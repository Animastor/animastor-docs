# Stage 141 — «Publication A-min» Implementation

**Status: BLOCKED — STOP at safe variant (Stage 1 premises NOT proven; lock NOT removed)**

Date: 2026-10-25
Repository state at start: `HEAD c500b221` on `main`, 15 commits ahead of
`origin/main`; pre-existing dirty/untracked files recorded in
`audit-141/baseline-git-status.txt` and left untouched.

---

## 1. Goal (Stage 140 → Stage 141)

Stage 140 (`stage140-publication-architecture-decision.md`) recommended «A-min»:
replace the filesystem interprocess publication lock
(`backend/src/services/publication-lock.cjs`) with an in-process mutex —
**but only if a real, verified single-publisher mechanism exists** in all
supported deployment scenarios. Otherwise: stop safely, keep the IPC lock,
keep Redis fencing, and state the minimal additional decision needed.

Stage 141 = mandatory Stage 1 (premise verification) → conditional Stage 2
(lock removal) → Stage 3 (tests on current code) → report.

**Stage 1 result: premises unproven → Stage 2 (lock removal) NOT executed.**
This report documents the verification, the additive work delivered, the
test evidence, and the exact decision needed to unblock A-min.

---

## 2. Stage 1 — Premise verification

### 2.1 Who can publish (publishers)

Survey of `result-publication.cjs` (the only module that invokes
`withPublicationLock`, at `:479` and `:706`) plus every writer of canonical
publication paths:

| # | Publisher | Entry | Lock-protected? |
|---|-----------|-------|-----------------|
| P1 | HTTP generation result callback | `generation-routes.cjs:560 handleTaskResult` → `task-handler.cjs:1844 executeGpuTask` → `result-publication.cjs publishTaskResult/executeIuImagePublication` | yes |
| P2 | Redis Stream consumer (same code path P1) | `onMessage` → `handleTaskResult` | yes |
| P3 | Reconciliation / recovery re-publication | `runtime-loop.js:158`, `audio-recovery.cjs:161/:215`, `reconciliation-engine.js:1887` → same handler | yes |
| P4 | **`video-orchestrator.js:339`** — writes group `.mp4` **directly** to the canonical group path (`capTmp → grpPath`) | no | **NO** |

Conclusion: even within one backend process, publication of the canonical
group video path is **already written by a second, non-lock-aware writer (P4)**.
A single-publisher guarantee does not exist today at the path level, only at
the `result-publication` entry level.

Additional findings:

- `collectStaleQuarantine()` has **no production caller** (dead code path).
- The two real invocations are both inside `result-publication.cjs`
  (`:479`, `:706`); no other file imports `publication-lock.cjs`.
- Live container `animastor-backend` (image built 2026-10-21, code
  `/home/animastor/animastor` @ `088f3fa9`) contains **neither**
  `result-publication.cjs` nor `publication-lock.cjs`: the fencing/lock
  stack is **not deployed** (verified by `docker exec ... find /app`). Live
  volume `data/output` has **no `.publication-locks`** directory — a point
  in time **before** any `.publication-locks` existed. So the current live
  deployment runs with neither lock nor fencing; both exist only in local
  code. (No deploy was performed — out of scope.)

### 2.2 Publication entry points / paths — one canonical path, two task IDs

Proven by script `audit-141/alias-canonical-path-proof.cjs` (uses the
production `parseJobId` + `taskLockName` + `resolveAssetPath` logic; output
saved in the report section “alias proof” below):

- Two **distinct task IDs** (`bookA_ch1_sc1_iu01:iu_image` and
  `bookA_ch1_sc1_iu01:image`) parse to the **same** result type `iu_image`,
  the **same canonical asset path**
  (`data/output/.../bookA_ch1_sc1_iu01.png`), but produce **different**
  lock names (`…:iu_image` vs `…:image`).

⇒ The filesystem lock key and the canonical path key are **different key
spaces**. A single-publisher mechanism keyed by task ID would allow two
aliases of the same path to run **concurrently** — strictly weaker than the
path-scoped IPC lock.

### 2.3 What the FS lock guarantees; what depends on `verify()`

- Guarantees: mutual exclusion per **lock name** (task-ID-derived) across
  processes **and hosts** sharing the publication tree; `verify()` re-checks
  ownership immediately before the critical `rename()` commit so a holder
  whose lock was lost aborts (`publication_lock_lost`) instead of committing
  on top of a newer writer.
- Depends on `verify()`: the anti-stale-commit invariant of P1–P3, the
  `publication_lock_lost` abort paths (`result-publication.cjs:612/:667`),
  and the stale-result protection at `:967`.
- Note: the lock cannot exclude P4 at all — `video-orchestrator` never
  acquires it (see 2.1).

### 2.4 Can a second publisher be technically prevented? (deployment scenarios)

| Scenario | Single-publisher enforceable? |
|---|---|
| One backend container, one process, static config | Plausible but **not proof**: dynamic fan-out, supervisor restarts, and non-`result-publication` writers (P4) still exist; “one container” is a config assumption, not a mechanism (task rule: config ≠ proof). |
| Multi-process / multi-host sharing the publication tree | **No** — no cross-host coordination exists besides the FS lock; PID files are meaningless across hosts, `.publication-locks` existence proves nothing about a live owner (task rule). |
| Live container now (code @ `088f3fa9`) | Lock code not even present; different code version than local. |

**Redis lease as replacement?** Rejected as *weaker*, not equivalent:

- A `SET NX PX` lease does not fence the filesystem: a paused lease-holder
  past TTL can still perform the final `rename()` on stale bytes — the FS
  `rename()` is not fencing-aware. The IPC `verify()` immediately before
  `rename()` is exactly what closes that window; a lease check earlier in
  the flow does not (recheck-then-rename is inherently racy without
  holding an exclusive FS object).
- `_restoreCanonical` (rollback restore) can likewise restore a stale
  backup over fresher bytes if its holder was paused past TTL.

⇒ A Redis lease cannot replace `verify()` **without weakening** the
stale-commit invariant, which Stage 140/141 forbid without an invariant+test
replacement. No such replacement exists today.

### 2.5 Stage 1 decision

**STOP / BLOCKED.** `publication-lock.cjs` is **kept unchanged**; Redis
fencing, receipt validation, manifest/SHA verification, rollback, recovery,
and stale-result protection are all untouched. Replacing the lock would
require simultaneously solving (a) cross-host mutual exclusion for a
path-keyed resource, (b) fencing of the final `rename()`, and (c) the
alias key-space mismatch — i.e. it is not an A-min change.

**Minimal additional decision needed to unblock A-min** (pick one):

1. **Declare and enforce single-publisher operationally**: a documented,
   tested invariant that exactly one `result-publication` process runs per
   publication tree *and* that no other writer (notably
   `video-orchestrator.js:339`) touches canonical paths — plus a runtime
   guard (e.g. heartbeat file with heartbeat+epoch, verified before every
   publish) — then A-min's in-process mutex becomes safe; or
2. **Keep the FS lock** and, if cross-host correctness matters, add a
   fencing-token check *inside* the rename critical section (lock file
   content compared atomically with the rename) — this is a smaller,
   invariant-preserving change than A-min; or
3. **Single-host-only product decision**: officially restrict deployment to
   one backend process on one host, in which case the FS lock degenerates
   to a file lock on one machine and A-min is behaviorally equivalent —
   but this must be an explicit product/deployment decision, not an
   assumption.

---

## 3. Additive work delivered (Stage 2 output in BLOCKED mode)

No production code was modified. Per the Stage 141 task, the observable
Stage 2 deliverable in the blocked path is documentation of the
`iu-progress INCR` repeat/idempotency behavior:

- **New test file** `backend/tests/stage141-ready-chain-idempotency.test.js`
  (3 tests, all passing):
  - **C1** — route-level dedup (`generation-routes.cjs:501-506`, Redis
    `SET NX EX 3600` on `animastor:result-processed:{job}:{build}`) runs the
    ready chain **once**: `iu-progress INCR` executed exactly once; a second
    identical callback does not re-run it.
  - **C2** — recovery/reconciliation re-delivery after a completed publish
    never re-runs the ready chain (counter unchanged, still 1).
  - **C3** — **confirmed limitation (documented, not changed):** raw
    `INCR` is *not* idempotent for replay that bypasses the route dedup key
    (e.g. dedup key expiry after 1h, or direct `task-handler` invocation
    with a processed job). In that case the raw counter overcounts
    (2, 3, …), while `iuReadyFromCounters(...)` clamps the readiness
    decision to boolean semantics — so **business semantics are
    unaffected**; only the raw counter's informational value degrades.
    Test asserts both the overcount and the clamped `ready=true`.

No business/production semantics were changed; per the task this limitation
is documented rather than “fixed”.

---

## 4. Stage 3 — Test evidence (all run on current code, this session)

Baseline before any change: full suite **3489 passing, 28 pending,
0 failing, EXIT=0** (`audit-141/full-suite-baseline.log`).

Isolated Redis: `AUDIT_REDIS_URL=redis://127.0.0.1:6438/<db>` with distinct
indices per harness (no `redis-cli` on PATH; production Docker Redis/PG
untouched).

| Run | Command / file | Result |
|---|---|---|
| Full suite (baseline) | `npx mocha --exit 'tests/**/*.test.js'` | **3489 passing / 0 failing, EXIT=0** — `audit-141/full-suite-baseline.log` |
| Fencing scenarios + S14 targeted | 8-file fencing/iu-progress/markReady set (see command in §5) | **197 passing / 0 failing, EXIT=0** — `audit-141/fencing-targeted-iso.log` |
| audit-139 f-harness (fencing scenarios: stale fence, duplicate callback, retry, recovery, Redis/FS failure) | `f-harness.cjs` | **27/27 PASS** — `audit-141/f-harness-iso.log` |
| audit-139 l-harness (lock lifecycle) | `l-harness.cjs` | **20/20 PASS** — `audit-141/l-harness-iso.log` |
| audit-137 #01 core | `audit-137` harness | 24/24 — `audit-141/137-iso-01-*.log` |
| audit-137 #10 | ″ | 24/24 — `137-iso-10-*.log` |
| audit-137 #11 (audit-136 marker safety: M1–M9 + RACE1/RACE2) — **after harness fix** | ″ | **17/17 PASS, EXIT=0 ×2 isolated runs** — `137-iso-11-fixed-run1.log`, `137-iso-11-fixed-run2.log` |
| audit-137 #12 | ″ | 15/15 — `137-iso-12-*.log` |
| audit-137 #13 (blocked-mode) | ″ | `blocked=false`, EXIT=0 — `137-iso-13-*.log` |
| Full suite **with new Stage 141 test** | `npx mocha --exit 'tests/**/*.test.js'` | **3492 passing, 28 pending / 0 failing, EXIT=0** — `audit-141/full-suite-with-new-test.log` |

Parallel publications from different task IDs, manifest/SHA integrity,
rollback, audio/image/progress/SSE/markReady regressions are covered by the
full suite + fencing set + harnesses above (each harness log names its
scenario matrix). The alias/canonical-path scenario is covered by the proof
script (§2.2) — it is the **evidence for the BLOCKED decision**, not a
regression test.

Second-publisher check: search confirms only `result-publication.cjs`
acquires the lock; `video-orchestrator.js:339` writes the canonical group
path without any lock (finding P4, §2.1) — this is an **existing
condition**, documented here, not introduced by this stage.

---

## 5. Reproduce

```bash
cd /home/animastor/animastor-backend/backend
export AUDIT_REDIS_URL='redis://127.0.0.1:6438/8'

# full suite (glob must be quoted)
npx mocha --exit 'tests/**/*.test.js'

# targeted fencing + idempotency + markReady
npx mocha --exit tests/gpu-result-fencing-commit.test.js \
  tests/gpu-fenced-publication-gates.test.js tests/gpu-publication-consistency.test.js \
  tests/gpu-queue-idempotency.test.js tests/gpu-intent-fence-receipt.test.js \
  tests/gpu-intent-fence-regressions.test.js tests/iu-progress-utils.test.js \
  tests/markready-build-id-idempotency.test.js \
  tests/stage141-ready-chain-idempotency.test.js

# harnesses (one per Redis index!)
AUDIT_REDIS_URL=redis://127.0.0.1:6438/1 node /home/animastor/reorg-2026-10-23/audit-139/f-harness.cjs
AUDIT_REDIS_URL=redis://127.0.0.1:6438/2 node /home/animastor/reorg-2026-10-23/audit-139/l-harness.cjs
node /home/animastor/reorg-2026-10-23/audit-141/alias-canonical-path-proof.cjs
```

---

## 6. Git / change management

- Baseline state saved: `audit-141/baseline-git-status.txt`
  (pre-existing: 1 deleted + 7 modified files, 2 untracked dirs/files —
  **not touched**, not staged).
- Committed: **only** `backend/tests/stage141-ready-chain-idempotency.test.js`.
  Commit hash: `b38f12ba38713f5e825334b82c963daadb8260e9` (1 file, 263 insertions;
  verified via `git log -1 --stat`).
- **No push, no deploy, no destructive operations** performed. Production
  Docker Redis/PG and the live container untouched.

## 7. Residual risks / limitations

1. Lock-vs-path key-space mismatch (§2.2) — remains; the FS lock does not
   actually protect the path against alias task IDs *concurrently* either
   (different lock names), though it does serialize same-name publishers.
2. `video-orchestrator.js:339` non-lock writer (§2.1 P4) — pre-existing.
3. Live deployment runs code without lock/fencing stack — deployment
   decision outside this stage.
4. `iu-progress` raw counter overcount on replay bypassing route dedup —
   documented limitation (test C3), business semantics unaffected.
5. audit-137 #11 harness reliability: the harness itself hung at `RACE1-MIDSTATE`
   in ~2 of 3 attempts — a **known defect of the harness** (already documented in
   `138c-independent-publication-lock-audit.md:127`): the parent subscribes to
   `child.on('exit')` *after* its own F2 publication, so it can miss the
   already-emitted exit event and await forever. Evidence the child had in fact
   completed correctly: `.race-result.json` written with the expected
   `stale_intent` rollback, `.race-unparked` written, canonical = `F2-BYTES`,
   no orphan processes. **Fixed in the harness only** (subscription moved to
   immediately after `spawn`, in `audit-137/11-rerun-audit136-marker-safety.cjs`;
   `node --check` clean) — no production code touched. Two subsequent isolated
   runs: 17/17 PASS, EXIT=0 both. The RACE1 invariant itself never failed.
   Discipline noted: one harness per Redis index, and harness races must be
   fixed at the harness, not papered over.

## 8. Verdict against criteria 1–4

| # | Criterion | Status |
|---|---|---|
| 1 | Stage 1 proves single-publisher + entry points + path aliasing + lock guarantees | **FAIL** (single-publisher NOT provable; second writer exists; alias key mismatch) |
| 2 | Lock removed only if proven, otherwise safe stop with lock kept | **Met-as-safety-rule**: STOP taken, lock untouched, minimal decision stated (§2.5) |
| 3 | All Stage 3 tests run on current code and pass | **PASS** (see §4) |
| 4 | No push/deploy/destructive ops; only own test file committed | **PASS** |

**Overall: STOP / BLOCKED — not PASS** (criterion 1 fails by evidence, and
criterion 2's conditional branch mandates stopping). A-min implementation is
deferred until one of the three decisions in §2.5 is made.
