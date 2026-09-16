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
});
