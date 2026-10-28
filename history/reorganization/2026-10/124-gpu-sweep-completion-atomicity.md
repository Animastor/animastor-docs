# Stage 124 — Hub sweep and completion-marker atomicity

**Base:** `57c3d58f` plus local Stage 124 worktree changes.  
**Result:** **BLOCKED.** N1 is repaired and locally verified; N2 remains uncorrected because a safe atomic boundary was not implemented. No local commit was created.

## Scope and safety

All DB/Redis-capable commands used `PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1`. No production Redis/PG/Hub, containers, queues, `.env`, Compose, hooks, refs, publish, push, CI, GHCR, or deploy were used. Existing dirty files were left untouched.

## Implemented N1 repair (uncommitted)

Changed files:

- `packages/animastor-orchestration/src/runtime/dispatch-engine.js`
- `backend/node_modules/@animastor/orchestration/src/runtime/dispatch-engine.js` (local generated test mirror, kept source-identical)
- `backend/src/routes/book/generation-routes.cjs`
- `backend/tests/gpu-lane-release-order.test.js`

### Fail-closed response validation

Book-scoped `clearHubDispatches([], { book_id })` still emits exactly one correctly encoded DELETE. HTTP success now counts as `cleared` only if JSON is parseable and has `scope.book_id` as a string exactly equal to the requested book. Missing JSON, malformed JSON, absent scope, a wrong-shaped scope, and mismatched scope all return `{ requested: 1, cleared: 0, failed: 1 }` and warn.

Per-dispatch-ID behavior remains unchanged: one DELETE per unique explicit ID. Existing cache/cancel/delete paths keep their prior safe order (Hub clear before claims release); inspection found no accidental book-sweep use with an explicit ID list.

### Regenerate ordering

Regenerate now runs one confirmed book sweep **before** `releaseClaimsForScene`. It releases claims only for `{ requested: 1, cleared: 1, failed: 0 }`. A timeout, HTTP error, malformed/mismatched echo, unwired port, partial result, or thrown port error leaves claims intact and follows the existing warning path.

This eliminates the Stage 123 unsafe sequence “release claims → failed second sweep → orphan Hub lane entry without its idempotency claim.” A repeated call is safe: the first failed call changes no claims; a later confirmed sweep can release them. While the old claims remain, a parallel dispatch is suppressed as `duplicate_pending`.

## N2 remains BLOCKED — no unsafe partial fix committed

I did **not** change `releaseTaskDoneIfOrphan`. It still bases deletion solely on `already_completed + idem_key`, while artifact probing is earlier and outside a shared fence. The unsafe Stage 123 interleaving therefore remains:

1. a sender sees artifact absent;
2. a valid result writes the artifact and then the completion marker;
3. sender sees `already_completed`, deletes that live marker, and retries.

An adequate fix requires a single fencing protocol shared by result acceptance/artifact write/settlement and send-side orphan release, plus an identity/intent check. A Redis-only marker deletion or an additional non-atomic filesystem recheck does not provide that guarantee, so it was not presented as a completion.

Consequently the required N2 concurrency cases (delayed result, two dispatchers, completion between check/delete, TTL, restart, and new intent) were not added as false evidence. Existing Stage 122 tests continue to test a scripted response, not the required interleaving.

## Tests executed

| Scope | Result |
|---|---|
| N1 lane + Hub cleanup | 20 passing / 0 failing |
| Targeted GPU including separate video file | 90 passing / 0 failing |
| Orchestration package | 35 passing / 0 failing |
| Syntax smoke | PASS |
| Architecture | 928 passing / 24 pending / 2 failing |

The two architecture failures are unchanged package-boundary harness failures: `npm pack --json` returns status 0 but empty stdout, so its test `JSON.parse`s an empty string. They do not exercise Stage 124 files.

## Full suite

Not run for Stage 124. The only available execution environment blocks test-local listeners (`listen EPERM`), so the Stage 123 full run was non-comparable (`249 failing`, including listener sandbox failures) to the Stage 118/121 baseline. No sandbox bypass or production connection was attempted. Because N2 is incomplete, a full run would not establish acceptance in any event.

## Disposition

Keep the N1 changes uncommitted until N2 is implemented and its required concurrent tests pass. Stage 124 cannot be marked PASS and has no commit.
