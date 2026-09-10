# WhatsApp Android adapter contract

This is the versioned boundary between a decrypted Android WhatsApp source and
EchoHoard application services. The source is opened read-only by a future
adapter implementation. No application service, persistence port, or domain
type may name source tables, columns, SQLite row identifiers, native type
codes, JIDs, or LIDs.

## Schema fingerprints

The selector requires the complete structural anchors below. Optional columns
and tables are handled by the adapter version that owns the family; their
presence alone never selects an adapter. The names are recorded here because
they are adapter implementation knowledge, not application vocabulary.

| Fingerprint | Structural anchors | Evidence boundary |
| --- | --- | --- |
| `android-current.v1` | `message` with `_id`, `chat_row_id`, `from_me`, `timestamp`, `message_type`, `text_data`; `chat` with `_id`, `jid_row_id`; `jid` with `_id`, `raw_string` | Current Android family described by Whapa's Android-modern reader. |
| `android-legacy.v1` | `messages` with `_id`, `key_remote_jid`, `key_from_me`, `timestamp`, `media_wa_type`, `data` | Relevant legacy Android family described by Whapa's Android-legacy reader. |

The upstream oracle distinguishes the modern `message` family from the older
`messages` family and notes that columns vary between WhatsApp releases. This
contract therefore does not infer support from a table name alone. A future
observed variant needs a new fingerprint, synthetic fixture, and adapter test;
it must not be accepted by broadening optional-column matching.

If exactly one fingerprint matches, selection returns its named adapter
version. If both match, selection returns `ambiguous-whatsapp-schema`; if none
match, it returns `unsupported-whatsapp-schema`. Both are terminal for that
source attempt, preserve the immutable encrypted snapshot, and may not be
marked complete. Diagnostics contain only the sanitized classification.

## Normalized output

The adapter emits source-neutral records under
`whatsapp-android-contract.v1`:

- `person`: stable key, optional display name, and observed source references.
- `identity`: stable key, source reference, and optional explicitly verified
  person link. Similar names never create a link.
- `conversation`: stable key, source reference, kind (`direct`, `group`,
  `broadcast`, or `unknown`), and optional title observation.
- `participant`: conversation key, identity key, and conservative role.
- `message`: stable key, conversation key, optional sender identity, UTC
  timestamp, direction, normalized kind, body state, optional reply key, and
  optional inert unsupported type code.
- `revision`: stable key, message key, ordinal, body state/content, and the
  first snapshot that exposed that revision.

Stable keys are namespaced source observations or versioned deterministic
fallbacks. A source database row identifier is never part of a durable key.
Identifiers that the source represents as JIDs or LIDs remain opaque source
references; only the adapter may classify or reconcile them. Text is hostile
input. Invalid text is represented with `bodyState: damaged` and does not
abort unrelated records.

## Verification

`src/adapters/whatsapp/contract.test.ts` proves deterministic selection for
current, legacy, ambiguous, and unknown synthetic schemas and checks that the
selection result does not expose database vocabulary. Fixture builders and
record mapping are deliberately left to EH-04-02 and later stories.

Reference: Whapa's read-only schema detection and Android readers in
[`whareader.py`](https://github.com/B16f00t/whapa/blob/master/libs/whareader.py).
