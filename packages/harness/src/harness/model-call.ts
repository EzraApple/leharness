import type { RecordEvent } from "../events.js"
import type { Provider, ProviderRequest, ProviderResponse } from "../provider/index.js"
import { finishIfCancelled } from "./control.js"

type ModelCallResult = { status: "completed"; response: ProviderResponse } | { status: "finished" }

export async function callModel(
  provider: Provider,
  request: ProviderRequest,
  recordEvent: RecordEvent,
  signal: AbortSignal | undefined,
): Promise<ModelCallResult> {
  if (await finishIfCancelled(recordEvent, signal)) return { status: "finished" }

  try {
    const response = await callWithAbort(provider.call(request), signal)
    return { status: "completed", response }
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      await recordEvent("agent.finished", { reason: "cancelled" })
      return { status: "finished" }
    }

    await recordEvent("model.failed", { error: errorMessage(err) })
    await recordEvent("agent.finished", { reason: "model_failed" })
    return { status: "finished" }
  }
}

export async function recordModelCompleted(
  response: ProviderResponse,
  recordEvent: RecordEvent,
): Promise<void> {
  await recordEvent("model.completed", {
    text: response.text,
    toolCalls: response.toolCalls,
    usage: response.usage,
  })
}

function callWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
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

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError"
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
