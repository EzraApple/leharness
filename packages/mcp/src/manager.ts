// manager.ts
// Owns the lifecycle of all configured MCP servers: connect each, run
// auth where needed, aggregate their tools (namespaced <server>__<tool>),
// and track per-server status for the UI. The one object products touch.

import { ensureAccessToken } from "./auth/oauth.js"
import { createFileTokenStore, type TokenStore } from "./auth/token-store.js"
import { McpClient } from "./client.js"
import type { HttpServerConfig, ServerConfig, StdioServerConfig } from "./config.js"
import { HttpTransport, UnauthorizedError } from "./transport/http.js"
import { StdioTransport } from "./transport/stdio.js"

export type McpStatus = "connecting" | "ready" | "auth_required" | "failed" | "exited"

export interface McpToolDescriptor {
  // Namespaced name exposed to the model, e.g. "github__create_issue".
  name: string
  serverName: string
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
  call(args: unknown): Promise<{ text: string; isError: boolean }>
}

export interface ConnectOptions {
  // Loopback redirect URI for OAuth (app owns the listener).
  redirectUri: string
  // App opens the browser to `authorizationUrl` and resolves with the
  // captured authorization code. Only called for OAuth-gated servers.
  authorize: (authorizationUrl: string) => Promise<string>
  // Forwarded server stderr (stdio) for debugging.
  onStderr?: (server: string, line: string) => void
}

export interface McpManagerOptions {
  servers: ServerConfig[]
  authDir: string
  clientName?: string
  clientVersion?: string
}

interface ConnectedServer {
  client: McpClient
  tools: McpToolDescriptor[]
}

export class McpManager {
  private readonly store: TokenStore
  private readonly statusByServer = new Map<string, McpStatus>()
  private readonly connected = new Map<string, ConnectedServer>()
  private readonly clientName: string
  private readonly clientVersion: string

  constructor(private readonly options: McpManagerOptions) {
    this.store = createFileTokenStore(options.authDir)
    this.clientName = options.clientName ?? "leharness"
    this.clientVersion = options.clientVersion ?? "0.0.0"
    for (const s of options.servers) this.statusByServer.set(s.name, "connecting")
  }

  status(): Map<string, McpStatus> {
    return new Map(this.statusByServer)
  }

  // Connect every configured server. A failure on one is isolated:
  // logged via status, never thrown, never blocks the others.
  async connectAll(opts: ConnectOptions): Promise<void> {
    await Promise.all(this.options.servers.map((server) => this.connectOne(server, opts)))
  }

  listAllTools(): McpToolDescriptor[] {
    const all: McpToolDescriptor[] = []
    for (const { tools } of this.connected.values()) all.push(...tools)
    return all
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connected.values()].map(({ client }) => client.close()))
    this.connected.clear()
  }

  private async connectOne(server: ServerConfig, opts: ConnectOptions): Promise<void> {
    try {
      const connected =
        server.kind === "stdio"
          ? await this.connectStdio(server, opts)
          : await this.connectHttp(server, opts)
      this.connected.set(server.name, connected)
      this.statusByServer.set(server.name, "ready")
    } catch (err) {
      // Isolation: surface and move on — one bad server never blocks
      // the others or the session.
      this.statusByServer.set(server.name, "failed")
      console.warn(
        `[mcp] server "${server.name}" failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private async connectStdio(
    server: StdioServerConfig,
    opts: ConnectOptions,
  ): Promise<ConnectedServer> {
    const transport = new StdioTransport({
      command: server.command,
      args: server.args,
      env: server.env,
      onStderr: (line) => opts.onStderr?.(server.name, line),
    })
    const client = new McpClient(transport, {
      clientName: this.clientName,
      clientVersion: this.clientVersion,
    })
    transport.onClose((reason) => {
      if (this.statusByServer.get(server.name) === "ready") {
        this.statusByServer.set(server.name, "exited")
      }
      void reason
    })
    await client.initialize()
    return this.fetchTools(server.name, client)
  }

  private async connectHttp(
    server: HttpServerConfig,
    opts: ConnectOptions,
  ): Promise<ConnectedServer> {
    // Mutable token holder so getAuthHeader picks up a refreshed token
    // without rebuilding the transport.
    let bearer: string | undefined
    const staticAuth = server.headers.Authorization ?? server.headers.authorization

    const makeClient = () => {
      const transport = new HttpTransport({
        url: server.url,
        getAuthHeader: () => {
          if (bearer !== undefined) return `Bearer ${bearer}`
          return staticAuth
        },
      })
      return new McpClient(transport, {
        clientName: this.clientName,
        clientVersion: this.clientVersion,
      })
    }

    let client = makeClient()
    try {
      await client.initialize()
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err
      // OAuth path: get a token, then reconnect with it.
      this.statusByServer.set(server.name, "auth_required")
      bearer = await ensureAccessToken({
        serverName: server.name,
        serverUrl: server.url,
        wwwAuthenticate: err.wwwAuthenticate,
        redirectUri: opts.redirectUri,
        store: this.store,
        authorize: opts.authorize,
      })
      client = makeClient()
      await client.initialize()
    }
    return this.fetchTools(server.name, client)
  }

  private async fetchTools(serverName: string, client: McpClient): Promise<ConnectedServer> {
    const specs = await client.listTools()
    const tools: McpToolDescriptor[] = specs.map((spec) => ({
      name: `${serverName}__${spec.name}`,
      serverName,
      toolName: spec.name,
      description: spec.description ?? `${spec.name} (via ${serverName})`,
      inputSchema: spec.inputSchema ?? { type: "object" },
      call: (args: unknown) => client.callTool(spec.name, args),
    }))
    return { client, tools }
  }
}
