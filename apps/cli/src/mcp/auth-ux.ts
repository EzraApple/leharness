// mcp/auth-ux.ts
// App-layer half of the MCP OAuth flow: open the user's browser to the
// authorization URL and run a one-shot localhost loopback server to
// capture the redirect's authorization code. The @leharness/mcp oauth
// module owns the protocol; this owns the browser + loopback so the
// package stays UI-free.

import { spawn } from "node:child_process"
import { createServer } from "node:http"
import process from "node:process"

const DEFAULT_PORT = 8765

interface Authorizer {
  redirectUri: string
  authorize: (authorizationUrl: string) => Promise<string>
}

export function createOAuthAuthorizer(port: number = DEFAULT_PORT): Authorizer {
  const redirectUri = `http://localhost:${port}/callback`

  const authorize = (authorizationUrl: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", redirectUri)
        if (url.pathname !== "/callback") {
          res.writeHead(404).end()
          return
        }
        const code = url.searchParams.get("code")
        const error = url.searchParams.get("error")
        res.writeHead(200, { "content-type": "text/html" })
        if (code !== null) {
          res.end(
            "<html><body><h2>leharness: authorized.</h2>You can close this tab.</body></html>",
          )
          server.close()
          resolve(code)
        } else {
          res.end(
            `<html><body><h2>leharness: authorization failed.</h2>${error ?? "no code"}</body></html>`,
          )
          server.close()
          reject(new Error(`OAuth callback returned no code${error !== null ? `: ${error}` : ""}`))
        }
      })

      server.on("error", reject)
      server.listen(port, () => {
        process.stderr.write(`\n[mcp] opening browser for OAuth — approve, then return here.\n`)
        process.stderr.write(`[mcp] if the browser didn't open, visit:\n${authorizationUrl}\n\n`)
        openBrowser(authorizationUrl)
      })

      // Don't hang forever if the user abandons the flow.
      setTimeout(
        () => {
          server.close()
          reject(new Error("OAuth flow timed out after 5 minutes"))
        },
        5 * 60 * 1000,
      ).unref()
    })

  return { redirectUri, authorize }
}

function openBrowser(url: string): void {
  const platform = process.platform
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open"
  const args = platform === "win32" ? ["", url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: platform === "win32" })
    child.unref()
  } catch {
    // browser open is best-effort; the URL is printed above as fallback
  }
}
