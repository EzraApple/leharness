import { Box, Text } from "ink"
import stringWidth from "string-width"
import wrapAnsi from "wrap-ansi"
import type { SlashItem } from "../slash/types.js"

const COLUMN_GAP = 4
const MAX_NAME_WIDTH = 30
const MIN_NAME_WIDTH = 22

export function SlashMenu({
  items,
  selectedIndex,
  width,
}: {
  items: SlashItem[]
  selectedIndex: number
  width: number
}) {
  if (items.length === 0) return null

  const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(MIN_NAME_WIDTH, Math.floor(width * 0.28)))
  const descriptionWidth = Math.max(20, width - nameWidth - COLUMN_GAP - 4)

  return (
    <Box flexDirection="column" marginTop={0} paddingX={1}>
      {items.map((item, index) => {
        const selected = index === selectedIndex
        const color = selected ? "blue" : "gray"
        const descriptionLines = wrapDescription(item.description, descriptionWidth)
        const continuation = descriptionLines[1]
        const name = padToWidth(trimToWidth(`/${item.name}`, nameWidth), nameWidth)

        return (
          <Box flexDirection="column" key={`${item.kind}:${item.name}`}>
            <Box>
              <Box marginRight={COLUMN_GAP} width={nameWidth}>
                <Text color={color}>{name}</Text>
              </Box>
              <Text color={color}>{descriptionLines[0] ?? ""}</Text>
            </Box>
            {continuation === undefined ? null : (
              <Box>
                <Box marginRight={COLUMN_GAP} width={nameWidth}>
                  <Text> </Text>
                </Box>
                <Text color={color}>{continuation}</Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

function wrapDescription(description: string, width: number): string[] {
  const lines = wrapAnsi(description, width, { hard: true, trim: true, wordWrap: true }).split("\n")
  return lines.slice(0, 2)
}

function trimToWidth(text: string, width: number): string {
  if (stringWidth(text) <= width) return text
  const target = Math.max(1, width - 1)
  let out = ""
  for (const char of text) {
    if (stringWidth(`${out}${char}`) > target) break
    out += char
  }
  return `${out}…`
}

function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - stringWidth(text)))}`
}
