/** A bounded, content-free health vocabulary shared by delivery surfaces. */
export type HealthState =
  | "healthy"
  | "warning"
  | "failed"
  | "empty"
  | "in-progress"
  | "stale"
  | "unsupported";

export type FreshnessState = "fresh" | "stale" | "unknown";
export type ImportHealthStatus = "idle" | "in-progress" | "completed" | "failed";

export interface HealthThresholds {
  /** Age at which a completed snapshot is no longer fresh. */
  readonly staleAfterMilliseconds: number;
}

export interface HealthInput {
  readonly now: Date;
  readonly latestCompletedSnapshotAt?: Date;
  readonly importStatus: ImportHealthStatus;
  readonly messageCount: number;
  readonly mediaReferencedCount: number;
  readonly mediaAvailableCount: number;
  readonly unsupportedCount: number;
  readonly diagnostics?: readonly HealthDiagnosticInput[];
}

export interface HealthDiagnosticInput {
  readonly code: string;
  readonly retryable?: boolean;
}

export interface HealthDiagnostic {
  readonly code: HealthDiagnosticCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type HealthDiagnosticCode =
  | "CORRUPT_SOURCE"
  | "INVALID_KEY"
  | "IO_FAILURE"
  | "UNSUPPORTED_SCHEMA"
  | "IMPORT_FAILURE"
  | "MISSING_MEDIA"
  | "UNSUPPORTED_CONTENT";

export interface HealthResult {
  readonly state: HealthState;
  readonly freshness: FreshnessState;
  readonly latestCompletedSnapshotAt?: Date;
  readonly counts: {
    readonly messages: number;
    readonly mediaReferenced: number;
    readonly mediaAvailable: number;
    readonly unsupported: number;
  };
  readonly diagnostics: readonly HealthDiagnostic[];
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = Object.freeze({
  staleAfterMilliseconds: 36 * 60 * 60 * 1000,
});

const diagnosticMessages: Record<HealthDiagnosticCode, string> = {
  CORRUPT_SOURCE: "The source snapshot is corrupt or incomplete.",
  INVALID_KEY: "The configured decryption key was rejected.",
  IO_FAILURE: "The archive could not read or store required data.",
  UNSUPPORTED_SCHEMA: "The source schema is not supported by this version.",
  IMPORT_FAILURE: "The import did not complete; retry after reviewing configuration.",
  MISSING_MEDIA: "Some referenced media is unavailable.",
  UNSUPPORTED_CONTENT: "Some source content uses an unsupported type.",
};

const diagnosticCodes = new Set<HealthDiagnosticCode>(
  Object.keys(diagnosticMessages) as HealthDiagnosticCode[],
);

/**
 * Classify archive evidence without inspecting its content. Precedence is
 * failure, active work, unsupported data, empty archive, stale snapshot,
 * incomplete media warning, then healthy.
 */
export function classifyHealth(
  input: HealthInput,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): HealthResult {
  if (!Number.isFinite(thresholds.staleAfterMilliseconds) || thresholds.staleAfterMilliseconds < 0)
    throw new RangeError("stale threshold must be a non-negative finite number");
  const freshness = classifyFreshness(input.latestCompletedSnapshotAt, input.now, thresholds);
  const diagnostics = sanitizeDiagnostics(input.diagnostics ?? []);
  const missingMedia = input.mediaAvailableCount < input.mediaReferencedCount;
  let state: HealthState = "healthy";
  if (input.importStatus === "failed") state = "failed";
  else if (input.importStatus === "in-progress") state = "in-progress";
  else if (input.unsupportedCount > 0) state = "unsupported";
  else if (input.messageCount === 0) state = "empty";
  else if (freshness === "stale") state = "stale";
  else if (missingMedia) state = "warning";
  return {
    state,
    freshness,
    ...(input.latestCompletedSnapshotAt
      ? { latestCompletedSnapshotAt: input.latestCompletedSnapshotAt }
      : {}),
    counts: {
      messages: nonNegativeCount(input.messageCount),
      mediaReferenced: nonNegativeCount(input.mediaReferencedCount),
      mediaAvailable: nonNegativeCount(input.mediaAvailableCount),
      unsupported: nonNegativeCount(input.unsupportedCount),
    },
    diagnostics,
  };
}

export function classifyFreshness(
  latestCompletedSnapshotAt: Date | undefined,
  now: Date,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): FreshnessState {
  if (!latestCompletedSnapshotAt) return "unknown";
  const age = now.getTime() - latestCompletedSnapshotAt.getTime();
  return age > thresholds.staleAfterMilliseconds ? "stale" : "fresh";
}

function sanitizeDiagnostics(
  inputs: readonly HealthDiagnosticInput[],
): readonly HealthDiagnostic[] {
  return inputs.flatMap((input) => {
    if (!diagnosticCodes.has(input.code as HealthDiagnosticCode)) return [];
    const code = input.code as HealthDiagnosticCode;
    return [{ code, message: diagnosticMessages[code], retryable: input.retryable === true }];
  });
}

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
