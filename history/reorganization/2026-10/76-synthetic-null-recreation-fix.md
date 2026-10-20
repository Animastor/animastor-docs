# Stage 76 — Prevent synthetic NULL recreation before migration (`ensureSyntheticStaleAsset`)

**Verdict: PASS** — root cause traced to a single INSERT branch, smallest safe fix implemented
(one new UPDATE branch, 26 lines in one function), 9 new regression tests + 28 existing
Stage 66/73 tests + 929 architecture tests + syntax smoke all green, isolated commit `74088d6`
pushed to `origin/main` (GitHub). Production DB, Redis, deploy state and worktree foreign changes untouched.

Date: 2026-10-19, window ~05:45–06:07 UTC. Report: this file.

---

## 1. Scope and restrictions — compliance summary

| Restriction | Status |
|---|---|
| No production `scene_assets` mutation (no delete/repoint) | ✅ verified: before/after md5 `238ee1c2888e3910b945682866b02934`, 459 rows / 437 NULL, `max(id)=48353`, `max(updated_at)=1792386322` — identical pre/post |
| No Redis change | ✅ no Redis command issued this stage |
| Do not restore `48353` | ✅ untouched |
| No deploy | ✅ container unchanged (`restarts=0`, started 05:05:15Z, health 200); image digest `02049cc2…` unchanged |
| Do not include foreign work (`8a99796`, README, dirty worktree files) in the commit | ✅ commit `74088d6` contains exactly 2 files (`scene-assets-repo.js` +26, new test file +247); foreign commits/edits left exactly as found (§2) |
| No PostgreSQL test leakage | ✅ test book ids `test76-*` deleted in `afterEach`/`after`; post-suite `test%`/`ghost%` rows in `scene_assets` = **0** |

---

## 2. Worktree / HEAD / foreign activity inspection (before any edit)

State at stage start:

- `HEAD` = `6a992e6` = `origin/main` (local bare remote). GitHub remote (`github/main`) still at `9783963`.
- Foreign local commits already on `main` (by the concurrent process, **not** created by this stage):
  - `8a99796` “docs: move documentation to the animastor-docs repository” (05:33:50) — deleted the in-repo
    `docs/` tree, rewired `README.md`/`CONTRIBUTING.md` links to `Animastor/animastor-docs`.
    Stage 75 had observed it as local-only/unpushed; by Stage 76 it is part of shared `main` history
    (pushed by the other process before this stage started).
  - `6a992e6` “test(architecture): read the Phase 2 contract from animastor-docs” (05:37:25) —
    `phase2-redis-ownership-contract.test.js` resolves the contract from a docs checkout; README/CONTRIBUTING notes.
  Both were left untouched; nothing was reset, amended or rebased.
- Worktree (all pre-existing, untouched, **not staged**):
  `D backend/scripts/audit-orphan-books.js`,
  `M backend/tests/ai-endpoint-sharing.test.js`,
  `M backend/tests/ai-shared-inference.test.js`,
  `M backend/tests/architecture/installer-package-boundary.test.js` (npm-publish visibility update),
  `M backend/tests/architecture/phase5-runtime-result.test.js` (lazyRequire-barrel removal tolerance),
  `?? deploy/`, `?? freebuff-chat-2026-10-11T07-41-12.445Z.md`.
- No staged changes existed; the Stage 75–noted README modification had been consumed by the foreign commits.
- The two foreign-modified architecture tests were run as-is during this stage and **pass** (part of the 929).

---

## 3. Write-path trace

### 3.1 Callers of `ensureSyntheticStaleAsset`

| # | Caller | Condition reaching the synthetic path |
|---|---|---|
| 1 | `book-sync.js:215 markSceneAssetsStale` → `:244` (production path, via `reconcileFromDiff` `:86` after `book-diff` detects a changed scene) | step-1 `UPDATE … SET status='stale' … WHERE (book,ch,sc) AND status='ready'` (any asset type, `book-sync.js:228-238`) affects **0 rows** → `ensureSyntheticStaleAsset(bookId, chapterId, sceneId)` with default `assetType='audio'` |
| 2 | `backend/tests/markready-build-id-idempotency.test.js:242` | direct contract test (no scenes row → 0) |
| — | **no other production callers** (repo export `scene-assets-repo.js:793`) | |

The other NULL-inserting writer, `stampSceneVersionsForDispatch` (`scene-assets-repo.js:291-340`),
is **already fail-closed for versioned keys**: its first UPDATE hits *any* rows of the key (no build
filter) and returns `stamped > 0` before the insert path; the INSERT runs only when the key has
**zero** rows of that asset type (`:309-337`, guarded by `NOT EXISTS … build_id IS NULL`).
Pinned by the Stage 66 test “inserts a synthetic row once”. **No change needed there** — out of scope.

### 3.2 Exact insert conditions (pre-fix), inside `ensureSyntheticStaleAsset`

Transaction + advisory `pg_advisory_xact_lock` on the NULL-build key, then:

1. no `scenes` row → **return 0** (legacy no-op, Stage 66 contract);
2. `UPDATE` all `build_id IS NULL` rows of `(key, asset_type)` → `status='stale'` + scene-version stamps;
   `rowCount > 0` → return (no insert);
3. **else `INSERT` a new `build_id IS NULL`, `status='stale'` row** ← the K-5 recreation.

### 3.3 When branch 3 fires — scenario matrix

Branch 3 requires: a `scenes` row exists, **no NULL rows** for `(key, audio)`, and step-1 of the
caller matched nothing (no `ready` row of any type in the scene). Then:

| Scene state | Is the row versioned work? | Pre-fix behavior | Post-fix behavior |
|---|---|---|---|
| zero rows of any type (brand-new/legacy scene) | no build context exists | INSERT 1 NULL stale marker (R15+) | **unchanged** INSERT (branch 4) |
| versioned audio rows exist (`build_id IS NOT NULL`), none ready (placeholder/stale/failed/pending), no NULL rows | **yes — canonical versioned rows established** | **INSERT new NULL row** (unique key cannot deduplicate NULL → every edit mints another family) | **UPDATE all versioned rows** → stale + stamps; insert forbidden |
| no audio rows, but versioned rows of other types (image/video) exist | no versioned *audio* canonical exists | INSERT NULL audio marker | **unchanged** INSERT (no build context for this asset type) |
| NULL + versioned rows of the same key (current ba_ production shape) | mixed | NULL branch wins, versioned untouched | **unchanged** — NULL branch still first |

### 3.4 Is the row created for a versioned scene with an existing equivalent versioned asset?

**Yes** — that is the root cause. For a key whose rows are all versioned (e.g. any of the 9 ba_ audio
keys that have only `build_ba_1788172242081` placeholder/stale rows), the pre-fix INSERT created a
`build_id IS NULL` twin **while versioned equivalents already existed for the same key**. After Stage 75
deletes the 425 NULL duplicates, *every* genuine edit of such a key would mint a fresh NULL family —
re-seeding exactly the classes the migration removes (and `markReady` with a build-less path /
`stampSceneVersionsForDispatch` on empty keys remain the two legitimate NULL writers, unchanged).

### 3.5 Legitimate legacy behavior vs synthetic rows required for versioned work

- **Legitimate legacy (preserved verbatim):** a scene with *no* asset rows and *no* build context gets
  exactly one synthetic NULL stale marker so `sceneHasValidContent`/version comparison has a row to
  compare (R15+ upsert design, `book-sync.js:220-242`); second call updates it (Stage 66 idempotency).
  No scenes row → no-op.
- **Not legitimate for versioned work (fixed):** minting a NULL row when the key already carries build
  provenance. Versioned staleness is now carried by the versioned rows themselves (status→stale +
  scene stamps — the same treatment the NULL branch already applied to NULL rows of any status).
- **Current production impact (pre-migration):** of ba_'s 17 audio keys, 8 still have NULL rows
  (NULL branch — byte-identical behavior to before); the **9 versioned-only keys** switch from
  “edit mints a new NULL row” to “edit refreshes the versioned rows”. Dirty-signal equivalence for
  those keys is proven in tests: a stale versioned row is a `getDirtyMarkers` participant
  (`status IN ('stale','failed','pending')`, Stage 73 `notProvenNullDuplicateCondition` excludes only
  *proven NULL dupes*, never versioned rows); a flipped `placeholder` row becomes `stale`, which is a
  *stronger* (still single-key) dirty signal than the placeholder + inserted NULL pair it replaces.

---

## 4. Root cause (one sentence)

`ensureSyntheticStaleAsset` treated “no NULL row to refresh” as “no row at all”, so on versioned-only
keys its unconditional INSERT re-created `build_id IS NULL` rows that the unique key
`(book, chapter, scene, asset_type, build_id)` cannot deduplicate (NULL never conflicts) — the same
mechanism that produced the 437-row NULL families Stage 75 migrates.

## 5. The fix (smallest safe, one write path)

`backend/src/storage/postgres/repositories/scene-assets-repo.js` — one new branch between the
NULL-refresh and the legacy INSERT (`ensureSyntheticStaleAsset`, +26 lines including the contract
comment):

1. no `scenes` row → return 0 *(unchanged)*;
2. NULL rows of the key → refresh them *(unchanged; current ba_ mixed shape unaffected)*;
3. **NEW: versioned rows (`build_id IS NOT NULL`) of the key → UPDATE all of them**
   (`status='stale'`, `scene_content_version`/`scene_audio_config_version` = current scene versions,
   `updated_at=now`), return `rowCount`; **INSERT forbidden**;
4. no rows of any provenance → legacy synthetic NULL INSERT *(unchanged, R15+)*.

**Fail-closed ambiguity contract (documented in the code comment and pinned by tests):**
when the key holds versioned rows with **several different builds**, the function does **not** choose
a canonical build, does **not** delete or re-bind any row, and does **not** insert a NULL row —
*every* versioned row is conservatively marked stale and re-stamped. The canonical build is decided
only by the next dispatch via `markReady` (build-stamped upsert, Stage 66). Pending work is never
discarded: rows are only re-statused (`pending`/`failed`/`placeholder` → `stale`), never removed —
the same treatment the pre-existing NULL branch already applied to NULL rows of any status
(no status filter, mirrored exactly).

Scope discipline: **no other writer changed** — `markStale`, `markSceneAssetsStale` step-1,
`stampSceneVersionsForDispatch`, `upsertAsset`/`markReady`, `notProvenNullDuplicateCondition` and all
dirty/stale signal queries are untouched.

## 6. Tests

New file `backend/tests/synthetic-null-recreation-fix.test.js` (247 lines, book id `test76-*`,
cleanup mirrors the Stage 73 pattern with a final leakage assertion):

| Requirement | Test(s) |
|---|---|
| Versioned scene edit creates no NULL synthetic row when the canonical build is known | “ensureSyntheticStaleAsset обновляет versioned-строку вместо INSERT NULL”; “genuine edit через book-sync.markSceneAssetsStale не плодит NULL-строку”; “ready versioned-строка при edit через book-sync: step1 матчит ready — ensure не вызывается” |
| Legacy scene without build context keeps intended behavior | “сцена с нуля строк: ensure создаёт один синтетический NULL-маркер”; “без строки в scenes — no-op (контракт Stage 66)” |
| Ambiguous case handled safely (fail closed) | “два versioned-строки с разными builds: обе stale, ни одна не удалена, NULL не создана”; “NULL+versioned одной формы (production ba_): выигрывает NULL-ветка, versioned не тронута” |
| Repeated calls idempotent | “повторный ensure на legacy-сцене идемпотентен”; “повторный ensure на неоднозначном ключе идемпотентен” |
| Stage 73 duplicate/self-heal tests keep passing | full runs below |

Run results (all on the pushed tree, shared `animastor-pg`):

| Command | Result |
|---|---|
| `npx mocha tests/synthetic-null-recreation-fix.test.js` | **9 passing** |
| `npx mocha tests/null-duplicate-self-heal.test.js tests/markready-build-id-idempotency.test.js tests/book-sync.test.js` | **38 passing** |
| combined re-run after push: new + Stage 73 + Stage 66 suites | **37 passing, 0 failing** |
| `npm run test:syntax` (`scripts/syntax-smoke.sh`) | **All production JS/CJS files pass** |
| `npx mocha tests/architecture/*.test.js` | **929 passing, 24 pending, 0 failing** (incl. the two foreign-modified files, run as-is) |
| PG leakage: `SELECT count(*) FROM scene_assets WHERE book_id LIKE 'test%' OR 'ghost%'` after suites | **0** |

## 7. Production-state verification (read-only, pre/post)

| Check | Before fix/commit | After tests + commit + push |
|---|---|---|
| `scene_assets` total / NULL | 459 / 437 | **459 / 437** |
| md5 of `row_to_json` aggregate | `238ee1c2888e3910b945682866b02934` | **`238ee1c2888e3910b945682866b02934`** |
| `max(id)` / `max(updated_at)` | 48353 / `1792386322` | **48353 / `1792386322`** |
| backend container | restarts 0, started 05:05:15Z | **unchanged**, `GET /health` 200 |
| Redis / deploy / book files | — | **not touched** |

Tests wrote only `test76-*` rows (deleted in-suite); no production row was updated, inserted or
removed by this stage — the deployed container still runs the Stage 74 image, so the fix is
**code-only until the next authorized deploy** (deliberately not done here).

## 8. Delivery

- Commit: **`74088d6`** `fix(scene-assets): never mint NULL synthetic rows on versioned keys (stage 76)`
  (2026-10-19 06:04:56 +0000) — exactly 2 files, +273 lines.
- Push: **done, normally** — `origin/main` (bare local remote) `6a992e6..74088d6`;
  the GitHub remote advanced `9783963..74088d6` via the push-through (which mechanically carried the
  already-committed foreign commits `8a99796`/`6a992e6` onto GitHub as part of shared `main` history —
  they are **not** part of this stage's diff; `git show 74088d6` contains only the two Stage 76 files).
- Not done, per instructions: no deploy, no production data change, no Redis change, no `48353` action,
  no worktree cleanup of foreign files, no amend/reset of foreign commits.

## 9. Remaining risks / notes

1. **Pre-migration activation on 9 ba_ keys:** the new branch is live in code but only exercised on the
   next genuine edit of a ba_ versioned-only key (or post-Stage-75-migration keys). Expected effect:
   versioned rows refresh instead of a NULL twin appearing; dirty-signal equivalence covered by tests,
   but the first real edit should be watched in logs (`[BOOK-SYNC] RECONCILE … assets stale`).
2. **Status transitions broaden slightly for versioned rows** (any status → `stale`, mirroring the NULL
   branch): a mid-flight `pending` generation for the same key is re-stamped stale at edit time; its
   completion upserts `ready` again via `markReady` — no work is lost, but in-flight dispatches for a
   just-edited scene complete into a `stale`-then-`ready` sequence as before for NULL rows.
3. **`placeholder` → `stale`** on edit for the 9 ba_ placeholder rows: turns a non-dirty status into a
   dirty one *for that key* — correct on content edit (placeholder derived from old content) and
   equivalent to the dirty marker the old NULL-insert provided.
4. The fix is **not deployed**; the production container still executes the Stage 74 image. Until the
   next authorized deploy+approve, NULL recreation remains possible in production if a ba_ scene is
   edited (pre-existing behavior, unchanged by code presence in git only). Post-deploy, Stage 75's
   post-migration invariant “NULL count stays 2” (§6.8-14 of report 75) becomes enforceable.
5. `stampSceneVersionsForDispatch` can still insert a NULL `pending` row — only when a key has **zero**
   rows of that asset type (already fail-closed for versioned keys, Stage 66-pinned); deliberately out
   of this stage's scope.
