import { parseDocument } from "htmlparser2"
import katex from "katex"

interface DomNode {
  children?: DomNode[]
  data?: string
  name?: string
  type?: string
}

const SUBSCRIPT: Record<string, string> = {
  "(": "₍",
  ")": "₎",
  "+": "₊",
  "-": "₋",
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "=": "₌",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
}

const SUPERSCRIPT: Record<string, string> = {
  "(": "⁽",
  ")": "⁾",
  "+": "⁺",
  "-": "⁻",
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "=": "⁼",
  i: "ⁱ",
  n: "ⁿ",
}

export function renderMath(text: string, displayMode: boolean): string {
  try {
    const html = katex.renderToString(text, {
      displayMode,
      output: "mathml",
      throwOnError: false,
    })
    return normalizeMathText(renderNode(findMathNode(parseDocument(html) as DomNode) ?? undefined))
  } catch {
    return text.trim()
  }
}

function findMathNode(node: DomNode | undefined): DomNode | undefined {
  if (node?.name === "math") return node
  for (const child of node?.children ?? []) {
    const match = findMathNode(child)
    if (match !== undefined) return match
  }
  return undefined
}

function renderNode(node: DomNode | undefined): string {
  if (node === undefined) return ""
  if (node.type === "text") return node.data ?? ""

  const children = node.children ?? []
  switch (node.name) {
    case "annotation":
      return ""
    case "math":
    case "semantics":
      return renderChildren(children)
    case "mrow":
      return renderChildren(children)
    case "msub":
      return `${renderNode(children[0])}${script(renderNode(children[1]), SUBSCRIPT, "_")}`
    case "msup":
      return `${renderNode(children[0])}${script(renderNode(children[1]), SUPERSCRIPT, "^")}`
    case "msubsup":
      return `${renderNode(children[0])}${script(renderNode(children[1]), SUBSCRIPT, "_")}${script(
        renderNode(children[2]),
        SUPERSCRIPT,
        "^",
      )}`
    case "msqrt":
      return `√(${renderChildren(children)})`
    case "mfrac":
      return `(${renderNode(children[0])})/(${renderNode(children[1])})`
    case "mo":
    case "mi":
    case "mn":
    case "mtext":
      return renderChildren(children)
    default:
      return renderChildren(children)
  }
}

function renderChildren(children: DomNode[]): string {
  return children.map((child) => renderNode(child)).join("")
}

function script(text: string, alphabet: Record<string, string>, fallbackPrefix: string): string {
  const normalized = normalizeMathText(text)
  let rendered = ""
  for (const char of normalized) {
    const mapped = alphabet[char]
    if (mapped === undefined) return `${fallbackPrefix}{${normalized}}`
    rendered += mapped
  }
  return rendered
}

function normalizeMathText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*([,;:])\s*/g, "$1 ")
    .replace(/\s*([=+±×÷<>])\s*/g, " $1 ")
    .replace(/\s*([−-])\s*/g, " $1 ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+/g, " ")
    .trim()
}
