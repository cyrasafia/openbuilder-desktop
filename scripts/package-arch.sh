#!/usr/bin/env bash
# 构建 Arch Linux 安装包（.pkg.tar.zst）
# 流程：electron-vite build → electron-builder --dir（unpacked，绕开 fpm 的 libcrypt 依赖）
#       → 组装 packaging/arch → makepkg
# 产物：release/arch/openbuilder-desktop-<ver>-<rel>-x86_64.pkg.tar.zst
# 版本号：从 package.json 读取 pkgver；build number（pkgrel）从已有包文件自动递增
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
npx electron-builder --linux dir --config electron-builder.config.ts

ARCH_DIR=release/arch
mkdir -p "$ARCH_DIR"

# pkgver 取自 package.json（去引号取值）
PKGVER=$(node -e "console.log(require('./package.json').version)")
# pkgrel 自动递增：扫描已有包文件取最大 rel，+1；无包则从 1 起
MAXREL=0
for f in "$ARCH_DIR"/openbuilder-desktop-"$PKGVER"-*-x86_64.pkg.tar.zst; do
  [ -f "$f" ] || continue
  rel=$(basename "$f" | sed -nE "s/^openbuilder-desktop-${PKGVER}-([0-9]+)-x86_64\.pkg\.tar\.zst$/\1/p")
  [ -n "$rel" ] && [ "$rel" -gt "$MAXREL" ] && MAXREL=$rel
done
PKGREL=$((MAXREL + 1))

# 生成 PKGBUILD（从 packaging/arch 模板替换 pkgver/pkgrel）
sed -e "s/^pkgver=.*/pkgver=${PKGVER}/" -e "s/^pkgrel=.*/pkgrel=${PKGREL}/" \
  packaging/arch/PKGBUILD > "$ARCH_DIR/PKGBUILD"
cp packaging/arch/openbuilder-desktop.install "$ARCH_DIR/"

rm -rf "$ARCH_DIR/icons"
cp -r build/icons "$ARCH_DIR/icons"

echo "==> 构建 openbuilder-desktop ${PKGVER}-${PKGREL}"
cd "$ARCH_DIR"
makepkg -f
ls -la ./*.pkg.tar.zst
