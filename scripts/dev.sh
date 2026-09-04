#!/usr/bin/env bash
# 安装依赖并启动开发模式（electron-vite dev）
# Wayland 下如遇 Vulkan 崩溃，可加参数：./scripts/dev.sh --disable-gpu
set -euo pipefail
cd "$(dirname "$0")/.."

# --no-audit/--no-fund：audit 是向 registry 的 bulk POST，本机网络下会长时间
# 无响应把启动卡死在 install 尾声（debug log 停在 "silly audit"）；启动脚本
# 只装依赖，审计/资助信息无消费方，直接关闭
npm install --no-audit --no-fund

# electron 的 postinstall 可能被跳过（如 ignore-scripts 或安装中断），导致 dist/path.txt
# 缺失、electron-vite 启动报 "Electron uninstall"。检测到缺失时补跑下载。
if [ ! -f node_modules/electron/path.txt ] || [ ! -d node_modules/electron/dist ]; then
  node node_modules/electron/install.js
fi

# Electron 需要 DISPLAY 或 WAYLAND_DISPLAY 之一，缺了 ozone 图形平台直接初始化失败退出。
# 从 systemd user 服务等无图形上下文启动（如 opencode serve 托管）时两者为空：
# 依次尝试 systemd user manager 环境（graphical 会话登录后导入）→ then socket 直接探测。
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  se="$(systemctl --user show-environment 2>/dev/null || true)"
  for var in DISPLAY WAYLAND_DISPLAY XAUTHORITY; do
    value="$(sed -n "s/^${var}=//p" <<<"$se" || true)"
    if [ -n "$value" ]; then
      export "$var=$value"
    fi
  done
fi
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/wayland-0" ]; then
  export WAYLAND_DISPLAY=wayland-0
fi
if [ -z "${DISPLAY:-}" ] && [ -S /tmp/.X11-unix/X0 ]; then
  export DISPLAY=:0
  if [ -z "${XAUTHORITY:-}" ]; then
    auth="$(find "/run/user/$(id -u)" -maxdepth 1 -name '.mutter-Xwaylandauth.*' 2>/dev/null | head -1 || true)"
    if [ -n "$auth" ]; then
      export XAUTHORITY="$auth"
    fi
  fi
fi
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "警告：未检测到图形会话（DISPLAY / WAYLAND_DISPLAY 均为空），Electron 窗口将无法启动" >&2
fi

exec npm run dev -- "$@"
