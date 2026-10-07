/**
 * System tray integration: hide-to-tray, click-to-toggle, a live status line,
 * a kernel-restart item, a launch-at-login toggle, a global summon shortcut,
 * a balance/recharge shortcut, and a check-for-updates item.
 *
 * Modeled on the official dsh-desktop shell's tray, which shows far more than
 * a single "quit" — the most useful additions are the live state line (so the
 * tray tells you the kernel is starting / ready / retrying / crashed without
 * you opening the window) and the restart item (so a stuck kernel is one click
 * away from a fresh launch).
 *
 * @module tray
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// `electron` is reached lazily through `createRequire`, so plain-Node unit
// tests can import this module without Electron being present. Module-scope
// `import { Tray } from 'electron'` would throw synchronously outside the
// Electron runtime, because Electron's main module is a native binding that
// only resolves inside it.
const nodeRequire = createRequire(import.meta.url)
const loadElectron = () => nodeRequire('electron')

/**
 * Resolves the app icon path relative to `here` (the directory of the calling
 * module, set by `main.js`). Used for the window and as the tray fallback.
 *
 * @param {string} here - directory of the calling module, e.g. `.../src`
 * @returns {string}
 */
export function trayIconPath(here) {
  return join(here, '..', 'assets', 'icon.png')
}

/**
 * Resolves a dedicated tray icon — a small image meant specifically for the
 * system tray, not the 512px app icon. Falls back to the app icon when the
 * dedicated asset is absent, so a tray is always visible. On macOS the image
 * is marked as a template so the OS recolours it for light and dark menu bars.
 *
 * @param {string} here - directory of the calling module, e.g. `.../src`
 * @returns {string}
 */
export function trayTemplateIconPath(here) {
  const template = join(here, '..', 'assets', 'trayTemplate.png')
  return existsSync(template) ? template : trayIconPath(here)
}

/**
 * The kernel phases the tray status line renders.
 *
 * @typedef {'starting' | 'ready' | 'crashed'} KernelPhase
 * @typedef {object} KernelState
 * @property {KernelPhase} phase
 * @property {'launching' | 'waiting-for-ready' | 'retrying'} [stage]
 * @property {number} [attempts]
 * @property {number} [retryDelayMs]
 */

const SUMMON_ACCELERATOR = 'CommandOrControl+Shift+Space'

/**
 * The `dsh` command item, by what is currently published at the path.
 *
 * Only `ours` is clickable: `foreign` means somebody else's command sits
 * there, `stale` means ours was changed after installation and only the user
 * can decide about it, and `absent` is the state that offers to install — a
 * separate item, so installing never hides behind a toggle that reads as
 * already-on.
 *
 * @type {Readonly<Record<'ours' | 'foreign' | 'stale' | 'absent', string>>}
 */
const CLI_COMMAND_LABELS = Object.freeze({
  ours: 'dsh 命令：已安装（点击卸载）',
  foreign: 'dsh 命令：被其它程序占用',
  stale: 'dsh 命令：已被改动，请手动检查',
  absent: 'dsh 命令：未安装',
})
// The recharge URL and summon shortcut can be overridden through config.json.
// config.js is pure fs/path, so this import is safe under plain Node too.
let RECHARGE_URL = 'https://platform.deepseek.com/top_up'
try {
  const trayConf = (await import('./config.js')).getConfig().tray
  RECHARGE_URL = trayConf.rechargeUrl ?? RECHARGE_URL
} catch { /* keep default */ }

export class ShellTray {
  /** @type {import('electron').Tray | null} */
  #tray = null
  /** @type {import('electron').BrowserWindow | null} */
  #window = null
  /** @type {() => void} */
  #focus = () => {}
  /** @type {() => void} */
  #quit = () => {}
  #isQuitting = false
  #isWindowVisible = false
  /** @type {Set<(visible: boolean) => void>} */
  #visibilityListeners = new Set()

  // New state the upgraded tray carries. Each is optional; when absent the
  // matching menu item simply hides or disables.
  /** @type {KernelState | null} */
  #kernelState = null
  /** @type {() => void} */
  #onRestart = () => {}
  /** @type {() => void} */
  #onCheckUpdates = () => {}
  /** @type {() => void} */
  #onToggleLaunchAtLogin = () => {}
  /** @type {boolean} */
  #launchAtLogin = false
  /** @type {boolean} */
  #safeMode = false
  /** @type {() => void} */
  #onToggleSafeMode = () => {}
  /**
   * What is published at `~/.local/bin/dsh`: ours, someone else's, stale
   * (installed by us and changed since), or absent.
   *
   * @type {'ours' | 'foreign' | 'stale' | 'absent'}
   */
  #commandState = 'absent'
  /** @type {() => void} */
  #onToggleCommand = () => {}
  /** @type {string | null} */
  #balance = null
  /** @type {boolean} */
  #shortcutRegistered = false
  /**
   * The update state as one line, or null when the shell has nothing to say.
   *
   * @type {string | null}
   */
  #updateStatus = null

  /**
   * The kernel homes offered in the menu, and the one currently in use.
   *
   * Shown as a radio group rather than a plain list: exactly one home is in use
   * at any moment, and the menu should say which rather than making the user
   * infer it from absence. Entries arrive already shaped for display by
   * `describeHomes` — including the `duplicateOf` flag, which marks two entries
   * pointing at one directory instead of silently dropping one.
   *
   * @type {Array<{id: string, name: string, path: string, active: boolean, builtin: boolean, duplicateOf: string | null}>}
   */
  #homes = []
  /** @type {string | null} */
  #activeHomeId = null
  /** @type {(id: string) => void} */
  #onSelectHome = () => {}
  /** @type {() => void} */
  #onAddHome = () => {}

  /**
   * @param {object} options
   * @param {string} options.iconPath - a tray-sized icon
   * @param {import('electron').BrowserWindow} options.window
   * @param {() => void} options.onShow - restore and focus the window
   * @param {() => void} options.onQuit - tear down everything and exit
   * @param {(state: KernelState) => void} [options.onState] - status callback
   * @param {() => void} [options.onRestart] - restart the kernel
   * @param {() => void} [options.onCheckUpdates] - check for updates
   * @param {() => void} [options.onToggleLaunchAtLogin] - toggle autostart
   * @param {() => void} [options.onToggleSafeMode] - toggle Safe Mode
   * @param {boolean} [options.safeMode] - whether Safe Mode is on
   * @param {boolean} [options.launchAtLogin] - whether autostart is on
   * @param {'ours' | 'foreign' | 'stale' | 'absent'} [options.commandState]
   *   - what is published at the `dsh` command path
   * @param {() => void} [options.onToggleCommand] - publish or remove the command
   * @param {string | null} [options.balance] - balance string to show, or null
   * @param {Array<{id: string, name: string, path: string, active: boolean, builtin: boolean, duplicateOf: string | null}>} [options.homes]
   *   - the kernel homes to offer
   * @param {(id: string) => void} [options.onSelectHome] - switch to that home
   * @param {() => void} [options.onAddHome] - register another home directory
   * @returns {void}
   */
  attach({ iconPath, window, onShow, onQuit, onState, onRestart, onCheckUpdates, onToggleLaunchAtLogin, onToggleSafeMode, launchAtLogin = false, safeMode = false, commandState = 'absent', onToggleCommand, balance = null, homes = [], onSelectHome, onAddHome }) {
    if (this.#tray !== null) return
    if (!existsSync(iconPath)) {
      throw new Error(`tray icon missing: ${iconPath}`)
    }
    this.#window = window
    this.#focus = onShow
    this.#quit = onQuit
    this.#onRestart = onRestart ?? (() => {})
    this.#onCheckUpdates = onCheckUpdates ?? (() => {})
    this.#onToggleLaunchAtLogin = onToggleLaunchAtLogin ?? (() => {})
    this.#launchAtLogin = launchAtLogin
    this.#safeMode = safeMode
    if (typeof onToggleSafeMode === 'function') this.#onToggleSafeMode = onToggleSafeMode
    this.#commandState = commandState
    if (typeof onToggleCommand === 'function') this.#onToggleCommand = onToggleCommand
    this.#balance = balance
    this.#setHomes(homes)
    if (typeof onSelectHome === 'function') this.#onSelectHome = onSelectHome
    if (typeof onAddHome === 'function') this.#onAddHome = onAddHome
    if (typeof onState === 'function') onState(this.#kernelState ?? { phase: 'starting', stage: 'launching' })

    const { Tray, nativeImage } = loadElectron()
    const tray = new Tray(iconPath)

    // A template image is recoloured by the OS for light/dark menu bars (macOS);
    // on other platforms Electron ignores the flag but the dedicated asset still
    // renders cleaner in the tray than the full app icon.
    const image = nativeImage.createFromPath(iconPath)
    if (process.platform === 'darwin') image.setTemplateImage(true)
    tray.setImage(image)

    tray.setToolTip('DeepSeek Harness 桌面端')
    tray.on('click', () => this.#onClick())
    tray.on('double-click', () => this.#focus())
    tray.setContextMenu(this.#buildMenu())
    this.#tray = tray

    // Global shortcut: summon the window from anywhere. Registered best-effort
    // — if the accelerator is taken, the tray simply has no shortcut.
    this.#registerShortcut()

    window.on('show', () => this.#setVisible(true))
    window.on('hide', () => this.#setVisible(false))
  }

  /**
   * Sets the flag that tells the window-close handler to allow close (rather
   * than hiding). Called from `before-quit` so an explicit Quit always wins.
   *
   * @returns {void}
   */
  prepareQuit() {
    this.#isQuitting = true
  }

  /**
   * Whether the shell is currently shutting down. Read by the window-close
   * handler in `main.js`.
   *
   * @returns {boolean}
   */
  get isQuitting() {
    return this.#isQuitting
  }

  /**
   * Whether the window is currently visible. Read by the close handler so
   * closing an already-hidden window can be passed through to the OS.
   *
   * @returns {boolean}
   */
  get isWindowVisible() {
    return this.#isWindowVisible
  }

  /** @returns {void} */
  #registerShortcut() {
    try {
      // `globalShortcut` is reached through `loadElectron()`, not as a module
      // binding — this module deliberately has no top-level Electron import so
      // its pure parts stay testable under plain Node. Referring to it bare
      // threw a ReferenceError, the catch below swallowed it, and the summon
      // shortcut was therefore never registered.
      const { globalShortcut } = loadElectron()
      this.#shortcutRegistered = globalShortcut.register(SUMMON_ACCELERATOR, () => this.#focus())
    } catch {
      this.#shortcutRegistered = false
    }
  }

  /** @returns {void} */
  destroy() {
    const { globalShortcut } = loadElectron()
    try { globalShortcut.unregister(SUMMON_ACCELERATOR) } catch { /* ignore */ }
    this.#tray?.destroy()
    this.#tray = null
  }

  /**
   * Updates the live kernel state and refreshes the tray menu (so the status
   * line tracks starting / ready / retrying / crashed without opening a window).
   *
   * @param {KernelState} state
   * @returns {void}
   */
  setState(state) {
    this.#kernelState = state
    this.#refreshMenu()
  }

  /**
   * Updates the balance string shown (and used as the recharge shortcut).
   *
   * @param {string | null} balance
   * @returns {void}
   */
  setBalance(balance) {
    this.#balance = balance
    this.#refreshMenu()
  }

  /**
   * Reflects the update state, so the menu says what is happening without the
   * user opening the application to find out.
   *
   * @param {string | null} status - one line from `updateStatusLine`, or null
   *   when nothing is happening and the check action belongs there instead
   * @returns {void}
   */
  setUpdateStatus(status) {
    this.#updateStatus = status
    this.#refreshMenu()
  }

  /**
   * Updates the launch-at-login flag and refreshes the checkbox.
   *
   * @param {boolean} enabled
   * @returns {void}
   */
  setLaunchAtLogin(enabled) {
    this.#launchAtLogin = enabled
    this.#refreshMenu()
  }

  /**
   * Reflects the Safe Mode flag in the menu, so the checked state and the
   * status line agree with what the kernel was actually started with.
   *
   * @param {boolean} enabled
   * @returns {void}
   */
  setSafeMode(enabled) {
    this.#safeMode = enabled
    this.#refreshMenu()
  }

  /**
   * Reflects what is published at the `dsh` command path, so the menu never
   * offers to remove a command this shell did not install.
   *
   * @param {'ours' | 'foreign' | 'stale' | 'absent'} state
   * @returns {void}
   */
  setCommandState(state) {
    this.#commandState = state
    this.#refreshMenu()
  }

  /**
   * Shows a desktop notification.
   *
   * This is what the renderer's `shell.notify` bridge ends up calling when the
   * DOM observer sees a turn finish. The method did not exist until now, so
   * every notification threw and was swallowed by the preload's try/catch —
   * the feature was silently dead.
   *
   * Delivery prefers the tray's own balloon, which is tied to the icon the
   * user already associates with the app; the standalone Electron
   * `Notification` is the fallback for environments without tray balloons.
   *
   * @param {string} title
   * @param {string} body
   * @returns {void}
   */
  notify(title, body) {
    const text = String(title ?? '')
    const detail = String(body ?? '')
    try {
      if (this.#tray !== null && typeof this.#tray.displayBalloon === 'function') {
        this.#tray.displayBalloon({ title: text, content: detail })
        return
      }
    } catch {
      // Fall through to the standalone notification.
    }
    try {
      const { Notification } = loadElectron()
      if (typeof Notification !== 'function') return
      if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) return
      new Notification({ title: text, body: detail }).show()
    } catch {
      // A notification that cannot be shown must never break the caller.
    }
  }

  /** @returns {void} */
  #refreshMenu() {
    if (this.#tray === null) return
    this.#tray.setContextMenu(this.#buildMenu())
  }

  /**
   * Records the offered homes and which one is marked active.
   *
   * @param {Array<{id: string, name: string, path: string, active: boolean, builtin: boolean, duplicateOf: string | null}>} homes
   * @returns {void}
   */
  #setHomes(homes) {
    this.#homes = Array.isArray(homes) ? homes : []
    this.#activeHomeId = this.#homes.find((home) => home.active)?.id ?? null
  }

  /**
   * Replaces the list of kernel homes shown in the menu.
   *
   * @param {Array<{id: string, name: string, path: string, active: boolean, builtin: boolean, duplicateOf: string | null}>} homes
   * @returns {void}
   */
  setHomes(homes) {
    this.#setHomes(homes)
    this.#refreshMenu()
  }

  /**
   * Marks one home as current. Called once a switch has taken effect, so the
   * check mark follows reality rather than the user's click.
   *
   * @param {string} id
   * @returns {void}
   */
  setActiveHome(id) {
    this.#activeHomeId = id
    this.#homes = this.#homes.map((home) => ({ ...home, active: home.id === id }))
    this.#refreshMenu()
  }

  /**
   * The "Kernel home" submenu, or null when there is nothing worth showing.
   *
   * A single home means there is nothing to switch to, so the entry stays
   * hidden rather than offering a menu whose only row says "the one you are
   * using" — that is noise dressed up as a feature.
   *
   * @returns {Electron.MenuItemConstructorOptions | null}
   */
  #buildHomesMenu() {
    if (this.#homes.length === 0) return null

    const rows = this.#homes.map((home) => ({
      label: home.duplicateOf !== null ? `${home.name}（与 ${home.duplicateOf} 同路径）` : home.name,
      type: /** @type {const} */ ('radio'),
      checked: home.id === this.#activeHomeId,
      toolTip: home.path,
      click: () => this.#onSelectHome(home.id),
    }))

    return {
      label: '内核 Home',
      submenu: [
        ...rows,
        { type: /** @type {const} */ ('separator') },
        {
          label: '添加已有 Home…',
          click: () => this.#onAddHome(),
        },
        {
          label: '在文件管理器中打开当前 Home',
          click: () => this.#openHomeDirectory(),
        },
      ],
    }
  }

  /**
   * Opens the home currently in use in the OS file manager.
   *
   * Best-effort: `openPath` reports failure asynchronously and there is nothing
   * useful to do about it here beyond logging. Pointing the user at the
   * directory is worth offering because "which home am I in" is a question
   * better answered by seeing the files than by reading a menu.
   *
   * @returns {void}
   */
  #openHomeDirectory() {
    const current = this.#homes.find((home) => home.id === this.#activeHomeId)
    if (current === undefined) return
    try {
      const { shell } = loadElectron()
      void shell.openPath(current.path)
    } catch (error) {
      console.warn(`could not open ${current.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** @returns {string} the status line for the current kernel state */
  #statusLabel() {
    const state = this.#kernelState
    if (state === null) return '内核启动中…'
    if (state.phase === 'ready') return '内核运行中'
    if (state.phase === 'crashed') return `自动恢复已暂停（已尝试 ${state.attempts ?? '?'} 次）`
    if (state.phase === 'starting' && state.stage === 'retrying') {
      const secs = Math.ceil((state.retryDelayMs ?? 0) / 1000)
      return `${secs} 秒后重试…`
    }
    if (state.phase === 'starting' && state.stage === 'waiting-for-ready') return '等待内核就绪…'
    if (state.phase === 'starting' && state.stage === 'launching') return '正在启动内核…'
    return '内核启动中…'
  }

  /**
   * @returns {import('electron').Menu}
   */
  #buildMenu() {
    const { Menu } = loadElectron()
    const canRestart = this.#kernelState?.phase === 'crashed' || this.#kernelState?.phase === 'ready'

    /** @type {Electron.MenuItemConstructorOptions[]} */
    const items = [
      {
        label: this.#isWindowVisible ? '隐藏窗口' : '显示窗口',
        click: () => (this.#isWindowVisible ? this.#hide() : this.#focus()),
      },
      {
        label: '快捷召唤',
        accelerator: SUMMON_ACCELERATOR,
        click: () => this.#focus(),
      },
      {
        label: this.#shortcutRegistered ? `快捷键：${SUMMON_ACCELERATOR}` : '快捷键不可用',
        enabled: false,
      },
      {
        label: this.#launchAtLogin ? '开机自启：开' : '开机自启：关',
        type: 'checkbox',
        checked: this.#launchAtLogin,
        click: () => this.#onToggleLaunchAtLogin(),
      },
      {
        label: this.#safeMode ? '安全模式：开（第三方插件已停用）' : '安全模式：关',
        type: 'checkbox',
        checked: this.#safeMode,
        click: () => this.#onToggleSafeMode(),
      },
      { type: 'separator' },
      {
        // The shell is only half useful if a terminal opened beside it cannot
        // reach it, and `dsh` has to be on `PATH` for that. The official shell
        // publishes the command on macOS and Windows and declines to build it
        // for Linux (`command-manager-entry.ts` throws off darwin/win32), so
        // this is a Linux-only addition.
        label: CLI_COMMAND_LABELS[this.#commandState],
        enabled: this.#commandState === 'ours' || this.#commandState === 'absent',
        click: () => this.#onToggleCommand(),
      },
      { label: this.#safeMode ? `${this.#statusLabel()}（安全模式）` : this.#statusLabel(), enabled: false },
      {
        label: this.#kernelState?.phase === 'crashed' ? '启动内核' : '重启内核',
        enabled: canRestart,
        click: () => this.#onRestart(),
      },
    ]

    // The home switcher sits beside "restart kernel" rather than under a settings
    // submenu: it is a routine action, and burying it would make the shell look
    // like it still only supports one home.
    const homesMenu = this.#buildHomesMenu()
    if (homesMenu !== null) {
      items.push({ type: 'separator' }, homesMenu)
    }

    if (this.#balance !== null) {
      items.push({
        label: `余额：${this.#balance}`,
        click: () => loadElectron().shell.openExternal(RECHARGE_URL),
      })
    }

    items.push(
      { type: 'separator' },
      // The update line and the action share a slot: while something is
      // happening the state is what the user needs, and the action waits for
      // the next check rather than offering a second one mid-download.
      this.#updateStatus === null
        ? { label: '检查更新…', click: () => this.#onCheckUpdates() }
        : { label: this.#updateStatus, enabled: false },
      { type: 'separator' },
      { label: '退出', click: () => this.#quit() },
    )

    return Menu.buildFromTemplate(items)
  }

  /** @returns {void} */
  #onClick() {
    if (this.#isWindowVisible) this.#hide()
    else this.#focus()
  }

  /**
   * @param {boolean} visible
   * @returns {void}
   */
  #setVisible(visible) {
    if (this.#isWindowVisible === visible) return
    this.#isWindowVisible = visible
    if (visible) this.#broadcast(true)
    else this.#broadcast(false)
  }

  /**
   * Registers a listener fired when the window's visibility changes.
   *
   * @param {(visible: boolean) => void} listener
   * @returns {() => void} unsubscribe
   */
  onVisibilityChange(listener) {
    this.#visibilityListeners.add(listener)
    return () => this.#visibilityListeners.delete(listener)
  }

  /** @returns {void} */
  #hide() {
    this.#window?.hide()
  }

  /**
   * @param {boolean} visible
   * @returns {void}
   */
  #broadcast(visible) {
    for (const listener of this.#visibilityListeners) {
      try { listener(visible) } catch { /* ignore listener errors */ }
    }
  }
}
