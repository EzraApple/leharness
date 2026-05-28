// auth/oauth.ts
// OAuth 2.0 authorization-code + PKCE for MCP servers, hand-rolled over
// fetch. Covers the MCP auth spec path: protected-resource metadata
// discovery (RFC 9728) → authorization-server metadata (RFC 8414) →
// optional dynamic client registration (RFC 7591) → PKCE authorize →
// code exchange → refresh.
//
// The crypto is node stdlib (sha256 + base64url for PKCE) — no jose,
// because as a client we never verify the access token; it's opaque to
// us and we just bear it. The browser-open + loopback redirect capture
// is delegated to the caller (app layer) via the `authorize` callback,
// keeping this module UI-free.

import { createHash, randomBytes } from "node:crypto"
import type { StoredTokens, TokenStore } from "./token-store.js"

// Refresh a little before actual expiry to avoid racing the clock.
const EXPIRY_SKEW_MS = 30_000

interface AuthServerMetadata {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
}

// Thrown when a valid token can't be obtained without user interaction
// (no stored token, refresh failed) and `interactive` is false. The
// manager turns this into an "auth_required" status instead of opening
// a browser at startup.
export class NeedsInteractiveAuthError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" needs interactive authorization`)
    this.name = "NeedsInteractiveAuthError"
  }
}

// A live loopback authorization, owned by the app layer. The app binds a
// local redirect listener on a free port (so there's no hardcoded-port
// collision) and reports the URI it chose; the oauth module then drives
// the rest of the flow against that URI.
export interface LoopbackAuthorization {
  // The redirect URI the listener is bound to (e.g. http://127.0.0.1:PORT/callback).
  redirectUri: string
  // Open the browser to `authorizationUrl` and resolve with the captured
  // authorization code (rejects on error/timeout).
  waitForCode: (authorizationUrl: string) => Promise<string>
  // Release the listener — called when the flow ends, on any outcome.
  close: () => void
}

interface EnsureTokenArgs {
  serverName: string
  serverUrl: string
  // The WWW-Authenticate header from the server's 401, if any.
  wwwAuthenticate?: string
  store: TokenStore
  // App-supplied: begin a loopback authorization (bind the redirect
  // listener, returning its URI + a code waiter). Invoked only on the
  // interactive path, so no listener is bound unless a flow actually runs.
  beginAuthorization: () => Promise<LoopbackAuthorization>
  // When false, stop before the browser flow and throw
  // NeedsInteractiveAuthError (used at startup so OAuth servers don't
  // block the TUI launch). Defaults to true.
  interactive?: boolean
}

// Returns a valid access token, running whatever subset of the flow is
// needed: reuse stored, refresh, or full browser authorization.
export async function ensureAccessToken(args: EnsureTokenArgs): Promise<string> {
  const stored = await args.store.load(args.serverName)
  if (stored !== undefined && !isExpired(stored)) {
    return stored.accessToken
  }

  const metadata = await discoverAuthServer(args.serverUrl, args.wwwAuthenticate)

  // Try refresh first if we have a refresh token.
  if (stored?.refreshToken !== undefined && stored.clientId !== undefined) {
    try {
      const refreshed = await refreshTokens(metadata.tokenEndpoint, {
        refreshToken: stored.refreshToken,
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
      })
      const merged: StoredTokens = {
        ...stored,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? stored.refreshToken,
        expiresAt: refreshed.expiresAt,
      }
      await args.store.save(args.serverName, merged)
      return merged.accessToken
    } catch {
      // refresh failed — fall through to a full authorization
    }
  }

  // Reaching here means a browser flow is required. Bail early when the
  // caller asked to stay non-interactive (e.g. TUI startup).
  if (args.interactive === false) {
    throw new NeedsInteractiveAuthError(args.serverName)
  }

  // Full authorization-code + PKCE flow. The app binds the loopback
  // listener now (picking a free port) and tells us the redirect URI; we
  // register/authorize/exchange against it, then always release it.
  const auth = await args.beginAuthorization()
  try {
    const redirectUri = auth.redirectUri
    let clientId = stored?.clientId
    let clientSecret = stored?.clientSecret
    if (clientId === undefined && metadata.registrationEndpoint !== undefined) {
      const reg = await registerClient(metadata.registrationEndpoint, redirectUri)
      clientId = reg.clientId
      clientSecret = reg.clientSecret
    }
    if (clientId === undefined) {
      throw new Error(
        `MCP OAuth for "${args.serverName}": no client_id and no registration endpoint to obtain one`,
      )
    }

    const pkce = generatePkce()
    const state = base64url(randomBytes(16))
    const authorizationUrl = buildAuthorizationUrl(metadata.authorizationEndpoint, {
      clientId,
      redirectUri,
      codeChallenge: pkce.challenge,
      state,
      resource: args.serverUrl,
    })

    const code = await auth.waitForCode(authorizationUrl)

    const tokens = await exchangeCode(metadata.tokenEndpoint, {
      code,
      codeVerifier: pkce.verifier,
      clientId,
      clientSecret,
      redirectUri,
      resource: args.serverUrl,
    })

    const toStore: StoredTokens = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      clientId,
      clientSecret,
    }
    await args.store.save(args.serverName, toStore)
    return toStore.accessToken
  } finally {
    auth.close()
  }
}

function isExpired(tokens: StoredTokens): boolean {
  if (tokens.expiresAt === undefined) return false // assume long-lived
  return Date.now() >= tokens.expiresAt - EXPIRY_SKEW_MS
}

// ---- discovery ----

async function discoverAuthServer(
  serverUrl: string,
  wwwAuthenticate: string | undefined,
): Promise<AuthServerMetadata> {
  const issuer = await discoverAuthServerIssuer(serverUrl, wwwAuthenticate)
  return fetchAuthServerMetadata(issuer)
}

async function discoverAuthServerIssuer(
  serverUrl: string,
  wwwAuthenticate: string | undefined,
): Promise<string> {
  // Prefer the resource_metadata pointer in WWW-Authenticate, else probe
  // the well-known protected-resource path on the server origin.
  const resourceMetadataUrl =
    parseResourceMetadataUrl(wwwAuthenticate) ?? wellKnown(serverUrl, "oauth-protected-resource")
  try {
    const meta = (await fetchJson(resourceMetadataUrl)) as { authorization_servers?: unknown }
    if (
      Array.isArray(meta.authorization_servers) &&
      typeof meta.authorization_servers[0] === "string"
    ) {
      return meta.authorization_servers[0]
    }
  } catch {
    // no resource metadata — fall back to treating the server origin as
    // the issuer (common for servers that co-locate auth)
  }
  return new URL(serverUrl).origin
}

async function fetchAuthServerMetadata(issuer: string): Promise<AuthServerMetadata> {
  // Try RFC 8414 then OpenID Connect discovery.
  for (const suffix of ["oauth-authorization-server", "openid-configuration"]) {
    try {
      const meta = (await fetchJson(wellKnown(issuer, suffix))) as {
        authorization_endpoint?: unknown
        token_endpoint?: unknown
        registration_endpoint?: unknown
      }
      if (
        typeof meta.authorization_endpoint === "string" &&
        typeof meta.token_endpoint === "string"
      ) {
        return {
          authorizationEndpoint: meta.authorization_endpoint,
          tokenEndpoint: meta.token_endpoint,
          registrationEndpoint:
            typeof meta.registration_endpoint === "string" ? meta.registration_endpoint : undefined,
        }
      }
    } catch {
      // try the next well-known path
    }
  }
  throw new Error(`could not discover OAuth endpoints for issuer ${issuer}`)
}

function parseResourceMetadataUrl(wwwAuthenticate: string | undefined): string | undefined {
  if (wwwAuthenticate === undefined) return undefined
  const match = wwwAuthenticate.match(/resource_metadata="([^"]+)"/)
  return match?.[1]
}

function wellKnown(base: string, suffix: string): string {
  const url = new URL(base)
  return `${url.origin}/.well-known/${suffix}`
}

// ---- dynamic client registration (RFC 7591) ----

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "leharness",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  })
  if (!res.ok) {
    throw new Error(`dynamic client registration failed (${res.status})`)
  }
  const json = (await res.json()) as { client_id?: unknown; client_secret?: unknown }
  if (typeof json.client_id !== "string") {
    throw new Error("dynamic client registration returned no client_id")
  }
  return {
    clientId: json.client_id,
    clientSecret: typeof json.client_secret === "string" ? json.client_secret : undefined,
  }
}

// ---- PKCE ----

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// ---- authorize + token ----

function buildAuthorizationUrl(
  endpoint: string,
  args: {
    clientId: string
    redirectUri: string
    codeChallenge: string
    state: string
    resource: string
  },
): string {
  const url = new URL(endpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", args.clientId)
  url.searchParams.set("redirect_uri", args.redirectUri)
  url.searchParams.set("code_challenge", args.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", args.state)
  // RFC 8707 resource indicator — many MCP auth servers want it.
  url.searchParams.set("resource", args.resource)
  return url.toString()
}

interface TokenResponse {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

async function exchangeCode(
  tokenEndpoint: string,
  args: {
    code: string
    codeVerifier: string
    clientId: string
    clientSecret?: string
    redirectUri: string
    resource: string
  },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    resource: args.resource,
  })
  if (args.clientSecret !== undefined) body.set("client_secret", args.clientSecret)
  return postToken(tokenEndpoint, body)
}

async function refreshTokens(
  tokenEndpoint: string,
  args: { refreshToken: string; clientId: string; clientSecret?: string },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  })
  if (args.clientSecret !== undefined) body.set("client_secret", args.clientSecret)
  return postToken(tokenEndpoint, body)
}

async function postToken(tokenEndpoint: string, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  })
  if (!res.ok) {
    throw new Error(`token endpoint error (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  const json = (await res.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }
  if (typeof json.access_token !== "string") {
    throw new Error("token response missing access_token")
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresAt:
      typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1000 : undefined,
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return res.json()
}
