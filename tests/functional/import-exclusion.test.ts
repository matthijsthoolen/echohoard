import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApplyImportExclusionService,
  PlanImportExclusionService,
} from "../../src/application/import-exclusion.js";
import type { ImportRecord } from "../../src/application/text-import.js";
import { PrismaImportExclusionPersistence } from "../../src/infrastructure/db/import-exclusion.js";
import { PrismaTextSnapshotImporter } from "../../src/infrastructure/db/text-import.js";
import { createFixtureOwnedAccount } from "./owned-account-fixture.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const importer = new PrismaTextSnapshotImporter(prisma);
const dates = [
  "2026-01-01T00:00:00.000Z",
  "2026-01-02T00:00:00.000Z",
  "2026-01-03T00:00:00.000Z",
] as const;

type ArchiveFixture = {
  readonly userId: string;
  readonly archiveId: string;
  readonly jobs: readonly string[];
};

async function createArchive(): Promise<ArchiveFixture> {
  const userId = randomUUID();
  const archiveId = randomUUID();
  const accountId = randomUUID();
  await prisma.user.create({ data: { id: userId } });
  await prisma.archive.create({ data: { id: archiveId, userId, name: `exclusion-${archiveId}` } });
  await prisma.ownedAccount.create({
    data: { id: accountId, archiveId, accountKey: `account-${archiveId}` },
  });
  const jobs: string[] = [];
  for (const [index, name] of (["a", "b", "c"] as const).entries()) {
    const sourceId = randomUUID();
    const snapshotId = randomUUID();
    const jobId = randomUUID();
    await prisma.source.create({
      data: {
        id: sourceId,
        archiveId,
        ownedAccountId: accountId,
        kind: "backup",
        stableKey: `source-${name}`,
        sha256: name.repeat(64),
      },
    });
    await prisma.snapshot.create({
      data: {
        id: snapshotId,
        archiveId,
        ownedAccountId: accountId,
        sourceId,
        sha256: name.repeat(64),
      },
    });
    await prisma.importJob.create({
      data: {
        id: jobId,
        archiveId,
        ownedAccountId: accountId,
        sourceId,
        snapshotId,
        status: "queued",
      },
    });
    await importer.import({
      archiveId,
      snapshotId,
      importJobId: jobId,
      observedAt: new Date(dates[index]),
      records: recordsFor(name),
    });
    jobs.push(jobId);
  }
  return { userId, archiveId, jobs };
}

function recordsFor(name: "a" | "b" | "c"): readonly ImportRecord[] {
  return [
    {
      kind: "conversation",
      stableKey: "chat-1",
      conversationKind: "direct",
      title: "Synthetic chat",
    },
    {
      kind: "message",
      stableKey: "message-1",
      source: { namespace: "synthetic", value: "message-1" },
      conversationKey: "chat-1",
      timestamp: "2026-01-01T12:00:00.000Z",
      direction: "received",
      messageKind: "text",
      body: `${name}-body`,
      bodyState: "present",
    },
    {
      kind: "revision",
      stableKey: "revision-1",
      messageKey: "message-1",
      revisionOrdinal: 1,
      body: `${name}-revision`,
      bodyState: "present",
      firstSeenSnapshotId: `synthetic-${name}`,
    },
  ];
}

function request(
  archive: ArchiveFixture,
  jobId: string,
  action: "exclude" | "re-enable",
  key: string,
) {
  return {
    archiveId: archive.archiveId,
    importJobId: jobId,
    action,
    actor: "synthetic-owner",
    reason: `synthetic ${action}`,
    idempotencyKey: key,
  } as const;
}

async function state(archiveId: string) {
  const message = await prisma.message.findFirstOrThrow({
    where: { archiveId, stableKey: "message-1" },
    select: { body: true, materialized: true, messageType: true, sourceKey: true },
  });
  const revision = await prisma.messageRevision.findFirstOrThrow({
    where: { archiveId, revisionKey: "revision-1" },
    select: { body: true, materialized: true },
  });
  return { message, revision };
}

describe("import exclusion and deterministic rematerialization", () => {
  beforeAll(async () => prisma.$connect());
  afterAll(async () => prisma.$disconnect());

  it("plans without mutation, handles first/middle/last overlap, and re-enables", async () => {
    const archive = await createArchive();
    const persistence = new PrismaImportExclusionPersistence(prisma);
    const planner = new PlanImportExclusionService(persistence);
    const applier = new ApplyImportExclusionService(persistence);
    const before = await Promise.all([
      prisma.messageObservation.count({ where: { archiveId: archive.archiveId } }),
      prisma.source.count({ where: { archiveId: archive.archiveId } }),
      prisma.snapshot.count({ where: { archiveId: archive.archiveId } }),
      prisma.importEligibilityDecision.count({ where: { archiveId: archive.archiveId } }),
    ]);
    const planned = await planner.execute(
      request(archive, archive.jobs[0], "exclude", "plan-only"),
    );
    expect(planned.counts).toMatchObject({ messages: 1, revisions: 1, observations: 3 });
    expect(
      await Promise.all([
        prisma.messageObservation.count({ where: { archiveId: archive.archiveId } }),
        prisma.source.count({ where: { archiveId: archive.archiveId } }),
        prisma.snapshot.count({ where: { archiveId: archive.archiveId } }),
        prisma.importEligibilityDecision.count({ where: { archiveId: archive.archiveId } }),
      ]),
    ).toEqual(before);

    const initial = await state(archive.archiveId);
    expect(initial.message.body).toBe("c-body");
    expect(initial.revision.body).toBe("a-revision");
    await applier.execute(request(archive, archive.jobs[0], "exclude", "exclude-a"));
    expect((await state(archive.archiveId)).message.body).toBe("c-body");
    await applier.execute(request(archive, archive.jobs[1], "exclude", "exclude-b"));
    expect((await state(archive.archiveId)).message.body).toBe("c-body");
    await applier.execute(request(archive, archive.jobs[1], "re-enable", "enable-b-before-last"));
    await applier.execute(request(archive, archive.jobs[2], "exclude", "exclude-c"));
    expect(await state(archive.archiveId)).toEqual({
      message: { body: "b-body", materialized: true, messageType: "text", sourceKey: "message-1" },
      revision: { body: "b-revision", materialized: true },
    });
    expect(await prisma.messageObservation.count({ where: { archiveId: archive.archiveId } })).toBe(
      3,
    );

    await applier.execute(request(archive, archive.jobs[0], "re-enable", "enable-a"));
    await applier.execute(request(archive, archive.jobs[1], "re-enable", "enable-b"));
    await applier.execute(request(archive, archive.jobs[2], "re-enable", "enable-c"));
    expect(await state(archive.archiveId)).toEqual({
      message: { body: "c-body", materialized: true, messageType: "text", sourceKey: "message-1" },
      revision: { body: "c-revision", materialized: true },
    });
    await prisma.user.delete({ where: { id: archive.userId } });
  });

  it("rolls back failure, records failed work, and retries the same decision", async () => {
    const archive = await createArchive();
    let fail = true;
    const failing = new PrismaImportExclusionPersistence(prisma, async () => {
      if (fail) {
        fail = false;
        throw new Error("synthetic failure injection");
      }
    });
    const input = request(archive, archive.jobs[0], "exclude", "retryable");
    await expect(new ApplyImportExclusionService(failing).execute(input)).rejects.toThrow(
      "synthetic failure injection",
    );
    expect(
      await prisma.importJob.findUniqueOrThrow({
        where: { archiveId_id: { archiveId: archive.archiveId, id: archive.jobs[0] } },
      }),
    ).toMatchObject({ eligibility: "eligible" });
    expect(
      await prisma.messageObservation.count({
        where: { archiveId: archive.archiveId, eligibility: "eligible" },
      }),
    ).toBe(3);
    expect(
      await prisma.materializationRun.findFirstOrThrow({ where: { archiveId: archive.archiveId } }),
    ).toMatchObject({ status: "failed", errorClass: "Error" });
    await expect(
      new ApplyImportExclusionService(new PrismaImportExclusionPersistence(prisma)).execute(input),
    ).resolves.toMatchObject({ status: "completed", idempotent: false });
    await expect(
      new ApplyImportExclusionService(new PrismaImportExclusionPersistence(prisma)).execute(input),
    ).resolves.toMatchObject({ status: "completed", idempotent: true, counts: { messages: 1 } });
    expect(
      await prisma.importJob.findUniqueOrThrow({
        where: { archiveId_id: { archiveId: archive.archiveId, id: archive.jobs[0] } },
      }),
    ).toMatchObject({ eligibility: "excluded" });
    await prisma.user.delete({ where: { id: archive.userId } });
  });

  it("rejects a job from another archive without changing either archive", async () => {
    const first = await createArchive();
    const second = await createArchive();
    const service = new ApplyImportExclusionService(new PrismaImportExclusionPersistence(prisma));
    await expect(
      service.execute(
        request(
          { ...first, archiveId: second.archiveId },
          first.jobs[0],
          "exclude",
          "cross-archive",
        ),
      ),
    ).rejects.toThrow();
    expect(
      await prisma.importJob.findUniqueOrThrow({
        where: { archiveId_id: { archiveId: second.archiveId, id: second.jobs[0] } },
      }),
    ).toMatchObject({ eligibility: "eligible" });
    await prisma.user.deleteMany({ where: { id: { in: [first.userId, second.userId] } } });
  });
});
