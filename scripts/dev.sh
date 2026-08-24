#!/usr/bin/env bash
# 安装依赖并启动开发模式（electron-vite dev）
# Wayland 下如遇 Vulkan 崩溃，可加参数：./scripts/dev.sh --disable-gpu
set -euo pipefail
cd "$(dirname "$0")/.."

npm install

# electron 的 postinstall 可能被跳过（如 ignore-scripts 或安装中断），导致 dist/path.txt
# 缺失、electron-vite 启动报 "Electron uninstall"。检测到缺失时补跑下载。
if [ ! -f node_modules/electron/path.txt ] || [ ! -d node_modules/electron/dist ]; then
  node node_modules/electron/install.js
fi

exec npm run dev -- "$@"
