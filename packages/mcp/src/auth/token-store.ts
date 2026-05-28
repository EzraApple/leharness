// auth/token-store.ts
// Persists OAuth tokens per server under .leharness/mcp-auth/<server>.json
// with 0600 perms. Stores the refresh token + access token + expiry so a
// later session reuses the grant instead of re-running the browser flow.

import { promises as fs } from "node:fs"
import path from "node:path"

export interface StoredTokens {
  accessToken: string
  refreshToken?: string
  // Absolute epoch ms when the access token expires (best-effort).
  expiresAt?: number
  // Dynamic-client-registration result, if the server required it, so
  // we don't re-register every run.
  clientId?: string
  clientSecret?: string
}

export interface TokenStore {
  load(server: string): Promise<StoredTokens | undefined>
  save(server: string, tokens: StoredTokens): Promise<void>
  clear(server: string): Promise<void>
}

export function createFileTokenStore(authDir: string): TokenStore {
  const fileFor = (server: string) =>
    path.join(authDir, `${server.replace(/[^A-Za-z0-9._-]/g, "_")}.json`)

  return {
    async load(server) {
      try {
        const raw = await fs.readFile(fileFor(server), "utf8")
        return JSON.parse(raw) as StoredTokens
      } catch {
        return undefined
      }
    },
    async save(server, tokens) {
      await fs.mkdir(authDir, { recursive: true })
      await fs.writeFile(fileFor(server), JSON.stringify(tokens, null, 2), { mode: 0o600 })
    },
    async clear(server) {
      await fs.rm(fileFor(server), { force: true })
    },
  }
}
