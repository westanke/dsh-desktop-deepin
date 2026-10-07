/**
 * @module cli-command
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readlink, rm, symlink, writeFile, chmod, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  COMMAND_NAME,
  REFUSAL,
  commandDirectory,
  describeCommand,
  fingerprintLink,
  fingerprintMatches,
  installCommand,
  readReceipt,
  resolvesInside,
  uninstallCommand,
} from './cli-command.js'

/** @type {string} */
let workspace = ''
/** @type {string} */
let binDir = ''
/** @type {string} */
let target = ''

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-cli-command-'))
  binDir = join(workspace, 'bin')
  target = join(workspace, 'dsh-runtime')
  await writeFile(target, '#!/bin/sh\nexit 0\n', 'utf8')
  await chmod(target, 0o755)
})

after(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('commandDirectory', () => {
  it('publishes into the user-owned bin directory', () => {
    // Not a system path: no privilege is needed and nothing outside the home
    // directory is ever touched.
    assert.equal(commandDirectory({ home: '/home/u' }), '/home/u/.local/bin')
  })
})

describe('installCommand', () => {
  it('publishes a link and records a receipt', async () => {
    const dir = join(workspace, 'install-1')
    const result = await installCommand({ target, directory: dir })
    assert.equal(result.ok, true)

    const link = join(dir, COMMAND_NAME)
    const fingerprint = await fingerprintLink(link)
    assert.ok(fingerprint !== null, 'the command must be a symlink')
    assert.equal(fingerprint.target, target)

    const receipt = await readReceipt(dir)
    assert.equal(receipt?.link, link)
    assert.equal(receipt?.target, target)
    assert.ok(receipt?.installedAt !== undefined, 'the receipt records when it happened')
  })

  it('refuses an entry it did not install', async () => {
    const dir = join(workspace, 'foreign')
    await writeFile(join(dir, COMMAND_NAME), '#!/bin/sh\n', { flag: 'w' }).catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, COMMAND_NAME), '#!/bin/sh\n')
    })
    const result = await installCommand({ target, directory: dir })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.code : '', REFUSAL.ownership)
    // The user's own command must survive untouched.
    assert.equal((await lstat(join(dir, COMMAND_NAME))).isFile(), true)
  })

  it('refuses a foreign symlink as firmly as a foreign file', async () => {
    const dir = join(workspace, 'foreign-link')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await symlink('/usr/bin/other-dsh', join(dir, COMMAND_NAME))
    const result = await installCommand({ target, directory: dir })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.code : '', REFUSAL.ownership)
    // `readlink`, not `readFile`: the latter would report the target's contents.
    assert.equal(await readlink(join(dir, COMMAND_NAME)), '/usr/bin/other-dsh')
  })

  it('replaces its own link when reinstalling', async () => {
    const dir = join(workspace, 'reinstall')
    const first = join(workspace, 'first-target')
    await writeFile(first, '#!/bin/sh\n')
    assert.equal((await installCommand({ target: first, directory: dir })).ok, true)
    // Same receipt, new target: the link was ours and unchanged, so this is a
    // legitimate update rather than a takeover.
    assert.equal((await installCommand({ target, directory: dir })).ok, true)
    const fingerprint = await fingerprintLink(join(dir, COMMAND_NAME))
    assert.equal(fingerprint?.target, target)
  })
})

describe('uninstallCommand', () => {
  it('removes a link it installed and clears the receipt', async () => {
    const dir = join(workspace, 'uninstall-1')
    assert.equal((await installCommand({ target, directory: dir })).ok, true)
    const result = await uninstallCommand({ directory: dir })
    assert.equal(result.ok, true)
    assert.equal(await fingerprintLink(join(dir, COMMAND_NAME)), null)
    assert.equal(await readReceipt(dir), null)
  })

  it('reports nothing installed when there is no receipt', async () => {
    const result = await uninstallCommand({ directory: join(workspace, 'never-installed') })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.code : '', REFUSAL.notInstalled)
  })

  it('refuses to delete a link that changed since install', async () => {
    const dir = join(workspace, 'changed-after-install')
    assert.equal((await installCommand({ target, directory: dir })).ok, true)
    // Someone repointed the link at their own dsh. That is their decision to
    // make, not ours to undo by deleting it.
    await rm(join(dir, COMMAND_NAME))
    await symlink('/usr/bin/theirs', join(dir, COMMAND_NAME))
    const result = await uninstallCommand({ directory: dir })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.code : '', REFUSAL.stale)
    assert.equal(await readlink(join(dir, COMMAND_NAME)), '/usr/bin/theirs')
  })

  it('is idempotent when the link is already gone', async () => {
    const dir = join(workspace, 'already-gone')
    assert.equal((await installCommand({ target, directory: dir })).ok, true)
    await rm(join(dir, COMMAND_NAME))
    const result = await uninstallCommand({ directory: dir })
    assert.equal(result.ok, true, 'an absent link means removed, not failed')
    assert.equal(await readReceipt(dir), null)
  })
})

describe('describeCommand', () => {
  it('tells the three states apart', async () => {
    const absent = await describeCommand({ directory: join(workspace, 'd-absent') })
    assert.equal(absent.state, 'absent')

    const ours = join(workspace, 'd-ours')
    await installCommand({ target, directory: ours })
    assert.equal((await describeCommand({ directory: ours })).state, 'ours')

    const foreign = join(workspace, 'd-foreign')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, COMMAND_NAME), 'x')
    assert.equal((await describeCommand({ directory: foreign })).state, 'foreign')
  })
})

describe('fingerprintMatches', () => {
  it('distinguishes a same-inode link with a different target', async () => {
    const dir = join(workspace, 'fingerprints')
    assert.equal((await installCommand({ target, directory: dir })).ok, true)
    const link = join(dir, COMMAND_NAME)
    const before = await fingerprintLink(link)
    assert.ok(before !== null)

    await rm(link)
    await symlink('/somewhere/else', link)
    const after = await fingerprintLink(link)

    assert.equal(fingerprintMatches(before, after), false, 'a repointed link must not match')
    assert.equal(fingerprintMatches(before, null), false, 'an absent link must not match')
    assert.equal(fingerprintMatches(null, before), false)
    assert.equal(fingerprintMatches(before, before), true)
  })
})

describe('resolvesInside', () => {
  it('accepts a path that resolves within the directory', async () => {
    const dir = join(workspace, 'inside')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'nested'), { recursive: true })
    assert.equal(await resolvesInside(dir, join(dir, 'nested')), true)
  })

  it('rejects a path that escapes it', async () => {
    const dir = join(workspace, 'escape')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    assert.equal(await resolvesInside(dir, workspace), false)
  })

  it('reports a path that does not exist', async () => {
    assert.equal(await resolvesInside(workspace, join(workspace, 'never-made')), false)
  })
})