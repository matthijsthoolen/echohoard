# EchoHoard

EchoHoard is a self-hosted, provenance-preserving archive for personal communications. WhatsApp Android backups are the first source: EchoHoard preserves encrypted snapshots, decrypts them, imports their contents into a normalized PostgreSQL archive, stores referenced media safely, and exposes the archive through a familiar viewer, search, statistics, health reporting, and a read-only MCP interface.

The code is intended to be public. Every deployment, secret, backup, and item of personal data remains private.

## Status

Planning is complete. Implementation has not started.

- [Feature contract](docs/FEATURE.md)
- [Architecture and quality rules](docs/ARCHITECTURE.md)
- [Validated task graph](docs/TASK_GRAPH.md)
- [Upstream references](docs/UPSTREAM.md)
- [Plane publication record](docs/PLANE.md)

Implementation starts with [EH-01](docs/tasks/EH-01.md), which creates the application framework and its mandatory quality gates before product features are added.

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

Read [AGENTS.md](AGENTS.md) before changing the project. Work from one task contract in `docs/tasks/` and preserve its acceptance evidence.
