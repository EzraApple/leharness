import type { Event } from "../events.js"
import type { SessionTaskServices } from "../tasks.js"
import type { Tool } from "../tools.js"

export interface CapabilityContext {
  sessionId: string
  events: ReadonlyArray<Event>
  userText: string | undefined
  taskServices: SessionTaskServices | undefined
}

export interface Capability {
  tools?(ctx: CapabilityContext): Promise<Tool[]>
  augmentSystemPrompt?(base: string, ctx: CapabilityContext): Promise<string>
}
