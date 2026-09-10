import { spawn } from "node:child_process";

const port = 4317;
const baseUrl = `http://127.0.0.1:${port}`;
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }); let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
});
let start;
let output = "";
const deadline = Date.now() + 15000;
const waitForApp = async () => { let lastError = ""; while (Date.now() < deadline) { try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch (error) { lastError = error.message; } await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`production app did not become ready (${lastError})\n${output}`); };
const main = async () => {
  try {
    const build = await run(["build:web"]); if (build.code !== 0) throw new Error(`production build failed\n${build.output}`);
    start = spawn(command, ["exec", "next", "start", "src/delivery/web", "-p", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    start.stdout.on("data", (chunk) => { output += chunk; }); start.stderr.on("data", (chunk) => { output += chunk; });
    await waitForApp();
    const pageResponse = await fetch(`${baseUrl}/`);
    if (pageResponse.status !== 200) throw new Error(`page status was ${pageResponse.status}`);
    const html = await pageResponse.text();
    if (!html.includes("<h1>EchoHoard</h1>")) throw new Error("production page content mismatch");
    const healthResponse = await fetch(`${baseUrl}/health`);
    if (healthResponse.status !== 200) throw new Error(`health status was ${healthResponse.status}`);
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
