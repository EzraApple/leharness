import * as fs from "node:fs/promises"
import * as path from "node:path"

const root = process.cwd()
const agentsDir = path.join(root, ".agents", "skills")
const claudeDir = path.join(root, ".claude", "skills")
const codexDir = path.join(root, ".codex", "skills")

const errors = []

async function exists(target) {
  try {
    await fs.lstat(target)
    return true
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return false
    }
    throw err
  }
}

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) return undefined
  const fields = new Map()
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!field) continue
    fields.set(field[1], field[2].replace(/^["']|["']$/g, ""))
  }
  return fields
}

async function skillNames() {
  const entries = await fs.readdir(agentsDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

for (const disallowed of [codexDir]) {
  if (await exists(disallowed)) {
    errors.push(`${path.relative(root, disallowed)} should not exist; use .agents/skills instead.`)
  }
}

if (!(await exists(agentsDir))) {
  errors.push(".agents/skills is missing.")
} else {
  for (const name of await skillNames()) {
    const skillPath = path.join(agentsDir, name, "SKILL.md")
    if (!(await exists(skillPath))) {
      errors.push(`${path.relative(root, skillPath)} is missing.`)
      continue
    }

    const frontmatter = parseFrontmatter(await fs.readFile(skillPath, "utf8"))
    if (!frontmatter) {
      errors.push(`${path.relative(root, skillPath)} is missing YAML frontmatter.`)
      continue
    }

    if (frontmatter.get("name") !== name) {
      errors.push(`${path.relative(root, skillPath)} must set name: ${name}.`)
    }
    if (!frontmatter.get("description")) {
      errors.push(`${path.relative(root, skillPath)} must set a non-empty description.`)
    }

    const claudePath = path.join(claudeDir, name)
    if (!(await exists(claudePath))) {
      errors.push(`${path.relative(root, claudePath)} symlink is missing.`)
      continue
    }
    const stat = await fs.lstat(claudePath)
    if (!stat.isSymbolicLink()) {
      errors.push(`${path.relative(root, claudePath)} must be a symlink.`)
      continue
    }
    const target = await fs.readlink(claudePath)
    const expected = `../../.agents/skills/${name}`
    if (target !== expected) {
      errors.push(`${path.relative(root, claudePath)} points to ${target}; expected ${expected}.`)
    }
  }

  if (await exists(claudeDir)) {
    const claudeEntries = await fs.readdir(claudeDir)
    const agentNames = new Set(await skillNames())
    for (const name of claudeEntries) {
      if (!agentNames.has(name)) {
        errors.push(`${path.join(".claude", "skills", name)} has no matching .agents skill.`)
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`skill lint: ${error}`)
  }
  process.exit(1)
}

console.log("skill lint: ok")
