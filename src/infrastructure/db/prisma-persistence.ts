import { PrismaClient } from "@prisma/client";
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
  ConversationPersistenceRow,
  MessagePersistenceRow,
  PersonPersistenceRow,
} from "../../application/reads.js";

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
      include: { _count: { select: { attachments: true } } },
    });
    return (
      rows as Array<{
        id: string;
        conversationId: string;
        senderId: string | null;
        sentAt: Date | null;
        body: string | null;
        _count: { attachments: number };
      }>
    ).map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      senderPersonId: row.senderId ?? undefined,
      sentAt: iso(row.sentAt),
      text: row.body ?? undefined,
      attachmentCount: row._count.attachments,
    }));
  }
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
