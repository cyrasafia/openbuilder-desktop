/**
 * Linux「打开方式」纯函数（design-linux-open-with §1.1）：
 * parseDesktopEntry（段过滤/本地化名/NoDisplay/MimeType）、
 * parseSubclasses/mimeAncestorsOf（祖先后闭包，字面匹配漏祖先声明应用的修复）。
 * 子进程与文件系统路径（listOpenWithApps/openWithApp）不做单测——真机 E2E 覆盖。
 */
import { describe, expect, it } from "vitest"
import { mimeAncestorsOf, parseDesktopEntry, parseSubclasses, sanitizedChildEnv } from "./linux-open-with"

const ENTRY = (body: string) => `[Desktop Entry]\n${body}\n`

describe("parseDesktopEntry", () => {
  it("基础解析：Name/Exec/MimeType 分号列表", () => {
    const e = parseDesktopEntry(
      ENTRY("Type=Application\nName=Text Editor\nExec=gnome-text-editor %U\nMimeType=text/plain;application/json;"),
      "en",
    )
    expect(e).not.toBeNull()
    expect(e!.name).toBe("Text Editor")
    expect(e!.exec).toBe("gnome-text-editor %U")
    expect(e!.mimeTypes.has("application/json")).toBe(true)
    expect(e!.noDisplay).toBe(false)
  })

  it("本地化名：Name[zh_CN] > Name[zh] > Name", () => {
    const base = "Name=Editor\n"
    expect(parseDesktopEntry(ENTRY(base + "Name[zh_CN]=编辑器\n"), "zh_CN")!.name).toBe("编辑器")
    expect(parseDesktopEntry(ENTRY(base + "Name[zh]=编辑器\n"), "zh_CN")!.name).toBe("编辑器")
    // zh_CN locale 但只有 zh 条目 → 命中 zh 前缀
    expect(parseDesktopEntry(ENTRY(base + "Name[zh]=编辑器\n"), "zh")!.name).toBe("编辑器")
    // 其他语言条目不影响
    expect(parseDesktopEntry(ENTRY(base + "Name[fr]=Éditeur\n"), "zh_CN")!.name).toBe("Editor")
  })

  it("NoDisplay/Hidden=true 跳过（调用方过滤）；仅取 [Desktop Entry] 段", () => {
    const e = parseDesktopEntry(
      `[Other Section]\nName=Wrong\n[Desktop Entry]\nName=Right\nExec=x\n`,
      "en",
    )
    expect(e!.name).toBe("Right")
    // 段结束后的下一 section 停止
    const e2 = parseDesktopEntry(
      `[Desktop Entry]\nName=A\n[Actions]\nName=B\n`,
      "en",
    )
    expect(e2!.name).toBe("A")
  })

  it("注释行跳过；无 Name 返回 null；MimeType 空项过滤", () => {
    expect(parseDesktopEntry(ENTRY("# comment\nExec=x\n"), "en")).toBeNull()
    const e = parseDesktopEntry(ENTRY("Name=N\nMimeType=a;;b;\n"), "en")
    expect([...e!.mimeTypes].sort()).toEqual(["a", "b"])
  })
})

describe("parseSubclasses / mimeAncestorsOf", () => {
  it("多行链式解引用：json→json5→ecmascript→text/javascript→typescript→text/plain 全闭包", () => {
    const sub = parseSubclasses(
      [
        "# comment",
        "application/json application/json5",
        "application/json5 application/ecmascript",
        "application/ecmascript text/javascript",
        "text/javascript application/typescript",
        "application/typescript text/plain",
        "orphan", // 无祖先：跳过
      ].join("\n"),
    )
    const acc = mimeAncestorsOf("application/json", sub)
    for (const m of [
      "application/json",
      "application/json5",
      "application/ecmascript",
      "text/javascript",
      "application/typescript",
      "text/plain",
    ]) {
      expect(acc.has(m)).toBe(true)
    }
    expect(acc.has("text/html")).toBe(false)
  })

  it("环安全（父子互指不挂起）；未知 MIME 仅自身", () => {
    const sub = parseSubclasses("a b\nb a")
    const acc = mimeAncestorsOf("a", sub)
    expect(acc.has("a")).toBe(true)
    expect(acc.has("b")).toBe(true)
    expect(mimeAncestorsOf("inode/directory", sub).has("inode/directory")).toBe(true)
  })

  it("空表（subclasses 缺失）退化为仅自身 = 字面匹配", () => {
    const acc = mimeAncestorsOf("application/json", new Map())
    expect([...acc]).toEqual(["application/json"])
  })

  it("子类型多祖先去重（diamond）", () => {
    const sub = parseSubclasses("x p1\nx p2\np1 top\np2 top")
    const acc = mimeAncestorsOf("x", sub)
    expect([...acc].sort()).toEqual(["p1", "p2", "top", "x"])
  })
})

describe("sanitizedChildEnv", () => {
  it("剥离 NODE_/ELECTRON_/VITE_ 前缀（dev 注入变量不泄漏给外部应用）", () => {
    const out = sanitizedChildEnv({
      NODE_ENV: "development",
      NODE_OPTIONS: "--inspect",
      NODE_PATH: "/x/node_modules",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_RENDERER_URL: "http://localhost:5173",
      VITE_DEV_SERVER_URL: "http://localhost:5173",
      PATH: "/usr/bin",
      HOME: "/home/u",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "GNOME",
    })
    expect(out).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "GNOME",
    })
  })

  it("会话变量（DISPLAY/DBUS/locale 等）全量保留；返回拷贝不改原对象", () => {
    const env: NodeJS.ProcessEnv = { DISPLAY: ":0", NODE_ENV: "development" }
    const out = sanitizedChildEnv(env)
    expect(out.DISPLAY).toBe(":0")
    expect("NODE_ENV" in out).toBe(false)
    expect(env.NODE_ENV).toBe("development")
  })

  it("前缀匹配大小写不敏感（Windows env 名不区分大小写，node_env 同样剥离）", () => {
    const out = sanitizedChildEnv({ node_env: "development", electron_run_as_node: "1" })
    expect(out).toEqual({})
  })
})
