import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const rootPackagePath = path.join(root, "package.json")
const rootPackage = JSON.parse(await fs.readFile(rootPackagePath, "utf8"))
const cliPackage = JSON.parse(
  await fs.readFile(path.join(root, "apps", "cli", "package.json"), "utf8"),
)
const harnessPackage = JSON.parse(
  await fs.readFile(path.join(root, "packages", "harness", "package.json"), "utf8"),
)

const bundledEntry = path.join(root, "apps", "cli", "dist", "index.js")
await assertReadable(bundledEntry, "Missing bundled CLI entry. Run `pnpm build` first.")

const packageRoot = path.join(root, "dist", "npm", "leharness")
await fs.rm(packageRoot, { recursive: true, force: true })
await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true })

await fs.copyFile(bundledEntry, path.join(packageRoot, "dist", "index.js"))
await fs.chmod(path.join(packageRoot, "dist", "index.js"), 0o755)

await copyIfExists(path.join(root, "README.md"), path.join(packageRoot, "README.md"))
await copyDirIfExists(path.join(root, "assets"), path.join(packageRoot, "assets"))

const npmPackage = {
  name: "leharness",
  version: rootPackage.version,
  description: "Experimental agent harness CLI.",
  type: "module",
  bin: {
    lh: "dist/index.js",
  },
  files: ["dist", "README.md", "assets"],
  engines: rootPackage.engines,
  dependencies: publishDependencies([
    cliPackage.dependencies ?? {},
    harnessPackage.dependencies ?? {},
  ]),
  publishConfig: {
    access: "public",
  },
}

await fs.writeFile(
  path.join(packageRoot, "package.json"),
  `${JSON.stringify(npmPackage, null, 2)}\n`,
)

console.log(`Prepared npm package at ${path.relative(root, packageRoot)}`)

async function assertReadable(filePath, message) {
  try {
    await fs.access(filePath, constants.R_OK)
  } catch {
    throw new Error(message)
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function copyIfExists(from, to) {
  if (!(await exists(from))) return
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
}

async function copyDirIfExists(from, to) {
  if (!(await exists(from))) return
  await fs.cp(from, to, { recursive: true })
}

function publishDependencies(dependencyGroups) {
  const dependencies = {}
  for (const group of dependencyGroups) {
    for (const [name, version] of Object.entries(group)) {
      if (String(version).startsWith("workspace:")) continue
      dependencies[name] = version
    }
  }
  return Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)))
}
