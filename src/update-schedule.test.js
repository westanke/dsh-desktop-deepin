/**
 * @module update-schedule
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_JITTER,
  DEFAULT_MAX_BACKOFF_MS,
  createUpdateSchedule,
  jitteredDelay,
  resolveUpdateScheduleConfig,
} from './update-schedule.js'

describe('resolveUpdateScheduleConfig', () => {
  it('defaults to ten minutes, an hour of backoff, and a fifth of jitter', () => {
    assert.deepEqual(resolveUpdateScheduleConfig({}), {
      intervalMs: DEFAULT_INTERVAL_MS,
      maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
      jitter: DEFAULT_JITTER,
    })
  })

  it('honours values that make sense', () => {
    const config = resolveUpdateScheduleConfig({
      DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '120000',
      DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS: '600000',
      DSH_DESKTOP_UPDATE_CHECK_JITTER: '0.5',
    })
    assert.equal(config.intervalMs, 120_000)
    assert.equal(config.maxBackoffMs, 600_000)
    assert.equal(config.jitter, 0.5)
  })

  it('falls back rather than letting an unusable value stop the launch', () => {
    // The cost of a wrong interval is a few extra requests; the cost of
    // refusing to start is everything.
    for (const raw of ['0', '-5', 'abc', 'NaN']) {
      const config = resolveUpdateScheduleConfig({ DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: raw })
      assert.equal(config.intervalMs, DEFAULT_INTERVAL_MS, `${raw} must not be honoured`)
    }
  })

  it('never lets the backoff ceiling fall below the interval', () => {
    // Otherwise a successful check would schedule a timer longer than the
    // longest failure delay, which is the opposite of backing off.
    const config = resolveUpdateScheduleConfig({
      DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '900000',
      DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS: '1000',
    })
    assert.ok(config.maxBackoffMs >= config.intervalMs)
  })

  it('clamps jitter into range', () => {
    assert.equal(resolveUpdateScheduleConfig({ DSH_DESKTOP_UPDATE_CHECK_JITTER: '5' }).jitter, 1)
    assert.equal(resolveUpdateScheduleConfig({ DSH_DESKTOP_UPDATE_CHECK_JITTER: '-5' }).jitter, 0)
    assert.equal(resolveUpdateScheduleConfig({ DSH_DESKTOP_UPDATE_CHECK_JITTER: 'nope' }).jitter, DEFAULT_JITTER)
  })
})

describe('jitteredDelay', () => {
  const config = { intervalMs: 100_000, maxBackoffMs: 1_000_000, jitter: 0.2 }

  it('spreads delays on both sides of the nominal wait', () => {
    // Randomising only upward would leave copies clustered at the boundary,
    // which is where the thundering herd actually forms.
    assert.equal(jitteredDelay(100_000, config, () => 0), 80_000)
    assert.equal(jitteredDelay(100_000, config, () => 1), 120_000)
    assert.equal(jitteredDelay(100_000, config, () => 0.5), 100_000)
  })

  it('never waits less than the timer floor', () => {
    // Below a second the jitter is smaller than the timer's own granularity,
    // so honouring it would be noise pretending to be precision.
    const tight = { intervalMs: 1_000, maxBackoffMs: 2_000, jitter: 0.9 }
    assert.ok(jitteredDelay(1_000, tight, () => 0) >= 1_000)
  })

  it('never waits longer than the ceiling', () => {
    const tight = { intervalMs: 1_000, maxBackoffMs: 5_000, jitter: 1 }
    assert.ok(jitteredDelay(1_000, tight, () => 1) <= 5_000)
  })
})

describe('createUpdateSchedule', () => {
  /**
   * Builds a schedule with a controllable clock, so the tests do not wait ten
   * minutes to observe a ten-minute behaviour.
   *
   * @param {object} options
   * @param {() => Promise<unknown>} options.check
   * @param {number} [options.intervalMs]
   * @param {number} [options.jitter]
   * @param {(event: {lastDelayMs: number, failures: number}) => void} [options.onSchedule]
   */
  function harness({ check, intervalMs = 1_000, jitter = 0, onSchedule = () => {} }) {
    /** @type {Array<{lastDelayMs: number, failures: number}>} */
    const scheduled = []
    const config = { intervalMs, maxBackoffMs: 1_000_000, jitter }
    let clock = 0
    const schedule = createUpdateSchedule({
      check,
      config,
      now: () => clock,
      random: () => 0.5,
      onSchedule: (event) => {
        scheduled.push(event)
        onSchedule(event)
      },
    })
    return { schedule, scheduled, advance: (/** @type {number} */ ms) => { clock += ms } }
  }

  it('schedules the next check after a success', async () => {
    let calls = 0
    const h = harness({ check: async () => { calls += 1 } })
    h.schedule.start()
    assert.equal(calls, 0, 'start() schedules; it does not check immediately')
    assert.equal(h.scheduled[0]?.lastDelayMs, 1_000)
    await h.schedule.checkNow()
    assert.equal(calls, 1)
    h.schedule.stop()
  })

  it('doubles the delay on each failure and resets on success', async () => {
    let outcome = 'fail'
    let calls = 0
    const h = harness({
      check: async () => {
        calls += 1
        if (outcome === 'fail') throw new Error('down')
      },
    })
    h.schedule.start()

    await h.schedule.checkNow() // fail → 2000
    assert.equal(h.scheduled.at(-1)?.lastDelayMs, 2_000)
    await h.schedule.checkNow() // fail → 4000
    assert.equal(h.scheduled.at(-1)?.lastDelayMs, 4_000)

    outcome = 'ok'
    await h.schedule.checkNow() // success → back to 1000
    assert.equal(h.scheduled.at(-1)?.lastDelayMs, 1_000)
    assert.equal(calls, 3)
    h.schedule.stop()
  })

  it('counts consecutive failures and forgets them after a success', () => {
    /** @type {Array<{lastDelayMs: number, failures: number}>} */
    const seen = []
    let outcome = 'fail'
    const h = harness({
      check: async () => {
        if (outcome === 'fail') throw new Error('down')
      },
      onSchedule: (event) => seen.push(event),
    })
    h.schedule.start()
    return (async () => {
      await h.schedule.checkNow()
      await h.schedule.checkNow()
      await h.schedule.checkNow()
      assert.equal(seen.at(-1)?.failures, 3)
      outcome = 'ok'
      await h.schedule.checkNow()
      assert.equal(seen.at(-1)?.failures, 0, 'a success clears the failure run')
      h.schedule.stop()
    })()
  })

  it('stops scheduling once stopped', async () => {
    let calls = 0
    const h = harness({ check: async () => { calls += 1 } })
    h.schedule.start()
    h.schedule.stop()
    await h.schedule.checkNow()
    assert.equal(calls, 0, 'a stopped schedule does no work')
  })

  it('does not throw out of a manual check when the check fails', async () => {
    // A manual check has a caller, but the background schedule has none: an
    // unhandled rejection from a timer would take the process down.
    const h = harness({ check: async () => { throw new Error('down') } })
    h.schedule.start()
    await h.schedule.checkNow()
    assert.equal(h.scheduled.at(-1)?.failures, 1)
    h.schedule.stop()
  })

  it('reports the time until the next check', () => {
    const h = harness({ check: async () => {} })
    assert.equal(h.schedule.remaining(), 0, 'nothing is scheduled yet')
    h.schedule.start()
    const before = h.schedule.remaining()
    assert.ok(before > 0 && before <= 1_000, `unexpected ${String(before)}`)
    h.schedule.stop()
    assert.equal(h.schedule.remaining(), 0, 'a stopped schedule has no next check')
  })
})
