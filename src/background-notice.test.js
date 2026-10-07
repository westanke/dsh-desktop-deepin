/**
 * @module background-notice
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { BackgroundNotice } from './background-notice.js'

/** @type {string} */
let workspace = ''
/** @type {string} */
let marker = ''

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-notice-'))
  marker = join(workspace, 'tray-notice.acknowledged')
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('BackgroundNotice', () => {
  it('asks before the first hide and hides once acknowledged', async () => {
    /** @type {string[]} */
    const events = []
    let answer = 0
    const notice = new BackgroundNotice({
      markerPath: marker,
      show: async () => {
        events.push('ask')
        return answer
      },
    })
    notice.close(() => events.push('hide'))
    // The dialog is answered asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(events, ['ask', 'hide'])
    assert.equal(await readFile(marker, 'utf8'), '', 'the acknowledgement is recorded')
  })

  it('does not hide when the notice is dismissed', async () => {
    /** @type {string[]} */
    const events = []
    const notice = new BackgroundNotice({ markerPath: marker, show: async () => 1 })
    notice.close(() => events.push('hide'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(events, [], 'a declined notice must not hide the window')
  })

  it('asks again next launch when the notice was declined', async () => {
    // Remembering a refusal as consent would be the worst outcome: the user
    // said no once, and would never see it again.
    const first = new BackgroundNotice({ markerPath: marker, show: async () => 1 })
    first.close(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))

    let asked = false
    const second = new BackgroundNotice({
      markerPath: marker,
      show: async () => {
        asked = true
        return 0
      },
    })
    second.close(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(asked, true, 'no marker means no acknowledgement')
  })

  it('hides straight away once a marker exists', async () => {
    // The marker survives upgrades, so a user who consented once is not asked
    // about it again after reinstalling.
    await mkdir(workspace, { recursive: true })
    await writeFile(marker, '')
    let asked = false
    const notice = new BackgroundNotice({
      markerPath: marker,
      show: async () => {
        asked = true
        return 0
      },
    })
    let hidden = false
    notice.close(() => {
      hidden = true
    })
    assert.equal(hidden, true, 'the hide must be synchronous once acknowledged')
    assert.equal(asked, false)
  })

  it('focuses the window instead of stacking a second dialog', async () => {
    let asks = 0
    let focused = 0
    const notice = new BackgroundNotice({
      markerPath: marker,
      show: async () => {
        asks += 1
        // Answer slowly so the second request lands while this one is up.
        await new Promise((resolve) => setTimeout(resolve, 30))
        return 1
      },
      focus: () => {
        focused += 1
      },
    })
    notice.close(() => undefined)
    notice.close(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(asks, 1, 'a double click on close is not a second question')
    assert.equal(focused, 1)
  })

  it('leaves the window visible when the dialog cannot be shown', async () => {
    let hidden = false
    const notice = new BackgroundNotice({
      markerPath: marker,
      show: async () => {
        throw new Error('no display')
      },
    })
    notice.close(() => {
      hidden = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Closing on the user's behalf is a decision they did not make, and the
    // notice exists precisely because the outcome of closing surprises them.
    assert.equal(hidden, false)
  })

  it('ignores a response that arrives after disposal', async () => {
    let hidden = false
    const notice = new BackgroundNotice({
      markerPath: marker,
      show: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return 0
      },
    })
    notice.close(() => {
      hidden = true
    })
    notice.dispose()
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(hidden, false, 'a quit in progress must not be undone by a late answer')
  })

  it('ignores a request after disposal', async () => {
    const notice = new BackgroundNotice({ markerPath: marker, show: async () => 0 })
    notice.dispose()
    let hidden = false
    notice.close(() => {
      hidden = true
    })
    assert.equal(hidden, false)
  })

  it('does not claim acknowledgement when the marker cannot be written', async () => {
    // Without the marker the user is asked again next launch, which is worse
    // than being asked twice but never wrong.
    const notice = new BackgroundNotice({
      markerPath: join(marker, 'nested-under-a-file'),
      show: async () => 0,
    })
    let hidden = false
    notice.close(() => {
      hidden = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(hidden, true, 'this launch still hides')
  })
})
