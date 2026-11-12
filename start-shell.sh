#!/usr/bin/env bash
# 一键启动 DSH 社区壳（系统内核模式）。
#
# 流程：解析配置 → 判断是否首次启动 → 缺运行时则自动下载 → 回填 config.json
#       → 设环境 → 直启 Electron。
#
# 首次启动的判断依据不是「有没有装过」这种模糊状态，而是**三个运行时是否都可用**：
#   Electron ≥ 33、Node ≥ 22.15、任意可用的 dsh
# 三者齐备就直接启动（零下载、零检测开销）；缺任何一项就进入自举流程。
# 这样「重装壳」「换机器」「手动删了 runtime」都能被正确识别，不需要额外的标记文件。
set -uo pipefail

# 用 bash 参数展开取目录，不依赖 dirname —— 本脚本要在工具极简的系统上运行。
SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
[ "$SCRIPT_DIR" = "$SCRIPT_PATH" ] && SCRIPT_DIR="."
SHELL_DIR="$(cd "$SCRIPT_DIR" && pwd)"
CONFIG="$SHELL_DIR/config.json"
# 每用户覆盖配置：全局 /opt/.../config.json 只读，用户改的东西都落这里。
USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-desktop"
USER_CONFIG="$USER_CONFIG_DIR/config.json"
BOOTSTRAP="$SHELL_DIR/tools/bootstrap.sh"
RUNTIME_DIR="${HOME}/.dsh-desktop/runtime"

# 失败时若本进程是「借终端重跑自己」那一路（DSH_BOOTSTRAP_IN_TTY=1），
# 必须把窗口留住：否则 bootstrap 失败 → exit 1 → 终端一闪而过，用户只看到
# 「闪退」，真正的原因和日志路径全滚没了（Gitee IKSSLI 的闪退就是它）。
# 只在真有终端时等回车：postinst / 无 tty 的自动化路径不会因此挂住。
pause_before_exit() {
  [ "${DSH_BOOTSTRAP_IN_TTY:-}" = "1" ] || return 0
  [ -t 0 ] || return 0
  printf '\n按回车键关闭本窗口…' >&2
  read -r _ 2>/dev/null || true
}
err()  { echo "✖ $*" >&2; pause_before_exit; exit 1; }
say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

# 依赖的最低版本，与 tools/bootstrap.sh 保持一致
NODE_MIN_MAJOR=22; NODE_MIN_MINOR=15
ELECTRON_MIN_MAJOR=33
# 本壳按这一版 Electron 验证过（与 tools/bootstrap.sh 的 ELECTRON_WANT 一致）。
# MIN_MAJOR 是对外承诺的「能跑的最低版本」，两者不是一回事：只有 MIN_MAJOR
# 的话，config.json 里记着的旧版绝对路径会让升级后的壳一直跑旧 Electron。
ELECTRON_WANT="v45.3.0"

[ -f "$CONFIG" ] || err "配置文件缺失: $CONFIG"

# ── 读 config（纯 shell，不依赖 node；node 可能还没装）──────────────────
# 取值顺序：用户覆盖份 (~/.config/dsh-desktop/config.json) 优先，
#           全局份 (/opt/.../config.json) 兜底。两处都没有则空。
config_value() {
  local key="$1" v=""
  if [ -f "$USER_CONFIG" ]; then
    v="$(sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$USER_CONFIG" | head -1)"
  fi
  [ -z "$v" ] && v="$(sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CONFIG" | head -1)"
  printf '%s' "$v"
}

# 把某个 key 写进「用户覆盖份」而不是全局份。全局份保持只读，避免多用户互相
# 覆盖、也避免普通用户写不了 /opt。首次写时从全局份继承其它字段做底子。
set_user_kv() {
  local key="$1" value="$2" esc
  esc="$(printf '%s' "$value" | sed 's/[&/\\|]/\\&/g')"
  mkdir -p "$USER_CONFIG_DIR"
  # 底子：用户份已有的合并全局份，缺失则新建最小骨架
  if [ -f "$USER_CONFIG" ]; then
    cp "$USER_CONFIG" "$USER_CONFIG.tmp.$$"
  else
    cp "$CONFIG" "$USER_CONFIG.tmp.$$" 2>/dev/null || printf '{\n}\n' > "$USER_CONFIG.tmp.$$"
  fi
  sed -i "s|\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"${key}\": \"${esc}\"|" "$USER_CONFIG.tmp.$$"
  mv "$USER_CONFIG.tmp.$$" "$USER_CONFIG"
}

resolve_rel() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *)  printf '%s' "$SHELL_DIR/$1" ;;
  esac
}

version_ge() {
  local a="$1" b="$2" am aj bm bj
  am=$(printf '%s' "$a" | sed -n 's/^v\{0,1\}\([0-9]*\)\..*/\1/p')
  aj=$(printf '%s' "$a" | sed -n 's/^v\{0,1\}[0-9]*\.\([0-9]*\).*/\1/p')
  bm=$(printf '%s' "$b" | sed -n 's/^v\{0,1\}\([0-9]*\)\..*/\1/p')
  bj=$(printf '%s' "$b" | sed -n 's/^v\{0,1\}[0-9]*\.\([0-9]*\).*/\1/p')
  [ -z "$am" ] && am=0; [ -z "$aj" ] && aj=0
  [ -z "$bm" ] && bm=0; [ -z "$bj" ] && bj=0
  [ "$am" -gt "$bm" ] && return 0
  [ "$am" -lt "$bm" ] && return 1
  [ "$aj" -ge "$bj" ]
}

# 三段全比（major.minor.patch）。version_ge 只比到 minor，拿它比两个具体
# 版本号会把 45.3.0 与 45.9.0 判成相等。
version_ge3() {
  local a="$1" b="$2" am aj ap bm bj bp
  am=$(printf '%s' "$a" | sed -n 's/^v\{0,1\}\([0-9]*\)\..*/\1/p')
  aj=$(printf '%s' "$a" | sed -n 's/^v\{0,1\}[0-9]*\.\([0-9]*\)\..*/\1/p')
  ap=$(printf '%s' "$a" | sed -n 's/^v\{0,1\}[0-9]*\.[0-9]*\.\([0-9]*\).*/\1/p')
  bm=$(printf '%s' "$b" | sed -n 's/^v\{0,1\}\([0-9]*\)\..*/\1/p')
  bj=$(printf '%s' "$b" | sed -n 's/^v\{0,1\}[0-9]*\.\([0-9]*\)\..*/\1/p')
  bp=$(printf '%s' "$b" | sed -n 's/^v\{0,1\}[0-9]*\.[0-9]*\.\([0-9]*\).*/\1/p')
  [ -z "$am" ] && am=0; [ -z "$aj" ] && aj=0; [ -z "$ap" ] && ap=0
  [ -z "$bm" ] && bm=0; [ -z "$bj" ] && bj=0; [ -z "$bp" ] && bp=0
  [ "$am" -gt "$bm" ] && return 0
  [ "$am" -lt "$bm" ] && return 1
  [ "$aj" -gt "$bj" ] && return 0
  [ "$aj" -lt "$bj" ] && return 1
  [ "$ap" -ge "$bp" ]
}

# 取一个 Electron 的版本号。优先读发行包自带的 version 文件：纯文本、零进程
# 开销，且不受 ELECTRON_RUN_AS_NODE 污染（该变量为 1 时 Electron 以 Node
# 模式运行，--version 报的是内捆的 Node 版本，实测 Electron 33 报 v20.18.1）。
electron_version() {
  local bin="$1" vf v=""
  vf="$(dirname "$bin")/version"
  if [ -f "$vf" ]; then
    v="$(head -1 "$vf" 2>/dev/null)"
    [ -n "$v" ] && { printf 'v%s' "${v#v}"; return 0; }
  fi
  v="$(env -u ELECTRON_RUN_AS_NODE "$bin" --version 2>/dev/null | head -1)"
  printf '%s' "$v"
}

# ── 内核 dsh 与桌面壳启动器的区分 ───────────────────────────────────────
# 桌面壳会把「启动本壳」的命令发布成 ~/.local/bin/dsh（见 src/cli-command.js
# 的 COMMAND_NAME），那是一个百来字节的 sh shim：
#   exec '<electron>' '<壳目录>/src' '--profile' 'web' "$@"
# 它与真内核同名，而 ~/.local/bin 通常排在 PATH 最前，于是 `command -v dsh`
# 先命中的是壳自己。这不是「路径没配好」，而是「名字被抢了」，所以必须按
# 内容判真伪。判据不能只看关键词：/usr/local/nodejs/bin/dsh 指向的 bin.js
# 里同样出现 electron 字样，故取「文件很小 + 出现 electron」同时成立。
is_desktop_shell_shim() {
  local f="${1:-}" size
  [ -n "$f" ] || return 1
  [ -f "$f" ] || return 1
  size="$(wc -c <"$f" 2>/dev/null || echo 0)"
  [ "${size:-0}" -lt 4096 ] || return 1
  grep -q 'electron' "$f" 2>/dev/null
}

# ── PATH 兜底：GUI 会话会漏掉 node 的 bin 目录 ──────────────────────────
# 从桌面图标/应用菜单启动时，PATH 只有会话管理器给的那一份。本机 ~/.bashrc
# 里有 export PATH=$PATH:$NODE_HOME/bin，但 DDE 会话里的 bash 是非交互非登录
# 的，不会读 ~/.bashrc —— 于是 /usr/local/nodejs/bin 缺席，表现为插件补装时
# 报「没有 pnpm，且自动安装失败」（pnpm/npm/corepack 一起找不到）。
# 这里在任何探测之前把确实带 node 工具链的目录补回 PATH。
# 只**追加**在末尾：不抢用户已有命令的优先级，只补上原本找不到的那些；
# 前置会越过用户自己的同名命令，属于越权。
ensure_node_bin_on_path() {
  local d cfg_dirs
  cfg_dirs="$(config_value nodeBinDir || true)"
  for d in ${cfg_dirs:+"$cfg_dirs"} \
           /usr/local/nodejs/bin /usr/local/bin /usr/bin \
           /usr/local/node/bin /opt/nodejs/bin /opt/node/bin /snap/bin \
           "${HOME}/.local/share/pnpm"; do
    [ -n "$d" ] || continue
    { [ -x "$d/node" ] || [ -x "$d/pnpm" ] || [ -x "$d/npm" ]; } || continue
    case ":$PATH:" in
      *":$d:"*) ;;
      *) PATH="$PATH:$d" ;;
    esac
  done
  export PATH
}
ensure_node_bin_on_path

# ── 检测三个运行时 ─────────────────────────────────────────────────────
# 输出：ELECTRON_OK / NODE_OK / DSH_OK 三个变量，以及它们的路径。
ELECTRON=""; NODE_BIN=""; SYSTEM_DSH=""
# 检测到的 Electron 版本低于本壳验证过的那一版时置 1（能跑，但该升级）。
ELECTRON_OUTDATED=0

detect() {
  local cfg_e cfg_d cfg_n
  cfg_e="$(config_value electron || true)"
  cfg_d="$(config_value systemDsh || true)"
  cfg_n="$(config_value nodeBinDir || true)"

  # 每项按 配置 → PATH → 常见位置 → 私有 runtime 目录 依次查找。
  # Electron 例外，两条规则：
  #  1) 自举目录里可能同时躺着好几版（升级前 v33.3.0，升级后 v45.3.0），
  #     glob 按字典序展开，旧版排在前面——挑版本号最大的那个，不是第一个
  #     能执行的。
  #  2) config.json 里记的是绝对路径，用户升级壳之后那一条还指着旧版本，
  #     「配置优先」会让人一直跑旧 Electron。所以配置里的路径要过版本关：
  #     够新就照用（用户可能故意钉某个版本）；不够新但机器上已有更新的一版，
  #     用更新的；都没有就先用旧版继续跑，由 bootstrap 去升级。
  local e_best="" e_ver="" e_cfg="" e_cfgver=""
  local c
  # 候选顺序与 tools/bootstrap.sh 的 detect() 保持一致：系统级 → 版本管理器
  # （nvm/fnm/volta/asdf/nvs/n）→ 用户级 → 第三方包管理器 → 自举私有目录。
  # 两处必须是同一份名单，否则 bootstrap 装好的运行时 start-shell.sh 认不出，
  # 表现为「下载完还是说缺 electron」。glob 未匹配时保持原样，[ -x ] 自然跳过。
  # /usr/lib/electron/electron 是 deepin/UOS 发行版打包的位置，在 PATH 之外，
  # 漏掉它会让「系统已经装了 electron」的用户白等一次约 180MB 的下载。
  for c in /usr/bin/electron /usr/local/bin/electron /usr/lib/electron/electron \
           /opt/electron/electron /opt/electron*/electron /snap/bin/electron \
           "${HOME}/.local/bin/electron" "${HOME}/.local/share/electron/"*/electron \
           "${HOME}/.cache/electron/"*/electron \
           "${HOME}/.nvm/versions/node/"*/lib/node_modules/electron/dist/electron \
           "$RUNTIME_DIR"/electron-*/electron; do
    [ -x "$c" ] || continue
    local cv; cv="$(electron_version "$c")"
    if [ -z "$e_best" ] || version_ge3 "$cv" "$e_ver"; then
      e_best="$c"; e_ver="$cv"
    fi
  done
  # PATH 上的 electron 也算一个候选（发行版包装的常常不在上面的名单里）
  if have electron; then
    local cp; cp="$(command -v electron)"
    if [ -x "$cp" ]; then
      local cv; cv="$(electron_version "$cp")"
      if [ -z "$e_best" ] || version_ge3 "$cv" "$e_ver"; then
        e_best="$cp"; e_ver="$cv"
      fi
    fi
  fi
  # 配置里的路径：够新就优先（用户钉版本），不够新则让位给已更新的那一版
  if [ -n "$cfg_e" ] && [ -x "$cfg_e" ]; then
    e_cfg="$cfg_e"
    e_cfgver="$(electron_version "$cfg_e")"
    if version_ge3 "$e_cfgver" "$ELECTRON_WANT"; then
      e_best="$cfg_e"; e_ver="$e_cfgver"
    elif [ -n "$e_best" ] && version_ge3 "$e_ver" "$e_cfgver"; then
      : # 机器上已有更新的版本，用它
    else
      e_best="$cfg_e"; e_ver="$e_cfgver"
    fi
  fi
  if [ -n "$e_best" ]; then
    ELECTRON="$e_best"
    # 挑中的这版比本壳验证过的版本旧 → 标为待升级（verify() 里再确认一次）。
    version_ge3 "$e_ver" "$ELECTRON_WANT" || ELECTRON_OUTDATED=1
  fi

  if [ -n "$cfg_n" ] && [ -x "$cfg_n/node" ]; then NODE_BIN="$cfg_n/node"
  elif have node; then NODE_BIN="$(command -v node)"
  else
    local c
    # 候选顺序与 tools/bootstrap.sh 的 detect() 保持一致：系统级 → 版本管理器
    # （nvm/fnm/volta/asdf/nvs/n）→ 用户级 → 第三方包管理器 → 自举私有目录。
    # 两处必须是同一份名单，否则 bootstrap 装好的运行时 start-shell.sh 认不出，
    # 表现为「下载完还是说缺 node」。glob 未匹配时保持原样，[ -x ] 自然跳过。
    for c in /usr/local/bin/node /usr/bin/node /usr/local/nodejs/bin/node \
             /usr/local/node/bin/node /snap/bin/node \
             /opt/node/bin/node /opt/nodejs/bin/node /opt/node-*/bin/node /opt/node*/bin/node \
             /opt/apps/*/files/bin/node /opt/*/bin/node \
             /home/linuxbrew/.linuxbrew/bin/node \
             "${HOME}/.nvm/versions/node/"*/bin/node \
             "${HOME}/.fnm/node-versions/"*/installation/bin/node \
             "${HOME}/.volta/bin/node" \
             "${HOME}/.asdf/installs/nodejs/"*/bin/node "${HOME}/.asdf/shims/node" \
             "${HOME}/.nvs/"*/bin/node \
             /usr/local/n/versions/node/*/bin/node \
             "${HOME}/.local/share/pnpm/node" "${HOME}/.yarn/bin/node" \
             "${HOME}/.local/bin/node" \
             "$RUNTIME_DIR"/node-*/bin/node; do
      [ -x "$c" ] && { NODE_BIN="$c"; break; }
    done
  fi

  # 配置里的路径也要验真：历史版本曾把桌面壳 shim 回填进来（「使用内核」与
  # 实际内核不一致，真机报错日志里就是它）。验不过就当没配，继续自动探测，
  # 后面回填 config 时会顺手把它纠正。
  if [ -n "$cfg_d" ] && { [ -x "$cfg_d" ] || [ -f "$cfg_d" ]; } \
     && ! is_desktop_shell_shim "$cfg_d"; then SYSTEM_DSH="$cfg_d"
  elif have dsh && ! is_desktop_shell_shim "$(command -v dsh)"; then SYSTEM_DSH="$(command -v dsh)"
  else
    local c nd
    # dsh 优先在「Node 所在的 bin 目录」里找：npm install -g 一定装到那里，
    # 这也是 nvm 用户最常见的情况（真机实测 dsh 就在 ~/.nvm/versions/node/*/bin/dsh）。
    nd=""
    [ -n "$NODE_BIN" ] && nd="$(dirname "$NODE_BIN")"
    for c in ${nd:+"$nd/dsh"} \
             /usr/local/bin/dsh /usr/bin/dsh /usr/local/nodejs/bin/dsh \
             /opt/nodejs/bin/dsh /opt/node/bin/dsh /opt/*/bin/dsh \
             /snap/bin/dsh \
             "${HOME}/.local/bin/dsh" "${HOME}/.yarn/bin/dsh" \
             "${HOME}/.local/share/pnpm/dsh" \
             "${HOME}/.nvm/versions/node/"*/bin/dsh \
             "${HOME}/.volta/bin/dsh" \
             "${HOME}/.asdf/shims/dsh"; do
      if [ -e "$c" ] && ! is_desktop_shell_shim "$c"; then SYSTEM_DSH="$c"; break; fi
    done
    # 已装 dsh 但不在 PATH：再用常见全局 node_modules 目录探一次，覆盖
    # pnpm/yarn/版本管理器把包装到别处的情况。
    if [ -z "$SYSTEM_DSH" ] && [ -n "$NODE_BIN" ]; then
      local nd2="${NODE_BIN%/bin}"
      for c in "${nd2}/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" \
               /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
               /usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
               "${HOME}/.nvm/versions/node/"*/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
               "${HOME}/.local/share/pnpm/global/"*/node_modules/@deepseek-ai/dsh/lib/bin.js \
               "${HOME}/.volta/tools/image/packages/@deepseek-ai/dsh/lib/bin.js"; do
        [ -f "$c" ] && { SYSTEM_DSH="$c"; break; }
      done
    fi
  fi
}

# 版本是否满足要求；不满足则清空对应变量
verify() {
  if [ -n "$ELECTRON" ]; then
    # Electron with ELECTRON_RUN_AS_NODE=1 runs as plain Node, and then
    # `--version` answers with the bundled Node version (20.18.1 for Electron
    # 33) instead of the Electron version. Any process spawned from inside the
    # shell inherits that variable, so the launcher would read "v20.18.1",
    # fail the >= 33 check and claim Electron is missing — after it had just
    # been downloaded. Clearing the variable for the probe is what the shell
    # itself does before exec'ing Electron. The packaged `version` file is
    # preferred over the probe: plain text, zero process cost, same answer.
    local v; v="$(electron_version "$ELECTRON")"
    if ! version_ge "$v" "v${ELECTRON_MIN_MAJOR}.0"; then
      ELECTRON=""
    elif ! version_ge3 "$v" "$ELECTRON_WANT"; then
      # 能跑，但比本壳验证过的版本旧。旧版先继续用（不打断用户），升级交给
      # bootstrap：它知道要去哪下载。
      ELECTRON_OUTDATED=1
    fi
  fi
  if [ -n "$NODE_BIN" ]; then
    local v; v="$("$NODE_BIN" --version 2>/dev/null | head -1)"
    version_ge "$v" "v${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}" || { NODE_BIN=""; }
  fi
  # dsh 不锁版本：能跑就行
}

missing_list() {
  local m=""
  [ -z "$ELECTRON" ] && m="$m electron"
  [ -z "$NODE_BIN" ] && m="$m node"
  [ -z "$SYSTEM_DSH" ] && m="$m dsh"
  printf '%s' "${m# }"
}

# ── 首次启动判断 + 自动补齐 ─────────────────────────────────────────────
detect
verify
MISSING="$(missing_list)"

# ── 首启进度可见化 ───────────────────────────────────────────────────────
# 缺运行时且当前不在终端里（双击启动器启动，Terminal=false 无输出）时，
# 借一个终端模拟器重跑自己：检测、下载、写回配置的全过程用户都看得见，
# 避免「点了没反应、黑屏几分钟突然弹窗」的困惑。
#   DSH_BOOTSTRAP_IN_TTY=1 是防死循环标记：终端里这一轮不再转开。
#   运行时齐备的正常启动走不到这里，零变化、零弹框。
if [ -n "$MISSING" ] && [ ! -t 0 ] && [ "${DSH_BOOTSTRAP_IN_TTY:-}" != "1" ]; then
  for term in deepin-terminal x-terminal-emulator gnome-terminal konsole xfce4-terminal; do
    if command -v "$term" >/dev/null 2>&1; then
      # exec：终端进程直接替换为本脚本，窗口关闭即链条终止，无孤儿进程。
      # -e 后接命令是这几类终端模拟器通用的执行约定。
      exec env DSH_BOOTSTRAP_IN_TTY=1 "$term" -e bash "$SCRIPT_PATH"
    fi
  done
  # 找不到任何终端模拟器的极简系统 → 保持现状：后台静默下载（日志仍写 shell.log）。
fi

if [ -n "$MISSING" ]; then
  say ""
  say "════════════════════════════════════════════════════════"
  say " 首次启动：缺少运行时 -> $MISSING"
  say "════════════════════════════════════════════════════════"
  say ""
  say "壳本身很小（约 1 MB），运行时按需获取。现在开始自动下载，"
  say "全部走国内镜像并自动测速选最快的一个。"
  say ""

  [ -x "$BOOTSTRAP" ] || err "自举脚本缺失或不可执行: $BOOTSTRAP
请手动执行：bash $SHELL_DIR/tools/bootstrap.sh install"

  # deb 的 postinst 装完后会以登录用户身份在后台预下载运行时。如果那一位还
  # 在下（.bootstrap-install.lock 存在），这里排队等它，而不是抢着下载——
  # 并发会争抢同一个 runtime 目录下的 .partial 文件（先 rename 的一方把
  # 另一方还在追加的文件顶掉 → 产物损坏）。等待期间给可见进度。
  LOCK="$RUNTIME_DIR/.bootstrap-install.lock"
  if [ -d "$LOCK" ]; then
    say "检测到安装后的预下载仍在后台进行，等待它完成…"
    waited=0
    while [ -d "$LOCK" ] && [ "$waited" -lt 900 ]; do
      sleep 5
      waited=$((waited + 5))
      [ $((waited % 60)) -eq 0 ] && say "  已等待 ${waited}s…"
    done
    [ -d "$LOCK" ] || say "  预下载完成。"
  fi

  # 交给纯 shell 的 bootstrap 干活（它不依赖 node，所以 node 缺失时也能跑）。
  # 若上面的后台实例已经装完，bootstrap 会因「全部就绪」直接返回成功。
  bash "$BOOTSTRAP" install || err "运行时下载失败，请检查网络后重试：
  手动重试：bash $BOOTSTRAP install
  npm 详情：$RUNTIME_DIR/npm-install-dsh.log"

  # 下载完成后重新检测 + 校验版本
  ELECTRON=""; NODE_BIN=""; SYSTEM_DSH=""
  detect
  verify
  MISSING="$(missing_list)"
  [ -z "$MISSING" ] || err "补齐后仍缺少：$MISSING
请手动检查：bash $BOOTSTRAP check"
  say ""
  ok "运行时已全部就绪"
fi

# ── 旧版 Electron 的升级 ─────────────────────────────────────────────────
# 机器上有一个能跑的旧版本，但它不是本壳验证过的那一版。旧版本继续用也能跑，
# 但壳升级了而 Electron 没跟着升级，等于这次升级白做——所以要把它换掉。
# 与「缺失」分开处理：缺失必须先补齐才能启动，旧版是可以先跑起来再换。
#
# 后台换（不打断用户当前的启动）：180MB 的下载不该把人拦在门外。
# 用 setsid 脱离当前进程组——本脚本随后会 exec Electron 换掉自己，
# 父进程一死，普通后台任务会被一起收掉。
#
# 失败不致命：旧版本还在，下次启动还会再试。
if [ "$ELECTRON_OUTDATED" = "1" ] && [ -x "$BOOTSTRAP" ]; then
  say ""
  info "Electron 版本较旧（$(electron_version "$ELECTRON")），正在后台升级到 $ELECTRON_WANT…"
  setsid nohup bash "$BOOTSTRAP" install >"$RUNTIME_DIR/electron-upgrade.log" 2>&1 &
  say "  （进度：$RUNTIME_DIR/electron-upgrade.log；升级后下次启动生效）"
fi

# ── 推荐插件：检查 + 可见补齐 ────────────────────────────────────────────
# 运行时就绪时上面的自举块不会执行（bootstrap 一见「全部就绪」就提前返回），
# 插件也就没人装——升级用户的常态。这里补上这段：启动前检查推荐插件，缺则
# 在**可见的终端窗口**里补齐（沿用上面「借终端重跑自己」的同一套机制与
# DSH_BOOTSTRAP_IN_TTY 防死循环标记），让下载过程与报错都看得见。
# 快路径：同一壳版本下已确认齐备过 → 跳过查询，避免每次启动都拉一次 pnpm。
PLUGINS_SH="$SHELL_DIR/tools/install-plugins.sh"
# 把本脚本刚探测到的内核路径显式交给插件脚本，让它以这里为准。
# 它自己的 `command -v dsh` 会命中桌面壳 shim（~/.local/bin/dsh 排在 PATH
# 最前；真机报错日志里「使用内核: /home/wangke/.local/bin/dsh」与本脚本
# 打印的 `dsh : /usr/local/nodejs/bin/dsh` 不一致，就是这条分歧）。
export DSH_KERNEL_BIN="${SYSTEM_DSH:-}"
PLUGIN_STAMP="${HOME}/.dsh-desktop/.plugins-ok"
SHELL_VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
             "$SHELL_DIR/package.json" 2>/dev/null | head -1)"
if [ -x "$PLUGINS_SH" ] && [ -z "$MISSING" ] && [ -n "$SHELL_VER" ] \
   && [ "$(cat "$PLUGIN_STAMP" 2>/dev/null)" != "$SHELL_VER" ]; then
  MISSING_PLUGINS="$(bash "$PLUGINS_SH" check 2>/dev/null || true)"
  if [ -n "$MISSING_PLUGINS" ]; then
    if [ ! -t 0 ] && [ "${DSH_BOOTSTRAP_IN_TTY:-}" != "1" ]; then
      # 双击启动（无终端）→ 借终端模拟器重跑自己；终端里这一轮带标记，
      # 不会再转开，直接在窗口里就地补齐。
      for term in deepin-terminal x-terminal-emulator gnome-terminal konsole xfce4-terminal; do
        if command -v "$term" >/dev/null 2>&1; then
          exec env DSH_BOOTSTRAP_IN_TTY=1 "$term" -e bash "$SCRIPT_PATH"
        fi
      done
      # 极简系统连终端模拟器都没有 → 后台静默补齐，不阻塞启动（日志留档）。
      mkdir -p "${HOME}/.dsh-desktop" 2>/dev/null
      setsid nohup bash "$PLUGINS_SH" >>"${HOME}/.dsh-desktop/plugin-install.log" 2>&1 &
      MISSING_PLUGINS=""
    fi
    if [ -n "$MISSING_PLUGINS" ]; then
      say ""
      say "════════════════════════════════════════════════════════"
      say " 推荐插件补装：$MISSING_PLUGINS"
      say "════════════════════════════════════════════════════════"
      say ""
      bash "$PLUGINS_SH" || true
    fi
  fi
fi

# ── 回填 config.json（只在检测到的路径与配置不一致时写）────────────────
ELECTRON_CFG="$(config_value electron || true)"
DSH_CFG="$(config_value systemDsh || true)"
NODE_CFG="$(config_value nodeBinDir || true)"
NEW_NODE_DIR="$(dirname "$NODE_BIN")"

if [ "$ELECTRON" != "$ELECTRON_CFG" ] || [ "$SYSTEM_DSH" != "$DSH_CFG" ] || [ "$NEW_NODE_DIR" != "$NODE_CFG" ]; then
  say ""
  say "回填 config.json（检测到的路径与配置不一致）："
  [ "$ELECTRON" != "$ELECTRON_CFG" ]   && info "launcher.electron  : $ELECTRON_CFG  →  $ELECTRON"
  [ "$NEW_NODE_DIR" != "$NODE_CFG" ]  && info "launcher.nodeBinDir: $NODE_CFG  →  $NEW_NODE_DIR"
  [ "$SYSTEM_DSH" != "$DSH_CFG" ]     && info "launcher.systemDsh : $DSH_CFG  →  $SYSTEM_DSH"

  cp -n "$USER_CONFIG" "$USER_CONFIG.bak-first-run" 2>/dev/null || true
  set_user_kv electron "$ELECTRON"
  set_user_kv nodeBinDir "$NEW_NODE_DIR"
  set_user_kv systemDsh "$SYSTEM_DSH"
  ok "已写回用户配置（备份：$USER_CONFIG.bak-first-run）"
fi

# ── 环境与启动 ─────────────────────────────────────────────────────────
# userDataDir 现在默认进用户目录（~/.local/share/dsh-desktop/data-shell），
# 多用户互不干扰。先展开 ~，再交给 resolve_rel（它只懂绝对/相对，不懂 ~）。
USERDATA_RAW="$(config_value userDataDir || echo '~/.local/share/dsh-desktop/data-shell')"
case "$USERDATA_RAW" in
  '~'|'~/'*) USERDATA_RAW="$HOME/${USERDATA_RAW#\~/}" ;;
esac
USERDATA="$(resolve_rel "$USERDATA_RAW")"
TELEMETRY="$(config_value telemetryMode || echo DISABLED)"
export PATH="$NEW_NODE_DIR:$PATH"
export DSH_KERNEL_BIN="$SYSTEM_DSH"
export ELECTRON_USER_DATA="$USERDATA"
export DSH_TELEMETRY_MODE="$TELEMETRY"

# ── 时区兜底 ────────────────────────────────────────────────────────────
# Chromium/ICU 只认 IANA 正式时区名。部分国产发行版把 /etc/timezone 写成
# backward 别名（Asia/Beijing、PRC 等），ICU 解析会得到 undefined，前端随后报
# "clientTimeZone must be UTC or a valid IANA Area/Location name"。
# 只在检测到这类已知非法别名时映射成等价正式名，其余情况一律不干预，
# 避免在时区本来就正常的机器上改坏。
tz_now="${TZ:-$(cat /etc/timezone 2>/dev/null || echo '')}"
case "$tz_now" in
  Asia/Beijing|PRC|Asia/Chungking)
    export TZ="Asia/Shanghai"
    info "时区兜底：$tz_now 非 IANA 正式名（Chromium 不认），已映射为 $TZ"
    ;;
esac
mkdir -p "$USERDATA"

# DSH_HOME 解析：~ 必须展开（Node 的 path.isAbsolute('~/.dsh') 为 false，
# 不展开会被当相对路径拼到 userData 下，生成名为 ~ 的空目录）。
#
# 必须 export：本脚本自身虽然不再直接用它起内核（内核的 env 由 Electron 侧
# 的 buildKernelEnv 拼），但被本脚本调用的 install-plugins.sh 是通过
# `dsh plugin --profile web add` 装插件的，而 dsh 认的就是环境变量 DSH_HOME。
# 不导出 → 插件一律装进默认家 ~/.dsh，与本壳实际使用的家错位：把家换到别处后，
# 插件仍然装去了旧家，表现为「这个家一个插件都没有」。之前就是漏了这个 export。
HOME_SUB="$(config_value homeSubdir || echo kernel-home)"
case "$HOME_SUB" in
  '~')    DSH_HOME="$HOME" ;;
  '~/'*)  DSH_HOME="$HOME/${HOME_SUB#\~/}" ;;
  /*)     DSH_HOME="$HOME_SUB" ;;
  *)      DSH_HOME="$USERDATA/$HOME_SUB" ;;
esac
export DSH_HOME

say ""
say "▶ 启动 DSH 社区壳（系统内核模式）"
say "  shell    : $SHELL_DIR"
say "  electron : $ELECTRON"
say "  node     : $NODE_BIN"
say "  dsh      : $SYSTEM_DSH"
say "  DSH_HOME : $DSH_HOME"
say "  log      : $USERDATA/shell.log"
# 说明当前实际生效的配置文件：用户覆盖份存在时它优先，否则用全局份。
# 改配置要改「生效的那份」，写在这里让人不用翻代码就知道。
if [ -f "$USER_CONFIG" ]; then
  say "  config   : $USER_CONFIG （用户覆盖份，优先生效；要改配置改这份）"
else
  say "  config   : $CONFIG （全局份；如需个性化请在 $USER_CONFIG 创建覆盖份）"
fi
say ""

# 经终端转开的首启：提示用户这个窗口接下来的角色，避免误关。
# Electron 的 stdout/stderr 仍并入日志文件；窗口保持打开只是承载进程，
# 用户最小化即可，关闭它等于退出壳（和关闭主窗口等价）。
if [ "${DSH_BOOTSTRAP_IN_TTY:-}" = "1" ]; then
  say "✔ 运行时已就绪，正在启动主窗口……"
  say "  本终端窗口将承载应用进程：可以最小化，请勿直接关闭"
  say "  （关闭本窗口等同于退出 DeepSeek Harness Desktop）。"
  say ""
fi

cd "$SHELL_DIR"
exec "$ELECTRON" . >> "$USERDATA/shell.log" 2>&1
