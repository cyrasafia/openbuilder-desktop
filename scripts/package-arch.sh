#!/usr/bin/env bash
# 构建 Arch Linux 安装包（.pkg.tar.zst）
# 流程：electron-vite build → electron-builder --dir（unpacked，绕开 fpm 的 libcrypt 依赖）
#       → 组装 packaging/arch → makepkg
# 产物：release/arch/openbuilder-desktop-<ver>-<rel>-x86_64.pkg.tar.zst
# 版本号：从 package.json 读取 pkgver；build number（pkgrel）从已有包文件自动递增
# 中间产物：默认在**打包成功后**清理（release/arch 下的 PKGBUILD/install/icons/src/pkg
#           与 release/linux-unpacked）；构建失败不清理，便于排查。显式保留：--keep-intermediates
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEEP_INTERMEDIATES=0
case "${1:-}" in
  "") ;;
  --keep-intermediates|--keep) KEEP_INTERMEDIATES=1 ;;
  -h|--help)
    echo "用法: $0 [--keep-intermediates]"
    echo "  默认：打包成功后清理中间产物（release/arch 组装件 + release/linux-unpacked）"
    echo "  --keep-intermediates（别名 --keep）：保留中间产物"
    exit 0
    ;;
  *) echo "未知参数: $1（可用 --keep-intermediates）" >&2; exit 2 ;;
esac

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

# 打包成功后清理中间产物（失败路径不触发：set -e 在此前已退出，便于排查）
cd "$ROOT"
if [ "$KEEP_INTERMEDIATES" -eq 0 ]; then
  # du 对缺失路径返回 1，在 set -e + pipefail 下会终止脚本——组内 || true 吞掉
  # 该状态（认路径缺失为正常，缺了就按 0 计），避免产物已成功却以失败退出
  before=$( { du -sb "$ARCH_DIR" release/linux-unpacked 2>/dev/null || true; } | awk '{s+=$1} END{print s+0}')
  rm -rf "$ARCH_DIR/src" "$ARCH_DIR/pkg" "$ARCH_DIR/icons"
  rm -f "$ARCH_DIR/PKGBUILD" "$ARCH_DIR/openbuilder-desktop.install"
  rm -rf release/linux-unpacked
  after=$( { du -sb "$ARCH_DIR" 2>/dev/null || true; } | awk '{s+=$1} END{print s+0}')
  echo "==> 已清理中间产物（arch 组装件 + linux-unpacked），释放 $(( (before-after)/1024/1024 )) MB；如需保留用 --keep-intermediates"
else
  echo "==> 保留中间产物（--keep-intermediates）"
fi
