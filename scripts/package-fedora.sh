#!/usr/bin/env bash
# 构建 Fedora 安装包（.rpm）
# 流程：electron-vite build → electron-builder --dir（unpacked）
#       → 组装 Source0 tarball → 在 fedora:41 容器内 rpmbuild（本机无 rpmbuild）
# 产物：release/fedora/out/RPMS/x86_64/openbuilder-desktop-<ver>-1.fc41.x86_64.rpm
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
npx electron-builder --linux dir --config electron-builder.config.ts

FED_DIR=release/fedora
mkdir -p "$FED_DIR/src" "$FED_DIR/out"

VERSION=$(jq -r .version package.json)

# 同步 spec 文件版本号
sed -i "s/^Version:.*/Version: $VERSION/" packaging/fedora/openbuilder-desktop.spec

# Source0：app/ = linux-unpacked 内容（spec 内 %setup 展开后即为 app/）
STAGE="$FED_DIR/src/openbuilder-desktop-$VERSION"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -a release/linux-unpacked/. "$STAGE/app"
cp packaging/fedora/openbuilder-desktop.desktop "$FED_DIR/src/"
cp -r build/icons "$STAGE/icons"

tar -cJf "$FED_DIR/src/openbuilder-desktop-$VERSION.tar.xz" -C "$FED_DIR/src" \
  openbuilder-desktop-$VERSION openbuilder-desktop.desktop

# 容器内 rpmbuild（挂载整个仓库；产物属主修正为当前用户）
docker run --rm \
  -v "$PWD:/repo" \
  -w /repo/release/fedora \
  fedora:41 \
  bash -c '
    set -euo pipefail
    dnf install -y -q rpm-build >/dev/null
    mkdir -p out/BUILD out/RPMS out/SOURCES out/SPECS out/SRPMS
    rpmbuild --define "_topdir $PWD/out" \
             --define "_sourcedir $PWD/src" \
             -bb /repo/packaging/fedora/openbuilder-desktop.spec
    chown -R '"$(id -u)"':'"$(id -g)"' out
  '

ls -la "$FED_DIR"/out/RPMS/x86_64/*.rpm
