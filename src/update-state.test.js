/**
 * @module update-state
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  IDLE_UPDATE_STATE,
  downloadState,
  isUpdateBusy,
  updateState,
  updateStateChanged,
  updateStatusLine,
} from './update-state.js'

describe('updateState', () => {
  it('drops empty fields rather than publishing blanks', () => {
    const state = updateState({ phase: 'available', version: '', percent: Number.NaN })
    assert.deepEqual(state, { phase: 'available' })
    assert.equal('version' in state, false)
    assert.equal('percent' in state, false)
  })

  it('rounds the percentage to a whole number', () => {
    // A fractional percentage in a tray tooltip is noise, and two surfaces
    // that round differently would look inconsistent.
    assert.equal(updateState({ phase: 'downloading', percent: 43.6 }).percent, 44)
    assert.equal(updateState({ phase: 'downloading', percent: 43.4 }).percent, 43)
  })

  it('keeps the percentage inside 0–100', () => {
    assert.equal(updateState({ phase: 'downloading', percent: -5 }).percent, 0)
    assert.equal(updateState({ phase: 'downloading', percent: 140 }).percent, 100)
  })
})

describe('downloadState', () => {
  it('reports the last stretch as verifying, not as a finished download', () => {
    // The bytes still have to be checked; reporting "downloading" at 100% then
    // appearing to stall is worse than saying what is happening.
    assert.equal(downloadState(100, '0.2.15').phase, 'verifying')
    assert.equal(downloadState(99.9, '0.2.15').phase, 'downloading')
  })
})

describe('isUpdateBusy', () => {
  it('covers every phase that is waiting on something', () => {
    for (const phase of /** @type {const} */ (['checking', 'downloading', 'verifying', 'installing'])) {
      assert.equal(isUpdateBusy({ phase }), true, phase)
    }
  })

  it('excludes the phases where nothing is happening', () => {
    for (const phase of /** @type {const} */ (['idle', 'available', 'ready', 'error'])) {
      assert.equal(isUpdateBusy({ phase }), false, phase)
    }
  })
})

describe('updateStatusLine', () => {
  it('says something different for every phase', () => {
    const lines = (/** @type {const} */ (['idle', 'checking', 'available', 'downloading', 'verifying', 'ready', 'installing', 'error']))
      .map((phase) => updateStatusLine({ phase, version: '0.2.15' }))
    assert.equal(new Set(lines).size, lines.length)
  })

  it('shows the percentage while downloading', () => {
    assert.ok(updateStatusLine({ phase: 'downloading', version: '0.2.15', percent: 42 }).includes('42%'))
  })

  it('says restarting is what applies, not installing now', () => {
    // "Ready" that reads as "done" would leave the user wondering why nothing
    // changed.
    assert.ok(updateStatusLine({ phase: 'ready', version: '0.2.15' }).includes('重启'))
  })

  it('survives a state it does not recognise', () => {
    assert.ok(updateStatusLine({ phase: /** @type {never} */ (/** @type {unknown} */ ('brand-new')) }).length > 0)
  })
})

describe('updateStateChanged', () => {
  it('treats the first state as a change', () => {
    assert.equal(updateStateChanged(undefined, IDLE_UPDATE_STATE), true)
  })

  it('sees nothing changed between identical records', () => {
    const state = updateState({ phase: 'downloading', version: '1', percent: 10 })
    assert.equal(updateStateChanged(state, updateState({ phase: 'downloading', version: '1', percent: 10 })), false)
  })

  it('notices each field that matters', () => {
    const base = updateState({ phase: 'downloading', version: '1', percent: 10 })
    assert.equal(updateStateChanged(base, updateState({ phase: 'verifying', version: '1', percent: 10 })), true)
    assert.equal(updateStateChanged(base, updateState({ phase: 'downloading', version: '2', percent: 10 })), true)
    assert.equal(updateStateChanged(base, updateState({ phase: 'downloading', version: '1', percent: 11 })), true)
    assert.equal(updateStateChanged(base, updateState({ phase: 'error', version: '1', percent: 10, failure: 'check' })), true)
  })
})
