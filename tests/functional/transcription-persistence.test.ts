import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: url });
const [userId, archiveId, otherArchiveId, attachmentId, transcriptId, requestId, runId] =
  Array.from({ length: 7 }, () => randomUUID());
const digest = "c".repeat(64);

describe("transcript persistence constraints", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.createMany({
      data: [
        { id: archiveId, userId, name: "transcript-one" },
        { id: otherArchiveId, userId, name: "transcript-two" },
      ],
    });
    await prisma.attachment.create({ data: { id: attachmentId, archiveId, sha256: digest } });
    await prisma.transcript.create({
      data: {
        id: transcriptId,
        archiveId,
        attachmentId,
        sourceMediaSha256: digest,
        currentMediaSha256: digest,
        updatedAt: new Date(),
      },
    });
    await prisma.transcriptionRequest.create({
      data: { id: requestId, archiveId, transcriptId, selectedModel: "synthetic/model" },
    });
    await prisma.transcriptionRun.create({
      data: {
        id: runId,
        archiveId,
        transcriptId,
        requestId,
        mediaSha256: digest,
        selectedModel: "synthetic/model",
        updatedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("keeps version history, permits one active version, and rejects cross-archive links", async () => {
    await prisma.transcriptVersion.create({
      data: {
        archiveId,
        transcriptId,
        runId,
        mediaSha256: digest,
        text: "machine transcript",
        isActive: true,
      },
    });
    await expect(
      prisma.transcriptVersion.create({
        data: {
          archiveId,
          transcriptId,
          runId,
          mediaSha256: digest,
          text: "second active transcript",
          isActive: true,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.transcriptionRequest.create({
        data: {
          archiveId: otherArchiveId,
          transcriptId,
          selectedModel: "synthetic/model",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.transcriptVersion.count({ where: { archiveId, transcriptId } }),
    ).resolves.toBe(1);
  });
});
