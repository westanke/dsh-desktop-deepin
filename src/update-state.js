/**
 * The update state that the tray and the page both render.
 *
 * One record describes the whole thing, and every surface reads that record
 * rather than its own copy of the truth. Two surfaces that each tracked the
 * update separately would disagree for exactly as long as it mattered — which
 * is when it is happening.
 *
 * The record is deliberately small: a phase, a version, an integer percentage.
 * It carries no wording and no diagnostics, so a surface can localise it, and
 * so a technical detail cannot reach a tooltip by accident.
 *
 * @module update-state
 */

/**
 * @typedef {'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error'} UpdatePhase
 */

/**
 * @typedef {object} UpdateState
 * @property {UpdatePhase} phase
 * @property {string} [version] - the version being acted on, when one is known
 * @property {number} [percent] - whole-number progress, 0–100
 * @property {import('./update-failure.js').UpdateFailureKind} [failure]
 */

/** The state before anything has happened. */
const IDLE = Object.freeze({ phase: /** @type {UpdatePhase} */ ('idle') })

/**
 * Builds a state record, normalising what the caller passed in.
 *
 * @param {object} input
 * @param {UpdatePhase} input.phase
 * @param {string} [input.version]
 * @param {number} [input.percent]
 * @param {import('./update-failure.js').UpdateFailureKind} [input.failure]
 * @returns {UpdateState}
 */
export function updateState({ phase, version, percent, failure }) {
  /** @type {UpdateState} */
  const state = { phase }
  if (typeof version === 'string' && version !== '') state.version = version
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    // Whole numbers only: a fractional percentage in a tray tooltip is noise,
    // and it would make two surfaces that round differently look inconsistent.
    state.percent = Math.max(0, Math.min(100, Math.round(percent)))
  }
  if (typeof failure === 'string') state.failure = failure
  return state
}

/**
 * Maps a download progress report onto a phase.
 *
 * Reaching 100% does not mean the update is ready — the bytes still have to be
 * verified — so the last stretch is reported as `verifying` rather than as a
 * finished download that then appears to stall.
 *
 * @param {number} percent - progress as reported, possibly fractional
 * @param {string} version - the version being downloaded
 * @returns {UpdateState}
 */
export function downloadState(percent, version) {
  return updateState({ phase: percent >= 100 ? 'verifying' : 'downloading', version, percent })
}

/**
 * Whether the update is waiting on something rather than progressing.
 *
 * @param {UpdateState} state - the current state
 * @returns {boolean}
 */
export function isUpdateBusy(state) {
  return state.phase === 'checking' || state.phase === 'downloading' ||
    state.phase === 'verifying' || state.phase === 'installing'
}

/**
 * A one-line status for a tray tooltip or a status bar.
 *
 * @param {UpdateState} state - the current state
 * @returns {string}
 */
export function updateStatusLine(state) {
  const version = state.version === undefined ? '' : ` ${state.version}`
  switch (state.phase) {
    case 'idle':
      return '更新：空闲'
    case 'checking':
      return '更新：正在检查…'
    case 'available':
      return `更新：有新版本${version}可用`
    case 'downloading':
      return `更新：正在下载${version}（${String(state.percent ?? 0)}%）`
    case 'verifying':
      return `更新：正在校验${version}`
    case 'ready':
      return `更新：${version}已就绪，重启后生效`
    case 'installing':
      return '更新：正在安装…'
    case 'error':
      return `更新：${state.failure === undefined ? '失败' : state.failure}`
    default:
      return '更新：空闲'
  }
}

/**
 * Whether the state changed enough to be worth sending.
 *
 * The tray and the page are pushed the same record, and a status line that
 * re-renders on every identical tick is a status line nobody can read.
 *
 * @param {UpdateState | undefined} previous - what was last published
 * @param {UpdateState} next - what would be published now
 * @returns {boolean}
 */
export function updateStateChanged(previous, next) {
  if (previous === undefined) return true
  return previous.phase !== next.phase ||
    previous.version !== next.version ||
    previous.percent !== next.percent ||
    previous.failure !== next.failure
}

export { IDLE as IDLE_UPDATE_STATE }
