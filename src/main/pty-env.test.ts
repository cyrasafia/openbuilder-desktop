import { describe, expect, it } from "vitest"
import { pickPtyDisplayEnv } from "./pty-env"

describe("pickPtyDisplayEnv", () => {
  it("白名单键全量拾取（Wayland 桌面会话形态）", () => {
    expect(
      pickPtyDisplayEnv({
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-1",
        XDG_SESSION_TYPE: "wayland",
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_CURRENT_DESKTOP: "GNOME",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      }),
    ).toEqual({
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
      XDG_SESSION_TYPE: "wayland",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_CURRENT_DESKTOP: "GNOME",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    })
  })

  it("非白名单键（PATH/SHELL/NODE_ENV 等）不透传——env 会整体覆盖 server 语义", () => {
    const out = pickPtyDisplayEnv({ DISPLAY: ":0", PATH: "/usr/bin", SHELL: "/bin/fish", NODE_ENV: "development" })
    expect(out).toEqual({ DISPLAY: ":0" })
  })

  it("缺键跳过、空串视为缺失（无 X11 的纯 Wayland / 无显示环境 / win32 = 空对象或子集）", () => {
    expect(pickPtyDisplayEnv({ WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/user/1000" })).toEqual({
      WAYLAND_DISPLAY: "wayland-1",
      XDG_RUNTIME_DIR: "/run/user/1000",
    })
    expect(pickPtyDisplayEnv({ DISPLAY: "" })).toEqual({})
    expect(pickPtyDisplayEnv({ PATH: "/usr/bin" })).toEqual({})
  })
})
