import { describe, expect, it } from "vitest"
import { isLoopbackBaseUrl, isLoopbackHostname } from "./loopback"

describe("isLoopbackHostname", () => {
  it("localhost（大小写不敏感）/ 127.0.0.0 段任意地址 / ::1（带或不带方括号）= true", () => {
    expect(isLoopbackHostname("localhost")).toBe(true)
    expect(isLoopbackHostname("LOCALHOST")).toBe(true)
    expect(isLoopbackHostname("127.0.0.1")).toBe(true)
    expect(isLoopbackHostname("127.5.4.3")).toBe(true)
    expect(isLoopbackHostname("[::1]")).toBe(true)
    expect(isLoopbackHostname("::1")).toBe(true)
  })

  it("远程主机（LAN IP / 域名 / 其他保留段）= false", () => {
    expect(isLoopbackHostname("192.168.1.5")).toBe(false)
    expect(isLoopbackHostname("10.0.0.2")).toBe(false)
    expect(isLoopbackHostname("nas.local")).toBe(false)
    expect(isLoopbackHostname("0.0.0.0")).toBe(false)
    expect(isLoopbackHostname("[::]")).toBe(false)
    // 127 段前缀伪装（1270.x / 12.7.x）
    expect(isLoopbackHostname("1270.0.0.1")).toBe(false)
    expect(isLoopbackHostname("12.7.0.1")).toBe(false)
  })
})

describe("isLoopbackBaseUrl", () => {
  it("完整 URL 解析 hostname 判定（端口/路径不影响）", () => {
    expect(isLoopbackBaseUrl("http://127.0.0.1:15120")).toBe(true)
    expect(isLoopbackBaseUrl("http://localhost:15120")).toBe(true)
    expect(isLoopbackBaseUrl("http://[::1]:15120/x")).toBe(true)
    expect(isLoopbackBaseUrl("http://192.168.1.5:15120")).toBe(false)
    expect(isLoopbackBaseUrl("http://nas.local:15120")).toBe(false)
  })

  it("空/非法 = false（保守不注入）", () => {
    expect(isLoopbackBaseUrl(null)).toBe(false)
    expect(isLoopbackBaseUrl(undefined)).toBe(false)
    expect(isLoopbackBaseUrl("")).toBe(false)
    expect(isLoopbackBaseUrl("not a url")).toBe(false)
  })
})
