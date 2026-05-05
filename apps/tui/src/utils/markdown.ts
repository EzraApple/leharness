import type { MarkedExtension, TokenizerAndRendererExtension, Tokens } from "marked"
import { Marked } from "marked"
import markedKatex from "marked-katex-extension"
import { markedTerminal } from "marked-terminal"
import { renderCodeBlock } from "./code.js"
import { renderMath } from "./math.js"

const parsers = new Map<number, Marked>()

export function renderMarkdown(text: string, width: number): string {
  const parser = parserForWidth(width)
  try {
    const rendered = parser.parse(text)
    return typeof rendered === "string" ? rendered.trimEnd() : text
  } catch {
    return text
  }
}

function parserForWidth(width: number): Marked {
  const safeWidth = Math.max(20, width)
  const existing = parsers.get(safeWidth)
  if (existing !== undefined) return existing

  const parser = new Marked({ gfm: true })
  parser.use(terminalKatexExtension())
  parser.use(
    markedTerminal({
      emoji: true,
      reflowText: false,
      showSectionPrefix: false,
      tab: 2,
      width: safeWidth,
    }),
  )
  parser.use(terminalCodeExtension(safeWidth))
  parsers.set(safeWidth, parser)
  return parser
}

function terminalCodeExtension(width: number): MarkedExtension {
  return {
    renderer: {
      code: (code, info) => renderCodeBlock(code, info, width),
    },
  }
}

function terminalKatexExtension(): MarkedExtension {
  const extension = markedKatex({ nonStandard: true, throwOnError: false })
  return {
    ...extension,
    extensions: extension.extensions?.map((item) => {
      if (item.name !== "inlineKatex" && item.name !== "blockKatex") return item

      return {
        ...item,
        renderer: (token: Tokens.Generic) => renderMathToken(item.name, token),
      } satisfies TokenizerAndRendererExtension
    }),
  }
}

function renderMathToken(name: string, token: Tokens.Generic): string {
  const text = typeof token.text === "string" ? token.text.trim() : ""
  const displayMode = name === "blockKatex" || token.displayMode === true
  const rendered = renderMath(text, displayMode)
  if (name === "blockKatex") return `${rendered}\n`
  return rendered
}
