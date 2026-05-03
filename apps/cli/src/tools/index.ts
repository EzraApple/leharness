import type { Tool } from "@leharness/harness"
import { bashTool } from "./bash.js"
import { listDirTool } from "./list_dir.js"
import { readFileTool } from "./read_file.js"

export const builtinTools: Tool[] = [readFileTool, listDirTool, bashTool]
