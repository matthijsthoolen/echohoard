import { PrismaClient } from "@prisma/client";
import type {
  ArchiveScopedPort,
  PersistencePorts,
  PersistenceRecord,
  PersistenceInput,
} from "../../application/persistence.js";

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
