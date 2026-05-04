import type { Event, ToolCall } from "@leharness/harness"

const RESET = "\x1b[0m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RED = "\x1b[31m"
const CYAN = "\x1b[36m"

const supportsColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined

function paint(code: string, s: string): string {
  if (!supportsColor) return s
  return `${code}${s}${RESET}`
}

const dim = (s: string) => paint(DIM, s)
const bold = (s: string) => paint(BOLD, s)
const red = (s: string) => paint(RED, s)
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
        if (this.writingAssistant) {
          this.endAssistantLine()
        } else {
          const text = (event.text as string) ?? ""
          if (text.length > 0) this.out.write(`${text}\n`)
        }
        for (const tc of (event.toolCalls as ToolCall[]) ?? []) {
          this.renderToolCall(tc)
        }
        break
      case "tool.completed":
        this.renderToolResult(event.result as string)
        break
      case "tool.failed":
        this.renderToolError(event.error as string)
        break
      case "model.failed":
        this.renderModelError(event.error as string)
        break
      case "agent.finished":
        this.endAssistantLine()
        this.renderTerminalReason(event.reason as string)
        this.out.write("\n")
        break
    }
  }

  replayHistory(events: Event[]): void {
    if (events.length === 0) return
    this.out.write(dim("--- prior session ---\n"))
    for (const event of events) {
      switch (event.type) {
        case "invocation.received":
          this.echoUser(event.text as string)
          break
        case "model.completed": {
          const text = (event.text as string) ?? ""
          if (text.length > 0) this.out.write(`${text}\n`)
          for (const tc of (event.toolCalls as ToolCall[]) ?? []) {
            this.renderToolCall(tc)
          }
          break
        }
        case "tool.completed":
          this.renderToolResult(event.result as string)
          break
        case "tool.failed":
          this.renderToolError(event.error as string)
          break
        case "model.failed":
          this.renderModelError(event.error as string)
          break
      }
    }
    this.out.write(`${dim("---")}\n\n`)
  }

  private renderToolCall(tc: ToolCall): void {
    this.out.write(`${dim("→")} ${cyan(tc.name)}${dim(`(${argsPreview(tc.args)})`)}\n`)
  }

  private renderToolResult(result: string): void {
    const lines = summarize(result, 6, 600).split("\n")
    for (const line of lines) {
      this.out.write(`${dim(`← ${line}`)}\n`)
    }
  }

  private renderToolError(error: string): void {
    this.out.write(`${red(`✗ ${error}`)}\n`)
  }

  private renderModelError(error: string): void {
    this.out.write(`${red(`✗ model failed: ${error}`)}\n`)
  }

  private renderTerminalReason(reason: string | undefined): void {
    if (reason === "cancelled") this.out.write(`${dim("cancelled")}\n`)
    if (reason === "max_steps") this.out.write(`${dim("stopped: max steps reached")}\n`)
    if (reason === "model_failed") this.out.write(`${dim("stopped: model failed")}\n`)
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
