import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { reconcileAttachmentAvailability } from "../../application/text-import.js";
import type {
  ImportAttachmentAvailability,
  ImportAttachmentRecord,
  ImportMessageRecord,
  TextSnapshotImportInput,
  TextSnapshotImporter,
} from "../../application/text-import.js";

type Tx = Prisma.TransactionClient;
const uuid = () => randomUUID();
const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/** Writes adapter-neutral records and only makes a snapshot visible after all
 * rows have succeeded. Existing rows are updated with last-seen provenance;
 * retries therefore converge on the same logical result. */
export class PrismaTextSnapshotImporter implements TextSnapshotImporter {
  public constructor(private readonly prisma: PrismaClient) {}

  public async import(input: TextSnapshotImportInput): Promise<{ readonly imported: number }> {
    return this.prisma.$transaction(async (tx) => {
      const people = new Map<string, string>();
      const identities = new Map<string, string>();
      const conversations = new Map<string, string>();
      const sourceConversations = new Map<string, string>();
      const messages = new Map<string, string>();
      const accounts = await tx.ownedAccount.findMany({
        where: { archiveId: input.archiveId },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      const ownedAccountId =
        input.ownedAccountId ?? (accounts.length === 1 ? accounts[0].id : undefined);
      if (!ownedAccountId || !accounts.some((account) => account.id === ownedAccountId))
        throw new Error("Text snapshot import requires an account in the archive scope");
      const job = await tx.importJob.findUnique({
        where: { archiveId_id: { archiveId: input.archiveId, id: input.importJobId } },
        select: { ownedAccountId: true, sourceId: true, snapshotId: true },
      });
      if (!job || job.ownedAccountId !== ownedAccountId || job.snapshotId !== input.snapshotId)
        throw new Error("Text snapshot import scope does not match its import job");
      for (const record of input.records) {
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
      }
      for (const record of input.records) {
        if (record.kind === "identity") {
          const personId = record.personKey ? people.get(record.personKey) : undefined;
          if (!personId) continue;
          const prior = await tx.identity.findUnique({
            where: {
              archiveId_kind_value: {
                archiveId: input.archiveId,
                kind: record.source.namespace,
                value: record.source.value,
              },
            },
            select: { provenance: true },
          });
          const existing = await tx.identity.upsert({
            where: {
              archiveId_kind_value: {
                archiveId: input.archiveId,
                kind: record.source.namespace,
                value: record.source.value,
              },
            },
            create: {
              id: stableUuid(input.archiveId, record.stableKey),
              archiveId: input.archiveId,
              personId,
              kind: record.source.namespace,
              value: record.source.value,
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
          const stableKey = await conversationStableKey(
            tx,
            input.archiveId,
            ownedAccountId,
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
            },
            update: { kind: record.conversationKind, title: record.title },
          });
          conversations.set(record.stableKey, existing.id);
          const sourceConversation = await tx.sourceConversation.upsert({
            where: {
              archiveId_ownedAccountId_sourceNamespace_sourceConversationKey: {
                archiveId: input.archiveId,
                ownedAccountId,
                sourceNamespace: "normalized-import",
                sourceConversationKey: record.stableKey,
              },
            },
            create: {
              id: stableUuid(
                input.archiveId,
                `${ownedAccountId}:source-conversation:${record.stableKey}`,
              ),
              archiveId: input.archiveId,
              ownedAccountId,
              unifiedConversationId: existing.id,
              sourceNamespace: "normalized-import",
              sourceConversationKey: record.stableKey,
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
            sourceConversationKey: record.stableKey,
            sourceEntityKey: record.stableKey,
            logicalEntityKey: stableKey,
            observationKey: record.stableKey,
            value: record,
            observedAt: input.observedAt,
          });
        }
      }
      for (const record of input.records) {
        if (record.kind === "participant") {
          const conversationId = conversations.get(record.conversationKey);
          const sourceConversationId = sourceConversations.get(record.conversationKey);
          const personId = await identityPersonId(
            input.archiveId,
            identities.get(record.identityKey),
            tx,
          );
          if (!conversationId || !sourceConversationId || !personId) continue;
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
      }
      for (const record of input.records) {
        if (record.kind !== "message") continue;
        const conversationId = conversations.get(record.conversationKey);
        const sourceConversationId = sourceConversations.get(record.conversationKey);
        if (!conversationId || !sourceConversationId) continue;
        const senderId = record.senderIdentityKey
          ? await identityPersonId(input.archiveId, identities.get(record.senderIdentityKey), tx)
          : null;
        const sentAt = record.timestamp ? new Date(record.timestamp) : null;
        const stableKey = await messageStableKey(
          tx,
          input.archiveId,
          ownedAccountId,
          sourceConversationId,
          record.stableKey,
        );
        const prior = await tx.message.findUnique({
          where: {
            archiveId_stableKey: { archiveId: input.archiveId, stableKey },
          },
          select: { metadata: true },
        });
        const existing = await tx.message.upsert({
          where: {
            archiveId_stableKey: { archiveId: input.archiveId, stableKey },
          },
          create: {
            id: stableUuid(input.archiveId, stableKey),
            archiveId: input.archiveId,
            conversationId,
            sourceConversationId,
            senderId,
            stableKey,
            sourceType: record.source.namespace,
            sourceKey: record.source.value,
            messageType: record.messageKind,
            body: record.body,
            metadata: json({
              direction: record.direction,
              bodyState: record.bodyState,
              ...(record.metadata ?? {}),
              ...(record.unsupportedTypeCode === undefined
                ? {}
                : { unsupportedTypeCode: record.unsupportedTypeCode }),
              firstSeenSnapshotId: input.snapshotId,
              lastSeenSnapshotId: input.snapshotId,
            }),
            sentAt,
            firstSeenAt: input.observedAt,
            lastSeenAt: input.observedAt,
          },
          update: {
            senderId,
            body: record.body,
            messageType: record.messageKind,
            lastSeenAt: input.observedAt,
            metadata: json({
              ...(asObject(prior?.metadata) ?? {}),
              direction: record.direction,
              bodyState: record.bodyState,
              ...(record.metadata ?? {}),
              ...mergeSnapshotProvenance(prior?.metadata, input.snapshotId),
            }),
          },
        });
        messages.set(record.stableKey, existing.id);
        await upsertObservation(tx.messageObservation, {
          archiveId: input.archiveId,
          ownedAccountId,
          sourceId: job.sourceId,
          snapshotId: input.snapshotId,
          importJobId: input.importJobId,
          sourceConversationId,
          sourceConversationKey: record.conversationKey,
          sourceEntityKey: record.stableKey,
          logicalEntityKey: stableKey,
          observationKey: record.stableKey,
          messageId: existing.id,
          value: record,
          observedAt: input.observedAt,
        });
      }
      for (const record of input.records) {
        if (record.kind === "message" && record.replyToKey) {
          const id = messages.get(record.stableKey),
            replyToId = messages.get(record.replyToKey);
          if (id && replyToId)
            await tx.message.update({
              where: { archiveId_id: { archiveId: input.archiveId, id } },
              data: { replyToId },
            });
        }
        if (record.kind === "revision") {
          const messageId = messages.get(record.messageKey);
          if (!messageId) continue;
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
              id: stableUuid(input.archiveId, record.stableKey),
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
            },
            update: {
              observedAt: input.observedAt,
              metadata: json({ ...(asObject(priorRevision?.metadata) ?? {}) }),
            },
          });
          const messageRecord = input.records.find(
            (candidate): candidate is ImportMessageRecord =>
              candidate.kind === "message" && candidate.stableKey === record.messageKey,
          );
          const revisionSourceConversationId = messageRecord
            ? sourceConversations.get(messageRecord.conversationKey)
            : undefined;
          if (revisionSourceConversationId)
            await upsertObservation(tx.revisionObservation, {
              archiveId: input.archiveId,
              ownedAccountId,
              sourceId: job.sourceId,
              snapshotId: input.snapshotId,
              importJobId: input.importJobId,
              sourceConversationId: revisionSourceConversationId,
              sourceConversationKey: messageRecord?.conversationKey ?? "unknown",
              sourceEntityKey: record.stableKey,
              logicalEntityKey: record.stableKey,
              observationKey: record.stableKey,
              revisionId: revision.id,
              value: record,
              observedAt: input.observedAt,
            });
        }
      }
      for (const record of input.records) {
        if (record.kind !== "attachment") continue;
        const messageId = messages.get(record.messageKey);
        if (!messageId) continue;
        const messageRecord = input.records.find(
          (candidate): candidate is ImportMessageRecord =>
            candidate.kind === "message" && candidate.stableKey === record.messageKey,
        );
        const sourceConversationId = messageRecord
          ? sourceConversations.get(messageRecord.conversationKey)
          : undefined;
        const link = await importAttachment(
          tx,
          input.archiveId,
          input.observedAt,
          messageId,
          record,
        );
        if (sourceConversationId)
          await upsertObservation(tx.attachmentReferenceObservation, {
            archiveId: input.archiveId,
            ownedAccountId,
            sourceId: job.sourceId,
            snapshotId: input.snapshotId,
            importJobId: input.importJobId,
            sourceConversationId,
            sourceConversationKey: messageRecord?.conversationKey ?? "unknown",
            sourceEntityKey: record.stableKey,
            logicalEntityKey: record.stableKey,
            observationKey: record.stableKey,
            messageAttachmentId: link.id,
            value: record,
            observedAt: input.observedAt,
          });
      }
      await tx.snapshot.update({
        where: { archiveId_id: { archiveId: input.archiveId, id: input.snapshotId } },
        data: { lifecycle: "completed", completedAt: input.observedAt },
      });
      await tx.importJob.update({
        where: { archiveId_id: { archiveId: input.archiveId, id: input.importJobId } },
        data: { status: "completed", finishedAt: input.observedAt },
      });
      return { imported: input.records.length };
    });
  }
}

async function importAttachment(
  tx: Tx,
  archiveId: string,
  observedAt: Date,
  messageId: string,
  record: ImportAttachmentRecord,
): Promise<{ readonly id: string }> {
  const byStableKey = await tx.attachment.findFirst({
    where: { archiveId, stableKey: record.stableKey },
  });
  const byHash = await tx.attachment.findUnique({
    where: { archiveId_sha256: { archiveId, sha256: record.sha256 } },
  });
  const prior = byStableKey ?? byHash;
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
  await tx.messageAttachment.upsert({
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
    },
    update: {
      ordinal: record.ordinal,
      role: record.role,
      ...(record.metadata ? { metadata: json(record.metadata) } : {}),
    },
  });
  return { id: attachment.id };
}

function attachmentMetadata(
  record: ImportAttachmentRecord,
  observedAt: Date,
  prior?: { readonly originalName: string | null; readonly originalPath: string | null },
): Prisma.AttachmentUpdateInput {
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
  readonly sourceConversationKey: string;
  readonly sourceEntityKey: string;
  readonly logicalEntityKey: string;
  readonly observationKey: string;
  readonly value: unknown;
  readonly observedAt: Date;
  readonly messageId?: string;
  readonly revisionId?: string;
  readonly messageAttachmentId?: string;
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
        observationKind: "value",
        sourceConversationId: input.sourceConversationId,
        sourceEntityKey: input.sourceEntityKey,
        observationKey: input.observationKey,
      },
    },
    create: {
      ...fields,
      ...target,
      observationKind: "value",
      eligibility: "eligible",
      valueDigest: digest,
    },
    update: { ...target, valueDigest: digest, observedAt: input.observedAt },
  } as never);
}

async function conversationStableKey(
  tx: Tx,
  archiveId: string,
  ownedAccountId: string,
  sourceKey: string,
): Promise<string> {
  const existing = await tx.conversation.findUnique({
    where: { archiveId_stableKey: { archiveId, stableKey: sourceKey } },
    include: { sourceConversations: { select: { ownedAccountId: true } } },
  });
  return existing &&
    existing.sourceConversations.some((row) => row.ownedAccountId !== ownedAccountId)
    ? `${ownedAccountId}:${sourceKey}`
    : sourceKey;
}

async function messageStableKey(
  tx: Tx,
  archiveId: string,
  ownedAccountId: string,
  sourceConversationId: string,
  sourceKey: string,
): Promise<string> {
  const existing = await tx.message.findUnique({
    where: { archiveId_stableKey: { archiveId, stableKey: sourceKey } },
    select: { sourceConversation: { select: { ownedAccountId: true } } },
  });
  return existing?.sourceConversation?.ownedAccountId !== undefined &&
    existing.sourceConversation.ownedAccountId !== ownedAccountId
    ? `${ownedAccountId}:${sourceConversationId}:${sourceKey}`
    : sourceKey;
}
