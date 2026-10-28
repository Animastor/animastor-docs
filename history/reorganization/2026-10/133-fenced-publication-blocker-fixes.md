# Stage 133 — Fix Fenced Publication Blockers (audit 132 B1–B5)

**Вердикт: PASS.**

Все пять блокеров независимого аудита Stage 132 устранены в production-коде и подтверждены
регрессионными тестами, включая прогон на **реальном изолированном Redis с исполнением
`FENCE_COMMIT_SCRIPT`** и временной файловой системой. Актуальный callback и crash recovery
продолжают работать; fail-closed подтверждён для отсутствующего receipt и для ошибок Redis.
Полный backend suite зелёный, посторонние dirty-файлы не тронуты, production не затрагивался.

- **Исходный HEAD:** `fa1fa1d6a795c488171294807b68d1ab06c37ade` (Stage 131).
- **Новый локальный commit:** `cd31d279` — 12 файлов, **+885 / −231** (push/deploy не выполнялись).
- **Отчёт аудита:** `/home/animastor/reorg-2026-10-23/132-fenced-publication-independent-audit.md`.
- **Артефакты Stage 133:** `/home/animastor/reorg-2026-10-23/audit-133/`
  (`01-real-redis-blockers.cjs`, `01-results.json`, `01-log.txt`, `full-suite.log`).

---

## 0. Baseline и границы

Зафиксировано ДО любых изменений (`git rev-parse HEAD`, `git status --porcelain`, `sha256sum`):

```
HEAD fa1fa1d6a795c488171294807b68d1ab06c37ade
 D backend/scripts/audit-orphan-books.js
 M backend/src/routes/book/generation-routes.cjs
 M backend/tests/ai-endpoint-sharing.test.js
 M backend/tests/ai-shared-inference.test.js
 M backend/tests/architecture/installer-package-boundary.test.js
 M backend/tests/architecture/phase5-runtime-result.test.js
 M backend/tests/gpu-lane-release-order.test.js
 M packages/animastor-orchestration/src/runtime/dispatch-engine.js
?? deploy/
?? freebuff-chat-2026-10-11T07-41-12.445Z.md
```

После работы все восемь хэшей совпадают с baseline байт-в-байт (проверено `sha256sum`), удаление
`audit-orphan-books.js` не восстанавливалось, untracked-пути не трогались. `git status` после
коммита содержит **только** эти же посторонние записи.

Соблюдено: production Redis/PostgreSQL/GPU Hub/очереди/контейнеры не читались и не менялись;
Compose, `.env`, production-конфигурация и запущенные сервисы не тронуты; `GPU_FENCING_MODE=enforce`
не включался (переменная нигде не выставлялась); push/deploy/npm publish/CI не выполнялись; очистки
очередей и удаления данных нет; тесты — только изолированный throwaway `redis:7` и `mkdtemp`-FS;
чужого форматирования/refactor'а нет. Throwaway-контейнер `a133-redis` удалён после прогона.

---

## 1. Что исправлено

### B1 (P0) — callback без receipt больше не попадает в legacy-путь

`backend/src/services/task-handler.cjs`, `backend/src/routes/generation-routes.cjs`

- Ветка «нет fence evidence → прямая запись canonical» удалена. Единственный оставшийся legacy-writer —
  явный kill-switch `GPU_FENCING_MODE=off` (contract 126 §6); в любом автоматическом режиме
  отсутствие receipt — терминальный отказ **до** staging, до записи canonical, до manifest и до
  chunk/ready-метаданных.
- Route `/gpu/task/result` гейтит **до** вызова handler: `receipt_missing`/`receipt_corrupt` →
  `{ ok:true, rejected:true, reason }`, dedup-маркер сохраняется (терминально, retry не поможет),
  ни один байт не пишется.
- В handler добавлен жёсткий инвариант: если режим не `off`, а fence не разрешён — `throw`
  (`receipt_missing`), ветка `fs.writeFileSync` недостижима.

### B2 (P0) — mutable job→fence ref больше не резолвит fence

`backend/src/helpers/queue-idempotency.cjs` — новый `resolveDispatchFence(redis, {dispatchId, jobId})`:
единственный источник — immutable dispatch receipt (`animastor:dispatch-intent:{dispatch}:{job}`).
Fallback на `readTaskRef` удалён и в route, и в handler. Сценарий аудита
(F1 superseded by F2 → callback F1 без receipt, ref→F2 → настоящий результат F2) проверен на реальном
Redis: F1 отклоняется **до** любых canonical/metadata изменений, F2 затем публикуется штатно
(харнесс `T1` + `C2`).

### B5 (P0) — ошибка чтения Redis = fail closed, не legacy

`resolveDispatchFence` различает четыре состояния: `ok | absent | corrupt | error`.

- `error` (WRONGTYPE/timeout/соединение) → route отвечает **503** `{ error:'fence_lookup_unavailable',
  retryable:true }` и снимает dedup (hub вправе повторить); handler бросает
  `fence_lookup_unavailable` (retryable). Ни файла, ни manifest, ни metadata.
- `absent` / `corrupt` → терминальный отказ (`receipt_missing` / `receipt_corrupt`), запись запрещена.
- Побочно: деградация учитывается как `animastor_intent_fence_degraded_total{reason="receipt_read_error"}`.

Реальный Redis: LIST под ключом receipt → `GET` даёт WRONGTYPE → `resolveDispatchFence` = `error`,
handler = `fence_lookup_unavailable`, canonical не создан (харнесс `T4`).

### B3 (P0) — debug audio recovery пишет только после проверки fencing

`backend/src/services/audio-recovery.cjs`, `backend/src/routes/debug-routes.cjs`

- `recoverAudioForScene` — гейт первым: (1) dispatch identity (`dispatch_id` из payload или от
  оператора), (2) immutable receipt для этого dispatch, (3) только затем байты передаются в
  `taskHandler.handleTaskResult(..., { fence })`, который стейджит и публикует через atomic fenced
  commit. Собственные `fs.writeFileSync` canonical/`_0001.mp3` и `saveChunk(... audio_status:'ready')`
  удалены — до гейта запись невозможна в принципе.
- `missing_dispatch_id` → `{ recovered:false, reason:'missing_dispatch_id', gated:true }`, файлы и
  metadata не изменены, replay-ключ **сохраняется** для оператора. `receipt_missing`/`receipt_corrupt`
  → отказ без записи; `fence_lookup_unavailable` → retryable.
- Терминальный fence-отказ (`stale_intent`/`intent_missing`/`intent_corrupt`/`invalid_fence`/
  `receipt_missing`/`receipt_corrupt`) удаляет только replay-ключ (он не может опубликоваться),
  файлов не касается.
- `recoverAudioResults` (scan-путь, в production не подключён) больше не пишет сам: делегирует в тот же
  gated per-scene путь; legacy-ключи без провable scene и image-результаты (их ведёт reconcile Phase A)
  пропускаются.
- Route принимает необязательный `dispatch_id` в body — операторский путь ручного восстановления,
  по-прежнему требующий receipt.

### B4 (P1) — старый done-маркер не разрешает публикацию устаревшего staging

`backend/src/helpers/queue-idempotency.cjs` (`FENCE_COMMIT_SCRIPT`), `backend/src/services/result-publication.cjs`

- Скрипт: порядок изменён на **intent → done**. `done:F` доказывает, что коммит был, но не что fence
  актуален; устаревший fence теперь получает `stale_intent` и **не** доходит до rename-replay.
  `duplicate_same_fence` возвращается только после подтверждения «этот fence — текущий active intent».
- `resumePendingPublications`: добавлен intent-гейт — committed манифест устаревшего fence
  пропускается (`superseded++`), staged-каталог остаётся age-gated GC; отсутствие intent (истёк после
  коммита) по-прежнему разрешает replay (durable пара — единственное доказательство); ошибка
  чтения/парсинга intent = «нельзя доказать» → ничего не пишется.
- Сценарий аудита (F1 commit → crash до rename → supersede F2 → F2 тоже commit+crash → ретрай F1 →
  resume) воспроизведён на реальном Lua: ретрай F1 = `stale_intent`, canonical не создан, resume
  публикует **F2**, и canonical/manifest/done согласованы на F2 (харнесс `R8`, мок-тест 18/18).

Отдельно проверено, что истинное crash-окно текущего fence по-прежнему восстанавливается
(`resume` `resumed=1`, повторный проход — `0`), т.е. recovery не сломан.

---

## 2. Telemetry и режимы

- **Метрика для callback без receipt:** `animastor_fence_commit_total{outcome="receipt_missing"}` и
  `{outcome="receipt_corrupt"}` через `observeFenceGateReject()` (route, handler, recovery). Это
  замена несуществовавшей `legacy_no_receipt` из аудита 132 §1.2 — но считает она уже **отказы**, а не
  небезопасные записи. Проверено на реальном Redis (харнесс `METRIC`, `receipt_missing=5`).
- **`GPU_FENCING_MODE`:**
  - `off` — документированный kill-switch (contract 126 §6), **единственный** оставшийся путь прямой
    записи canonical. Требует явного действия оператора, по умолчанию не включён; в Stage 133 не
    включался. (Остаточный риск, см. §4.)
  - `observe` — fence обязателен (receipt), иначе терминальный отказ.
  - `enforce` — **идентичен observe по построению, а не по умолчанию**: небезопасная ветка, в которую
    раньше проваливался observe, больше не существует, поэтому метка не может добавить или убрать
    запись. Разделение режимов с иной семантикой потребовало бы отдельного изменения контракта и в
    Stage 133 не имитировалось.
  - **Stage 133 не объявляется завершением observe→enforce migration**; `enforce` в production не
    включался, решение о включении — операторское.

---

## 3. Тесты и доказательства

### 3.1 Новый регрессионный сьют (репозиторий)

`backend/tests/gpu-fenced-publication-gates.test.js` — **18 passing / 0 failing**.
Воспроизводит исходные сценарии Stage 132 и проверяет новое поведение:

| Блокер | Проверка |
|---|---|
| B1/B2 | stale callback без receipt при ref→текущему fence → `receipt_missing`, canonical/chunk/metadata/done/manifest не созданы; истёкший receipt — тоже отказ; route отклоняет до handler'а (spy = 0 вызовов) |
| B5 | GET receipt → ошибка: handler `fence_lookup_unavailable`, route 503 retryable, ничего не записано |
| B2/контроль | текущий callback с receipt → fence берётся из receipt (не из ref); `receipt_corrupt` → отказ; `off`-kill-switch пишет напрямую (документированный override) |
| контроль | текущий fence: canonical + manifest + done + chunk-metadata; устаревший fence с живым receipt → `stale_intent`, ничего не записано, свой staging удалён |
| B3 | `missing_dispatch_id` / `receipt_missing` → файлы и metadata не изменены, handler не вызван, replay-ключ сохранён; успешный gated-recovery передаёт receipt-fence; fence-отказ ничего не пишет |
| B4 | commit F1 → crash → supersede F2 → ретрай F1 не публикует; resume пропускает superseded (`superseded=1`); двойное crash-окно → resume публикует F2, canonical/manifest/done согласованы; текущее crash-окно всё ещё восстанавливается |

Изменения существующих тестов (усиление, не ослабление):
- `gpu-result-fencing-commit.test.js`: «late redelivery уже закоммиченного F1 после supersede» теперь
  ожидает `stale_intent` вместо `duplicate_same_fence` — именно это и есть фикс B4 (файл остаётся `v2`).
- `tests/mocks/redis-mock.js`: независимое зеркало `FENCE_COMMIT_SCRIPT` приведено к новому порядку
  (intent → done).
- `private-worker-phase2.test.js`: route-монтаж получает реальный `queueIdempotency`-порт и receipt для
  `dispatch-cb-1` (иначе callback законно отклоняется гейтом); проверяемое поведение (workspace
  403/200, claimer) не изменено.

### 3.2 Реальный изолированный Redis + Lua + временная FS

`audit-133/01-real-redis-blockers.cjs` против throwaway `redis:7` (`a133-redis`, `127.0.0.1:6397`,
`--save '' --appendonly no`, без volume), production-модули, реальный `FENCE_COMMIT_SCRIPT`:

```
01: 12/12 scenarios behave as FIXED   (exit 0)
PASS [fixed]   T1-stale-no-receipt-ref-to-current-fence
PASS [control] C2-real-fence-result-publishes-after-the-rejection
PASS [fixed]   T2-no-receipt-legacy-write-blocked
PASS [control] T3-live-receipt-of-superseded-fence-is-stale_intent
PASS [fixed]   T4-redis-get-error-fails-closed-retryable           (WRONGTYPE на ключе receipt)
PASS [fixed]   T6-expired-receipt-is-not-a-legacy-write
PASS [fixed]   T7-debug-recovery-writes-nothing-before-the-gate
PASS [fixed]   T8-no-fence-evidence-never-writes-canonical
PASS [fixed]   R8-old-done-cannot-republish-superseded-bytes
PASS [fixed]   R9-resume-never-publishes-a-superseded-manifest
PASS [control] KILLSWITCH-off-mode-writes-directly-by-design
PASS [fixed]   METRIC-receipt-missing-gate-rejections-are-counted
```

Покрытие требования «проверить на реальном Redis»: (1) stale callback без receipt не пишет canonical и
metadata — T1/T2/T6/T8; (2) mutable ref не позволяет опубликовать F1 под F2 — T1 (ref→F2) + C2
(настоящий F2 затем публикуется); (3) Redis GET failure не даёт fail-open — T4; (4) debug recovery не
меняет файлы до проверки — T7; (5) старый `done:F1` не восстанавливает F1 после supersede — R8/R9;
(6) текущий callback и crash recovery работают — C2/R8-resume/`a genuinely current crash window`
(мок-тест); (7) legacy-совместимость проверена отдельно — только явный `GPU_FENCING_MODE=off`.

### 3.3 Обязательные прогоны (точные команды и результаты)

| Команда (cwd `backend/backend` или repo root, как указано) | Результат |
|---|---|
| `npx mocha --exit tests/gpu-fenced-publication-gates.test.js` | **18 passing**, exit 0 |
| `npx mocha --exit tests/gpu-result-fencing-commit.test.js tests/gpu-queue-idempotency.test.js tests/gpu-intent-fence-regressions.test.js tests/gpu-intent-fence-receipt.test.js tests/gpu-lane-release-order.test.js tests/dispatch-meta-lease-lifecycle.test.js tests/markready-build-id-idempotency.test.js` | **189 passing / 0 failing** (== Stage 132 baseline 30+111+48) |
| `npx mocha --exit tests/private-worker-phase2.test.js` | **40 passing / 1 pending**, exit 0 |
| `npx mocha --exit 'tests/architecture/*.test.js'` | **935 passing / 24 pending / 0 failing** (== baseline) |
| `npx mocha --recursive tests/ --exit` (на закоммиченном HEAD) | **3473 passing / 28 pending / 0 failing**, `exit 0` (`audit-133/full-suite.log`); baseline 132 = 3455 → **+18** (новый сьют) |
| `./scripts/syntax-smoke.sh backend` (repo root) | `All production JS/CJS files pass syntax check`, exit 0 |
| `node audit-133/01-real-redis-blockers.cjs` | **12/12**, exit 0 |

Зелёный full suite **не** использован как единственное доказательство: блокеры воспроизводятся
адресными тестами (18 кейсов) и харнессом на реальном Redis/Lua.

**Одна итерация без зелёного результата (честно):** первый полный прогон дал
`1 failing` в `tests/reconciliation-engine.test.js` — guard «копия в `backend/node_modules`
байт-в-байт равна `packages/`», потому что я расширил `packages/.../reconciliation-engine.js`
(список терминальных кодов Phase A). Правка откачена (`git checkout --`), сьют перезапущен:
`84 passing`, затем полный suite 3473/0. Синхронизация установленной копии пакета — отдельный
деплой-долг (см. §4), в scope Stage 133 не входит.

---

## 4. Оставшиеся риски (НЕ исправлены и не заявляются исправленными)

1. **PostgreSQL projection/replay** (audit 132 §2): `generation_fence`-миграции нет, replay
   metadata-цепочки из `fence-journal` нет; сценарии 2–4 по-прежнему самолечатся через Phase D
   (rework), без ложного `ready`. Требует отдельного этапа (schema).
2. **Manifest retention** (audit 132 §3.2): ключи без TTL, GC только `.staging`, `RESUME_MANIFEST_LIMIT=200`;
   политика prune не внедрялась. `releaseTaskDoneIfOrphan` × committed-unrenamed — тоже открытый edge.
3. **Redis epoch-gap на send-стороне** (audit 132 §4 obs.1): dispatch-side читатели не ревьюировались,
   риск не объявляется устранённым. CROSSSLOT/Cluster и reply-length fallback — без изменений.
4. **Локальная копия `@animastor/orchestration` в `backend/node_modules` устарела** относительно HEAD
   (деплой-долг, audit 132 §5.3). Поэтому Phase A reconcile (`recoverResultKeys`) не получал нового
   терминального кода: результат с dispatch identity, но без receipt теперь отклоняется handler'ом
   (`receipt_missing`), ключ остаётся до истечения своего 1-часового TTL и не пишет ни файла, ни
   metadata (безопасно, но с предупреждением в логе на цикл). Правка пакета откачена именно из-за
   byte-equality guard'а; синхронизация пакета — отдельная задача деплоя.
5. **`GPU_FENCING_MODE=off`** остаётся явным документированным обходом fencing (contract 126 §6):
   единственный путь прямой записи canonical без fenced commit. По умолчанию не включён, требует
   действия оператора. Требование «ни в каком режиме» выполнено для всех автоматических режимов;
   kill-switch сохранён осознанно (его удаление — изменение контракта, вне scope).
6. **`observe == enforce`** — теперь по построению (небезопасной ветки нет). Миграция не объявляется
   завершённой, `enforce` в production не включался.
7. **`audio-recovery.recoverAudioResults`** (не подключён в production) больше не обрабатывает
   image-ключи и legacy-ключи без провable scene — они остаются за reconcile Phase A. Поведение
   осознанно: любой самостоятельный write в этом файле был бы обходом гейта.

---

## 5. Изменённые файлы (commit `cd31d279`)

```
 backend/src/config/runtime-config.js               |  21 +-   (семантика режимов)
 backend/src/helpers/queue-idempotency.cjs          |  76 +-   (resolveDispatchFence, intent-first Lua, метрика, FENCE_IDENTITY_REJECTED)
 backend/src/metrics/prometheus.js                  |   4 +    (документация outcome'ов)
 backend/src/routes/debug-routes.cjs                |  11 +-   (dispatch_id для recovery)
 backend/src/routes/generation-routes.cjs           |  55 +-   (receipt-only гейт, 503 на ошибку чтения)
 backend/src/services/audio-recovery.cjs            | 274 +-   (гейт до записи, делегирование в fenced commit)
 backend/src/services/result-publication.cjs        |  45 +-   (intent-гейт resume, superseded)
 backend/src/services/task-handler.cjs              |  50 +-   (fail-closed fence resolution, legacy только off)
 backend/tests/gpu-fenced-publication-gates.test.js | 557 +    (новый регрессионный сьют, 18 кейсов)
 backend/tests/gpu-result-fencing-commit.test.js    |   7 +-   (ожидание stale_intent вместо duplicate)
 backend/tests/mocks/redis-mock.js                  |   4 +-   (зеркало Lua: intent → done)
 backend/tests/private-worker-phase2.test.js        |  12 +    (порт queue-idempotency + receipt)
```

Staged diff проверен пофайлово перед коммитом; посторонние dirty/untracked-файлы в коммит не попали.

---

## 6. Критерии завершения

| Критерий | Статус |
|---|---|
| B1–B5 устранены и подтверждены тестами | ✅ 18 регрессионных кейсов + 12/12 на реальном Redis/Lua |
| Новые тесты воспроизводят исходные сценарии Stage 132 и проходят | ✅ T1, T2, T4, T6, T7, T8, R8 (+ R9, C2, контроли T3) |
| Fail-closed при Redis errors и отсутствии receipt | ✅ 503 retryable / терминальный отказ, ноль записей |
| Актуальный callback и crash recovery работают | ✅ C2, R8-resume, «current crash window» |
| Полный backend suite без новых failures | ✅ 3473 passing / 28 pending / 0 failing, exit 0 |
| Изменения в согласованном scope | ✅ без PG-миграций, retention, deploy/push, unrelated refactor |
| Посторонние dirty-файлы не затронуты | ✅ sha256 совпадают с baseline |
| Независимый воспроизводимый отчёт с доказательствами | ✅ этот файл + `audit-133/` |
