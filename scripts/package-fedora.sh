#!/usr/bin/env bash
# 构建 Fedora 安装包（.rpm）
# 流程：electron-vite build → electron-builder --dir（unpacked）
#       → 组装 Source0 tarball → 在 fedora:41 容器内 rpmbuild（本机无 rpmbuild）
# 产物：release/fedora/out/RPMS/x86_64/openbuilder-desktop-<ver>-1.fc41.x86_64.rpm
# 中间产物：默认在**打包成功后**清理（release/fedora/src 组装件与残留 .rpmbuild.*、
#           release/linux-unpacked）；构建失败不清理，便于排查。显式保留：--keep-intermediates
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEEP_INTERMEDIATES=0
case "${1:-}" in
  "") ;;
  --keep-intermediates|--keep) KEEP_INTERMEDIATES=1 ;;
  -h|--help)
    echo "用法: $0 [--keep-intermediates]"
    echo "  默认：打包成功后清理中间产物（release/fedora/src + .rpmbuild.* + release/linux-unpacked）"
    exit 0
    ;;
  *) echo "未知参数: $1（可用 --keep-intermediates）" >&2; exit 2 ;;
esac

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

# _topdir 每次运行唯一：并发或残留构建若共用固定的 out/BUILD，一方收尾会删掉
# 另一方正在打包的 BUILDROOT，中途文件消失即报
# "cpio: open failed - No such file or directory"（resources.pak 等）。
# _rpmdir 仍指向 out/RPMS，产物落点不变。
RPMBUILD_TOPDIR="$FED_DIR/.rpmbuild.$$.$RANDOM"

# 容器内 rpmbuild（挂载整个仓库；产物属主修正为当前用户）
docker run --rm \
  -v "$PWD:/repo" \
  -w /repo/release/fedora \
  fedora:41 \
  bash -c '
    set -uo pipefail
    dnf install -y -q rpm-build >/dev/null
    topdir=/repo/'"$RPMBUILD_TOPDIR"'
    mkdir -p "$topdir"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
    rpmbuild --define "_topdir $topdir" \
             --define "_rpmdir $PWD/out/RPMS" \
             --define "_sourcedir $PWD/src" \
             -bb /repo/packaging/fedora/openbuilder-desktop.spec
    rc=$?
    # topdir 与产物属主由容器内 root 一并处理：宿主机 rm 会撞上 root 属主
    chown -R '"$(id -u)"':'"$(id -g)"' "$PWD/out/RPMS"
    rm -rf "$topdir"
    exit $rc
  '

ls -la "$FED_DIR"/out/RPMS/x86_64/*.rpm

# 打包成功后清理中间产物（失败路径不触发：set -e 在此前已退出，便于排查）
cd "$ROOT"
if [ "$KEEP_INTERMEDIATES" -eq 0 ]; then
  before=$(du -sb "$FED_DIR/src" release/linux-unpacked 2>/dev/null | awk '{s+=$1} END{print s+0}')
  rm -rf "$FED_DIR/src"
  rm -rf "$FED_DIR"/.rpmbuild.*
  rm -rf release/linux-unpacked
  echo "==> 已清理中间产物（fedora src 组装件 + .rpmbuild.* + linux-unpacked），释放 $(( before/1024/1024 )) MB；如需保留用 --keep-intermediates"
else
  echo "==> 保留中间产物（--keep-intermediates）"
fi
