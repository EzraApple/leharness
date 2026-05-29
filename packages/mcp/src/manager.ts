// manager.ts
// Owns the lifecycle of all configured MCP servers: connect each, run
// auth where needed, aggregate their tools (namespaced <server>__<tool>),
// and track per-server status for the UI. The one object products touch.
//
// Startup is non-interactive by default (interactiveAuth: false): an
// OAuth server with no usable stored token is marked auth_required
// rather than popping a browser. The interactive flow runs later, on a
// deliberate user gesture, via authorizeServer().

import {
  ensureAccessToken,
  type LoopbackAuthorization,
  NeedsInteractiveAuthError,
} from "./auth/oauth.js"
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
  // Why a server is failed/exited (close reason or rejection message).
  // Undefined while connecting/ready/auth_required.
  error?: string
  // Recent stderr lines from the server's last (re)connect attempt — the
  // real diagnostic for a crashed stdio server (HTTP servers have none).
  // Only populated for failed/exited servers.
  recentStderr?: string[]
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
  // App-supplied: begin a loopback OAuth authorization — bind the redirect
  // listener (on a free port, no hardcoded-port collision) and return its
  // URI plus a code waiter. Only invoked when interactiveAuth is true
  // (one-shot CLI) or via authorizeServer().
  beginAuthorization: () => Promise<LoopbackAuthorization>
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

// How many recent stderr lines to retain per server for diagnostics.
// Enough to capture a multi-line error dump without unbounded growth.
const STDERR_TAIL_LIMIT = 12

export class McpManager {
  private readonly store: TokenStore
  private readonly statusByServer = new Map<string, McpStatus>()
  private readonly connected = new Map<string, ConnectedServer>()
  private readonly serverByName = new Map<string, ServerConfig>()
  private readonly listeners = new Set<(name: string, status: McpStatus) => void>()
  private readonly errorByServer = new Map<string, string>()
  private readonly stderrTailByServer = new Map<string, string[]>()
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
      const detail: McpServerDetail = {
        status,
        toolCount: conn?.tools.length ?? 0,
        serverInfo: conn?.serverInfo,
      }
      if (status === "failed" || status === "exited") {
        detail.error = this.errorByServer.get(name)
        const tail = this.stderrTailByServer.get(name)
        if (tail !== undefined && tail.length > 0) detail.recentStderr = [...tail]
      }
      out.set(name, detail)
    }
    return out
  }

  // Connect every configured server. A failure on one is isolated:
  // logged via status, never thrown, never blocks the others.
  async connectAll(opts: ConnectOptions): Promise<void> {
    this.lastConnectOptions = opts
    await Promise.all(this.options().map((server) => this.connectOne(server, opts)))
  }

  // Reconcile the configured set against a freshly-loaded config (the
  // config file was edited mid-session — typically an agent-led add).
  // Servers dropped from the config are disconnected and forgotten;
  // servers new to the config are connected; servers whose definition
  // changed (e.g. a stdio→url edit) are disconnected and reconnected so
  // the edit applies on the next /mcp; unchanged servers keep their live
  // connection. No-op until connectAll has run — it seeds the connect
  // options reused here.
  async syncServers(servers: ServerConfig[]): Promise<void> {
    const opts = this.lastConnectOptions
    if (opts === undefined) return
    const next = new Map(servers.map((s) => [s.name, s]))

    for (const name of [...this.serverByName.keys()]) {
      if (!next.has(name)) {
        await this.disconnectOne(name)
        this.serverByName.delete(name)
        this.statusByServer.delete(name)
      }
    }

    const toConnect: ServerConfig[] = []
    for (const [name, server] of next) {
      const existing = this.serverByName.get(name)
      const changed = existing !== undefined && !sameServerConfig(existing, server)
      this.serverByName.set(name, server)
      if (existing === undefined || changed) {
        if (changed) await this.disconnectOne(name)
        this.setStatus(name, "connecting")
        toConnect.push(server)
      }
    }
    await Promise.all(toConnect.map((server) => this.connectOne(server, opts)))
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
    // A healthy transition clears any stale failure reason; failed/exited
    // keep whatever the caller recorded just before calling setStatus.
    if (status !== "failed" && status !== "exited") this.errorByServer.delete(name)
    this.statusByServer.set(name, status)
    for (const listener of this.listeners) listener(name, status)
  }

  private recordStderr(name: string, line: string): void {
    const tail = this.stderrTailByServer.get(name) ?? []
    tail.push(line)
    while (tail.length > STDERR_TAIL_LIMIT) tail.shift()
    this.stderrTailByServer.set(name, tail)
  }

  private async disconnectOne(name: string): Promise<void> {
    const conn = this.connected.get(name)
    if (conn !== undefined) {
      await conn.client.close()
      this.connected.delete(name)
    }
  }

  private async connectOne(server: ServerConfig, opts: ConnectOptions): Promise<void> {
    // Fresh attempt — drop stderr captured from any previous try.
    this.stderrTailByServer.delete(server.name)
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
      // Isolation: record why and move on — one bad server never blocks
      // the others or the session. The reason surfaces via details()
      // (/mcp); we don't print it, so the TUI stays quiet.
      this.errorByServer.set(server.name, err instanceof Error ? err.message : String(err))
      this.setStatus(server.name, "failed")
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
      onStderr: (line) => {
        // Capture for diagnostics (surfaced via /mcp) and forward to the
        // product's optional sink (suppressed in the TUI to stay quiet).
        this.recordStderr(server.name, line)
        opts.onStderr?.(server.name, line)
      },
    })
    const client = new McpClient(transport, {
      clientName: this.clientName,
      clientVersion: this.clientVersion,
    })
    transport.onClose((reason) => {
      if (this.statusByServer.get(server.name) === "ready") {
        this.errorByServer.set(server.name, reason)
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
        store: this.store,
        beginAuthorization: opts.beginAuthorization,
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

// Two server configs are equal when their definitions match. Both come
// from the same config parser, so field order is stable and a JSON
// compare is enough to detect an edit (e.g. command→url, changed args).
function sameServerConfig(a: ServerConfig, b: ServerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
