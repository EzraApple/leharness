import { ToolRegistry } from "@leharness/harness"
import { bashTool } from "./bash.js"
import { listDirTool } from "./list_dir.js"
import { readFileTool } from "./read_file.js"

export function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(listDirTool)
  registry.register(bashTool)
  return registry
}
