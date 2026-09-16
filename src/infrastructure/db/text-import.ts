import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { LeaseFenceError } from "../../application/echohoard";
import { reconcileAttachmentAvailability } from "../../application/text-import";
import type { ImportEligibility } from "../../application/import-exclusion";
import type {
  ImportAttachmentAvailability,
  ImportAttachmentRecord,
  ImportMessageRecord,
  ImportRecord,
  TextSnapshotImportInput,
  TextSnapshotImporter,
} from "../../application/text-import";

type Tx = Prisma.TransactionClient;
const uuid = () => randomUUID();
const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export const DEFAULT_IMPORT_TRANSACTION_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_IMPORT_TRANSACTION_MAX_WAIT_MS = 10_000;

export interface TextSnapshotImporterOptions {
  readonly transactionTimeoutMilliseconds?: number;
  readonly transactionMaxWaitMilliseconds?: number;
}

export function importTransactionOptions(options: TextSnapshotImporterOptions = {}): {
  readonly maxWait: number;
  readonly timeout: number;
} {
  return {
    maxWait: options.transactionMaxWaitMilliseconds ?? DEFAULT_IMPORT_TRANSACTION_MAX_WAIT_MS,
    timeout: options.transactionTimeoutMilliseconds ?? DEFAULT_IMPORT_TRANSACTION_TIMEOUT_MS,
  };
}

const MESSAGE_BATCH_SIZE = 250;

type BulkMessageRow = {
  readonly id: string;
  readonly archiveId: string;
  readonly conversationId: string;
  readonly sourceConversationId: string;
  readonly senderId: string | null;
  readonly replyToId: string | null;
  readonly stableKey: string;
  readonly sourceType: string;
  readonly sourceKey: string;
  readonly messageType: string;
  readonly body: string | null;
  readonly metadata: Record<string, unknown>;
  readonly sourceDeleted: boolean;
  readonly contentUnavailable: boolean;
  readonly sourceDeletedAt: string | null;
  readonly sourceDeletionObservationKey: string | null;
  readonly sourceDeletionMetadata: Record<string, unknown> | null;
  readonly sentAt: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly materialized: boolean;
};

async function bulkUpsertMessages(
  tx: Tx,
  rows: readonly BulkMessageRow[],
  eligibility: ImportEligibility,
): Promise<void> {
  if (rows.length === 0) return;
  const payload = JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      archive_id: row.archiveId,
      conversation_id: row.conversationId,
      source_conversation_id: row.sourceConversationId,
      sender_id: row.senderId,
      reply_to_id: row.replyToId,
      stable_key: row.stableKey,
      source_type: row.sourceType,
      source_key: row.sourceKey,
      message_type: row.messageType,
      body: row.body,
      metadata: row.metadata,
      source_deleted: row.sourceDeleted,
      content_unavailable: row.contentUnavailable,
      source_deleted_at: row.sourceDeletedAt,
      source_deletion_observation_key: row.sourceDeletionObservationKey,
      source_deletion_metadata: row.sourceDeletionMetadata,
      sent_at: row.sentAt,
      first_seen_at: row.firstSeenAt,
      last_seen_at: row.lastSeenAt,
      materialized: row.materialized,
    })),
  );
  if (eligibility === "excluded") {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "Message" (
        "id", "archiveId", "conversationId", "sourceConversationId", "senderId", "replyToId",
        "stableKey", "sourceType", "sourceKey", "messageType", "body", "metadata",
        "sourceDeleted", "contentUnavailable", "sourceDeletedAt", "sourceDeletionObservationKey",
        "sourceDeletionMetadata", "sentAt", "firstSeenAt", "lastSeenAt", "createdAt", "updatedAt",
        "materialized"
      )
      SELECT input.id::uuid, input.archive_id::uuid, input.conversation_id::uuid,
             input.source_conversation_id::uuid, input.sender_id::uuid, input.reply_to_id::uuid,
             input.stable_key, input.source_type, input.source_key, input.message_type, input.body,
             input.metadata, input.source_deleted, input.content_unavailable,
             input.source_deleted_at::timestamp(3), input.source_deletion_observation_key,
             input.source_deletion_metadata, input.sent_at::timestamp(3),
             input.first_seen_at::timestamp(3), input.last_seen_at::timestamp(3),
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, input.materialized
        FROM jsonb_to_recordset(CAST(${payload} AS jsonb)) AS input(
          id text, archive_id text, conversation_id text, source_conversation_id text,
          sender_id text, reply_to_id text, stable_key text, source_type text, source_key text,
          message_type text, body text, metadata jsonb, source_deleted boolean,
          content_unavailable boolean, source_deleted_at text, source_deletion_observation_key text,
          source_deletion_metadata jsonb, sent_at text, first_seen_at text, last_seen_at text,
          materialized boolean
        )
      ON CONFLICT ("archiveId", "stableKey") DO NOTHING
    `);
    return;
  }

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "Message" (
      "id", "archiveId", "conversationId", "sourceConversationId", "senderId", "replyToId",
      "stableKey", "sourceType", "sourceKey", "messageType", "body", "metadata",
      "sourceDeleted", "contentUnavailable", "sourceDeletedAt", "sourceDeletionObservationKey",
      "sourceDeletionMetadata", "sentAt", "firstSeenAt", "lastSeenAt", "createdAt", "updatedAt",
      "materialized"
    )
    SELECT input.id::uuid, input.archive_id::uuid, input.conversation_id::uuid,
           input.source_conversation_id::uuid, input.sender_id::uuid, input.reply_to_id::uuid,
           input.stable_key, input.source_type, input.source_key, input.message_type, input.body,
           input.metadata, input.source_deleted, input.content_unavailable,
           input.source_deleted_at::timestamp(3), input.source_deletion_observation_key,
           input.source_deletion_metadata, input.sent_at::timestamp(3),
           input.first_seen_at::timestamp(3), input.last_seen_at::timestamp(3),
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, input.materialized
      FROM jsonb_to_recordset(CAST(${payload} AS jsonb)) AS input(
        id text, archive_id text, conversation_id text, source_conversation_id text,
        sender_id text, reply_to_id text, stable_key text, source_type text, source_key text,
        message_type text, body text, metadata jsonb, source_deleted boolean,
        content_unavailable boolean, source_deleted_at text, source_deletion_observation_key text,
        source_deletion_metadata jsonb, sent_at text, first_seen_at text, last_seen_at text,
        materialized boolean
      )
    ON CONFLICT ("archiveId", "stableKey") DO UPDATE
      SET "senderId" = COALESCE(EXCLUDED."senderId", "Message"."senderId"),
          "body" = CASE WHEN EXCLUDED."body" IS NOT NULL THEN EXCLUDED."body" ELSE "Message"."body" END,
          "messageType" = EXCLUDED."messageType",
          "lastSeenAt" = EXCLUDED."lastSeenAt",
          "materialized" = EXCLUDED."materialized",
          "metadata" = jsonb_set(
            CASE WHEN jsonb_typeof("Message"."metadata") = 'object'
                 THEN "Message"."metadata" ELSE '{}'::jsonb END || EXCLUDED."metadata",
            '{firstSeenSnapshotId}',
            COALESCE("Message"."metadata"->'firstSeenSnapshotId', EXCLUDED."metadata"->'firstSeenSnapshotId'),
            true
          ),
          "sourceDeleted" = "Message"."sourceDeleted" OR EXCLUDED."sourceDeleted",
          "contentUnavailable" = CASE
            WHEN EXCLUDED."sourceDeleted" AND EXCLUDED."body" IS NOT NULL THEN false
            WHEN EXCLUDED."sourceDeleted" AND "Message"."body" IS NULL THEN true
            WHEN EXCLUDED."body" IS NOT NULL THEN false
            ELSE "Message"."contentUnavailable"
          END,
          "sourceDeletedAt" = CASE
            WHEN EXCLUDED."sourceDeleted" AND (
              "Message"."sourceDeletedAt" IS NULL OR
              EXCLUDED."sourceDeletedAt" > "Message"."sourceDeletedAt" OR
              (EXCLUDED."sourceDeletedAt" = "Message"."sourceDeletedAt" AND
               EXCLUDED."sourceDeletionObservationKey" > COALESCE("Message"."sourceDeletionObservationKey", ''))
            ) THEN EXCLUDED."sourceDeletedAt"
            ELSE "Message"."sourceDeletedAt"
          END,
          "sourceDeletionObservationKey" = CASE
            WHEN EXCLUDED."sourceDeleted" AND (
              "Message"."sourceDeletedAt" IS NULL OR
              EXCLUDED."sourceDeletedAt" > "Message"."sourceDeletedAt" OR
              (EXCLUDED."sourceDeletedAt" = "Message"."sourceDeletedAt" AND
               EXCLUDED."sourceDeletionObservationKey" > COALESCE("Message"."sourceDeletionObservationKey", ''))
            ) THEN EXCLUDED."sourceDeletionObservationKey"
            ELSE "Message"."sourceDeletionObservationKey"
          END,
          "sourceDeletionMetadata" = CASE
            WHEN EXCLUDED."sourceDeleted" AND (
              "Message"."sourceDeletedAt" IS NULL OR
              EXCLUDED."sourceDeletedAt" > "Message"."sourceDeletedAt" OR
              (EXCLUDED."sourceDeletedAt" = "Message"."sourceDeletedAt" AND
               EXCLUDED."sourceDeletionObservationKey" > COALESCE("Message"."sourceDeletionObservationKey", ''))
            ) THEN EXCLUDED."sourceDeletionMetadata"
            ELSE "Message"."sourceDeletionMetadata"
          END,
          "replyToId" = COALESCE(EXCLUDED."replyToId", "Message"."replyToId"),
          "updatedAt" = CURRENT_TIMESTAMP
  `);
}

type BulkMessageObservationRow = {
  readonly archiveId: string;
  readonly ownedAccountId: string;
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly importJobId: string;
  readonly sourceConversationId: string;
  readonly messageId: string;
  readonly sourceNamespace: string;
  readonly sourceConversationKey: string;
  readonly sourceEntityKey: string;
  readonly logicalEntityKey: string;
  readonly observationKey: string;
  readonly observationKind: string;
  readonly eligibility: ImportEligibility;
  readonly valueDigest: string;
  readonly observedValue: unknown;
  readonly observedAt: string;
};

async function bulkInsertMessageObservations(
  tx: Tx,
  rows: readonly BulkMessageObservationRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const payload = JSON.stringify(
    rows.map((row) => ({
      archive_id: row.archiveId,
      owned_account_id: row.ownedAccountId,
      source_id: row.sourceId,
      snapshot_id: row.snapshotId,
      import_job_id: row.importJobId,
      source_conversation_id: row.sourceConversationId,
      message_id: row.messageId,
      source_namespace: row.sourceNamespace,
      source_conversation_key: row.sourceConversationKey,
      source_entity_key: row.sourceEntityKey,
      logical_entity_key: row.logicalEntityKey,
      observation_key: row.observationKey,
      observation_kind: row.observationKind,
      eligibility: row.eligibility,
      value_digest: row.valueDigest,
      observed_value: row.observedValue,
      observed_at: row.observedAt,
    })),
  );
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "MessageObservation" (
      "archiveId", "ownedAccountId", "sourceId", "snapshotId", "importJobId",
      "sourceConversationId", "messageId", "sourceNamespace", "sourceConversationKey",
      "sourceEntityKey", "logicalEntityKey", "observationKey", "observationKind",
      "eligibility", "valueDigest", "observedValue", "observedAt"
    )
    SELECT input.archive_id::uuid, input.owned_account_id::uuid, input.source_id::uuid,
           input.snapshot_id::uuid, input.import_job_id::uuid, input.source_conversation_id::uuid,
           input.message_id::uuid, input.source_namespace, input.source_conversation_key,
           input.source_entity_key, input.logical_entity_key, input.observation_key,
           input.observation_kind, input.eligibility, input.value_digest,
           input.observed_value, input.observed_at::timestamp(3)
      FROM jsonb_to_recordset(CAST(${payload} AS jsonb)) AS input(
        archive_id text, owned_account_id text, source_id text, snapshot_id text,
        import_job_id text, source_conversation_id text, message_id text, source_namespace text,
        source_conversation_key text, source_entity_key text, logical_entity_key text,
        observation_key text, observation_kind text, eligibility text, value_digest text,
        observed_value jsonb, observed_at text
      )
    ON CONFLICT (
      "archiveId", "importJobId", "observationKind", "sourceConversationId",
      "sourceEntityKey", "observationKey"
    ) DO NOTHING
  `);
}

async function forEachRecord(
  source: TextSnapshotImportInput["records"],
  callback: (record: ImportRecord) => Promise<void>,
): Promise<number> {
  let count = 0;
  if (!isAsyncRecordSource(source)) {
    for (const record of source as readonly ImportRecord[]) {
      count += 1;
      await callback(record);
    }
    return count;
  }
  for await (const batch of source)
    for (const record of batch) {
      count += 1;
      await callback(record);
    }
  return count;
}

function orderedRecordSource(
  source: TextSnapshotImportInput["records"],
): TextSnapshotImportInput["records"] {
  if (!Array.isArray(source)) return source;
  return [...source].sort((left, right) => recordOrder(left) - recordOrder(right));
}

function recordOrder(record: ImportRecord): number {
  switch (record.kind) {
    case "person":
      return 0;
    case "identity":
      return 1;
    case "conversation":
      return 2;
    case "participant":
      return 3;
    case "message":
      return 4;
    case "revision":
      return 5;
    case "attachment":
      return 6;
  }
}

function isAsyncRecordSource(
  source: TextSnapshotImportInput["records"],
): source is AsyncIterable<readonly ImportRecord[]> {
  return typeof source === "object" && Symbol.asyncIterator in source;
}

/** Writes adapter-neutral records and only makes a snapshot visible after all
 * rows have succeeded. Existing rows are updated with last-seen provenance;
 * retries therefore converge on the same logical result. */
export class PrismaTextSnapshotImporter implements TextSnapshotImporter {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly options: TextSnapshotImporterOptions = {},
  ) {}

  public async import(input: TextSnapshotImportInput): Promise<{ readonly imported: number }> {
    const records = orderedRecordSource(input.records);
    return this.prisma.$transaction(async (tx) => {
      const people = new Map<string, string>();
      const identities = new Map<string, string>();
      const conversations = new Map<string, string>();
      const sourceConversations = new Map<string, string>();
      const messages = new Map<string, { readonly id: string; readonly conversationKey: string }>();
      const conversationSources = new Map<string, { namespace: string; key: string }>();
      const pendingReplies = new Map<string, string[]>();
      let importedCount = 0;
      const accounts = await tx.ownedAccount.findMany({
        where: { archiveId: input.archiveId },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      const ownedAccountId =
        input.ownedAccountId ?? (accounts.length === 1 ? accounts[0].id : undefined);
      if (!ownedAccountId || !accounts.some((account) => account.id === ownedAccountId))
        throw new Error("Text snapshot import requires an account in the archive scope");
      if (input.liveReceipt) {
        const sourceSha = createHash("sha256").update(input.liveReceipt.sourceKey).digest("hex");
        await tx.source.upsert({
          where: {
            archiveId_ownedAccountId_kind_stableKey: {
              archiveId: input.archiveId,
              ownedAccountId,
              kind: "live",
              stableKey: input.liveReceipt.sourceKey,
            },
          },
          create: {
            id: input.liveReceipt.sourceId,
            archiveId: input.archiveId,
            ownedAccountId,
            kind: "live",
            stableKey: input.liveReceipt.sourceKey,
            sha256: sourceSha,
          },
          update: {},
        });
        await tx.snapshot.upsert({
          where: { archiveId_id: { archiveId: input.archiveId, id: input.snapshotId } },
          create: {
            id: input.snapshotId,
            archiveId: input.archiveId,
            ownedAccountId,
            sourceId: input.liveReceipt.sourceId,
            sha256: sourceSha,
            lifecycle: "snapshotted",
          },
          update: {},
        });
        await tx.importJob.upsert({
          where: { archiveId_id: { archiveId: input.archiveId, id: input.importJobId } },
          create: {
            id: input.importJobId,
            archiveId: input.archiveId,
            ownedAccountId,
            sourceId: input.liveReceipt.sourceId,
            snapshotId: input.snapshotId,
            status: "adapting",
            adapterVersion: "wacli-webhook-contract.v1",
          },
          update: {},
        });
      }
      const job = await tx.importJob.findUnique({
        where: { archiveId_id: { archiveId: input.archiveId, id: input.importJobId } },
        select: { ownedAccountId: true, sourceId: true, snapshotId: true, eligibility: true },
      });
      if (!job || job.ownedAccountId !== ownedAccountId || job.snapshotId !== input.snapshotId)
        throw new Error("Text snapshot import scope does not match its import job");
      const jobEligibility: ImportEligibility =
        job.eligibility === "excluded" ? "excluded" : "eligible";
      const persistMessageBatch = async (batch: readonly ImportMessageRecord[]): Promise<void> => {
        if (batch.length === 0) return;
        const candidates = batch.flatMap((record) => {
          const conversationId = conversations.get(record.conversationKey);
          const sourceConversationId = sourceConversations.get(record.conversationKey);
          const sourceConversation = conversationSources.get(record.conversationKey);
          if (!conversationId || !sourceConversationId || !sourceConversation) return [];
          return [{ record, conversationId, sourceConversationId, sourceConversation }];
        });
        if (candidates.length === 0) return;

        const baseKeys = [...new Set(candidates.map(({ record }) => record.stableKey))];
        const baseRows = await tx.message.findMany({
          where: { archiveId: input.archiveId, stableKey: { in: baseKeys } },
          select: {
            id: true,
            stableKey: true,
            sourceConversationId: true,
            body: true,
            metadata: true,
            sourceDeletedAt: true,
            sourceDeletionObservationKey: true,
          },
        });
        const baseByKey = new Map(baseRows.map((row) => [row.stableKey, row]));
        const occupiedByKey = new Map(
          baseRows.map((row) => [row.stableKey, row.sourceConversationId]),
        );
        const preparedKeys = candidates.map(({ record, sourceConversationId }) => {
          const priorSourceConversationId = baseByKey.get(record.stableKey)?.sourceConversationId;
          const occupiedSourceConversationId = occupiedByKey.get(record.stableKey);
          const collides =
            (priorSourceConversationId !== undefined &&
              priorSourceConversationId !== sourceConversationId) ||
            (occupiedSourceConversationId !== undefined &&
              occupiedSourceConversationId !== sourceConversationId);
          const stableKey = collides
            ? `${ownedAccountId}:${sourceConversationId}:${record.stableKey}`
            : record.stableKey;
          if (!occupiedByKey.has(stableKey)) occupiedByKey.set(stableKey, sourceConversationId);
          return { record, sourceConversationId, stableKey };
        });
        const missingPriorKeys = preparedKeys
          .map(({ stableKey }) => stableKey)
          .filter((stableKey) => !baseByKey.has(stableKey));
        const extraRows =
          missingPriorKeys.length > 0
            ? await tx.message.findMany({
                where: { archiveId: input.archiveId, stableKey: { in: missingPriorKeys } },
                select: {
                  id: true,
                  stableKey: true,
                  sourceConversationId: true,
                  body: true,
                  metadata: true,
                  sourceDeletedAt: true,
                  sourceDeletionObservationKey: true,
                },
              })
            : [];
        const priorByKey = new Map([...baseRows, ...extraRows].map((row) => [row.stableKey, row]));

        const senderIdentityIds = [
          ...new Set(
            candidates
              .map(({ record }) => record.senderIdentityKey)
              .map((identityKey) => (identityKey ? identities.get(identityKey) : undefined))
              .filter((identityId): identityId is string => identityId !== undefined),
          ),
        ];
        const senderRows =
          senderIdentityIds.length > 0
            ? await tx.identity.findMany({
                where: { archiveId: input.archiveId, id: { in: senderIdentityIds } },
                select: { id: true, personId: true },
              })
            : [];
        const senderByIdentityId = new Map(senderRows.map((row) => [row.id, row.personId]));

        const idsBySourceKey = new Map(
          preparedKeys.map(({ record, stableKey }) => [
            record.stableKey,
            priorByKey.get(stableKey)?.id ?? stableUuid(input.archiveId, stableKey),
          ]),
        );
        const rows: BulkMessageRow[] = [];
        const observations: BulkMessageObservationRow[] = [];
        for (const candidate of candidates) {
          const prepared = preparedKeys.find(({ record }) => record === candidate.record);
          if (!prepared) continue;
          const { record, sourceConversationId, stableKey } = prepared;
          const identityId = record.senderIdentityKey
            ? identities.get(record.senderIdentityKey)
            : undefined;
          const senderId = identityId ? (senderByIdentityId.get(identityId) ?? null) : null;
          const deletion = record.sourceDeletion;
          const deletionObservedAt = deletion?.observedAt
            ? new Date(deletion.observedAt)
            : input.observedAt;
          const sourceDeletionMetadata = deletion
            ? {
                kind: deletion.kind,
                eventKey: deletion.eventKey,
                observedAt: deletion.observedAt,
                ...(deletion.sourceMetadata ?? {}),
              }
            : null;
          const messageId = priorByKey.get(stableKey)?.id ?? stableUuid(input.archiveId, stableKey);
          const replyToId = record.replyToKey
            ? (idsBySourceKey.get(record.replyToKey) ?? messages.get(record.replyToKey)?.id ?? null)
            : null;
          messages.set(record.stableKey, {
            id: messageId,
            conversationKey: record.conversationKey,
          });
          rows.push({
            id: messageId,
            archiveId: input.archiveId,
            conversationId: candidate.conversationId,
            sourceConversationId,
            senderId,
            replyToId,
            stableKey,
            sourceType: record.source.namespace,
            sourceKey: record.source.value,
            messageType: record.messageKind,
            body: record.body ?? null,
            metadata: {
              direction: record.direction,
              bodyState: record.bodyState,
              ...(record.metadata ?? {}),
              ...(record.unsupportedTypeCode === undefined
                ? {}
                : { unsupportedTypeCode: record.unsupportedTypeCode }),
              firstSeenSnapshotId: input.snapshotId,
              lastSeenSnapshotId: input.snapshotId,
            },
            sourceDeleted: deletion !== undefined,
            contentUnavailable: deletion !== undefined && record.body === undefined,
            sourceDeletedAt: deletion ? deletionObservedAt.toISOString() : null,
            sourceDeletionObservationKey: deletion?.eventKey ?? null,
            sourceDeletionMetadata,
            sentAt: record.timestamp ? new Date(record.timestamp).toISOString() : null,
            firstSeenAt: input.observedAt.toISOString(),
            lastSeenAt: input.observedAt.toISOString(),
            materialized: jobEligibility === "eligible",
          });
          observations.push({
            archiveId: input.archiveId,
            ownedAccountId,
            sourceId: job.sourceId,
            snapshotId: input.snapshotId,
            importJobId: input.importJobId,
            sourceConversationId,
            messageId,
            sourceNamespace: candidate.sourceConversation.namespace,
            sourceConversationKey: candidate.sourceConversation.key,
            sourceEntityKey: record.stableKey,
            logicalEntityKey: stableKey,
            observationKey: deletion?.eventKey ?? record.stableKey,
            observationKind: deletion ? "source-deletion-tombstone" : "value",
            eligibility: jobEligibility,
            valueDigest: createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex"),
            observedValue: record,
            observedAt: deletion?.observedAt
              ? deletionObservedAt.toISOString()
              : input.observedAt.toISOString(),
          });
        }
        await bulkUpsertMessages(tx, rows, jobEligibility);
        await bulkInsertMessageObservations(tx, observations);

        for (const record of batch) {
          const message = messages.get(record.stableKey);
          if (!message) continue;
          const waitingReplies = pendingReplies.get(record.stableKey);
          if (!waitingReplies) continue;
          for (const waitingReplyId of waitingReplies)
            await tx.message.update({
              where: { archiveId_id: { archiveId: input.archiveId, id: waitingReplyId } },
              data: { replyToId: message.id },
            });
          pendingReplies.delete(record.stableKey);
        }
        for (const record of batch) {
          if (!record.replyToKey) continue;
          const message = messages.get(record.stableKey);
          const replyTo = messages.get(record.replyToKey);
          if (!message) continue;
          if (replyTo)
            await tx.message.update({
              where: { archiveId_id: { archiveId: input.archiveId, id: message.id } },
              data: { replyToId: replyTo.id },
            });
          else {
            const waiting = pendingReplies.get(record.replyToKey) ?? [];
            waiting.push(message.id);
            pendingReplies.set(record.replyToKey, waiting);
          }
        }
      };
      let messageBatch: ImportMessageRecord[] = [];
      const flushMessageBatch = async (): Promise<void> => {
        const batch = messageBatch;
        messageBatch = [];
        await persistMessageBatch(batch);
      };
      await forEachRecord(records, async (record) => {
        importedCount += 1;
        if (record.kind === "message") {
          messageBatch.push(record);
          if (messageBatch.length >= MESSAGE_BATCH_SIZE) await flushMessageBatch();
          return;
        }
        await flushMessageBatch();
        if (record.kind === "person") {
          const existing = await tx.person.upsert({
            where: {
              archiveId_id: {
                archiveId: input.archiveId,
                id: stableUuid(input.archiveId, record.stableKey),
              },
            },
            create: {
              id: stableUuid(input.archiveId, record.stableKey),
              archiveId: input.archiveId,
              displayName: record.displayName,
            },
            update: { displayName: record.displayName },
          });
          people.set(record.stableKey, existing.id);
        }
        if (record.kind === "identity") {
          const personId = record.personKey ? people.get(record.personKey) : undefined;
          if (!personId) return;
          const rawIdentity = await tx.identity.findUnique({
            where: {
              archiveId_kind_value: {
                archiveId: input.archiveId,
                kind: record.source.namespace,
                value: record.source.value,
              },
            },
            select: { personId: true },
          });
          const value =
            rawIdentity && rawIdentity.personId !== personId
              ? `${record.source.value}:${record.stableKey}`
              : record.source.value;
          const prior = await tx.identity.findUnique({
            where: {
              archiveId_kind_value: {
                archiveId: input.archiveId,
                kind: record.source.namespace,
                value,
              },
            },
            select: { provenance: true },
          });
          const existing = await tx.identity.upsert({
            where: {
              archiveId_kind_value: {
                archiveId: input.archiveId,
                kind: record.source.namespace,
                value,
              },
            },
            create: {
              id: stableUuid(input.archiveId, record.stableKey),
              archiveId: input.archiveId,
              personId,
              kind: record.source.namespace,
              value,
              displayName: record.displayName,
              provenance: json({
                firstSeenSnapshotId: input.snapshotId,
                lastSeenSnapshotId: input.snapshotId,
              }),
            },
            update: {
              personId,
              displayName: record.displayName,
              provenance: json(mergeSnapshotProvenance(prior?.provenance, input.snapshotId)),
            },
          });
          identities.set(record.stableKey, existing.id);
        }
        if (record.kind === "conversation") {
          const sourceNamespace = record.source?.namespace ?? "normalized-import";
          const sourceConversationKey = record.source?.value ?? record.stableKey;
          conversationSources.set(record.stableKey, {
            namespace: sourceNamespace,
            key: sourceConversationKey,
          });
          const stableKey = await conversationStableKey(
            tx,
            input.archiveId,
            ownedAccountId,
            sourceNamespace,
            sourceConversationKey,
            record.stableKey,
          );
          const existing = await tx.conversation.upsert({
            where: {
              archiveId_stableKey: { archiveId: input.archiveId, stableKey },
            },
            create: {
              id: stableUuid(input.archiveId, stableKey),
              archiveId: input.archiveId,
              kind: record.conversationKind,
              stableKey,
              title: record.title,
              materialized: jobEligibility === "eligible",
            },
            update:
              jobEligibility === "eligible"
                ? { kind: record.conversationKind, title: record.title, materialized: true }
                : {},
          });
          conversations.set(record.stableKey, existing.id);
          const sourceConversation = await tx.sourceConversation.upsert({
            where: {
              archiveId_ownedAccountId_sourceNamespace_sourceConversationKey: {
                archiveId: input.archiveId,
                ownedAccountId,
                sourceNamespace,
                sourceConversationKey,
              },
            },
            create: {
              id: stableUuid(
                input.archiveId,
                `${ownedAccountId}:source-conversation:${sourceNamespace}:${sourceConversationKey}`,
              ),
              archiveId: input.archiveId,
              ownedAccountId,
              unifiedConversationId: existing.id,
              sourceNamespace,
              sourceConversationKey,
            },
            update: { unifiedConversationId: existing.id },
          });
          sourceConversations.set(record.stableKey, sourceConversation.id);
          await upsertObservation(tx.conversationObservation, {
            archiveId: input.archiveId,
            ownedAccountId,
            sourceId: job.sourceId,
            snapshotId: input.snapshotId,
            importJobId: input.importJobId,
            sourceConversationId: sourceConversation.id,
            sourceNamespace,
            sourceConversationKey,
            sourceEntityKey: record.stableKey,
            logicalEntityKey: stableKey,
            observationKey: record.stableKey,
            value: record,
            eligibility: jobEligibility,
            observedAt: input.observedAt,
          });
        }

        if (record.kind === "participant") {
          const conversationId = conversations.get(record.conversationKey);
          const sourceConversationId = sourceConversations.get(record.conversationKey);
          const personId = await identityPersonId(
            input.archiveId,
            identities.get(record.identityKey),
            tx,
          );
          if (!conversationId || !sourceConversationId || !personId) return;
          await tx.conversationParticipant.upsert({
            where: {
              archiveId_conversationId_personId: {
                archiveId: input.archiveId,
                conversationId,
                personId,
              },
            },
            create: {
              id: uuid(),
              archiveId: input.archiveId,
              conversationId,
              sourceConversationId,
              personId,
              role: record.role,
            },
            update: { role: record.role },
          });
        }

        if (record.kind === "revision") {
          const messageId = messages.get(record.messageKey)?.id;
          if (!messageId) return;
          const priorRevision = await tx.messageRevision.findUnique({
            where: {
              archiveId_messageId_revisionKey: {
                archiveId: input.archiveId,
                messageId,
                revisionKey: record.stableKey,
              },
            },
            select: { metadata: true },
          });
          const revision = await tx.messageRevision.upsert({
            where: {
              archiveId_messageId_revisionKey: {
                archiveId: input.archiveId,
                messageId,
                revisionKey: record.stableKey,
              },
            },
            create: {
              id: stableUuid(input.archiveId, `${messageId}:${record.stableKey}`),
              archiveId: input.archiveId,
              messageId,
              revisionKey: record.stableKey,
              body: record.body,
              metadata: json({
                bodyState: record.bodyState,
                firstSeenSnapshotId: record.firstSeenSnapshotId,
              }),
              firstSeenAt: input.observedAt,
              observedAt: input.observedAt,
              materialized: jobEligibility === "eligible",
            },
            update:
              jobEligibility === "eligible"
                ? {
                    observedAt: input.observedAt,
                    materialized: true,
                    metadata: json({ ...(asObject(priorRevision?.metadata) ?? {}) }),
                  }
                : {},
          });
          const messageConversationKey = messages.get(record.messageKey)?.conversationKey;
          const revisionSourceIdentity = messageConversationKey
            ? conversationSources.get(messageConversationKey)
            : undefined;
          const revisionSourceConversationId = messageConversationKey
            ? (sourceConversations.get(messageConversationKey) ??
              (revisionSourceIdentity
                ? (
                    await tx.sourceConversation.findUnique({
                      where: {
                        archiveId_ownedAccountId_sourceNamespace_sourceConversationKey: {
                          archiveId: input.archiveId,
                          ownedAccountId,
                          sourceNamespace: revisionSourceIdentity.namespace,
                          sourceConversationKey: revisionSourceIdentity.key,
                        },
                      },
                      select: { id: true },
                    })
                  )?.id
                : undefined))
            : undefined;
          if (revisionSourceConversationId && revisionSourceIdentity)
            await upsertObservation(tx.revisionObservation, {
              archiveId: input.archiveId,
              ownedAccountId,
              sourceId: job.sourceId,
              snapshotId: input.snapshotId,
              importJobId: input.importJobId,
              sourceConversationId: revisionSourceConversationId,
              sourceNamespace: revisionSourceIdentity.namespace,
              sourceConversationKey: revisionSourceIdentity.key,
              sourceEntityKey: record.stableKey,
              logicalEntityKey: record.stableKey,
              // The revision key is shared across adapters; the observation
              // key also records which source made this observation so a
              // live confirmation and backup confirmation both remain
              // queryable even when their normalized values match.
              observationKey: `${record.stableKey}:${input.liveReceipt ? "live" : "backup"}`,
              revisionId: revision.id,
              value: record,
              eligibility: jobEligibility,
              observedAt: input.observedAt,
            });
        }

        if (record.kind !== "attachment") return;
        const messageId = messages.get(record.messageKey)?.id;
        if (!messageId) return;
        const messageConversationKey = messages.get(record.messageKey)?.conversationKey;
        const sourceConversationId = messageConversationKey
          ? sourceConversations.get(messageConversationKey)
          : undefined;
        const link = await importAttachment(
          tx,
          input.archiveId,
          input.observedAt,
          messageId,
          record,
          jobEligibility,
        );
        if (sourceConversationId)
          await upsertObservation(tx.attachmentReferenceObservation, {
            archiveId: input.archiveId,
            ownedAccountId,
            sourceId: job.sourceId,
            snapshotId: input.snapshotId,
            importJobId: input.importJobId,
            sourceConversationId,
            sourceNamespace: messageConversationKey
              ? (conversationSources.get(messageConversationKey)?.namespace ?? "normalized-import")
              : "normalized-import",
            sourceConversationKey: messageConversationKey
              ? (conversationSources.get(messageConversationKey)?.key ?? "unknown")
              : "unknown",
            sourceEntityKey: record.stableKey,
            logicalEntityKey: record.stableKey,
            observationKey: record.stableKey,
            messageAttachmentId: link.id,
            value: record,
            eligibility: jobEligibility,
            observedAt: input.observedAt,
          });
      });
      await flushMessageBatch();
      try {
        await tx.snapshot.update({
          where: { archiveId_id: { archiveId: input.archiveId, id: input.snapshotId } },
          data: { lifecycle: "completed", completedAt: input.observedAt },
        });
        if (input.leaseId !== undefined) {
          const result = await tx.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
            WITH database_clock AS (SELECT clock_timestamp() AS now)
            UPDATE "ImportJob" AS job
               SET status = 'completed',
                   "finishedAt" = ${input.observedAt},
                   retryable = false,
                   "leaseId" = NULL,
                   "leaseOwner" = NULL,
                   "leaseExpiresAt" = NULL,
                   "updatedAt" = database_clock.now
              FROM database_clock
             WHERE job."archiveId" = CAST(${input.archiveId} AS uuid)
               AND job.id = CAST(${input.importJobId} AS uuid)
               AND job."leaseId" = ${input.leaseId}
               AND job."leaseExpiresAt" > database_clock.now
               AND job.status = 'finalizing'
             RETURNING job.id
          `);
          if (result.length !== 1) throw new LeaseFenceError("job lease changed during import");
        } else {
          await tx.importJob.update({
            where: { archiveId_id: { archiveId: input.archiveId, id: input.importJobId } },
            data: { status: "completed", finishedAt: input.observedAt, retryable: false },
          });
        }
      } catch (error) {
        if (error instanceof LeaseFenceError) throw error;
        throw Object.assign(new Error("snapshot import finalization failed"), {
          kind: "internal",
          phase: "finalization",
        });
      }
      if (input.liveReceipt) {
        const result = await tx.liveEventInbox.updateMany({
          where: {
            archiveId: input.archiveId,
            ownedAccountId,
            receiptId: input.liveReceipt.receiptId,
            claimId: input.liveReceipt.claimId,
            status: "processing",
          },
          data: { status: "normalized", claimId: null, claimExpiresAt: null, retryable: false },
        });
        if (result.count !== 1) throw new LeaseFenceError("live event claim changed during import");
      }
      return { imported: importedCount };
    }, importTransactionOptions(this.options));
  }
}

async function importAttachment(
  tx: Tx,
  archiveId: string,
  observedAt: Date,
  messageId: string,
  record: ImportAttachmentRecord,
  eligibility: ImportEligibility,
): Promise<{ readonly id: string }> {
  const byStableKey = await tx.attachment.findFirst({
    where: { archiveId, stableKey: record.stableKey },
  });
  const byHash = await tx.attachment.findUnique({
    where: { archiveId_sha256: { archiveId, sha256: record.sha256 } },
  });
  const prior = byHash ?? byStableKey;
  const observedAvailability: ImportAttachmentAvailability =
    record.availability === "available" && !record.casKey ? "unresolved" : record.availability;
  const availability = reconcileAttachmentAvailability(
    prior?.availability as ImportAttachmentAvailability | undefined,
    observedAvailability,
  );
  const availableObservation = observedAvailability === "available";
  const casKey =
    prior?.availability === "available"
      ? prior.casKey
      : availableObservation
        ? record.casKey
        : prior?.casKey;
  const attachment = prior
    ? await tx.attachment.update({
        where: { archiveId_id: { archiveId, id: prior.id } },
        data: {
          ...(prior.sha256 === record.sha256 || prior.availability === "available"
            ? {}
            : { sha256: record.sha256 }),
          stableKey: prior.stableKey ?? record.stableKey,
          availability,
          ...(casKey ? { casKey } : {}),
          ...attachmentMetadata(record, observedAt, prior),
        },
      })
    : await tx.attachment.create({
        data: {
          archiveId,
          stableKey: record.stableKey,
          sha256: record.sha256,
          availability,
          ...(casKey ? { casKey } : {}),
          ...attachmentMetadata(record, observedAt),
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
        },
      });
  const link = await tx.messageAttachment.upsert({
    where: {
      archiveId_messageId_attachmentId: { archiveId, messageId, attachmentId: attachment.id },
    },
    create: {
      archiveId,
      messageId,
      attachmentId: attachment.id,
      ordinal: record.ordinal,
      role: record.role,
      metadata: record.metadata ? json(record.metadata) : undefined,
      materialized: eligibility === "eligible",
    },
    update: {
      ordinal: record.ordinal,
      role: record.role,
      ...(record.metadata ? { metadata: json(record.metadata) } : {}),
      materialized: eligibility === "eligible",
    },
  });
  return { id: link.id };
}

function attachmentMetadata(
  record: ImportAttachmentRecord,
  observedAt: Date,
  prior?: { readonly originalName: string | null; readonly originalPath: string | null },
): {
  readonly originalName?: string;
  readonly originalPath?: string;
  readonly mimeType?: string;
  readonly byteSize?: bigint;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly sourceMetadata?: Prisma.InputJsonValue;
  readonly lastSeenAt: Date;
} {
  return {
    ...(record.originalName !== undefined ? { originalName: record.originalName } : {}),
    ...(record.originalPath !== undefined ? { originalPath: record.originalPath } : {}),
    ...(record.mimeType !== undefined ? { mimeType: record.mimeType } : {}),
    ...(record.byteSize !== undefined ? { byteSize: BigInt(record.byteSize) } : {}),
    ...(record.width !== undefined ? { width: record.width } : {}),
    ...(record.height !== undefined ? { height: record.height } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.sourceMetadata !== undefined ? { sourceMetadata: json(record.sourceMetadata) } : {}),
    lastSeenAt: observedAt,
    ...(prior?.originalName && record.originalName === undefined
      ? { originalName: prior.originalName }
      : {}),
    ...(prior?.originalPath && record.originalPath === undefined
      ? { originalPath: prior.originalPath }
      : {}),
  };
}

async function identityPersonId(
  archiveId: string,
  identityId: string | undefined,
  tx: Tx,
): Promise<string | null> {
  if (!identityId) return null;
  const identity = await tx.identity.findUnique({
    where: { archiveId_id: { archiveId, id: identityId } },
    select: { personId: true },
  });
  return identity?.personId ?? null;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mergeSnapshotProvenance(value: unknown, snapshotId: string): Record<string, string> {
  const prior = asObject(value);
  return {
    ...(typeof prior?.firstSeenSnapshotId === "string"
      ? { firstSeenSnapshotId: prior.firstSeenSnapshotId }
      : { firstSeenSnapshotId: snapshotId }),
    lastSeenSnapshotId: snapshotId,
  };
}

function stableUuid(archiveId: string, key: string): string {
  const hex = createHash("sha256")
    .update(`${archiveId}\0${key}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

type ObservationDelegate = { upsert(args: never): Promise<unknown> };
type ObservationInput = {
  readonly archiveId: string;
  readonly ownedAccountId: string;
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly importJobId: string;
  readonly sourceConversationId: string;
  readonly sourceNamespace: string;
  readonly sourceConversationKey: string;
  readonly sourceEntityKey: string;
  readonly logicalEntityKey: string;
  readonly observationKey: string;
  readonly value: unknown;
  readonly observedAt: Date;
  readonly messageId?: string;
  readonly revisionId?: string;
  readonly messageAttachmentId?: string;
  readonly eligibility: ImportEligibility;
  readonly observationKind?: "value" | "source-deletion-tombstone";
};

async function upsertObservation(
  delegate: ObservationDelegate,
  input: ObservationInput,
): Promise<void> {
  const { value, messageId, revisionId, messageAttachmentId, ...fields } = input;
  const target = messageId
    ? { messageId }
    : revisionId
      ? { revisionId }
      : messageAttachmentId
        ? { messageAttachmentId }
        : {};
  const digest = createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  await delegate.upsert({
    where: {
      archiveId_importJobId_observationKind_sourceConversationId_sourceEntityKey_observationKey: {
        archiveId: input.archiveId,
        importJobId: input.importJobId,
        observationKind: input.observationKind ?? "value",
        sourceConversationId: input.sourceConversationId,
        sourceEntityKey: input.sourceEntityKey,
        observationKey: input.observationKey,
      },
    },
    create: {
      ...fields,
      ...target,
      observationKind: input.observationKind ?? "value",
      eligibility: input.eligibility,
      valueDigest: digest,
      observedValue: json(value),
    },
    update: {},
  } as never);
}

async function conversationStableKey(
  tx: Tx,
  archiveId: string,
  ownedAccountId: string,
  sourceNamespace: string,
  sourceConversationKey: string,
  sourceKey: string,
): Promise<string> {
  const sourceConversation = await tx.sourceConversation.findUnique({
    where: {
      archiveId_ownedAccountId_sourceNamespace_sourceConversationKey: {
        archiveId,
        ownedAccountId,
        sourceNamespace,
        sourceConversationKey,
      },
    },
    include: { unifiedConversation: { select: { stableKey: true } } },
  });
  if (sourceConversation) return sourceConversation.unifiedConversation.stableKey;
  const existing = await tx.conversation.findUnique({
    where: { archiveId_stableKey: { archiveId, stableKey: sourceKey } },
    include: {
      sourceConversations: {
        select: { ownedAccountId: true, sourceNamespace: true, sourceConversationKey: true },
      },
    },
  });
  return existing &&
    existing.sourceConversations.some(
      (row) =>
        row.ownedAccountId !== ownedAccountId ||
        row.sourceNamespace !== sourceNamespace ||
        row.sourceConversationKey !== sourceConversationKey,
    )
    ? `${ownedAccountId}:${sourceNamespace}:${sourceConversationKey}:${sourceKey}`
    : sourceKey;
}
