# Stage 59 — Stop client-driven BOOK-RECOVER for deleted books

**Date:** 2026-10-17
**Verdict: PASS** — the recovery path was traced, a minimal registration gate was implemented across all three read-time self-heal writers, target tests pass (4 new + full architecture suite 933 passing), and the isolated change was committed (`c40b2da`) and pushed to `main` (github + local mirror). **Not deployed** (per step 7) — production still runs image `sha256:71ab1468…`; live-client confirmation is a separate approved step (see §7).

## 1. The client BOOK-RECOVER path (task step 1)
**Endpoint:** `GET /api/v1/book/:bookId` → `@animastor/editor` `editor-routes.cjs`.
On every read it unconditionally ran two recovery legs:
- `placeholderAudio.recoverMissingPlaceholders` (placeholder audio),
- `recoverMissingRedisChunks` (`read-recovery.cjs`) → logged `[BOOK-RECOVER] … created N missing Redis chunks`.

**Second writer (the actual `image_units` leftover):** `GET /api/v1/scene/:b/:ch/:sc/storyboard` → `@animastor/player` `scene-data.cjs:162` → `iuRepo.upsertImageUnit`. When no PG durations exist (`needsDuration`), it computes them and **self-heals PG**. Its IU fallback reads the **disk `book.json`** via `playerModel.loadBook` (line 119), *not* Redis — so it is independent of the chunk recovery and does not require a chunk.

**Restoration condition:** all three legs key only on **disk presence** (`book.json` readable). Nothing checked whether the book is still **registered** (owns a `books` row).
**Why the deleted book stayed active:** the cleanup (stages 56–57) removed PG/Redis registry rows but, by mandate, left the disk dir. So a client still polling `новая_книга_1788747351369` got a 200 from `editorModel.read` (disk) and each poll re-created chunks (Redis) + `image_units` (PG, row id=250444 at 13:30:14Z).

## 2. Minimal fix (task step 2)
A single host-side port **`isBookRegistered(bookId)`** — `bookRepo.getWorkspaceId(bookId) != null` (books-row lookup), **fail-closed** (a PG error ⇒ treated as unregistered, so a blip can never resurrect a deleted book) — defined in the composition root (`backend.cjs`) and injected into both contours (zero host PG requires added to the packages). Every self-heal **WRITE** is gated on it; **reads still serve**:
- `read-recovery.cjs` — skip Redis-chunk creation when unregistered.
- `editor-routes.cjs` (GET book) — skip placeholder-audio recovery when unregistered.
- `scene-data.cjs` (scene storyboard) — still compute + return durations, but skip the `image_units` PG upsert when unregistered.

The chunk-keyed storyboard (`iu-media.cjs:215`) also upserts, but only runs when a Redis chunk exists; for the deleted book no chunk is created (gate above) → it 404s → transitively covered (left ungated to stay minimal).

## 3. Keep books / legitimate recovery unaffected (task step 3)
Registered books (own a `books` row) pass the gate and recover exactly as before. Verified by the new test (registered keep book creates its chunk; deleted book is skipped in the same ctx). `ba_1788172242081` and `import_…` both own `books` rows (workspace `3317e019…`) → unchanged.

## 4. Tests (task step 4)
- **New** `backend/tests/book-registry-recovery-gate.test.js` (4 cases: skip-when-unregistered, recover-when-registered, legacy-behavior-if-port-absent, keep-vs-deleted differentiation). Loads the real package source by relative path.
- **Updated** the frozen `recoveryCtx` contract (`editor-extraction-readiness.test.js`) and the `assistant-purge-wiring` composition stub for the additive port.
- **Result:** new test 4/4; full architecture suite **933 passing**, 24 pending; all edited files pass `node --check`.

## 5–6. No data/files deleted (tasks steps 5, 6)
No book dirs, output, assets, bundles, or other books' data touched. No mass cleanup. The existing `image_units` row id=250444 was **not** deleted (step 10 — pending proof the source is fixed).

## 7. Not deployed (task step 7)
No production config change, no container restart, no new image. The running container (`sha256:71ab1468…`, restarts=0) still uses the baked `node_modules` copies, so **production behavior is unchanged** until a separately-approved rebuild + deploy. The fix lives in the repo (`packages/…` + `backend/src`), not yet live.

## 8. Git (tasks step 8 + commit/push)
Pre-edit `status/diff` checked. Committed **only** the 9 intended files; the forbidden unrelated changes (`audit-orphan-books.js` deletion, 4 unrelated tests, `index.html`, untracked `deploy/`+yml+chat) were **left unstaged and uncommitted**.
- **Commit:** `c40b2da` `fix(editor,player): gate read-time self-heal on book registration (stage 59)` — 9 files, +185/−22.
- **Push:** normal (no force) to `github/main` and the local `origin` mirror; both remotes at `c40b2da`. No history rewrite.

## 9. Remaining / next steps (task step 9 — separate, not faked)
Final confirmation requires a **deploy** (rebuild image from `c40b2da`, restart backend) **and a live client** polling the deleted book. Procedure after an approved deploy:
1. Record `image_units` row id=250444 state.
2. Have the client (or a curl replicating `GET /book/…`, `GET /scene/…/storyboard`) poll `новая_книга_1788747351369`.
3. Verify logs show `[BOOK-RECOVER] … skipped — book not registered` and **no** new `image_units`/chunk keys appear; the keep books still self-heal normally.
4. Only then delete the residual row id=250444 (single row, after snapshotting it).
This was **not** simulated here — the gate is proven at unit level only; production still runs the pre-fix image.
