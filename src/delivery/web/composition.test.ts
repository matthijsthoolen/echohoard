import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { createProductionAccountSettings } from "./composition.js";
import type { AccountSettingsPersistencePort } from "../../application/persistence.js";

describe("production account settings composition", () => {
  it("composes account settings with the database ports and fixed sidecar client", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({
        connection: "disconnected",
        checkedAt: "2026-09-16T12:00:00.000Z",
        reconnectCount: 0,
      });
    const accounts: AccountSettingsPersistencePort = {
      list: async () => [
        {
          id: "account-1",
          accountKey: "account-a",
          displayLabel: "Synthetic account",
          liveEnabled: true,
        },
      ],
      findById: async () => null,
      update: async () => {
        throw new Error("not used");
      },
    };
    const prisma = {
      liveEventInbox: {
        groupBy: async () => [],
        findFirst: async () => null,
      },
    } as unknown as PrismaClient;

    const service = createProductionAccountSettings(
      prisma,
      accounts,
      {
        ECHOHOARD_WACLI_CONTROL_URL: "http://wacli-control.test/",
        ECHOHOARD_WACLI_CONTROL_TIMEOUT_MS: 1_000,
      },
      fetcher,
    );

    await expect(service.list("archive-1")).resolves.toMatchObject([
      {
        id: "account-1",
        health: { connection: "disconnected", receipt: { state: "none" } },
      },
    ]);
  });
});
