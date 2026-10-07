# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.15] — 2026-10-07

### 新增

- **启动前读一次登录 shell，内核的环境不再比终端少一半**。GUI 启动的程序只继承会话
  管理器的变量，Linux/macOS 上 `~/.bashrc`、`~/.zprofile` 导出的一切都不在内——手工加进
  PATH 的目录、代理变量、包管理器镜像、locale 全都缺失，于是内核运行在一个和用户终端不同
  的环境里，症状是「终端里有的工具，应用里找不到」。现以账户记录的 login shell（不是
  `$SHELL`）优先、回退 `/bin/zsh` → `/bin/bash` → `/bin/sh`，各跑 `-ilc` 并用 NUL 定界读取
  `env -0`。防阻塞三件套齐备：注入 `DISABLE_AUTO_UPDATE` 与两个 `ZSH_TMUX_*` 变量，
  stdin 设 ignore 让 rc 里的 prompt 读到 EOF，detached 后按进程组 SIGKILL；第二个哨兵出现
  即完成，不等 `close`（rc 起的后台子进程会一直持有 stdout）。合并时 shell 变量优先，但
  剔除 `PWD`/`OLDPWD`/`SHLVL`/`_` 与全部 `DSH_*`、`ELECTRON_*` 前缀——壳已按 `DSH_HOME`
  解析过路径，rc 里的旧值不该把它改回去。超时可用 `DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS`
  调（默认 10 秒，越界回落而非钳制）。永不 reject：全失败就用继承的环境并记日志。
  实测使 PATH 从 `/usr/bin:/bin` 恢复到含 `~/.local/bin` 与 `/usr/local/nodejs/bin` 的
  完整值，耗时 194 毫秒、零失败候选。
- **Linux 上可安装 `dsh` 命令，终端里也能用**。此前壳只在应用内可用，旁边开个终端却连不上
  它。官方对非 macOS/Windows 直接抛 `EUNSUPPORTED`，未实现此能力；本版本按其可逆所有权
  设计补齐：发布到 `~/.local/bin/dsh`，同目录 receipt 记录 dev/ino/mode/uid/gid/size/mtime
  与链接目标。安装前必须能证明该链接是本壳装的且指纹未变，否则一律拒改——用户的 PATH 不是
  我们的。被占用的条目先 rename 让位而非删除，失败即原样恢复；新链接就位并记账后才丢弃
  备份。卸载同理：链接不存在或已被改成别的东西都不删。带参数时发布一个 exec 包装脚本
  （软链传不了参数），单引号转义覆盖任意路径字节。托盘新增「dsh 命令」一项，四态显示
  （已安装／被占用／已被改动／未安装），只有可操作的两态可点。
- **崩溃恢复对话框**。内核反复退出现状是窗口里只剩一张错误页——它解释了，但不提供任何
  出路，而此时窗口显示该页正是因为应用已经渲染不出别的东西。现由原生对话框接手：报告先
  落盘再弹窗（写入上限 1 秒，慢盘不把人扣在诊断上），详情截 1200 字只留末尾 8 行、按码点
  切以免截断代理对，给出「退出／重启／禁用第三方插件并重启」三条路。端口占用
  （`listen EADDRINUSE`）单独识别并去掉「禁用插件」按钮——那是另一个 dsh 还在跑，不是插件
  问题。恢复动作本身失败时不退出循环而是重新询问：用户正面对一个没有窗口的应用，退出等于
  把人丢在那里。一次进程只弹一次，崩溃循环不会堆成一串对话框。崩溃报告同时收紧：目录 0700
  文件 0600，同毫秒不覆盖（`wx`）。
- **关窗口前的一次性说明**。Linux/macOS 上关窗口与退出长得一模一样：没有 dock、没有任务栏
  按钮，多数窗口管理器也不放回去。应用的工作不会因窗口隐藏而停止，所以以为「关窗口=退出」
  的用户会在毫无提示的情况下看不见仍在跑的任务。首次隐藏前说明一次；确认后每次启动都按此
  行为走。取消不写 marker——把拒绝记成同意是最糟的结果，被拒的人下次还该被问。对话框出错
  时窗口保持可见：不替用户决定关闭，而这条通知存在的全部意义就是说清楚关闭的后果并非他
  以为的那样。
- **拖放文件取本机路径**。从文件管理器拖进来的文件有本机路径，应用因此可以
  `@/path/to/file` 引用它，而不必上传字节——这是「4 GB 构建产物能附加」与「什么都附加不了」
  的区别。粘贴或从别的页面拖来的文件没有路径，返回空串照常上传。传入的不是文件对象时同样
  返回空串而不让页面崩掉。
- **应用主题同步到原生界面**。内核 Web UI 用 `data-ds-theme-source` 决定亮/暗/跟随系统，而
  Electron 自己的窗口边框、原生菜单、托盘提示读的是 `nativeTheme`。放着不管，深色应用会装在
  浅色边框里。该属性由应用而非本壳写入，读它即可对齐。注入脚本只监听这一个属性（否则
  `<html>` 上任何变化都触发），对根元素尚未出现的情况等 `DOMContentLoaded`，且每次加载注入
  都幂等。未识别的值回落 `system` 而非猜测：跟用户的桌面设置对着干比跟随它更糟。
- **更新检查的后台调度、失败话术与进度广播**。本壳壳核分离、以 deb 重装升级，所以抄的是
  官方的状态机与话术，不是 electron-updater 的增量下载与签名链——后者对本壳一半不适用。
  调度：正好按间隔检查会让所有副本在同一刻打同一个 feed，故按 `DSH_DESKTOP_UPDATE_CHECK_*`
  可调的抖动把它们散到一个窗口（只往后推仍会挤在边界上，那正是踩踏形成处）；失败按指数退避
  至 1 小时上限、成功复位；未完成的检查慢过一个间隔时，第二个定时器不再发新请求而是等在途
  那次，否则重复请求会报两遍答案，还会把正在退避的序列清零。取值不可用时回落默认而不抛错
  ——间隔错了是多几次请求，拒绝对启动是全部都没了。话术：更新失败不是一件事，九种成因九种
  说法，措辞不含原始诊断（updater 错误带栈、URL、有时还带 token），网络类失败按实际错误码
  识别，因为「连不上」和「校验不通过」不该给同一句话。状态：一条记录描述全部，托盘与页面读
  同一条而非各记一份；100% 不等于就绪，故最后一段报「正在校验」而非一个看起来卡住的下载。

### 文档

- CONTRIBUTING 增补「调试：验证假设，而不是验证代码」一节，把 0.2.15 这轮黑屏排查的教训写成
  规约：先用能复现症状的最小东西试；一次只动一个变量并记下它排除了什么；宁可真运行时也
  不要手写替身；官方壳做同一件事时把它读完；让失败可观测再猜。每条都配了当时的真实案例。
- README 补 `dsh-app://` 与原生右键菜单一节、崩溃恢复与登录 shell 的说明、托盘一次性告知
  与拖放路径与主题同步三行能力说明、四个可调环境变量，以及 `preload.cjs` 的 `.cjs` 为承重
  件这一事实。

## [0.2.14] — 2026-10-07

### 新增

- **内核页走 `dsh-app://app/`，与官方壳同一形态**。此前渲染层直连内核的
  `http://127.0.0.1:<port>`，DevTools 里 Request URL 暴露的是内核 origin；官方壳
  加载的是 `dsh-app://app/`，由协议层拦截转发。本版本补齐这一层：主文档载入
  `dsh-app://app/`，内核 JS 发的每个相对请求经 scheme handler 转发到内核 origin
  并附上 `?token=`。
- **原生右键菜单**。Electron 默认不给右键菜单，内核 UI 里任何输入框都无法右键
  粘贴、无法从回答里右键复制。现按编辑状态动态给菜单：可编辑处给撤销/重做/剪切/
  复制/粘贴/全选（各项按实际可用性置灰），有选区时只给复制，无选中不弹。菜单文案
  为中文，与本壳其余菜单一致。

### 修复

- **壳启动后一片黑，主文档拿不到内容**。内核的入口握手是
  `GET /?token=… → 303 Location: ./ + Set-Cookie: dsh-auth-…`，转发层此前把 303
  原样交给渲染层，渲染层收到一个空 body 的重定向状态，正好渲染成全黑窗口。现由
  转发层自行解析跳转：token 只用于入口那一跳（每跳重发会让内核视为新的未认证访问
  而无限 303），票据按 cookie 名替换保存并跨请求重放（`dsh-app://app/` 是独立
  origin，渲染层存不住它）。转发同时改为透传方法、请求体与业务头，只丢弃 hop-by-hop
  与浏览器管理头。
- **流式通道连不上，界面一直「重新连接中」**。内核前端用 `document.baseURI` 拼
  WebSocket 地址，页面在 `dsh-app://app/` 上就拼出 `ws://app/…`——一个不存在的
  主机。内核实际支持 `__DSH_TRANSPORT__.streamBaseUrl` 覆盖，现由转发层在送达
  index.html 时注入该全局；WebSocket 请求头按官方壳的做法补上内核 origin、
  握手票据与 `sec-fetch-site`。内核就绪时主动换票，不依赖渲染层是否先走过一次
  文档请求。
- **`contextBridge is not defined`，渲染层没有任何桥接能力**。preload 用了裸全局
  `contextBridge`，而该运行时（Electron 33）只在 `require('electron')` 上提供它，
  裸引用直接抛 `ReferenceError`，Chromium 报成 "Unable to load preload script"。
  改为 `require` 取用。
- **装好的壳里「检查更新」文案错**。`app.isPackaged` 在已安装场景下恒为 false，
  判断改用 `ELECTRON_USER_DATA` 是否存在。
- **壳静态页缺 CSP 响应头**。Electron 的安全警告读响应头而非 meta 标签，加载页与
  错误页补上 `content-security-policy` 响应头。
- **CI 的测试矩阵由三平台收敛为 ubuntu**。本项目只发 Linux deb（Deepin / UOS），
  Windows 与 macOS 既不做安装包、也不发布任何产物，继续在这两个平台上跑单元测试
  只产生噪音：`windows-latest` 固定失败 5 项（断言写的是 POSIX 路径字面量
  `/home/u/.dsh`，而 Windows 的 `path.join` 产出反斜杠 `\home\u\.dsh`，那组断言
  从未被设计为跨平台），`macos-latest` 则因同为 POSIX 而恰好通过、同样只是在测一个
  不发行的平台。`e2e` job 早已按同一理由收敛到 ubuntu，`check` job 属遗漏，本次补齐
  一致性 —— 两个 job 现在都只在产物真正服务的平台上测试。将来若真要支持某平台，
  届时连断言一起补。

## [0.2.13] — 2026-10-06

### 修复

- **空白的内核 Home 覆盖值会被当成有效路径，把家安到当前工作目录**。`--dsh-home` 或
  `DSH_HOME` 被设为纯空白时，此前会被原样采信：空路径解析到进程的当前工作目录，于是
  内核的家取决于「壳是从哪儿启动的」。现在空白值一律视为未设置，回落到上次记住的家；
  非空值也会先 `trim` 再展开 `~`，行为与官方 `@deepseek-ai/dsh-home-paths` 的
  `resolveDshHome` 对齐（同样拒绝纯空白的覆盖）。
- **安装/卸载「无进度」，并连带拖死应用商店**。0.2.12 的 `postinst` 把默认插件补装
  放在前台同步执行（`runuser … bash install-plugins.sh`，既无 `&` 也无 `timeout`）。
  maintainer script 属于 dpkg 事务，一次挂死就独占了 `/var/lib/dpkg/lock-frontend`：
  装包、卸载、乃至应用商店的其它升级全部卡在等锁，`dpkg` 状态停在 `iU`（解包未配置）、
  `/var/lib/dpkg/updates/` 留下未提交 journal。现改为与预下载一致的 `setsid nohup … &`
  后台派发，并补齐三项防护：`run_capped()` 超时熔断（`bootstrap check` 30 秒、
  `loginctl` 10 秒）、后台任务 fd 隔离（`</dev/null >>log 2>&1`，切断与 dpkg 输出管道的
  继承，避免调用方读不到 EOF 而永远停在「无进度」）、降权后显式重设 `HOME`
  （`runuser` 不像 login shell 那样改 `HOME`，否则运行时与插件会被装进 root 家目录）。
  实测 `postinst` 返回耗时由「永不返回」降至 77–80 ms。真机日志
  （`~/.dsh-desktop/bootstrap-postinst.log`）留下了事故当时的直接证据：四个插件被
  完整安装了两轮、合计 44 秒 —— 这 44 秒正是 dpkg 事务当时干等的时长。两处冗余
  （`bootstrap install` 在运行时已就绪后仍会补插件，而那段独立补装又会再跑一遍）
  现已合并为单个后台任务串行执行，既避免并发争抢 pnpm 依赖缓存，也让第二段因
  查重命中而直接跳过。
- **维护者脚本的「单一事实来源」从未生效**。`build-deb.sh` 中 `STAGE="$ROOT/debian"`，
  而打包第一步是 `rm -rf "$STAGE"` —— 源文件 `debian/DEBIAN/postinst` 会在打包开始时被
  自己删掉，随后的 `cp` 必然失败并静默回落 heredoc 兜底（仓库源 4049 字节 vs 包内实际
  4214 字节，长期不一致），即**对源文件的任何修改都不会进包**。源码已迁至
  `packaging/DEBIAN/`，与暂存目录分离；取消 heredoc 兜底，源缺失即构建失败；
  `.gitignore` 恢复对 `debian/` 的整目录忽略。
- **Electron 版本探测会被 `ELECTRON_RUN_AS_NODE=1` 污染**。该变量下 Electron 以 Node
  模式运行，`--version` 报出的是它内捆的 Node 版本（实测 Electron 33.3.0 被报成
  `v20.18.1`），于是被判「低于 v33 → 缺失」，白白触发一次约 180MB 的重复下载。
  新增 `electron_version()`：优先读发行包自带的 `version` 文件（纯文本、零进程开销、
  不受环境变量污染），回退时才 `env -u ELECTRON_RUN_AS_NODE` 执行二进制。

### 新增

- **`prerm` / `postrm`**。`prerm` 在卸载/升级前收掉残留的后台预热进程，并清理
  `.bootstrap-install.lock`，避免重装被误判「已有安装进程在下载」而直接跳过；
  `postrm` 只做交接提示，不删除用户数据（`~/.dsh-desktop` 属于用户，卸载一个壳
  不该顺手清掉用户的家当）。

## [0.2.12] — 2026-10-06

### 新增

- **多个内核 Home 并可切换**。此前一个壳只认一个 `DSH_HOME`：它在进程启动时被
  解析成常量（`src/main.js`），换家意味着改配置重启整个壳，而 `requestSingleInstanceLock()`
  又使并行开第二个壳并不可能。现在新增 `src/dsh-home-manager.js`，把家变成可选状态：
  托盘菜单「内核 Home」列出所有已登记的家，点选即切换——实现上是「改当前路径 + 重启
  内核」，不重启整个壳。启动时的选取优先级为
  `--dsh-home` 命令行 > 环境变量 `DSH_HOME` > 上次记住的选择 > `config.json` 的 `homeSubdir`。
- **添加 Home 时可选「从当前家复制」**。dsh 会把空目录初始化成干净 profile，但那样
  一个第三方插件都没有。菜单提供复制 `profiles/web` 的选项，新家随即具备相同插件，
  免去重新下载安装；目标已有 `profiles/` 时跳过而非合并——合并两份 manifest 会静默
  产出一个两边都没写过的插件列表。
- **命令行 `--dsh-home=<路径>`**。用于给不同的家各做一个快捷方式；优先级最高，
  且不会覆盖记住的选择。

### 修复

- **`start-shell.sh` 解析出 `DSH_HOME` 却从未 `export`**。该值此前只用于启动时打印
  那一行 banner，因此被同一脚本调用的 `install-plugins.sh` 始终在默认家 `~/.dsh`
  下安装插件——一旦把家换到别处，插件会装进不在使用的那个目录，表现为「这个家一个
  插件都没有」。现已导出，插件装进当前实际生效的家。这是多 Home 功能成立的前提。

### 变更

- 家的清单存在 `userData/dsh-homes.json`，刻意放在所有 Home 之外，使删除某个 Home
  不会连带丢掉整个清单；默认家（由 `homeSubdir` 决定）不可删除，删除操作只移除清单
  条目、不删除用户的目录。

## [0.2.11] — 2026-10-02

### 新增

- **缺插件时弹出终端窗口可见补装**。此前「插件没装/装失败」用户完全看不见：
  运行时就绪时 `bootstrap.sh` 一见「全部就绪」就提前返回，首启根本不检查插件
  （升级用户的常态）；`postinst` 的输出又全部重定向进日志。现在 `start-shell.sh`
  启动前会检查推荐插件，缺了就在可见的终端窗口里补齐——沿用首启下载运行时那套
  「借终端重跑自己」的机制与防死循环标记，下载进度与报错都看得见；连终端模拟器
  都没有的极简系统则退回后台静默补齐，日志落 `~/.dsh-desktop/plugin-install.log`。
- **`install-plugins.sh check` 模式**：纯查询、零副作用（不会因为缺 pnpm 就触发
  下载），stdout 只输出缺失包名，供启动流程判断是否需要补装。
- **版本印记快路径**：补齐成功后写 `~/.dsh-desktop/.plugins-ok`（内容为壳版本），
  同一版本下启动时直接跳过插件查询，避免每次启动都拉起一次 pnpm。

### 修复

- **`corepack` 下载 pnpm 不再走国外源**：corepack 只认 `COREPACK_NPM_REGISTRY`
  （不认 `npm_config_registry`），且 `corepack enable` 只建 shim、真正的下载发生在
  首次调用 pnpm 时——真机上表现为「enable 之后长时间无输出」。现在显式把
  `COREPACK_NPM_REGISTRY` 指向国内镜像（覆盖后续所有 pnpm 调用），并在预热时
  提示「首次需下载 pnpm，通常 10~30 秒」。
- **插件安装进度可见**：每个插件显示 `[i/4]` 与本次耗时，结尾汇总总耗时。

## [0.2.10] — 2026-10-02

### 修复

- **推荐插件自动安装的最后一层障碍：目标机没有 pnpm**。`dsh plugin` 子命令底层
  调用 pnpm，PATH 上没有 pnpm 时 dsh 直接失败：
  `dsh: pnpm was not found; install pnpm and make it available on PATH.`
  用 nvm 装的 Node 默认不带 pnpm，因此 arm64 真机上四个插件全部安装失败
  （v0.2.7 的转义问题、v0.2.8 的语序问题修好后，这一层才暴露出来）。
  `tools/install-plugins.sh` 新增 `ensure_pnpm`，按「复用优先、零下载优先」的
  顺序保证 pnpm 可用：
  1. PATH 里已有 pnpm → 直接使用；
  2. 与 dsh（即 node）同目录，以及 `/usr/local/bin`、`~/.local/bin` 等常见位置
     → 命中即复用并把其目录加入 PATH（dsh 靠 PATH 找 pnpm）；
  3. Node 自带的 `corepack` → 就地 `corepack enable pnpm`（含 `$ndir/corepack`
     回退，应对 postinst 经 `runuser` 调用时 PATH 精简的情况）；
  4. 兜底：`npm install -g --prefix ~/.local pnpm`——用户级安装，不需要 root，
     不碰系统目录。
  四条路径都已实测（修改性分支用 `DSH_PLUGIN_DRYRUN=1` 干跑验证，不产生副作用）；
  全部失败时给出明确的手动安装指引，且不阻塞壳本身启动。

## [0.2.9] — 2026-10-02

### 修复

- **升级后推荐插件仍装不上（v0.2.8 遗留）**。v0.2.8 让失败报错可见后，真机输出
  定位出 `dsh plugin add` 的用法错误：
  1. 正确语序是 `dsh plugin --profile web add <pkg>`（`--profile` 跟在 `plugin`
     之后）；写成 `dsh --profile web plugin add` 会把 `plugin`/`add`/包名当成
     主服务参数，报 `too many arguments. Expected 0 arguments but got 3`；
  2. `dsh plugin add` 不认 `--registry` flag（报 `unknown option`），registry
     只能通过 `npm_config_registry` 环境变量传给底层 pnpm。
- 本机端到端实测：`npm_config_registry=… dsh plugin --profile <p> add
  dsh-pocket-relay` 成功（`+ dsh-pocket-relay ^1.0.2`，exit 0）。

## [0.2.8] — 2026-10-02

### 修复

- **postinst 插件补装段被 `\$` 转义写死**：该段写在 quoted heredoc（`<<'EOF'`）
  里却按 unquoted 习惯把 `$` 转义成 `\$`，quoted heredoc 原样保留 `\$`，导致
  `[ -x "\$PLUGINS_SCRIPT" ]` 恒假、整段静默跳过——v0.2.7「升级后插件没装」
  的直接原因。
- **安装失败不再吞报错**：失败时打印 dsh/pnpm 的真实输出（末 15 行），
  临时文件写 `~/.dsh-desktop/`（不用 /tmp）。正是这条让 v0.2.9 的根因得以定位。

## [0.2.7] — 2026-10-02

### 新增

- **默认插件自举安装**：新增 `tools/install-plugins.sh`，在运行时就绪后自动安装
  四个推荐插件（`@xmanrui/dsh-im`、`dsh-pocket-relay`、`dsh-mcp-panel`、
  `dshmarket`）。脚本幂等（已装的跳过）、单插件失败不阻塞；接入 bootstrap
  安装成功路径，postinst 在升级场景也独立补装一次（升级时运行时已就绪、
  bootstrap 会提前退出，故单独调用）。新装用户开箱即得四插件。

### 修复

- **升级不再覆盖全局配置**：deb 生成 `DEBIAN/conffiles` 声明
  `/opt/deepseek-harness-desktop/config.json`。
  此前升级包会无脑覆盖全局 config.json；声明后用户改过的配置保留，新版默认
  配置落为 `.dpkg-dist` 供参考（Debian 标准语义）。
- **postinst 安装目录笔误**：`INSTALL_DIR` 误写为 `/opt/dsh-desktop-deepin`
  （少 harness），导致 postinst 找不到 bootstrap.sh——「装完后台预下载运行时」
  自上线以来从未真正生效，提示的安装路径也是错的。修正为
  `/opt/deepseek-harness-desktop`，与 PKG_NAME 一致。
- **仓库卫生**：`debian/` 打包暂存副本曾被误提交进仓库（与真实源码形成两份
  漂移副本），已全部移出追踪；`.gitignore` 精确豁免源码级
  `debian/DEBIAN/postinst`（此前整目录忽略把它挡在库外，CI 打包一直走
  heredoc 兜底）。

## [0.2.6] — 2026-10-02

### 修复

- **老 dpkg 装不上新 deb（zstd 兼容）**：GitHub runner 镜像升级后，
  `dpkg-deb` 1.22+ 默认改用 zstd 压缩，Deepin 20 / arm64 真机（dpkg 1.19）
  报「对成员 control.tar.zst 使用了未知的压缩」。`build-deb.sh` 打包显式
  `-Zgzip`（所有 dpkg 版本的最小公约数，体积 110K→148K 可忽略）。
  v0.2.4/v0.2.5 的 deb 受影响，v0.2.6 起恢复。

## [0.2.5] — 2026-10-02

### Fixed

- **`tsc --noEmit` passes again — CI's red "Type check" step is addressable.**
  `src/permissions.js` carried four implicit-`any` parameters and `src/update.js`
  declared `updates` twice in the same function; under `strict` + `checkJs` both
  fail the type check, and since both files were already on `main`, every CI run
  went red regardless of the 253 green unit tests. The permission decision is now
  a typed module-level function, and the duplicated declaration is gone.
- **The kernel e2e job runs on ubuntu, the platform this shell actually ships.**
  The matrix previously listed `windows-latest` and `macos-latest` only — the one
  platform this Linux-only project publishes for had no end-to-end coverage, while
  two it explicitly does not target were tested on every push.
- **A permissions assertion guards every deb build against the EACCES
  regression.** Commit `d81cb11` fixed limited file modes (e.g. `0600`) leaking
  into the package and crashing Electron for non-root users once installed under
  `/opt`; nothing prevented a recurrence. `package-linux.yml` now unpacks the
  built deb's listing and fails the build if any file outside `DEBIAN/` lacks an
  other-user read bit (verified against both a healthy package and a deliberately
  broken one locally). Repository-side file modes are normalised as well.
- **Package metadata points at this repository, not the upstream baseline.**
  `homepage`, `repository.url`, `bugs.url` and `author` in `package.json` were
  inherited from `sleep2agi/DeepSeek-Harness-Desktop`, so a "report a problem"
  click would open someone else's issue tracker. They now name
  `westanke/dsh-desktop-deepin`. The dead electron-builder configuration
  (`win`/`nsis`, `mac`/`dmg`/`entitlements`, `AppImage`, `pack`, `dist:win`,
  `dist:mac`) is removed — this project ships Linux debs only — and
  `prepack:app` now runs the type check before packaging. `version` is aligned
  with the latest tag (v0.2.3).

### Added

- **The installer pre-downloads the runtimes in the background, under your own
  account.** `postinst` runs as root, but the runtimes belong in the installing
  user's `~/.dsh-desktop/runtime`, so it now resolves the real login user
  (`$SUDO_USER` → `loginctl` → the first real `/home` entry) and drops
  privileges with `runuser`/`su` before starting the download. The download is
  detached (`setsid` + `nohup`) so `apt install` returns immediately instead of
  appearing to hang for minutes on the 180 MB Electron — by the time the user
  clicks the launcher it is usually already there, which is the
  "works right after install" feel without shipping a 152 MB offline deb. Opt
  out with `DSH_NO_POSTINST_DOWNLOAD=1`. `bootstrap.sh install` now takes an
  atomic `mkdir` lock so a concurrent launch cannot race it on the same
  `.partial` file, and `start-shell.sh` waits on that lock (with visible
  progress) instead of downloading twice.


- **Downloads are checksum-verified on both install paths.** The shell-side
  installer (`src/runtime-install.js`) verified Node but trusted the HTTPS
  origin for Electron, the largest and therefore most attractive component;
  it now fetches the Electron release's `SHASUMS256.txt` (both China mirrors
  sync it) and refuses a substituted archive, degrading to origin-only
  integrity — loudly — when a mirror serves no manifest. The pure-shell
  bootstrap (`tools/bootstrap.sh`) verified nothing for either runtime; it now
  runs the same manifest check for Node and Electron (verified live: a clean
  download passes, a single flipped byte is rejected).
- **Orphan reaper: dead kernels no longer leak their MCP servers.** The kernel
  launches MCP servers through `npm exec` chains, and when a kernel died
  without a planned stop (a crash, or the market helper swapping the process),
  every chain was re-parented to init and lived on forever — repeated restarts
  accumulated a fresh crop of `excel-mcp-server` processes nobody owned. The
  shell now injects an attribution marker (`ELECTRON_USER_DATA`, chosen
  because the kernel strips `DSH_*` variables before handing its environment
  to MCP children) into the kernel it spawns; the whole process family carries
  it. After an unexpected exit, when restarts are exhausted, on user-initiated
  restarts and at shutdown, the shell walks `/proc` and TERMs every marked
  tree that can no longer reach a live kernel — escalating to SIGKILL after a
  grace period. Processes that look like a kernel (`--profile` + `--port` on
  their command line) are never reaped, so a second shell window's kernel and
  an unsupervised replacement kernel survive the sweep; processes younger than
  two seconds are always spared. The new `src/orphan-reaper.js` is covered by
  24 unit tests, and the sweep was verified against real orphaned chains on a
  live system.

## [0.2.3] — 2026-10-01

### 新增

- **首启进度可见化。** 在缺运行时且无终端的机器上，`start-shell.sh` 会转开
  `deepin-terminal`（依次降级 `x-terminal-emulator` → gnome-terminal → konsole →
  xfce4-terminal）重跑自身：检测、镜像测速、下载、配置回填全程可见，不再是对着
  静默等待。`DSH_BOOTSTRAP_IN_TTY=1` 防止转开循环。
- **权限白名单。** 渲染进程放行麦克风（audio-only 的 `media`）、通知、剪贴板
  读取/写入；摄像头与其余权限仍然默认拒绝。
- **`bootstrap.sh` 首要搜索 `/opt`**（含玲珑布局 `/opt/apps/*/files`），并覆盖
  nvm/fnm/volta/asdf/n/pnpm/yarn/snap/brew——机器上已有的运行时直接复用，不下载。

### 修复

- **时区兜底。** `/etc/timezone` 为 `Asia/Beijing`、`PRC` 等 Chromium 不认的名字时，
  开窗前映射为 `Asia/Shanghai`。
- **Gitee 同步容忍跨境 TLS 抖动**：带重试与超时；同步失败只告警，不再拖红发布流水线。

## [0.2.1] — 2026-10-01

### 新增

- **arm64 deb。** 打包流水线从同一份源码产出 `amd64` 与 `arm64` 两个 deb（deb 只含
  壳代码，运行时首启按架构下载），并发布到 GitHub 与 Gitee 两侧 Release。
- **deb 版本号取自 tag**，终结早期「tag 是 v0.1.7、文件名却是 0.1.2」的错位。
- **多用户配置分层。** `/opt` 下的发行配置只读、全局共享；每用户覆盖份在
  `~/.config/dsh-desktop/config.json`，按键合并（DEFAULTS < 发行份 < 用户份）。
  自举检测到的运行时路径只写用户份，不碰全局份。

### 修复

- **限制性文件权限不再打断安装后的应用**：打包前对构建树 `chmod -R a+rX`，普通用户
  能真正读到 `/opt/.../src`（此前的 EACCES 崩溃）。
- **首次安装崩溃**：用户配置尚不存在时回写路径触发 `set -u` 未绑定变量。

## [0.1.7] — 2026-09-30

### 变更

- **deb 改用 `dpkg-deb` 直接构建，只装约 100KB 的壳代码**——Electron、Node 与内核
  首次启动时从国内镜像按需下载（先测速，按网络实况排镜像顺序）。内核经
  `upstream.lock.json` 钉在 `@deepseek-ai/dsh` 0.2.0-rc.2（sha512 校验）。
- 移除 Windows/macOS 打包流水线：本项目只发 Linux deb。

## [0.1.3] — 2026-09-29

### 新增

- **加载页 + 内核实时日志**——窗口先于内核出现，流式展示内核日志（已脱敏）、
  原地推进各阶段，就绪后再停留 `splashMinMs` 供阅读。
- **安全模式**：不加载第三方 bundle、用户 patch 层挪开备份（不持久化）——插件把
  内核在加载期搞崩时，壳仍进得去、有路可退。
- **端口由 OS 分配。** 内核端口每次启动由系统挑选；就绪探测不会再错审占着旧固定
  端口的别人家内核。
- **保留应用菜单栏**（应用/文件/编辑/视图/窗口）、F12 / Ctrl+Shift+I 开 DevTools、
  `kernel.homeSubdir` 支持 `~`、`supervisor.readinessTimeoutMs` 真正从配置读取。

## [0.1.2] — 2026-08-14

### Added

- **macOS desktop build.** The shell now ships a checksum-verified Node runtime for
  Apple Silicon and Intel (`darwin-arm64`, `darwin-x64`), packages a `.dmg` and a `.zip`,
  and runs the same readiness / window-policy / process-tree shutdown path as Windows.
- Unix kernel processes are spawned as their own process-group leader, so quitting the
  app actually tears down the tools the kernel started rather than leaving them orphaned.
- A Dock- or Finder-launched Mac app prepends Homebrew's usual `PATH` locations, so
  `git` (and the rest of a developer toolchain) is visible to the kernel.

### Changed

- `npm run dist` builds for the current platform. `dist:win` and `dist:mac` select one
  explicitly. CI and the release workflow now cover `macos-latest` as well as Windows.

### Known limitations

- Packaged Mac builds are ad-hoc signed, not notarized. Gatekeeper will warn on a
  downloaded `.dmg`.

## [0.1.1] — 2026-08-14

### Changed

- The packaged application is **180 MB smaller** — 674 MB installed down to 494 MB — with
  no change to what it can do.

  An npm tree is published for developers, and everything in it ships to every user. The
  removed files are the ones a running application never opens: debug symbols (52.8 MB),
  source maps (36.8 MB), the TypeScript the JavaScript was built from (35.0 MB),
  documentation (5.8 MB), and prebuilt native binaries for platforms this build does not
  target (~26 MB). Chromium's locale files account for the remaining 45.6 MB; the two the
  application can actually display are kept.

  Licences and notices are kept in every spelling — redistributing MIT-licensed code
  without its licence text is a violation, and they are small. The end-to-end test runs
  against the pruned kernel, so a size win that broke startup would fail the build.

  Kernel startup also got faster, from ~41 s to ~17 s, with 20,041 fewer files to walk.

## [0.1.0] — 2026-08-13

First preview. Windows is built and verified end to end; macOS and Linux are untested.

### Added

- Launches the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) kernel
  (`@deepseek-ai/dsh` 0.1.0-rc.6) as a child process on a free loopback port and shows its
  web UI in a desktop window.
- Bundles the kernel and the Node runtime it is published against, so a packaged build has
  no external requirements. Both are pinned in `upstream.lock.json`; the kernel is checked
  against its npm integrity hash and Node against the SHA-256 published in that release's
  `SHASUMS256.txt`, with each artefact asked to confirm its own version afterwards.
- Waits for a real HTTP response from the launch being waited on before showing a window,
  and reports an unexpected kernel exit with its captured output rather than leaving a
  window pointed at a process that is gone.
- Confines the window to the kernel's exact origin, restricts external links to
  `http`/`https`, refuses `webview` attachment, and attaches no preload bridge.
- Gives the kernel a private `DSH_HOME`, drops inherited `DSH_*` variables, and sets
  telemetry to disabled explicitly.
- Captures kernel output into a bounded buffer, redacted on entry, with the count of
  dropped lines kept visible.
- `tools/scan-leaks.js`, run in CI, fails the build on credentials, private registries, or
  internal address ranges in the working tree or in history.

### Known limitations

- The kernel's native workspace picker crashes on Windows in this upstream preview.
  `buildShellPatch({ useBrowseDirectoryPicker: true })` selects the non-native
  implementation; it is not enabled by default yet.
- Log redaction matches by shape and cannot be complete.
- Installers are unsigned, so Windows SmartScreen will warn on first run.

[0.1.2]: https://github.com/sleep2agi/DeepSeek-Harness-Desktop/releases/tag/v0.1.2
[0.1.1]: https://github.com/sleep2agi/DeepSeek-Harness-Desktop/releases/tag/v0.1.1
[0.1.0]: https://github.com/sleep2agi/DeepSeek-Harness-Desktop/releases/tag/v0.1.0
