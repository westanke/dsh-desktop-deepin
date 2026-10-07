/**
 * @module login-shell-environment
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  FAILURE,
  loginShellCandidates,
  mergeLoginShellEnvironment,
  parseLoginShellOutput,
  readLoginShellEnvironment,
  resolveLoginShellConfig,
} from './login-shell-environment.js'

const DELIMITER = '_DSH_SHELL_ENV_DELIMITER_'

/**
 * @param {string[]} entries - `NAME=value` strings, NUL-joined as `env -0` prints them
 * @returns {string} the probe's stdout with both delimiters in place
 */
function dump(entries) {
  return `\0${DELIMITER}\0${entries.join('\0')}\0${DELIMITER}\0`
}

describe('parseLoginShellOutput', () => {
  it('reads the variables between the two delimiters', () => {
    const parsed = parseLoginShellOutput(dump(['PATH=/usr/bin:/bin', 'LANG=zh_CN.UTF-8']))
    assert.deepEqual(parsed, { PATH: '/usr/bin:/bin', LANG: 'zh_CN.UTF-8' })
  })

  it('keeps a value that contains spaces, quotes or newlines', () => {
    // `env -0` exists precisely because values may contain separators.
    const parsed = parseLoginShellOutput(dump(['OPTS=a b "c" \n d=not-a-pair']))
    assert.equal(parsed?.OPTS, 'a b "c" \n d=not-a-pair')
  })

  it('ignores noise the startup files printed around the dump', () => {
    const parsed = parseLoginShellOutput(`oh-my-zsh banner\n${dump(['A=1'])}\nbye\n`)
    assert.deepEqual(parsed, { A: '1' })
  })

  it('rejects output that does not carry both delimiters', () => {
    assert.equal(parseLoginShellOutput('nothing here'), undefined)
    assert.equal(parseLoginShellOutput(`\0${DELIMITER}\0PATH=/bin`), undefined)
    assert.equal(parseLoginShellOutput(''), undefined)
  })

  it('drops entries with no name', () => {
    // A line like `=value` is not a variable; keeping it would put an empty
    // name into the environment.
    const parsed = parseLoginShellOutput(dump(['GOOD=1', '=2', 'ALSO=3']))
    assert.deepEqual(Object.keys(parsed ?? {}), ['GOOD', 'ALSO'])
  })
})

describe('mergeLoginShellEnvironment', () => {
  it('lets the shell override what the session manager provided', () => {
    const merged = mergeLoginShellEnvironment({ PATH: '/usr/bin' }, { PATH: '/opt/bin:/usr/bin' })
    assert.equal(merged.PATH, '/opt/bin:/usr/bin')
  })

  it('keeps the probe session variables and the launcher-owned ones', () => {
    // The probe ran in the home directory and its own session; those describe
    // the probe, not the kernel. `DSH_*` and `ELECTRON_*` were already resolved
    // by this launcher, and a stale value from an rc file would undo that.
    const merged = mergeLoginShellEnvironment(
      { DSH_HOME: '/resolved/home', ELECTRON_USER_DATA: '/resolved/data' },
      {
        PWD: '/home/user',
        OLDPWD: '/',
        SHLVL: '3',
        _: '/usr/bin/env',
        DISABLE_AUTO_UPDATE: 'true',
        ZSH_TMUX_AUTOSTARTED: 'true',
        ZSH_TMUX_AUTOSTART: 'false',
        DSH_HOME: '/stale/from/rc',
        ELECTRON_RUN_AS_NODE: '1',
        PATH: '/opt/bin',
        LANG: 'zh_CN.UTF-8',
      },
    )
    assert.equal(merged.PWD, undefined)
    assert.equal(merged.OLDPWD, undefined)
    assert.equal(merged.SHLVL, undefined)
    assert.equal(merged._, undefined)
    assert.equal(merged.DISABLE_AUTO_UPDATE, undefined)
    assert.equal(merged.DSH_HOME, '/resolved/home')
    assert.equal(merged.ELECTRON_USER_DATA, '/resolved/data')
    assert.equal(merged.ELECTRON_RUN_AS_NODE, undefined)
    // Every other variable the startup files export is the point of the read.
    assert.equal(merged.LANG, 'zh_CN.UTF-8')
    assert.equal(merged.PATH, '/opt/bin')
  })

  it('modifies neither argument', () => {
    const base = { PATH: '/usr/bin' }
    const shell = { PATH: '/opt/bin' }
    mergeLoginShellEnvironment(base, shell)
    assert.deepEqual(base, { PATH: '/usr/bin' })
    assert.deepEqual(shell, { PATH: '/opt/bin' })
  })
})

describe('resolveLoginShellConfig', () => {
  it('defaults to ten seconds', () => {
    assert.equal(resolveLoginShellConfig({}), 10_000)
  })

  it('accepts a bound inside the safe range', () => {
    assert.equal(resolveLoginShellConfig({ DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS: '2500' }), 2500)
    assert.equal(resolveLoginShellConfig({ DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS: '60000' }), 60_000)
  })

  it('falls back rather than trusting a value outside the range', () => {
    // A rc file that hangs must not be able to stall startup, and a value that
    // cannot be honoured as written is a typo whose intent is unknowable.
    for (const raw of ['0', '-1', '999', '2147483648', 'abc', '1.5', '']) {
      assert.equal(
        resolveLoginShellConfig({ DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS: raw }),
        10_000,
        `${raw} must not be honoured`,
      )
    }
  })
})

describe('loginShellCandidates', () => {
  it('always offers the fixed shells and never repeats one', () => {
    const candidates = loginShellCandidates()
    assert.deepEqual(candidates, [...new Set(candidates)])
    for (const fallback of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
      assert.ok(candidates.includes(fallback), `${fallback} must be offered`)
    }
  })
})

describe('readLoginShellEnvironment', () => {
  it('returns the inherited environment untouched on Windows', async () => {
    // A Windows GUI launch already inherits the registry environment, so there
    // is nothing to read — and probing would only cost startup time.
    const base = { PATH: 'C:\\Windows' }
    const result = await readLoginShellEnvironment(base, 10_000, {
      platform: 'win32',
      shells: ['/bin/sh'],
    })
    assert.equal(result.environment, base)
    assert.deepEqual(result.failures, [])
  })

  it('records each failing candidate and keeps the inherited environment', async () => {
    const base = { PATH: '/usr/bin' }
    const result = await readLoginShellEnvironment(base, 10_000, {
      platform: 'linux',
      // Neither path exists in any sane installation; the read must fall
      // through rather than reject, because startup may not depend on it.
      shells: ['/nonexistent/shell-a', '/nonexistent/shell-b'],
    })
    assert.equal(result.environment, base)
    assert.equal(result.failures.length, 2)
    assert.deepEqual(result.failures.map((failure) => failure.shell), [
      '/nonexistent/shell-a',
      '/nonexistent/shell-b',
    ])
    for (const failure of result.failures) {
      assert.equal(typeof failure.reason, 'string')
      assert.ok(failure.reason.length > 0, 'a failure must say why')
    }
  })

  it('stops trying candidates once aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await readLoginShellEnvironment({ PATH: '/usr/bin' }, 10_000, {
      platform: 'linux',
      shells: ['/bin/sh', '/bin/bash', '/bin/zsh'],
      signal: controller.signal,
    })
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0]?.reason, FAILURE.aborted)
  })
})