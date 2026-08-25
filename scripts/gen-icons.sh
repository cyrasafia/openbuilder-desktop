#!/usr/bin/env bash
# 从 build/icon-source.png（openbuilder 移动端同源图标，1080x1080）生成全套应用图标：
#   build/icon.png                1024x1024，electron-builder buildResources 入口（Linux）
#   build/icons/{16..512}.png     hicolor 尺寸集（Arch/Fedora 打包 + 运行时窗口图标）
#   build/icon.ico                Windows 多尺寸（16~256）
#   build/icon.icns               macOS（scripts/gen-icns.mjs，无第三方依赖）
# 依赖：ImageMagick 7（magick）、node
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=build/icon-source.png
[ -f "$SRC" ] || { echo "缺少 $SRC" >&2; exit 1; }

mkdir -p build/icons
for s in 16 24 32 48 64 128 256 512; do
  magick "$SRC" -resize "${s}x${s}" "build/icons/$s.png"
done

magick "$SRC" -resize 1024x1024 build/icon.png

magick build/icons/16.png build/icons/24.png build/icons/32.png \
  build/icons/48.png build/icons/64.png build/icons/128.png \
  build/icons/256.png build/icon.ico

node scripts/gen-icns.mjs

file build/icon.png build/icon.ico build/icon.icns
ls -la build/icons/
