import { describe, expect, it } from "vitest"
import { belowMinServerVersion, compareVersions } from "./semver"

describe("compareVersions", () => {
  it("常规比较", () => {
    expect(compareVersions("1.18.20", "1.0.66")).toBe(1)
    expect(compareVersions("1.0.65", "1.0.66")).toBe(-1)
    expect(compareVersions("1.0.66", "1.0.66")).toBe(0)
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1)
  })
  it("缺段补零", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0)
    expect(compareVersions("1", "1.0.1")).toBe(-1)
  })
  it("v 前缀与预发布后缀", () => {
    expect(compareVersions("v1.0.66", "1.0.66")).toBe(0)
    expect(compareVersions("1.0.66-beta.1", "1.0.65")).toBe(1)
  })
  it("无法解析按相等（不误伤）", () => {
    expect(compareVersions("unknown", "1.0.66")).toBe(0)
    expect(compareVersions("", "1.0.0")).toBe(0)
  })
})

describe("belowMinServerVersion", () => {
  it("低于 1.0.66 判 true", () => {
    expect(belowMinServerVersion("1.0.65")).toBe(true)
    expect(belowMinServerVersion("0.9.9")).toBe(true)
    expect(belowMinServerVersion("1.0")).toBe(true)
  })
  it("达标与无法解析判 false", () => {
    expect(belowMinServerVersion("1.0.66")).toBe(false)
    expect(belowMinServerVersion("1.18.20")).toBe(false)
    expect(belowMinServerVersion("garbage")).toBe(false)
  })
  it("自定义下限", () => {
    expect(belowMinServerVersion("1.2.0", "1.3.0")).toBe(true)
  })
})
