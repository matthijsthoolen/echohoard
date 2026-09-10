import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";
import { PrismaMediaDelivery } from "./media-delivery";

const archiveId = "archive-1";
const attachmentId = "attachment-1";
const content = Buffer.from("synthetic media bytes");
const hash = createHash("sha256").update(content).digest("hex");

describe("Prisma media delivery", () => {
  it("looks up by archive and streams the archive-owned CAS object", async () => {
    const tempRoot = join(cwd(), ".tmp");
    await mkdir(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, "echohoard-media-delivery-"));
    const objectPath = join(root, "sha256", hash.slice(0, 2), hash);
    await mkdir(join(root, "sha256", hash.slice(0, 2)), { recursive: true });
    await writeFile(objectPath, content);
    const calls: unknown[] = [];
    const prisma = {
      attachment: {
        findUnique: async (args: unknown) => {
          calls.push(args);
          return {
            availability: "available",
            byteSize: BigInt(content.length),
            casKey: hash,
            mimeType: "audio/mpeg",
            originalName: "voice.mp3",
            sha256: hash,
          };
        },
      },
    } as never;
    try {
      const result = await new PrismaMediaDelivery(prisma, root).find(archiveId, attachmentId);
      expect(result?.state).toBe("available");
      expect(result?.byteSize).toBe(content.length);
      expect(calls).toEqual([
        expect.objectContaining({
          where: { archiveId_id: { archiveId, id: attachmentId } },
        }),
      ]);
      const reader = result!.open().getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))).toEqual(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for missing bytes and mismatched CAS identity", async () => {
    const prisma = {
      attachment: {
        findUnique: async () => ({
          availability: "available",
          byteSize: BigInt(content.length),
          casKey: "f".repeat(64),
          mimeType: "image/png",
          originalName: "photo.png",
          sha256: hash,
        }),
      },
    } as never;
    const result = await new PrismaMediaDelivery(prisma, cwd()).find(archiveId, attachmentId);
    expect(result?.state).toBe("unresolved");
  });
});
