/**
 * Linux「打开方式」纯函数（design-linux-open-with §1.1）：
 * parseDesktopEntry（段过滤/本地化名/NoDisplay/MimeType）、
 * parseSubclasses/mimeAncestorsOf（祖先后闭包，字面匹配漏祖先声明应用的修复）。
 * 子进程与文件系统路径（listOpenWithApps/openWithApp）不做单测——真机 E2E 覆盖。
 */
import { describe, expect, it } from "vitest"
import {
  iconPathOf,
  iconPixmapCaseInsensitiveOf,
  mimeAncestorsOf,
  parseDesktopEntry,
  parseInherits,
  parseSubclasses,
  sanitizedChildEnv,
  themeChainOf,
} from "./linux-open-with"

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

  it("Icon= 透传（缺省 undefined）", () => {
    expect(parseDesktopEntry(ENTRY("Name=N\nExec=x\nIcon=org.gnome.Nautilus\n"), "en")!.icon).toBe(
      "org.gnome.Nautilus",
    )
    expect(parseDesktopEntry(ENTRY("Name=N\nExec=x\n"), "en")!.icon).toBeUndefined()
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

describe("parseInherits / themeChainOf", () => {
  it("Inherits 解析：逗号列表去空白去重", () => {
    expect(parseInherits("[Icon Theme]\nInherits=AdwaitaLegacy, hicolor\n")).toEqual([
      "AdwaitaLegacy",
      "hicolor",
    ])
    expect(parseInherits("[Other]\nX=1\n[Icon Theme]\nName=A\n")).toEqual([])
  })

  it("themeChainOf：Inherits 逐级解引用 + hicolor 恒兜底；环安全", () => {
    const index: Record<string, string> = {
      Custom: "[Icon Theme]\nInherits=Adwaita\n",
      Adwaita: "[Icon Theme]\nInherits=AdwaitaLegacy,hicolor\n",
      Loop: "[Icon Theme]\nInherits=Self,Other\n",
      Self: "[Icon Theme]\nInherits=Self\n",
    }
    const dirs = ["/fake/share"]
    const read = (t: string) => index[t] ?? null
    expect(themeChainOf("Custom", dirs, read)).toEqual(["Custom", "Adwaita", "AdwaitaLegacy", "hicolor"])
    // 环：不挂起
    expect(themeChainOf("Self", dirs, read)).toEqual(["Self", "hicolor"])
    // 空数据（非 hicolor 主题无 index.theme）：仍占链位 + hicolor 兜底
    expect(themeChainOf("Missing", dirs, read)).toEqual(["Missing", "hicolor"])
  })
})

describe("iconPathOf", () => {
  // 模拟五类失败场景的最小目录树（2026-08-31 真机分类：A 档位/B 主题链/C scalable-png/D pixmaps/E 悬空）
  const FILES = new Set([
    "/sys/share/icons/hicolor/64x64/apps/typora.png", // A：仅 64 档
    "/sys/share/icons/hicolor/256x256/apps/discord.png", // A：仅 256 档
    "/sys/share/icons/hicolor/48x48/apps/app48.png",
    "/sys/share/icons/Adwaita/48x48/apps/adw-app.png", // B：主题链命中
    "/sys/share/icons/AdwaitaLegacy/48x48/legacy/legacy-app.png", // B：context=legacy
    "/sys/share/icons/AdwaitaLegacy/24x24/legacy/small-legacy.png", // B+降档
    "/sys/share/icons/hicolor/scalable/apps/svg-app.svg",
    "/sys/share/icons/hicolor/scalable/apps/png-in-scalable.png", // C：scalable 放位图
    "/sys/share/pixmaps/pixmap.png",
    "/sys/share/pixmaps/CaseIcon.svg", // D：大小写 + svg
    "/sys/share/pixmaps/abs.png",
  ])
  const dirs = ["/home/share", "/sys/share"]
  const exists = (p: string) => FILES.has(p)
  const chain = ["Adwaita", "AdwaitaLegacy", "hicolor"]

  it("A：48px 无 → 档位升（64→128→256→512→96）→ 降（32→…）", () => {
    expect(iconPathOf("typora", dirs, 48, exists, chain)).toBe("/sys/share/icons/hicolor/64x64/apps/typora.png")
    expect(iconPathOf("discord", dirs, 48, exists, chain)).toBe(
      "/sys/share/icons/hicolor/256x256/apps/discord.png",
    )
  })

  it("A：同尺寸差升档优先于降档；等距时大档优先", () => {
    // 48 目标：64（差16）先于 32（差16，同距取大）
    expect(iconPathOf("e", dirs, 48, (p) => p.includes("64x64") || p.includes("32x32"), chain)).toContain(
      "64x64",
    )
  })

  it("A：仅 32px+96px 档（无 scalable/48/64/72）→ 96px 胜出（升档全序先于降档，code review 修正）", () => {
    // 距离排序会把 32 排在 96 前（|32-48|=16 < |96-48|=48）——与「升档优先」需求相反
    expect(
      iconPathOf(
        "small-and-large",
        dirs,
        48,
        (p) => p.includes("32x32") || p.includes("96x96"),
        chain,
      ),
    ).toContain("96x96")
  })

  it("B：主题链优先于 hicolor；context 目录 apps 优先 → legacy 兜底", () => {
    expect(iconPathOf("adw-app", dirs, 48, exists, chain)).toBe("/sys/share/icons/Adwaita/48x48/apps/adw-app.png")
    expect(iconPathOf("legacy-app", dirs, 48, exists, chain)).toBe(
      "/sys/share/icons/AdwaitaLegacy/48x48/legacy/legacy-app.png",
    )
    // apps 无 → 降档 legacy 命中
    expect(iconPathOf("small-legacy", dirs, 48, exists, chain)).toBe(
      "/sys/share/icons/AdwaitaLegacy/24x24/legacy/small-legacy.png",
    )
  })

  it("C：scalable/ 下 png 同样命中（svg 优先）", () => {
    expect(iconPathOf("svg-app", dirs, 48, exists, chain)).toBe("/sys/share/icons/hicolor/scalable/apps/svg-app.svg")
    expect(iconPathOf("png-in-scalable", dirs, 48, exists, chain)).toBe(
      "/sys/share/icons/hicolor/scalable/apps/png-in-scalable.png",
    )
  })

  it("绝对路径：svg/png 直用；无后缀先 .png 后 .svg", () => {
    expect(iconPathOf("/sys/share/pixmaps/abs.png", dirs, 48, exists, chain)).toBe(
      "/sys/share/pixmaps/abs.png",
    )
    expect(iconPathOf("/sys/share/pixmaps/abs", dirs, 48, exists, chain)).toBe("/sys/share/pixmaps/abs.png")
  })

  it("E：彻底未找到 → null（悬空引用，渲染层瓷片兜底）", () => {
    expect(iconPathOf("hwloc", dirs, 48, exists, chain)).toBeNull()
    expect(iconPathOf("", dirs, 48, exists, chain)).toBeNull()
  })
})

describe("iconPixmapCaseInsensitiveOf", () => {
  it("大小写不敏感 + svg（D：Icon=Alacritty vs Alacritty.svg）", () => {
    const list = (p: string) => (p === "/sys/share/pixmaps" ? ["Alacritty.svg", "Other.png"] : null)
    expect(iconPixmapCaseInsensitiveOf("Alacritty", ["/sys/share"], list)).toBe(
      "/sys/share/pixmaps/Alacritty.svg",
    )
    expect(iconPixmapCaseInsensitiveOf("alacritty", ["/sys/share"], list)).toBe(
      "/sys/share/pixmaps/Alacritty.svg",
    )
    // 目录不存在 → null；无匹配 → null
    expect(iconPixmapCaseInsensitiveOf("missing", ["/sys/share"], list)).toBeNull()
    expect(iconPixmapCaseInsensitiveOf("x", ["/no/dir"], list)).toBeNull()
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
