import { randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import {
  McpServer,
  type McpServer as McpServerType,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ArchivePrincipal } from "../../application/auth.js";
import type { ReadPorts } from "../../application/reads.js";
import { registerArchiveReadTools, registerConversationReadTools } from "./tools.js";
import type { McpHealthService } from "./tools.js";
export * from "./tools.js";

export const mcpDelivery = "mcp";
export const MCP_SERVER_NAME = "echohoard-private-readonly";
export const MCP_SERVER_VERSION = "0.1.0";
export const MCP_SESSION_HEADER = "mcp-session-id";
export const MCP_MAX_CREDENTIAL_BYTES = 4096;

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
}

type McpSession = {
  readonly principal: McpPrincipal;
  readonly server: McpServerType;
  readonly transport: WebStandardStreamableHTTPServerTransport;
};

/**
 * Private Streamable HTTP composition root. EH-09-01 intentionally registers
 * no tools yet; later stories add read mappings through `reads`, never SQL or
 * filesystem handlers in this delivery module.
 */
export class PrivateMcpServer {
  private readonly sessions = new Map<string, McpSession>();

  public constructor(private readonly options: McpServerCompositionOptions) {}

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

    const sessionId = request.headers.get(MCP_SESSION_HEADER);
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session || session.principal.archiveId !== principal.archiveId) return notFound();
      return session.transport.handleRequest(request);
    }

    const server = createMcpServer(this.options.reads, principal.archiveId, this.options.health);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessionclosed: (closedSessionId) => {
        this.sessions.delete(closedSessionId);
      },
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    if (transport.sessionId)
      this.sessions.set(transport.sessionId, { principal, server, transport });
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
}

/** Official SDK server composition. Only the bounded EH-09-02 read tools are
 * registered here; later stories may add their explicitly scoped tools. */
export const createMcpServer = (
  reads: McpReadServices,
  archiveId = "",
  health?: McpHealthService,
): McpServer => {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  registerConversationReadTools(server, reads, archiveId);
  registerArchiveReadTools(server, archiveId, health);
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

function unauthorized(): Response {
  return Response.json({ error: "MCP authentication failed" }, { status: 401 });
}

function notFound(): Response {
  return Response.json({ error: "MCP session not found" }, { status: 404 });
}
