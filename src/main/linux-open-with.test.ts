/**
 * Linux「打开方式」纯函数（design-linux-open-with §1.1）：
 * parseDesktopEntry（段过滤/本地化名/NoDisplay/MimeType）。
 * 子进程与文件系统路径（listOpenWithApps/openWithApp）不做单测——真机 E2E 覆盖。
 */
import { describe, expect, it } from "vitest"
import { parseDesktopEntry } from "./linux-open-with"

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
