import { describe, expect, it } from "vitest";
import {
  applyAutomaticVersion,
  applyManualVersion,
  assertTranscriptLink,
  invalidateForChangedMedia,
  versionIsApplicable,
} from "./transcription";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const transcript = {
  archiveId: "archive-1",
  transcriptId: "transcript-1",
  attachmentId: "attachment-1",
  sourceMediaSha256: digest,
  currentMediaSha256: digest,
  manualAuthority: false,
};

describe("transcription authority", () => {
  it("links only an attachment in the same archive", () => {
    expect(() => assertTranscriptLink("archive-1", "archive-2", digest)).toThrow();
    expect(() => assertTranscriptLink("archive-1", "archive-1", "bad")).toThrow();
  });

  it("makes manual versions authoritative while retaining automatic history", () => {
    const manual = {
      archiveId: "archive-1",
      transcriptId: "transcript-1",
      mediaSha256: digest,
      text: "corrected text",
      isManual: true,
      editorId: "owner",
      editedAt: new Date(),
    };
    const protectedTranscript = applyManualVersion(transcript, manual);
    expect(protectedTranscript.manualAuthority).toBe(true);
    expect(applyAutomaticVersion(protectedTranscript, { ...manual, isManual: false }).active).toBe(
      false,
    );
  });

  it("invalidates old versions when the media digest changes without deleting them", () => {
    const changed = invalidateForChangedMedia(transcript, otherDigest);
    expect(versionIsApplicable(changed, { mediaSha256: digest })).toBe(false);
    expect(versionIsApplicable(changed, { mediaSha256: otherDigest })).toBe(true);
  });
});
