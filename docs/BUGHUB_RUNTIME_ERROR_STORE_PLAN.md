# BugHub runtime error store plan

Status: implementation complete; v1.4.23 release pending

This plan is Spotter's implementation TODO for a product-owned local runtime
error projection. It must preserve the Claude-first hook/daemon contracts and
the recursion-safety guarantees described in `CLAUDE.md`.

## Contract

- Collection is disabled unless the canonical dotagents factory reporter
  config contains the JSON boolean `collection.enabled: true`.
- The store never performs network I/O and never inspects reporting credentials.
- Persist only allow-listed aggregates: product/version, component, stable
  error code, fixed message template, severity, SHA-256 fingerprint, count,
  first/last seen, state schema version, OS/arch, status, and sequence.
- Reject exception objects, stderr/stdout, stacks, prompts, hook payloads,
  findings text, absolute paths, file contents, tokens, cookies, and arbitrary
  context at the API boundary.
- Observe each failure at exactly one owning boundary. Do not count a daemon or
  auditor failure again in its hook adapter.
- Storage failure is non-blocking for Spotter but emits one fixed local
  diagnostic with no reflected error text.
- Use owner-private permissions, atomic replacement, a monotonic cursor,
  acknowledgement, explicit resolve/reopen, and retention that preserves every
  unacknowledged record.

## TODO

- [x] Add disabled/missing/malformed config characterization tests.
- [x] Add privacy, aggregation, and duplicate-layer negative fixtures.
- [x] Add cursor/ack, resolve/reopen, retention, mode, and atomic-write tests.
- [x] Implement the product-owned aggregate store and read-only snapshot API.
- [x] Extend diagnostics with a bounded store status that exposes no path or payload.
- [x] Connect fixed-code daemon transport, persistence, and selected auditor
      availability boundaries at one owner layer each without weakening hooks.
- [x] Require canonical `new URL` HTTP(S) endpoint equivalence instead of regex acceptance.
- [x] Isolate production observation in a bounded, killable worker process group and cover blocked
      FIFO plus descendant-process counterexamples.
- [x] Replace application-level stale-owner reclamation with a private SQLite
      `BEGIN IMMEDIATE` mutex whose ownership is released by the OS on crash.
- [x] Create and validate the SQLite mutex file as exclusive owner-private state before
      `DatabaseSync`, with repeated cold 32-process contention coverage.
- [x] Settle isolated observation by its absolute deadline without waiting for worker close.
- [x] Commit a bounded private exact `{id,fingerprint}` receipt ledger atomically with each
      observation, then reconcile uncertain timeout/kill outcomes against the expected fingerprint
      in a separate worker without cross-kind idempotency or double counting.
- [x] Reject duplicate record sequences and preserve explicit `resolved_at` / `reason_code`
      metadata through resolve and reopen transitions, including `resolved_at >= last_seen`.
- [x] Revalidate POSIX uid/mode on every read and rebuild/verify a current-SID-only Windows DACL.
- [x] Run the complete test suite and update product documentation.
- [x] Commit and push this repository independently.

## Release wave

- [x] Bump package metadata and release-facing documentation to `1.4.23` without moving an existing tag.
- [x] Stabilize the isolated-worker FIFO fixture at the production timeout budget and require repeated full-suite green.
- [x] Run `node --test`, pack/secret inspection, and a temporary-prefix registry-equivalent install smoke.
- [ ] Push the release commit and require the public macOS/Linux/Windows CI matrix to pass.
- [ ] After the owner H gate, publish `claude-spotter@1.4.23`, create tag/release, and verify npm `latest` plus a registry-derived global install.
- [ ] Confirm `spotter diagnostics factory` and runtime snapshot/ack from the published package, then record the public SHA and results in CHANGELOG/CLAUDE.
