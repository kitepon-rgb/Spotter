# BugHub runtime error rollout fix plan

Status: in progress
Created: 2026-07-14

## Problem

The published `1.4.23` runtime snapshot correctly requires its parent state
directory to be owner-private. However, `spotter install` creates `~/.spotter`
with the process umask and does not repair an existing directory. Real rollout
hosts therefore have mode `0755` or `0775`; with collection explicitly enabled,
the first snapshot fails before a store exists.

## TODO

- [x] Export one internal helper that prepares the runtime store parent with the
      existing POSIX uid/mode and Windows current-SID-only ACL contract.
- [x] Call that helper before installer-created global state and tool databases.
- [x] Characterize fresh and existing permissive directories, store-absent
      snapshots, and installer invocation without weakening read-time checks.
- [x] Reject a POSIX state-root symlink before repair and prove its target mode is
      unchanged.
- [x] Run the full suite, pack inspection, and registry-equivalent install smoke.
- [ ] Release a patch version, verify npm latest, and update the three rollout hosts.
- [ ] Return to the dotagents Mac canary and archive this completed plan.
