#!/usr/bin/env node
/**
 * `npm run doctor` — report the runtime dependencies, and optionally fetch
 * whatever is missing.
 *
 * Detection is read-only by default. With `--install`, anything absent is
 * downloaded into `~/.dsh-desktop/runtime` (China mirrors first) and the
 * resolved paths are written back into `config.json`, so the next launch needs
 * no detection at all.
 *
 * This script is the only place that spawns processes and touches the network;
 * the decisions live in `src/runtime-doctor.js` and `src/runtime-install.js`,
 * both of which are pure and unit-tested.
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { atomicWriteFile } from '../src/config-file.js'
import { installElectron, installNode, runtimeDir } from '../src/runtime-install.js'
import {
  MIN_ELECTRON_MAJOR,
  MIN_NODE_VERSION,
  WANTED_ELECTRON_VERSION,
  detectRuntime,
  formatReport,
  meetsMinimum,
  parseVersion,
} from '../src/runtime-doctor.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const configPath = join(repoRoot, 'config.json')

/**
 * Asks a binary for its version.
 *
 * A `dsh` installed from npm is a JS file with a shebang, so it is run through
 * `node` when it cannot be executed directly.
 *
 * `ELECTRON_RUN_AS_NODE` is removed from the environment for the probe: with it
 * set, Electron runs as plain Node and `--version` answers with the bundled
 * Node version (20.18.1 for Electron 33) rather than the Electron version, so
 * the doctor would report a perfectly good Electron as too old — or missing.
 *
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function versionOf(path) {
  /** @type {Array<[string, string[]]>} */
  const attempts = [
    [path, ['--version']],
    ['node', [path, '--version']],
  ]
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const [command, args] of attempts) {
    try {
      const { stdout } = await run(command, args, { timeout: 15_000, encoding: 'utf8', env })
      const text = String(stdout).trim()
      if (text !== '') return text
    } catch {
      // Try the next invocation shape.
    }
  }
  return null
}

/**
 * Runs detection with real processes, then re-evaluates usability against the
 * versions that were actually reported.
 *
 * @param {Record<string, string>} launcher
 * @returns {Promise<ReturnType<typeof detectRuntime>>}
 */
async function inspect(launcher) {
  // Versions are not known until asked for, so the synchronous detector is
  // handed a lookup that answers null and the real versions are filled in here.
  const report = detectRuntime({
    exists: existsSync,
    runVersion: () => null,
    pathValue: process.env.PATH ?? '',
    configured: launcher,
  })

  for (const entry of [report.electron, report.node, report.dsh]) {
    if (entry.path !== null) entry.version = await versionOf(entry.path)
  }

  report.electron.ok = meetsMinimum(parseVersion(report.electron.version), [MIN_ELECTRON_MAJOR, 0, 0])
  report.node.ok = meetsMinimum(parseVersion(report.node.version), MIN_NODE_VERSION)
  report.dsh.ok = report.dsh.path !== null
  report.missing = ['electron', 'node', 'dsh'].filter(
    (kind) => report[/** @type {'electron'|'node'|'dsh'} */ (kind)].ok === false,
  )
  // `detectRuntime` could not read versions (the probe runs here), so the
  // outdated verdict is recomputed from the versions it learned.
  report.electronOutdated =
    report.electron.ok && !meetsMinimum(parseVersion(report.electron.version), parseVersion(WANTED_ELECTRON_VERSION) ?? [0, 0, 0])

  return report
}

async function main() {
  const install = process.argv.includes('--install')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const launcher = config.launcher ?? {}

  const report = await inspect(launcher)
  console.log('运行时检测：')
  for (const line of formatReport(report)) console.log(`  ${line}`)
  console.log()

  if (report.missing.length === 0 && !report.electronOutdated) {
    console.log('全部就绪，无需下载。')
    return
  }

  if (report.missing.length === 0) {
    console.log(`Electron ${report.electron.version} 可用，但低于本壳验证过的 ${WANTED_ELECTRON_VERSION}。`)
  } else {
    console.log(`缺失：${report.missing.join('、')}`)
  }
  if (!install) {
    console.log()
    console.log('加 --install 自动下载并写回 config.json：')
    console.log('  npm run doctor -- --install')
    console.log()
    console.log('下载源（国内优先）：')
    console.log('  Node      https://npmmirror.com/mirrors/node')
    console.log('  Electron  https://npmmirror.com/mirrors/electron')
    console.log('  dsh       https://registry.npmmirror.com')
    process.exitCode = 1
    return
  }

  /** @type {Record<string, string>} */
  const updates = {}
  /** @param {string} message */
  const log = (message) => console.log(`  ${message}`)
  /**
   * @param {string} command
   * @param {string[]} args
   * @param {object} options
   * @returns {Promise<unknown>}
   */
  const exec = async (command, args, options) => run(command, args, options)

  if (!report.electron.ok || report.electronOutdated) {
    console.log(`下载 Electron 到 ${runtimeDir()} …`)
    updates.electron = await installElectron({ exec, log })
  }
  if (!report.node.ok) {
    console.log(`下载 Node 到 ${runtimeDir()} …`)
    updates.nodeBinDir = dirname(await installNode({ exec, log }))
  }
  if (!report.dsh.ok) {
    console.log('安装 dsh 内核（npm 全局，国内源）…')
    await run(
      'npm',
      ['install', '--global', '--registry', 'https://registry.npmmirror.com', '@deepseek-ai/dsh@latest'],
      { timeout: 900_000, maxBuffer: 32 * 1024 * 1024 },
    )
    log('dsh 已通过 npm 全局安装')
  }

  if (Object.keys(updates).length === 0) {
    console.log()
    console.log('没有需要写回 config.json 的路径。')
    return
  }

  copyFileSync(configPath, `${configPath}.bak-doctor`)
  const merged = { ...config, launcher: { ...launcher, ...updates } }
  await atomicWriteFile(configPath, `${JSON.stringify(merged, null, 2)}\n`)
  console.log()
  console.log('已写回 config.json（备份 config.json.bak-doctor）：')
  for (const [key, value] of Object.entries(updates)) console.log(`  launcher.${key} = ${value}`)
}

main().catch((error) => {
  console.error(`doctor 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
