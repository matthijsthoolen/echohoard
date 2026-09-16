import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LiteLlmTranscriptionAdapter,
  TranscriptionError,
  createLiteLlmTranscriptionAdapter,
  transcriptionEndpoint,
} from "./transcription.js";

const roots: string[] = [];
const mediaBytes = Buffer.from("synthetic audio sentinel");
const mediaSha256 = createHash("sha256").update(mediaBytes).digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  casRoot: string;
  workRoot: string;
  casPath: string;
  secretPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "echohoard-transcription-"));
  roots.push(root);
  const casRoot = join(root, "media");
  const workRoot = join(root, "work");
  const casPath = join(casRoot, "sha256", mediaSha256.slice(0, 2), mediaSha256);
  await mkdir(dirname(casPath), { recursive: true });
  await writeFile(casPath, mediaBytes);
  const secretPath = join(root, "secret");
  await writeFile(secretPath, "sentinel-provider-key\n", { mode: 0o600 });
  return { casRoot, workRoot, casPath, secretPath };
}

async function commandFixture(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "echohoard-transcription-command-"));
  roots.push(root);
  const command = join(root, "ffmpeg.cjs");
  await writeFile(command, `#!${process.execPath}\n${body}`);
  await chmod(command, 0o755);
  return command;
}

function input(casPath: string, selectedModel = "synthetic/audio") {
  return {
    attachment: {
      archiveId: "archive-synthetic",
      mediaSha256,
      casPath,
      mimeType: "audio/ogg; codecs=opus",
      durationMs: 2_000,
    },
    selectedModel,
  };
}

describe("bounded LiteLLM transcription adapter", () => {
  it("converts only the CAS object and returns sanitized transcript timing", async () => {
    const f = await fixture();
    const command = await commandFixture(
      "require('fs').writeFileSync(process.argv.at(-1), Buffer.from('RIFF synthetic derivative'));",
    );
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(
        JSON.stringify({
          text: "  hello\r\nworld  ",
          language: "EN_us",
          segments: [{ start: 0, end: 1.25, text: "hello" }],
          ignored: "untrusted metadata",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const adapter = createLiteLlmTranscriptionAdapter(
      "http://litellm.test:4000",
      f.secretPath,
      "synthetic/audio",
      f.casRoot,
      f.workRoot,
      { derivativeExecutable: command, fetcher },
    );

    await expect(adapter.transcribe(input(f.casPath))).resolves.toEqual({
      mediaSha256,
      model: "synthetic/audio",
      text: "hello\nworld",
      language: "en-us",
      segments: [{ startMs: 0, endMs: 1250, text: "hello" }],
    });
    expect(requestUrl).toBe("http://litellm.test:4000/audio/transcriptions");
    const form = requestInit?.body as FormData;
    expect(form.get("model")).toBe("synthetic/audio");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(requestInit?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer sentinel-provider-key",
    });
    await expect(readdir(f.workRoot)).resolves.toEqual([]);
  });

  it("does not put secret or media bytes in subprocess arguments", async () => {
    const f = await fixture();
    const argvPath = join(f.workRoot, "argv");
    const command = await commandFixture(
      `require('fs').mkdirSync(process.argv[process.argv.length - 1].split('/').slice(0, -1).join('/'), { recursive: true });
require('fs').writeFileSync('${argvPath}', JSON.stringify(process.argv));
require('fs').writeFileSync(process.argv.at(-1), Buffer.from('RIFF derivative'));`,
    );
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ text: "safe result" })));
    const adapter = new LiteLlmTranscriptionAdapter(
      "https://127.0.0.1:4000",
      "sentinel-provider-key",
      new Set(["synthetic/audio"]),
      f.casRoot,
      f.workRoot,
      { derivativeExecutable: command, fetcher },
    );

    await adapter.transcribe(input(f.casPath));
    const argv = await readFile(argvPath, "utf8");
    expect(argv).not.toContain("sentinel-provider-key");
    expect(argv).not.toContain(mediaBytes.toString());
    expect(argv).not.toContain("safe result");
  });

  it("fails closed for non-CAS paths, unsupported media, model drift, size, and duration", async () => {
    const f = await fixture();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ text: "should not run" })));
    const adapter = new LiteLlmTranscriptionAdapter(
      "http://localhost:4000",
      "sentinel-provider-key",
      new Set(["synthetic/audio"]),
      f.casRoot,
      f.workRoot,
      { fetcher, maxBytes: 1, maxDurationMs: 3_000 },
    );
    await expect(adapter.transcribe(input(join(f.casRoot, "outside")))).rejects.toMatchObject({
      kind: "cas-unavailable",
      retryable: false,
    });
    await expect(
      adapter.transcribe({ ...input(f.casPath), selectedModel: "provider/arbitrary" }),
    ).rejects.toMatchObject({ kind: "model-not-allowed" });
    await expect(
      adapter.transcribe({
        ...input(f.casPath),
        attachment: { ...input(f.casPath).attachment, mimeType: "application/octet-stream" },
      }),
    ).rejects.toMatchObject({ kind: "unsupported-format" });
    await expect(
      adapter.transcribe({
        ...input(f.casPath),
        attachment: { ...input(f.casPath).attachment, durationMs: 3_001 },
      }),
    ).rejects.toMatchObject({ kind: "duration-too-long" });
    await expect(adapter.transcribe(input(f.casPath))).rejects.toMatchObject({
      kind: "input-too-large",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies derivative timeouts and cleans the derivative directory", async () => {
    const f = await fixture();
    const command = await commandFixture("setTimeout(() => {}, 1_000);");
    const adapter = new LiteLlmTranscriptionAdapter(
      "http://service.internal:4000",
      "sentinel-provider-key",
      new Set(["synthetic/audio"]),
      f.casRoot,
      f.workRoot,
      { derivativeExecutable: command, derivativeTimeoutMs: 20 },
    );
    await expect(adapter.transcribe(input(f.casPath))).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });
    await expect(readdir(f.workRoot)).resolves.toEqual([]);
  });

  it("aborts a provider request at the time limit and cleans up", async () => {
    const f = await fixture();
    const derivative = {
      prepare: vi.fn(async ({ destinationPath }) => {
        await writeFile(destinationPath, Buffer.from("RIFF derivative"));
        return { bytes: 10, durationMs: 2_000 };
      }),
    };
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const adapter = new LiteLlmTranscriptionAdapter(
      "http://service.internal:4000",
      "sentinel-provider-key",
      new Set(["synthetic/audio"]),
      f.casRoot,
      f.workRoot,
      { derivative, fetcher, timeoutMs: 20 },
    );
    await expect(adapter.transcribe(input(f.casPath))).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });
    await expect(readdir(f.workRoot)).resolves.toEqual([]);
  });

  it("classifies provider failures without exposing provider body or transcript", async () => {
    const f = await fixture();
    const derivative = {
      prepare: vi.fn(async ({ destinationPath }) => {
        await writeFile(destinationPath, Buffer.from("RIFF derivative"));
        return { bytes: 10, durationMs: 2_000 };
      }),
    };
    const fetcher = vi.fn(
      async () => new Response("provider secret transcript sentinel", { status: 429 }),
    );
    const adapter = new LiteLlmTranscriptionAdapter(
      "http://service.internal:4000",
      "sentinel-provider-key",
      new Set(["synthetic/audio"]),
      f.casRoot,
      f.workRoot,
      { derivative, fetcher },
    );
    const error = await adapter.transcribe(input(f.casPath)).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error).toMatchObject({ kind: "provider-rate-limit", retryable: true });
    expect((error as Error).message).not.toContain("provider secret");
    expect((error as Error).message).not.toContain("transcript sentinel");
    await expect(readdir(f.workRoot)).resolves.toEqual([]);
  });

  it("rejects malformed response metadata and cleans up after validation failure", async () => {
    const f = await fixture();
    const derivative = {
      prepare: vi.fn(async ({ destinationPath }) => {
        await writeFile(destinationPath, Buffer.from("RIFF derivative"));
        return { bytes: 10, durationMs: 2_000 };
      }),
    };
    const adapter = new LiteLlmTranscriptionAdapter(
      "http://service.internal:4000",
      "sentinel-provider-key",
      new Set(["synthetic/audio"]),
      f.casRoot,
      f.workRoot,
      {
        derivative,
        fetcher: async () =>
          new Response(JSON.stringify({ text: "valid", language: "not a language" })),
      },
    );
    await expect(adapter.transcribe(input(f.casPath))).rejects.toMatchObject({
      kind: "invalid-response",
      retryable: false,
    });
    await expect(readdir(f.workRoot)).resolves.toEqual([]);
  });

  it("rejects public or credential-bearing endpoint configuration", () => {
    expect(() => transcriptionEndpoint("https://api.example.com")).toThrow("configuration");
    expect(() => transcriptionEndpoint("https://user:pass@localhost:4000")).toThrow(
      "configuration",
    );
    expect(transcriptionEndpoint("https://litellm.example.test/v1")).toBe(
      "https://litellm.example.test/v1/audio/transcriptions",
    );
  });
});
