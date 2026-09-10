import { Prisma, PrismaClient } from "@prisma/client";
import type {
  ArchiveScopedPort,
  PersistencePorts,
  PersistenceRecord,
  PersistenceInput,
} from "../../application/persistence.js";
import type {
  ReadConversationPersistenceQuery,
  ReadMessagePersistenceQuery,
  ReadPersistencePort,
  ReadPersonPersistenceQuery,
  ReadSearchPersistenceQuery,
  ConversationPersistenceRow,
  MessagePersistenceRow,
  PersonPersistenceRow,
  SearchPersistenceRow,
} from "../../application/reads.js";
import type {
  HealthJobPersistenceRow,
  HealthPersistenceEvidence,
  HealthReadPersistencePort,
  HealthSnapshotPersistenceRow,
} from "../../application/health-reads.js";

type Delegate = {
  findUnique(args: never): Promise<unknown>;
  findMany(args: never): Promise<unknown>;
  create(args: never): Promise<unknown>;
};

const asRecord = (value: unknown): PersistenceRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Persistence adapter returned a non-record");
  return value as PersistenceRecord;
};

class PrismaArchiveScopedAdapter implements ArchiveScopedPort {
  public constructor(
    private readonly delegate: Delegate,
    private readonly archiveField: string,
    private readonly createField: string | null = archiveField,
  ) {}

  public async findById(archiveId: string, id: string): Promise<PersistenceRecord | null> {
    if (this.archiveField === "id") {
      const value = await this.delegate.findUnique({ where: { id } } as never);
      return value === null ? null : asRecord(value);
    }
    const value = await this.delegate.findUnique({
      where: { archiveId_id: { archiveId, id } },
    } as never);
    return value === null ? null : asRecord(value);
  }

  public async list(archiveId: string): Promise<readonly PersistenceRecord[]> {
    const value = await this.delegate.findMany({
      where: { [this.archiveField]: archiveId },
    } as never);
    if (!Array.isArray(value)) throw new Error("Persistence adapter returned a non-list");
    return value.map(asRecord);
  }

  public async create(archiveId: string, input: PersistenceInput): Promise<PersistenceRecord> {
    const value = await this.delegate.create({
      data: this.createField ? { ...input, [this.createField]: archiveId } : input,
    } as never);
    return asRecord(value);
  }
}

export const createPrismaPersistence = (prisma: PrismaClient): PersistencePorts => {
  const scoped = (delegate: Delegate, field = "archiveId", createField: string | null = field) =>
    new PrismaArchiveScopedAdapter(delegate, field, createField);
  return {
    users: scoped(prisma.user as unknown as Delegate, "id"),
    archives: scoped(prisma.archive as unknown as Delegate, "id", null),
    sources: scoped(prisma.source as unknown as Delegate),
    snapshots: scoped(prisma.snapshot as unknown as Delegate),
    importJobs: scoped(prisma.importJob as unknown as Delegate),
    people: scoped(prisma.person as unknown as Delegate),
    identities: scoped(prisma.identity as unknown as Delegate),
    conversations: scoped(prisma.conversation as unknown as Delegate),
    messages: scoped(prisma.message as unknown as Delegate),
    revisions: scoped(prisma.messageRevision as unknown as Delegate),
    reactions: scoped(prisma.reaction as unknown as Delegate),
    attachments: scoped(prisma.attachment as unknown as Delegate),
    messageAttachments: scoped(prisma.messageAttachment as unknown as Delegate),
  };
};

type ReadDelegate = {
  findMany(args: unknown): Promise<unknown>;
};

const iso = (value: Date | null | undefined): string | undefined => value?.toISOString();

/** Efficient, archive-scoped read adapter. Each method performs one SQL query
 * with relation counts, rather than loading relation graphs per result row. */
export class PrismaReadPersistence implements ReadPersistencePort {
  public constructor(private readonly prisma: PrismaClient) {}

  public async searchMessages(
    input: ReadSearchPersistenceQuery,
  ): Promise<readonly SearchPersistenceRow[]> {
    const after = input.after;
    const afterScore = after?.[0];
    const afterSentAt = after?.[1];
    const afterId = after?.[2];
    const afterPredicate = after
      ? input.direction === "forward"
        ? Prisma.sql`AND ranked.id <> CAST(${afterId} AS uuid)
          AND (
            ranked.score < CAST(${afterScore} AS double precision)
            OR (
              ranked.score = CAST(${afterScore} AS double precision)
              AND (
                ranked.sort_sent_at > CAST(${afterSentAt} AS timestamp)
                OR (ranked.sort_sent_at = CAST(${afterSentAt} AS timestamp) AND ranked.id > CAST(${afterId} AS uuid))
              )
            )
          )`
        : Prisma.sql`AND ranked.id <> CAST(${afterId} AS uuid)
          AND (
            ranked.score > CAST(${afterScore} AS double precision)
            OR (
              ranked.score = CAST(${afterScore} AS double precision)
              AND (
                ranked.sort_sent_at < CAST(${afterSentAt} AS timestamp)
                OR (ranked.sort_sent_at = CAST(${afterSentAt} AS timestamp) AND ranked.id < CAST(${afterId} AS uuid))
              )
            )
          )`
      : Prisma.empty;
    const ordering =
      input.direction === "forward"
        ? Prisma.sql`ranked.score DESC, ranked.sort_sent_at ASC, ranked.id ASC`
        : Prisma.sql`ranked.score ASC, ranked.sort_sent_at DESC, ranked.id DESC`;

    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; score: number; sort_sent_at: Date }>
    >(Prisma.sql`
      WITH ranked AS (
        SELECT
          message.id,
          ts_rank_cd(
            message."searchVector",
            plainto_tsquery('simple'::regconfig, ${input.query})
          )::double precision AS score,
          COALESCE(
            message."sentAt",
            TIMESTAMP '9999-12-31 23:59:59.999'
          ) AS sort_sent_at
        FROM "Message" AS message
        WHERE message."archiveId" = ${input.archiveId}::uuid
          AND message."searchVector" @@ plainto_tsquery('simple'::regconfig, ${input.query})
      )
      SELECT ranked.id, ranked.score, ranked.sort_sent_at
      FROM ranked
      WHERE TRUE
      ${afterPredicate}
      ORDER BY ${ordering}
      LIMIT ${input.limit}
    `);
    return rows.map((row) => ({
      id: row.id,
      score: row.score,
      sortSentAt: row.sort_sent_at.toISOString(),
    }));
  }

  public async listConversations(
    input: ReadConversationPersistenceQuery,
  ): Promise<readonly ConversationPersistenceRow[]> {
    const where = {
      archiveId: input.archiveId,
      ...(input.search
        ? {
            OR: [
              { title: { contains: input.search, mode: "insensitive" } },
              { stableKey: { contains: input.search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...cursorWhere(input.after, input.direction, "createdAt"),
    };
    const rows = await (this.prisma.conversation as unknown as ReadDelegate).findMany({
      where,
      orderBy: [
        { createdAt: input.direction === "backward" ? "desc" : "asc" },
        { id: input.direction === "backward" ? "desc" : "asc" },
      ],
      take: input.limit,
      include: {
        _count: { select: { participants: true } },
        messages: { select: { sentAt: true }, orderBy: { sentAt: "desc" }, take: 1 },
      },
    });
    return (
      rows as Array<{
        id: string;
        title: string | null;
        createdAt: Date;
        _count: { participants: number };
        messages: Array<{ sentAt: Date | null }>;
      }>
    ).map((row) => ({
      id: row.id,
      title: row.title ?? undefined,
      createdAt: row.createdAt.toISOString(),
      participantCount: row._count.participants,
      lastMessageAt: iso(row.messages[0]?.sentAt),
    }));
  }

  public async listPeople(
    input: ReadPersonPersistenceQuery,
  ): Promise<readonly PersonPersistenceRow[]> {
    const where = {
      archiveId: input.archiveId,
      ...(input.search ? { displayName: { contains: input.search, mode: "insensitive" } } : {}),
      ...cursorWhere(input.after, input.direction, "displayName"),
    };
    const rows = await (this.prisma.person as unknown as ReadDelegate).findMany({
      where,
      orderBy: [
        { displayName: input.direction === "backward" ? "desc" : "asc" },
        { id: input.direction === "backward" ? "desc" : "asc" },
      ],
      take: input.limit,
      include: { _count: { select: { identities: true } } },
    });
    return (
      rows as Array<{ id: string; displayName: string | null; _count: { identities: number } }>
    ).map((row) => ({
      id: row.id,
      displayName: row.displayName ?? undefined,
      identityCount: row._count.identities,
    }));
  }

  public async listMessages(
    input: ReadMessagePersistenceQuery,
  ): Promise<readonly MessagePersistenceRow[]> {
    const rows = await (this.prisma.message as unknown as ReadDelegate).findMany({
      where: {
        archiveId: input.archiveId,
        conversationId: input.conversationId,
        ...cursorWhere(input.after, input.direction, "sentAt"),
      },
      orderBy: [
        { sentAt: input.direction === "backward" ? "desc" : "asc" },
        { id: input.direction === "backward" ? "desc" : "asc" },
      ],
      take: input.limit,
      include: {
        _count: { select: { attachments: true } },
        replyTo: { select: { id: true, sentAt: true, body: true } },
        revisions: {
          select: { id: true, firstSeenAt: true, body: true },
          orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
        },
        reactions: {
          select: { id: true, personId: true, emoji: true },
          orderBy: [{ id: "asc" }],
        },
      },
    });
    return (
      rows as Array<{
        id: string;
        conversationId: string;
        senderId: string | null;
        messageType: string;
        metadata: unknown;
        sentAt: Date | null;
        body: string | null;
        _count: { attachments: number };
        replyTo: { id: string; sentAt: Date | null; body: string | null } | null;
        revisions: Array<{ id: string; firstSeenAt: Date; body: string | null }>;
        reactions: Array<{ id: string; personId: string; emoji: string }>;
      }>
    ).map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      senderPersonId: row.senderId ?? undefined,
      sentAt: iso(row.sentAt),
      text: row.body ?? undefined,
      attachmentCount: row._count.attachments,
      direction: messageDirection(row.metadata),
      messageType: row.messageType,
      ...(row.replyTo
        ? {
            replyTo: {
              id: row.replyTo.id,
              ...(row.replyTo.sentAt ? { sentAt: row.replyTo.sentAt.toISOString() } : {}),
              ...(row.replyTo.body !== null ? { text: row.replyTo.body } : {}),
            },
          }
        : {}),
      revisions: row.revisions.map((revision) => ({
        id: revision.id,
        firstSeenAt: revision.firstSeenAt.toISOString(),
        ...(revision.body !== null ? { text: revision.body } : {}),
      })),
      reactions: row.reactions.map((reaction) => ({
        id: reaction.id,
        personId: reaction.personId,
        emoji: reaction.emoji,
      })),
    }));
  }

}

/** One bounded, archive-scoped aggregate read for the private health surface.
 * Counts are read from normalized rows that are only published by the
 * transactional snapshot importer; failed/in-progress jobs therefore never
 * become health counts. Raw SQL is limited to grouped media/type aggregates
 * and remains parameterized through Prisma.sql. */
export class PrismaHealthReadPersistence implements HealthReadPersistencePort {
  public constructor(private readonly prisma: PrismaClient) {}

  public async getHealthEvidence(input: {
    readonly archiveId: string;
    readonly jobLimit: number;
  }): Promise<HealthPersistenceEvidence> {
    const snapshotDelegate = this.prisma.snapshot as unknown as {
      findMany(args: unknown): Promise<unknown>;
    };
    const jobDelegate = this.prisma.importJob as unknown as {
      findMany(args: unknown): Promise<unknown>;
    };
    const messageDelegate = this.prisma.message as unknown as {
      findMany(args: unknown): Promise<unknown>;
      count(args: unknown): Promise<number>;
    };
    const conversationDelegate = this.prisma.conversation as unknown as {
      count(args: unknown): Promise<number>;
    };
    const personDelegate = this.prisma.person as unknown as {
      count(args: unknown): Promise<number>;
    };

    const [discoveredRows, completedRows, messageRows, jobs, messages, conversations, people, mediaRows, unsupportedRows] =
      await Promise.all([
        snapshotDelegate.findMany({
          where: { archiveId: input.archiveId },
          orderBy: { capturedAt: "desc" },
          take: 1,
          select: { id: true, lifecycle: true, capturedAt: true, completedAt: true },
        }),
        snapshotDelegate.findMany({
          where: { archiveId: input.archiveId, lifecycle: "completed", completedAt: { not: null } },
          orderBy: { completedAt: "desc" },
          take: 1,
          select: { id: true, lifecycle: true, capturedAt: true, completedAt: true },
        }),
        messageDelegate.findMany({
          where: { archiveId: input.archiveId, sentAt: { not: null } },
          orderBy: [{ sentAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { sentAt: true },
        }),
        jobDelegate.findMany({
          where: { archiveId: input.archiveId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: input.jobLimit,
          select: {
            id: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            createdAt: true,
            errorClass: true,
          },
        }),
        messageDelegate.count({ where: { archiveId: input.archiveId } }),
        conversationDelegate.count({ where: { archiveId: input.archiveId } }),
        personDelegate.count({ where: { archiveId: input.archiveId } }),
        this.prisma.$queryRaw<Array<{ availability: string; referenced: bigint | number }>>(Prisma.sql`
          SELECT a.availability, COUNT(DISTINCT ma."attachmentId")::bigint AS referenced
          FROM "MessageAttachment" ma
          JOIN "Attachment" a
            ON a.id = ma."attachmentId" AND a."archiveId" = ma."archiveId"
          WHERE ma."archiveId" = ${input.archiveId}::uuid
          GROUP BY a.availability
        `),
        this.prisma.$queryRaw<Array<{ type: string; count: bigint | number }>>(Prisma.sql`
          SELECT COALESCE(m.metadata->>'unsupportedTypeCode', 'unknown') AS type,
                 COUNT(*)::bigint AS count
          FROM "Message" m
          WHERE m."archiveId" = ${input.archiveId}::uuid AND m."messageType" = 'unsupported'
          GROUP BY COALESCE(m.metadata->>'unsupportedTypeCode', 'unknown')
          ORDER BY type ASC
        `),
      ]);

    const snapshots = asHealthSnapshots(discoveredRows);
    const completedSnapshots = asHealthSnapshots(completedRows);
    const messageResult = asHealthMessages(messageRows);
    const media = { referenced: 0, available: 0, missing: 0, unsafe: 0, unresolved: 0 };
    for (const row of mediaRows) {
      const count = countValue(row.referenced);
      media.referenced += count;
      if (row.availability === "available") media.available += count;
      else if (row.availability === "missing") media.missing += count;
      else if (row.availability === "unsafe") media.unsafe += count;
      else if (row.availability === "unresolved") media.unresolved += count;
    }
    return {
      latestDiscoveredSnapshot: snapshots[0],
      latestCompletedSnapshot: completedSnapshots[0],
      latestMessageAt: messageResult[0]?.sentAt,
      jobs: asHealthJobs(jobs),
      counts: { messages, conversations, people },
      media,
      unsupportedTypes: unsupportedRows.map((row) => ({ type: row.type, count: countValue(row.count) })),
    };
  }
}

/** Compatibility alias for compositions that name persistence by its
 * aggregate rather than its delivery concern. */
export const PrismaArchiveHealthPersistence = PrismaHealthReadPersistence;

function asHealthSnapshots(value: unknown): HealthSnapshotPersistenceRow[] {
  if (!Array.isArray(value)) return [];
  return (
    value as Array<{ id: string; lifecycle: string; capturedAt: Date; completedAt: Date | null }>
  ).map((row) => ({
    id: row.id,
    lifecycle: row.lifecycle,
    capturedAt: row.capturedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
  }));
}

function asHealthMessages(value: unknown): Array<{ readonly sentAt?: Date }> {
  if (!Array.isArray(value)) return [];
  return (value as Array<{ sentAt: Date | null }>).map((row) => ({
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
  }));
}

function asHealthJobs(value: unknown): HealthJobPersistenceRow[] {
  if (!Array.isArray(value)) return [];
  return (
    value as Array<{
      id: string;
      status: string;
      startedAt: Date | null;
      finishedAt: Date | null;
      createdAt: Date;
      errorClass: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    ...(row.errorClass ? { errorClass: row.errorClass } : {}),
  }));
}

function countValue(value: bigint | number): number {
  if (typeof value === "bigint")
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function messageDirection(metadata: unknown): "sent" | "received" | "unknown" {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return "unknown";
  const direction = (metadata as Record<string, unknown>).direction;
  return direction === "sent" || direction === "received" ? direction : "unknown";
}

function cursorWhere(
  after: readonly (string | number)[] | undefined,
  direction: "forward" | "backward",
  field: "createdAt" | "displayName" | "sentAt",
): Record<string, unknown> {
  if (!after) return {};
  const [value, id] = after;
  if (typeof id !== "string" || (typeof value !== "string" && typeof value !== "number"))
    throw new Error("Invalid read cursor position");
  const op = direction === "backward" ? "lt" : "gt";
  return {
    OR: [
      { [field]: { [op]: field === "displayName" ? value : new Date(String(value)) } },
      { [field]: value, id: { [op]: id } },
    ],
  };
}
