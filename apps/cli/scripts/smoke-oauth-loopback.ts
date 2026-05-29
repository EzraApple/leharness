// smoke-oauth-loopback.ts
// The OAuth callback listener must not depend on a hardcoded port: it
// prefers 8765 but falls back to an OS-assigned free port when 8765 is
// taken (the EADDRINUSE fix). This drives the real createOAuthAuthorizer,
// binding only — it never calls waitForCode, which would open a browser.

import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createOAuthAuthorizer } from "../src/mcp/auth-ux.js"

const PREFERRED = 8765

function listen(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(port, "127.0.0.1", () => resolve(server))
  })
}

// --- 1. preferred port free → uses 8765 on 127.0.0.1 ---
const a1 = await createOAuthAuthorizer().beginAuthorization()
const url1 = new URL(a1.redirectUri)
assert.equal(url1.hostname, "127.0.0.1", "redirect should bind IPv4 loopback")
assert.equal(url1.pathname, "/callback", "redirect path should be /callback")
assert.equal(url1.port, String(PREFERRED), `expected preferred port ${PREFERRED}, got ${url1.port}`)
a1.close()

// --- 2. preferred port taken → falls back to a different free port ---
const blocker = await listen(PREFERRED)
const a2 = await createOAuthAuthorizer().beginAuthorization()
const url2 = new URL(a2.redirectUri)
assert.equal(url2.hostname, "127.0.0.1", "fallback should still bind IPv4 loopback")
assert.notEqual(url2.port, String(PREFERRED), "should fall back off the occupied preferred port")
assert.ok(Number(url2.port) > 0, `fallback port should be valid, got ${url2.port}`)
a2.close()
blocker.close()

// --- 3. close() releases the port → it can be re-bound immediately ---
const a3 = await createOAuthAuthorizer().beginAuthorization()
const reboundPort = Number(new URL(a3.redirectUri).port)
a3.close()
const rebinder = await listen(reboundPort)
rebinder.close()

console.log("smoke-oauth-loopback: preferred port / EADDRINUSE fallback / close releases ok")
