# EchoHoard V2 initiative — living, private, recoverable archive

## Purpose / problem

EchoHoard V1 can preserve and search overlapping Android backups, but its normalized model does not yet distinguish several owned WhatsApp accounts, retain every import observation, combine source chats reversibly, capture messages between nightly backups, or provide owner-controlled privacy, deletion, media recovery, and transcription workflows.

## Primary user story

As the archive owner, I want one continuously updated EchoHoard experience across my WhatsApp numbers and backups, so that I can combine chats, preserve deleted messages, recover and transcribe media, and control what the UI and MCP may reveal without losing source provenance.

## Start state

- V1 imports snapshots idempotently inside one archive and retains first/last-seen provenance.
- Source accounts and source conversations are not first-class; no import can be excluded and rematerialized safely.
- Live linked-device ingestion, manual conversation merge, privacy controls, soft deletion, galleries, lost-media recovery, and transcription are absent.
- Existing V1 read, UI, MCP, job, CAS, Authentik, PostgreSQL, and deployment boundaries are available for extension.

## End state

- One archive accepts backups and live observations from multiple explicitly owned WhatsApp accounts without duplicate logical messages.
- Source conversations remain immutable evidence while reversible unified conversations present one owner-chosen chat across accounts.
- A pinned, replaceable `wacli` sidecar captures live events and deletion tombstones; nightly backup observations supersede matching live-only provenance without removing the logical message.
- Imports can be excluded and re-enabled through deterministic rematerialization, without mutating immutable snapshots.
- Hidden, locked, MCP-denied, soft-deleted, and purged states have distinct audited behavior.
- Per-chat and global galleries expose available and missing media, accept bounded recovery sources, and require review for ambiguous matches.
- Voice and video notes can be transcribed through an owner-selected LiteLLM model; human edits are versioned and never overwritten automatically.

## Acceptance criteria

1. Multiple owned accounts, sources, snapshots, live observations, and source conversations retain independently queryable provenance.
2. Replays, overlapping backups, live-to-backup reconciliation, and import exclusion/re-enable converge without duplicate logical messages or destructive loss.
3. Manual merge and unmerge affect presentation only; every message retains its source conversation, owned account, and observations.
4. WhatsApp revoke/delete events never erase captured content and are visibly represented.
5. UI visibility, locked access, MCP visibility, and soft deletion are independent, fail-closed policies enforced by shared application services.
6. The only irreversible live purge is an owner-operated CLI with dry-run, exact scope, explicit confirmation, and no access to immutable snapshots or backup repositories.
7. Galleries distinguish available, missing, unsafe, and recovered media and never auto-link an ambiguous candidate.
8. Transcripts retain attachment, model, timestamps, source text, edit history, and manual-authority state; automatic runs cannot overwrite a human edit.
9. Repository, container, private deployment, linked-device, Authentik, LiteLLM, MCP, and negative-boundary evidence are recorded separately.

## Implementation decisions

- Complete EH-13 before real-data EH-12 acceptance; it is the V1.1 compatibility foundation, not a V2 user-interface release.
- Keep immutable source observations separate from normalized/presentation entities. Excluding an import changes eligibility and recomputes materialized state; it does not delete the import or snapshot.
- Model each owned WhatsApp account explicitly. Names and phone-like identifiers are never used for fuzzy automatic identity or conversation merging.
- A unified conversation groups source conversations by explicit owner action and can be unmerged. It never moves source messages.
- Use a pinned `wacli` sidecar per named account behind an EchoHoard-owned adapter. EchoHoard owns the UI, normalized data, policies, and MCP. No send, reaction, edit, delete, presence-management, or general `wacli` command surface is exposed.
- The normalized message identity is shared by live and backup adapters. A backup confirmation removes the `live-only` presentation state but retains both observations.
- Preserve captured content after WhatsApp revoke/delete events and show a source-deleted marker. Content never observed before deletion cannot be reconstructed.
- Use Authentik step-up/recent authentication for locked chats; do not create a second password database in EchoHoard.
- Soft deletion is reversible. Hard purge touches only live normalized rows, derived transcripts, and unreferenced EchoHoard CAS objects. Immutable snapshots and external backups are out of reach.
- Exact content hashes may link recovered media automatically. All metadata/fuzzy candidates require explicit owner confirmation.
- Transcription models are selected from the existing LiteLLM catalog in settings; store the selected model with every run and transcript.

## Verification strategy

- PostgreSQL functional suites cover multi-account isolation, observation provenance, rematerialization, merge/unmerge, policy combinations, tombstones, and transcript authority.
- Adapter fixtures cover replayed live events, out-of-order delivery, disconnect/reconnect, revoke-before/after capture, and live-to-backup convergence.
- Browser tests cover pairing/status, merged timelines, locked/hidden navigation, trash/restore, galleries, recovery review, transcription, and manual edits.
- Contract tests prove no forbidden `wacli` operation or arbitrary path/command is reachable.
- Generated scale fixtures measure unified timelines, policy-filtered search, galleries, and rematerialization without personal content.
- Attended private acceptance pairs a disposable/test account path first, verifies bounded live capture, then validates the configured production account without publishing identifiers or content.

## Out of scope

- Sending, reacting, editing, deleting, marking read, typing/presence control, group administration, or restoring content into WhatsApp.
- Guaranteed full history from WhatsApp Web; encrypted backups remain authoritative for deep history.
- Automatic fuzzy conversation/person merge, automatic ambiguous media attachment, OCR, image understanding, speaker diarization, or AI summaries.
- Purging immutable encrypted snapshots or historical backup repositories.
- Sharing locked chats with other users or replacing Authentik.

## Open decisions

None. Provider availability, exact upstream version, and schema details are implementation-time facts verified by their owning stories without reopening the settled product behavior.

## Repositories

- `/home/matthijs/projects/echohoard` — public contracts, schema, adapters, UI, tests, and image.
- `/home/matthijs/projects/unraided-treasures` — private sidecar/deployment, Vault, Authentik, LiteLLM, paths, and attended evidence.
