export type ImportRecord =
  | ImportPersonRecord
  | ImportIdentityRecord
  | ImportConversationRecord
  | ImportParticipantRecord
  | ImportMessageRecord
  | ImportRevisionRecord
  | ImportAttachmentRecord;
export interface ImportPersonRecord {
  readonly kind: "person";
  readonly stableKey: string;
  readonly displayName?: string;
}
export interface ImportIdentityRecord {
  readonly kind: "identity";
  readonly stableKey: string;
  readonly source: { readonly namespace: string; readonly value: string };
  readonly personKey?: string;
  readonly displayName?: string;
}
export interface ImportConversationRecord {
  readonly kind: "conversation";
  readonly stableKey: string;
  /** Source namespace for the account-specific conversation identity. */
  readonly source?: { readonly namespace: string; readonly value: string };
  readonly conversationKind: string;
  readonly title?: string;
}
export interface ImportParticipantRecord {
  readonly kind: "participant";
  readonly conversationKey: string;
  readonly identityKey: string;
  readonly role: string;
}
export interface ImportMessageRecord {
  readonly kind: "message";
  readonly stableKey: string;
  readonly source: { readonly namespace: string; readonly value: string };
  readonly conversationKey: string;
  readonly senderIdentityKey?: string;
  readonly timestamp: string | null;
  readonly direction: string;
  readonly messageKind: string;
  readonly body?: string;
  readonly bodyState: string;
  /** Bounded, source-neutral rich-message metadata from the adapter. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly replyToKey?: string;
  readonly unsupportedTypeCode?: number;
  readonly sourceDeletion?: ImportSourceDeletion;
}
export interface ImportSourceDeletion {
  readonly kind: "revoke" | "delete";
  readonly eventKey: string;
  readonly observedAt: string | null;
  readonly sourceMetadata?: Readonly<Record<string, string>>;
}
export interface ImportRevisionRecord {
  readonly kind: "revision";
  readonly stableKey: string;
  readonly messageKey: string;
  readonly revisionOrdinal: number;
  readonly body?: string;
  readonly bodyState: string;
  readonly firstSeenSnapshotId: string;
}

export type ImportAttachmentAvailability = "available" | "missing" | "unsafe" | "unresolved";

/** Apply the append-preserving media state policy to one new observation. */
export function reconcileAttachmentAvailability(
  prior: ImportAttachmentAvailability | undefined,
  observed: ImportAttachmentAvailability,
): ImportAttachmentAvailability {
  // A missing observation is never allowed to hide bytes already owned by the
  // archive. Unsafe observations remain explicit until a later available CAS
  // observation is positively verified by the caller.
  if (prior === "available") return "available";
  if (prior === "unsafe" && observed !== "available") return "unsafe";
  return observed;
}

/** A source-neutral attachment observation. The hash is the expected content
 * identity when the source can provide one; stableKey keeps a logical media
 * reference reconciliable when its bytes are absent from this delivery. */
export interface ImportAttachmentRecord {
  readonly kind: "attachment";
  readonly stableKey: string;
  readonly messageKey: string;
  readonly sha256: string;
  readonly availability: ImportAttachmentAvailability;
  readonly casKey?: string;
  readonly originalName?: string;
  readonly originalPath?: string;
  readonly mimeType?: string;
  readonly byteSize?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly sourceMetadata?: Readonly<Record<string, unknown>>;
  readonly ordinal?: number;
  readonly role?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TextSnapshotImportInput {
  readonly archiveId: string;
  /** Opaque receiving account. V1 callers may omit this only when the archive
   * has exactly one account; multi-account imports must identify it. */
  readonly ownedAccountId?: string;
  readonly snapshotId: string;
  readonly importJobId: string;
  readonly observedAt: Date;
  readonly records: readonly ImportRecord[];
  /** Backup imports must carry the lease that fenced their job transition.
   * Live receipts do not use the backup job lease path. */
  readonly leaseId?: string;
  readonly leaseCheckedAt?: Date;
  readonly liveReceipt?: {
    readonly receiptId: string;
    readonly claimId: string;
    readonly sourceId: string;
    readonly sourceKey: string;
  };
}

/** Persistence boundary for one normalized snapshot. Implementations must
 * commit the records and completion marker in one transaction. */
export interface TextSnapshotImporter {
  import(input: TextSnapshotImportInput): Promise<{ readonly imported: number }>;
}
