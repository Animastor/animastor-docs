# Stage 137 — команды и результаты

Все команды выполнены с cwd как указано. Real-Redis сценарии используют
изолированный throwaway Redis (`a137-redis`, 127.0.0.1:6402, `--save '' --appendonly no`,
loopback-only, без volume) — production Redis/PG/GPU Hub/очереди/контейнеры не затронуты.

```
# изоляция
docker run --rm -d --name a137-redis -p 127.0.0.1:6402:6379 redis:7 --save '' --appendonly no
docker exec a137-redis redis-cli ping      # PONG

# ── независимые real-Redis сценарии Stage 137 ──────────────────────────
cd /home/animastor/reorg-2026-10-23/audit-137
AUDIT_REDIS_URL=redis://127.0.0.1:6402/0 node 01-core.cjs        # exit 0 — 24/24 PASS
AUDIT_REDIS_URL=redis://127.0.0.1:6402/0 node 02-race-child.cjs  # только через 01-core (RACE1/RACE2)

# ── независимые harness'ы предыдущих аудитов, прогнанные на коде Stage 137 ──
AUDIT_REDIS_URL=redis://127.0.0.1:6402/0 node 10-rerun-audit136-b1b6.cjs            # exit 0 — 24/24 PASS
AUDIT_REDIS_URL=redis://127.0.0.1:6402/0 node 11-rerun-audit136-marker-safety.cjs   # exit 0 — 17/17 PASS
AUDIT_REDIS_URL=redis://127.0.0.1:6402/0 node 12-rerun-audit134-independent.cjs     # exit 0 — 15/15 PASS, probes=2
AUDIT_REDIS_URL=redis://127.0.0.1:6402/0 node 13-rerun-audit134-minimal-repro.cjs   # exit 0 — blocked=false

# ── тесты проекта (cwd /home/animastor/animastor-backend/backend) ─────
npx mocha --exit tests/gpu-publication-consistency.test.js                                          # 16 passing, exit 0
npx mocha --exit tests/gpu-fenced-publication-gates.test.js tests/gpu-result-fencing-commit.test.js # 48 passing, exit 0
npx mocha --exit tests/gpu-queue-idempotency.test.js tests/gpu-intent-fence-regressions.test.js \
            tests/gpu-intent-fence-receipt.test.js tests/gpu-lane-release-order.test.js \
            tests/dispatch-meta-lease-lifecycle.test.js tests/markready-build-id-idempotency.test.js \
            tests/book-registry-recovery-gate.test.js tests/startup-recovery-registry-gate.test.js  # 168 passing, exit 0
npx mocha --exit tests/private-worker-phase2.test.js                                                # 40 passing / 1 pending, exit 0
npx mocha --exit 'tests/architecture/*.test.js'                                                     # 935 passing / 24 pending, exit 0
npx mocha --recursive tests/ --exit                                                                 # финал — см. 16-full-backend-suite.log
cd /home/animastor/animastor-backend && ./scripts/syntax-smoke.sh backend                           # exit 0

# изоляция после прогонов (в конце работы)
docker rm -f a137-redis
```

Логи: `01-run.log`, `10-run.log`, `11-full3.log`, `12-run.log`, `13-run.log`,
`10-…16-*.log`, `15-syntax-smoke.log`. Результаты: `01-results.json`,
`02-results.json` (01-core), `10-…`/`11-…`/`12-…` рядом с harness'ами.

Порт 6401 (a136-redis) и 6398/6399 (a135-redis) не использовались и не изменялись.
