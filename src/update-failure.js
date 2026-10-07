/**
 * User-facing wording for update failures.
 *
 * A failed update is not one thing, and "检查更新失败" for all of them tells
 * the user nothing about whether to retry, check their network, or look for a
 * permission problem. Nine distinct causes get nine distinct explanations.
 *
 * The wording deliberately contains no raw diagnostics. Updater errors carry
 * stack traces, URLs and sometimes tokens; the message is what the user reads
 * and the technical detail is what they paste into a bug report, so they are
 * kept apart.
 *
 * @module update-failure
 */

/**
 * @typedef {'check' | 'download' | 'install' | 'stop-failed' | 'tasks-changed' | 'tasks-unavailable'} UpdateOperation
 */

/**
 * @typedef {`${UpdateOperation}-network` | UpdateOperation | 'stop-failed' | 'tasks-changed' | 'tasks-unavailable'} UpdateFailureKind
 */

/**
 * Failures whose cause is almost certainly the network rather than the
 * operation itself.
 *
 * These appear in an updater's message verbatim when it wraps a fetch failure,
 * so matching the code names avoids reporting "download failed" for something
 * the user could fix by reconnecting.
 */
const NETWORK_CODES = /\b(?:ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|EAI_AGAIN)\b/u

/** Every kind, and what the user is told. */
export const FAILURE_SUMMARIES = Object.freeze({
  check: '检查更新失败，稍后会自动重试。',
  'check-network': '连不上更新服务器，请检查网络后重试。',
  download: '新版本下载失败，稍后会自动重试。',
  'download-network': '下载新版本时网络中断，请检查网络后重试。',
  install: '安装新版本失败，本版本仍可正常使用。',
  'install-network': '安装新版本时需要联网，本版本仍可正常使用。',
  'stop-failed': '无法停止正在运行的任务，因此没有安装新版本。',
  'tasks-changed': '任务状态在确认期间发生了变化，没有安装新版本。',
  'tasks-unavailable': '无法确认是否有任务在运行，因此没有安装新版本。',
})

/**
 * The wording for an unknown cause.
 *
 * A kind this build does not recognise still has to produce a sentence, since
 * throwing here would replace a recoverable update failure with a crash.
 */
const UNKNOWN_SUMMARY = '更新失败，本版本仍可正常使用。'

/**
 * Whether a message describes a network failure.
 *
 * @param {string | undefined} message - the raw diagnostic
 * @returns {boolean}
 */
export function isNetworkFailure(message) {
  return typeof message === 'string' && NETWORK_CODES.test(message)
}

/**
 * Classifies a failure so the summary and the wording can be chosen without
 * carrying the raw diagnostic into the UI.
 *
 * A preparation failure outranks the operation it interrupted: "could not stop
 * the running tasks" is the actionable fact, and reporting it as a failed
 * install would send the user looking in the wrong place.
 *
 * @param {object} failure
 * @param {UpdateOperation} [failure.operation] - what was being done
 * @param {string} [failure.message] - the raw diagnostic
 * @param {string} [failure.preparationFailure] - an earlier failure that
 *   prevented the operation from starting
 * @returns {UpdateFailureKind}
 */
export function classifyUpdateFailure({ operation = 'install', message, preparationFailure } = {}) {
  if (operation === 'install' && typeof preparationFailure === 'string' && preparationFailure !== '') {
    return /** @type {UpdateFailureKind} */ (preparationFailure)
  }
  const base = isNetworkFailure(message) ? `${operation}-network` : operation
  return /** @type {UpdateFailureKind} */ (base)
}

/**
 * The sentence shown to the user.
 *
 * @param {Parameters<typeof classifyUpdateFailure>[0]} failure - the failure
 * @returns {string}
 */
export function updateFailureSummary(failure) {
  const kind = classifyUpdateFailure(failure)
  return /** @type {Record<string, string>} */ (FAILURE_SUMMARIES)[kind] ?? UNKNOWN_SUMMARY
}

/**
 * The technical detail, collapsed behind an expander.
 *
 * It is a separate string from the summary so the dialog can show the second
 * only when asked: users who need it paste it into a report, and users who do
 * not should never have to read it.
 *
 * @param {string | undefined} message - the raw diagnostic
 * @returns {string} the detail, or an empty string when there is none
 */
export function updateFailureDetail(message) {
  if (typeof message !== 'string') return ''
  const trimmed = message.trim()
  // Anything longer than a sentence is a stack trace or a multi-line log; a
  // pasted single line is more useful than a paragraph of noise.
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed
}
