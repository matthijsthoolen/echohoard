import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const port = 4317;
const baseUrl = `http://127.0.0.1:${port}`;
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
let start;
let output = "";
const waitForApp = async () => {
  const deadline = Date.now() + 15000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`production app did not become ready (${lastError})\n${output}`);
};
const main = async () => {
  try {
    const build = await run(["build:web"]);
    if (build.code !== 0) throw new Error(`production build failed\n${build.output}`);
    start = spawn(command, ["exec", "next", "start", "src/delivery/web", "-p", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    start.stdout.on("data", (chunk) => {
      output += chunk;
    });
    start.stderr.on("data", (chunk) => {
      output += chunk;
    });
    await waitForApp();
    const pageResponse = await fetch(`${baseUrl}/`);
    if (pageResponse.status !== 200) throw new Error(`page status was ${pageResponse.status}`);
    const html = await pageResponse.text();
    for (const marker of [
      "EchoHoard",
      'aria-label="Primary navigation"',
      'href="#main-content"',
      "Loading conversations",
    ]) {
      if (!html.includes(marker)) throw new Error(`production page missing ${marker}`);
    }
    const anonymousConversations = await fetch(`${baseUrl}/api/conversations`);
    if (anonymousConversations.status !== 401)
      throw new Error(`anonymous conversation status was ${anonymousConversations.status}`);
    const shellStyles = await readFile("src/delivery/web/styles/globals.css", "utf8");
    for (const marker of [":focus-visible", "@media (max-width: 719px)", ".mobile-nav"]) {
      if (!shellStyles.includes(marker)) throw new Error(`shell styles missing ${marker}`);
    }
    const healthResponse = await fetch(`${baseUrl}/health`);
    if (healthResponse.status !== 200)
      throw new Error(`health status was ${healthResponse.status}`);
    const health = await healthResponse.json();
    if (health.status !== "ok") throw new Error("health response was not ok");
    console.log("Browser harness smoke passed: production page and health seam are reachable");
  } catch (error) {
    console.error(`Browser harness smoke failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (start) start.kill("SIGTERM");
  }
};

await main();
