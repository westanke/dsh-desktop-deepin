/**
 * Runtime discovery: where the three moving parts actually live.
 *
 * The shell needs three things to start: an Electron binary to host the
 * window, a Node to run the kernel on, and the `dsh` kernel itself. Any of
 * them may already be installed, may be missing, or may be the wrong version.
 *
 * This module answers "what is present and where", as pure functions over an
 * injected filesystem and version runner, so every branch is testable without
 * touching the real machine or the network. Fetching what is missing is a
 * separate concern (`runtime-install.js`).
 *
 * Lookup order for each: the configured path first (it is an explicit
 * statement of intent), then `PATH`, then the conventional install locations.
 *
 * @module runtime-doctor
 */

import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * The kernel needs `zlib.createZstdDecompress`, which landed in Node 22.15.
 * Anything older fails at import time with an error that says nothing about
 * versions, so the check is explicit.
 */
export const MIN_NODE_VERSION = [22, 15, 0]

/**
 * The Electron major the shell was developed and tested against. Newer majors
 * are accepted — the APIs used here are stable — but anything older is
 * refused, because the packaged defaults may rely on behaviour it lacks.
 */
export const MIN_ELECTRON_MAJOR = 33

/**
 * The Electron release the shell was actually verified against.
 *
 * Distinct from `MIN_ELECTRON_MAJOR`, which is the lower bound the shell
 * accepts: a machine may sit between the two and still run the shell, but it
 * is then running an Electron this shell was not tested with. The lower bound
 * is a promise to the user ("33 works"); this one is a statement of fact
 * ("45 is what we tested"). Both are needed — conflating them either blocks
 * users who are fine on 33, or leaves them silently on an unverified release.
 *
 * @type {string}
 */
export const WANTED_ELECTRON_VERSION = 'v45.3.0'

/**
 * Chinese mirrors, tried before the upstream hosts.
 *
 * Every one of these was verified to answer; the point is speed on a mainland
 * connection, where the upstream hosts are frequently unusable.
 */
export const MIRRORS = Object.freeze({
  node: ['https://npmmirror.com/mirrors/node', 'https://mirrors.huaweicloud.com/nodejs'],
  electron: ['https://npmmirror.com/mirrors/electron', 'https://mirrors.huaweicloud.com/electron'],
  dsh: ['https://registry.npmmirror.com', 'https://registry.npmjs.org'],
})

/**
 * Conventional places a binary may live when it is not on `PATH`.
 *
 * @param {string} home
 * @returns {string[]}
 */
export function conventionalDirs(home = homedir()) {
  return [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/nodejs/bin',
    '/usr/local/nodejs/bin',
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.dsh-desktop', 'runtime'),
  ]
}

/**
 * Splits a `PATH` value.
 *
 * @param {string} [pathValue]
 * @returns {string[]}
 */
export function pathDirs(pathValue = '') {
  return pathValue.split(delimiter).filter((entry) => entry !== '')
}

/**
 * Parses a version string into comparable parts.
 *
 * @param {string | null | undefined} text
 * @returns {number[] | null}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (match === null) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null
  return [major, minor, patch]
}

/**
 * The wanted Electron release, pre-parsed.
 *
 * `parseVersion` is a hoisted function declaration, so calling it here at
 * module scope is fine; the constant never changes, so it is parsed once.
 */
const WANTED_ELECTRON_PARTS = parseVersion(WANTED_ELECTRON_VERSION) ?? [0, 0, 0]

/**
 * Whether `version` is at least `minimum`, compared part by part.
 *
 * @param {number[] | null | undefined} version
 * @param {number[]} minimum
 * @returns {boolean}
 */
export function meetsMinimum(version, minimum) {
  if (version === null || version === undefined) return false
  for (let index = 0; index < minimum.length; index += 1) {
    const have = version[index] ?? 0
    const need = minimum[index] ?? 0
    if (have > need) return true
    if (have < need) return false
  }
  return true
}

/**
 * Finds the first candidate that exists.
 *
 * @param {object} options
 * @param {string[]} options.candidates
 * @param {(path: string) => boolean} options.exists
 * @returns {string | null}
 */
function firstExisting({ candidates, exists }) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && exists(candidate)) return candidate
  }
  return null
}

/**
 * Locates one binary across the configured path, `PATH`, and conventions.
 *
 * @param {object} options
 * @param {string} options.name - binary file name, e.g. `node`
 * @param {string | null} [options.configured] - an explicit path from config
 * @param {string[]} options.dirs - directories to search
 * @param {(path: string) => boolean} options.exists
 * @returns {string | null}
 */
export function findBinary({ name, configured = null, dirs, exists }) {
  if (configured !== null && configured !== '' && exists(configured)) return configured
  return firstExisting({ candidates: dirs.map((dir) => join(dir, name)), exists })
}

/**
 * Inspects the three runtime dependencies.
 *
 * `runVersion` is injected rather than spawned here: this function stays pure
 * and synchronous-by-contract, and the caller decides how a version string is
 * obtained (which may involve launching a process, or may be a stub in a test).
 *
 * @param {object} options
 * @param {string} [options.platform]
 * @param {string} [options.home]
 * @param {string} [options.pathValue]
 * @param {(path: string) => boolean} options.exists
 * @param {(path: string) => string | null} options.runVersion
 * @param {{electron?: string, nodeBinDir?: string, systemDsh?: string}} [options.configured] - the `launcher` section of config.json
 * @returns {{
 *   electron: {path: string | null, version: string | null, ok: boolean},
 *   node: {path: string | null, version: string | null, ok: boolean},
 *   dsh: {path: string | null, version: string | null, ok: boolean},
 *   missing: string[],
 *   electronOutdated: boolean,
 * }}
 */
export function detectRuntime({
  platform = process.platform,
  home = homedir(),
  pathValue = '',
  exists,
  runVersion,
  configured = {},
}) {
  const dirs = [...pathDirs(pathValue), ...conventionalDirs(home)]
  const isWindows = platform === 'win32'

  const electronPath = findBinary({
    name: isWindows ? 'electron.exe' : 'electron',
    configured: configured.electron ?? null,
    dirs,
    exists,
  })
  const electronVersion = electronPath === null ? null : runVersion(electronPath)
  const electronParts = parseVersion(electronVersion)

  const nodePath = findBinary({
    name: isWindows ? 'node.exe' : 'node',
    configured: configured.nodeBinDir ? join(configured.nodeBinDir, isWindows ? 'node.exe' : 'node') : null,
    dirs,
    exists,
  })
  const nodeVersion = nodePath === null ? null : runVersion(nodePath)

  const dshPath = findBinary({
    name: isWindows ? 'dsh.cmd' : 'dsh',
    configured: configured.systemDsh ?? null,
    dirs,
    exists,
  })
  const dshVersion = dshPath === null ? null : runVersion(dshPath)

  const electronMajor = electronParts === null ? null : electronParts[0]
  const electronOk = electronMajor !== null && electronMajor !== undefined && electronMajor >= MIN_ELECTRON_MAJOR
  // Usable, but older than the release the shell was verified against. Not
  // "missing" — it runs — but the shell upgrade is only half-done without it.
  const electronOutdated = electronOk && !meetsMinimum(electronParts, WANTED_ELECTRON_PARTS)
  const nodeOk = meetsMinimum(parseVersion(nodeVersion), MIN_NODE_VERSION)
  // Any `dsh` that runs is acceptable: the shell does not pin a kernel version,
  // and refusing a newer one would break the "use what is installed" promise.
  const dshOk = dshPath !== null

  /** @type {string[]} */
  const missing = []
  if (!electronOk) missing.push('electron')
  if (!nodeOk) missing.push('node')
  if (!dshOk) missing.push('dsh')

  return {
    electron: { path: electronPath, version: electronVersion, ok: electronOk },
    node: { path: nodePath, version: nodeVersion, ok: nodeOk },
    dsh: { path: dshPath, version: dshVersion, ok: dshOk },
    missing,
    electronOutdated,
  }
}

/**
 * A human-readable report of a detection result.
 *
 * @param {ReturnType<typeof detectRuntime>} report
 * @returns {string[]} one line per dependency
 */
export function formatReport(report) {
  /**
   * @param {string} label
   * @param {{path: string | null, version: string | null, ok: boolean}} entry
   * @param {string} requirement
   * @returns {string}
   */
  const line = (label, entry, requirement) => {
    const found = entry.path === null ? '未找到' : entry.path
    const version = entry.version === null ? '版本未知' : entry.version
    return `${entry.ok ? '✅' : '❌'} ${label.padEnd(9)} ${version.padEnd(12)} ${found}${entry.ok ? '' : `  (需要 ${requirement})`}`
  }
  return [
    line('Electron', report.electron, `≥${MIN_ELECTRON_MAJOR}.0.0`),
    line('Node', report.node, `≥${MIN_NODE_VERSION.join('.')}`),
    line('dsh 内核', report.dsh, '任意可运行版本'),
  ]
}

/**
 * The download origin for a dependency, mirror first.
 *
 * @param {'node' | 'electron' | 'dsh'} kind
 * @param {number} [index]
 * @returns {string}
 */
export function mirrorFor(kind, index = 0) {
  const list = MIRRORS[kind]
  const chosen = list[Math.min(index, list.length - 1)]
  return chosen ?? list[0] ?? ''
}
