import { Prisma, PrismaClient } from "@prisma/client";
import {
  OWNER_DELETION_POLICY_VERSION,
  OwnerDeletionConflictError,
  type OwnerDeletionEntity,
  type OwnerDeletionPersistence,
  type OwnerDeletionRequest,
  type OwnerDeletionResult,
} from "../../application/owner-deletion.js";
import { randomUUID } from "node:crypto";

type Db = PrismaClient | Prisma.TransactionClient;
type StateRow = { owner_deleted: boolean; owner_deletion_version: number };
type AuditRow = {
  id: string;
  entity_kind: OwnerDeletionEntity;
  entity_id: string;
  action: "delete" | "restore";
  owner_deleted: boolean;
  resulting_version: number;
  cascade_count: number;
  actor: string;
  reason: string;
};

/** PostgreSQL implementation. It deliberately uses updates only: source
 * observations, normalized rows, and immutable snapshots are never deleted. */
export class PrismaOwnerDeletionPersistence implements OwnerDeletionPersistence {
  public constructor(private readonly prisma: PrismaClient) {}

  public async execute(request: OwnerDeletionRequest): Promise<OwnerDeletionResult> {
    const existing = await this.findAudit(this.prisma, request);
    if (existing) return replayResult(request, existing);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await this.findAudit(tx, request);
        if (replay) return replayResult(request, replay);
        const current = await lockState(tx, request);
        if (!current) throw new Error(`${request.entityKind} is not in archive`);
        if (
          request.expectedVersion !== undefined &&
          request.expectedVersion !== current.owner_deletion_version
        )
          throw new OwnerDeletionConflictError(
            request.entityKind,
            request.entityId,
            request.expectedVersion,
            current.owner_deletion_version,
          );

        const ownerDeleted = request.action === "delete";
        const nextVersion = current.owner_deletion_version + 1;
        const now = request.requestedAt ?? new Date();
        const table = tableFor(request.entityKind);
        await tx.$executeRaw(Prisma.sql`
          UPDATE ${Prisma.raw(table)}
          SET "ownerDeleted" = ${ownerDeleted},
              "ownerDeletedAt" = ${ownerDeleted ? now : null},
              "ownerDeletedBy" = ${ownerDeleted ? request.actor : null},
              "ownerDeletionReason" = ${ownerDeleted ? request.reason : null},
              "ownerDeletionVersion" = ${nextVersion},
              "updatedAt" = ${now}
          WHERE "archiveId" = ${request.archiveId}::uuid AND id = ${request.entityId}::uuid
        `);
        const cascadeCount =
          request.entityKind === "conversation"
            ? await countMessages(tx, request.archiveId, request.entityId)
            : 0;
        const auditId = randomUUID();
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "OwnerDeletionAudit"
            ("id", "archiveId", "entityKind", "entityId", "action", "actor", "reason",
             "idempotencyKey", "policyVersion", "expectedVersion", "resultingVersion", "cascadeCount", "occurredAt")
          VALUES (${auditId}::uuid, ${request.archiveId}::uuid, ${request.entityKind}, ${request.entityId}::uuid,
            ${request.action}, ${request.actor}, ${request.reason}, ${request.idempotencyKey},
            ${OWNER_DELETION_POLICY_VERSION}, ${request.expectedVersion ?? null}, ${nextVersion}, ${cascadeCount}, ${now})
        `);
        return {
          archiveId: request.archiveId,
          entityKind: request.entityKind,
          entityId: request.entityId,
          action: request.action,
          ownerDeleted,
          version: nextVersion,
          cascadeCount,
          idempotent: false,
          auditId,
          policyVersion: OWNER_DELETION_POLICY_VERSION,
        };
      });
    } catch (error) {
      const replay = await this.findAudit(this.prisma, request);
      if (replay) return replayResult(request, replay);
      throw error;
    }
  }

  private async findAudit(db: Db, request: OwnerDeletionRequest): Promise<AuditRow | null> {
    const rows = await db.$queryRaw<AuditRow[]>(Prisma.sql`
      SELECT "id", "entityKind" AS entity_kind, "entityId" AS entity_id, "action",
             ("action" = 'delete') AS owner_deleted, "resultingVersion" AS resulting_version,
             "cascadeCount" AS cascade_count, "actor", "reason"
      FROM "OwnerDeletionAudit"
      WHERE "archiveId" = ${request.archiveId}::uuid AND "idempotencyKey" = ${request.idempotencyKey}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }
}

function replayResult(request: OwnerDeletionRequest, audit: AuditRow): OwnerDeletionResult {
  if (
    audit.entity_kind !== request.entityKind ||
    audit.entity_id !== request.entityId ||
    audit.action !== request.action ||
    audit.actor !== request.actor ||
    audit.reason !== request.reason
  )
    throw new Error("idempotency key already names a different owner deletion command");
  return resultFromAudit(request, audit, true);
}

async function lockState(db: Db, request: OwnerDeletionRequest): Promise<StateRow | null> {
  const rows = await db.$queryRaw<StateRow[]>(Prisma.sql`
    SELECT "ownerDeleted" AS owner_deleted, "ownerDeletionVersion" AS owner_deletion_version
    FROM ${Prisma.raw(tableFor(request.entityKind))}
    WHERE "archiveId" = ${request.archiveId}::uuid AND id = ${request.entityId}::uuid
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function countMessages(db: Db, archiveId: string, conversationId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count FROM "Message"
    WHERE "archiveId" = ${archiveId}::uuid AND "conversationId" = ${conversationId}::uuid
  `);
  return Number(rows[0]?.count ?? 0);
}

function tableFor(kind: OwnerDeletionEntity): string {
  return kind === "conversation"
    ? '"Conversation"'
    : kind === "message"
      ? '"Message"'
      : '"Attachment"';
}

function resultFromAudit(
  request: OwnerDeletionRequest,
  audit: AuditRow,
  idempotent: boolean,
): OwnerDeletionResult {
  return {
    archiveId: request.archiveId,
    entityKind: audit.entity_kind,
    entityId: audit.entity_id,
    action: audit.action,
    ownerDeleted: audit.owner_deleted,
    version: audit.resulting_version,
    cascadeCount: audit.cascade_count,
    idempotent,
    auditId: audit.id,
    policyVersion: OWNER_DELETION_POLICY_VERSION,
  };
}
