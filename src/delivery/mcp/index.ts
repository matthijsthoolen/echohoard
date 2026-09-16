import { randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import {
  McpServer,
  type McpServer as McpServerType,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ArchivePrincipal } from "../../application/auth";
import type { ReadPorts } from "../../application/reads";
import {
  assertMcpToolAllowlist,
  registerArchiveReadTools,
  registerConversationReadTools,
  MCP_MAX_PAYLOAD_BYTES,
  type McpAuditPrincipal,
  type McpAuditSink,
} from "./tools";
import type { McpHealthService } from "./tools";
export * from "./tools";

export const mcpDelivery = "mcp";
export const MCP_SERVER_NAME = "echohoard-private-readonly";
export const MCP_SERVER_VERSION = "0.1.0";
export const MCP_SESSION_HEADER = "mcp-session-id";
export const MCP_MAX_CREDENTIAL_BYTES = 4096;
export const MCP_MAX_REQUEST_BYTES = MCP_MAX_PAYLOAD_BYTES;
export const MCP_MAX_SESSIONS = 100;
export const MCP_SESSION_IDLE_TTL_MS = 30 * 60 * 1_000;

export type McpPrincipal = Readonly<ArchivePrincipal>;

/** Authentication failures intentionally have one message. It must never
 * reveal whether a credential file, user, or archive exists. */
export class McpAuthenticationError extends Error {
  public constructor() {
    super("MCP authentication failed");
    this.name = "McpAuthenticationError";
  }
}

/**
 * Validates one private read-only credential from a mounted secret file.
 * The file is read for each request so rotation takes effect without a
 * process restart. Files and credentials are bounded before comparison.
 */
export class McpCredentialAuthenticator {
  private readonly principal: McpPrincipal;

  public constructor(
    private readonly credentialFile: string,
    principal: McpPrincipal,
  ) {
    if (!credentialFile || !isPrincipal(principal))
      throw new Error("invalid MCP authentication configuration");
    this.principal = Object.freeze({ ...principal });
  }

  public async authenticate(request: Request): Promise<McpPrincipal> {
    const supplied = bearerCredential(request.headers.get("authorization"));
    if (!supplied || Buffer.byteLength(supplied, "utf8") > MCP_MAX_CREDENTIAL_BYTES)
      throw new McpAuthenticationError();

    let expected: string;
    try {
      const details = await lstat(this.credentialFile);
      if (!details.isFile() || details.size > MCP_MAX_CREDENTIAL_BYTES)
        throw new Error("credential unavailable");
      expected = stripTrailingNewline(await readFile(this.credentialFile, { encoding: "utf8" }));
    } catch {
      throw new McpAuthenticationError();
    }
    if (!expected || Buffer.byteLength(expected, "utf8") > MCP_MAX_CREDENTIAL_BYTES)
      throw new McpAuthenticationError();

    const suppliedBytes = Buffer.from(supplied, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    if (
      suppliedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(suppliedBytes, expectedBytes)
    )
      throw new McpAuthenticationError();
    return this.principal;
  }

  /** A credential maps to exactly one archive; callers cannot select one. */
  public assertArchive(principal: McpPrincipal, archiveId: string): void {
    if (
      principal.userId !== this.principal.userId ||
      principal.archiveId !== this.principal.archiveId ||
      principal.subject !== this.principal.subject ||
      principal.issuer !== this.principal.issuer ||
      archiveId !== this.principal.archiveId
    )
      throw new McpAuthenticationError();
  }
}

export type McpReadServices = ReadPorts;

export interface McpServerCompositionOptions {
  readonly authenticator: McpCredentialAuthenticator;
  /** Application read services are the only dependency available to tools. */
  readonly reads: McpReadServices;
  /** Sanitized archive health application service for archive_status. */
  readonly health?: McpHealthService;
  /** Optional content-free audit sink. It never receives tool arguments/results. */
  readonly audit?: McpAuditSink;
  /** Hard cap for in-memory Streamable HTTP sessions. */
  readonly maxSessions?: number;
  /** Idle lifetime for a session before it is evicted. */
  readonly sessionIdleTtlMs?: number;
  /** Injectable clock for deterministic expiry tests. */
  readonly now?: () => number;
}

type McpSession = {
  readonly principal: McpPrincipal;
  readonly server: McpServerType;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  lastActivityAt: number;
};

/**
 * Private Streamable HTTP composition root. Read mappings are supplied through
 * application ports; this delivery module never reaches SQL or filesystem
 * handlers.
 */
export class PrivateMcpServer {
  private readonly sessions = new Map<string, McpSession>();
  private sessionAdmission: Promise<void> = Promise.resolve();
  private readonly maxSessions: number;
  private readonly sessionIdleTtlMs: number;
  private readonly now: () => number;

  public constructor(private readonly options: McpServerCompositionOptions) {
    this.maxSessions = boundedPositiveInteger(
      options.maxSessions ?? MCP_MAX_SESSIONS,
      MCP_MAX_SESSIONS,
    );
    this.sessionIdleTtlMs = boundedPositiveInteger(
      options.sessionIdleTtlMs ?? MCP_SESSION_IDLE_TTL_MS,
      MCP_SESSION_IDLE_TTL_MS,
    );
    this.now = options.now ?? Date.now;
  }

  public async handleRequest(request: Request, requestedArchiveId?: string): Promise<Response> {
    let principal: McpPrincipal;
    try {
      principal = await this.options.authenticator.authenticate(request);
    } catch {
      return unauthorized();
    }
    if (requestedArchiveId !== undefined) {
      try {
        this.options.authenticator.assertArchive(principal, requestedArchiveId);
      } catch {
        return unauthorized();
      }
    }

    const now = this.now();
    await this.evictIdleSessions(now);
    const sessionId = request.headers.get(MCP_SESSION_HEADER);
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session || session.principal.archiveId !== principal.archiveId) return notFound();
      session.lastActivityAt = now;
      return session.transport.handleRequest(request);
    }

    const server = createMcpServer(
      this.options.reads,
      principal.archiveId,
      this.options.health,
      this.options.audit,
      principal,
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessionclosed: (closedSessionId) => {
        this.sessions.delete(closedSessionId);
      },
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const newSessionId = transport.sessionId;
    if (newSessionId) {
      await this.withSessionAdmission(async () => {
        await this.ensureSessionCapacity(now);
        this.sessions.set(newSessionId, {
          principal,
          server,
          transport,
          lastActivityAt: now,
        });
      });
    }
    return response;
  }

  public async close(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async ({ server, transport }) => {
        await transport.close();
        await server.close();
      }),
    );
    this.sessions.clear();
  }

  private async evictIdleSessions(now: number): Promise<void> {
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActivityAt >= this.sessionIdleTtlMs)
        await this.closeSession(sessionId, session);
    }
  }

  private async ensureSessionCapacity(now: number): Promise<void> {
    await this.evictIdleSessions(now);
    while (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort(
        ([leftId, left], [rightId, right]) =>
          left.lastActivityAt - right.lastActivityAt || leftId.localeCompare(rightId),
      )[0];
      if (!oldest) break;
      await this.closeSession(oldest[0], oldest[1]);
    }
  }

  /** Serialize the capacity check and insertion. Both contain awaits, so a
   * plain size check would allow concurrent initialize requests to exceed the
   * configured hard cap. */
  private async withSessionAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionAdmission;
    let release!: () => void;
    this.sessionAdmission = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async closeSession(sessionId: string, session: McpSession): Promise<void> {
    this.sessions.delete(sessionId);
    try {
      await session.transport.close();
    } catch {
      // Eviction is best-effort cleanup; the bounded map remains authoritative.
    }
    try {
      await session.server.close();
    } catch {
      // The SDK may already have closed the server through the transport.
    }
  }
}

/** Official SDK server composition. Only the bounded EH-09-02 read tools are
 * registered here; later stories may add their explicitly scoped tools. */
export const createMcpServer = (
  reads: McpReadServices,
  archiveId = "",
  health?: McpHealthService,
  audit?: McpAuditSink,
  principal?: McpAuditPrincipal,
): McpServer => {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  const registration = { ...(audit ? { audit } : {}), ...(principal ? { principal } : {}) };
  registerConversationReadTools(server, reads, archiveId, registration);
  registerArchiveReadTools(server, archiveId, health, registration);
  assertMcpToolAllowlist(server);
  return server;
};

export const createPrivateMcpServer = (options: McpServerCompositionOptions): PrivateMcpServer =>
  new PrivateMcpServer(options);

function bearerCredential(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  return match?.[1] ?? null;
}

function stripTrailingNewline(value: string): string {
  return value.replace(/(?:\r\n|\n|\r)$/u, "");
}

function isPrincipal(value: McpPrincipal): boolean {
  return Boolean(
    value &&
      typeof value.userId === "string" &&
      value.userId.trim() &&
      typeof value.archiveId === "string" &&
      value.archiveId.trim() &&
      typeof value.subject === "string" &&
      value.subject.trim() &&
      typeof value.issuer === "string" &&
      value.issuer.trim(),
  );
}

function boundedPositiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error("invalid MCP session bound");
  return value;
}

function unauthorized(): Response {
  return Response.json(
    { error: "MCP authentication failed" },
    { status: 401, headers: privateErrorHeaders() },
  );
}

function notFound(): Response {
  return Response.json(
    { error: "MCP session not found" },
    { status: 404, headers: privateErrorHeaders() },
  );
}

function privateErrorHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
