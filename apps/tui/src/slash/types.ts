import type { Skill } from "@leharness/harness"

export interface SlashCommand {
  description: string
  name: string
}

export type SlashItem =
  | {
      description: string
      kind: "command"
      name: string
    }
  | {
      description: string
      kind: "skill"
      name: string
      skill: Skill
    }

export interface SlashToken {
  end: number
  query: string
  start: number
  token: string
}
