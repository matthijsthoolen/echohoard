# Private Whapa aggregate comparison

This is a human-run acceptance procedure for a privately available WhatsApp
sample. No decrypted database, message body, identifier, path, or Whapa output
is committed, logged, or pasted into an issue.

1. Work on an encrypted copy in an isolated, Tailscale-only environment. Keep
   the key and decrypted output outside the repository and remove both after
   the run.
2. Run Whapa read-only against the sample and record only sanitized aggregates:
   schema family, conversation count, participant count, message count by
   supported/unsupported type, revision count, and damaged-text count.
3. Import the same sample through EchoHoard. Export the same aggregate fields
   from the archive, without content or identifiers.
4. Compare counts and explicitly document expected differences (for example,
   Whapa may count source rows that EchoHoard quarantines as damaged). Repeat
   after reimport and after importing overlapping sanitized snapshots in each
   A/B/C order; logical counts and keys must converge while first/last-seen
   provenance may differ with chronology.
5. Record pass/fail, tool versions, fixture names, and aggregate values in a
   private operator note. Never store the sample or its output in Git.
