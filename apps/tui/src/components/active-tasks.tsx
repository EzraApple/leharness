import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import stringWidth from "string-width"
import type { ActiveTask } from "../state/types.js"
import { color } from "../theme.js"

export function ActiveTasks({ tasks, width }: { tasks: Map<string, ActiveTask>; width: number }) {
  const now = useTickingNow(tasks.size > 0)
  if (tasks.size === 0) return null

  const list = Array.from(tasks.values()).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const rowWidth = Math.max(24, width - 4)
  const line = formatLine(list, now, rowWidth)
  const tone = list[0]?.kind === "delegated" ? color.userChevron : color.background

  return (
    <Box marginTop={1}>
      <Text color={tone}>{padToWidth(line, rowWidth)}</Text>
    </Box>
  )
}

function formatLine(tasks: ActiveTask[], now: number, width: number): string {
  const first = tasks[0]
  if (first === undefined) return ""
  const elapsed = formatElapsed(elapsedSeconds(first, now))
  const noun = taskNoun(tasks)
  const head = `⇣ ${tasks.length} ${noun} · ${labelFor(first)} (${elapsed})`
  if (tasks.length === 1) return trimToWidth(head, width)
  return trimToWidth(`${head} + ${tasks.length - 1} more`, width)
}

function labelFor(task: ActiveTask): string {
  if (task.kind === "delegated") return task.display.target ?? "subagent"
  const body = task.command.length > 0 ? task.command : task.kind
  return body.replace(/\s+/g, " ").trim()
}

function taskNoun(tasks: ActiveTask[]): string {
  const delegatedCount = tasks.filter((task) => task.kind === "delegated").length
  if (delegatedCount === tasks.length) return tasks.length === 1 ? "subagent" : "subagents"
  if (delegatedCount > 0) return "bg + subagent"
  return "bg"
}

function elapsedSeconds(task: ActiveTask, now: number): number {
  return Math.max(0, Math.floor((now - new Date(task.startedAt).getTime()) / 1000))
}

function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds.toString().padStart(2, "0")}s`
}

function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
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
