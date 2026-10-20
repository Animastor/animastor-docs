# Stage 76 — Extract docs repository: execution report

**Date:** 2026-10-19
**Status:** PASS (docs extracted; tools untouched/BLOCKED)
**Basis:** `75-docs-tools-extraction-audit.md`, `75-docs-manifest.txt`, `76-docs-rollback-plan.md`

---

## 0. Result

| Item | Value |
|---|---|
| Target repo | `Animastor/animastor-docs` (public) |
| Target branch | `main` |
| Target commit (HEAD) | `bb8106cf0d06829dc2a2c6039df9593f3430f6f6` |
| History | 793 commits (792 docs-history + 1 extraction commit), first `2026-06-11` |
| Files | 298 tracked (297 docs + `LICENSE`) |
| Bundle backup | `/home/animastor/reorg-2026-10-19/76-animastor-docs.bundle` (3.8 MiB) |
| Local clone (stable) | `/home/animastor/animastor-docs` (`@bb8106c`) |
| Backend removal commit | `8a997966cd2b53919342d55b92410a6b46b5b7b5` |
| Backend test-fix commit | `6a992e6b288560c5a1c2f296d70b8d7d34b3bd35` |
| Backend remote state | `origin/main` = `github/main` = `6a992e6` |

No force-push was used. No runtime/API/protocol/secret/production-config change. GPU Hub and `tools/` untouched.

---

## 1. Preflight (before any write)

| Check | Result |
|---|---|
| Source HEAD | `465453df673016a4f3884b7ae25cddeebb052551` (unchanged from Stage 75) |
| Source branch | `c21.4-physically-extract-analysis-from-backend`; worktree dirty as before (1 M, 1 ??) |
| Source `docs` tree | `da1f129e79b3aafb416617171043fd72198ff97d`, 297 files |
| Backend HEAD before | `9783963acf7b9c54c048443bf6fe7fb70b966e16`; pre-existing dirty files recorded |
| Backend `docs` tree | `c92c44ae28cb4fdcfe5b43721444871f8508058d`, 288 files |
| Target refs before | 0 refs, `default_branch=main`, public |
| Dry-run | `/tmp/audit-docs-extract` = 792 commits / 297 files, tree diff 0 |
| Rollback plan | created before execution: `76-docs-rollback-plan.md` |

---

## 2. Extraction (filtered clone)

```bash
git clone --no-local --single-branch \
  --branch c21.4-physically-extract-analysis-from-backend \
  /home/animastor/animastor /tmp/stage76-docs-20261019
cd /tmp/stage76-docs-20261019
git filter-repo --path docs/ --path-rename docs/:
```

Result: 792 commits, 297 files, branch renamed to `main`, tree equal to `/home/animastor/animastor/docs` (`diff -rq` = 0).

Extraction commit `bb8106c` added:

1. `LICENSE` (MIT, copied from the monorepo root) — the new public repo had no license.
2. Fixed the one link broken by flattening:
   `08-mobile-web-migration/README.md`: `../../README.md` → `../README.md`.

---

## 3. Target verification

| Check | Result |
|---|---|
| Fresh clone from GitHub HEAD | `bb8106cf0d06829dc2a2c6039df9593f3430f6f6` |
| Commits / tracked files | 793 / 298 |
| First commit | `f31add9` 2026-06-11 `Recovery01: June 9 working state + dedup` |
| `diff -rq` fresh clone vs filtered clone | 0 differences |
| Manifest paths (297) | 297/297 present |
| Blob equality vs manifest | 296/297 identical; 1 expected mismatch — `08-mobile-web-migration/README.md` (link fix); extra file `LICENSE` |
| Broken relative links | 11 — exactly the pre-existing set; **0 new** |
| Secret scan (HEAD + full history) | 0 hits |
| `git fsck --full` | clean |
| `https://raw.githubusercontent.com/Animastor/animastor-docs/main/README.md` | HTTP 200 |
| `git ls-remote ... refs/heads/main` | `bb8106cf0d06829dc2a2c6039df9593f3430f6f6` |

Pre-existing broken links (unchanged by the move): 6 × `README.md`, 4 × `08-mobile-web-migration/TODO.md`, 1 × `architecture/repository-split-post-split-audit.md`.

---

## 4. Backend removal (after target verification)

Commit `8a99796` — `docs: move documentation to the animastor-docs repository`

- deleted `docs/` (288 tracked files); `git ls-files docs` = 0, the directory is gone from disk;
- updated user-facing links to `https://github.com/Animastor/animastor-docs/blob/main/...`:
  `README.md`, `CONTRIBUTING.md`, `packages/animastor-{auth,editor,player,url-safety,vbook-runtime,contracts}` README/CHANGELOG;
- removed the `docs/` entry from the README project-tree block.

Commit `6a992e6` — `test(architecture): read the Phase 2 contract from animastor-docs`

The removal exposed one real dependency: `backend/tests/architecture/phase2-redis-ownership-contract.test.js`
read `docs/architecture/PHASE_2_CONTRACTS.md` from disk. The test now resolves the
contract from (1) `ANIMASTOR_DOCS_ROOT`, (2) a sibling `../animastor-docs` clone,
(3) the legacy in-repo `docs/` path, and **fails closed** with a clear error when
none exists. Assertions are unchanged. README/CONTRIBUTING gained the clone
instruction. A stable clone was created at `/home/animastor/animastor-docs`.

Pre-existing backend worktree changes (`D backend/scripts/audit-orphan-books.js`,
4 × `M` tests, `?? deploy/`, `?? freebuff-chat-…md`) were **not** staged or committed.

### Backend checks

| Check | Result |
|---|---|
| `git ls-files docs` | 0 |
| Architecture suite `mocha tests/architecture/*.test.js` | **929 passing, 24 pending, rc=0** |
| `scripts/syntax-smoke.sh` | rc=0 (`All production JS/CJS files pass syntax check`) |
| `origin/main` / `github/main` | `6a992e6b288560c5a1c2f296d70b8d7d34b3bd35` (the local bare `origin` mirrors to GitHub) |
| Phase 2 test with sibling clone and with `ANIMASTOR_DOCS_ROOT` | both 7 passing, rc=0 |

---

## 5. Old-path / dependency audit

Checked and intentionally left unchanged (documented, non-breaking):

| Location | State | Reason |
|---|---|---|
| `animastor`, `animastor-web`, `animastor-worker` `docs/` | still present (297 / 31 / 16) | out of Stage 76 scope; production docs portal still bind-mounts the monorepo tree |
| Production `deploy/docker-compose.yml:146` (mono `docs`) | unchanged | production config is explicitly off-limits |
| Backend `docker-compose.yml:149` `./docs` mount | unchanged | legacy standalone compose, already non-functional in the split repo (it also mounts missing `./frontends`, `./proxy`); not the production path |
| `.dockerignore:12` `docs/` | unchanged | harmless dead ignore entry |
| ~257 code comments with `docs/...` in backend | unchanged | historical references, not runtime |
| Installer manifests `docs/...` evidence strings | unchanged | metadata/provenance only; no code opens them as files |
| `scripts/*` messages referencing `docs/runtime-audits/...` | unchanged | text only |

Verified production portal is unaffected: `https://animastor.org/docs/` → 200, `/docs/README.md` → 200 (still served from the monorepo mount).

---

## 6. Limitations / follow-ups

1. **Duplicate docs remain** in `animastor` (canonical history), `animastor-web`, `animastor-worker`. Removing them requires follow-up stages; the monorepo copy cannot be removed without a production mount change (forbidden here).
2. **Backend legacy compose** still references `./docs`; the standalone file was already stale. If it is ever used, point it at a docs checkout.
3. **Phase 2 contract test needs a docs checkout.** Without `ANIMASTOR_DOCS_ROOT` or a sibling clone the suite fails closed with an explicit message (no silent skip). No CI job runs this suite today; if one is added, it must clone `animastor-docs`.
4. **No production cutover** to the new docs repo was performed (production config untouched by design). The portal continues to serve the monorepo tree.
5. **Tools remains BLOCKED** — not touched in this stage.
6. Pre-existing dirty files in `animastor-backend` and `animastor` remain uncommitted, as before.

---

## 7. Rollback

See `76-docs-rollback-plan.md`. In short:

- target repo had 0 refs, so any correction is a normal commit/revert + `git push` (never force);
- backend rollback: `git revert 8a99796 6a992e6` (or just `6a992e6` for the test-resolution change) and push;
- full docs content remains in `/home/animastor/animastor/docs`, the docs repo history, the bundle, and `75-docs-manifest.txt`.
