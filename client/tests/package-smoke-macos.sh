#!/usr/bin/env bash
set -euo pipefail

client_dir="$(cd "$(dirname "$0")/.." && pwd)"
project_dir="$(cd "$client_dir/.." && pwd)"
dist_dir="${1:-$project_dir/dist}"
app_version="${2:-$(node -p "require('$client_dir/src-tauri/tauri.conf.json').version")}"
app_version="${app_version#v}"
release_version="v$app_version"
dmg="$dist_dir/MapLink-$release_version-macos-arm64.dmg"
archive="$dist_dir/MapLink-$release_version-macos-arm64.app.zip"
checksums="$dist_dir/MapLink-$release_version-macos-arm64-SHA256SUMS.txt"
max_package_bytes=$((200 * 1024 * 1024))

for asset in "$dmg" "$archive" "$checksums"; do
  [[ -f "$asset" ]] || { echo "缺少发布文件：$asset" >&2; exit 1; }
done
for package in "$dmg" "$archive"; do
  package_size="$(stat -f%z "$package")"
  (( package_size < max_package_bytes )) || { echo "发布包必须小于 200 MB：$(basename "$package") 当前为 $package_size 字节" >&2; exit 1; }
done
(
  cd "$dist_dir"
  shasum -a 256 -c "$(basename "$checksums")"
)

extract_dir="$(mktemp -d)"
ditto -x -k "$archive" "$extract_dir"
app="$extract_dir/MapLink Client.app"
frpc="$app/Contents/Resources/frpc"
[[ -d "$app" && -x "$frpc" ]] || { echo "APP 内缺少可执行 frpc" >&2; exit 1; }
[[ "$("$frpc" --version)" == "0.71.0" ]] || { echo "APP 内 frpc 版本错误" >&2; exit 1; }
codesign --verify --deep --strict "$app"

echo "macOS 完整包验证通过：MapLink ${app_version}、frpc 0.71.0、DMG、APP ZIP 和 SHA-256 均有效。"
