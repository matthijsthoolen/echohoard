export type TranscriptStatus = "pending" | "running" | "completed" | "failed";
export type TranscriptRunStatus = TranscriptStatus;

export interface TranscriptState {
  readonly archiveId: string;
  readonly transcriptId: string;
  readonly attachmentId: string;
  readonly sourceMediaSha256: string;
  readonly currentMediaSha256: string;
  readonly manualAuthority: boolean;
}

export interface TranscriptVersionState {
  readonly archiveId: string;
  readonly transcriptId: string;
  readonly mediaSha256: string;
  readonly text: string;
  readonly isManual: boolean;
  readonly editorId?: string;
  readonly editedAt?: Date;
}

const DIGEST = /^[0-9a-f]{64}$/;

export function assertTranscriptLink(
  archiveId: string,
  attachmentArchiveId: string,
  mediaSha256: string,
): void {
  if (!archiveId || archiveId !== attachmentArchiveId)
    throw new Error("cross-archive transcript link");
  if (!DIGEST.test(mediaSha256)) throw new Error("media digest must be a lowercase SHA-256");
}

export function canAutomaticVersionBeActive(transcript: TranscriptState): boolean {
  return !transcript.manualAuthority;
}

export function versionIsApplicable(
  transcript: Pick<TranscriptState, "currentMediaSha256">,
  version: Pick<TranscriptVersionState, "mediaSha256">,
): boolean {
  return transcript.currentMediaSha256 === version.mediaSha256;
}

export function applyManualVersion(
  transcript: TranscriptState,
  version: TranscriptVersionState,
): TranscriptState {
  validateVersion(transcript, version, true);
  return { ...transcript, manualAuthority: true };
}

export function applyAutomaticVersion(
  transcript: TranscriptState,
  version: TranscriptVersionState,
): { transcript: TranscriptState; active: boolean } {
  validateVersion(transcript, version, false);
  return {
    transcript,
    active: canAutomaticVersionBeActive(transcript) && versionIsApplicable(transcript, version),
  };
}

export function invalidateForChangedMedia(
  transcript: TranscriptState,
  currentMediaSha256: string,
): TranscriptState {
  if (!DIGEST.test(currentMediaSha256)) throw new Error("media digest must be a lowercase SHA-256");
  return { ...transcript, currentMediaSha256 };
}

function validateVersion(
  transcript: TranscriptState,
  version: TranscriptVersionState,
  manual: boolean,
): void {
  if (version.archiveId !== transcript.archiveId)
    throw new Error("cross-archive transcript version");
  if (version.transcriptId !== transcript.transcriptId)
    throw new Error("version belongs to another transcript");
  if (!DIGEST.test(version.mediaSha256))
    throw new Error("media digest must be a lowercase SHA-256");
  if (!version.text.trim()) throw new Error("transcript text is required");
  if (version.isManual !== manual) throw new Error("version authority mismatch");
  if (manual && (!version.editorId || !version.editedAt))
    throw new Error("manual editor and time are required");
}
