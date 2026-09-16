import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaLiveEventInboxPersistence } from "../../src/infrastructure/db/prisma-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const inbox = new PrismaLiveEventInboxPersistence(prisma);
const userId = randomUUID();
const archiveId = randomUUID();
const otherArchiveId = randomUUID();
const accountId = randomUUID();
const otherAccountId = randomUUID();

function input(archive: string, account: string, receiptId: string, maxPending = 10) {
  return {
    archiveId: archive,
    ownedAccountId: account,
    receiptId,
    sourceEventKey: `wacli:message:${receiptId}`,
    eventKind: "message",
    payload: { kind: "message", synthetic: true },
    observedAt: new Date("2026-01-01T00:00:00.000Z"),
    receivedAt: new Date("2026-01-01T00:00:01.000Z"),
    maxPending,
  } as const;
}

describe("live event inbox PostgreSQL durability", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.createMany({
      data: [
        { id: archiveId, userId, name: `live-inbox-${archiveId}` },
        { id: otherArchiveId, userId, name: `live-inbox-${otherArchiveId}` },
      ],
    });
    await prisma.ownedAccount.createMany({
      data: [
        { id: accountId, archiveId, accountKey: `account-${accountId}` },
        { id: otherAccountId, archiveId: otherArchiveId, accountKey: `account-${otherAccountId}` },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("commits one receipt, replays it idempotently, and applies explicit backpressure", async () => {
    const receiptId = randomUUID().replaceAll("-", "");
    expect((await inbox.enqueue(input(archiveId, accountId, receiptId))).kind).toBe("accepted");
    expect((await inbox.enqueue(input(archiveId, accountId, receiptId))).kind).toBe("duplicate");
    expect(
      (await inbox.enqueue(input(archiveId, accountId, randomUUID().replaceAll("-", ""), 1))).kind,
    ).toBe("backpressure");
    expect(await prisma.liveEventInbox.count({ where: { archiveId } })).toBe(1);
  });

  it("keeps account/archive scope in the durable key", async () => {
    const receiptId = randomUUID().replaceAll("-", "");
    expect((await inbox.enqueue(input(otherArchiveId, otherAccountId, receiptId))).kind).toBe(
      "accepted",
    );
    expect(await prisma.liveEventInbox.count({ where: { archiveId } })).toBe(1);
    expect(await prisma.liveEventInbox.count({ where: { archiveId: otherArchiveId } })).toBe(1);
  });
});
