/**
 * Crash reports written before a fatal dialog is shown.
 *
 * The official shell writes a report to the platform log directory — on Linux
 * that is the `logs` directory under the application's `userData`, not
 * `~/Library/Logs` — named `crash-<UTC time>-<source>.log`, and keeps only the
 * most recent ten. This shell used to write `kernel-exit.log` and
 * `startup-error.log` straight into `userData`, both unbounded and with no
 * naming convention that lets a user tell one failure from the next.
 *
 * Reports are bounded for the same reason the log buffer is: a long-running
 * kernel produces enough output that an unbounded file becomes the problem it
 * was meant to diagnose.
 *
 * The naming and the retention rule are pure functions so they can be tested
 * without a filesystem; only {@link writeCrashReport} touches the disk.
 *
 * @module diagnostics
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from './config-file.js'

/**
 * Where a failure came from.
 *
 * - `host` — the kernel exited unexpectedly
 * - `web-boot` — the renderer failed to start
 * - `renderer` — the renderer or its document failed
 * - `main` — the shell itself failed
 *
 * @typedef {'host' | 'web-boot' | 'renderer' | 'main'} CrashSource
 */

/**
 * How many reports are kept. Older ones are deleted on the next write.
 *
 * @type {number}
 */
export const MAX_CRASH_REPORTS = 10

/**
 * The most characters of kernel output kept in one report.
 *
 * Matches the official shell's 64 KiB bound on Host stderr diagnostics: enough
 * to see the failure, small enough that a month of reports stays readable.
 *
 * @type {number}
 */
export const MAX_OUTPUT_CHARS = 65_536

/**
 * The log directory for the current platform.
 *
 * macOS uses the system log directory; Windows and Linux use `logs` under the
 * application's `userData`, which is what the official shell documents.
 *
 * @param {object} options
 * @param {string} options.userData - `app.getPath('userData')`
 * @param {string} [options.platform] - `process.platform`
 * @returns {string}
 */
export function crashLogDirectory({ userData, platform = process.platform }) {
  return platform === 'darwin' ? join(userData, 'Logs') : join(userData, 'logs')
}

/**
 * Builds the report filename.
 *
 * The timestamp is UTC and uses characters that are safe in a filename on
 * every platform this shell targets — no colons, which Windows rejects.
 *
 * @param {CrashSource} source
 * @param {Date} [when]
 * @returns {string}
 */
export function crashReportName(source, when = new Date()) {
  const stamp = when.toISOString().replace(/[:.]/g, '-')
  return `crash-${stamp}-${source}.log`
}

/**
 * Renders the report body.
 *
 * @param {object} options
 * @param {CrashSource} options.source
 * @param {string} options.appVersion
 * @param {string} [options.kernelVersion]
 * @param {boolean} [options.ready] - whether the kernel was serving
 * @param {string} [options.message] - the error text
 * @param {string} [options.output] - captured kernel output
 * @param {Date} [options.when]
 * @returns {string}
 */
export function renderCrashReport({
  source,
  appVersion,
  kernelVersion = 'unknown',
  ready = false,
  message = '',
  output = '',
  when = new Date(),
}) {
  const lines = [
    `time:     ${when.toISOString()}`,
    `source:   ${source}`,
    `app:      ${appVersion}`,
    `kernel:   ${kernelVersion}`,
    `ready:    ${String(ready)}`,
    '',
    'error:',
    truncate(message, MAX_OUTPUT_CHARS),
    '',
    'output:',
    truncate(output, MAX_OUTPUT_CHARS),
    '',
  ]
  return lines.join('\n')
}

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function truncate(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(text.length - limit)}\n[truncated: ${text.length - limit} earlier characters dropped]`
}

/**
 * The names to delete so that at most {@link MAX_CRASH_REPORTS} remain.
 *
 * @param {string[]} existing - report filenames, any order
 * @param {number} [keep]
 * @returns {string[]} the names to delete
 */
export function crashReportsToPrune(existing, keep = MAX_CRASH_REPORTS) {
  // Names embed a UTC timestamp that sorts lexicographically, so a plain sort
  // is a chronological sort — no parsing needed.
  const sorted = [...existing].sort()
  return sorted.slice(0, Math.max(0, sorted.length - keep))
}

/**
 * Writes a crash report and prunes older ones.
 *
 * A failure here must never mask the failure it is reporting, so every step is
 * best-effort: the path is returned only when the write actually succeeded.
 *
 * @param {object} options
 * @param {string} options.userData - `app.getPath('userData')`
 * @param {CrashSource} options.source
 * @param {string} options.appVersion
 * @param {string} [options.kernelVersion]
 * @param {boolean} [options.ready]
 * @param {string} [options.message]
 * @param {string} [options.output]
 * @returns {Promise<string | null>} the report path, or null when it could not be written
 */
export async function writeCrashReport({
  userData,
  source,
  appVersion,
  kernelVersion,
  ready,
  message,
  output,
}) {
  try {
    const directory = crashLogDirectory({ userData })
    // The reports name the user's home directory and carry whatever the kernel
    // last printed, so the directory and the files are owner-only. `wx` refuses
    // to overwrite: two failures in the same millisecond must not silently
    // clobber the first one's evidence.
    await mkdir(directory, { recursive: true, mode: 0o700 })

    const path = join(directory, crashReportName(source))
    await writeFile(path, renderCrashReport({ source, appVersion, kernelVersion, ready, message, output }), {
      mode: 0o600,
      flag: 'wx',
    })

    const existing = (await readdir(directory)).filter((name) => name.startsWith('crash-'))
    for (const name of crashReportsToPrune(existing)) {
      await rm(join(directory, name), { force: true }).catch(() => undefined)
    }
    return path
  } catch {
    return null
  }
}
