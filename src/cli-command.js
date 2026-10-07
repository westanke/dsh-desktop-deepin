/**
 * Installs the `dsh` command for the user's shell, reversibly.
 *
 * The shell runs `dsh` from `PATH`, so a desktop install is only half useful:
 * a terminal opened next to it cannot talk to it. This publishes the command on
 * `PATH` and takes it back out again without leaving anything behind.
 *
 * The governing constraint is that a user's `PATH` is not ours. Whatever is
 * already there belongs to them — a distro package, an nvm install, a manual
 * build — and this module may only add a link it can prove is its own, may
 * only replace a link whose fingerprint still matches the one it recorded, and
 * may always put back what it displaced.
 *
 * The official shell does this for macOS and Windows and declines to build it
 * for Linux (`command-manager-entry.ts` throws `EUNSUPPORTED` off darwin/win32),
 * so the portable half of its design is reimplemented here against symlinks.
 *
 * @module cli-command
 */

import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Receipts live beside the install so a later run can tell "the link I made is
 * still there" from "something replaced it".
 */
const RECEIPT_NAME = '.dsh-desktop-command.json'

/** Command name published on `PATH`. */
export const COMMAND_NAME = 'dsh'

/**
 * @typedef {object} CommandFingerprint
 * @property {string} dev - device id
 * @property {string} ino - inode
 * @property {number} mode - permission bits
 * @property {number} uid - owner
 * @property {number} gid - group
 * @property {number} size - byte length of the link target
 * @property {string} mtimeMs - modification time in milliseconds, as a string
 * @property {string} target - where the symlink points
 */

/**
 * @typedef {object} CommandReceipt
 * @property {string} link - absolute path of the published command
 * @property {string} target - what that link pointed at when installed
 * @property {CommandFingerprint} fingerprint - the link as installed
 * @property {string} installedAt - ISO timestamp
 */

/** Why an operation was refused. */
export const REFUSAL = Object.freeze({
  notALink: 'notALink',
  ownership: 'ownership',
  stale: 'stale',
  notInstalled: 'notInstalled',
})

/**
 * Whether anything exists at a path, of any kind.
 *
 * Needed because "the path is a symlink" and "the path exists" are different
 * questions: a regular file the user put there is occupied even though no
 * fingerprint can describe it.
 *
 * @param {string} path - to test
 * @returns {Promise<boolean>}
 */
async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Records what can be checked about a link later.
 *
 * `mtime` is part of it because a link can be recreated at the same inode with
 * a different target, which the other fields alone would not catch.
 *
 * @param {string} link - path to stat
 * @returns {Promise<CommandFingerprint | null>} null when the path is absent
 */
export async function fingerprintLink(link) {
  try {
    const stats = await lstat(link)
    if (!stats.isSymbolicLink()) return null
    return {
      dev: String(stats.dev),
      ino: String(stats.ino),
      mode: stats.mode & 0o7777,
      uid: stats.uid,
      gid: stats.gid,
      size: stats.size,
      mtimeMs: String(stats.mtimeMs),
      // `readFile` on a symlink reads the *target's* contents, not the link.
      // Only `readlink` reports where the link points, which is the thing the
      // fingerprint has to capture.
      target: await readlink(link),
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Whether a fingerprint still describes the link on disk.
 *
 * @param {CommandFingerprint | null} recorded - what the receipt said
 * @param {CommandFingerprint | null} current - what the link is now
 * @returns {boolean}
 */
export function fingerprintMatches(recorded, current) {
  if (recorded === null || current === null) return false
  return (
    recorded.dev === current.dev &&
    recorded.ino === current.ino &&
    recorded.mode === current.mode &&
    recorded.uid === current.uid &&
    recorded.gid === current.gid &&
    recorded.size === current.size &&
    recorded.mtimeMs === current.mtimeMs &&
    recorded.target === current.target
  )
}

/**
 * @param {string} directory - where the receipt lives
 * @returns {Promise<CommandReceipt | null>}
 */
export async function readReceipt(directory) {
  try {
    const raw = await readFile(join(directory, RECEIPT_NAME), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.link === 'string' && typeof parsed.fingerprint === 'object'
      ? /** @type {CommandReceipt} */ (parsed)
      : null
  } catch {
    // A missing or unparsable receipt means "nothing installed that we can
    // prove", which is the safe reading: without proof we must not remove.
    return null
  }
}

/**
 * @param {string} directory - where the receipt lives
 * @param {CommandReceipt} receipt - what to record
 * @returns {Promise<void>}
 */
export async function writeReceipt(directory, receipt) {
  await mkdir(directory, { recursive: true })
  // Owner-only: the receipt names the user's home and the link target.
  await writeFile(join(directory, RECEIPT_NAME), `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    flag: 'w',
  })
}

/**
 * The directory the command is published into.
 *
 * `~/.local/bin` rather than a system path: it is on `PATH` by default on the
 * distributions this shell targets, and it is the user's own space — so no
 * privilege is needed and nothing outside the home directory is touched.
 *
 * @param {object} [options]
 * @param {string} [options.home] - overridable so tests need no real home
 * @returns {string}
 */
export function commandDirectory({ home = homedir() } = {}) {
  return join(home, '.local', 'bin')
}

/**
 * Publishes `target` as `dsh` on `PATH`.
 *
 * Refuses to touch an existing entry unless it is the link this module
 * installed and its fingerprint is unchanged. A displaced entry is moved aside
 * rather than deleted, and restored if anything fails.
 *
 * @param {object} options
 * @param {string} options.target - the executable to publish
 * @param {string[]} [options.args] - arguments the published link must pass
 * @param {string} [options.directory] - defaults to {@link commandDirectory}
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
 */
export async function installCommand({ target, args = [], directory = commandDirectory() }) {
  const link = join(directory, COMMAND_NAME)
  const receipt = await readReceipt(directory)
  const existing = await fingerprintLink(link)
  // A path that exists but is not a symlink is somebody's own command, and
  // `fingerprintLink` cannot describe it — so it has to be detected as "taken"
  // rather than mistaken for "free". Otherwise the `symlink` below fails with
  // EEXIST and the user gets a syscall error instead of a decision.
  const occupied = existing !== null || (await pathExists(link))

  if (occupied) {
    if (receipt === null || receipt.link !== link) {
      return {
        ok: false,
        code: REFUSAL.ownership,
        message: `${link} 已被其它程序占用，未改动`,
      }
    }
    if (existing === null || !fingerprintMatches(receipt.fingerprint, existing)) {
      return {
        ok: false,
        code: REFUSAL.stale,
        message: `${link} 在安装后被改动过，未改动；请手动检查`,
      }
    }
  }

  await mkdir(directory, { recursive: true })
  /** @type {string | null} */
  let backup = null
  if (occupied) {
    // Move the previous entry aside rather than deleting it: if anything below
    // fails, it goes back exactly where it was.
    backup = join(directory, `.dsh-command-backup-${String(Date.now())}`)
    await rename(link, backup)
  }
  try {
    if (args.length > 0) {
      // A symlink cannot carry arguments, so the published command is a small
      // exec wrapper. Quoting is single-quote with `'\''` escaping, which is
      // safe for any byte a path can contain.
      const quoted = [target, ...args].map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(' ')
      const script = join(directory, `.${COMMAND_NAME}-launcher`)
      await writeFile(script, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755, flag: 'w' })
      await symlink(script, link)
    } else {
      await symlink(target, link)
    }
  } catch (error) {
    // Put back what was there: a failed install must not cost the user the
    // command they already had.
    if (backup !== null) await rename(backup, link).catch(() => undefined)
    return {
      ok: false,
      code: /** @type {NodeJS.ErrnoException} */ (error).code ?? 'EIO',
      message: error instanceof Error ? error.message : '创建命令链接失败',
    }
  }
  const fingerprint = await fingerprintLink(link)
  if (fingerprint === null) {
    await unlink(link).catch(() => undefined)
    if (backup !== null) await rename(backup, link).catch(() => undefined)
    return { ok: false, code: 'EIO', message: '命令链接创建后无法确认' }
  }
  await writeReceipt(directory, {
    link,
    target,
    fingerprint,
    installedAt: new Date().toISOString(),
  })
  // Only now is the displaced entry safe to drop: the new link is in place and
  // recorded, so the user can run the command even if this one is wrong.
  if (backup !== null) await rm(backup, { force: true }).catch(() => undefined)
  return { ok: true }
}

/**
 * Removes a command this module installed.
 *
 * Refuses when the link is not ours, or when its fingerprint moved since the
 * receipt was written — in both cases the user changed something and only they
 * can decide what to do with it.
 *
 * @param {object} [options]
 * @param {string} [options.directory] - defaults to {@link commandDirectory}
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
 */
export async function uninstallCommand({ directory = commandDirectory() } = {}) {
  const link = join(directory, COMMAND_NAME)
  const receipt = await readReceipt(directory)
  if (receipt === null || receipt.link !== link) {
    return { ok: false, code: REFUSAL.notInstalled, message: '未找到本壳安装的命令' }
  }
  if (!(await pathExists(link))) {
    // Already gone. Clear the receipt so the state is honest, and report it as
    // removed rather than as a failure.
    await rm(join(directory, RECEIPT_NAME), { force: true })
    return { ok: true }
  }
  const current = await fingerprintLink(link)
  if (current === null || !fingerprintMatches(receipt.fingerprint, current)) {
    // Either the link is gone, replaced by a real file, or repointed. In every
    // case what is there now was not what we installed, so it is not ours to
    // delete.
    return {
      ok: false,
      code: REFUSAL.stale,
      message: `${link} 在安装后被改动过，未删除；请手动检查`,
    }
  }
  await unlink(link)
  await rm(join(directory, `.${COMMAND_NAME}-launcher`), { force: true }).catch(() => undefined)
  await rm(join(directory, RECEIPT_NAME), { force: true })
  return { ok: true }
}

/**
 * What is currently published, for the shell to show the user.
 *
 * @param {object} [options]
 * @param {string} [options.directory] - defaults to {@link commandDirectory}
 * @returns {Promise<{ state: 'ours' | 'foreign' | 'absent' | 'stale', link: string, target: string | null }>}
 */
export async function describeCommand({ directory = commandDirectory() } = {}) {
  const link = join(directory, COMMAND_NAME)
  const receipt = await readReceipt(directory)
  if (!(await pathExists(link))) return { state: 'absent', link, target: null }
  const current = await fingerprintLink(link)
  if (current === null) {
    // Something is there, but it is not a symlink: the user's own command.
    return { state: 'foreign', link, target: null }
  }
  if (receipt === null || receipt.link !== link) return { state: 'foreign', link, target: current.target }
  return {
    state: fingerprintMatches(receipt.fingerprint, current) ? 'ours' : 'stale',
    link,
    target: current.target,
  }
}

/**
 * Whether a path is inside a directory, by resolved location.
 *
 * Used to refuse publishing into a directory that resolves somewhere else than
 * it appears to — a symlinked `~/.local/bin` is legitimate, but the caller has
 * to be able to say what it ended up touching.
 *
 * @param {string} parent - the directory that must contain the result
 * @param {string} child - the path to resolve
 * @returns {Promise<boolean>}
 */
export async function resolvesInside(parent, child) {
  try {
    const [realParent, realChild] = await Promise.all([realpath(parent), realpath(child)])
    return realChild === realParent || realChild.startsWith(`${realParent}/`)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false
    throw error
  }
}

/** Re-exported so callers do not need `node:fs` for the access check. */
export const READABLE = fsConstants.R_OK