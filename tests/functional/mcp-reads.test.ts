import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveHealthService } from "../../src/application/health-reads.js";
import { ArchiveReadService, CursorCodec } from "../../src/application/reads.js";
import { ConversationGroupingService } from "../../src/application/conversation-grouping.js";
import { PrismaConversationGroupingPersistence } from "../../src/infrastructure/db/conversation-grouping.js";
import { McpCredentialAuthenticator, PrivateMcpServer } from "../../src/delivery/mcp/index.js";
import { createMcpRoute } from "../../src/delivery/web/app/mcp/route-handler.js";
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
const deniedOnlyPersonId = randomUUID();
const otherPersonId = randomUUID();
const conversationId = randomUUID();
const hiddenAllowedConversationId = randomUUID();
const deniedConversationId = randomUUID();
const otherConversationId = randomUUID();
const accountOneId = randomUUID();
const accountTwoId = randomUUID();
const otherAccountId = randomUUID();
const messageId = randomUUID();
const hiddenAllowedMessageId = randomUUID();
const deniedMessageId = randomUUID();
const deniedOnlyMessageId = randomUUID();
const otherMessageId = randomUUID();
const attachmentId = randomUUID();

const principal = {
  userId,
  archiveId,
  subject: "synthetic-mcp-client",
  issuer: "functional-test",
} as const;
type ContractSnapshot = {
  contractVersion: string;
  server: { name: string; version: string };
  tools: Array<{
    name: string;
    requiredInputProperties: string[];
    inputProperties: string[];
  }>;
};
const contract = JSON.parse(
  await readFile(new URL("../../docs/mcp-contract.v0.1.json", import.meta.url), "utf8"),
) as ContractSnapshot;
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
    await prisma.ownedAccount.createMany({
      data: [
        {
          id: accountOneId,
          archiveId,
          accountKey: "synthetic-mcp-account-one-key",
          displayLabel: "synthetic-mcp-account-one-label",
        },
        {
          id: accountTwoId,
          archiveId,
          accountKey: "synthetic-mcp-account-two-key",
          displayLabel: "synthetic-mcp-account-two-label",
        },
        {
          id: otherAccountId,
          archiveId: otherArchiveId,
          accountKey: "synthetic-mcp-other-account-key",
          displayLabel: "synthetic-mcp-other-account-label",
        },
      ],
    });
    await prisma.person.createMany({
      data: [
        { id: personOneId, archiveId, displayName: "Alex" },
        { id: personTwoId, archiveId, displayName: "Alex" },
        { id: deniedOnlyPersonId, archiveId, displayName: "Denied only" },
        { id: otherPersonId, archiveId: otherArchiveId, displayName: "Alex" },
      ],
    });
    await prisma.conversation.createMany({
      data: [
        {
          id: conversationId,
          archiveId,
          kind: "direct",
          stableKey: "mcp-conversation",
          title: "Synthetic",
          uiVisibility: "normal",
          mcpAccess: "allowed",
        },
        {
          id: hiddenAllowedConversationId,
          archiveId,
          kind: "direct",
          stableKey: "mcp-hidden-allowed",
          title: "MCP hidden but allowed",
          uiVisibility: "hidden",
          mcpAccess: "allowed",
        },
        {
          id: deniedConversationId,
          archiveId,
          kind: "direct",
          stableKey: "mcp-denied",
          title: "MCP denied",
          uiVisibility: "normal",
          mcpAccess: "denied",
        },
        {
          id: otherConversationId,
          archiveId: otherArchiveId,
          kind: "direct",
          stableKey: "mcp-other-archive",
          title: "Other archive",
          uiVisibility: "normal",
          mcpAccess: "allowed",
        },
      ],
    });
    await prisma.message.createMany({
      data: [
        {
          id: messageId,
          archiveId,
          conversationId,
          sourceConversationId: null,
          senderId: personOneId,
          stableKey: "mcp-message",
          messageType: "text",
          body: "hostile source text must remain inert",
          sentAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: hiddenAllowedMessageId,
          archiveId,
          conversationId: hiddenAllowedConversationId,
          sourceConversationId: null,
          senderId: personOneId,
          stableKey: "mcp-hidden-allowed-message",
          messageType: "text",
          body: "MCP allowed despite UI hidden",
          sentAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          id: deniedMessageId,
          archiveId,
          conversationId: deniedConversationId,
          sourceConversationId: null,
          senderId: personOneId,
          stableKey: "mcp-denied-message",
          messageType: "text",
          body: "MCP denied source must stay private",
          sentAt: new Date("2026-01-03T00:00:00.000Z"),
        },
        {
          id: deniedOnlyMessageId,
          archiveId,
          conversationId: deniedConversationId,
          sourceConversationId: null,
          senderId: deniedOnlyPersonId,
          stableKey: "mcp-denied-only-message",
          messageType: "text",
          body: "denied-only sender must stay private",
          sentAt: new Date("2026-01-03T12:00:00.000Z"),
        },
        {
          id: otherMessageId,
          archiveId: otherArchiveId,
          conversationId: otherConversationId,
          sourceConversationId: null,
          senderId: otherPersonId,
          stableKey: "mcp-other-archive-message",
          messageType: "text",
          body: "other archive must never cross the boundary",
          sentAt: new Date("2026-01-04T00:00:00.000Z"),
        },
      ],
    });
    await prisma.conversationParticipant.create({
      data: { archiveId, conversationId, personId: personTwoId },
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
    const initializeBody = (await response.clone().json()) as {
      result?: { serverInfo?: { name?: string; version?: string } };
    };
    expect(initializeBody.result?.serverInfo).toEqual({
      name: contract.server.name,
      version: contract.server.version,
    });
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
    const discoveredTools = discovered.result.tools as Array<{
      name: string;
      inputSchema: { properties?: Record<string, unknown>; required?: string[] };
    }>;
    expect(discoveredTools.map((tool) => tool.name)).toEqual(MCP_ALLOWED_TOOL_NAMES);
    expect(discovered.result.tools).toHaveLength(7);
    expect(contract.contractVersion).toBe("0.1.0");
    expect(discoveredTools).toHaveLength(contract.tools.length);
    for (const expected of contract.tools) {
      const actual = discoveredTools.find((tool) => tool.name === expected.name);
      expect(actual, `missing contract tool ${expected.name}`).toBeDefined();
      expect(Object.keys(actual?.inputSchema.properties ?? {}).sort()).toEqual(
        expected.inputProperties,
      );
      expect((actual?.inputSchema.required ?? []).slice().sort()).toEqual(
        expected.requiredInputProperties,
      );
    }

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
    expect(JSON.stringify(calls)).not.toContain("synthetic-mcp-account-key");
    expect(JSON.stringify(calls)).not.toContain("synthetic-mcp-account-label");

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

  it("uses MCP policy independently through representative HTTP calls", async () => {
    const route = createMcpRoute({ getRuntime: () => ({ mcp: app }) });
    const hidden = await httpCall(route, "get_conversation", {
      conversationId: hiddenAllowedConversationId,
    });
    expect(hidden.result.structuredContent.items.map((item: { id: string }) => item.id)).toContain(
      hiddenAllowedMessageId,
    );

    const denied = await httpCall(route, "get_conversation", {
      conversationId: deniedConversationId,
    });
    expect(denied.result.structuredContent.items).toEqual([]);
    expect(JSON.stringify(denied)).not.toContain("MCP denied source");

    const search = await httpCall(route, "search_messages", {
      query: "MCP",
      limit: 10,
    });
    const searchIds = search.result.structuredContent.items.map((item: { id: string }) => item.id);
    expect(searchIds).toContain(hiddenAllowedMessageId);
    expect(searchIds).not.toContain(deniedMessageId);
    expect(searchIds).not.toContain(deniedOnlyMessageId);

    const people = await httpCall(route, "find_person", { query: "Alex", limit: 10 });
    const peopleIds = people.result.structuredContent.items.map((item: { id: string }) => item.id);
    expect(peopleIds).toEqual(expect.arrayContaining([personOneId, personTwoId]));
    expect(peopleIds).not.toContain(deniedOnlyPersonId);
    expect(peopleIds).not.toContain(otherPersonId);

    const deniedOnly = await httpCall(route, "find_person", { query: "Denied only" });
    expect(deniedOnly.result.structuredContent.items).toEqual([]);

    const conversations = await httpCall(route, "list_conversations", { limit: 10 });
    const conversationIds = conversations.result.structuredContent.items.map(
      (item: { id: string }) => item.id,
    );
    expect(conversationIds).toContain(hiddenAllowedConversationId);
    expect(conversationIds).not.toContain(deniedConversationId);
    expect(conversationIds).not.toContain(otherConversationId);

    const status = await httpCall(route, "archive_status", {});
    expect(status.result.structuredContent.counts).toMatchObject({
      messages: 2,
      conversations: 2,
      people: 2,
    });

    const otherArchive = await httpCall(route, "get_conversation", {
      conversationId: otherConversationId,
    });
    expect(otherArchive.result.structuredContent.items).toEqual([]);
    expect(JSON.stringify(otherArchive)).not.toContain(otherMessageId);
  });

  it("exposes a merged conversation once and switches back after unmerge", async () => {
    const sourceConversationId = randomUUID();
    const sourceMessageId = randomUUID();
    const targetMessageId = randomUUID();
    const secondSourceMessageId = randomUUID();
    const grouping = new ConversationGroupingService(
      new PrismaConversationGroupingPersistence(prisma),
    );
    await prisma.conversation.create({
      data: {
        id: sourceConversationId,
        archiveId,
        kind: "direct",
        stableKey: `mcp-unified-source-${sourceConversationId}`,
        title: "MCP unified source",
        mcpAccess: "allowed",
      },
    });
    await prisma.sourceConversation.createMany({
      data: [
        {
          id: conversationId,
          archiveId,
          ownedAccountId: accountOneId,
          unifiedConversationId: conversationId,
          sourceNamespace: "synthetic",
          sourceConversationKey: `mcp-unified-target-${conversationId}`,
        },
        {
          id: sourceConversationId,
          archiveId,
          ownedAccountId: accountTwoId,
          unifiedConversationId: sourceConversationId,
          sourceNamespace: "synthetic",
          sourceConversationKey: `mcp-unified-source-${sourceConversationId}`,
        },
      ],
    });
    await prisma.message.create({
      data: {
        id: sourceMessageId,
        archiveId,
        conversationId: sourceConversationId,
        sourceConversationId,
        senderId: personOneId,
        stableKey: `mcp-unified-message-${sourceMessageId}`,
        messageType: "text",
        body: "synthetic unified MCP message",
        sentAt: new Date("2026-01-05T00:00:00.000Z"),
      },
    });
    await prisma.message.createMany({
      data: [
        {
          id: targetMessageId,
          archiveId,
          conversationId,
          sourceConversationId: conversationId,
          senderId: personOneId,
          stableKey: `mcp-unified-target-message-${targetMessageId}`,
          messageType: "text",
          body: "source-account-probe",
          sentAt: new Date("2026-01-05T00:00:00.000Z"),
        },
        {
          id: secondSourceMessageId,
          archiveId,
          conversationId: sourceConversationId,
          sourceConversationId,
          senderId: personOneId,
          stableKey: `mcp-unified-source-message-${secondSourceMessageId}`,
          messageType: "text",
          body: "source-account-probe",
          sentAt: new Date("2026-01-05T00:00:00.000Z"),
        },
      ],
    });
    const merged = await grouping.merge({
      archiveId,
      targetConversationId: conversationId,
      sourceConversationIds: [sourceConversationId],
      expectedVersion: 0,
      actor: "synthetic-owner",
      reason: "MCP unified read regression",
      idempotencyKey: `mcp-unified-merge-${sourceMessageId}`,
      uiAccess: { authorizedConversationIds: [] },
    });

    const listed = await call("tools/call", {
      name: "list_conversations",
      arguments: { limit: 10 },
    });
    const listedIds = listed.result.structuredContent.items.map((item: { id: string }) => item.id);
    expect(
      listedIds.filter((id: string) => id === conversationId || id === sourceConversationId),
    ).toEqual([conversationId]);
    expect(
      listed.result.structuredContent.items.find(
        (item: { id: string }) => item.id === conversationId,
      ),
    ).toMatchObject({ sourceCount: 2 });

    const messages = await call("tools/call", {
      name: "get_conversation",
      arguments: { conversationId, limit: 10 },
    });
    const mergedMessageIds = messages.result.structuredContent.items.map(
      (item: { id: string }) => item.id,
    );
    expect(mergedMessageIds).toEqual([
      messageId,
      ...[sourceMessageId, targetMessageId, secondSourceMessageId].sort(),
    ]);
    expect(mergedMessageIds).toHaveLength(4);
    expect(messages.result.structuredContent.items[0].conversationId).toBe(conversationId);
    expect(JSON.stringify(messages)).not.toContain(sourceConversationId);

    const accountSelected = await call("tools/call", {
      name: "search_messages",
      arguments: {
        query: "source-account-probe",
        sourceAccountId: accountTwoId,
        limit: 10,
      },
    });
    expect(
      accountSelected.result.structuredContent.items.map((item: { id: string }) => item.id),
    ).toEqual([secondSourceMessageId]);
    expect(accountSelected.result.structuredContent.items).toHaveLength(1);

    const crossAccount = await call("tools/call", {
      name: "search_messages",
      arguments: {
        query: "source-account-probe",
        sourceAccountId: otherAccountId,
        limit: 10,
      },
    });
    expect(crossAccount.result.structuredContent.items).toEqual([]);

    const searched = await call("tools/call", {
      name: "search_messages",
      arguments: { query: "synthetic unified MCP message" },
    });
    expect(searched.result.structuredContent.items).toEqual([
      expect.objectContaining({ id: sourceMessageId, conversationId }),
    ]);

    const timeline = await call("tools/call", {
      name: "get_timeline",
      arguments: { from: "2026-01-05T00:00:00.000Z", to: "2026-01-06T00:00:00.000Z" },
    });
    expect(timeline.result.structuredContent.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sourceMessageId, conversationId })]),
    );

    await grouping.unmerge({
      archiveId,
      targetConversationId: conversationId,
      sourceConversationIds: [sourceConversationId],
      expectedVersion: 1,
      actor: "synthetic-owner",
      reason: "MCP unified read regression undo",
      idempotencyKey: `mcp-unified-unmerge-${sourceMessageId}`,
      auditId: merged.auditId,
      uiAccess: { authorizedConversationIds: [] },
    });
    const afterUnmerge = await call("tools/call", {
      name: "list_conversations",
      arguments: { limit: 10 },
    });
    const afterIds = afterUnmerge.result.structuredContent.items.map(
      (item: { id: string }) => item.id,
    );
    expect(
      afterIds.filter((id: string) => id === conversationId || id === sourceConversationId).sort(),
    ).toEqual([conversationId, sourceConversationId].sort());
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

async function httpCall(
  route: (request: Request) => Promise<Response>,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const response = await route(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-mcp-token",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": activeSessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name: method, arguments: params },
      }),
    }),
  );
  expect(response.status).toBe(200);
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
