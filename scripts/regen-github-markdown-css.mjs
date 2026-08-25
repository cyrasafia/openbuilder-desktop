/**
 * 重新生成 vendor/github-markdown-{light,dark}.css：从 npm 包 github-markdown-css 复制，
 * 给每个 .markdown-body 选择器加 :root[data-theme="X"] 前缀，使其按本项目 [data-theme]
 * 机制切明暗（vendor 自带的 prefers-color-scheme 自动切与本项目手动主题模式不兼容）。
 *
 * 用法：npm run vendor:md
 * 升级 github-markdown-css 后须重跑（CSS 内容会变，选择器前缀规则不变）。
 */
import { readFileSync, writeFileSync } from "node:fs"

const pairs = [
  {
    src: "node_modules/github-markdown-css/github-markdown-light.css",
    theme: "light",
    out: "src/renderer/src/styles/vendor/github-markdown-light.css",
  },
  {
    src: "node_modules/github-markdown-css/github-markdown-dark.css",
    theme: "dark",
    out: "src/renderer/src/styles/vendor/github-markdown-dark.css",
  },
]

for (const { src, theme, out } of pairs) {
  let css = readFileSync(src, "utf8")
  // 行首或逗号后的 .markdown-body 选择器加前缀（vendor 现版全部行首，逗号分支
  // 兼容未来单行多选择器写法，如 ".foo, .markdown-body {"）
  css = css.replace(
    /(^|,|\n)(\s*)\.markdown-body/g,
    (_m, pre, sp) => `${pre}${sp}:root[data-theme="${theme}"] .markdown-body`,
  )
  // 头部加来源/重生成说明（覆盖 vendor 原始的 /*light */ 或 /*dark */ 首行注释）
  const header = `/* vendored from github-markdown-css (${theme})，选择器已加 :root[data-theme="${theme}"] 前缀。
 * 重生成：npm run vendor:md（源 = node_modules/github-markdown-css/github-markdown-${theme}.css）。 */\n`
  css = header + css
  writeFileSync(out, css)
  console.log(`regenerated ${out} (theme=${theme})`)
}