import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveReadService, CursorCodec } from "../../src/application/reads.js";
import { PrismaReadPersistence } from "../../src/infrastructure/db/prisma-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const userId = randomUUID();
const archiveId = randomUUID();
const conversationIds = [randomUUID(), randomUUID(), randomUUID()];
const messageConversationId = conversationIds[0]!;
const messageIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const personIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const sharedAttachmentId = randomUUID();
const otherAttachmentId = randomUUID();
const messageAttachmentIds = [randomUUID(), randomUUID(), randomUUID()];
const tiedTimestamp = "2026-01-01T00:00:00Z";

const service = new ArchiveReadService(
  new PrismaReadPersistence(prisma),
  new CursorCodec("cursor-permutation-secret"),
);

describe("PostgreSQL cursor permutations", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRaw`
      INSERT INTO "User" (id, "updatedAt") VALUES (${userId}::uuid, now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Archive" (id, "userId", name, "updatedAt")
      VALUES (${archiveId}::uuid, ${userId}::uuid, 'cursor permutations', now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Conversation"
        (id, "archiveId", kind, "stableKey", title, "createdAt", "updatedAt")
      VALUES
        (${conversationIds[0]}::uuid, ${archiveId}::uuid, 'direct', 'conversation-1', 'One', ${tiedTimestamp}::timestamp, now()),
        (${conversationIds[1]}::uuid, ${archiveId}::uuid, 'direct', 'conversation-2', 'Two', ${tiedTimestamp}::timestamp, now()),
        (${conversationIds[2]}::uuid, ${archiveId}::uuid, 'direct', 'conversation-3', 'Three', ${tiedTimestamp}::timestamp, now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Person" (id, "archiveId", "displayName", "updatedAt")
      VALUES
        (${personIds[0]}::uuid, ${archiveId}::uuid, 'Tied', now()),
        (${personIds[1]}::uuid, ${archiveId}::uuid, 'Tied', now()),
        (${personIds[2]}::uuid, ${archiveId}::uuid, 'Other', now()),
        (${personIds[3]}::uuid, ${archiveId}::uuid, null, now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Message"
        (id, "archiveId", "conversationId", "stableKey", "messageType", body, "sentAt", "createdAt", "updatedAt")
      VALUES
        (${messageIds[0]}::uuid, ${archiveId}::uuid, ${messageConversationId}::uuid, 'message-1', 'text', 'cursor needle', ${tiedTimestamp}::timestamp, ${tiedTimestamp}::timestamp, now()),
        (${messageIds[1]}::uuid, ${archiveId}::uuid, ${messageConversationId}::uuid, 'message-2', 'text', 'cursor needle', ${tiedTimestamp}::timestamp, ${tiedTimestamp}::timestamp, now()),
        (${messageIds[2]}::uuid, ${archiveId}::uuid, ${messageConversationId}::uuid, 'message-3', 'text', 'cursor needle', ${tiedTimestamp}::timestamp, ${tiedTimestamp}::timestamp, now()),
        (${messageIds[3]}::uuid, ${archiveId}::uuid, ${messageConversationId}::uuid, 'message-4', 'text', 'cursor needle', null, ${tiedTimestamp}::timestamp, now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Attachment"
        (id, "archiveId", "stableKey", sha256, availability, "mimeType", "createdAt", "updatedAt")
      VALUES
        (${sharedAttachmentId}::uuid, ${archiveId}::uuid, 'shared', repeat('a', 64), 'available', 'image/jpeg', ${tiedTimestamp}::timestamp, now()),
        (${otherAttachmentId}::uuid, ${archiveId}::uuid, 'other', repeat('b', 64), 'missing', 'application/pdf', ${tiedTimestamp}::timestamp, now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "MessageAttachment"
        (id, "archiveId", "messageId", "attachmentId", "createdAt", "updatedAt")
      VALUES
        (${messageAttachmentIds[0]}::uuid, ${archiveId}::uuid, ${messageIds[0]}::uuid, ${sharedAttachmentId}::uuid, ${tiedTimestamp}::timestamp, now()),
        (${messageAttachmentIds[1]}::uuid, ${archiveId}::uuid, ${messageIds[1]}::uuid, ${sharedAttachmentId}::uuid, ${tiedTimestamp}::timestamp, now()),
        (${messageAttachmentIds[2]}::uuid, ${archiveId}::uuid, ${messageIds[2]}::uuid, ${otherAttachmentId}::uuid, ${tiedTimestamp}::timestamp, now())
    `;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "User" WHERE id = ${userId}::uuid`;
    await prisma.$disconnect();
  });

  it("covers tied conversations and null/tied people in both directions", async () => {
    const collectConversations = (direction: "forward" | "backward") =>
      collect((cursor) =>
        service.listConversations({
          archiveId,
          direction,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        }),
      );
    const collectPeople = (direction: "forward" | "backward") =>
      collect((cursor) =>
        service.listPeople({ archiveId, direction, limit: 1, ...(cursor ? { cursor } : {}) }),
      );

    const [conversationsForward, conversationsBackward, peopleForward, peopleBackward] =
      await Promise.all([
        collectConversations("forward"),
        collectConversations("backward"),
        collectPeople("forward"),
        collectPeople("backward"),
      ]);
    for (const rows of [
      conversationsForward,
      conversationsBackward,
      peopleForward,
      peopleBackward,
    ]) {
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    }
    expect(conversationsForward).toHaveLength(3);
    expect(peopleForward).toHaveLength(4);
    expect(conversationsBackward.map((row) => row.id)).toEqual(
      conversationsForward.map((row) => row.id).reverse(),
    );
    expect(peopleBackward.map((row) => row.id)).toEqual(
      peopleForward.map((row) => row.id).reverse(),
    );
  });

  it("covers null/tied messages, multiply-linked media, and timeline events", async () => {
    const collectMessages = (direction: "forward" | "backward") =>
      collect(
        (cursor) =>
          service.listMessages({
            archiveId,
            conversationId: messageConversationId,
            direction,
            limit: 1,
            ...(cursor ? { cursor } : {}),
          }),
        `messages-${direction}`,
      );
    const collectMedia = (direction: "forward" | "backward") =>
      collect(
        (cursor) =>
          service.listMedia({ archiveId, direction, limit: 1, ...(cursor ? { cursor } : {}) }),
        `media-${direction}`,
      );
    const collectTimeline = (direction: "forward" | "backward") =>
      collect(
        (cursor) =>
          service.listTimeline({ archiveId, direction, limit: 1, ...(cursor ? { cursor } : {}) }),
        `timeline-${direction}`,
      );
    const collectSearch = (direction: "forward" | "backward") =>
      collect(
        (cursor) =>
          service.search({
            archiveId,
            query: "needle",
            direction,
            limit: 1,
            ...(cursor ? { cursor } : {}),
          }),
        `search-${direction}`,
      );

    const [
      messagesForward,
      messagesBackward,
      mediaForward,
      mediaBackward,
      timelineForward,
      timelineBackward,
      searchForward,
      searchBackward,
    ] = await Promise.all([
      collectMessages("forward"),
      collectMessages("backward"),
      collectMedia("forward"),
      collectMedia("backward"),
      collectTimeline("forward"),
      collectTimeline("backward"),
      collectSearch("forward"),
      collectSearch("backward"),
    ]);

    for (const rows of [messagesForward, messagesBackward, searchForward, searchBackward])
      expect(new Set(rows.map((row) => row.id)).size).toBe(4);
    expect(messagesBackward.map((row) => row.id)).toEqual(
      messagesForward.map((row) => row.id).reverse(),
    );
    expect(searchBackward.map((row) => row.id)).toEqual(
      searchForward.map((row) => row.id).reverse(),
    );
    for (const rows of [mediaForward, mediaBackward]) {
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => `${row.id}:${row.messageId}`)).size).toBe(3);
    }
    for (const rows of [timelineForward, timelineBackward]) {
      expect(rows).toHaveLength(7);
      expect(rows.filter((row) => row.kind === "message")).toHaveLength(4);
      expect(rows.filter((row) => row.kind === "media")).toHaveLength(3);
    }
    expect(mediaBackward.map((row) => `${row.id}:${row.messageId}`)).toEqual(
      mediaForward.map((row) => `${row.id}:${row.messageId}`).reverse(),
    );
    expect(timelineBackward.map((row) => `${row.kind}:${row.id}:${row.occurredAt}`)).toEqual(
      timelineForward.map((row) => `${row.kind}:${row.id}:${row.occurredAt}`).reverse(),
    );
  });
});

async function collect<T extends { readonly id: string }>(
  getPage: (cursor: string | undefined) => Promise<{
    readonly items: readonly T[];
    readonly nextCursor?: string;
    readonly hasMore: boolean;
  }>,
  label = "read",
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await getPage(cursor);
    items.push(...result.items);
    if (!result.hasMore) return items;
    expect(result.nextCursor).toBeDefined();
    cursor = result.nextCursor;
  }
  throw new Error(`${label} cursor pagination did not terminate: ${JSON.stringify(items)}`);
}
