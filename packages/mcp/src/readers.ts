export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readRecordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return isRecord(field) ? field : undefined
}

export function readArrayField(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return []
  const field = value[key]
  return Array.isArray(field) ? field : []
}

export function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "string" ? field : undefined
}

export function readBooleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "boolean" ? field : undefined
}

export function readNumberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "number" ? field : undefined
}

export function readErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
