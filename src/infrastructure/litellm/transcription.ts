import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { lstat, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import type {
  TranscriptionAdapterPort,
  TranscriptionRequestInput,
  TranscriptionResult,
  TranscriptSegment,
} from "../../application/transcription.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MODEL_ID = /^[\u0021-\u007e]{1,256}$/u;
const LANGUAGE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/u;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 100_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENTS = 2_000;
const MAX_SEGMENT_TEXT_CHARS = 20_000;
const MAX_STDERR_BYTES = 8 * 1024;
const SUPPORTED_MEDIA_TYPES = new Set([
  "audio/aac",
  "audio/amr",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "video/3gpp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

export type TranscriptionFailureKind =
  | "configuration"
  | "cas-unavailable"
  | "input-too-large"
  | "duration-too-long"
  | "unsupported-format"
  | "model-not-allowed"
  | "timeout"
  | "provider-rate-limit"
  | "provider-unavailable"
  | "provider-authentication"
  | "provider-rejected"
  | "invalid-response"
  | "cleanup-failed"
  | "internal";

const RETRYABLE = new Set<TranscriptionFailureKind>([
  "timeout",
  "provider-rate-limit",
  "provider-unavailable",
  "cleanup-failed",
  "internal",
]);

export class TranscriptionError extends Error {
  public readonly retryable: boolean;

  public constructor(readonly kind: TranscriptionFailureKind) {
    super(`transcription failed (${kind})`);
    this.name = "TranscriptionError";
    this.retryable = RETRYABLE.has(kind);
  }
}

export interface AudioDerivativeRequest {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly inputMimeType: string;
  readonly sourceDurationMs: number;
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  readonly timeoutMs: number;
}

export interface AudioDerivativeResult {
  readonly bytes: number;
  readonly durationMs: number;
}

/** Port for media conversion.  It is intentionally narrower than a general
 * command runner: callers can only request a derivative at a worker-owned
 * destination with explicit bounds. */
export interface AudioDerivativePort {
  prepare(request: AudioDerivativeRequest): Promise<AudioDerivativeResult>;
}

export interface FfmpegAudioDerivativeOptions {
  readonly executable?: string;
  readonly maxStderrBytes?: number;
}

/** Fixed-argument ffmpeg adapter.  It never uses a shell and never puts media
 * bytes, credentials, or transcript text in process arguments. */
export class FfmpegAudioDerivative implements AudioDerivativePort {
  private readonly executable: string;
  private readonly maxStderrBytes: number;

  public constructor(options: FfmpegAudioDerivativeOptions = {}) {
    this.executable = options.executable ?? "ffmpeg";
    this.maxStderrBytes = options.maxStderrBytes ?? MAX_STDERR_BYTES;
    if (!this.executable || !Number.isSafeInteger(this.maxStderrBytes) || this.maxStderrBytes < 1)
      throw new TranscriptionError("configuration");
  }

  public async prepare(request: AudioDerivativeRequest): Promise<AudioDerivativeResult> {
    const durationSeconds = (request.maxDurationMs / 1000).toFixed(3);
    const result = await runProcess(
      this.executable,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        request.sourcePath,
        "-map_metadata",
        "-1",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-t",
        durationSeconds,
        "-fs",
        String(request.maxBytes),
        "-f",
        "wav",
        request.destinationPath,
      ],
      request.timeoutMs,
      this.maxStderrBytes,
    );
    if (result.timedOut) throw new TranscriptionError("timeout");
    if (result.spawnFailed || result.code !== 0)
      throw new TranscriptionError(classifyDerivativeFailure(result.stderr));

    const details = await stat(request.destinationPath).catch(() => null);
    if (!details?.isFile() || !Number.isSafeInteger(details.size) || details.size <= 0)
      throw new TranscriptionError("unsupported-format");
    if (details.size > request.maxBytes) throw new TranscriptionError("input-too-large");
    return { bytes: details.size, durationMs: request.sourceDurationMs };
  }
}

export interface LiteLlmTranscriptionLimits {
  readonly maxBytes?: number;
  readonly maxDurationMs?: number;
  readonly timeoutMs?: number;
  readonly maxTranscriptChars?: number;
  readonly maxResponseBytes?: number;
  readonly derivativeTimeoutMs?: number;
}

export interface LiteLlmTranscriptionAdapterOptions extends LiteLlmTranscriptionLimits {
  readonly fetcher?: typeof fetch;
  readonly derivative?: AudioDerivativePort;
  readonly derivativeExecutable?: string;
  readonly endpointLookup?: EndpointLookup;
  readonly cleanup?: (temporaryDirectory: string) => Promise<void>;
}

export type EndpointLookup = (hostname: string) => Promise<readonly string[]>;

/** Bounded, private LiteLLM transcription adapter.  The endpoint is derived
 * from configuration once; per-request URLs are not accepted. */
export class LiteLlmTranscriptionAdapter implements TranscriptionAdapterPort {
  private readonly endpoint: string;
  private readonly maxBytes: number;
  private readonly maxDurationMs: number;
  private readonly timeoutMs: number;
  private readonly derivativeTimeoutMs: number;
  private readonly maxTranscriptChars: number;
  private readonly maxResponseBytes: number;
  private readonly fetcher: typeof fetch;
  private readonly derivative: AudioDerivativePort;
  private readonly allowedModelIds: ReadonlySet<string>;
  private readonly casRoot: string;
  private readonly workRoot: string;
  private readonly endpointLookup: EndpointLookup;
  private readonly cleanup: (temporaryDirectory: string) => Promise<void>;

  public constructor(
    baseUrl: string,
    private readonly secret: string,
    allowedModelIds: ReadonlySet<string>,
    casRoot: string,
    workRoot: string,
    options: LiteLlmTranscriptionAdapterOptions = {},
  ) {
    this.endpoint = transcriptionEndpoint(baseUrl);
    this.allowedModelIds = new Set(allowedModelIds);
    this.casRoot = resolve(casRoot);
    this.workRoot = resolve(workRoot);
    this.maxBytes = positiveLimit(options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxDurationMs = positiveLimit(options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
    this.timeoutMs = positiveLimit(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.derivativeTimeoutMs = positiveLimit(options.derivativeTimeoutMs ?? this.timeoutMs);
    this.maxTranscriptChars = positiveLimit(
      options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS,
    );
    this.maxResponseBytes = positiveLimit(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    this.fetcher = options.fetcher ?? fetch;
    this.derivative =
      options.derivative ?? new FfmpegAudioDerivative({ executable: options.derivativeExecutable });
    this.endpointLookup = options.endpointLookup ?? resolveEndpointAddresses;
    this.cleanup = options.cleanup ?? (async (path) => rm(path, { recursive: true, force: true }));
    if (!this.secret.trim() || this.allowedModelIds.size === 0)
      throw new TranscriptionError("configuration");
  }

  public async transcribe(input: TranscriptionRequestInput): Promise<TranscriptionResult> {
    const attachment = input.attachment;
    validateRequest(input, this.allowedModelIds, this.maxBytes, this.maxDurationMs);
    const sourcePath = await this.assertCasAttachment(attachment.mediaSha256, attachment.casPath);
    let temporaryDirectory: string | undefined;
    try {
      await mkdir(this.workRoot, { recursive: true });
      temporaryDirectory = await makeTemporaryDirectory(this.workRoot);
      const derivativePath = join(temporaryDirectory, "audio.wav");
      const derivative = await this.derivative.prepare({
        sourcePath,
        destinationPath: derivativePath,
        inputMimeType: normalizeMime(attachment.mimeType),
        sourceDurationMs: attachment.durationMs,
        maxBytes: this.maxBytes,
        maxDurationMs: this.maxDurationMs,
        timeoutMs: this.derivativeTimeoutMs,
      });
      if (
        !Number.isSafeInteger(derivative.bytes) ||
        derivative.bytes <= 0 ||
        derivative.bytes > this.maxBytes
      )
        throw new TranscriptionError("input-too-large");
      if (
        !Number.isSafeInteger(derivative.durationMs) ||
        derivative.durationMs <= 0 ||
        derivative.durationMs > this.maxDurationMs ||
        derivative.durationMs > attachment.durationMs
      )
        throw new TranscriptionError("duration-too-long");

      const audio = await readBounded(derivativePath, this.maxBytes);
      const result = await this.request(input.selectedModel, audio, derivative.durationMs);
      return {
        mediaSha256: attachment.mediaSha256,
        model: input.selectedModel,
        text: result.text,
        ...(result.language ? { language: result.language } : {}),
        ...(result.segments ? { segments: result.segments } : {}),
      };
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw new TranscriptionError("internal");
    } finally {
      if (temporaryDirectory) {
        try {
          await this.cleanup(temporaryDirectory);
        } catch {
          throw new TranscriptionError("cleanup-failed");
        }
      }
    }
  }

  private async assertCasAttachment(mediaSha256: string, casPath: string): Promise<string> {
    const expected = join(this.casRoot, "sha256", mediaSha256.slice(0, 2), mediaSha256);
    if (!SHA256.test(mediaSha256) || resolve(casPath) !== expected)
      throw new TranscriptionError("cas-unavailable");
    const details = await lstat(expected).catch(() => null);
    if (!details?.isFile()) throw new TranscriptionError("cas-unavailable");
    if (!Number.isSafeInteger(details.size) || details.size > this.maxBytes)
      throw new TranscriptionError("input-too-large");
    return expected;
  }

  private async request(
    model: string,
    audio: Buffer,
    mediaDurationMs: number,
  ): Promise<ParsedTranscriptionResponse> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "audio.wav");
    form.append("model", model);
    form.append("response_format", "verbose_json");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new TranscriptionError("timeout"));
        }, this.timeoutMs);
      });
      const pending = this.fetchAndParse(form, controller.signal, mediaDurationMs);
      try {
        return await Promise.race([pending, timeout]);
      } catch (error) {
        if (error instanceof TranscriptionError) throw error;
        if (timedOut || controller.signal.aborted) throw new TranscriptionError("timeout");
        throw new TranscriptionError("provider-unavailable");
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fetchAndParse(
    form: FormData,
    signal: AbortSignal,
    mediaDurationMs: number,
  ): Promise<ParsedTranscriptionResponse> {
    await assertPrivateEndpoint(this.endpoint, this.endpointLookup, signal);
    if (signal.aborted) throw new TranscriptionError("timeout");
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      redirect: "error",
      headers: { Accept: "application/json", Authorization: `Bearer ${this.secret}` },
      body: form,
      signal,
    });
    if (signal.aborted) throw new TranscriptionError("timeout");
    return parseTranscriptionResponse(
      response,
      this.maxResponseBytes,
      this.maxTranscriptChars,
      mediaDurationMs,
      signal,
    );
  }
}

export function createLiteLlmTranscriptionAdapter(
  baseUrl: string | undefined,
  secretFile: string | undefined,
  allowedIds: string,
  casRoot: string,
  workRoot: string,
  options: LiteLlmTranscriptionAdapterOptions = {},
): TranscriptionAdapterPort {
  const models = new Set(
    allowedIds
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!baseUrl || !secretFile || models.size === 0) return unavailableAdapter();
  let secret: string;
  try {
    secret = readFileSync(secretFile, "utf8").trim();
  } catch {
    return unavailableAdapter();
  }
  if (!secret) return unavailableAdapter();
  return new LiteLlmTranscriptionAdapter(baseUrl, secret, models, casRoot, workRoot, options);
}

export function transcriptionEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TranscriptionError("configuration");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isPrivateHostname(hostname)
  )
    throw new TranscriptionError("configuration");
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${path}/audio/transcriptions`;
  return url.toString();
}

async function assertPrivateEndpoint(
  endpoint: string,
  endpointLookup: EndpointLookup,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL(endpoint);
  const hostname = normalizeHostname(url.hostname);
  if (!isPrivateHostname(hostname)) throw new TranscriptionError("configuration");
  if (isIP(hostname)) {
    if (!isPrivateAddress(hostname)) throw new TranscriptionError("configuration");
    return;
  }
  let addresses: readonly string[];
  try {
    addresses = await endpointLookup(hostname);
  } catch {
    if (signal.aborted) throw new TranscriptionError("timeout");
    throw new TranscriptionError("provider-unavailable");
  }
  if (signal.aborted) throw new TranscriptionError("timeout");
  if (addresses.length === 0 || addresses.some((address) => !isPrivateAddress(address)))
    throw new TranscriptionError("configuration");
}

async function parseTranscriptionResponse(
  response: Response,
  maxResponseBytes: number,
  maxTranscriptChars: number,
  mediaDurationMs: number,
  signal: AbortSignal,
): Promise<ParsedTranscriptionResponse> {
  if (response.status === 429) throw new TranscriptionError("provider-rate-limit");
  if (response.status >= 500) throw new TranscriptionError("provider-unavailable");
  if (response.status === 401 || response.status === 403)
    throw new TranscriptionError("provider-authentication");
  if (!response.ok) throw new TranscriptionError("provider-rejected");
  const raw = await readResponseText(response, maxResponseBytes, signal);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new TranscriptionError("invalid-response");
  }
  if (!isRecord(body) || typeof body.text !== "string")
    throw new TranscriptionError("invalid-response");
  const text = safeText(body.text, maxTranscriptChars);
  if (!text) throw new TranscriptionError("invalid-response");
  const language = body.language === undefined ? undefined : safeLanguage(body.language);
  const responseDurationMs =
    body.duration === undefined
      ? mediaDurationMs
      : secondsToMilliseconds(body.duration, mediaDurationMs);
  const segments =
    body.segments === undefined
      ? undefined
      : safeSegments(body.segments, responseDurationMs, maxTranscriptChars);
  return { text, ...(language ? { language } : {}), ...(segments ? { segments } : {}) };
}

type ParsedTranscriptionResponse = {
  readonly text: string;
  readonly language?: string;
  readonly segments?: TranscriptSegment[];
};

function validateRequest(
  input: TranscriptionRequestInput,
  allowedModelIds: ReadonlySet<string>,
  maxBytes: number,
  maxDurationMs: number,
): void {
  const attachment = input.attachment;
  if (!attachment.archiveId || !SHA256.test(attachment.mediaSha256))
    throw new TranscriptionError("cas-unavailable");
  if (!MODEL_ID.test(input.selectedModel) || !allowedModelIds.has(input.selectedModel))
    throw new TranscriptionError("model-not-allowed");
  if (!SUPPORTED_MEDIA_TYPES.has(normalizeMime(attachment.mimeType)))
    throw new TranscriptionError("unsupported-format");
  if (!Number.isSafeInteger(attachment.durationMs) || attachment.durationMs <= 0)
    throw new TranscriptionError("duration-too-long");
  if (attachment.durationMs > maxDurationMs) throw new TranscriptionError("duration-too-long");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new TranscriptionError("configuration");
}

function safeText(value: string, limit: number): string {
  if (value.length > limit || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
    throw new TranscriptionError("invalid-response");
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

function safeLanguage(value: unknown): string {
  if (typeof value !== "string" || !LANGUAGE.test(value))
    throw new TranscriptionError("invalid-response");
  return value.replace("_", "-").toLowerCase();
}

function safeSegments(
  value: unknown,
  maxDurationMs: number,
  textLimit: number,
): TranscriptSegment[] {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS)
    throw new TranscriptionError("invalid-response");
  let previousEndMs = 0;
  return value.map((item) => {
    if (!isRecord(item) || typeof item.start !== "number" || typeof item.end !== "number")
      throw new TranscriptionError("invalid-response");
    const startMs = secondsToMilliseconds(item.start, maxDurationMs);
    const endMs = secondsToMilliseconds(item.end, maxDurationMs);
    if (
      startMs < previousEndMs ||
      endMs < startMs ||
      typeof item.text !== "string" ||
      item.text.length > MAX_SEGMENT_TEXT_CHARS
    )
      throw new TranscriptionError("invalid-response");
    previousEndMs = endMs;
    return { startMs, endMs, text: safeText(item.text, textLimit) };
  });
}

function secondsToMilliseconds(value: unknown, maxDurationMs: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value * 1000 > maxDurationMs
  )
    throw new TranscriptionError("invalid-response");
  const result = Math.round(value * 1000);
  if (!Number.isSafeInteger(result)) throw new TranscriptionError("invalid-response");
  return result;
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const details = await stat(path).catch(() => null);
  if (!details?.isFile() || !Number.isSafeInteger(details.size) || details.size > maxBytes)
    throw new TranscriptionError("input-too-large");
  const chunks: Buffer[] = [];
  let size = 0;
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        stream.destroy();
        throw new TranscriptionError("input-too-large");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof TranscriptionError) throw error;
    throw new TranscriptionError("input-too-large");
  }
  return Buffer.concat(chunks, size);
}

async function readResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  const contentLengthBytes = contentLength === null ? null : Number(contentLength);
  if (
    contentLength !== null &&
    (!Number.isSafeInteger(contentLengthBytes) ||
      contentLengthBytes < 0 ||
      contentLengthBytes > maxBytes)
  )
    throw new TranscriptionError("invalid-response");
  if (!response.body) throw new TranscriptionError("invalid-response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new TranscriptionError("invalid-response");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (signal.aborted) {
      void reader.cancel().catch(() => undefined);
      throw new TranscriptionError("timeout");
    }
    throw error;
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new TranscriptionError("timeout"));
  return new Promise<T>((resolveResult, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new TranscriptionError("timeout"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolveResult(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  maxStderrBytes: number,
): Promise<{
  readonly code: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnFailed: boolean;
}> {
  return new Promise((resolveResult) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let stderrBytes = 0;
    let timedOut = false;
    let spawnFailed = false;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < maxStderrBytes) {
        const bytes = chunk.subarray(0, maxStderrBytes - stderrBytes);
        stderr += bytes.toString("utf8");
        stderrBytes += bytes.byteLength;
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveResult({ code, stderr, timedOut, spawnFailed });
    });
  });
}

function classifyDerivativeFailure(stderr: string): TranscriptionFailureKind {
  return /invalid|unsupported|codec|format|decode|input/iu.test(stderr)
    ? "unsupported-format"
    : "internal";
}

function normalizeMime(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TranscriptionError("configuration");
  return value;
}

async function makeTemporaryDirectory(root: string): Promise<string> {
  return mkdtemp(join(root, `transcription-${randomUUID()}-`));
}

function unavailableAdapter(): TranscriptionAdapterPort {
  return {
    transcribe: async () => {
      throw new TranscriptionError("configuration");
    },
  };
}

function isPrivateHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.endsWith(".internal") || hostname.endsWith(".local") || hostname.endsWith(".lan"))
    return true;
  if (hostname.endsWith(".test") || (!hostname.includes(".") && /^[a-z0-9-]+$/u.test(hostname)))
    return true;
  if (isIP(hostname)) return isPrivateAddress(hostname);
  return false;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, "").toLowerCase();
}

function isPrivateAddress(address: string): boolean {
  const hostname = normalizeHostname(address);
  const family = isIP(hostname);
  if (family === 6) {
    const firstByte = Number.parseInt(hostname.slice(0, 2), 16);
    return hostname === "::1" || firstByte === 0xfc || firstByte === 0xfd;
  }
  if (family !== 4) return false;
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return false;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

async function resolveEndpointAddresses(hostname: string): Promise<readonly string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
