import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveHealthService } from "../../src/application/health-reads.js";
import { ArchiveReadService, CursorCodec } from "../../src/application/reads.js";
import { McpCredentialAuthenticator, PrivateMcpServer } from "../../src/delivery/mcp/index.js";
import { MCP_ALLOWED_TOOL_NAMES, type McpAuditRecord } from "../../src/delivery/mcp/tools.js";
import {
  PrismaHealthReadPersistence,
  PrismaReadPersistence,
} from "../../src/infrastructure/db/prisma-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const userId = randomUUID();
const archiveId = randomUUID();
const otherArchiveId = randomUUID();
const personOneId = randomUUID();
const personTwoId = randomUUID();
const conversationId = randomUUID();
const messageId = randomUUID();
const attachmentId = randomUUID();

const principal = {
  userId,
  archiveId,
  subject: "synthetic-mcp-client",
  issuer: "functional-test",
} as const;
let activeApp: PrivateMcpServer | undefined;
let activeSessionId = "";
const auditRecords: McpAuditRecord[] = [];

describe("PostgreSQL private MCP read traversal", () => {
  let app: PrivateMcpServer;
  let sessionId = "";

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.createMany({
      data: [
        { id: archiveId, userId, name: "mcp-one" },
        { id: otherArchiveId, userId, name: "mcp-two" },
      ],
    });
    await prisma.person.createMany({
      data: [
        { id: personOneId, archiveId, displayName: "Alex" },
        { id: personTwoId, archiveId, displayName: "Alex" },
      ],
    });
    await prisma.conversation.create({
      data: {
        id: conversationId,
        archiveId,
        kind: "direct",
        stableKey: "mcp-conversation",
        title: "Synthetic",
      },
    });
    await prisma.message.create({
      data: {
        id: messageId,
        archiveId,
        conversationId,
        senderId: personOneId,
        stableKey: "mcp-message",
        messageType: "text",
        body: "hostile source text must remain inert",
        sentAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await prisma.attachment.create({
      data: {
        id: attachmentId,
        archiveId,
        stableKey: "mcp-missing",
        sha256: "a".repeat(64),
        availability: "missing",
        mimeType: "image/jpeg",
      },
    });
    await prisma.messageAttachment.create({
      data: { archiveId, messageId, attachmentId },
    });

    const credentialFile = `${process.env.TMPDIR ?? "/tmp"}/echohoard-mcp-functional-${randomUUID()}`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(credentialFile, "synthetic-mcp-token\n", { mode: 0o600 });
    app = new PrivateMcpServer({
      authenticator: new McpCredentialAuthenticator(credentialFile, principal),
      reads: new ArchiveReadService(
        new PrismaReadPersistence(prisma),
        new CursorCodec("cursor-secret"),
      ),
      health: new ArchiveHealthService(new PrismaHealthReadPersistence(prisma)),
      audit: (record) => {
        auditRecords.push(record);
      },
    });
    activeApp = app;
    const response = await app.handleRequest(initializeRequest());
    expect(response.status).toBe(200);
    sessionId = response.headers.get("mcp-session-id") ?? "";
    activeSessionId = sessionId;
  });

  afterAll(async () => {
    await app?.close();
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("discovers seven tools and completes bounded calls against PostgreSQL", async () => {
    const discovered = await call("tools/list", {});
    expect(discovered.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      MCP_ALLOWED_TOOL_NAMES,
    );
    expect(discovered.result.tools).toHaveLength(7);

    const calls = await Promise.all([
      call("tools/call", { name: "search_messages", arguments: { query: "" } }),
      call("tools/call", { name: "get_conversation", arguments: { conversationId } }),
      call("tools/call", { name: "list_conversations", arguments: {} }),
      call("tools/call", { name: "find_person", arguments: { query: "Alex" } }),
      call("tools/call", { name: "find_media", arguments: { messageId } }),
      call("tools/call", { name: "get_timeline", arguments: { limit: 10 } }),
      call("tools/call", { name: "archive_status", arguments: {} }),
    ]);
    expect(calls.every((response) => response.result?.isError !== true)).toBe(true);
    expect(calls[3]?.result.structuredContent.status).toBe("ambiguous");
    expect(calls[4]?.result.structuredContent.items[0]).toMatchObject({
      id: attachmentId,
      availability: "missing",
    });
    expect(calls[1]?.result.structuredContent.items[0].text).toBe(
      "hostile source text must remain inert",
    );
    expect(calls[6]?.result.structuredContent.provenance).toMatchObject({
      source: "echohoard",
      archiveId,
      untrusted: true,
    });
    expect(calls[1]?.result.structuredContent.evidence.kind).toBe("untrusted_evidence");
    expect(auditRecords).toHaveLength(7);
    expect(auditRecords.every((record) => record.status === "ok")).toBe(true);
    expect(JSON.stringify(auditRecords)).not.toContain("hostile source text");
    expect(JSON.stringify(auditRecords)).not.toContain("synthetic-mcp-token");

    const extra = await call("tools/call", {
      name: "read_everything",
      arguments: {},
    });
    expect(extra.error || extra.result?.isError).toBeTruthy();
  });

  it("rejects invalid credentials and cross-archive probes without leakage", async () => {
    const invalid = await app.handleRequest(initializeRequest("wrong-token"));
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).not.toContain(archiveId);
    const crossArchive = await app.handleRequest(initializeRequest(), otherArchiveId);
    expect(crossArchive.status).toBe(401);
    expect(await crossArchive.text()).not.toContain(otherArchiveId);
  });
});

function initializeRequest(token = "synthetic-mcp-token"): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionIdHeader() ? { "mcp-session-id": sessionIdHeader() } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "functional-test", version: "1" },
      },
    }),
  });
}

function sessionIdHeader(): string {
  return "";
}

async function call(method: string, params: Record<string, unknown>): Promise<any> {
  const response = await appRequest({ method, params });
  return (await response.json()) as any;
}

function appRequest(body: Record<string, unknown>): Promise<Response> {
  if (!activeApp) throw new Error("MCP app is not initialized");
  return activeApp.handleRequest(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-mcp-token",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": activeSessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), ...body }),
    }),
  );
}
