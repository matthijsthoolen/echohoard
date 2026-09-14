# ADR-0002: Multi-source observations and deterministic materialization

- Status: accepted
- Date: 2026-09-14
- Scope: EH-13 V1.1 persistence and reconciliation foundation

## Context

V1 normalized rows describe the current archive view and retain first/last-seen
snapshot metadata, but they cannot explain every contributing import or remove
the conclusions of one corrupt import without deleting evidence. V1.1 must
accept overlapping backup-shaped and live-shaped inputs for more than one
owned WhatsApp account while preserving the distinction between source
evidence and the archive view presented to the owner.

This ADR is schema-neutral. It defines names, keys, invariants, and
reconciliation semantics for later persistence and importer stories; it does
not prescribe tables, an ORM, a migration, a live transport, or a UI.

## Decision

### 1. Keep immutable observations separate from materialized state

The contract has four distinct concepts:

- An **owned account** is an archive-scoped, owner-controlled receiving account
  identity. Its stable key is opaque and is not a phone number. A display label
  is metadata and never an identity key.
- A **source input** is one evidence-producing input for an owned account, such
  as a backup stream or a live sidecar stream. Its source key identifies the
  input, not a conversation or a message.
- A **source conversation** is the account-specific source identity of a chat.
  It is keyed from the owned account and the canonical source conversation
  identity emitted by an adapter. The same chat observed by backup and live
  inputs for one account resolves to one source conversation. Similar names,
  matching titles, and contact guesses never merge source conversations.
- A **unified conversation** is an owner-managed presentation group. It may
  initially contain one source conversation and may later group several of
  them. Group membership does not rewrite source identity or provenance.

An **observation** is immutable evidence from one import. It records the
source identity, import ownership, observation time, and a digest of the
observed value or event. Observations are typed by a closed entity kind and
observation kind. A later implementation must use typed relations or an
equivalent integrity-preserving representation; an unconstrained polymorphic
record with dangling entity IDs is not compliant.

Materialized messages, revisions, reactions, attachment references,
source-conversation views, and unified-conversation views are derived from the
eligible observation set plus owner-managed grouping policy. A materialized
row is never the sole record of provenance: it must be able to enumerate the
observation and import keys that support each visible field or reference.

### 2. Use explicit archive-scoped identity keys

Every key and relation begins with `archiveId`. The following canonical
components are required; an adapter may use a versioned deterministic fallback
only when a stable source identifier is unavailable, and must record that
fallback and detect collisions.

| Concept | Canonical key components | Consequence |
| --- | --- | --- |
| Owned account | `archiveId + accountKey` | Account keys are unique only within an archive. Labels and phone-number-like display data are not keys. |
| Source input | `archiveId + accountKey + sourceKind + sourceKey` | Backup and live inputs remain independently addressable and may reuse source-local keys on different accounts. |
| Source conversation | `archiveId + accountKey + sourceNamespace + sourceConversationKey` | Backup/live inputs converge only when they emit the same account-scoped canonical chat identity. |
| Logical entity | `archiveId + accountKey + sourceNamespace + sourceConversationKey + entityKind + sourceEntityKey` | A message, revision, reaction, or attachment reference can be shared by overlapping inputs only when its account and source identity permit it. |
| Observation | `archiveId + importId + observationKind + sourceConversationIdentityKey + sourceEntityKey + observationKey` | Replaying one import upserts the same observation; another import creates another immutable observation for the same logical entity. |
| Unified conversation | `archiveId + unifiedConversationKey` | The key is owner-assigned and opaque. Presentation grouping is never inferred from names or message content. |

`sourceKind` is a closed, versioned value such as `backup` or `live`; a new
kind needs a contract update. `sourceNamespace` identifies the source
adapter's canonical identity space. `entityKind` is also closed and includes
at least `conversation`, `message`, `revision`, `reaction`, and
`attachment-reference`. A deletion tombstone is an observation kind about a
source entity, not a replacement for the entity's prior content.

The logical message key is source-input independent. Therefore one account's
live event and backup observation can support one logical message while two
accounts with the same source-local chat and message keys remain distinct.
The key must use stable source identity or a versioned fallback fingerprint,
never a SQLite row ID, display name, or fuzzy similarity.

### 3. Separate authoritative fields from derived fields

The following ownership applies regardless of the eventual persistence
technology:

| Authoritative record or control | Derived materialized result |
| --- | --- |
| Archive ownership and owned-account identity | Current account-scoped counts and read models |
| Source input, snapshot, and import-job identity/status | Current source-conversation and message views |
| Immutable typed observation identity, source metadata, value digest, and observed value/event | Selected body, revision, reaction, attachment, availability, and title values |
| Import eligibility decisions and their audit trail | First/last-seen fields and the current contributing-import list |
| Source revoke/delete observations | `sourceDeleted`, content-unavailable, and tombstone presentation status |
| Owner soft-delete state and audit trail | Normal-read filtering of owner-soft-deleted materialized rows |
| Owner-managed unified-conversation membership | Unified conversation reads and derived presentation counts |

Observation content and source metadata are evidence, not instructions. A
source deletion event never overwrites or erases a captured body, media
reference, revision, or attachment. Owner soft deletion is a separate policy
field and cannot be set by a WhatsApp observation.

### 4. Make eligibility reversible and rematerialization deterministic

Import exclusion is an audited eligibility decision, not deletion. Excluding
an import:

1. records the import key, actor or automation identity, reason, timestamp,
   idempotency key, and resulting status;
2. leaves the source input, snapshot, import job, and every observation intact;
3. derives the affected logical entities from eligible observations only; and
4. publishes a new complete materialization generation only after the rebuild
   has finished successfully.

Re-enabling removes or supersedes the exclusion decision through the same
audited path and recomputes from the same immutable observations. A retry of
the same exclusion or re-enable is idempotent. A failed or interrupted rebuild
may leave a recoverable work generation, but it must not be presented as a
successful current generation or expose a partially recomputed conclusion.

The materialization input is the ordered set of eligible observations and the
versioned reconciliation policy. The implementation records an input-set
digest and a materialization-run identifier. Equal inputs, policy version, and
owner grouping state produce equal normalized values, stable logical IDs, and
equal contributing-import sets. Chronology fields such as first/last seen are
recomputed from the eligible set and are allowed to change when eligibility
changes.

### 5. Apply fixed, auditable conflict precedence

For each materialized field, the implementation evaluates only eligible
observations supporting that field and records the selected observation key,
candidate set digest, and precedence details. The fixed precedence for a
usable value is:

1. a usable/present value beats a missing, damaged, or unavailable placeholder;
2. a backup-confirmed value beats a live-only value for the same logical
   entity and field;
3. among observations with the same confirmation class, the later
   `observedAt` wins; and
4. an exact lexicographic comparison of the immutable `observationKey` breaks
   a timestamp tie.

The precedence is per field, so a newer observation may win a caption without
silently replacing an older body or attachment reference. A new observation
with a conflicting digest is retained and audited; it is never silently
merged into or used to overwrite the losing observation. A source deletion
or revoke is evaluated as status/event evidence independently of content
precedence. If at least one eligible deletion observation exists,
`sourceDeleted` is true, while the selected prior content remains available.

For a logical entity with an eligible live observation but no eligible backup
confirmation, the derived provenance state is `live-only`. Once an eligible
backup observation supports the same logical identity it becomes
`backup-confirmed`; both observations remain enumerable. Excluding the backup
can return the state to `live-only`, and re-enabling it restores the
backup-confirmed result when no other inputs changed.

### 6. Preserve deletion history and distinguish soft deletion

Revoke/delete observations are append-preserving tombstones with their own
source event identity, source metadata, observed time, and value digest. They
support all event orders:

- revoke after content marks the source entity deleted while retaining the
  previously captured content;
- revoke before content creates a content-unavailable tombstone; and
- later valid content can fill the tombstone without removing its deletion
  observation or history.

Absence from an import is not a deletion observation. Owner soft deletion is
set only by an owner-authorized policy operation, has separate actor/time and
reason audit fields, and remains independent from source deletion. Hard purge
and user-facing restore semantics are outside this ADR and the V1.1
implementation scope.

### 7. Require provenance and audit fields

Every materialized visible entity or reference must retain or be able to
enumerate, at minimum:

- `archiveId`, `accountKey`, source input key, source conversation identity,
  import key, and observation key;
- source entity identity, entity kind, observation kind, observation time, and
  value digest;
- eligibility status and every eligibility change's actor/automation,
  timestamp, reason, and idempotency key;
- materialization-run ID, policy version, input-set digest, selected
  observation key per derived field, and generated time;
- source deletion event identity/metadata separately from selected content;
  and
- owner soft-delete actor, timestamp, and reason separately from all source
  observations.

Raw secrets, decryption keys, and unbounded diagnostic/source content are not
audit fields. Safe metadata and digests are sufficient to explain a decision
without turning audit output into a second archive copy.

### 8. Enforce invariants at the application and persistence boundaries

Later stories must preserve these invariants:

1. No object crosses an `archiveId` boundary.
2. No account, source, conversation, message, or observation identity is
   global by accident.
3. One source message observed through eligible live and backup inputs has one
   logical identity and multiple immutable observations.
4. Identical source-local keys on two owned accounts never collide.
5. Every visible entity can enumerate all eligible and historical contributing
   imports; exclusion changes eligibility, not evidence.
6. Replay of one import is idempotent for observations and materialized state.
7. Snapshot omission never infers deletion.
8. Fuzzy names, titles, timestamps alone, or message text never cause an
   automatic identity merge.
9. Unknown or conflicting source values fail visibly or remain distinct and
   auditable; they are not silently discarded.
10. A partial rematerialization cannot become the successful current state.
11. Source deletion cannot erase captured content, and source deletion cannot
    set owner soft-delete state.
12. Immutable source artifacts remain outside exclusion and materialization
    deletion paths.

## Migration consequences

Future migrations must add an explicit account root and account-scoped
relations before accepting real data. Existing V1 sources, snapshots, and
import jobs must be mapped to an account through an explicit archive-owned
mapping; a global phone-number or single-account constant is forbidden. If a
synthetic legacy/default account is needed for tests, its identity is
fixture-local and cannot become a production default.

Existing V1 conversations map to one source conversation and one initial
unified conversation group each. Existing stable normalized IDs should be
preserved where their source identity is sufficient. Existing first/last-seen
values become derived values after observations are backfilled. If a legacy
row does not contain enough source identity to create an unambiguous
observation, migration must quarantine or visibly report it for an explicit
mapping decision; it must not guess or silently merge it.

Observation backfill must bind every record to an archive, account, source,
snapshot, and import job and must preserve source identifiers and digests.
The migration must be replayable, must not delete immutable artifacts, and
must prove same-account overlap, two-account isolation, reordered imports,
exclusion/re-enable, and tombstone event order with synthetic data. These are
consequences for EH-13-02 through EH-13-08, not migrations performed by this
ADR.

## Consequences

This decision adds provenance storage and deterministic recomputation work,
but makes overlap, account isolation, exclusion, and deletion behavior
explainable. It permits source conversations to be grouped later without
rewriting evidence and lets a corrupt import be excluded without destructive
cleanup. The cost is that materialized rows are caches of an explicit
observation ledger, and every future importer must emit complete identity and
audit inputs.

Automatic fuzzy merge, destructive import exclusion, absence-as-deletion,
global single-account shortcuts, and a live sidecar coupled directly to the
domain are rejected because each would make provenance or recovery
irreversible.

## EH-13 criterion coverage

| EH-13 feature criterion | Contract location and executable evidence |
| --- | --- |
| Live and backup observations deduplicate to one logical message | Identity keys, Section 5 live-only/backup-confirmed transition, and the overlap example in `fixtures/eh-13-01-observation-contract.json` |
| Same-looking chats on two accounts remain separate | Source-conversation and logical-entity keys plus the account-isolation example |
| Visible entities enumerate contributing imports | Sections 1 and 7's observation/import ownership and materialization audit requirements |
| Exclusion removes unsupported conclusions and re-enable restores them | Section 4's immutable eligibility and generation rules plus the exclusion example |
| Revoke/delete preserves content and metadata | Section 6 tombstone rules plus the tombstone example |
| V1 migration remains account-scoped and leak-free | Migration consequences and Section 8 invariants |

The focused executable fixture test verifies that required identity inputs are
present in every synthetic observation, that live/backup overlap shares only
the intended logical identity, and that two accounts remain isolated. It also
contains a negative omission assertion so removing an identity input fails the
contract check before a persistence implementation is attempted.

## Verification

The fixture is synthetic and contains no real archive content, credentials,
database files, keys, or personal filesystem paths. Run:

```text
pnpm exec vitest run src/application/observation-contract.test.ts
pnpm exec prettier --check docs/adr/0002-multi-source-observations-and-materialization.md fixtures/eh-13-01-observation-contract.json src/application/observation-contract.test.ts
```

Migration, PostgreSQL, importer, live integration, UI, and real-data checks
belong to later EH-13 stories and are intentionally not claimed here.
