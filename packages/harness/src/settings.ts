// settings.ts
// User-level configuration read from / written to
// <LEHARNESS_HOME>/config.json. Persists which provider + model + reasoning
// effort the user picked, so the next CLI run resumes the same runtime
// without flags. Atomic write (tmp + rename) to survive concurrent runs.

import { promises as fs } from "node:fs"
import path from "node:path"
import { resolveLeharnessHome } from "./events.js"
import type { ReasoningEffort } from "./models.js"
import { isRecord, readErrorCode } from "./readers.js"

export interface RuntimeSettings {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffort
}

export interface UserSettings {
  runtime?: RuntimeSettings
}

export async function loadUserSettings(): Promise<UserSettings> {
  let raw: string
  try {
    raw = await fs.readFile(resolveSettingsPath(), "utf8")
  } catch (err) {
    if (readErrorCode(err) === "ENOENT") return {}
    throw err
  }

  try {
    return parseUserSettings(JSON.parse(raw))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse settings: ${message}`)
  }
}

export async function saveUserSettings(settings: UserSettings) {
  const filePath = resolveSettingsPath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

export async function updateUserSettings(update: UserSettings): Promise<UserSettings> {
  const current = await loadUserSettings()
  const next: UserSettings = {
    ...current,
    ...update,
  }
  if (update.runtime !== undefined) next.runtime = update.runtime
  await saveUserSettings(next)
  return next
}

export function resolveSettingsPath(): string {
  return path.join(resolveLeharnessHome(), "settings.json")
}

function parseUserSettings(value: unknown): UserSettings {
  if (!isRecord(value)) return {}
  const candidate = value
  const runtime = parseRuntimeSettings(candidate.runtime)
  return runtime === undefined ? {} : { runtime }
}

function parseRuntimeSettings(value: unknown): RuntimeSettings | undefined {
  if (!isRecord(value)) return undefined
  const candidate = value
  if (typeof candidate.provider !== "string" || typeof candidate.model !== "string") {
    return undefined
  }
  const runtime: RuntimeSettings = {
    provider: candidate.provider,
    model: candidate.model,
  }
  if (isReasoningEffort(candidate.reasoningEffort)) {
    runtime.reasoningEffort = candidate.reasoningEffort
  }
  return runtime
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "off" || value === "high" || value === "max"
}
