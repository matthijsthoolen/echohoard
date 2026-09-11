import type { PrismaClient } from "@prisma/client";
import { join } from "node:path";
import type { SnapshotPathPort } from "../../application/intake.js";

/** Resolves only database-owned snapshot ids into the worker's mounted source
 * root. Callers never provide an arbitrary filesystem path. */
export class PrismaSnapshotPath implements SnapshotPathPort {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly snapshotsRoot: string,
  ) {}

  public async path(snapshotId: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]+$/.test(snapshotId)) throw new Error("invalid snapshot identifier");
    const snapshot = await this.prisma.snapshot.findUnique({
      where: { id: snapshotId },
      select: { id: true, lifecycle: true },
    });
    if (!snapshot || snapshot.lifecycle === "failed") throw new Error("snapshot is not ready");
    return join(this.snapshotsRoot, snapshot.id, "msgstore.db.crypt15");
  }
}
