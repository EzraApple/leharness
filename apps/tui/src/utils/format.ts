export function finishReason(reason: string): string {
  if (reason === "no_tool_calls") return "done"
  if (reason === "cancelled") return "cancelled"
  if (reason === "max_steps") return "stopped: max steps reached"
  if (reason === "model_failed") return "stopped: model failed"
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
