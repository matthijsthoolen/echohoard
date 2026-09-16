import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReadPorts } from "../../application/reads.js";
import {
  MCP_SESSION_HEADER,
  McpAuthenticationError,
  McpCredentialAuthenticator,
  PrivateMcpServer,
} from "./index.js";

const principal = {
  userId: "user-a",
  archiveId: "archive-a",
  subject: "read-client",
  issuer: "private",
} as const;
const reads = {} as ReadPorts;

const initialize = (credential: string, sessionId?: string) =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { [MCP_SESSION_HEADER]: sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "functional-test", version: "1" },
      },
    }),
  });

describe("private MCP Streamable HTTP transport", () => {
  it("authenticates initialization and keeps the principal archive-scoped", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-mcp-"));
    const secretFile = join(root, "credential");
    await writeFile(secretFile, "sentinel-read-token\n", { mode: 0o600 });
    const app = new PrivateMcpServer({
      authenticator: new McpCredentialAuthenticator(secretFile, principal),
      reads,
    });

    const response = await app.handleRequest(initialize("sentinel-read-token"));
    expect(response.status).toBe(200);
    expect(response.headers.get(MCP_SESSION_HEADER)).toBeTruthy();
    expect(await response.text()).toContain('"serverInfo"');
    const tools = await app.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer sentinel-read-token",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          [MCP_SESSION_HEADER]: response.headers.get(MCP_SESSION_HEADER)!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
    );
    expect(tools.status).toBe(200);
    const toolsBody = await tools.text();
    expect(toolsBody).toContain('"name":"search_messages"');
    expect(toolsBody).toContain('"name":"get_conversation"');
    expect(toolsBody).toContain('"name":"list_conversations"');
    expect(toolsBody).toContain('"name":"find_person"');
    expect(toolsBody).toContain('"name":"find_media"');
    expect(toolsBody).toContain('"name":"get_timeline"');
    expect(toolsBody).toContain('"name":"archive_status"');
    expect(toolsBody).not.toContain("archive-a");
    await app.close();
  });

  it("rejects missing and invalid credentials without archive metadata or secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-mcp-"));
    const secretFile = join(root, "credential");
    await writeFile(secretFile, "sentinel-read-token\n", { mode: 0o600 });
    const authenticator = new McpCredentialAuthenticator(secretFile, principal);
    const app = new PrivateMcpServer({ authenticator, reads });

    const missing = await app.handleRequest(
      new Request("http://localhost/mcp", { method: "POST" }),
    );
    const invalid = await app.handleRequest(initialize("wrong-token"));
    for (const response of [missing, invalid]) {
      expect(response.status).toBe(401);
      const body = await response.text();
      expect(body).not.toContain("archive-a");
      expect(body).not.toContain("sentinel-read-token");
    }
    const absentFileApp = new PrivateMcpServer({
      authenticator: new McpCredentialAuthenticator(join(root, "missing"), principal),
      reads,
    });
    const absentFile = await absentFileApp.handleRequest(initialize("sentinel-read-token"));
    expect(absentFile.status).toBe(401);
    expect(await absentFile.text()).not.toContain("missing");
    await absentFileApp.close();
    await app.close();
  });

  it("does not permit a session to be used as another archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-mcp-"));
    const secretFile = join(root, "credential");
    await writeFile(secretFile, "sentinel-read-token\n", { mode: 0o600 });
    const authenticator = new McpCredentialAuthenticator(secretFile, principal);
    const app = new PrivateMcpServer({ authenticator, reads });
    const initialized = await app.handleRequest(initialize("sentinel-read-token"));
    const sessionId = initialized.headers.get(MCP_SESSION_HEADER)!;
    expect(sessionId).toBeTruthy();

    expect(() => authenticator.assertArchive(principal, "archive-b")).toThrow(
      McpAuthenticationError,
    );
    const crossArchiveProbe = await app.handleRequest(
      initialize("sentinel-read-token", sessionId),
      "archive-b",
    );
    expect(crossArchiveProbe.status).toBe(401);
    expect(await crossArchiveProbe.text()).not.toContain("archive-b");
    await app.close();
  });

  it("evicts deterministically at the strict session maximum and idle TTL", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-mcp-"));
    const secretFile = join(root, "credential");
    await writeFile(secretFile, "sentinel-read-token\n", { mode: 0o600 });
    let now = 1_000;
    const app = new PrivateMcpServer({
      authenticator: new McpCredentialAuthenticator(secretFile, principal),
      reads,
      maxSessions: 1,
      sessionIdleTtlMs: 100,
      now: () => now,
    });

    const first = await app.handleRequest(initialize("sentinel-read-token"));
    const firstSessionId = first.headers.get(MCP_SESSION_HEADER)!;
    expect(firstSessionId).toBeTruthy();

    now += 25;
    const active = await app.handleRequest(sessionRequest("sentinel-read-token", firstSessionId));
    expect(active.status).toBe(200);

    now += 25;
    const second = await app.handleRequest(initialize("sentinel-read-token"));
    const secondSessionId = second.headers.get(MCP_SESSION_HEADER)!;
    expect(second.status).toBe(200);
    expect(secondSessionId).not.toBe(firstSessionId);

    const evictedByMaximum = await app.handleRequest(
      initialize("sentinel-read-token", firstSessionId),
    );
    expect(evictedByMaximum.status).toBe(404);

    now += 100;
    const expired = await app.handleRequest(sessionRequest("sentinel-read-token", secondSessionId));
    expect(expired.status).toBe(404);
    await app.close();
  });

  it("keeps concurrent initialization within the strict session maximum", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-mcp-"));
    const secretFile = join(root, "credential");
    await writeFile(secretFile, "sentinel-read-token\n", { mode: 0o600 });
    const app = new PrivateMcpServer({
      authenticator: new McpCredentialAuthenticator(secretFile, principal),
      reads,
      maxSessions: 1,
      sessionIdleTtlMs: 10_000,
    });

    const responses = await Promise.all([
      app.handleRequest(initialize("sentinel-read-token")),
      app.handleRequest(initialize("sentinel-read-token")),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const sessionIds = responses.map((response) => response.headers.get(MCP_SESSION_HEADER)!);
    expect(new Set(sessionIds).size).toBe(2);

    const probes = await Promise.all(
      sessionIds.map((sessionId) =>
        app.handleRequest(sessionRequest("sentinel-read-token", sessionId)),
      ),
    );
    expect(probes.filter((response) => response.status === 200)).toHaveLength(1);
    expect(probes.filter((response) => response.status === 404)).toHaveLength(1);
    await app.close();
  });
});

function sessionRequest(credential: string, sessionId: string): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      [MCP_SESSION_HEADER]: sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
}
