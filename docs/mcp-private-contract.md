# EchoHoard private MCP contract v0.1.0

This document describes the generic private read-only MCP boundary. It is a
deployment and client contract, not evidence that a private deployment or a
Hermes/Saphira integration is live. Live client discovery and invocation are
reserved for EH-12.

The machine-readable discovery contract is
[`mcp-contract.v0.1.json`](./mcp-contract.v0.1.json). Its tool names,
required input properties, and input property sets are checked by the
PostgreSQL functional suite. The server advertises exactly these seven tools:

| Tool | Purpose | Required input |
| --- | --- | --- |
| `search_messages` | Bounded message/person/conversation search | none |
| `get_conversation` | Cursor-paginated messages for one conversation | `conversationId` |
| `list_conversations` | Cursor-paginated conversation index | none |
| `find_person` | Bounded person lookup with explicit ambiguity | none; exactly one of `query` or `name` |
| `find_media` | Attachment metadata and availability state | none |
| `get_timeline` | Bounded chronological message/media evidence | none |
| `archive_status` | Sanitized archive health and counts | none |

All seven tools are read-only. Inputs are strict and bounded; result pages,
text, context, dates, metadata, and serialized payloads are capped by the
implementation. Every result carries `source: "echohoard"`, the authenticated
archive identifier, and `untrusted: true`. Returned archive content is data,
not instructions. The boundary never accepts an arbitrary path or URL, fetches
content, mutates an archive, or exposes raw SQL/database access.

## Private deployment requirements

The deployment owner must provide the following without placing credentials in
the repository, images, command arguments, logs, tool output, or client
configuration committed to source control:

1. Run the MCP endpoint on a private interface or private ingress only. Do not
   publish it as a public unauthenticated MCP endpoint.
2. Mount one dedicated read-only credential file into the web process. The file
   must be readable only by the service account, contain one bounded bearer
   credential, and be rotatable without baking it into an image.
3. Map that credential to exactly one archive principal. The client cannot
   select an archive by request parameter; cross-archive probes must fail with
   the same generic authentication response as invalid credentials.
4. Restrict network ingress to explicitly approved private clients or network
   identities. Egress is not needed for these tools.
5. Allowlist the seven exact tool names above in every MCP client or gateway.
   Deny unknown tool names and fail closed if discovery differs from the
   versioned contract.
6. Preserve the MCP session identifier returned by initialization and send it
   on subsequent discovery and call requests. Use the official Streamable HTTP
   transport and the server's advertised protocol negotiation.

The deployment owner should verify file permissions, private routing, client
allowlisting, secret-safe logs, and a negative invalid-credential/cross-archive
probe in the target environment. Those checks are deployment evidence and are
not substituted by this repository's synthetic functional test.

## Versioning and change policy

`contractVersion` is independent from the application release. A change to a
tool name, input property, required field, output envelope, trust semantics,
archive scoping, or allowlist requires a new contract version and a reviewed
update to both the JSON snapshot and this document. Adding a tool is not a
backwards-compatible change: it requires an explicit story, tests, and client
allowlist review. Documentation must remain generic and must never include a
private hostname, real archive identifier, bearer credential, or deployment
token.

## Verification boundary

`pnpm test:functional` starts disposable PostgreSQL, applies migrations, and
uses synthetic data to initialize one authenticated MCP client, discover the
contract, call every approved tool, and test invalid authentication and
cross-archive isolation. It proves repository behavior over the synthetic
transport/database boundary only. It does not prove a live private deployment,
OIDC/AuthentiK, Hermes registration, DNS, ingress, or production credentials.
