// artifacts.ts
// Session-scoped on-disk storage for large content. The harness's loop
// auto-artifacts any tool output (or drained task completion) bigger than
// AUTO_ARTIFACT_THRESHOLD_BYTES, writes the full content to
// .leharness/sessions/<sessionId>/artifacts/<artifactId>, and replaces the
// in-context value with a short stub plus the artifact id. The model uses
// the built-in read_artifact tool to pull the full content (or a paginated
// slice) when it actually needs the detail.
//
// Designed to be opt-out via HarnessDeps.artifacts = false. When disabled
// the harness falls back to the existing 16KB truncation cap. See plan 006
// for the full removability story.

import { promises as fs } from "node:fs"
import path from "node:path"
import { ulid } from "ulid"
import { z } from "zod"
import { resolveLeharnessHome } from "./events.js"
import type { Tool, ToolContext, ToolExecuteResult } from "./tools.js"

export const AUTO_ARTIFACT_THRESHOLD_BYTES = 8 * 1024
export const STUB_HEAD_CHARS = 400
const MAX_ARTIFACT_READ_BYTES = 16 * 1024

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

export interface ArtifactOptions {
  autoThresholdBytes?: number
}

export function newArtifactId(): string {
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
  return `[artifact: ${artifact.id} · ${artifact.byteCount} bytes${mime} · head:\n${head}\n]`
}

const readArtifactArgs = z.object({
  artifact_id: z.string().describe("Id of an artifact previously surfaced in a tool result."),
  since_byte: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Byte cursor to read from; omit to read from the start."),
})

type ReadArtifactArgs = z.infer<typeof readArtifactArgs>

export const readArtifactTool: Tool<ReadArtifactArgs> = {
  name: "read_artifact",
  description:
    "Read the full content (or a paginated slice) of an artifact stored on disk. Tool results larger than 8KB are automatically written to an artifact and replaced in your prompt with a stub like [artifact: artifact_xxx · N bytes · head: ...]. Call read_artifact with the id to fetch the original content. Returns up to 16KB per call; use since_byte to paginate.",
  schema: readArtifactArgs,
  async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
    try {
      const { content, byteCount } = await readArtifact(ctx.sessionId, args.artifact_id)
      const cursor = args.since_byte ?? 0
      if (cursor >= byteCount) {
        return {
          kind: "ok",
          output: `[artifact ${args.artifact_id} · ${byteCount} bytes · cursor ${cursor} → ${byteCount}]\n`,
          summary: `${byteCount} bytes total · at end`,
        }
      }
      const buffer = Buffer.from(content, "utf8").subarray(cursor)
      const sliceBytes = Math.min(buffer.byteLength, MAX_ARTIFACT_READ_BYTES)
      const slice = buffer.subarray(0, sliceBytes).toString("utf8")
      const nextCursor = cursor + sliceBytes
      const body = `[artifact ${args.artifact_id} · ${byteCount} bytes · cursor ${cursor} → ${nextCursor}]\n${slice}`
      return {
        kind: "ok",
        output: body,
        summary: `${sliceBytes} bytes returned`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { kind: "error", message: `read_artifact failed: ${message}` }
    }
  },
}

export function resolveArtifactOptions(
  config: ArtifactOptions | false | undefined,
): { enabled: false } | { enabled: true; thresholdBytes: number } {
  if (config === false) return { enabled: false }
  return {
    enabled: true,
    thresholdBytes: config?.autoThresholdBytes ?? AUTO_ARTIFACT_THRESHOLD_BYTES,
  }
}
