// model-call.ts
// One model round-trip: build the request from the prepared prompt, attach
// cancellation-aware passthroughs to the streaming callbacks, race the
// provider against the AbortSignal, and return a discriminated result the
// loop can branch on (completed / cancelled / failed).

import { buildRequest, type PromptInput } from "../prompt.js"
import type { Provider, ProviderResponse, ToolCallDelta } from "../provider/index.js"

type PromptResult =
  | { kind: "completed"; response: ProviderResponse }
  | { kind: "cancelled"; text: string }
  | { kind: "failed"; error: string }

export async function sendPrompt(
  provider: Provider,
  prompt: PromptInput,
  signal: AbortSignal | undefined,
): Promise<PromptResult> {
  let emittedText = ""
  try {
    const request = buildRequest(prompt)
    const forwardText = request.onText
    request.onText =
      forwardText === undefined
        ? undefined
        : (delta: string) => {
            if (signal?.aborted === true) return
            emittedText += delta
            forwardText(delta)
          }
    const forwardToolCallDelta = request.onToolCallDelta
    request.onToolCallDelta =
      forwardToolCallDelta === undefined
        ? undefined
        : (delta: ToolCallDelta) => {
            if (signal?.aborted === true) return
            forwardToolCallDelta(delta)
          }
    const response = await waitForProvider(() => provider.call(request), signal)
    return signal?.aborted === true
      ? { kind: "cancelled", text: emittedText }
      : { kind: "completed", response }
  } catch (err) {
    if (signal?.aborted === true || (err instanceof DOMException && err.name === "AbortError")) {
      return { kind: "cancelled", text: emittedText }
    }
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) }
  }
}

function waitForProvider<T>(call: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return call()
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    call().then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      },
    )
  })
}
