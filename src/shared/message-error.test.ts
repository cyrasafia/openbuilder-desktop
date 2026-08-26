import { describe, expect, it } from "vitest"
import { extractErrorMessage, extractRetryMessage } from "./message-error"

describe("extractErrorMessage", () => {
  it("NamedError 形态：文案在 data.message（实测契约主路径）", () => {
    expect(
      extractErrorMessage({
        name: "APIError",
        data: { message: "rate limited", statusCode: 429, isRetryable: true },
      }),
    ).toBe("rate limited")
  })

  it("data.message 内嵌 JSON body：清洗为人读文案（与 retry 提示同源）", () => {
    expect(
      extractErrorMessage({
        name: "UnknownError",
        data: {
          message:
            'Internal Server Error: {"error":{"message":"The server had an error while processing your request","type":"server_error"}}',
        },
      }),
    ).toBe("Internal Server Error: The server had an error while processing your request")
  })

  it("中止消息：MessageAbortedError 的 data.message", () => {
    expect(extractErrorMessage({ name: "MessageAbortedError", data: { message: "Aborted" } })).toBe("Aborted")
  })

  it("data.error 次选；data 为字符串直接取", () => {
    expect(extractErrorMessage({ name: "X", data: { error: "boom" } })).toBe("boom")
    expect(extractErrorMessage({ name: "X", data: "boom" })).toBe("boom")
  })

  it("data 有值但无 message/error：整体 dump（空壳不 dump 回落 name）", () => {
    expect(extractErrorMessage({ name: "X", data: { code: 5 } })).toBe('{"code":5}')
    expect(extractErrorMessage({ name: "X", data: {} })).toBe("X")
  })

  it("顶层 message/error/msg/detail 兜底", () => {
    expect(extractErrorMessage({ message: "m" })).toBe("m")
    expect(extractErrorMessage({ error: "e" })).toBe("e")
    expect(extractErrorMessage({ msg: "msg" })).toBe("msg")
    expect(extractErrorMessage({ detail: "detail" })).toBe("detail")
  })

  it("未知形态：JSON dump 可诊断，永不 [object Object]", () => {
    expect(extractErrorMessage({ name: "X", weird: 1 })).toBe('{"name":"X","weird":1}')
    expect(String(extractErrorMessage({ some: "obj" }))).not.toContain("[object Object]")
  })

  it("仅 name/data 空壳：回落 name；null/undefined/字符串入参", () => {
    expect(extractErrorMessage(null)).toBe("")
    expect(extractErrorMessage(undefined)).toBe("")
    expect(extractErrorMessage("plain")).toBe("plain")
  })
})

describe("extractRetryMessage（retry 提示文案清洗）", () => {
  it("内嵌 JSON body：提取 error.message 与前置摘要重组", () => {
    expect(
      extractRetryMessage(
        'Internal Server Error: {"error":{"message":"The server had an error while processing your request","type":"server_error"}}',
      ),
    ).toBe("Internal Server Error: The server had an error while processing your request")
  })

  it("纯 JSON 文案：无前置摘要时直接给人读字段", () => {
    expect(extractRetryMessage('{"error":{"message":"rate limited"}}')).toBe("rate limited")
    expect(extractRetryMessage('{"message":"provider overloaded"}')).toBe("provider overloaded")
  })

  it("非 JSON 原文返回（server 常规 message）；解析失败原文返回", () => {
    expect(extractRetryMessage("rate limited")).toBe("rate limited")
    expect(extractRetryMessage("Provider is overloaded")).toBe("Provider is overloaded")
    expect(extractRetryMessage("Broken: {not json}")).toBe("Broken: {not json}")
  })

  it("内嵌 JSON 无可读字段：原文返回（不产出空文案）", () => {
    expect(extractRetryMessage('{"type":"server_error"}')).toBe('{"type":"server_error"}')
  })
})
