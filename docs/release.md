# EchoHoard release flow

The `Publish release image` workflow is the only supported public image
publication path. It runs for a semantic version tag (`vMAJOR.MINOR.PATCH`),
requires the release-mode supply-chain check, and publishes to GHCR with
BuildKit provenance and an SBOM.

Before creating a tag:

1. Resolve the pinned Node and Python base-image tags to immutable digests and
   record them in `docs/supply-chain/upstream-pins.json`.
2. Run `pnpm supply-chain:verify -- --release` and the normal CI gates from a
   clean checkout.
3. Obtain review approval for the tag and the dependency/license record.

After the workflow succeeds, download its `release-metadata.json` artifact and
use the `image` plus `digest` fields for the private stack. The digest, not the
mutable tag, is the deployment reference. Keep the metadata artifact with the
deployment evidence; do not put it, credentials, or archive content in Git.
