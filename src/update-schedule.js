/**
 * Scheduling for the update check.
 *
 * The check itself is cheap and the answer is not urgent, so it runs in the
 * background rather than on demand. What that costs is a process that talks to
 * a network endpoint on a timer forever, and the consequences of getting the
 * timer wrong fall on the user:
 *
 * - Checking exactly on the interval makes every installed copy hit the feed at
 *   the same moment. The jitter spreads them out over a window instead of
 *   merely delaying them.
 * - A failing check that retries at the same rate turns one outage into
 *   continuous requests for as long as it lasts, so failures back off
 *   exponentially and a success resets the delay.
 * - Overlapping checks are worse than late ones: a request that is still in
 *   flight when the next timer fires should be shared, not duplicated.
 *
 * @module update-schedule
 */

/** How often a successful check runs. */
export const DEFAULT_INTERVAL_MS = 600_000

/** The longest a failing sequence waits before trying again. */
export const DEFAULT_MAX_BACKOFF_MS = 3_600_000

/** Fraction of the delay the actual wait is randomised by, as a fraction. */
export const DEFAULT_JITTER = 0.2

/**
 * A wait shorter than this is not worth scheduling: the timer granularity
 * below it is coarser than the delay, so the jitter would be meaningless noise.
 */
const MINIMUM_DELAY_MS = 1_000

/**
 * @typedef {object} UpdateScheduleConfig
 * @property {number} intervalMs - delay after a successful check
 * @property {number} maxBackoffMs - ceiling for the doubling delay
 * @property {number} jitter - fraction, in `[0, 1]`, the delay is randomised by
 */

/**
 * Reads the schedule settings, falling back rather than refusing to start.
 *
 * An unusable value here must not stop the application from launching, so the
 * defaults stand rather than throwing — the cost of a wrong interval is a few
 * extra requests, and the cost of refusing to start is everything.
 *
 * @param {NodeJS.ProcessEnv} env - this process's environment
 * @returns {UpdateScheduleConfig}
 */
export function resolveUpdateScheduleConfig(env) {
  const intervalMs = positiveDuration(env.DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS, DEFAULT_INTERVAL_MS)
  // The ceiling has to leave room for the interval, or a successful check
  // would schedule a timer longer than the maximum failure delay.
  const maxBackoffMs = positiveDuration(
    env.DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS,
    Math.max(intervalMs, DEFAULT_MAX_BACKOFF_MS),
  )
  const rawJitter = env.DSH_DESKTOP_UPDATE_CHECK_JITTER
  const parsed = Number(rawJitter)
  const jitter = rawJitter === undefined || rawJitter === '' || !Number.isFinite(parsed)
    ? DEFAULT_JITTER
    : Math.min(Math.max(parsed, 0), 1)
  return {
    intervalMs,
    maxBackoffMs: Math.max(maxBackoffMs, intervalMs),
    jitter,
  }
}

/**
 * @param {string | undefined} raw - the configured value
 * @param {number} fallback - what to use when it is absent or unusable
 * @returns {number} milliseconds
 */
function positiveDuration(raw, fallback) {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= MINIMUM_DELAY_MS ? value : fallback
}

/**
 * Spreads a delay over a window.
 *
 * Randomising *downward* as well as upward is what actually separates copies:
 * a delay that is only ever pushed later still leaves them clustered at the
 * boundary.
 *
 * @param {number} delay - the nominal delay
 * @param {UpdateScheduleConfig} config - supplies the jitter and the ceiling
 * @param {() => number} random - injectable so tests are deterministic
 * @returns {number} the delay to actually wait, in milliseconds
 */
export function jitteredDelay(delay, config, random = Math.random) {
  const lower = Math.max(MINIMUM_DELAY_MS, delay * (1 - config.jitter))
  const upper = Math.min(config.maxBackoffMs, delay * (1 + config.jitter))
  return Math.round(lower + (upper - lower) * random())
}

/**
 * @typedef {object} UpdateScheduleOptions
 * @property {() => Promise<unknown>} options.check - performs one check;
 *   resolving means success, rejecting means failure and triggers the backoff
 * @property {UpdateScheduleConfig} options.config - resolved schedule settings
 * @property {(state: {lastDelayMs: number, failures: number}) => void} [options.onSchedule]
 *   - reports each scheduled delay, so a status line can show it
 * @property {() => number} [options.now] - clock, injectable for tests
 * @property {() => number} [options.random] - jitter source, injectable for tests
 */

/**
 * A repeating background check with exponential backoff on failure.
 *
 * @module
 */

/**
 * Schedules background update checks.
 *
 * Exported as a factory rather than a class so the timer and the in-flight
 * request are closure state that cannot be reached except through the returned
 * operations.
 *
 * @param {UpdateScheduleOptions} options - the check and its settings
 * @returns {{
 *   checkNow: () => Promise<void>,
 *   start: () => void,
 *   stop: () => void,
 *   remaining: () => number,
 * }}
 */
export function createUpdateSchedule({ check, config, onSchedule = () => {}, now = Date.now, random = Math.random }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  /** @type {number | null} */
  let dueAtMs = null
  /** @type {Promise<unknown> | null} */
  let inFlight = null
  let delay = config.intervalMs
  let failures = 0
  let disposed = false

  /**
   * @param {boolean} failed - whether the last attempt failed
   * @returns {void}
   */
  function schedule(failed) {
    if (disposed) return
    delay = failed ? Math.min(config.maxBackoffMs, delay * 2) : config.intervalMs
    const wait = jitteredDelay(delay, config, random)
    onSchedule({ lastDelayMs: wait, failures })
    dueAtMs = now() + wait
    timer = setTimeout(() => {
      void run()
    }, wait)
  }

  /**
   * Runs one check, sharing an attempt that is already under way.
   *
   * @returns {Promise<void>}
   */
  async function run() {
    if (disposed) return
    // A check slower than the interval must not be joined by a second one:
    // the second would report the same answer twice and reset the backoff of a
    // sequence that was already failing.
    if (inFlight !== null) {
      await inFlight.catch(() => undefined)
      if (disposed) return
      schedule(false)
      return
    }
    inFlight = check()
    try {
      await inFlight
      failures = 0
      schedule(false)
    } catch (error) {
      // The backoff is the response to a failure; nothing is thrown on, because
      // a background timer has no caller to receive it and an unhandled
      // rejection would take the process down.
      failures += 1
      schedule(true)
      if (typeof onSchedule === 'function') onSchedule({ lastDelayMs: delay, failures })
      console.warn('update check failed', error instanceof Error ? error.message : String(error))
    } finally {
      inFlight = null
    }
  }

  return {
    /**
     * Checks once now, in addition to the background schedule.
     *
     * @returns {Promise<void>}
     */
    async checkNow() {
      try {
        await run()
      } catch (error) {
        // The caller decides how to present a manual failure; the schedule has
        // already recorded it and backed off.
      }
    },

    /**
     * Starts the repeating check.
     *
     * @returns {void}
     */
    start() {
      if (disposed || timer !== null) return
      schedule(false)
    },

    /**
     * Stops the schedule. An attempt already in flight is left to finish: it
     * has no side effect beyond a network request, and cancelling it would
     * leave the outcome unreported.
     *
     * @returns {void}
     */
    stop() {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      dueAtMs = null
    },

    /**
     * How long until the next check, for a status line.
     *
     * @returns {number} milliseconds, or 0 when nothing is scheduled
     */
    remaining() {
      return dueAtMs === null ? 0 : Math.max(0, dueAtMs - now())
    },
  }
}
