import { highlight, supportsLanguage } from "cli-highlight"
import stringWidth from "string-width"
import wrapAnsi from "wrap-ansi"

export function renderCodeBlock(code: string, info: string | undefined, width: number): string {
  const language = readLanguage(info)
  const highlighted = highlightCode(code, language)
  const bodyWidth = Math.max(8, width - 2)
  const lines = highlighted.replace(/\s+$/g, "").split("\n")
  const title = language === undefined ? "╭─ code" : `╭─ ${language}`

  return `${[title, ...lines.flatMap((line) => renderCodeLine(line, bodyWidth)), "╰─"].join("\n")}\n\n`
}

function readLanguage(info: string | undefined): string | undefined {
  const language = info?.trim().split(/\s+/, 1)[0]
  return language === undefined || language.length === 0 ? undefined : language
}

function highlightCode(code: string, language: string | undefined): string {
  if (language === undefined || !supportsLanguage(language)) return code

  try {
    return highlight(code, { ignoreIllegals: true, language })
  } catch {
    return code
  }
}

function renderCodeLine(line: string, width: number): string[] {
  if (stringWidth(line) === 0) return ["│"]

  return wrapAnsi(line, width, { hard: true, trim: false, wordWrap: false })
    .split("\n")
    .map((part) => `│ ${part}`)
}
