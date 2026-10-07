/**
 * Auto-update wiring for the packaged shell.
 *
 * Modeled on the official dsh-desktop shell, which ships `electron-updater`
 * and points it at the project's GitHub releases (citrusli2026/dsh-desktop).
 * In a source/dev run there is no installer to update, so `checkForUpdates`
 * reports that instead of failing — the tray item must always have a handler.
 *
 * The updater itself is an optional dependency: this module imports it lazily so
 * a build without `electron-updater` installed still launches, and only the
 * "Check for updates" action degrades to a clear message.
 *
 * @module update
 */

import { app, dialog } from 'electron'
import { getConfig, isInstalledLaunch } from './config.js'
import { classifyUpdateFailure, updateFailureDetail, updateFailureSummary } from './update-failure.js'
import { downloadState, updateState, updateStateChanged } from './update-state.js'

/**
 * Where the current update state is published.
 *
 * A single holder rather than a callback parameter so the tray and the page can
 * be updated from the updater's event handlers, which are wired in one place
 * and have no caller to pass anything through.
 *
 * @type {(state: import('./update-state.js').UpdateState) => void}
 */
let publish = () => {}

/**
 * The state last published, so an unchanged tick is not re-sent.
 *
 * @type {import('./update-state.js').UpdateState | undefined}
 */
let lastPublished = undefined

/**
 * Points the updater's state at whatever renders it.
 *
 * @param {(state: import('./update-state.js').UpdateState) => void} sink - receives every change
 * @returns {void}
 */
export function setUpdateStateSink(sink) {
  publish = typeof sink === 'function' ? sink : () => {}
}

/**
 * Publishes a state, skipping one that says nothing new.
 *
 * @param {import('./update-state.js').UpdateState} state - what changed
 * @returns {void}
 */
function emit(state) {
  if (!updateStateChanged(lastPublished, state)) return
  lastPublished = state
  publish(state)
}

/**
 * Checks for a newer release and notifies the user.
 *
 * @returns {Promise<void>}
 */
export async function checkForUpdatesAndNotify() {
  // `app.isPackaged` is false in the installed deb too (it runs `electron .`),
  // so a source checkout is told apart by whether the launcher ran — see
  // {@link module:config.isInstalledLaunch}.
  if (!isInstalledLaunch()) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Check for updates',
      message: 'Updates are only checked in a packaged build.',
    })
    return
  }

  const updates = getConfig().updates
  // 本壳的 Linux 发版形态是 deb，升级走 `sudo apt install ./新.deb` 重装；
  // electron-updater 那条链路（指向官方壳的 GitHub Releases）对本壳不适用，
  // config.json 的 updates.enabled 默认 false。关着时菜单点「检查更新」给出
  // 明确指引而不是去查一个别人的仓库。
  if (!updates.enabled) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Check for updates',
      message: `当前版本 v${app.getVersion()}。\n\n本壳以 deb 形式发布，不使用自动更新；升级请下载新版 deb 后执行：\n  sudo apt install ./DeepSeek-Harness-Desktop-<版本>-amd64.deb\n\n（下载地址见 README 的「下载与安装」章节。）`,
      buttons: ['好的'],
    })
    return
  }

  let autoUpdater
  try {
    // 动态 import + @ts-ignore：electron-updater 是可选依赖（没装也能跑，
    // 只有菜单点『检查更新』且 enabled=true 时才需要），不进 devDependencies，
    // 否则 CI 的 npm ci 装不上它 typecheck 就红。
    // @ts-ignore -- optional peer, absent from devDependencies by design
    ;({ autoUpdater } = await import('electron-updater'))
  } catch {
    await dialog.showErrorBox(
      'Auto-update unavailable',
      'The updater module is not installed in this build. Reinstall the packaged app to enable updates.',
    )
    return
  }

  // The published release feed. Mirrors the official shell's provider config,
  // but every value is read from config.json so the feed can be retargeted
  // without touching code.
  autoUpdater.autoDownload = Boolean(updates.autoDownload)
  // `provider` comes from config.json, so it is a plain string; electron-updater
  // types it as a union. The cast is the boundary where configuration meets
  // the library's contract.
  autoUpdater.setFeedURL({
    // @ts-ignore -- builder-util-runtime types ship with electron-updater only
    provider: updates.provider,
    owner: updates.owner,
    repo: updates.repo,
  })

  // The updater reports progress through events, not through the promise the
  // check returns, so the state has to come from here for the tray and the page
  // to show anything at all.
  autoUpdater.on('checking-for-update', () => {
    emit(updateState({ phase: 'checking' }))
  })
  // `ProgressInfo` carries bytes rather than a version, so the download events
  // can only name what `update-available` announced.
  /** @type {string | undefined} */
  let targetVersion
  autoUpdater.on('update-available', (info) => {
    targetVersion = typeof info?.version === 'string' ? info.version : undefined
    emit(updateState({ phase: 'available', version: targetVersion }))
  })
  autoUpdater.on('update-not-available', () => {
    targetVersion = undefined
    emit(updateState({ phase: 'idle' }))
  })
  autoUpdater.on('download-progress', (progress) => {
    emit(downloadState(progress?.percent ?? 0, targetVersion ?? ''))
  })
  autoUpdater.on('update-downloaded', (info) => {
    emit(updateState({
      phase: 'ready',
      version: typeof info?.version === 'string' ? info.version : targetVersion,
    }))
  })

  try {
    emit(updateState({ phase: 'checking' }))
    const result = await autoUpdater.checkForUpdatesAndNotify()
    if (result?.updateInfo === undefined) {
      emit(updateState({ phase: 'idle' }))
      await dialog.showMessageBox({
        type: 'info',
        title: '已是最新版本',
        message: `当前运行 v${app.getVersion()}。`,
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failure = { operation: /** @type {const} */ ('check'), message }
    emit(updateState({ phase: 'error', failure: classifyUpdateFailure(failure) }))
    // The summary says what happened in terms the user can act on; the raw
    // diagnostic goes behind a second line, because it carries URLs and
    // whatever else the updater put there.
    const detail = updateFailureDetail(message)
    await dialog.showMessageBox({
      type: 'warning',
      title: '检查更新失败',
      message: updateFailureSummary(failure),
      detail: detail === '' ? '' : `技术细节：\n${detail}`,
      buttons: ['好'],
      noLink: true,
    })
  }
}
