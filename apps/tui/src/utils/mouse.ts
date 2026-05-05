const ESC = "\u001b"
const OPTIONAL_ESC = `${ESC}?`
const SGR_MOUSE_PATTERN = new RegExp(`${OPTIONAL_ESC}\\[<(\\d+);\\d+;\\d+([mM])`, "g")
const X10_MOUSE_PATTERN = new RegExp(`${OPTIONAL_ESC}\\[M([\\s\\S])[\\s\\S][\\s\\S]`, "g")
const WHEEL_SCROLL_LINES = 3

export const ENABLE_MOUSE_REPORTING = "\u001b[?1000h\u001b[?1006h"
export const DISABLE_MOUSE_REPORTING = "\u001b[?1000l\u001b[?1006l"

export function mouseWheelDelta(input: string): number {
  let delta = 0

  for (const match of input.matchAll(SGR_MOUSE_PATTERN)) {
    if (match[2] !== "M") continue
    delta += wheelDeltaFromButton(Number(match[1]))
  }

  for (const match of input.matchAll(X10_MOUSE_PATTERN)) {
    delta += wheelDeltaFromButton((match[1]?.charCodeAt(0) ?? 32) - 32)
  }

  return delta
}

export function stripMouseSequences(input: string): string {
  return input.replace(SGR_MOUSE_PATTERN, "").replace(X10_MOUSE_PATTERN, "")
}

function wheelDeltaFromButton(rawButton: number): number {
  if ((rawButton & 64) === 0) return 0

  const direction = rawButton & 3
  if (direction === 0) return -WHEEL_SCROLL_LINES
  if (direction === 1) return WHEEL_SCROLL_LINES
  return 0
}
