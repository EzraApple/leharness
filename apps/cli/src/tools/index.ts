import type { Tool } from "@leharness/harness"
import { bashTool } from "./bash.js"
import { createFileTool } from "./create_file.js"
import { editFileTool } from "./edit_file.js"
import { listDirTool } from "./list_dir.js"
import { readFileTool } from "./read_file.js"

export const builtinTools: Tool[] = [
  readFileTool,
  listDirTool,
  createFileTool,
  editFileTool,
  bashTool,
]
