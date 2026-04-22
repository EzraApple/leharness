export {
  appendEvent,
  type Event,
  type EventEnvelope,
  type EventOfType,
  loadEvents,
  newEventId,
  nowIso,
  resolveLeharnessHome,
  resolveSessionPath,
} from "./events.js"
export {
  compact,
  type HarnessDeps,
  runInvocation,
  runSession,
  shouldCompact,
  shouldContinue,
} from "./harness.js"
export { type BuildPromptOptions, buildPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompt.js"

export {
  callModel,
  type HarnessMessage,
  type HarnessTool,
  type HarnessToolCall,
  type Provider,
  ProviderError,
  type ProviderRequest,
  type ProviderResponse,
} from "./provider/index.js"

export { OllamaProvider, type OllamaProviderOptions } from "./provider/ollama.js"
export { OpenAIProvider, type OpenAIProviderOptions } from "./provider/openai.js"
export {
  type AssistantToolCall,
  initialSessionState,
  projectSession,
  reduce,
  type SessionState,
  type TranscriptEntry,
} from "./session.js"
export {
  type AppendEvent,
  allowAllPermissions,
  executeToolCall,
  executeToolCalls,
  type PermissionHandle,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolExecuteResult,
  ToolRegistry,
  type ToolResult,
  truncateOutput,
} from "./tools.js"
