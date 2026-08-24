#!/usr/bin/env bash
set -euo pipefail

client_dir="$(cd "$(dirname "$0")/.." && pwd)"
project_dir="$(cd "$client_dir/.." && pwd)"
tauri_dir="$client_dir/src-tauri"
dist_dir="$project_dir/dist"
configured_version="$(node -p "require('$tauri_dir/tauri.conf.json').version")"
requested_version="${1:-$configured_version}"
requested_version="${requested_version#v}"

if [[ "$requested_version" != "$configured_version" ]]; then
  echo "发布版本与应用版本不一致：发布 $requested_version，应用 $configured_version" >&2
  exit 1
fi
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "macOS Apple Silicon 完整包必须在 arm64 macOS 上构建" >&2
  exit 1
fi

frpc="$tauri_dir/resources/frpc"
expected_frpc_hash="3ce4ba70ffce7da4026940586c5f3454df50814f4c050d6560efc556b3adef48"
if [[ ! -x "$frpc" ]]; then
  echo "缺少可执行的 macOS ARM64 frpc：$frpc" >&2
  exit 1
fi
if [[ "$("$frpc" --version)" != "0.71.0" ]]; then
  echo "内置 macOS frpc 版本不是 0.71.0" >&2
  exit 1
fi
if [[ "$(shasum -a 256 "$frpc" | awk '{print $1}')" != "$expected_frpc_hash" ]]; then
  echo "内置 macOS frpc 校验失败" >&2
  exit 1
fi

cd "$client_dir"
APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}" \
  ./node_modules/.bin/tauri build --target aarch64-apple-darwin

bundle_dir="$tauri_dir/target/aarch64-apple-darwin/release/bundle"
app_path="$bundle_dir/macos/MapLink Client.app"
dmg_path="$(find "$bundle_dir/dmg" -maxdepth 1 -type f -name '*.dmg' -print -quit)"
if [[ ! -d "$app_path" || -z "$dmg_path" || ! -f "$dmg_path" ]]; then
  echo "Tauri 未生成完整的 macOS APP 与 DMG" >&2
  exit 1
fi

bundled_frpc="$app_path/Contents/Resources/frpc"
if [[ ! -x "$bundled_frpc" || "$("$bundled_frpc" --version)" != "0.71.0" ]]; then
  echo "APP 内未正确包含官方 frpc 0.71.0" >&2
  exit 1
fi
codesign --verify --deep --strict "$app_path"

mkdir -p "$dist_dir"
release_version="v$configured_version"
release_dmg="$dist_dir/MapLink-$release_version-macos-arm64.dmg"
release_zip="$dist_dir/MapLink-$release_version-macos-arm64.app.zip"
checksum_file="$dist_dir/MapLink-$release_version-macos-arm64-SHA256SUMS.txt"
cp "$dmg_path" "$release_dmg"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$release_zip"
(
  cd "$dist_dir"
  shasum -a 256 "$(basename "$release_dmg")" "$(basename "$release_zip")" > "$(basename "$checksum_file")"
)

printf 'macOS 完整包生成完成：\n%s\n%s\n%s\n' "$release_dmg" "$release_zip" "$checksum_file"
