# Authentication MVP — Implementation Note

**Status:** Implemented (commit follows Account & Workspace foundation + hardening)
**Date:** 2026-08-20
**Scope:** REGISTER + LOGIN + SESSION + LOGOUT + CURRENT USER + BASIC AUTHORIZATION INTEGRATION.
Explicitly NOT included: OAuth, passkeys, email verification, password reset,
recovery keys, workspace switcher, anonymous/guest workspaces, billing, RBAC.

---

## 1. What was built

### Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /api/v1/auth/register` | public | username + password (+ optional email) → user + personal workspace + owner membership + session |
| `POST /api/v1/auth/login` | public | username + password → session |
| `POST /api/v1/auth/logout` | public (cookie) | revoke session (idempotent), clear cookie |
| `GET /api/v1/auth/me` | public → `{authenticated:false}` when anonymous | current user + workspace |

### Password storage (`backend/src/auth/password.js`)

- `crypto.scrypt` (Node built-in; memory-hard, no native dependency).
- Format: `scrypt$N=16384,r=8,p=1$<salt.b64>$<hash.b64>` — self-describing,
  rehashable for a future Argon2id switch.
- Policy: length 8–512, no composition rules (deliberately minimal).
- `verifyPassword` uses `timingSafeEqual` and a dummy derivation for
  missing hashes (equalizes timing for unknown users).

### Sessions (`sessions` table, `backend/src/storage/postgres/repositories/session-repo.js`)

- Server-side in PostgreSQL (never Redis — PG is the identity source of truth).
- Cookie: `animastor_sid = sid.<session_id_b64url>.<secret_b64url>`,
  HttpOnly, SameSite=Lax, Secure over HTTPS (`X-Forwarded-Proto`,
  `NODE_ENV=production`). TTL 30 days.
- Cookie scope: host-only by default; when `COOKIE_DOMAIN` is set
  (e.g. `animastor.org`) the session and guest cookies carry that `Domain=`
  suffix, so one login authenticates on every subdomain (public website
  `animastor.org` + application `app.animastor.org` — same backend, same
  session store, no second auth system). The value is charset-validated
  before it is written into `Set-Cookie`.
- **Raw tokens never stored** — only SHA-256 of the secret
  (`token_hash`, indexed). Session id + hash are generated together (never
  drift); a leaked DB yields no usable tokens.
- Logout = revoke (idempotent). Expired/revoked rows purged every 6 h.
- Session cookie value never appears in logs, responses, or `/auth/me`.

### Username / email policy

- Username: trimmed; 2–32 chars; no whitespace; compared case-insensitively
  via DB-side unique index `lower(username)` (application pre-check only
  races — the index is authoritative). No hash-suffix generation.
- Email: optional, trim + lowercase; unique (NULL = unlimited accounts
  without email).

### Registration atomicity

Registration runs in **one** PG transaction: `users` INSERT →
`workspaces` INSERT → `workspace_members` INSERT (`owner`). Any failure
rolls everything back — a user can never exist without a workspace, nor a
workspace without its owner. The session is created only after COMMIT.

---

## 2. Auth context (`backend/src/middleware/auth-context.js`)

```text
request → cookie → sessions lookup (PG) → users → workspaces
                 → req.user = { userId, username, displayName }
                 → req.workspace = { id, name, type }  (personal/default ws)
```

- `authContext` is async now; no valid cookie ⇒ `req.user = null` and the
  request proceeds exactly as pre-auth (no global `requireAuth` anywhere).
- Transient PG failures during session lookup degrade to anonymous.
- `checkBookAccess`: pre-auth allows all (compat); authenticated requires
  workspace membership (`books.workspace_id` → `workspace_members`), with
  self-heal for rows created before ownership existed (never overwriting a
  concurrent/foreign workspace).

## 2a. No guest is minted; anonymous writes are 401 (owner, 2026-11-18)

VBook v4 step 5 (`VBOOK_FORMAT_V4.md` §12ж, §13 В22). `authContext` no longer
provisions a guest workspace on an anonymous POST/PUT/PATCH under `/api/v1`.
`requireIdentityForWrites`, mounted right after `authContext`, answers
`401 {error: 'Authentication required', code: 'login_required'}` before any
route runs to:

- any anonymous request to `/api/v1/book/*` (every method, reads included);
- any anonymous write (POST/PUT/PATCH/DELETE) under `/api/v1`, except the
  sign-in routes `/api/v1/auth/*` and the machine surfaces with their own
  credentials: `/api/v1/worker/*` (`wrk.*`), `/api/v1/ai-connector/*` (`llmc.*`).

No row of `users` / `workspaces` / `guests` appears and no `animastor_gid`
cookie is set. Guests minted before keep resolving until their workspace
expires; register still converts a live guest in place. Both fronts open the
sign-in window on 401 (web auth-sticky, Android login prompt). Tests:
`backend/tests/no-guest-provision.test.js`, `book-input-guard.test.js`,
`guest-workspace.test.js`.

## 2b. Admin-only system writes; the write-route audit (owner, 2026-11-18)

VBook v4 step 6 (`VBOOK_FORMAT_V4.md` §12з, §13 В23). `/api/v1/connectors/*`
is system data — the files of `ai/connectors/` (add, parameters, status,
bindings, reload) and the ONE global prompt-profile override in Redis
(`PUT /connectors/profiles`); no workspace owns it and every book of every
user is assembled with it. Every non-GET method there goes through
`requireAdmin` (`connectorWriteGuard`, mounted before the routes): anonymous
→ 401, a signed-in non-admin → 403 `admin_required`. Reads stay open to any
identity (the settings screen shows the active profile; web and Android show
the selector read-only to non-admins).

`isAdminUser(user)` is the one admin predicate (`role = 'admin'` OR the
`ADMIN_USERNAMES` allowlist); `GET /api/v1/auth/me` reports it as
`user.is_admin`. Workspace roles: `workspace_members.role` has
`owner` / `editor` / `viewer` in the schema, but only `owner` rows are ever
created (personal workspaces), so book access = membership = ownership; no
write needs a role split today.

Audit of every write route under `/api/v1` (the live Express stack of
`backend.cjs`, 18.11; tests: `step6-write-guards.test.js`,
`no-guest-provision.test.js`):

| Routes | Identity | Role / ownership |
|---|---|---|
| `/auth/register`, `/auth/login`, `/auth/logout` | none (sign-in itself) | rate limits on login / register |
| `/book/:bookId/*` (editor, heroes, looks, rules, behaviour, voice candidates / reference, generation commands, cache, snapshot, lazy-parse, cancel) | 401 before the route | `requireBookAccess` — member of the book's workspace; 410 expired guest; 409 for a 3.1 book after the access check |
| `/book/import`, `/import-txt`, `/import-text`, `/load-vbook` | `requireUser` (registered user) | cross-workspace guard of the importer |
| `/book/blank` | 401 before the route (`requireIdentityForWrites`) | the book is attached to `req.workspace` |
| `/scene/:bookId/…/timings` | 401 | `requireBookAccess` |
| `/generate` | `requireUser` | importer cross-workspace guard |
| `/ai/sessions*`, `/ai/chat*` | 401 (`aiBookGuard`) | the book of the session / body must be in the caller's workspace; mismatch → 400 |
| `/settings/ai/provider` (PUT/DELETE), `/settings/ai/test` | identity | own workspace only (`req.workspace`) |
| `/ai-endpoints*`, `/ai-connector/registrations` and `/connectors/:id/*`, `/workers*`, `/private-worker/setup/plan` | registered user (guest → 403) | own workspace only; foreign id → 404 |
| `/workers/:id/request-log` | registered user | workspace owner or platform admin |
| `/admin/*`, `/debug/*` | `requireAdmin` | platform admin |
| `/connectors/*` (writes) | `requireAdmin` | platform admin (**fixed 18.11** — was open to anyone) |
| `/worker/verify` | worker token `wrk.*` | — |
| `/internal/gen/*`, `/internal/workers/:id/logs` | hub key / per-job upload token | — |
| `/gpu/task/result`, `/gpu/task/error` | hub callback auth | the task's workspace is re-checked |

## 3. Authorization wiring (`backend/src/backend.cjs`)

Mounted before the route handlers:

- `/api/v1/book/:bookId/*` — ownership guard (exempt: `import`,
  `import-txt`, `import-text`, `load-vbook`, `blank` — creation paths).
- `/api/v1/scene/*`, `/api/v1/iu-image/*`, `/api/v1/preview/*` — guard.
- `/api/v1/chunk/:id/*` (status/storyboard/audio/image/video) — the target
  book comes from Redis, so it is checked in-handler after chunk load.
- `/api/v1/ai/*` — book resolved from query/body/session lookup, guarded
  pre-route (fail closed).
- `GET /api/v1/books` — workspace-filtered for authenticated callers
  (implemented in the foundation phase; now driven by a real `req.workspace`).
- **Import cross-tenant guards** (dedup + bundle re-import): a re-import may
  only return/touch a book the caller owns (`dedupOwnedByCaller`,
  `importBookAllowed`); raw disk-scan dedup is pre-auth only; a bundle whose
  id collides with a foreign book → 403; disk copy with unverifiable
  ownership (PG down) → 403 for authed callers.
- Rate limits: `/auth/login` 10/min, `/auth/register` 5/min (brute force).

**Pre-auth behaviour is fully preserved** — every guard is a no-op for
requests without a valid session; dev books belong to the seeded developer
workspace and keep working.

## 4. Frontend

- `state/authStore.ts` — signals over `/auth/me`; localStorage is never
  auth truth (cookie only).
- `features/auth/UserMenu.tsx` — user-circle button in header/toolbar
  (concept §19, left of Settings): `Anonymous` → Login/Create account;
  logged in → username + Personal workspace + Sign out. Minimal dialog,
  existing `.modal` design tokens (en+ru i18n).

## 5. Known follow-ups (next stages, by design)

1. Anonymous/temporary workspaces + "Keep my workspace" conversion
   (registration currently always creates a fresh workspace).
2. Workspace switcher (today: `req.workspace` = personal/default).
3. `/api/v1/debug/*`, `/api/v1/worker/*`, connectors/workflows/config are
   INTERNAL/dev endpoints left unguarded for dev compatibility.
4. Android still uses nginx Basic Auth — needs this flow later.
5. Recovery keys / password reset via optional email (schema already has
   `recovery_key_hash` column).
