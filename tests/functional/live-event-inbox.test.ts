import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  PrismaLiveEventInboxPersistence,
  PrismaLiveEventNormalizer,
} from "../../src/infrastructure/db/prisma-persistence.js";
import {
  parseWacliWebhookEvent,
  type WacliWebhookEvent,
} from "../../src/adapters/wacli/contract.js";
import { normalizeWacliEvent } from "../../src/adapters/wacli/normalize.js";
import {
  CountingLiveEventMetrics,
  LiveEventIntakeService,
  signLiveEvent,
} from "../../src/application/live-event-intake.js";
import { createLiveEventRoute } from "../../src/delivery/web/app/api/internal/live-events/route-handler.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const inbox = new PrismaLiveEventInboxPersistence(prisma);
const normalizer = new PrismaLiveEventNormalizer(
  prisma,
  (payload, accountKey) => parseWacliWebhookEvent(payload, accountKey),
  (event) => normalizeWacliEvent(asWacliEvent(event)),
);
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

function asWacliEvent(event: unknown): WacliWebhookEvent {
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw new Error("live event adaptation produced an invalid event");
  const kind = (event as { readonly kind?: unknown }).kind;
  if (kind !== "message" && kind !== "receipt" && kind !== "chat_presence")
    throw new Error("live event adaptation produced an unsupported event");
  return event as WacliWebhookEvent;
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
        { id: accountId, archiveId, accountKey: `account-${accountId}`, liveEnabled: true },
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
    const claim = (
      await normalizer.claimPending({
        archiveId,
        limit: 1,
        workerId: "test",
        now: new Date(),
        claimExpiresAt: new Date(Date.now() + 60_000),
      })
    )[0]!;
    await normalizer.failClaim({
      ...claim,
      retryable: false,
      errorClass: "invalid-payload",
      now: new Date(),
    });
  });

  it("keeps account/archive scope in the durable key", async () => {
    const receiptId = randomUUID().replaceAll("-", "");
    expect((await inbox.enqueue(input(otherArchiveId, otherAccountId, receiptId))).kind).toBe(
      "accepted",
    );
    expect(await prisma.liveEventInbox.count({ where: { archiveId } })).toBe(1);
    expect(await prisma.liveEventInbox.count({ where: { archiveId: otherArchiveId } })).toBe(1);
  });

  it("finalizes a message receipt with observations in one retryable transaction", async () => {
    const receiptId = randomUUID().replaceAll("-", "");
    const event = {
      Chat: "15550000001@s.whatsapp.net",
      ID: `synthetic-live-${receiptId}`,
      SenderJID: "15550000001@s.whatsapp.net",
      Timestamp: "2026-01-01T00:00:00.000Z",
      FromMe: false,
      Text: "synthetic live history",
    };
    await inbox.enqueue({
      ...input(archiveId, accountId, receiptId),
      sourceEventKey: `wacli:message:${accountId}:${event.Chat}:${event.ID}`,
      payload: event,
    });
    const result = await normalizer.normalize({ archiveId, ownedAccountId: accountId, receiptId });
    expect(result.status).toBe("normalized");
    expect(await prisma.liveEventInbox.findFirst({ where: { receiptId } })).toMatchObject({
      status: "normalized",
    });
    expect(
      await prisma.messageObservation.count({
        where: { archiveId, observedValue: { path: ["body"], equals: "synthetic live history" } },
      }),
    ).toBe(1);
  });

  it("accepts a signed webhook through the web route and normalizes it", async () => {
    const accountKey = `account-${accountId}`;
    const secret = "synthetic-webhook-secret";
    const event = {
      Chat: "15550000001@s.whatsapp.net",
      ID: `synthetic-route-${randomUUID()}`,
      SenderJID: "15550000001@s.whatsapp.net",
      Timestamp: "2026-01-01T00:00:00.000Z",
      FromMe: false,
      Text: "synthetic compose webhook",
    };
    const body = new TextEncoder().encode(JSON.stringify(event));
    const timestamp = Math.floor(Date.now() / 1000);
    const intake = new LiveEventIntakeService(
      {
        resolve: async (key) =>
          key === accountKey ? { archiveId, ownedAccountId: accountId, secret } : null,
      },
      inbox,
      new CountingLiveEventMetrics(),
      {
        validate: (payload, key) => {
          const parsed = parseWacliWebhookEvent(payload, key);
          return {
            kind: parsed.kind,
            sourceEventKey: parsed.sourceEventKey,
            observedAt: parsed.observedAt,
            payload: JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>,
          };
        },
      },
    );
    const route = createLiveEventRoute({ getIntake: () => intake });
    const response = await route(
      new Request(`http://web:3000/api/internal/live-events?account=${accountKey}`, {
        method: "POST",
        headers: {
          "x-echohoard-timestamp": String(timestamp),
          "x-echohoard-signature": signLiveEvent(body, timestamp, secret),
        },
        body,
      }),
    );
    expect(response.status).toBe(202);
    const receipt = await prisma.liveEventInbox.findFirstOrThrow({
      where: {
        archiveId,
        ownedAccountId: accountId,
        sourceEventKey: { startsWith: `wacli:message:${accountKey}:` },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(
      (
        await normalizer.normalize({
          archiveId,
          ownedAccountId: accountId,
          receiptId: receipt.receiptId,
        })
      ).status,
    ).toBe("normalized");
    expect(
      await prisma.messageObservation.count({
        where: {
          archiveId,
          observedValue: { path: ["body"], equals: "synthetic compose webhook" },
        },
      }),
    ).toBe(1);
  });

  it("terminates poison receipts without starving later valid receipts", async () => {
    const poisonId = randomUUID().replaceAll("-", "");
    const validId = randomUUID().replaceAll("-", "");
    await inbox.enqueue(input(archiveId, accountId, poisonId));
    await inbox.enqueue({
      ...input(archiveId, accountId, validId),
      payload: {
        Chat: "15550000001@s.whatsapp.net",
        ID: `synthetic-after-poison-${validId}`,
        SenderJID: "15550000001@s.whatsapp.net",
        Timestamp: "2026-01-01T00:00:00.000Z",
        FromMe: false,
        Text: "after poison",
      },
    });
    const first = await normalizer.claimPending({
      limit: 1,
      archiveId,
      workerId: "worker-a",
      now: new Date("2026-01-01T00:01:00.000Z"),
      claimExpiresAt: new Date("2026-01-01T00:02:00.000Z"),
    });
    expect(first[0]?.receiptId).toBe(poisonId);
    await expect(normalizer.normalize(first[0]!)).rejects.toMatchObject({ retryable: false });
    await normalizer.failClaim({
      ...first[0]!,
      retryable: false,
      errorClass: "invalid-payload",
      now: new Date("2026-01-01T00:01:00.000Z"),
    });
    const next = await normalizer.claimPending({
      limit: 1,
      archiveId,
      workerId: "worker-a",
      now: new Date("2026-01-01T00:01:00.000Z"),
      claimExpiresAt: new Date("2026-01-01T00:02:00.000Z"),
    });
    expect(next[0]?.receiptId).toBe(validId);
  });

  it("retries transient claims, recovers a stale claim, and serializes concurrent claims", async () => {
    const receiptId = randomUUID().replaceAll("-", "");
    await inbox.enqueue(input(archiveId, accountId, receiptId));
    const now = new Date("2026-02-01T00:00:00.000Z");
    const [left, right] = await Promise.all([
      normalizer.claimPending({
        archiveId,
        limit: 1,
        workerId: "left",
        now,
        claimExpiresAt: new Date("2026-02-01T00:01:00.000Z"),
      }),
      normalizer.claimPending({
        archiveId,
        limit: 1,
        workerId: "right",
        now,
        claimExpiresAt: new Date("2026-02-01T00:01:00.000Z"),
      }),
    ]);
    const claimed = [...left, ...right];
    expect(claimed).toHaveLength(1);
    const stale = await normalizer.claimPending({
      archiveId,
      limit: 1,
      workerId: "restart",
      now: new Date("2026-02-01T00:02:00.000Z"),
      claimExpiresAt: new Date("2026-02-01T00:03:00.000Z"),
    });
    expect(stale).toHaveLength(1);
    await normalizer.failClaim({
      ...stale[0]!,
      retryable: true,
      errorClass: "database-unavailable",
      now,
    });
    const retried = await normalizer.claimPending({
      archiveId,
      limit: 1,
      workerId: "restart",
      now,
      claimExpiresAt: new Date("2026-02-01T00:01:00.000Z"),
    });
    expect(retried).toHaveLength(1);
    await normalizer.failClaim({
      ...retried[0]!,
      retryable: false,
      errorClass: "invalid-payload",
      now,
    });
    expect(
      await prisma.liveEventInbox.findUnique({
        where: {
          archiveId_ownedAccountId_receiptId: { archiveId, ownedAccountId: accountId, receiptId },
        },
      }),
    ).toMatchObject({ status: "failed", attempts: 2, retryable: false });
  });
});
