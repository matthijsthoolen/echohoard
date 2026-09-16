import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ReadPorts } from "../../../../application/reads.js";
import {
  MCP_MAX_REQUEST_BYTES,
  MCP_SESSION_HEADER,
  McpCredentialAuthenticator,
  PrivateMcpServer,
} from "../../../mcp/index.js";
import { createMcpRoute } from "./route-handler.js";

const principal = {
  userId: "user-a",
  archiveId: "archive-a",
  subject: "mcp-client",
  issuer: "private",
} as const;

const reads = {
  listConversations: vi.fn(async () => ({ items: [], hasMore: false })),
  listPeople: vi.fn(async () => ({ items: [], hasMore: false })),
  listMessages: vi.fn(async () => ({ items: [], hasMore: false })),
  listMedia: vi.fn(async () => ({ items: [], hasMore: false })),
  listTimeline: vi.fn(async () => ({ items: [], hasMore: false })),
  search: vi.fn(async () => ({ items: [], hasMore: false })),
  statistics: vi.fn(async () => ({
    messageCount: 0,
    personCount: 0,
    conversationCount: 0,
    mediaCount: 0,
  })),
} satisfies ReadPorts;

describe("packaged MCP HTTP route", () => {
  it("discovers the established tools and calls them through the packaged route", async () => {
    const app = await createApp();
    const route = createMcpRoute({ getRuntime: () => ({ mcp: app }) });
    const initialized = await route(initializeRequest());
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get(MCP_SESSION_HEADER);
    expect(sessionId).toBeTruthy();

    const discovered = await route(request("tools/list", {}, sessionId ?? undefined));
    const body = (await discovered.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "search_messages",
      "get_conversation",
      "list_conversations",
      "find_person",
      "find_media",
      "get_timeline",
      "archive_status",
    ]);
    reads.listConversations.mockClear();
    const called = await route(
      request("tools/call", { name: "list_conversations", arguments: { limit: 1 } }, sessionId!),
    );
    expect(called.status).toBe(200);
    expect(reads.listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ archiveId: principal.archiveId, limit: 1 }),
    );
    await app.close();
  });

  it("denies unauthorized requests before the MCP server can disclose discovery or data", async () => {
    const app = await createApp();
    const route = createMcpRoute({ getRuntime: () => ({ mcp: app }) });
    const response = await route(
      new Request("http://web.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("search_messages");
    await app.close();
  });

  it("rejects an oversized streamed body before invoking the MCP server", async () => {
    const handleRequest = vi.fn();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MCP_MAX_REQUEST_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const route = createMcpRoute({
      getRuntime: () => ({ mcp: { handleRequest } }),
    });
    const response = await route(
      new Request("http://web.test/mcp", {
        method: "POST",
        body: stream,
        duplex: "half",
      }),
    );
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(handleRequest).not.toHaveBeenCalled();
    expect(MCP_MAX_REQUEST_BYTES).toBe(256 * 1024);
  });

  it("does not carry a session across a restarted packaged server", async () => {
    const first = await createApp();
    const firstRoute = createMcpRoute({ getRuntime: () => ({ mcp: first }) });
    const initialized = await firstRoute(initializeRequest());
    const sessionId = initialized.headers.get(MCP_SESSION_HEADER)!;
    await first.close();

    const restarted = await createApp();
    const restartedRoute = createMcpRoute({ getRuntime: () => ({ mcp: restarted }) });
    const stale = await restartedRoute(request("tools/list", {}, sessionId));
    expect(stale.status).toBe(404);
    const fresh = await restartedRoute(initializeRequest());
    expect(fresh.status).toBe(200);
    await restarted.close();
  });
});

async function createApp(): Promise<PrivateMcpServer> {
  const root = await mkdtemp(join(tmpdir(), "echohoard-packaged-mcp-"));
  const credential = join(root, "credential");
  await writeFile(credential, "test-token\n", { mode: 0o600 });
  return new PrivateMcpServer({
    authenticator: new McpCredentialAuthenticator(credential, principal),
    reads,
  });
}

function request(method: string, params: Record<string, unknown>, sessionId?: string): Request {
  return new Request("http://web.test/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { [MCP_SESSION_HEADER]: sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

function initializeRequest(): Request {
  return request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "packaged-route-test", version: "1" },
  });
}
