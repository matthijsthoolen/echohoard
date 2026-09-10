/** Values crossing the application/infrastructure boundary are deliberately
 * plain objects; ORM-generated types must not become application contracts. */
export type ArchiveId = string;
export type PersistenceRecord = Readonly<Record<string, unknown>>;
export type PersistenceInput = Record<string, unknown>;

export interface ArchiveScopedPort<T extends PersistenceRecord = PersistenceRecord> {
  findById(archiveId: ArchiveId, id: string): Promise<T | null>;
  list(archiveId: ArchiveId): Promise<readonly T[]>;
  create(archiveId: ArchiveId, input: PersistenceInput): Promise<T>;
}

export interface UserPort extends ArchiveScopedPort {}
export interface ArchivePort extends ArchiveScopedPort {}
export interface SourcePort extends ArchiveScopedPort {}
export interface SnapshotPort extends ArchiveScopedPort {}
export interface ImportJobPort extends ArchiveScopedPort {}
export interface PersonPort extends ArchiveScopedPort {}
export interface IdentityPort extends ArchiveScopedPort {}
export interface ConversationPort extends ArchiveScopedPort {}
export interface MessagePort extends ArchiveScopedPort {}
export interface RevisionPort extends ArchiveScopedPort {}
export interface ReactionPort extends ArchiveScopedPort {}
export interface AttachmentPort extends ArchiveScopedPort {}
export interface MessageAttachmentPort extends ArchiveScopedPort {}

export interface PersistencePorts {
  users: UserPort;
  archives: ArchivePort;
  sources: SourcePort;
  snapshots: SnapshotPort;
  importJobs: ImportJobPort;
  people: PersonPort;
  identities: IdentityPort;
  conversations: ConversationPort;
  messages: MessagePort;
  revisions: RevisionPort;
  reactions: ReactionPort;
  attachments: AttachmentPort;
  messageAttachments: MessageAttachmentPort;
}
