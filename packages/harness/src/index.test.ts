import { describe, expect, it } from "vitest"
import { VERSION } from "./index.js"

describe("leharness scaffold", () => {
  it("exposes a version constant", () => {
    expect(VERSION).toBe("0.1.0")
  })
})
