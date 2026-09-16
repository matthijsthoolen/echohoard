import { describe, expect, it } from "vitest";
import { DEFAULT_IMPORT_TRANSACTION_TIMEOUT_MS, importTransactionOptions } from "./text-import.js";

describe("normalized import transaction budget", () => {
  it("does not use Prisma's five-second interactive transaction default", () => {
    expect(importTransactionOptions()).toEqual({ maxWait: 10_000, timeout: 21_600_000 });
    expect(DEFAULT_IMPORT_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it("allows the worker composition to provide an explicit budget", () => {
    expect(
      importTransactionOptions({
        transactionMaxWaitMilliseconds: 2_000,
        transactionTimeoutMilliseconds: 900_000,
      }),
    ).toEqual({ maxWait: 2_000, timeout: 900_000 });
  });
});
