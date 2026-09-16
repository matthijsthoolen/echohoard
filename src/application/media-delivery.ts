import type { UiReadAccess } from "./reads.js";

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
  /** Return only an attachment visible in the requested UI policy.  The
   * attachment ID remains an opaque archive-scoped handle. */
  find(
    archiveId: string,
    attachmentId: string,
    uiAccess?: UiReadAccess,
  ): Promise<MediaDeliveryAttachment | null>;
}
