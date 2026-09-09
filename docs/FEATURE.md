# EchoHoard V1 feature contract

## Title

EchoHoard V1: trustworthy, searchable WhatsApp archive

## Purpose / problem

More than two million personal WhatsApp messages and their attachments exist across Android backup snapshots and media directories. The encrypted snapshots are valuable but difficult to browse, search, reconcile, or expose safely to Saphira. Querying one decrypted `msgstore.db` is not an archive: later backups can omit historical content, WhatsApp schemas change, media lives outside the database, and raw messages are hostile input when returned to an AI.

EchoHoard will turn those inputs into a durable, self-hosted evidence store while retaining the encrypted originals as the reproducible source of truth. V1 must already be useful without semantic search or AI-derived memory.

## Primary user story

As the owner of a large personal WhatsApp history, I want EchoHoard to preserve and reconcile nightly encrypted backups and media into a fast private archive, so that I can reliably browse and search my history and let Saphira retrieve evidence through a read-only interface.

## Start state

- No EchoHoard application or public source repository exists.
- Android-to-Unraid synchronization can deliver `.crypt15` backups and media, but no application owns their intake lifecycle.
- Decryption is currently a manual operation.
- More than two million messages are distributed across source backups rather than a normalized archive.
- `unraided-treasures/stacks/ai/ingestion/importers/whatsapp/README.md` is only a reserved placeholder.
- There is no authenticated viewer, searchable archive, archive health surface, or EchoHoard MCP service.

## End state

- The public EchoHoard source repository contains a tested, documented, containerized application with enforced code-quality and architecture gates.
- A private deployment accepts completed Android-sync batches, preserves an immutable `.crypt15` snapshot and manifest, decrypts it using a secret-file key, imports it idempotently, and removes disposable plaintext work files.
- A normalized PostgreSQL archive preserves source identifiers, message revisions, first/last-seen provenance, attachments, reactions, replies, and unsupported source types without deleting history when later snapshots omit it.
- Referenced WhatsApp media is copied into EchoHoard-owned content-addressed storage; availability and missing-media state are visible. Immich is not a storage dependency.
- The archive remains responsive at a reference scale of five million messages and one million attachment records.
- The sole V1 user authenticates through Authentik. The data model and authorization services isolate every object by archive owner so another user can be added without redesign.
- The web application provides responsive WhatsApp-style browsing, safe media playback/download, full-text and fuzzy search with filters, basic statistics, and archive-health reporting.
- A token-protected internal MCP endpoint exposes only read operations, treats returned source content as untrusted, and is proven callable from the live Hermes/Saphira runtime.
- PostgreSQL data, immutable snapshots, and managed media have documented backup and isolated-restore proof in the private deployment repository.

## Acceptance criteria

### Foundation

- **AC-01:** A clean checkout can install with a frozen lockfile and pass format check, lint, strict type check, architecture-boundary checks, unit coverage, PostgreSQL-backed functional tests, and a production build in pull-request CI.
- **AC-02:** Unit coverage is enforced at no less than 80% for statements, lines, and functions and 70% for branches; reducing a threshold requires an accepted ADR and maintainer approval.
- **AC-03:** Public fixtures contain no real message, identity, media, key, token, database, or personal filesystem data.

### Intake and preservation

- **AC-04:** EchoHoard discovers a quiet/stable inbox batch, claims it once, hashes every accepted source artifact, and writes a manifest before marking the snapshot ready for decryption.
- **AC-05:** The original `.crypt15` file is never modified; an identical source hash does not create a second logical snapshot or duplicate archive data.
- **AC-06:** Decryption uses `wa-crypt-tools` through a bounded subprocess and a secret-file key. The key and plaintext content never enter application logs, manifests, database fields, command-line arguments visible to other users, or the repository.
- **AC-07:** Plaintext SQLite exists only under a per-job work directory and is removed after success and after handled failure. Failed jobs preserve immutable inputs and a sanitized diagnostic.
- **AC-08:** An unsupported or inconsistent source schema cannot be marked complete and cannot make partially imported records visible as a successful snapshot.

### Archive correctness

- **AC-09:** The initial adapter imports direct and group conversations, participants, text, replies, reactions, edits, images, video, voice/audio, documents, locations, contacts, stickers, and source/system events where present.
- **AC-10:** An unknown message type is preserved with its source type code, stable identifiers, timestamp, safe metadata, and an explicit unsupported placeholder; it does not disappear or render as executable content.
- **AC-11:** Importing snapshot A repeatedly produces the same logical archive, identifiers, counts, and media references.
- **AC-12:** Importing snapshots A, B, and C in any order converges on the same preserved history except for fields that explicitly describe snapshot chronology.
- **AC-13:** A message absent from a later snapshot remains in the archive. V1 does not infer deletion from absence and offers no user delete/hide workflow.
- **AC-14:** Every normalized message can be traced to its source, source identifier or deterministic fallback identity, and first-seen snapshot. Revisions retain the snapshot that first exposed each revision.
- **AC-15:** Identity merging is conservative: exact stable identifiers and explicitly verified mappings may merge; fuzzy name similarity never merges people automatically.
- **AC-16:** Every record-access path enforces `archive_id`; functional tests prove one archive cannot read another archive's messages, people, media, jobs, snapshots, statistics, or MCP results.

### Media

- **AC-17:** Available referenced media is hashed and stored once at `/data/media/sha256/<prefix>/<sha256>` while retaining original path/name and message references.
- **AC-18:** Missing media does not block message import. The viewer and health page distinguish referenced, available, missing, and unsafe/unsupported media.
- **AC-19:** Unsafe active content is never served inline. Source HTML and SVG are downloaded or rendered as inert text; images, audio, and video use an explicit safe MIME allowlist.
- **AC-20:** EchoHoard never hardlinks to, deletes from, or treats Immich as authoritative. Stored hashes leave room for a later read-only correlation connector.

### User experience and retrieval

- **AC-21:** After Authentik login, the owner can browse conversations and virtualized/paginated message history on desktop and mobile-width layouts without loading an entire large chat into browser memory.
- **AC-22:** The owner can search message text using PostgreSQL full-text and trigram search and filter by conversation/person, sender direction, date range, and media type.
- **AC-23:** On the five-million-message reference dataset, representative warm searches and first-page conversation loads meet a documented p95 target of two seconds on the production host; full import completes within the nightly operating window of six hours.
- **AC-24:** Statistics show at least total messages, conversations, people, media by availability/type, sent/received distribution, activity over time, and most-active conversations.
- **AC-25:** Archive health shows latest discovered and completed snapshots, latest archived message, job status/duration, counts, media coverage, unsupported-type counts, and actionable failure details without exposing source content or secrets.

### MCP, deployment, and recovery

- **AC-26:** The internal MCP surface exposes only `search_messages`, `get_conversation`, `list_conversations`, `find_person`, `find_media`, `get_timeline`, and `archive_status`; it has no send, delete, mutate, arbitrary-file, or arbitrary-URL operation.
- **AC-27:** MCP inputs are bounded and validated, results are archive-scoped and size-bounded, and source content is explicitly identified as untrusted evidence rather than instructions.
- **AC-28:** An invalid or absent MCP credential is denied. The live Hermes/Saphira profile discovers the allowlisted tools and completes fresh authenticated calls against a hostile synthetic record and a known real-data query.
- **AC-29:** The public image runs without bundled secrets or data and exposes separate web and worker roles from one codebase/image; the private Compose deployment uses external PostgreSQL, Vault-rendered secret files, private storage mounts, and no public MCP port.
- **AC-30:** A scheduled backup captures a consistent PostgreSQL dump plus immutable snapshots and managed media. An isolated restore reconstructs a searchable archive and playable sample attachment before production acceptance.

## Implementation decisions

- Working and product name: **EchoHoard**; repository slug: `echohoard`.
- Public source, private service and data. Public visibility is not permission to publish personal fixtures, deployment secrets, hostnames, or archive content.
- One user in V1. `User -> Archive -> all owned records` is still explicit, and authorization is tested with at least two synthetic archives.
- Android synchronization is external. EchoHoard starts at a delivered inbox batch and owns readiness detection, immutable snapshotting, decryption, and everything after it.
- Inbox readiness uses a configurable quiet period plus repeated file-size/mtime agreement. EchoHoard atomically claims a batch before hashing it; arrivals after claim become a later batch/reconciliation run.
- Storage layout:

  ```text
  /data/inbox/<delivery-id>/
  /data/snapshots/<snapshot-id>/msgstore.db.crypt15
  /data/snapshots/<snapshot-id>/manifest.json
  /data/media/sha256/<first-two>/<sha256>
  /data/work/<job-id>/
  ```

- Encrypted source snapshots and manifests are retained indefinitely unless the owner adopts a future explicit retention policy. Decrypted work is disposable.
- TypeScript, React, boring Next.js, Prisma, PostgreSQL, Tailwind, and shadcn/ui. Use normal route handlers and server functions; no edge runtime, Server Actions dependency, or framework-specific caching tricks in core behavior.
- Prisma owns migrations and ordinary queries. Parameterized PostgreSQL SQL owns FTS, `pg_trgm`, bulk upserts, and measured hot paths.
- `wa-crypt-tools` is a pinned Python runtime dependency invoked through a bounded adapter. Do not reimplement backup cryptography.
- WhatsApp SQLite knowledge stays behind a versioned `WhatsAppAndroidAdapter`. Whapa is a reference/validation oracle, not a runtime dependency or data model.
- The archive is append-preserving, not a mirror. Absence never deletes. A future hide/delete feature must have separate product semantics and audit behavior.
- Media is copied into EchoHoard-owned SHA-256 content-addressed storage. Cross-application physical deduplication with Immich is out of scope; future correlation may use hashes and the supported Immich API.
- One build artifact supplies web and worker entrypoints. Compose may run them as separate roles so job failure or restart does not take down browsing; no Redis, RabbitMQ, Kafka, or separate Python microservice.
- PostgreSQL job rows and transactional claims coordinate the single worker role.
- Authentik OIDC protects the web surface. The service is LAN/Tailscale/private-proxy only in V1.
- MCP is Streamable HTTP on the private application network with a dedicated read-only credential delivered by secret file. It reuses application services, never direct database queries.
- Messages, filenames, metadata, and MCP output are hostile data. React escaping alone is not the whole policy: attachment MIME, URL handling, downloads, logs, and model-facing envelopes are also constrained.

## Verification strategy

1. Fast unit tests cover domain invariants, identifier derivation, reconciliation, identity, path handling, policy, and content rendering decisions.
2. PostgreSQL-backed functional tests cover migrations, constraints, bulk upserts, job claims, archive isolation, FTS/trigram queries, and MCP application services.
3. Synthetic SQLite fixtures represent supported legacy/current schema families, message types, malformed text, missing media, unknown type codes, duplicate snapshots, and reordered snapshot imports.
4. Browser tests cover login boundaries, large-conversation pagination, search/filtering, safe playback/download, health, and statistics.
5. Container tests prove non-root runtime, health/readiness, secret-file handling, work cleanup, and image reproducibility.
6. A generated five-million-message dataset supplies repeatable scale measurements without exposing personal content.
7. Private acceptance uses real snapshots only on the deployment host and records counts/hashes without copying content into CI or Git.
8. Deployment acceptance separately proves Authentik login, Vault delivery, nightly ingestion, fresh process uptime, live viewer/search, Hermes MCP invocation, scheduled backup, and isolated restore.

## Out of scope for V1

- Android sync-tool selection or configuration beyond documenting the inbox contract.
- iOS, Signal, SMS, Telegram, Slack, email, ChatGPT, or other source adapters.
- Live WhatsApp linked-device ingestion or `whatsmeow`.
- Sending, deleting, reacting, editing, or restoring anything in WhatsApp.
- User-visible archive hide/delete and retention controls.
- Immich API integration or shared physical media ownership.
- Embeddings, `pgvector`, semantic conversation windows, AI summaries, GBrain/Mnemosyne memory extraction, or personal timelines.
- OCR, voice transcription, video transcription, or image understanding.
- Conversation export, PDF generation, ZIP export, or restore-to-phone.
- Public internet publication, anonymous access, or multi-user sharing UI.
- Perfect support for every historic/experimental WhatsApp message type; unknown types must be preserved safely.
- Final visual branding beyond the EchoHoard name and a coherent baseline UI.

## Open decisions

The grilling budget was intentionally exhausted. One non-blocking publication decision remains: choose the public repository license before inviting outside contributions. `GPL-3.0-only` is the recommended default because the distributed image invokes the GPL-3.0 `wa-crypt-tools` component and the project is a self-hosted archive, but the application can retain a different compatible license if the subprocess/package boundary and redistribution obligations are documented.

## Repositories

- `/home/matthijs/projects/echohoard` — public reusable application, tests, container image, and generic deployment contract.
- `/home/matthijs/projects/unraided-treasures` — private-instance deployment, Vault, Authentik, Caddy, Komodo, Borg, Saphira registration, and live acceptance records.
