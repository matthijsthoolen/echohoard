import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  PrismaLiveEventInboxPersistence,
  PrismaLiveEventNormalizer,
  PrismaLiveEventAccountResolver,
} from "../../src/infrastructure/db/prisma-persistence.js";
import {
  parseWacliWebhookEvent,
  type WacliWebhookEvent,
} from "../../src/adapters/wacli/contract.js";
import { normalizeWacliEvent } from "../../src/adapters/wacli/normalize.js";
import { normalizeWhatsAppMessages } from "../../src/adapters/whatsapp/messages.js";
import { buildWhatsAppSqliteFixture } from "../../src/adapters/whatsapp/fixtures.js";
import { whatsappMessageKey } from "../../src/adapters/whatsapp/identity.js";
import { PrismaTextSnapshotImporter } from "../../src/infrastructure/db/text-import.js";
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
  (event, accountScope) => normalizeWacliEvent(asWacliEvent(event), accountScope),
);
const importer = new PrismaTextSnapshotImporter(prisma);
const userId = randomUUID();
const archiveId = randomUUID();
const otherArchiveId = randomUUID();
const accountId = randomUUID();
const sameArchiveOtherAccountId = randomUUID();
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
        {
          id: sameArchiveOtherAccountId,
          archiveId,
          accountKey: `account-${sameArchiveOtherAccountId}`,
          liveEnabled: true,
        },
        { id: otherAccountId, archiveId: otherArchiveId, accountKey: `account-${otherAccountId}` },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.liveEventInbox.deleteMany({ where: { archiveId } });
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
    const archiveReceiptId = randomUUID().replaceAll("-", "");
    const receiptId = randomUUID().replaceAll("-", "");
    expect((await inbox.enqueue(input(archiveId, accountId, archiveReceiptId))).kind).toBe(
      "accepted",
    );
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
      new PrismaLiveEventAccountResolver(prisma, archiveId, secret),
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
    const request = () =>
      new Request(`http://web:3000/api/internal/live-events?account=${accountKey}`, {
        method: "POST",
        headers: {
          "x-echohoard-timestamp": String(timestamp),
          "x-echohoard-signature": signLiveEvent(body, timestamp, secret, accountKey),
        },
        body,
      });
    const response = await route(request());
    const retry = await route(request());
    expect(response.status).toBe(202);
    expect(retry.status).toBe(202);
    const accepted = (await response.json()) as {
      readonly receiptId: string;
      readonly status: string;
    };
    const duplicate = (await retry.json()) as {
      readonly receiptId: string;
      readonly status: string;
    };
    expect(accepted.status).toBe("accepted");
    expect(duplicate).toEqual({ status: "duplicate", receiptId: accepted.receiptId });
    const receipt = await prisma.liveEventInbox.findFirstOrThrow({
      where: {
        archiveId,
        ownedAccountId: accountId,
        sourceEventKey: { startsWith: `wacli:message:${accountKey}:` },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(receipt.receiptId).toBe(accepted.receiptId);
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

  it("rejects a valid account-A signature when the route assigns the event to account B", async () => {
    const accountAKey = `account-${accountId}`;
    const accountBKey = `account-${sameArchiveOtherAccountId}`;
    const secret = "synthetic-webhook-secret";
    const event = {
      Chat: "15550000001@s.whatsapp.net",
      ID: `synthetic-cross-account-${randomUUID()}`,
      SenderJID: "15550000001@s.whatsapp.net",
      Timestamp: "2026-01-01T00:00:00.000Z",
      FromMe: false,
      Text: "must not be reassigned",
    };
    const body = new TextEncoder().encode(JSON.stringify(event));
    const timestamp = Math.floor(Date.now() / 1000);
    const intake = new LiveEventIntakeService(
      new PrismaLiveEventAccountResolver(prisma, archiveId, secret),
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
      new Request(`http://web:3000/api/internal/live-events?account=${accountBKey}`, {
        method: "POST",
        headers: {
          "x-echohoard-timestamp": String(timestamp),
          "x-echohoard-signature": signLiveEvent(body, timestamp, secret, accountAKey),
        },
        body,
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_signature" });
    expect(await prisma.liveEventInbox.count({ where: { archiveId } })).toBe(0);
  });

  it("terminates poison receipts without starving later valid receipts", async () => {
    const poisonId = randomUUID().replaceAll("-", "");
    const validId = randomUUID().replaceAll("-", "");
    await inbox.enqueue({
      ...input(archiveId, accountId, poisonId),
      receivedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await inbox.enqueue({
      ...input(archiveId, accountId, validId),
      receivedAt: new Date("2026-01-01T00:00:01.000Z"),
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

  it.each(["live-first", "backup-first"] as const)(
    "converges an edited message when %s",
    async (order) => {
      const messageKey = `functional-shared-edit-${order}-${randomUUID()}`;
      const chatKey = "15550000001@s.whatsapp.net";
      const event = {
        Chat: chatKey,
        ID: messageKey,
        SenderJID: chatKey,
        Timestamp: "2026-01-01T00:00:00.000Z",
        FromMe: false,
        Text: "edited text",
        Edited: true,
      };
      const receiptId = randomUUID().replaceAll("-", "");
      const applyLive = async () => {
        await inbox.enqueue({
          ...input(archiveId, accountId, receiptId),
          sourceEventKey: `wacli:message:${accountId}:${chatKey}:${messageKey}`,
          payload: event,
        });
        await normalizer.normalize({ archiveId, ownedAccountId: accountId, receiptId });
        expect(await prisma.revisionObservation.count({ where: { archiveId } })).toBeGreaterThan(0);
      };
      const applyBackup = async () => {
        const sourceId = randomUUID();
        const snapshotId = randomUUID();
        const importJobId = randomUUID();
        const sourceSha = randomUUID().replaceAll("-", "").padEnd(64, "0");
        await prisma.source.create({
          data: {
            id: sourceId,
            archiveId,
            ownedAccountId: accountId,
            kind: "backup",
            stableKey: `functional-backup-${importJobId}`,
            sha256: sourceSha,
          },
        });
        await prisma.snapshot.create({
          data: {
            id: snapshotId,
            archiveId,
            ownedAccountId: accountId,
            sourceId,
            sha256: sourceSha,
            lifecycle: "snapshotted",
          },
        });
        await prisma.importJob.create({
          data: {
            id: importJobId,
            archiveId,
            ownedAccountId: accountId,
            sourceId,
            snapshotId,
            status: "adapting",
          },
        });
        const fixture = buildWhatsAppSqliteFixture("android-legacy.v1");
        const records = normalizeWhatsAppMessages(
          {
            ...fixture,
            rows: {
              ...fixture.rows,
              messages: [
                {
                  _id: 101,
                  key_remote_jid: chatKey,
                  key_from_me: false,
                  timestamp: Date.parse(event.Timestamp),
                  media_wa_type: 0,
                  data: "original text",
                  key_id: messageKey,
                },
              ],
              message_edits: [
                {
                  message_id: 101,
                  edit_version: 1,
                  data: "edited text",
                  timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
                },
              ],
            },
          },
          { accountScope: accountId, snapshotId },
        );
        expect(records.filter((record) => record.kind === "revision")).toHaveLength(1);
        const backupRevision = records.find((record) => record.kind === "revision");
        const backupMessage = records.find((record) => record.kind === "message");
        expect(backupRevision && backupMessage && backupRevision.messageKey).toBe(
          backupMessage?.stableKey,
        );
        await importer.import({
          archiveId,
          ownedAccountId: accountId,
          snapshotId,
          importJobId,
          observedAt: new Date("2026-01-01T00:00:02.000Z"),
          records,
        });
        expect(await prisma.revisionObservation.count({ where: { archiveId } })).toBeGreaterThan(0);
      };

      if (order === "live-first") {
        await applyLive();
        await applyBackup();
      } else {
        await applyBackup();
        await applyLive();
      }

      const stableKey = whatsappMessageKey(accountId, chatKey, messageKey);
      expect(await prisma.message.count({ where: { archiveId, stableKey } })).toBe(1);
      const message = await prisma.message.findFirstOrThrow({ where: { archiveId, stableKey } });
      expect(
        await prisma.messageRevision.count({ where: { archiveId, messageId: message.id } }),
      ).toBe(1);
      const revision = await prisma.messageRevision.findFirstOrThrow({
        where: { archiveId, messageId: message.id },
      });
      const observations = await prisma.revisionObservation.findMany({
        where: { archiveId, revisionId: revision.id },
        select: { importJobId: true, sourceConversationId: true, observationKey: true },
      });
      expect(observations.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each([
    ["revoke", "Revoked"],
    ["delete", "delete_for_me"],
  ] as const)(
    "preserves %s deletion observations across reordered delivery, replay, and accounts",
    async (deletionKind, eventKind) => {
      const chatKey = "15550000001@s.whatsapp.net";
      const messageKey = `functional-deletion-${deletionKind}-${randomUUID()}`;
      const original = {
        Chat: chatKey,
        ID: messageKey,
        SenderJID: chatKey,
        Timestamp: "2026-01-01T00:00:01.000Z",
        FromMe: false,
        Text: `retained ${deletionKind} content`,
      };
      const deletion =
        eventKind === "Revoked"
          ? { ...original, Timestamp: "2026-01-01T00:00:02.000Z", Revoked: true }
          : {
              EventType: "delete_for_me",
              ChatJID: chatKey,
              MessageID: messageKey,
              SenderJID: chatKey,
              Timestamp: "2026-01-01T00:00:02.000Z",
              IsFromMe: false,
            };

      const apply = async (ownedAccountId: string, payload: Record<string, unknown>) => {
        const receiptId = randomUUID().replaceAll("-", "");
        await inbox.enqueue({
          ...input(archiveId, ownedAccountId, receiptId),
          sourceEventKey: `wacli:test:${ownedAccountId}:${messageKey}:${receiptId}`,
          payload,
        });
        await expect(
          normalizer.normalize({ archiveId, ownedAccountId, receiptId }),
        ).resolves.toMatchObject({ status: "normalized" });
        return receiptId;
      };

      const accountADeletionReceipt = await apply(accountId, deletion);
      await apply(accountId, original);
      const replay = await inbox.enqueue({
        ...input(archiveId, accountId, accountADeletionReceipt),
        sourceEventKey: `wacli:test:${accountId}:${messageKey}:replay`,
        payload: deletion,
      });
      expect(replay.kind).toBe("duplicate");

      await apply(sameArchiveOtherAccountId, original);
      await apply(sameArchiveOtherAccountId, deletion);

      const stableKeys = [accountId, sameArchiveOtherAccountId].map((ownedAccountId) =>
        whatsappMessageKey(ownedAccountId, chatKey, messageKey),
      );
      const messages = await prisma.message.findMany({
        where: { archiveId, stableKey: { in: stableKeys } },
        orderBy: { stableKey: "asc" },
      });
      expect(messages).toHaveLength(2);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceDeleted: true,
            contentUnavailable: false,
            body: original.Text,
            sourceDeletionMetadata: expect.objectContaining({ kind: deletionKind }),
          }),
        ]),
      );
      expect(
        await prisma.messageObservation.count({
          where: { archiveId, messageId: { in: messages.map((message) => message.id) } },
        }),
      ).toBe(4);
      expect(
        await prisma.message.count({ where: { archiveId, stableKey: { in: stableKeys } } }),
      ).toBe(2);
    },
  );

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
    ).toMatchObject({ status: "failed", attempts: 3, retryable: false });
  });
});
