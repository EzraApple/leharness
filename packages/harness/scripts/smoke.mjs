import { readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const smokeDir = path.join(here, "smoke")
const scripts = (await readdir(smokeDir))
  .filter((name) => name.endsWith(".mjs"))
  .sort((a, b) => a.localeCompare(b))

if (scripts.length === 0) {
  console.error(`FAIL: no smoke scripts found in ${smokeDir}`)
  process.exit(1)
}

for (const script of scripts) {
  console.log(`\n== smoke: ${script} ==`)
  await import(pathToFileURL(path.join(smokeDir, script)).href)
}

console.log("\nsmoke: all scripts passed")
