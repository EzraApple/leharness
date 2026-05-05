import type { Skill } from "@leharness/harness"
import { SLASH_COMMANDS } from "./commands.js"
import type { SlashItem, SlashToken } from "./types.js"

const MAX_RESULTS = 5

export function findSlashToken(input: string): SlashToken | undefined {
  const match = /(^|\s)(\/[^\s]*)$/.exec(input)
  if (match === null) return undefined

  const prefix = match[1] ?? ""
  const token = match[2]
  if (token === undefined) return undefined

  const start = match.index + prefix.length
  return {
    end: input.length,
    query: token.slice(1),
    start,
    token,
  }
}

export function searchSlashItems(skills: Skill[], query: string): SlashItem[] {
  const items = dedupeSlashItems([
    ...SLASH_COMMANDS.map(
      (command): SlashItem => ({
        description: command.description,
        kind: "command",
        name: command.name,
      }),
    ),
    ...skills.map(
      (skill): SlashItem => ({
        description: skill.description,
        kind: "skill",
        name: skill.name,
        skill,
      }),
    ),
  ])

  return items
    .map((item, index) => ({ index, item, score: scoreItem(item, query) }))
    .filter((entry) => query.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.item)
}

function dedupeSlashItems(items: SlashItem[]): SlashItem[] {
  const seen = new Set<string>()
  const deduped: SlashItem[] = []
  for (const item of items) {
    const key = `${item.kind}:${normalize(item.name)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }
  return deduped
}

export function replaceSlashToken(input: string, token: SlashToken, item: SlashItem): string {
  const replacement = `/${item.name}`
  return `${input.slice(0, token.start)}${replacement} ${input.slice(token.end)}`.replace(
    /\s+$/g,
    " ",
  )
}

export function expandSkillTokens(input: string, skills: Skill[]): string {
  const skillNames = new Set(skills.map((skill) => skill.name))
  const loadHints: string[] = []
  const body = input
    .split(/\s+/g)
    .filter((part) => {
      if (!part.startsWith("/")) return true
      const name = part.slice(1)
      if (!skillNames.has(name)) return true
      loadHints.push(`[Please load skill: ${name}]`)
      return false
    })
    .join(" ")
    .trim()

  if (loadHints.length === 0) return input
  return [...loadHints, body].filter((part) => part.length > 0).join("\n")
}

function scoreItem(item: SlashItem, query: string): number {
  const normalizedQuery = normalize(query)
  if (normalizedQuery.length === 0) return item.kind === "command" ? 200 : 100

  const name = normalize(item.name)
  const description = normalize(item.description)
  let score = 0

  if (name === normalizedQuery) score += 1000
  if (name.startsWith(normalizedQuery)) score += 700
  if (name.includes(normalizedQuery)) score += 400

  for (const token of normalizedQuery.split(/\s+/g)) {
    if (token.length === 0) continue
    if (name.includes(token)) score += 120
    if (description.includes(token)) score += 60
  }

  return score
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/^\/+/, "").trim()
}
