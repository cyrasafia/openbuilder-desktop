/**
 * buildHtmlPreviewDocument 注入点测试（design-html-preview §3.1）：
 * 真实 head / 仅 html / 片段 / 注释诱饵 / raw-text 诱饵 / 未闭合 / template /
 * plaintext / 假闭合（</scriptx）/ 大小上限。
 */
import { describe, expect, it } from "vitest"
import { buildHtmlPreviewDocument, CSP_META } from "./html-preview"

describe("buildHtmlPreviewDocument", () => {
  it("真实 <head>：紧随其后注入", () => {
    const out = buildHtmlPreviewDocument("<html><head><title>t</title></head><body></body></html>")
    expect(out).toBe(`<html><head>${CSP_META}<title>t</title></head><body></body></html>`)
  })

  it("<header> 不误匹配 <head>；其后文本使 <head lang=en> 成假 head → 回退 <html> 补 head", () => {
    const out = buildHtmlPreviewDocument("<html><header>h</header><head lang=\"en\"></head></html>")
    expect(out).toBe(`<html><head>${CSP_META}</head><header>h</header><head lang="en"></head></html>`)
  })

  it("仅 <html>：其后补完整 <head>", () => {
    const out = buildHtmlPreviewDocument("<html><body>x</body></html>")
    expect(out).toBe(`<html><head>${CSP_META}</head><body>x</body></html>`)
  })

  it("片段（无 html/head）：前置注入", () => {
    const out = buildHtmlPreviewDocument("<div>hi</div>")
    expect(out).toBe(`${CSP_META}<div>hi</div>`)
  })

  it("注释内 <head> 诱饵：跳过，注入真实 head", () => {
    const out = buildHtmlPreviewDocument("<!-- <head> --><html><head>real</head></html>")
    expect(out).toBe(`<!-- <head> --><html><head>${CSP_META}real</head></html>`)
  })

  it("script 体内 <head> 诱饵：跳过", () => {
    const out = buildHtmlPreviewDocument('<html><script>var a = "<head>"</script><head>real</head></html>')
    expect(out).toBe(`<html><script>var a = "<head>"</script><head>${CSP_META}real</head></html>`)
  })

  it("未闭合 script：吞到文档尾 → 仅 <html> 回退补 head", () => {
    const out = buildHtmlPreviewDocument('<html><script>var a = "<head>"</html>')
    expect(out).toBe(`<html><head>${CSP_META}</head><script>var a = "<head>"</html>`)
  })

  it("template 内容惰性：其内 <head> 跳过，注入真实 head", () => {
    const out = buildHtmlPreviewDocument("<html><template><head>x</head></template><head>real</head></html>")
    expect(out).toBe(`<html><template><head>x</head></template><head>${CSP_META}real</head></html>`)
  })

  it("plaintext：吞到文档尾 → 回退", () => {
    const out = buildHtmlPreviewDocument("<html><plaintext><head>")
    expect(out).toBe(`<html><head>${CSP_META}</head><plaintext><head>`)
  })

  it("假闭合 </scriptx> 不结束 script（吞到尾）：解析器语义 = 无真实 head → 回退 <html> 补 head", () => {
    const out = buildHtmlPreviewDocument(
      "<html><script>var a = 1;</scriptx more><head>real</head></html>",
    )
    expect(out).toBe(
      `<html><head>${CSP_META}</head><script>var a = 1;</scriptx more><head>real</head></html>`,
    )
  })

  it("DOCTYPE 与 bogus comment 跳过", () => {
    const out = buildHtmlPreviewDocument('<?xml ver="1"?><!DOCTYPE html><html><head>r</head></html>')
    expect(out).toBe(`<?xml ver="1"?><!DOCTYPE html><html><head>${CSP_META}r</head></html>`)
  })

  it("超过 8 MiB：跳过扫描直接前置", () => {
    const big = "x".repeat(8 * 1024 * 1024 + 10)
    const out = buildHtmlPreviewDocument(big)
    expect(out.startsWith(CSP_META)).toBe(true)
    expect(out.length).toBe(CSP_META.length + big.length)
  })

  it("自闭合/大小写：<HEAD> 与 <Html> 均识别", () => {
    const out = buildHtmlPreviewDocument("<Html><HEAD></HEAD><Body></Body></Html>")
    expect(out).toBe(`<Html><HEAD>${CSP_META}</HEAD><Body></Body></Html>`)
  })
})

describe("buildHtmlPreviewDocument 解析器忽略语义（review 补充）", () => {
  it("</script/> 自闭合：script 在此结束，其后文本进 body → 后续 <head> 均忽略 → 回退 <html> 补 head", () => {
    const out = buildHtmlPreviewDocument(
      `<html><script>a="</script/>";var s="<head>"</script><head>real</head></html>`,
    )
    expect(out).toBe(
      `<html><head>${CSP_META}</head><script>a="</script/>";var s="<head>"</script><head>real</head></html>`,
    )
  })

  it("body 后的假 <head> 不注入：回退 <html> 补 head（先于 body，恒有效）", () => {
    const out = buildHtmlPreviewDocument("<html><body>x</body><head>y</head></html>")
    expect(out).toBe(`<html><head>${CSP_META}</head><body>x</body><head>y</head></html>`)
  })

  it("raw-text 在 <html> 前：其后的 <html> 不作注入点（解析器忽略）→ 前置", () => {
    const out = buildHtmlPreviewDocument("<title>t</title><html><body>x</body></html>")
    expect(out.startsWith(CSP_META)).toBe(true)
  })

  it("注释 --!> 变体闭合", () => {
    const out = buildHtmlPreviewDocument("<!-- x --!><html><head>real</head></html>")
    expect(out).toBe(`<!-- x --!><html><head>${CSP_META}real</head></html>`)
  })

  it("注释突闭 <!-->：注释立即结束", () => {
    const out = buildHtmlPreviewDocument("<!--><html><head>real</head></html>")
    expect(out).toBe(`<!--><html><head>${CSP_META}real</head></html>`)
  })

  it("无 head 有 body：仅 <html> 注入点仍有效（先于 body）", () => {
    const out = buildHtmlPreviewDocument("<html><body>x</body></html>")
    expect(out).toBe(`<html><head>${CSP_META}</head><body>x</body></html>`)
  })
})
