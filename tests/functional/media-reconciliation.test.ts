import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportAttachmentRecord, ImportRecord } from "../../src/application/text-import.js";
import { PrismaTextSnapshotImporter } from "../../src/infrastructure/db/text-import.js";
import { LocalMediaCasStore } from "../../src/infrastructure/files/media-cas.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const importer = new PrismaTextSnapshotImporter(prisma);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("PostgreSQL media availability reconciliation", () => {
  beforeAll(async () => prisma.$connect());
  afterAll(async () => prisma.$disconnect());

  it("reconciles missing bytes, preserves duplicate links, and is idempotent", async () => {
    const userId = randomUUID();
    const archiveId = randomUUID();
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.create({ data: { id: archiveId, userId, name: archiveId } });
    const conversationId = randomUUID();
    const messageIds = [randomUUID(), randomUUID()];
    await prisma.conversation.create({
      data: { id: conversationId, archiveId, kind: "direct", stableKey: "media-chat" },
    });
    for (const [index, id] of messageIds.entries())
      await prisma.message.create({
        data: {
          id,
          archiveId,
          conversationId,
          stableKey: `message-${index}`,
          messageType: "image",
        },
      });
    const sourceId = randomUUID();
    const firstSnapshotId = randomUUID();
    const secondSnapshotId = randomUUID();
    const firstJobId = randomUUID();
    const secondJobId = randomUUID();
    await prisma.source.create({
      data: {
        id: sourceId,
        archiveId,
        kind: "whatsapp",
        stableKey: "android",
        sha256: "a".repeat(64),
      },
    });
    for (const [snapshotId, jobId, sha256] of [
      [firstSnapshotId, firstJobId, "b".repeat(64)],
      [secondSnapshotId, secondJobId, "c".repeat(64)],
    ] as const) {
      await prisma.snapshot.create({ data: { id: snapshotId, archiveId, sourceId, sha256 } });
      await prisma.importJob.create({
        data: { id: jobId, archiveId, sourceId, snapshotId, status: "queued" },
      });
    }

    const content = "same duplicate bytes";
    const sha256 = hash(content);
    const missing = (messageKey: string): ImportAttachmentRecord => ({
      kind: "attachment",
      stableKey: "media:stable-photo",
      messageKey,
      sha256,
      availability: "missing",
      originalName: "photo.jpg",
      mimeType: "image/jpeg",
    });
    const messages: readonly ImportRecord[] = messageIds.map((id, index) => ({
      kind: "message",
      stableKey: `message-${index}`,
      source: { namespace: "whatsapp-android", value: `source-${index}` },
      conversationKey: "media-chat",
      timestamp: null,
      direction: "received",
      messageKind: "image",
      bodyState: "missing",
    }));
    // The message rows are pre-seeded to isolate this test to attachment
    // reconciliation; importer records still use the same stable message key.
    await importer.import({
      archiveId,
      snapshotId: firstSnapshotId,
      importJobId: firstJobId,
      observedAt: new Date("2026-01-01T00:00:00.000Z"),
      records: [
        {
          kind: "conversation",
          stableKey: "media-chat",
          conversationKind: "direct",
          title: "Media",
        },
        ...messages,
        missing("message-0"),
        missing("message-1"),
        {
          ...missing("message-0"),
          stableKey: "media:unsafe",
          sha256: "e".repeat(64),
          availability: "unsafe",
        },
      ],
    });
    const root = await mkdtemp(join(tmpdir(), "echohoard-media-functional-"));
    const sourcePath = join(root, "photo.jpg");
    await writeFile(sourcePath, content);
    const cas = await new LocalMediaCasStore(join(root, "cas")).store(sourcePath, sha256);
    const available: ImportAttachmentRecord = {
      ...missing("message-0"),
      availability: "available",
      casKey: cas.sha256,
      byteSize: cas.size,
    };
    await importer.import({
      archiveId,
      snapshotId: secondSnapshotId,
      importJobId: secondJobId,
      observedAt: new Date("2026-01-02T00:00:00.000Z"),
      records: [
        {
          kind: "conversation",
          stableKey: "media-chat",
          conversationKind: "direct",
          title: "Media",
        },
        ...messages,
        available,
        { ...available, messageKey: "message-1" },
      ],
    });
    await importer.import({
      archiveId,
      snapshotId: secondSnapshotId,
      importJobId: secondJobId,
      observedAt: new Date("2026-01-02T00:00:00.000Z"),
      records: [
        {
          kind: "conversation",
          stableKey: "media-chat",
          conversationKind: "direct",
          title: "Media",
        },
        ...messages,
        available,
        { ...available, messageKey: "message-1" },
      ],
    });

    const attachment = await prisma.attachment.findUniqueOrThrow({
      where: { archiveId_sha256: { archiveId, sha256 } },
    });
    expect(attachment.availability).toBe("available");
    expect(attachment.casKey).toBe(sha256);
    expect(
      await prisma.messageAttachment.count({ where: { archiveId, attachmentId: attachment.id } }),
    ).toBe(2);
    expect(await prisma.attachment.count({ where: { archiveId } })).toBe(2);
    await expect(readFile(cas.path)).resolves.toEqual(Buffer.from(content));
    await prisma.user.delete({ where: { id: userId } });
  });

  it("keeps identical observations isolated by archive", async () => {
    const users = [randomUUID(), randomUUID()];
    const archives = [randomUUID(), randomUUID()];
    for (const [index, userId] of users.entries()) {
      await prisma.user.create({ data: { id: userId } });
      await prisma.archive.create({
        data: { id: archives[index]!, userId, name: archives[index]! },
      });
    }
    const sha256 = "d".repeat(64);
    for (const [index, archiveId] of archives.entries()) {
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const sourceId = randomUUID();
      const snapshotId = randomUUID();
      const jobId = randomUUID();
      await prisma.conversation.create({
        data: { id: conversationId, archiveId, kind: "direct", stableKey: "chat" },
      });
      await prisma.message.create({
        data: {
          id: messageId,
          archiveId,
          conversationId,
          stableKey: "message",
          messageType: "image",
        },
      });
      await prisma.source.create({
        data: {
          id: sourceId,
          archiveId,
          kind: "whatsapp",
          stableKey: "source",
          sha256: `${index}`.repeat(64),
        },
      });
      await prisma.snapshot.create({
        data: { id: snapshotId, archiveId, sourceId, sha256: `${index + 1}`.repeat(64) },
      });
      await prisma.importJob.create({
        data: { id: jobId, archiveId, sourceId, snapshotId, status: "queued" },
      });
      await importer.import({
        archiveId,
        snapshotId,
        importJobId: jobId,
        observedAt: new Date("2026-01-03T00:00:00.000Z"),
        records: [
          { kind: "conversation", stableKey: "chat", conversationKind: "direct" },
          {
            kind: "message",
            stableKey: "message",
            source: { namespace: "whatsapp-android", value: "message" },
            conversationKey: "chat",
            timestamp: null,
            direction: "unknown",
            messageKind: "image",
            bodyState: "missing",
          },
          {
            kind: "attachment",
            stableKey: "stable-media",
            messageKey: "message",
            sha256,
            availability: "missing",
          },
        ],
      });
    }
    expect(await prisma.attachment.count({ where: { sha256 } })).toBe(2);
    for (const userId of users) await prisma.user.delete({ where: { id: userId } });
  });
});
