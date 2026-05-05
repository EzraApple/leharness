export function argsPreview(args: unknown): string {
  const s = JSON.stringify(args) ?? ""
  if (s.length > 180) return `${s.slice(0, 177)}...`
  return s
}

export function finishReason(reason: string): string {
  if (reason === "no_tool_calls") return "Done"
  if (reason === "cancelled") return "Cancelled"
  if (reason === "max_steps") return "Stopped: max steps reached"
  if (reason === "model_failed") return "Stopped: model failed"
  return reason
}

export function summarize(s: string, maxLines: number, maxChars: number): string {
  const allLines = s.split("\n")
  const head = allLines.slice(0, maxLines).join("\n")
  const charCapped = head.length > maxChars ? `${head.slice(0, maxChars)}...` : head
  if (allLines.length > maxLines)
    return `${charCapped}\n...(${allLines.length - maxLines} more lines)`
  return charCapped
}
