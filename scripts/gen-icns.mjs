#!/usr/bin/env node
// 由 gen-icons.sh 调用：把 build/ 下的 PNG 打包为 macOS icns（ICNS 容器 + PNG 条目，无第三方依赖）
// 条目类型按 Apple ICNS 规范：icp4/icp5/icp6（16/32/64）、ic07~ic10（128~1024）、ic11~ic14（Retina @2x）
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const entries = [
  ["icp4", "build/icons/16.png"],
  ["icp5", "build/icons/32.png"],
  ["icp6", "build/icons/64.png"],
  ["ic07", "build/icons/128.png"],
  ["ic08", "build/icons/256.png"],
  ["ic09", "build/icons/512.png"],
  ["ic10", "build/icon.png"],
  ["ic11", "build/icons/32.png"],
  ["ic12", "build/icons/64.png"],
  ["ic13", "build/icons/256.png"],
  ["ic14", "build/icons/512.png"],
].map(([type, rel]) => {
  const data = readFileSync(join(root, rel))
  const header = Buffer.alloc(8)
  header.write(type, 0, "ascii")
  header.writeUInt32BE(8 + data.length, 4)
  return Buffer.concat([header, data])
})

const body = Buffer.concat(entries)
const magic = Buffer.alloc(8)
magic.write("icns", 0, "ascii")
magic.writeUInt32BE(8 + body.length, 4)
writeFileSync(join(root, "build/icon.icns"), Buffer.concat([magic, body]))
console.log("build/icon.icns", 8 + body.length, "bytes")
