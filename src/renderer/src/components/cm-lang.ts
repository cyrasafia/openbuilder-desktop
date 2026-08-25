/**
 * CodeMirror 语言映射（design-code-view §2.2）：扩展名/特殊文件名 → LanguageSupport。
 * 静态映射（不用 @codemirror/language-data 懒加载注册表）——包体确定、命中即可用。
 * 借鉴 openchamber languageByExtension.ts（静态集 + Makefile→shell 兜底）。
 */
import type { Extension } from "@codemirror/state"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { python } from "@codemirror/lang-python"
import { go } from "@codemirror/lang-go"
import { rust } from "@codemirror/lang-rust"
import { yaml } from "@codemirror/lang-yaml"
import { markdown } from "@codemirror/lang-markdown"
import { html } from "@codemirror/lang-html"
import { css } from "@codemirror/lang-css"
import { sql } from "@codemirror/lang-sql"
import { cpp } from "@codemirror/lang-cpp"
import { xml } from "@codemirror/lang-xml"
import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { toml } from "@codemirror/legacy-modes/mode/toml"
import { properties } from "@codemirror/legacy-modes/mode/properties"
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile"

const shellLanguage = StreamLanguage.define(shell)
const tomlLanguage = StreamLanguage.define(toml)
const propertiesLanguage = StreamLanguage.define(properties)
const dockerfileLanguage = StreamLanguage.define(dockerFile)

/** 扩展名（basename 最后非前导点，大小写不敏感）——与 isMarkdownPath 同解析规则 */
function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return ""
  return base.slice(dot + 1).toLowerCase()
}

function basenameOf(path: string): string {
  return (path.split("/").pop() ?? "").toLowerCase()
}

/**
 * markdown 围栏代码块语言解析表（LanguageDescription 按 name/alias 匹配 fence
 * info 字符串）。静态语言集同源复用——md 源码态围栏内也有语法高亮。
 */
const fenceDescriptions = [
  LanguageDescription.of({ name: "javascript", alias: ["js", "jsx"], support: javascript({ jsx: true }) }),
  LanguageDescription.of({ name: "typescript", alias: ["ts", "tsx"], support: javascript({ typescript: true, jsx: true }) }),
  LanguageDescription.of({ name: "json", alias: ["jsonc", "json5"], support: json() }),
  LanguageDescription.of({ name: "python", alias: ["py"], support: python() }),
  LanguageDescription.of({ name: "go", alias: ["golang"], support: go() }),
  LanguageDescription.of({ name: "rust", alias: ["rs"], support: rust() }),
  LanguageDescription.of({ name: "yaml", alias: ["yml"], support: yaml() }),
  LanguageDescription.of({ name: "html", support: html() }),
  LanguageDescription.of({ name: "css", alias: ["scss", "less"], support: css() }),
  LanguageDescription.of({ name: "sql", support: sql() }),
  LanguageDescription.of({ name: "cpp", alias: ["c", "c++"], support: cpp() }),
  LanguageDescription.of({ name: "xml", support: xml() }),
  LanguageDescription.of({ name: "shell", alias: ["bash", "sh", "zsh", "console", "shellsession"], support: new LanguageSupport(shellLanguage) }),
]

const markdownLanguage = markdown({ codeLanguages: fenceDescriptions })

/** 文件路径 → 语言扩展；null = 纯文本（无高亮，行号仍在） */
export function languageForPath(path: string): Extension | null {
  // 特殊文件名优先（无扩展名的构建/容器文件）
  switch (basenameOf(path)) {
    case "makefile":
    case "gnumakefile":
      // 无专用 mode，shell 是 Make 语法最近的兜底（openchamber 同款）
      return shellLanguage
    case "dockerfile":
      return dockerfileLanguage
  }

  switch (extensionOf(path)) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true })
    case "tsx":
      return javascript({ typescript: true, jsx: true })
    case "js":
    case "mjs":
    case "cjs":
      return javascript()
    case "jsx":
      return javascript({ jsx: true })
    case "json":
    case "jsonc":
    case "json5":
    case "jsonl":
    case "ndjson":
    case "geojson":
      return json()
    case "py":
    case "pyi":
    case "pyw":
      return python()
    case "go":
      return go()
    case "rs":
      return rust()
    case "yaml":
    case "yml":
      return yaml()
    case "md":
    case "markdown":
    case "mdown":
    case "mkd":
      return markdownLanguage
    case "html":
    case "htm":
      return html()
    case "css":
    case "scss":
    case "sass":
    case "less":
      return css()
    case "sql":
      return sql()
    case "c":
    case "h":
    case "cpp":
    case "hpp":
    case "cc":
    case "cxx":
    case "hh":
      return cpp()
    case "xml":
    case "svg":
      return xml()
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return shellLanguage
    case "toml":
      return tomlLanguage
    case "ini":
    case "properties":
    case "env":
      return propertiesLanguage
    default:
      return null
  }
}
