# Synthetic WhatsApp SQLite fixtures

These SQL dumps are deterministic, synthetic SQLite inputs for the adapter
contract. They contain no exported WhatsApp database bytes or personal
content. Each family has a `valid` fixture and a `damaged` fixture whose
structure still selects the family while one text value is hostile input.

Regenerate them with:

```sh
pnpm generate:fixtures
```

The generator sorts tables and emits columns in the documented fingerprint
order. The fixture tests also compare a fresh build with itself and verify
that both current and legacy variants select their intended adapter.
