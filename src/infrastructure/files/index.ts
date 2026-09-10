import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DeliveryFile, DeliveryId, InboxPort } from "../../application/echohoard.js";

export class LocalInbox implements InboxPort {
  public async listDeliveries(inboxPath: string): Promise<readonly string[]> {
    const entries = await readdir(inboxPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
  }
  public async inspect(deliveryPath: string): Promise<readonly DeliveryFile[]> {
    const entries = await readdir(deliveryPath, { withFileTypes: true });
    const files: DeliveryFile[] = [];
    for (const entry of entries.filter((candidate) => candidate.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
      const details = await stat(join(deliveryPath, entry.name));
      files.push({ name: entry.name, size: details.size, modifiedAt: details.mtime });
    }
    return files;
  }
  public async claim(deliveryPath: string, deliveryId: DeliveryId): Promise<string | null> {
    const destination = join(join(deliveryPath, ".."), ".claimed", deliveryId);
    await mkdir(join(destination, ".."), { recursive: true });
    try { await rename(deliveryPath, destination); return destination; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST") return null;
      throw error;
    }
  }
}

export const infrastructureFiles = "files";
