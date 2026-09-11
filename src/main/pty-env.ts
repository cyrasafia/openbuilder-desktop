/**
 * pty 显示环境白名单切片（design-terminal-tab §1.1 显示环境注入，2026-09-11）：
 * server 侧 pty 完全继承 server 进程 env（opencode core pty.ts `...process.env`），
 * server 若自非图形上下文启动（实证：systemd user 服务先于 GNOME 的
 * DISPLAY/WAYLAND_DISPLAY import 启动，快照永久缺显示变量），终端内 GUI 程序
 * （smerge 等）连不上显示静默失败。Electron 主进程必在图形会话内——以此处
 * env 快照回填给 createPty 的 body.env（server 合并序 payload env 优先）。
 *
 * 白名单而非全量透传：createPty env 会整体覆盖 server 语义，只补显示会话
 * 必需键；win32/darwin 这些键不存在 → 空 = no-op。
 */
const PTY_DISPLAY_ENV_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_SESSION_TYPE",
  "XDG_RUNTIME_DIR",
  "XDG_CURRENT_DESKTOP",
  "DBUS_SESSION_BUS_ADDRESS",
] as const

/** 从 env 拷贝白名单键（存在且非空才含）；纯函数供单测 */
export function pickPtyDisplayEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of PTY_DISPLAY_ENV_KEYS) {
    const v = env[key]
    if (v !== undefined && v !== "") out[key] = v
  }
  return out
}
