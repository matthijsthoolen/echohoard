# Upstream references and reuse boundaries

Verified 2026-09-09. Re-check versions, licenses, and interfaces when implementing or upgrading.

| Project | V1 role | Reuse boundary |
|---|---|---|
| [ElDavoo/wa-crypt-tools](https://github.com/ElDavoo/wa-crypt-tools) | Pinned crypt12/14/15 decryption dependency; V1 requires crypt15 | Invoke through a bounded Python adapter. GPL-3.0 license and redistributed-image obligations must be honored. Do not copy cryptography into TypeScript. |
| [B16f00t/whapa](https://github.com/B16f00t/whapa) | Schema research, message-type catalogue, and validation oracle | Do not make its reports/CSV the archive contract. Do not copy code until the exact file license is reviewed. Compare synthetic fixture counts and behaviors. |
| [pedroschott/whatmcp](https://github.com/pedroschott/whatmcp) | Design reference for durable archive identity, idempotency, bounded retrieval, conversation windows, and MCP safety | V1 may adopt concepts, not source. Semantic windows are deferred. Re-check license before copying any implementation. |
| [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) | Reference for linked-device ingestion and the MCP prompt-injection risk | No runtime dependency in V1. Live ingestion and all write/send tools are deferred. MIT-licensed code still requires attribution if reused later. |
| [imbue-ai/datalib](https://github.com/imbue-ai/datalib) | Reference for source-adapter boundaries and non-root crypt15 acquisition | No runtime dependency required. WhatsApp is EchoHoard source adapter 1, not its permanent domain boundary. Re-check license before copying. |
| [Immich](https://github.com/immich-app/immich) | Future read-only media correlation target | Never share physical ownership or query its database. Use supported APIs and hashes only in a later feature. |

## Required implementation checks

Before pinning `wa-crypt-tools`:

1. record the exact package version, source commit, license, artifact hash, and supported Python versions;
2. validate a synthetic crypt15 fixture and a private real snapshot;
3. confirm the key can be supplied without exposing it in process listings or logs;
4. pin the runtime dependency in the container build;
5. retain the license and source-offer/attribution material required by distribution;
6. make failure output pass through an allowlisting redactor.

Before adding or changing a WhatsApp schema adapter:

1. capture only synthetic or irreversibly sanitized schema/row fixtures;
2. compare counts/types against Whapa on the same private source as human-operated acceptance evidence;
3. add unknown-type and malformed-text behavior;
4. prove the source SQLite file opens read-only;
5. record the observed WhatsApp schema fingerprint and adapter selection rule.

## Concepts deliberately deferred

- WhatMCP-style conversation windows and hybrid semantic search;
- `whatsmeow` live history and current-day buffering;
- Datalib-style additional personal-data providers;
- Whapa merge/carving/report generation;
- Immich correlation and deep links.
