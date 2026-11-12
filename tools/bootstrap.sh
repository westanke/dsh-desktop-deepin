#!/usr/bin/env bash
# 运行时自举：在没有任何 Node/Electron 的机器上把壳跑起来。
#
# 为什么必须用纯 shell 写：这个脚本的职责就是「检查 Node 在不在并把它装上」，
# 如果它自己需要 Node 才能运行，那么 Node 缺失时它根本启动不了——一个自举
# 循环。所以这里只用 bash + curl/wget + tar/unzip，这些在 Debian/UOS 基础
# 系统里必定存在。
#
# 检测顺序：config.json 指定 → PATH → 常见安装位置 → 私有运行时目录。
# 缺失时优先从国内镜像下载（上游源在大陆经常不可达）。
#
# 用法：
#   bootstrap.sh check     只检测，报告缺什么（exit 1 表示有缺失）
#   bootstrap.sh install   检测并下载缺失项
#   bootstrap.sh run       保证就绪后启动壳
set -uo pipefail

# 用 bash 参数展开取目录，不调用外部 dirname —— 这个脚本要能在
# 工具极度精简的环境里跑起来，任何外部命令依赖都是风险。
SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
[ "$SCRIPT_DIR" = "$SCRIPT_PATH" ] && SCRIPT_DIR="."
SHELL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$SHELL_DIR/config.json"
# 每用户覆盖配置：全局 /opt/.../config.json 只读，用户改的东西落这里。
USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-desktop"
USER_CONFIG="$USER_CONFIG_DIR/config.json"
RUNTIME_DIR="${HOME}/.dsh-desktop/runtime"

# 检测结果里的 Electron 状态：空 = 没找到；1 = 找到了但版本旧于本壳要装的
# 那版（能跑，该升级）；2 = 找到了且版本达标。
ELECTRON_OUTDATED=0

# 国内镜像（全部实测可用）。顺序即优先级。
NODE_MIRRORS=(
  "https://npmmirror.com/mirrors/node"
  "https://mirrors.huaweicloud.com/nodejs"
)
ELECTRON_MIRRORS=(
  "https://npmmirror.com/mirrors/electron"
  "https://mirrors.huaweicloud.com/electron"
)
NPM_REGISTRY="https://registry.npmmirror.com"

# 版本要求：内核用到 zlib.createZstdDecompress，Node 22.15 起才有；
# Electron 下限是本壳开发验证过的版本，更高版本同样接受。
NODE_WANT="v24.19.0"
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=15
# ELECTRON_WANT 是「本壳默认要装的那一版」；ELECTRON_MIN_MAJOR 是「能跑的最低
# 主版本」（对外承诺：装 33 也能跑，别把用户挡在门外）。两者不是一回事：
#   - 低于 MIN_MAJOR → 不可用，必须换；
#   - 高于 MIN_MAJOR 但低于 WANT → 能跑，但本壳已经按 WANT 验证过，应当升级。
# 只看 MIN_MAJOR 的话，升级壳之后的老用户会一直卡在旧 Electron 上：版本判定
# 通过 → 不下载 → 仍跑旧版本，升级等于没发生。
ELECTRON_WANT="v45.3.0"
ELECTRON_MIN_MAJOR=33

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

# ── 工具可用性 ──────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

# 基础命令预检：缺了就没法自举，必须明确报出来而不是中途神秘失败。
require_basics() {
  local missing="" c
  for c in mkdir rm cp mv sed grep head tar; do
    have "$c" || missing="$missing $c"
  done
  if ! have curl && ! have wget; then
    missing="$missing curl/wget"
  fi
  if ! have unzip && [ "${NEED_UNZIP:-0}" = "1" ]; then
    missing="$missing unzip"
  fi
  if [ -n "$missing" ]; then
    bad "缺少基础命令：$missing"
    say ""
    say "  这些是自举所需的工具，请先安装："
    say "    sudo apt install coreutils sed grep tar gzip curl unzip"
    return 1
  fi
  return 0
}

# 下载到文件，返回 0/1。curl 优先，wget 兜底。跟随重定向。
fetch() {
  local url="$1" dest="$2"
  if have curl; then
    curl -fSL --retry 2 --connect-timeout 20 -o "$dest" "$url" 2>/dev/null
  elif have wget; then
    wget -q -O "$dest" "$url"
  else
    return 1
  fi
}

# 校验下载产物的 sha256。期望值取自与产物同镜像的 SHASUMS256.txt——镜像若被
# 投毒，攻击者还得同时篡改上游签名的清单文件，难度完全不同。清单拉不到时
# 降级为只信 HTTPS 来源并明确告警（与 runtime-install.js 的降级策略一致）。
#   verify_sha256 <archive> <fileName> <version> <mirror> <kind> [manifestFile]
# 传入 manifestFile（offline deb 内嵌的清单）时离线校验，不访问网络。
verify_sha256() {
  local file="$1" name="$2" ver="$3" mirror="$4" kind="$5"
  local manifest_file="${6:-}"
  have sha256sum || { say "  ⚠ 无 sha256sum，跳过校验（仅信 HTTPS 来源）"; return 0; }
  local expected actual manifest_src
  if [ -n "$manifest_file" ] && [ -f "$manifest_file" ]; then
    manifest_src="$manifest_file"
    expected="$(grep -E "^[0-9a-f]{64}[[:space:]]+\*?$name\$" "$manifest_src" | awk '{print $1}')" || true
  else
    manifest_src="$RUNTIME_DIR/SHASUMS256.$kind.$ver.txt"
    expected="$(fetch "$mirror/$ver/SHASUMS256.txt" "$manifest_src" \
      && grep -E "^[0-9a-f]{64}[[:space:]]+\*?$name\$" "$manifest_src" \
      | awk '{print $1}')" || true
    rm -f "$manifest_src" 2>/dev/null
  fi
  if [ -z "$expected" ]; then
    say "  ⚠ 未获得 $name 的校验值，跳过校验（仅信 HTTPS 来源）"
    return 0
  fi
  actual="$(sha256sum "$file" | awk '{print $1}')"
  if [ "$actual" = "$expected" ]; then
    ok "sha256 校验通过"
    return 0
  fi
  bad "sha256 校验失败：期望 $expected，实际 $actual"
  return 1
}

# 离线缓存解包：offline deb 自带 runtimes/ 目录（官方压缩包 + 内嵌清单）。
# 命中就直接解包到 RUNTIME_DIR，跳过一切网络；文件不存在则返回 1 走在线下载。
#   try_offline_unpack <kind: node|electron> <version> <fileName>
try_offline_unpack() {
  local kind="$1" ver="$2" file="$3"
  local bundled="$SHELL_DIR/runtimes"
  local src="$bundled/$file"
  local manifest="$bundled/SHASUMS256.$kind.$ver.txt"
  [ -f "$src" ] || return 1
  say "发现离线内置运行时：$file（免下载）"
  # 内嵌清单存在就校验；不存在（打包时拉取失败）则告警放行
  if [ -f "$manifest" ]; then
    verify_sha256 "$src" "$file" "$ver" "" "$kind" "$manifest" || {
      bad "离线内置包校验失败——deb 可能损坏，改走在线下载"
      return 1
    }
  else
    say "  ⚠ 无内嵌清单，跳过校验"
  fi
  mkdir -p "$RUNTIME_DIR"
  local target
  if [ "$kind" = "node" ]; then
    tar -xzf "$src" -C "$RUNTIME_DIR" || { bad "解压失败"; return 1; }
    local arch arch_label
    arch="$(uname -m)"; case "$arch" in x86_64) arch_label=x64 ;; aarch64) arch_label=arm64 ;; esac
    target="$RUNTIME_DIR/node-${ver}-linux-${arch_label}/bin/node"
    chmod +x "$target" 2>/dev/null
  else
    target="$RUNTIME_DIR/electron-${ver}"
    mkdir -p "$target"
    unzip -q -o "$src" -d "$target" || { bad "解压失败"; return 1; }
    target="$target/electron"
    chmod +x "$target" 2>/dev/null
  fi
  ok "离线内置运行时已就位：$target"
  return 0
}

# uname -m → Node/Electron 官方压缩包的架构标签
arch_label() {
  local a; a="$(uname -m)"
  case "$a" in x86_64) printf x64 ;; aarch64) printf arm64 ;; *) printf "$a" ;; esac
}

# 测速：从 url 拉一小段，返回速度（字节/秒）。失败返回 0。
speed_of() {
  local url="$1" bytes="${2:-262144}" out
  if have curl; then
    out=$(curl -sSL --connect-timeout 8 --max-time 15 -r "0-$((bytes-1))" -o /dev/null \
          -w '%{speed_download}' "$url" 2>/dev/null) || out=0
  elif have wget; then
    # wget 没有直接的速度输出，用时间差估算
    local t0 t1
    t0=$(date +%s%N 2>/dev/null || echo 0)
    wget -q --timeout=15 -O /dev/null "$url" 2>/dev/null || { echo 0; return; }
    t1=$(date +%s%N 2>/dev/null || echo 0)
    [ "$t1" -gt "$t0" ] && out=$(( bytes * 1000000000 / (t1 - t0) )) || out=0
  else
    out=0
  fi
  printf '%.0f' "${out:-0}" 2>/dev/null || printf '0'
}

# 在多个镜像里挑最快的。参数：测速用的样本 URL 前缀 + 文件名，候选镜像列表。
# 输出选中的镜像（最多等 3 个候选，避免慢镜像拖太久）。
pick_fastest() {
  local version="$1" sample_file="$2"; shift 2
  local best="" best_speed=0 m url sp
  local tried=0
  for m in "$@"; do
    [ "$tried" -ge 3 ] && break
    url="$m/$version/$sample_file"
    sp=$(speed_of "$url")
    tried=$((tried + 1))
    info "测速 $m → $((sp / 1024)) KB/s" >&2
    if [ "$sp" -gt "$best_speed" ]; then best_speed="$sp"; best="$m"; fi
  done
  printf '%s' "$best"
}

# ── 读取 config.json 里的某个 launcher 值（纯 shell，不依赖 node）────────
# 用 grep/sed 抠 JSON 字符串值。配置由本项目生成，格式稳定，够用。
config_value() {
  local key="$1" v=""
  if [ -f "$USER_CONFIG" ]; then
    v="$(sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$USER_CONFIG" | head -1)"
  fi
  [ -z "$v" ] && [ -f "$CONFIG" ] && v="$(sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CONFIG" | head -1)"
  printf '%s' "$v"
}

# ── 版本比较：a >= b（按 major.minor 比较，够用）────────────────────────
version_ge() {
  local a="$1" b="$2"
  local am aj bm bj
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

# ── 版本比较：a >= b（major.minor.patch 三段全比）────────────────────────
# version_ge 只比到 minor（够用于「≥ 某个最低要求」），但拿它比两个具体版本号
# 会出现 45.3.0 与 45.9.0 判成相等的情况。判断「装的是不是本壳要的那一版」
# 需要精确到 patch，故另有一份。
version_ge3() {
  local a="$1" b="$2"
  local am aj ap bm bj bp
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

# ── 探测 Electron 版本 ─────────────────────────────────────────────────
# 优先读发行包自带的 version 文件：纯文本读取、零进程开销，且不受环境变量
# 污染。为什么不能只靠 `electron --version`：当 ELECTRON_RUN_AS_NODE=1 时
# Electron 会以 Node 模式运行，--version 报出的是它内捆的 Node 版本
# （实测 Electron 33.3.0 被报成 v20.18.1），于是被判「低于 v33 → 缺失」，
# 白白触发一次约 180MB 的重复下载。而从 dsh 壳（本身是 Electron 应用）
# 派生的进程恰好继承了这个变量，故必须兜住。
electron_version() {
  local bin="$1" vf v=""
  vf="$(dirname "$bin")/version"
  if [ -f "$vf" ]; then
    v="$(head -1 "$vf" 2>/dev/null)"
    [ -n "$v" ] && { printf 'v%s' "${v#v}"; return 0; }
  fi
  v="$(env -u ELECTRON_RUN_AS_NODE "$bin" --version 2>/dev/null || echo '?')"
  printf '%s' "$v"
}

# ── 定位一个可执行文件 ─────────────────────────────────────────────────
# 参数：配置里的值、命令名、若干候选绝对路径
locate() {
  local configured="$1" name="$2"; shift 2
  if [ -n "$configured" ] && [ -x "$configured" ]; then printf '%s' "$configured"; return 0; fi
  if have "$name"; then command -v "$name"; return 0; fi
  local c
  for c in "$@"; do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

# ── 检测 ───────────────────────────────────────────────────────────────
NODE_BIN=""; ELECTRON_BIN=""; DSH_BIN=""

detect() {
  local cfg_electron cfg_dsh cfg_nodebin
  cfg_electron="$(config_value electron || true)"
  cfg_dsh="$(config_value systemDsh || true)"
  cfg_nodebin="$(config_value nodeBinDir || true)"

  # 候选位置按「系统级 → 版本管理器 → 用户级 → 第三方包管理器 → 自举私有目录」铺开，
  # 目的是尽量复用机器上已有的运行时，避免无谓下载。glob 未匹配时保持原样、[ -x ] 会跳过。
  NODE_BIN="$(locate "${cfg_nodebin:+$cfg_nodebin/node}" node \
    /usr/local/bin/node /usr/bin/node /usr/local/nodejs/bin/node \
    /usr/local/node/bin/node /snap/bin/node \
    /opt/node/bin/node /opt/nodejs/bin/node /opt/node-*/bin/node /opt/node*/bin/node \
    /opt/apps/*/files/bin/node /opt/*/bin/node \
    /home/linuxbrew/.linuxbrew/bin/node \
    "${HOME}/.nvm/versions/node/"*/bin/node \
    "${HOME}/.fnm/node-versions/"*/installation/bin/node \
    "${HOME}/.volta/bin/node" \
    "${HOME}/.asdf/installs/nodejs/"*/bin/node "${HOME}/.asdf/shims/node" \
    "${HOME}/.nvs/"*/bin/node \
    /usr/local/n/versions/node/"${NODE_WANT}"/bin/node \
    /usr/local/n/versions/node/*/bin/node \
    "${HOME}/.local/share/pnpm/node" "${HOME}/.yarn/bin/node" \
    "${HOME}/.local/bin/node" \
    "$RUNTIME_DIR"/node-*/bin/node || true)"
  ELECTRON_BIN="$(locate "$cfg_electron" electron \
    /usr/bin/electron /usr/local/bin/electron /usr/lib/electron/electron \
    /opt/electron/electron /opt/electron*/electron /opt/*/electron \
    /opt/apps/*/files/bin/electron /snap/bin/electron \
    /usr/share/electron/electron \
    "${HOME}/.local/bin/electron" "${HOME}/.local/share/electron/"*/electron \
    "${HOME}/.cache/electron/"*/electron \
    "${HOME}/.nvm/versions/node/"*/lib/node_modules/electron/dist/electron \
    "${HOME}/.dsh-desktop/runtime/"electron-*/electron \
    "$RUNTIME_DIR"/electron-*/electron || true)"
  # 自举目录里可能同时躺着好几版（升级前 v33.3.0，升级后 v45.3.0）。glob 按
  # 字典序展开，旧版排在前面；挑版本号最大的那个，否则 locate 会把旧版选走，
  # 明明已经装好新版却仍被判「待升级」而下一次 180MB。
  if [ -n "$ELECTRON_BIN" ]; then
    local e_best="" e_ver="" ec ev
    for ec in "$RUNTIME_DIR"/electron-*/electron "${HOME}/.dsh-desktop/runtime/"electron-*/electron; do
      [ -x "$ec" ] || continue
      ev="$(electron_version "$ec")"
      if [ -z "$e_best" ] || version_ge3 "$ev" "$e_ver"; then
        e_best="$ec"; e_ver="$ev"
      fi
    done
    # 只有当自举目录里的版本比当前选中的更新时才替换
    if [ -n "$e_best" ] && version_ge3 "$e_ver" "$(electron_version "$ELECTRON_BIN")"; then
      ELECTRON_BIN="$e_best"
    fi
  fi
  # dsh 优先在「Node 所在的 bin 目录」里找：npm install -g 一定装到那个目录，
  # 这是最常见的情况（真机实测 dsh 就在 ~/.nvm/versions/node/*/bin/dsh）。
  local node_dir=""
  [ -n "$NODE_BIN" ] && node_dir="$(dirname "$NODE_BIN")"
  DSH_BIN="$(locate "$cfg_dsh" dsh \
    ${node_dir:+"$node_dir/dsh"} \
    /usr/local/bin/dsh /usr/bin/dsh /usr/local/nodejs/bin/dsh \
    /opt/nodejs/bin/dsh /opt/node/bin/dsh /opt/*/bin/dsh \
    /snap/bin/dsh \
    "${HOME}/.local/bin/dsh" "${HOME}/.yarn/bin/dsh" \
    "${HOME}/.local/share/pnpm/dsh" \
    "${HOME}/.nvm/versions/node/"*/bin/dsh \
    "${HOME}/.volta/bin/dsh" \
    "${HOME}/.asdf/shims/dsh" || true)"

  # 已装 dsh 但不在 PATH？再用常见全局 node_modules 目录探一次（覆盖 pnpm/yarn/版本管理器等）。
  if [ -z "$DSH_BIN" ] && [ -n "$NODE_BIN" ]; then
    local candidate node_dir2
    node_dir2="$(dirname "$NODE_BIN")"
    for candidate in \
      "${node_dir2%/bin}"/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
      /usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
      "${HOME}/.nvm/versions/node/"*/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
      "${HOME}/.local/share/pnpm/global/"*/node_modules/@deepseek-ai/dsh/lib/bin.js \
      "${HOME}/.config/yarn/global/node_modules/@deepseek-ai/dsh/lib/bin.js"; do
      [ -f "$candidate" ] && { DSH_BIN="$candidate"; break; }
    done
  fi
}

report() {
  say "运行时检测："
  if [ -n "$NODE_BIN" ]; then
    local v; v="$("$NODE_BIN" --version 2>/dev/null || echo '?')"
    if version_ge "$v" "v${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}"; then
      ok "Node      $v   $NODE_BIN"
    else
      bad "Node      $v   $NODE_BIN  (需要 ≥ v${NODE_MIN_MAJOR}.${NODE_MIN_MINOR})"
      NODE_BIN=""
    fi
  else
    bad "Node      未找到  (需要 ≥ v${NODE_MIN_MAJOR}.${NODE_MIN_MINOR})"
  fi

  if [ -n "$ELECTRON_BIN" ]; then
    local v; v="$(electron_version "$ELECTRON_BIN")"
    if version_ge "$v" "v${ELECTRON_MIN_MAJOR}.0"; then
      # 能跑，但版本比本壳要装的那一版旧：能跑≠该用。用户拿到的是「本壳按
      # v45 验证过」的那份，而不是碰巧还留在机器上的旧版，所以判为待升级。
      if version_ge3 "$v" "$ELECTRON_WANT"; then
        ok "Electron  $v   $ELECTRON_BIN"
      else
        info "Electron  $v   $ELECTRON_BIN  (本壳按 $ELECTRON_WANT 验证，可升级)"
        ELECTRON_BIN=""
        ELECTRON_OUTDATED=1
      fi
    else
      bad "Electron  $v   $ELECTRON_BIN  (需要 ≥ v${ELECTRON_MIN_MAJOR})"
      ELECTRON_BIN=""
    fi
  else
    bad "Electron  未找到  (需要 ≥ v${ELECTRON_MIN_MAJOR})"
  fi

  if [ -n "$DSH_BIN" ]; then
    ok "dsh 内核   $DSH_BIN"
  else
    bad "dsh 内核   未找到  (需要能运行的任意版本)"
  fi
  say ""
}

missing() {
  local m=""
  [ -z "$NODE_BIN" ] && m="$m node"
  [ -z "$ELECTRON_BIN" ] && m="$m electron"
  [ -z "$DSH_BIN" ] && m="$m dsh"
  printf '%s' "${m# }"
}

# 待升级 ≠ 缺失：机器上有一个能跑的旧版本，只是不是本壳验证过的那一版。
# 两者都触发同一条安装路径，但给人的说法要不一样——说「缺失」会让人以为
# 从没装过，去翻安装包；说「可升级」才指得对方向。
missing_label() {
  if [ "${ELECTRON_OUTDATED:-0}" = "1" ]; then
    printf 'Electron 可升级到 %s' "$ELECTRON_WANT"
  else
    printf '缺失：%s' "$(missing)"
  fi
}
# ── 安装 ───────────────────────────────────────────────────────────────
install_node() {
  say "下载 Node ${NODE_WANT}"
  say "国内镜像优先"
  # offline deb 内嵌了压缩包：直接解包，零网络
  if try_offline_unpack node "$NODE_WANT" "node-${NODE_WANT}-linux-$(arch_label).tar.gz"; then
    NODE_BIN="$(locate "$RUNTIME_DIR"/node-${NODE_WANT}-linux-*/bin/node || true)"
    [ -n "$NODE_BIN" ] && return 0
  fi
  mkdir -p "$RUNTIME_DIR"
  local arch file url dest mirror
  arch="$(uname -m)"
  case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
  file="node-${NODE_WANT}-linux-${arch}.tar.gz"
  dest="$RUNTIME_DIR/$file"

  # 先测速挑最快的镜像（多备几个地址，避免死磕最慢的那个）
  say "  正在测速选择最快的镜像…"
  local fastest=""
  fastest="$(pick_fastest "$NODE_WANT" "$file" "${NODE_MIRRORS[@]}")"
  local ordered=()
  if [ -n "$fastest" ]; then
    # 让测速胜出的镜像排在最前，其余按原顺序兜底
    for m in "${NODE_MIRRORS[@]}"; do
      [ "$m" = "$fastest" ] && ordered=("$m" "${ordered[@]}") || ordered+=("$m")
    done
  else
    ordered=("${NODE_MIRRORS[@]}")
  fi

  for mirror in "${ordered[@]}"; do
    url="$mirror/$NODE_WANT/$file"
    info "$url"
    if fetch "$url" "$dest" && verify_sha256 "$dest" "$file" "$NODE_WANT" "$mirror" node; then break; fi
    bad "该镜像失败或校验未过，换下一个"
    dest=""
  done
  [ -n "$dest" ] && [ -f "$dest" ] || { bad "所有镜像都下载失败"; return 1; }

  if have tar; then
    tar -xzf "$dest" -C "$RUNTIME_DIR" || { bad "解压失败"; return 1; }
    rm -f "$dest"
    NODE_BIN="$RUNTIME_DIR/node-${NODE_WANT}-linux-${arch}/bin/node"
    chmod +x "$NODE_BIN" 2>/dev/null
    ok "Node 已装到 $NODE_BIN"
    return 0
  fi
  bad "缺少 tar，无法解压"
  return 1
}

install_electron() {
  say "下载 Electron ${ELECTRON_WANT}"
  say "国内镜像优先，约 180MB，请耐心等待"
  # offline deb 内嵌了压缩包：直接解包，零网络
  if try_offline_unpack electron "$ELECTRON_WANT" "electron-${ELECTRON_WANT}-linux-$(arch_label).zip"; then
    ELECTRON_BIN="$(locate "$RUNTIME_DIR"/electron-${ELECTRON_WANT}/electron || true)"
    [ -n "$ELECTRON_BIN" ] && return 0
  fi
  mkdir -p "$RUNTIME_DIR"
  local arch file url dest mirror
  arch="$(uname -m)"
  case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
  file="electron-${ELECTRON_WANT}-linux-${arch}.zip"
  dest="$RUNTIME_DIR/$file"

  say "  正在测速选择最快的镜像…"
  local fastest=""
  fastest="$(pick_fastest "$ELECTRON_WANT" "$file" "${ELECTRON_MIRRORS[@]}")"
  local ordered=()
  if [ -n "$fastest" ]; then
    for m in "${ELECTRON_MIRRORS[@]}"; do
      [ "$m" = "$fastest" ] && ordered=("$m" "${ordered[@]}") || ordered+=("$m")
    done
  else
    ordered=("${ELECTRON_MIRRORS[@]}")
  fi

  for mirror in "${ordered[@]}"; do
    url="$mirror/$ELECTRON_WANT/$file"
    info "$url"
    if fetch "$url" "$dest" && verify_sha256 "$dest" "$file" "$ELECTRON_WANT" "$mirror" electron; then break; fi
    bad "该镜像失败或校验未过，换下一个"
    dest=""
  done
  [ -n "$dest" ] && [ -f "$dest" ] || { bad "所有镜像都下载失败"; return 1; }

  local target="$RUNTIME_DIR/electron-${ELECTRON_WANT}"
  if have unzip; then
    mkdir -p "$target"
    unzip -q -o "$dest" -d "$target" || { bad "解压失败"; return 1; }
    rm -f "$dest"
    ELECTRON_BIN="$target/electron"
    chmod +x "$ELECTRON_BIN" 2>/dev/null
    ok "Electron 已装到 $ELECTRON_BIN"
    return 0
  fi
  bad "缺少 unzip，无法解压"
  return 1
}

# ── 让自举下来的 Node 排在 PATH 最前 ───────────────────────────────────
# Node 官方压缩包里的 bin/npm、bin/dsh 都是 JS 脚本，首行 #!/usr/bin/env node：
# 它们按 PATH 找解释器，而不是用「旁边那个 node」。bootstrap 以前只算出 NODE_BIN
# 的绝对路径就 exec npm，PATH 一直没动，于是两类机器必坏：
#   · PATH 上没有 node（纯净系统）→ /usr/bin/env: 'node': No such file or directory
#   · PATH 上是 apt 装的旧 node（UOS / Debian 10 自带 nodejs 10.24）→ Node 24 的
#     npm 11 被 Node 10 启动，立刻失败（npm 11 的 engines 要求 Node ≥ 20）
# 两者都表现为「npm 安装失败」，且错误曾被 2>&1 吞掉 —— 这就是 Gitee IKSSLI
# （UOS 1070 arm64）报的问题。把自举 Node 的目录前置是最小且确定的修法：它同时
# 修好 npm / dsh / pnpm 三个靠 shebang 启动的工具，并随 export 传给子脚本。
use_node_bin_on_path() {
  [ -n "$NODE_BIN" ] || return 0
  local node_dir
  node_dir="$(dirname "$NODE_BIN")"
  # 判据是「排在最前」而不是「在不在」：Node 目录若已在 PATH 里但排在旧 node
  # 后面（比如用户自己的 ~/bin 在 /usr/bin 之后），那种情况同样会踩坑。
  if [ "${PATH%%:*}" != "$node_dir" ]; then
    PATH="$node_dir:$PATH"
  fi
  export PATH
  # install-plugins.sh 的 PATH 自救把它当第一优先目录（见其 ensure_node_bin_on_path）。
  DSH_NODE_BIN="$node_dir"; export DSH_NODE_BIN
}

install_dsh() {
  say "安装 dsh 内核（npm 国内源）…"
  [ -n "$NODE_BIN" ] || { bad "需要先有 Node"; return 1; }
  use_node_bin_on_path

  local node_dir npm_bin log rc
  node_dir="$(dirname "$NODE_BIN")"
  npm_bin="$node_dir/npm"
  if [ ! -x "$npm_bin" ]; then
    # 官方 Node 一定带 npm；走到这里说明拿到的是裁剪过的 Node。退回系统 npm 可以，
    # 但它同样由 #!/usr/bin/env node 启动，得靠上面已前置的 PATH 才跑得动。
    if have npm; then
      npm_bin="$(command -v npm)"
      info "Node 旁没有 npm，改用 PATH 里的：$npm_bin"
    else
      bad "找不到 npm（Node 目录与 PATH 里都没有）"
      return 1
    fi
  fi

  # 输出不再丢弃：issue 里只有「npm 安装失败」一句话，排查只能靠猜。日志落在
  # 用户自己的 runtime 目录（不写 /tmp），失败时回显尾部。
  mkdir -p "$RUNTIME_DIR"
  log="$RUNTIME_DIR/npm-install-dsh.log"
  : >"$log"

  # 先自检：npm 能跑起来再谈装包。跑不起来时把「是谁在启动它」说清楚，
  # 别再把一句「安装失败」丢给用户。
  if ! "$npm_bin" --version >>"$log" 2>&1; then
    bad "npm 无法运行：$npm_bin"
    say "  当前 PATH 首位：${PATH%%:*}"
    say "  npm 的首行是 #!/usr/bin/env node，它会按 PATH 找 node。"
    say "  自检输出：$log"
    say "  可先执行 export PATH=\"$node_dir:\$PATH\" 再重试本脚本。"
    return 1
  fi
  info "日志：$log"

  "$npm_bin" install --global --registry "$NPM_REGISTRY" @deepseek-ai/dsh@latest >>"$log" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "dsh 已通过 npm 安装（日志：$log）"
    # 立刻补上检测结果，让后面的 writeback 一次就把 systemDsh 写对，
    # 而不是等下一次 start-shell.sh 再回填。
    if [ -x "$node_dir/dsh" ]; then
      DSH_BIN="$node_dir/dsh"
      DSH_KERNEL_BIN="$DSH_BIN"; export DSH_KERNEL_BIN
    fi
    return 0
  fi

  bad "npm 安装失败（退出码 $rc）"
  say "  完整日志：$log"
  say "  最后 15 行："
  tail -n 15 "$log" 2>/dev/null | sed 's/^/    /'
  say ""
  say "  常见原因："
  say "    · 网络/镜像不可达：换网络后重试，镜像地址 ${NPM_REGISTRY}"
  say "    · 启动 npm 的 Node 不对：本脚本已把 $node_dir 放到 PATH 最前，仍有问题请贴上面日志"
  say "    · 权限不足：$RUNTIME_DIR 应归当前用户所有"
  return 1
}

# ── 把解析出的路径写回「用户覆盖份」而非全局份 ─────────────────────────
# 全局 /opt/.../config.json 保持只读（root 才写得动、且多用户会互相覆盖），
# 所以自举检测到的路径写进每个用户自己的 ~/.config/dsh-desktop/config.json。
# 改动前备份；用 sed 做定点替换，保留文件里的注释字段。
writeback() {
  mkdir -p "$USER_CONFIG_DIR"
  # 临时文件统一在此声明，if/else 两个分支都必须赋值，否则 set -u 下
  # 首次安装（用户份尚不存在、走 else 分支）会报「tmp：未绑定的变量」。
  local tmp="$USER_CONFIG.tmp.$$"
  # 底子：用户份已有则继承，否则从全局份复制（保留全局份的所有字段与注释）。
  if [ -f "$USER_CONFIG" ]; then
    cp -n "$USER_CONFIG" "$USER_CONFIG.bak-bootstrap" 2>/dev/null || true
    cp "$USER_CONFIG" "$tmp"
  else
    cp "$CONFIG" "$tmp" 2>/dev/null || { bad "找不到 $CONFIG"; return 1; }
  fi

  set_kv() {
    local key="$1" value="$2"
    local escaped; escaped=$(printf '%s' "$value" | sed 's/[&/\\]/\\&/g')
    sed -i "s|\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"${key}\": \"${escaped}\"|" "$tmp"
  }

  [ -n "$ELECTRON_BIN" ] && set_kv electron "$ELECTRON_BIN"
  [ -n "$NODE_BIN" ] && set_kv nodeBinDir "$(dirname "$NODE_BIN")"
  if [ -n "$DSH_BIN" ]; then
    case "$DSH_BIN" in
      */bin.js) : ;;  # 已经是脚本路径，直接用
      *) DSH_BIN="$(command -v "$DSH_BIN" 2>/dev/null || echo "$DSH_BIN")" ;;
    esac
    set_kv systemDsh "$DSH_BIN"
  fi

  mv "$tmp" "$USER_CONFIG"
  ok "已写回用户配置（备份：$USER_CONFIG.bak-bootstrap）"
}

# ── 主流程 ─────────────────────────────────────────────────────────────
cmd="${1:-check}"

detect

case "$cmd" in
  check)
    report
    m="$(missing)"
    if [ -z "$m" ]; then
      say "全部就绪。"
      exit 0
    fi
    say "$(missing_label)"
    say ""
    say "执行以下命令自动下载（国内源优先）："
    say "  bash $SCRIPT_DIR/bootstrap.sh install"
    exit 1
    ;;
  install)
    report
    m="$(missing)"
    if [ -z "$m" ]; then
      say "全部就绪，无需下载。"
      exit 0
    fi

    # 互斥：deb 的 postinst 会在装完后以登录用户身份后台跑一次本脚本，用户
    # 也可能同时双击启动器。两者若并发下载，会争抢同一个 runtime 目录里的
    # .partial 文件（先写完的一方 rename 后，另一方还在追加 → 产物损坏）。
    # mkdir 是原子的，拿不到锁就说明已有实例在装——直接退出即可，对方装完
    # 就是我们要的结果。
    lock="$RUNTIME_DIR/.bootstrap-install.lock"
    mkdir -p "$RUNTIME_DIR" 2>/dev/null
    if ! mkdir "$lock" 2>/dev/null; then
      say "已有安装进程在下载运行时（锁：$lock），本次跳过。"
      exit 0
    fi
    trap 'rmdir "$lock" 2>/dev/null || true' EXIT INT TERM

    require_basics || exit 1
    say "$(missing_label) —— 开始下载"
    say ""
    failed=0
    case "$m" in *electron*) install_electron || failed=1 ;; esac
    case "$m" in *node*)     install_node     || failed=1 ;; esac
    # dsh 依赖 Node，所以放在 Node 之后就绪后再试
    case "$m" in *dsh*)      install_dsh      || failed=1 ;; esac
    say ""
    if [ "$failed" -eq 0 ]; then
      writeback
      say ""
      say "完成。重新运行 start-shell.sh 即可启动。"
      # 运行时就绪后顺手装默认插件（dsh 已可用）；失败只告警不阻塞。
      # 用 || true 兜底：脚本 set -u 下任何异常都不能影响「安装成功」的结论。
      bash "$SHELL_DIR/tools/install-plugins.sh" || true
    else
      bad "有项目未能安装，请检查网络后重试"
      exit 1
    fi
    ;;
  run)
    report
    m="$(missing)"
    if [ -n "$m" ]; then
      say "$(missing_label)，先自动安装…"
      say ""
      bash "$SCRIPT_DIR/bootstrap.sh" install || exit 1
      detect
    fi
    say "启动壳…"
    exec bash "$SHELL_DIR/start-shell.sh"
    ;;
  *)
    say "用法：bootstrap.sh [check|install|run]"
    exit 2
    ;;
esac
