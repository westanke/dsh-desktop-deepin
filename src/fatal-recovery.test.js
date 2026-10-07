/**
 * @module fatal-recovery
 */

import { strict as assert } from 'node:assert'
import { beforeEach, describe, it } from 'node:test'

import {
  CRASH_REPORT_WAIT_MS,
  DETAIL_BUDGET,
  budgetDetail,
  dialogDetail,
  flattenError,
  isAddressInUse,
  reportFatal,
  resetFatalRecoveryForTest,
} from './fatal-recovery.js'

describe('flattenError', () => {
  it('walks the cause chain so the interesting line is not buried', () => {
    const error = new Error('kernel did not become ready', { cause: new Error('spawn ENOENT') })
    assert.equal(flattenError(error), 'kernel did not become ready\n caused by: spawn ENOENT')
  })

  it('flattens a nested AggregateError one level at a time', () => {
    // `String(aggregate)` would show only "AggregateError", which is what a
    // start failure plus its cleanup failure arrives as.
    const aggregate = new AggregateError([new Error('bind failed'), new Error('cleanup failed')])
    assert.equal(flattenError(aggregate), 'bind failed\ncleanup failed')
  })

  it('handles a cause that is not an Error', () => {
    assert.equal(flattenError({ reason: 'plain object' }), '[object Object]')
    assert.equal(flattenError('a string'), 'a string')
  })

  it('stops at a missing cause rather than printing undefined', () => {
    assert.equal(flattenError(new Error('alone')), 'alone')
  })
})

describe('isAddressInUse', () => {
  it('recognises the port collision', () => {
    assert.equal(isAddressInUse('listen EADDRINUSE: address already in use'), true)
  })

  it('does not fire on unrelated text', () => {
    assert.equal(isAddressInUse('EADDRINUSE mentioned in a comment only'), false)
    assert.equal(isAddressInUse('kernel did not become ready'), false)
  })
})

describe('budgetDetail', () => {
  it('leaves a short message untouched', () => {
    assert.equal(budgetDetail('short'), 'short')
  })

  it('keeps the tail, which is where the cause is', () => {
    const long = `${'x'.repeat(2000)}THE END`
    const capped = budgetDetail(long, 100)
    assert.ok(capped.includes('THE END'), 'the end must survive')
    assert.ok(capped.length < long.length, 'the text must actually be shorter')
    assert.ok(capped.includes('已截短'))
  })

  it('never splits a surrogate pair', () => {
    // Cutting a UTF-16 unit in half would render as a replacement character at
    // the very start of what the user reads.
    const emoji = '👩‍💻'.repeat(50)
    const capped = budgetDetail(emoji, 10)
    const body = capped.slice(capped.indexOf('\n') + 1)
    assert.ok(!body.includes('�'), 'a broken surrogate must not reach the dialog')
  })
})

describe('dialogDetail', () => {
  it('keeps only the trailing lines', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${String(index)}`)
    const shown = dialogDetail(lines.join('\n'))
    assert.ok(shown.includes('line 19'))
    assert.ok(!shown.includes('line 0\n'))
  })

  it('respects the overall budget', () => {
    assert.ok([...dialogDetail('y'.repeat(5000))].length <= DETAIL_BUDGET + 100)
  })
})

describe('reportFatal', () => {
  // The guard is process-wide by design, so each case starts from a clean one.
  beforeEach(() => {
    resetFatalRecoveryForTest()
  })

  /** Builds the operation bundle with recording. */
  /**
   * @param {{error?: Error, writeResult?: string, failRecovery?: boolean}} [overrides]
   */
  function harness(overrides = {}) {
    const { error, writeResult = '/tmp/report.log', failRecovery = false } = overrides
    /** @type {string[]} */
    const calls = []
    /** @type {Array<{detail: string, buttons: string[]}>} */
    const asked = []
    return {
      calls,
      asked,
      /** Calls made after the most recent dialog. */
      afterAsk: () => calls.slice(calls.lastIndexOf('show') + 1),
      options: {
        error: error ?? new Error('kernel did not become ready'),
        source: /** @type {'main'} */ ('main'),
        writeReport: async () => {
          calls.push('write')
          return writeResult
        },
        show: /** @type {(request: {detail: string, buttons: string[]}) => Promise<number>} */ (async (request) => {
          calls.push('show')
          asked.push(request)
          return asked.length === 1 ? 1 : 0
        }),
        stop: async () => {
          calls.push('stop')
          if (failRecovery) throw new Error('stop refused')
        },
        disablePlugins: async () => {
          calls.push('disablePlugins')
        },
        exit: () => {
          calls.push('exit')
        },
        restart: () => {
          calls.push('restart')
        },
      },
    }
  }

  it('writes the report before asking, and names the file', async () => {
    const h = harness()
    await reportFatal(h.options)
    assert.deepEqual(h.calls.slice(0, 2), ['write', 'show'])
    assert.ok(h.asked[0]?.detail.includes('/tmp/report.log'), 'the dialog must name the report')
    assert.deepEqual(h.afterAsk(), ['stop', 'restart'])
  })

  it('offers three buttons for an ordinary failure', async () => {
    const h = harness()
    await reportFatal(h.options)
    assert.equal(h.asked[0]?.buttons.length, 3)
    assert.ok(h.asked[0]?.buttons.includes('禁用第三方插件并重启'))
  })

  it('drops the plugin button for a port collision, which cannot help there', async () => {
    const h = harness({ error: new Error('listen EADDRINUSE: address already in use') })
    await reportFatal(h.options)
    assert.equal(h.asked[0]?.buttons.length, 2)
    assert.ok(h.asked[0]?.detail.includes('端口已被占用'))
  })

  it('exits without restarting when the user picks exit', async () => {
    const h = harness()
    h.options.show = async () => {
      h.calls.push('show')
      return 0
    }
    await reportFatal(h.options)
    assert.deepEqual(h.afterAsk(), ['stop', 'exit'])
  })

  it('disables plugins on the third button', async () => {
    const h = harness()
    h.options.show = async () => {
      h.calls.push('show')
      return 2
    }
    await reportFatal(h.options)
    assert.deepEqual(h.afterAsk(), ['stop', 'disablePlugins', 'restart'])
  })

  it('offers the same choices again when the recovery itself fails', async () => {
    // Quitting here would strand the user in front of an app with no window.
    const h = harness({ failRecovery: true })
    await reportFatal(h.options)
    assert.equal(h.asked.length, 2, 'the dialog must come back')
    assert.ok(h.asked[1]?.detail.includes('stop refused'), 'the retry must name what went wrong')
    // Second round: the user picks exit, and that one succeeds.
    assert.deepEqual(h.afterAsk(), ['stop', 'exit'])
  })

  it('shows the dialog even when the report cannot be written', async () => {
    const h = harness()
    h.options.writeReport = async () => {
      throw new Error('disk full')
    }
    await reportFatal(h.options)
    assert.ok(h.calls.includes('show'), 'a failed report must not hide the failure')
  })

  it('does not wait forever for a slow report', async () => {
    const h = harness()
    h.options.writeReport = () => new Promise((resolve) => setTimeout(() => resolve('/tmp/late.log'), CRASH_REPORT_WAIT_MS * 4))
    const started = Date.now()
    await reportFatal(h.options)
    // The dialog appears without a path rather than after the slow write; the
    // assertion is on the bound, not on an exact duration.
    assert.ok(Date.now() - started < CRASH_REPORT_WAIT_MS * 3, 'the dialog must not wait for the report')
    assert.ok(!h.asked[0]?.detail.includes('late.log'), 'a report that arrived too late is not named')
  })

  it('ignores a second report so a crash loop cannot stack dialogs', async () => {
    const h = harness()
    h.options.show = async () => {
      h.calls.push('show')
      return 0
    }
    await reportFatal(h.options)
    const firstCount = h.calls.length
    await reportFatal({ ...h.options, error: new Error('second failure') })
    assert.equal(h.calls.length, firstCount, 'the second report must be a no-op')
  })
})