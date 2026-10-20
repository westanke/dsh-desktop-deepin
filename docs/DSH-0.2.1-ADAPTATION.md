# dsh-desktop-deepin 对 DSH 0.2.1-rc.2 的适配差距清单

> 调研人：desktop-deepin-scout（Team Lead 调研员）
> 调研对象：`/media/wangke/OFFICE/harness/DeepSeek-Harness-Desktop-dev-deepin-linux2`（壳版本 **0.2.19**）
> 目标内核：**@deepseek-ai/dsh 0.2.1-rc.2**（本地已装于 `/usr/local/nodejs/lib/node_modules/@deepseek-ai/dsh/`）
> 对比基线：**@deepseek-ai/dsh 0.2.0-rc.2**（本仓 `upstream.lock.json` 当前锁定版本）
> 文档性质：纯调研，不改任何源码、不提交、不打包。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 当前锁定的 DSH 内核版本是多少？ | **0.2.0-rc.2**（`upstream.lock.json:5`，sha512 校验于 `:6`）。壳的 `package.json` **完全没有声明任何 `@deepseek-ai/*` 依赖**，内核是离线 payload，装在 `resources/kernel/`（该目录 `package-lock.json:495` 记录 `0.2.0-rc.2`） |
| 升级到 0.2.1-rc.2 的破坏性风险有多大？ | **低，但有 3 处必须验证**：①`dsh web:` 行现在是 `authenticatedUrl()` 产物，正则仍匹配但语义变了；②10 个新包 + 6 个包被移除，`node-pty`/peer 补齐逻辑要重跑；③`dshmarket` 锁 1.20.0 远落后于实际可用的 1.66.x，新内核自带 plugin-manager / plugin-market bundle，装旧版插件有被新机制替换的风险 |
| 能否声明「最低支持 DSH 0.2.0」？ | **能，且建议改为「最低 0.2.0-rc.2，推荐 0.2.1-rc.2」**。依据见 §7：CLI 接口（`--profile web` / `--patch` / `plugin add`）两版一致，`__DSH_TRANSPORT__` 与 `remoteStreamUrl()` 传输链路两版一致，鉴权链路（token→303→cookie）两版一致。真正需要 0.2.1 的只有新功能，没有破坏壳启动的硬门槛 |
| 双通道（第4层）在 0.2.1 下会不会塌？ | **不会塌**。核心依赖 `__DSH_TRANSPORT__.streamBaseUrl` 与 `remotestreamUrl()` 在 0.2.1 的 `dsh-api-gateway` 中逐字保留，连注释都一样 |

---

## 1. 依赖锁版本核查

### 1.1 壳自身 `package.json`：没有内核依赖

`package.json:40-44` 的依赖只有 devDependencies：

```json
"devDependencies": {
  "@types/node": "^24.10.1",
  "electron": "^43.4.0",
  "typescript": "^5.9.3"
}
```

**没有任何 `@deepseek-ai/*` 运行时依赖。** 这不是疏忽，是设计：内核走"离线 payload"路线，由 `tools/install-kernel.js` 单独装进 `resources/kernel/`，`package-lock.json` 只描述壳自己（286 个包，全是 Electron/TS 工具链）。

**这带来一个直接后果**：壳仓库根的 `package-lock.json` 与内核版本完全脱钩，内核升级的唯一真相源是 `upstream.lock.json`。

### 1.2 `package-lock.json`（壳仓库根）

- lockfileVersion 3，共 286 个包条目。
- `grep -in 'deepseek'` 只有 2 处命中，都是壳自己的 `"name": "deepseek-harness-deepin"`（`package-lock.json:2`、`:8`）。
- **没有任何 `@deepseek-ai/dsh` 条目。**

### 1.3 `upstream.lock.json`：真正的内核锁

`upstream.lock.json:3-8`：

```json
"kernel": {
  "name": "@deepseek-ai/dsh",
  "version": "0.2.0-rc.2",
  "integrity": "sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==",
  "bin": "node_modules/@deepseek-ai/dsh/lib/bin.js"
}
```

同时锁了两样跟版本强相关的东西：

- `upstream.lock.json:11` — 私有 Node Runtime **v22.22.0**（四平台 sha256）。
- `upstream.lock.json:31-35` — 随包插件 **dshmarket 1.20.0**（带 sha512）。

### 1.4 `resources/kernel/` 实际装的也是 0.2.0-rc.2

`resources/kernel/package-lock.json:11` 的占位 manifest 声明 `"@deepseek-ai/dsh": "^0.2.0-rc.2"`，`:495-496` 记录解析结果 `0.2.0-rc.2`，`@deepseek-ai/dsh-api-gateway` 也停在 `0.2.0-rc.2`。全树 272 个 `@deepseek-ai/` 条目全是 0.2.0-rc.2。

### 1.5 与本地已装内核的版本落差

本地 `/usr/local/nodejs/lib/node_modules/@deepseek-ai/dsh` 是 **0.2.1-rc.2**，装了 86 个直接依赖（0.2.0-rc.2 是 82 个），cordis 从 4.0.4 升到 4.0.5，schemastery 3.18.4 → 3.18.5。

**依赖增删明细（`dsh` 顶层 dependencies 对比）：**

新增 10 个：
```
+ @deepseek-ai/dsh-experimental-inspector-profile
+ @deepseek-ai/dsh-tool-schedule
+ @deepseek-ai/dsh-experimental-cot-translation-bundle
+ @deepseek-ai/dsh-experimental-badge-skill-bundle
+ @deepseek-ai/dsh-experimental-ralph-bundle
+ @deepseek-ai/dsh-experimental-session-titles-bundle
+ @deepseek-ai/dsh-experimental-terminal-bundle
+ @deepseek-ai/dsh-experimental-session-search
+ @deepseek-ai/dsh-experimental-tool-worktree
+ @deepseek-ai/dsh-experimental-plugin-market-bundle
```

移除 6 个：
```
- @deepseek-ai/dsh-experimental-schedule-bundle   （被 dsh-tool-schedule 取代）
- @deepseek-ai/dsh-hooks-claude-code
- @deepseek-ai/dsh-hooks-codex
- @deepseek-ai/dsh-tool-ralph                     （被 dsh-experimental-ralph-bundle 取代）
- @deepseek-ai/dsh-webhook
- @deepseek-ai/dsh-webhook-github
```

> 这 6 个被移除的包如果出现在某个 profile 的 `dsh.profile.bundles` 里，升级后会 **import 失败**。本机 `~/.dsh/profiles/web/package.json` 的 bundles 清单里没有它们，暂无实害，但壳的 profile 迁移逻辑要能容忍。

---

## 2. 主进程代码（src/）对内核的假设

### 2.1 双通道的两个支点，0.2.1 都还在

壳的整套第4层双通道建立在两个内核行为上，逐字核对结果如下：

**支点 A：`__DSH_TRANSPORT__.streamBaseUrl`**（注入 HTML，见 `src/shell-protocol.js:341-344`）

0.2.1 内核 `dsh-api-gateway/lib/types/client/stream-client.js:477-484`：
```js
function remoteStreamUrl() {
	const globals = globalThis;
	const url = new URL(REMOTE_STREAM_MUX_PATH.slice(1), globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}
```

0.2.0-rc.2 同名文件 `:441-446` 逻辑**完全一致**。`REMOTE_STREAM_MUX_PATH = "/api/remote.mux"`（`stream-protocol.js:4`）两版也未变。

**支点 B：token → 303 → cookie 鉴权链**（`src/shell-protocol.js:456-475`、`:500-511`）

0.2.1 `dsh-client-connection/lib/index.js`：
- `:442` — `authenticatedUrl()` 把 launch token 塞进 `?token=`（`TOKEN_QUERY` 常量在 `:276`）。
- `:458-483` — `authorizeIndex()`：根路径带合法 token → `303 Location: ./` + `set-cookie`（cookie 名 `dsh-auth-` 前缀，`COOKIE_PREFIX`）；带合法 cookie → 放行；其余 → 401。
- `:742-746` — `admit()`：`browserAuth.isAuthenticated(request, secure)` 通过才给 peer，否则 401。
- `:779` — API 请求走 `isTrustedApiRequest(request, trustedHosts, bindHost, protocol)`。

壳的 `authenticateWebHost()`（`shell-protocol.js:456`）判据是"**303 且带 set-cookie**"，0.2.1 依然如此。

### 2.2 `isTrustedApiRequest` 在 0.2.1 变严了（需要关注）

0.2.0-rc.2 签名只有 `(request, trustedHosts)`；0.2.1 是 `(request, trustedHosts, bindHost, protocol)`。

0.2.1 新增的两条判定（`dsh-client-connection/lib/index.js:240-253`）：

```js
function isTrustedApiRequest(request, trustedHosts, bindHost, protocol = "http:") {
	const host = header$1(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host, protocol);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts, protocol) && !isBindAddressAuthority(hostUrl, bindHost)) return false;
	if (header$1(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header$1(request.headers, "origin");
	if (origin === void 0) return true;
	return isSameAuthorityOrigin(origin, host);
}
```

新增且与本壳强相关的两点：

1. **`sec-fetch-site: cross-site` 一律拒绝**（这条 0.2.0 也有）。
2. **`Origin` 必须与 Host 同 authority**，且必须能解析成 `http:`/`https:` scheme —— `isSameAuthorityOrigin()` 对非 http(s) 的 scheme 直接 `return false`。

壳在 `shell-protocol.js:243-246` 转发时**主动丢弃了 `origin` 和 `referer`**，在 `:501-510` 改写 WebSocket 头时把 `origin` 覆写成内核 origin、`sec-fetch-site` 覆写成 `same-origin`。这两手恰好都是 0.2.1 想看的形状，**当前实现是安全的**。但注意这是"蒙对"而非"针对 0.2.1 设计"——0.2.0 时代这两个头不是硬门槛。

风险点：壳的 WS 改写只在 `headers.origin === 'dsh-app://app'` 时触发（`main.js:1531`）。如果内核前端某天改用别的 origin 形式拨号，改写不触发，`Origin` 原样透传就会被 `isSameAuthorityOrigin` 拒。

### 2.3 WebSocket 拦截：写的是 `ws://`，不是 `wss://`

`src/main.js:1521`：
```js
webContents.session.webRequest.onBeforeSendHeaders({ urls: ['ws://*/*'] }, ...)
```

0.2.1 的 `remoteStreamUrl()` 里 `url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'` —— 壳走的是 http，仍得 `ws:`，**暂不受影响**。但 0.2.1 新增了 `--tls-cert` / `--tls-key`（`dsh-web-app/lib/startup.js`），一旦哪天启用 TLS，这里就是 `wss://*/*`，而 URL filter 匹配不上 → WebSocket 头不被改写 → 立刻 401。

### 2.4 就绪探测不依赖 `dsh web:` 行，只有 token 依赖

`src/readiness.js:52-78` 的 `waitForReady()` 是**纯 HTTP 探测**（2xx/3xx 算就绪，`isServing()` 在 `:104-106`），不解析 stdout。所以 0.2.1 改启动输出格式不影响就绪判断。

`src/kernel-process.js:150-159` 的 token 提取才是唯一致命的 stdout 解析：

```js
const match = /dsh web:\s*https?:\/\/[^\s]+?\/\?token=([A-Za-z0-9_-]+)/.exec(this.#pendingOutput)
```

0.2.1 `dsh-web-app/lib/index.js:162`：
```js
if (config.printUrl) console.log(`dsh web: ${authenticatedUrl}`);
```

`authenticatedUrl()`（`dsh-client-connection/lib/index.js:440-445`）产物形如 `http://127.0.0.1:<port>/?token=<launchToken>`，**正则仍然匹配**。但这是脆弱的耦合：0.2.1 新增了 `--public-url`，`authenticatedUrl` 的 base 可以变成任意 URL（如 `https://app.example/ui/`），token 仍在 query 里，正则靠 `\/\?token=` 仍能命中 —— 除非哪天 `authenticatedUrl` 把 token 挪到 fragment 或 path。

### 2.5 `--no-open` / `--port` / `--profile web` 语法

`src/kernel-runtime.js:126-137` 的 `buildKernelArgs()` 生成：

```js
[binPath, '--profile', 'web', ...patchFiles.flatMap((f) => ['--patch', f]), '--port', String(port), '--no-open']
```

0.2.1 `dsh/lib/bin.js:105` 与 `dsh-web-app/lib/startup.js:25` 对比 0.2.0：

| 参数 | 0.2.0 | 0.2.1 | 壳是否用 |
|---|---|---|---|
| `--profile <name>` | ✅ | ✅ | ✅ |
| `--patch <path>`（repeatable） | ✅ | ✅ | ✅（patchFiles，默认空） |
| `--port <port>` | ✅ | ✅ | ✅ |
| `--no-open` | ✅ | ✅ | ✅ |
| `--host <host>` | "bind host" | 收紧为"单一 IPv4/IPv6 字面量，拒绝通配" | ❌ 未用 |
| `--public-url <url>` | ❌ 无 | ✅ 新增 | ❌ 未用 |
| `--trusted-host` | ✅ | ✅ | ❌ 未用 |
| `--tls-cert` / `--tls-key` | ❌ 无 | ✅ 新增 | ❌ 未用 |

**壳用到的 CLI 面 100% 兼容。** 新增的 `--host` 收紧不影响壳（壳从不传 `--host`，内核默认绑 loopback）。

### 2.6 dshmarket 补丁基线

`tools/install-kernel.js:427-509` 的 `SHIPPED_PLUGIN_PATCHES` 对 `dshmarket/lib/dsh-cli.js` 的 `spawnEnv()` 做字面量 find/replace。0.2.1 内核引入了 `@deepseek-ai/dsh-experimental-plugin-market-bundle`（新包）和 `dsh-plugin-manager`（0.2.0 就有），说明插件市场机制在内核侧被官方收编了。**dshmarket 1.20.0 的 `dsh-cli.js` 结构大概率已经改了**，这条 find 一旦失配就是 `install-kernel.js:543-551` 的硬失败（build error，不会静默出错，这是好事）。

---

## 3. start-shell.sh 启动链路

### 3.1 dsh 版本完全不锁

`start-shell.sh:216-226` 的 `verify()`：

```bash
verify() {
  if [ -n "$ELECTRON" ]; then ... version_ge ... ELECTRON="" ; fi
  if [ -n "$NODE_BIN" ]; then ... version_ge ... NODE_BIN="" ; fi
  # dsh 不锁版本：能跑就行
}
```

`start-shell.sh:34-35` 只锁 Node ≥ 22.15 和 Electron ≥ 33，**dsh 内核没有任何版本下限**。这意味着：用户机器上装 0.1.x 内核，壳也会照样拉起，然后大概率黑屏。

`is_desktop_shell_shim()`（`start-shell.sh:95-102`）用"文件 < 4096 字节且含 `electron`"区分壳 shim 和真内核 —— 这个判据与内核版本无关，0.2.1 仍适用（0.2.19 起壳的命令已改名 `dsh-desktop`，见 `main.js:2089-2102`，判据只是多一层保险）。

### 3.2 内核拉起不在本脚本内

`start-shell.sh:439-440` 只 `exec "$ELECTRON" .`，真正的内核进程由 `src/main.js` → `src/kernel-process.js` 用 `DSH_KERNEL_BIN` 拉起。`start-shell.sh:314` 和 `:376` 两处 export `DSH_KERNEL_BIN`。

`start-shell.sh:403-410` 解析并 export `DSH_HOME`（支持 `~/`、`/*` 绝对、相对拼 userDataDir 三种形态），这个逻辑与内核版本无关。

### 3.3 插件补装依赖 `dsh plugin --profile web list`

`start-shell.sh:320`：
```bash
MISSING_PLUGINS="$(bash "$PLUGINS_SH" check 2>/dev/null || true)"
```

`tools/install-plugins.sh:185`：
```bash
LIST_OUT="$("$DSH_BIN" plugin --profile web list 2>/dev/null || true)"
```

0.2.1 `dsh/lib/bin.js:105` 的 `plugin` 子命令仍是 `requiredOption("--profile <name>")` + `argument("[args...]")` 透传给 pnpm，**语序 `plugin --profile web add/list` 两版一致**。

### 3.4 一个与版本无关但值得记的权限问题

`tools/install-plugins.sh` 权限是 `-rwx--x--x`（14188 字节）—— 属主可读写执行，**同组/其他人只有执行没有读**。`bash <script>` 读取时不需要自己可执行，但 `[ -x "$PLUGINS_SH" ]` 判断（`start-shell.sh:318`、`debian/DEBIAN/postinst:139`）依赖 x 位，其他人有 x 所以能过。**deb 重装时若权限被 dpkg 保留，仍可用；但 source 分发时这个权限组合很奇怪**，建议统一成 755。

---

## 4. tools/install-plugins.sh 插件清单

### 4.1 清单与版本门槛

`tools/install-plugins.sh:180`：
```bash
PLUGINS=("@xmanrui/dsh-im" dsh-remote-bridge dsh-mcp-panel dshmarket)
```

**四个插件一个版本都没锁**，全走 `dsh plugin --profile web add <pkg>` 装 latest。

对照本机实际 profile（`~/.dsh/profiles/web/package.json`）：

| 插件 | 壳清单 | 本机实际装的 | 说明 |
|---|---|---|---|
| `@xmanrui/dsh-im` | 无版本 | `^5.2.0` | ✅ 一致 |
| `dsh-remote-bridge` | 无版本 | `^2.4.2` | ✅ 一致（0.2.18 起取代 dsh-pocket-relay，见 `install-plugins.sh:177-178`） |
| `dsh-mcp-panel` | 无版本 | `^0.6.29` | ✅ 一致 |
| `dshmarket` | 无版本 | `1.66.44` | ⚠️ 与 `upstream.lock.json:32` 锁的 1.20.0 **相差 46 个小版本** |

**这是本次调研发现的第二个版本割裂**：`upstream.lock.json` 把 dshmarket 钉在 1.20.0（作为 bundled 随包插件，带 sha512），而 `install-plugins.sh` 装的是 latest（本机 1.66.44）。两者会**同时存在**：bundled 的在 `resources/kernel/node_modules/`，profile 侧在 `~/.dsh/profiles/web/node_modules/`。

### 4.2 pnpm 依赖

`tools/install-plugins.sh:98-169` 的 `ensure_pnpm()` 四级兜底（PATH → 同目录 → corepack → npm 用户级）。`dsh plugin add` 底层是 pnpm，0.2.1 未变（`bin.js:117` 的 `argument("[args...]", "pnpm arguments, forwarded verbatim")`）。

`install-plugins.sh:244` 用 `npm_config_registry="$NPM_REGISTRY"` 传镜像，注释 `:240-242` 明确说 `--registry` 会被 pnpm 当 unknown option 拒 —— 这条经验两版通用。

---

## 5. README / CHANGELOG 版本声明

### 5.1 grep 命中实况

按任务要求执行 `grep -n '0\.2\.\|DSH 版本\|内核版本'`：

**README.md**（全文件只有 2 处数字命中，且**都不是内核版本声明**）：
- `README.md:273` — "0.2.19 起它不再叫 `dsh`"（壳自身版本）
- `README.md:510` — "此模式下不下载 bundled 内核，内核版本就是你装的那个。"

**CHANGELOG.md**：所有 `0.2.x` 命中**全是壳自身版本号**（`0.2.19`、`0.2.18` … `0.2.1`），没有一条是 DSH 内核版本声明。唯一提到内核版本的是：
- `CHANGELOG.md:527` — "`upstream.lock.json` 钉在 `@deepseek-ai/dsh` 0.2.0-rc.2（sha512 校验）。"

**结论：README 和 CHANGELOG 都没有"当前支持哪个 DSH 内核版本"的显式声明。** 这是最大的文档缺口 —— 用户无法从文档判断自己的内核够不够新。

### 5.2 README 里与内核行为相关的段落（需同步核对的行）

| 行号 | 内容 | 与 0.2.1 的关系 |
|---|---|---|
| `README.md:68-70` | `dsh-app://` 与官方壳同源 | 未变 |
| `README.md:269` | 系统内核模式，`DSH_KERNEL_BIN` | 未变 |
| `README.md:320` | **系统内核模式**：`launcher.systemDsh` 指向本机 `dsh` | 未变 |
| `README.md:444-445` | `electron` / `systemDsh` 配置项 | 未变 |
| `README.md:475` | `readinessTimeoutMs` 240000，"实测 45~120 秒间波动" | ⚠️ 0.2.1 多了 10 个 experimental bundle，首启可能更长 |
| `README.md:509-510` | "内核版本就是你装的那个" | ⚠️ 正是要补最低版本声明的地方 |
| `README.md:566` | 离线双通道自建 | 未变 |
| `README.md:653` | `dsh-app://app` 打包 Web 入口 | 未变 |

---

## 6. config.json 的版本/端口配置

`config.json` 全文 **没有任何 DSH 内核版本字段**，也没有端口字段（端口由 `main.js` 动态选）。

与版本相关的间接配置：

| 键 | 值 | 行号 | 与 0.2.1 的关系 |
|---|---|---|---|
| `kernel.profile` | `"web"` | `config.json:20` | ✅ 0.2.1 仍内置 web profile |
| `kernel.homeSubdir` | `"~/.dsh"` | `config.json:18` | ✅ `dsh-home-paths/lib/index.js:11` 的 `.dsh` 常量未变 |
| `kernel.noOpen` | `true` | `config.json:22` | ✅ `--no-open` 两版都有 |
| `supervisor.readinessTimeoutMs` | `240000` | `config.json:39` | ⚠️ 注释明说"11 个插件 + 4 个 MCP 串行 45~120s"，0.2.1 插件更多，建议实测后再决定是否上调 |
| `launcher.telemetryMode` | `"DISABLED"` | `config.json:13` | ✅ |
| `engines.node`（package.json:22） | `>=22.15.0` | `package.json:22` | ✅ 与 `kernel-runtime.js:17` 的 `MIN_NODE_VERSION` 一致，理由是内核用 `zlib.createZstdDecompress`（22.15+）。0.2.1 未抬高此门槛 |

`upstream.lock.json:11` 的 Node Runtime `v22.22.0` 与壳的最低 22.15 无冲突（bundled 模式才用 22.22.0，系统内核模式用系统的）。

---

## 7. 「最低支持 DSH 0.2.0」能否声明？

**能。** 逐条给出依据：

### 7.1 支持"能声明"的证据

| 壳依赖的内核行为 | 0.2.0-rc.2 | 0.2.1-rc.2 | 证据 |
|---|---|---|---|
| `dsh --profile web --port N --no-open` CLI | ✅ | ✅ | `bin.js:105` / `startup.js:25` 两版一致 |
| `dsh plugin --profile web add/list` | ✅ | ✅ | `bin.js:117` 两版一致 |
| `--patch <file>` repeatable | ✅ | ✅ | `bin.js:105` 两版一致 |
| stdout 打 `dsh web: <url>/?token=<t>` | ✅ | ✅ | `dsh-web-app/lib/index.js:162` |
| token→303→`set-cookie: dsh-auth-*` 握手 | ✅ | ✅ | `client-connection/lib/index.js:458-483` |
| `__DSH_TRANSPORT__.streamBaseUrl` 被前端读取 | ✅ | ✅ | `api-gateway/.../stream-client.js` 两版同逻辑 |
| `WS /api/remote.mux` 靠 cookie 鉴权、拒 token | ✅ | ✅ | `client-connection/lib/index.js:742-746` |
| `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles` 约定 | ✅ | ✅ | 本机 `~/.dsh/profiles/web/package.json` 实证 |
| `isTrustedApiRequest` 拒 cross-site | ✅ | ✅ | 两版都有这条 |

### 7.2 需要写进文档的两个"软"注意点

1. **0.2.1 的 `isTrustedApiRequest` 多了 `isSameAuthorityOrigin` 强校验**：`Origin` 必须是 http(s) 且与 Host 同 authority。壳的转发层本来就剥掉 `Origin`，所以**两版都能跑，但 0.2.1 是"剥对了才活"**。声明最低 0.2.0 时建议加一句"0.2.1 起 API 信任判定收紧，壳的 WS 头改写必须保持"。

2. **被移除的 6 个包**（`dsh-hooks-claude-code`、`dsh-hooks-codex`、`dsh-tool-ralph`、`dsh-webhook`、`dsh-webhook-github`、`dsh-experimental-schedule-bundle`）：如果用户 profile 的 bundles 里列了它们，0.2.1 启动会 import 失败。壳的 `ensureShippedPlugins()`（`main.js:660+`）只增不删，不会清理。**建议声明最低 0.2.1 时提示用户手动清理 bundles。**

### 7.3 建议的声明措辞

> 本壳最低支持 **DSH 0.2.0-rc.2**，推荐 **0.2.1-rc.2** 或更新。低于 0.2.0-rc.2 的内核未经验证；0.2.1 起内核收紧了 `/api` 的 Origin 信任判定并新增 TLS 能力，本壳的 WebSocket 头改写已适配，但 TLS 模式下需另行支持。

---

## 8. P1 / P2 / P3 差距清单

### P1 —— 必须改，不改在 0.2.1 上会坏

#### P1-1 `upstream.lock.json` 内核锁还钉在 0.2.0-rc.2

- **现状**：`upstream.lock.json:5` `"version": "0.2.0-rc.2"`；`:6` 对应 sha512；`resources/kernel/package-lock.json:495` 记录同版本。
- **0.2.1 下的风险**：`tools/install-kernel.js:45` 的 `isAlreadyInstalled()` 比对 version+integrity，**失配即整树重装**（rmSync + npm install，注释 `:40-44` 说冷装约 25 分钟）。若只改 version 不改 integrity，`:222-226` 会抛 "installed ... but upstream.lock.json pins ..."。若两个都对不上 registry 实际产物，`:228-237` 抛 integrity mismatch。**这不是"会坏"，而是"必须一次性做对"**：改锁要连 integrity 一起换成 npm registry 上 0.2.1-rc.2 的真实 sha512，否则 build 直接失败。
- **建议改法**：
  1. `npm view @deepseek-ai/dsh@0.2.1-rc.2 dist.integrity` 取真实值；
  2. 同步更新 `upstream.lock.json:5-6`；
  3. 同步 `upstream.lock.json:31-35` 的 dshmarket（若决定升级）；
  4. 删掉 `resources/kernel/` 让下次 `npm run kernel:install` 重建，**或**先备份再重建 —— 0.2.0→0.2.1 有 10 增 6 删，混树必出怪事。
- **涉及文件**：`upstream.lock.json`、`resources/kernel/`（整体）、`tools/install-kernel.js`（若 P1-2 也要改）

#### P1-2 dshmarket 补丁基线对 1.20.0 之后失效

- **现状**：`tools/install-kernel.js:446-453` 的 `find` 字面量是 dshmarket 1.20.0 的 `spawnEnv()` 源码；`:543-551` 失配即抛 build error。`upstream.lock.json:32` 锁 1.20.0，而 `install-plugins.sh:180` 装的是 latest（本机 1.66.44）。
- **0.2.1 下的风险**：0.2.1 引入 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 与 `dsh-plugin-manager`，官方在内核侧收编了插件市场能力，dshmarket 的新版本极可能重构了 PATH 探测（连 `nodeVersionManagerBins()` 这个函数都是本仓 patch 自己加的）。**若 dshmarket 跟着升到 1.66.x，find 必失配 → build 失败；若继续锁 1.20.0，则 bundled 的 market 与 profile 侧的 1.66.x 双份并存，UI 行为不可预期。**
- **建议改法**：先决定 dshmarket 策略（二选一）：
  - **A. 升到 1.66.x**：用 1.66.x 的 `lib/dsh-cli.js` 重写 `SHIPPED_PLUGIN_PATCHES` 的 find/replace；若新版已修 PATH 探测（或改用 `dsh-plugin-manager` 的机制），整条 patch 可删除；
  - **B. 保持 1.20.0**：把 `upstream.lock.json:32-35` 的 1.20.0 写成显式决策并注释原因，同时在 `install-plugins.sh:180` 给 dshmarket 加版本钉（`dshmarket@1.20.0`），消除双份并存。
- **涉及文件**：`tools/install-kernel.js:427-510`、`upstream.lock.json:31-35`、`tools/install-plugins.sh:180`

#### P1-3 6 个被移除的内核包会让旧 profile import 失败

- **现状**：`src/main.js:660-700` 的 `ensureShippedPlugins()` 只往 `dsh.profile.bundles` 里**追加**，从不清理；本机 `~/.dsh/profiles/web/package.json` 的 bundles 有 17 项。
- **0.2.1 下的风险**：`dsh-hooks-claude-code`、`dsh-hooks-codex`、`dsh-tool-ralph`、`dsh-webhook`、`dsh-webhook-github`、`dsh-experimental-schedule-bundle` 六个包在 0.2.1 的依赖树里**已不存在**。任何列了它们的 profile 在 0.2.1 上启动时 `tree.import(<name>)` 会 ERR_MODULE_NOT_FOUND。升级用户的 profile 是从 0.2.0 时代继承的，命中概率不低。
- **建议改法**：在 `ensureShippedPlugins()` 旁边加一个 `pruneVanishedBundles(dshHome)`：读 profile manifest 的 bundles，逐个 `require.resolve` 或检查 `node_modules/<name>` 存在性，不存在且属于"已知被内核移除清单"的才删（**不能无脑删所有缺失项 —— 用户自己装的第三方插件暂时没装上也是缺失**）。已知移除清单随 `upstream.lock.json` 的版本走。
- **涉及文件**：`src/main.js`（`ensureShippedPlugins` 附近）、`src/dsh-home-manager.js`（若走 home 迁移路径）、`upstream.lock.json`（新增 `vanishedBundles` 字段）

#### P1-4 `dsh web:` token 正则与 0.2.1 的 `authenticatedUrl` 耦合

- **现状**：`src/kernel-process.js:156`：
  ```js
  const match = /dsh web:\s*https?:\/\/[^\s]+?\/\?token=([A-Za-z0-9_-]+)/.exec(this.#pendingOutput)
  ```
- **0.2.1 下的风险**：0.2.1 的该行输出是 `connectionCtx.connection.authenticatedUrl(webUrl)` 的产物（`dsh-web-app/lib/index.js:162` → `client-connection/lib/index.js:440-445`）。当前形状仍是 `.../?token=<t>`，**正则仍命中**。但 0.2.1 新增 `--public-url`，`appRootUrl()` 可指向任意 root（`dsh-web-app/lib/index.js:145`），token 的挂载位置由 `authenticatedUrl` 单方面决定。**一旦上游把 token 改到 fragment/path，或加了第二个 query 参数排在 token 前面，壳就再也拿不到 token → 所有请求 401 → 黑屏。** 这是最脆的一根线。
- **建议改法**：加兜底 —— 正则失配时不要静默 `null`。两种方案：
  1. 在 `kernel-process.js` 里把失配记为 warn 日志（已有 LogBuffer 脱敏机制，不会泄露 token）；
  2. 更稳的：探测 `readiness.js` 的 `httpProbe` 拿到 401 时，主动读一次内核的 `dsh --dump-config` 或 `DSH_WEB_URL`（0.2.1 新增的 shellEnv 变量，`dsh-web-app/lib/index.js:150-155`）反推 origin。
  短期先把正则放宽成 `\/[?&]token=` 并容忍 `#` 之前的 query。
- **涉及文件**：`src/kernel-process.js:150-165`

### P2 —— 建议改，能提升

#### P2-1 声明最低内核版本并在启动时校验

- **现状**：`start-shell.sh:225` 注释"dsh 不锁版本：能跑就行"；`verify()` 只校 Electron 和 Node。
- **机会**：用户装 0.1.x 内核会得到黑屏而非明确报错，是最难自查的一类故障。
- **建议改法**：`verify()` 里加一段 `"$SYSTEM_DSH" --version`（0.2.1 `bin.js:105` 有 `-V, --version`，0.2.0 也有）+ `version_ge` 比对，低于 `0.2.0-rc.2` 就清空 `SYSTEM_DSH` 并让 `missing_list` 报出来。注意 `version_ge`（`start-shell.sh:74-85`）目前只比 major.minor，**比不了 `-rc.2` 后缀**，需要扩展或换 node 侧判断。
- **涉及文件**：`start-shell.sh:216-226`、`tools/bootstrap.sh`（候选名单旁边加版本说明）

#### P2-2 WebSocket URL filter 未覆盖 `wss://`

- **现状**：`src/main.js:1521` `{ urls: ['ws://*/*'] }`。
- **机会**：0.2.1 新增 `--tls-cert` / `--tls-key`（`dsh-web-app/lib/startup.js:25`），`remoteStreamUrl()` 会产出 `wss:`。虽然壳现在不用 TLS，但"未覆盖"意味着哪天启用就是静默 401。
- **建议改法**：filter 改成 `['ws://*/*', 'wss://*/*']`（`rewriteWebSocketHeaders` 的逻辑对两者都成立，它只改头不改 URL）。
- **涉及文件**：`src/main.js:1521`

#### P2-3 `isTrustedApiRequest` 收紧后缺回归测试

- **现状**：`src/shell-protocol.test.js` 有 19689 字节的用例，`src/kernel-process.test.js` 相对薄。
- **机会**：0.2.1 的 `isSameAuthorityOrigin` 是新的拒绝路径。当前壳靠"剥 Origin + 覆写 same-origin"蒙对，没有任何测试锁定这个不变量。
- **建议改法**：在 `shell-protocol.test.js` 加一条：转发非 GET 请求到内核时，断言 `origin`/`referer`/`sec-fetch-site` 都不出现在出向 header 里；再加一条 WS 改写断言 `sec-fetch-site === 'same-origin'` 且 `origin` 等于内核 origin。
- **涉及文件**：`src/shell-protocol.test.js`

#### P2-4 README 缺"内核版本要求"章节

- **现状**：`README.md:510` 只说了句"内核版本就是你装的那个"，无最低版本、无推荐版本、无验证方法。§5.1 已证全文无内核版本声明。
- **机会**：这是用户排障的第一入口。
- **建议改法**：在 `README.md:509-510` 附近加一小节：最低/推荐版本表 + `dsh --version` 自查命令 + 0.2.1 破坏性注意（6 个包移除）。
- **涉及文件**：`README.md`

#### P2-5 `readinessTimeoutMs` 240s 对 0.2.1 可能不够

- **现状**：`config.json:39-40` 注释明说基于"11 个插件 + 4 个 MCP 服务器串行初始化，45~120s 间波动，原 90 秒不够，故放宽到 240 秒"。
- **机会**：0.2.1 多了 10 个 experimental bundle，全部走默认启用的话首启耗时只会涨不会跌。
- **建议改法**：升级内核后在真机实测一次首启耗时（看 `shell.log` 里 `startupBeganAt` 到 `setKernel` 的间隔），再决定 240s 是否上调。不要盲改。
- **涉及文件**：`config.json:39`（实测后）、`README.md:475`

#### P2-6 `install-plugins.sh` 权限位异常

- **现状**：`-rwx--x--x`（属主 7，组/其他 1）。
- **机会**：deb 打包/多用户场景下行为难预测；其他用户能执行不能读，`bash <script>` 又不需要写权限，状态暧昧。
- **建议改法**：`chmod 755 tools/install-plugins.sh`，与 `start-shell.sh`/`bootstrap.sh` 的表现一致（它们当前是 644，靠 `bash xxx` 调用，也可统一考虑）。
- **涉及文件**：`tools/install-plugins.sh`

### P3 —— 暂不做，说明为什么

#### P3-1 不支持 0.2.1 的新 CLI 参数（`--public-url` / `--tls-*` / 新的 `--host` 语义）

**为什么不做**：壳是单机 loopback 桌面场景，`--public-url` 服务于反向代理/公网部署，`--tls-*` 服务于 HTTPS 部署，`--host` 收紧对从不传 `--host` 的壳无影响。加了反而是未验证的攻击面。保留为 P2-2 的 filter 覆盖即可。

#### P3-2 不清理 profile bundles 里的第三方缺失插件

**为什么不做**：第三方插件（`@liustack/modlens`、`@windypro-rourou/dsh-logcat` 等，见 `~/.dsh/profiles/web/package.json`）是否安装是用户/网络状态，不是内核版本问题。无脑删会删掉"暂时没装上"的合法配置，比不删更糟。P1-3 只清理"已知被内核移除"的那一份白名单。

#### P3-3 不为 `@deepseek-ai/*` 加 npm 运行时依赖

**为什么不做**：内核是几百个包的离线 payload，放进壳的 `package.json` 会让 `npm install` 时间从秒级变成分钟级，且与 `resources/kernel/` 双份安装必然漂移。当前"壳 lock 只管壳自己、内核锁由 upstream.lock.json 单点负责"的分工是对的，`upstream.lock.json:2` 的注释已经把这个决策写明白了。保持。

#### P3-4 不追平 dshmarket 到 1.66.44 以外的更新

**为什么不做**：market 的版本策略应该跟 P1-2 的 A/B 决策一起定，单独追版本只会加剧双份并存。且本机 1.66.44 已经在跑，说明 latest 本身可用；问题在 bundled 那一份，不在 latest。

#### P3-5 不改 `package-lock.json`（壳仓库根）

**为什么不做**：§1.2 已证它不含任何内核条目，与内核升级完全无关。改它只会引入无关 diff。

---

## 9. 明确回答两个必答题

### Q1：当前锁的 DSH 内核版本是多少？升级到 0.2.1-rc.2 有哪些破坏性变更风险？

**答：当前锁 0.2.0-rc.2**（`upstream.lock.json:5`，sha512 见 `:6`；`resources/kernel/package-lock.json:495` 同）。壳的 `package.json`/`package-lock.json` 不含任何 `@deepseek-ai/*` 依赖，内核版本与壳的 npm 依赖树完全脱钩。

**破坏性风险分级：**

| 级别 | 风险 | 触发条件 |
|---|---|---|
| 🔴 高 | **build 失败** | 改 version 不改 integrity（`install-kernel.js:222`）、dshmarket patch 失配（`:543`）。都不是运行时坑，是构建期硬失败 —— 反而安全 |
| 🟡 中 | **旧 profile import 失败 → 黑屏** | 用户 profile 的 `dsh.profile.bundles` 含 6 个被移除的包（`dsh-hooks-claude-code` / `dsh-hooks-codex` / `dsh-tool-ralph` / `dsh-webhook` / `dsh-webhook-github` / `dsh-experimental-schedule-bundle`） |
| 🟡 中 | **token 提取失败 → 全站 401** | `dsh web:` 行格式若随 `--public-url` 改变（当前仍匹配，但是单点耦合） |
| 🟢 低 | **API 信任判定收紧** | 0.2.1 新增 `isSameAuthorityOrigin` 强校验；壳已剥 Origin + 覆写 same-origin，当前适配但无测试锁定 |
| 🟢 低 | **首启变慢** | 多 10 个 experimental bundle；`readinessTimeoutMs` 240s 可能需上调（实测后定） |
| ⚪ 无 | **CLI 接口 / 双通道 / profile 约定** | 三者两版逐字一致，见 §7.1 |

### Q2：能否声明「最低支持 DSH 0.2.0」？

**答：能。** 壳真正依赖的 9 项内核行为（CLI 参数、plugin 子命令、`--patch`、`dsh web:` 输出、token→303→cookie 握手、`__DSH_TRANSPORT__`、WS mux 鉴权、profile bundles 约定、cross-site 拒绝）在 0.2.0-rc.2 与 0.2.1-rc.2 之间**完全一致**，证据链见 §7.1。

建议措辞（精确到 rc，因为 0.2.0-rc.2 之前的版本未验证）：

> 最低支持 **DSH 0.2.0-rc.2**，推荐 **0.2.1-rc.2**。

并附两条注意：①0.2.1 收紧了 `/api` 的 Origin 信任判定，壳的 WS 头改写必须保留；②0.2.1 移除了 6 个 bundle，含它们的旧 profile 需清理（见 P1-3）。

---

## 10. 收尾清单：package.json / README / CHANGELOG 需要改哪些行

### 10.1 `package.json`（当前 45 行）

**不需要改版本号或加依赖**（0.2.19 是壳版本，与内核无关；不加内核依赖的理由见 P3-3）。

只需考虑是否加一个自说明字段，非必需：

| 位置 | 现状 | 建议 | 优先级 |
|---|---|---|---|
| `package.json:22` `engines.node` | `>=22.15.0` | 保持（理由是内核 `zlib.createZstdDecompress`，0.2.1 未抬高门槛，见 `src/kernel-runtime.js:17`） | 不改 |

**可选**（若想让 `npm pkg` 一眼看到内核要求）：在 `package.json` 加一个自定义字段，例如：
```json
"kernelRequirement": {
  "package": "@deepseek-ai/dsh",
  "minimum": "0.2.0-rc.2",
  "recommended": "0.2.1-rc.2"
}
```
这属于文档性字段，无代码消费，加了就要保证同步（可与 `upstream.lock.json` 一起改）。

### 10.2 `README.md`（当前 40678 字节）

| 行号 | 现状 | 改什么 |
|---|---|---|
| `README.md:475` | "`readinessTimeoutMs` \| `240000` \| 单次启动等待内核打出 `dsh web:` 行的超时。**实测本机内核启动耗时在 45~120 秒间波动**（插件与 MCP 服务器串行初始化），原 90 秒不够，故放宽到 240 秒" | 补一句 0.2.1 多了 10 个 experimental bundle，首启可能更长；数值是否上调以实测为准（P2-5） |
| `README.md:509-510` | "**系统内核模式**（当前默认）：需要本机已装 `dsh`，`launcher.systemDsh` 指向它。" / "此模式下不下载 bundled 内核，内核版本就是你装的那个。" | **新增小节「内核版本要求」**：最低 0.2.0-rc.2 / 推荐 0.2.1-rc.2；自查命令 `dsh --version`；0.2.1 破坏性注意（6 个包移除、Origin 信任收紧）（P2-4） |
| `README.md:269` | "系统内核模式 \| `src/main.js` `resolveKernelPaths` \| 设 `DSH_KERNEL_BIN` 即可驱动系统已装的 `dsh`，用真 Node 跑" | 可选：在末尾加"(≥ 0.2.0-rc.2)" |
| `README.md:273` | "…0.2.19 起它不再叫 `dsh`——内核 CLI 的名字必须留给内核" | 不改（壳版本声明，与内核无关） |
| `README.md:68-70` | `dsh-app://` 与原生右键菜单段落 | 不改（双通道描述 0.2.1 仍准确） |
| `README.md:566` / `README.md:653` | 离线双通道 / 打包入口 | 不改 |

### 10.3 `CHANGELOG.md`（当前 41965 字节）

| 位置 | 现状 | 改什么 |
|---|---|---|
| `CHANGELOG.md:7` | `## [Unreleased]` | **在这里加一节「内核兼容性」**，记录：upstream.lock.json 从 0.2.0-rc.2 升到 0.2.1-rc.2（含真实 sha512）、dshmarket 策略选择（P1-2 的 A 或 B）、bundle 清理逻辑（P1-3）、README 新增内核版本要求章节（P2-4） |
| `CHANGELOG.md:527` | "`upstream.lock.json` 钉在 `@deepseek-ai/dsh` 0.2.0-rc.2（sha512 校验）。"（在 `## [0.2.1] — 2026-10-01` 里） | **不改**。这是历史记录，改了就是篡改历史。新版本写在 `[Unreleased]` 或新的版本节里 |

### 10.4 本次未列入但强相关的文件（供 Lead 决策）

| 文件 | 为什么要动 | 对应条目 |
|---|---|---|
| `upstream.lock.json:5-6` | 内核版本 + integrity 一起换 | P1-1 |
| `upstream.lock.json:31-35` | dshmarket 版本 + integrity | P1-2 |
| `tools/install-kernel.js:427-510` | `SHIPPED_PLUGIN_PATCHES` 重写或删除 | P1-2 |
| `src/main.js:660+`（`ensureShippedPlugins` 旁） | 新增 `pruneVanishedBundles()` | P1-3 |
| `src/kernel-process.js:156` | token 正则放宽 + 失配告警 | P1-4 |
| `start-shell.sh:216-226` | `verify()` 加 dsh 版本下限 | P2-1 |
| `src/main.js:1521` | WS filter 加 `wss://*/*` | P2-2 |
| `src/shell-protocol.test.js` | 补 Origin/`sec-fetch-site` 不变量测试 | P2-3 |
| `tools/install-plugins.sh:180` | dshmarket 加版本钉（若走 P1-2 的 B 方案） | P1-2 |
| `tools/install-plugins.sh`（文件权限） | `chmod 755` | P2-6 |

---

*本文档只做调研与记录，未改动任何源码、未提交、未构建。*
