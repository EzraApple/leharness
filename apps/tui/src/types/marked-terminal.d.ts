declare module "marked-terminal" {
  import type { MarkedExtension } from "marked"

  export interface MarkedTerminalOptions {
    emoji?: boolean
    reflowText?: boolean
    showSectionPrefix?: boolean
    tab?: number | string
    width?: number
  }

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension
}
