# Stage 56 — Book Cleanup (keep 2 books) + Мастер и Маргарита discovery restore

**Date:** 2026-10-17
**Verdict: PARTIAL** — every sanctioned cleanup action succeeded (all PG records + 42/43 Redis keys of removed books, disk untouched, both keep books working, Мастер restored). The single shortfall is one (1) passive-config Redis key that the running backend **rehydrates by design** from a preserved disk `book.json` (see §7). It is not an active queue/generation state and touches neither keep book. Fixing it fully would require a disk write or a code change — both explicitly out of scope for this stage.

**Production backend:** `ghcr.io/animastor/animastor-backend@sha256:71ab14683267df51463700a00ff0d4084a9ce2ef34661ae44dc9d1ebba4abcd8` (rev `c7eaa9cf`). **No rebuild/release was needed** — container verified to already contain the stage-50/53/54 fixes. Container `animastor-backend` running, **restarts=0** after all operations, API `GET /api/v1/books` = 200.

---

## 1. Kept vs. cleaned

**KEPT (2 books, workspace `3317e019-879d-4dfb-a9f8-edc9b72da7f4` "sureg's Workspace"):**
- `ba_1788172242081` — «За пределами алгоритмов», state ACTIVE, 8 scenes, 26 scene_assets.
- `import_1786345731767_1786345734345` — «Мастер и Маргарита», state BOOTSTRAPPED, 5 scenes (materialized this stage), 427 scene_assets.

Shared workspace + its entities preserved entirely: 1 owner user (`sureg`/xs2home@gmail.com), `workspace_members`, 1 `ai_endpoints`, 11 `generation_tasks` (all belong to the keep import book). Global counts unchanged: `users=83`, `workspace_members=15`, `ai_endpoints=1`.

**CLEANED — 15 PG book_ids** (built from inventory across every table having a `book_id` column — 26 tables scanned — not by name prefix):
```
import_1783656905372_1783656918982   import_1784518044598_1784518063384
ghost_book   smoke_book   book-1   b   test_book_1788242468506   test-edit
новая_книга_1788747351369   новая_книга_1788754457378   новая_книга_1788754462605
новая_книга_1788756291018   новая_книга_1789374776899
новая_книга_1791640039242 (guest ws 91f31949…)  новая_книга_1791640071055 (guest ws 6b41087a…)
```
(`новая_книга_1788754459266` is disk-only, never in PG → no PG action; disk preserved.)

---

## 2. Pre-state / audit (A)
- Audit tool rerun → `/tmp/opencode/audit-56-before.log`: **23 issues** (13 invisible-books, 2 scenes-without-book, 1 disk-only, 7 NULL-build_id keys / 427 redundant). `books=4` (guest purge had removed `новая_книга_1789374776899`'s books row since stage 55).
- FK map established: `books→workspaces` NO ACTION (delete books first), `guests→workspaces` CASCADE, `audio_layers/book_snapshots/storyboard_elements→books` CASCADE; `scenes/scene_assets/image_units/generation_tasks/book_source/cache_entries/…` have **no FK** (delete explicitly). `workspaces.id` is `uuid`.
- Workspace safety: no cleaned book referenced the KEEP workspace; the 2 guest workspaces held only their own cleaned book + 1 guest (0 members, 0 ai_endpoints, 0 tasks) → safe isolated delete.
- One previously-unflagged table found in the `book_id` scan: **`ai_chat_sessions` (3 rows)** — added to backup before any delete.

## 3. Backups (A5) — verifiable, with manifest
Directory `/tmp/opencode/backup-56/` (17 CSVs + manifests; **restorable, md5 re-verified OK**):
- `pg/*.clean.csv` — per-table COPY of cleaned-book rows + 2 guest workspaces/guests. `MANIFEST.pg.txt` records `table | SQL row-count | md5 | bytes`.
  Totals: `books=2, scenes=4, scene_assets=50, image_units=85, ai_chat_sessions=3, book_source=1, cache_entries=4, book_generation_sessions=1` (+10 empty tables); `workspaces(guest)=2, guests(guest)=2`.
- `redis/delete-keys.txt` (39 keys, md5 `98696224…`) + `redis/values.tsv` (type+base64 value, md5 `225896ac…`) + `redis/supplemental-keys.tsv` (3 later-caught keys, md5 `3d9cfb95…`).
- `RESTORE.md` — restore procedure (CSV `\copy` + Redis SET/HSET/SADD/RPUSH by type) and preserved-on-purpose list.

## 4. Part B — restore «Мастер и Маргарита» discovery (PASS)
`listBooks = SELECT DISTINCT book_id FROM scenes`. Мастер had **0 scenes rows** (invisible). Ran in-container `ensureSceneRow` (idempotent `INSERT … ON CONFLICT DO NOTHING`, `scene-assets-repo.js:362`) over the 5 distinct `(chapter,scene)` from its 427 assets:
- scenes `0 → 5`, **2nd run unchanged (idempotent)**, all 5 present:
  `ch-1bb5123c/{sc-45c789c6, sc-45d38693, sc-5f18dd0f, sc-a740d763}`, `ch-37eadabb/sc-5f0068ca`.
- `ba_` left as-is (8 scenes). Temp scripts removed from container.

## 5. Part C — delete cleaned books from PG + Redis (PASS, no disk changes)
Single guarded transaction (`/tmp/opencode/part-c-delete.sql`, `ON_ERROR_STOP`, guard asserts no keep book/workspace in the delete set). First attempt aborted cleanly on a `uuid=text` cast (open tx → **full rollback confirmed**, counts intact); fixed cast and re-ran → COMMIT.

Deleted: `scene_assets 50, image_units 85, ai_chat_sessions 3, cache_entries 4, book_source 1, book_generation_sessions 1, scenes 4, books 2, workspaces 2 (guests 2 cascade)`; all other book-scoped tables 0 rows.

**Post-state (exact):** `scenes=13` (ba_8+Мастер5), `scene_assets=453` (=26+427), `image_units=58` (=32+26), `books=2`, `book_source=2`, `cache_entries=0`, `guests=297`, `workspaces=436`, `users=83`, `ws_members=15`, `ai_endpoints=1`. Zero rows for any cleaned book_id anywhere (`scene_assets/scenes/image_units/ai_chat/books = 0`).

**Disk:** untouched — `data/books` = 10 dirs (2 keep + 8 новая), `data/output` = 7 dirs (unchanged).

**Redis:** deleted 39 keys (`animastor:*` scan) + 3 more caught by a **full `*` scan** (2× `trigger_cooldown:<clean>` missed by the prefix pattern, 1 recreated `layer-config`) = **42 keys**. Verified 99 keep-book keys intact (`ba_`=34, Мастер=65), keep-workspace queue `animastor:queue:image:ws:3317e019…` = present, active queues contain no cleaned book.

## 6. Part D — verification (PASS on all but D.5)
- **D.1 code fixes present in running image:** `ensureSceneRow` (5), materialize-before-reset `scenesRowsFailed` (6), FSM orchestrators DONE (audio+video), `purgeExpired` (2). No release needed.
- **Re-audit (`audit-orphan-books.js`, read-only):** issues **23 → 11**. **Class I (invisible books) 13 → 0 ✓; Class II → 0 ✓.** Remaining 11 = 8 disk-only `новая_книга` bundles (preserved by mandate) + 3 NULL-build_id duplicate keys belonging to **keep** books (C.5 → preserved, noted).
- **Discovery:** `listBooks` = exactly the 2 keep books. Workspace-scoped `GET /api/v1/books` (simulated with real repos + composition root) = exactly the 2 keep books (ba_ ACTIVE/17 scenes, Мастер BOOTSTRAPPED/5 scenes). Pre-auth view shows 8 unowned **disk** stubs (`state:null`) — expected (disk preserved; workspace books correctly hidden from anonymous by `listRecent`'s `LEFT JOIN books.workspace_id`).
- **READY files:** all **15** `ready` rows resolve to files on disk (relative/`build_…` paths resolve under `build_import_1786345731767_1786345734345/`); all 4 ready scenes have files. (4 `ready` rows point at a dead `/data/output/b1/…` path — stale NULL-build_id duplicates of a present `build_import` file, flagged by audit IV; pre-existing, keep-book, untouched.)
- **Health:** container running, 0 restarts, digest unchanged, `GET /api/v1/books` 200.
- **D.5 — the one gap:** 1 cleaned-book key present (see §7).

## 7. Residual — 1 auto-rehydrated config key (sole reason for PARTIAL)
`animastor:layer-config:новая_книга_1788747351369` (a passive config blob: audio/image/video enabled, chunk_size…).
- Deleted during cleanup; **recreated by the app within ~25–50s** and thereafter.
- Mechanism: periodic **C6 `reconcileCycle`** → `layer-config.js:restoreFromBooks()` does `SET … NX` for every disk book that has a durable `layer_config` copy in its `book.json`. Only this book has that field (the other 7 disk books have none) — which is exactly why only it reappears.
- It is **not** an active queue or in-flight generation state; it does not make that book discoverable or working (no scenes / book_source / assets; absent from listBooks and the workspace view); it touches neither keep book.
- **Not fixed** because the durable source is on disk (`data/books/…/book.json`), and this stage forbids disk modification/deletion and prefers no code changes.
- **To reach full clean, choose one (out of scope here):** (a) strip the `layer_config` field from that `book.json` (single disk-field write, file kept), or (b) a tiny code change to skip rehydration for books with no PG record. Active queues/states for removed books = **none** regardless.

## 8. Rollback (E)
- Backups verified restorable (§3): CSVs parse with headers, SQL counts + md5 match manifest, Redis values base64-decode correctly; `md5sum -c` OK.
- Procedure: `RESTORE.md` — re-`\copy` affected rows per table (guest workspaces by `id`, guests by `workspace_id`), re-SET Redis by type from `values.tsv`/`supplemental-keys.tsv`, restore the 5 Мастер scenes by deleting them (`scenes` rows) if the pre-B state must be reproduced, then re-run audit.
- No global PG rollback needed (only scoped rows changed); disk never modified.

## 9. Final state snapshot
```
PG     books=2  scenes={ba_:8, import(Мастер):5}  scene_assets=453  ready=15
       image_units=58  book_source=2  guests=297  workspaces=436
       users=83  ws_members=15  ai_endpoints=1
listBooks(scenes)= ba_1788172242081 , import_1786345731767_1786345734345
Redis  total=281   cleaned-book keys=1 (the §7 rehydrated config; 42 deleted)
Disk   books_dirs=10  output_dirs=7   (unchanged)
API    GET /api/v1/books = 200 ; workspace view = the 2 keep books
Backend status=running restarts=0 image=sha256:71ab1468…(c7eaa9cf)
```
