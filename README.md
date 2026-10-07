# DeepSeek Harness Desktop · Deepin / UOS / Linux 版

<p align="center">
  <a href="https://github.com/westanke/dsh-desktop-deepin/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/westanke/dsh-desktop-deepin/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/westanke/dsh-desktop-deepin/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/westanke/dsh-desktop-deepin?include_prereleases"></a>
  <a href="https://gitee.com/westanke/dsh-desktop-deepin/releases"><img alt="Gitee" src="https://img.shields.io/badge/Gitee-%E5%90%8C%E6%AD%A5-orange"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20Deepin%20%7C%20UOS-blueviolet">
  <img alt="typecheck" src="https://img.shields.io/badge/tsc--noEmit-0%20errors-success">
</p>

**English (short).** A community Electron desktop shell for the [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) agent runtime, built for Deepin / UOS / Linux. It ships a shell-only deb (amd64 + arm64) that bootstraps Electron/Node/kernel on first run from China mirrors; an offline variant with everything bundled can be built locally for air-gapped machines. Linux is not an afterthought here: timezone quirks, `apt` dependency handling, multi-user config layering, kernel process-group management and orphaned MCP-server reaping are all first-class, and a unit-test suite plus a real-kernel e2e keep it that way.

面向 Deepin / UOS / Linux 的 DeepSeek Harness 桌面壳。把命令行 agent 运行时
`dsh` 包进一个 Electron 窗口：双击即用，不必开终端。

> **状态**：可用。单元测试全绿、`tsc --noEmit` 零错误、内核 e2e 通过（见上方 CI 徽章，
> 本地跑 `npm run test:all` 复现），已在
> UOS Desktop 20 Professional（glibc 2.31）与 Deepin 25 上真机验证（窗口加载、内核就绪、
> 托盘、菜单）。内核是上游开发预览版，配置面仍在变化。

---

## 项目特色

同类 DSH 桌面壳不止一个，取舍各不相同。本壳把三件事放在首位：**跑在中国 Linux 上**、
**安装包尽可能小**、**崩了也退得回去**。

### Linux ARM64：同类壳里目前只有这一家出包

同类壳的 Linux 产物都只覆盖 x64——`anywhere-labs/dsh-desktop` 的 release notes 直接写着
「ARM64 packages are not provided」；`dsh-tauri/deepseek-harness-desktop` 的 Linux 资产只有
`amd64.deb` 与 `amd64.AppImage`；`dataelement/dsh-desktop` 最新版只挂了 macOS 与 Windows 产物。
（三家都有 `aarch64` 文件，但那是 macOS 的 `.dmg`，不是 Linux。）

本壳同时发布 `amd64` 与 `arm64` 两个 deb，覆盖国产 ARM 整机、ARM 云主机与 arm64 开发板。
两个包文件名按架构区分、内容一致，首启各自下载对应架构的运行时。

### Deepin / UOS 是第一目标平台，不是顺带

| 坑 | 本壳的处理 |
|---|---|
| `/etc/timezone` 是 `Asia/Beijing`、`PRC` 等 Chromium 不认的名字 | 开窗前映射为 `Asia/Shanghai`，否则页面时间全错 |
| 缺终端模拟器 | 按 `deepin-terminal → x-terminal-emulator → gnome-terminal → konsole → xfce4-terminal` 依次降级，都没有则回退后台补齐 |
| 原生目录对话框不一定存在 | 有 `zenity` / `kdialog` 才用原生，否则自动降级为浏览模式 |
| 首次双击被问「是否信任该应用」 | 已写入文档——「点了没反应」通常是这个询问，不是启动失败 |

**验证环境**：UOS Desktop 20 Professional（专业版 `Y2020E0001`，内核 `4.19.0-amd64-desktop`，
海光 C86-3G，x86_64，**glibc 2.31** / GLIBC 符号上限 2.30，libstdc++ 上限 GLIBCXX_3.4.25）
与 Deepin 25——窗口加载、内核就绪、托盘、菜单均通过。

### 为什么是 Electron 而不是 Tauri 2

Tauri 体积小、内存低，看着是更"现代"的选择，社区里也有同类壳走了这条路。但它在
**本项目的目标系统上根本装不上**，原因都是实测出来的：

| 障碍 | 实测数据 |
|---|---|
| **Tauri 2 强制依赖 `libwebkit2gtk-4.1`**（Tauri 2.0 起在 Linux 上从 4.0 迁到 4.1，见 [官方迁移说明](https://tauri.ubitools.com/fr/blog/tauri-2-0-0-alpha-3/)） | UOS 20 的 apt 源里**只有 `libwebkit2gtk-4.0-37`**；`apt-cache search webkit2gtk` 搜遍仓库，**没有任何 4.1 包**，也装不上 |
| 系统 WebView 版本碎片化 | 各发行版的 webkit2gtk 版本差得远（4.0 / 4.1、2.38 / 2.44），同一份产物在不同系统上行为不一致 |
| 老系统的库基线 | 本系统 glibc **2.31**、GLIBCXX 上限 3.4.25；社区预编译二进制普遍要求更高（实测过别的预编译工具因 `libffi.so.8`、`GLIBCXX_3.4.29` 直接加载失败） |
| 同类壳的对照 | 走 Tauri 2 的那个壳，其 Linux 包自述「基于 Ubuntu 22.04 构建」——glibc 2.35 基线，与本类系统存在代差 |

**Electron 的取舍正好相反**：它自带 Chromium，**不依赖系统 WebView**，所以 Deepin 20 /
UOS 20 这类老系统与 Deepin 25 / UOS 25 这类新系统跑的是**同一个浏览器内核**，行为可预期；
代价是首次启动要下载约 180 MB 运行时——而这一点被「deb 只装约 160 KB 壳代码 + 装完后台
预下载」抵掉了。

### 界面与官方壳同源：`dsh-app://` 与原生右键菜单

内核页面加载在 `dsh-app://app/` 下，与官方桌面壳同一形态：页面的相对路径请求由协议层
拦截、转发到内核 origin 并带上当次启动的令牌，WebSocket 走独立通道。对外表现是
DevTools 里看到的请求域名是壳域，而不是每换一个内核端口就变一次的 `127.0.0.1:<端口>`。

附带 Electron 默认不给的原生右键菜单：按当前编辑状态动态给项——可编辑处给
撤销/重做/剪切/复制/粘贴/全选（各项按实际可用性置灰），选中文字时只给复制，
无选中不弹，文案为中文。没有它，输入框无法右键粘贴、回答无法右键复制。

> 一句话：选 Electron 不是因为它小（它不小），而是因为它**把不确定性从用户的系统搬进了
> 自己的包**。对一个以国产老系统为首要目标的壳，这个交换是划算的。
>
> 补一句实话：本壳的代码基线本就来自一个 Electron 壳，改用 Tauri 意味着重写窗口、托盘、
> 菜单与进程治理全部上层——但即便从零开始，上面第一条（WebView 依赖）也足以让 Tauri 2 出局。

### 安装包约 160 KB，运行时按需获取

deb 里**只有壳的代码**，不含 Electron（约 364 MB）、Node（约 25 MB）与 dsh 内核（约 30 MB）。
装完后 `postinst` 会**以你自己的账号**在后台预下载，等你去点启动器时通常已经就绪——
「装完即用」的体验，而包还是 160 KB。机器上已有可复用的运行时则完全不下。

### 开箱自带四个插件，不用去市场翻

首次启动（以及每次 deb 升级）会自动补齐下面四个社区插件。已装的**不覆盖你的版本**，
升级后缺失的会被补回。四个都各自解决一件「用得下去」的刚需，其中 `dshmarket`（★5.5k）
与 `dsh-im`（★1.6k）是社区里最热的两块：

| 插件 | 它让你能做什么 |
|---|---|
| **dsh-im** | 把 agent 接进你已经在用的聊天软件——飞书、微信、企业微信、钉钉、QQ、Slack、Telegram、Discord、WhatsApp 共 9 个通道，扫码或凭据即可接入。人不必坐在电脑前，在 IM 里就能使唤 agent |
| **dshmarket** | 内置可视化插件市场：浏览、搜索、一键安装。想再要点什么，不必去记 npm 包名 |
| **dsh-pocket-relay** | 把 DSH 装进口袋：局域网扫码直连，或经自建 relay 中继随时随地远程访问；设备级认证、多机共存与热备、实时同屏 |
| **dsh-mcp-panel** | MCP 管理控制台：`/mcp` 查看各 MCP 服务器的健康状态与连接诊断；设置页带服务器增删改（写入需审批、自动备份）与工具试调用台 |

**为什么值得默认装**：这四个恰好覆盖「能远程使唤」（`dsh-im` / `dsh-pocket-relay`）、
**能自己找插件**（`dshmarket`）、**出问题能自己诊断**（`dsh-mcp-panel`）四件刚需——
装完就有，不必先知道它们存在。补装/强制重装见下文「推荐插件」。

> 不想要某个？`dsh plugin --profile web remove <包名>`。注意升级 deb 后会按「在不在」
> 补回，除非改 `tools/install-plugins.sh`。

### 失败路径都被认真对待

| 问题 | 处理 |
|---|---|
| 插件把内核搞崩，壳自己进不去、也没法卸插件（死锁） | **安全模式**：停用全部第三方 bundle，用户 patch 层备份改名，且不持久化 |
| 内核非正常退出后，`npm exec` 拉起的 MCP 服务器被 init 收养、永远活着 | **孤儿收割**：给内核注入进程印记，退出后扫描 `/proc` 按印记收割整棵进程树（24 个单测） |
| 端口开着但其实不是我们的内核 | **就绪判定必须拿到真实 HTTP 响应**，端口占用不算 |
| 崩溃后一片空白 | 崩溃报告落盘（保留最新 10 份、目录 0700 文件 0600、同毫秒不覆盖）+ 日志进缓冲区即脱敏 + 渲染进程 60 秒内自愈 3 次 |
| 内核反复退出，窗口里只剩一张错误页 | **原生恢复对话框**：报告先落盘再弹窗（写入上限 1 秒，慢盘不把人扣住），给「退出 / 重启 / 禁用第三方插件并重启」三条路；端口占用单独识别——那是另一个 dsh 还在跑，不是插件问题，所以那条路上不提供「禁用插件」 |

### 供应链可验证，且失败时不静默

Electron 与 Node 的下载都校验对应版本的 `SHASUMS256.txt`；国内镜像若未同步该清单，
会**大声降级为「仅信任 HTTPS 来源」**并提示，而不是悄悄跳过校验。

### 多用户机器不掉坑

全局配置 `/opt/.../config.json` 只读、所有人共用；每用户覆盖份在
`~/.config/dsh-desktop/config.json`，键级合并。运行时下载到用户家目录，
**不需要 root、不碰系统目录**，卸载也不动你的会话数据。

---

## 下载与安装

发布包在 [GitHub Releases](https://github.com/westanke/dsh-desktop-deepin/releases)
与 [Gitee Releases](https://gitee.com/westanke/dsh-desktop-deepin/releases)（国内网络推荐 Gitee）。

| 格式 | 覆盖系统 | 说明 |
|---|---|---|
| `*.deb`（amd64 / arm64） | Debian / Ubuntu / **UOS / Deepin** / 麒麟 | 在线版，约 160 KB；装到 `/opt`，注册启动器与图标，首启下载运行时 |
| `*-offline-*.deb`（自建） | 同上 | **不在 release 提供**。有内网/离线机需求时自己打：见下文「离线双通道」 |

### 安装包只有约 160 KB——因为运行时按需获取

**这一点必须在安装前知道：首次启动会下载 Electron（约 180 MB），需要等几分钟。**

这个 deb 里**只有壳的代码**，不含 Electron、Node 与 dsh 内核。原因很直接：

| 组件 | 单独体积 | 为什么不打包 |
|---|---|---|
| Electron 运行时 | 约 364 MB | **包体积的主要来源**，占了原本 250 MB 安装包的绝大部分 |
| Node 运行时 | 约 25 MB | 你机器上多半已经有了，内核可以直接用系统的 |
| dsh 内核 | 约 30 MB | 同上；而且内核升级频繁，打进包会很快过时 |

把这三样打进去，安装包会从 **约 160 KB 膨胀到 250 MB 以上**，而其中 90% 的内容对
「已经装过 dsh 的机器」是重复的。所以本包采取按需获取：

```sh
# 装完后首次启动前，先跑一次自检（会告诉你要不要下载）
bash /opt/deepseek-harness-desktop/tools/bootstrap.sh check

# 缺什么就下什么，国内镜像优先
bash /opt/deepseek-harness-desktop/tools/bootstrap.sh install
```

安装器（deb 的 postinst）也会在装完后自动跑一次检测，并在缺失时明确提示你执行上面的命令。

**下载耗时预期**（取决于网络）：

| 缺什么 | 下载量 | 大致耗时 |
|---|---|---|
| 只缺 Node | 约 25 MB | 十几秒 |
| 只缺 dsh 内核 | 约 30 MB | 几十秒 |
| **只缺 Electron** | **约 180 MB** | **几分钟** ← 最常见的情况 |
| 三者都缺 | 约 235 MB | 几分钟 |

下载**只发生一次**。全部就绪后会把解析出的绝对路径写回
`config.json`（备份为 `config.json.bak-bootstrap`），之后每次启动都是零检测、秒开。

下载内容与来源（写入 `~/.dsh-desktop/runtime/`，不碰系统目录、不需要 root）：

| 组件 | 国内源 |
|---|---|
| Node | `npmmirror.com/mirrors/node`，备用 `mirrors.huaweicloud.com/nodejs` |
| Electron | `npmmirror.com/mirrors/electron`，备用 `mirrors.huaweicloud.com/electron` |
| dsh 内核 | `registry.npmmirror.com`（npm 全局安装） |

> 为什么优先国内源：上游 `nodejs.org`、GitHub Releases 与 `registry.npmjs.org` 在大陆
> 网络下经常超时或极慢，而上述镜像是同步的完整副本。脚本会在主源失败时自动切备用源。

**想避开首次下载？** 如果你的机器上已经有 Electron ≥ 33、Node ≥ 22.15 和任意可用的
`dsh`，`bootstrap.sh check` 会全部识别为已就绪，**不会有任何下载**。检测顺序是
`config.json` 指定路径 → `PATH` → 常见安装位置，命中即复用。

### 请用 apt 安装 deb，不要用 dpkg -i

`dpkg -i` 不解析依赖，缺库时直接失败。本包声明的运行时依赖：

```
libgtk-3-0  libnotify4  libnss3  libxss1  libxtst6
xdg-utils  libatspi2.0-0  libayatana-appindicator3-1
```

```sh
sudo apt install ./DeepSeek-Harness-Desktop-<版本>-amd64.deb
```

> 该结论来自 anywhere-labs PR #1120 的 Ubuntu 24.04 真机验证，非推测。

### 装完就会在后台预下载，不用干等

`apt install` 结束后，安装脚本会以**你自己的账号**（不是 root）在后台自动开始
下载运行时 —— 所以绝大多数情况下，等你双击启动器时它已经就绪，跟「装完即用」
没区别，而包还是只有 160 KB。

- 下载在后台跑，`apt install` 立即返回，不会卡住安装进度
- 日志：`~/.dsh-desktop/bootstrap-postinst.log`
- 不想装时就下载（比如批量部署、离线机）：
  `sudo DSH_NO_POSTINST_DOWNLOAD=1 apt install ./xxx.deb`
- 若你双击时它还没下完，启动器会显示等待进度并排队，不会重复下载

Deepin/UOS 上首次双击启动器可能询问「是否信任该应用」，确认即可。信任按用户记录，
所以「点了没反应」通常是这个询问，不是启动失败。

卸载：

```sh
sudo apt remove deepseek-harness-desktop
```

卸载**不会**动你的内核数据（`~/.dsh` 或 `$DSH_HOME`：会话、设置、凭据、插件），
也不会删 `~/.dsh-desktop/runtime/`（已下载的运行时留着，重装后可直接复用）。
如要彻底清理，手动删该目录即可。

---

## 推荐插件（默认随运行时自动安装）

以下四个社区插件由 `tools/install-plugins.sh` 在**运行时就绪后自动安装**
（升级 deb 时 postinst 也会补装缺失的；已装的跳过、不覆盖你的版本）。
不想要某个？`dsh plugin --profile web remove <包名>` 即可——注意升级后会
被自动补回（查重只认「在不在」）。

| 插件 | 干什么 | 链接 |
|---|---|---|
| **dsh-im** | 把微信、飞书、企业微信、钉钉、QQ、Telegram、WhatsApp、Slack、Discord、Matrix 等 IM 接入 DSH——在聊天软件里直接使唤你的 agent | [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) |
| **dsh-pocket-relay** | 把 DSH 装进口袋：局域网扫码直连，或经自建 relay 中继随时随地远程访问（设备级认证、多机共存与热备、实时同屏） | [kinderao/dsh-pocket-relay](https://github.com/kinderao/dsh-pocket-relay) |
| **dsh-mcp-panel** | MCP 管理控制台：`/mcp` 命令查看 MCP 服务器健康状态、诊断连接问题 | [PerryLink/dsh-mcp-panel](https://github.com/PerryLink/dsh-mcp-panel) |
| **dshmarket** | 内置可视化插件市场：浏览、搜索、一键安装社区插件 | [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) |

手动补装 / 强制重装：

```sh
bash /opt/deepseek-harness-desktop/tools/install-plugins.sh          # 补缺的
bash /opt/deepseek-harness-desktop/tools/install-plugins.sh force    # 全部重装
```

---

## 功能（按实际实现）

### 内核与进程

| 功能 | 实现位置 | 说明 |
|---|---|---|
| 内核启动与就绪判定 | `src/kernel-process.js` `src/readiness.js` | 必须拿到真实 HTTP 响应才算就绪；端口开着不算 |
| 崩溃自动重启 | `src/kernel-supervisor.js` `src/restart-policy.js` | 指数退避，10 分钟窗口内最多 5 次，超出则放弃并报错 |
| 进程组整体回收 | `src/kernel-process.js` | Unix 下子进程自任组长，退出时 `kill(-pid)` 连孙进程一起收 |
| 系统内核模式 | `src/main.js` `resolveKernelPaths` | 设 `DSH_KERNEL_BIN` 即可驱动系统已装的 `dsh`，用真 Node 跑 |
| 固定端口 | `src/main.js` `preferredPort` | 默认 `19387`（官方同款）；被占用则自动退回随机端口 |
| 崩溃报告 | `src/diagnostics.js` | 写 `userData/logs/crash-<UTC>-<来源>.log`，保留最新 10 份，输出限 64 KiB；目录 0700 文件 0600，`wx` 拒绝覆盖 |
| 崩溃恢复对话框 | `src/fatal-recovery.js` | 先落盘报告再弹窗（上限 1 秒）；详情截 1200 字留末 8 行、按码点切不截断代理对；三分支按钮，恢复失败重新询问而非退出；一次进程只弹一次 |
| 终端里也能用 | `src/login-shell-environment.js` `src/cli-command.js` | GUI 启动只继承会话管理器变量，所以启动前读一次登录 shell（`-ilc` + NUL 定界，10 秒上限，失败即回落继承环境）；`dsh` 命令可装到 `~/.local/bin`，带指纹记账，只动能证明是自己装的那一个 |
| 多个内核 Home | `src/dsh-home-manager.js` | 可登记多个 `DSH_HOME` 并在托盘切换；注册表存 `userData/dsh-homes.json`，刻意放在所有 Home 之外 |
| 命令行指定 Home | `src/dsh-home-manager.js` | `--dsh-home=<路径>` 直接用某个目录启动，优先级高于一切 remembered 选择；适合做多个快捷方式 |

### 桌面集成

| 功能 | 实现位置 | 说明 |
|---|---|---|
| 应用菜单 | `src/app-menu.js` | 应用/文件/编辑/视图/窗口 五组；首项「关于」开原生面板 |
| DevTools 快捷键 | `src/app-menu.js` | F12 与 Ctrl+Shift+I，注册为隐藏菜单项，打包版同样有效 |
| 系统托盘 | `src/tray.js` | 显示/隐藏/重启内核/**切换 Home**/`dsh` 命令安装与卸载/检查更新/安全模式/开机自启/退出，带实时状态行与更新进度 |
| 关闭即隐藏 | `src/tray.js` `src/main.js` | 关窗只隐藏，内核与任务继续跑；退出走托盘或菜单。**首次隐藏前说明一次**（「关闭窗口不会退出」），确认后不再打扰；取消则下次仍问 |
| 拖放文件取本机路径 | `src/preload.cjs` | 拖进来的文件以 `@/path` 引用而非上传字节——4 GB 产物能附加与什么都附加不了的差别；粘贴来的字节无路径则照常上传 |
| 主题跟随应用 | `src/theme-bridge.js` | 应用内切深色时，窗口边框、原生菜单、托盘提示一起切，不出现深色应用装在浅色边框里 |
| 退出确认 | `src/exit-guard.js` | 退出前弹确认框，策略见 `kernel.exitPolicy` |
| 窗口几何记忆 | `src/window-state.js` | 记住尺寸位置；显示器拔掉后不会把窗口丢到屏幕外 |
| 托盘图标 | `assets/trayTemplate.png` | Linux 任务栏图标 |
| 桌面通知 | `src/tray.js` `src/dom-observer.js` | agent 完成当前任务时发系统通知 |
| 运行时自检 | `tools/bootstrap.sh` `src/runtime-doctor.js` | 检测 Electron/Node/dsh 是否就绪，缺了可从国内源自动下载 |

### 启动过程可见

窗口**先出现**，内核在后面启动，全程显示进度——不必对着空白干等：

```
正在准备启动…            ← 窗口一出现就能看到
正在启动内核…
正在等待内核就绪…

已等待 13 秒              ← 逐秒跳动，跨页面切换连续计数

dsh-pocket: auto-restore check        ← 内核实时输出
[info]: [ 'client ready' ]
[MCP-Server-Chart] ... tool handlers set up
12306 MCP Server running on stdio
dsh: skipping profile bundle "xxx"    ← 哪个插件没加载，看得见
```

实现：`src/loading-page.js` 暴露 `window.__dshStage()` 与 `window.__dshLog()`，主进程
**原地改文本**而不是换页（换页会重建文档、计时归零、中间态一闪而过）。
内核输出经脱敏后按 120ms 批推送。

### 端口与内核模式

- **端口由系统分配**，不固定。官方壳固定 19387，本壳曾经也这样——但那会导致：端口被
  别的 dsh 实例占用时，壳换了端口却仍去探测 19387，探到的是**别人的内核**（token 对不上，
  永远 401，最后报「内核未响应」而真正的内核活得好好的）。改成系统分配后从根上消除了撞车。
- **系统内核模式**：`launcher.systemDsh` 指向本机 `dsh`，壳用它作为内核，不下载 bundled 版本。
- **`~` 展开**：`kernel.homeSubdir` 支持 `~/.dsh` 写法（Node 不认 `~` 是绝对路径，必须显式展开）。

### 多个内核 Home（可选切换）

一个 `DSH_HOME` 就是一套完整身份：会话、设置、凭据、插件、记忆全在里面。
壳可以登记若干个这样的目录，**用哪个加载哪个**，不用再改配置重启。

适合这几种情况：工作与个人分开；临时开一个干净环境试插件，试完删掉不影响主力；
给不同用途配不同插件组合。

#### 怎么切换

**托盘菜单 →「内核 Home」→ 点选目标**，前面有 `✓` 的是当前生效的那一家。

```
托盘右键
└─ 内核 Home
   ├─ ✓ 默认
   ├─   工作
   ├─   ──────────
   ├─   添加已有 Home…
   └─   在文件管理器中打开当前 Home
```

切换时会**重启内核**（不是重启整个壳），所以要等一会儿——界面回到 loading 页，
日志照常可见。实测启动耗时在 **45~120 秒**之间波动（插件与 MCP 服务器串行初始化），
这是内核自己的启动代价，不是菜单卡住。选过之后会被记住，下次启动直接进那一家。

#### 怎么添加

托盘 →「内核 Home → 添加已有 Home…」，选一个目录即可。随后会问一句：

- **复制** —— 把当前 Home 的 `profiles/web`（含全部插件）拷进新家。新家立刻具备
  相同的插件，省去重新下载安装。适合"想要一个和现在一样的"。
- **不用，创建空 Home** —— 得到干净内核，只有 `dsh-base` 与 `dsh-web-app`
  两个内置 bundle，一个第三方插件都没有。适合"想要一个纯净环境"。

> 目标目录里已经有 `profiles/` 时会**跳过复制**（不合并）。合并两份 manifest
> 会静默产出一个两边都没写过的插件列表，那比不做更糟。

#### 命令行直接指定

```sh
./start-shell.sh --dsh-home=/home/你/dsh-work
# 或等号形式
--dsh-home /home/你/dsh-work
```

它的优先级最高：高于环境变量 `DSH_HOME`，也高于上次记住的选择。想做几个不同用途的
快捷方式（`.desktop`），各写一行 `--dsh-home=…` 就行。

完整优先级，从高到低：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `--dsh-home` 命令行 | 本次启动专用，不改变记住的选择 |
| 2 | 环境变量 `DSH_HOME` | 终端里 `DSH_HOME=… ./start-shell.sh` 同样有效 |
| 3 | 上次记住的选择 | 托盘切换后写入注册表，下次自动沿用 |
| 4 | `config.json` 的 `homeSubdir` | 兜底，即「默认那一家」 |

#### ⚠️ 同时只让一家在线

复制出来的新家**沿用原家的凭据**。两个 Home 同时在线时，同一账号的常连接型插件
（例如 IM）会互相争抢长连接，**结果是入站消息丢失**——这正是各家必须能分开的理由，
也是分开后要留神的地方。

需要真的同时在线，请到新家里改掉对应插件的凭据。或者干脆别同时开两家。

#### 注册表在哪

`userData/dsh-homes.json`（通常是 `~/.local/share/dsh-desktop/data-shell/`）。
刻意放在**所有 Home 之外**：否则删掉某一个 Home 时，会把整个清单也一起带走。

- 「默认」那一家**不可删除**——它的路径由 `config.json` 的 `homeSubdir` 决定，
  删了就没有兜底可用。
- 菜单里的删除只对清单生效，**绝不删你的目录**。删一个装满东西的家这种事，
  不该由"从列表里移除一行"触发。要清数据请自己去文件管理器删。
- 两份条目指向同一目录时，后一条会被标注「与 xxx 同路径」，两条都保留。

### 安全模式

插件崩到内核起不来时，壳自己也进不去、无法卸载插件——死锁。安全模式是这个死锁的出口：

- 停用**全部第三方 bundle**（`@deepseek-ai/dsh-base`、`dsh-web-app` 受保护，否则没界面）
- 用户 patch 层**备份改名**而非改写：`cordis.patch.yml` → `cordis.patch.yml.bak-<UTC>`
- **不持久化**：恢复动作不是偏好，下次正常启动插件自动回来

托盘菜单与应用菜单两个入口都能触发。实现见 `src/safe-mode.js`。

### 安全策略

| 项 | 实现 | 说明 |
|---|---|---|
| 导航白名单 | `src/window-policy.js` | 仅精确 origin 可导航；外链限 http/https 交系统浏览器 |
| 渲染进程权限白名单 | `src/permissions.js` | 仅放行内核需要的麦克风（纯音频）、通知、剪贴板；摄像头等一律拒绝 |
| 沙箱与隔离 | `src/window-policy.js` | `contextIsolation` + 无 Node 集成 |
| 日志脱敏 | `src/log-redact.js` | 进缓冲区即脱敏，超限丢弃并计数 |
| 配置原子写 | `src/config-file.js` | 临时文件 + rename，加文件锁（陈旧锁可破） |
| 渲染崩溃自愈 | `src/main.js` | 60 秒内最多 3 次 reload，超出显示错误页 |

---

## 配置

所有可调项集中在 `config.json`，改它不用动代码。每个键旁边都有 `_comment_*`
中文说明，这里列出常用项：

**配置文件有两份，改「生效的那份」**（`start-shell.sh` 启动横幅里也会打印当前
用的是哪份）：

| 位置 | 权限 | 何时用 |
|---|---|---|
| `/opt/deepseek-harness-desktop/config.json` | root 只读 | **全局默认**，deb 安装自带，所有人共用 |
| `~/.config/dsh-desktop/config.json` | 用户可写 | **每用户覆盖份**，优先生效 |

规则：读取顺序是**用户覆盖份 → 全局份**，键级合并（用户份有该键就用用户份的）。
多用户机器上**不要改全局份**（普通用户也改不动），把要改的键写进自己的覆盖份即可；
首次启动壳会自动创建覆盖份并把检测到的运行时路径写进去。改完重启壳生效。

### `launcher` —— 怎么把壳拉起来

| 键 | 取值 | 说明 |
|---|---|---|
| `electron` | 路径 | Electron 可执行文件。系统内核模式下它就是壳的运行环境，必填 |
| `systemDsh` | 路径 | 系统 `dsh`。Shell 把它作为 `DSH_KERNEL_BIN` 传给内核，即「系统内核模式」 |
| `nodeBinDir` | 目录 | 系统 node 所在目录，会被加进 `PATH` 供内核使用 |
| `userDataDir` | 路径 | 壳的 Electron userData 目录，日志也落这里。相对路径以壳根目录为基准 |
| `telemetryMode` | `DISABLED` 等 | 传给环境变量 `DSH_TELEMETRY_MODE` |

> `electron` / `systemDsh` / `nodeBinDir` 三项**可以由 `bootstrap.sh install` 自动写入**，
> 不用手工填。装完 deb 跑一次自检即可。

### `kernel` —— 内核怎么起、数据放哪

| 键 | 取值 | 说明 |
|---|---|---|
| `homeSubdir` | 路径 | `DSH_HOME` 的位置。**支持 `~` 展开**（`~/.dsh` → `/home/你/.dsh`）；相对路径则拼在 `userDataDir` 下。**它决定的是「默认那一家」**——此外还能登记更多 Home 并随时切换，见《[多个内核 Home](#多个内核-home可选切换)》 |
| `profile` | `web` 等 | 启动 profile |
| `noOpen` | `true`/`false` | `true` 表示不让 dsh 自己开浏览器，由壳加载页面 |
| `directoryPicker` | `auto`/`browse`/`native` | `auto` 时：Linux 上有 zenity 或 kdialog 就用原生对话框，两者都没有则自动降级为浏览模式 |
| `exitPolicy` | `ask-always`/`ask-if-busy`/`never` | 退出确认策略。默认 `ask-always` 最保守（本壳无法像官方那样精确查询 Host 任务，故取保守档） |

> `homeSubdir` 的 `~` 展开是必须的：Node 的 `path.isAbsolute('~/.dsh')` 返回 **false**，
> 不展开就会被当成相对路径拼到 `data-shell/` 下，生成一个名字字面叫 `~` 的空目录，
> 内核会在错误的 home 里启动、看不到你的任何插件。

### `supervisor` —— 内核守护

| 键 | 默认 | 说明 |
|---|---|---|
| `maxRestartsInWindow` | `5` | 滚动窗口内最多重试次数，超出则放弃并报错 |
| `restartWindowMs` | `600000` | 重试计数的滚动窗口（10 分钟） |
| `baseDelayMs` | `2000` | 首次重试延迟，之后每次翻倍 |
| `maxDelayMs` | `30000` | 重试延迟上限 |
| `readinessTimeoutMs` | `240000` | 单次启动等待内核打出 `dsh web:` 行的超时。**实测本机内核启动耗时在 45~120 秒间波动**（插件与 MCP 服务器串行初始化），原 90 秒不够，故放宽到 240 秒 |

### `renderer` / `tray` / 其他

| 键 | 说明 |
|---|---|
| `renderer.maxRecoveries` / `recoveryWindowMs` | 渲染进程崩溃后自动 reload 的次数与窗口（默认 3 次 / 60 秒） |
| `DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS` | 环境变量。后台检查更新的间隔（默认 `600000`，即 10 分钟） |
| `DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS` | 环境变量。连续失败时的退避上限（默认 `3600000`，即 1 小时） |
| `DSH_DESKTOP_UPDATE_CHECK_JITTER` | 环境变量。实际等待在间隔上浮动的比例（默认 `0.2`） |
| `DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS` | 环境变量。读取登录 shell 环境的上限（默认 `10000` 毫秒） |
| `splashMinMs` | 启动页最短展示时长（默认 3000ms）。内核就绪后至少再停这么久，让你看清启动日志；`0` 表示就绪即切走 |
| `tray.summonAccelerator` | 全局快捷键，一键召唤/隐藏窗口（默认 `CommandOrControl+Shift+Space`） |
| `tray.showBalance` / `rechargeUrl` | 是否显示充值入口及其地址 |
| `updates.*` | 自动更新源（仅打包版生效） |

---

## 环境要求

**只支持 Linux**（Deepin / UOS / Debian 系）。**Windows 与 macOS 不做安装包**——
本仓库不发布这两个平台的任何产物，也别提 issue 要。

**跑打包版**：本身无强制要求——缺失的运行时会被自动检测并下载（见上方「下载与安装」）。
但为了避免首次启动的大下载，机器上最好已有：

| 组件 | 最低版本 | 说明 |
|---|---|---|
| Electron | ≥ 33 | 壳的运行环境。没有会下载约 180 MB |
| Node | ≥ 22.15 | 内核用了 `zlib.createZstdDecompress`，更早的版本起不来 |
| dsh 内核 | 任意可运行版本 | 不锁版本，用你已装的 |

**开发**：Node.js ≥ 22.15.0。

**系统内核模式**（当前默认）：需要本机已装 `dsh`，`launcher.systemDsh` 指向它。
此模式下不下载 bundled 内核，内核版本就是你装的那个。

### 自检命令

```sh
# 只检测，报告缺什么（exit=1 表示有缺失，可用于脚本判断）
npm run doctor
bash tools/bootstrap.sh check

# 缺什么下什么，国内源优先，并把解析出的路径写回 config.json
npm run doctor:install
bash tools/bootstrap.sh install
```

`bootstrap.sh` 是**纯 shell** 写的，只依赖 bash + curl/wget + tar/unzip——这几样在
Debian/UOS 基础系统里必定存在。这是刻意的：它的职责是「检查 Node 在不在并把它装上」，
如果它自己需要 Node 才能运行，Node 缺失时它根本启动不了，就成了自举死循环。

---

## 开发

```sh
npm install              # 壳依赖与类型
npm test                 # 单元测试，不联网、不需要 Electron（跑完会打印通过/总数）
npm run test:all         # 再加一个真实内核的端到端测试
npm run typecheck        # tsc --noEmit
npm run doctor           # 运行时自检：Electron / Node / dsh 就绪情况
npm start                # 启动
```

### 打包

打包由 GitHub Actions 自动完成：打 `v*` tag 即产出 amd64 / arm64 两个 deb
并挂到 GitHub Release，同时同步到 Gitee Release。本仓库有两个 workflow：

| workflow | 触发 | 作用 |
|---|---|---|
| `.github/workflows/ci.yml` | push main / PR | ubuntu 跑测试 + scan-leaks |
| `.github/workflows/package-linux.yml` | 打 `v*` tag / 手动 | **deb（amd64 + arm64）打包挂 release，并同步 Gitee** |

手动触发打包（或在 Actions 页面点 Run workflow）：

```sh
gh workflow run package-linux.yml --repo westanke/dsh-desktop-deepin
```

本地打包（用 dpkg-deb 手工打，不走 electron-builder）：

```sh
bash tools/build-deb.sh amd64   # 或 arm64；第二个参数可指定版本号
```

产物在 `release/`。**本地打包不会下载内核、Node 或 Electron**——这三样由最终用户
运行时按需获取（见「下载与安装」），deb 里只有约 160 KB 的壳代码。

**离线双通道（自建，不在 release 提供）**：给无法稳定访问网络的机器打全自带包——

```sh
# 1. 先把两个官方运行时压缩包放到 release/（npmmirror 或官方源均可）
#    版本不要手写：跟随 tools/bootstrap.sh 的 NODE_WANT / ELECTRON_WANT。
#    手写的话主程序升级后会与期望版本对不上，内嵌的运行时等于白装。
ARCH_LABEL=x64      # amd64 用 x64，arm64 机器改为 arm64（与 build-deb.sh 的映射一致）
NODE_VER="$(sed -n 's/^NODE_WANT="\(.*\)"/\1/p' tools/bootstrap.sh)"
ELECTRON_VER="$(sed -n 's/^ELECTRON_WANT="\(.*\)"/\1/p' tools/bootstrap.sh)"
curl -L -o "release/node-${NODE_VER}-linux-${ARCH_LABEL}.tar.gz" \
  "https://npmmirror.com/mirrors/node/${NODE_VER}/node-${NODE_VER}-linux-${ARCH_LABEL}.tar.gz"
curl -L -o "release/electron-${ELECTRON_VER}-linux-${ARCH_LABEL}.zip" \
  "https://npmmirror.com/mirrors/electron/${ELECTRON_VER}/electron-${ELECTRON_VER}-linux-${ARCH_LABEL}.zip"

# 2. 加 --offline 打包，产物名带 -offline 后缀（约 150MB）
bash tools/build-deb.sh amd64 <版本> --offline
```

offline 包内嵌官方压缩包与对应的 `SHASUMS256.txt`：`bootstrap.sh` 检测到缺运行时
时**优先解包内置的**（校验通过后免下载直接就位），内置缺失或校验失败才回退在线
下载——一份代码，在线/离线两种产物。

### 模块布局

不依赖 Electron 的纯决策模块（可直接单测）：

| 模块 | 决定什么 |
|---|---|
| `src/window-policy.js` | 窗口能导航到哪、什么能交给系统 |
| `src/readiness.js` | 内核何时算真就绪 |
| `src/restart-policy.js` | 死掉的内核是否再给一次机会 |
| `src/directory-picker.js` | 本平台能否信任原生目录对话框 |
| `src/app-menu.js` | 应用菜单结构 |
| `src/shortcuts.js` | 接受哪些键位、按键如何投递 |
| `src/window-state.js` | 记住的窗口几何能否复用 |
| `src/exit-guard.js` | 退出前是否要问 |
| `src/safe-mode.js` | 安全模式该停用哪些 bundle |
| `src/diagnostics.js` | 崩溃报告写哪、留几份 |
| `src/fatal-recovery.js` | 崩溃后给用户哪几条路 |
| `src/login-shell-environment.js` | GUI 启动怎么补回登录 shell 的环境 |
| `src/cli-command.js` | `dsh` 命令怎么装、怎么保证不误删用户的 |
| `src/background-notice.js` | 「关窗口会不会退出」只问一次，怎么记得住 |
| `src/theme-bridge.js` | 应用的主题怎么同步到原生界面 |
| `src/update-schedule.js` | 更新检查什么时候问、失败了怎么退避 |
| `src/update-failure.js` | 每种失败该说哪句话 |
| `src/update-state.js` | 更新进度报给谁、报成什么样 |
| `src/config-file.js` | 配置如何写才不撕裂 |
| `src/desktop-commands.js` | 网页能请求哪些桌面动作 |
| `src/runtime-doctor.js` | Electron/Node/dsh 在不在、版本够不够 |
| `src/runtime-install.js` | 缺的东西从哪下、怎么校验 |

其余模块（`main.js`、`tray.js`、`kernel-*.js`、`preload.cjs`、`dom-observer.js`、
`loading-page.js`、`update.js`、`log-redact.js`、`node-runtime.js`、`shell-patch.js`）
负责 Electron 与进程 IO。其中 `preload.cjs` 的 `.cjs` 后缀是承重件：本目录受
package.json 的 `"type": "module"` 管辖，同名 `.js` 会被当成 ES Module 加载而
拿不到 `require`；它本身也必须用 `require('electron')` 取 `contextBridge`，
裸全局在该运行时不存在。

**纯 shell 例外**：`tools/bootstrap.sh` 刻意不用 Node 写。它负责「检查 Node 在不在并把它装上」，
如果它自己依赖 Node，Node 缺失时就启动不了——自举死循环。所以只用
bash + curl/wget + tar/unzip，这三样在 Debian/UOS 基础系统里必定存在。

---

## 这个项目借了谁的力

本仓库是**站在几个项目肩膀上**的社区整合，不是原创。按实际借鉴关系列清楚：

| 项目 | 借鉴了什么 | 链接 |
|---|---|---|
| **deepseek-ai/deepseek-harness** | 内核 `dsh` 本体、Web UI、插件机制。所有 agent 能力（模型、工具、会话、权限）都来自它 | <https://github.com/deepseek-ai/deepseek-harness> |
| **sleep2agi/DeepSeek-Harness-Desktop** | 本仓库的**代码基线**。窗口安全策略、就绪探测、进程树回收、日志脱敏、打包流程都源自这份社区壳 | <https://github.com/sleep2agi/DeepSeek-Harness-Desktop> |
| **citrusli2026/dsh-desktop** | 官方桌面端的行为参照：菜单/托盘/安全模式/退出确认的**设计意图**来自它的实现，以及 UOS/Deepin 适配经验（Issue #73） | <https://github.com/citrusli2026/dsh-desktop> |
| **anywhere-labs/dsh-desktop** | Linux deb 打包工艺参照：其 PR #1120 实测出「`dpkg -i` 缺依赖失败，须用 `apt install ./x.deb`」，本 README 直接采用该结论 | <https://github.com/anywhere-labs/dsh-desktop> |

`deepseek-ai/deepseek-harness` 官方 `apps/desktop` 的实现细节也作为行为基准被对照，
但它**不发布 Linux 产物**，且其私有发布单元（见下）无法获取。

---

## 与官方桌面端的差异（诚实说明）

官方 `deepseek-ai/deepseek-harness` 的 `apps/desktop` 明确写着「Linux 不是受支持的
Desktop 发布目标」。其部分能力**无法获取**，因为它们不是公开包，而是与签名产物绑定的
私有发布单元：

- 私有 Desktop Host 包（带 `desktop` 的包名在 npm 上 404）
- `dsh-app://app` 打包 Web 入口、`desktop-runtime.json` 签名校验
- 内置 Python / Node / pnpm 三件套分发
- 官方 COS 更新源、Windows EV 签名与 macOS 公证
- 平台账号登录（PKCE）

**能复刻的已做**：官方 README 点名 Linux 的三处（目录选择器降级、快捷键 DOM 分发、
保留应用菜单与 Edit 菜单）加通用项（关于面板、DevTools 快捷键、默认端口 19387、
权限全拒、窗口几何、崩溃日志、退出确认）。

**只能近似的**：退出前「是否有任务在跑」的查询。官方通过私有 IPC 问 Host，本壳没有
这条通道，因此改为可配置策略（默认每次都问）。

**一处刻意的架构差异**：官方用 `ELECTRON_RUN_AS_NODE=1` + `--expose-internals` 把
Electron 当 Node 跑内核（目标是不依赖系统 Node）；本壳用真 Node。后者已真机验证，
更稳，故保留。

---

## 独立性

代码全部依据公开来源编写，依赖均为公开包。不含私有产品代码、组织专属品牌、
认证客户端、私有端点、更新源、凭据或遥测。`npm run scan:leaks` 在 CI 中对此做强制检查。

本项目与 DeepSeek 无隶属或背书关系。

## 许可证

本仓库代码 MIT，见 [LICENSE](LICENSE)。随包分发上游 `@deepseek-ai/dsh` 内核（同为 MIT）。
第三方组件保留各自许可证，归属声明见 [NOTICE](NOTICE)。
