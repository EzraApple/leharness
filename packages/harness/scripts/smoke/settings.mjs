import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
  loadUserSettings,
  resolveSettingsPath,
  saveUserSettings,
  updateUserSettings,
} from "../../dist/index.js"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-settings-smoke-"))
process.env.LEHARNESS_HOME = tmp

assert.equal(resolveSettingsPath(), path.join(tmp, "settings.json"))
assert.deepEqual(await loadUserSettings(), {})

await saveUserSettings({
  runtime: {
    model: "deepseek-v4-pro",
    provider: "deepseek",
    reasoningEffort: "max",
  },
})

assert.deepEqual(await loadUserSettings(), {
  runtime: {
    model: "deepseek-v4-pro",
    provider: "deepseek",
    reasoningEffort: "max",
  },
})

await updateUserSettings({
  runtime: {
    model: "qwen3.6:27b-coding-nvfp4",
    provider: "ollama",
  },
})

assert.deepEqual(await loadUserSettings(), {
  runtime: {
    model: "qwen3.6:27b-coding-nvfp4",
    provider: "ollama",
  },
})

console.log("smoke-settings: ok")
