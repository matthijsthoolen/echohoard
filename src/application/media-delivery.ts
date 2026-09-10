/** The small, archive-scoped contract used by HTTP media delivery.  It
 * deliberately exposes a stream factory, never a filesystem path. */
export interface MediaByteRange {
  readonly start: number;
  readonly end: number;
}

export type MediaAttachmentState = "available" | "missing" | "unsafe" | "unresolved";

export interface MediaDeliveryAttachment {
  readonly state: MediaAttachmentState;
  readonly mimeType?: string | null;
  readonly originalName?: string | null;
  readonly byteSize?: number;
  readonly open: (range?: MediaByteRange) => ReadableStream<Uint8Array>;
}

export interface MediaDeliveryPort {
  /** Return only an attachment owned by archiveId.  Implementations must not
   * accept or resolve a source path supplied by a caller. */
  find(archiveId: string, attachmentId: string): Promise<MediaDeliveryAttachment | null>;
}
