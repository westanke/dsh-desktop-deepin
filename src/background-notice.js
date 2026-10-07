/**
 * One-time confirmation before the window goes to the tray.
 *
 * Closing the window and quitting look identical on Linux and macOS — there is
 * no dock, no taskbar button, and most window managers put nothing back. The
 * application's work does not stop when the window hides, so the user who
 * expects "close to quit" loses sight of a running task with no indication that
 * one exists.
 *
 * The notice says so once. After they acknowledge it the behaviour is exactly
 * what they chose, on every later launch. A cancelled prompt records nothing,
 * so someone who declined is asked again rather than having their refusal
 * remembered as consent.
 *
 * @module background-notice
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Shown once, before the first hide that the user has not already acknowledged. */
const NOTICE_BODY =
  '关闭窗口不会退出 DeepSeek Harness，正在运行的任务会继续。\n\n需要它时，从系统托盘重新打开；如果要真正退出，用托盘菜单里的「退出」。'

/** Options for {@link BackgroundNotice}. */
export class BackgroundNotice {
  /**
   * Acknowledged during this run. Separate from the marker on disk: the marker
   * survives an upgrade, and a user who reinstalled should not be asked about
   * behaviour they already consented to once.
   */
  #acknowledged = false

  /** A confirmation is already showing, so a second request must not open one. */
  #pending = false

  /** Set during shutdown, so a dialog response that arrives too late is ignored. */
  #disposed = false

  /**
   * @param {object} options
   * @param {string} options.markerPath - acknowledgement file under `userData`
   * @param {(request: {message: string, buttons: string[]}) => Promise<number>} options.show
   *   - shows the confirmation, resolving with the chosen button index
   * @param {() => void} [options.focus] - brings the window forward
   */
  constructor({ markerPath, show, focus = () => {} }) {
    this.#markerPath = markerPath
    this.#show = show
    this.#focus = focus
  }

  /** @type {string} */
  #markerPath

  /** @type {(request: {message: string, buttons: string[]}) => Promise<number>} */
  #show

  /** @type {() => void} */
  #focus

  /**
   * Hides the window, asking first unless the notice has been acknowledged.
   *
   * Repeated requests while the dialog is up focus the window instead of
   * stacking another dialog: a user clicking the close button twice has not
   * asked a second question.
   *
   * @param {() => void} hide - hides the window once the answer permits it
   * @returns {void}
   */
  close(hide) {
    if (this.#disposed) return
    if (this.#pending) {
      this.#focus()
      return
    }
    if (this.#acknowledged || existsSync(this.#markerPath)) {
      hide()
      return
    }
    this.#pending = true
    void this.#confirm(hide)
  }

  /**
   * Stops answering dialogs. Called when the application is quitting, because
   * a response arriving after that would otherwise hide a window nobody can
   * reach.
   *
   * @returns {void}
   */
  dispose() {
    this.#disposed = true
  }

  /**
   * @param {() => void} hide - what to do once acknowledged
   * @returns {Promise<void>}
   */
  async #confirm(hide) {
    try {
      const response = await this.#show({ message: NOTICE_BODY, buttons: ['知道了'] })
      if (this.#disposed || response !== 0) return
      this.#acknowledged = true
      try {
        mkdirSync(dirname(this.#markerPath), { recursive: true })
        // The marker's content is irrelevant; its existence is the answer.
        writeFileSync(this.#markerPath, '')
      } catch (error) {
        // Without the marker the user is asked again next launch, which is
        // worse than being asked twice but never wrong.
        console.warn('could not record the tray notice acknowledgement', error)
      }
      hide()
    } catch (error) {
      // A dialog that cannot be shown leaves the window visible: the user asked
      // to close it, but closing on their behalf is a decision they did not
      // make, and the notice exists precisely because the outcome of closing is
      // not what they expect.
      console.warn('tray notice unavailable', error)
    } finally {
      this.#pending = false
    }
  }
}