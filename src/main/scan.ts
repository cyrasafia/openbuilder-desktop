/**
 * 自动扫描（design-auto-scan）：managed 二进制扫描 + attach server 扫描。
 * 单次收束（无后台常驻）；依赖注入默认真实实现，纯函数单独导出供单测。
 */
import { execFile as execFileCb } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access as accessCb, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter as pathDelimiter, join, resolve as resolvePath } from "node:path"
import { promisify } from "node:util"
import { Bonjour } from "bonjour-service"
import type { BinaryCandidate, ServerCandidate } from "../shared/ipc"
import { runLimited } from "../shared/run-limited"
import { sanitizedChildEnv } from "./linux-open-with"

const execFile = promisify(execFileCb)

/** loopback 探测地址（opencode serve 默认端口 4096，不做端口段扫描） */
export const LOOPBACK_PROBE_URL = "http://127.0.0.1:4096"
/** mDNS 浏览窗口：bonjour-service 收 service-up 事件的等待上限，随后 destroy */
const MDNS_WINDOW_MS = 4000
/** 候选健康验证超时 */
const HEALTH_TIMEOUT_MS = 2000
/** 单个 `--version` 探测超时 */
const VERSION_TIMEOUT_MS = 3000
/** 版本探测并发上限 */
const VERSION_CONCURRENCY = 4
/** 扫描整体兜底截止（超时后不再发起新探测，在途的等待收束） */
const SCAN_DEADLINE_MS = 10_000

// ============ 纯函数（单测覆盖） ============

/**
 * 二进制候选目录（按推荐序）：PATH 各目录 → ~/.opencode/bin → ~/.local/bin →
 * npm global bin → /opt/homebrew/bin → /usr/local/bin。resolve 归一去重保序。
 */
export function binarySearchDirs(
  env: NodeJS.ProcessEnv,
  home: string,
  npmGlobalBin: string | null,
): string[] {
  const dirs: string[] = []
  const push = (d: string) => {
    if (!d) return
    const r = resolvePath(d.replace(/^~(?=\/|$)/, home))
    if (!dirs.includes(r)) dirs.push(r)
  }
  if (env.PATH) {
    for (const seg of env.PATH.split(pathDelimiter)) push(seg)
  }
  push(join(home, ".opencode", "bin"))
  push(join(home, ".local", "bin"))
  if (npmGlobalBin) push(npmGlobalBin)
  push("/opt/homebrew/bin")
  push("/usr/local/bin")
  return dirs
}

/** `opencode --version` 输出解析：stdout 首个非空行 trim；无有效行 = null */
export function parseVersionLine(out: string): string | null {
  for (const line of out.split("\n")) {
    const t = line.trim()
    if (t) return t
  }
  return null
}

/** mDNS 服务名过滤：server 发布格式 `opencode-{port}`（mdns.ts 同源契约） */
export function isOpencodeMdnsName(name: string): boolean {
  return /^opencode-\d+$/.test(name)
}

/** mDNS service → 候选 URL。必须用 addresses 的 IP（Node fetch 的 DNS 不走
 *  mDNS，`opencode.local` 解析不开）；IPv6 按 RFC 3986 加方括号。无地址 = null */
export function mdnsServiceUrl(addresses: string[] | undefined, port: number): string | null {
  if (!port || !addresses || addresses.length === 0) return null
  const addr = addresses[0]
  if (!addr) return null
  const host = addr.includes(":") ? `[${addr}]` : addr
  return `http://${host}:${port}`
}

// ============ 依赖注入 ============

export interface ExecResult {
  stdout: string
  stderr: string
}

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<ExecResult>

type AccessFn = (p: string) => Promise<void>
type RealpathFn = (p: string) => Promise<string>
type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

/** bonjour-service 的最小面（真实实现直接传入；测试用桩） */
export interface BonjourLike {
  find(
    opts: { type: string },
    onup?: (service: { name: string; port: number; addresses?: string[] }) => void,
  ): unknown
  destroy(): void
}

export interface ScanDeps {
  env: NodeJS.ProcessEnv
  home: string
  platform: NodeJS.Platform
  exec: ExecFn
  access: AccessFn
  realpath: RealpathFn
  fetch: FetchFn
  bonjourFactory: () => BonjourLike
  mdnsWindowMs: number
}

const defaultDeps = (): ScanDeps => ({
  env: process.env,
  home: homedir(),
  platform: process.platform,
  exec: (cmd, args, opts) => execFile(cmd, args, { timeout: opts.timeout, env: opts.env }),
  access: (p) => accessCb(p, fsConstants.X_OK),
  realpath: (p) => realpath(p),
  fetch: (url, init) => fetch(url, init),
  bonjourFactory: () => new Bonjour() as BonjourLike,
  mdnsWindowMs: MDNS_WINDOW_MS,
})

// ============ 二进制扫描 ============

async function npmGlobalBin(exec: ExecFn): Promise<string | null> {
  try {
    const { stdout } = await exec("npm", ["prefix", "-g"], {
      timeout: 3000,
      env: sanitizedChildEnv(process.env),
    })
    const prefix = stdout.trim().split("\n")[0]?.trim()
    return prefix ? join(prefix, "bin") : null
  } catch {
    return null
  }
}

async function probeVersion(exec: ExecFn, bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec(bin, ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      env: sanitizedChildEnv(process.env),
    })
    return parseVersionLine(stdout)
  } catch {
    return null
  }
}

export async function scanBinaries(deps: Partial<ScanDeps> = {}): Promise<BinaryCandidate[]> {
  const d = { ...defaultDeps(), ...deps }
  const npmBin = d.platform === "win32" ? null : await npmGlobalBin(d.exec)
  const dirs = binarySearchDirs(d.env, d.home, npmBin)
  const names = d.platform === "win32" ? ["opencode.exe", "opencode.cmd"] : ["opencode"]

  const found: string[] = []
  for (const dir of dirs) {
    for (const name of names) {
      try {
        await d.access(join(dir, name))
        found.push(join(dir, name))
      } catch {
        // 不存在/不可执行
      }
    }
  }

  // realpath 去重（~/.opencode/bin 常为指向版本目录的 symlink；保序留先序出现者）
  const unique: string[] = []
  const seen = new Set<string>()
  for (const p of found) {
    const rp = await d.realpath(p).catch(() => p)
    if (seen.has(rp)) continue
    seen.add(rp)
    unique.push(p)
  }

  const deadline = Date.now() + SCAN_DEADLINE_MS
  const results: BinaryCandidate[] = []
  await runLimited(unique, VERSION_CONCURRENCY, async (p) => {
    if (Date.now() > deadline) return
    results.push({ path: p, version: await probeVersion(d.exec, p) })
  })
  return results
}

// ============ server 扫描 ============

/** 候选健康验证：不可连/不健康 = null；健康 = 版本（缺失时 null 值随健康位返回） */
async function healthCheck(
  fetchFn: FetchFn,
  url: string,
): Promise<{ healthy: true; version: string | null } | null> {
  try {
    const res = await fetchFn(`${url}/global/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { healthy?: unknown; version?: unknown }
    if (body.healthy !== true) return null
    return { healthy: true, version: typeof body.version === "string" ? body.version : null }
  } catch {
    return null
  }
}

/** mDNS 浏览一个窗口后收束：返回期间发现的 opencode 服务 URL（未验证） */
async function browseMdns(
  bonjourFactory: () => BonjourLike,
  windowMs: number,
): Promise<string[]> {
  const urls: string[] = []
  let bonjour: BonjourLike
  try {
    bonjour = bonjourFactory()
  } catch {
    return urls
  }
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      try {
        bonjour.destroy()
      } catch {
        // 已销毁/未初始化：忽略
      }
      resolve()
    }
    const timer = setTimeout(finish, windowMs)
    try {
      bonjour.find({ type: "http" }, (service) => {
        if (!service || !isOpencodeMdnsName(service.name)) return
        const url = mdnsServiceUrl(service.addresses, service.port)
        if (url && !urls.includes(url)) urls.push(url)
      })
    } catch {
      finish()
    }
  })
  return urls
}

export async function scanServers(deps: Partial<ScanDeps> = {}): Promise<ServerCandidate[]> {
  const d = { ...defaultDeps(), ...deps }
  const mdnsUrls = await browseMdns(d.bonjourFactory, d.mdnsWindowMs)

  const urls = [LOOPBACK_PROBE_URL, ...mdnsUrls.filter((u) => u !== LOOPBACK_PROBE_URL)]
  const results: ServerCandidate[] = []
  await runLimited(urls, VERSION_CONCURRENCY, async (url) => {
    const check = await healthCheck(d.fetch, url)
    if (!check) return
    results.push({
      url,
      version: check.version,
      source: url === LOOPBACK_PROBE_URL ? "loopback" : "mdns",
    })
  })
  return results
}
