# Container runtime contract

The public image contains the web and worker composition roots, but the roles
run as different unprivileged users. The web image default is UID/GID `10001`;
the worker role must be started as UID/GID `10002` (for example with Compose's
`user: "10002:10002"`). Neither role runs as root.

The worker owns the only application write paths:

- `/data` — durable inbox, snapshots, and managed media mounts;
- `/work` — disposable per-job decrypted work files.

The worker secret directory is `/run/echohoard/secrets`. Secret files are
provided by the deployment as read-only mounts and are never copied into the
image or passed as command-line arguments. The web role is intentionally not
given the worker data, work, or secret mounts. A private deployment may mount a
separate read-only media view for the web role when its composition contract
requires it.

The container-level sentinel test in `scripts/test-container.sh` verifies the
effective UID, approved writes, forbidden writes, read-only secret mounts,
role isolation, and absence of a sentinel value from image history and
metadata. It does not use real keys or archive data.
