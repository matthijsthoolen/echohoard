# EchoHoard architecture and quality rules

## System context

```text
Android sync tool (external)
        |
        v
/data/inbox --claim--> immutable snapshot + manifest
        |                         |
        |                         v
        |                  wa-crypt-tools subprocess
        |                         |
        |                         v
        |                 disposable msgstore.db
        |                         |
        +-------------------------v
                       WhatsAppAndroidAdapter
                                |
                                v
                  application import/reconcile services
                         |                 |
                         v                 v
                 external PostgreSQL   EchoHoard media CAS
                         |
                +--------+---------+
                v                  v
       Authentik web UI       read-only MCP
                                  |
                                  v
                           Hermes / Saphira
```

The encrypted snapshot is the reproducible source artifact. PostgreSQL and the media CAS are the optimized archive and remain recoverable through their own backup contract.

## Runtime topology

One public build produces two roles from one image and codebase:

- `web`: Next.js UI, authenticated route handlers, health/readiness, and private MCP transport;
- `worker`: inbox polling, job claiming, decryption subprocess, SQLite adaptation, import, and media reconciliation.

The roles share PostgreSQL and mounted `/data` paths. V1 runs one worker replica. No broker or distributed scheduler exists. The Python dependency is a subprocess inside the worker image, not a network service.

## Logical modules and allowed dependencies

```text
src/domain                 pure entities, values, invariants
src/application            use cases and ports
src/infrastructure/db      Prisma and PostgreSQL implementations
src/infrastructure/files   inbox, snapshots, work, and media CAS
src/infrastructure/crypto  wa-crypt-tools subprocess adapter
src/adapters/whatsapp      versioned SQLite schema adapters
src/delivery/web           React UI and authenticated HTTP routes
src/delivery/mcp           validation, auth, and read-only tool mapping
src/worker                 job loop and composition root
```

Allowed direction:

```text
delivery -------> application -------> domain
worker ----------> application -------> domain
infrastructure --> application ports + domain types
adapters --------> application ports + domain types
```

Forbidden examples:

- domain importing Prisma, React, Next.js, MCP SDK, Node filesystem, or subprocess APIs;
- web routes, React components, or MCP handlers calling Prisma directly;
- application code naming WhatsApp tables or columns;
- the WhatsApp adapter writing normalized rows directly;
- infrastructure depending on delivery modules;
- cross-archive queries without an explicit archive scope.

Enforce these rules mechanically with ESLint import restrictions or a small dependency-boundary tool. Prefer one mechanism; do not introduce a separate architecture platform.

## Archive ownership

V1 authenticates one real person, but the model is not globally single-user:

```text
User 1---* Archive 1---* Source 1---* Snapshot
                  |
                  +---* Person / Identity
                  +---* Conversation / Participant
                  +---* Message / Revision / Reaction
                  +---* Attachment / MessageAttachment
                  +---* ImportJob
```

Every root aggregate has `archive_id`, and child access inherits and verifies it. Unique constraints include `archive_id` where identity would otherwise be global. A future sharing model can grant access to an Archive without merging ownership or weakening isolation.

## Source and identity rules

- Preserve WhatsApp JIDs, LIDs, stanza/message IDs, chat IDs, sender IDs, and source type codes when present.
- Never use a SQLite row ID as durable archive identity.
- Prefer a namespaced source key such as `{source}:{conversation-stable-id}:{message-stable-id}`.
- When no stable message ID exists, derive a versioned deterministic fingerprint from stable source fields. Record that fallback was used and detect collisions instead of silently merging them.
- Link exact verified identifier transitions. Do not merge people because names look similar.
- Keep display names as observations/aliases rather than overwriting identity history.
- Retain `first_seen_snapshot_id` and `last_seen_snapshot_id` on current normalized records. Each message revision records the first snapshot exposing that revision.
- Snapshot absence is not proof of source deletion.

## Intake state machine

```text
discovered -> settling -> claimed -> hashed -> snapshotted
           -> decrypting -> adapting -> importing -> reconciling -> complete
                                      \-> failed
```

Rules:

- A discovered batch must be unchanged across the configured quiet interval before claim.
- Claim uses an atomic move/marker on the same filesystem or a database lease with an immutable discovered path.
- A source hash already associated with a completed snapshot resolves idempotently.
- The manifest records source filenames, byte sizes, SHA-256 hashes, discovery/claim times, adapter version, and non-secret outcome metadata.
- Large imports may use chunked transactions, but data for the new snapshot remains invisible/ineligible as complete until finalization. Retry must clean or reuse its own run safely.
- Errors are sanitized and classify retryable I/O, invalid key, corrupted backup, unsupported schema, constraint conflict, and internal failure.

## Media ownership and Immich

EchoHoard hashes available WhatsApp attachments and stores each byte sequence once under its own content-addressed path. Message references, original names/paths, MIME observations, sizes, and availability remain in PostgreSQL.

Immich may independently contain the same photo or video. V1 deliberately accepts duplicated bytes across the two products because ownership independence is safer than cross-application deletion and restore coupling. A future read-only connector may correlate EchoHoard SHA-256 with supported Immich API results and store an external asset reference. It must never query Immich's database directly or replace the EchoHoard path with an Immich-owned path.

## Content safety

- Escape text and names; never use source content with `dangerouslySetInnerHTML`.
- Maintain a small safe inline MIME allowlist for raster images, audio, and video.
- Treat HTML, SVG, scripts, executables, and ambiguous MIME as downloads with safe `Content-Disposition`, `nosniff`, and an inert content type.
- Resolve media only through attachment IDs and server-owned paths. Never accept an arbitrary filesystem path from HTTP or MCP.
- Never fetch a URL contained in a message on the user's or agent's behalf.
- Bound result counts, context windows, text sizes, date ranges, and media metadata in every API and MCP schema.
- Mark MCP source fields as untrusted user-controlled evidence in tool descriptions and structured results.

## Search and scale

- Use PostgreSQL generated/search-vector columns or an equivalent migration-managed design with GIN indexes for full-text search.
- Use `pg_trgm` for fuzzy names and text only where measured useful.
- Cursor paginate conversations, messages, and search results; never use unbounded offset pagination on large histories.
- Virtualize the message viewport and fetch bounded pages around stable message cursors.
- Bulk imports use prepared statements, staging tables, `COPY`, or measured batched upserts behind the persistence adapter.
- Generate a deterministic five-million-message / one-million-attachment reference corpus for CI-optional performance tests. Performance data contains no personal content.
- Document the production hardware and query set with every accepted benchmark; a number without its conditions is not evidence.

## Code-quality gates (CQ)

EH-01 must establish one command per gate and an aggregate CI command:

| Gate | Minimum contract |
|---|---|
| Format | deterministic check; CI does not rewrite |
| Lint | no warnings accepted in CI |
| Type check | strict TypeScript, production and tests |
| Architecture | forbidden dependency directions fail CI |
| Unit | fast deterministic tests with enforced coverage |
| Functional | real PostgreSQL service and migrations |
| Browser | focused critical-path tests; may be separate from fast PR unit job |
| Build | production Next.js build and worker entrypoint compile |
| Container | image builds without secrets and runs as non-root |

Initial unit thresholds: 80% statements/lines/functions and 70% branches globally. Critical invariants should normally exceed that, but no arbitrary 100% target is required. Generated code, migration artifacts, and declarative UI wrappers may be excluded explicitly; business modules may not be excluded to manufacture compliance.

Every feature task must add tests at the cheapest seam that proves its behavior. Functional tests are mandatory when correctness depends on PostgreSQL, migrations, filesystem atomicity, subprocess behavior, OIDC authorization, or MCP transport.

## Change control

Create a short ADR before changing any of these:

- application framework, ORM, database, or primary runtime;
- module dependency direction;
- archive identity or deletion semantics;
- source-of-truth or media-ownership boundary;
- authentication or MCP trust boundary;
- job coordination mechanism;
- coverage thresholds;
- introduction of another persistent service.

An ADR records context, decision, consequences, migration, and verification. It is not required for ordinary implementation choices inside the established boundaries.
