# Stage 130 — Real-Redis verification & independent audit of the Stage 129 intent-fence fixes

**Verdict: PASS** — the real-Redis gate is satisfied. Both the atomic Lua path and the
non-Lua (WATCH/MULTI) fallback were exercised against a real, isolated `redis:7` server,
executing the **actual Lua script literal from source** (not a rewritten mirror). Every
terminal verdict was proven to block the Hub POST. No result below rests on a mock.

- **Audited commit:** `c5239cf4` — *"fix(gpu-queue): versioned fence admission + fail-closed atomic receipt (stage 129 / audit 128 B1, B2)"* (13 files, +1501/−182). HEAD is unchanged; the diff was confirmed to be `c5239cf4` and the fencing files are byte-identical to it (`git diff c5239cf4` empty for them).
- **Harness artifacts (outside the repo):** `/home/animastor/reorg-2026-10-23/audit-130/`
  - `01-lua-and-fallback.cjs` → **127 passed / 0 failed** (`part1.out`, `part1-notes.json`)
  - `02-dispatcher-e2e.cjs` → **46 passed / 0 failed** (`part2.json`)
  - `ensure.lua` → the script **extracted verbatim from source** for the ioredis-independent `redis-cli --eval` check.

---

## 1. What was independently re-verified in code

Beyond re-reading the diff, these production paths were traced line-by-line and then
executed for real (see the scenario sections):

| Concern | Source | Verified behaviour |
|---|---|---|
| Admission decision (single source of truth) | `queue-idempotency.cjs:737-817` `_decideIntentReceipt` | receipt immutability → intent_missing on receipt-without-intent → corrupt → same-fence state guard → supersede (wasSuperseded / epoch / non-active) |
| Atomic script | `queue-idempotency.cjs:918-1035` `ENSURE_INTENT_RECEIPT_SCRIPT` | mirrors `_decideIntentReceipt` decision-for-decision |
| Fail-closed gates | `queue-idempotency.cjs:1272-1343` `ensureIntentAndReceipt` | `invalid` / `invalid_fence`; eval success → classify; unknown reply → `unavailable`; **capability-error** → fall through only; anything else → `unavailable` (no fallback); `__allowNonLuaFallback` never set in production (grep) |
| WATCH/MULTI fallback | `queue-idempotency.cjs:1153-1270` | lock-guarded, one MULTI/EXEC, compare-and-delete on owner token |
| POST gate + rollback | `gpu-dispatcher.js:353-424`, `:30-44` | non-`created`/`reused` verdict → `rollbackOwnEnqueue` (fence-scoped) → structured not-sent, **no POST** |
| Retry taxonomy | `dispatch-outcomes.js`, `dispatch-engine.js:883-891` | terminal (stale_intent, receipt_conflict, intent_*) vs capacity (`intent_receipt_unavailable`) |
| Observability | `prometheus.js:83-115`, `queue-idempotency.cjs:862-879` | `animastor_intent_fence_total{outcome}`, `animastor_intent_fence_degraded_total{reason}` |

## 2. Real-Redis isolation (no production touch)

Three throwaway `redis:7` containers, `--network host`, bound to loopback, all data on
`--tmpfs /data` with `--save ''` / `--appendonly no`:

| Container | Port | Role |
|---|---|---|
| `s130-redis` | `127.0.0.1:6399` | primary (atomic + fallback tests) |
| `s130-redis-ro` | `127.0.0.1:6398` | replica of primary (real `READONLY`) |
| `s130-cluster` | `127.0.0.1:6397` | cluster-enabled, all 16384 slots on one node (`cluster_state:ok`) → real `CROSSSLOT` |

- An ACL user `s130noeval` / `s130pass` with `+@all -eval` produces a real `NOPERM` on EVAL.
- Bridge + `--internal` networking blocked `-p` publishing and protected-mode blocked
  non-loopback auth, so `--network host` on loopback was the only workable isolated binding.
- **No** production Redis/PG/Hub, Compose, `.env`, credentials, or hooks were used or changed.
- Dispatcher-level tests use a real ioredis client + a **stubbed `global.fetch`** (POSTs are
  counted, never sent) and `require.cache` stubs for `book-repo`/`worker-repo`/`workspace-repo`
  (no PG connection is attempted).

## 3. Provenance — the executed script IS the source

Section A of Part 1 asserts the sha256 of `ENSURE_INTENT_RECEIPT_SCRIPT` read from
`queue-idempotency.cjs` equals the sha256 of the `ensure.lua` byte-for-byte, and that the
script the server actually runs (via `EVAL`) is that literal. Part 1 additionally drives the
script through a **production-shaped ioredis client with the fallback flag absent**, so the
atomic path is what runs. The raw `redis-cli --eval …/ensure.lua` runs (below) are a second,
ioredis-independent confirmation.

## 4. Verdict matrix on the real atomic path (Part 1 §B, raw redis-cli)

Every verdict produced by the real script on the real primary:

| Scenario (real keys) | Verdict | Receipt written? |
|---|---|---|
| first fence, no receipt | `created` | yes |
| same fence, receipt already present | `reused` | already present |
| newer fence, newer epoch, not in history | `created` (supersede: `supersedes`+`history` updated) | yes (new dispatch) |
| older/superseded fence (F1 after F2) | `stale_intent` | **no** |
| same fence, `state=cancelled`, not strictly newer | `intent_not_active:cancelled` | **no** |
| receipt already binds a *different* fence | `receipt_conflict` | **no** |
| intent record absent but a receipt exists | `intent_missing` | **no** |
| intent record unparseable / no valid fence | `intent_corrupt` | **no** |
| fence not hex | `invalid_fence` | **no** |

`redis-cli --eval` (independent of ioredis) reproduced the full **F1 → F2 → F1** sequence:
`created` → `created` (supersede) → `stale_intent`, with the intent record
`{"fence":F2,…,"supersedes":F1,"history":[[F1,0]]}` and both receipts intact and immutable
(d1→F1, d2→F2). Re-binding the *same* dispatch to a new fence correctly returns
`receipt_conflict`. TTLs land as configured (intent 600 s, receipt ≈300 s).

## 5. The 10 mandatory scenarios — where each was proven

| # | Scenario | Part 1 | Part 2 / raw |
|---|---|---|---|
| 1 | two identical ensure calls | §B (`reused`) | §1.4 duplicate suppressed, 1 POST; raw `reused` |
| 2 | two fences per task | §B (supersede) | §1.6-1.8 new epoch admitted, supersede + history |
| 3 | F1 → F2 → F1 | §B (`stale_intent`) | §2 stale sender rejected, rolled back, record byte-identical, **no POST**; raw |
| 4 | lock expiry mid-op | §C, §E (counter keep-alive, concurrency) | §H lock busy / lapse / compare-and-delete |
| 5 | Redis error / lost reply | §G (real TCP proxy: lost reply, connection reset, retry) | retry returns `reused` (commit may have landed — idempotent) |
| 6 | Lua/ACL/READONLY/CROSSSLOT/unknown reply | §F (all fail closed, no lock key, fallback never ran) | §5 ACL + replica, **no POST** |
| 7 | receipt vs intent expiry | §D (real TTL boundaries), §B (`intent_missing`) | §3 intent_missing blocks POST |
| 8 | lost generation counter | §C (loss, keep-alive, bounded catch-up, no permanent jam) | — |
| 9 | restart between intent creation and POST | §D (restart durability) | §6 surviving claim suppresses duplicate; after claim lapse, admitted once, intent reused |
| 10 | foreign fence / ref rollback error | §I (fence-scoped compare-and-delete) | §4 WRONGTYPE rollback → `rollbackFailed:true`, counted, ref survives |

In every terminal case the core invariant held: **Hub POST count unchanged, `sent:false`,
`retryable:false`, own claim rolled back, nothing written (before/after state identical),
`jobs_fence_rejected` incremented.**

## 6. Real failure modes of the atomic path (never a silent fallback, never a POST)

- **ACL `NOPERM` on EVAL** (real): `unavailable`/`eval_error` → dispatcher `intent_receipt_unavailable` (retryable), rollback ran, **no lock key**, nothing written. Prometheus `animastor_intent_fence_degraded_total{reason="eval_error"}` increments (operator signal); the dispatcher's local `jobs_intent_fencing_degraded` stays 0 because that local counter tracks *fallback* usage only.
- **READONLY replica**: fails earlier, at the `SET NX` single-pending claim → `duplicate_pending` (retryable), **no POST**, nothing written. (Heartbeat replication waited for, then confirmed.)
- **CROSSSLOT** (real cluster): the 3 script keys (intent/receipt/stage) hash to different slots (8224/2163/12583) → always `CROSSSLOT` → fail closed (`unavailable`), no lock, fallback never ran. **Operational note:** on a Redis Cluster the atomic fence cannot run at all; sends fail closed (retryable, never POST). This is by design (a read-check-write can admit a stale generation).
- **Wrongtype / corrupted data**: `intent_corrupt` → terminal, POST blocked.
- **Lost reply / connection reset** (real TCP proxy): the EVAL may already have committed; the retry is idempotent and returns `reused` — no double-write, no double-POST.
- **OOM / EXECABORT** (real): the WATCH/MULTI transaction aborts → fail closed, no partial state.
- **Unknown EVAL reply**: classified `unknown` → `unavailable` (never re-run through a weaker path).

## 7. Non-Lua fallback (WATCH/MULTI) on the real server (Part 1 §H)

Exercised by stripping `eval` from a wrapper + setting `__allowNonLuaFallback = true`
(harness-only; the flag is **never** set in production code — grep-verified). Parity on the
real primary: create/reuse/supersede/stale/intent_* verdicts identical to the Lua path; lock
busy, lock lapse, and compare-and-delete on the owner token all behave; a lost `WATCH` aborts
the transaction instead of overwriting a newer state.

## 8. Fence-scoped rollback (Part 1 §I, Part 2 §4)

`rollbackOwnEnqueue` releases only the caller's own claim (key derived from its own idem_key)
and deletes the job→fence ref **only while it still points at the caller's fence**
(WATCH/MULTI compare-and-delete). A ref re-mapped by a concurrent regeneration is left
alone (`not_owner`). A rollback that cannot run (real WRONGTYPE on the ref) is reported as
`rollbackFailed:true` and counted in `jobs_fence_rollback_failed` — never a masked success.
`forgetTaskRef` against a READONLY replica returns `{deleted:false, reason:'error'}` (no
masked success).

## 9. Dispatcher end-to-end (Part 2, real ioredis + stubbed fetch)

`sendUnified → executor gate → single-pending claim → ensureIntentAndReceipt → Hub POST`
ran against the real primary for: happy path (1 POST), duplicate suppression (0 extra POST),
legit regeneration (supersede + 1 POST), F1→F2→F1 stale straggler (0 POST), all five terminal
verdicts (0 POST each), rollback-failure (0 POST), ACL + replica outages (0 POST), and
restart recovery (0 POST while claim survives; exactly 1 POST after claim lapses). **Total
Hub POSTs across the whole run equalled exactly the number of authorized sends.**

## 10. Observability (Part 2 §7)

`getStats()` exposes `jobs_fence_rejected`, `jobs_intent_fencing_unavailable`,
`jobs_fence_rollback_failed`. The healthy Lua path never incremented the local degraded
counter (0 before the injected outage). The Prometheus registry recorded every verdict:
`created 4, stale_intent 2, intent_corrupt 2, intent_missing 1, intent_not_active 1,
receipt_conflict 1, rollback_failed 1`, and `animastor_intent_fence_degraded_total{reason="eval_error"}`.

## 11. Observations & limitations (carried forward, not gate failures)

1. **Lost stage counter → epoch comparison disabled** (documented limitation 129 §6.6). With the counter gone, only history guards: an F1 that is already in history is still rejected (`stale_intent`), but a *never-seen* older fence after counter loss is admitted (`created`). Legitimate regeneration after counter loss is blocked only until the restarted INCR catches up (bounded; was `stale_intent` for epochs 1–2, `created` at 3) — i.e. no permanent jam.
2. **`rememberTaskRef` is a blind `SET` executed *before* the intent fence.** A rejected stale sender can transiently overwrite the live generation's job→fence ref with its own fence, then the fence-scoped rollback deletes that own-fence ref — leaving the ref absent (never pointing at the rejected fence). The **intent RECORD (authority) is byte-identical** and the POST is blocked, so this is a low-severity race on a *secondary* best-effort index only.
3. **WATCH/MULTI fallback checks only reply length**, not per-command errors (`multi().exec()` can yield `[[null,0],[{}]]`). Theoretically unreachable — every written key is WATCHed, so an exec-time error first aborts the transaction (null). Noted as an un-inspected theoretical gap.
4. **Dispatcher local vs Prometheus degraded signal.** The local `jobs_intent_fencing_degraded` counts *fallback* usage; the fail-closed `eval_error` path signals via Prometheus `animastor_intent_fence_degraded_total{reason}` instead. Both are visible; an operator reading only `getStats()` would not see the ACL-style outage there.
5. **Production Redis Cluster always fails closed** for this fence (CROSSSLOT on the 3 keys) — sends are retryable but never POST while the cluster cannot run the script. Deployment consideration, not a correctness defect.

## 12. Regression results (working tree at `c5239cf4`, foreign dirty files untouched)

| Suite | Result |
|---|---|
| `gpu-intent-fence-regressions` + `gpu-intent-fence-receipt` | **48 passing** |
| `gpu-queue-idempotency` | **58 passing** |
| `happy-path` | **75 passing** |
| `tests/architecture/**` | **935 passing / 24 pending** |
| full backend `tests/**` | **3425 passing / 28 pending** |
| `scripts/syntax-smoke.sh backend` | all files OK, exit 0 |

The full suite executes the working tree (which carries the pre-existing foreign dirty files:
`generation-routes.cjs`, 5 test files, `dispatch-engine.js`, deleted `audit-orphan-books.js`,
untracked `deploy/`, `freebuff-chat-*.md`) — the same caveat as Stage 128. None of these touch
the intent-fence code; the fencing files are byte-identical to `c5239cf4`.

## 13. Cleanup

Removed only the three throwaway containers (`docker rm -f s130-redis s130-redis-ro
s130-cluster`). All were `--network host` with `--tmpfs /data` (no volumes, no data left).
Confirmed afterward: the production/other containers (`animastor-backend`, `animastor-proxy`,
`gpu-hub`, `buildx_buildkit_repro0`, `repro-redis`, `animastor-pg`, `animastor-redis`), the
networks (`animastor_net`, `repro-net`, …), and all volumes are untouched; no `s130` leftovers.

## 14. Conclusion

**PASS.** The Stage 129 intent-fence fixes hold under a real, isolated Redis. The actual Lua
script from source produces every expected verdict, writes nothing before a reject, and every
terminal verdict blocks the Hub POST with the sender's own side effects rolled back and no
partial success state. The atomic path fails closed on every real outage (ACL/READONLY/
CROSSSLOT/OOM/lost-reply) without ever silently switching to fallback or causing a POST; the
WATCH/MULTI fallback (test-only reachable) shows verdict parity on the same real server.
All Stage 129 regressions, GPU dispatch/idempotency, architecture, and the full backend suite
pass. No production system was contacted or modified.
