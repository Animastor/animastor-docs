# Stage 136 — логи команд

Все команды запускались на HEAD `6a6f18910cc73085533d3bf1b5c51996f90541bd`
(`/home/animastor/animastor-backend`), Redis — throwaway `a136-redis`
(`redis:7`, `127.0.0.1:6401`, `--save '' --appendonly no`), FS — `mkdtemp`.
Логи лежат рядом с этим файлом.

| # | cwd | команда | exit | результат |
|---|---|---|---|---|
| 1 | repo | `git rev-parse HEAD` | 0 | `6a6f18910cc73085533d3bf1b5c51996f90541bd` |
| 2 | repo | `git status --porcelain` | 0 | 10 записей, идентичны baseline Stage 134/135 |
| 3 | repo | `sha256sum <8 посторонних файлов>; find deploy -type f | xargs sha256sum` | 0 | совпадает с baseline (§1 отчёта) |
| 4 | `backend/` | `npx mocha --exit tests/gpu-publication-consistency.test.js` | 0 | **16 passing** — `10-gpu-publication-consistency.log` |
| 5 | `backend/` | `npx mocha --exit tests/gpu-fenced-publication-gates.test.js tests/gpu-result-fencing-commit.test.js` | 0 | **48 passing** (18 + 30) — `11-gates-and-fencing.log` |
| 6 | `backend/` | `npx mocha --exit tests/gpu-queue-idempotency.test.js tests/gpu-intent-fence-regressions.test.js tests/gpu-intent-fence-receipt.test.js tests/gpu-lane-release-order.test.js tests/dispatch-meta-lease-lifecycle.test.js tests/markready-build-id-idempotency.test.js tests/book-registry-recovery-gate.test.js tests/startup-recovery-registry-gate.test.js` | 0 | **168 passing** — `12-targeted-idempotency-dispatch-recovery.log` |
| 7 | `backend/` | `npx mocha --exit tests/private-worker-phase2.test.js` | 0 | **40 passing / 1 pending** — `13-private-worker-phase2.log` |
| 8 | `backend/` | `npx mocha --exit 'tests/architecture/*.test.js'` | 0 | **935 passing / 24 pending** — `14-architecture.log` |
| 9 | `backend/` | `npx mocha --recursive tests/ --exit` | 0 | **3489 passing / 28 pending / 0 failing** — `16-full-backend-suite.log` |
| 10 | repo | `./scripts/syntax-smoke.sh backend` | 0 | `All production JS/CJS files pass syntax check` — `15-syntax-smoke.log` |
| 11 | `audit-136/` | `node 01-b1-b6-real-redis.cjs` | 1 | **21/24 PASS**; 3 FAIL — это находки B3e/B3f/B3g — `01-run.log`, `01-results.json` |
| 12 | `audit-136/` | `node 02-marker-safety.cjs` | 1 | **13/17 PASS**; 4 FAIL — находки M8/M9/RACE1/RACE2 — `02-run.log`, `02-results.json` |
| 13 | `audit-136/` | `node 05-rerun-audit134-independent.cjs` | 0 | **15/15**, probes=2 — `05-rerun-audit134-independent.log` |
| 14 | `audit-136/` | `node 06-rerun-audit134-minimal-repro.cjs` | 0 | `blocked=false` (R1/R2 invariant=true) — `06-rerun-audit134-minimal-repro.log` |
| 15 | `audit-136/` | `node ../audit-135/01-b6-real-redis.cjs` | 0 | **12/12** (harness автора, без изменений) — `07-rerun-audit135-harness.log`, `07-audit135-results-rerun.json` |

Примечания:

* Harness `01`/`02` завершаются с exit 1 намеренно: FAIL — это зафиксированные
  findings, а не сбой инфраструктуры.
* Запуск #15 пишет свой `01-results.json` в `__dirname` harness'а, то есть в
  `audit-135/01-results.json`; файл Stage 135 был перезаписан результатом
  повторного прогона (те же 12 сценариев, 12/12). Копия сохранена в
  `07-audit135-results-rerun.json`. Исходные `.cjs`, отчёты и прочие артефакты
  Stage 135 не изменялись.
* `05`/`06` — копии harness'ов Stage 134 с заменой порта `6398 → 6401`
  (единственная правка, чтобы не зависеть от контейнера предыдущего этапа).
* Контейнер `a136-redis` удалён после прогонов. Оставшиеся от Stage 135
  `a135-redis` (6399) и `a135-redis-6398` (6398) не трогались.
