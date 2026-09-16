# EchoHoard V1, V1.1, and V2 validated initiative, feature, and story graph

## Hierarchy and execution rule

- Initiatives: EchoHoard V1 and V2, specified in `docs/FEATURE.md` and `docs/V2_FEATURE.md` and represented by overview items in the existing EchoHoard Plane Module.
- Features: EH-01 through EH-14 and EHV2-01 through EHV2-10, specified in `docs/tasks/`. They are outcome trackers, not implementation assignments.
- Executable stories: EH-xx-yy, specified in `docs/stories/`. A worker receives one leaf story plus repository access.

Only executable leaf stories receive a worker model class or may enter Ready. EH-01-01 is the historical V1 entry leaf; EH-13-01 is the V1.1 entry leaf. Every unfinished leaf remains Backlog until all `Blocked by` stories are Done. The tables record the state when each graph section was added; Plane is the live execution state. Feature trackers and initiative overviews remain tracking records.

## Feature map

| Feature | Outcome | Story catalog | Leaves | Feature dependency |
|---|---|---|---:|---|
| EH-01 | Framework and mandatory quality gates | [EH-01 stories](stories/EH-01.md) | 6 | none |
| EH-02 | Archive schema and isolation | [EH-02 stories](stories/EH-02.md) | 5 | EH-01 |
| EH-03 | Snapshot intake and decryption | [EH-03 stories](stories/EH-03.md) | 6 | EH-02 |
| EH-04 | Text import and convergence | [EH-04 stories](stories/EH-04.md) | 7 | EH-03 |
| EH-05 | Rich messages and managed media | [EH-05 stories](stories/EH-05.md) | 6 | EH-04 |
| EH-06 | Bounded reads and search | [EH-06 stories](stories/EH-06.md) | 6 | EH-04 |
| EH-07 | Authenticated archive viewer | [EH-07 stories](stories/EH-07.md) | 6 | EH-05, EH-06 |
| EH-08 | Health and statistics | [EH-08 stories](stories/EH-08.md) | 5 | EH-03, EH-05, EH-06, EH-07 |
| EH-09 | Private read-only MCP | [EH-09 stories](stories/EH-09.md) | 5 | EH-05, EH-06, EH-07, EH-08 |
| EH-10 | Production packaging | [EH-10 stories](stories/EH-10.md) | 5 | EH-07, EH-08, EH-09 |
| EH-11 | Private deployment and recovery | [EH-11 stories](stories/EH-11.md) | 6 | EH-10 |
| EH-12 | Attended real-data acceptance | [EH-12 stories](stories/EH-12.md) | 5 | EH-09, EH-11, EH-13 |
| EH-14 | Saphira-branded failure experience | [EH-14 stories](stories/EH-14.md) | 2 | EH-07 |

## Executable leaf graph

The story catalog linked for each row is the authoritative assignment body.

| Story | Short outcome | Model class | Blocked by | Initial state |
|---|---|---|---|---|
| EH-01-01 | Pin toolchain and compile empty roles | simple | none | Ready |
| EH-01-02 | Enforce module dependency boundaries | simple | EH-01-01 | Backlog |
| EH-01-03 | Enforce unit coverage and lint | simple | EH-01-01 | Backlog |
| EH-01-04 | Add PostgreSQL functional harness | medium | EH-01-01 | Backlog |
| EH-01-05 | Add browser smoke harness | simple | EH-01-01 | Backlog |
| EH-01-06 | Wire PR CI and contributor contracts | medium | EH-01-02, EH-01-03, EH-01-04, EH-01-05 | Backlog |
| EH-02-01 | Add ownership and lifecycle schema | medium | EH-01-06 | Backlog |
| EH-02-02 | Add people and conversation schema | medium | EH-02-01 | Backlog |
| EH-02-03 | Add message and reaction schema | medium | EH-02-01 | Backlog |
| EH-02-04 | Add attachment/link schema | medium | EH-02-01 | Backlog |
| EH-02-05 | Implement archive-scoped ports | medium | EH-02-02, EH-02-03, EH-02-04 | Backlog |
| EH-03-01 | Define intake/decryption contracts | simple | EH-02-05 | Backlog |
| EH-03-02 | Claim stable batches atomically | medium | EH-03-01 | Backlog |
| EH-03-03 | Create immutable snapshots/manifests | medium | EH-03-02 | Backlog |
| EH-03-04 | Implement secret-safe decrypt adapter | complex | EH-03-01 | Backlog |
| EH-03-05 | Recover leases and clean work | medium | EH-03-02, EH-03-04 | Backlog |
| EH-03-06 | Verify intake/decryption lifecycle | medium | EH-03-03, EH-03-05 | Backlog |
| EH-04-01 | Record schema fingerprints/adapter contract | reasoning | EH-03-06 | Backlog |
| EH-04-02 | Build synthetic SQLite fixtures | simple | EH-04-01 | Backlog |
| EH-04-03 | Map identities and conversations | medium | EH-04-01, EH-04-02 | Backlog |
| EH-04-04 | Derive stable message identities | medium | EH-04-01, EH-04-02 | Backlog |
| EH-04-05 | Map text, replies, edits, unsupported | medium | EH-04-02, EH-04-04 | Backlog |
| EH-04-06 | Import one text snapshot transactionally | medium | EH-04-03, EH-04-05 | Backlog |
| EH-04-07 | Prove idempotency and convergence | medium | EH-04-06 | Backlog |
| EH-05-01 | Map common rich message types | simple | EH-04-07 | Backlog |
| EH-05-02 | Resolve media paths safely | medium | EH-04-07 | Backlog |
| EH-05-03 | Store media atomically in CAS | medium | EH-05-02 | Backlog |
| EH-05-04 | Persist/reconcile media availability | medium | EH-05-01, EH-05-03 | Backlog |
| EH-05-05 | Serve media with safe MIME/ranges | medium | EH-05-03 | Backlog |
| EH-05-06 | Verify rich media and hostile content | medium | EH-05-04, EH-05-05 | Backlog |
| EH-06-01 | Define bounded read/cursor contracts | medium | EH-04-07 | Backlog |
| EH-06-02 | Implement conversation/person reads | medium | EH-06-01 | Backlog |
| EH-06-03 | Add full-text search | medium | EH-06-01 | Backlog |
| EH-06-04 | Add trigram and filtered search | medium | EH-06-02, EH-06-03 | Backlog |
| EH-06-05 | Generate deterministic scale corpus | simple | EH-06-01 | Backlog |
| EH-06-06 | Benchmark and tune reads/search | medium | EH-06-04, EH-06-05 | Backlog |
| EH-07-01 | Implement OIDC/archive principal | medium | EH-01-06, EH-02-05 | Backlog |
| EH-07-02 | Build responsive conversation shell | simple | EH-06-02, EH-07-01 | Backlog |
| EH-07-03 | Render virtualized message timeline | medium | EH-07-02 | Backlog |
| EH-07-04 | Render rich messages/media states | medium | EH-05-06, EH-07-03 | Backlog |
| EH-07-05 | Add search/filter context navigation | medium | EH-06-04, EH-07-02 | Backlog |
| EH-07-06 | Verify viewer accessibility/performance | medium | EH-07-03, EH-07-04, EH-07-05 | Backlog |
| EH-08-01 | Define health states/redaction | simple | EH-03-06 | Backlog |
| EH-08-02 | Implement health reads/endpoints | medium | EH-06-02, EH-08-01 | Backlog |
| EH-08-03 | Implement archive statistics | medium | EH-05-06, EH-06-04 | Backlog |
| EH-08-04 | Build health/statistics views | medium | EH-07-01, EH-08-02, EH-08-03 | Backlog |
| EH-08-05 | Bound health/statistics performance | medium | EH-06-06, EH-08-04 | Backlog |
| EH-09-01 | Establish MCP transport/auth | medium | EH-06-01, EH-07-01 | Backlog |
| EH-09-02 | Expose conversation/search tools | simple | EH-06-04, EH-09-01 | Backlog |
| EH-09-03 | Expose person/media/timeline/status | simple | EH-05-06, EH-08-02, EH-09-01 | Backlog |
| EH-09-04 | Enforce MCP envelope/audit/allowlist | medium | EH-09-02, EH-09-03 | Backlog |
| EH-09-05 | Verify/document private MCP contract | medium | EH-09-04 | Backlog |
| EH-10-01 | Build one web/worker image | medium | EH-07-06, EH-08-05, EH-09-05 | Backlog |
| EH-10-02 | Harden runtime and secret mounts | simple | EH-10-01 | Backlog |
| EH-10-03 | Add lifecycle/migration/Compose | medium | EH-10-01, EH-10-02 | Backlog |
| EH-10-04 | Record SBOM/licenses/rollback | simple | EH-10-01 | Backlog |
| EH-10-05 | Run container synthetic acceptance | medium | EH-10-03, EH-10-04 | Backlog |
| EH-11-01 | Add private stack and boundaries | medium | EH-10-05 | Backlog |
| EH-11-02 | Provision scoped Vault identities | complex | EH-11-01 | Backlog |
| EH-11-03 | Configure Authentik/Caddy | medium | EH-11-01, EH-11-02 | Backlog |
| EH-11-04 | Prepare Saphira MCP reachability | medium | EH-11-01, EH-11-02 | Backlog |
| EH-11-05 | Define/schedule recovery unit | medium | EH-11-01 | Backlog |
| EH-11-06 | Deploy and rehearse isolated restore | complex | EH-11-03, EH-11-04, EH-11-05 | Backlog |
| EH-12-01 | Freeze acceptance/evidence controls | simple | EH-11-06, EH-13-08 | Backlog |
| EH-12-02 | Accept real import/convergence | medium | EH-12-01 | Backlog |
| EH-12-03 | Accept scale/security behavior | medium | EH-12-02 | Backlog |
| EH-12-04 | Accept Authentik/Hermes traversal | medium | EH-09-05, EH-11-04, EH-12-02 | Backlog |
| EH-12-05 | Accept restore and sign off V1 | medium | EH-11-06, EH-12-03, EH-12-04 | Backlog |

## V1.1 compatibility feature

EH-13 is required before EH-12 touches real data. It adds persistence/reconciliation foundations only; V2 user interfaces and live sidecars remain outside V1 acceptance.

| Story | Short outcome | Model class | Blocked by | Initial state |
|---|---|---|---|---|
| EH-13-01 | Record observation/materialization ADR | reasoning | none | Ready |
| EH-13-02 | Add owned-account/import scope | medium | EH-13-01 | Backlog |
| EH-13-03 | Separate source/unified conversations | medium | EH-13-01, EH-13-02 | Backlog |
| EH-13-04 | Persist typed import observations | medium | EH-13-01, EH-13-02, EH-13-03 | Backlog |
| EH-13-05 | Import through observation ledger | medium | EH-13-04 | Backlog |
| EH-13-06 | Exclude/re-enable and rematerialize | complex | EH-13-05 | Backlog |
| EH-13-07 | Preserve revoke/delete observations | medium | EH-13-04, EH-13-05 | Backlog |
| EH-13-08 | Prove migration and convergence | medium | EH-13-06, EH-13-07 | Backlog |

## Saphira-branded error experience

EH-14 is an independently valuable browser-experience extension. Its reusable brand foundation may start immediately; the EchoHoard integration follows that canonical asset and skill contract.

| Story | Short outcome | Model class | Blocked by | Initial state |
|---|---|---|---|---|
| EH-14-01 | Canonicalize Saphira brand-image generation | medium | none | Ready |
| EH-14-02 | Build the complete EchoHoard error experience | medium | EH-14-01, EH-07-01 | Backlog |

## V2 feature map

| Feature | Outcome | Story catalog | Leaves | Blocked by |
|---|---|---|---:|---|
| EHV2-01 | Invisible multi-account live ingestion | [stories](stories/EHV2-01.md) | 8 | EH-13-08 |
| EHV2-02 | Reversible unified conversations | [stories](stories/EHV2-02.md) | 5 | EH-13-08 |
| EHV2-03 | Hidden, locked, MCP-private chats | [stories](stories/EHV2-03.md) | 6 | EH-13-08 |
| EHV2-04 | Soft deletion and owner live purge | [stories](stories/EHV2-04.md) | 5 | EH-13-08 |
| EHV2-05 | Media galleries and recovery | [stories](stories/EHV2-05.md) | 7 | EH-13-08 |
| EHV2-06 | Voice/video-note transcription | [stories](stories/EHV2-06.md) | 7 | EH-13-08 |
| EHV2-07 | Integrated V2 acceptance | [stories](stories/EHV2-07.md) | 4 | EHV2-01–06 |
| EHV2-08 | Production ingestion integrity | [stories](stories/EHV2-08.md) | 6 | EH-13-08, EHV2-01-04 |
| EHV2-09 | Privacy-safe unified reads | [stories](stories/EHV2-09.md) | 4 | EHV2-02-02, EHV2-03-03 |
| EHV2-10 | Production transport and release integrity | [stories](stories/EHV2-10.md) | 5 | EH-10-05, EHV2-06-03 |

## V2 executable graph

| Story | Short outcome | Model class | Blocked by | Initial state |
|---|---|---|---|---|
| EHV2-01-01 | Pin and verify wacli contract | reasoning | EH-13-08 | Backlog |
| EHV2-01-02 | Package isolated fixed sidecar | medium | EHV2-01-01 | Backlog |
| EHV2-01-03 | Accept signed durable events | medium | EHV2-01-01, EH-13-08 | Backlog |
| EHV2-01-04 | Normalize live/history observations | medium | EHV2-01-03 | Backlog |
| EHV2-01-05 | Preserve revoke/delete events | medium | EHV2-01-04, EH-13-07 | Backlog |
| EHV2-01-06 | Reconcile live with nightly backup | medium | EHV2-01-04, EHV2-01-05 | Backlog |
| EHV2-01-07 | Add account pairing/health settings | complex | EHV2-01-02, EHV2-01-03 | Backlog |
| EHV2-01-08 | Deploy/accept two-account capture | complex | EHV2-01-06, EHV2-01-07 | Backlog |
| EHV2-02-01 | Implement merge/unmerge commands | medium | EH-13-08 | Backlog |
| EHV2-02-02 | Read unified timeline | medium | EHV2-02-01 | Backlog |
| EHV2-02-03 | Add merge/provenance UI | medium | EHV2-02-01, EHV2-02-02 | Backlog |
| EHV2-02-04 | Apply unified search/statistics | medium | EHV2-02-02 | Backlog |
| EHV2-02-05 | Expose unified chats through MCP | simple | EHV2-02-02, EHV2-02-04 | Backlog |
| EHV2-03-01 | Persist conversation privacy policy | medium | EH-13-08 | Backlog |
| EHV2-03-02 | Add Authentik step-up unlock | complex | EHV2-03-01 | Backlog |
| EHV2-03-03 | Filter hidden/locked UI reads | medium | EHV2-03-01, EHV2-03-02 | Backlog |
| EHV2-03-04 | Build privacy and locked-folder UX | medium | EHV2-03-02, EHV2-03-03 | Backlog |
| EHV2-03-05 | Enforce per-chat MCP visibility | medium | EHV2-03-01, EHV2-02-05 | Backlog |
| EHV2-03-06 | Prove privacy policy composition | medium | EHV2-03-04, EHV2-03-05, EHV2-02-03 | Backlog |
| EHV2-04-01 | Implement soft-delete/restore | medium | EH-13-08 | Backlog |
| EHV2-04-02 | Filter deleted normal reads | medium | EHV2-04-01, EHV2-03-05 | Backlog |
| EHV2-04-03 | Add trash/delete/restore UX | medium | EHV2-04-01, EHV2-04-02 | Backlog |
| EHV2-04-04 | Build owner-only purge CLI | complex | EHV2-04-01, EHV2-06-06 | Backlog |
| EHV2-04-05 | Verify purge isolation/recovery | complex | EHV2-04-02, EHV2-04-04 | Backlog |
| EHV2-05-01 | Add gallery reads/indexes | medium | EH-13-08, EHV2-03-03, EHV2-04-02 | Backlog |
| EHV2-05-02 | Build per-chat gallery | medium | EHV2-05-01 | Backlog |
| EHV2-05-03 | Build global media library | medium | EHV2-05-01, EHV2-05-02 | Backlog |
| EHV2-05-04 | Stage directories/uploads | medium | EHV2-05-01 | Backlog |
| EHV2-05-05 | Rank candidates/exact-hash link | medium | EHV2-05-04 | Backlog |
| EHV2-05-06 | Review/apply media recovery | medium | EHV2-05-03, EHV2-05-05 | Backlog |
| EHV2-05-07 | Deploy/accept gallery recovery | complex | EHV2-05-06 | Backlog |
| EHV2-06-01 | Add transcript/run/version schema | medium | EH-13-08 | Backlog |
| EHV2-06-02 | Select LiteLLM model | medium | EHV2-06-01 | Backlog |
| EHV2-06-03 | Implement transcription adapter | complex | EHV2-06-01, EHV2-06-02 | Backlog |
| EHV2-06-04 | Queue selected/bulk jobs | medium | EHV2-06-03, EHV2-05-03 | Backlog |
| EHV2-06-05 | Show transcripts beside media | medium | EHV2-06-04, EHV2-05-03 | Backlog |
| EHV2-06-06 | Edit/protect human transcripts | medium | EHV2-06-01, EHV2-06-05 | Backlog |
| EHV2-06-07 | Deploy/accept transcription | complex | EHV2-06-04, EHV2-06-06 | Backlog |
| EHV2-07-01 | Prove live/backup/import convergence | medium | EHV2-01-06, EHV2-02-02, EH-13-08 | Backlog |
| EHV2-07-02 | Prove privacy/merge/delete matrix | medium | EHV2-02-05, EHV2-03-06, EHV2-04-03, EHV2-05-03 | Backlog |
| EHV2-07-03 | Prove recovery/transcript authority | medium | EHV2-05-06, EHV2-06-06, EHV2-04-04 | Backlog |
| EHV2-07-04 | Accept and sign off V2 privately | complex | EHV2-01-08, EHV2-03-06, EHV2-04-05, EHV2-05-07, EHV2-06-07, EHV2-07-01, EHV2-07-02, EHV2-07-03, EHV2-08-05, EHV2-08-06, EHV2-09-01, EHV2-10-05 | Backlog |
| EHV2-08-01 | Complete decrypt-to-import worker pipeline | complex | EH-13-08 | Ready |
| EHV2-08-02 | Fence import leases through terminal state | complex | EHV2-08-01 | Backlog |
| EHV2-08-03 | Compose bounded production live intake | medium | EHV2-01-03, EHV2-01-04 | Ready |
| EHV2-08-04 | Prevent poison live receipts from starvation | medium | EHV2-08-03 | Backlog |
| EHV2-08-05 | Converge live and backup edit revisions | medium | EHV2-01-04 | Ready |
| EHV2-08-06 | Invalidate expired sidecar pairing sessions | medium | EHV2-01-07 | Ready |
| EHV2-09-01 | Authorize grouping reads and commands | medium | EHV2-02-01, EHV2-03-03 | Ready |
| EHV2-09-02 | List unified conversations once | medium | EHV2-02-02 | Ready |
| EHV2-09-03 | Scope source-account statistics fully | medium | EHV2-02-04 | Ready |
| EHV2-09-04 | Bind and stabilize every read cursor | complex | EHV2-09-02, EHV2-09-03 | Backlog |
| EHV2-10-01 | Pin LiteLLM transport to validated addresses | complex | EHV2-06-03 | Ready |
| EHV2-10-02 | Expose authenticated production MCP transport | complex | EH-09-05 | Ready |
| EHV2-10-03 | Make Compose readiness fail closed | medium | EH-10-05 | Ready |
| EHV2-10-04 | Gate tagged releases on quality evidence | simple | EHV2-10-03 | Backlog |
| EHV2-10-05 | Require production integration seams in CI | medium | EHV2-08-02, EHV2-08-04, EHV2-09-04, EHV2-10-01, EHV2-10-02, EHV2-10-04 | Backlog |

## Acceptance-criterion ownership

| Initiative criteria | Owning features |
|---|---|
| AC-01–AC-03 | EH-01 |
| AC-04–AC-08 | EH-03, with packaging/acceptance in EH-10 and EH-12 |
| AC-09–AC-16 | EH-02, EH-04, EH-05, with real-data proof in EH-12 |
| AC-17–AC-20 | EH-05 and EH-07 |
| AC-21–AC-23 | EH-06, EH-07, and EH-12 |
| AC-24–AC-25 | EH-08 |
| AC-26–AC-28 | EH-09, EH-11, and EH-12 |
| AC-29 | EH-10 and EH-11 |
| AC-30 | EH-11 and EH-12 |
| EH14-AC-01–EH14-AC-06 | EH-14 |
| EHV2-AC-01–EHV2-AC-04 | EHV2-01, EHV2-02, EHV2-07 |
| EHV2-AC-05–EHV2-AC-06 | EHV2-03, EHV2-04, EHV2-07 |
| EHV2-AC-07–EHV2-AC-08 | EHV2-05, EHV2-06, EHV2-07 |
| EHV2-AC-09 | EHV2-07 |
| EHV2-AC-10 | EHV2-08, EHV2-09, EHV2-10, EHV2-07 |

Each feature contract maps its criteria to concrete leaf acceptance and verification. Final integration stories verify composition without replacing focused leaf proofs.

## Model routing

| Class | Count | Share |
|---|---:|---:|
| simple | 17 | 12.6% |
| medium | 97 | 71.9% |
| complex | 18 | 13.3% |
| reasoning | 3 | 2.2% |
| total | 135 | 100% |

The additional non-routine leaves are isolated to load-bearing identity/upstream decisions, authentication, irreversible cleanup, private filesystem/model/provider boundaries, and attended live acceptance. Ordinary schema, application, UI, and verification work remains simple or medium.

- EH-03-04 combines only the upstream cryptography invocation with its inseparable secret/process boundary.
- EH-04-01 is the single load-bearing WhatsApp schema and identity decision; later import stories consume its recorded contract.
- EH-11-02 owns one high-impact Vault policy and secret-delivery boundary.
- EH-11-06 owns the coordinated private deployment and isolated-restore boundary; splitting deployment from restore would lose the required recovery proof.

## Graph validation

- All 30 initiative acceptance criteria and all 6 EH-14 feature criteria have feature ownership, and every feature has observable leaf acceptance plus verification.
- All 135 leaves declare goal, repository, local constraints, bounded work, acceptance criteria, verification, out of scope, blockers, priority, and model class.
- Every leaf targets one repository; private deployment and acceptance leaves explicitly target `unraided-treasures`.
- The dependency graph is acyclic, every blocker identifies an existing leaf, and cross-feature edges are explicit.
- For each graph section, only leaves whose prerequisites were complete at publication are Ready. Feature and initiative trackers have no worker model class; Plane remains authoritative for current execution state.
- Each leaf fits the one-primary-outcome, one-to-three-deliverable, focused-verification, and at-most-one-difficult-risk-axis guardrails.
- A fresh worker can begin from its leaf contract and repository instructions without the planning conversation; no assignment uses “as discussed” or another hidden decision.
- Safe parallelism remains available after shared contracts; repository verification stays distinct from private authenticated/live acceptance.
- EH-13 changes the V1.1 persistence foundation only. Deferred user-facing capabilities are owned explicitly by the V2 initiative and do not silently widen EH-12.

## Feature contracts

- [EH-01](tasks/EH-01.md)
- [EH-02](tasks/EH-02.md)
- [EH-03](tasks/EH-03.md)
- [EH-04](tasks/EH-04.md)
- [EH-05](tasks/EH-05.md)
- [EH-06](tasks/EH-06.md)
- [EH-07](tasks/EH-07.md)
- [EH-08](tasks/EH-08.md)
- [EH-09](tasks/EH-09.md)
- [EH-10](tasks/EH-10.md)
- [EH-11](tasks/EH-11.md)
- [EH-12](tasks/EH-12.md)
- [EH-13](tasks/EH-13.md)
- [EH-14](tasks/EH-14.md)
- [EHV2 initiative](V2_FEATURE.md)
- [EHV2-01](tasks/EHV2-01.md)
- [EHV2-02](tasks/EHV2-02.md)
- [EHV2-03](tasks/EHV2-03.md)
- [EHV2-04](tasks/EHV2-04.md)
- [EHV2-05](tasks/EHV2-05.md)
- [EHV2-06](tasks/EHV2-06.md)
- [EHV2-07](tasks/EHV2-07.md)
- [EHV2-08](tasks/EHV2-08.md)
- [EHV2-09](tasks/EHV2-09.md)
- [EHV2-10](tasks/EHV2-10.md)
