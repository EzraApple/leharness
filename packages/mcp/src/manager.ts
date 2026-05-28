// manager.ts
// Owns the lifecycle of all configured MCP servers: connect each, run
// auth where needed, aggregate their tools (namespaced <server>__<tool>),
// and track per-server status for the UI. The one object products touch.
//
// Startup is non-interactive by default (interactiveAuth: false): an
// OAuth server with no usable stored token is marked auth_required
// rather than popping a browser. The interactive flow runs later, on a
// deliberate user gesture, via authorizeServer().

import { ensureAccessToken, NeedsInteractiveAuthError } from "./auth/oauth.js"
import { createFileTokenStore, type TokenStore } from "./auth/token-store.js"
import { McpClient } from "./client.js"
import type { HttpServerConfig, ServerConfig, StdioServerConfig } from "./config.js"
import { HttpTransport, UnauthorizedError } from "./transport/http.js"
import { StdioTransport } from "./transport/stdio.js"

export type McpStatus = "connecting" | "ready" | "auth_required" | "failed" | "exited"

export interface McpServerDetail {
  status: McpStatus
  toolCount: number
  serverInfo?: { name?: string; version?: string }
}

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
  // captured authorization code. Only invoked when interactiveAuth is
  // true (one-shot CLI) or via authorizeServer().
  authorize: (authorizationUrl: string) => Promise<string>
  // Forwarded server stderr (stdio) for debugging.
  onStderr?: (server: string, line: string) => void
  // When false (TUI startup), OAuth servers needing a browser flow are
  // marked auth_required instead of blocking. Defaults to true.
  interactiveAuth?: boolean
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
  serverInfo?: { name?: string; version?: string }
}

export class McpManager {
  private readonly store: TokenStore
  private readonly statusByServer = new Map<string, McpStatus>()
  private readonly connected = new Map<string, ConnectedServer>()
  private readonly serverByName = new Map<string, ServerConfig>()
  private readonly listeners = new Set<(name: string, status: McpStatus) => void>()
  private lastConnectOptions: ConnectOptions | undefined
  private readonly clientName: string
  private readonly clientVersion: string

  constructor(options: McpManagerOptions) {
    this.store = createFileTokenStore(options.authDir)
    this.clientName = options.clientName ?? "leharness"
    this.clientVersion = options.clientVersion ?? "0.0.0"
    for (const s of options.servers) {
      this.serverByName.set(s.name, s)
      this.statusByServer.set(s.name, "connecting")
    }
  }

  // Subscribe to status transitions; returns an unsubscribe.
  onStatusChange(listener: (name: string, status: McpStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  status(): Map<string, McpStatus> {
    return new Map(this.statusByServer)
  }

  details(): Map<string, McpServerDetail> {
    const out = new Map<string, McpServerDetail>()
    for (const [name, status] of this.statusByServer) {
      const conn = this.connected.get(name)
      out.set(name, {
        status,
        toolCount: conn?.tools.length ?? 0,
        serverInfo: conn?.serverInfo,
      })
    }
    return out
  }

  // Connect every configured server. A failure on one is isolated:
  // logged via status, never thrown, never blocks the others.
  async connectAll(opts: ConnectOptions): Promise<void> {
    this.lastConnectOptions = opts
    await Promise.all(this.options().map((server) => this.connectOne(server, opts)))
  }

  // Retry a single server (after the user edits config, or a crash).
  async reconnect(name: string): Promise<void> {
    const server = this.serverByName.get(name)
    if (server === undefined || this.lastConnectOptions === undefined) return
    await this.disconnectOne(name)
    this.setStatus(name, "connecting")
    await this.connectOne(server, this.lastConnectOptions)
  }

  // Run the interactive OAuth flow for one server, then connect it.
  async authorizeServer(name: string): Promise<void> {
    const server = this.serverByName.get(name)
    if (server === undefined || server.kind !== "http" || this.lastConnectOptions === undefined) {
      return
    }
    await this.disconnectOne(name)
    this.setStatus(name, "connecting")
    await this.connectOne(server, { ...this.lastConnectOptions, interactiveAuth: true })
  }

  // Clear a server's stored tokens and mark it auth_required again.
  async logout(name: string): Promise<void> {
    await this.store.clear(name)
    await this.disconnectOne(name)
    this.setStatus(name, "auth_required")
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

  private options(): ServerConfig[] {
    return [...this.serverByName.values()]
  }

  private setStatus(name: string, status: McpStatus): void {
    this.statusByServer.set(name, status)
    for (const listener of this.listeners) listener(name, status)
  }

  private async disconnectOne(name: string): Promise<void> {
    const conn = this.connected.get(name)
    if (conn !== undefined) {
      await conn.client.close()
      this.connected.delete(name)
    }
  }

  private async connectOne(server: ServerConfig, opts: ConnectOptions): Promise<void> {
    try {
      const connected =
        server.kind === "stdio"
          ? await this.connectStdio(server, opts)
          : await this.connectHttp(server, opts)
      this.connected.set(server.name, connected)
      this.setStatus(server.name, "ready")
    } catch (err) {
      if (err instanceof NeedsInteractiveAuthError) {
        this.setStatus(server.name, "auth_required")
        return
      }
      // Isolation: surface and move on — one bad server never blocks
      // the others or the session.
      this.setStatus(server.name, "failed")
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
    transport.onClose(() => {
      if (this.statusByServer.get(server.name) === "ready") {
        this.setStatus(server.name, "exited")
      }
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
        getAuthHeader: () => (bearer !== undefined ? `Bearer ${bearer}` : staticAuth),
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
      // OAuth path: get a token (non-interactive at startup → may throw
      // NeedsInteractiveAuthError, which connectOne maps to auth_required).
      bearer = await ensureAccessToken({
        serverName: server.name,
        serverUrl: server.url,
        wwwAuthenticate: err.wwwAuthenticate,
        redirectUri: opts.redirectUri,
        store: this.store,
        authorize: opts.authorize,
        interactive: opts.interactiveAuth ?? true,
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
    return { client, tools, serverInfo: client.server }
  }
}
