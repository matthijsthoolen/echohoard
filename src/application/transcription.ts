/** Application-facing contract for one bounded transcription attempt.  The
 * adapter receives an EchoHoard-owned CAS object, never a caller-provided URL
 * or an arbitrary media path. */
export interface TranscriptionAttachment {
  readonly archiveId: string;
  readonly mediaSha256: string;
  readonly casPath: string;
  readonly mimeType: string;
  readonly durationMs: number;
}

export interface TranscriptionRequestInput {
  readonly attachment: TranscriptionAttachment;
  readonly selectedModel: string;
}

export interface TranscriptSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface TranscriptionResult {
  readonly mediaSha256: string;
  readonly model: string;
  readonly text: string;
  readonly language?: string;
  readonly segments?: readonly TranscriptSegment[];
}

export interface TranscriptionAdapterPort {
  transcribe(input: TranscriptionRequestInput): Promise<TranscriptionResult>;
}
