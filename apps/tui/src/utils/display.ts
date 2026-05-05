const LOAD_SKILL_HINT = /^\[Please load skill: ([^\]]+)\]$/

export function collapseSkillLoadHints(text: string): string {
  const skillNames: string[] = []
  const bodyLines: string[] = []

  for (const line of text.split("\n")) {
    const match = LOAD_SKILL_HINT.exec(line.trim())
    const name = match?.[1]
    if (name !== undefined && name.length > 0) {
      skillNames.push(name)
      continue
    }
    bodyLines.push(line)
  }

  if (skillNames.length === 0) return text
  const tokens = skillNames.map((name) => `/${name}`).join(" ")
  const body = bodyLines.join("\n").trim()
  return body.length > 0 ? `${tokens} ${body}` : tokens
}
