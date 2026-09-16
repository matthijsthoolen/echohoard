# ADR-0003: Fixed wacli integration contract

- Status: accepted
- Date: 2026-09-16
- Scope: EHV2-01-01 upstream and adapter boundary

## Context

EchoHoard V2 needs bounded live observations from a linked-device process, but
`wacli` is an untrusted upstream CLI with a substantially wider command surface
than EchoHoard. Its local SQLite files include both a `whatsmeow` session store
and a wacli-owned mirror. Neither database is an EchoHoard integration API.

The planning pin, `openclaw/wacli` v0.15.0, had to be re-checked before a
sidecar could be designed. The current stable release on 2026-09-16 is v0.18.2,
released 2026-09-11. Its release commit is
`cd4370388f03e2234c5f6af14778c9649f230c81`; GitHub reports its commit
signature as verified (`valid`). The Linux amd64 archive is 9,036,823 bytes and
has SHA-256
`d33e8cc4b01acbd4e1ba212e22ac9c6438221e0761112dd3e7a2cc30b3a5946f`.

The release supplies `checksums.txt`, an asset inventory, and a non-Darwin
rebuild manifest. The release's `SIGNING-MANIFEST.json` describes notarized
Darwin binaries; it is not a detached signature for the Linux archive. The
Linux artifact is therefore accepted only when the checksum matches both the
published checksum and inventory, the tag resolves to the verified release
commit, and the archive contains the upstream MIT license. A binary signature
must not be implied where upstream does not publish one.

The release uses Go 1.27.1 and
`go.mau.fi/whatsmeow@v0.0.0-20260909164725-b25a56d63729`. The wacli release
source and its `go.mod` were inspected together; this is the compatibility
pair to test, not a separately selected whatsmeow version. The whatsmeow
repository currently has no release endpoint and its current commits are
unsigned, so its compatibility evidence is the pinned wacli source build and
synthetic contract suite rather than an invented upstream signature.

Maintenance evidence is positive but does not remove the need for pinning:
the repository has protected-main CI, release automation, a current maintainer
listed in the README, and recent signed fixes. v0.18.2 also adds local read
state commands, so the command surface is actively changing and must never be
passed through generically.

## Decision

### Pin and licensing

The replaceable sidecar baseline is the following immutable release artifact:

| Field | Value |
| --- | --- |
| Repository | `openclaw/wacli` |
| License | MIT (upstream `LICENSE`, copyright Peter Steinberger) |
| Version/tag | `v0.18.2` |
| Release commit | `cd4370388f03e2234c5f6af14778c9649f230c81` |
| Target | `linux_amd64` |
| Archive | `wacli_0.18.2_linux_amd64.tar.gz` |
| Archive size | `9036823` bytes |
| Archive SHA-256 | `d33e8cc4b01acbd4e1ba212e22ac9c6438221e0761112dd3e7a2cc30b3a5946f` |
| Upstream source checksum | `checksums.txt` and `ASSET-INVENTORY.json` agree |
| Rebuild evidence | `ASSET-INVENTORY.json` records a byte-identical Linux amd64 rebuild |
| Release signature evidence | GitHub verified commit, reason `valid`; no Linux detached artifact signature |
| whatsmeow module | `v0.0.0-20260909164725-b25a56d63729` |

The public application does not copy wacli code. Any future distributed image
must retain the MIT notice and its dependency notices. The artifact and source
URLs, checksum material, and this ADR are the provenance record; no archive,
session store, QR, webhook secret, or real account data is stored here.

### Fixed operations

Only these operations may be requested by an EchoHoard-owned launcher. The
account name and webhook URL are supplied by the composition root, never by a
normal user or an HTTP request:

1. **Pair/auth:** `wacli --account ACCOUNT --events auth --qr-format text`.
   This is owner-attended and emits an ephemeral `qr_code` lifecycle event.
   Phone-number pairing is not part of the contract.
2. **Follow-sync:** `wacli --account ACCOUNT --events sync --follow
   --presence-mode quiet --webhook FIXED_ENDPOINT --webhook-events
   message,receipt,chat_presence --webhook-secret PROTECTED_VALUE`. The
   launcher supplies the secret from a protected file without accepting a
   secret value from callers. `quiet` suppresses available-presence sends, but
   v0.18.2 still sends the protocol's final unavailable cleanup on shutdown;
   this bounded remote side effect is explicit and tested by the later sidecar
   story. No media download, refresh, backfill, or delegated command is
   enabled.
3. **Cancel pairing:** invalidate the current owner-attended pairing attempt
   through the sidecar's fixed `pair/cancel` operation. The operation is
   idempotent and accepts no QR, command, path, or other caller-controlled
   sidecar input.
4. **Health:** `wacli --account ACCOUNT --read-only --json auth status`.
   The adapter consumes only a boolean authenticated state. The upstream
   linked JID is sensitive and is discarded before application health output.

The command builder contains no generic argv escape hatch. The webhook secret
is represented as a protected-file placeholder in the adapter contract, never
as a value in source, logs, or tests. Because v0.18.2 only accepts
`--webhook-secret SECRET` rather than a file/env selector, EHV2-01-02 must prove
that the launcher/process boundary prevents other principals from observing
the expanded argument, or refuse to start. This ADR does not claim that proof.

### Event and schema contract

The signed transport is an HTTP `POST` to the fixed private endpoint with
`Content-Type: application/json` and
`X-Wacli-Signature: sha256=<lowercase HMAC-SHA256>`. HMAC covers the exact body
bytes. The account key is endpoint/launcher context, not a client-controlled
JSON field.

The v0.18.2 webhook is a flat JSON object. A missing `EventType` means a
message for backward compatibility; the other accepted discriminators are
`receipt` and `chat_presence`. The adapter accepts only bounded, source-neutral
fields:

- messages: chat JID, message ID, sender JID, UTC timestamp, direction, bounded
  text, edit/revoke flags, reply ID, and media type/MIME/name/length metadata;
- receipts: chat/sender, bounded non-empty message ID batch, UTC timestamp, and
  only `delivered`, `read`, or `played`;
- chat presence: chat/sender and only `composing`/`paused`, with empty or audio
  media.

Direct paths, media keys, encryption hashes, raw protocol payloads, and unknown
fields are not part of the EchoHoard contract. Unknown additive JSON fields may
be ignored, but an unknown discriminator, malformed required field, oversize
body, or invalid signature fails closed.

The `--events` stderr stream is a separate NDJSON lifecycle channel with
`{"event": ..., "data": ..., "ts": ...}` envelopes. It is accepted only for
bounded health/lifecycle signals such as `auth_starting`, `qr_code`,
`connected`, `disconnected`, `stream_replaced`, `logged_out`,
`offline_sync_preview`, `offline_sync_completed`, `history_sync`, `progress`,
and `stale`. `history_sync` is a count/lifecycle signal, not a message-content
feed. The current upstream webhook is live-message oriented; it does not
provide signed history message bodies. Consequently, a later sidecar must
either produce history through this adapter's versioned contract or visibly
declare history unavailable; it may not silently read wacli SQLite tables.

The adapter is the only place where `Chat`, `ID`, `SenderJID`, `EventType`,
`MessageIDs`, `Media`, `Revoked`, upstream lifecycle names, or wacli command
flags are known. Application services receive account-scoped neutral records
and never import wacli types, command strings, SQLite names, or session paths.

### Forbidden surface and remote effects

The launcher rejects `send`, `messages edit/delete/revoke/forward`, reactions,
`chats mark-read/mark-unread`, `presence`, group/channel administration,
history backfill, media retry/download, profile changes, logout, store cleanup,
and every unknown or extra command/flag. It also rejects arbitrary webhook
URLs, arbitrary paths, shell fragments, and user-supplied argv. The local
sidecar store and delegate socket are not mounted into web, worker, or MCP
roles.

Pairing necessarily contacts WhatsApp, creates a linked-device session, and
performs upstream bootstrap sync; v0.18.2 also refreshes contacts, groups, and
channels during auth. Follow-sync maintains the linked connection, writes the
upstream local stores, posts signed live events, reconnects, and performs the
final unavailable cleanup. EchoHoard never asks it to send messages, mutate
chat state, manage presence, download media, or recover history. These effects
are operator-visible contract facts, not hidden assumptions.

### Upgrade and rollback

1. A proposed pin changes the version, release commit, artifact hash, license
   evidence, and whatsmeow compatibility tuple together.
2. Verify the tag's release commit, archive checksum against both upstream
   manifests, MIT license presence, and reproducible rebuild evidence before
   staging. Do not accept a release based on a moving tag or a checksum copied
   from one source only.
3. Run the synthetic history/live/revoke/media/account/connection fixtures,
   signature vectors, schema bounds, exact command allowlist, and forbidden
   command tests against the candidate. No live account is used.
4. Validate the candidate against a disposable copied store with the same
   fixed operations. Promotion requires the old and new adapters to emit the
   same versioned neutral event contract and the health/stop behavior to pass.
5. Keep the previous artifact, pin, and store backup. Rollback restores the
   previous artifact and pin as one unit, then runs the same contract suite.
   If either SQLite store was migrated incompatibly, restore the pre-upgrade
   account-store backup rather than opening it with a guessed older binary.
   Immutable EchoHoard snapshots and external backups are never rollback or
   migration inputs.
6. A failed candidate or rollback blocks startup and preserves the source
   stores; it does not fall through to `latest`, rebuild from an unpinned
   commit, or discard events.

## Consequences

This accepts a current, MIT-licensed, reproducibly checked baseline while
making the upstream's wide and changing CLI unreachable from EchoHoard. It
also makes the current lack of signed history bodies and file/env webhook
secret input visible before sidecar implementation. The later sidecar and
event-inbox stories must satisfy those explicit gaps without widening the
application's schema boundary.

## Verification

Synthetic fixtures and focused tests live in
`fixtures/wacli/wacli-contract.v1.json` and
`src/adapters/wacli/contract.test.ts`. They contain no real identifiers,
messages, media, account stores, QR codes, keys, or secrets. The pinned Linux
archive was downloaded separately on 2026-09-16 and verified with:

```text
sha256sum --check --ignore-missing checksums.txt
tar -tzf wacli_0.18.2_linux_amd64.tar.gz
```

The result was `OK`; the archive contained only its top-level directory,
`LICENSE`, `README.md`, and `wacli`. GitHub's verified release-commit evidence
is recorded above. Live pairing and real-data acceptance remain explicitly out
of scope.
