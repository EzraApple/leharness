import * as crypto from "node:crypto"
import type { Dirent } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { z } from "zod"
import type { Event } from "./events.js"
import type { Tool, ToolContext, ToolExecuteResult } from "./tools.js"

export type SkillSource = "workspace_agents" | "workspace_claude"

export interface Skill {
  name: string
  description: string
  path: string
  relativePath: string
  source: SkillSource
  mtimeMs: number
  size: number
  contentHash: string
}

export interface SkillCatalogOptions {
  budgetChars?: number
  includePaths?: boolean
  queryText?: string
  recentSkillNames?: string[]
}

export interface SkillOptions {
  enabled?: boolean
  root?: string
  catalogBudgetChars?: number
  includePaths?: boolean
  maxSkillBytes?: number
}

const DEFAULT_CATALOG_BUDGET_CHARS = 6000
const DEFAULT_MAX_SKILL_BYTES = 32 * 1024
const DESCRIPTION_CAPS = [240, 120, 60]

const skillDirs: Array<{ dir: string; source: SkillSource }> = [
  { dir: path.join(".agents", "skills"), source: "workspace_agents" },
  { dir: path.join(".claude", "skills"), source: "workspace_claude" },
]

const loadSkillArgs = z.object({
  name: z.string().describe("Name of the skill to load from the discovered skill registry."),
})

type LoadSkillArgs = z.infer<typeof loadSkillArgs>

export async function discoverSkills(root = process.cwd()): Promise<Skill[]> {
  const workspaceRoot = path.resolve(root)
  const skills: Skill[] = []
  for (const location of skillDirs) {
    const baseDir = path.join(workspaceRoot, location.dir)
    let entries: Dirent[]
    try {
      entries = await fs.readdir(baseDir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
      throw err
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillPath = path.join(baseDir, entry.name, "SKILL.md")
      const skill = await readSkill(workspaceRoot, skillPath, location.source, entry.name)
      if (skill !== undefined) skills.push(skill)
    }
  }
  return sortSkillsForPrecedence(skills)
}

export function renderSkillCatalog(skills: Skill[], options: SkillCatalogOptions = {}): string {
  if (skills.length === 0) return ""

  const budgetChars = options.budgetChars ?? DEFAULT_CATALOG_BUDGET_CHARS
  const ranked = rankSkills(skills, {
    queryText: options.queryText ?? "",
    recentSkillNames: options.recentSkillNames ?? [],
  })

  for (const cap of DESCRIPTION_CAPS) {
    const rendered = renderCatalogEntries(ranked, {
      budgetChars,
      descriptionCap: cap,
      includePaths: options.includePaths ?? false,
      totalCount: skills.length,
    })
    if (rendered.length <= budgetChars) return rendered
  }

  return renderCatalogEntries(ranked, {
    budgetChars,
    descriptionCap: DESCRIPTION_CAPS[DESCRIPTION_CAPS.length - 1] ?? 60,
    includePaths: options.includePaths ?? false,
    totalCount: skills.length,
  })
}

export function createLoadSkillTool(
  options: { root?: string; maxSkillBytes?: number } = {},
): Tool<LoadSkillArgs> {
  return {
    name: "load_skill",
    description:
      "Load the full instructions for a discovered skill by name. Call this before applying a listed skill.",
    schema: loadSkillArgs,
    async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
      const root = path.resolve(options.root ?? process.cwd())
      const skills = await discoverSkills(root)
      const matches = skills.filter((skill) => skill.name === args.name)
      if (matches.length === 0) {
        const available = skills.map((skill) => skill.name).join(", ")
        const suffix =
          available.length > 0 ? ` Available skills: ${available}` : " No skills found."
        return { kind: "error", message: `skill not found: ${args.name}.${suffix}` }
      }

      const skill = matches[0]
      if (skill === undefined) return { kind: "error", message: `skill not found: ${args.name}` }

      const body = await readSkillBody(skill.path, options.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES)
      const supportingFiles = await listSupportingFiles(path.dirname(skill.path))
      const shadowed = matches.slice(1)

      await ctx.recordEvent?.("skill.loaded", {
        name: skill.name,
        path: skill.relativePath,
        source: skill.source,
        contentHash: skill.contentHash,
      })

      return {
        kind: "ok",
        output: renderLoadedSkill(skill, body, supportingFiles, shadowed),
      }
    },
  }
}

export function skillOptionsEnabled(options: SkillOptions | false | undefined): boolean {
  return options !== false && options?.enabled !== false
}

export function recentLoadedSkillNames(events: Event[]): string[] {
  const names: string[] = []
  for (const event of events) {
    if (event.type !== "skill.loaded" || typeof event.name !== "string") continue
    names.push(event.name)
  }
  return [...new Set(names.reverse())]
}

export function withSkillCatalog(system: string, catalog: string): string {
  if (catalog.length === 0) return system
  return `${system}\n\n${catalog}`
}

async function readSkill(
  workspaceRoot: string,
  skillPath: string,
  source: SkillSource,
  directoryName: string,
): Promise<Skill | undefined> {
  let raw: string
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    raw = await fs.readFile(skillPath, "utf8")
    stat = await fs.stat(skillPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }

  const frontmatter = parseFrontmatter(raw)
  const name = cleanMetadataValue(frontmatter.name) ?? directoryName
  const description =
    cleanMetadataValue(frontmatter.description) ??
    firstParagraphDescription(raw) ??
    "No description provided."

  return {
    name,
    description: truncateWhitespace(description, 500),
    path: skillPath,
    relativePath: toRelativePath(workspaceRoot, skillPath),
    source,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    contentHash: `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`,
  }
}

function parseFrontmatter(raw: string): Record<string, string> {
  if (!raw.startsWith("---\n")) return {}
  const end = raw.indexOf("\n---", 4)
  if (end === -1) return {}

  const out: Record<string, string> = {}
  const lines = raw.slice(4, end).split("\n")
  for (const line of lines) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    const value = match[2]
    if (key === undefined || value === undefined) continue
    out[key] = stripQuotes(value.trim())
  }
  return out
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function cleanMetadataValue(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  if (cleaned === undefined || cleaned.length === 0) return undefined
  return cleaned
}

function firstParagraphDescription(raw: string): string | undefined {
  const body = raw.startsWith("---\n") ? stripFrontmatter(raw) : raw
  const paragraphs = body.split(/\n\s*\n/g)
  for (const paragraph of paragraphs) {
    const cleaned = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .join(" ")
      .trim()
    if (cleaned.length > 0) return truncateWhitespace(cleaned, 240)
  }
  return undefined
}

function stripFrontmatter(raw: string): string {
  const end = raw.indexOf("\n---", 4)
  if (end === -1) return raw
  const after = raw.indexOf("\n", end + 4)
  return after === -1 ? "" : raw.slice(after + 1)
}

function rankSkills(
  skills: Skill[],
  options: { queryText: string; recentSkillNames: string[] },
): Skill[] {
  const queryTokens = tokenize(options.queryText)
  const recent = new Set(options.recentSkillNames)
  return [...skills].sort((a, b) => {
    const diff = scoreSkill(b, queryTokens, recent) - scoreSkill(a, queryTokens, recent)
    if (diff !== 0) return diff
    return compareSkillPrecedence(a, b)
  })
}

function scoreSkill(skill: Skill, queryTokens: Set<string>, recent: Set<string>): number {
  const nameTokens = tokenize(skill.name)
  const descriptionTokens = tokenize(skill.description)
  let score = sourceScore(skill.source)
  if (recent.has(skill.name)) score += 300
  if (queryMentionsSkill(skill.name, queryTokens)) score += 1000
  for (const token of queryTokens) {
    if (nameTokens.has(token)) score += 80
    if (descriptionTokens.has(token)) score += 30
  }
  score -= Math.floor(skill.description.length / 200)
  return score
}

function queryMentionsSkill(name: string, queryTokens: Set<string>): boolean {
  const normalized = normalizeToken(name)
  if (queryTokens.has(normalized)) return true
  for (const token of tokenize(name)) {
    if (queryTokens.has(token)) return true
  }
  return false
}

function renderCatalogEntries(
  skills: Skill[],
  options: {
    budgetChars: number
    descriptionCap: number
    includePaths: boolean
    totalCount: number
  },
): string {
  const header = [
    "Available skills. Call load_skill({name}) before applying a skill.",
    `Showing 0 of ${options.totalCount} discovered skills.`,
    "",
  ]
  const footer = [
    "",
    "Some skills may be omitted by budget. If needed, inspect workspace skill directories or ask for the exact skill name.",
  ]
  const entries: string[] = []

  for (const skill of skills) {
    const pathPart = options.includePaths ? ` [${skill.relativePath}]` : ""
    const line = `- ${skill.name}${pathPart}: ${truncateWhitespace(skill.description, options.descriptionCap)}`
    const next = renderCatalog(header, entries.concat(line), footer, options.totalCount)
    if (next.length > options.budgetChars && entries.length > 0) break
    if (next.length > options.budgetChars) break
    entries.push(line)
  }

  return renderCatalog(header, entries, footer, options.totalCount)
}

function renderCatalog(
  header: string[],
  entries: string[],
  footer: string[],
  totalCount: number,
): string {
  const lines = [...header]
  lines[1] = `Showing ${entries.length} of ${totalCount} discovered skills.`
  lines.push(...entries, ...footer)
  return lines.join("\n")
}

async function readSkillBody(skillPath: string, maxBytes: number): Promise<string> {
  const raw = await fs.readFile(skillPath)
  if (raw.byteLength <= maxBytes) return raw.toString("utf8")
  let cut = maxBytes
  while (cut > 0) {
    const byte = raw[cut]
    if (byte === undefined) break
    if ((byte & 0xc0) !== 0x80) break
    cut--
  }
  return `${raw.subarray(0, cut).toString("utf8")}\n[skill truncated: ${raw.byteLength - cut} bytes]`
}

async function listSupportingFiles(skillDir: string): Promise<string[]> {
  const out: string[] = []
  let entries: Dirent[]
  try {
    entries = await fs.readdir(skillDir, { withFileTypes: true })
  } catch {
    return out
  }

  for (const entry of entries) {
    if (entry.name === "SKILL.md") continue
    if (entry.isFile()) out.push(entry.name)
    if (!entry.isDirectory()) continue
    let nested: Dirent[]
    try {
      nested = await fs.readdir(path.join(skillDir, entry.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of nested) {
      if (child.isFile()) out.push(path.join(entry.name, child.name))
      if (out.length >= 20) return out.sort()
    }
  }
  return out.sort().slice(0, 20)
}

function renderLoadedSkill(
  skill: Skill,
  body: string,
  supportingFiles: string[],
  shadowed: Skill[],
): string {
  const lines = [
    `Loaded skill: ${skill.name}`,
    `Path: ${skill.relativePath}`,
    `Hash: ${skill.contentHash}`,
    "",
    body,
  ]

  if (supportingFiles.length > 0) {
    lines.push("", "Supporting files:")
    for (const file of supportingFiles) lines.push(`- ${toPosixPath(file)}`)
  }

  if (shadowed.length > 0) {
    lines.push("", "Shadowed skills:")
    for (const other of shadowed) lines.push(`- ${other.relativePath}`)
  }

  return lines.join("\n")
}

function sortSkillsForPrecedence(skills: Skill[]): Skill[] {
  return [...skills].sort(compareSkillPrecedence)
}

function compareSkillPrecedence(a: Skill, b: Skill): number {
  const sourceDiff = sourceScore(b.source) - sourceScore(a.source)
  if (sourceDiff !== 0) return sourceDiff
  const nameDiff = a.name.localeCompare(b.name)
  if (nameDiff !== 0) return nameDiff
  return a.relativePath.localeCompare(b.relativePath)
}

function sourceScore(source: SkillSource): number {
  if (source === "workspace_agents") return 100
  return 90
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .split(/[^A-Za-z0-9_-]+/g)
    .map(normalizeToken)
    .filter((token) => token.length > 0)
  return new Set(tokens)
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/^[$/]+/, "")
}

function truncateWhitespace(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxChars) return normalized
  if (maxChars <= 3) return normalized.slice(0, maxChars)
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`
}

function toRelativePath(root: string, target: string): string {
  return toPosixPath(path.relative(root, target))
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/")
}
