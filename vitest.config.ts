import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    // electron 主进程代码在 node 环境测试
    environmentMatchGlobs: [
      ["src/main/**/*.test.ts", "node"],
      ["src/shared/**/*.test.ts", "node"],
    ],
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@renderer": resolve(__dirname, "src/renderer/src"),
    },
  },
})
