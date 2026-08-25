/**
 * CodeMirror 主题扩展（design-code-view §2.4）：class 化 HighlightStyle——
 * token 着色不内联，交给 app.css 的 `.cm-*` + `--syntax-*` 语义令牌，
 * data-theme 切换即时生效、无需重建编辑器（openchamber flexokiTheme 的
 * class 层同法）。结构性样式（布局/字体/颜色）全部在 app.css 单一来源；
 * CM 自身样式（含 baseTheme，无条件注入于 Prec.lowest）插在 head.firstChild，
 * app.css 文档序靠后，同特异性时后者胜——这是 CM 设计的覆写途径。
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags as t } from "@lezer/highlight"

/** class 化语法层：tag → cm-* 类，颜色见 app.css */
const classHighlighter = HighlightStyle.define([
  { tag: [t.comment, t.docComment, t.meta, t.documentMeta], class: "cm-comment" },
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.modifier],
    class: "cm-keyword",
  },
  { tag: [t.operatorKeyword, t.operator, t.logicOperator, t.compareOperator, t.arithmeticOperator, t.definitionOperator, t.typeOperator, t.controlOperator, t.bitwiseOperator, t.updateOperator, t.derefOperator], class: "cm-operator" },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket], class: "cm-punctuation" },
  { tag: [t.string, t.regexp, t.attributeValue, t.special(t.string), t.monospace], class: "cm-string" },
  { tag: t.escape, class: "cm-string-2" },
  { tag: [t.number, t.bool, t.atom, t.null, t.self], class: "cm-number" },
  {
    tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.function(t.propertyName), t.standard(t.variableName), t.special(t.variableName)],
    class: "cm-function",
  },
  { tag: t.definition(t.variableName), class: "cm-def" },
  { tag: [t.variableName, t.local(t.variableName), t.constant(t.variableName), t.literal], class: "cm-variable" },
  { tag: t.propertyName, class: "cm-property" },
  { tag: t.attributeName, class: "cm-attribute" },
  { tag: [t.className, t.typeName, t.namespace], class: "cm-type" },
  { tag: [t.tagName, t.labelName, t.annotation, t.macroName], class: "cm-tag" },
  { tag: t.link, class: "cm-link" },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], class: "cm-keyword" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
])

export const cmSyntaxTheme = [syntaxHighlighting(classHighlighter)]
