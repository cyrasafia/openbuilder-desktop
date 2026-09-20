/** Ctrl/⌘+W 吞键判定单测（design-browser-tab §1.2，2026-09-19）：浏览器/PDF
 * 视图持焦时切断 Electron 默认菜单 Window>Close 加速键（CommandOrControl+W）
 * 的路径——转发只驱动关 Tab，不消费按键则整窗被关 */
import { describe, expect, it } from "vitest"
import { isTabCloseShortcut, type TabCloseInput } from "./tab-close-shortcut"

function kd(over: Partial<TabCloseInput> = {}): TabCloseInput {
  return { type: "keyDown", key: "w", code: "KeyW", control: true, meta: false, shift: false, alt: false, ...over }
}

describe("isTabCloseShortcut", () => {
  it("Ctrl+W keyDown 命中（吞加速键）", () => {
    expect(isTabCloseShortcut(kd())).toBe(true)
  })

  it("mac ⌘W（meta）命中；Linux Super+W 亦命中（与 dispatch ctrl=control||meta 判定一致）", () => {
    expect(isTabCloseShortcut(kd({ control: false, meta: true }))).toBe(true)
    expect(isTabCloseShortcut(kd({ meta: true }))).toBe(true)
  })

  it("非拉丁布局：key 非 w 但 code=KeyW 仍命中（加速键按物理键位触发，dispatch 不识别的场景）", () => {
    expect(isTabCloseShortcut(kd({ key: "ц" }))).toBe(true)
  })

  it("key 字面 w 而 code 缺失命中（key 大小写均可）", () => {
    expect(isTabCloseShortcut(kd({ code: undefined }))).toBe(true)
    expect(isTabCloseShortcut(kd({ key: "W", code: undefined }))).toBe(true)
  })

  it("Shift/Alt 组合不吞（Ctrl+Shift+W / Ctrl+Alt+W 非应用映射，默认菜单无对应加速键）", () => {
    expect(isTabCloseShortcut(kd({ shift: true }))).toBe(false)
    expect(isTabCloseShortcut(kd({ alt: true }))).toBe(false)
  })

  it("keyUp / 无修饰 / 其他键 / 非 keyDown 类型不吞", () => {
    expect(isTabCloseShortcut(kd({ type: "keyUp" }))).toBe(false)
    expect(isTabCloseShortcut(kd({ control: false, meta: false }))).toBe(false)
    expect(isTabCloseShortcut(kd({ key: "t", code: "KeyT" }))).toBe(false)
    expect(isTabCloseShortcut(kd({ type: "rawKeyDown" }))).toBe(false)
  })

  it("isAutoRepeat 不拦（与主窗口 window keydown 路径一致——dispatch 对 W 无 repeat 守卫）", () => {
    const repeat = { ...kd(), isAutoRepeat: true }
    expect(isTabCloseShortcut(repeat)).toBe(true)
  })
})
