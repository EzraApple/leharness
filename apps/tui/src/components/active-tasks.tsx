import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import stringWidth from "string-width"
import type { ActiveTask } from "../state/types.js"

const MAX_VISIBLE = 3

export function ActiveTasks({ tasks, width }: { tasks: Map<string, ActiveTask>; width: number }) {
  const now = useTickingNow(tasks.size > 0)
  if (tasks.size === 0) return null

  const list = Array.from(tasks.values()).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const visible = list.slice(0, MAX_VISIBLE)
  const hidden = list.length - visible.length
  const rowWidth = Math.max(24, width - 4)
  const summary = `${list.length} background task${list.length === 1 ? "" : "s"}`

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">{padToWidth(`⇣ ${summary}`, rowWidth)}</Text>
      {visible.map((task) => (
        <Text color="gray" key={task.id}>
          {padToWidth(formatTaskRow(task, now, rowWidth), rowWidth)}
        </Text>
      ))}
      {hidden > 0 ? <Text color="gray">{padToWidth(`  + ${hidden} more`, rowWidth)}</Text> : null}
    </Box>
  )
}

function formatTaskRow(task: ActiveTask, now: number, width: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - new Date(task.startedAt).getTime()) / 1000))
  const elapsed = formatElapsed(elapsedSeconds)
  const command = task.command.length > 0 ? task.command : task.kind
  const prefix = `  ${task.kind} `
  const suffix = ` (${elapsed})`
  const room = Math.max(8, width - stringWidth(prefix) - stringWidth(suffix))
  const trimmedCommand =
    stringWidth(command) > room ? `${trimToWidth(command, room - 1)}…` : command
  return `${prefix}${trimmedCommand}${suffix}`
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
  let out = ""
  for (const char of text) {
    if (stringWidth(`${out}${char}`) > width) break
    out += char
  }
  return out
}

function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - stringWidth(text)))}`
}
