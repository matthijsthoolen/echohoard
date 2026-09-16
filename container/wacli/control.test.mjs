import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createControlBridge } from "./control.mjs";

test("pair/cancel terminates the pending upstream auth process and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "echohoard-wacli-control-"));
  const executable = join(root, "fake-wacli.sh");
  await writeFile(
    executable,
    `#!/bin/sh
case "$*" in
  *"auth status"*) printf '%s\\n' '{"authenticated":false}' ;;
  *"--events auth"*) printf '%s\\n' '{"event":"qr_code","data":{"code":"synthetic-qr"}}' >&2; while :; do sleep 1; done ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o755 },
  );
  const bridge = createControlBridge({
    accounts: ["account-a"],
    accountRoot: root,
    executable,
    secretFile: join(root, "secret"),
    port: 0,
  });
  try {
    await bridge.start(0);
    const address = bridge.server.address();
    if (!address || typeof address === "string") throw new Error("control bridge did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await expectJson(`${baseUrl}/accounts/account-a/pair`, "synthetic-qr");
    await expectStatus(`${baseUrl}/accounts/account-a/pair/cancel`, 200);
    await expectStatus(`${baseUrl}/accounts/account-a/pair/cancel`, 200);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pair/cancel fails closed when an authenticated process has no pending auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "echohoard-wacli-control-"));
  const executable = join(root, "fake-wacli.sh");
  await writeFile(
    executable,
    `#!/bin/sh
case "$*" in
  *"auth status"*) printf '%s\\n' '{"authenticated":true}' ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o755 },
  );
  const bridge = createControlBridge({
    accounts: ["account-a"],
    accountRoot: root,
    executable,
    port: 0,
  });
  try {
    await bridge.start(0);
    const address = bridge.server.address();
    if (!address || typeof address === "string") throw new Error("control bridge did not bind");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/accounts/account-a/pair/cancel`,
      { method: "POST" },
    );
    if (response.status !== 503)
      throw new Error(`unexpected cancellation status ${response.status}`);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pair/cancel fails closed when auth completes before the process close callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "echohoard-wacli-control-"));
  let authenticated = false;
  let pairingChild;
  const spawn = (_executable, args) => {
    if (args.includes("status")) {
      const child = new FakeChild();
      process.nextTick(() => {
        child.stdout.end(`${JSON.stringify({ authenticated })}\n`);
        child.close();
      });
      return child;
    }
    pairingChild = new FakeChild(() => {
      // Model wacli committing its linked session as the auth process exits.
      authenticated = true;
      process.nextTick(() => pairingChild.close());
    });
    process.nextTick(() => {
      pairingChild.stderr.write('{"event":"qr_code","data":{"code":"synthetic-qr"}}\n');
    });
    return pairingChild;
  };
  const bridge = createControlBridge({ accounts: ["account-a"], accountRoot: root, spawn });
  try {
    await bridge.start(0);
    const address = bridge.server.address();
    if (!address || typeof address === "string") throw new Error("control bridge did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await expectJson(`${baseUrl}/accounts/account-a/pair`, "synthetic-qr");
    const response = await fetch(`${baseUrl}/accounts/account-a/pair/cancel`, {
      method: "POST",
    });
    if (response.status !== 503)
      throw new Error(`unexpected cancellation status ${response.status}`);
    const retry = await fetch(`${baseUrl}/accounts/account-a/pair/cancel`, { method: "POST" });
    if (retry.status !== 503) throw new Error(`unexpected retry status ${retry.status}`);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function expectJson(url, expectedQr) {
  const response = await fetch(url, { method: "POST" });
  if (!response.ok)
    throw new Error(`pair failed with ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (body.qr !== expectedQr) throw new Error("unexpected QR response");
}

async function expectStatus(url, expected) {
  const response = await fetch(url, { method: "POST" });
  if (response.status !== expected) throw new Error(`expected ${expected}, got ${response.status}`);
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode = null;
  signalCode = null;

  constructor(onKill) {
    super();
    this.onKill = onKill;
  }

  kill(signal) {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.exitCode = 0;
    this.signalCode = signal;
    this.onKill?.();
    return true;
  }

  close() {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", this.exitCode, this.signalCode);
  }
}
