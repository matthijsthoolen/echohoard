import { createHmac, randomUUID } from "node:crypto";

const baseUrl = process.env.ECHOHOARD_MCP_BASE_URL;
const token = process.env.ECHOHOARD_MCP_TOKEN;
const webhookSecret = process.env.ECHOHOARD_WACLI_WEBHOOK_SECRET;
const accountKey = process.env.ECHOHOARD_ACCEPTANCE_ACCOUNT_KEY;
const archiveId = process.env.ECHOHOARD_ACCEPTANCE_ARCHIVE_ID;
const deniedConversationId = process.env.ECHOHOARD_ACCEPTANCE_DENIED_CONVERSATION_ID;
const otherConversationId = process.env.ECHOHOARD_ACCEPTANCE_OTHER_CONVERSATION_ID;
const deniedMarker = "synthetic privacy denied evidence";
const importedMarker = "synthetic packaged import evidence";

if (
  !baseUrl ||
  !token ||
  !webhookSecret ||
  !accountKey ||
  !archiveId ||
  !deniedConversationId ||
  !otherConversationId
) {
  console.error("Packaged transport acceptance configuration is incomplete");
  process.exit(2);
}

const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.text() };
};

const call = async (authorization, method, params = {}, session) => {
  const result = await request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  return { ...result, json: parseJson(result.body) };
};

const denied = await call(undefined, "tools/list");
if (denied.response.status !== 401 || denied.body.includes("search_messages")) {
  throw new Error("unauthorized MCP request was not denied without disclosure");
}

const event = {
  Chat: "synthetic-packaged-chat",
  ID: "synthetic-packaged-message",
  SenderJID: "synthetic-contact@s.whatsapp.net",
  Timestamp: "2026-01-01T00:00:00.000Z",
  FromMe: false,
  Text: importedMarker,
  Media: { Type: "image", MimeType: "image/png", Filename: "synthetic.png", FileLength: 12 },
};
const eventBody = JSON.stringify(event);
const eventTimestamp = Math.floor(Date.now() / 1000);
const signature = `sha256=${createHmac("sha256", webhookSecret)
  .update(String(eventTimestamp))
  .update(".")
  .update(accountKey)
  .update(".")
  .update(eventBody)
  .digest("hex")}`;

const wrongAccount = await request("/api/internal/live-events", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-echohoard-account": "synthetic-other-account",
    "x-echohoard-signature": signature,
    "x-echohoard-timestamp": String(eventTimestamp),
  },
  body: eventBody,
});
if (wrongAccount.response.status !== 401 || wrongAccount.body.includes(importedMarker))
  throw new Error("account-rebound webhook was not denied without disclosure");

const accepted = await request("/api/internal/live-events", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-echohoard-account": accountKey,
    "x-echohoard-signature": signature,
    "x-echohoard-timestamp": String(eventTimestamp),
  },
  body: eventBody,
});
if (accepted.response.status !== 202 || parseJson(accepted.body).status !== "accepted")
  throw new Error(`signed synthetic webhook was not accepted (${accepted.response.status})`);

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
const names = discovered.json.result?.tools?.map(({ name }) => name);
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

const imported = await waitForImportedMessage(session);
const conversations = await toolCall("list_conversations", {}, session);
const conversationItems = conversations.result?.structuredContent?.items ?? [];
if (
  !conversationItems.some(({ id }) => id === imported.conversationId) ||
  conversationItems.some(({ id }) => id === deniedConversationId || id === otherConversationId)
)
  throw new Error("MCP conversation visibility did not enforce archive/privacy scope");

const calls = [
  ["search_messages", { query: importedMarker }],
  ["get_conversation", { conversationId: imported.conversationId }],
  ["find_person", { query: "synthetic" }],
  ["find_media", { messageId: imported.messageId }],
  ["get_timeline", { limit: 10 }],
  ["archive_status", {}],
];
for (const [name, params] of calls) {
  const result = await toolCall(name, params, session);
  if (result.result?.isError === true) throw new Error(`MCP tool call failed: ${name}`);
}

const conversation = await toolCall(
  "get_conversation",
  { conversationId: imported.conversationId },
  session,
);
if (!JSON.stringify(conversation).includes(importedMarker))
  throw new Error("packaged worker import was not returned by MCP");
const media = await toolCall("find_media", { messageId: imported.messageId }, session);
if (media.result?.structuredContent?.items?.[0]?.availability !== "missing")
  throw new Error("packaged imported media state was not returned by MCP");

const privacy = await toolCall(
  "get_conversation",
  { conversationId: deniedConversationId },
  session,
);
if (
  privacy.result?.structuredContent?.items?.length !== 0 ||
  JSON.stringify(privacy).includes(deniedMarker)
)
  throw new Error("MCP privacy denial disclosed synthetic content");
const crossArchive = await toolCall(
  "get_conversation",
  { conversationId: otherConversationId },
  session,
);
if (
  crossArchive.result?.structuredContent?.items?.length !== 0 ||
  JSON.stringify(crossArchive).includes("synthetic cross archive evidence")
)
  throw new Error("MCP archive isolation disclosed synthetic content");

const invalid = await call("Bearer wrong-synthetic-token", "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "synthetic-ci", version: "1" },
});
if (invalid.response.status !== 401 || invalid.body.includes(archiveId))
  throw new Error("invalid MCP credential was not denied without disclosure");

console.log(
  "Packaged acceptance passed: signed intake, worker persistence, seven MCP calls, and negative boundaries",
);

async function toolCall(name, params, sessionId) {
  const result = await call(
    `Bearer ${token}`,
    "tools/call",
    { name, arguments: params },
    sessionId,
  );
  if (result.response.status !== 200)
    throw new Error(`MCP call returned ${result.response.status}: ${name}`);
  return result.json;
}

async function waitForImportedMessage(sessionId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await toolCall("search_messages", { query: importedMarker }, sessionId);
    const item = result.result?.structuredContent?.items?.[0];
    if (item?.id && typeof item.id === "string") {
      const conversations = await toolCall("list_conversations", {}, sessionId);
      const conversation = conversations.result?.structuredContent?.items?.find(
        ({ id }) => id !== deniedConversationId && id !== otherConversationId,
      );
      if (conversation?.id) return { messageId: item.id, conversationId: conversation.id };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("worker did not normalize the signed webhook before the timeout");
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("packaged acceptance returned invalid JSON");
  }
}
