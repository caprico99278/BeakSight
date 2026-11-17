#!/usr/bin/env bash
# BeakSight の起動ファイル（macOS・Linux。設計書 doc/design/2026-11-08-beaksight-root-launcher-design.md 3）。
# 使い方: bash beaksight.sh [引数]（例: bash beaksight.sh --port 4400）。受けた引数は、そのまま本体（tools/launcher/start.mjs）へ渡す。
#
# 本体の前に、条件を満たす Node.js を用意する（Windows の tools/launcher/bootstrap.ps1 と同じ決まり）。
# 1. PATH の node が package.json の engines.node を満たせば、それを使う。
# 2. 満たさない（または node がない）ときは、BeakSight 専用の置き場所 local/runtime/ に置いた Node.js のうち、条件を満たすいちばん新しいものを使う。
# 3. なければ、nodejs.org の公式の一覧（index.json）から条件を満たすいちばん新しい版を選び、公式の配布物（tar.gz）と SHASUMS256.txt を curl で
#    取ってきて、SHA-256 が合えば展開して local/runtime/node-v<版>-<環境>/ に置く。取ってくる先は nodejs.org（https）だけ。
# PC 全体の Node.js と、シェルの設定は変えない（PATH は、この起動の間だけ変える）。版の比べの決まりは start.mjs の checkNodeVersion と同じ。
#
# source で読んだときは、関数を読み込むだけで何もしない（テストで関数を確かめるため）。

if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

# 公式の配布の場所（これのほかから取ってこない）。
NODE_DIST_BASE='https://nodejs.org/dist'

# 利用者向けの文（Node.js がまだないときの文。ほかの文は start.mjs の LAUNCHER_TEXT）。
TEXT_PREPARING='BeakSight 用の Node.js（%s）を用意します。少し時間がかかります。'
TEXT_RANGE_UNREADABLE='BeakSight を起動できません。必要な Node.js の版を読めませんでした。'
TEXT_PLATFORM_UNSUPPORTED='BeakSight を起動できません。この環境に合う Node.js を自動では用意できません。'
TEXT_TOOL_MISSING='BeakSight を起動できません。Node.js を取ってくるための道具（%s）が見つかりませんでした。'
TEXT_NO_RELEASE='BeakSight を起動できません。合う版の Node.js が見つかりませんでした。'
TEXT_DOWNLOAD_FAILED='BeakSight を起動できません。Node.js を取ってこられませんでした。インターネットにつながっているかを確かめてください。'
TEXT_HASH_MISMATCH='BeakSight を起動できません。取ってきた Node.js が正しいものか確かめられませんでした。'
TEXT_EXTRACT_FAILED='BeakSight を起動できません。取ってきた Node.js を展開できませんでした。'
TEXT_MANUAL='手で入れるときは、https://nodejs.org/ から Node.js（%s）を入れてから、もう一度起動してください。'

bootstrap_error() {
  # shellcheck disable=SC2059
  printf "$1\n" "${2:-}" >&2
}

# 版（v24.22.1）が範囲を満たすか（SATISFIED・NOT_SATISFIED・UNREADABLE）を出す。
node_version_status() {
  local range="$1" version="$2" token operator major minor patch order satisfied=1 count=0 tokens
  # 正規表現は変数に入れて使う（[[ ]] の中に直に書くと、< と > の逃がし方が bash の版で変わるため）。
  local version_pattern='^v?([0-9]+)\.([0-9]+)\.([0-9]+)$'
  local comparator_pattern='^(>=|<=|>|<|=)?([0-9]+)(\.([0-9]+))?(\.([0-9]+))?$'
  if [[ ! $version =~ $version_pattern ]]; then
    echo UNREADABLE
    return
  fi
  local current_major=$((10#${BASH_REMATCH[1]})) current_minor=$((10#${BASH_REMATCH[2]})) current_patch=$((10#${BASH_REMATCH[3]}))
  read -r -a tokens <<<"$range"
  for token in ${tokens[@]+"${tokens[@]}"}; do
    count=$((count + 1))
    if [[ ! $token =~ $comparator_pattern ]]; then
      echo UNREADABLE
      return
    fi
    operator="${BASH_REMATCH[1]:-=}"
    major=$((10#${BASH_REMATCH[2]}))
    minor="${BASH_REMATCH[4]}"
    patch="${BASH_REMATCH[6]}"
    if [ -z "$patch" ] && [ "$operator" != '>=' ] && [ "$operator" != '<' ]; then
      echo UNREADABLE
      return
    fi
    minor=$((10#${minor:-0}))
    patch=$((10#${patch:-0}))
    order=0
    if [ "$current_major" -ne "$major" ]; then
      [ "$current_major" -lt "$major" ] && order=-1 || order=1
    elif [ "$current_minor" -ne "$minor" ]; then
      [ "$current_minor" -lt "$minor" ] && order=-1 || order=1
    elif [ "$current_patch" -ne "$patch" ]; then
      [ "$current_patch" -lt "$patch" ] && order=-1 || order=1
    fi
    case "$operator" in
      '>=') [ "$order" -ge 0 ] || satisfied=0 ;;
      '>') [ "$order" -gt 0 ] || satisfied=0 ;;
      '<=') [ "$order" -le 0 ] || satisfied=0 ;;
      '<') [ "$order" -lt 0 ] || satisfied=0 ;;
      *) [ "$order" -eq 0 ] || satisfied=0 ;;
    esac
  done
  if [ "$count" -eq 0 ]; then
    echo UNREADABLE
  elif [ "$satisfied" -eq 1 ]; then
    echo SATISFIED
  else
    echo NOT_SATISFIED
  fi
}

# 2 つの版（24.22.1 の形）のうち、左が新しければ成功。
version_newer() {
  local left right
  IFS=. read -r -a left <<<"$1"
  IFS=. read -r -a right <<<"$2"
  local index
  for index in 0 1 2; do
    if [ "$((10#${left[$index]}))" -gt "$((10#${right[$index]}))" ]; then return 0; fi
    if [ "$((10#${left[$index]}))" -lt "$((10#${right[$index]}))" ]; then return 1; fi
  done
  return 1
}

# index.json（ファイル。1 行に 1 つの版）から、配布物（file_key）があり、範囲を満たすいちばん新しい版（v を除く）を出す。なければ何も出さない。
select_node_release() {
  local index_file="$1" file_key="$2" range="$3" line version best=''
  while IFS= read -r line || [ -n "$line" ]; do
    [[ $line == *"\"$file_key\""* ]] || continue
    [[ $line =~ \"version\":\"v([0-9]+\.[0-9]+\.[0-9]+)\" ]] || continue
    version="${BASH_REMATCH[1]}"
    [ "$(node_version_status "$range" "v$version")" = SATISFIED ] || continue
    if [ -z "$best" ] || version_newer "$version" "$best"; then best="$version"; fi
  done <"$index_file"
  [ -n "$best" ] && printf '%s\n' "$best"
  return 0
}

# SHASUMS256.txt（ファイル）から、file_name の SHA-256 を出す（名前の完全な一致だけ）。なければ何も出さない。
expected_sha256() {
  local shasums_file="$1" file_name="$2" hash name
  while read -r hash name || [ -n "$hash" ]; do
    name="${name#\*}"
    if [ "$name" = "$file_name" ] && [[ $hash =~ ^[0-9a-fA-F]{64}$ ]]; then
      printf '%s\n' "$hash" | tr 'A-F' 'a-f'
      return 0
    fi
  done <"$shasums_file"
  return 0
}

# ファイルの SHA-256 が expected と同じなら成功（大文字と小文字を区別しない）。sha256sum か shasum -a 256 を使う。
file_sha256_matches() {
  local file="$1" expected actual
  expected="$(printf '%s' "$2" | tr 'A-F' 'a-f')"
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | cut -d ' ' -f 1)"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | cut -d ' ' -f 1)"
  else
    return 1
  fi
  [ "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" = "$expected" ]
}

# 置き場所（runtime_dir）の node-v<版>-<os>-<arch>/bin/node のうち、範囲を満たすいちばん新しいもののフォルダを出す。なければ何も出さない。
local_node_directory() {
  local runtime_dir="$1" range="$2" os="$3" arch="$4" directory name version best='' best_directory=''
  [ -d "$runtime_dir" ] || return 0
  for directory in "$runtime_dir"/node-v*-"$os"-"$arch"; do
    [ -f "$directory/bin/node" ] || continue
    name="${directory##*/}"
    [[ $name =~ ^node-v([0-9]+\.[0-9]+\.[0-9]+)- ]] || continue
    version="${BASH_REMATCH[1]}"
    [ "$(node_version_status "$range" "v$version")" = SATISFIED ] || continue
    if [ -z "$best" ] || version_newer "$version" "$best"; then
      best="$version"
      best_directory="$directory"
    fi
  done
  [ -n "$best_directory" ] && printf '%s\n' "$best_directory"
  return 0
}

# この環境の配布物の os と arch（例: linux x64）。合うものがなければ失敗。
node_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) return 1 ;;
  esac
  printf '%s %s\n' "$os" "$arch"
}

# nodejs.org から取ってくる（https だけ）。
download_node_dist() {
  curl --proto '=https' --tlsv1.2 -fsSL -o "$2" "$NODE_DIST_BASE/$1"
}

# 条件を満たす Node.js を取ってきて置き、その bin のフォルダを出す。失敗したら説明を出して失敗。
install_node_runtime() {
  local runtime_dir="$1" range="$2" os="$3" arch="$4" file_key version name work target expected tool
  for tool in curl tar; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      bootstrap_error "$TEXT_TOOL_MISSING" "$tool"
      return 1
    fi
  done
  if [ "$os" = darwin ]; then file_key="osx-$arch-tar"; else file_key="$os-$arch"; fi
  mkdir -p "$runtime_dir" || return 1
  work="$(mktemp -d "$runtime_dir/download-XXXXXX")" || return 1
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" RETURN
  if ! download_node_dist index.json "$work/index.json"; then
    bootstrap_error "$TEXT_DOWNLOAD_FAILED"
    return 1
  fi
  version="$(select_node_release "$work/index.json" "$file_key" "$range")"
  if [ -z "$version" ]; then
    bootstrap_error "$TEXT_NO_RELEASE"
    return 1
  fi
  bootstrap_error "$TEXT_PREPARING" "v$version"
  name="node-v$version-$os-$arch"
  if ! download_node_dist "v$version/SHASUMS256.txt" "$work/SHASUMS256.txt" || ! download_node_dist "v$version/$name.tar.gz" "$work/$name.tar.gz"; then
    bootstrap_error "$TEXT_DOWNLOAD_FAILED"
    return 1
  fi
  expected="$(expected_sha256 "$work/SHASUMS256.txt" "$name.tar.gz")"
  if ! file_sha256_matches "$work/$name.tar.gz" "$expected"; then
    bootstrap_error "$TEXT_HASH_MISMATCH"
    return 1
  fi
  target="$runtime_dir/$name"
  mkdir -p "$work/extracted" || return 1
  if ! tar -xzf "$work/$name.tar.gz" -C "$work/extracted" || [ ! -f "$work/extracted/$name/bin/node" ]; then
    bootstrap_error "$TEXT_EXTRACT_FAILED"
    return 1
  fi
  rm -rf "$target"
  if ! mv "$work/extracted/$name" "$target"; then
    bootstrap_error "$TEXT_EXTRACT_FAILED"
    return 1
  fi
  printf '%s\n' "$target/bin"
}

# package.json の engines.node（読めなければ空）。
engines_node_range() {
  sed -n 's/^[[:space:]]*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -n 1
}

# 使う Node.js の bin のフォルダを出す。用意できなければ説明を出して失敗。
prepare_node() {
  local range runtime_dir='local/runtime' path_node platform os arch directory
  range="$(engines_node_range)"
  path_node="$(command -v node 2>/dev/null || true)"
  if [ "$(node_version_status "$range" v0.0.0)" = UNREADABLE ]; then
    # 版の決まりを読めないとき: PATH の node があれば、版を確かめずに使う（start.mjs が注意を出す）。なければ止める。
    if [ -n "$path_node" ]; then
      dirname -- "$path_node"
      return 0
    fi
    bootstrap_error "$TEXT_RANGE_UNREADABLE"
    return 1
  fi
  if [ -n "$path_node" ] && [ "$(node_version_status "$range" "$("$path_node" --version 2>/dev/null)")" = SATISFIED ]; then
    dirname -- "$path_node"
    return 0
  fi
  if ! platform="$(node_platform)"; then
    bootstrap_error "$TEXT_PLATFORM_UNSUPPORTED"
    bootstrap_error "$TEXT_MANUAL" "$range"
    return 1
  fi
  read -r os arch <<<"$platform"
  directory="$(local_node_directory "$runtime_dir" "$range" "$os" "$arch")"
  if [ -n "$directory" ]; then
    printf '%s\n' "$PWD/$directory/bin"
    return 0
  fi
  if directory="$(install_node_runtime "$runtime_dir" "$range" "$os" "$arch")"; then
    printf '%s\n' "$PWD/$directory"
    return 0
  fi
  bootstrap_error "$TEXT_MANUAL" "$range"
  return 1
}

main() {
  local node_directory
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" || exit 1
  node_directory="$(prepare_node)" || exit 1
  export PATH="$node_directory:$PATH"
  exec "$node_directory/node" tools/launcher/start.mjs "$@"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
