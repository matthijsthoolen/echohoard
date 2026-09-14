import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/** Synthetic-only account seed. Production code must receive an opaque account
 * key from its caller and must never use this fixture key as a default. */
export async function createFixtureOwnedAccount(
  prisma: PrismaClient,
  archiveId: string,
  accountKey = "fixture-legacy-default",
): Promise<string> {
  const id = randomUUID();
  await prisma.ownedAccount.create({
    data: { id, archiveId, accountKey, displayLabel: "Synthetic legacy/default account" },
  });
  return id;
}
