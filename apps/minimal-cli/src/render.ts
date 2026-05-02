import type { Event, ToolCallRef } from "@leharness/harness"

const RESET = "\x1b[0m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"

const supportsColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined

function paint(code: string, s: string): string {
  if (!supportsColor) return s
  return `${code}${s}${RESET}`
}

const dim = (s: string) => paint(DIM, s)
const bold = (s: string) => paint(BOLD, s)
const red = (s: string) => paint(RED, s)
const yellow = (s: string) => paint(YELLOW, s)
const cyan = (s: string) => paint(CYAN, s)

export class LiveRenderer {
  private out: NodeJS.WritableStream
  private writingAssistant = false

  constructor(out: NodeJS.WritableStream = process.stdout) {
    this.out = out
  }

  echoUser(text: string): void {
    this.out.write(`${bold("> ")}${text}\n`)
  }

  onText(delta: string): void {
    this.writingAssistant = true
    this.out.write(delta)
  }

  onEvent(event: Event): void {
    switch (event.type) {
      case "model.completed":
        this.endAssistantLine()
        for (const tc of (event.toolCalls as ToolCallRef[]) ?? []) {
          this.out.write(`${dim("→")} ${cyan(tc.name)}${dim(`(${argsPreview(tc.args)})`)}\n`)
        }
        break
      case "tool.completed": {
        const lines = summarize(event.result as string, 6, 600).split("\n")
        for (const line of lines) {
          this.out.write(`${dim(`← ${line}`)}\n`)
        }
        break
      }
      case "tool.failed":
        this.out.write(`${red(`✗ ${event.error as string}`)}\n`)
        break
      case "agent.interrupted":
        this.endAssistantLine()
        this.out.write(`${yellow(`[interrupted: ${event.reason as string}]`)}\n`)
        break
      case "agent.finished":
        this.endAssistantLine()
        break
    }
  }

  private endAssistantLine(): void {
    if (this.writingAssistant) {
      this.out.write("\n")
      this.writingAssistant = false
    }
  }
}

function argsPreview(args: unknown): string {
  const s = JSON.stringify(args) ?? ""
  if (s.length > 80) return `${s.slice(0, 77)}...`
  return s
}

function summarize(s: string, maxLines: number, maxChars: number): string {
  const allLines = s.split("\n")
  const head = allLines.slice(0, maxLines).join("\n")
  const charCapped = head.length > maxChars ? `${head.slice(0, maxChars)}...` : head
  if (allLines.length > maxLines) {
    return `${charCapped}\n...(${allLines.length - maxLines} more lines)`
  }
  return charCapped
}
