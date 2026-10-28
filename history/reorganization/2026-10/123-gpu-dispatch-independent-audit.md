# Stage 123 — Independent audit of Stage 122 GPU-dispatch fixes

**Object:** local commit `57c3d58f` over the existing Stage 118/120 fixes, repository `/home/animastor/animastor-backend`  
**Date:** 2026-10-23  
**Mode:** read-only audit; no source, version, lockfile, ref, configuration, service, queue, container, `.env`, hook, or dirty user file was changed.  
**Result: BLOCKED.** Two blocking correctness defects remain in the claimed N1/N2 fixes. The target tests pass, but they do not cover the unsafe interleavings below.

## Scope and isolation

All commands that could reach PostgreSQL or Redis were run with:

```text
PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1
```

No production endpoint, Hub, Redis, PG, queue 457/438, container, push, CI, GHCR, deploy, or npm publish was used. The pre-existing dirty files were preserved:

```text
D  backend/scripts/audit-orphan-books.js
M  backend/tests/ai-endpoint-sharing.test.js
M  backend/tests/ai-shared-inference.test.js
M  backend/tests/architecture/installer-package-boundary.test.js
M  backend/tests/architecture/phase5-runtime-result.test.js
?? deploy/
?? freebuff-chat-2026-10-11T07-41-12.445Z.md
```

The tracked orchestration sources and the installed backend mirror are byte-identical (`diff -qr packages/animastor-orchestration/src backend/node_modules/@animastor/orchestration/src`: no output).

## Blocking defects

### N1-A — book-scoped Hub sweep accepts a malformed or absent scope echo (HIGH)

`packages/animastor-orchestration/src/runtime/dispatch-engine.js:1640-1658` treats every HTTP `ok` response as `cleared` unless `body.scope.book_id` is explicitly present and different. `response.json()` errors are swallowed with `/* unparseable body — trust the ok status */`; `{}`, `null`, a response without `.json`, and malformed JSON consequently produce `{ requested: 1, cleared: 1, failed: 0 }`.

This is fail-open. The request itself is correctly formed as exactly one:

```text
DELETE {hub}/queue/clear?book_id={encodeURIComponent(bookId)}
```

and the current checked Hub implementation returns a correct echo (`animastor-gpu-hub/gpu-hub.js:1919-2040`). But the client cannot honestly certify that the requested book scope was honoured when the echo is missing or malformed. A proxy, incompatible Hub, or buggy Hub may have carried out a broader/foreign deletion and returned `200` with a non-JSON/partial body; the caller logs success. This violates the required malformed-echo handling and the demanded guarantee that a foreign book can never be cleared in any outcome.

Stage 122 tests cover only an explicit foreign `scope.book_id`; they omit malformed JSON, no body, no `scope`, and wrong-shaped `scope`. The prose comment claims absent scope is unsafe, but the implementation does not enforce it.

### N1-B — regenerate releases claims before a failed post-release sweep (HIGH)

The regenerate path in `backend/src/routes/book/generation-routes.cjs:636-692` calls `releaseClaimsForScene()` and only then performs the second book-wide Hub sweep. Any `failed > 0`, port error, timeout, or network failure is merely warned and execution continues. There is no claim preservation/rollback, retry, durable cleanup marker, or response failure.

Therefore this reachable interleaving is unsafe:

1. `resetScenes` clears the first lane snapshot;
2. a dispatch lands in the lane before/during claim release;
3. `releaseClaimsForScene` deletes its idempotency protection;
4. the mandatory post-release book sweep times out/fails;
5. the orphan Hub lane entry remains while its claim is gone, opening a duplicate-execution window.

The commit report calls the remaining orphan “bounded by claim TTL”, but the claim was explicitly released, so that statement does not preserve the claimed safety invariant. The user requirement specifically asks that a sweep error retain a safe state; this path does not. Existing tests only assert result accounting for `clearHubDispatches`; they do not drive regenerate through this ordering/error case and inspect claims/lane state.

### N2 — `already_completed` is assumed orphan without an atomic evidence check (HIGH)

`releaseTaskDoneIfOrphan` (`backend/src/helpers/queue-idempotency.cjs:491-501`) has only this predicate:

```text
!sent && reason === 'already_completed' && idem_key
```

It unconditionally deletes the completion marker and returns `true`, causing one more `provider.generate` in the image, both audio paths, and video. It does not atomically establish that the artifact/chunk/group is still absent, that the marker belongs to a wiped artifact, or that the identity is still the active generation.

The claimed “send path already probed absence” is a TOCTOU assertion, not a guarantee. A valid sequence is:

1. sender probes artifact/chunk/group absent;
2. a live worker’s accepted result concurrently runs `handleTaskResult`, which writes the artifact first (`backend/src/routes/generation-routes.cjs:511-514`), then settles/writes its completion marker (`:528-553`);
3. the sender's queue guard returns `already_completed` for that now-live marker;
4. Stage 122 deletes the legitimate marker and retries the same job without rechecking the artifact or identity.

This can re-enqueue work that has just completed. The same lack of generation/intent validation means the Stage 122 helper itself does not prove that a delayed old send cannot participate after an intent change; it relies on external dispatch/result behaviour not checked at the release point. The bounded retry limit prevents an infinite local loop, but not this duplicate/old-result race.

The new audio/video tests inject scripted `already_completed -> sent` responses. They do not use the real guard/send transition under parallel dispatch, a concurrently settling result, a delayed result, or an intent epoch change. Existing general idempotency tests cover some queue and epoch invariants, but do not exercise `releaseTaskDoneIfOrphan` in those interleavings. Thus the requested proof for image, both audio paths, and video is absent.

## N1 audit details

Positive findings:

- Empty IDs plus `book_id` is implemented as one correct DELETE; empty IDs without a book sends no request.
- HTTP non-OK and thrown fetch errors are counted as `failed`, do not throw, and warn.
- An explicit mismatched `scope.book_id` is counted as failure.
- Explicit dispatch-ID callers retain their one-DELETE-per-unique-ID behaviour. Calls found: the hub-cancel adapter, cancel-worker route, entity scene/unit cleanup, and tests. None accidentally pass a book scope with explicit IDs.
- The checked Hub endpoint uses `record.book_id === book_id` for a book-scoped request and returns `scope.book_id` (`animastor-gpu-hub/gpu-hub.js:1930-2039`).

These positives do not remove N1-A/N1-B.

## N2 audit details

Positive findings:

- Image is refactored to the shared helper; audio uses it in merged-dialogue and per-segment paths; video reaches it through the new `idem.releaseTaskDoneIfOrphan` persistence operation.
- Retry is syntactically bounded to one additional `provider.generate`; `duplicate_pending` does not qualify for retry.
- The persistence-port operation is declared in `OPS`, implemented by the host adapter, consumed through `persist(...)`, and is covered by the O2 declaration scan.

The helper's assumption that any SEND-path `already_completed` is orphan is insufficient under concurrency, so these do not close N2.

## Architecture and test isolation

- O2 contract remains structurally correct: port is zero-require, the new operation is declarative, and the host adapter implements it. The O2 test itself passed within the architecture run.
- The video test does not alter global host bindings or Mocha configuration. It does temporarily set the real global video-FSM port, and `afterEach` restores `../src/storage/video-fsm-adapter`; the separately run test completed successfully. This restoration design is acceptable for the stated adapter requirement, though the test is not completely free of global port mutation.
- No Stage 122 test modifies production configuration.

## Test matrix

| Command / scope | Result |
|---|---|
| `bash ../scripts/syntax-smoke.sh` | PASS — all production JS/CJS files syntax-valid |
| `npx mocha --exit tests/gpu-orphan-video.test.js` | PASS — 3 passing |
| Targeted GPU: idempotency, audio-deferral, lane-order, orphan-audio, orphan-video, hub-cleanup | PASS — 89 passing / 0 failing (the Stage 122 report's 88 omits/uses a different targeted composition; this run included `gpu-hub-cleanup`) |
| `packages/animastor-orchestration: npm test` | PASS — 35 passing |
| `npx mocha --exit 'tests/architecture/*.test.js'` | 928 passing / 24 pending / 2 failing |
| Full backend `npx mocha --exit --reporter min 'tests/**/*.test.js'` | 2470 passing / 28 pending / 249 failing |

### Comparison with Stage 118/121 baseline

Stage 118/121 records `2678 passing / 28 pending / 85 failing`, with all 85 failures reported as `ECONNREFUSED 127.0.0.1:1`. This execution cannot reproduce that baseline exactly because the audit sandbox rejects every test-local TCP listener with `EPERM`; it also converts the mandated unreachable PG/Redis connections to `connect EPERM 127.0.0.1:1`, rather than `ECONNREFUSED`.

Observed deviations:

- Full suite: 249 failures, i.e. +164 versus the recorded 85. The log has 153 `listen EPERM` lines, 430 `connect EPERM 127.0.0.1:1` lines, and the two npm-pack parsing failures below; these are environment failures, not evidence of a Stage 122 regression.
- Architecture: two non-baseline failures in `assistant-package-boundary.test.js` and `phase10d-gpu-hub-package-boundary.test.js`: both execute `npm pack ... --json`, receive exit status 0, but `stdout` is empty and `JSON.parse` raises `Unexpected end of JSON input`. These are independent package-boundary harness/environment failures; no Stage 122 file is involved.
- Because listener creation is sandbox-blocked, byte-identical failure-list comparison with Stage 118/121 is **not possible** here. The independently run Stage 122 target suites and orchestration suite do pass, but that cannot compensate for N1-A, N1-B, or N2.

## Required disposition

Do not accept Stage 122 as PASS. It needs a follow-up that makes Hub scope verification fail closed, retains a safe claim/lane state when the post-release sweep fails, and makes orphan-marker release conditional on race-safe evidence of artifact absence/current identity. The follow-up should add real concurrent tests for each send path (live completion, delayed completion, restart, parallel dispatch, and changed intent), then re-run the full suite in an environment that permits test-local listeners while keeping PG/Redis at `127.0.0.1:1`.
