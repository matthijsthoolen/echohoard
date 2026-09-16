const baseUrl = process.env.ECHOHOARD_MCP_BASE_URL;
const token = process.env.ECHOHOARD_MCP_TOKEN;

if (!baseUrl || !token) {
  console.error("MCP transport acceptance requires ECHOHOARD_MCP_BASE_URL and ECHOHOARD_MCP_TOKEN");
  process.exit(2);
}

const call = async (authorization, method, params = {}, session) => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { response, body: await response.text() };
};

const denied = await call(undefined, "tools/list");
if (denied.response.status !== 401 || denied.body.includes("search_messages")) {
  throw new Error("unauthorized MCP request was not denied without disclosure");
}

const initialized = await call(`Bearer ${token}`, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "synthetic-ci", version: "1" },
});
if (initialized.response.status !== 200)
  throw new Error(`MCP initialize returned ${initialized.response.status}`);
const session = initialized.response.headers.get("mcp-session-id");
if (!session) throw new Error("MCP initialize did not return a session");

const discovered = await call(`Bearer ${token}`, "tools/list", {}, session);
if (discovered.response.status !== 200)
  throw new Error(`MCP discovery returned ${discovered.response.status}`);
const payload = JSON.parse(discovered.body);
const names = payload.result?.tools?.map(({ name }) => name);
const expected = [
  "search_messages",
  "get_conversation",
  "list_conversations",
  "find_person",
  "find_media",
  "get_timeline",
  "archive_status",
];
if (JSON.stringify(names) !== JSON.stringify(expected))
  throw new Error("MCP tool allowlist changed");

console.log("MCP transport acceptance passed: denial, authentication, session, and allowlist");
