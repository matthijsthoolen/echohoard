import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import type { MediaDeliveryAttachment, MediaDeliveryPort } from "../../application/media-delivery";

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
  ): Promise<MediaDeliveryAttachment | null> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { archiveId_id: { archiveId, id: attachmentId } },
      select: {
        availability: true,
        byteSize: true,
        casKey: true,
        mimeType: true,
        originalName: true,
        sha256: true,
      },
    });
    if (!attachment) return null;
    const base = {
      state: normalizeState(attachment.availability),
      mimeType: attachment.mimeType,
      originalName: attachment.originalName,
    } as const;
    if (base.state !== "available" || !attachment.casKey || !SHA256.test(attachment.casKey)) {
      return { ...base, open: () => new ReadableStream<Uint8Array>() };
    }
    // casKey is the content hash produced by the CAS writer.  Requiring it to
    // match the persisted SHA prevents malformed rows from selecting a second
    // object and keeps the path construction closed over this implementation.
    if (attachment.casKey !== attachment.sha256) {
      return { ...base, state: "unresolved", open: () => new ReadableStream<Uint8Array>() };
    }
    const objectPath = join(
      this.casRoot,
      "sha256",
      attachment.casKey.slice(0, 2),
      attachment.casKey,
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

function normalizeState(value: string): "available" | "missing" | "unsafe" | "unresolved" {
  if (value === "available" || value === "unsafe" || value === "unresolved") return value;
  return "missing";
}
