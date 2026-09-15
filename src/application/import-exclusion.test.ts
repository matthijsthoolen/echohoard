import { describe, expect, it } from "vitest";
import {
  ApplyImportExclusionService,
  PlanImportExclusionService,
  selectPreferredObservation,
  transitionMaterializationRun,
} from "./import-exclusion.js";

const request = {
  archiveId: "archive",
  importJobId: "job",
  action: "exclude" as const,
  actor: "synthetic-owner",
  reason: "synthetic verification",
  idempotencyKey: "decision-1",
};

describe("import exclusion application services", () => {
  it("validate input and delegate plan/apply without adding policy to delivery", async () => {
    const plan = {
      archiveId: "archive",
      importJobId: "job",
      action: "exclude" as const,
      currentEligibility: "eligible" as const,
      nextEligibility: "excluded" as const,
      counts: {
        conversations: 1,
        messages: 2,
        revisions: 0,
        reactions: 0,
        attachmentReferences: 0,
        observations: 2,
      },
      inputSetDigest: "a".repeat(64),
      truncated: false,
    };
    const persistence = {
      plan: async () => plan,
      apply: async () => ({
        ...plan,
        runId: "run",
        status: "completed" as const,
        idempotent: false,
      }),
    };
    await expect(new PlanImportExclusionService(persistence).execute(request)).resolves.toEqual(
      plan,
    );
    await expect(
      new ApplyImportExclusionService(persistence).execute(request),
    ).resolves.toMatchObject({
      runId: "run",
    });
  });

  it("enforces a resumable run state machine", () => {
    expect(transitionMaterializationRun("running", "failed")).toBe("failed");
    expect(transitionMaterializationRun("failed", "running")).toBe("running");
    expect(transitionMaterializationRun("running", "completed")).toBe("completed");
    expect(transitionMaterializationRun("completed", "completed")).toBe("completed");
    expect(() => transitionMaterializationRun("completed", "running")).toThrow();
  });

  it("applies usable, backup, time, and lexical precedence in order", () => {
    const value = (body: string | undefined) =>
      body ? { body, bodyState: "present" } : { bodyState: "missing" };
    const observations = [
      {
        observationKey: "live",
        sourceKind: "live",
        observedAt: new Date("2026-01-03"),
        value: value("live"),
      },
      {
        observationKey: "backup-old",
        sourceKind: "backup",
        observedAt: new Date("2026-01-01"),
        value: value("backup"),
      },
      {
        observationKey: "backup-new",
        sourceKind: "backup",
        observedAt: new Date("2026-01-03"),
        value: value("new"),
      },
      {
        observationKey: "missing",
        sourceKind: "backup",
        observedAt: new Date("2026-01-04"),
        value: value(undefined),
      },
    ];
    expect(
      selectPreferredObservation(observations, (candidate) => candidate?.bodyState === "present")
        ?.observationKey,
    ).toBe("backup-new");
    expect(selectPreferredObservation(observations, () => true)?.observationKey).toBe("missing");
  });
});
