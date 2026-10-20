# Stage 76 — rollback plan (docs extraction)

Created before any write/push. Scope: `animastor-docs` extraction + removal of `docs/` from `animastor-backend` only. `tools`, GPU Hub, mono/web/worker docs are out of scope and must remain untouched.

## Pre-state (recorded 2026-10-19)

| Object | Value |
|---|---|
| Source repo | `/home/animastor/animastor` |
| Source branch | `c21.4-physically-extract-analysis-from-backend` |
| Source HEAD | `465453df673016a4f3884b7ae25cddeebb052551` |
| Source `docs` tree | `da1f129e79b3aafb416617171043fd72198ff97d` (297 files) |
| Source worktree | `M frontends/website/index.html`, `?? docker/compose/overlay-backend-standalone.yml` (pre-existing, untouched) |
| Backend repo | `/home/animastor/animastor-backend` |
| Backend branch / HEAD | `main` / `9783963acf7b9c54c048443bf6fe7fb70b966e16` |
| Backend `docs` tree | `c92c44ae28cb4fdcfe5b43721444871f8508058d` (288 files) |
| Backend worktree | `D backend/scripts/audit-orphan-books.js`, 4 `M` tests, `?? deploy/`, `?? freebuff-chat-…md` (pre-existing, untouched) |
| Target repo | `Animastor/animastor-docs`, public, empty (`size=0`, 0 refs, default `main`) |

## Rollback points

### R0 — before push (target still empty)
No remote change. Delete only the temporary filtered clone if desired; source repos are untouched.

### R1 — target pushed, verification failed
Do **not** force-push. Because the repo had no refs, a corrective commit is enough:
```bash
# from the local filtered clone
git revert --no-edit <bad-commit>
git push origin main
```
If the bad state is the entire repo content, create an empty-tree corrective commit (no force) or leave the repo and document it. No consumers are switched to the new repo in this stage.

### R2 — backend commit created, push failed/undesired
The backend commit is local only until explicitly pushed. To undo locally:
```bash
git -C /home/animastor/animastor-backend revert --no-edit <backend-docs-commit>
```
If the commit was pushed:
```bash
git -C /home/animastor/animastor-backend revert --no-edit <backend-docs-commit>
git -C /home/animastor/animastor-backend push origin main
```
No `reset --hard`, no force-push.

### R3 — docs content loss
The 297-file tree remains available in:
1. `/home/animastor/animastor/docs` (source, untouched);
2. `animastor-docs` target history;
3. bare `/home/animastor/repos/animastor.git` (if still present);
4. manifests `/home/animastor/reorg-2026-10-19/75-docs-manifest.txt`.

## Hard stops

Abort before writing/pushing if:
- source HEAD != `465453df…`;
- target repo is non-empty or has unexpected refs;
- target default branch != `main` (push still explicit to `main`, but record);
- filtered tree differs from source;
- secret scan of filtered history is non-empty;
- any operation would require force-push or production config change.

## Explicitly out of scope

- No changes to `tools/`, GPU Hub, runtime/API/protocols/secrets.
- No npm publish, no GHCR release, no production deployment.
- No removal of mono/web/worker docs in this stage (production docs portal still bind-mounts mono `docs/`; changing that is production config).
- No deletion of backups/working directories.
