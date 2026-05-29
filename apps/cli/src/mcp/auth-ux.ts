// mcp/auth-ux.ts
// App-layer half of the MCP OAuth flow: bind a one-shot localhost
// loopback server to capture the redirect's authorization code, and open
// the user's browser to the authorization URL. The @leharness/mcp oauth
// module owns the protocol; this owns the browser + loopback so the
// package stays UI-free.
//
// The listener is bound only when a flow begins (not at startup) and uses
// a free port — preferring 8765 but falling back to an OS-assigned port
// if another process holds it — so there's no hardcoded-port collision.

import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import process from "node:process"
import type { LoopbackAuthorization } from "@leharness/mcp"

const PREFERRED_PORT = 8765
const FLOW_TIMEOUT_MS = 5 * 60 * 1000

interface Authorizer {
  beginAuthorization: () => Promise<LoopbackAuthorization>
}

export function createOAuthAuthorizer(): Authorizer {
  const beginAuthorization = async (): Promise<LoopbackAuthorization> => {
    const { server, port } = await bindLoopback(PREFERRED_PORT)
    const redirectUri = `http://127.0.0.1:${port}/callback`

    const waitForCode = (authorizationUrl: string): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("OAuth flow timed out after 5 minutes")),
          FLOW_TIMEOUT_MS,
        )
        timer.unref()

        server.on("request", (req, res) => {
          const url = new URL(req.url ?? "/", redirectUri)
          if (url.pathname !== "/callback") {
            res.writeHead(404).end()
            return
          }
          const code = url.searchParams.get("code")
          const error = url.searchParams.get("error")
          res.writeHead(200, { "content-type": "text/html" })
          clearTimeout(timer)
          if (code !== null) {
            res.end(
              "<html><body><h2>leharness: authorized.</h2>You can close this tab.</body></html>",
            )
            resolve(code)
          } else {
            res.end(
              `<html><body><h2>leharness: authorization failed.</h2>${error ?? "no code"}</body></html>`,
            )
            reject(
              new Error(`OAuth callback returned no code${error !== null ? `: ${error}` : ""}`),
            )
          }
        })

        openBrowser(authorizationUrl)
      })

    return { redirectUri, waitForCode, close: () => server.close() }
  }

  return { beginAuthorization }
}

// Bind the loopback listener, preferring the well-known port but falling
// back to any free port if it's taken (RFC 8252 allows a variable loopback
// redirect port). Resolves with the live server and the port it bound.
function bindLoopback(preferredPort: number): Promise<{ server: Server; port: number }> {
  return listen(preferredPort).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err
    return listen(0)
  })
}

function listen(port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null
      if (address === null) {
        server.close()
        reject(new Error("could not determine OAuth loopback port"))
        return
      }
      server.removeListener("error", reject)
      resolve({ server, port: address.port })
    })
  })
}

function openBrowser(url: string): void {
  const platform = process.platform
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open"
  const args = platform === "win32" ? ["", url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: platform === "win32" })
    child.unref()
  } catch {
    // browser open is best-effort
  }
}
