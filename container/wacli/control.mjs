import { createServer } from "node:http";
import { spawn as spawnProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_REQUEST_BYTES = 1_024;
const MAX_PROCESS_OUTPUT_BYTES = 32 * 1_024;
const MAX_QR_BYTES = 16 * 1_024;
const PROCESS_TIMEOUT_MS = 15_000;
const TERMINATE_TIMEOUT_MS = 5_000;
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const operationMethods = new Map([
  ["pair", "POST"],
  ["pair/cancel", "POST"],
  ["follow-sync/start", "POST"],
  ["follow-sync/stop", "POST"],
  ["health", "GET"],
]);

export function createControlBridge(overrides = {}) {
  const accounts = parseAccounts(overrides.accounts ?? process.env.WACLI_ACCOUNTS);
  if (accounts.length === 0) throw new Error("WACLI_ACCOUNTS is required");
  const accountRoot =
    overrides.accountRoot ?? process.env.WACLI_ACCOUNT_ROOT ?? "/var/lib/wacli/accounts";
  const webhookBase = fixedWebhookBase(
    overrides.webhookBase ??
      process.env.WACLI_WEBHOOK_BASE_URL ??
      "http://web:3000/api/internal/live-events",
  );
  const executable = overrides.executable ?? process.env.WACLI_EXECUTABLE ?? "/usr/local/bin/wacli";
  const secretFile =
    overrides.secretFile ??
    process.env.WACLI_WEBHOOK_SECRET_FILE ??
    "/run/secrets/wacli_webhook_key";
  const spawn = overrides.spawn ?? spawnProcess;
  const controllers = new Map(
    accounts.map((account) => [
      account,
      new AccountController(account, {
        accountRoot,
        executable,
        secretFile,
        webhookBase,
        spawn,
      }),
    ]),
  );
  let reconciliationTimer;

  const server = createServer((request, response) => {
    void handleRequest(request, response, controllers).catch(() => {
      sendJson(response, 503, { error: "sidecar control unavailable" });
    });
  });
  server.headersTimeout = PROCESS_TIMEOUT_MS;
  server.requestTimeout = PROCESS_TIMEOUT_MS;

  return {
    server,
    async start(port = Number(overrides.port ?? process.env.WACLI_CONTROL_PORT ?? 8080)) {
      await Promise.all([...controllers.values()].map((controller) => controller.reconcile()));
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", resolve);
      });
      reconciliationTimer = globalThis.setInterval(() => {
        for (const controller of controllers.values()) void controller.reconcile();
      }, 30_000);
    },
    async close() {
      if (reconciliationTimer) globalThis.clearInterval(reconciliationTimer);
      await Promise.all([...controllers.values()].map((controller) => controller.close()));
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

class AccountController {
  pairProcess;
  followProcess;
  followRestartTimer;
  followWanted = true;
  pairingCancelled = false;

  constructor(account, options) {
    this.account = account;
    this.accountRoot = options.accountRoot;
    this.executable = options.executable;
    this.secretFile = options.secretFile;
    this.webhookBase = options.webhookBase;
    this.spawn = options.spawn;
  }

  async pair() {
    await this.stopFollow();
    if (this.pairProcess) await this.cancelPairing();
    await this.prepareStore();
    this.pairingCancelled = false;
    const child = this.startProcess([
      "--account",
      this.account,
      "--events",
      "auth",
      "--qr-format",
      "text",
    ]);
    this.pairProcess = child;
    child.once("close", () => {
      if (this.pairProcess === child) this.pairProcess = undefined;
    });
    try {
      const qr = await readQr(child);
      return { qr };
    } catch (error) {
      await terminate(child);
      throw error;
    }
  }

  async cancelPairing() {
    if (this.pairProcess) {
      const child = this.pairProcess;
      await terminate(child);
      if (this.pairProcess === child) this.pairProcess = undefined;
      this.pairingCancelled = true;
      return { cancelled: true };
    }
    if (this.pairingCancelled) return { cancelled: true };
    if (!(await this.authenticated())) {
      this.pairingCancelled = true;
      return { cancelled: true };
    }
    // A completed auth process has already created a linked session. The
    // fixed contract deliberately has no logout operation, so claiming that
    // this cancellation succeeded would leave a stale QR usable upstream.
    throw new Error("pairing invalidation unavailable");
  }

  async startFollow() {
    this.followWanted = true;
    if (this.followProcess) return;
    await this.prepareStore();
    if (!(await this.authenticated())) throw new Error("account is not paired");
    const secret = await readSecret(this.secretFile);
    const endpoint = new URL(this.webhookBase);
    endpoint.searchParams.set("account", this.account);
    const child = this.startProcess([
      "--account",
      this.account,
      "--events",
      "sync",
      "--follow",
      "--presence-mode",
      "quiet",
      "--webhook",
      endpoint.toString(),
      "--webhook-events",
      "message,receipt,chat_presence",
      "--webhook-secret",
      secret,
    ]);
    this.followProcess = child;
    child.once("close", () => {
      if (this.followProcess !== child) return;
      this.followProcess = undefined;
      if (this.followWanted) {
        this.followRestartTimer = globalThis.setTimeout(() => {
          this.followRestartTimer = undefined;
          void this.startFollow().catch(() => undefined);
        }, 1_000);
      }
    });
  }

  async stopFollow() {
    this.followWanted = false;
    if (this.followRestartTimer) globalThis.clearTimeout(this.followRestartTimer);
    this.followRestartTimer = undefined;
    if (!this.followProcess) return;
    const child = this.followProcess;
    await terminate(child);
    if (this.followProcess === child) this.followProcess = undefined;
  }

  async health() {
    const authenticated = await this.authenticated();
    return {
      connection: authenticated ? "connected" : "unpaired",
      checkedAt: new Date().toISOString(),
      reconnectCount: 0,
    };
  }

  async reconcile() {
    if (!this.followWanted || this.followProcess || this.pairProcess) return;
    try {
      if (await this.authenticated()) await this.startFollow();
    } catch {
      // A sidecar restart may race store recovery or a transient upstream
      // outage. The reconciliation timer retries without exposing details.
    }
  }

  async close() {
    this.followWanted = false;
    if (this.followRestartTimer) globalThis.clearTimeout(this.followRestartTimer);
    this.followRestartTimer = undefined;
    await Promise.all(
      [this.pairProcess, this.followProcess]
        .filter((child) => child !== undefined)
        .map((child) => terminate(child)),
    );
  }

  async authenticated() {
    await this.prepareStore();
    const result = await runProcess(
      this.startProcess(["--account", this.account, "--read-only", "--json", "auth", "status"]),
    );
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new Error("invalid wacli health response");
    }
    return value !== null && typeof value === "object" && value.authenticated === true;
  }

  startProcess(args) {
    return this.spawn(this.executable, args, {
      cwd: this.storePath(),
      env: {
        ...process.env,
        HOME: this.storePath(),
        XDG_CONFIG_HOME: join(this.storePath(), "config"),
        XDG_STATE_HOME: join(this.storePath(), ".state"),
        XDG_DATA_HOME: join(this.storePath(), "data"),
        WACLI_ACCOUNT: this.account,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  storePath() {
    return join(this.accountRoot, this.account);
  }

  async prepareStore() {
    await mkdir(this.storePath(), { recursive: true, mode: 0o700 });
    const configPath = join(this.storePath(), ".state", "wacli", "config.yaml");
    try {
      await readFile(configPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(join(this.storePath(), ".state", "wacli"), { recursive: true, mode: 0o700 });
      await writeFile(
        configPath,
        `default_account: ${this.account}\naccounts:\n  ${this.account}:\n    store: ${join(this.storePath(), "data")}\n`,
        { mode: 0o600 },
      );
    }
  }
}

async function handleRequest(request, response, controllers) {
  if (
    request.method === "GET" &&
    new URL(request.url ?? "/", "http://sidecar").pathname === "/health"
  ) {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (request.method !== "GET" && request.method !== "POST") {
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }
  if ((await requestBytes(request)) > MAX_REQUEST_BYTES) {
    sendJson(response, 413, { error: "request exceeds limit" });
    return;
  }
  const path = new URL(request.url ?? "/", "http://sidecar").pathname;
  const match =
    /^\/accounts\/([^/]+)\/(pair|pair\/cancel|follow-sync\/start|follow-sync\/stop|health)$/.exec(
      path,
    );
  if (!match) {
    sendJson(response, 404, { error: "operation not found" });
    return;
  }
  let account;
  try {
    account = decodeURIComponent(match[1]);
  } catch {
    sendJson(response, 404, { error: "operation not found" });
    return;
  }
  const operation = match[2];
  if (operationMethods.get(operation) !== request.method || !controllers.has(account)) {
    sendJson(response, 404, { error: "operation not found" });
    return;
  }
  const controller = controllers.get(account);
  const value =
    operation === "pair"
      ? await controller.pair()
      : operation === "pair/cancel"
        ? await controller.cancelPairing()
        : operation === "follow-sync/start"
          ? await controller.startFollow()
          : operation === "follow-sync/stop"
            ? await controller.stopFollow()
            : await controller.health();
  sendJson(response, 200, value ?? {});
}

function requestBytes(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) request.resume();
    });
    request.on("end", () => resolve(bytes));
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function parseAccounts(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [
    ...new Set(
      values
        .map((account) => String(account).trim())
        .filter((account) => ACCOUNT_NAME.test(account)),
    ),
  ];
}

function fixedWebhookBase(value) {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.search || url.hash)
    throw new Error("WACLI_WEBHOOK_BASE_URL must be a plain http(s) URL");
  return url.toString();
}

async function readSecret(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength > 256) throw new Error("webhook secret is too large");
  const value = bytes.toString("utf8").trim();
  if (!value) throw new Error("webhook secret is empty");
  return value;
}

function runProcess(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      void terminate(child).finally(() => finish(new Error("wacli process timed out")));
    }, PROCESS_TIMEOUT_MS);
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_PROCESS_OUTPUT_BYTES)
        throw new Error("wacli output exceeds limit");
      return next;
    };
    child.stdout.on("data", (chunk) => {
      try {
        stdout = append(stdout, chunk);
      } catch (error) {
        void terminate(child).finally(() => finish(error));
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        stderr = append(stderr, chunk);
      } catch (error) {
        void terminate(child).finally(() => finish(error));
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish(undefined, { stdout, stderr });
      else finish(new Error("wacli process failed"));
    });
    function finish(error, value) {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
  });
}

function readQr(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = globalThis.setTimeout(
      () => finish(new Error("pairing QR timed out")),
      PROCESS_TIMEOUT_MS,
    );
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_PROCESS_OUTPUT_BYTES)
        throw new Error("wacli output exceeds limit");
      return next;
    };
    const line = (value, source) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (source === "stdout") {
        finish(undefined, trimmed);
        return;
      }
      try {
        const event = JSON.parse(trimmed);
        const code = event?.event === "qr_code" && event.data?.code;
        if (typeof code === "string") finish(undefined, code);
      } catch {
        // Non-event diagnostics are intentionally discarded.
      }
    };
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      try {
        stdout += chunk.toString("utf8");
        stdout
          .split("\n")
          .slice(0, -1)
          .forEach((value) => line(value, "stdout"));
        if (Buffer.byteLength(stdout) > MAX_PROCESS_OUTPUT_BYTES)
          throw new Error("wacli output exceeds limit");
      } catch (error) {
        finish(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      try {
        stderr = append(stderr, chunk);
        const lines = stderr.split("\n");
        stderr = lines.pop() ?? "";
        lines.forEach((value) => line(value, "stderr"));
      } catch (error) {
        finish(error);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", () => {
      if (!settled) finish(new Error("pairing process ended before QR"));
    });
    function finish(error, value) {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      if (error) reject(error);
      else if (typeof value !== "string" || Buffer.byteLength(value) > MAX_QR_BYTES)
        reject(new Error("pairing QR exceeds limit"));
      else resolve(value);
    }
  });
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const timer = globalThis.setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, TERMINATE_TIMEOUT_MS);
    child.once("close", finish);
    child.kill("SIGTERM");
    function finish() {
      if (done) return;
      done = true;
      globalThis.clearTimeout(timer);
      resolve();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bridge = createControlBridge();
  await bridge.start();
  const shutdown = () => void bridge.close().then(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
