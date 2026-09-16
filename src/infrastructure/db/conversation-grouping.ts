import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type {
  ConversationGroupingPersistence,
  ConversationGroupingRequest,
  ConversationGroupingResult,
} from "../../application/conversation-grouping.js";

type PreviousGroups = Record<string, string>;

/** PostgreSQL implementation of the owner-only presentation grouping commands. */
export class PrismaConversationGroupingPersistence implements ConversationGroupingPersistence {
  public constructor(private readonly prisma: PrismaClient) {}

  public merge(request: ConversationGroupingRequest): Promise<ConversationGroupingResult> {
    return this.run(request, "merge");
  }

  public unmerge(request: ConversationGroupingRequest): Promise<ConversationGroupingResult> {
    return this.run(request, "unmerge");
  }

  public async getState(archiveId: string, targetConversationId: string) {
    const target = await this.prisma.conversation.findUnique({
      where: { archiveId_id: { archiveId, id: targetConversationId } },
      select: { id: true, groupingVersion: true },
    });
    if (!target) throw new Error("target conversation is not in the archive");
    const sources = await this.prisma.sourceConversation.findMany({
      where: { archiveId },
      select: {
        id: true,
        unifiedConversationId: true,
        sourceNamespace: true,
        sourceConversationKey: true,
        ownedAccount: { select: { displayLabel: true, accountKey: true } },
      },
      orderBy: [{ sourceConversationKey: "asc" }, { id: "asc" }],
    });
    const currentSourceIds = sources
      .filter((source) => source.unifiedConversationId === target.id)
      .map((source) => source.id)
      .sort();
    const latestMerge = await this.prisma.conversationMergeAudit.findFirst({
      where: { archiveId, targetConversationId: target.id, action: "merge" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, sourceConversationIds: true },
    });
    const mergeSourceIds = latestMerge ? asStringArray(latestMerge.sourceConversationIds) : [];
    const activeMerge = mergeSourceIds.every((id) => currentSourceIds.includes(id));
    return {
      targetConversationId: target.id,
      version: target.groupingVersion,
      sources: sources.map((source) => ({
        id: source.id,
        title: source.sourceConversationKey,
        accountLabel: source.ownedAccount.displayLabel ?? source.ownedAccount.accountKey,
        sourceNamespace: source.sourceNamespace,
        sourceConversationKey: source.sourceConversationKey,
        unifiedConversationId: source.unifiedConversationId,
      })),
      currentSourceIds,
      mergeSourceIds: activeMerge ? mergeSourceIds : [],
      ...(activeMerge && latestMerge ? { mergeAuditId: latestMerge.id } : {}),
    };
  }

  private async run(
    request: ConversationGroupingRequest,
    action: "merge" | "unmerge",
  ): Promise<ConversationGroupingResult> {
    const existing = await this.prisma.conversationMergeAudit.findUnique({
      where: {
        archiveId_idempotencyKey: {
          archiveId: request.archiveId,
          idempotencyKey: request.idempotencyKey,
        },
      },
    });
    if (existing) return resultFromAudit(existing, request, action);

    return this.prisma.$transaction(async (tx) => {
      const ids = [...new Set(request.sourceConversationIds)].sort();
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM "Conversation"
        WHERE "archiveId" = ${request.archiveId}::uuid
          AND id IN (${Prisma.join([request.targetConversationId, ...ids].map((id) => Prisma.sql`${id}::uuid`))})
        FOR UPDATE
      `);
      const target = await tx.conversation.findUnique({
        where: { archiveId_id: { archiveId: request.archiveId, id: request.targetConversationId } },
      });
      if (!target) throw new Error("target conversation is not in the archive");
      if (target.groupingLocked) throw new Error("conversation grouping is locked");
      if (target.groupingVersion !== request.expectedVersion)
        throw new Error("stale grouping version");

      const sources = await tx.sourceConversation.findMany({
        where: { archiveId: request.archiveId, id: { in: ids } },
        select: { id: true, unifiedConversationId: true },
      });
      if (sources.length !== ids.length)
        throw new Error("a source conversation is not in the archive");
      const previousGroups = Object.fromEntries(
        sources.map((source) => [source.id, source.unifiedConversationId]),
      );

      if (action === "unmerge") {
        if (!request.auditId) throw new Error("auditId is required for unmerge");
        const merge = await tx.conversationMergeAudit.findFirst({
          where: { archiveId: request.archiveId, id: request.auditId, action: "merge" },
        });
        if (!merge || merge.targetConversationId !== target.id)
          throw new Error("merge audit is not valid");
        if (!sameIds(asStringArray(merge.sourceConversationIds), ids))
          throw new Error("unmerge source selection does not match the merge audit");
        const recorded = asPreviousGroups(merge.previousGroups);
        for (const source of sources) {
          if (source.unifiedConversationId !== target.id)
            throw new Error("source is no longer in merge group");
          await tx.sourceConversation.update({
            where: { archiveId_id: { archiveId: request.archiveId, id: source.id } },
            data: { unifiedConversationId: recorded[source.id] },
          });
        }
      } else {
        for (const source of sources) {
          if (source.unifiedConversationId !== target.id)
            await tx.sourceConversation.update({
              where: { archiveId_id: { archiveId: request.archiveId, id: source.id } },
              data: { unifiedConversationId: target.id },
            });
        }
      }

      const version = target.groupingVersion + 1;
      await tx.conversation.update({
        where: { archiveId_id: { archiveId: request.archiveId, id: target.id } },
        data: {
          groupingVersion: version,
          ...(action === "merge" &&
          (request.ownerTitle !== undefined || request.ownerAvatar !== undefined)
            ? { ownerTitle: request.ownerTitle, ownerAvatar: request.ownerAvatar }
            : {}),
        },
      });
      const audit = await tx.conversationMergeAudit.create({
        data: {
          id: randomUUID(),
          archiveId: request.archiveId,
          targetConversationId: target.id,
          action,
          sourceConversationIds: ids,
          previousGroups,
          resultingVersion: version,
          expectedVersion: request.expectedVersion,
          actor: request.actor,
          reason: request.reason,
          idempotencyKey: request.idempotencyKey,
          metadata: { requestedAt: (request.requestedAt ?? new Date()).toISOString() },
        },
      });
      return { ...resultFromAudit(audit, request, action), idempotent: false };
    });
  }
}

function resultFromAudit(
  audit: {
    id: string;
    archiveId: string;
    targetConversationId: string;
    action: string;
    sourceConversationIds: Prisma.JsonValue;
    resultingVersion: number;
  },
  request: ConversationGroupingRequest,
  expectedAction: "merge" | "unmerge",
): ConversationGroupingResult {
  if (audit.action !== expectedAction)
    throw new Error("idempotency key belongs to another grouping action");
  if (
    audit.targetConversationId !== request.targetConversationId ||
    !sameIds(asStringArray(audit.sourceConversationIds), [...request.sourceConversationIds].sort())
  )
    throw new Error("idempotency key belongs to another grouping command");
  return {
    archiveId: audit.archiveId,
    targetConversationId: audit.targetConversationId,
    action: expectedAction,
    sourceConversationIds: asStringArray(audit.sourceConversationIds),
    version: audit.resultingVersion,
    auditId: audit.id,
    idempotent: true,
  };
}

function asStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string"))
    throw new Error("invalid grouping audit metadata");
  return [...value].sort();
}

function asPreviousGroups(value: Prisma.JsonValue): PreviousGroups {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid grouping audit metadata");
  const entries = Object.entries(value);
  if (!entries.every(([, group]) => typeof group === "string"))
    throw new Error("invalid grouping audit metadata");
  return Object.fromEntries(entries) as PreviousGroups;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
