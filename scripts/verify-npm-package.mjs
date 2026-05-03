import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const distDir = path.join(root, "dist", "npm")
const tarball = await findLatestTarball(distDir)
const smokeRoot = path.join(distDir, "smoke")

await fs.rm(smokeRoot, { recursive: true, force: true })
await fs.mkdir(smokeRoot, { recursive: true })

run("npm", ["install", "--prefix", smokeRoot, tarball])

const binPath = path.join(smokeRoot, "node_modules", ".bin", "lh")
run(binPath, ["--help"], {
  LEHARNESS_HOME: path.join(smokeRoot, ".leharness"),
})

console.log(`Verified packed CLI from ${path.relative(root, tarball)}`)

async function findLatestTarball(dir) {
  const entries = await fs.readdir(dir)
  const tarballs = entries
    .filter((name) => /^leharness-\d+\.\d+\.\d+.*\.tgz$/.test(name))
    .map((name) => path.join(dir, name))

  if (tarballs.length === 0) {
    throw new Error("No leharness tarball found. Run `pnpm package:pack` first.")
  }

  const stats = await Promise.all(
    tarballs.map(async (filePath) => ({ filePath, stat: await fs.stat(filePath) })),
  )
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  return stats[0].filePath
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: "pipe",
  })

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`)
  }
}
