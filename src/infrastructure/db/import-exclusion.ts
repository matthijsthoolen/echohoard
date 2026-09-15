import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  MATERIALIZATION_POLICY_VERSION,
  MAX_EXCLUSION_PLAN_COUNT,
  type ImportEligibility,
  type ImportExclusionAction,
  type ImportExclusionCounts,
  type ImportExclusionPersistence,
  type ImportExclusionPlan,
  type ImportExclusionRequest,
  type ImportExclusionResult,
  selectPreferredObservation,
} from "../../application/import-exclusion.js";
import type { PersistenceRecord } from "../../application/persistence.js";

type Db = PrismaClient | Prisma.TransactionClient;
type EntityKind = "conversation" | "message" | "revision" | "reaction" | "attachmentReference";
type Affected = {
  readonly kind: EntityKind;
  readonly entityId: string;
  readonly logicalEntityKey: string;
};
type RawAffected = { entity_kind: string; entity_id: string; logical_entity_key: string };
type RawDigest = {
  entity_kind: string;
  entity_id: string;
  logical_entity_key: string;
  observation_key: string;
  value_digest: string;
  observed_at: Date;
  import_job_id: string;
  eligibility: string;
};

type MaterializationObservation = {
  readonly observationKey: string;
  readonly observedAt: Date;
  readonly sourceKind: string;
  readonly value: PersistenceRecord | null;
};

const asRecord = (value: unknown): PersistenceRecord | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as PersistenceRecord;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const countsFor = (
  affected: readonly Affected[],
  observationCount: number,
): ImportExclusionCounts => ({
  conversations: boundedCount(affected.filter((row) => row.kind === "conversation").length),
  messages: boundedCount(affected.filter((row) => row.kind === "message").length),
  revisions: boundedCount(affected.filter((row) => row.kind === "revision").length),
  reactions: boundedCount(affected.filter((row) => row.kind === "reaction").length),
  attachmentReferences: boundedCount(
    affected.filter((row) => row.kind === "attachmentReference").length,
  ),
  observations: boundedCount(observationCount),
});

/** PostgreSQL implementation of the audited, reversible import eligibility use case. */
export class PrismaImportExclusionPersistence implements ImportExclusionPersistence {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly failureHook?: (phase: "after-materialization") => void | Promise<void>,
  ) {}

  public async plan(request: ImportExclusionRequest): Promise<ImportExclusionPlan> {
    const job = await this.getJob(this.prisma, request);
    const nextEligibility = nextState(job.eligibility, request.action);
    const affected = await findAffected(this.prisma, request.archiveId, request.importJobId);
    const digestRows = await findDigestRows(
      this.prisma,
      request.archiveId,
      affected.map((row) => row.logicalEntityKey),
    );
    return {
      archiveId: request.archiveId,
      importJobId: request.importJobId,
      action: request.action,
      currentEligibility: job.eligibility,
      nextEligibility,
      counts: countsFor(
        affected,
        digestRows.filter((row) => row.import_job_id === request.importJobId).length,
      ),
      inputSetDigest: inputDigest(digestRows, request.importJobId, nextEligibility),
      truncated:
        affected.length > MAX_EXCLUSION_PLAN_COUNT ||
        digestRows.filter((row) => row.import_job_id === request.importJobId).length >
          MAX_EXCLUSION_PLAN_COUNT,
    };
  }

  public async apply(request: ImportExclusionRequest): Promise<ImportExclusionResult> {
    const plan = await this.plan(request);
    const existing = await this.prisma.materializationRun.findUnique({
      where: {
        archiveId_importJobId_idempotencyKey: {
          archiveId: request.archiveId,
          importJobId: request.importJobId,
          idempotencyKey: request.idempotencyKey,
        },
      },
    });
    if (existing?.status === "completed") return completedResult(existing, request, true);
    const run = existing
      ? await this.prisma.materializationRun.update({
          where: { archiveId_id: { archiveId: request.archiveId, id: existing.id } },
          data: {
            status: "running",
            errorClass: null,
            completedAt: null,
            startedAt: request.requestedAt ?? new Date(),
          },
        })
      : await this.prisma.materializationRun.create({
          data: {
            archiveId: request.archiveId,
            importJobId: request.importJobId,
            action: request.action,
            status: "running",
            actor: request.actor,
            reason: request.reason,
            idempotencyKey: request.idempotencyKey,
            policyVersion: MATERIALIZATION_POLICY_VERSION,
            inputSetDigest: plan.inputSetDigest,
            startedAt: request.requestedAt ?? new Date(),
          },
        });

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT id FROM "ImportJob"
          WHERE id = ${request.importJobId}::uuid AND "archiveId" = ${request.archiveId}::uuid
          FOR UPDATE
        `);
        const lockedJob = await this.getJob(tx, request);
        const nextEligibility = nextState(lockedJob.eligibility, request.action);
        const affected = await findAffected(tx, request.archiveId, request.importJobId);
        const digestRows = await findDigestRows(
          tx,
          request.archiveId,
          affected.map((row) => row.logicalEntityKey),
        );
        const digest = inputDigest(digestRows, request.importJobId, nextEligibility);
        await tx.importEligibilityDecision.create({
          data: {
            archiveId: request.archiveId,
            importJobId: request.importJobId,
            eligibility: nextEligibility,
            actor: request.actor,
            reason: request.reason,
            idempotencyKey: request.idempotencyKey,
            decidedAt: request.requestedAt ?? new Date(),
          },
        });
        const observationUpdate = await updateObservationEligibility(
          tx,
          request.archiveId,
          request.importJobId,
          nextEligibility,
        );
        await tx.importJob.update({
          where: { archiveId_id: { archiveId: request.archiveId, id: request.importJobId } },
          data: { eligibility: nextEligibility },
        });
        await rematerialize(tx, request.archiveId, affected, digest, run.id);
        await this.failureHook?.("after-materialization");
        const counts = countsFor(affected, observationUpdate);
        const result = { counts, inputSetDigest: digest };
        await tx.materializationRun.update({
          where: { archiveId_id: { archiveId: request.archiveId, id: run.id } },
          data: {
            status: "completed",
            inputSetDigest: digest,
            result: result as unknown as Prisma.InputJsonValue,
            completedAt: request.requestedAt ?? new Date(),
            errorClass: null,
          },
        });
        return {
          archiveId: request.archiveId,
          importJobId: request.importJobId,
          action: request.action,
          runId: run.id,
          status: "completed" as const,
          counts,
          inputSetDigest: digest,
          idempotent: false,
        };
      });
    } catch (error) {
      await this.prisma.materializationRun.update({
        where: { archiveId_id: { archiveId: request.archiveId, id: run.id } },
        data: { status: "failed", errorClass: safeErrorClass(error) },
      });
      throw error;
    }
  }

  private async getJob(
    db: Db,
    request: ImportExclusionRequest,
  ): Promise<{ eligibility: ImportEligibility }> {
    const job = await db.importJob.findUnique({
      where: { archiveId_id: { archiveId: request.archiveId, id: request.importJobId } },
      select: { eligibility: true },
    });
    if (!job) throw new Error("Import job is outside the archive scope or does not exist");
    if (job.eligibility !== "eligible" && job.eligibility !== "excluded")
      throw new Error("Import job has an invalid eligibility state");
    return { eligibility: job.eligibility };
  }
}

async function findAffected(
  db: Db,
  archiveId: string,
  importJobId: string,
): Promise<readonly Affected[]> {
  const rows = await db.$queryRaw<RawAffected[]>(Prisma.sql`
    SELECT 'conversation' AS entity_kind, "sourceConversationId" AS entity_id, "logicalEntityKey" AS logical_entity_key
      FROM "ConversationObservation" WHERE "archiveId" = ${archiveId}::uuid AND "importJobId" = ${importJobId}::uuid
    UNION ALL
    SELECT 'message', "messageId", "logicalEntityKey"
      FROM "MessageObservation" WHERE "archiveId" = ${archiveId}::uuid AND "importJobId" = ${importJobId}::uuid
    UNION ALL
    SELECT 'revision', "revisionId", "logicalEntityKey"
      FROM "RevisionObservation" WHERE "archiveId" = ${archiveId}::uuid AND "importJobId" = ${importJobId}::uuid
    UNION ALL
    SELECT 'reaction', "reactionId", "logicalEntityKey"
      FROM "ReactionObservation" WHERE "archiveId" = ${archiveId}::uuid AND "importJobId" = ${importJobId}::uuid
    UNION ALL
    SELECT 'attachmentReference', "messageAttachmentId", "logicalEntityKey"
      FROM "AttachmentReferenceObservation" WHERE "archiveId" = ${archiveId}::uuid AND "importJobId" = ${importJobId}::uuid
  `);
  const unique = new Map<string, Affected>();
  for (const row of rows) {
    if (!isEntityKind(row.entity_kind) || !row.entity_id || !row.logical_entity_key) continue;
    unique.set(`${row.entity_kind}:${row.entity_id}`, {
      kind: row.entity_kind,
      entityId: row.entity_id,
      logicalEntityKey: row.logical_entity_key,
    });
  }
  return [...unique.values()].sort((left, right) =>
    `${left.kind}:${left.entityId}`.localeCompare(`${right.kind}:${right.entityId}`),
  );
}

async function findDigestRows(
  db: Db,
  archiveId: string,
  logicalKeys: readonly string[],
): Promise<readonly RawDigest[]> {
  if (logicalKeys.length === 0) return [];
  const values = Prisma.join(
    logicalKeys.map((key) => Prisma.sql`${key}`),
    ", ",
  );
  return db.$queryRaw<RawDigest[]>(Prisma.sql`
    SELECT 'conversation' AS entity_kind, "sourceConversationId" AS entity_id, "logicalEntityKey" AS logical_entity_key,
           "observationKey" AS observation_key, "valueDigest" AS value_digest, "observedAt" AS observed_at,
           "importJobId" AS import_job_id, "eligibility" FROM "ConversationObservation"
      WHERE "archiveId" = ${archiveId}::uuid AND "logicalEntityKey" IN (${values})
    UNION ALL
    SELECT 'message', "messageId", "logicalEntityKey", "observationKey", "valueDigest", "observedAt", "importJobId", "eligibility"
      FROM "MessageObservation" WHERE "archiveId" = ${archiveId}::uuid AND "logicalEntityKey" IN (${values})
    UNION ALL
    SELECT 'revision', "revisionId", "logicalEntityKey", "observationKey", "valueDigest", "observedAt", "importJobId", "eligibility"
      FROM "RevisionObservation" WHERE "archiveId" = ${archiveId}::uuid AND "logicalEntityKey" IN (${values})
    UNION ALL
    SELECT 'reaction', "reactionId", "logicalEntityKey", "observationKey", "valueDigest", "observedAt", "importJobId", "eligibility"
      FROM "ReactionObservation" WHERE "archiveId" = ${archiveId}::uuid AND "logicalEntityKey" IN (${values})
    UNION ALL
    SELECT 'attachmentReference', "messageAttachmentId", "logicalEntityKey", "observationKey", "valueDigest", "observedAt", "importJobId", "eligibility"
      FROM "AttachmentReferenceObservation" WHERE "archiveId" = ${archiveId}::uuid AND "logicalEntityKey" IN (${values})
  `);
}

function inputDigest(
  rows: readonly RawDigest[],
  importJobId: string,
  nextEligibility: ImportEligibility,
): string {
  const canonical = [...rows]
    .map((row) =>
      [
        row.entity_kind,
        row.entity_id,
        row.logical_entity_key,
        row.observation_key,
        row.value_digest,
        row.observed_at.toISOString(),
        row.import_job_id,
        row.import_job_id === importJobId ? nextEligibility : row.eligibility,
      ].join("\0"),
    )
    .sort()
    .join("\n");
  return createHash("sha256")
    .update(`${MATERIALIZATION_POLICY_VERSION}\n${canonical}`)
    .digest("hex");
}

async function updateObservationEligibility(
  tx: Prisma.TransactionClient,
  archiveId: string,
  importJobId: string,
  eligibility: ImportEligibility,
): Promise<number> {
  const results = await Promise.all([
    tx.conversationObservation.updateMany({
      where: { archiveId, importJobId },
      data: { eligibility },
    }),
    tx.messageObservation.updateMany({ where: { archiveId, importJobId }, data: { eligibility } }),
    tx.revisionObservation.updateMany({ where: { archiveId, importJobId }, data: { eligibility } }),
    tx.reactionObservation.updateMany({ where: { archiveId, importJobId }, data: { eligibility } }),
    tx.attachmentReferenceObservation.updateMany({
      where: { archiveId, importJobId },
      data: { eligibility },
    }),
  ]);
  return results.reduce((total, result) => total + result.count, 0);
}

async function rematerialize(
  tx: Prisma.TransactionClient,
  archiveId: string,
  affected: readonly Affected[],
  inputSetDigest: string,
  runId: string,
): Promise<void> {
  await rematerializeConversations(tx, archiveId, affected, inputSetDigest, runId);
  await rematerializeMessages(tx, archiveId, affected, inputSetDigest, runId);
  await rematerializeRevisions(tx, archiveId, affected, inputSetDigest, runId);
  await rematerializeSimple(tx, archiveId, affected, inputSetDigest, runId);
}

async function rematerializeConversations(
  tx: Prisma.TransactionClient,
  archiveId: string,
  affected: readonly Affected[],
  digest: string,
  runId: string,
): Promise<void> {
  const ids = affected.filter((row) => row.kind === "conversation").map((row) => row.entityId);
  if (ids.length === 0) return;
  const sourceConversations = await tx.sourceConversation.findMany({
    where: { archiveId, id: { in: ids } },
    select: { id: true, unifiedConversationId: true },
  });
  const observations = await tx.conversationObservation.findMany({
    where: { archiveId, sourceConversationId: { in: ids } },
    select: {
      sourceConversationId: true,
      observationKey: true,
      observedAt: true,
      eligibility: true,
      observedValue: true,
      source: { select: { kind: true } },
    },
  });
  for (const source of sourceConversations) {
    const rows = observations.filter((row) => row.sourceConversationId === source.id);
    const eligible = rows.filter((row) => row.eligibility === "eligible");
    const winner = selectPreferredObservation(toMaterializationRows(eligible), () => true);
    const value = winner?.value;
    const title = asString(value?.title);
    const kind = asString(value?.conversationKind);
    await tx.conversation.update({
      where: { archiveId_id: { archiveId, id: source.unifiedConversationId } },
      data: {
        ...(kind ? { kind } : {}),
        ...(title !== undefined ? { title } : {}),
        materialized: eligible.length > 0,
        ...materializationFields(runId, digest),
      },
    });
  }
}

async function rematerializeMessages(
  tx: Prisma.TransactionClient,
  archiveId: string,
  affected: readonly Affected[],
  digest: string,
  runId: string,
): Promise<void> {
  const ids = affected.filter((row) => row.kind === "message").map((row) => row.entityId);
  if (ids.length === 0) return;
  const observations = await tx.messageObservation.findMany({
    where: { archiveId, messageId: { in: ids } },
    select: {
      messageId: true,
      observationKey: true,
      observedAt: true,
      eligibility: true,
      observedValue: true,
      source: { select: { kind: true } },
      snapshotId: true,
    },
  });
  for (const id of ids) {
    const rows = observations.filter((row) => row.messageId === id);
    const eligible = rows.filter((row) => row.eligibility === "eligible");
    const allWinner = selectPreferredObservation(toMaterializationRows(eligible), () => true);
    const bodyWinner = selectPreferredObservation(toMaterializationRows(eligible), (value) => {
      const state = value?.bodyState;
      return state === "present" && value?.body !== undefined;
    });
    const value = allWinner?.value;
    const bodyValue = bodyWinner?.value;
    const first = earliest(eligible);
    const last = latest(eligible);
    const source = asRecord(value?.source);
    const sourceType = asString(source?.namespace);
    const sourceKey = asString(source?.value);
    const messageType = asString(value?.messageKind);
    const sentAt = asDateValue(value?.timestamp);
    const metadata = {
      ...(asRecord(value?.metadata) ?? {}),
      ...(asString(value?.direction) ? { direction: value?.direction } : {}),
      ...(asString(value?.bodyState) ? { bodyState: value?.bodyState } : {}),
      ...(typeof value?.unsupportedTypeCode === "number"
        ? { unsupportedTypeCode: value.unsupportedTypeCode }
        : {}),
      materialization: {
        runId,
        inputSetDigest: digest,
        policyVersion: MATERIALIZATION_POLICY_VERSION,
        ...(bodyWinner ? { selectedBodyObservationKey: bodyWinner.observationKey } : {}),
      },
      ...(first?.snapshotId ? { firstSeenSnapshotId: first.snapshotId } : {}),
      ...(last?.snapshotId ? { lastSeenSnapshotId: last.snapshotId } : {}),
    };
    await tx.message.update({
      where: { archiveId_id: { archiveId, id } },
      data: {
        ...(sourceType ? { sourceType } : {}),
        ...(sourceKey ? { sourceKey } : {}),
        ...(messageType ? { messageType } : {}),
        ...(bodyWinner
          ? { body: asString(bodyValue?.body) ?? null }
          : eligible.length > 0
            ? { body: null }
            : {}),
        ...(sentAt !== undefined ? { sentAt } : {}),
        ...(first ? { firstSeenAt: first.observedAt } : {}),
        ...(last ? { lastSeenAt: last.observedAt } : {}),
        ...(Object.keys(metadata).length > 0
          ? { metadata: metadata as Prisma.InputJsonValue }
          : {}),
        materialized: eligible.length > 0,
        ...materializationFields(runId, digest),
      },
    });
  }
}

async function rematerializeRevisions(
  tx: Prisma.TransactionClient,
  archiveId: string,
  affected: readonly Affected[],
  digest: string,
  runId: string,
): Promise<void> {
  const ids = affected.filter((row) => row.kind === "revision").map((row) => row.entityId);
  if (ids.length === 0) return;
  const observations = await tx.revisionObservation.findMany({
    where: { archiveId, revisionId: { in: ids } },
    select: {
      revisionId: true,
      observationKey: true,
      observedAt: true,
      eligibility: true,
      observedValue: true,
      source: { select: { kind: true } },
    },
  });
  for (const id of ids) {
    const eligible = observations.filter(
      (row) => row.revisionId === id && row.eligibility === "eligible",
    );
    const winner = selectPreferredObservation(
      toMaterializationRows(eligible),
      (value) => value?.bodyState === "present",
    );
    const value = winner?.value;
    const first = earliest(eligible);
    await tx.messageRevision.update({
      where: { archiveId_id: { archiveId, id } },
      data: {
        ...(winner
          ? { body: asString(value?.body) ?? null }
          : eligible.length > 0
            ? { body: null }
            : {}),
        ...(value ? { metadata: value as Prisma.InputJsonValue } : {}),
        ...(first ? { firstSeenAt: first.observedAt } : {}),
        ...(winner ? { observedAt: winner.observedAt } : {}),
        materialized: eligible.length > 0,
        ...materializationFields(runId, digest),
      },
    });
  }
}

async function rematerializeSimple(
  tx: Prisma.TransactionClient,
  archiveId: string,
  affected: readonly Affected[],
  digest: string,
  runId: string,
): Promise<void> {
  const reactionIds = affected.filter((row) => row.kind === "reaction").map((row) => row.entityId);
  const linkIds = affected
    .filter((row) => row.kind === "attachmentReference")
    .map((row) => row.entityId);
  const [reactionRows, linkRows] = await Promise.all([
    reactionIds.length
      ? tx.reactionObservation.findMany({
          where: { archiveId, reactionId: { in: reactionIds } },
          select: { reactionId: true, eligibility: true },
        })
      : [],
    linkIds.length
      ? tx.attachmentReferenceObservation.findMany({
          where: { archiveId, messageAttachmentId: { in: linkIds } },
          select: { messageAttachmentId: true, eligibility: true },
        })
      : [],
  ]);
  for (const id of reactionIds) {
    await tx.reaction.update({
      where: { archiveId_id: { archiveId, id } },
      data: {
        materialized: reactionRows.some(
          (row) => row.reactionId === id && row.eligibility === "eligible",
        ),
        ...materializationFields(runId, digest),
      },
    });
  }
  for (const id of linkIds) {
    await tx.messageAttachment.update({
      where: { archiveId_id: { archiveId, id } },
      data: {
        materialized: linkRows.some(
          (row) => row.messageAttachmentId === id && row.eligibility === "eligible",
        ),
        ...materializationFields(runId, digest),
      },
    });
  }
}

function toMaterializationRows(
  rows: readonly {
    observationKey: string;
    observedAt: Date;
    observedValue: unknown;
    source: { kind: string };
  }[],
): readonly MaterializationObservation[] {
  return rows.map((row) => ({
    observationKey: row.observationKey,
    observedAt: row.observedAt,
    sourceKind: row.source.kind,
    value: asRecord(row.observedValue),
  }));
}

function earliest<
  T extends { observedAt: Date; observationKey: string; snapshotId?: string | null },
>(rows: readonly T[]): T | undefined {
  return [...rows].sort(compareObservationTime)[0];
}

function latest<T extends { observedAt: Date; observationKey: string }>(
  rows: readonly T[],
): T | undefined {
  return [...rows].sort((left, right) => compareObservationTime(right, left))[0];
}

function compareObservationTime(
  left: { readonly observedAt: Date; readonly observationKey: string },
  right: { readonly observedAt: Date; readonly observationKey: string },
): number {
  const difference = left.observedAt.getTime() - right.observedAt.getTime();
  return difference || left.observationKey.localeCompare(right.observationKey);
}

function boundedCount(value: number): number {
  return Math.min(MAX_EXCLUSION_PLAN_COUNT, value);
}

function materializationFields(runId: string, digest: string) {
  return {
    materializationRunId: runId,
    materializationInputDigest: digest,
    materializationPolicyVersion: MATERIALIZATION_POLICY_VERSION,
  };
}

function nextState(current: ImportEligibility, action: ImportExclusionAction): ImportEligibility {
  return action === "exclude" ? "excluded" : "eligible";
}

function isEntityKind(value: string): value is EntityKind {
  return ["conversation", "message", "revision", "reaction", "attachmentReference"].includes(value);
}

function asDateValue(value: unknown): Date | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function safeErrorClass(error: unknown): string {
  return error instanceof Error && error.name ? error.name.slice(0, 120) : "internal";
}

function completedResult(
  run: { id: string; action: string; result: Prisma.JsonValue | null; inputSetDigest: string },
  request: ImportExclusionRequest,
  idempotent: boolean,
): ImportExclusionResult {
  const result = asRecord(run.result);
  const counts = asRecord(result?.counts);
  return {
    archiveId: request.archiveId,
    importJobId: request.importJobId,
    action: run.action === "exclude" || run.action === "re-enable" ? run.action : request.action,
    runId: run.id,
    status: "completed",
    counts: {
      conversations: numberValue(counts?.conversations),
      messages: numberValue(counts?.messages),
      revisions: numberValue(counts?.revisions),
      reactions: numberValue(counts?.reactions),
      attachmentReferences: numberValue(counts?.attachmentReferences),
      observations: numberValue(counts?.observations),
    },
    inputSetDigest: run.inputSetDigest,
    idempotent,
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
