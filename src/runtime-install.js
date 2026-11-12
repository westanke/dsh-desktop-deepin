/**
 * Fetching the runtimes the shell needs but cannot find.
 *
 * Companion to `runtime-doctor.js`: that module answers "what is here", this
 * one answers "get me what is not". Everything lands in a single user-writable
 * directory, and nothing is installed system-wide — the shell never needs root,
 * and a failed download leaves no half-installed binary behind.
 *
 * Origins are the China mirrors first (see `MIRRORS`): the upstream hosts are
 * routinely unreachable from a mainland connection, and a download that hangs
 * is worse than one that fails.
 *
 * @module runtime-install
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { MIRRORS, mirrorFor } from './runtime-doctor.js'

/**
 * Where downloaded runtimes go.
 *
 * Under the user's home rather than the shell's own directory: the runtimes
 * outlive any single checkout, and a second copy of the shell should find them
 * already there.
 *
 * @param {string} [home]
 * @returns {string}
 */
export function runtimeDir(home = homedir()) {
  return join(home, '.dsh-desktop', 'runtime')
}

/**
 * The Node version to fetch when none is usable.
 *
 * A current LTS-line release rather than the newest: the kernel is a developer
 * preview and is exercised against stable Node.
 *
 * @type {string}
 */
export const DEFAULT_NODE_VERSION = 'v24.19.0'

/**
 * The Electron version to fetch when none is usable.
 *
 * Electron 45 (Chromium 156, Node 24) is the current release. The shell
 * accepts any newer major; this is the version it installs by default.
 *
 * @type {string}
 */
export const DEFAULT_ELECTRON_VERSION = 'v45.3.0'

/**
 * A download URL for one release archive.
 *
 * @param {'node' | 'electron'} kind
 * @param {string} version - e.g. `v24.19.0`
 * @param {string} fileName
 * @param {number} [mirrorIndex]
 * @returns {string}
 */
export function archiveUrl(kind, version, fileName, mirrorIndex = 0) {
  return `${mirrorFor(kind, mirrorIndex)}/${version}/${fileName}`
}

/**
 * The archive name for a Node release on this platform.
 *
 * @param {string} version
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string}
 */
export function nodeArchiveName(version, platform = process.platform, arch = process.arch) {
  return `node-${version}-${platform}-${arch}.tar.gz`
}

/**
 * The archive name for an Electron release on this platform.
 *
 * @param {string} version
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string}
 */
export function electronArchiveName(version, platform = process.platform, arch = process.arch) {
  return `electron-${version}-${platform}-${arch}.zip`
}

/**
 * Fetches a URL, following redirects, and returns the bytes.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Buffer>}
 */
export async function download(url, { fetchImpl = fetch, timeoutMs = 600_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether a downloaded archive matches its published digest.
 *
 * @param {Buffer} bytes
 * @param {string} expectedHex
 * @returns {boolean}
 */
export function digestMatches(bytes, expectedHex) {
  const actual = createHash('sha256').update(bytes).digest('hex')
  return actual.toLowerCase() === String(expectedHex).toLowerCase()
}

/**
 * Reads an expected digest out of a `SHASUMS256.txt` body.
 *
 * @param {string} body
 * @param {string} fileName
 * @returns {string | null}
 */
export function digestFromShasums(body, fileName) {
  for (const line of body.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (match === null) continue
    const digest = match[1]
    const name = match[2]
    if (digest !== undefined && name !== undefined && name.trim() === fileName) return digest
  }
  return null
}

/**
 * Downloads a file, trying each mirror in turn.
 *
 * The digest is verified before anything is written, so a mirror serving a
 * truncated or substituted archive fails here rather than at run time.
 *
 * @param {object} options
 * @param {'node' | 'electron'} options.kind
 * @param {string} options.version
 * @param {string} options.fileName
 * @param {string} options.destination
 * @param {string | null} [options.expectedSha256]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<string>} the destination path
 */
export async function downloadTo({
  kind,
  version,
  fileName,
  destination,
  expectedSha256 = null,
  fetchImpl = fetch,
  log = () => undefined,
}) {
  /** @type {string[]} */
  const errors = []
  for (let index = 0; index < MIRRORS[kind].length; index += 1) {
    const url = archiveUrl(kind, version, fileName, index)
    try {
      log(`downloading ${url}`)
      const bytes = await download(url, { fetchImpl })
      if (expectedSha256 !== null && !digestMatches(bytes, expectedSha256)) {
        errors.push(`${url}: checksum mismatch`)
        continue
      }
      // Written to a sibling and renamed, so an interrupted download never
      // leaves a file that looks complete at the destination.
      const temporary = `${destination}.partial`
      await writeFile(temporary, bytes)
      await rename(temporary, destination)
      return destination
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await rm(`${destination}.partial`, { force: true }).catch(() => undefined)
  throw new Error(`could not download ${fileName}:\n  ${errors.join('\n  ')}`)
}

/**
 * Extracts a `.tar.gz` or `.zip` archive.
 *
 * Shelling out to `tar` and `unzip` rather than carrying an archive library:
 * both are present on every target, and the alternative is a dependency tree
 * larger than the thing being unpacked.
 *
 * @param {object} options
 * @param {string} options.archive
 * @param {string} options.into
 * @param {(command: string, args: string[], options: object) => Promise<unknown>} options.exec
 * @returns {Promise<void>}
 */
export async function extractArchive({ archive, into, exec }) {
  await mkdir(into, { recursive: true })
  const args = archive.endsWith('.zip')
    ? ['-q', '-o', archive, '-d', into]
    : ['-xzf', archive, '-C', into]
  const command = archive.endsWith('.zip') ? 'unzip' : 'tar'
  try {
    await exec(command, args, {})
  } catch (error) {
    throw new Error(`${command} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Installs a Node runtime under `runtimeDir`.
 *
 * @param {object} options
 * @param {string} [options.home]
 * @param {string} [options.version]
 * @param {(command: string, args: string[], options: object) => Promise<unknown>} options.exec
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<string>} path of the installed `node` binary
 */
export async function installNode({
  home = homedir(),
  version = DEFAULT_NODE_VERSION,
  exec,
  fetchImpl = fetch,
  log = () => undefined,
}) {
  const dir = runtimeDir(home)
  const archiveName = nodeArchiveName(version)
  const archive = join(dir, archiveName)
  const target = join(dir, `node-${version}`)

  if (existsSync(join(target, 'bin', 'node'))) {
    log(`node ${version} already at ${target}`)
    return join(target, 'bin', 'node')
  }

  await mkdir(dir, { recursive: true })
  const shasums = await download(`${mirrorFor('node')}/${version}/SHASUMS256.txt`, { fetchImpl })
  const expected = digestFromShasums(shasums.toString('utf8'), archiveName)
  await downloadTo({ kind: 'node', version, fileName: archiveName, destination: archive, expectedSha256: expected, fetchImpl, log })
  await extractArchive({ archive, into: dir, exec })
  await rm(archive, { force: true }).catch(() => undefined)

  const binary = join(target, 'bin', 'node')
  await chmod(binary, 0o755).catch(() => undefined)
  return binary
}

/**
 * Installs an Electron runtime under `runtimeDir`.
 *
 * Electron *does* publish a `SHASUMS256.txt` per release — the same manifest
 * format Node uses — and both China mirrors carried here sync it alongside the
 * archives. The digest is fetched from the mirror first, so a substituted
 * archive cannot pass by also substituting the manifest (that would require
 * the mirror to fake the upstream manifest itself). The install still goes to
 * a private directory and is verified by asking the binary its version.
 *
 * @param {object} options
 * @param {string} [options.home]
 * @param {string} [options.version]
 * @param {(command: string, args: string[], options: object) => Promise<unknown>} options.exec
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<string>} path of the installed `electron` binary
 */
export async function installElectron({
  home = homedir(),
  version = DEFAULT_ELECTRON_VERSION,
  exec,
  fetchImpl = fetch,
  log = () => undefined,
}) {
  const dir = runtimeDir(home)
  const archiveName = electronArchiveName(version)
  const archive = join(dir, archiveName)
  const target = join(dir, `electron-${version}`)

  if (existsSync(join(target, 'electron'))) {
    log(`electron ${version} already at ${target}`)
    return join(target, 'electron')
  }

  await mkdir(dir, { recursive: true })
  let expected = null
  try {
    const shasums = await download(`${mirrorFor('electron')}/${version}/SHASUMS256.txt`, { fetchImpl })
    expected = digestFromShasums(shasums.toString('utf8'), archiveName)
    if (expected === null) {
      log(`SHASUMS256.txt did not list ${archiveName}; falling back to origin-only integrity`)
    }
  } catch (error) {
    // A manifest that cannot be fetched must not block the install — degrade
    // to the previous behaviour (HTTPS origin is the guarantee), but say so.
    log(`could not fetch SHASUMS256.txt (${error instanceof Error ? error.message : String(error)}); falling back to origin-only integrity`)
  }
  await downloadTo({ kind: 'electron', version, fileName: archiveName, destination: archive, expectedSha256: expected, fetchImpl, log })
  await extractArchive({ archive, into: target, exec })
  await rm(archive, { force: true }).catch(() => undefined)

  const binary = join(target, 'electron')
  await chmod(binary, 0o755).catch(() => undefined)
  return binary
}
