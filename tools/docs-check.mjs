#!/usr/bin/env node
/**
 * `npm run docs:check` — 根 README / CHANGELOG 与仓库真相源的一致性门禁。
 *
 * 这个仓库此前**没有任何文档门禁**，于是「改了内核锁没改文档」「发了版忘写
 * CHANGELOG」「README 里留着 `TODO` 占位」都能静悄悄地进主干。本脚本把三类
 * 最容易腐化的口径钉住：
 *
 *   1. **bundled 内核版本**：`upstream.lock.json` 的 `kernel.version` 是唯一真相源，
 *      README「内核版本口径」里的 bundled 行必须与它逐字相同。锁与文档各存一份，
 *      任何一份单方面改动都会让读者按错的版本去排查问题；
 *   2. **CHANGELOG 条目**：必须有 `## [Unreleased]` 节，或有与 `package.json`
 *      `version` 匹配的条目 —— 发版忘写 changelog 是最高频的漏项；
 *   3. **占位符**：`OWNER` / `TODO` / `xxxx` 之类没填完的东西不许留在对外文档里。
 *
 * 纪律（沿袭 dsh-remote-bridge `scripts/check-project-docs.ts` 的做法，语言不同）：
 *   - 所有问题先攒进 `failures`，最后统一打印，`exit code = 1`；
 *   - 每条**解析类**检查都有下限断言：一条都没匹配到就报「格式可能变了」。
 *     正则悄悄失效时，唯一安全的默认是变红，而不是「没匹配到 = 没问题」。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 仓库根。本脚本在 `tools/` 下，退一级即是。
 *
 * 刻意不用 `process.cwd()`：那样从子目录里 `node tools/docs-check.mjs` 会读到
 * 别的 package.json。`import.meta.dirname` 自 Node 20.11 起可用，而 package.json
 * 的 `engines` 已要求 `node >= 22.15.0`；留一个 cwd 兜底只为防御性。
 */
const here = import.meta.dirname ?? process.cwd()
const repoRoot = import.meta.dirname ? join(here, '..') : process.cwd()

/** @type {string[]} */
const failures = []

/**
 * 读一个仓库内的文本文件。缺失或读不动时记一条 failure 并返回 `null`。
 *
 * 返回 `null` 而不是 `''` 是刻意的：调用方拿到 `null` 会跳过后续解析，而
 * `''` 会把「文件不存在」混同「内容为空」——后者该由下限断言来报警。
 *
 * @param {string} relativePath
 * @returns {string | null}
 */
function readText(relativePath) {
  const path = join(repoRoot, relativePath)
  if (!existsSync(path)) {
    failures.push(`缺少 ${relativePath}（仓库根必须同时有 README.md 与 CHANGELOG.md）`)
    return null
  }
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    failures.push(`${relativePath} 读取失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 解析 `x.y.z[-prerelease]`，解析不了返回 null。
 *
 * @param {string} text
 * @returns {{ major: number, minor: number, patch: number, pre: string | null } | null}
 */
function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(text.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? null,
  }
}

/**
 * semver 比较：-1 / 0 / 1。
 *
 * 手写而不引第三方包（本脚本的依赖边界就是 node:fs / node:path）。预发布版按
 * semver 规则小于正式版，所以 `0.2.0-rc.2 < 0.2.0`。
 *
 * @param {string} left
 * @param {string} right
 * @returns {number | null} 任一侧解析不了时返回 null（调用方另行报错）
 */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return null

  for (const [x, y] of [[a.major, b.major], [a.minor, b.minor], [a.patch, b.patch]]) {
    if (x !== y) return x < y ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1

  // 预发布标识逐段比：纯数字段按数值比，数字段小于字母段（semver §11.4）。
  const as = a.pre.split('.')
  const bs = b.pre.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x) ? Number(x) : null
    const yn = /^\d+$/.test(y) ? Number(y) : null
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn < yn ? -1 : 1
      continue
    }
    if (xn !== null) return -1
    if (yn !== null) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 取出 README 的「内核版本口径」小节正文。
 *
 * 不写死小节编号：它在「环境要求」下面，层级和位置都可能随文档演进而变；
 * 只按标题文字定位，找不动就由下限断言报「格式可能变了」。
 *
 * @param {string} readme
 * @returns {string | null}
 */
function kernelPolicySection(readme) {
  const match = /内核版本口径[^\n]*\n([\s\S]*?)(?=\n#{2,3}\s|\n---)/.exec(readme)
  return match ? match[1] : null
}

/**
 * 在小节里取 bundled 那一行，返回 `{ row, version }`。
 *
 * 只认**第一列含 bundled 字样**的表格行，且取该行第二列（内核版本列）里第一个
 * `x.y.z` 版本号。之所以要精确到「bundled 行」：同一节里 system 行也写着
 * `0.2.1-rc.2`，整节搜第一个版本号会随行序漂移而张冠李戴。
 *
 * @param {string} section
 * @returns {{ row: string | null, version: string | null }}
 */
function bundledRow(section) {
  const match = /^\|([^|\n]*bundled[^|\n]*)\|([^|\n]*)\|/m.exec(section)
  if (!match) return { row: null, version: null }
  const versionCell = match[2]
  const version = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(versionCell)
  return { row: versionCell, version: version ? version[1] : null }
}

function main() {
  const readme = readText('README.md')
  const changelog = readText('CHANGELOG.md')

  // ---- package.json：version 是 CHANGELOG 条目的比对基准 -------------------
  /** @type {string | null} */
  let packageVersion = null
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    packageVersion = typeof pkg.version === 'string' ? pkg.version : null
  } catch (error) {
    failures.push(`package.json 读取或解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (packageVersion === null && !failures.some((f) => f.startsWith('package.json'))) {
    failures.push('package.json 缺少 version 字段')
  }

  // ---- upstream.lock.json：kernel.version 是 bundled 内核的唯一真相源 --------
  /** @type {string | null} */
  let lockedVersion = null
  try {
    const lock = JSON.parse(readFileSync(join(repoRoot, 'upstream.lock.json'), 'utf8'))
    lockedVersion = typeof lock?.kernel?.version === 'string' ? lock.kernel.version : null
  } catch (error) {
    failures.push(`upstream.lock.json 读取或解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (lockedVersion === null && !failures.some((f) => f.startsWith('upstream.lock.json'))) {
    failures.push('upstream.lock.json 缺少 kernel.version（bundled 内核的唯一真相源）')
  }

  // ---- 检查 1/2/4：README 内核版本口径 ↔ 内核锁 ----------------------------
  // 为什么存在：upstream.lock.json 的 $comment 自己就写着「不要在任何地方重复这些值，
  // 第二份拷贝在有人只改其中一份之前一直是自洽的」。README 是给人看的第二份，
  // 只能靠门禁保证它与锁同步，否则改锁不改文档会让读者按错的版本排查启动失败。
  if (readme !== null && lockedVersion !== null) {
    const section = kernelPolicySection(readme)
    if (section === null) {
      failures.push('README 里找不到「内核版本口径」小节（预期 ≥ 1），格式可能变了')
    } else {
      const { row, version } = bundledRow(section)
      if (row === null) {
        failures.push('「内核版本口径」小节里找不到 bundled 行（预期 ≥ 1），表格格式可能变了')
      } else {
        if (version === null) {
          failures.push('bundled 行里解析不到 x.y.z 形式的版本号，写法可能变了')
        } else if (version !== lockedVersion) {
          failures.push(
            `README 的 bundled 内核版本是 ${version}，与 upstream.lock.json 的 kernel.version（${lockedVersion}）不一致 —— 改锁就要改文档，改文档就要改锁`,
          )
        }
        // bundled 行必须把读者指回唯一真相源，否则下一回照样会去改 README 而忘了锁。
        if (!row.includes('upstream.lock.json')) {
          failures.push('bundled 行没有提到 upstream.lock.json —— 该行应标明内核版本以锁文件为唯一真相源')
        }
      }
    }

    // 最低支持版本声明：0.2.1-rc.2 适配结论的落点，缺了它读者无从判断
    // 「我这个内核版本到底能不能用」。这里只查**存在且带具体版本号**，不查它
    // 与 bundled 锁相等——system 模式不限版本，bundled 升级后最低支持可以合理
    // 地留在旧版；但绝不允许高于 bundled 锁。
    const minSupport = /最低支持[^\n]{0,24}?(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(readme)
    if (minSupport === null) {
      failures.push('README 里找不到「最低支持 DSH x.y.z」声明（预期 ≥ 1），格式可能变了')
    } else {
      const declared = minSupport[1]
      const order = compareVersions(declared, lockedVersion)
      if (order === null) {
        failures.push(`README 声明的最低支持版本 ${declared} 不是 x.y.z 形式`)
      } else if (order > 0) {
        failures.push(
          `README 声明最低支持 DSH ${declared}，高于 bundled 锁 ${lockedVersion} —— bundled 都跑不起来的版本不可能被支持，口径矛盾`,
        )
      }
    }
  }

  // ---- 检查 3：CHANGELOG 版本条目 ----------------------------------------
  // 为什么存在：发版时改 package.json version 却忘了写 changelog，是这个仓库
  // 已经发生过的事故模式；`## [Unreleased]` 则是 Keep a Changelog 的规矩。
  if (changelog !== null) {
    const entries = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)]
    if (entries.length === 0) {
      failures.push('CHANGELOG.md 解析不到任何 `## [x]` 版本条目（预期 ≥ 1），格式可能变了')
    } else {
      const hasUnreleased = entries.some((m) => m[1] === 'Unreleased')
      const hasVersionEntry =
        packageVersion !== null &&
        new RegExp(`^## \\[${escapeRegExp(packageVersion)}\\](?!\\d)`, 'm').test(changelog)
      if (!hasUnreleased && !hasVersionEntry) {
        failures.push(
          `CHANGELOG.md 既没有 ## [Unreleased] 节，也没有与 package.json version（${packageVersion ?? '缺失'}）匹配的条目`,
        )
      }
    }
  }

  // ---- 检查 5：未解析占位符 ----------------------------------------------
  // 为什么存在：对外文档里留着 `TODO` / `github.com/OWNER/` / `lorem`，读者会当成
  // 待办或者真实地址。OWNER / TODO / FIXME / TBD 只在**全大写**时报，免得把正常
  // 英文句子里的 owner / todo 误伤；lorem 这类本来就是小写占位，大小写都查。
  //
  // `xxxx` 只查**四连及以上**：README 里 `./xxx.deb`、日志示例里的 `bundle "xxx"`、
  // 「与 xxx 同路径」都是**刻意的示例占位**，三连是约定俗成的写法，四连才像
  // 「还没想好填什么」。这条界线写在这里，免得后来者误以为是漏检。
  const placeholderRules = [
    [/github\.com\/OWNER\//i, '未解析的 GitHub owner 占位符（github.com/OWNER/）'],
    [/\bOWNER\b/, '未解析的占位符 OWNER'],
    [/<TODO>|\bTODO\b/, '未解决的 TODO 占位符'],
    [/\bFIXME\b/, '未解决的 FIXME 占位符'],
    [/\bTBD\b/, '未解决的 TBD 占位符'],
    [/x{4,}/i, '未填写的 xxxx 占位符'],
    [/\blorem\b/i, 'lorem ipsum 占位正文'],
  ]
  for (const [name, text] of [
    ['README.md', readme],
    ['CHANGELOG.md', changelog],
  ]) {
    if (text === null) continue
    for (const [pattern, label] of placeholderRules) {
      if (pattern.test(text)) failures.push(`${name} 含有${label}`)
    }
  }

  // ---- 统一出口：先攒够再报，exit code 1 ---------------------------------
  if (failures.length > 0) {
    console.error('docs:check 未通过：')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
    return
  }

  console.log('docs:check: README, CHANGELOG and kernel-version lock are consistent')
}

try {
  await main()
} catch (error) {
  console.error(`docs:check 执行异常：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
