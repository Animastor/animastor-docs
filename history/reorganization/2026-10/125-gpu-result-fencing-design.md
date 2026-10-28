# Stage 125 — Atomic fencing design for result, artifact and completion lifecycle

**Input:** Stage 123 independent audit and [Stage 124 report](124-gpu-sweep-completion-atomicity.md).  
**Mode:** analysis only. No source, test, lockfile, version, ref, configuration, service, production data, queue, or dirty file was changed.  
**N1 context:** the uncommitted Stage 124 N1 changes are present in the worktree and are compatible with this design; they remain outside this design stage.

## Decision

Adopt a **durable per-logical-task intent fence**, with the existing canonical `idem_key` as its identity basis, plus a dispatch-to-fence receipt and a conditional result commit. Do **not** use a Redis lock plus another filesystem existence check as the fix: Redis and the filesystem cannot be made atomic that way, and a result can still land between the check and rename.

The minimum safe model has these parts:

1. `fence = hash(workspace, job_id, type, build_id, input-version, task-intent-epoch)`; this is the existing `idem_key` after the per-task pinned epoch is resolved. It is stable across a recovery/re-dispatch of the *same* intent and changes for a justified retry or explicit regeneration.
2. A durable **current-intent record** per logical task, e.g. `intent:{book}:{chapter}:{scene}:{job}` → `{ fence, epoch, state, generation_id }`, and a historical, TTL-bounded **dispatch receipt** `dispatch-intent:{dispatch_id}:{job_id}` → `fence` written before the Hub POST.
3. Result bytes are written only to a **fence-versioned staging/output path**, never directly to the canonical published path. A stale result may leave a garbage versioned file but cannot overwrite the current artifact.
4. One conditional/atomic storage operation commits the result only if `current-intent.fence === receipt.fence === result.fence`. It changes the result state/manifest, writes the completion marker for that fence, and releases only that fence's claim. A compare-and-set failure is terminal `stale_intent`, not a retry or an artifact publish.
5. Artifact readers resolve the current published version through a manifest/current-fence pointer. Garbage collection removes unreferenced staged versions only after a conservative retention period.

This makes the cross-store boundary explicit: filesystem writing is not the commit. The atomic commit is the visibility point; versioned immutable files make a stale pre-commit write harmless.

## Current lifecycle and breaks in the fence

| Phase | Image | Audio | Video | Current weakness |
|---|---|---|---|---|
| Intent / dispatch | `iu-processor` sends image; dispatcher resolves job epoch, computes `idem_key`, `guardEnqueue`, writes ref | merged and per-segment `audio/generation` use same dispatcher | `scene-orchestrator` builds group jobs then same dispatcher | `idem_key` is not made an authoritative result fence; no dispatch→fence receipt is retained for callbacks |
| Hub POST | `gpu-dispatcher` remembers `job_id → idem_key` then posts | same | same | Hub/callback protocol supplies `dispatch_id`, but callback does not bind it to the original task identity |
| Result admission | route and `task-handler` call `verifyDispatchIdentity` | stale dispatch may be accepted in `WAITING_CHUNKS`/`MERGING` | same exception | stale acceptance checks phase, not intent/fence; a regenerated intent can accept an old audio/video result |
| Artifact write | `task-handler.cjs:75-88` writes canonical path synchronously | same, then chunk/merge state | same group path/state | canonical file is overwritten **before** completion/ref validation or version gate |
| Complete | route calls handler then `settleCompletedTask` | same | same | settlement re-reads mutable ref after artifact write; it can repair an old ref and cannot prove current intent |
| Orphan recovery | send sees `already_completed` | two send paths do the same | persistence-port call does the same | `releaseTaskDoneIfOrphan` deletes a marker based only on response; artifact probe is earlier, outside any fence |
| Cancel/regenerate/delete | release ref-derived claim/done | same | same | bulk release is scoped by book/scene but does not require a current fence; result may race it |
| Restart / recovery | reconciliation replays saved result keys | audio recovery also writes/replays | reconciliation/callback paths | recovery entries lack an authoritative fence receipt and some legacy helpers call handler without `dispatch_id` |
| TTL | claim 24 h, ambiguous claim 90 min, ref/done 7 days, task pin 24 h | same | same | expiry may remove the only evidence needed to distinguish an old result from a current retry |

### Exact loss points

- `backend/src/runtime/gpu-dispatcher.js:263-302` computes and remembers an identity, but the ref is mutable `job_id → idem_key`, not an immutable dispatch receipt.
- `backend/src/routes/generation-routes.cjs:469-489` and `backend/src/services/task-handler.cjs:33-61` explicitly accept stale audio/video merely from FSM phase.
- `backend/src/services/task-handler.cjs:69-88` writes the canonical artifact before `settleCompletedTask` at `generation-routes.cjs:529-553`.
- `settleCompletedTask` may repair a missing ref and writes marker/releases claim after the non-atomic file write; it only compares that ref with the supplied idem key.
- `releaseTaskDoneIfOrphan` (`queue-idempotency.cjs:491-501`) has neither artifact-at-commit evidence nor current-intent comparison.
- `releaseClaimsByPrefix` deletes claim/done/ref based on scene ownership, not a fence compare; it is appropriate only after intent invalidation has made old callbacks harmless.
- `audio-recovery.cjs` contains legacy replay paths without a dispatch identity, so they cannot participate in a fence protocol until upgraded or made fail-closed.

## Recommended fence protocol

### Data model

Use `idem_key` as `fence_id`; add a random `generation_id` only if an operator-visible opaque correlation ID is useful. Do not rely on `dispatch_id`: a valid recovery can have a new dispatch ID for the same intent.

| Record | Ownership / lifetime | Purpose |
|---|---|---|
| `intent:{job}` | durable with task/asset lifecycle (not 24 h TTL) | current fence, epoch, intent state (`active`, `cancelled`, `superseded`) |
| `dispatch-intent:{dispatch}:{job}` | at least Hub result retention + reconciliation retention | immutable receipt that maps result callback to fence |
| `claim:{fence}` | active/ambiguous TTL as today | at most one pending Hub entry for this fence |
| `ref:{scene}:{job}` | pointer to current fence; conditional update only | scene/book cleanup index, never authority for an old result |
| `done:{fence}` | artifact retention lifetime | completion for exactly one immutable fence |
| `artifact-manifest:{job}` / DB row | durable | current published fence and artifact version/path |

The canonical file name must no longer be the authority. Write to a fence path such as `.../{job}/{fence}/artifact.ext.tmp`, fsync/validate, atomically rename only within that fence directory, then publish the path by CAS. Audio uses per-chunk fence directories and a scene-audio manifest; video uses group fence directories and only merges groups belonging to the same current scene/video intent. Image uses one IU fence directory.

### Send

1. Resolve/pin task epoch and compute `fence`.
2. Atomically ensure `intent:{job}` either already equals `fence` (same intent) or is created as active; claim only that fence.
3. Write `ref` with a conditional “current fence” compare and write immutable `dispatch-intent` receipt before POST.
4. Post to Hub. A definitive rejection releases only `claim:{fence}` if receipt/current intent still match. Ambiguous response preserves it. A retry/re-dispatch of same intent reuses fence; it may add a second receipt, not a second claim.

`already_completed` means only `done:{fence}` exists. It is never permission to delete it. The send path reads the published artifact manifest for the same fence: if it is missing, report `orphan_completed` to recovery; it does not retry inline. A fenced repair command can later create a fresh intent and enqueue it.

### Result acceptance and commit

Result route first parses job/stage and resolves `dispatch-intent:{dispatch}:{job}`. It rejects absent/expired receipt, a non-active current intent, or receipt fence unequal to current fence. The old audio/video “FSM waiting” exception is replaced with: accept a historical dispatch only when its receipt fence equals the current fence. That preserves batch/recovery result ordering inside one intent but rejects every result from a superseded intent.

The handler writes only a fenced staged file. It must not mutate canonical file, ready state, progress counters, chunk metadata, video group state, or PG asset state before the commit decision.

Then execute one Redis Lua script (or a Redis transaction with WATCH/MULTI only where script unavailable) with `(job, dispatch receipt, fence, expected current intent)`:

1. require current intent active and exactly equal to fence;
2. require receipt exactly equal to fence;
3. require ref still exactly equal to fence;
4. set/replace manifest `published_fence=fence` and staged artifact metadata;
5. write `done:{fence}`;
6. delete `claim:{fence}` only; never a claim derived from a later ref;
7. record an idempotent completion journal entry keyed by `(job, fence)`.

Return `committed`, `duplicate_same_fence`, or `stale_intent`. On `stale_intent`, delete only the staged fence version asynchronously and do not touch current state. This is the atomic operation required by N2; the actual bytes are intentionally outside it and harmless until published.

PG cannot be atomically included with Redis/filesystem. Either make the manifest/intent row transactional in PostgreSQL and use its conditional `UPDATE ... WHERE current_fence = $fence`, with Redis as cache/outbox, or retain Redis as the commit authority and use an idempotent durable outbox to update PG `scene_assets`/`image_units` conditionally by `generation_fence`. The latter needs schema fields (`generation_fence`, `published_path`, optional `completion_state`) and a migration. Never issue an unconditional `markReady` after a fenced commit.

### Intent changes and bulk operations

Cancel, explicit regenerate, dirty-unit regenerate, consumed error, cache clear, and book deletion must first atomically transition the matching current intent from `active` to `cancelled`/`superseded` (or install its new fence). Only then may they clear Hub lane and remove **that old fence's** claim/done/ref. A result that arrives before or after the Hub sweep sees a non-current intent and cannot publish.

Stage 124 N1 is compatible: the confirmed book-scoped Hub sweep remains before old-claim release. The difference is that release becomes `releaseFenceIfCurrent(oldFence, terminal/superseded)` rather than scanning and blindly deleting every ref-derived key. On Hub failure, keep both old intent/fence claim; retrying the sweep is idempotent. On repeated success, conditional deletion is idempotent.

## Alternatives considered

| Option | Assessment |
|---|---|
| Recheck artifact then `DEL done` under a Redis lock | Reject. No transaction spans filesystem and Redis; live result can write/rename after recheck. Lock TTL/restart makes it worse. |
| Use only `generation_epoch` in callback | Insufficient. Callback does not currently carry/retain the epoch per dispatch; file write remains before check. |
| Use only `dispatch_id` | Insufficient. Same intent legitimately has multiple dispatches after recovery; it would reject valid late chunks. |
| Random token only in memory | Reject. Lost on restart and cannot fence delayed Hub results. |
| Existing `idem_key` plus durable current intent, dispatch receipt, staged versioned artifacts and CAS publish | **Choose.** Minimal conceptual extension of existing identity/claim/ref design; it handles restart and does not need queue purge. |

## Migration with no queue clear or mass claim reset

1. Add nullable durable fence columns/manifest and new Redis records. Existing records are `legacy` and remain readable.
2. New sends dual-write receipt + current intent while preserving existing claim/ref; old Hub queue entries remain valid.
3. Callback handling: if a new receipt exists, require fenced commit. If only legacy state exists, retain current conservative behavior only until the old maximum result/claim retention; do not manufacture a new fence from a late result.
4. For a legacy `already_completed` with missing artifact, do not delete its marker. Create an explicit repair/rebuild intent through the normal regenerate path; this produces a new fence and leaves the legacy marker harmless.
5. Once the maximum of Hub result retention, ambiguous claim TTL, and reconciliation result-key TTL passes, stop accepting receipt-less legacy callbacks; garbage-collect staged/unreferenced versions and expired receipts.
6. No queue drain, global claim deletion, or production Redis flush is required. A restart reloads durable current intent/manifest and Redis receipts; missing receipt is fail-closed/reconciliation-managed.

## Invariants and concurrency matrix

| Scenario | Required invariant / expected outcome |
|---|---|
| Two dispatches, same intent | Same fence; one claim; either one Hub POST or a bounded duplicate/ambiguous outcome; both receipts may exist; one result commit. |
| Two dispatches, new intent | Different fence; old receipt cannot publish; old claim/done cannot affect new fence. |
| Completion between prior artifact check and orphan release | No marker deletion. Send detects done and schedules fenced repair only; result commit remains published. |
| Cancel vs result | Cancel first transitions intent terminal; result CAS fails stale. Result first commits same fence; cancel then may remove only that terminal fence according to user intent. |
| Regenerate vs result | Regenerate supersedes old fence before old artifact removal/new enqueue; old staged/late result CAS fails and cannot overwrite current manifest. |
| Restart while pending | Current intent/receipt/claim survive; re-dispatch uses same fence; no duplicate. |
| Restart after staged write before commit | Reconciler validates staged file and runs conditional commit for its receipt/fence; otherwise garbage collects. |
| Restart after commit before PG projection | Outbox replays conditional projection; duplicate is idempotent. |
| Claim/ref TTL expiration | TTL may permit a new send only if durable current intent says fence is still active. It may never turn an old result into current. |
| Done TTL expiration | Manifest/current intent remains authority; expiry cannot allow overwrite of a current artifact without a new intent. |
| Storage/Redis failure | No “success” response or claim release on uncertain commit. Keep staged file and claim/receipt; reconciler retries idempotently. |

## Test plan

Run these with in-memory/fake filesystem plus a Redis implementation capable of Lua/CAS semantics; add integration variants for Redis restart and filesystem staging.

1. For image, merged audio, per-segment audio, and each video group: dispatch A, pause result after staged write, supersede to B, resume A; assert A neither publishes bytes nor ready/progress state nor alters B claim/done.
2. Pause send A after old artifact probe, commit a valid result B/A of the same fence, resume A; assert done survives and no inline retry happens.
3. Two simultaneous sends same fence: exactly one claim/Hub job; result callbacks in either order commit once.
4. Re-dispatch same fence after restart: historical dispatch receipt accepted only when its fence equals current; newly generated intent rejects it.
5. Cancel versus result and regenerate versus result at every boundary: before staging, after staging/before CAS, after CAS/before projection, after projection. Assert no canonical/new manifest overwrite.
6. Expire claim, ref, done, and receipt independently; validate the documented fail-closed or reconciler path and no cross-intent release.
7. Hub HTTP timeout/partial lane sweep/repeated N1 request: claims survive failed sweep; successful repeat releases only exact superseded fence; parallel dispatch remains suppressed until then.
8. Redis Lua error, Redis unavailable, PG conditional-update failure, fsync/rename failure, and outbox retry: no false completion, no claim of another fence released, no published partial file.
9. Legacy result/recovery key without receipt: rejected/quarantined after migration gate; assert no call to `taskHandler.handleTaskResult` writes a canonical path.
10. Regression tests for audio/video late chunks: stale dispatch of same fence is accepted; stale dispatch from old fence is rejected even while FSM is `WAITING_CHUNKS`/`MERGING`.

## Architecture and test-environment findings

The architecture run’s `928 passing / 24 pending / 2 failing` is not an O2/persistence-port or Stage 124 code failure. Both failures are package-boundary setup hooks:

- `assistant-package-boundary.test.js:327-333`: `spawnSync('npm', ['pack', '--json'])` returns status 0 but empty stdout; `JSON.parse` throws `Unexpected end of JSON input`.
- `phase10d-gpu-hub-package-boundary.test.js:157-163`: identical issue for `npm pack --dry-run --json`.

The Stage 123 full run was non-comparable with the Stage 118/121 baseline because this sandbox refuses all test-local TCP listeners (`listen EPERM`), producing cascades in suites that start ephemeral HTTP/Hub servers. Isolated PG/Redis connections at `127.0.0.1:1` also surface as `connect EPERM` here rather than the baseline `ECONNREFUSED`. A full baseline comparison requires an allowed isolated environment with listeners enabled and DB/Redis deliberately unavailable at `127.0.0.1:1`; it must not use production as a substitute.

## Implementation order

1. Introduce data model/ports and receipt creation, without changing callback acceptance.
2. Introduce staged versioned paths and reader manifest resolution.
3. Add fenced CAS commit plus durable projection/outbox; make callback use it.
4. Supersede intent before cancel/regenerate cleanup; restrict release helpers to exact old fence.
5. Remove inline `releaseTaskDoneIfOrphan` retry; replace it with a visible fenced repair intent.
6. Migrate/reconcile legacy data, then turn receipt-less callbacks fail-closed after retention.

This order keeps N1’s confirmed sweep-before-release rule and avoids a mass queue/claim reset.
