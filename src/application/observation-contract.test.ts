import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../fixtures/eh-13-01-observation-contract.json", import.meta.url),
    "utf8",
  ),
) as ObservationContractFixture;

const REQUIRED_OBSERVATION_FIELDS = [
  "archiveId",
  "accountKey",
  "sourceKind",
  "sourceKey",
  "sourceNamespace",
  "sourceConversationKey",
  "sourceConversationIdentityKey",
  "entityKind",
  "sourceEntityKey",
  "logicalEntityKey",
  "importId",
  "observationKey",
  "observedAt",
  "valueDigest",
  "observationKind",
  "eligibility",
] as const;

interface Observation {
  readonly [key: string]: unknown;
}

interface ObservationExample {
  readonly observations: readonly Observation[];
  readonly expected: Readonly<Record<string, unknown>>;
}

interface ObservationContractFixture {
  readonly contractVersion: string;
  readonly identityKeys: {
    readonly observation: readonly string[];
  };
  readonly authoritativeFields: readonly string[];
  readonly derivedFields: readonly string[];
  readonly examples: Readonly<Record<string, ObservationExample>>;
}

function assertCompleteObservation(observation: Observation): void {
  for (const field of REQUIRED_OBSERVATION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(observation, field)) {
      throw new Error(`observation is missing required identity input: ${field}`);
    }
  }
}

describe("EH-13-01 observation/materialization contract fixture", () => {
  it("publishes the complete required observation identity set", () => {
    expect(fixture.contractVersion).toBe("eh-13-01-observation-materialization.v1");
    expect(fixture.identityKeys.observation).toEqual(REQUIRED_OBSERVATION_FIELDS);

    for (const example of Object.values(fixture.examples)) {
      for (const observation of example.observations) {
        expect(() => assertCompleteObservation(observation)).not.toThrow();
      }
    }
  });

  it("fails closed when an identity input is omitted", () => {
    const source = fixture.examples.liveBackupOverlap.observations[0];
    const incomplete: Observation = { ...source };
    delete incomplete.accountKey;

    expect(() => assertCompleteObservation(incomplete)).toThrow(
      "observation is missing required identity input: accountKey",
    );
  });

  it("proves live/backup overlap is one logical entity with two imports", () => {
    const observations = fixture.examples.liveBackupOverlap.observations;
    expect(new Set(observations.map((observation) => observation.logicalEntityKey)).size).toBe(1);
    expect(new Set(observations.map((observation) => observation.observationKey)).size).toBe(2);
    expect(new Set(observations.map((observation) => observation.importId)).size).toBe(2);
    expect(new Set(observations.map((observation) => observation.sourceKind))).toEqual(
      new Set(["live", "backup"]),
    );
    expect(fixture.examples.liveBackupOverlap.expected).toMatchObject({
      logicalEntityCount: 1,
      contributingImportCount: 2,
      provenanceState: "backup-confirmed",
    });
  });

  it("proves same source-local keys stay isolated across accounts", () => {
    const observations = fixture.examples.accountIsolation.observations;
    expect(new Set(observations.map((observation) => observation.sourceConversationKey)).size).toBe(
      1,
    );
    expect(new Set(observations.map((observation) => observation.sourceEntityKey)).size).toBe(1);
    expect(
      new Set(observations.map((observation) => observation.sourceConversationIdentityKey)).size,
    ).toBe(2);
    expect(new Set(observations.map((observation) => observation.logicalEntityKey)).size).toBe(2);
    expect(fixture.examples.accountIsolation.expected.sameLocalKeysRemainDistinct).toBe(true);
  });

  it("keeps excluded evidence and source deletion separate from content", () => {
    const example = fixture.examples.exclusionAndTombstone;
    expect(new Set(example.observations.map((observation) => observation.observationKind))).toEqual(
      new Set(["value", "source-deletion-tombstone"]),
    );
    expect(example.expected).toMatchObject({
      excludedImportEvidenceRetained: true,
      validContentRemainsAfterExclusion: true,
      sourceDeletionRetainsContent: true,
      ownerSoftDeleteUnaffected: true,
      reEnableRestoresDeterministicInputSet: true,
    });
  });

  it("keeps authoritative and derived field ownership disjoint", () => {
    const authoritative = new Set(fixture.authoritativeFields);
    expect(fixture.derivedFields.every((field) => !authoritative.has(field))).toBe(true);
    expect(fixture.derivedFields).toContain("contributingImportKeys");
    expect(fixture.authoritativeFields).toContain("eligibility");
  });
});
