/** 自动扫描单测（design-auto-scan §5）：纯函数 + 依赖注入桩覆盖 */
import { describe, expect, it } from "vitest"
import {
  LOOPBACK_PROBE_URL,
  binarySearchDirs,
  isOpencodeMdnsName,
  mdnsServiceUrl,
  parseVersionLine,
  scanBinaries,
  scanServers,
  type BonjourLike,
  type ExecFn,
  type ScanDeps,
} from "./scan"

const HOME = "/home/tester"

describe("binarySearchDirs", () => {
  it("PATH 各目录在前、落点目录在后，去重保序", () => {
    const dirs = binarySearchDirs(
      { PATH: `/usr/bin:${HOME}/.local/bin:/usr/bin` },
      HOME,
      null,
    )
    expect(dirs[0]).toBe("/usr/bin")
    expect(dirs[1]).toBe(`${HOME}/.local/bin`) // 与 PATH 重复的落点不二进
    expect(dirs).toContain(joinDir(HOME, ".opencode/bin"))
    expect(dirs).toContain("/opt/homebrew/bin")
    expect(dirs).toContain("/usr/local/bin")
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  it("npm global bin 插在 ~/.local/bin 之后；null 不占位", () => {
    const withNpm = binarySearchDirs({ PATH: "/usr/bin" }, HOME, "/npm/global/bin")
    expect(withNpm.indexOf("/npm/global/bin")).toBeGreaterThan(
      withNpm.indexOf(joinDir(HOME, ".local/bin")),
    )
    const withoutNpm = binarySearchDirs({ PATH: "/usr/bin" }, HOME, null)
    expect(withoutNpm).not.toContain("/npm/global/bin")
  })

  it("~ 前缀展开到 home；空 PATH 段跳过", () => {
    const dirs = binarySearchDirs({ PATH: "~/bin::/usr/bin" }, HOME, null)
    expect(dirs[0]).toBe(`${HOME}/bin`)
    expect(dirs[1]).toBe("/usr/bin")
  })
})

function joinDir(base: string, rel: string): string {
  // 测试辅助：避免引入 path.join 平台差异（delimiter 用运行平台的）
  return `${base}/${rel}`
}

describe("parseVersionLine", () => {
  it("取首个非空行 trim", () => {
    expect(parseVersionLine("\n  1.18.20  \nextra")).toBe("1.18.20")
  })
  it("无有效行 = null", () => {
    expect(parseVersionLine("")).toBeNull()
    expect(parseVersionLine("  \n \n")).toBeNull()
  })
})

describe("isOpencodeMdnsName", () => {
  it("只认 opencode-{port} 格式", () => {
    expect(isOpencodeMdnsName("opencode-4096")).toBe(true)
    expect(isOpencodeMdnsName("opencode-15120")).toBe(true)
    expect(isOpencodeMdnsName("opencode-abc")).toBe(false)
    expect(isOpencodeMdnsName("opencode-")).toBe(false)
    expect(isOpencodeMdnsName("myopencode-1")).toBe(false)
    expect(isOpencodeMdnsName("opencode-4096-extra")).toBe(false)
  })
})

describe("mdnsServiceUrl", () => {
  it("v4 地址直接拼", () => {
    expect(mdnsServiceUrl(["192.168.1.5"], 4096)).toBe("http://192.168.1.5:4096")
  })
  it("v6 地址加方括号（RFC 3986）", () => {
    expect(mdnsServiceUrl(["fe80::1"], 4096)).toBe("http://[fe80::1]:4096")
  })
  it("多地址取首个", () => {
    expect(mdnsServiceUrl(["192.168.1.5", "10.0.0.2"], 4096)).toBe("http://192.168.1.5:4096")
  })
  it("无地址/无端口 = null", () => {
    expect(mdnsServiceUrl(undefined, 4096)).toBeNull()
    expect(mdnsServiceUrl([], 4096)).toBeNull()
    expect(mdnsServiceUrl(["192.168.1.5"], 0)).toBeNull()
  })
})

// ============ 依赖注入桩 ============

function stubExec(byCmd: Record<string, { stdout: string } | Error>): ExecFn {
  return async (cmd) => {
    const r = byCmd[cmd]
    if (!r) throw new Error(`unexpected exec: ${cmd}`)
    if (r instanceof Error) throw r
    return { stdout: r.stdout, stderr: "" }
  }
}

function ok(res: { healthy?: boolean; version?: string }): Response {
  return new Response(JSON.stringify(res ?? { healthy: true, version: "1.0.0" }), {
    status: 200,
  })
}

describe("scanBinaries（桩）", () => {
  const base = {
    env: { PATH: "/usr/bin:/custom" },
    home: HOME,
    platform: "linux" as const,
    exec: stubExec({ npm: new Error("no npm") }),
    access: async (p: string) => {
      if (p === "/usr/bin/opencode" || p === "/custom/opencode") return
      throw new Error("ENOENT")
    },
    realpath: async (p: string) => p,
  } satisfies Partial<ScanDeps>

  it("探测命中目录、逐项版本探测", async () => {
    const results = await scanBinaries({
      ...base,
      exec: stubExec({
        npm: new Error("no npm"),
        "/usr/bin/opencode": { stdout: "1.18.20\n" },
        "/custom/opencode": { stdout: "0.9.9" },
      }),
    })
    expect(results).toEqual([
      { path: "/usr/bin/opencode", version: "1.18.20" },
      { path: "/custom/opencode", version: "0.9.9" },
    ])
  })

  it("版本探测失败仍保留候选（version null）；~/.opencode/bin 命中且 realpath 去重", async () => {
    const seen: string[] = []
    const results = await scanBinaries({
      ...base,
      access: async (p: string) => {
        if (p === "/usr/bin/opencode" || p === `${HOME}/.opencode/bin/opencode`) return
        throw new Error("ENOENT")
      },
      realpath: async (p: string) => {
        seen.push(p)
        // ~/.opencode/bin/opencode 是指向 /usr/bin/opencode 的 symlink
        return p === `${HOME}/.opencode/bin/opencode` ? "/usr/bin/opencode" : p
      },
      exec: stubExec({
        npm: new Error("no npm"),
        "/usr/bin/opencode": new Error("timeout"),
      }),
    })
    // PATH 命中在前，symlink 副本被去重；失败的版本探测 = null
    expect(results).toEqual([{ path: "/usr/bin/opencode", version: null }])
    expect(seen).toEqual(["/usr/bin/opencode", `${HOME}/.opencode/bin/opencode`])
  })

  it("npm prefix 解析出 global bin 并探测其 opencode", async () => {
    const results = await scanBinaries({
      ...base,
      env: { PATH: "/usr/bin" },
      exec: stubExec({
        npm: { stdout: "\n/npm-global\n" },
        "/npm-global/bin/opencode": { stdout: "2.0.0" },
      }),
      access: async (p: string) => {
        if (p === "/npm-global/bin/opencode") return
        throw new Error("ENOENT")
      },
    })
    expect(results).toEqual([{ path: "/npm-global/bin/opencode", version: "2.0.0" }])
  })
})

describe("scanServers（桩）", () => {
  /** 收集 onup 回调的 bonjour 桩：测试手动注入服务事件 */
  function stubBonjour(events: Array<{ name: string; port: number; addresses?: string[] }>) {
    const impl = {
      find(_opts: unknown, onup?: (s: unknown) => void) {
        queueMicrotask(() => {
          for (const e of events) onup?.(e)
        })
        return {}
      },
      destroyed: false,
      destroy() {
        impl.destroyed = true
      },
    }
    return impl
  }

  it("mDNS 命中 + loopback 都验证通过；source 正确；非 opencode 服务被过滤", async () => {
    const bonj = stubBonjour([
      { name: "opencode-4096", port: 4096, addresses: ["192.168.1.5"] },
      { name: "someprinter", port: 631, addresses: ["192.168.1.9"] },
      { name: "opencode-4096", port: 4096, addresses: ["192.168.1.5"] },
    ])
    const results = await scanServers({
      bonjourFactory: () => bonj as unknown as BonjourLike,
      mdnsWindowMs: 20,
      fetch: async (url) => {
        if (url === `${LOOPBACK_PROBE_URL}/global/health`) {
          return ok({ healthy: true, version: "1.1.1" })
        }
        if (url === "http://192.168.1.5:4096/global/health") {
          return ok({ healthy: true, version: "1.2.2" })
        }
        throw new Error("network unreachable")
      },
    })
    expect(results).toEqual([
      { url: LOOPBACK_PROBE_URL, version: "1.1.1", source: "loopback" },
      { url: "http://192.168.1.5:4096", version: "1.2.2", source: "mdns" },
    ])
    expect(bonj.destroyed).toBe(true)
  })

  it("健康验证失败（不健康/不可达）丢弃候选；healthy 缺 version = null 版本保留", async () => {
    const bonj = stubBonjour([{ name: "opencode-4096", port: 4096, addresses: ["192.168.1.5"] }])
    const results = await scanServers({
      bonjourFactory: () => bonj as unknown as BonjourLike,
      mdnsWindowMs: 20,
      fetch: async (url) => {
        if (url === `${LOOPBACK_PROBE_URL}/global/health`) return ok({ healthy: true })
        if (url === "http://192.168.1.5:4096/global/health") return ok({ healthy: false })
        throw new Error("unreachable")
      },
    })
    expect(results).toEqual([
      { url: LOOPBACK_PROBE_URL, version: null, source: "loopback" },
    ])
  })

  it("bonjour 构造失败降级为纯 loopback，不整体失败", async () => {
    const results = await scanServers({
      bonjourFactory: () => {
        throw new Error("multicast unavailable")
      },
      mdnsWindowMs: 20,
      fetch: async () => ok({ healthy: true, version: "1.0.0" }),
    })
    expect(results).toEqual([{ url: LOOPBACK_PROBE_URL, version: "1.0.0", source: "loopback" }])
  })

  it("loopback 不可达且 mDNS 命中同一 URL 去重", async () => {
    const bonj = stubBonjour([{ name: "opencode-4096", port: 4096, addresses: ["127.0.0.1"] }])
    const results = await scanServers({
      bonjourFactory: () => bonj as unknown as BonjourLike,
      mdnsWindowMs: 20,
      fetch: async () => ok({ healthy: true, version: "1.0.0" }),
    })
    // mDNS 声明 addresses=[127.0.0.1] 构造出的 URL 与 loopback 探测同址 → 去重为一条 loopback
    expect(results).toEqual([{ url: LOOPBACK_PROBE_URL, version: "1.0.0", source: "loopback" }])
  })
})
