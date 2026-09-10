# Supply-chain and release reproducibility

This directory records the dependency provenance needed to review and
redistribute EchoHoard. It is an engineering record, not legal advice. Before
publishing a release, a maintainer must make the repository-license decision
and have the resulting obligations reviewed by the project owner.

## Authoritative inputs

- `package.json` and `pnpm-lock.yaml` are the Node application and toolchain
  dependency declarations. The lockfile contains the integrity value for
  every package fetched by pnpm; `pnpm install --frozen-lockfile` must be used.
- `container/worker-requirements.txt` is the worker-only Python dependency
  declaration. Every line is an exact version and has a PyPI wheel/sdist
  SHA-256 hash. Docker installs it with pip `--require-hashes`.
- `Dockerfile` pins the Node and Python base-image tags. A release build must
  resolve those tags to immutable image digests and record them in
  `docs/supply-chain/upstream-pins.json` before it is published. The current
  working-tree record intentionally leaves those release-only digests unset;
  inventing a digest would make provenance less trustworthy.
- `echohoard.cdx.json` is the reviewable CycloneDX 1.5 SBOM for the application
  and direct runtime dependencies. Transitive Node packages remain covered by
  the pnpm lockfile and are checked by the verification script.

Run the deterministic local checks with:

```sh
pnpm supply-chain:verify
```

Use `pnpm supply-chain:verify -- --release` in a release checkout. That mode
also refuses to proceed until immutable base-image digests have been recorded.

## License and attribution boundaries

The SBOM marks the EchoHoard application license as `NOASSERTION`. This is
deliberate: the repository is public, but maintainers have not yet selected an
open-source project license. Do not silently add a license file or SPDX
expression as part of dependency work.

`wa-crypt-tools` is pinned at 0.1.0 and is recorded as GPL-3.0-only. Its
transitive Python dependencies and hashes are listed in both the requirements
file and the SBOM. Distribution must preserve the applicable license and
source-offer/attribution material; this repository does not provide a legal
interpretation of those obligations. The dependency is worker-only and must
not be copied into the web role or replaced with copied cryptographic code.

The SBOM also records the licenses reported for the direct Node and Python
dependencies. Re-check upstream license metadata when upgrading a package;
the lockfile integrity value alone proves bytes, not licensing.

## Reproducible build expectation

Release builds use a clean checkout, Node 22.14.0, pnpm 9.15.5, the committed
lockfiles, UTC, and BuildKit with network access only to the pinned package
sources. No archive, secret, local path, or deployment value may enter the
build context. Once the two base-image digests are recorded, run the following
twice in separate clean build directories:

```sh
export BUILDKIT_PROGRESS=plain
docker buildx build --pull --no-cache --provenance=false --sbom=false \
  --build-arg NODE_VERSION=22.14.0-bookworm-slim \
  --build-arg PYTHON_VERSION=3.12.8-slim-bookworm \
  --tag echohoard:eh-10-04-a --load .
docker image inspect echohoard:eh-10-04-a --format '{{.Id}}'
```

Repeat with a fresh tag and compare the resulting image IDs. A mismatch is a
release blocker to investigate (including base-image resolution, toolchain
versions, timestamps, and generated build output); it is not evidence that a
different digest is safe. The checked-in SBOM is intentionally timestamp-free
so it can be compared byte-for-byte.

## Upgrade procedure

1. Change one dependency or base-image pin at a time.
2. Regenerate/update the lockfile with the pinned pnpm version and review the
   resulting integrity/hash changes.
3. Re-check upstream license, source, supported-runtime, and wa-crypt-tools
   compatibility metadata; update `echohoard.cdx.json` and
   `upstream-pins.json` in the same change.
4. Run `pnpm supply-chain:verify`, then the normal format, lint, typecheck,
   architecture, unit, functional, browser, build, and container gates.
5. Build twice under the conditions above and retain the sanitized image IDs,
   SBOM, commit, and verification output as release evidence.

## Rollback dry run

Rollback is an image-reference change, not a database or archive deletion.
The dry-run helper validates two already-known release digests and prints the
operator actions without contacting a registry or mutating deployment state:

```sh
pnpm supply-chain:rollback -- \
  --current sha256:<current-release-digest> \
  --previous sha256:<previous-release-digest>
```

The previous digest must have a matching archived SBOM and migration
compatibility record. Never use a tag as rollback evidence; tags can move.
After an actual deployment rollback (outside this story), verify web health,
worker lease recovery, and read-only archive access before declaring recovery.
