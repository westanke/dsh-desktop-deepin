/**
 * Electron entry point: orchestration and IO only.
 *
 * Every decision this file acts on is made in a module that can be tested without
 * Electron — what remains here is starting a process, opening a window, and wiring the
 * two together.
 *
 * @module main
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, symlink, cp } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, screen, shell } from 'electron'
import { findFreePort } from './kernel-process.js'
import { KernelSupervisor } from './kernel-supervisor.js'
// Deprecated: kept for the rollback path. The scheme URL in `loadingUrl` /
// `errorUrl` below is now the primary; `loadingPageHtml` / `errorPageHtml`
// remain wired in `loadShellStaticPage` as a fallback when the scheme is not
// yet installed (e.g. a hand-picked install layout missing `renderer/`).
import { errorPageHtml, loadingPageHtml } from './loading-page.js'
import { getConfig, isInstalledLaunch } from './config.js'
import { buildKernelArgs, buildKernelEnv, isSupportedNodeVersion } from './kernel-runtime.js'
import { readLoginShellEnvironment, resolveLoginShellConfig } from './login-shell-environment.js'
import { describeCommand, installCommand, uninstallCommand } from './cli-command.js'
import { familyMarkerEnv, markerValueFor, reapOrphans } from './orphan-reaper.js'
import { nodeBinaryName } from './node-runtime.js'
import { httpProbe, waitForReady } from './readiness.js'
import { shouldUseBrowsePicker } from './directory-picker.js'
import { buildAppMenuTemplate } from './app-menu.js'
import { buildShellPatch, serialisePatch } from './shell-patch.js'
import { writeConfigFile } from './config-file.js'
import { denyUnexpectedPermissions } from './permissions.js'
import { writeCrashReport } from './diagnostics.js'
import { reportFatal } from './fatal-recovery.js'
import { BackgroundNotice } from './background-notice.js'
import { resolveThemeSource, themeBridgeScript } from './theme-bridge.js'
import { IDLE_UPDATE_STATE, isUpdateBusy, updateStatusLine } from './update-state.js'
import { createUpdateSchedule, resolveUpdateScheduleConfig } from './update-schedule.js'
import { captureWindowState, fitWindowState } from './window-state.js'
import { resolveBindings, shortcutDeliveryMode, validateBindings } from './shortcuts.js'
import { exitConfirmCopy, shouldConfirmExit } from './exit-guard.js'
import { isDesktopAction, toDesktopState } from './desktop-commands.js'
import { hasSafeModeTargets, nextBackupPath, safeModeTargets, toDisablePatch } from './safe-mode.js'
import {
  DEFAULT_HOME_ID,
  chooseHome,
  describeHomes,
  normalizeRegistry,
  readCliHome,
  registryPath,
  removeHome,
  resolveSubdir,
  setActiveHome,
  upsertHome,
} from './dsh-home-manager.js'
import { rename } from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'
import { ShellTray, trayIconPath, trayTemplateIconPath } from './tray.js'
import { OBSERVER_SOURCE } from './dom-observer.js'
import { authenticateWebHost, installShellProtocol, kernelTicket, registerShellScheme, rewriteWebSocketHeaders, ROUTES as SCHEME_ROUTES, SCHEME } from './shell-protocol.js'

// Scheme URLs the static loading/error pages are served from.
// The handler is installed in `whenReady` (before the first window), and the
// pages are plain files under `renderer/`, so they survive across restarts
// without re-packaging the shell.
const LOADING_URL = 'dsh-app://shell/loading.html'
const ERROR_URL = 'dsh-app://shell/error.html'
// The kernel's web UI is loaded through the scheme's `app` hostname: the
// renderer lands on `dsh-app://app/`, and every request the UI issues
// (including the WebSocket surface) is resolved against the scheme, then
// proxied to the kernel's plain `http://127.0.0.1` endpoint with the
// per-launch token attached as `?token=`.
const APP_URL = 'dsh-app://app/'
import {
  SECURE_WEB_PREFERENCES,
  classifyWindowOpen,
  isAllowedNavigation,
  kernelOrigin,
} from './window-policy.js'

const HOST = '127.0.0.1'
const here = dirname(fileURLToPath(import.meta.url))

// Register the private scheme as privileged *before* any window is created —
// `registerSchemesAsPrivileged` only takes effect pre-window. The handler
// itself is installed later, once we know the kernel's origin and token.
registerShellScheme(protocol)

// Ports are always chosen by the OS.
//
// The official shell fixes 19387, and this shell copied that — which turned out
// to be actively harmful here. When another dsh instance already held 19387,
// this shell moved to a free port *and then probed 19387 anyway*, so it was
// checking a stranger's kernel: that kernel gates its web surface behind its
// own per-launch token, this shell had a different token, every probe came
// back 401, and startup failed with "the kernel did not start responding in
// time" while the real kernel was up and healthy on the port it had been given.
//
// Asking the OS for an unused port removes the collision entirely: nothing else
// can hold the port this launch is about to use, so the probe can only ever
// reach the kernel this shell started.


/**
 * The shortest time the loading page stays up after the kernel is ready.
 *
 * Without a floor, a fast kernel makes the page flash by: the log fills in and
 * is gone before it can be read, which defeats the point of showing it. Three
 * seconds is long enough to read a few lines and short enough not to feel like
 * a delay. A `splashMinMs` value in config.json overrides it; 0 disables the
 * floor entirely.
 *
 * @type {number}
 */
const DEFAULT_SPLASH_MIN_MS = 3_000

// Renderer self-healing bounds: a few reloads inside a short window is a
// transient renderer death; more than that is a page that will not load, and
// reloading it forever only hides that. Both come from config.json.
const cfgRenderer = getConfig().renderer
const MAX_RENDERER_RECOVERIES = cfgRenderer.maxRecoveries
const RENDERER_RECOVERY_WINDOW_MS = cfgRenderer.recoveryWindowMs

/**
 * The kernel supervisor — not the kernel process.
 *
 * Getting this wrong is what broke the tray's "restart kernel" item: the
 * supervisor owns `restart()` and `markReady()`, while the process owns
 * `isRunning()`, `webToken()` and `args`. The annotation below used to say
 * `KernelProcess`, and `restartKernel` acted on that wrong belief.
 *
 * @type {KernelSupervisor | null}
 */
let kernel = null
/**
 * Whether the kernel is driven from an external install (`DSH_KERNEL_BIN`)
 * rather than the bundled tree.
 *
 * Recorded at launch so code that runs *after* startup can reason about it —
 * `restartKernel` in particular needs it to pick the right readiness probe.
 *
 * @type {boolean}
 */
let systemKernelMode = false
/**
 * When this launch began waiting for a kernel, in epoch millis.
 *
 * Passed into every loading page so the elapsed counter keeps counting across
 * the page swaps that happen as the kernel moves through its stages — a
 * counter that restarted on each swap would understate how long the user has
 * actually been waiting.
 *
 * @type {number}
 */
let startupBeganAt = 0
/** @type {BrowserWindow | null} */
let mainWindow = null
/**
 * Live state shared by the `dsh-app` protocol handler and the WebSocket header
 * hook: the kernel's plain origin, and the browser ticket its entry handshake
 * hands out. Both live out here because each window reads them while the
 * startup path writes them.
 *
 * @type {import('./shell-protocol.js').ShellProtocolState}
 */
const shellProtoState = { kernelOrigin: null }
/** @type {ShellTray | null} */
let tray = null
/**
 * The one-time "closing the window does not quit" notice.
 *
 * Built on first use rather than at module load: it needs `app.getPath`, which
 * is only meaningful once the app is ready, and a window cannot be closed
 * before that either.
 *
 * @type {BackgroundNotice | null}
 */
let trayNotice = null
/** @type {{phase: string, stage?: string, attempts?: number, retryDelayMs?: number} | null} */
let kernelState = null
/**
 * Whether the kernel's web UI last looked busy.
 *
 * An approximation of the official shell's "is anything running?" query, which
 * it answers through a private Host channel this shell does not have. It is
 * fed by the DOM observer and read only by the exit confirmation.
 *
 * @type {boolean}
 */
let kernelBusy = false
/**
 * The key bindings in force: the defaults, overridden by `keybindings.json`.
 *
 * @type {Record<string, string>}
 */
let windowShortcutBindings = {}
/**
 * Whether the next kernel launch should skip the user's third-party bundles.
 *
 * Set by the tray, the menu or the in-page controls, and consumed by
 * `startKernel` on the next launch. Persisted nowhere: Safe Mode is a recovery
 * action, not a preference — a user who restarts normally should get their
 * plugins back unless they ask for Safe Mode again.
 *
 * @type {boolean}
 */
let safeMode = false
/**
 * The marker value this shell's process family is attributed by, and the pid
 * of the kernel launch currently being supervised.
 *
 * The marker rides `ELECTRON_USER_DATA` — see {@link module:orphan-reaper} for
 * why that variable and not a `DSH_*` one. Both are set in `startKernel` and
 * read by the reaper call sites.
 *
 * @type {string}
 */
let familyMarker = ''
/** @type {number | null} */
let currentKernelPid = null

/**
 * The kernel home currently in use, and why it was chosen.
 *
 * `dshHome` is mutable, unlike every previous version of this shell: switching
 * homes means pointing this variable somewhere else and restarting the kernel,
 * which is far cheaper than restarting the whole application. It is read fresh
 * on every launch attempt by the supervisor's `launchSpec`, so a switch takes
 * effect at the next kernel start without any further plumbing.
 *
 * The `source` records which rule picked it — command line, environment,
 * registry, or config default — purely so the startup log can say why this
 * home rather than another one. Nothing depends on it.
 *
 * @type {string}
 */
let dshHome = ''
/** @type {string} */
let dshHomeSource = 'default'
/**
 * The registry of known homes, loaded once per launch from `userData`. Its own
 * file lives outside every `DSH_HOME` it lists, so the list survives a home
 * being deleted.
 *
 * @type {{version: number, activeId: string, homes: Array<object>}}
 */
let homeRegistry = normalizeRegistry(null, '')

/**
 * Loads the registry of kernel homes from `userData`.
 *
 * A missing or unparseable file is not an error: the fallback shape is exactly
 * the state of a fresh install — one home, derived from `config.json` — so a
 * broken registry costs the user their list of extra homes and nothing else. The
 * shell must never fail to start because a file it wrote got damaged.
 *
 * @param {string} userData - `app.getPath('userData')`
 * @param {string} defaultPath - where the built-in home points this launch
 * @returns {Promise<{version: number, activeId: string, homes: Array<object>}>}
 */
async function loadHomeRegistry(userData, defaultPath) {
  const path = registryPath(userData)
  let raw = null
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    // Absent on first launch, and unreadable if something interrupted a write.
    // Either way the defaults apply.
  }
  return normalizeRegistry(raw, defaultPath)
}

/**
 * Persists the registry, atomically and under the same lock every other config
 * write uses.
 *
 * @returns {Promise<void>}
 */
async function saveHomeRegistry() {
  const path = registryPath(app.getPath('userData'))
  await writeConfigFile(path, `${JSON.stringify(homeRegistry, null, 2)}\n`)
}

/**
 * Switches the shell to a different kernel home.
 *
 * The switch itself is small — repoint `dshHome` and restart the supervisor —
 * but the restart is *not* instant: the kernel is tearing down and re-running
 * every plugin and MCP server it owns, which takes tens of seconds on a real
 * machine. So the loading page goes up before anything else happens, and the
 * remembered choice is written before the restart starts rather than after it
 * succeeds: if the switch fails, the user should still find their choice in
 * place next launch, because a failed restart leaves the *new* home selected and
 * the old one unreachable — arguably worse than failing outright.
 *
 * A second concurrent switch is refused. There is one supervisor and one window;
 * two interleaved switches would leave the kernel running against whichever home
 * lost the race, with no record of which one that was.
 *
 * @param {string} id - registry id of the home to switch to
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
/** @type {Promise<void> | null} */
let homeSwitchInProgress = null

/**
 * @param {string} id - registry id of the home to switch to
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function switchHome(id) {
  if (homeSwitchInProgress !== null) {
    return { ok: false, error: '另一个切换正在进行中' }
  }
  const target = homeRegistry.homes.find((entry) => /** @type {any} */ (entry).id === id)
  if (target === undefined) {
    return { ok: false, error: `未知的 Home：${id}` }
  }
  const nextPath = /** @type {any} */ (target).path

  const run = (async () => {
    // Written before the restart rather than after: see the note above.
    homeRegistry = setActiveHome(homeRegistry, id)
    await saveHomeRegistry()
    dshHome = nextPath
    dshHomeSource = 'switch'
    console.log(`switching kernel home to ${dshHome} (${id})`)

    try {
      await mkdir(dshHome, { recursive: true })
    } catch (error) {
      console.warn(`could not create ${dshHome}: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      startupBeganAt = Date.now()
      void loadLoadingPage(mainWindow, 'launching', startupBeganAt)
    }

    const supervisor = kernel
    if (supervisor === null) {
      // No kernel yet means startup has not finished; the value above is
      // already correct for when it does.
      return
    }
    currentKernelPid = null
    await sweepOrphans('home-switch')
    // `restart()` on the supervisor already replaces the running kernel with a
    // fresh launch using whatever `dshHome` is current — no separate start step,
    // and no reassigning `kernel`, which stays the supervisor throughout (the
    // mistake an earlier version of restartKernel made).
    await supervisor.restart()
    tray?.setActiveHome?.(id)
  })()

  homeSwitchInProgress = run
  try {
    await run
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`switching home failed: ${message}`)
    return { ok: false, error: message }
  } finally {
    homeSwitchInProgress = null
  }
}

/**
 * Adds a home to the registry, or switches to it if it is already listed.
 *
 * Registering does not switch immediately — it only makes the home available.
 * Registering and switching are deliberately separate because switching restarts
 * the kernel, and there is no reason to pay that cost to add an entry nobody
 * asked to use yet.
 *
 * @param {{id: string, name?: string, path: string}} entry
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function addHome(entry) {
  try {
    homeRegistry = upsertHome(homeRegistry, entry)
    await saveHomeRegistry()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Registers an existing directory as a kernel home, picked from a file dialog.
 *
 * Nothing is switched to automatically: adding an entry costs nothing, while
 * switching restarts the kernel, so the two are kept separate and the user gets
 * to choose from the menu afterwards.
 *
 * @returns {Promise<void>}
 */
async function addHomeFromPicker() {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return

  const result = await dialog.showOpenDialog(target, {
    title: '选择用作内核 Home 的目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled) return
  const directory = result.filePaths[0]
  if (typeof directory !== 'string' || directory === '') return

  const id = await uniqueHomeId(directory)
  const name = basename(directory) || 'Home'
  const outcome = await addHome({ id, name, path: directory })
  if (!outcome.ok) {
    tray?.notify('添加 Home 失败', outcome.error ?? '原因未知')
    return
  }

  tray?.setHomes(describeHomes(homeRegistry))
  tray?.notify('已添加 Home', `${name} —— 在菜单里切换到它即可启用`)

  // A directory nobody has used as a home yet is offered to be seeded from the
  // current one, which avoids waiting through a full plugin reinstall for a
  // profile that is meant to look like this one anyway.
  const seeded = await offerHomeSeeding(directory, name)
  if (!seeded.ok && seeded.error !== undefined) {
    console.warn(`copying the current home into ${directory} failed: ${seeded.error}`)
  }
}

/**
 * Seeds a new home by copying the profile directory out of the one in use.
 *
 * The kernel initialises an empty home on first use, but the result has no third
 * party plugins — it takes a fresh install and a network round trip to get back
 * to the set this user already runs. Copying `profiles/<name>` instead carries
 * everything across, and the copy is skipped rather than merged when the target
 * already organises itself, because merging two profile manifests silently
 * produces a bundle list neither author wrote.
 *
 * @param {string} directory - the new home
 * @param {string} name - display name, for the confirmation dialog
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function offerHomeSeeding(directory, name) {
  const profile = getConfig().kernel.profile || 'web'
  const source = join(dshHome, 'profiles', profile)
  const destination = join(directory, 'profiles', profile)

  if (!existsSync(source) || existsSync(destination)) return { ok: false }

  const answer = await dialog.showMessageBox(
    /** @type {Electron.BrowserWindow} */ (mainWindow),
    {
      type: 'question',
      buttons: ['复制', '不用，创建空 Home'],
      defaultId: 0,
      cancelId: 1,
      message: `是否把当前 Home 的配置与插件复制进「${name}」？`,
      detail:
        `源：${source}\n目标：${destination}\n\n` +
        '复制后新 Home 立即具备与当前 Home 相同的插件，省去重新下载安装。' +
        '若两个 Home 随后都在线，其中同一账号的常连接型插件（如 IM）可能互相争抢，' +
        '届时请只保留一个在线，或在新 Home 里调整对应凭据。',
    },
  )
  if (answer.response !== 0) return { ok: false }

  try {
    await cp(source, destination, { recursive: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Derives a registry id from a directory path.
 *
 * The base name is the obvious id and is what the user recognises, so it is used
 * as-is when free, and suffixed when taken — generating something
 * unrecognisable to dodge a collision would make the menu harder to read for no
 * benefit.
 *
 * @param {string} directory
 * @returns {Promise<string>}
 */
async function uniqueHomeId(directory) {
  const base = basename(directory).replace(/[^A-Za-z0-9._-]/g, '') || 'home'
  const taken = new Set(homeRegistry.homes.map((entry) => /** @type {any} */ (entry).id))
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * Forgets a home. The directory itself is left alone — deleting a user's kernel
 * profile out from under them because they removed an entry from a list is not
 * a thing this shell is willing to do. The built-in home cannot be removed.
 *
 * @param {string} id
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function forgetHome(id) {
  const target = homeRegistry.homes.find((entry) => /** @type {any} */ (entry).id === id)
  if (target === undefined) return { ok: false, error: `未知的 Home：${id}` }
  const next = removeHome(homeRegistry, id)
  if (next === homeRegistry) return { ok: false, error: '默认 Home 不可删除' }
  homeRegistry = next
  await saveHomeRegistry()
  return { ok: true }
}

/**
 * Best-effort sweep of the process trees a dead kernel left behind.
 *
 * @param {string} why - where in the lifecycle the sweep runs, for the log line
 * @returns {Promise<void>}
 */
// ═══ 1. 状态与收割（module state & orphan sweep）═══

async function sweepOrphans(why) {
  if (familyMarker === '') return
  const report = await reapOrphans({
    marker: familyMarker,
    kernelPid: currentKernelPid,
    log: (message) => console.log(`orphan-reaper[${why}]: ${message}`),
  })
  if (report.skipped === null && report.doomed.length > 0) {
    console.log(
      `orphan-reaper[${why}]: doomed ${report.doomed.length}, killed ${report.killed.length}, survived ${report.survived.length}`,
    )
  }
}

/**
 * Where the bundled kernel lives, packaged or not.
 *
 * `extraResources` places it beside the asar archive rather than inside it: files in an
 * asar cannot be spawned, so a kernel bundled the usual way would fail only once packaged.
 *
 * @returns {{binPath: string, nodePath: string, runElectronAsNode: boolean, root: string, systemKernel: boolean}}
 */
// ═══ 2. 内核解析与启动（kernel paths & lifecycle）═══

function resolveKernelPaths() {
  const root = app.isPackaged ? join(process.resourcesPath, 'kernel') : join(here, '..', 'resources', 'kernel')

  // System-kernel mode: when DSH_KERNEL_BIN is set, the shell drives an
  // externally-installed `dsh` (e.g. /usr/local/nodejs/bin/dsh) instead of the
  // bundled resources/kernel tree. The system bin is a plain JS file with a
  // `#!/usr/bin/env node` shebang, so it is still spawned through a real Node
  // — we resolve `node` from PATH so the kernel runs on the system Node rather
  // than Electron-as-Node. No bundled kernel, no shipped-plugin bootstrap, no
  // bundled Node download is required for this mode.
  const systemBin = process.env.DSH_KERNEL_BIN
  if (systemBin !== undefined && systemBin !== '') {
    console.log(`system-kernel mode: using ${systemBin} with system node`)
    return {
      binPath: systemBin,
      nodePath: 'node',
      runElectronAsNode: false,
      root,
      systemKernel: true,
    }
  }

  const binPath = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

  // A bundled Node is preferred when present: the kernel's dependencies are published and
  // tested against Node releases, and Electron's bundled Node is a different runtime that
  // merely resembles one. Falling back to Electron is supported, but it has to be told to
  // behave as Node — see buildKernelEnv.
  const bundled = join(root, nodeBinaryName(process.platform))
  const hasBundledNode = existsSync(bundled)

  return {
    binPath,
    nodePath: hasBundledNode ? bundled : process.execPath,
    runElectronAsNode: !hasBundledNode,
    root,
    systemKernel: false,
  }
}

/**
 * Walks the bundled `node_modules/` and returns every package that declares
 * itself as a dsh bundle (i.e. has a `dsh.bundle.patch` in its package.json) —
 * skipping the kernel's own `@deepseek-ai/*` packages, which the profile template
 * already covers.
 *
 * Used to discover shipped plugins at runtime: any package laid down under
 * `resources/kernel/node_modules/` by the build pipeline that ships a patch
 * layer gets picked up automatically, with no separate manifest to keep in sync.
 *
 * @param {string} nodeModulesRoot - absolute path of the bundled `node_modules/`
 * @returns {string[]} package names, in `node_modules/` directory order
 */
function discoverShippedPlugins(nodeModulesRoot) {
  if (!existsSync(nodeModulesRoot)) return []
  /** @type {string[]} */
  const shipped = []
  for (const entry of readdirSync(nodeModulesRoot)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@deepseek-ai/')) continue
    const pkgPath = join(nodeModulesRoot, entry, 'package.json')
    if (!existsSync(pkgPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg.dsh?.bundle?.patch !== undefined) shipped.push(entry)
    } catch {
      // An unreadable bundled package is a build error; surface it but do not
      // refuse to start the kernel over a missing optional plugin.
    }
  }
  return shipped
}

/**
 * Registers every shipped plugin into the user's profile manifest, so the kernel
 * loads it on boot the same way it would load a plugin the user installed
 * themselves.
 *
 * Why this is necessary: the kernel only loads packages listed in the profile's
 * `dsh.profile.bundles`. A plugin shipped alongside the kernel (laid down at build
 * time under `resources/kernel/node_modules/<plugin>/`) is reachable through the
 * install anchor when `resolveBundleDir` is asked for it — but it is not on the
 * bundle list until something puts it there. `dsh plugin --profile web add <path>`
 * would do this through pnpm, which would require pnpm to be on PATH on every
 * install. Editing the profile manifest directly avoids the pnpm dependency and
 * keeps the shipped copy where it already is: the user gets the same registry
 * entry as if they had installed it themselves, and `dsh plugin` later (which
 * pnpm does power) sees it as a regular dependency and leaves it alone.
 *
 * A second step is required because of how the kernel loads bundles: an entry
 * declared in a bundle's patch file is activated by `tree.import(<name>)` from
 * inside the profile directory, and Node's ESM resolution from there walks
 * `node_modules/` looking for `<name>`. The shipped copy sits in the kernel's
 * tree, not in the user's profile, and `healProfilesModuleFallback` only
 * symlinks the kernel manifest's declared dependencies — not anything added at
 * build time. Symlinking each shipped plugin into the profile's `node_modules/`
 * is what makes the dynamic import succeed without requiring pnpm to be on PATH.
 *
 * Idempotent: a profile that already lists every shipped plugin is left untouched
 * (the bundle list check is the source of truth); the symlink is also a no-op when
 * it already points at the same target.
 *
 * A failure here is logged but does not abort startup — the user gets a working
 * shell, just without the shipped plugins.
 *
 * @param {string} dshHome - this app's private kernel home
 * @param {string} shippedRoot - the directory of the bundled `node_modules/`
 * @returns {Promise<void>}
 */
async function ensureShippedPlugins(dshHome, shippedRoot) {
  const shippedNames = discoverShippedPlugins(shippedRoot)
  if (shippedNames.length === 0) return

  const profileDir = join(dshHome, 'profiles', 'web')
  const profileNodeModules = join(profileDir, 'node_modules')
  const manifestPath = join(profileDir, 'package.json')

  let existing = /** @type {{dependencies?: Record<string, string>, dsh?: {profile?: {bundles?: string[]}}} | null} */ (null)
  if (existsSync(manifestPath)) {
    try {
      existing = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      // A corrupt profile manifest is exactly what we are trying to amend — fall
      // through and rebuild the shape around the existing file rather than refusing
      // to start the kernel over a missing bundle.
      console.warn(`shipped plugins: existing profile manifest could not be parsed (${error instanceof Error ? error.message : String(error)}); rewriting`)
    }
  }

  const registeredBundles = new Set(existing?.dsh?.profile?.bundles ?? [])
  const missing = shippedNames.filter((name) => !registeredBundles.has(name))

  // Always ensure the symlinks, even on a re-run after the bundle list is already
  // up to date. A first launch that ran an earlier (no-symlink) version of this
  // step left the bundles registered but no profile-side link, which means a
  // later dynamic `import 'dshmarket'` from inside the profile still cannot
  // resolve the package.
  await mkdir(profileNodeModules, { recursive: true })
  const relinked = []
  for (const name of shippedNames) {
    const source = join(shippedRoot, name)
    const link = join(profileNodeModules, name)
    if (!existsSync(link)) {
      await mkdir(dirname(link), { recursive: true })
      await symlink(source, link, 'dir')
      relinked.push(name)
    }
  }
  if (relinked.length > 0) {
    console.log(`shipped plugins: linked ${relinked.join(', ')} into ${profileNodeModules}`)
  }

  if (missing.length === 0 && existing !== null) return

  // The bundles a fresh `dsh` profile starts with. Mirrors the template the
  // kernel's own `initProfile` would have written had it run first — and it
  // must, because this bootstrap runs before the kernel boots, so the kernel
  // sees the manifest as already initialised and skips its own template seed.
  // A profile that lists `dshmarket` but no `dsh-web-app` would boot the kernel
  // with no web surface at all.
  const WEB_PROFILE_TEMPLATE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

  // `dependencies` and `bundles` both need the shipped name. `bundles` is what
  // `loadProfile` walks to resolve and activate a layer; `dependencies` is what
  // `dsh plugin` later reads to decide whether a package is still installed
  // (without an entry here, a future reconciliation would prune the bundle).
  const manifest = existing ?? {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...WEB_PROFILE_TEMPLATE] } },
  }
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles ?? [...WEB_PROFILE_TEMPLATE]

  /** @type {Record<string, string>} */
  const dependencies = manifest.dependencies
  for (const name of missing) {
    const source = join(shippedRoot, name)
    dependencies[name] = `file:${source}`
    if (!manifest.dsh.profile.bundles.includes(name)) {
      manifest.dsh.profile.bundles.push(name)
    }
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`shipped plugins: registered ${shippedNames.join(', ')} into profile at ${profileDir}`)
}

/**
 * Builds the Safe Mode disable overlay and sets the user's patch layer aside.
 *
 * The overlay is a `--patch` file of `{ id, disabled: true }` rows — the same
 * disable mechanism the shell already uses, and the one the official shell
 * documents for its recovery action. The user's own patch file is renamed
 * rather than edited, so nothing they wrote is lost and the file can be put
 * back by hand.
 *
 * A profile with no third-party bundles has nothing to disable; that is not an
 * error, and no overlay is written.
 *
 * @param {string} dshHome - the kernel home the profile lives under
 * @returns {Promise<string | null>} the overlay path, or null when there is
 *   nothing to disable
 */
async function buildSafeModePatch(dshHome) {
  const profileDir = join(dshHome, 'profiles', getConfig().kernel.profile || 'web')
  const manifestPath = join(profileDir, 'package.json')

  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    console.warn('safe mode: profile manifest unreadable, starting without changes')
    return null
  }

  if (!hasSafeModeTargets(manifest)) {
    console.log('safe mode: no third-party bundles to disable')
    return null
  }

  // Set the user's patch layer aside before disabling anything, so a recovery
  // never destroys the configuration it is recovering from.
  const userPatch = join(profileDir, 'cordis.patch.yml')
  if (existsSync(userPatch)) {
    try {
      const target = nextBackupPath(userPatch, (candidate) => existsSync(candidate))
      await rename(userPatch, target)
      console.log(`safe mode: profile patch moved to ${target}`)
    } catch (error) {
      console.warn(
        `safe mode: could not back up the profile patch (${error instanceof Error ? error.message : String(error)}); continuing`,
      )
    }
  }

  const overlay = toDisablePatch(safeModeTargets(manifest))
  const overlayPath = join(app.getPath('userData'), 'safe-mode.patch.yml')
  await writeConfigFile(overlayPath, serialisePatch(overlay))
  console.log(`safe mode: disabling ${overlay.length} third-party bundle(s)`)
  return overlayPath
}

/**
 * Toggles Safe Mode and restarts the kernel so it takes effect.
 *
 * Safe Mode is deliberately not persisted: it is a recovery action, and a
 * normal restart should give the user their plugins back unless they ask for
 * Safe Mode again. Storing it would mean a shell that silently stays
 * degraded — which is the failure it exists to escape.
 *
 * @returns {Promise<void>}
 */
async function toggleSafeMode() {
  safeMode = !safeMode
  console.log(`safe mode: ${safeMode ? 'on' : 'off'}`)
  tray?.setSafeMode(safeMode)
  await restartKernel()
  await pushDesktopState()
}

/**
 * What is published at the `dsh` command path, for the tray item.
 *
 * @returns {Promise<'ours' | 'foreign' | 'stale' | 'absent'>}
 */
async function readCommandState() {
  try {
    return (await describeCommand()).state
  } catch (error) {
    console.warn(`could not read the dsh command: ${error instanceof Error ? error.message : String(error)}`)
    return 'absent'
  }
}

/**
 * Publishes or removes the `dsh` command, then reports what happened.
 *
 * The target is this shell's own launcher, not the kernel binary it currently
 * supervises: the command should survive a kernel restart and a home switch,
 * and it should keep working after this release is upgraded.
 *
 * @returns {Promise<void>}
 */
async function toggleCommand() {
  const state = await readCommandState()
  const result = state === 'ours'
    ? await uninstallCommand()
    : await installCommand({ target: process.execPath, args: [here, '--profile', 'web'] })
  tray?.setCommandState(await readCommandState())
  const detail = result.ok
    ? state === 'ours'
      ? '已从 PATH 移除'
      : '已安装，新开的终端里可用'
    : result.message
  if (result.ok === false) console.warn(`dsh command: ${result.message}`)
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    void dialog.showMessageBox(mainWindow, {
      type: result.ok ? 'info' : 'warning',
      message: 'dsh 命令',
      detail,
      buttons: ['好'],
    })
  }
}

/**
 * Sends the current stage to the loading page, retrying until the page's script
 * is actually running.
 *
 * The page is a `data:` URL whose inline script defines `__dshStage`. An
 * `executeJavaScript` fired before that script runs finds the function
 * missing, and a naive `window.__dshStage && ...` guard then drops the update
 * silently — which is exactly why the stage text never advanced past
 * "preparing". The retry makes delivery independent of that race.
 *
 * @param {string} stage
 * @param {number} retryDelayMs
 * @param {number} [attempt]
 * @returns {void}
 */
function pushStage(stage, retryDelayMs, attempt = 0) {
  const window_ = mainWindow
  if (window_ === null || window_.isDestroyed()) return
  void window_.webContents
    .executeJavaScript(
      `(function(){if(typeof window.__dshStage!=='function')return false;` +
        `window.__dshStage(${JSON.stringify(stage)}, ${Number(retryDelayMs)});return true})()`,
      true,
    )
    .then((applied) => {
      if (applied === true || attempt >= 40) return
      setTimeout(() => pushStage(stage, retryDelayMs, attempt + 1), 50)
    })
    .catch(() => {
      if (attempt < 40) setTimeout(() => pushStage(stage, retryDelayMs, attempt + 1), 50)
    })
}

/**
 * Streams a kernel's output into the loading page's log pane.
 *
 * Batched on a short interval rather than pushed per line: the kernel writes
 * one line per plugin and per MCP server, and an `executeJavaScript` call per
 * line would cost more than the kernel itself. The pane only exists while the
 * loading page is showing; once the real UI takes over, the injections become
 * no-ops and the buffer is dropped.
 *
 * @param {import('./kernel-process.js').KernelProcess} process_
 * @returns {() => void} detach
 */
function attachKernelOutput(process_) {
  /** @type {string[]} */
  let pending = []
  let timer = /** @type {NodeJS.Timeout | null} */ (null)

  const flush = () => {
    timer = null
    if (pending.length === 0) return
    const batch = pending
    pending = []
    const window_ = mainWindow
    if (window_ === null || window_.isDestroyed()) return
    // Guarded the same way `pushStage` is: `__dshLog` only exists once the
    // loading page's own script has run, and an unguarded call would throw
    // into the catch and lose the batch. Unclaimed lines are simply left in
    // `pending` to go out with the next flush while the page is coming up.
    window_.webContents
      .executeJavaScript(
        `(function(){if(typeof window.__dshLog!=='function')return false;` +
          // Each line is JSON-encoded, so a quote or backslash in kernel
          // output cannot break out of the injected script.
          batch.map((line) => `window.__dshLog(${JSON.stringify(line)})`).join(';') +
          `;return true})()`,
        true,
      )
      .then((applied) => {
        if (applied === false) pending = batch.concat(pending)
      })
      .catch(() => {
        pending = batch.concat(pending)
      })
  }

  const detach = process_.onOutput((line) => {
    pending.push(line)
    // Cap the queue so a kernel that floods output cannot grow this without
    // bound while the page is slow to accept it.
    if (pending.length > 300) pending = pending.slice(-300)
    if (timer === null) timer = setTimeout(flush, 120)
  })

  return () => {
    detach()
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * The port to launch on: the official default when it is free, otherwise any
 * free port.
 *
 * A fixed port makes the kernel's address predictable across launches, which
 * matters for anything that remembers it. But a port held by another process —
 * a kernel from a launch that did not shut down cleanly — must not stop this
 * launch, so the preference degrades rather than fails.
 *
 * @param {string} host
 * @returns {Promise<number>}
 */
// ═══ 3. 就绪与端口（readiness & port）═══

async function preferredPort(host) {
  // Deliberately always ephemeral — see the comment above this function. A
  // fixed port can be held by another dsh instance, and probing a stranger's
  // kernel is what produced the startup timeout.
  return findFreePort(host)
}

/**
 * Reads the environment the kernel should launch under.
 *
 * A GUI launch on Linux and macOS inherits only what the session manager
 * hands it, so everything the user's shell startup files export — `PATH`
 * additions, proxy variables, package mirrors, locale — is missing. The kernel
 * would then run in a different environment than the user's own terminal, and
 * the symptom is tools that work in one place and not the other.
 *
 * Failure is never fatal. The probe runs arbitrary rc files; when none of the
 * candidate shells produces an environment the inherited one is used and the
 * reason is logged, because a shell that cannot be read must not stop the app
 * from starting.
 *
 * @returns {Promise<NodeJS.ProcessEnv>} the environment for the kernel
 */
async function readLaunchEnvironment() {
  if (process.platform === 'win32') return { ...process.env }
  const timeoutMs = resolveLoginShellConfig(process.env)
  const { environment, failures } = await readLoginShellEnvironment(process.env, timeoutMs)
  if (failures.length > 0) {
    const detail = failures.map((failure) => `${failure.shell} (${failure.reason})`).join(', ')
    // Every candidate failing is worth a line; some shells are simply absent,
    // so only the first shell's absence is unremarkable.
    console.warn(`login-shell environment unavailable, using the inherited environment: ${detail}`)
  }
  return { ...environment }
}

/**
 * Starts the kernel and waits until it is genuinely serving.
 *
 * @returns {Promise<{origin: string, token: string | null}>}
 * @throws when the kernel cannot be started or never becomes ready
 */
async function startKernel() {
  const { binPath, nodePath, runElectronAsNode, root: kernelRoot, systemKernel } = resolveKernelPaths()
  systemKernelMode = systemKernel
  if (systemKernel) {
    // System-kernel mode: the user's own `dsh` already exists and is installed
    // independently. We must not gate on the bundled resources/kernel tree, nor
    // run the shipped-plugin bootstrap — that only applies to the bundled path.
    if (!existsSync(binPath)) {
      throw new Error(
        `DSH_KERNEL_BIN points to ${binPath}, which does not exist.\n` +
        `Remove the environment variable to fall back to the bundled kernel.`,
      )
    }
  } else {
    if (!existsSync(binPath)) {
      throw new Error(
        `The kernel is not installed at:\n  ${binPath}\n\nRun "npm run kernel:install" first.`,
      )
    }

    // When Electron is standing in for Node, the runtime the kernel gets is the one this
    // process is already running on, so `process.version` is exactly the version to check.
    if (runElectronAsNode && !isSupportedNodeVersion(process.version)) {
      throw new Error(
        `The kernel needs Node 22.15.0 or newer; this build of Electron provides ${process.version}.`,
      )
    }
  }

  // DSH_HOME is where the kernel keeps its profile. There can now be more than
  // one: the registry lists the homes this shell knows about, and which one is
  // in use is decided here once, then switched at runtime by `switchHome()`.
  //
  // The resolution order is "most explicit first": a `--dsh-home` flag beats the
  // environment, which beats the remembered choice, which beats the plain
  // `homeSubdir` default. See {@link module:dsh-home-manager} for the reasoning.
  //
  // Anything still written as `~` or relative goes through the same expansion as
  // before — `~/.dsh` is not an absolute path as far as Node is concerned, and
  // treating it as one relative to `userData` used to produce a literal
  // directory named `~`, against which the kernel then started with an empty
  // home and appeared to ignore every plugin the user had installed.
  const homeSubdir = getConfig().kernel.homeSubdir
  const userData = app.getPath('userData')
  const defaultPath = resolveSubdir({ homeSubdir, userData })
  homeRegistry = await loadHomeRegistry(userData, defaultPath)

  const chosen = chooseHome({
    homes: homeRegistry.homes,
    activeId: homeRegistry.activeId,
    defaultPath,
    cliValue: readCliHome(process.argv),
    envValue: process.env.DSH_HOME,
  })
  dshHome = chosen.path
  dshHomeSource = chosen.source
  console.log(`using kernel home ${dshHome} (selected by ${dshHomeSource})`)
  await mkdir(dshHome, { recursive: true })

  // Shipped plugins must be registered in the profile before the kernel starts, so
  // their patch layers are part of the very first profile load. Failures here are
  // logged and swallowed — the user still gets a working shell, just without the
  // bundled defaults. In system-kernel mode this bootstrap is skipped entirely:
  // the system install owns its own plugins.
  if (!systemKernel) {
    try {
      await ensureShippedPlugins(dshHome, join(kernelRoot, 'node_modules'))
    } catch (error) {
      console.warn(`shipped plugins bootstrap failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Whether the native folder dialog can be trusted. The official shell falls
  // back to browse mode when Linux has neither zenity nor kdialog, because
  // Electron's native dialog shells out to one of them and silently does
  // nothing without it. An explicit `directoryPicker` override in config.json
  // wins over the probe.
  const useBrowse = shouldUseBrowsePicker({
    platform: process.platform,
    pathValue: process.env.PATH ?? '',
    mode: /** @type {'auto' | 'browse' | 'native'} */ (
      getConfig().kernel?.directoryPicker ?? 'auto'
    ),
  })
  if (useBrowse) {
    console.log('directory picker: no zenity/kdialog on PATH, using browse mode')
  }
  const patchEntries = buildShellPatch({ useBrowseDirectoryPicker: useBrowse })
  /** @type {string[]} */
  const patchFiles = []
  if (patchEntries.length > 0) {
    const patchPath = join(app.getPath('userData'), 'shell.patch.yml')
    await writeConfigFile(patchPath, serialisePatch(patchEntries))
    patchFiles.push(patchPath)
  }

  // Safe Mode: start without the user's third-party bundles, and set their
  // patch layer aside. This is the way out of a plugin that crashes the kernel
  // at load time — a shell that cannot start cannot be told to remove the
  // plugin, so the next launch has to be able to start without it.
  if (safeMode) {
    const safePath = await buildSafeModePatch(dshHome)
    if (safePath !== null) patchFiles.push(safePath)
  }

  // The kernel is supervised rather than spawned once: if it exits after the
  // window is up, the supervisor starts it again on a bounded backoff, and the
  // state callback below is what the loading page and the tray read. Each
  // attempt takes a fresh port, because the port the last one died on may
  // still be in TIME_WAIT.
  //
  // The environment the kernel launches under is read once, before the first
  // attempt: a GUI launch on Linux and macOS inherits only the session
  // manager's variables, so `PATH` additions, proxy settings and mirrors from
  // the user's shell startup files are missing — the kernel would then run in a
  // different environment than the user's terminal. Retries reuse the same
  // read: the answer cannot change mid-launch, and an rc file that hangs would
  // otherwise be able to stall every attempt.
  const launchEnv = await readLaunchEnvironment()
  const supervisor = new KernelSupervisor({
    onState: (state) => {
      // Keep the latest state where both the tray and a late-coming window can
      // read it, then push it to whichever is already alive.
      kernelState = state
      tray?.setState(state)
      // Keep the in-page controls in step with the tray status line.
      void pushDesktopState()
      if (mainWindow === null || mainWindow.isDestroyed()) return
      const stage = state.phase === 'starting' ? (state.stage ?? 'launching') : undefined
      if (stage === undefined) return
      // Advance the loading page in place rather than reloading it: a reload
      // restarts the elapsed counter and makes the earlier stages unreachable,
      // which is what made the whole progress display invisible.
      pushStage(stage, state.retryDelayMs ?? 0)
    },
    /** @returns {Promise<{nodePath: string, args: string[], env: Record<string,string>, cwd: string}>} */
    launchSpec: async () => {
      const port = await preferredPort(HOST)
      // Read `dshHome` per launch rather than capturing it once: switching homes
      // is implemented as "change the variable, restart the kernel", and every
      // attempt — including the retries the supervisor makes on its own — has
      // to use whichever home is current at that moment.
      const kernelEnv = buildKernelEnv({ parentEnv: launchEnv, dshHome, runElectronAsNode })
      return {
        nodePath,
        args: buildKernelArgs({ binPath, port, patchFiles }),
        env: { ...kernelEnv, ...familyMarkerEnv(process.env, app.getPath('userData')) },
        cwd: app.getPath('home'),
      }
    },
  })

  // From here on the family marker is known and the reaper can attribute
  // processes; the marker value must match what the launch above injects (or
  // what the launcher already provided), so it is derived the same way.
  familyMarker = markerValueFor(process.env, app.getPath('userData'))

  const process_ = await supervisor.start()
  kernel = supervisor
  currentKernelPid = process_.pid ?? null

  // What the last launch left behind: a kernel that died unplanned — a crash,
  // or the market helper swapping the process — cannot collect its MCP
  // chains, so a sweep at every launch caps the leak at one generation.
  void sweepOrphans('startup')

  // Stream the kernel's own output to the loading page, so a slow start shows
  // what it is doing instead of an opaque spinner. Batched: the kernel emits
  // hundreds of lines (one per plugin), and one `executeJavaScript` per line
  // would cost more than the kernel does.
  attachKernelOutput(process_)

  // A supervisor that has run out of restarts is the one case the user has to
  // be told about: the window cannot recover by waiting. Record it and show
  // the error page rather than a silent blank surface.
  supervisor.onGaveUp(() => {
    // The kernel is gone for good; nothing supervises its servants any more.
    currentKernelPid = null
    void sweepOrphans('gave-up')

    // The in-window error page explains but offers nothing, and by this point
    // the window is showing that page because the app has nothing better to
    // render. A native dialog carries the same report plus a way forward — and
    // a port collision, the failure a user can actually do something about, is
    // called out separately so they do not go hunting for a broken plugin.
    void reportFatal({
      error: new Error('内核反复退出，已停止自动重启', {
        cause: new Error(tail(process_.logText(), 25)),
      }),
      source: 'host',
      writeReport: () =>
        writeCrashReport({
          userData: app.getPath('userData'),
          source: 'host',
          appVersion: app.getVersion(),
          message: 'kernel gave up after repeated exits',
          output: process_.logText(),
        }),
      show: async ({ detail, buttons }) => {
        const { response } = await dialog.showMessageBox({
          type: 'error',
          title: 'DeepSeek Harness 启动失败',
          message: 'DeepSeek Harness 启动失败',
          detail,
          buttons,
          defaultId: 1,
          cancelId: 0,
          noLink: true,
        })
        return response
      },
      stop: async () => {
        await supervisor.stop().catch(() => undefined)
      },
      disablePlugins: async () => {
        // The next launch starts without third-party bundles. Setting the flag
        // is what `restartKernel` reads, so the relaunch below picks it up.
        safeMode = true
        tray?.setSafeMode(true)
      },
      exit: () => {
        app.exit(1)
      },
      restart: () => {
        app.relaunch()
        app.exit(0)
      },
    })

    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      void loadErrorPage(mainWindow, '内核启动失败，未能就绪。', tail(process_.logText(), 25))
    }
  })
  // A single unexpected exit is still worth recording, even when a restart
  // follows: the restart hides the crash, but the crash still happened. It is
  // also the one moment the dead launch's MCP chains have escaped collection
  // but are not yet replaced by the next launch — sweep here, before the
  // backoff timer spawns a fresh kernel that would make every marked process
  // look attributable again.
  process_.onUnexpectedExit(({ code, signal }) => {
    currentKernelPid = null
    void sweepOrphans('unexpected-exit')
    void writeCrashReport({
      userData: app.getPath('userData'),
      source: 'host',
      appVersion: app.getVersion(),
      message: `kernel exited unexpectedly: code=${String(code)} signal=${String(signal)}`,
      output: process_.logText(),
    }).catch(() => undefined)
  })

  // The port the supervisor actually launched on: it is chosen inside
  // launchSpec, so it is read back out of the argument vector the process was
  // started with, rather than assumed from a value computed earlier.
  const launchedArgs = process_.args ?? []
  const portIndex = launchedArgs.indexOf('--port')
  const port = Number(portIndex >= 0 ? launchedArgs[portIndex + 1] : NaN)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not read the kernel port back from ${launchedArgs.join(' ')}`)
  }
  const origin = kernelOrigin(HOST, port)

  // Newer kernels gate the web surface behind a per-launch token. The token
  // is captured by the kernel process from its raw stdout, before the Log
  // buffer redacts it; a bare probe gets a 401 until that credential is
  // carried. Older kernels print no token, `webToken()` stays null, and the
  // probe degrades to the plain one.
  /** @param {string} url @param {AbortSignal} signal */
  const probeWithToken = (url, signal) => httpProbe(tokenised(url, process_.webToken()), signal)

  const readiness = await waitForReady({
    url: `${origin}/`,
    isCurrent: () => process_.isRunning(),
    probe: systemKernel ? probeWithToken : httpProbe,
    // From config.json. This used to omit `timeoutMs` entirely, so the
    // documented `supervisor.readinessTimeoutMs` was dead configuration and
    // the hard-coded 90 s in readiness.js always won — a kernel that needed
    // longer failed regardless of what the file said.
    timeoutMs: getConfig().supervisor.readinessTimeoutMs,
  })

  if (!readiness.ok) {
    const why =
      readiness.reason === 'process-gone'
        ? 'The kernel exited during startup.'
        : 'The kernel did not start responding in time.'
    throw new Error(`${why}\n\nRecent output:\n${tail(process_.logText(), 25)}`)
  }

  supervisor.markReady(`${origin}/`)
  const token = process_.webToken()
  return { origin, token }
}

/**
 * Attaches the kernel's per-launch token to a probe URL, so a 401-gated web
 * surface is probed (and the window opened) with the credential in hand.
 *
 * @param {string} url - bare origin URL, e.g. `http://127.0.0.1:41235/`
 * @param {string | null} token - extracted from the kernel log, or null
 * @returns {string} the URL to probe / load
 */
function tokenised(url, token) {
  if (token === null || url.includes('token=')) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/**
 * Reloads the window back onto the kernel after a renderer dies, at most a few
 * times within a rolling window.
 *
 * @param {BrowserWindow} window
 * @param {() => {origin: string | null, token: string | null}} endpoint
 * @param {number[]} times - epoch millis of past recoveries
 * @param {(next: number[]) => void} setTimes
 * @returns {Promise<void>}
 */
async function recoverRenderer(window, endpoint, times, setTimes) {
  const now = Date.now()
  const recent = times.filter((time) => time >= now - RENDERER_RECOVERY_WINDOW_MS)
  if (recent.length >= MAX_RENDERER_RECOVERIES) {
    console.error(`renderer recovery exhausted (${recent.length} attempts); giving up`)
    setTimes(recent)
    return
  }
  const next = [...recent, now]
  setTimes(next)
  if (window.isDestroyed()) return
  // Read the endpoint at recovery time, not at handler-install time: the
  // window exists before the kernel does, so an origin captured when the
  // handler was attached would be null forever.
  const { origin } = endpoint()
  if (origin === null) return
  try {
    await window.loadURL(APP_URL)
  } catch (error) {
    console.error(`renderer recovery failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Installs the OS application menu.
 *
 * The official shell's about panel shows the app icon, the product name and
 * the installed release version. Electron reads the icon from the application
 * bundle on macOS, and on Linux and Windows from the PNG distributed with the
 * package — which is why `setAboutPanelOptions` is given the same icon the
 * window uses, so an about panel opened before any bundle exists still shows
 * something.
 *
 * @param {BrowserWindow} window - the window DevTools is toggled on
 * @returns {void}
 */
function installApplicationMenu(window) {
  const iconPath = join(here, '..', 'assets', 'icon.png')

  app.setAboutPanelOptions({
    applicationName: 'DeepSeek Harness Desktop',
    applicationVersion: app.getVersion(),
    iconPath: existsSync(iconPath) ? iconPath : undefined,
  })

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppMenuTemplate(
        { platform: process.platform, appName: 'DeepSeek Harness', safeMode },
        {
          showAbout: () => app.showAboutPanel(),
          toggleSafeMode: () => void toggleSafeMode(),
          quit: () => void requestQuit(),
          closeWindow: () => {
            if (window.isDestroyed()) return
            // Match the window's own close handler: hide rather than quit, so
            // the kernel and its tasks keep running — including asking first,
            // since from a menu the outcome is just as invisible.
            if (tray === null || tray.isQuitting) window.close()
            else backgroundNotice().close(() => window.hide())
          },
          reload: () => {
            if (!window.isDestroyed()) window.webContents.reload()
          },
          toggleDevTools: () => {
            if (window.isDestroyed()) return
            window.webContents.toggleDevTools()
          },
          checkForUpdates: () => void checkForUpdates(),
        },
      ),
    ),
  )
}

/**
 * Where the window's geometry is remembered, under `userData` and separate
 * from `DSH_HOME` — it is a preference about the desktop surface, not about
 * the kernel.
 *
 * @returns {string}
 */
function windowStatePath() {
  return join(app.getPath('userData'), 'window-state.json')
}

/**
 * Reads the remembered geometry, tolerating a missing or unreadable file.
 *
 * @returns {unknown} parsed contents, or null when there is nothing usable
 */
function readWindowState() {
  try {
    return JSON.parse(readFileSync(windowStatePath(), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Loads the static loading page (served over the `dsh-app://` scheme) and
 * pushes its initial parameters via `executeJavaScript`.
 *
 * The page is a plain file under `renderer/` — it does not embed any state,
 * so the main process has to hand the start timestamp over after load. The
 * retry loop in `pushStage` already handles the "function not yet defined"
 * case, so this is a plain `executeJavaScript` call here.
 *
 * @param {BrowserWindow} window
 * @param {string} stage
 * @param {number} startedAt
 * @returns {Promise<void>}
 */
async function loadLoadingPage(window, stage, startedAt) {
  await window.loadURL(LOADING_URL)
  void window.webContents
    .executeJavaScript(`window.__dshShellInit && window.__dshShellInit(${Number(startedAt)})`, true)
    .catch(() => { /* page's script not yet running; pushStage will retry */ })
  pushStage(stage, 0)
}

/**
 * Loads the static error page and pushes the error body + log tail.
 *
 * @param {BrowserWindow} window
 * @param {string} body - the human-readable error message
 * @param {string} logTail - the kernel's last N lines of output
 * @returns {Promise<void>}
 */
async function loadErrorPage(window, body, logTail) {
  await window.loadURL(ERROR_URL)
  void window.webContents
    .executeJavaScript(
      `(function(){ if (typeof window.__dshShellError !== 'function') return false;
        window.__dshShellError(${JSON.stringify(body)}, ${JSON.stringify(logTail)}); return true })()`,
      true,
    )
    .catch(() => { /* page's script not yet running; user can reload manually */ })
}

/**
 * Remembers the window's geometry for the next launch.
 *
 * Best-effort: failing to remember a size must never stop the window from
 * being used.
 *
 * @param {BrowserWindow} window
 * @returns {void}
 */
function persistWindowState(window) {
  if (window.isDestroyed()) return
  try {
    const state = captureWindowState(window)
    void writeConfigFile(windowStatePath(), `${JSON.stringify(state, null, 2)}\n`).catch(
      () => undefined,
    )
  } catch {
    // intentionally empty
  }
}

/**
 * The window is created *before* the kernel is up, so it can show the loading
 * page while the kernel starts — waiting for the kernel first leaves the user
 * staring at nothing, which on a slow first launch is most of the wait.
 *
 * `origin` and `token` are therefore not known yet. They live in a mutable
 * closure the kernel-start path fills in via the returned handle, and every
 * navigation decision reads that closure rather than a captured value. Until
 * the origin is known, no external navigation is allowed at all — the loading
 * page is a `data:` URL and needs no origin.
 *
 * @returns {{window: BrowserWindow, setKernel: (origin: string, token: string | null) => void}}
 */
// ═══ 4. 窗口与渲染进程自愈（window & renderer recovery）═══

function createWindow() {
  /** @type {string | null} */
  let origin = null
  /** @type {string | null} */
  let token = null

  /**
   * Presents the kernel's browser ticket on WebSocket dials from this window.
   *
   * The kernel's frontend builds its socket address from `document.baseURI`, so
   * from `dsh-app://app/` it dials `ws://app/…` and the `dsh-app` scheme layer
   * is what turns that into a real connection — the URL stays as-is. What the
   * kernel refuses is the request's headers: its `Connection.admit()` requires
   * a recognised origin and an authority-bound signed cookie, the same ticket
   * the entry handshake handed out. The launch token is not accepted there; it
   * only ever mints that cookie.
   *
   * @param {Electron.WebContents} webContents - the contents to attach to
   * @returns {void}
   */
  const installWebSocketRewrite = (webContents) => {
    webContents.session.webRequest.onBeforeSendHeaders({ urls: ['ws://*/*'] }, (details, callback) => {
      // Only this window's own sockets are the kernel's to authenticate; a guest
      // page's WebSocket is none of the shell's business.
      if (webContents.id !== details.webContentsId || origin === null) {
        callback({})
        return
      }
      const headers = Object.fromEntries(
        Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]),
      )
      if (headers.origin !== `${SCHEME.shell}://${SCHEME_ROUTES.kernel}`) {
        callback({})
        return
      }
      const rewritten = rewriteWebSocketHeaders(headers, {
        kernelOrigin: origin,
        ticketOf: () => kernelTicket(shellProtoState),
      })
      if (rewritten === headers) {
        callback({})
        return
      }
      callback({ requestHeaders: rewritten })
    })
  }

  /**
   * Records the kernel endpoint once it is known, and points the window at it.
   *
   * @param {string} nextOrigin
   * @param {string | null} nextToken
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line jsdoc/require-param
  const setKernel = async (nextOrigin, nextToken) => {
    origin = nextOrigin
    token = nextToken

    // Hold the loading page long enough to be read. The kernel is often ready
    // in a few seconds, and switching the moment it is would make the log pane
    // — the whole point of this screen — a flicker.
    const minimum = Number(getConfig()?.splashMinMs ?? DEFAULT_SPLASH_MIN_MS)
    if (Number.isFinite(minimum) && minimum > 0 && startupBeganAt > 0) {
      const remaining = minimum - (Date.now() - startupBeganAt)
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
    }

    if (window.isDestroyed()) return
    void window.loadURL(APP_URL)
  }

  /**
   * Whether a URL belongs to the kernel that is actually serving.
   *
   * @param {string} url
   * @returns {boolean}
   */
  const isKernelUrl = (url) => origin !== null && isAllowedNavigation(url, origin)
  // Geometry the user last left behind, validated against the displays that
  // are connected now — a monitor unplugged since the last launch would
  // otherwise leave the window somewhere it cannot be seen.
  const restored = fitWindowState(
    readWindowState(),
    screen.getAllDisplays().map((d) => d.workArea),
  )

  const window = new BrowserWindow({
    width: restored.width,
    height: restored.height,
    ...(restored.x === undefined ? {} : { x: restored.x, y: restored.y }),
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#1b1b1f',
    title: 'DeepSeek Harness Desktop',
    icon: join(here, '..', 'assets', 'icon.png'),
    // The menu bar is kept but stays out of the way until Alt is pressed. The
    // chat UI is driven by the rendered web surface; the menu exists because
    // the official shell keeps one on Linux.
    autoHideMenuBar: true,
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      // Absolute path required by Electron — a relative preload silently fails
      // to attach (and the renderer is then unable to call `shell.notify`).
      // `here` is the directory of this `main.js` script, so the same path
      // works in dev (`src/preload.cjs`) and in the packaged app.
      //
      // The `.cjs` extension is load-bearing, not cosmetic: `package.json`
      // declares `"type": "module"`, which makes every `.js` under this
      // directory an ES Module. A sandboxed preload must be CommonJS — it runs
      // with no Node module loader and reads `contextBridge` / `ipcRenderer`
      // off Electron's injected globals. Loaded as ESM those globals never
      // materialise, so the preload dies with `contextBridge is not defined`
      // and the renderer loses every bridge method (observed as a black
      // window). Naming it `.cjs` opts it out of the ESM interpretation.
      preload: join(here, 'preload.cjs'),
    },
  })

  // The OS menu bar is kept, not removed.
  //
  // This used to be `Menu.setApplicationMenu(null)`, which took the bar off
  // every platform. That contradicts the behaviour the official shell
  // documents — "Linux 保留应用菜单和 Edit 菜单" and an About item that opens
  // Electron's native about panel — so it is now a real menu instead.
  //
  // The menu still does not drive the chat UI; it exists because the platform
  // is expected to have one. DevTools is registered as hidden items so F12 and
  // Ctrl+Shift+I work in packaged builds without advertising the entry.
  installApplicationMenu(window)

  // The preload (`src/preload.cjs`) is the only piece of shell-side code the
  // renderer can call into. Its surface is locked to `notify` and `onShown` —
  // see `src/preload.cjs` for the rationale.

  const { webContents } = window

  // The page in this window is the kernel's web UI — whatever it and its
  // plugins render — not shell code. It has no reason to ask the OS for a
  // camera, microphone, clipboard or notification, and Electron would prompt
  // for them by default.
  denyUnexpectedPermissions(webContents.session)

  // Remember the geometry the user chose, so the next launch opens the way
  // they left it rather than at a fixed size.
  window.on('resized', () => persistWindowState(window))
  window.on('moved', () => persistWindowState(window))
  if (restored.isMaximized === true) window.maximize()

  // The built-in loading and error pages are `data:` URLs — they are the shell's
  // own content, served by nobody, so navigation to them is always allowed.
  // Everything else still goes through the origin policy below.
  /** @param {string} url */
  const isShellPage = (url) => url.startsWith('data:')

  // Right-click menu. Electron ships with none, so every text field in the
  // kernel UI would be right-click-hostile: no paste into the composer, no
  // copy out of a transcript. The menu is built from the edit state Chromium
  // reports rather than a fixed template, so items appear only where they
  // would actually do something.
  //
  // Labels are given explicitly because a bare `role` takes its text from
  // Electron's own translations, which have no Chinese — the rest of this
  // shell's menus are Chinese for the same reason (`app-menu.js`). The role
  // still does the work; only the wording is ours.
  /** @type {Readonly<Record<string, string>>} */
  const EDIT_LABELS = Object.freeze({
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
  })
  webContents.on('context-menu', (_event, { isEditable, selectionText, editFlags }) => {
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const items = []
    /**
     * @param {NonNullable<Electron.MenuItemConstructorOptions['role']>} role
     *   the native edit role to render
     * @param {boolean} enabled - whether Chromium reports the action possible
     * @returns {Electron.MenuItemConstructorOptions}
     */
    const item = (role, enabled) => ({ role, label: EDIT_LABELS[role], enabled })
    if (isEditable) {
      items.push(
        item('undo', editFlags.canUndo),
        item('redo', editFlags.canRedo),
        { type: 'separator' },
        item('cut', editFlags.canCut),
        item('copy', editFlags.canCopy),
        item('paste', editFlags.canPaste),
        { type: 'separator' },
        item('selectAll', editFlags.canSelectAll),
      )
    } else if (selectionText.length > 0) {
      items.push(item('copy', editFlags.canCopy))
    }
    // An empty accelerator suppresses the default shortcut label Electron
    // would otherwise print next to each native role (`Ctrl+C`, `⌘C`).
    if (items.length === 0) return
    Menu.buildFromTemplate(items.map((entry) => ({ ...entry, accelerator: '' }))).popup({ window })
  })

  webContents.on('will-navigate', (event, url) => {
    if (isShellPage(url)) return
    if (!isKernelUrl(url)) {
      event.preventDefault()
      if (origin !== null && classifyWindowOpen(url, origin) === 'external') {
        void shell.openExternal(url)
      }
    }
  })

  webContents.setWindowOpenHandler(({ url }) => {
    const action = origin === null ? 'deny' : classifyWindowOpen(url, origin)
    if (action === 'external') void shell.openExternal(url)
    // Never `allow`: a new BrowserWindow created this way would not inherit the policy
    // applied above, so kernel URLs are navigated in place instead.
    if (action === 'same-window') void webContents.loadURL(url)
    return { action: 'deny' }
  })

  // A webview can carry its own webPreferences and would bypass every setting above.
  webContents.on('will-attach-webview', (event) => event.preventDefault())

  // Dual-channel: let the kernel's `ws://127.0.0.1` streaming surface reach
  // Chromium's dial-out even though the page lives under the `dsh-app` scheme.
  installWebSocketRewrite(webContents)

  // Renderer self-healing: a crashed or failed-to-load renderer is reloaded
  // back onto the kernel URL a bounded number of times, so a transient
  // renderer death does not leave the user looking at a dead window. Past the
  // limit it stops retrying — a page that keeps dying is a problem the user
  // has to see, not something to reload forever.
  /** @type {number[]} */
  let rendererRecoveries = []
  webContents.on('render-process-gone', (_event, details) => {
    console.error(`renderer gone: ${details.reason}`)
    void recoverRenderer(window, () => ({ origin, token }), rendererRecoveries, (next) => {
      rendererRecoveries = next
    })
  })
  webContents.on('did-fail-load', (_event, errorCode, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || validatedURL.startsWith('data:')) return
    console.error(`load failed (${errorCode}): ${description}`)
    void recoverRenderer(window, () => ({ origin, token }), rendererRecoveries, (next) => {
      rendererRecoveries = next
    })
  })

  // Install the busy→idle observer every time the page finishes loading. The
  // observer is idempotent (guards itself on `window.__DSH_SHELL_OBSERVER__`),
  // so re-injection on SPA route changes is cheap.
  webContents.on('did-finish-load', () => {
    void webContents.executeJavaScript(OBSERVER_SOURCE, true).catch((error) => {
      console.error(`observer inject failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    // The page decides its own theme; Electron's chrome has to follow it or the
    // window frame and native menus disagree with the window's contents.
    void webContents.executeJavaScript(themeBridgeScript(), true).catch((error) => {
      console.error(`theme bridge inject failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    // Preload self-check. DevTools reports a preload problem as
    // "Unable to load preload script" without saying whether the file was
    // missing, unreadable or threw while running, so read the mark the preload
    // leaves on the page and report which of those it was.
    void webContents.executeJavaScript('typeof globalThis.__dshPreloadProbe', true)
      .then((probe) => {
        if (probe === 'object') {
          console.log('preload: loaded, window.__dshPreloadProbe present')
          return
        }
        const message = `preload NOT loaded (window.__dshPreloadProbe is ${String(probe)})`
        console.error(message)
        void writeCrashReport({
          userData: app.getPath('userData'),
          source: 'renderer',
          appVersion: app.getVersion(),
          message,
          output: `window.__dshPreloadProbe → ${String(probe)}\npreload path → ${join(here, 'preload.cjs')}`,
        }).catch(() => undefined)
      })
      .catch((error) => {
        console.error(`preload probe failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  })

  // Hide-to-tray on close: when the window is the only one, closing it should
  // keep the kernel running invisibly. The `tray.isQuitting` flag — set by
  // the tray's own Quit menu item and by `before-quit` below — is what lets a
  // real quit through. Without that gate, `app.before-quit` would race the
  // close handler and the kernel would never get a clean SIGTERM.
  window.on('close', (event) => {
    if (tray === null || tray.isQuitting) return
    if (!window.isVisible()) return
    event.preventDefault()
    // Ask first, once. Closing the window looks like quitting but is not, and
    // on Linux there is no dock to reveal afterwards — so a user with a task
    // running would lose sight of it with no indication anything is left.
    backgroundNotice().close(() => window.hide())
  })

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    mainWindow = null
  })

  // The loading page is shown immediately; `setKernel` swaps in the kernel
  // once it is ready.
  void loadLoadingPage(window, 'preparing', startupBeganAt)
  return { window, setKernel }
}

/**
 * Restores and focuses the main window, then tells the renderer so it can
 * resume anything it was pausing while hidden.
 *
 * @returns {void}
 */
function showWindow() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send('shell:shown')
}

/**
 * The one-time tray notice, created on first use.
 *
 * @returns {BackgroundNotice}
 */
function backgroundNotice() {
  if (trayNotice !== null) return trayNotice
  trayNotice = new BackgroundNotice({
    markerPath: join(app.getPath('userData'), 'tray-notice.acknowledged'),
    show: async ({ message }) => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'DeepSeek Harness',
        message,
        buttons: ['知道了'],
        defaultId: 0,
        // There is nothing to cancel out of: the dialog exists to explain, and
        // the answer is the same either way, so it is not closable by dismissal.
        cancelId: -1,
        noLink: true,
      })
      return response
    },
    focus: () => showWindow(),
  })
  return trayNotice
}

/**
 * @param {string} text
 * @param {number} lines
 * @returns {string}
 */
function tail(text, lines) {
  return text.split('\n').slice(-lines).join('\n')
}

/** @returns {Promise<void>} */
async function shutdown() {
  const running = kernel
  kernel = null
  if (running !== null) await running.stop()
  // The planned stop signalled the process group; anything that escaped it
  // (the npm-exec MCP chains demonstrably do) still deserves a sweep. The
  // kernel pid is already gone, so the reaper attributes against nothing and
  // spares only processes that still look like kernels themselves.
  currentKernelPid = null
  await sweepOrphans('shutdown')
}

/**
 * Restarts the kernel on user demand (tray "Restart kernel"). This is a clean
 * stop + fresh launch, not a crash, so it does not count against the automatic
 * backoff window. The window is sent back to the loading page while the new
 * launch gets ready.
 *
 * @returns {Promise<void>}
 */
// ═══ 5. 托盘/菜单动作（tray & menu actions）═══

async function restartKernel() {
  // `kernel` is the *supervisor*, not the process. The previous version of this
  // function assigned the process returned by `restart()` back into `kernel`,
  // so the next restart called `restart()` on a KernelProcess — which has no
  // such method — and the failure was swallowed by the catch below, leaving the
  // shell apparently doing nothing.
  const supervisor = kernel
  if (supervisor === null) return
  // The planned stop in `restart()` below signals the process group; sweep
  // whatever escaped it before the fresh launch muddies attribution.
  currentKernelPid = null
  await sweepOrphans('restart')

  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    startupBeganAt = Date.now()
    void loadLoadingPage(mainWindow, 'launching', startupBeganAt)
  }

  try {
    // Returns the freshly spawned process; the supervisor keeps ownership.
    const process_ = await supervisor.restart()
    // The fresh launch is the family's new head: the reaper must attribute
    // against it, or the next sweep would read the live family as orphans.
    currentKernelPid = process_.pid ?? null
    const launchedArgs = process_.args ?? []
    const portIndex = launchedArgs.indexOf('--port')
    const port = Number(portIndex >= 0 ? launchedArgs[portIndex + 1] : NaN)
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error('the restarted kernel did not report a port')
    }

    const origin = kernelOrigin(HOST, port)
    // The probe must carry the launch's token whenever the kernel gates its web
    // surface: a bare probe gets a 401, `isServing` rejects it, and the restart
    // sits on "waiting for the kernel" forever. The first launch already
    // accounts for this; the restart has to do the same.
    /** @param {string} url @param {AbortSignal} signal */
    const probeWithToken = (url, signal) =>
      httpProbe(tokenised(url, process_.webToken()), signal)
    const readiness = await waitForReady({
      url: `${origin}/`,
      isCurrent: () => process_.isRunning(),
      probe: systemKernelMode ? probeWithToken : httpProbe,
      timeoutMs: getConfig().supervisor.readinessTimeoutMs,
    })
    if (!readiness.ok) {
      throw new Error(`the restarted kernel never became ready (${readiness.reason})`)
    }

    // `markReady` lives on the supervisor: it resets the backoff window, which
    // is what makes a user-initiated restart not count as a crash.
    supervisor.markReady(`${origin}/`)
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      void mainWindow.loadURL(APP_URL)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`kernel restart failed: ${message}`)
    // A failed restart must not leave the loading page up forever: say what
    // happened instead of showing an animation that will never end.
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      const supervisorLog = supervisor.current?.logText?.() ?? ''
      void loadErrorPage(
        mainWindow,
        '内核重启失败。',
        tail(`restart failed: ${message}\n\n${supervisorLog}`, 25),
      )
    }
  }
}

/**
 * Checks for a newer shell release. In development there is nothing to fetch,
 * so it only reports that and does not error. The packaged path (⑤) wires
 * this to `electron-updater`.
 *
 * @returns {Promise<void>}
 */
async function checkForUpdates() {
  // Not `app.isPackaged`: the installed deb also runs `electron .`, so that
  // flag is false in production. The launcher's marker distinguishes a real
  // install from a source run — see {@link module:config.isInstalledLaunch}.
  if (!isInstalledLaunch()) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Check for updates',
      message: 'Updates are only checked in a packaged build.',
    })
    return
  }
  // Packaged builds call into the auto-updater wired in update.js. Kept as a
  // no-op here so the tray item always has a handler without duplicating the
  // updater logic in two places.
  // Everything the updater reports goes through one sink, so the tray line and
  // the page's own indicator can never disagree about what is happening.
  const { checkForUpdatesAndNotify, setUpdateStateSink } = await import('./update.js')
  setUpdateStateSink(publishUpdateState)
  try {
    await checkForUpdatesAndNotify()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('Update check failed', message)
  } finally {
    publishUpdateState(IDLE_UPDATE_STATE)
  }
}

/**
 * The background check, or null when it was never started.
 *
 * @type {ReturnType<typeof createUpdateSchedule> | null}
 */
let updateSchedule = null

/**
 * Publishes an update state to every surface that shows one.
 *
 * The tray line and the page's indicator read the same record, and a state that
 * says nothing new is not re-sent: a status line that re-renders on every
 * identical tick is one nobody can read.
 *
 * @param {import('./update-state.js').UpdateState} state - what changed
 * @returns {void}
 */
function publishUpdateState(state) {
  const busy = isUpdateBusy(state)
  tray?.setUpdateStatus(busy ? updateStatusLine(state) : null)
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shell:update', state)
  }
}

/**
 * Starts the background check.
 *
 * Only for an installed build: a source checkout has no update to fetch, and a
 * timer that can only ever fail is a timer that only ever backs off.
 *
 * @returns {void}
 */
function startUpdateSchedule() {
  if (!isInstalledLaunch()) return
  if (getConfig().updates?.enabled !== true) return
  if (updateSchedule !== null) return
  updateSchedule = createUpdateSchedule({
    config: resolveUpdateScheduleConfig(process.env),
    check: async () => {
      const { checkForUpdatesAndNotify } = await import('./update.js')
      await checkForUpdatesAndNotify()
    },
    onSchedule: ({ failures }) => {
      if (failures > 0) console.warn(`update check failed ${String(failures)} time(s); backing off`)
    },
  })
  updateSchedule.start()
}

/**
 * Toggles whether the shell launches when the user logs in.
 *
 * @returns {void}
 */
function toggleLaunchAtLogin() {
  const settings = app.getLoginItemSettings()
  const next = !settings.openAtLogin
  app.setLoginItemSettings({ openAtLogin: next, args: [] })
  tray?.setLaunchAtLogin(next)
}

// A second instance would start a second kernel against the same home directory, and the
// two would overwrite each other's state.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    startupBeganAt = Date.now()
    try {
      // Install the protocol handler before the first window. The renderer can
      // fetch `dsh-app://shell/...` for shell-owned static documents and
      // `dsh-app://app/...` to reach the kernel's authenticated origin. The
      // handler reads live state through the closure, so it picks up the
      // endpoint the moment `setKernel` records it.
      installShellProtocol(protocol, {
        rendererRoot: join(here, '..', 'renderer'),
        kernelOriginOf: () => shellProtoState.kernelOrigin,
        tokenOf: () => {
          const proc = kernel?.current
          return proc?.webToken?.() ?? null
        },
        state: shellProtoState,
      })
      /** @param {string | null} origin */
      const setShellKernelOrigin = (origin) => { shellProtoState.kernelOrigin = origin }

      // Show the window first, then start the kernel. The kernel takes seconds
      // to become ready, and making the user stare at nothing for that whole
      // time is a worse experience than a visible loading page that reports
      // what is happening. The window is shown as soon as it can paint.
      const window_ = createWindow()
      mainWindow = window_.window
      window_.window.show()

      // The loading page is already on screen; bring the kernel up and hand
      // its endpoint to the window. Progress during startup reaches the page
      // through the supervisor's `onState` callback, which swaps the loading
      // page's stage text as the kernel moves through launch → waiting.
      const { origin, token } = await startKernel()
      await window_.setKernel(origin, token)
      // Publish the kernel endpoint to the protocol handler so the
      // `dsh-app://app/` route can forward once the kernel is up.
      setShellKernelOrigin(origin)
      // Claim the kernel's browser ticket up front, exactly as the official
      // shell does (`authenticateWebHost`): one `GET /?token=…` whose `303`
      // response carries the signed cookie. The WebSocket endpoint
      // authenticates by that cookie and nothing else — the launch token is
      // not accepted there — so it must be in hand before the renderer opens
      // its first socket, not collected as a side effect of whatever document
      // request happens to arrive first.
      const ticket = await authenticateWebHost(origin, token)
      if (ticket === null) console.warn('kernel ticket unavailable; WebSocket dials will not authenticate')
      else shellProtoState.tickets = new Map(ticket)

      // The background update check, once the application is usable. Started
      // here rather than at import so a failure to reach the feed cannot delay
      // anything the user is waiting for.
      startUpdateSchedule()

      // The IPC channel from the locked-down preload. The renderer can only
      // call `shell.notify`; everything else in the kernel web UI has no
      // bridge into the shell.
      ipcMain.on('shell:notify', (_event, payload) => {
        if (tray === null) return
        const title = typeof payload?.title === 'string' ? payload.title : 'DeepSeek Harness'
        const body = typeof payload?.body === 'string' ? payload.body : ''
        tray.notify(title, body)
      })

      // The page's theme choice, so Electron's own chrome matches the window
      // frame, native menus and tray rather than following the OS while the
      // application follows the user.
      ipcMain.on('shell:theme', (_event, payload) => {
        // An unrecognised value resolves to `system` rather than to a guess:
        // fighting the user's desktop setting is worse than following it.
        nativeTheme.themeSource = resolveThemeSource(payload?.source)
      })

      // The preload reporting that it ran. DevTools says only "Unable to load
      // preload script", which cannot be told apart from a file that loaded and
      // then threw; this message means the file executed to its first line.
      ipcMain.on('shell:preload-probe', (_event, payload) => {
        const line = `preload executed: contextBridge=${String(payload?.contextBridge)} ipcRenderer=${String(payload?.ipcRenderer)}`
        console.log(line)
        void writeCrashReport({
          userData: app.getPath('userData'),
          source: 'renderer',
          appVersion: app.getVersion(),
          message: line,
          output: `preload path → ${join(here, 'preload.cjs')}`,
        }).catch(() => undefined)
      })

      // The renderer's own report of whether a turn is in flight. This is the
      // only signal the shell has for "would quitting interrupt anything?", and
      // it is an approximation of what the official shell asks its Host.
      ipcMain.on('shell:busy', (_event, payload) => {
        kernelBusy = payload === true
        void pushDesktopState()
      })

      // In-page desktop controls. Only a named action crosses the bridge, and
      // only the actions in DESKTOP_ACTIONS are honoured — the page cannot use
      // this to reach any other handler.
      ipcMain.on('shell:invoke', (_event, action) => {
        if (!isDesktopAction(action)) {
          console.warn(`desktop controls: refused unknown action ${String(action)}`)
          return
        }
        void runDesktopAction(action)
      })

      // Tell the page what the tray already knows, and keep telling it.
      void pushDesktopState()

      // Key bindings the user overrode, kept under userData and separate from
      // DSH_HOME. Unknown commands and reserved accelerators are refused rather
      // than silently ignored.
      await installKeybindings(mainWindow)

      // Tray is attached after the window exists so its click handlers can
      // restore it. The tray owns the "is this an explicit quit" flag the
      // window-close handler reads.
      tray = new ShellTray()
      tray.attach({
        iconPath: trayTemplateIconPath(here),
        window: mainWindow,
        onShow: () => showWindow(),
        onQuit: () => void requestQuit(),
        onState: (state) => {
          // Mirror the kernel state into the tray status line without opening
          // the window — the official shell's single most useful tray feature.
          tray?.setState(state)
        },
        onRestart: () => void restartKernel(),
        onCheckUpdates: () => void checkForUpdates(),
        onToggleLaunchAtLogin: () => toggleLaunchAtLogin(),
        onToggleSafeMode: () => void toggleSafeMode(),
        commandState: await readCommandState(),
        onToggleCommand: () => void toggleCommand(),
        safeMode,
        launchAtLogin: app.getLoginItemSettings().openAtLogin,
        homes: describeHomes(homeRegistry),
        onSelectHome: (id) => {
          void switchHome(id).then((result) => {
            if (result.ok) {
              tray?.setActiveHome(id)
              return
            }
            // A failed switch leaves the kernel running against whichever home
            // it was on, so say so plainly rather than letting the menu show a
            // choice that never took effect.
            console.warn(`home switch refused: ${result.error ?? 'unknown reason'}`)
            tray?.notify('切换 Home 未生效', result.error ?? '原因未知')
          })
        },
        onAddHome: () => void addHomeFromPicker(),
      })

      // The kernel may already be ready by the time the tray exists; backfill
      // its status line so the tray is not stuck on "starting…".
      if (kernelState !== null) {
        tray.setState(/** @type {import('./tray.js').KernelState} */ (kernelState))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      // The dialog is transient and truncates; a startup failure is exactly when someone
      // needs the whole story, so it also goes to a crash report whose path the
      // dialog names. The official shell writes these to the platform log
      // directory and keeps the last ten.
      const logPath = await writeCrashReport({
        userData: app.getPath('userData'),
        source: 'main',
        appVersion: app.getVersion(),
        ready: false,
        message,
        // `logText` lives on the kernel *process*, not the supervisor — the
        // supervisor keeps the launch that owns it behind `current`.
        output: kernel?.current?.logText?.() ?? '',
      }).catch(() => null)

      dialog.showErrorBox(
        'DeepSeek Harness 桌面端无法启动',
        logPath === null
          ? message
          : `${message}\n\n已写入：\n${logPath}`,
      )
      await shutdown()
      app.exit(1)
    }
  })

  // With a tray present, "last window closed" no longer means quit: the user
  // hid it deliberately, and the kernel should keep running so the background
  // task can finish. The tray's Quit menu item is the only path that calls
  // `app.quit()` from here on.
  app.on('window-all-closed', () => {
    // intentional no-op on every platform with a tray
  })

  app.on('activate', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return
    showWindow()
  })

  // `before-quit` is the last point at which the kernel can still be stopped; without it a
  // quit triggered from the menu or the OS would leave the process tree running.
  //
  // It is not the place to ask about interrupting work: the handler is
  // synchronous, and a native confirm dialog needs an await. Quitting is
  // therefore routed through `requestQuit` by every path the shell controls,
  // and an OS-initiated quit reaches this handler directly, unprompted.
  app.on('before-quit', () => {
    tray?.prepareQuit()
    void shutdown()
    tray?.destroy()
  })
}

/**
 * Pushes the shell's state to the page, so the in-page controls can show the
 * same status the tray does.
 *
 * Reduced through `toDesktopState` first: the page gets a phase, a busy flag
 * and the autostart flag, and nothing else. No paths, no tokens, no log lines.
 *
 * @returns {Promise<void>}
 */
async function pushDesktopState() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  const state = toDesktopState({
    kernelState,
    busy: kernelBusy,
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    safeMode,
  })
  mainWindow.webContents.send('shell:state', state)
}

/**
 * Runs one desktop action requested from the page.
 *
 * Every action maps to something the tray menu already offers, so the page
 * gains no capability the tray did not have. `quit` is the destructive one and
 * goes through the same confirmation the tray does.
 *
 * @param {import('./desktop-commands.js').DesktopAction} action
 * @returns {Promise<void>}
 */
async function runDesktopAction(action) {
  switch (action) {
    case 'restart-kernel':
      await restartKernel()
      break
    case 'check-updates':
      await checkForUpdates()
      break
    case 'toggle-launch-at-login':
      toggleLaunchAtLogin()
      break
    case 'toggle-safe-mode':
      await toggleSafeMode()
      break
    case 'show-about':
      app.showAboutPanel()
      break
    case 'hide-window':
      if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.hide()
      break
    case 'quit':
      await requestQuit()
      break
  }
  await pushDesktopState()
}

/**
 * Loads `keybindings.json` and publishes the accepted bindings.
 *
 * A malformed or unreadable file keeps the defaults rather than blocking
 * startup — an unreadable preferences file should not cost the user their
 * window. Rejected entries are logged, so a binding the user set and that does
 * nothing is visible instead of mysterious.
 *
 * @param {BrowserWindow} window
 * @returns {Promise<Record<string, string>>} the bindings in force
 */
async function installKeybindings(window) {
  /** @type {Record<string, string>} */
  let overrides = {}
  const path = join(app.getPath('userData'), 'keybindings.json')
  try {
    overrides = validateBindings(JSON.parse(await readFile(path, 'utf8'))).accepted
  } catch {
    // Absent or unreadable: the defaults are fine.
  }

  const bindings = resolveBindings(overrides)
  // Linux does not get the pre-page interception Windows and macOS use, so the
  // shell dispatches through the DOM instead — see src/shortcuts.js.
  console.log(`shortcuts: ${Object.keys(bindings).length} bindings, delivery=${shortcutDeliveryMode()}`)
  windowShortcutBindings = bindings
  return bindings
}

/**
 * Asks before quitting, when the configured policy asks it to.
 *
 * The official shell queries the Host — over a private IPC channel belonging to
 * its private Desktop Host package — for what quitting would interrupt, and
 * only prompts when the answer is non-empty. This shell has no such channel,
 * so it cannot know exactly; `exitPolicy` in config.json declares how to
 * behave in the presence of that uncertainty, defaulting to always asking.
 *
 * @returns {Promise<void>}
 */
// ═══ 6. 退出链（quit chain）═══

async function requestQuit() {
  const exitPolicy = /** @type {'ask-always' | 'ask-if-busy' | 'never'} */ (
    getConfig().kernel?.exitPolicy ?? 'ask-always'
  )
  const busy = kernelBusy === true

  if (!shouldConfirmExit({ policy: exitPolicy, busy })) {
    tray?.prepareQuit()
    app.quit()
    return
  }

  const copy = exitConfirmCopy({ busy })
  const response = await dialog.showMessageBox({
    type: 'question',
    title: copy.title,
    message: copy.message,
    buttons: ['退出', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  // "取消" or a dismissed dialog (Esc) leaves everything as it was.
  if (response.response !== 0) return

  // The background check holds a timer and possibly a request in flight; a
  // timer that outlives the application is what keeps a Node process alive
  // after the last window is gone.
  updateSchedule?.stop()
  updateSchedule = null
  tray?.prepareQuit()
  app.quit()
}
