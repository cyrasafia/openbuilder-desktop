#!/usr/bin/env bash
# 构建 Arch Linux 安装包（.pkg.tar.zst）
# 流程：electron-vite build → electron-builder --dir（unpacked，绕开 fpm 的 libcrypt 依赖）
#       → 组装 packaging/arch → makepkg
# 产物：release/arch/openbuilder-desktop-<ver>-<rel>-x86_64.pkg.tar.zst
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
npx electron-builder --linux dir --config electron-builder.config.ts

ARCH_DIR=release/arch
mkdir -p "$ARCH_DIR"
cp packaging/arch/PKGBUILD packaging/arch/openbuilder-desktop.install "$ARCH_DIR/"
cp -r build/icons "$ARCH_DIR/icons"

cd "$ARCH_DIR"
makepkg -f
ls -la ./*.pkg.tar.zst
