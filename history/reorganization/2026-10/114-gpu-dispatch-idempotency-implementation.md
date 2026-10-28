# Stage 114 — GPU dispatch idempotency: local implementation and tests

**Дата:** 2026-10-22, окно **03:12Z → 04:25Z**.
**Репозиторий:** `animastor-backend` (локальный коммит, **без публикации**).
**Исходный HEAD:** `53ce504536c14413c2c5e7b8546d529db8ee2530`
**HEAD после этапа:** `8b375dc0d0efe32b4ff5381399270957340a3d85` (локально; `origin/main` и `github/main` остались на `53ce5045` — **push не выполнялся**).
**Итог: PASS** — патч реализован локально, 22 новых изолированных теста зелёные, полный backend-suite без единой новой регрессии, production не затронут.

---

## 0. Краткая сводка

| Что | Результат |
|---|---|
| Причина дубликатов подтверждена кодом и тестами | ✅ 4 формата dedup-ключей разобраны; 3 из 4 не работали по конкретным причинам |
| Устойчивая идемпотентность реализована | ✅ `idem_key = sha256(workspace│job│type│build│sha256(canonical(params))│generation_epoch)`; атомарный claim `SET NX`; `dispatch_id` исключён |
| `generation_epoch` двигается только при обоснованном retry / явной регенерации | ✅ `markDirtyScene` (регенерация) и путь ошибки воркера (израсходованный failure); **не** при re-dispatch/recovery |
| Гейт исполнителя | ✅ задача не отправляется без живого совместимого воркера; возвращается `{sent:false, reason:'no_worker_available', retryable:true}`, запись в очередь не создаётся |
| Тесты | ✅ 22/22 новых; полный suite: baseline 2590 pass / 85 fail → patched **2612 pass / 85 fail**, множество падений **идентично** (0 регрессий); архитектурные 935/0; orchestration-пакет 19/0; syntax-smoke OK |
| Production | ✅ не изменён: Redis `dbsize` 321, ws-lane 457, глобальная lane 8, 0 heartbeat, **0 ключей `animastor:idempotency:*`**; PG `scene_assets` 459/437, `generation_tasks` 17; sha инвентарей `data/**` те же; контейнеры `StartedAt`/`RestartCount` те же; чужие dirty-файлы и другие репозитории не тронуты |

---

# 1. Разбор исходников: четыре формата dedup-ключей

Проверено по коду (не по отчёту Stage 113) — каждое утверждение подтверждено строкой и экспериментом.

| # | Ключ | Кто пишет | Где используется | Почему не работает | Статус после Stage 114 |
|---|---|---|---|---|---|
| 1 | `animastor:job:{dispatch_id}:{job_id}` | **GPU Hub** | `gpu-hub.js:423-425` (`jobDedupKey`), `SET NX EX 3600` в `POST /task` (`:829-847`) | **Ключ содержит `dispatch_id`** — тот самый идентификатор, который меняется при каждом re-dispatch ⇒ дедуп физически не может подавить re-dispatch | **оставлен как есть** (hub не менялся); подавление перенесено на backend-side claim |
| 2 | `animastor:iu-in-flight:{book}_{ch}_{sc}_{unit}` (TTL **1200 с**) | backend | `image/iu-processor.js:43-88` (`checkInFlightMarker`), `:267` | Guard «жив» только если владелец == текущий `dispatch_id` **или** == активный dispatch из `dispatch-meta`. Graceful-shutdown **удаляет `dispatch-meta`** ⇒ маркер всегда признаётся stale ⇒ guard не защищает | **не изменён** (устранён корневой эффект: re-dispatch теперь подавляется claim'ом) |
| 3 | `animastor:job:{iu}:iu_image` / `animastor:job:{iu}:image` | backend («DEDUP-CLEAR») | `image/iu-processor.js:206-213` (было) | **Legacy-формат, который hub никогда не пишет** ⇒ `del` был **no-op**; «dedup-clear» не освобождал ничего | **ИСПРАВЛЕНО**: ключ перестроен из реального формата hub'а (`animastor:job:{dispatch_id}:{job_id}`) |
| 4 | `animastor:result-processed:{dispatch_id}:{job_id}:{build_id}` | backend | `routes/generation-routes.cjs:490` | **Dispatch-scoped** ⇒ повторная доставка результата из другого dispatch'а **не дедуплицировалась** | **ИСПРАВЛЕНО**: `animastor:result-processed:{job_id}:{build_id}` (dispatch-независимый) |
| 4b | `animastor:result-processed:{iu}:iu_image:{build}` | backend («DEDUP-CLEAR-BACKEND») | `image/iu-processor.js:275, 307` | Тот же legacy-разрыв ⇒ clear был **no-op** относительно ключа, который писал маршрут | **СЛЧИТАЛОСЬ** автоматически: после (4) формат маршрута совпадает с форматом clear'а |

**Цепочка дефекта (подтверждена кодом):**
`backend.cjs:983-1003` (SIGTERM → `cancelActiveDispatch('graceful_shutdown')`) → `dispatch-engine.finalizeDispatch(outcome='cancelled')` (Lua `claimFinalization` **удаляет lease и `dispatch-meta`**) → следующий старт: `reconciliation-engine:1196-1244` → `getDispatchEvidence()` не находит ни lease, ни meta, ни in-flight ⇒ `GENERATING→DIRTY→PENDING` ⇒ scheduler диспетчеризует заново с **новым** `dispatch_id` ⇒ guard (2) протух (cancel снёс meta) ⇒ hub-dedup (1) не срабатывает ⇒ **дубликат в lane'е**.

**Экспериментальное подтверждение** (Stage 113, воспроизведено на реальном `gpu-hub.js`): 50 re-dispatch'ей с разными `dispatch_id` ⇒ **50 записей** в lane. Ниже в этом этапе тот же сценарий закрыт тестом регрессии.

---

# 2. Реализация

## 2.1 Новый модуль `backend/src/helpers/queue-idempotency.cjs` (375 строк)

Размещение выбрано по архитектурным guard'ам репозитория: `backend/src/runtime/` закрыт гейтом «PM-G2 — ровно 4 классифицированных host-stay» (`physical-move-gate.test.js`), а `routes/generation-routes.cjs` не может получить новый **относительный** require (замороженное множество require-ов contour-маршрутов, `phase6-editor-player.test.js`). Поэтому модуль лежит в `helpers/`, а маршрут получает его **инъекцией** из композиционного корня.

**Идентичность задачи:**

```
idem_key = sha256( workspace_id │ job_id │ job_type │ build_id
                   │ sha256(canonicalJson(params)) │ generation_epoch )
```

| Поле | Источник | Проверка на представление во всех путях вызова |
|---|---|---|
| `workspace_id` | `gpu-dispatcher.sendUnified` — **серверный** (`resolveWorkspaceForBook` → `books.workspace_id`), `null` для system pool | `null` нормализован в `''`; клиентское значение перезатирается (`policy_id`/`workspace_id` в payload всегда backend-authored) |
| `job_id` | `jobSchema.parseJobId` — 4 грамматики (`audio_chunk`, `iu_image`, `scene_image`, `scene_video`) | всегда строка; `parseJobId` возвращает `null` для мусора ⇒ `sendUnified` бросает ошибку до enqueue |
| `job_type` | `mediaRegistry.hasMediaType` проверяется до enqueue | всегда из реестра |
| `build_id` | `taskSpec.build_id \|\| 'default'` ⇒ **никогда не null** | проверено в коде диспетчера |
| `params` | `workflow` из 4 вызывающих путей (`image/iu-processor.js:293`, `audio/generation.js:329,506`, `scene-orchestrator.js:556`) → `comfyui-provider.generate` → `sendUnified` | передаётся **verbatim** (`S-3 payload preservation`); канонизация — рекурсивная сортировка ключей, порядок массивов сохраняется |
| `generation_epoch` | `animastor:idempotency:stage-epoch:{book}:{ch}:{sc}:{stage}` | целое ≥ 0; по умолчанию 0 |

**Значимые параметры не теряются:** `canonicalJson` обходит **всё** дерево `params` (включая вложенные `inputs`, `clip`, `latent_image`, `model`, `seed`, текст промпта). Проверено тестом: отличие seed / промпта / модели ⇒ разные `input_version`; перестановка ключей ⇒ **тот же** хэш.

**Эпоха генерации:**

| Событие | Двигает эпоху? | Где |
|---|---|---|
| Обычный re-dispatch (graceful shutdown → reconciliation → новый `dispatch_id`) | **НЕТ** | эпоха не меняется ⇒ claim подавляет повтор |
| Восстановление после рестарта (reconciliation без cancel) | **НЕТ** | там же |
| Израсходованный failure (воркер сообщил ошибку) | **ДА** | `routes/generation-routes.cjs` (`/gpu/task/error`) → `bumpStageEpoch` |
| Явная регенерация (сцена/юнит помечены DIRTY) | **ДА** | `state/scene-state-ops.js` `markDirtyScene`; `image/iu-processor.js` (dirty-unit regen) |

`markDirtyScene` **не** используется путём reconciliation-отката (`orchestrator.rollbackStageToPending` пишет FSM напрямую) ⇒ рестарт-восстановление эпоху не двигает. Проверено чтением кода.

**Атомарность:** claim — один `SET animastor:idempotency:claim:{idem_key} 1 NX EX`; конкурентные dispatch'и ⇒ ровно один победитель (тест: 25 параллельных claim ⇒ 1 успех). Эпоха **замораживается на dispatch** (`animastor:idempotency:dispatch-epoch:{dispatch_id}`, `SET NX` + `GET` сходимости) ⇒ все 9-10 IU одного dispatch'а получают одну идентичность, даже если эпоха изменилась посреди dispatch'а.

**Завершение ≠ новая запись в очереди:** маркер `animastor:idempotency:done:{idem_key}` ставится **только** после принятия реального результата (`/gpu/task/result` → `handleTaskResult` OK). Наличие записи в lane'е никогда не считается доказательством выполнения. Фактический артефакт на диске остаётся авторитетной проверкой «сделано ли» (`probeIUImage` для image, `isGroupFileValid` для video).

## 2.2 `backend/src/runtime/gpu-dispatcher.js` (+103)

1. `setRedis(client)` / `getRedis()` — Redis-клиент регистрируется композиционным корнем (`backend.cjs`), второй коннект не открывается.
2. **Гейт исполнителя** — до расчёта claim'а:
   * lane `private` ⇒ нужен **живой** private-воркер этого workspace и этого типа;
   * lane `system` ⇒ нужен живой system/share-воркер этого типа;
   * lane `policy` ⇒ живой private-воркер владельца policy (`owner_workspace_id` теперь возвращается `worker-repo.findGrantPolicyForRouting`).
   Нет исполнителя ⇒ `{ sent:false, reason:'no_worker_available', retryable:true }` и **никакой записи в очередь**.
   *Живость* читается из hub-authored heartbeat-ключей `animastor:worker:heartbeat:{type}:{id}` (TTL 30 с) — **не** из `workers.status`.
3. **Claim перед enqueue** — `guardEnqueue()`; при `duplicate_pending` / `already_completed` ⇒ `{sent:false, reason, suppressed:true}` и **без** POST'а в hub.
4. `rememberTaskRef(job_id → idem_key)` — чтобы callback результата нашёл идентичность.
5. Упавший POST ⇒ claim **освобождается** (иначе задача была бы заблокирована навсегда).
6. Счётчики: `jobs_gated_no_worker`, `jobs_suppressed_duplicate`.

**Маршрутизация (выбор lane'а) оставлена registration-based, и это осознанное решение:** lane определяет, ЧЬИ задачи и кто их исполнит (изоляция workspace). Если выбирать lane по живости, задача workspace'а с временно упавшим private-воркером уехала бы в **общий** пул и там «залипла» (его умеет читать только system-воркер). Проверка живости поставлена в точку **отправки** — там, где по смыслу «не отправлять без живого исполнителя». Это удовлетворяет намерению требования («не отправлять только потому, что worker зарегистрирован») без побочного эффекта «strand».

## 2.3 `backend/src/routes/generation-routes.cjs` (+52)

* Результат: dedup-ключ теперь `animastor:result-processed:{job_id}:{build_id}` (dispatch-независимый) ⇒ повторная доставка результата из любого dispatch'а дедуплицируется.
* Результат: после принятия результата — `markTaskDone` + `releaseTask` + `forgetTaskRef`.
* Ошибка: `releaseTask` + `forgetTaskRef` + `bumpStageEpoch` (обоснованный retry).
* Модуль **не** требуется маршрутом: `queueIdempotency` приходит через `deps` (инъекция из `backend.cjs`) ⇒ замороженное множество require-ов contour-маршрутов не нарушено.

## 2.4 `backend/src/image/iu-processor.js` (+43)

* «DEDUP-CLEAR» теперь использует **реальный** ключ hub'а: `animastor:job:{dispatch_id}:{job_id}` (раньше — legacy-формат ⇒ no-op).
* Явная регенерация dirty-юнита дополнительно двигает эпоху стадии.
* Причина `enqueue_failed` заменена на явную (`no_worker_available` / `duplicate_pending`) + `retryable`.

## 2.5 `backend/src/state/scene-state-ops.js` (+25)

`markDirtyScene` (канонический писатель DIRTY = «запрошена новая работа») двигает эпоху генерации для стадий `audio|image|video`.

## 2.6 `backend/src/backend.cjs` (+12)

* `gpuDispatcher.setRedis(redis)` — единый клиент.
* `queueIdempotency` в deps маршрута генерации.

## 2.7 `backend/src/storage/postgres/repositories/worker-repo.js` (+1)

`findGrantPolicyForRouting` теперь отдаёт `owner_workspace_id` (аддитивно) — нужен для проверки живости policy-lane.

## 2.8 `backend/tests/architecture/redis-registry.js` (+15)

Зарегистрировано новое семейство `animastor:idempotency:*` (owner: backend, readers/writers: backend). Выбрано отдельное пространство имён, чтобы **не** пересекаться с hub-owned семействами `animastor:job:*` и `animastor:queue:*` (иначе backend-writes были бы cross-owner).

---

# 3. Что НЕ менялось (осознанно)

| Что | Почему |
|---|---|
| `animastor-gpu-hub` (репозиторий hub'а) | Атомарность достигается на backend-side claim'е (`SET NX` в том же Redis). Hub не трогаем ⇒ **нет изменений формата очереди и нет миграции**; hub-side dedup остаётся вторым эшелоном |
| `workers.status` в PostgreSQL | Колонка нигде не обновляется (только DEFAULT `'offline'`); живость берётся из Redis-heartbeat. Менять колонку = делать её источником истины ⇒ отдельный анализ совместимости и потребителей (вне рамок этапа) |
| Очередь (457 записей) | Очистка дублей — отдельный этап с approval (Stage 113 §B.6). Ни одна запись не удалена/изменена |
| `packages/animastor-orchestration` | Пакет публикуется отдельно (`@animastor/orchestration@0.1.4`); правка пакета без переиздания не попала бы в образ ⇒ вся логика реализована в host-слое (`backend/src`) |
| Пакет `@animastor/contracts` / job-id грамматика | Формат `job_id` не менялся (frozen protocol) |
| Статус задач/сцен, leases, данные | Не трогались |

---

# 4. Тесты

## 4.1 Новый набор `backend/tests/gpu-queue-idempotency.test.js` — 22/22 PASS

Изолированная среда: in-memory Redis double (`FakeRedis`), заглушки PG-слоя маршрутизации через `proxyquire`, перехват `global.fetch`. **Ни production Redis/PG, ни hub, ни сеть.**

| # | Требование задания | Тест | Результат |
|---|---|---|---|
| 1 | Повторный dispatch с теми же параметрами и новым `dispatch_id` остаётся одной логической задачей | «a re-dispatch with a NEW dispatch_id stays ONE logical task» (3 dispatch'а → **1** POST) | ✅ |
| 2 | Одновременные dispatch не создают дубликаты | «concurrent dispatches create exactly one lane entry» (4 параллельных → 1 POST) + «concurrent claims: exactly one winner» (25 claim'ов → 1) | ✅ |
| 3 | Активный lease защищён | «an active (renewed) lease makes the dispatch engine skip» + «an expired lease is recognised as stale» (реальный `lease-manager`) | ✅ |
| 4 | Graceful shutdown → reconciliation → re-dispatch не создаёт дубликатов | «graceful shutdown → reconciliation → re-dispatch creates no duplicate» (dispatch до/после cancel → **1** POST) | ✅ |
| 5 | Обоснованный retry с новым `generation_epoch` разрешён | «a justified retry with a new generation_epoch is allowed» (epoch bump → 2-й POST) | ✅ |
| 6 | Разные параметры, IU, модель, seed, версия не схлопываются | «different IU / seed / prompt / model are never collapsed» (6 задач → 6 POST) + «different params … input versions» | ✅ |
| 7 | Завершённая задача не ставится повторно без разрешённого retry | «a completed task is not re-queued without an allowed retry» (`already_completed`) | ✅ |
| 8 | Отсутствие живого совместимого worker блокирует enqueue | «the absence of a live compatible worker blocks the enqueue» (0 POST) + «a live worker of ANOTHER type…» + «a private worker of ANOTHER workspace…» + «a live PRIVATE worker of the workspace unblocks the ws lane» | ✅ |
| 9 | Истечение lease и crash/restart обрабатываются безопасно | «an expired lease is recognised as stale» + «a failed POST releases the claim (crash between claim and enqueue)» + «all jobs of one dispatch observe the SAME frozen epoch» | ✅ |
| 10 | Результаты worker и повторная доставка результата остаются идемпотентными | «a redelivered result is deduplicated independently of the dispatch_id» + «the identity of a job can be resolved back from its job_id» | ✅ |

## 4.2 Регрессионные прогоны

| Прогон | Baseline (без патча) | С патчем | Вывод |
|---|---|---|---|
| Новый набор | — | **22 pass / 0 fail** | ✅ |
| Полный backend-suite (`tests/**/*.test.js`, PG/Redis **заблокированы** на `127.0.0.1:1`) | 2590 pass / 28 pending / **85 fail** | **2612 pass** / 28 pending / **85 fail** | +22 (ровно мои тесты); **множество падений идентично** (307 записей в обоих прогонах, `comm` → 0 новых) ⇒ **0 регрессий** |
| Архитектурные (`tests/architecture/*.test.js`) | 934 pass / 1 fail (`phase4-book-model` — флакующий таймаут, воспроизводится и на baseline) | **935 pass / 0 fail** | ✅ (тот флакующий тест прошёл в этом прогоне; при повторных прогонах он флакует и на baseline — т.е. к патчу отношения не имеет) |
| `packages/animastor-orchestration` (`npm test`) | 19 pass | **19 pass / 0 fail** | ✅ (пакет не менялся) |
| Syntax smoke (`scripts/syntax-smoke.sh backend`) | OK | **All production JS/CJS files pass syntax check** | ✅ |

**Почему тесты гонялись с заблокированными PG/Redis:** PostgreSQL production опубликован на `0.0.0.0:5432` ⇒ локальный прогон тестов, касающихся БД, **создал бы записи в production**. Поэтому все прогоны выполнялись с `PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1` — БД-зависимые тесты падают по соединению (это и есть baseline), но **физически не могут** дойти до production. Изменённые/добавленные файлы моего патча БД не касаются; Redis-касание — только in-memory double.

## 4.3 Проверенные и найденные архитектурные нарушения (исправлены)

Первый вариант патча нарушал три guard'а репозитория — все обнаружены прогоном и **исправлены до коммита**:

| Нарушение | Исправление |
|---|---|
| `PM-G2: backend/src/runtime` должен содержать ровно 4 host-stay файла | модуль перенесён в `backend/src/helpers/queue-idempotency.cjs` |
| `relative require sets of the contour routes stay frozen` / `T6: contour routes do not gain new implementation-detail deps` | маршрут не добавляет require — порт инъецируется через `deps` из `backend.cjs` |
| `every animastor:* key literal … belongs to a registered family` | семейство `animastor:idempotency:*` зарегистрировано в `tests/architecture/redis-registry.js` (owner: backend) |

---

# 5. Проверка отсутствия production-изменений

| Объект | Состояние до | Состояние после | Статус |
|---|---|---|---|
| Redis `dbsize` | 321 | **321** | ✅ |
| ws-lane `queue:image:ws:3317e019…` | 457 | **457** | ✅ |
| глобальная lane `queue:image` | 8 | **8** | ✅ |
| `animastor:worker:heartbeat:*` | 0 | **0** | ✅ |
| `animastor:idempotency:*` (новое) | — | **0** (код в production не попадал) | ✅ |
| `GET /gpu/health` | `gpus:0, queues.image:8, ws:457, running:0` | **идентично** | ✅ |
| PG `scene_assets` | 459 (437 NULL) | **459 (437 NULL)** | ✅ |
| PG `generation_tasks` | 17 | **17** | ✅ |
| `data/books` inventory sha | `200beb1a…` | **`200beb1a…`** | ✅ |
| `data/output` inventory sha | `2a03a8c7…` | **`2a03a8c7…`** | ✅ |
| Контейнеры `StartedAt` / `RestartCount` | backend `2026-10-21T13:15:38.819Z`/0, gpu-hub `2026-10-12T13:41:43Z`/0, pg/redis `2026-08-24T16:30:12Z`/0, proxy `2026-10-19T06:18:24Z`/0 | **идентично** | ✅ |
| Git refs | `origin/main` = `github/main` = `53ce5045` | **без изменений** (push не выполнялся) | ✅ |
| Чужие dirty-файлы | `D backend/scripts/audit-orphan-books.js`, 4 `M` в `backend/tests/**`, `?? deploy/`, `?? freebuff-chat-*.md` | **те же, не тронуты** | ✅ |
| Другие репозитории | gpu-hub / worker / web — чисто | **чисто** | ✅ |
| Генерация | не запускалась | **не запускалась** | ✅ |

**Изоляция тестов:** production-PG опубликован на `0.0.0.0:5432` (это production-контейнер `animastor-pg`), production-Redis на хост не опубликован. Все прогоны выполнялись с `PG_*`/`REDIS_*`, уведёнными на `127.0.0.1:1`, а мои тесты используют in-memory double ⇒ **записи в production невозможны**.

---

# 6. Коммит

```
8b375dc0d0efe32b4ff5381399270957340a3d85
fix(gpu-queue): make GPU dispatch idempotent across re-dispatch/restart (stage 114)
```

| Файл | Строк |
|---|---|
| `backend/src/helpers/queue-idempotency.cjs` (новый) | +375 |
| `backend/tests/gpu-queue-idempotency.test.js` (новый) | +593 |
| `backend/src/runtime/gpu-dispatcher.js` | +103 / −15 |
| `backend/src/routes/generation-routes.cjs` | +52 / −15 |
| `backend/src/image/iu-processor.js` | +43 / −13 |
| `backend/src/state/scene-state-ops.js` | +25 |
| `backend/src/backend.cjs` | +12 / −5 |
| `backend/tests/architecture/redis-registry.js` | +15 |
| `backend/src/storage/postgres/repositories/worker-repo.js` | +1 / −1 |

Итого: **9 файлов, +1205 / −15**. В коммит вошли **только** мои файлы (`git add` по явным путям); чужие изменения остались в рабочем дереве.

---

# 7. Ограничения и известные нюансы

1. **Патч не задеплоен.** Без публикации и деплоя поведение production не изменилось; 438 накопленных дублей **остаются** (очистка — отдельный этап, Stage 113 §B.6).
2. **Формат очереди не менялся**, миграций не требуется ⇒ скрытых миграций нет.
3. **Эпоха — на стадию, а не на IU.** Регенерация одного юнита двигает эпоху всей стадии ⇒ при следующем dispatch'е стадии новую идентичность получают все её юниты (неизменённые отсекаются проверкой артефакта на диске — `probeIUImage`). Более тонкая гранулярность потребовала бы per-IU эпохи и расширения публичного контракта epoch'а.
4. **Claim живёт до терминального состояния** (24 ч — backstop TTL). Если backend упал до получения результата/ошибки, claim остаётся до истечения TTL — блокирующая повторную постановку, но **не** приводящая к потере работы (задача остаётся в lane'е).
5. **TTL done-маркера — 7 суток**; после истечения задача с готовым артефактом может быть поставлена снова, но backend отсечёт её проверкой артефакта на диске.
6. **`workers.status` не трогали** — как требовалось; живость определяется по Redis-heartbeat. Синхронизация `status` в PG остаётся отдельной задачей (нужен анализ потребителей колонки).
7. **Policy-lane** проверяется по `owner_workspace_id`; если владелец неизвестен — проверка пермиссивная (lane достижим только через явный grant).
8. **`phase4-book-model.test.js` флакует** (2-секундный таймаут) — воспроизводится и на baseline, к патчу отношения не имеет.
9. **GPU Hub не изменялся** ⇒ его собственный dedup (`job_id+dispatch_id`) остаётся, но он больше не является единственной защитой; совместимость со старым backend (без claim'а) сохраняется — новые ключи просто не создаются.
10. **Локальная среда**: `backend/node_modules/@animastor/orchestration` — установленная копия (0.1.4), идентичная `packages/animastor-orchestration/src`; пакет не менялся, расхождений нет.

---

# 8. Рекомендуемый порядок следующих этапов

| Этап | Содержание | Гейт |
|---|---|---|
| **115** | Ревью патча + решение по `workers.status` (с анализом потребителей) | согласие владельца |
| **116** | Публикация пакета `@animastor/orchestration` — **не требуется** для этого патча (изменений пакета нет) ⇒ можно сразу переходить к сборке образа | — |
| **117** | Push/CI/GHCR/deploy по обычному гейту + наблюдение ≥ 1 graceful-рестарта backend'а | очередь **457 → 457** (не растёт) — прямой критерий |
| **118** | Отдельная очистка 438 дублей (по процедуре Stage 113 §B.6: dry-run → журнал → точечный `LREM` → rollback) | требует approval; выполнять **после** 117 |
| **119** | Восстановление workers (Stage 113 §A.5, 10 шагов) | `gpus ≥ 1`, heartbeat живой, очередь убывает |
| **120** | Отдельно: Stage 75 batch C (архив + удаление 4 dead-path строк `scene_assets`) и `schema.js:1211` (вариант B) | решения владельца |

---

# 9. Классификация

| Пункт | Класс | Доказательство |
|---|---|---|
| 4 формата dedup-ключей разобраны; 3 из 4 не работали | **CONFIRMED** | §1 (строки кода) + воспроизведение дефекта (Stage 113: 50 → 50) |
| Устойчивый `idem_key` (без `dispatch_id`) реализован | **CONFIRMED** | `helpers/queue-idempotency.cjs` + тесты (22/22) |
| `generation_epoch` двигается только при обоснованном retry / явной регенерации | **CONFIRMED** | `markDirtyScene` (+dirty-unit regen) и `/gpu/task/error`; reconciliation-откат эпоху не двигает (проверено по коду) |
| Атомарный dedup при конкурентных dispatch | **CONFIRMED** | `SET NX` + тесты (25 claim'ов → 1; 4 dispatch'а → 1 POST) |
| Разные IU / params / модель / seed / версия не схлопываются | **CONFIRMED** | тесты (6 задач → 6 POST; разные `input_version`) |
| Завершение фиксируется по факту результата, не по записи в очереди | **CONFIRMED** | `markTaskDone` только после `handleTaskResult` OK; артефакт на диске остаётся авторитетом |
| Гейт исполнителя (живость + совместимость типа) | **CONFIRMED** | `hasLiveExecutorForLane` + 4 теста (private/system/policy, чужой тип, чужой workspace) |
| `workers.status` не сделан источником истины | **CONFIRMED** (требование соблюдено) | колонка не изменялась; живость — из heartbeat |
| Регрессий в репозитории нет | **CONFIRMED** | baseline vs patched: идентичное множество падений; +22 (мои тесты); архитектура 935/0; пакет 19/0; syntax OK |
| Production не изменён | **CONFIRMED** | §5 (Redis/PG/инвентари/контейнеры/refs/чужие файлы) |
| Формат очереди/миграции не потребовались | **CONFIRMED** | новые ключи — отдельное семейство `animastor:idempotency:*`; hub не менялся |
| 438 накопленных дублей | **PRE-EXISTING** (не чистились — вне рамок этапа) | очередь 457 без изменений |
| `workers.status` как источник истины | **INCONCLUSIVE** (требует отдельного анализа потребителей) | колонка не обновляется кодом; потребители не разобраны |
| Тонкая (per-IU) гранулярность эпохи | **INCONCLUSIVE** (не реализовано сознательно) | §7 п.3 |
| Деплой/наблюдение в production | **NEEDS ACTION** | §8 (этапы 117-119) |
