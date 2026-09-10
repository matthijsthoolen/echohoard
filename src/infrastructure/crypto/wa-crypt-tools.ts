import { readFile, stat, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";

export type DecryptFailureKind = "invalid-key" | "corrupt-source" | "unsupported-format" | "timeout" | "io" | "internal";
export type DecryptResult = { outputPath: string; bytes: number };

export class DecryptError extends Error {
  constructor(readonly kind: DecryptFailureKind, message: string) {
    super(redact(message));
    this.name = "DecryptError";
  }
}

export interface DecryptOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxInputBytes?: number;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_OUTPUT = 512 * 1024;
const DEFAULT_INPUT = 8 * 1024 * 1024 * 1024;
let secretForRedaction = "";
const redact = (value: string): string => secretForRedaction ? value.split(secretForRedaction).join("[REDACTED]") : value;

/** Adapter for the pinned wa-crypt-tools `wadecrypt key encrypted output` CLI. */
export async function decryptCrypt15(
  encryptedPath: string,
  outputPath: string,
  secretFilePath: string,
  options: DecryptOptions = {},
): Promise<DecryptResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_INPUT;
  let key: string;
  try {
    const source = await stat(encryptedPath);
    if (source.size > maxInputBytes) throw new DecryptError("io", "encrypted input exceeds configured limit");
    key = (await readFile(secretFilePath, "utf8")).trim();
    if (!key) throw new DecryptError("invalid-key", "configured key file is empty");
  } catch (error) {
    if (error instanceof DecryptError) throw error;
    throw new DecryptError("io", "unable to read decryption inputs");
  }
  secretForRedaction = key;
  try {
    const result = await run(options.executable ?? "wadecrypt", [secretFilePath, encryptedPath, outputPath], timeoutMs, maxOutputBytes);
    if (result.code !== 0) throw new DecryptError(classify(result.stderr), "wa-crypt-tools failed: " + result.stderr.slice(0, 300));
    return await validateSqlite(outputPath);
  } catch (error) {
    if (error instanceof DecryptError) throw error;
    throw new DecryptError("internal", "decryption failed");
  } finally {
    secretForRedaction = "";
  }
}

async function run(command: string, args: string[], timeoutMs: number, maxOutputBytes: number): Promise<{ code: number; stderr: string }> {
  const child = spawn(command, args, { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { if (stderr.length < maxOutputBytes) stderr += chunk.slice(0, maxOutputBytes - stderr.length); });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [result] = (await once(child, "close")) as [number | null];
  clearTimeout(timer);
  if (result === null) throw new DecryptError("timeout", "decryption timed out");
  return { code: result, stderr: redact(stderr) };
}

async function validateSqlite(path: string): Promise<DecryptResult> {
  try {
    const handle = await open(path, "r");
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    await handle.close();
    if (header.toString("ascii") !== "SQLite format 3\u0000") throw new DecryptError("unsupported-format", "decrypted output is not SQLite");
    const bytes = (await stat(path)).size;
    if (!bytes) throw new DecryptError("corrupt-source", "decrypted SQLite output is empty");
    return { outputPath: path, bytes };
  } catch (error) {
    if (error instanceof DecryptError) throw error;
    throw new DecryptError("corrupt-source", "decrypted output could not be opened read-only");
  }
}

function classify(message: string): DecryptFailureKind {
  const text = message.toLowerCase();
  if (/key|decrypt|mac|auth/.test(text)) return "invalid-key";
  if (/crypt15|crypt14|format|version|unsupported/.test(text)) return "unsupported-format";
  if (/corrupt|integrity|header|padding|invalid/.test(text)) return "corrupt-source";
  return "internal";
}
