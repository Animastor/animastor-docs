# AI Assistant Extraction — Physical Extraction

**Status:** LANDED (`@animastor/assistant` package physically extracted)
**Branch:** `c21.4-physically-extract-analysis-from-backend`
**Predecessor:** `docs/architecture/ai-assistant-extraction-preparation.md` (seams/ports/adapters — A-1…A-5)
**Guard suite:** `backend/tests/architecture/assistant-contour.test.js` (A1–A7, A1c), `backend/tests/architecture/assistant-package-boundary.test.js` (PB1–PB6), `backend/tests/architecture/chat-transport.test.js`

## 1. What was physically extracted

| Item | Source (deleted) | Destination (package) |
|---|---|---|
| Chat engine | `backend/src/services/chat-engine.cjs` | `packages/animastor-assistant/src/chat-engine.cjs` |
| AI routes | `backend/src/routes/ai-routes.cjs` | `packages/animastor-assistant/src/assistant-routes.cjs` |
| Ports contract | `backend/src/services/assistant-ports.cjs` (interface half) | `packages/animastor-assistant/src/assistant-ports-contract.cjs` |
| Session repo contract | inline in route (16× SQL) | `packages/animastor-assistant/src/session-repo-contract.cjs` |
| Public API entrypoint | `require('../routes/ai-routes')` + `require('../services/chat-engine')` | `packages/animastor-assistant/src/index.cjs` |

## 2. What remains host-side

| Component | Why host-side | Wired as |
|---|---|---|
| `chat-session-repo.js` (PG impl) | PostgreSQL infrastructure stays host | `assistantPorts.sessionRepo` |
| `ai-book-guard.js` | Middleware + auth-context + sessionRepo | injected in `backend.cjs` composition root |
| `backend/ai/ai-assistant-profile.md` | Persona file on host filesystem | `deps.aiProfile` (host reads the file via `assistant-profile-loader.cjs`, injects the CONTENT) |
| `provider-gateway.js` | Cloud resolution, Redis, config | `assistantPorts.resolveChatAI` |
| `url-safety.js` | SSRF guard (shared infra) | `assistantPorts.chatTransport.safeFetch` (wraps url-safety) |
| `shared-pool.js` | Shared inference (private workers) | `assistantPorts.chatTransport.runSharedInference` |
| `bundle-validator.cjs` | Book contract validation | `assistantPorts.validateBundle` + engine `deps.validateBundleObject` |
| `assistant-ports.cjs` (implementation) | Host adapter wiring Book Model + PG + gateway | `backend/src/services/assistant-ports.cjs` |

## 3. Package architecture

```
packages/animastor-assistant/
├── package.json          # ZERO runtime deps; devDependencies: chai, mocha
├── LICENSE
├── src/
│   ├── index.cjs                    # Public API: 4 exports
│   ├── chat-engine.cjs              # Engine: persona, prompts, edit_book tool, patch pipeline, normalizer
│   ├── assistant-routes.cjs         # HTTP contour: sessions CRUD + chat + SSE stream
│   ├── assistant-ports-contract.cjs # Ports interface + assertAssistantPorts()
│   └── session-repo-contract.cjs    # Session repo interface + assertSessionRepo()
├── README.md                        # Package docs (public API, ports, architecture)
├── CHANGELOG.md                     # Release history
├── LICENSE
└── test/
    └── assistant-package.test.js    # Package-owned unit tests (PT1–PT4)
```

**Dependency direction:** package → host is ZERO. All host legs are injected through the ports seam at registration time. The package has no `require()` calls into `backend/src/`, no `fs`, no `path`, and reads no `process.env` — it is pure logic + contracts.

## 4. Ports seam (AssistantPorts)

The package declares the contract (`assistant-ports-contract.cjs`); the host implements it (`backend/src/services/assistant-ports.cjs`). The composition root (`backend.cjs`) wires the two.

```
Package (contract)                    Host (implementation)
──────────────────                    ──────────────────────
assertAssistantPorts(ports)           createAssistantPorts({ ... })
                                      ├── loadBook       → bookModel.loadBook(bookId, { mode: 'lazy' })
                                      ├── persistBook    → book.saveBookBundle / targeted file save
                                      ├── validateBundle → bundle-validator (object)
                                      ├── validateBundleFile → bundle-validator (per-file)
                                      ├── resolveChatAI  → providerGateway.chat.resolveProvider
                                      ├── sessionRepo    → chat-session-repo (PG)
                                      ├── purgeForBook   → sessionRepo.purgeSessionsForBook
                                      ├── chatTransport  → { safeFetch, runSharedInference, describeSharedError, chatAiSourceToken }
                                      └── log            → utils.log
```

## 5. Transport legs (chatTransport)

The route historically required `url-safety`, `shared-pool`, and `provider-gateway` directly for the three transport branches (cloud / connector / shared). After extraction, these three are injected as a single `chatTransport` sub-seam inside `assistantPorts`:

| Port | Bound to | Used in |
|---|---|---|
| `safeFetch` | `urlSafety.safeFetch` (SSRF-guarded) | Cloud provider HTTP calls |
| `runSharedInference` | `sharedPool.runSharedInference` | Connector shared-inference path |
| `describeSharedError` | `sharedPool.describeSharedError` | Error message sanitization |
| `chatAiSourceToken` | Maps `{ source, transport }` → consumer token (`'cloud'` / `'system'` / `'shared'`) | `ai_source` in API responses |

The local `sharedPool = { runSharedInference, describeSharedError }` shim inside the route preserves guard string-match compatibility (guards scan for `require('../services/ai-connector/shared-pool')` patterns — the shim name must match).

## 6. Engine injection changes

| Aspect | Before (host) | After (package) |
|---|---|---|
| `validateBundleObject` | Fallback `require('../book/bundle-validator.cjs')` | **Required** injection — throws if missing |
| Persona | host read `fs.readFileSync(path)` at every call | `deps.aiProfile` — host loads CONTENT and injects it; package keeps no path/fs |
| `fs` module | Full fs usage (multiple) | **REMOVED** — the package no longer requires or uses `fs` |
| `process.env` | `AI_PROFILE_PATH`, `AI_API_BASE_URL` read inside engine | **REMOVED** — `deps.aiApiBaseUrl` injected; env read in host loader |

## 7. Architecture guards

### assistant-contour.test.js (A1–A7, A1c)
- **A1/A1b:** No SQL/postgres/storage-barrel in the contour (route + engine + guard + package)
- **A1c:** No host `require()` inside package `src/` — package closure scan
- **A2:** `ai_chat_sessions` SQL only in `chat-session-repo.js` (+ schema.js)
- **A3/A3b:** Narrow route wiring + `AssistantPorts` surface completeness
- **A4:** Book/VBook access via ports only
- **A5:** Purge flows use `purgeAssistantForBook` port
- **A6:** Chat transport contract (SSE frames, tools, AbortController)
- **A7:** Engine validator injectable + composition-root bound

### assistant-package-boundary.test.js (PB1–PB8)
- **PB1:** Deep-import guard — host consumes the package root only
- **PB2:** Export-map + manifest freeze (name/version/docs/files), ZERO runtime deps
- **PB3:** Public API surface (exactly the four factories)
- **PB4:** Package require closure (intra-package + builtins, no cycles, no host/other packages)
- **PB5:** Host-side adapters (PG repo, assistant-ports, ai-book-guard) stay host-side
- **PB6:** Dependency direction (composition root is the only host consumer)
- **PB7:** Runtime purity — no fs/path/os/child_process, no `process.env`/`__dirname`/`cwd`,
  no dynamic require, no relative escape, no self-barrel, scripts carry no host paths
- **PB8:** `npm pack` file allowlist + no junk + extracted tree + clean-consumer
  `require()` smoke (engine via injected deps, routes via injected ports)

### chat-transport.test.js (updated)
- Chat routes use package paths (not old host paths)
- SSE meta/delta/done/error contract unchanged

### phase7-extraction-readiness.test.js (baselines updated)
- `RAW_BOOK_BASELINE`: `ai-routes.cjs` removed (deleted); `backend.cjs: ./book/bundle-validator.cjs` present (composition root edge)
- `P7-T6 CONSUMER_BASELINE`: package entrypoint registered in `package.json`

## 8. Test suite

### Package tests (PT1–PT6)
`packages/animastor-assistant/test/assistant-package.test.js` — run from `backend/`:
```
npx mocha --exit ../packages/animastor-assistant/test/*.test.js
```
- PT1: public API surface (4 exports, injected persona/base URL, fallback)
- PT2: port contracts fail closed (assertAssistantPorts, assertSessionRepo)
- PT3: engine logic (participants normalization, patch validation, system prompt,
  tool modes, tool definition, context builders, response parsing, patch apply)
- PT4: prompt building + tools + parsing (former PT3 split)
- PT5: runtime purity (no host builtins / env / path assumptions / host requires)
- PT6: HTTP contour registers the `/api/v1/ai/*` surface via injected ports

### Host-rewired tests (all pass)
All runtime tests (`ai-patch-validation`, `ai-editor-mode`, `behavior-edit-book`, `ai-participants-doctrine`, `workspace-ai-security`, `ai-model-propagation`, `ai-connector-provider`, `personal-ai-provider-phase4`, `workspace-ai-provider`, `ai-shared-stream`, `ai-connector-acceptance`, `ai-shared-inference`) rewired to use `require('@animastor/assistant').createChatEngine(config, { validateBundleObject, aiProfile: null })`.

### Architecture guards: 830 passing, 0 failing

### Pre-existing environment failures (not caused by extraction)
- `16b. shared snapshot is safe for health checks` — fails on clean HEAD
- Private worker / LLM sharing / share-grants tests — worker infrastructure not available in this environment

## 9. Dependency graph (before → after)

**Before:**
```
backend/src/routes/ai-routes.cjs
  ├── ../services/chat-engine.cjs
  │     ├── ../book/bundle-validator.cjs  ← host fallback
  │     └── path, fs
  ├── ../services/url-safety.js
  ├── ../services/ai-connector/shared-pool.js
  ├── ../services/provider-gateway.js
  ├── storage/postgres/repositories/chat-session-repo.js (16× inline SQL)
  ├── middleware/auth-context.js
  └── storage/postgres/database (raw handle)
```

**After:**
```
packages/animastor-assistant/src/
  ├── chat-engine.cjs          ← deps.validateBundleObject (required)
  │     └── fs (persona read only)
  ├── assistant-routes.cjs     ← assistantPorts.chatTransport.*
  │     └── (zero host requires)
  ├── assistant-ports-contract.cjs
  └── session-repo-contract.cjs

backend/src/
  ├── backend.cjs              ← require('@animastor/assistant')
  │     ├── createChatEngine(config, { validateBundleObject, aiProfile })
  │     ├── createAssistantPorts({ ..., urlSafety, sharedPool })
  │     └── createAssistantRoutes(app, redis, { chatEngine, assistantPorts, utils })
  ├── services/assistant-ports.cjs  ← host adapter
  ├── services/chat-session-repo.js ← PG (unchanged)
  └── middleware/ai-book-guard.js    ← host (unchanged)
```

## 10. npm / package boundary

**Status:** publish-ready. `npm publish` has **NOT** been run — publication
remains a manual, explicit step.

### Boundary model

```
Host
 ├── PostgreSQL adapter        (chat-session repository implementation)
 ├── Book adapter              (bookModel.loadBook / book.saveBookBundle)
 ├── Provider adapter          (provider-gateway.chat.resolveProvider)
 ├── Transport adapter         (url-safety.safeFetch / shared-pool)
 └── AI profile loader         (assistant-profile-loader.cjs reads the persona)
             ↓  injected at composition root
      @animastor/assistant
             ↓
        public API
   createChatEngine / createAssistantRoutes
   assertAssistantPorts / assertSessionRepo
```

### Published files (`package.json` `"files"`)

`npm pack` emits exactly:

```
package.json
README.md
CHANGELOG.md
LICENSE
src/index.cjs
src/chat-engine.cjs
src/assistant-routes.cjs
src/assistant-ports-contract.cjs
src/session-repo-contract.cjs
```

No backend source, no `.git`, no tests, no local configs, no temporary
files, no monorepo docs, no host infrastructure. The `exports` map is
root-only (`"." → "./src/index.cjs"`); deep imports are blocked.

### Host-side pieces (never packaged)

| Piece | Home |
|---|---|
| `chat-session-repo.js` (PG, `ai_chat_sessions` SQL) | `backend/src/storage/postgres/repositories/` |
| `assistant-ports.cjs` (book/PG/gateway/transport wiring) | `backend/src/services/` |
| `assistant-profile-loader.cjs` (persona file read) | `backend/src/services/` |
| `ai-book-guard.js` (middleware + auth context) | `backend/src/middleware/` |
| `provider-gateway.js`, `url-safety.js`, `shared-pool.js` | `backend/src/services/` |

### Publish-readiness checks

- `backend/tests/architecture/assistant-package-boundary.test.js`
  - PB1 deep-import guard, PB2 manifest freeze, PB3 public API surface,
    PB4 package closure, PB5 host adapters, PB6 dependency direction,
    **PB7 runtime purity** (no fs/path/os/child_process, no `process.env`,
    no dynamic require, no relative escape, no self-barrel),
    **PB8 npm tarball + clean-consumer smoke** (`npm pack` file allowlist,
    no junk, extracted tree, `require()` from a clean directory, engine via
    injected deps, routes via injected ports).
- `backend/tests/architecture/assistant-contour.test.js` A1c/A7: no fs, no
  env, no host require in the package.

## 11. What is NOT done (out of scope)

- `ai-book-guard.js` stays host-side (middleware + auth-context + sessionRepo)
- Persona file stays on host filesystem; the HOST reads it and injects the
  content via `deps.aiProfile` (the package holds no fs/path)
- `provider-gateway.js`, `url-safety.js`, `shared-pool.js` stay host-side (transport infra)
- No PG/Redis extraction (PostgreSQL stays host infrastructure)
- No HTTP/SSE contract changes; frontend clients untouched
- Package-level `npm publish` (not yet — a manual explicit step; the code is
  publish-ready and `npm pack` verified)

## 12. Remaining work

1. **`npm publish`** — after monorepo stabilization and version freeze
   (manual, explicit step; the package is publish-ready and `npm pack` verified)
2. **Old host file references** — comment-only references in 5+ test files (cosmetic, non-functional)

## 13. Honest edit turns — `@animastor/assistant` 0.3.1–0.3.2 (2026-11-22)

Incident 19.11 (VBook 4 book, backend `deploy-045328c`, assistant 0.3.0):
the assistant answered «Done. I've added … as Scene 2 … filled in
video.action», the book stayed at one empty scene. Investigation —
`reports/2026-11-22/assistant-edit-bug.md`.

**Cause.** The model never called `edit_book` (0 tool calls in all 5 turns).
The book context told it «Read it, modify it as needed, and return the full
changed version in your response», the Edit prompt said «Always confirm
changes with the user before applying» and described no scene / unit paths;
the model pasted a changed scene as a ```json block and wrote «Done». The
routes relayed the text unchanged — and when `edit_book` WAS called and
rejected, a non-empty model text («Done») still hid the error.

**Contract since 0.3.1.**

- Book context = read-only snapshot. `buildBookContext(book, { canEdit })` /
  `buildCompactBookContext(book, { canEdit })`: with `canEdit` (Edit mode,
  unlocked book — exactly when `edit_book` is offered) the header points at the
  tool and says a JSON or text in the reply changes nothing; otherwise «in this
  mode you cannot change the book».
- Edit prompt: call `edit_book` in the same turn (a question only for a
  genuinely ambiguous request); never claim a change without the call; paths:
  `/chapters/<i>/scenes/<j>/units/<k>/<field>`, new scene `add
  /chapters/<i>/scenes/-`, unit fields `text`, `audio {speaker, text}`,
  `image {shot, prompt, negative}`, `video {action}`; `add` creates a missing
  `video` object.
- One reply pipeline for both routes and every transport (`processChatReply`):
  several `edit_book` calls apply cumulatively (each validated), the book is
  saved ONCE through `persistBook`. `edit_book` outside an edit-capable turn is
  refused (before: a content-embedded call was applied in any mode, a locked
  book included).
- `edit_outcome` — additive field of the `/api/v1/ai/chat` response and of the
  SSE `done` frame:

  | `edit_outcome` | when | user-visible reply |
  |---|---|---|
  | `applied` | patches validated and persisted | the model's text, or «✅ Changes applied: N change(s)»; a partial failure appends «⚠️ Some changes were NOT applied: …» |
  | `rejected` | `edit_book` called, nothing saved (path guard, contract validation, save error, wrong mode) | «⚠️ The book was NOT changed: <reason>» — the model's text is dropped |
  | `claimed_not_applied` | `edit_book` offered, not called, the reply claims a change (`looksLikeChangeClaim`: «Done», «I've added», «has been updated», «Готово», «добавил…», a pasted book / scene JSON; a reply ending with a question is not a claim) | cloud providers: ONE corrective call («You have NOT called the `edit_book` tool …») inside the same time window; if it still applies nothing — «⚠️ The book was NOT changed: the assistant described the edit but did not apply it…» |
  | `none` | no edit involved | the model's text; empty + `finish_reason=length` → «ran out of its answer budget»; empty otherwise → «returned no result» |

- A scene / unit added without ids gets `sc-` / `iu-` + 8 hex, unique in the
  book (`assignMissingIds` inside `applyPatchesValidated`); `participants`
  defaults to `[]`.
- Diagnostics: one log line per turn — `[AI] turn` / `[AI STREAM] turn
  session=… mode=… source=… model=… finish=… reply_chars=… tool_calls=…
  edit=… patches=… [retry=1]` — and `edit_book not applied (session=…): <reason>`.
  No prompt or reply text is logged.
- `edit_book` arguments go through `editBookPatches` (0.3.2): `patches` as an
  array, as a JSON string of the array (the shape the prod system model sends —
  0.3.1 refused it), a single operation, a bare array, or a nested
  `{patches: {patches: [...]}}`; broken JSON → «invalid edit_book arguments».
- The connector transport gets no tool schema (Phase-4 contract unchanged); the
  honest outcome applies, the corrective retry does not.

Fronts render the reply text as is — no UI change (BACKEND-ONLY, see
`ANDROID_WEB_PARITY.md` «Решения»). Tests: package `test/edit-honesty.test.js`
(EH1–EH3), backend `tests/assistant-edit-honesty.test.js` (real host ports, a
stub cloud model; 1 = the 19.11 replay).
