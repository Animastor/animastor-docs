# Stage 57 — Remove the rehydrating `layer_config` (новая_книга_1788747351369)

**Date:** 2026-10-17
**Verdict: PASS** — the `layer_config` field was removed from the target `book.json` (file kept, all other fields byte-identical, JSON valid); the corresponding Redis key is now **permanently gone** (C6 `restoreFromBooks` no longer finds a durable copy and skips the book). Verified across ≥1 full C6 cycle (105 s+ and a further 45 s stability window). Both keep books unchanged. No C6 code was changed; the fix is purely a data (disk-field) change.

## 1. Target path + backup (steps 1, 3)
- File: `/home/animastor/animastor/data/books/новая_книга_1788747351369/book.json` (in-container `/data/books/…/book.json`).
- Host user cannot write it (root-owned); the backend container runs as root and mounts `/data/books`, so the edit was performed **inside the container** (node).
- **Backup saved** to `/tmp/opencode/backup-57/book.json.orig` (602 B) with checksums in `/tmp/opencode/backup-57/target.md5`:
  - md5 `1293bed7a14f451ee2ae8f5d9cc72cd6`
  - sha256 `5715cfe53c7c44007eba8df9ac5e034f806ac1c273686559c224f556dca87b3f`
- After edit: md5 `b51290ef71e1d033eb611d6e9cc3d34f`, sha256 `b4d264b9233f0780e8b8302862cfc69f1d2fdc2d15a36a7f02bf177fd067fed3`.

## 2. Ownership — only the removing book (step 2)
- `layer_config` in `book.json` exists on **3** disk books: the 2 keep books (`ba_1788172242081`, `import_1786345731767…`) **and** `новая_книга_1788747351369`. Only the **removing** book's file was edited; the keep books' `book.json` (and their Redis `layer-config` keys) were left untouched — their sha256 is identical before/after (see §7).
- Corresponding Redis keys before: `layer-config:ba_…`, `layer-config:import_…` (keep, preserved) + `layer-config:новая_книга_1788747351369` (remove, targeted).

## 3. Edit (steps 4, 5)
- Removed **only** the top-level `layer_config` key via node (container); all 7 other fields (`book_id, version, title, author, language, structure, defaults`) verified byte-identical after round-trip. `diff` shows the sole change = the `layer_config` block (plus one cosmetic trailing newline the original lacked).
- JSON re-validated independently (host) → **VALID**, keys = the 7 remaining.
- **No directory/bundle/output/other file touched** — `data/books/новая_книга_1788747351369/` still holds `behavior.json`, `book.json`, `chapters/`, `manifest.json` (nothing added/removed). Only this one file's one field changed.

## 4. Why this permanently stops C6 (step 6 mechanism)
`layer-config.js:_readDurable()` does `if (!meta.layer_config || typeof !== 'object') return null;` and `restoreFromBooks()` then `if (!durable) continue;`. With the field gone, `_readDurable` → `null` → the book is **skipped**, so C6's `SET … NX` never fires. The only other writer (`layerConfig.set`, from a user PUT/generation) is never invoked for this book; client GETs do not write `layer_config`. **No C6 code was modified.**

## 5. Redis key removed + waited ≥1 full C6 cycle (steps 6, 7)
- Deleted `animastor:layer-config:новая_книга_1788747351369`.
- Monitored: **stayed gone for 105 s** (stage 56 rehydrated it within ~25–50 s → this is ≥2 C6 cycles) and a further **45 s** stability window at the end — key never returned (`exists=0` throughout). Runtime loop confirmed active (scheduler ticks ~5 s) but C6 now skips the book.

## 6. Transient side-observation (not layer_config, resolved)
During re-audit, 4 other keys for this book appeared (`book-scenes:…:next-index/total`, `chunks:…`, `chunk:…`). Logs show a **client polled this book's HTTP endpoints** (`book/status`, `scene/storyboard`, `iu-image`), triggering `[BOOK-RECOVER] … created 1 missing Redis chunks` — a **request-driven** path, *not* C6/`layer_config`. Deleted them; they **stayed gone** (60 s + final 45 s). Client GETs never write `layer_config`, so this does not affect the layer_config result. (If a client later opens this disk book again, BOOK-RECOVER may recreate chunk keys on demand — transient and out of the layer_config scope; not C6-driven.)

## 7. Keep books unchanged + audit + discovery (steps 7, 8)
- Keep `book.json` sha256 **identical** before/after: `ba_…` `e50bcc61…`, `import_…` `60e6e4b1…`.
- Keep Redis `layer-config` keys present; keep-book keys = 99.
- Keep PG unchanged: `books=2`, `ba_scenes=8`, `m_scenes=5`, `m_ready=15`.
- **`listBooks` (scenes)** = `ba_1788172242081`, `import_1786345731767_1786345734345` (exactly the 2 kept). Workspace-scoped list unchanged (2 keep books).
- Re-audit (`audit-orphan-books.js`): issues 11 (unchanged from stage 56) — 7 disk-only `новая` bundles (preserved) + 3 keep-book NULL-build_id duplicate keys (preserved). Class I/II = none.
- Backend: `restarts=0`, `GET /api/v1/books` = 200.

## 8. Final state
```
Redis  cleaned-book keys = 0 (any prefix) ; keep-book keys = 99 ; layer-config keys = {ba_, import} only
book.json (target) = valid JSON, layer_config absent, 7 other fields intact; backup at /tmp/opencode/backup-57/
PG     books=2  listBooks={ba_1788172242081, import_1786345731767…}  keep m_ready=15  ba_scenes=8  m_scenes=5
Disk   новая_книга_1788747351369/ dir + behavior.json + chapters/ + manifest.json untouched (only book.json field edited)
C6     restoreFromBooks skips the book (no durable copy) — key did not return over 105s+45s; no code change
```

## 9. Step 9 — did C6 still restore it / does JSON require the field?
**No.** `_readDurable` treats a missing `layer_config` as `null` (best-effort) and `restoreFromBooks` skips the book — the field is **optional**, not required by any parser (`layer_config` is not referenced anywhere in `backend/src/book/`). The key did not reappear across the observation windows. **No stop condition met; no C6 code changed.**
