export type ImportRecord =
  | ImportPersonRecord
  | ImportIdentityRecord
  | ImportConversationRecord
  | ImportParticipantRecord
  | ImportMessageRecord
  | ImportRevisionRecord;
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
  readonly replyToKey?: string;
  readonly unsupportedTypeCode?: number;
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

export interface TextSnapshotImportInput {
  readonly archiveId: string;
  readonly snapshotId: string;
  readonly importJobId: string;
  readonly observedAt: Date;
  readonly records: readonly ImportRecord[];
}

/** Persistence boundary for one normalized snapshot. Implementations must
 * commit the records and completion marker in one transaction. */
export interface TextSnapshotImporter {
  import(input: TextSnapshotImportInput): Promise<{ readonly imported: number }>;
}
