import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import type {
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
      const messages = new Map<string, string>();
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
          const existing = await tx.conversation.upsert({
            where: {
              archiveId_stableKey: { archiveId: input.archiveId, stableKey: record.stableKey },
            },
            create: {
              id: stableUuid(input.archiveId, record.stableKey),
              archiveId: input.archiveId,
              kind: record.conversationKind,
              stableKey: record.stableKey,
              title: record.title,
            },
            update: { kind: record.conversationKind, title: record.title },
          });
          conversations.set(record.stableKey, existing.id);
        }
      }
      for (const record of input.records) {
        if (record.kind === "participant") {
          const conversationId = conversations.get(record.conversationKey);
          const personId = await identityPersonId(
            input.archiveId,
            identities.get(record.identityKey),
            tx,
          );
          if (!conversationId || !personId) continue;
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
        if (!conversationId) continue;
        const senderId = record.senderIdentityKey
          ? await identityPersonId(input.archiveId, identities.get(record.senderIdentityKey), tx)
          : null;
        const sentAt = record.timestamp ? new Date(record.timestamp) : null;
        const prior = await tx.message.findUnique({
          where: {
            archiveId_stableKey: { archiveId: input.archiveId, stableKey: record.stableKey },
          },
          select: { metadata: true },
        });
        const existing = await tx.message.upsert({
          where: {
            archiveId_stableKey: { archiveId: input.archiveId, stableKey: record.stableKey },
          },
          create: {
            id: stableUuid(input.archiveId, record.stableKey),
            archiveId: input.archiveId,
            conversationId,
            senderId,
            stableKey: record.stableKey,
            sourceType: record.source.namespace,
            sourceKey: record.source.value,
            messageType: record.messageKind,
            body: record.body,
            metadata: json({
              direction: record.direction,
              bodyState: record.bodyState,
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
              ...mergeSnapshotProvenance(prior?.metadata, input.snapshotId),
            }),
          },
        });
        messages.set(record.stableKey, existing.id);
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
          await tx.messageRevision.upsert({
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
        }
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
