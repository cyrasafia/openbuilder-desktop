import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        output: {
          // sandbox:true 的 preload 加载器只支持 CJS；.cjs 后缀避开 package.json type:module 歧义
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    server: {
      // renderer 直连 opencode server；server CORS 对 localhost 无条件放行
      allowedHosts: true,
    },
  },
})
