import { createServer } from "node:http";

const page = `<!doctype html><html><head><title>EchoHoard</title></head><body><main><h1>EchoHoard</h1></main></body></html>`;

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const pageResponse = await fetch(`${baseUrl}/`);
    if (pageResponse.status !== 200) throw new Error(`page status was ${pageResponse.status}`);
    const html = await pageResponse.text();
    if (!html.includes("<title>EchoHoard</title>") || !html.includes("<h1>EchoHoard</h1>")) throw new Error("synthetic page content mismatch");
    const healthResponse = await fetch(`${baseUrl}/health`);
    if (healthResponse.status !== 200) throw new Error(`health status was ${healthResponse.status}`);
    const health = await healthResponse.json();
    if (health.status !== "ok") throw new Error("health response was not ok");
    console.log("Browser harness smoke passed: page and health seam are reachable");
  } catch (error) {
    console.error(`Browser harness smoke failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
