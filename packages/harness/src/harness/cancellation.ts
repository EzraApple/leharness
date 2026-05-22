// cancellation.ts
// Tiny shared helpers for AbortSignal-based cancellation. The loop checks
// signal aborts in multiple spots (between steps, around the model call,
// inside tool execution); keeping the predicates here so every caller asks
// the same question the same way.

export function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export function isProviderCancelled(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof DOMException && err.name === "AbortError")
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
