import { Box, Text } from "ink"
import stringWidth from "string-width"
import wrapAnsi from "wrap-ansi"
import { color } from "../theme.js"

const COLUMN_GAP = 4
const MAX_NAME_WIDTH = 30
const MIN_NAME_WIDTH = 22

export interface MenuItem {
  description: string
  kind: string
  name: string
}

export function SlashMenu({
  items,
  prefix = "/",
  selectedIndex,
  width,
}: {
  items: MenuItem[]
  prefix?: string
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
        const rowColor = selected ? color.selected : color.meta
        const descriptionLines = wrapDescription(item.description, descriptionWidth)
        const continuation = descriptionLines[1]
        const name = padToWidth(trimToWidth(`${prefix}${item.name}`, nameWidth), nameWidth)

        return (
          <Box flexDirection="column" key={`${item.kind}:${item.name}`}>
            <Box>
              <Box marginRight={COLUMN_GAP} width={nameWidth}>
                <Text color={rowColor}>{name}</Text>
              </Box>
              <Text color={rowColor}>{descriptionLines[0] ?? ""}</Text>
              {item.kind === "skill" ? <Text color={color.meta}>{"  skill"}</Text> : null}
            </Box>
            {continuation === undefined ? null : (
              <Box>
                <Box marginRight={COLUMN_GAP} width={nameWidth}>
                  <Text> </Text>
                </Box>
                <Text color={rowColor}>{continuation}</Text>
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
