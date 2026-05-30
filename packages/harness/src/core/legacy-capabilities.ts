import type { SkillOptions } from "../skills.js"
import { skillOptionsEnabled, skillsCapability } from "../skills.js"
import { subagentsCapability } from "../subagents.js"
import { builtInTaskTools, type SessionTaskServices } from "../tasks.js"
import type { Capability } from "./capability.js"

interface LegacyCapabilityOptions {
  skills?: SkillOptions | false
  tasks?: boolean
  subagents?: boolean
  taskServices?: SessionTaskServices
}

export function legacyCapabilities(options: LegacyCapabilityOptions): Capability[] {
  const capabilities: Capability[] = []

  if (options.tasks !== false) {
    capabilities.push({
      async tools() {
        return builtInTaskTools
      },
    })
  }

  if (
    options.subagents !== false &&
    options.taskServices !== undefined &&
    options.taskServices.executors.has("delegated")
  ) {
    capabilities.push(subagentsCapability(options.taskServices))
  }

  if (skillOptionsEnabled(options.skills)) {
    capabilities.push(skillsCapability(options.skills))
  }

  return capabilities
}
