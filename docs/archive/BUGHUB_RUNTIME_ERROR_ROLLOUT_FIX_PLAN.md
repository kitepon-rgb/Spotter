# BugHub runtime error rollout fix plan

Status: complete; v1.4.24 published and three-host rollout verified 2026-07-14
Created: 2026-07-14

## Problem

The published `1.4.23` runtime snapshot correctly requires its parent state
directory to be owner-private. However, `spotter install` created `~/.spotter`
with the process umask and did not repair an existing directory. Real rollout
hosts therefore had mode `0755` or `0775`; with collection explicitly enabled,
the first snapshot failed before a store existed.

## TODO

- [x] Export one internal helper that prepares the runtime store parent with the
      existing POSIX uid/mode and Windows current-SID-only ACL contract.
- [x] Call that helper before installer-created global state and tool databases.
- [x] Characterize fresh and existing permissive directories, store-absent
      snapshots, and installer invocation without weakening read-time checks.
- [x] Reject a POSIX state-root symlink before repair and prove its target mode is
      unchanged.
- [x] Run the full suite, pack inspection, and registry-equivalent install smoke.
- [x] Release a patch version, verify npm latest, and update the three rollout hosts.
- [x] Return to the dotagents Mac canary and archive this completed plan.

## Completion evidence

- Release commit: `52d6086`; CI: `29274984927`; npm/tag/GitHub Release: `1.4.24`.
- Registry-derived global install and runtime snapshot passed on Mac, main-server,
  and FOX WSL2; all three global state roots are owner-only `0700`.
- The resumed dotagents Mac canary accepted the final v1 Oracle retirement report,
  then accepted the first v2 fixed-12-product report with Spotter collection ready.
