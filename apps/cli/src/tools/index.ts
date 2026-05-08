import type { Tool } from "@leharness/harness"
import { bashTool } from "./bash.js"
import { createFileTool } from "./create_file.js"
import { editFileTool } from "./edit_file.js"
import { readFileTool } from "./read_file.js"

export const builtinTools: Tool[] = [readFileTool, createFileTool, editFileTool, bashTool]
