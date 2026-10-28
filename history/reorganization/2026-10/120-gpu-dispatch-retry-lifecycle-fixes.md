# Stage 120 — GPU dispatch: исправление блокеров F1/F2 и находок M-a…M-f аудита Stage 119

**Дата:** 2026-10-22 (завершено 10:45Z)
**Базовый коммит:** `e2f5bb4c` (main; origin/main `53ce5045` — не тронут)
**Новый коммит:** `78bbfe18` (локально, без push)
**Отчёт-источник:** `reorg-2026-10-19/119-gpu-dispatch-independent-audit.md` (2 блокера F1, F2 + 6 средних M-a…M-f)
**Репозиторий:** `animastor-backend` (только backend; `@animastor/orchestration` **не менялся** — все фиксы host-side)
**Режим:** локально. Push / CI / GHCR / deploy / `npm publish` **не выполнялись**. Версии пакетов, lockfiles, зависимости, remote refs, `.env`/Compose/hooks, production Redis/PG/Hub/очереди 457/438 **не изменялись**. Чужие dirty-файлы не тронуты. Все прогоны — с песочницей `PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1`.
**Итог: PASS** — оба блокера и все 6 средних находок закрыты кодом и регрессионными тестами (по месту из §13.1 аудита); полный suite против baseline Stage 118: набор падений **идентичен** (0 новых, 0 пропавших), +23 новых теста, все зелёные.

---

## 0. Сводка

| ID | Дефект (аудит 119) | Исправление | Тест |
|---|---|---|---|
| **F1** | pin-эпоха задачи (M6) переживала `markDirtyScene` ⇒ легитимная стадийная регенерация audio/video/image подавлялась как `already_completed` (первая же попытка) | `markDirtyScene` после `bumpStageEpoch` вызывает новый `resetJobEpochForStage` — снимаются **только** пины задач этой стадии (job_id → стадия через грамматику contracts `jobProtocolV2`); никакого blanket-сброса | `gpu-queue-idempotency.test.js` «Stage 120»: 3 кейса F1 (audio/video/image: отправка → settlement → CONTROL `already_completed` → `markDirtyScene` → pin пуст → ре-диспатч **принят**, старый маркер цел, ровно 2 POST) + «F1: markDirtyScene of ONE stage never resets a sibling stage» |
| **F2** | `refreshClaimTtl` при `duplicate_pending` продлевал claim до 24 ч, **обнуляя** 90-минутное окно неоднозначного исхода (блокировка 24 ч вместо 90 мин) | значение claim'а несёт состояние (`'pending'`/`'ambiguous'`); `shortenClaimTtl` = атомарный `SET 'ambiguous' XX EX`; `refreshClaimTtl` = Lua `REFRESH_CLAIM_TTL_SCRIPT` (нет ключа → 0, `ambiguous` → -1, иначе `SET XX EX` → 1) + read-then-extend JS-фолбэк для клиентов без `eval` | 3 кейса: поведенческий на реальном `duplicate_pending`-пути (фактический TTL ≤ 90 мин после refresh, resend после 90 мин — отправлен), state-aware unit, eval/Lua-путь через `createMockRedis` |
| **M-a** | cache-teardown отвечал `{cleared:true}` при **неподтверждённой** очистке lane хаба (claims/markers сохранены, книга не авто-регенерируется) | честное тело: `{cleared:false, hub_cleared:false, claims_kept:true, error:'hub_queue_clear_failed'}` (HTTP 200 сохранён — lane-order контракт; cancel-путь остаётся 500) | `gpu-lane-release-order.test.js` «M-a: the cache response never claims cleared when the hub clear is unconfirmed» |
| **M-b** | гонка clear-lane ↔ release-claim: dispatch между очисткой и release'ом оставлял **осиротевшую** запись lane без claim (следующий диспатч ставил второй экземпляр) | второй проход очистки lane **после** release'а во всех четырёх путях: cache/delete/cancel — прямой `fetch`, regenerate — `ports.hubCancel.hubCancelOp('clearHubDispatches')` за `isHubCancelPortWired()`; ошибки оставляют безопасное восстановимое состояние (claims не трогаются) | 4 кейса в `gpu-lane-release-order.test.js` (cancel, cache, cache+throw, delete cascade) + hub-fail ⇒ claimskept/1 попытка + структурный кейс regenerate |
| **M-c** | `already_completed` на SEND-пути ⇒ вечный цикл: деферал 900 с → та же причина → сцена навсегда в active-index | в `processSingleIU` (не `sendUnified` — контракт существующего теста): `already_completed` достижим только при **отсутствующем** артефакте (кэш-хит коротко замыкает раньше отправки) ⇒ маркер осиротевший → `releaseTaskDone` + **одна** повторная отправка | интеграционный `gpu-orphan-completed-marker.test.js` (реальный `processSingleIU` → реальный transport → реальный `guardEnqueue`): 3 диспатча — отправлен → orphan-release+регенерация (2 POST, done-маркер удалён) → `duplicate_pending` (bounded deferral, НЕ `already_completed`, POST не прибавился) + unit-кейс `releaseTaskDone` |
| **M-d** | удаление книги/очистка не удаляли `animastor:idempotency:job-epoch:*` (24 ч «привиденческих» suppressed-задач), а сырое удаление `ref:*` создавало бы unreachable-маркеры (реоткрытый B4) | в `cleanBookRedisKeys` добавлен **только** префикс `animastor:idempotency:job-epoch:{book}:*` (percent-encoded); `ref:*` намеренно **не** добавлен — ref остаётся индексом владения (B1/M-f) | «M-d: cleanBookRedisKeys purges this book's job-epoch pins and KEEPS the ownership refs» (scan-перехват: свой book закрыт, чужой и ref — сохранены) |
| **M-e** | финальный 4xx (401/403/404/422) ретраился 3 раза с 2-секундными паузами — детерминированный отказ не меняется | `RETRYABLE_4XX = {400,408,409,425,429}`; иной 4xx ⇒ `break` после первой попытки. 400 оставлен ретрабельным (гонка bad-request; контракт B2-тестов) | «M-e: a FINAL 4xx rejection is attempted exactly ONCE» (401 → ровно 1 fetch, claim освобождён) + «M-e: a TRANSIENT 4xx (429) still gets all three attempts» |
| **M-f** | settle при **истёкшем** ref писал слепой done-маркер поверх мёртвого ref — unreachable 7 сут (задача вечно `already_completed`, release-путь его не находит) | новый `settleCompletedTask(redis, {bookId,…,idemKey})`: extend ref → **repair** ref из job_id при отсутствии → verify ref указывает на этот idem_key → только тогда `markTaskDone` → release claim; при пере-mapping ref'а другим диспатчем маркер **пропускается** | 3 кейса settleCompletedTask (живой ref / repair / пере-mapping ⇒ `markerWritten:false`) + структурный кейс: `generation-routes.cjs` вызывает `qidem.settleCompletedTask(redis, {` и больше не содержит слепой пары `markTaskDone→extendTaskRef` |

`@animastor/orchestration` не требовал изменений: все находки закрыты на host-стороне, пакетные 35/0 не изменились.

---

## 1. Ключевые решения по исправлениям

**F1 (вариант «а» аудита).** Источник истины «задача этой стадии подлежит регенерации» — `markDirtyScene` (reconciliation stuck-repair, RELEASE_STALE_LEASE, C1/C1b recovery, restore, placeholder audio, `invalidateSceneAssets`). Он уже двигает stage-epoch; теперь он же снимает пины задач **своей** стадии. Job_id → стадия однозначно: `bk_ch_sc_0000:audio` → audio, `bk_ch_sc:video` → video, `bk_ch_sc_iu-1:iu_image` → image (grammar contracts `jobProtocolV2`, фасад `runtime/job-schema.js`). Легитимная регенерация получает свежую идентичность с первой попытки; старый completion-маркер и параллельный диспатч новой идентичности не валидны (тест: CONTROL до сигнала = `already_completed`; новый ключ ≠ старому; POST ровно 2).

**F2.** Состояние claim'а — значение ключа, поэтому Lua-шаг атомарен и не нуждается в read-then-write. `duplicate_pending`-refresh выполняется на **реальном** пути подавления (sendUnified → guardEnqueue → refresh) и фактический TTL проверяется после travel времени; `'ambiguous'` никогда не поднимается выше `IDEM_AMBIGUOUS_CLAIM_TTL_S` (5400 с), отпущенный claim не воскресает (missing → 0). Тестовый FakeRedis без `eval` покрывает JS-фолбэк; Lua-путь — отдельный кейс на `createMockRedis` с записанным вызовом `eval`.

**M-c.** Размещён в `processSingleIU`, а не в `sendUnified`: существующий тест «already_completed» запрещает менять поведение sendUnified. Инвариант: на SEND-пути `already_completed` возможен **только** при пробе артефакта «отсутствует» (наличие артефакта уходит в кэш-хит и никогда не отправляется) — значит маркер всегда осиротевший. Retry ровно один; повторная отправка сажает свежий pending-claim той же логической задачи, поэтому третий диспатч получает нормальный bounded-деферал `duplicate_pending`, а не цикл.

**M-b.** Второй проход очистки — **после** release'а и только при подтверждённом первом (при отказе хаба claims сохраняются, sweep не нужен — безопасное направление). Гонка с concurrent-dispatch'ем сужается, но не устраняется полностью — это честно отражено в логах (`bounded by claim TTL`); устранить окно целиком можно только транзакцией hub↔backend, которой нет.

**M-f — маршрут.** Поведенческое покрытие `settleCompletedTask` — в `gpu-queue-idempotency.test.js` (живой ref / repair / пере-mapping). Вызов в `generation-routes.cjs` покрыт структурной ассерцией (источник содержит `qidem.settleCompletedTask(redis, {` и не содержит слепой последовательности): полный behavioral-тег regenerate-хендлера потребовал бы живой PG-транзакции, недоступной в санкционированной матрице (PG-песочница).

---

## 2. Матрица тестов (против baseline Stage 118/119)

| Прогон | Baseline | Stage 120 | Вердикт |
|---|---|---|---|
| Целевые (`gpu-queue-idempotency` + `gpu-audio-dispatch-deferral` + `gpu-lane-release-order` + `gpu-orphan-completed-marker`) | 52/0 | **75/0** (+23 новых: 15 + 7 + 1) | PASS |
| Полный backend-suite (`npx mocha --exit 'tests/**/*.test.js'`) | 2673 теста / 2642 pass / 28 pending / **85 fail** (env) | 2696 / **2665** / 28 / **85** | PASS — fail-набор **идентичен** (diff: 0 новых, 0 пропавших; сравнение по fullTitle) |
| Архитектурные (`npm run test:arch`) | 935/24/0 | **935/24/0** | PASS |
| Пакет `packages/animastor-orchestration` `npm test` | 35/0 | **35/0** (не менялся) | PASS |
| `bash scripts/syntax-smoke.sh backend` | OK | **OK** (все production JS/CJS) | PASS |

**Доказательства (перезапуск на фиксированном дереве, `/tmp/opencode/stage120/`):**
* `proof-p10.js` — 9/12: все 3 стадийных регенерации PASS (audio/video/image принимаются с первой попытки); 3 CONTROL-ноги теперь дают `duplicate_pending` — ожидаемо: после `markDirtyScene` ре-диспатч уже принял идентичность, повторный ручной сброс пина даёт тот же epoch ⇒ та же идентичность ⇒ легитимный дубль-деферал (и попутное подтверждение F2-семантики).
* `proof-p11.js` — 7/8: единственный «провал» — P11.7 (`cleared:true` при отказе хаба) — это **сам** M-a (скрипт фиксирует старое поведение).
* `proof-p12.js` — 5/5 (F2-сценарий).

**Известные флаки:** `tests/architecture/phase4-book-model.test.js` T6 (2-секундный таймаут) — известный флаки; в этом прогоне **прошёл** (arch 935/24/0 без падений).

**85 env-падений:** все — `ECONNREFUSED 127.0.0.1:1` (PG/Redis по дизайну офлайн в песочнице), включая `after all`-хуки PG-teardown в `image-ghost-no-jobs-sent.test.js`; набор байт-в-байт совпадает со stage118.failures.txt. Новые тесты Stage 120 не оставляют ни одного падения/хука — `gpu-orphan-completed-marker.test.js` вообще не трогает PG и не имеет teardown-хуков.

---

## 3. Изменённые файлы (коммит `78bbfe18`, 13 файлов, +1129/−12)

Production (9): `src/helpers/queue-idempotency.cjs` (F1 resetJobEpochForStage, F2 state+Lua refresh, M-c releaseTaskDone, M-f settleCompletedTask + экспорты), `src/state/scene-state-ops.js` (F1), `src/image/iu-processor.js` (M-c ветка), `src/routes/book/cache-routes.cjs` (M-a тело + M-b sweep), `src/services/book-deletion.cjs` (M-b sweep), `src/routes/book/generation-routes.cjs` (M-b sweep через hubCancel-порт), `src/routes/generation-routes.cjs` (M-f settleCompletedTask), `src/runtime/gpu-dispatcher.js` (M-e RETRYABLE_4XX + break), `src/helpers/redis-helpers.cjs` (M-d).

Тесты (4): `tests/gpu-queue-idempotency.test.js` (блок «Stage 120», 15 кейсов), `tests/gpu-lane-release-order.test.js` (+7 кейсов M-a/M-b), `tests/gpu-orphan-completed-marker.test.js` (новый, M-c интеграция), `tests/mocks/redis-mock.js` (ветка `eval` для REFRESH_CLAIM_TTL_SCRIPT).

## 4. Границы — соблюдение

Не выполнялось и не тронуто: push, CI, GHCR, deploy, `npm publish`, версии/зависимости/lockfiles, remote refs, `.env`/Compose/hooks, production Redis/PG/Hub, очереди 457/438, чужие dirty-файлы (` D backend/scripts/audit-orphan-books.js`; ` M` `ai-endpoint-sharing`/`ai-shared-inference`/`architecture/installer-package-boundary`/`architecture/phase5-runtime-result`; `?? deploy/`; `?? freebuff-chat-*.md`) — в коммит не вошли и не изменялись. Коммит создан только после полного прохождения матрицы. Транспорт-биндинг production-процесса в тестах не разворачивался (`generation-test-bindings.cjs` оставлен в исходном виде).
