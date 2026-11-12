/**
 * Tests for runtime discovery.
 *
 * Everything is injected: no real filesystem, no processes, no network.
 *
 * @module runtime-doctor.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { delimiter, join } from 'node:path'
import {
  MIN_ELECTRON_MAJOR,
  MIN_NODE_VERSION,
  WANTED_ELECTRON_VERSION,
  conventionalDirs,
  detectRuntime,
  findBinary,
  formatReport,
  meetsMinimum,
  mirrorFor,
  parseVersion,
  pathDirs,
} from './runtime-doctor.js'

/** @param {string[]} present @returns {(path: string) => boolean} */
const existsOnly = (present) => (path) => present.includes(path)

/** @param {Record<string, string>} versions @returns {(path: string) => string | null} */
const versionsOf = (versions) => (path) => versions[path] ?? null

describe('parseVersion', () => {
  it('reads a plain and a v-prefixed version', () => {
    assert.deepEqual(parseVersion('22.15.0'), [22, 15, 0])
    assert.deepEqual(parseVersion('v33.3.0'), [33, 3, 0])
  })

  it('finds the version inside a longer banner', () => {
    assert.deepEqual(parseVersion('v20.11.1\nsome trailing text'), [20, 11, 1])
  })

  it('returns null for anything unparseable', () => {
    for (const input of [null, undefined, '', 'no version here', 42]) {
      assert.equal(parseVersion(/** @type {any} */ (input)), null)
    }
  })
})

describe('meetsMinimum', () => {
  it('accepts an equal version', () => {
    assert.equal(meetsMinimum([22, 15, 0], MIN_NODE_VERSION), true)
  })

  it('accepts anything newer, including a higher minor or major', () => {
    assert.equal(meetsMinimum([22, 15, 1], MIN_NODE_VERSION), true)
    assert.equal(meetsMinimum([23, 0, 0], MIN_NODE_VERSION), true)
    assert.equal(meetsMinimum([24, 19, 0], MIN_NODE_VERSION), true)
  })

  it('rejects 22.14 — the version that broke zstd', () => {
    assert.equal(meetsMinimum([22, 14, 9], MIN_NODE_VERSION), false)
  })

  it('rejects a lower major', () => {
    assert.equal(meetsMinimum([20, 99, 99], MIN_NODE_VERSION), false)
  })

  it('rejects an unknown version rather than assuming it is fine', () => {
    assert.equal(meetsMinimum(null, MIN_NODE_VERSION), false)
  })
})

describe('pathDirs', () => {
  it('splits on the platform delimiter and drops empty entries', () => {
    // 按「平台分隔符」构造输入：win32 上是 ';'，POSIX 上是 ':'。
    const sep = delimiter
    assert.deepEqual(pathDirs(`/a${sep}/b`), ['/a', '/b'])
    assert.deepEqual(pathDirs(''), [])
  })
})

describe('conventionalDirs', () => {
  it('includes the usual system locations and the user bin', () => {
    const dirs = conventionalDirs('/home/u')
    assert.ok(dirs.includes('/usr/local/bin'))
    assert.ok(dirs.includes(join('/home/u', '.local', 'bin')))
  })
})

describe('findBinary', () => {
  it('prefers the configured path when it exists', () => {
    const found = findBinary({
      name: 'node',
      configured: '/opt/custom/node',
      dirs: ['/usr/bin'],
      exists: existsOnly(['/opt/custom/node', join('/usr/bin', 'node')]),
    })
    assert.equal(found, '/opt/custom/node')
  })

  it('ignores a configured path that does not exist', () => {
    const found = findBinary({
      name: 'node',
      configured: '/gone/node',
      dirs: ['/usr/bin'],
      exists: existsOnly([join('/usr/bin', 'node')]),
    })
    assert.equal(found, join('/usr/bin', 'node'))
  })

  it('walks the search directories in order', () => {
    const found = findBinary({
      name: 'dsh',
      dirs: ['/first', '/second'],
      exists: existsOnly([join('/second', 'dsh')]),
    })
    assert.equal(found, join('/second', 'dsh'))
  })

  it('returns null when nothing matches', () => {
    assert.equal(findBinary({ name: 'nope', dirs: ['/a'], exists: () => false }), null)
  })
})

describe('detectRuntime', () => {
  const happy = {
    exists: existsOnly([join('/usr/bin', 'electron'), join('/usr/bin', 'node'), join('/usr/bin', 'dsh')]),
    runVersion: versionsOf({
      [join('/usr/bin', 'electron')]: 'v33.3.0',
      [join('/usr/bin', 'node')]: 'v24.19.0',
      [join('/usr/bin', 'dsh')]: '0.2.0-rc.1',
    }),
    pathValue: '/usr/bin',
    home: '/home/u',
  }

  it('reports everything present and usable', () => {
    const report = detectRuntime({ ...happy, platform: 'linux' })
    assert.equal(report.electron.ok, true)
    assert.equal(report.node.ok, true)
    assert.equal(report.dsh.ok, true)
    assert.deepEqual(report.missing, [])
  })

  it('lists what is missing', () => {
    const report = detectRuntime({ ...happy, platform: 'linux', exists: existsOnly([join('/usr/bin', 'node')]) })
    assert.deepEqual(report.missing.sort(), ['dsh', 'electron'])
  })

  it('treats Node 22.14 as missing, not merely old', () => {
    const report = detectRuntime({
      ...happy,
      platform: 'linux',
      runVersion: versionsOf({
        [join('/usr/bin', 'electron')]: 'v33.3.0',
        [join('/usr/bin', 'node')]: 'v22.14.0',
        [join('/usr/bin', 'dsh')]: '0.2.0-rc.1',
      }),
    })
    assert.equal(report.node.ok, false)
    assert.ok(report.missing.includes('node'))
  })

  it('accepts a newer Electron major', () => {
    const report = detectRuntime({
      ...happy,
      platform: 'linux',
      runVersion: versionsOf({
        [join('/usr/bin', 'electron')]: 'v44.0.0',
        [join('/usr/bin', 'node')]: 'v24.19.0',
        [join('/usr/bin', 'dsh')]: '0.2.0-rc.1',
      }),
    })
    assert.equal(report.electron.ok, true)
  })

  it('rejects an Electron older than the floor', () => {
    const report = detectRuntime({
      ...happy,
      platform: 'linux',
      runVersion: versionsOf({
        [join('/usr/bin', 'electron')]: `v${MIN_ELECTRON_MAJOR - 1}.0.0`,
        [join('/usr/bin', 'node')]: 'v24.19.0',
        [join('/usr/bin', 'dsh')]: '0.2.0-rc.1',
      }),
    })
    assert.equal(report.electron.ok, false)
  })

  it('flags an Electron that is usable but older than the wanted release', () => {
    const report = detectRuntime({
      ...happy,
      platform: 'linux',
      runVersion: versionsOf({
        [join('/usr/bin', 'electron')]: 'v33.3.0',
        [join('/usr/bin', 'node')]: 'v24.19.0',
        [join('/usr/bin', 'dsh')]: '0.2.0-rc.1',
      }),
    })
    // Usable — it is above the floor — but not the release we verified against.
    assert.equal(report.electron.ok, true)
    assert.equal(report.electronOutdated, true)
    assert.deepEqual(report.missing, [])
  })

  it('does not flag the wanted Electron release as outdated', () => {
    const report = detectRuntime({
      ...happy,
      platform: 'linux',
      runVersion: versionsOf({
        [join('/usr/bin', 'electron')]: WANTED_ELECTRON_VERSION,
        [join('/usr/bin', 'node')]: 'v24.19.0',
        [join('/usr/bin', 'dsh')]: '0.2.0-rc.1',
      }),
    })
    assert.equal(report.electron.ok, true)
    assert.equal(report.electronOutdated, false)
  })

  it('does not flag a newer Electron release as outdated', () => {
    const report = detectRuntime({
      ...happy,
      platform: 'linux',
      runVersion: versionsOf({
        [join('/usr/bin', 'electron')]: 'v99.0.0',
        [join('/usr/bin', 'node')]: 'v24.19.0',
        [join('/usr/bin', 'dsh')]: '0.2.0-rc.1',
      }),
    })
    assert.equal(report.electron.ok, true)
    assert.equal(report.electronOutdated, false)
  })

  it('accepts any dsh, however new', () => {
    const report = detectRuntime({
      ...happy,
      platform: 'linux',
      runVersion: versionsOf({
        [join('/usr/bin', 'electron')]: 'v33.3.0',
        [join('/usr/bin', 'node')]: 'v24.19.0',
        [join('/usr/bin', 'dsh')]: '9.9.9',
      }),
    })
    assert.equal(report.dsh.ok, true)
  })

  it('honours a configured path over the search directories', () => {
    const report = detectRuntime({
      ...happy,
      exists: existsOnly(['/custom/dsh', join('/usr/bin', 'electron'), join('/usr/bin', 'node')]),
      runVersion: versionsOf({
        [join('/usr/bin', 'electron')]: 'v33.3.0',
        [join('/usr/bin', 'node')]: 'v24.19.0',
        '/custom/dsh': '0.2.0-rc.1',
      }),
      configured: { systemDsh: '/custom/dsh' },
    })
    assert.equal(report.dsh.path, '/custom/dsh')
  })

  it('does not run a version command for a binary it never found', () => {
    /** @type {string[]} */
    const asked = []
    detectRuntime({
      exists: () => false,
      runVersion: (path) => {
        asked.push(path)
        return null
      },
      pathValue: '',
    })
    assert.deepEqual(asked, [])
  })
})

describe('formatReport', () => {
  it('marks each dependency present or missing', () => {
    const report = detectRuntime({
      platform: 'linux',
      exists: existsOnly([join('/usr/bin', 'node')]),
      runVersion: versionsOf({ [join('/usr/bin', 'node')]: 'v24.19.0' }),
      pathValue: '/usr/bin',
    })
    const lines = formatReport(report)
    assert.equal(lines.length, 3)
    assert.ok(lines.some((l) => l.startsWith('✅') && l.includes('Node')))
    assert.ok(lines.some((l) => l.startsWith('❌') && l.includes('Electron')))
  })
})

describe('mirrorFor', () => {
  it('gives the China mirror first for every dependency', () => {
    for (const kind of ['node', 'electron', 'dsh']) {
      assert.match(mirrorFor(/** @type {any} */ (kind)), /npmmirror\.com/)
    }
  })

  it('falls back to a second origin when asked', () => {
    assert.notEqual(mirrorFor('node', 1), mirrorFor('node', 0))
  })

  it('clamps an out-of-range index to the last mirror', () => {
    assert.equal(mirrorFor('node', 99), mirrorFor('node', 1))
  })
})
