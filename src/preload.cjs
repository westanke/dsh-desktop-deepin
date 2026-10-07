/**
 * Sandboxed preload — the only piece of shell-side code the renderer ever sees.
 *
 * Everything else in the window runs in the kernel-served web UI, which is
 * untrusted by design (see `window-policy.js`). The preload is locked down
 * (`sandbox: true`, `contextIsolation: true`, no `nodeIntegration`) and exposes
 * exactly two methods via `contextBridge`:
 *
 *   `notify(title, body)` — fire a desktop notification through the OS shell.
 *   `onShown(handler)`     — invoke `handler()` whenever the window is unhidden
 *                            from the tray, so the renderer can resume any work
 *                            it was pausing.
 *
 * That is the entire surface. A larger surface is the failure mode this preload
 * exists to prevent: every new export is another piece of the kernel's web UI
 * that can be addressed from a compromised renderer, which is precisely what
 * the upstream policy was written to forbid.
 *
 * Sandboxed preloads run in a V8 context with a CommonJS `require` and no
 * Node module loader beyond it, so `require('electron')` is how this file
 * reaches `contextBridge` / `ipcRenderer`. Bare references to those names do
 * not resolve on this runtime — see the note at the import below.
 *
 * The `.cjs` extension is what makes that work. `package.json` declares
 * `"type": "module"`, so a sibling `preload.js` would be handed to the ESM
 * loader, where `require` does not exist at all. `.cjs` forces the CommonJS
 * path regardless.
 *
 * @module preload
 */

// Electron's API is reached through `require('electron')`, not through bare
// globals. A sandboxed preload does get a CommonJS `require`, but
// `contextBridge` / `ipcRenderer` are NOT injected as globals on Electron 33 —
// a bare `contextBridge` reference throws `ReferenceError: contextBridge is
// not defined`, which Chromium reports as "Unable to load preload script".
// Verified against this runtime: `require('electron').contextBridge` succeeds
// where the bare global throws.
const { contextBridge: contextBridgeApi, ipcRenderer: ipcRendererApi, webUtils } = require('electron')

if (!contextBridgeApi || !ipcRendererApi) {
  throw new Error('preload: Electron contextBridge/ipcRenderer are not available')
}

// Self-check: reaching this line proves Electron parsed and executed the file,
// which is otherwise indistinguishable from "Unable to load preload script" in
// DevTools. The main process reads it back to tell a parse failure from a
// successful load.
contextBridgeApi.exposeInMainWorld('__dshPreloadProbe', {
  loaded: true,
  hasContextBridge: contextBridgeApi !== undefined,
  hasIpcRenderer: ipcRendererApi !== undefined,
  hasWebUtils: webUtils !== undefined,
})

// Resolves a dropped or pasted `File` to the path on this machine.
//
// A file that came from a file manager has one, and the application can then
// refer to it as `@/path/to/file` instead of uploading its bytes — which is the
// difference between attaching a 4 GB build artifact and failing to attach
// anything. A file that came from a paste or a drag out of another page has no
// path, so this returns an empty string and the caller uploads it as usual.
contextBridgeApi.exposeInMainWorld('__DSH_HOST_PATHS__', Object.freeze({
  /**
   * @param {File} file - a `File` from a drop or paste event
   * @returns {string} the absolute path, or '' when the file has none
   */
  pathFor(file) {
    try {
      // `getPathForFile` throws on a File that did not come from the OS, so a
      // wrong argument must not take the page down with it.
      return file instanceof File ? (webUtils.getPathForFile(file) ?? '') : ''
    } catch {
      return ''
    }
  },
}))
console.log('[dsh-shell] preload loaded; contextBridge =', typeof contextBridgeApi,
  'ipcRenderer =', typeof ipcRendererApi)
// Also hand the mark to the main process over IPC: the renderer console is not
// always visible (no terminal, DevTools closed), and the main process turns
// this into a crash report on disk.
ipcRendererApi.send('shell:preload-probe', {
  contextBridge: typeof contextBridgeApi,
  ipcRenderer: typeof ipcRendererApi,
})

// Receives the page's theme choice so the main process can keep Electron's own
// chrome in step. Called by the script `theme-bridge.js` injects; exposed
// separately from `shell` because the page reads it, not the application.
contextBridgeApi.exposeInMainWorld('__dshSetTheme', (/** @type {unknown} */ value) => {
  try {
    ipcRendererApi.send('shell:theme', { source: value === null || value === undefined ? null : String(value) })
  } catch {
    // intentionally empty
  }
})

contextBridgeApi.exposeInMainWorld('shell', Object.freeze({
  /**
   * Posts a desktop notification through the shell's `Notification` instance.
   *
   * Failures are swallowed: a renderer that is mid-unload, or a notification
   * daemon that is not running, should not propagate exceptions back into the
   * page that asked for them.
   *
   * @param {string} title
   * @param {string} body
   * @returns {void}
   */
  notify(title, body) {
    try {
      ipcRendererApi.send('shell:notify', { title: String(title), body: String(body) })
    } catch {
      // intentionally empty
    }
  },

  /**
   * Subscribes to the "window was just unhidden" event so the renderer can
   * resume polling or visual updates it had paused. Multiple subscribers are
   * allowed; the underlying listener is fanned out.
   *
   * @param {() => void} handler
   * @returns {() => void} unsubscribe
   */
  onShown(handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = () => {
      try { handler() } catch { /* ignore renderer errors */ }
    }
    ipcRendererApi.on('shell:shown', listener)
    return () => ipcRendererApi.removeListener('shell:shown', listener)
  },

  /**
   * Reports whether the kernel's web UI currently looks busy.
   *
   * This is the only input the shell has for "would quitting interrupt
   * anything?". The official shell answers that by querying the Host over a
   * private channel this shell does not have; the DOM observation is an
   * approximation, and is treated as one.
   *
   * @param {boolean} busy
   * @returns {void}
   */
  setBusy(busy) {
    try {
      ipcRendererApi.send('shell:busy', busy === true)
    } catch {
      // intentionally empty
    }
  },

  /**
   * Asks the shell to run one of a fixed set of desktop actions.
   *
   * Only an action *name* crosses the bridge — never a channel, a path, or a
   * payload. The main process looks the name up in `DESKTOP_ACTIONS` and
   * refuses anything else, so a page cannot reach an IPC handler this preload
   * did not mean to expose.
   *
   * @param {string} action - e.g. 'restart-kernel'
   * @returns {void}
   */
  invoke(action) {
    try {
      ipcRendererApi.send('shell:invoke', String(action))
    } catch {
      // intentionally empty
    }
  },

  /**
   * Subscribes to the shell's state, so the in-page controls can show whether
   * the kernel is starting, ready or crashed — the same information the tray
   * status line shows.
   *
   * @param {(state: object) => void} handler
   * @returns {() => void} unsubscribe
   */
  /**
   * Subscribes to the update state, so the page can show the same thing the
   * tray line shows rather than a second guess at it.
   *
   * @param {(state: object) => void} handler
   * @returns {() => void} unsubscribe
   */
  onUpdate(/** @type {(state: object) => void} */ handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = (/** @type {unknown} */ _event, /** @type {any} */ state) => {
      try { handler(state) } catch { /* ignore renderer errors */ }
    }
    ipcRendererApi.on('shell:update', listener)
    return () => ipcRendererApi.removeListener('shell:update', listener)
  },

  onState(/** @type {(state: object) => void} */ handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = (/** @type {unknown} */ _event, /** @type {any} */ state) => {
      try { handler(state) } catch { /* ignore renderer errors */ }
    }
    ipcRendererApi.on('shell:state', listener)
    return () => ipcRendererApi.removeListener('shell:state', listener)
  },
}))