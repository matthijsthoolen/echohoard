import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { MediaDeliveryAttachment, MediaDeliveryPort } from "../../application/media-delivery";
import type { UiReadAccess, UiReadMode } from "../../application/reads";
import { uiConversationPredicate } from "./ui-privacy";

const SHA256 = /^[a-f0-9]{64}$/u;

/** PostgreSQL/CAS implementation for the HTTP media delivery port.  The CAS
 * root is deployment configuration; neither it nor a source path crosses the
 * delivery boundary. */
export class PrismaMediaDelivery implements MediaDeliveryPort {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly casRoot: string,
  ) {}

  public async find(
    archiveId: string,
    attachmentId: string,
    access?: UiReadAccess,
  ): Promise<MediaDeliveryAttachment | null> {
    const policy = uiPolicy(access);
    if (!policy) return null;
    const rows = await this.prisma.$queryRaw<
      Array<{
        availability: string;
        byte_size: bigint | number | null;
        cas_key: string | null;
        mime_type: string | null;
        original_name: string | null;
        sha256: string;
      }>
    >(Prisma.sql`
      SELECT attachment.availability,
             attachment."byteSize" AS byte_size,
             attachment."casKey" AS cas_key,
             attachment."mimeType" AS mime_type,
             attachment."originalName" AS original_name,
             attachment.sha256
      FROM "Attachment" attachment
      WHERE attachment."archiveId" = ${archiveId}::uuid
        AND attachment.id::text = ${attachmentId}
        AND EXISTS (
          SELECT 1
          FROM "MessageAttachment" link
          JOIN "Message" message
            ON message."archiveId" = link."archiveId" AND message.id = link."messageId"
          LEFT JOIN "SourceConversation" source
            ON source."archiveId" = message."archiveId"
           AND source.id = message."sourceConversationId"
          JOIN "Conversation" conversation
            ON conversation."archiveId" = message."archiveId"
           AND conversation.id = COALESCE(source."unifiedConversationId", message."conversationId")
          WHERE link."archiveId" = attachment."archiveId"
            AND link."attachmentId" = attachment.id
            AND link."materialized" = true
            AND message."materialized" = true
            AND ${uiConversationPredicate("conversation", policy)}
        )
      LIMIT 1
    `);
    const attachment = rows[0];
    if (!attachment) return null;
    const base = {
      state: normalizeState(attachment.availability),
      mimeType: attachment.mime_type,
      originalName: attachment.original_name,
    } as const;
    if (base.state !== "available" || !attachment.cas_key || !SHA256.test(attachment.cas_key)) {
      return { ...base, open: () => new ReadableStream<Uint8Array>() };
    }
    // casKey is the content hash produced by the CAS writer.  Requiring it to
    // match the persisted SHA prevents malformed rows from selecting a second
    // object and keeps the path construction closed over this implementation.
    if (attachment.cas_key !== attachment.sha256) {
      return { ...base, state: "unresolved", open: () => new ReadableStream<Uint8Array>() };
    }
    const objectPath = join(
      this.casRoot,
      "sha256",
      attachment.cas_key.slice(0, 2),
      attachment.cas_key,
    );
    const details = await stat(objectPath).catch(() => null);
    if (!details?.isFile() || !Number.isSafeInteger(details.size)) {
      return { ...base, state: "missing", open: () => new ReadableStream<Uint8Array>() };
    }
    return {
      ...base,
      byteSize: details.size,
      open: (range) => {
        const stream = createReadStream(
          objectPath,
          range ? { start: range.start, end: range.end } : undefined,
        );
        return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      },
    };
  }
}

function uiPolicy(access: UiReadAccess | undefined): {
  readonly uiMode: UiReadMode;
  readonly authorizedConversationIds: readonly string[];
} | null {
  const mode = access?.mode ?? "ordinary";
  if (mode !== "ordinary" && mode !== "hidden" && mode !== "locked") return null;
  const authorizedConversationIds = access?.authorizedConversationIds ?? [];
  if (authorizedConversationIds.some((id) => !id.trim())) return null;
  return { uiMode: mode, authorizedConversationIds };
}

function normalizeState(value: string): "available" | "missing" | "unsafe" | "unresolved" {
  if (value === "available" || value === "unsafe" || value === "unresolved") return value;
  return "missing";
}
