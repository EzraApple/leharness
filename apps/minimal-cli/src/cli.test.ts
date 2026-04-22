import { OllamaProvider, OpenAIProvider } from "@leharness/harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildProvider, defaultModelFor, parseArgs } from "./cli.js"

describe("parseArgs", () => {
  it("treats a bare positional argument as a one-shot prompt", () => {
    const args = parseArgs(["hello world"])
    expect(args.mode).toBe("one_shot")
    expect(args.prompt).toBe("hello world")
  })

  it("recognizes the explicit repl subcommand", () => {
    const args = parseArgs(["repl"])
    expect(args.mode).toBe("repl")
    expect(args.prompt).toBeUndefined()
  })

  it("defaults to repl mode when no positional or subcommand is given", () => {
    const args = parseArgs([])
    expect(args.mode).toBe("repl")
    expect(args.prompt).toBeUndefined()
  })

  it("returns a one-shot mode without prompt for --help", () => {
    const args = parseArgs(["--help"])
    expect(args.mode).toBe("one_shot")
    expect(args.prompt).toBeUndefined()
  })

  it("parses --session alongside repl", () => {
    const args = parseArgs(["repl", "--session", "abc"])
    expect(args.mode).toBe("repl")
    expect(args.sessionId).toBe("abc")
  })

  it("parses provider and model short flags", () => {
    const args = parseArgs(["hello", "-p", "openai", "-m", "gpt-4"])
    expect(args.mode).toBe("one_shot")
    expect(args.prompt).toBe("hello")
    expect(args.provider).toBe("openai")
    expect(args.model).toBe("gpt-4")
  })

  it("prefers repl over a positional prompt when both are supplied", () => {
    const args = parseArgs(["repl", "hello"])
    expect(args.mode).toBe("repl")
  })

  it("parses long flag forms", () => {
    const args = parseArgs([
      "hello",
      "--provider",
      "ollama",
      "--model",
      "llama3",
      "--session",
      "s1",
    ])
    expect(args.provider).toBe("ollama")
    expect(args.model).toBe("llama3")
    expect(args.sessionId).toBe("s1")
  })
})

describe("defaultModelFor", () => {
  it("returns gemma4:26b for ollama", () => {
    expect(defaultModelFor("ollama")).toBe("gemma4:26b")
  })

  it("returns gpt-4o-mini for openai", () => {
    expect(defaultModelFor("openai")).toBe("gpt-4o-mini")
  })

  it("throws for an unknown provider", () => {
    expect(() => defaultModelFor("nonsense")).toThrow(/no default model/)
  })
})

describe("buildProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns an OllamaProvider", () => {
    const provider = buildProvider("ollama")
    expect(provider).toBeInstanceOf(OllamaProvider)
    expect(provider.name).toBe("ollama")
  })

  it("returns an OpenAIProvider when OPENAI_API_KEY is set", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key")
    const provider = buildProvider("openai")
    expect(provider).toBeInstanceOf(OpenAIProvider)
    expect(provider.name).toBe("openai")
  })

  it("throws for an unknown provider", () => {
    expect(() => buildProvider("nonsense")).toThrow(/unknown provider/)
  })
})
