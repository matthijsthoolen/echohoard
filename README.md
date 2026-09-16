# EchoHoard

EchoHoard is a self-hosted, provenance-preserving archive for personal communications. WhatsApp Android backups are the first source: EchoHoard preserves encrypted snapshots, decrypts them, imports their contents into a normalized PostgreSQL archive, stores referenced media safely, and exposes the archive through a familiar viewer, search, statistics, health reporting, and a read-only MCP interface.

The code is intended to be public. Every deployment, secret, backup, and item of personal data remains private.

## Status

V1 implementation and private deployment work are in progress. Remaining V1 acceptance, the required V1.1 compatibility foundation, and V2 are represented by the validated leaf-story graph below; a completed plan is not evidence that those leaves are implemented.

- [Feature contract](docs/FEATURE.md)
- [V2 initiative contract](docs/V2_FEATURE.md)
- [Architecture and quality rules](docs/ARCHITECTURE.md)
- [Design system and UX contracts](docs/DESIGN_SYSTEM.md)
- [Validated initiative, feature, and story graph](docs/TASK_GRAPH.md)
- [Upstream references](docs/UPSTREAM.md)
- [Plane publication record](docs/PLANE.md)
- [CI and production seam evidence](docs/ci.md)

Implementation is assigned only through leaf stories. V1 uses `EH-xx-yy`; the required pre-real-data V1.1 foundation uses `EH-13-yy`; V2 uses `EHV2-xx-yy`. Feature/workstream records are trackers, not assignments to implement in one pass.

## Product boundary

EchoHoard owns:

- immutable source snapshots and their manifests;
- decryption orchestration;
- WhatsApp schema adaptation and normalized import;
- archive identity, provenance, reconciliation, and search;
- content-addressed WhatsApp media storage;
- authenticated web and read-only MCP access.

EchoHoard does not own Android-to-Unraid synchronization, WhatsApp's protocol, Immich storage, AI memory extraction, OCR, transcription, or message sending in V1.

## Repository boundary

This repository will contain the reusable public application, tests, container image, and generic deployment example. Private Unraid, Vault, Authentik, Caddy, Komodo, Borg, and Saphira integration belongs in `unraided-treasures`.

## Contributing

Read [AGENTS.md](AGENTS.md) before changing the project. Work from one leaf-story contract in `docs/stories/` and preserve its acceptance evidence.
