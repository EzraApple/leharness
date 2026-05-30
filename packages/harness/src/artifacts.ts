// artifacts.ts
// Session-scoped on-disk storage for large content. The harness's loop
// auto-artifacts any tool output (or drained task completion) bigger than
// AUTO_ARTIFACT_THRESHOLD_BYTES, writes the full content to
// .leharness/sessions/<sessionId>/artifacts/<artifactId>, and replaces the
// in-context value with a short stub plus the artifact file path. The model
// can use the caller-provided read_file tool with offset/limit to inspect
// more detail without dumping the whole file back into context.

import { promises as fs } from "node:fs"
import path from "node:path"
import { ulid } from "ulid"
import { resolveLeharnessHome } from "./events.js"

export const AUTO_ARTIFACT_THRESHOLD_BYTES = 8 * 1024
const STUB_HEAD_CHARS = 400

export interface Artifact {
  id: string
  sessionId: string
  createdAt: string
  byteCount: number
  mime?: string
}

export interface WriteArtifactOptions {
  mime?: string
  sourceCallId?: string
  sourceTaskId?: string
}

function newArtifactId(): string {
  return `artifact_${ulid()}`
}

export function resolveArtifactPath(sessionId: string, artifactId: string): string {
  return path.join(resolveLeharnessHome(), "sessions", sessionId, "artifacts", artifactId)
}

export async function writeArtifact(
  sessionId: string,
  content: string | Buffer,
  options: WriteArtifactOptions = {},
): Promise<Artifact> {
  const id = newArtifactId()
  const filePath = resolveArtifactPath(sessionId, id)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content
  await fs.writeFile(filePath, buffer)
  return {
    id,
    sessionId,
    createdAt: new Date().toISOString(),
    byteCount: buffer.byteLength,
    mime: options.mime,
  }
}

export async function readArtifact(
  sessionId: string,
  artifactId: string,
): Promise<{ content: string; byteCount: number }> {
  const filePath = resolveArtifactPath(sessionId, artifactId)
  const buffer = await fs.readFile(filePath)
  return { content: buffer.toString("utf8"), byteCount: buffer.byteLength }
}

export function formatArtifactStub(artifact: Artifact, content: string): string {
  const head = content.length > STUB_HEAD_CHARS ? `${content.slice(0, STUB_HEAD_CHARS)}…` : content
  const mime = artifact.mime !== undefined ? ` · ${artifact.mime}` : ""
  const filePath = resolveArtifactPath(artifact.sessionId, artifact.id)
  return `[artifact: ${filePath} · ${artifact.byteCount} bytes${mime} · head:\n${head}\nUse read_file with path="${filePath}", offset=1, limit=400 to inspect more.]`
}
