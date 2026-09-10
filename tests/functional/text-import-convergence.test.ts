import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaTextSnapshotImporter } from "../../src/infrastructure/db/text-import.js";
import type { ImportRecord } from "../../src/application/text-import.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const importer = new PrismaTextSnapshotImporter(prisma);
const observedAt = new Date("2026-02-01T00:00:00.000Z");
const conversationKey = "wa:conversation:synthetic-chat";
const personKey = "wa:person:fallback-alice";
const identityKey = "wa:identity:fallback-alice";

type SnapshotName = "a" | "b" | "c";
const orders: readonly SnapshotName[][] = [
  ["a", "b", "c"],
  ["a", "c", "b"],
  ["b", "a", "c"],
  ["b", "c", "a"],
  ["c", "a", "b"],
  ["c", "b", "a"],
];

function recordsFor(snapshot: SnapshotName): readonly ImportRecord[] {
  const common: ImportRecord[] = [
    { kind: "person", stableKey: personKey, displayName: "Fallback Alice" },
    {
      kind: "identity",
      stableKey: identityKey,
      personKey,
      source: { namespace: "whatsapp-android", value: "fallback:alice" },
      displayName: "Fallback Alice",
    },
    { kind: "conversation", stableKey: conversationKey, conversationKind: "direct", title: "Chat" },
    { kind: "participant", conversationKey, identityKey, role: "member" },
    {
      kind: "message",
      stableKey: "wa:message:stable-shared",
      source: { namespace: "whatsapp-android", value: "source-shared" },
      conversationKey,
      senderIdentityKey: identityKey,
      timestamp: "2026-01-01T00:00:00.000Z",
      direction: "received",
      messageKind: "text",
      body: "shared message",
      bodyState: "present",
    },
    {
      kind: "revision",
      stableKey: "wa:revision:stable-shared:1",
      messageKey: "wa:message:stable-shared",
      revisionOrdinal: 1,
      body: "shared message (edited)",
      bodyState: "present",
      firstSeenSnapshotId: "logical-edit-observation",
    },
    {
      kind: "message",
      stableKey: "wa:message:fallback",
      source: { namespace: "whatsapp-android", value: "fallback-fingerprint:v1" },
      conversationKey,
      senderIdentityKey: identityKey,
      timestamp: null,
      direction: "unknown",
      messageKind: "text",
      body: "fallback identity message",
      bodyState: "present",
    },
    {
      kind: "message",
      stableKey: "wa:message:unknown-type",
      source: { namespace: "whatsapp-android", value: "source-unknown" },
      conversationKey,
      senderIdentityKey: identityKey,
      timestamp: "2026-01-03T00:00:00.000Z",
      direction: "received",
      messageKind: "unsupported",
      bodyState: "missing",
      unsupportedTypeCode: 999,
    },
  ];
  if (snapshot === "a") {
    common.push({
      kind: "message",
      stableKey: "wa:message:omitted-later",
      source: { namespace: "whatsapp-android", value: "source-omitted-later" },
      conversationKey,
      senderIdentityKey: identityKey,
      timestamp: "2026-01-02T00:00:00.000Z",
      direction: "received",
      messageKind: "text",
      body: "must remain visible",
      bodyState: "present",
    });
  }
  return common;
}

async function createArchive() {
  const userId = randomUUID();
  const archiveId = randomUUID();
  await prisma.user.create({ data: { id: userId } });
  await prisma.archive.create({ data: { id: archiveId, userId, name: archiveId } });
  const snapshots = new Map<SnapshotName, { id: string; jobId: string }>();
  for (const name of ["a", "b", "c"] as const) {
    const sourceId = randomUUID();
    const snapshotId = randomUUID();
    const jobId = randomUUID();
    await prisma.source.create({
      data: { id: sourceId, archiveId, kind: "whatsapp", stableKey: name, sha256: name.repeat(64) },
    });
    await prisma.snapshot.create({
      data: { id: snapshotId, archiveId, sourceId, sha256: name.repeat(64) },
    });
    await prisma.importJob.create({
      data: { id: jobId, archiveId, sourceId, snapshotId, status: "queued" },
    });
    snapshots.set(name, { id: snapshotId, jobId });
  }
  return { userId, archiveId, snapshots };
}

async function normalizedState(archiveId: string) {
  const [people, identities, conversations, participants, messages, revisions] = await Promise.all([
    prisma.person.findMany({ where: { archiveId }, orderBy: { id: "asc" } }),
    prisma.identity.findMany({ where: { archiveId }, orderBy: { value: "asc" } }),
    prisma.conversation.findMany({ where: { archiveId }, orderBy: { stableKey: "asc" } }),
    prisma.conversationParticipant.findMany({
      where: { archiveId },
      include: { conversation: true, person: true },
    }),
    prisma.message.findMany({
      where: { archiveId },
      include: { conversation: true, sender: true, replyTo: true },
      orderBy: { stableKey: "asc" },
    }),
    prisma.messageRevision.findMany({
      where: { archiveId },
      include: { message: true },
      orderBy: { revisionKey: "asc" },
    }),
  ]);
  const chronology = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const copy = { ...(value as Record<string, unknown>) };
    delete copy.firstSeenSnapshotId;
    delete copy.lastSeenSnapshotId;
    return copy;
  };
  return {
    people: people.map(
      ({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, archiveId: _archiveId, ...p }) => p,
    ),
    identities: identities.map(
      ({
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        archiveId: _archiveId,
        personId: _personId,
        provenance: _provenance,
        ...i
      }) => ({ ...i, person: _personId ? "linked" : "unlinked" }),
    ),
    conversations: conversations.map(
      ({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, archiveId: _archiveId, ...c }) => c,
    ),
    participants: participants.map((p) => ({
      conversation: p.conversation.stableKey,
      person: p.person.displayName,
      role: p.role,
    })),
    messages: messages.map((m) => ({
      stableKey: m.stableKey,
      conversation: m.conversation.stableKey,
      sender: m.sender?.displayName,
      sourceKey: m.sourceKey,
      messageType: m.messageType,
      body: m.body,
      metadata: chronology(m.metadata),
      replyTo: m.replyTo?.stableKey,
    })),
    revisions: revisions.map((r) => ({
      revisionKey: r.revisionKey,
      message: r.message.stableKey,
      body: r.body,
      metadata: chronology(r.metadata),
    })),
  };
}

describe("text snapshot idempotency and order convergence", () => {
  beforeAll(async () => prisma.$connect());
  afterAll(async () => prisma.$disconnect());

  it("converges every A/B/C permutation and repeated import", async () => {
    let expected: Awaited<ReturnType<typeof normalizedState>> | undefined;
    for (const order of orders) {
      const archive = await createArchive();
      for (const name of order) {
        const snapshot = archive.snapshots.get(name)!;
        const input = {
          archiveId: archive.archiveId,
          snapshotId: snapshot.id,
          importJobId: snapshot.jobId,
          observedAt,
          records: [...recordsFor(name)].reverse(),
        };
        await importer.import(input);
        await importer.import(input);
      }
      const state = await normalizedState(archive.archiveId);
      if (!expected) expected = state;
      expect(state).toEqual(expected);
      const firstSnapshotId = archive.snapshots.get(order[0])!.id;
      const lastSnapshotId = archive.snapshots.get(order[2])!.id;
      const identity = await prisma.identity.findFirstOrThrow({
        where: { archiveId: archive.archiveId },
      });
      expect(identity.provenance).toMatchObject({
        firstSeenSnapshotId: firstSnapshotId,
        lastSeenSnapshotId: lastSnapshotId,
      });
      const shared = await prisma.message.findUniqueOrThrow({
        where: {
          archiveId_stableKey: {
            archiveId: archive.archiveId,
            stableKey: "wa:message:stable-shared",
          },
        },
      });
      expect(shared.metadata).toMatchObject({
        firstSeenSnapshotId: firstSnapshotId,
        lastSeenSnapshotId: lastSnapshotId,
      });
      expect(state.messages.map((message) => message.stableKey)).toContain(
        "wa:message:omitted-later",
      );
      const message = state.messages.find(
        (candidate) => candidate.stableKey === "wa:message:unknown-type",
      );
      expect(message?.messageType).toBe("unsupported");
      expect((message?.metadata as { unsupportedTypeCode?: number }).unsupportedTypeCode).toBe(999);
      expect(state.revisions).toHaveLength(1);
      await prisma.user.delete({ where: { id: archive.userId } });
    }
  });
});
