import type { Event } from "../events.js"
import { DEFAULT_SYSTEM_PROMPT } from "../prompt.js"
import {
  createLoadSkillTool,
  discoverSkills,
  recentLoadedSkillNames,
  renderSkillCatalog,
  type SkillOptions,
  skillOptionsEnabled,
  withSkillCatalog,
} from "../skills.js"
import type { Tool } from "../tools.js"

interface PromptSurface {
  system: string
  tools: Tool[]
}

export async function buildPromptSurface(options: {
  events: Event[]
  skills: SkillOptions | false | undefined
  systemPrompt: string | undefined
  tools: Tool[]
  userText: string
}): Promise<PromptSurface> {
  const baseSystem = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const skillConfig = options.skills === false ? undefined : options.skills
  if (!skillOptionsEnabled(options.skills)) {
    return { system: baseSystem, tools: options.tools }
  }

  const discoveredSkills = await discoverSkills(skillConfig?.root)
  if (discoveredSkills.length === 0) return { system: baseSystem, tools: options.tools }

  const catalog = renderSkillCatalog(discoveredSkills, {
    budgetChars: skillConfig?.catalogBudgetChars,
    includePaths: skillConfig?.includePaths,
    queryText: options.userText,
    recentSkillNames: recentLoadedSkillNames(options.events),
  })
  return {
    system: withSkillCatalog(baseSystem, catalog),
    tools: [
      createLoadSkillTool({
        root: skillConfig?.root,
        maxSkillBytes: skillConfig?.maxSkillBytes,
      }),
      ...options.tools.filter((tool) => tool.name !== "load_skill"),
    ],
  }
}
