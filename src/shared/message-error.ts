/**
 * 报错消息人读文案提取（design-error-message）。
 * 参考 openbuilder conversation_screen.dart _extractErrorMessage：server 错误是
 * NamedError 序列化（{name, data: {message, …}}），人读文案在 data.message；
 * 顶层 .message 取值会落空，回退 String(obj) 会得到 [object Object]。
 * 提取顺序防御式覆盖多形态（data.message > data.error > data 字符串 >
 * 顶层 message/error/msg/detail > 原始 JSON dump），保证永不输出 [object Object]。
 * 产出文案统一过内嵌 JSON 清洗（stripEmbeddedJson）——provider 错误原文
 * （data.message 与 retry message 同源）可内嵌 JSON body。
 */

function nonEmpty(v: unknown): string | null {
  if (typeof v !== "string") return null
  return v.length > 0 ? v : null
}

export function extractErrorMessage(error: unknown): string {
  return stripEmbeddedJson(rawErrorMessage(error))
}

function rawErrorMessage(error: unknown): string {
  if (error == null) return ""
  if (typeof error === "string") return error
  if (typeof error !== "object") return String(error)
  const obj = error as Record<string, unknown>
  const data = obj.data
  if (data != null && typeof data === "object") {
    const d = data as Record<string, unknown>
    const msg = nonEmpty(d.message) ?? nonEmpty(d.error)
    if (msg) return msg
    // data 含至少一个有意义值才整体 dump（同 openbuilder：空壳 {} 不 dump）
    if (Object.values(d).some((v) => v != null && String(v).length > 0)) {
      return JSON.stringify(d)
    }
  }
  const direct = nonEmpty(data)
  if (direct) return direct
  for (const key of ["message", "error", "msg", "detail"]) {
    const v = nonEmpty(obj[key])
    if (v) return v
  }
  // 兜底 dump：name 之外还有未知字段时原文可见（可诊断），仅 name/data 空壳给 name
  if (Object.keys(obj).some((k) => k !== "name" && k !== "data")) {
    return JSON.stringify(obj)
  }
  return nonEmpty(obj.name) ?? ""
}

/**
 * retry 提示文案清洗（design-error-message §3.1）：session.status retry 的
 * message 是 provider 错误原文（server retry.ts 透传 error.data.message），
 * 可能内嵌 JSON body——如 `Internal Server Error: {"error":{"message":"…","type":"server_error"}}`。
 * 提取内嵌 JSON 的人读字段（error.message > message > error > detail）与前置摘要
 * 重组；非 JSON 或解析失败原文返回。纯展示层清洗，store 数据保持忠实。
 */

function readHumanText(v: unknown): string | null {
  if (typeof v === "string") return v.length > 0 ? v : null
  if (v == null || typeof v !== "object") return null
  const obj = v as Record<string, unknown>
  const nested = obj.error
  if (nested != null && typeof nested === "object") {
    const inner = readHumanText(nested)
    if (inner) return inner
  }
  for (const key of ["message", "error", "detail", "msg"]) {
    const s = nonEmpty(obj[key])
    if (s) return s
  }
  return null
}

function stripEmbeddedJson(message: string): string {
  const idx = message.indexOf("{")
  if (idx === -1) return message
  const prefix = message.slice(0, idx).replace(/[\s:：]+$/, "")
  try {
    const inner = readHumanText(JSON.parse(message.slice(idx)))
    if (inner) return prefix ? `${prefix}: ${inner}` : inner
  } catch {
    // 内嵌段不是合法 JSON——原文返回
  }
  return message
}

/** retry 提示文案清洗（TypingSlot 消费；即内嵌 JSON 清洗的直接暴露） */
export function extractRetryMessage(message: string): string {
  return stripEmbeddedJson(message)
}
