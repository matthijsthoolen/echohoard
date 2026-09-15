import type {
  ConversationPrivacyAudit,
  ConversationPrivacyPolicy,
  UpdateConversationPrivacyRequest,
} from "./conversation-privacy.js";

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
export interface OwnedAccountPort extends ArchiveScopedPort {}
export interface SourcePort extends ArchiveScopedPort {}
export interface SnapshotPort extends ArchiveScopedPort {}
export interface ImportJobPort extends ArchiveScopedPort {}
export interface PersonPort extends ArchiveScopedPort {}
export interface IdentityPort extends ArchiveScopedPort {}
export interface ConversationPort extends ArchiveScopedPort {}
export interface ConversationPrivacyPort {
  list(archiveId: ArchiveId): Promise<readonly ConversationPrivacyPolicy[]>;
  findPolicy(
    archiveId: ArchiveId,
    conversationId: string,
  ): Promise<ConversationPrivacyPolicy | null>;
  updatePolicy(request: UpdateConversationPrivacyRequest): Promise<{
    readonly policy: ConversationPrivacyPolicy;
    readonly audit: readonly ConversationPrivacyAudit[];
  }>;
}
export interface UnifiedConversationPort extends ArchiveScopedPort {}
export interface SourceConversationPort extends ArchiveScopedPort {}
export interface MessagePort extends ArchiveScopedPort {}
export interface RevisionPort extends ArchiveScopedPort {}
export interface ReactionPort extends ArchiveScopedPort {}
export interface AttachmentPort extends ArchiveScopedPort {}
export interface MessageAttachmentPort extends ArchiveScopedPort {}
export interface TranscriptPort extends ArchiveScopedPort {}
export interface TranscriptionRequestPort extends ArchiveScopedPort {}
export interface TranscriptionRunPort extends ArchiveScopedPort {}
export interface TranscriptVersionPort extends ArchiveScopedPort {}

export interface ObservationPort extends ArchiveScopedPort {
  /** Return a bounded provenance page for one typed normalized entity. */
  listForEntity(
    archiveId: ArchiveId,
    entityId: string,
    limit: number,
  ): Promise<readonly PersistenceRecord[]>;
}

export interface PersistencePorts {
  users: UserPort;
  archives: ArchivePort;
  ownedAccounts: OwnedAccountPort;
  sources: SourcePort;
  snapshots: SnapshotPort;
  importJobs: ImportJobPort;
  people: PersonPort;
  identities: IdentityPort;
  conversations: ConversationPort;
  conversationPrivacy: ConversationPrivacyPort;
  unifiedConversations: UnifiedConversationPort;
  sourceConversations: SourceConversationPort;
  messages: MessagePort;
  revisions: RevisionPort;
  reactions: ReactionPort;
  attachments: AttachmentPort;
  messageAttachments: MessageAttachmentPort;
  transcripts: TranscriptPort;
  transcriptionRequests: TranscriptionRequestPort;
  transcriptionRuns: TranscriptionRunPort;
  transcriptVersions: TranscriptVersionPort;
  conversationObservations: ObservationPort;
  messageObservations: ObservationPort;
  revisionObservations: ObservationPort;
  reactionObservations: ObservationPort;
  attachmentReferenceObservations: ObservationPort;
}
