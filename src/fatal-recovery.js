/**
 * Recovery from a failure that leaves nothing to recover into.
 *
 * A kernel that never becomes ready, or a renderer that dies before it paints,
 * has no in-app way to explain itself — the window the message would appear in
 * is the thing that is broken. So the shell puts a native dialog in front of it,
 * and that dialog has to carry enough to act on: what failed, where the full
 * report was written, and a way forward.
 *
 * Three decisions shape it, all of them about the failure being untrustworthy:
 *
 * - The report is written *before* the dialog, so the dialog can name a file the
 *   user can attach to a bug report. That write is bounded, because a slow disk
 *   must not hold a user hostage to a diagnostic.
 * - The message is capped. A kernel stack trace can be megabytes, and a dialog
 *   nobody can read is not a diagnostic.
 * - A failed recovery offers itself again rather than quitting. Losing the
 *   window to a transient failure is exactly the situation the user is already in.
 *
 * @module fatal-recovery
 */

/**
 * How long the crash report may take before the dialog appears without a path.
 * A report is worth a moment; a hung dialog is not.
 */
export const CRASH_REPORT_WAIT_MS = 1000

/**
 * How much of the failure text the dialog shows. Enough for the last few lines
 * of a stack, not enough to push the buttons off screen.
 */
export const DETAIL_BUDGET = 1200

/**
 * How many trailing lines survive the cap. A kernel failure's cause is at the
 * end, not the beginning.
 */
const DETAIL_LINES = 8

/** Shown when the kernel could not bind its port. */
const ADDRESS_IN_USE = '端口已被占用——通常是另一个 dsh 还在运行。关掉它，或重启让它换一个端口。'

/**
 * Flattens an error and its `cause` chain into one message.
 *
 * `AggregateError` is flattened recursively because that is how a start failure
 * and its cleanup failure arrive together: the interesting text is buried one
 * level down and `String(error)` would show only "AggregateError".
 *
 * @param {unknown} error - the failure
 * @returns {string} a single-line-per-level message
 */
export function flattenError(error) {
  if (error instanceof AggregateError) {
    return error.errors.map((nested) => flattenError(nested)).join('\n')
  }
  if (!(error instanceof Error)) return String(error)
  const cause = /** @type {{ cause?: unknown }} */ (error).cause
  if (cause === undefined || cause === null) return error.message
  return `${error.message}\n caused by: ${flattenError(cause)}`
}

/**
 * Whether the failure is a port collision.
 *
 * Worth distinguishing: "another dsh is running" is a fact the user can act on,
 * and the plugin-disabling button would not help with it at all.
 *
 * @param {string} detail - the flattened message
 * @returns {boolean}
 */
export function isAddressInUse(detail) {
  return /\blisten EADDRINUSE\b/u.test(detail)
}

/**
 * Truncates the detail to the budget, keeping the end.
 *
 * The cap is applied to code points rather than UTF-16 units so a surrogate
 * pair is never cut in half — which would render as a replacement character at
 * the very start of what the user sees.
 *
 * @param {string} detail - the flattened message
 * @param {number} [budget] - maximum length
 * @returns {string} the tail, prefixed with a note when anything was cut
 */
export function budgetDetail(detail, budget = DETAIL_BUDGET) {
  const points = [...detail]
  if (points.length <= budget) return detail
  const kept = points.slice(-budget).join('')
  const dropped = points.length - budget
  return `…（已截短，完整内容见报告文件，共 ${String(dropped + budget)} 字）\n${kept}`
}

/**
 * The lines the dialog shows: the tail of the message, capped.
 *
 * @param {string} detail - the flattened message
 * @returns {string}
 */
export function dialogDetail(detail) {
  const lines = detail.split('\n')
  const tail = lines.length > DETAIL_LINES ? lines.slice(-DETAIL_LINES) : lines
  return budgetDetail(tail.join('\n'))
}

/**
 * Whether a fatal dialog has already been answered in this process.
 *
 * Process-wide rather than per-call: a kernel in a crash loop reports again after
 * every restart attempt, and each of those would otherwise open a dialog the
 * user did not ask for. Once an action has been chosen, later reports have
 * nothing left to say. A *retry* — the dialog coming back because the recovery
 * itself failed — is not a new report and stays allowed.
 */
let settled = false

/**
 * Clears the process-wide guard. Only for tests: the production path is
 * one dialog per process, which is the whole point of the guard.
 *
 * @returns {void}
 */
export function resetFatalRecoveryForTest() {
  settled = false
}

/**
 * Presents the recovery dialog and performs the chosen action.
 *
 * Reports after the first are ignored: a kernel in a crash loop would otherwise
 * stack dialogs, and the user's answer to the first one is still the right one.
 *
 * @param {object} options
 * @param {unknown} options.error - the failure
 * @param {import('./diagnostics.js').CrashSource} options.source
 * @param {() => Promise<string | null>} options.writeReport - writes the report
 * @param {(request: {detail: string, buttons: string[]}) => Promise<number>} options.show
 *   - shows the dialog, resolving with the chosen button index
 * @param {() => Promise<void>} options.stop - tear the kernel down
 * @param {() => Promise<void>} options.disablePlugins - restart without third-party bundles
 * @param {() => void} options.exit - quit the app
 * @param {() => void} options.restart - relaunch the app
 * @returns {Promise<void>}
 */
export async function reportFatal({
  error,
  source,
  writeReport,
  show,
  stop,
  disablePlugins,
  exit,
  restart,
}) {
  // Checked before anything else: a second report must cost nothing, not even
  // a redundant write.
  if (settled) return
  const detail0 = flattenError(error)
  const reportPath = await boundedReport(writeReport)
  const reportLine = reportPath === null ? '' : `\n\n完整报告：${reportPath}`
  const addressInUse = isAddressInUse(detail0)

  let detail = addressInUse ? `${ADDRESS_IN_USE}${reportLine}` : `${dialogDetail(detail0)}${reportLine}`

  for (;;) {
    // The buttons follow the failure: a port collision has nothing to do with
    // plugins, so offering "disable them" would point the user the wrong way.
    const response = await show({ detail, buttons: buttonsFor(detail0) })
    if (response === 0) {
      try {
        await stop()
      } catch (failure) {
        console.error(failure)
      }
      settled = true
      exit()
      return
    }
    try {
      await stop()
      if (response === 2) await disablePlugins()
      settled = true
      restart()
      return
    } catch (failure) {
      // The recovery itself failed. The user is still sitting in front of a
      // broken app with no window, so quitting here would strand them — offer
      // the same choices again with the new reason.
      console.error(failure)
      detail = `${dialogDetail(flattenError(failure))}${reportLine}`
    }
  }
}

/**
 * @param {string} detail - the text the dialog would show
 * @returns {string[]} the buttons, in order
 */
function buttonsFor(detail) {
  // A port collision has nothing to do with plugins, so offering "disable them"
  // there would send the user down the wrong path.
  return isAddressInUse(detail)
    ? ['退出', '重启']
    : ['退出', '重启', '禁用第三方插件并重启']
}

/**
 * Writes the report without letting a slow write hold the dialog.
 *
 * @param {() => Promise<string | null>} writeReport - the writer
 * @returns {Promise<string | null>} the path, or null when it was too slow or failed
 */
async function boundedReport(writeReport) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  try {
    return await Promise.race([
      writeReport(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          resolve(null)
        }, CRASH_REPORT_WAIT_MS)
      }),
    ])
  } catch (failure) {
    console.error('crash report failed', failure)
    return null
  } finally {
    clearTimeout(timer)
  }
}