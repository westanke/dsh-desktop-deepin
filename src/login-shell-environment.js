/**
 * Login-shell environment for a GUI launch on POSIX systems.
 *
 * A program started from a desktop environment inherits only what the session
 * manager hands it: on Linux and macOS that excludes everything exported by the
 * user's shell startup files — `PATH` entries added by `~/.bashrc`, the proxy
 * variables set for a specific network, the npm/pnpm mirrors, the language
 * selection. The kernel this shell supervises would then run with a different
 * environment than the user's terminal, which shows up as tools that exist in
 * the terminal but not in the app.
 *
 * One probe of the login shell fixes that: run it interactively so the startup
 * files execute, and read the environment it ends up with.
 *
 * The probe is defensive on every axis because it runs arbitrary rc files:
 * it must not be able to hang the shell's startup, and its output must be
 * attributable to us rather than to whatever the rc files happened to print.
 *
 * @module login-shell-environment
 */

import { spawn } from 'node:child_process'
import { homedir, userInfo } from 'node:os'

/**
 * Marks the boundary between the probe's own noise and the environment dump.
 * NUL-delimited so no byte of an environment value can imitate it.
 */
const DELIMITER = '_DSH_SHELL_ENV_DELIMITER_'
const MARKER = Buffer.from(`\0${DELIMITER}\0`)

/**
 * Prints the marker, the environment, then the marker again. `env -0` is
 * NUL-separated, which survives values containing spaces, quotes or newlines.
 */
const DUMP = `printf '\\0%s\\0' '${DELIMITER}'; command env -0 || exit; printf '\\0%s\\0' '${DELIMITER}'; exit`

/**
 * Tried in order after the account's own shell. POSIX guarantees at least one
 * of these exists, and they are read in interactive-login mode so the system
 * startup files run too.
 */
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh']

/**
 * Kept because they describe the probe process rather than the user's
 * configuration, and because a shell that sets them would make the resulting
 * environment wrong for everything the kernel spawns.
 */
const PROBE_ENVIRONMENT = {
  DISABLE_AUTO_UPDATE: 'true',
  ZSH_TMUX_AUTOSTARTED: 'true',
  ZSH_TMUX_AUTOSTART: 'false',
}

/**
 * Variables that describe the probe shell's own session, so they must not
 * reach the kernel: the kernel runs in a different directory and session.
 */
const SHELL_SESSION_KEYS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', ...Object.keys(PROBE_ENVIRONMENT)])

/**
 * Prefixes the launcher owns. The shell is read after the launcher resolved
 * paths such as `DSH_HOME`; a stale value from an rc file would undo that.
 */
const LAUNCHER_OWNED_PREFIXES = ['DSH_', 'ELECTRON_']

/** Why a candidate shell produced no environment. */
export const FAILURE = Object.freeze({
  timeout: 'timeout',
  aborted: 'aborted',
  unparsed: 'unparsed',
})

/**
 * @typedef {object} LoginShellFailure
 * @property {string} shell - the candidate that was tried
 * @property {string} reason - `exit <code>`, a signal name, a spawn error
 *   message, or one of {@link FAILURE}
 */

/**
 * @typedef {object} LoginShellResult
 * @property {NodeJS.ProcessEnv} environment - `base` merged with the first
 *   successful probe, or `base` itself when none succeeded
 * @property {LoginShellFailure[]} failures - candidates tried before the
 *   result, in order
 */

/**
 * Reads and validates the per-candidate deadline.
 *
 * The bound is clamped rather than trusted: a rc file that hangs would
 * otherwise hang the launch, and a value outside the range is a typo whose
 * intent is unknowable, so the default is the honest response.
 *
 * @param {NodeJS.ProcessEnv} env - this process's environment
 * @returns {number} milliseconds per candidate
 */
export function resolveLoginShellConfig(env) {
  const raw = env.DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS
  if (raw === undefined || raw === '') return 10_000
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1000 || value > 2_147_483_647) return 10_000
  return value
}

/**
 * Candidate shells in trial order: the account record's login shell — which is
 * not `$SHELL`, since that variable describes the invoking shell rather than
 * the account — followed by the fixed system shells.
 *
 * @returns {string[]} distinct absolute paths to try
 */
export function loginShellCandidates() {
  let account = null
  try {
    account = userInfo().shell
  } catch {
    // No account record for this uid: the fixed candidates are all we have.
  }
  const ordered = account === null || account === '' ? [] : [account]
  return [...new Set([...ordered, ...FALLBACK_SHELLS])]
}

/**
 * Extracts the environment printed between the two delimiters.
 *
 * @param {string} stdout - the probe's output, including anything rc files
 *   printed around the dump
 * @returns {Record<string, string> | undefined} the variables, or undefined
 *   when both delimiters are absent
 */
export function parseLoginShellOutput(stdout) {
  const parts = stdout.split('\0')
  const first = parts.indexOf(DELIMITER)
  const last = parts.lastIndexOf(DELIMITER)
  if (first === -1 || first === last) return undefined
  /** @type {Record<string, string>} */
  const variables = {}
  for (const entry of parts.slice(first + 1, last)) {
    const separator = entry.indexOf('=')
    if (separator > 0) variables[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return variables
}

/**
 * Overlays the probe's variables on the inherited environment.
 *
 * The shell's values win, since they are the ones the user's terminal has,
 * except for the session variables above and the launcher-owned prefixes.
 *
 * @param {NodeJS.ProcessEnv} base - the environment the shell inherited
 * @param {Record<string, string>} shell - what the login shell printed
 * @returns {NodeJS.ProcessEnv} a new object; neither argument is modified
 */
export function mergeLoginShellEnvironment(base, shell) {
  /** @type {NodeJS.ProcessEnv} */
  const merged = { ...base }
  for (const [key, value] of Object.entries(shell)) {
    if (SHELL_SESSION_KEYS.has(key)) continue
    if (LAUNCHER_OWNED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    merged[key] = value
  }
  return merged
}

/**
 * Runs one candidate and resolves with its environment or a failure reason.
 *
 * @param {string} shell - candidate path
 * @param {NodeJS.ProcessEnv} base - environment to probe under
 * @param {number} timeoutMs - deadline for this candidate
 * @param {AbortSignal} [signal] - aborting kills the process group
 * @returns {Promise<Record<string, string> | string>} the variables, or the reason
 */
function readShell(shell, base, timeoutMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(FAILURE.aborted)
      return
    }
    /** @type {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, null>} */
    let child
    try {
      // `-i` runs the interactive startup files and `-l` the login ones;
      // without either, `~/.bashrc` / `~/.zprofile` never execute and there is
      // nothing to read. stdin is closed so a prompt in an rc file sees EOF
      // instead of waiting for input that will never come.
      child = spawn(shell, ['-ilc', DUMP], {
        cwd: homedir(),
        env: { ...base, ...PROBE_ENVIRONMENT },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      })
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error))
      return
    }
    /** @type {Buffer[]} */
    const chunks = []
    let tail = Buffer.alloc(0)
    let markers = 0
    const output = () => parseLoginShellOutput(Buffer.concat(chunks).toString('utf8')) ?? FAILURE.unparsed
    const onData = (/** @type {Buffer} */ chunk) => {
      chunks.push(chunk)
      const window = Buffer.concat([tail, chunk])
      for (let at = window.indexOf(MARKER); at !== -1; at = window.indexOf(MARKER, at + MARKER.length)) {
        markers += 1
      }
      tail = window.subarray(Math.max(0, window.length - MARKER.length + 1))
      // Background jobs started by rc files inherit stdout and can hold it open
      // long after the shell itself exits, so the read completes at the closing
      // delimiter rather than at `close`.
      if (markers >= 2) finish(output())
    }
    const killGroup = () => {
      // A spawn failure settles through the error listener before any timer can
      // run, so the pid is present here.
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group already exited.
      }
    }
    const stop = (/** @type {string} */ reason) => {
      finish(reason)
      killGroup()
    }
    const onAbort = () => {
      stop(FAILURE.aborted)
    }
    const timer = setTimeout(() => {
      stop(FAILURE.timeout)
    }, timeoutMs)
    function finish(/** @type {Record<string, string> | string} */ result) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // Keep draining so rc-started children writing to stdout do not die of
      // EPIPE when we stop listening.
      child.stdout.off('data', onData)
      child.stdout.resume()
      resolve(result)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', onData)
    child.on('error', (error) => {
      finish(error.message)
    })
    child.on('close', (code, closeSignal) => {
      if (code !== 0) {
        finish(closeSignal ?? `exit ${String(code)}`)
        return
      }
      finish(output())
    })
  })
}

/**
 * Reads the user's login-shell environment once per launch.
 *
 * Windows GUI launches already inherit the registry environment, so there is
 * nothing to read and `base` is returned unchanged. Never rejects: a failing
 * candidate is recorded and the next tried, and `base` is returned when all
 * fail. Startup must not depend on a probe succeeding.
 *
 * @param {NodeJS.ProcessEnv} base - the environment this process inherited
 * @param {number} timeoutMs - per-candidate deadline, from {@link resolveLoginShellConfig}
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] - defaults to `process.platform`
 * @param {string[]} [options.shells] - defaults to {@link loginShellCandidates}
 * @param {AbortSignal} [options.signal] - aborting kills the running group
 * @returns {Promise<LoginShellResult>}
 */
export async function readLoginShellEnvironment(base, timeoutMs, options = {}) {
  const { platform = process.platform, shells = loginShellCandidates(), signal } = options
  if (platform === 'win32') return { environment: base, failures: [] }
  /** @type {LoginShellFailure[]} */
  const failures = []
  for (const shell of shells) {
    const result = await readShell(shell, base, timeoutMs, signal)
    if (typeof result !== 'string') {
      return { environment: mergeLoginShellEnvironment(base, result), failures }
    }
    failures.push({ shell, reason: result })
    if (result === FAILURE.aborted) break
  }
  return { environment: base, failures }
}