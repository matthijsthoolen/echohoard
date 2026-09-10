import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchivePrincipal } from "../../src/application/auth.js";
import type { ImportRecord, ImportAttachmentRecord } from "../../src/application/text-import.js";
import { normalizeWhatsAppIdentitiesAndConversations } from "../../src/adapters/whatsapp/normalize.js";
import { normalizeWhatsAppMessages } from "../../src/adapters/whatsapp/messages.js";
import { buildWhatsAppSqliteFixture } from "../../src/adapters/whatsapp/fixtures.js";
import { createMediaRoute } from "../../src/delivery/web/app/api/media/[attachmentId]/route-handler.js";
import { PrismaMediaDelivery } from "../../src/infrastructure/db/media-delivery.js";
import { PrismaTextSnapshotImporter } from "../../src/infrastructure/db/text-import.js";
import { LocalMediaCasStore } from "../../src/infrastructure/files/media-cas.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const importer = new PrismaTextSnapshotImporter(prisma);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

const safeSamples = {
  image: {
    name: "photo.png",
    mimeType: "image/png",
    bytes: Buffer.from("synthetic-png-sample"),
  },
  video: {
    name: "clip.mp4",
    mimeType: "video/mp4",
    bytes: Buffer.from("synthetic-mp4-sample"),
  },
  audio: {
    name: "voice.wav",
    mimeType: "audio/wav",
    bytes: Buffer.from("synthetic-wav-sample"),
  },
  document: {
    name: "notes.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from("synthetic-pdf-sample"),
  },
  sticker: {
    name: "sticker.webp",
    mimeType: "image/webp",
    // Deliberately duplicate the image bytes to prove CAS deduplication does
    // not collapse either message link.
    bytes: Buffer.from("synthetic-png-sample"),
  },
} as const;

const archiveId = randomUUID();
const principal: ArchivePrincipal = {
  userId: "synthetic-user",
  archiveId,
  issuer: "https://issuer.synthetic",
  subject: "owner",
};

describe("composed rich-message and media acceptance", () => {
  const userId = randomUUID();
  const sourceId = randomUUID();
  const firstSnapshotId = randomUUID();
  const secondSnapshotId = randomUUID();
  const firstJobId = randomUUID();
  const secondJobId = randomUUID();
  let casRoot: string;
  let workRoot: string;

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.create({ data: { id: archiveId, userId, name: "Synthetic rich media" } });
    await prisma.source.create({
      data: {
        id: sourceId,
        archiveId,
        kind: "whatsapp",
        stableKey: "synthetic-android",
        sha256: "a".repeat(64),
      },
    });
    await prisma.snapshot.createMany({
      data: [
        { id: firstSnapshotId, archiveId, sourceId, sha256: "b".repeat(64) },
        { id: secondSnapshotId, archiveId, sourceId, sha256: "c".repeat(64) },
      ],
    });
    await prisma.importJob.createMany({
      data: [
        { id: firstJobId, archiveId, sourceId, snapshotId: firstSnapshotId, status: "queued" },
        { id: secondJobId, archiveId, sourceId, snapshotId: secondSnapshotId, status: "queued" },
      ],
    });
    workRoot = await mkdtemp(join(tmpdir(), "echohoard-rich-media-functional-"));
    casRoot = join(workRoot, "cas");
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });

  it("imports every rich type, preserves relationships, and reconciles later duplicate bytes", async () => {
    const fixture = buildWhatsAppSqliteFixture("android-current.v1");
    const initialRecords = importRecords(fixture, firstSnapshotId);
    const messageRecords = initialRecords.filter(
      (record): record is Extract<ImportRecord, { kind: "message" }> => record.kind === "message",
    );
    const richMessages = messageRecords.filter((record) =>
      [
        "image",
        "video",
        "audio",
        "document",
        "location",
        "contact",
        "sticker",
        "reaction",
        "system",
      ].includes(record.messageKind),
    );
    const byType = new Map(richMessages.map((record) => [record.messageKind, record]));
    expect([...byType.keys()].sort()).toEqual([
      "audio",
      "contact",
      "document",
      "image",
      "location",
      "reaction",
      "sticker",
      "system",
      "video",
    ]);
    // Insert the duplicate reference first so the canonical metadata remains
    // the image's safe playable name while both links share one CAS object.
    const attachmentMessages = ["sticker", "image", "video", "audio", "document"] as const;
    const missingAttachments = attachmentMessages.map((kind) =>
      attachmentRecord(byType.get(kind)!, kind, "missing"),
    );
    const unsafe = attachmentRecord(byType.get("document")!, "unsafe-path", "unsafe");
    await importer.import({
      archiveId,
      snapshotId: firstSnapshotId,
      importJobId: firstJobId,
      observedAt: new Date("2026-01-01T00:00:00.000Z"),
      records: [...initialRecords, ...missingAttachments, unsafe],
    });

    const files = new Map<string, string>();
    const cas = new LocalMediaCasStore(casRoot);
    for (const kind of ["image", "video", "audio", "sticker"] as const) {
      const sample = safeSamples[kind];
      const sourcePath = join(workRoot, sample.name);
      await writeFile(sourcePath, sample.bytes);
      const stored = await cas.store(sourcePath, hash(sample.bytes));
      files.set(kind, stored.sha256);
      expect(stored.duplicate).toBe(kind === "sticker");
      await expect(readFile(stored.path)).resolves.toEqual(sample.bytes);
    }
    const hostileSamples = [
      {
        name: "payload.html",
        mimeType: "text/html",
        bytes: Buffer.from("<script>hostile()</script>"),
      },
      { name: "spoofed.html", mimeType: "image/png", bytes: Buffer.from("not-a-png") },
    ] as const;
    const hostileCas = new Map<string, { readonly sha256: string; readonly size: number }>();
    for (const sample of hostileSamples) {
      const sourcePath = join(workRoot, sample.name);
      await writeFile(sourcePath, sample.bytes);
      const stored = await cas.store(sourcePath, hash(sample.bytes));
      hostileCas.set(sample.name, { sha256: stored.sha256, size: stored.size });
    }
    const textMessage = messageRecords.find((record) => record.messageKind === "text")!;
    const laterAttachments = ["sticker", "image", "video", "audio"] as const;
    await importer.import({
      archiveId,
      snapshotId: secondSnapshotId,
      importJobId: secondJobId,
      observedAt: new Date("2026-01-02T00:00:00.000Z"),
      records: [
        ...initialRecords,
        ...laterAttachments.map((kind) => ({
          ...attachmentRecord(byType.get(kind)!, kind, "available"),
          casKey: files.get(kind),
          byteSize: safeSamples[kind].bytes.length,
        })),
        {
          kind: "attachment",
          stableKey: "media:hostile-html",
          messageKey: textMessage.stableKey,
          sha256: hostileCas.get("payload.html")!.sha256,
          casKey: hostileCas.get("payload.html")!.sha256,
          byteSize: hostileCas.get("payload.html")!.size,
          availability: "available" as const,
          originalName: "payload.html",
          originalPath: "media/payload.html",
          mimeType: "text/html",
        },
        {
          kind: "attachment",
          stableKey: "media:spoofed-html",
          messageKey: textMessage.stableKey,
          sha256: hostileCas.get("spoofed.html")!.sha256,
          casKey: hostileCas.get("spoofed.html")!.sha256,
          byteSize: hostileCas.get("spoofed.html")!.size,
          availability: "available" as const,
          originalName: "spoofed.html",
          originalPath: "media/spoofed.html",
          mimeType: "image/png",
        },
      ],
    });

    const messages = await prisma.message.findMany({
      where: { archiveId },
      select: {
        messageType: true,
        metadata: true,
        sourceKey: true,
        _count: { select: { attachments: true } },
      },
    });
    expect(new Set(messages.map((message) => message.messageType))).toEqual(
      new Set([
        "text",
        "image",
        "video",
        "audio",
        "document",
        "location",
        "contact",
        "sticker",
        "reaction",
        "system",
        "unsupported",
      ]),
    );
    const reaction = messages.find((message) => message.messageType === "reaction");
    expect(reaction?.metadata).toMatchObject({
      reactionEmoji: "👍",
      reactsToKey: expect.any(String),
    });
    expect(messages.find((message) => message.messageType === "location")?.metadata).toMatchObject({
      latitude: 52.09,
      longitude: 5.12,
    });
    expect(messages.find((message) => message.messageType === "contact")?.metadata).toMatchObject({
      contactName: "Example Beta",
    });
    expect(messages.filter((message) => message._count.attachments > 0)).toHaveLength(6);

    const attachments = await prisma.attachment.findMany({
      where: { archiveId },
      select: {
        id: true,
        stableKey: true,
        availability: true,
        sha256: true,
        casKey: true,
        originalPath: true,
      },
    });
    expect(attachments).toHaveLength(7);
    expect(
      attachments.filter((attachment) => attachment.availability === "available"),
    ).toHaveLength(5);
    expect(new Set(attachments.map((attachment) => attachment.sha256)).size).toBe(7);
    const sharedImage = attachments.find(
      (attachment) => attachment.sha256 === hash(safeSamples.image.bytes),
    );
    expect(sharedImage).toBeDefined();
    expect(
      await prisma.messageAttachment.count({
        where: { archiveId, attachmentId: sharedImage!.id },
      }),
    ).toBe(2);
    expect(
      attachments.find((attachment) => attachment.stableKey === "media:unsafe-path"),
    ).toMatchObject({
      availability: "unsafe",
      originalPath: "../../outside/payload.html",
      casKey: null,
    });
    expect(
      (await prisma.snapshot.findUniqueOrThrow({ where: { id: secondSnapshotId } })).lifecycle,
    ).toBe("completed");
    expect((await prisma.importJob.findUniqueOrThrow({ where: { id: secondJobId } })).status).toBe(
      "completed",
    );
  });

  it("delivers safe samples, ranges audio, and keeps hostile content inert", async () => {
    const delivery = new PrismaMediaDelivery(prisma, casRoot);
    const route = createMediaRoute({
      getRuntime: () => ({ auth: { principalForRequest: () => principal }, media: delivery }),
    });
    const image = await prisma.attachment.findFirstOrThrow({
      where: { archiveId, originalName: safeSamples.image.name },
      select: { id: true },
    });
    const audio = await prisma.attachment.findFirstOrThrow({
      where: { archiveId, originalName: safeSamples.audio.name },
      select: { id: true },
    });
    const missing = await prisma.attachment.findFirstOrThrow({
      where: { archiveId, originalName: safeSamples.document.name },
      select: { id: true },
    });
    const unsafe = await prisma.attachment.findFirstOrThrow({
      where: { archiveId, stableKey: "media:unsafe-path" },
      select: { id: true },
    });
    const hostileHtml = await prisma.attachment.findFirstOrThrow({
      where: { archiveId, originalName: "payload.html" },
      select: { id: true },
    });
    const spoofed = await prisma.attachment.findFirstOrThrow({
      where: { archiveId, originalName: "spoofed.html" },
      select: { id: true },
    });

    const imageResponse = await route(new Request("http://localhost/api/media/image"), {
      params: { attachmentId: image.id },
    });
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(imageResponse.headers.get("content-disposition")).toBe('inline; filename="photo.png"');
    expect(imageResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await imageResponse.arrayBuffer())).toEqual(safeSamples.image.bytes);

    const audioResponse = await route(
      new Request("http://localhost/api/media/audio", { headers: { Range: "bytes=1-4" } }),
      { params: Promise.resolve({ attachmentId: audio.id }) },
    );
    expect(audioResponse.status).toBe(206);
    expect(audioResponse.headers.get("content-range")).toBe(
      `bytes 1-4/${safeSamples.audio.bytes.length}`,
    );
    expect(Buffer.from(await audioResponse.arrayBuffer())).toEqual(
      safeSamples.audio.bytes.subarray(1, 5),
    );

    for (const attachment of [hostileHtml, spoofed]) {
      const response = await route(new Request("http://localhost/api/media/hostile"), {
        params: { attachmentId: attachment.id },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toMatch(/^attachment;/u);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }

    expect(
      (
        await route(new Request("http://localhost/api/media/missing"), {
          params: { attachmentId: missing.id },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await route(new Request("http://localhost/api/media/unsafe"), {
          params: { attachmentId: unsafe.id },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await route(new Request("http://localhost/api/media/traversal"), {
          params: { attachmentId: "../etc/passwd" },
        })
      ).status,
    ).toBe(404);
    const anonymousRoute = createMediaRoute({
      getRuntime: () => ({
        auth: { principalForRequest: () => null },
        media: delivery,
      }),
    });
    expect(
      (
        await anonymousRoute(new Request("http://localhost/api/media/anonymous"), {
          params: { attachmentId: image.id },
        })
      ).status,
    ).toBe(401);
  });
});

function importRecords(
  fixture: ReturnType<typeof buildWhatsAppSqliteFixture>,
  snapshotId: string,
): readonly ImportRecord[] {
  const structural = normalizeWhatsAppIdentitiesAndConversations(fixture).filter(
    (record): record is Exclude<ImportRecord, { kind: "message" | "revision" | "attachment" }> =>
      record.kind !== "message" && record.kind !== "revision",
  );
  const messages = normalizeWhatsAppMessages(fixture, { snapshotId }).map(
    (record): ImportRecord => {
      if (record.kind === "revision") return record;
      return {
        kind: "message",
        stableKey: record.stableKey,
        source: record.source,
        conversationKey: record.conversationKey,
        ...(record.senderIdentityKey ? { senderIdentityKey: record.senderIdentityKey } : {}),
        timestamp: record.timestamp,
        direction: record.direction,
        messageKind: record.messageKind,
        ...(record.body !== undefined ? { body: record.body } : {}),
        bodyState: record.bodyState,
        metadata: record.metadata,
        unsupportedTypeCode: record.unsupportedTypeCode,
      };
    },
  );
  return [...structural, ...messages];
}

function attachmentRecord(
  message: Extract<ImportRecord, { kind: "message" }>,
  kind: keyof typeof safeSamples | "unsafe-path",
  availability: ImportAttachmentRecord["availability"],
): ImportAttachmentRecord {
  const sample =
    kind === "unsafe-path"
      ? { ...safeSamples.document, bytes: Buffer.from("unsafe-path-sample") }
      : safeSamples[kind];
  return {
    kind: "attachment",
    stableKey: `media:${kind}`,
    messageKey: message.stableKey,
    sha256: hash(sample.bytes),
    availability,
    originalName: kind === "unsafe-path" ? "unsafe-path.html" : sample.name,
    originalPath: kind === "unsafe-path" ? "../../outside/payload.html" : `media/${sample.name}`,
    mimeType: kind === "unsafe-path" ? "text/html" : sample.mimeType,
  };
}
