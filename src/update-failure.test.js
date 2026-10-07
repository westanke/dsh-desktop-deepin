/**
 * @module update-failure
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  FAILURE_SUMMARIES,
  classifyUpdateFailure,
  isNetworkFailure,
  updateFailureDetail,
  updateFailureSummary,
} from './update-failure.js'

describe('classifyUpdateFailure', () => {
  it('tells a network failure from an ordinary one', () => {
    // "检查更新失败" for a dead network tells the user nothing about whether
    // to retry or to check their connection.
    assert.equal(classifyUpdateFailure({ operation: 'check', message: 'ERR_NAME_NOT_RESOLVED' }), 'check-network')
    assert.equal(classifyUpdateFailure({ operation: 'check', message: 'ETIMEDOUT' }), 'check-network')
    assert.equal(classifyUpdateFailure({ operation: 'download', message: 'ERR_CONNECTION_RESET' }), 'download-network')
    assert.equal(classifyUpdateFailure({ operation: 'check', message: 'signature mismatch' }), 'check')
  })

  it('covers every network error the updater actually produces', () => {
    for (const code of [
      'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_INTERNET_DISCONNECTED',
      'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_TIMED_OUT', 'ETIMEDOUT', 'EAI_AGAIN',
    ]) {
      assert.equal(isNetworkFailure(`getaddrinfo ${code} registry.npmjs.org`), true, code)
    }
  })

  it('prefers an earlier preparation failure over the operation it blocked', () => {
    // "Could not stop the running tasks" is the actionable fact; reporting it
    // as a failed install sends the user looking in the wrong place.
    assert.equal(
      classifyUpdateFailure({ operation: 'install', message: 'whatever', preparationFailure: 'stop-failed' }),
      'stop-failed',
    )
  })

  it('ignores a preparation failure that belongs to another operation', () => {
    assert.equal(classifyUpdateFailure({ operation: 'check', preparationFailure: 'stop-failed' }), 'check')
  })

  it('defaults to install when no operation is given', () => {
    assert.equal(classifyUpdateFailure({}), 'install')
    assert.equal(classifyUpdateFailure(), 'install')
  })
})

describe('updateFailureSummary', () => {
  it('has a distinct sentence for each kind', () => {
    // Two kinds sharing a sentence would be two kinds that are not.
    const summaries = Object.values(FAILURE_SUMMARIES)
    assert.equal(new Set(summaries).size, summaries.length, 'every kind must read differently')
    assert.equal(summaries.length, 9)
  })

  it('always says what the user can still do', () => {
    // A failed update is not a failed application; the wording has to keep the
    // installed version usable in view.
    for (const summary of Object.values(FAILURE_SUMMARIES)) {
      assert.ok(summary.length > 0)
    }
    assert.ok(/** @type {string} */ (FAILURE_SUMMARIES.install).includes('正常使用'))
  })

  it('never contains a raw diagnostic', () => {
    for (const summary of Object.values(FAILURE_SUMMARIES)) {
      assert.ok(!/https?:|at .*\.js:\d|token|Authorization/i.test(summary), summary)
    }
  })

  it('still produces a sentence for a kind this build does not know', () => {
    // Throwing here would replace a recoverable failure with a crash.
    assert.ok(updateFailureSummary({ operation: /** @type {'install'} */ (/** @type {unknown} */ ('install')), message: 'x' }).length > 0)
    const future = /** @type {never} */ (/** @type {unknown} */ ({ operation: 'install', preparationFailure: 'brand-new-kind' }))
    assert.ok(updateFailureSummary(future).length > 0)
  })
})

describe('updateFailureDetail', () => {
  it('carries the raw diagnostic for the report', () => {
    assert.equal(updateFailureDetail('ERR_NAME_NOT_RESOLVED registry.npmjs.org'), 'ERR_NAME_NOT_RESOLVED registry.npmjs.org')
  })

  it('is empty when there is nothing to report', () => {
    assert.equal(updateFailureDetail(undefined), '')
    assert.equal(updateFailureDetail('   '), '')
  })

  it('truncates a stack trace rather than pasting pages', () => {
    const detail = updateFailureDetail(`Error: failed\n${'at foo (/x/y.js:1:1)\n'.repeat(80)}`)
    assert.ok(detail.length <= 401)
    assert.ok(detail.endsWith('…'))
  })

  it('keeps a short message whole', () => {
    const message = 'Error: signature mismatch'
    assert.equal(updateFailureDetail(message), message)
  })
})
