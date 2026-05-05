import { Box, Text } from "ink"
import wrapAnsi from "wrap-ansi"
import type { SlashItem } from "../slash/types.js"

const NAME_WIDTH = 18

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

  const descriptionWidth = Math.max(20, width - NAME_WIDTH - 6)

  return (
    <Box flexDirection="column" marginTop={0} paddingX={1}>
      {items.map((item, index) => {
        const selected = index === selectedIndex
        const color = selected ? "blue" : "gray"
        const descriptionLines = wrapDescription(item.description, descriptionWidth)
        const continuation = descriptionLines[1]
        const name = `/${item.name}`.padEnd(NAME_WIDTH)

        return (
          <Box flexDirection="column" key={`${item.kind}:${item.name}`}>
            <Text color={color}>
              {name}
              {descriptionLines[0] ?? ""}
            </Text>
            {continuation === undefined ? null : (
              <Text color={color}>
                {" ".repeat(NAME_WIDTH)}
                {continuation}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export function slashMenuHeight(items: SlashItem[]): number {
  return items.reduce(
    (height, item) => height + Math.min(2, item.description.length > 70 ? 2 : 1),
    0,
  )
}

function wrapDescription(description: string, width: number): string[] {
  const lines = wrapAnsi(description, width, { hard: true, trim: true, wordWrap: true }).split("\n")
  return lines.slice(0, 2)
}
