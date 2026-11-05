# Разведка для новой оркестрации генерации (ORCHESTRATION_V2_RECON)

Дата: 2026-11-05. Тип: разведка, только чтение кода (изменений в коде и на проде нет). Документ фиксирует текущее устройство оркестрации генерации по коду; предложений по архитектуре не содержит.

## Версии кода

| Репозиторий | Коммит (main) | Дата коммита | Префикс в ссылках |
|---|---|---|---|
| animastor-backend | `34634ca` | 2026-11-05 | `backend/src/…`, `packages/…` (пакет оркестрации — `packages/animastor-orchestration/src/…`, сокращение `orch:`) |
| animastor-gpu-hub | `c9aa24f` | 2026-11-04 | `hub:` |
| animastor-worker | `c34c4ea` | 2026-11-04 | `worker:` = `packages/animastor-worker/worker/` |
| animastor-web | `d9cb135` | 2026-11-05 | `web:` |
| animastor-android | `be1233c` | 2026-11-05 | `and:` = `frontends/android/app/src/main/java/com/example/animastor/` |

Каждая ссылка `файл:строка` указывает на строку в этих коммитах. Пакет `@animastor/orchestration` лежит в `packages/animastor-orchestration` в корне репо backend (а не в `backend/packages`).

## Сводка

| Что | Сколько | Раздел |
|---|---|---|
| HTTP-эндпоинтов backend, связанных с генерацией | 37 (из 136 регистраций `app.get/post/put/delete/patch` во всех routes) | 1 |
| Фоновых периодических циклов backend | 8 (генерационных — 4: tick 5 с, reconcile 60 с, lease renewal 30 с, GPU retry); startup-хуков — 6; Redis-подписок — 1 | 2 |
| Генерационных таблиц PG / мест записи | 16 / 78 | 3 |
| Семейств Redis-ключей `animastor:*` в backend и пакете | 108 (5 нет в реестре, 14 есть только в реестре) | 4 |
| Эндпоинтов хаба в цепочке генерации | 6 (+ цикл 10 с) | 5 |
| Классифицированных файлов backend/src | 99 (A 41, B 41, C 17) | 10 |

## Содержание

1. Входы backend (HTTP)
2. Фоновые процессы и таймеры
3. Postgres: схема и места записи
4. Redis-ключи backend
5. GPU-хаб
6. Воркер
7. Фронты
8. Файлы в data/output
9. Пользователи
10. Классификация файлов backend/src
11. Странности (общий раздел)
12. Выборочная проверка ссылок

## 1. Входы backend (HTTP)

Все HTTP-эндпоинты backend, которые запускают, отменяют или меняют генерацию либо читают её состояние. Префикс путей — относительно корня репо animastor-backend, например `backend/src/routes/generation-routes.cjs:103` = `/home/animastor/src/animastor-backend/backend/src/routes/generation-routes.cjs:103`.

Всего регистраций `app.get/post/put/delete/patch(` по всем routes-файлам: **136** (посчитано `grep -rc "app\.\(get\|post\|put\|delete\|patch\)(" backend/src/routes/`). Из них в раздел 1 попадает **37** эндпоинтов (см. таблицу ниже).

### 1.1 Таблица эндпоинтов

| # | Метод + путь | Регистрация (файл:строка) | Параметры тела / query | Что вызывает дальше (1–2 уровня) | Что пишет (PG / Redis / файл / хаб) |
|---|---|---|---|---|---|
| 1 | POST `/api/v1/generate` (полная книга) | `backend/src/routes/generation-routes.cjs:103` | multipart `file`; тело `audio_enabled`, `image_enabled`, `video_enabled` | `book.extractBookBundle`, `book.buildBookFromBundle` (routes/generation-routes.cjs); `authContextMiddleware.importBookAllowed` (middleware/auth-context); `generationCancelRepo.clear` (repos/generation-cancel-repo); `genScope.setScope`; `layerConfig.set`; `@animastor/orchestration`.runtime.sceneWindow.slideWindow / initSceneWindow | PG: прямой записи нет (книга — файлы на диске); Redis: `genScope` ключ, `layerConfig` hash, `BOOK_SCENE_TOTAL/NEXT`, chunks; хаб: нет (прямое окно сцен) |
| 2 | GET `/api/v1/worker/status` | `backend/src/routes/generation-routes.cjs:255` | — | `@animastor/orchestration`.runtime.workerHealth.getStatus(redis) | Читает Redis (heartbeat-ключи воркеров); ничего не пишет |
| 3 | GET `/api/v1/worker/counts` | `backend/src/routes/generation-routes.cjs:265` | — | `workerHealth.getAvailability(redis, workspaceId)`; `redis.scard('animastor:active-scenes')`; `aiService.checkAIHealth`; `sessionControl.getActiveSessionCount()` | Читает Redis + PG (agent сессии через AgentSessionControl); ничего не пишет |
| 4 | GET `/api/v1/book/:bookId/progress-stream` (SSE) | `backend/src/routes/generation-routes.cjs:372` | path `bookId` | `progress-pubsub.cjs` — `progressChannel(bookId)`, `sub.subscribe(ch)`; `setInterval` heartbeat 15s | Читает Redis pubsub-канал прогресса; ничего не пишет (только отдаёт SSE клиенту) |
| 5 | POST `/gpu/task/result` | `backend/src/routes/generation-routes.cjs:430` | `job_id`, `result_base64`, `build_id`, `dispatch_id`, `protocol_version`, `worker_id`, `workspace_id` | `job-schema.parseJobId`; `verifyCallbackWorkspace` (book-repo.getWorkspaceId); `persistTaskClaim` → `taskRepo.recordTaskClaim`; `@animastor/orchestration`.runtime.dispatch.verifyDispatchIdentity; `queueIdempotency.resultDedupKey` / `resolveDispatchFence`; `deps.taskHandler.handleTaskResult` | Redis: dedup key `animastor:result-processed:<job_id>:<build_id>` (TTL 3600), fence-маркеры, claim release; PG: task claim (worker_id/workspace_id); хаб: auth колбэка (x-api-key) |
| 6 | POST `/gpu/task/error` | `backend/src/routes/generation-routes.cjs:666` | `job_id`, `build_id`, `reason`, `dispatch_id`, `protocol_version`, `worker_id`, `workspace_id`, `error_class`, `comfy_status`, `error_code`, `hub_detail` | `job-schema.parseJobId`; `verifyCallbackWorkspace`; `persistTaskClaim`; `dispatchEngine.verifyDispatchIdentity`; `queueIdempotency` (readTaskRef/releaseTask/forgetTaskRef/bumpStageEpoch/resetJobEpoch); `gpuRetryPolicy.handleStageFailure` | Redis: `animastor:error-processed:<dispatch_id>:<job_id>:<build_id>` (TTL 60), idempotency claims, stage epoch bump; PG: task status (через handleStageFailure → task-repo); хаб: callback auth |
| 7 | POST `/api/v1/book/:bookId/generate-next` | `backend/src/routes/book/generation-routes.cjs:78` | path `bookId` | `book.loadBook`; `runtime.sceneWindow.slideWindow(redis, bookId, loadedBook, buildId)` | Redis: окно сцен (scene window), chunk-ключи; PG: нет |
| 8 | GET `/api/v1/book/:bookId/layer-config` | `backend/src/routes/book/generation-routes.cjs:102` | path `bookId` | `layerConfig.get(redis, bookId)` | Читает Redis (layer-config hash); ничего не пишет |
| 9 | PUT `/api/v1/book/:bookId/layer-config` | `backend/src/routes/book/generation-routes.cjs:131` | path `bookId`; тело `audio_enabled`, `image_enabled`, `video_enabled`, `chunk_size`, `audio_timeout_minutes`, `image_timeout_minutes`, `video_timeout_minutes`, `analysis_mode`, `analysis_parallelism` | `layerConfig.set(redis, bookId, {...})`; `mediaRegistry.listMediaTypes()`; `cancelStage` (deps.stageCancellation → services/stage-cancellation.cjs) для отключённых слоёв | Redis: layer-config hash; PG: нет (отмена слоёв через stage-cancellation пишет в PG/Redis/хаб — см. сервис) |
| 10 | POST `/api/v1/book/:bookId/cancel-worker` | `backend/src/routes/book/generation-routes.cjs:186` | path `bookId`; тело `type` (audio|image|video|cover|vbook) или `task_id` | `generationProgress.getTask` / `getActiveTasksByType` (services/generation-progress); `taskRepo.updateTaskStatus(..., 'cancelled')`; `sessionControl.cancelSessions` (vbook); `generationCancelRepo.setCancelled` (vbook); `dispatchEngine.clearLeasesForBookByStage` (cover); `cancelStage` (deps.stageCancellation) | Redis: `animastor:cancelled-workers:<bookId>` (vbook, TTL 3600); PG: task status → `cancelled`; generation_cancel tombstone (vbook); хаб: лизы/очереди через stage-cancellation |
| 11 | POST `/api/v1/book/:bookId/cancel-generation` (стоп всего) | `backend/src/routes/book/generation-routes.cjs:303` | path `bookId` | `runtime.sceneWindow.setCancelFlag`; `generationCancelRepo.setCancelled`; `runtime.scheduler.clearBookFromActiveIndex`; `dispatchEngine.clearAllLeasesForBook`; `dispatchEngine.repairOrphanGeneratingStates`; `deps.stageCancellation.clearCancelledSceneState`; `sceneAssetsRepo.cancelPendingAssets`; `taskRepo.cancelActiveTasksForBook`; `sessionControl.cancelSessions`; `fetch DELETE ${HUB_URL}/queue/clear?book_id=`; `queueIdempotency.releaseClaimsForBook`; `dispatchEngine.clearDeferralsForBook` | Redis: cancel-флаг сцены, `animastor:runtime:active-*`, все лизы книги, idempotency claims; PG: generation_cancel tombstone, scene_assets pending→cancelled, generation_tasks → cancelled; хаб: HTTP `DELETE /queue/clear?book_id=` |
| 12 | POST `/api/v1/book/:bookId/regenerate` | `backend/src/routes/book/generation-routes.cjs:468` | path `bookId`; тело `scope`, `chapter_id`, `scene_id`, `worker_types`, `rebuild_all`, `client_action`, `unit_id` | `book.loadBook`; `layerConfig.get`; `mediaRegistry.resolveValidWorkerTypes`; `bookDiff.filterDirtyScenesByScope`; `sceneAssetsRepo.ensureSceneRow` (INSERT … ON CONFLICT DO NOTHING); `orchestrator.resetScenes` (сервис); `queueIdempotency.releaseClaimsForScene`; `dispatchEngine.clearDeferralsForScene`; `@animastor/orchestration`.ports.hubCancel `hubCancelOp('clearHubDispatches')`; `sceneAssetsRepo.setDirtyUnitIds`; `generationProgress.removeSupersededTasks`; `generationProgress.createTasks`; `taskRepo.createTask` + `updateTaskStatus(..., 'running')`; `runtime.scheduler.addSceneToActiveIndex` | Redis: regenerate-lock `animastor:regenerate-lock:<bookId>` (TTL 120), cancel-флаг снимется; PG: `scenes` строки (ensureSceneRow), `generation_tasks` (createTask, status running), `scene_assets` dirty_unit_ids; хаб: clearHubDispatches (по dispatch id или book sweep) |
| 13 | POST `/api/v1/book/import` (единый импорт vbook/txt) | `backend/src/routes/book/import-routes.cjs:215` | multipart `file` | `book.extractBookBundle` / `book.buildBookFromBundle` (vbook); `txtImporter.decodeTxtBuffer` (txt); `resolveOwnedTxtDedup` (PG book_source + диск-скан); `placeholderAudio.ensureAllPlaceholderAudio`; `book.resetBook` + `book.saveBookBundle`; `setImmediate` placeholder-аудио | Redis: chunk-ключи (`animastor:chunk:<id>`), `BOOK_SCENE_TOTAL/NEXT`; Файл: книги на диск (data/books), sidecar placeholders; PG: book_source.registerSource (INSERT); хаб: нет |
| 14 | POST `/api/v1/book/load-vbook` | `backend/src/routes/book/import-routes.cjs:418` | multipart `file` | как п.13 (vbook-ветка единого импорта) | как п.13 |
| 15 | POST `/api/v1/book/:bookId/resume-bootstrap` | `backend/src/routes/book/import-routes.cjs:525` | path `bookId` | `lazyBook.loadDraftBook`; `agentSession.getActiveSessionForBook`; `txtImporter.bootstrapImportedText` | PG: book_generation_sessions (через agent session); Redis: нет |
| 16 | POST `/api/v1/book/import-txt` | `backend/src/routes/book/import-routes.cjs:574` | multipart `file` | как п.13 (txt-ветка) | как п.13 |
| 17 | POST `/api/v1/book/:bookId/bootstrap` | `backend/src/routes/book/import-routes.cjs:645` | path `bookId` | `txtImporter.bootstrapImportedText(bookId, null, publishVBook, redis)`; `genSessionRepo.markFirstWindowCompleted`; `saveChunk` для сцен первого окна; `placeholderAudio.ensureAllPlaceholderAudio` | PG: gen_session_repo (markFirstWindowCompleted); Redis: chunk-ключи, `BOOK_SCENE_TOTAL/NEXT`, progress pubsub; Файл: placeholders |
| 18 | POST `/api/v1/book/:bookId/bootstrap-next-window` | `backend/src/routes/book/import-routes.cjs:722` | path `bookId` | `txtImporter.bootstrapNextWindow(bookId, null, publishVBook, redis)` | Redis: progress pubsub, `BOOK_SCENE_TOTAL/NEXT`; Файл: placeholders |
| 19 | POST `/api/v1/book/:bookId/trigger-next-window` | `backend/src/routes/book/import-routes.cjs:738` | path `bookId`; тело `chapter_id`, `scene_id`, `unit_index`, `register_for_gpu` | `lazyBook.loadDraftBook`; `agentSession.getLatestSessionForBook`; `redis.sismember('trigger_dedup:<bookId>', …)` / `sadd` (TTL 86400); `redis.set('trigger_cooldown:<bookId>', …)` (60s); `txtImporter.bootstrapNextWindow` (setImmediate); `genSessionRepo.createSession`; `genSessionRepo.getSessionsByStatus` | Redis: `trigger_cooldown:<bookId>`, `trigger_dedup:<bookId>`; PG: gen sessions (createSession) |
| 20 | POST `/api/v1/book/:bookId/recover-placeholders` | `backend/src/routes/book/recovery-routes.cjs:20` | path `bookId`; тело `build_id` (default) | `placeholderAudio.recoverMissingPlaceholders(build_id, bookId)` | Файл: placeholder-аудио на диск; Redis: нет |
| 21 | GET `/api/v1/book/:bookId/generation-state` | `backend/src/routes/book/status-routes.cjs:11` | path `bookId` | `genSessionRepo.getGenerationState(bookId)`; `lazyBook.getBookStatus(bookId)` | Читает PG (gen sessions) + файлы книги; ничего не пишет |
| 22 | GET `/api/v1/book/:bookId/agent-status` | `backend/src/routes/book/agent-routes.cjs:63` | path `bookId` | `layerConfig.getChunkSize(redis, bookId)`; `agentSession.getLatestSessionForBook(bookId)`; `agentSession.getRunningStepType(session_id)` | Читает Redis (layer config) + PG (agent sessions/steps); ничего не пишет |
| 23 | GET `/api/v1/book/:bookId/progress-panel` | `backend/src/routes/book/progress-panel.cjs:405` | path `bookId` | `generationProgress.listTasks(redis, bookId)`; `state.getAssetStates`; `iuRepo.getImageUnitsForScene`; `computeIuReady` | Читает Redis (tasks, chunks, asset states) + PG (image units, scene assets); ничего не пишет |

### 1.2 Воркеры (Private Worker, Experimental Beta)

| # | Метод + путь | Регистрация | Назначение (генерационная связь) | Пишет |
|---|---|---|---|---|
| 24 | POST `/api/v1/worker/verify` | `backend/src/routes/worker-routes.cjs:174` | Подтверждение учётных данных воркера CLI (первый запуск) | PG: `workerRepo.touchLastSeen` (обновление last_seen) |
| 25 | POST `/api/v1/workers` | `backend/src/routes/worker-routes.cjs:204` | Создание воркера + разовая выдача учётных данных | PG: `workerRepo.createWorker` (строка workers); Redis: `workerAuth.mirrorPut` (зеркало токена) |
| 26 | GET `/api/v1/workers` | `backend/src/routes/worker-routes.cjs:258` | Список воркеров workspace | PG: `workerRepo.listByWorkspace`; Redis: publicWorker → heartbeat-ключ (liveInfo) |
| 27 | GET `/api/v1/workers/shared-with-me` | `backend/src/routes/worker-routes.cjs:277` | Воркеры, доступные личному гранту (kill-switch shareFeaturesEnabled) | PG: `workerRepo.listSharedWithMe` |
| 28 | GET `/api/v1/workers/:workerId` | `backend/src/routes/worker-routes.cjs:294` | Детали одного воркера workspace | PG + Redis (heartbeat) |
| 29 | POST `/api/v1/workers/:workerId/rotate` | `backend/src/routes/worker-routes.cjs:314` | Ротация учётных данных | PG: `workerRepo.rotateCredential`; Redis: `mirrorDrop` + `mirrorPutWorkerById` |
| 30 | DELETE `/api/v1/workers/:workerId` | `backend/src/routes/worker-routes.cjs:348` | Отзыв (мягкое удаление) | PG: `workerRepo.revokeWorker`; Redis: `mirrorDrop`, drain policy lane `animastor:queue:<type>:policy:<id>` → `animastor:queue:<type>` |
| 31 | DELETE `/api/v1/workers/:workerId/purge` | `backend/src/routes/worker-routes.cjs:395` | Жёсткое удаление (только отозванные) | PG: `workerRepo.purgeWorker`; Redis: `mirrorDrop`, `redis.del(WORKER_HEARTBEAT_KEY)`, `hdel('animastor:gpu-hub:workers', …)` |
| 32–37 | POST/DELETE/GET `/api/v1/workers/:workerId/share`, GET/POST/DELETE `/…/share/users` | `backend/src/routes/worker-routes.cjs:459, 624, 649, 684, 703, 784` | Управление политиками шаринга воркера (kill-switch) | PG: share_policies / share_grants; Redis: `workerAuth.mirrorPutWorkerById` |

### Странности (раздел 1)

- Legacy `POST /api/v1/worker/heartbeat` удалён, остался только комментарий (`backend/src/routes/generation-routes.cjs:244–250`).
- `cancel-worker` с `type=cover` только снимает лизы audio+image всей книги (`backend/src/routes/book/generation-routes.cjs:266–270`): реестр задач, PG `generation_tasks`, очереди хаба и `scene_assets` не трогаются — в отличие от остальных типов, идущих через `cancelStage` (`:277–284`).
- `cancel-worker` с `type=vbook` пишет отмену в Redis-множество `animastor:cancelled-workers:{book}` с TTL 1 ч (`:248–249`) и в PG-tombstone (`:261`) — после истечения TTL признак в Redis пропадает, tombstone остаётся.
- `cancel-generation` вызывает `DELETE /queue/clear?book_id=` у хаба дважды (`:411` и повторный sweep `:446`); ошибка первого вызова прерывает команду (`:453–454`), ошибка второго — только предупреждение.
- Защита от параллельных `trigger-next-window` хранится только в памяти процесса (`inFlightTriggers`, `backend/src/routes/book/import-routes.cjs:192`, `:854–858`) и в Redis-ключах вне пространства `animastor:` (`trigger_cooldown:`, `trigger_dedup:`, `:805`, `:816`).
- Ключ дедупликации результата `animastor:result-processed:{job_id}:{build_id}` намеренно не содержит `dispatch_id` (`backend/src/routes/generation-routes.cjs:500–509`), а ключ ошибки `animastor:error-processed:{dispatch_id}:{job_id}:{build_id}` содержит (`:718`).
- Логика «загрузить бандл → восстановить чанки с диска → окно сцен» продублирована: `POST /api/v1/generate` (две почти одинаковые ветки, `backend/src/routes/generation-routes.cjs:139–181` и `:183–234`), `POST /book/import` (vbook-ветка, `backend/src/routes/book/import-routes.cjs:222–321`) и `POST /book/load-vbook` (`:418–520`).

### Итоги раздела 1

- Всего регистраций app.get/post/put/delete/patch во всех routes: **136**.
- Эндпоинтов в разделе 1: **37** (из них генерация/отмена/чтение состояния: 23; воркеры/шаринг: 14).


## 2. Фоновые процессы и таймеры

Префиксы: `backend/src/...` — `/home/animastor/src/animastor-backend/backend/src/...`; `orch: runtime/...` — `/home/animastor/src/animastor-backend/packages/animastor-orchestration/src/runtime/...` (пакет `@animastor/orchestration`; лежит в `packages/` в корне репо, а не в `backend/packages/`).

### 2.1 Периодические циклы (setInterval / рекурсивный setTimeout)

| # | Цикл | Создание (файл:строка) | Период | Что читает | Что пишет | Когда создаёт/переотправляет работу |
|---|---|---|---|---|---|---|
| 1 | Runtime loop — быстрый tick | `backend/src/runtime/runtime-loop.js:261` (рекурсивный setTimeout, `scheduleNext`) | `orch: runtime/runtime-scheduler.js:84` `SCHEDULER_TICK_MS = 5000`; передаётся в `start()` `backend/src/runtime/runtime-loop.js:322` | Redis ping; активный индекс `getActiveSceneKeys` (`orch: runtime/runtime-scheduler.js:146`); layer-config, force-stages, asset states | `runtimeScheduler.tick` (`runtime-loop.js:78`) → dispatch на хаб; `counterReconciliation.reconcileCounters` (`runtime-loop.js:81`); `runtimeMetrics.recordSchedulerTick` (`runtime-loop.js:93`); `prometheus.collect` (`runtime-loop.js:100`) | `tick` (`orch: runtime/runtime-scheduler.js:355`) → для каждой сцены активного индекса `attemptDispatch` (`runtime-scheduler.js:448`, определение `:546`) → `shouldScheduleAssets` (`:560`, определение `:283`) |
| 2 | Runtime loop — reconcile | `backend/src/runtime/runtime-loop.js:306` (рекурсивный setTimeout, `scheduleReconcile`) | `RECONCILE_INTERVAL_MS = 60000` (`runtime-loop.js:19`) | Redis `animastor:result:*` (scan, `orch: runtime/reconciliation-engine.js:2009`), audio/video-orch состояния, staging-манифесты, heartbeat-ключи | `executeReconcileCycle` (`runtime-loop.js:143`): `resultPublication.resumePendingPublications` + `collectStaleStaging` (`:161`, `:169`); `syncWorkerLiveness` → PG `workers` (`:180`); `reconciliationEngine.reconcileCycle(..., {startup:false})` (`:192`) | Фаза A `recoverResultKeys` (`reconciliation-engine.js:1987`) повторно вызывает `taskHandler.handleTaskResult` для найденных ключей результата; B1 `checkStalledAudioScenes` (`:528`) и B2 `checkStalledVideoScenes` (`:650`) вызывают `failWaitingScene` (`:583`, `:617`, `:627`) → по комментарию `:648` «failStage (→ re-dispatch)» |
| 3 | Lease renewal (на каждый dispatch) | `orch: runtime/lease-manager.js:181` setInterval (+ одноразовый первый `:173`) | `RENEWAL_INTERVAL_MS = 30000` (`lease-manager.js:29`), первый — `RESTART_DELAY_MS = 5000` (`:30`) | ключ lease (владелец по token) | `renewLeaseIfOwner` — переставляет TTL lease на `LEASE_TOTAL_TTLS[stage] + 180` (`:36`) | Работу не создаёт; держит lease живым, пока процесс жив |
| 4 | SSE heartbeat progress-stream | `backend/src/routes/generation-routes.cjs:410` | 15 000 мс (литерал) | — | `: ping` в SSE | Нет |
| 5 | Sessions purge | `backend/src/backend.cjs:866` | 6 ч (литерал) | PG sessions | `sessionRepo.purgeExpired` (DELETE) | Нет (не генерация) |
| 6 | Guests purge | `backend/src/backend.cjs:883` | 6 ч (литерал) | PG guests/workspaces | `guestRepo.purgeExpired` | Нет (не генерация; удаляет временные workspace) |
| 7 | Worker-auth mirror resync | `backend/src/services/worker-auth.js:199` (старт из `backend/src/backend.cjs:902`) | `MIRROR_RESYNC_INTERVAL_MS = 5 мин` (`worker-auth.js:30`) | PG workers + share policies | Redis-зеркало учётных данных воркеров (`syncWorkerAuthMirror`) | Нет; влияет на то, какой воркер хаб пустит к pop |
| 8 | GPU retry timer (на каждую паузу) | `backend/src/services/gpu-retry-policy.cjs:291` (`armTimer`) | паузы по классу ошибки `gpu-retry-policy.cjs:50–53`: TRANSIENT 30 с / 120 с (2 повтора), OOM 60 с (1), DETERMINISTIC/UNKNOWN — 0 | Redis retry-record, задача реестра | `fireRetry` (`:303`): `unsafeRestoreAssetState(..., PENDING)` + `scheduler.addSceneToActiveIndex` (`:350`) | Переотправка через scheduler на следующем tick, если задача `active` (`:327`) и стадия разрешена command-gate (`:329`) |

### 2.2 Startup-хуки (одноразово, `backend/src/backend.cjs`)

| # | Хук | файл:строка | Что делает |
|---|---|---|---|
| S1 | `storage.postgres.initialize()` | `backend/src/backend.cjs:856` | Инициализация схемы PG |
| S2 | `interruptActiveGenerationTasks` (до старта loop) | `backend/src/backend.cjs:931` → `backend/src/startup-resume.js:69` | Реестр задач → `interrupted` (`startup-resume.js:79`), PG `taskRepo.interruptActiveTasks` (`:89`), дренаж активного индекса по command-gate (`:97–104`) |
| S3 | `gpuRetryPolicy.interruptPendingRetries` | `backend/src/backend.cjs:938` → `gpu-retry-policy.cjs:367` | Отложенные повторы предыдущего процесса не выполняются (журнал «interrupted») |
| S4 | `runtime.loop.start(redis)` | `backend/src/backend.cjs:944` | Запуск циклов #1 и #2 |
| S5 | `reconcileCycle(..., {startup:true})` (setImmediate) | `backend/src/backend.cjs:971` | Фазы A, B1, B2 + C0 chunk recovery, C1/C1b audio/video-orch, C2 version stale, C4 counters из PG, C5 `interruptIncompleteSessions` (`startup-resume.js:31`: gen sessions → `failed`), C6 layer-config из book.json |
| S6 | Сброс счётчиков и лизов (setImmediate) | `backend/src/backend.cjs:986–1022` | `genScope.migrateLegacyScopes` (`:986`); DEL `animastor:runtime:active-audio/image/video`; SCAN+DEL `animastor:dispatch-lease:*` (`:1009`); `reconcileCounters` (`:1022`) |

Подписки: в backend/src и пакете оркестрации есть одна Redis-подписка — `sub.subscribe(ch)` в progress-stream (`backend/src/routes/generation-routes.cjs:399`, по одному соединению на SSE-клиента). Других `subscribe`/`psubscribe` и `new EventEmitter` в генерационном коде нет (поиск `grep -rn "\.subscribe(\|psubscribe(\|new EventEmitter\|\.on('message'"`). `window-generator.cjs` таймеров не создаёт: его `runBackgroundWindowGeneration` запускается из HTTP (`backend/src/routes/book/import-routes.cjs:965`).

### 2.3 Гейтится ли command-gate

Функции гейта: `orch: runtime/command-gate.js` — `getAuthorizedStages:118`, `isStageAuthorized:143`, `isBookCancelled:79`.

| Цикл / путь | command-gate | Проверка (файл:строка) |
|---|---|---|
| #1 scheduler tick → dispatch | да | `orch: runtime/runtime-scheduler.js:298` (`getAuthorizedStages` в `shouldScheduleAssets`); кэш гейта на tick `:408`; force-stages `:424` |
| Добавление в активный индекс | да | `orch: runtime/active-scenes-index.js:50`; `orch: runtime/scene-window.js:713` (startScene) |
| #8 GPU retry timer | да | `backend/src/services/gpu-retry-policy.cjs:329` |
| #2 reconcile — applyFix (возврат в индекс / повторы) | да | `orch: runtime/reconciliation-engine.js:1337`, `:1382`, `:1427`, `:1519`, `:1582`; отмена книги — `:386` |
| #2 reconcile — фаза A `recoverResultKeys` (повторная публикация результата) | нет | в `reconciliation-engine.js:1987–2060` вызова гейта нет; работу не создаёт, только принимает уже готовый результат |
| #2 reconcile — B1/B2 stalled watchdog → `failWaitingScene` | нет | `reconciliation-engine.js:528–764` — вызова гейта нет; повторная отправка (если будет) идёт через scheduler, где гейт есть |
| S2 дренаж активного индекса при старте | да | `backend/src/startup-resume.js:102` |
| #3 lease renewal | нет | работу не создаёт |
| #7 mirror resync, #5/#6 purge, #4 SSE | нет | к генерации не относятся |

### 2.4 Одноразовые setTimeout

| файл:строка | Задержка | Назначение |
|---|---|---|
| `backend/src/routes/generation-routes.cjs:175` | 500 мс | повторный опрос чанков в POST /api/v1/generate |
| `backend/src/helpers/queue-idempotency.cjs:1172` | 20 мс | пауза внутри цикла idempotency |
| `backend/src/backend.cjs:1052` | 10 000 мс | жёсткий выход при graceful shutdown |
| `backend/src/runtime/gpu-dispatcher.js:511` | 30 000 мс | abort fetch на хаб |
| `backend/src/runtime/gpu-dispatcher.js:524`, `:549` | 1000 мс | пауза между попытками отправки на хаб (attempt < 2) |
| `orch: runtime/lease-manager.js:173` | 5000 мс | первый renewal lease |
| `backend/src/services/publication-lock.cjs:132` | ms (параметр) | sleep в ожидании lock публикации |
| `backend/src/services/ai-service.js:123`, `:498`; `backend/src/services/agent/ai-caller.js:54` | delay (backoff) | повторы AI-запросов (VBook) |
| `backend/src/routes/ai-connector-routes.cjs:412`, `:502`; `backend/src/services/ai-connector/transport.js:333`; `.../discovery.js:140` | — | таймеры WS Local AI Connector (не генерация медиа) |

### Странности (раздел 2)

- Dispatch-лизы чистятся при старте дважды по смыслу: SCAN+DEL `animastor:dispatch-lease:*` (`backend/src/backend.cjs:1009`) и фазы reconcile со stale-lease проверками (`orch: runtime/reconciliation-engine.js:975` `checkStaleDispatchLeases`).
- Счётчики `animastor:runtime:active-*` удаляются в трёх местах: startup (`backend/src/backend.cjs` блок `:986–1022`), `cancel-generation` (`backend/src/routes/book/generation-routes.cjs:323–325`), и пересчитываются `reconcileCounters` каждые 5 с (`runtime-loop.js:81`).
- Таймеры lease renewal (`lease-manager.js:181`) и GPU retry (`gpu-retry-policy.cjs:291`) хранятся в памяти процесса (`activeLeaseRenewals` Map, `timers` Map); после рестарта повторы явно сбрасываются (S3), а lease — SCAN+DEL (S6).
- Фаза C5 помечает gen sessions как `failed` с текстом «interrupted» (`backend/src/startup-resume.js:44–48`) — отдельного статуса `interrupted` у сессий нет, а у задач реестра — есть.
- `syncWorkerLiveness` зеркалит heartbeat хаба (Redis) в PG `workers` раз в 60 с (`runtime-loop.js:180`): одно состояние (живость воркера) в Redis и PG.
- Комментарий `backend/src/backend.cjs:951` (`// T6: Единый reconciliation-цикл (заменяет startup-recovery, audio-recovery, cleanup-service)`), при этом файлы `backend/src/services/audio-recovery.cjs` и `cleanup-service.cjs` в репо остаются (см. раздел 10).


## 3. Postgres: схема и места записи

Префиксы: `schema.js:N` — `backend/src/storage/postgres/schema.js:N`; `repo/X:N` — `backend/src/storage/postgres/repositories/X:N`; прочие пути от `backend/src/`. Отдельных файлов миграций нет: миграции — блоки `ALTER TABLE …` в `runMigrations` в том же `schema.js` (строки 735–1922). Пакет `@animastor/orchestration` SQL не содержит (поиск `INSERT INTO|UPDATE|DELETE FROM` по `packages/animastor-orchestration/src` — 0 совпадений); в PG он ходит через порты (`storage/runtime-persistence-adapter.js`, `storage/progress-events-adapter.js`).

### 3.1 Схема генерационных таблиц

| Таблица | Определение | Ключевые колонки (тип) | CHECK по статусам | Индексы / уникальные |
|---|---|---|---|---|
| `generation_tasks` | `schema.js:233` | `id` BIGINT identity PK, `task_id` TEXT, `book_id` TEXT, `chapter_id`/`scene_id` TEXT, `task_type` TEXT, `status` TEXT, `worker_id` TEXT, `workspace_id` UUID FK workspaces, `retry_count`/`max_retries` INT, `error` TEXT, `created_at`/`started_at`/`completed_at` BIGINT, `metadata` JSONB | `task_type IN (audio,image,video)` `:239`; `status IN (queued,running,completed,failed,cancelled,blocked,interrupted)` `:240`, пересоздаётся миграцией `:852–854` | `idx_tasks_book` `:252`, `idx_tasks_status` `:253`, `idx_tasks_workspace` `:1747` (миграция PW-2, бэкфилл workspace_id из books `:1737`). Уникального ключа на `task_id` нет — одна строка на (task_id × сцена) |
| `scene_assets` | `schema.js:573` | `id` PK, `book_id`/`chapter_id`/`scene_id` TEXT, `asset_type` TEXT, `path`, `duration_sec`, `width`/`height`, `format`, `chunks` JSONB, `build_id`, `scene_hash`, `status`, `error`, `metadata` JSONB, `created_at`/`updated_at`; миграции добавляют `scene_content_version` `:828`, `scene_audio_config_version` `:836` | `asset_type IN (audio,image,video,storyboard,subtitle,preview,manifest)` `:578`; `status IN (pending,ready,stale,failed,missing,placeholder,cancelled)` `:589`, пересоздаётся `:794–796` | `UNIQUE(book_id,chapter_id,scene_id,asset_type,build_id)` `:594`; `idx_scene_assets_scene/build/status/type/hash` `:597–601` |
| `scenes` | `schema.js:165` | PK `(book_id,chapter_id,scene_id)`, `book_id` FK books ON DELETE CASCADE, `scene_order`, `scene_type`, `status`, `scene_hash`, `build_id`, `metadata`; миграции: `content_version` `:812`, `audio_config_version` `:820`, `dirty_unit_ids` TEXT[] `:900`, `is_dirty` BOOL `:941` | `status IN (pending,generating,ready,failed,dirty)` `:172` | `idx_scenes_hash` `:778`, `idx_scenes_build` `:779` |
| `asset_states` | `schema.js:182` | PK `(book_id,chapter_id,scene_id,layer)`, `status`, `hash`, `version`, `error` | `layer IN (audio,image,video,filesystem)` `:186`; `status IN (clean,dirty,queued,generating,ready,failed)` `:187` | только PK |
| `book_generation_sessions` | `schema.js:1149` (миграция) | `id` UUID PK, `book_id`, `window_index`, offsets, `generated_scene_from/to`, `window_size`, `status`, `error`, `progress_msg`; `completion_status` `:1136` | `status IN (pending,generating,completed,failed,queued)` `:1158` | `idx_gen_session_book` `:1164`, `idx_gen_session_status` `:1165` |
| `generation_cancellations` | `schema.js:1181` | `book_id` TEXT PK, `cancelled_at`, `reason`, `created_by`, `updated_at` | — | PK |
| `image_units` | `schema.js:507` | `book_id`, `build_id`, `chapter_id`, `scene_id`, `unit_id`, тайминги (`start_ms`, `end_ms`, `scene_duration_sec`…) | — | `UNIQUE(build_id,book_id,chapter_id,scene_id,unit_id)` `:524`; 3 индекса `:527–529` |
| `iu_image_fence_reservations` | `schema.js:1898` (`IU_IMAGE_VERSIONED_SQL`, под флагом) | `idem_key` PK, ключ IU, `build_id`, `fence` BIGINT (seq `iu_image_fence_seq` `:1897`) | — | PK |
| `iu_image_pointers` | `schema.js:1908` | PK `(book_id,chapter_id,scene_id,iu_id,build_id)`, `path`, `publish_fence` | — | PK |
| `workers` | `schema.js:267` | `worker_id` UUID PK, `workspace_id` UUID FK CASCADE, `worker_type`, `mode`, `status`, `token_hash` UNIQUE, `revoked_at`, `last_seen`, `version` | `worker_type IN (audio,image,video)` `:273`; `mode IN (private,share,system)` `:275`; `status IN (online,offline,busy,error)` `:276`; `workers_scope_check` (system ∨ workspace_id NOT NULL) `:287`; секунды в `last_seen`/`revoked_at` `:1855–1874` | `idx_workers_workspace` (миграция `:1463`/`:1473`/`:1498`) |
| `books` | `schema.js:139` | `book_id` PK, `workspace_id` UUID FK (миграция `:1267`), `user_id` UUID FK | `visibility` `:146` | `idx_books_workspace` `:1277` |
| `book_events` | `schema.js:624` | `book_id`, `chapter_id`, `scene_id`, `event_type`, `state`, `actor`, `ref_type/ref_id`, `details` JSONB | — | `idx_events_book/scene/type/ref` `:638–641` |
| `cache_entries` | `schema.js:196` | `asset_key` UNIQUE, путь/размер/хэш файла, `status` | `asset_type` `:202`; `status IN (pending,ready,stale,failed)` `:207` | 4 индекса `:213–216` |
| `output_manifests` | `schema.js:493` | `build_id`, `book_id`, `asset_type`, `status` | `status IN (building,ready,failed)` `:500` | `UNIQUE(build_id,book_id,asset_type)` |
| `asset_dependencies` | `schema.js:219` | `book_id`, `source_layer`, `target_layer` | — | `UNIQUE(book_id,source_layer,target_layer)` |
| `reconciliation_events` | `schema.js:484` | `book_id`, `event_type`, `details` | — | — |

### 3.2 Все места записи (INSERT / UPDATE / DELETE / UPSERT)

Сбор: `grep -rnoP "(INSERT INTO|UPDATE|DELETE FROM)\s+(<таблицы>)\b" backend/src packages/*/src`, имена функций — по ближайшему объявлению выше строки (скрипт), затем ручная проверка.

**generation_tasks**

| Операция | Место | Функция | Кто вызывает |
|---|---|---|---|
| INSERT | `repo/task-repo.js:5` | `createTask` | `routes/book/generation-routes.cjs:904` (/regenerate) |
| UPDATE worker_id, workspace_id | `repo/task-repo.js:22` | `recordTaskClaim` | `routes/generation-routes.cjs:94` (колбэки result/error) |
| UPDATE status | `repo/task-repo.js:54` | `updateTaskStatus` | `routes/book/generation-routes.cjs:240`, `:917`; `services/gpu-retry-policy.cjs:172`; `services/stage-cancellation.cjs:53`; `storage/runtime-persistence-adapter.js:53`; `storage/progress-events-adapter.js:66`, `:92` |
| UPDATE retry_count | `repo/task-repo.js:59` | `incrementRetry` | вызовов нет (только экспорт `:156`) |
| UPDATE → cancelled | `repo/task-repo.js:94` | `cancelActiveTasksForBook` | `routes/book/generation-routes.cjs:387` |
| UPDATE → interrupted | `repo/task-repo.js:110` | `interruptActiveTasks` | `startup-resume.js:90` |
| UPDATE → cancelled (по типу) | `repo/task-repo.js:125` | `cancelActiveTasksForBookByType` | `services/stage-cancellation.cjs:60` |
| UPDATE (stale) | `services/book-sync.js:275` | `markGenerationTasksStale` | `services/book-sync.js:91`, `:362` |
| UPDATE workspace_id (бэкфилл) | `schema.js:1737` | миграция PW-2 | старт |
| DELETE по сцене | `services/book-sync.js:324` (цикл по таблицам) | `purgeRemovedSceneRows` | book-sync / `services/entity-cleanup.cjs` |
| DELETE по книге | `services/book-deletion.cjs:195`; `routes/book/cache-routes.cjs:113` (цикл `DELETE FROM ${table}`) | `createBookDeletion` / DELETE `/api/v1/book/:bookId/cache` | удаление книги / очистка кэша |

**scene_assets**

| Операция | Место | Функция | Кто вызывает |
|---|---|---|---|
| UPDATE / INSERT (build_id NULL) | `repo/scene-assets-repo.js:149`, `:177` | `upsertAssetWithNullBuildId` | `repo/scene-assets-repo.js:206` |
| UPSERT `ON CONFLICT (…,build_id) DO UPDATE` | `repo/scene-assets-repo.js:210` (`:221`) | `upsertAsset` | `services/placeholder-audio.js:248,340,373,394,418,440`; `services/scene-asset-registry.js:42,67,89,106,123,136,146` (модуль без production-импортёров, раздел 10) |
| UPDATE → stale | `repo/scene-assets-repo.js:269` | `markStale` | `state/scene-state-ops.js:131` |
| UPDATE ×2 + INSERT `ON CONFLICT DO NOTHING` | `repo/scene-assets-repo.js:293`, `:310`, `:324` (`:336`) | `stampSceneVersionsForDispatch` | `storage/runtime-persistence-adapter.js:76` |
| UPDATE ×2 + INSERT | `repo/scene-assets-repo.js:368`, `:380`, `:392` | `ensureSyntheticStaleAsset` | `services/book-sync.js:251` |
| UPDATE (stale) | `services/book-sync.js:236` | `markSceneAssetsStale` | `services/book-sync.js:88`, `:361` |
| UPDATE pending → cancelled / failed | `repo/scene-assets-repo.js:851` (`updatePendingAssets:845`) | `cancelPendingAssets:862`, `markPendingAssetsFailed:870` | cancel: `routes/book/generation-routes.cjs:376`, `services/stage-cancellation.cjs:143`; failed: `services/gpu-retry-policy.cjs:178`, `storage/progress-events-adapter.js:73` |
| DELETE сцена / книга / build | `repo/scene-assets-repo.js:550`, `:556`, `:560` | `deleteSceneAssets`, `deleteBookAssets`, `deleteBuildAssets` | `services/scene-asset-registry.js:263`, `:266`, `:269` — модуль импортируют только тесты, т.е. в production эти DELETE не вызываются |
| DELETE (цикл) | `services/book-sync.js:324`; `services/book-deletion.cjs:195`; `routes/book/cache-routes.cjs:113` | см. выше | — |

**scenes**

| Операция | Место | Функция | Кто вызывает |
|---|---|---|---|
| UPSERT `ON CONFLICT DO UPDATE` | `services/book-sync.js:213` | `updateSceneHashes` | book-sync |
| UPDATE версии | `repo/scene-assets-repo.js:611`, `:625` | `bumpSceneVersions` | `services/entity-cleanup.cjs:385`; `packages/animastor-editor/src/editor-routes.cjs:260,427,562,624,682` |
| INSERT `ON CONFLICT DO NOTHING` | `repo/scene-assets-repo.js:633` | `ensureSceneRow` | `routes/book/generation-routes.cjs:717` (/regenerate) |
| UPDATE dirty_unit_ids | `repo/scene-assets-repo.js:658`, `:668` | `setDirtyUnitIds` | `routes/book/generation-routes.cjs:853`; `storage/runtime-persistence-adapter.js:84`; editor-routes |
| UPDATE is_dirty=false | `repo/scene-assets-repo.js:715` | `clearDirtyFlag` | `storage/runtime-persistence-adapter.js:92` |
| UPDATE dirty_unit_ids='{}' | `repo/scene-assets-repo.js:778` | `clearDirtyUnitIds` | `storage/runtime-persistence-adapter.js:88` |
| UPDATE | `services/entity-cleanup.cjs:311` | `purgeUnit` | entity-cleanup |
| DELETE | `services/book-sync.js:330` | `purgeRemovedSceneRows` | — |
| DELETE (цикл книги) | `services/book-deletion.cjs:195`; `routes/book/cache-routes.cjs:113`; каскад FK `schema.js:168` при DELETE books | — | — |

**Остальные**

| Таблица | Операция | Место | Функция | Кто вызывает |
|---|---|---|---|---|
| `generation_cancellations` | UPSERT | `repo/generation-cancel-repo.js:26` (`:28`) | `setCancelled` | `routes/book/generation-routes.cjs:261`, `:315` |
| | DELETE | `repo/generation-cancel-repo.js:43` | `clear` | `routes/generation-routes.cjs:132`; `routes/book/generation-routes.cjs:570` |
| `book_generation_sessions` | INSERT | `repo/gen-session-repo.js:13` | `createSession` | `routes/book/import-routes.cjs:947`, `:954`; `services/agent/bootstrap.js:116,483,653` |
| | UPDATE | `repo/gen-session-repo.js:28` | `updateSession` | `routes/book/import-routes.cjs:948`, `:958`; `startup-resume.js:43`; `services/window-generator.cjs:34,42,59` |
| | INSERT | `repo/gen-session-repo.js:99` | `markFirstWindowCompleted` | `routes/book/import-routes.cjs:653` |
| | UPDATE | `repo/gen-session-repo.js:168` | `setBookCompletionStatus` | `services/window-generator.cjs:63` |
| `image_units` | UPSERT | `repo/iu-repo.js:17` | `upsertImageUnit` | `image/iu-processor.js:113`; `storage/runtime-persistence-adapter.js:133`; `packages/animastor-player/src/scene-data.cjs:189`, `iu-media.cjs:261` |
| | UPSERT | `repo/iu-repo.js:56` | `upsertIuTiming` | `packages/animastor-player/src/scene-data.cjs:372`, `:439` |
| | UPDATE | `repo/iu-repo.js:86` | `updateImageUnitText` | — |
| | DELETE | `repo/iu-repo.js:94`, `:99` | `deleteImageUnitsForBuild`, `deleteImageUnitsForScene` | вызовов не найдено |
| | DELETE | `services/entity-cleanup.cjs:305` | `purgeUnit` | — |
| `iu_image_fence_reservations` | INSERT `ON CONFLICT DO NOTHING` | `repo/iu-image-pointer-repo.js:213` (`:216`) | `reserveDispatchFence` | `runtime/gpu-dispatcher.js:358` |
| `iu_image_pointers` | UPSERT (только если fence не меньше) | `repo/iu-image-pointer-repo.js:284` (`:287`, `:292`) | `publishIuImagePointer` | `services/task-handler.cjs:231` |
| `workers` | INSERT | `repo/worker-repo.js:110`, `:129` | `createWorker`, `createSystemWorker` | worker-routes / admin-routes |
| | UPDATE | `repo/worker-repo.js:242`, `:258`, `:314`, `:326`, `:788` | `rotateCredential`, `revokeWorker`, `rotateSystemCredential`, `revokeSystemWorker`, `touchLastSeen` | worker-routes / admin-routes |
| | UPDATE online/offline | `repo/worker-repo.js:814`, `:824` | `syncLivenessFromHeartbeats` | `services/worker-liveness-sync.cjs:48` (reconcile, раз в 60 с) |
| | DELETE | `repo/worker-repo.js:277` | `purgeWorker` | `routes/worker-routes.cjs:413` |
| `books` | UPSERT | `repo/book-repo.js:7` | `ensureBook` | `middleware/workspace-ownership.js:75` |
| | UPDATE workspace_id | `repo/book-repo.js:103` | `attachWorkspaceIfMissing` | `middleware/workspace-ownership.js:67` |
| | DELETE | `repo/book-repo.js:79` | `deleteBookSnapshots` (удаляет и `book_snapshots`, и `books`) | удаление книги |
| | DELETE | `repo/guest-repo.js:199` | `purgeExpired` | `backend.cjs:883` (раз в 6 ч) |
| `book_events` | INSERT | `repo/events-repo.js:17`, `:44` | `appendEvent`, `appendBatch` | `services/book-event-log.js:76`, `:101` |
| | DELETE | `repo/events-repo.js:134`, `:139`, `:146` | `deleteBookEvents`, `deleteSceneEvents`, `deleteEventsBefore` | `services/book-event-log.js:188` (retention) |
| `asset_states`, `cache_entries`, `asset_dependencies`, `reconciliation_events`, `output_manifests` | только DELETE (цикл по книге/сцене) | `services/book-deletion.cjs:195`; `routes/book/cache-routes.cjs:113`; `services/book-sync.js:324` (asset_states, cache_entries) | — | — |

### 3.3 Таблицы, в которые никто не пишет

`asset_states`, `cache_entries`, `asset_dependencies`, `reconciliation_events`, `output_manifests` — ни одного INSERT/UPDATE в `backend/src` и `packages/*/src`; есть только DELETE в циклах очистки (`services/book-deletion.cjs:166–173`, `routes/book/cache-routes.cjs:79–86`, `services/book-sync.js:321–322`). Состояние слоёв фактически живёт в Redis (раздел 4), не в `asset_states`.

### Странности (раздел 3)

- Состояние слоя сцены хранится в трёх местах: Redis asset-state (раздел 4), PG `scene_assets.status`, PG `scenes.status`/`is_dirty`/`dirty_unit_ids`; плюс пустая таблица `asset_states` со своим CHECK-набором статусов (`clean,dirty,queued,…` `schema.js:187`), не совпадающим ни со `scene_assets` (`:589`), ни со `scenes` (`:172`).
- Статус задачи хранится в Redis-реестре задач (`services/generation-progress`) и в PG `generation_tasks`; /regenerate пишет в PG `createTask` и сразу `updateTaskStatus('running')` (`routes/book/generation-routes.cjs:904`, `:917`) — статус `queued` из DEFAULT (`schema.js:240`) на этом пути не используется.
- `generation_tasks` не имеет UNIQUE на `task_id`: одна задача = N строк (по одной на сцену-цель, цикл `routes/book/generation-routes.cjs:901–923`); при ошибке PG внутри цикла `break` (`:920`) оставляет часть строк.
- `task-repo.incrementRetry` (`repo/task-repo.js:57`) не вызывается; счётчик повторов ведёт `gpu-retry-policy` в Redis — колонки `retry_count`/`max_retries` (`schema.js:243–244`) не обновляются.
- `scene-assets-repo.deleteSceneAssets/deleteBookAssets/deleteBuildAssets` (`repo/scene-assets-repo.js:550–560`) вызываются только из `services/scene-asset-registry.js`, у которого нет production-импортёров (только `backend/tests/scene-asset-registry.test.js:13`, `backend/tests/book-sync.test.js:26`).
- `iu-repo.deleteImageUnitsForBuild`/`deleteImageUnitsForScene` (`repo/iu-repo.js:94`, `:99`) — вызовов нет.
- Списки таблиц для удаления книги продублированы в двух местах с расхождениями: `services/book-deletion.cjs:164–186` включает `book_source`, `book_events`, `generation_cancellations`, а `routes/book/cache-routes.cjs:78–97` — нет (по комментарию намеренно), но включает `storyboard_elements`, `audio_layers`.
- `workers.status` (PG) зеркалит heartbeat хаба (Redis) с задержкой до 60 с (`repo/worker-repo.js:814–824`), а `routes/worker-routes.cjs:113–114` прямо пишет, что PG-статус наружу не отдаётся — для UI статус вычисляется по Redis.
- В `workers.mode` CHECK меняется миграциями дважды: `(private,share)` `schema.js:1471–1472`, затем `(private,share,system)` `:1519–1521`.


## 4. Redis-ключи backend

Префиксы путей: от `backend/src/` (без префикса) и `orch:` = `packages/animastor-orchestration/src/`. Сбор: скрипт по литералам `'animastor:…'`/`` `animastor:… `` во всех `*.js|*.cjs` (комментарии исключены) + чтение модулей-владельцев. Найдено **108 семейств** (по первым 1–2 сегментам после `animastor:`). Ниже — 4.1 основные генерационные семейства (тип и TTL проверены по коду владельца); полный перечень — приложение 4.5.

### 4.1 Основные генерационные ключи

| Ключ (формат) | Тип | TTL | Кто пишет | Кто читает | book_id в ключе |
|---|---|---|---|---|---|
| `animastor:active-scenes` (элемент — `book:chapter:scene`) | set | нет | `orch:runtime/active-scenes-index.js:11` (ключ); `addSceneToActiveIndex` `orch:runtime/runtime-scheduler.js:101`; srem `:159`, `:181` | scheduler `orch:runtime/runtime-scheduler.js:147`; `routes/generation-routes.cjs:279` (scard); `metrics/prometheus.js:270` | **нет (глобальный)** |
| `animastor:dispatch-lease:{book}:{ch}:{sc}:{stage}` | string (token) | по стадии `LEASE_TTLS` (`orch:runtime/dispatch-engine.js:71`); renewal → +180 с (`orch:runtime/lease-manager.js:36`) | `orch:runtime/dispatch-engine.js:188`, `:193` (SET NX EX); формат `:136` | `orch:runtime/lease-manager.js`, reconcile, `metrics/prometheus.js:218`; удаляются SCAN+DEL `backend.cjs:1009` | да |
| `animastor:dispatch-meta:{book}:{ch}:{sc}:{stage}` | string (JSON) | = TTL lease (`orch:runtime/dispatch-engine.js:275`) | `orch:runtime/dispatch-engine.js:275`; формат `:143` | `orch:runtime/counter-reconciliation.js:152`, `orch:runtime/lease-manager.js:247` | да |
| `animastor:dispatch-completed:{book}:{ch}:{sc}:{stage}…` | string | — | `orch:runtime/dispatch-engine.js:104`, `:150` | dispatch-engine | да |
| `animastor:runtime:deferred:{book}:{ch}:{sc}:{stage}` | string `'1'` | 60 с (capacity) / 900 с (idempotent) `orch:runtime/dispatch-engine.js:810–811` | `orch:runtime/dispatch-engine.js:865` | dispatch-engine; снимается `clearDeferralsForBook/Scene` (`routes/book/generation-routes.cjs:437`, `:784`) | да |
| `animastor:runtime:active-{audio,image,video}` | string (счётчик INCR, Lua `ATOMIC_ACQUIRE_SCRIPT` `orch:runtime/dispatch-engine.js:638`) | нет | `orch:runtime/dispatch-engine.js:596`, `:657`; префикс `config/runtime-config.js:124` | `orch:runtime/counter-reconciliation.js:31`; DEL `backend.cjs:998–1000`, `routes/book/generation-routes.cjs:323–325` | **нет (глобальный)** |
| `animastor:runtime:scheduler-lock` | string | 30 с (`orch:runtime/dispatch-engine.js:126`) | `orch:runtime/dispatch-engine.js:686` | — | **нет (глобальный)** |
| `animastor:cleanup-lock` | string (token) | 120 с | `orch:runtime/reconciliation-engine.js:1751` (ключ `config/runtime-config.js:128`) | `:1759` (снятие) | **нет (глобальный)** |
| `animastor:runtime:last-active:{stage}` | string | 3 с | `orch:runtime/dispatch-engine.js:1217` | — | **нет (глобальный)** |
| `animastor:asset-state:{book}:{ch}:{sc}` | hash (поле — слой) | нет | `state/asset-state-store.js:100`, `:127` (префикс `:15`) | `state.getAssetStates` (progress-panel `routes/book/progress-panel.cjs:116`), scheduler | да |
| `animastor:audio-orch:{book}:{ch}:{sc}` / `animastor:video-orch:…` | string (JSON FSM) | нет | `services/audio-orchestrator.js:112` (префикс `:48`); `services/video-orchestrator.js:118` (`:54`) | `routes/generation-routes.cjs:486` (getState), reconcile B1/B2; удаление `services/cancel-scene-state.cjs:33` | да |
| `animastor:chunk:{chunk_id}` (chunk_id начинается с `{book}_`) | string (JSON) | нет | `helpers/redis-helpers.cjs:47` (saveChunk); `services/audio-orchestrator.js:470` | `helpers/redis-helpers.cjs:52`, `:71`; `routes/book/progress-panel.cjs:94` | косвенно (в chunk_id) |
| `animastor:chunks:{book}` | set (chunk_id) | нет | `helpers/redis-helpers.cjs:48`; `audio/generation.js:222`, `:389` | `helpers/redis-helpers.cjs:68` (getAllChunks) | да |
| `animastor:book-scenes:{book}:total` / `:next-index` / window-start | string | нет | `config/runtime-config.js:219–221` (конструкторы); `orch:runtime/scene-window.js:84–115`; routes импорта (`routes/book/import-routes.cjs:254` и др.) | scene-window, reconcile `orch:runtime/reconciliation-engine.js:2416` | да |
| `animastor:generation-progress:{book}` (реестр задач) | hash (task_id → JSON) | 4 ч, продлевается (`services/generation-progress.js:17`, `:26`, `:51`) | `services/generation-progress.js:25` | progress-panel, command-gate, startup-resume | да |
| `animastor:layer-config:{book}` | string (JSON) | нет | `services/layer-config.js:208`; восстановление из book.json SET NX `:277` | `orch:runtime/command-gate.js:56`; `orch:runtime/scene-window.js:219`; `orch:runtime/reconciliation-engine.js:685` | да |
| `animastor:gen-scope:{book}` | string (JSON) | 24 ч (`services/gen-scope.js:16`, `:27`) | `services/gen-scope.js:27` | gen-scope | да |
| `animastor:generation:cancel:{book}` (cancel-флаг) | string `'true'` | нет | `orch:runtime/scene-window.js:404` (префикс `:61`) | command-gate `isBookCancelled` `orch:runtime/command-gate.js:79` | да |
| `animastor:force-dispatch-stages:{book}` | set (`ch:sc:stage`) | параметр `ttlSeconds` | `orch:runtime/command-gate.js:291–292` (префикс `:274`) | `orch:runtime/command-gate.js:297`; scheduler `orch:runtime/runtime-scheduler.js:424` | да |
| `animastor:dispatch-noprogress:{book}:{ch}:{sc}:{stage}` | string (JSON) | 1 ч (`orch:runtime/command-gate.js:216`) | `orch:runtime/command-gate.js:238` | `noteNoProgress` / `failStageNoProgress` | да |
| `animastor:cancelled-workers:{book}` | set (`'vbook'`) | 3600 с | `routes/book/generation-routes.cjs:248–249` | `routes/book/import-routes.cjs:845`, `:923`; DEL `routes/book/generation-routes.cjs:368` | да |
| `animastor:regenerate-lock:{book}` | string (token) | 120 с | `routes/book/generation-routes.cjs:473` | `:484` | да |
| `animastor:gpu-retry:…` | string (JSON: attempts / pending) | 24 ч / 1 ч (`services/gpu-retry-policy.cjs:57–58`) | `services/gpu-retry-policy.cjs:132`, `:267` | `fireRetry` `:303`, `interruptPendingRetries` `:367` | да |
| `animastor:result-processed:{job_id}:{build_id}` | string (`1` / `done:<dispatch_id>`) | 3600 с (`routes/generation-routes.cjs:510`; `helpers/queue-idempotency.cjs:1968`) | `routes/generation-routes.cjs:510` (SET NX EX), `markResultSettled` | reconcile `readResultDedup` `orch:runtime/reconciliation-engine.js:70` | косвенно (job_id содержит book) |
| `animastor:error-processed:{dispatch_id}:{job_id}:{build_id}` | string | 60 с | `routes/generation-routes.cjs:718–719` | там же | косвенно |
| `animastor:result:{build}:{book}:{ch}:{sc}:{type}` | string (fallback-результат) | — | **хаб** (`hub: gpu-hub.js:1255`) | reconcile фаза A `orch:runtime/reconciliation-engine.js:2009`; `services/audio-recovery.cjs:46` | да |
| `animastor:error:{job_id}` | string | — | **хаб** (`hub: gpu-hub.js:514`) | `orch:runtime/reconciliation-engine.js:2094` | косвенно |
| `animastor:job:{dispatch_id}:{job_id}` | — | — | **хаб** (`hub: gpu-hub.js:424`) | DEL `image/iu-processor.js:247`; SCAN `routes/debug-routes.cjs:225` | косвенно |
| `animastor:idempotency:claim:{idem}` / `done:{idem}` / `ref:{book}:{ch}:{sc}:{job}` / `job-epoch:…` / `stage-epoch:…` | string | claim 24 ч (ambiguous 90 мин), done 7 сут, ref 24 ч, job-epoch 24 ч, stage-epoch 30 сут (`helpers/queue-idempotency.cjs:62–95`) | `helpers/queue-idempotency.cjs:426`, `:556`, `:467`, `:274`, `:231` | queue-idempotency (порт в routes через deps) | claim/done — нет (idem-хэш); ref/epoch — да |
| `animastor:intent:…` / `animastor:dispatch-intent:…` (receipt) / `animastor:intent-lock:…` | string | 14 сут / 48 ч / 15 с (`helpers/queue-idempotency.cjs:103`, `:113`, `:124`) | `helpers/queue-idempotency.cjs:1294`, `:1297`, `:1170` | `resolveDispatchFence` (колбэк result) | по формату idem/dispatch |
| `animastor:artifact-manifest:…` / `fence-journal:…` / `fence-publish:…` / `fence-unrecoverable:…` | string | journal/publish = 7 сут (`helpers/queue-idempotency.cjs:1583`, `:1614`) | `helpers/queue-idempotency.cjs:1579–1680` | `services/result-publication.cjs` (recovery в reconcile) | по формату |
| `animastor:iu-in-flight:{iu_id}` + `animastor:iu-in-flight-index:…` | string + set | `TIMEOUTS.IU_IN_FLIGHT_TTL_S` (`orch:runtime/dispatch-engine.js:121`, `:367`) | `image/iu-processor.js:184`; `orch:runtime/dispatch-engine.js:366` | `orch:orchestration/orchestrator.js:593`; `orch:orchestration/scene-callbacks.js:433` | косвенно (iu_id начинается с book) |
| `animastor:iu-progress:{book}:{ch}:{sc}:image` / `iu-progress-ids:…` | string (INCR) / set | 14400 с (`services/task-handler.cjs:523`, `:526`) | `services/task-handler.cjs:519–520` | `routes/book/iu-progress-utils.cjs:62` | да |
| `animastor:progress:{book}` | pub/sub канал | — | `publishProgress` (`services/progress-pubsub.cjs:13`) | SSE `routes/generation-routes.cjs:399` | да |
| `animastor:event-journal:{book}:{ch}:{sc}` | — | — | `state/event-journal.js:79` | `orch:runtime/reconciliation-engine.js:1617`, `:1659` | да |
| `animastor:worker:heartbeat:{type}:{worker_id}` | string (JSON с `ts`) | 30 с (пишет хаб) | **хаб**; конструктор `config/runtime-config.js:230` | `routes/worker-routes.cjs:99–100`; worker-health; DEL `routes/worker-routes.cjs:419` | **нет (глобальный, без book/user)** |
| `animastor:gpu-hub:workers` | hash | — | **хаб** | HDEL `routes/worker-routes.cjs:422` | **нет (глобальный)** |
| `animastor:worker-auth` (зеркало токенов) | — | нет | `services/worker-auth.js:29` (mirrorPut/Drop/resync) | хаб (аутентификация воркера) | **нет (глобальный)** |
| `animastor:queue:{type}` / `animastor:queue:{type}:policy:{id}` | list | — | **хаб**; backend RPOPLPUSH/LREM/LPUSH `routes/worker-routes.cjs:147–159` | хаб; `orch:runtime/counter-reconciliation.js:186` | **нет** (кроме ws/policy-суффикса) |

### 4.2 Глобальные ключи (без book_id и user_id)

`animastor:active-scenes`; `animastor:runtime:active-{audio,image,video}`; `animastor:runtime:scheduler-lock`; `animastor:cleanup-lock`; `animastor:runtime:last-active:{stage}`; `animastor:runtime:metrics:current|history` (`config/runtime-config.js:139–140`); `animastor:runtime:total-{dispatched,completed,failed}` (`routes/debug-routes.cjs:191–192`); `animastor:runtime:scheduler*`, `:recovery`, `:renewal-timers`, `:stuck-scenes` (`orch:runtime/runtime-metrics.js:147–350`); `animastor:retry-budget:global|type|worker` (`orch:runtime/retry-budget-manager.js:39–47`); `animastor:circuit:*` (`orch:runtime/circuit-breaker.js:75–96`); `animastor:worker:heartbeat:{type}:{id}`; `animastor:gpu-hub:workers`; `animastor:worker-auth`; `animastor:queue:{type}`, `animastor:running` (`orch:runtime/counter-reconciliation.js:183–186`); `animastor:prompt-profiles` (`services/profile-override.js:20`); `animastor:pending-purge`, `animastor:pending-purge-attempts` (`services/entity-cleanup.cjs:50–51`); `animastor:ai-connector:hb:*` (`routes/ai-connector-routes.cjs:98`). Ключи `animastor:idempotency:claim|done:{idem}` содержат только хэш (book_id в ключе нет, связь через `ref`).

Вне пространства `animastor:`: `trigger_cooldown:{book}` и `trigger_dedup:{book}` (`routes/book/import-routes.cjs:805`, `:816`, `:913–916`).

### 4.3 Сверка с реестром `backend/tests/architecture/redis-registry.js`

Реестр есть (824 строки, массив `REDIS_OWNERSHIP`, тест `backend/tests/architecture/redis-ownership.test.js`). Сравнение скриптом (`fnmatch` префикса кода против `pattern`):

| Расхождение | Ключ | Где в коде |
|---|---|---|
| в коде, нет в реестре | `animastor:dispatch-noprogress:*` | `orch:runtime/command-gate.js:213` |
| в коде, нет в реестре | `animastor:force-dispatch-stages:*` (в реестре только `animastor:force-dispatch:*`) | `orch:runtime/command-gate.js:274` |
| в коде, нет в реестре | `animastor:dispatch-phantom-suspect:*` | `orch:runtime/counter-reconciliation.js:154` |
| в коде, нет в реестре | `animastor:scene-state:*` | `helpers/redis-helpers.cjs:388` |
| в коде, нет в реестре | `animastor:scene:*` | `helpers/redis-helpers.cjs:464` |
| в реестре, нет в backend | `animastor:processing`, `animastor:processing-claimed`, `animastor:dead-letter`, `animastor:priority:queue`, `animastor:queue:*:ws:*`, `animastor:queue:*:policy:*` (литерал в backend есть только как шаблон `routes/worker-routes.cjs:147`) | ключи хаба (owner `gpu-hub`) |
| в реестре, литерала нет нигде в backend/src и пакете | `animastor:dispatch:*`, `animastor:event:*`, `animastor:force-dispatch:*`, `animastor:gen:*`, `animastor:gpu:*`, `animastor:layer:*`, `animastor:stale-dispatch-signal:*`, `animastor:vbook:*` | — |

### Странности (раздел 4)

- Ряд семейств упоминается в backend только в списке шаблонов очистки `cleanBookRedisKeys` (`helpers/redis-helpers.cjs:378` и далее), в `services/entity-cleanup.cjs` или в debug-чтении, без единого писателя в `backend/src` и пакете оркестрации: `animastor:scope`, `scene-state`, `snapshot`, `audio-scene-failsafe`, `scene-audio-status`, `fairness:*` (`helpers/redis-helpers.cjs:413–415`), `drift`, `failure`, `retry`, `runtime:quotas`, `runtime:total-*`, `video-dedup`, `scene-lock`, `lease` (проверено `grep` по остальным файлам — 0 ссылок).
- Состояние «что сейчас выполняется» хранится одновременно: active-index (`animastor:active-scenes`), счётчики `runtime:active-*`, dispatch-lease + dispatch-meta, реестр задач `generation-progress` (Redis), PG `generation_tasks`, и очереди/`processing`/`running` хаба.
- Отмена хранится в трёх местах: Redis `animastor:generation:cancel:{book}` (без TTL), Redis `animastor:cancelled-workers:{book}` (только vbook, TTL 1 ч), PG `generation_cancellations`.
- Литерал `animastor:active-scenes` продублирован вне владельца: `orch:runtime/runtime-metrics.js:116`, `routes/generation-routes.cjs:279`, `routes/debug-routes.cjs:179`, `:491`, `metrics/prometheus.js:270`, `helpers/redis-helpers.cjs:490` (владелец — константа `orch:runtime/active-scenes-index.js:11`).
- Литерал `animastor:layer-config:{book}` читается напрямую в трёх файлах пакета (`orch:runtime/command-gate.js:56`, `scene-window.js:219`, `reconciliation-engine.js:685`) в обход сервиса `services/layer-config.js:43` (и порта LayerConfigPort).
- Без TTL (при наличии book_id): `asset-state`, `audio-orch`/`video-orch`, `chunk`/`chunks`, `book-scenes`, `layer-config`, `generation:cancel`.
- Backend мутирует очереди хаба (`routes/worker-routes.cjs:146–165`, `drainPolicyLane`) — в реестре это отмечено как DEBT (`backend/tests/architecture/redis-registry.js`, запись `animastor:queue:*`).

### 4.5 Приложение: все 108 семейств (литералы в backend/src и пакете оркестрации)

| Префикс | Вхождений литерала | Первые места (файл:строка) | В реестре (паттерн) |
|---|---|---|---|
| `animastor:active-scenes` | 9 | routes/generation-routes.cjs:279, routes/debug-routes.cjs:179, routes/debug-routes.cjs:491, helpers/redis-helpers.cjs:490 … | `animastor:active-scenes` |
| `animastor:ai-connector:hb` | 1 | routes/ai-connector-routes.cjs:98 | `animastor:ai-connector:hb:*` |
| `animastor:artifact-manifest` | 1 | helpers/queue-idempotency.cjs:1579 | `animastor:artifact-manifest:*` |
| `animastor:asset` | 1 | helpers/redis-helpers.cjs:462 | `animastor:asset:*` |
| `animastor:asset-state` | 3 | state/asset-state-store.js:15, helpers/redis-helpers.cjs:391, services/entity-cleanup.cjs:252 | `animastor:asset-state:*` |
| `animastor:assets` | 4 | services/entity-cleanup.cjs:253, storage/asset-registry.js:24, storage/asset-registry.js:307, storage/asset-registry.js:324 | `animastor:assets:*` |
| `animastor:audio-merge-lock` | 2 | audio/pipeline.js:217, orch:runtime/reconciliation-engine.js:912 | `animastor:audio-merge-lock:*` |
| `animastor:audio-orch` | 4 | helpers/redis-helpers.cjs:423, services/audio-orchestrator.js:48, services/cancel-scene-state.cjs:33, services/entity-cleanup.cjs:254 | `animastor:audio-orch:*` |
| `animastor:audio-scene-failsafe` | 1 | helpers/redis-helpers.cjs:426 | `animastor:audio-scene-failsafe:*` |
| `animastor:audio-scene-lock` | 5 | helpers/redis-helpers.cjs:425, audio/generation.js:243, config/runtime-config.js:129, services/entity-cleanup.cjs:256 … | `animastor:audio-scene-lock:*` |
| `animastor:book` | 1 | helpers/redis-helpers.cjs:460 | `animastor:book:*` |
| `animastor:book-scenes` | 4 | helpers/redis-helpers.cjs:421, config/runtime-config.js:219, orch:runtime/reconciliation-engine.js:2416, orch:runtime/scene-window.js:56 | `animastor:book-scenes:*` |
| `animastor:cancelled-workers` | 11 | routes/book/generation-routes.cjs:248, routes/book/generation-routes.cjs:249, routes/book/generation-routes.cjs:368, routes/book/import-routes.cjs:845 … | `animastor:cancelled-workers:*` |
| `animastor:chunk` | 27 | routes/book/progress-panel.cjs:94, helpers/redis-helpers.cjs:47, helpers/redis-helpers.cjs:52, helpers/redis-helpers.cjs:71 … | `animastor:chunk:*` |
| `animastor:chunks` | 14 | helpers/redis-helpers.cjs:48, helpers/redis-helpers.cjs:68, helpers/redis-helpers.cjs:385, audio/generation.js:222 … | `animastor:chunks:*` |
| `animastor:circuit` | 4 | orch:runtime/circuit-breaker.js:75, orch:runtime/circuit-breaker.js:82, orch:runtime/circuit-breaker.js:89, orch:runtime/circuit-breaker.js:96 | `animastor:circuit:*` |
| `animastor:cleanup-lock` | 4 | config/runtime-config.js:128, services/cleanup-service.cjs:87, services/cleanup-service.cjs:98, orch:runtime/reconciliation-engine.js:1749 | `animastor:cleanup-lock` |
| `animastor:dispatch-completed` | 1 | orch:runtime/dispatch-engine.js:104 | `animastor:dispatch-completed` |
| `animastor:dispatch-intent` | 1 | helpers/queue-idempotency.cjs:58 | `animastor:dispatch-intent:*` |
| `animastor:dispatch-lease` | 12 | backend.cjs:1009, helpers/redis-helpers.cjs:399, metrics/prometheus.js:218, config/runtime-config.js:120 … | `animastor:dispatch-lease:*` |
| `animastor:dispatch-meta` | 6 | helpers/redis-helpers.cjs:400, config/runtime-config.js:121, services/entity-cleanup.cjs:270, orch:runtime/counter-reconciliation.js:152 … | `animastor:dispatch-meta:*` |
| `animastor:dispatch-noprogress` | 1 | orch:runtime/command-gate.js:213 | **нет** |
| `animastor:dispatch-phantom-suspect` | 1 | orch:runtime/counter-reconciliation.js:154 | **нет** |
| `animastor:drift` | 1 | routes/debug-routes.cjs:272 | `animastor:drift:*` |
| `animastor:error` | 1 | orch:runtime/reconciliation-engine.js:2094 | `animastor:error:*` |
| `animastor:error-processed` | 3 | routes/generation-routes.cjs:718, services/entity-cleanup.cjs:268, services/entity-cleanup.cjs:346 | `animastor:error-processed:*` |
| `animastor:event-journal` | 4 | state/event-journal.js:79, helpers/redis-helpers.cjs:417, orch:runtime/reconciliation-engine.js:1617, orch:runtime/reconciliation-engine.js:1659 | `animastor:event-journal:*` |
| `animastor:failure` | 1 | routes/debug-routes.cjs:255 | `animastor:failure:*` |
| `animastor:fairness:book` | 1 | helpers/redis-helpers.cjs:414 | `animastor:fairness:*` |
| `animastor:fairness:retry-throttle` | 1 | helpers/redis-helpers.cjs:415 | `animastor:fairness:*` |
| `animastor:fairness:starvation-boost` | 1 | helpers/redis-helpers.cjs:413 | `animastor:fairness:*` |
| `animastor:fence-journal` | 1 | helpers/queue-idempotency.cjs:1580 | `animastor:fence-journal:*` |
| `animastor:fence-publish` | 1 | helpers/queue-idempotency.cjs:1611 | `animastor:fence-publish:*` |
| `animastor:fence-unrecoverable` | 1 | helpers/queue-idempotency.cjs:1680 | `animastor:fence-unrecoverable:*` |
| `animastor:force-dispatch-stages` | 1 | orch:runtime/command-gate.js:274 | **нет** |
| `animastor:gen-scope` | 2 | helpers/redis-helpers.cjs:393, services/gen-scope.js:15 | `animastor:gen-scope:*` |
| `animastor:generation-progress` | 2 | helpers/redis-helpers.cjs:395, services/generation-progress.js:16 | `animastor:generation-progress:*` |
| `animastor:generation:cancel` | 2 | helpers/redis-helpers.cjs:438, orch:runtime/scene-window.js:61 | `animastor:generation:cancel:*` |
| `animastor:gpu-hub:workers` | 1 | routes/worker-routes.cjs:422 | `animastor:gpu-hub:workers` |
| `animastor:gpu-retry` | 1 | services/gpu-retry-policy.cjs:56 | `animastor:gpu-retry:*` |
| `animastor:idempotency:claim` | 1 | helpers/queue-idempotency.cjs:48 | `animastor:idempotency:*` |
| `animastor:idempotency:done` | 1 | helpers/queue-idempotency.cjs:49 | `animastor:idempotency:*` |
| `animastor:idempotency:job-epoch` | 2 | helpers/queue-idempotency.cjs:51, helpers/redis-helpers.cjs:458 | `animastor:idempotency:*` |
| `animastor:idempotency:ref` | 1 | helpers/queue-idempotency.cjs:50 | `animastor:idempotency:*` |
| `animastor:idempotency:stage-epoch` | 1 | helpers/queue-idempotency.cjs:52 | `animastor:idempotency:*` |
| `animastor:intent` | 1 | helpers/queue-idempotency.cjs:57 | `animastor:intent:*` |
| `animastor:intent-lock` | 1 | helpers/queue-idempotency.cjs:59 | `animastor:intent-lock:*` |
| `animastor:iu` | 1 | helpers/redis-helpers.cjs:171 | `animastor:iu:*` |
| `animastor:iu-in-flight` | 6 | image/iu-processor.js:184, services/entity-cleanup.cjs:264, services/entity-cleanup.cjs:340, orch:orchestration/orchestrator.js:593 … | `animastor:iu-in-flight:*` |
| `animastor:iu-in-flight-index` | 1 | orch:runtime/dispatch-engine.js:116 | `animastor:iu-in-flight-index:*` |
| `animastor:iu-progress` | 5 | routes/book/iu-progress-utils.cjs:62, services/task-handler.cjs:519, services/entity-cleanup.cjs:258, orch:orchestration/orchestrator.js:584 … | `animastor:iu-progress:*` |
| `animastor:iu-progress-ids` | 3 | services/task-handler.cjs:520, services/entity-cleanup.cjs:259, orch:orchestration/orchestrator.js:587 | `animastor:iu-progress-ids:*` |
| `animastor:iu-registry` | 3 | config/runtime-config.js:133, services/entity-cleanup.cjs:263, services/entity-cleanup.cjs:339 | `animastor:iu-registry:*` |
| `animastor:job` | 12 | image/iu-processor.js:247, routes/debug-routes.cjs:225, routes/debug-routes.cjs:353, routes/debug-routes.cjs:399 … | `animastor:job:*` |
| `animastor:layer-config` | 7 | helpers/redis-helpers.cjs:397, services/layer-config.js:43, orch:runtime/reconciliation-engine.js:685, orch:runtime/command-gate.js:56 … | `animastor:layer-config:*` |
| `animastor:lease` | 3 | routes/debug-routes.cjs:208, routes/debug-routes.cjs:355, helpers/redis-helpers.cjs:463 | `animastor:lease:*` |
| `animastor:lease-heartbeat` | 1 | orch:runtime/lease-manager.js:124 | `animastor:lease-heartbeat:*` |
| `animastor:mode` | 2 | helpers/redis-helpers.cjs:164, helpers/redis-helpers.cjs:440 | `animastor:mode:*` |
| `animastor:pending-purge` | 1 | services/entity-cleanup.cjs:50 | `animastor:pending-purge` |
| `animastor:pending-purge-attempts` | 1 | services/entity-cleanup.cjs:51 | `animastor:pending-purge-attempts` |
| `animastor:progress` | 1 | services/progress-pubsub.cjs:13 | `animastor:progress:*` |
| `animastor:prompt-profiles` | 1 | services/profile-override.js:20 | `animastor:prompt-profiles` |
| `animastor:queue` | 3 | routes/worker-routes.cjs:147, routes/worker-routes.cjs:148, orch:runtime/counter-reconciliation.js:186 | `animastor:queue:*` |
| `animastor:regenerate-lock` | 1 | routes/book/generation-routes.cjs:469 | `animastor:regenerate-lock` |
| `animastor:result` | 6 | helpers/redis-helpers.cjs:434, services/audio-recovery.cjs:46, services/audio-recovery.cjs:97, services/entity-cleanup.cjs:266 … | `animastor:result:*` |
| `animastor:result-processed` | 9 | image/iu-processor.js:347, image/iu-processor.js:423, routes/generation-routes.cjs:509, helpers/queue-idempotency.cjs:1954 … | `animastor:result-processed:*` |
| `animastor:retry` | 1 | routes/debug-routes.cjs:289 | `animastor:retry:*` |
| `animastor:retry-budget` | 2 | helpers/redis-helpers.cjs:411, orch:runtime/retry-budget-manager.js:35 | `animastor:retry-budget:*` |
| `animastor:retry-budget:global` | 1 | orch:runtime/retry-budget-manager.js:39 | `animastor:retry-budget:*` |
| `animastor:retry-budget:type` | 1 | orch:runtime/retry-budget-manager.js:43 | `animastor:retry-budget:*` |
| `animastor:retry-budget:worker` | 1 | orch:runtime/retry-budget-manager.js:47 | `animastor:retry-budget:*` |
| `animastor:running` | 1 | orch:runtime/counter-reconciliation.js:183 | `animastor:running` |
| `animastor:runtime` | 1 | routes/debug-routes.cjs:195 | `animastor:runtime:*` |
| `animastor:runtime:active` | 3 | config/runtime-config.js:124, orch:runtime/counter-reconciliation.js:31, orch:runtime/dispatch-engine.js:105 | `animastor:runtime:active` |
| `animastor:runtime:active-` | 1 | metrics/prometheus.js:156 | `animastor:runtime:*` |
| `animastor:runtime:active-audio` | 6 | backend.cjs:998, routes/debug-routes.cjs:190, routes/debug-routes.cjs:488, routes/book/generation-routes.cjs:323 … | `animastor:runtime:*` |
| `animastor:runtime:active-image` | 6 | backend.cjs:999, routes/debug-routes.cjs:190, routes/debug-routes.cjs:489, routes/book/generation-routes.cjs:324 … | `animastor:runtime:*` |
| `animastor:runtime:active-video` | 6 | backend.cjs:1000, routes/debug-routes.cjs:191, routes/debug-routes.cjs:490, routes/book/generation-routes.cjs:325 … | `animastor:runtime:*` |
| `animastor:runtime:deferred` | 1 | orch:runtime/dispatch-engine.js:809 | `animastor:runtime:*` |
| `animastor:runtime:last-active` | 1 | orch:runtime/dispatch-engine.js:1217 | `animastor:runtime:*` |
| `animastor:runtime:metrics` | 7 | routes/debug-routes.cjs:172, routes/debug-routes.cjs:484, metrics/prometheus.js:196, config/runtime-config.js:139 … | `animastor:runtime:*` |
| `animastor:runtime:quotas` | 1 | routes/debug-routes.cjs:241 | `animastor:runtime:*` |
| `animastor:runtime:recovery` | 2 | orch:runtime/runtime-metrics.js:172, orch:runtime/runtime-metrics.js:323 | `animastor:runtime:*` |
| `animastor:runtime:renewal-timers` | 2 | orch:runtime/runtime-metrics.js:147, orch:runtime/lease-manager.js:125 | `animastor:runtime:*` |
| `animastor:runtime:retry` | 2 | helpers/redis-helpers.cjs:402, services/entity-cleanup.cjs:271 | `animastor:runtime:*` |
| `animastor:runtime:scheduler` | 3 | metrics/prometheus.js:242, orch:runtime/runtime-metrics.js:151, orch:runtime/runtime-metrics.js:312 | `animastor:runtime:*` |
| `animastor:runtime:scheduler-lock` | 2 | config/runtime-config.js:127, orch:runtime/dispatch-engine.js:125 | `animastor:runtime:*` |
| `animastor:runtime:stuck-scenes` | 1 | orch:runtime/runtime-metrics.js:350 | `animastor:runtime:*` |
| `animastor:runtime:total-completed` | 1 | routes/debug-routes.cjs:192 | `animastor:runtime:*` |
| `animastor:runtime:total-dispatched` | 1 | routes/debug-routes.cjs:191 | `animastor:runtime:*` |
| `animastor:runtime:total-failed` | 1 | routes/debug-routes.cjs:192 | `animastor:runtime:*` |
| `animastor:scene` | 1 | helpers/redis-helpers.cjs:464 | **нет** |
| `animastor:scene-audio-status` | 1 | helpers/redis-helpers.cjs:436 | `animastor:scene-audio-status:*` |
| `animastor:scene-heartbeat` | 1 | orch:runtime/reconciliation-engine.js:928 | `animastor:scene-heartbeat:*` |
| `animastor:scene-lock` | 1 | routes/debug-routes.cjs:397 | `animastor:scene-lock:*` |
| `animastor:scene-state` | 1 | helpers/redis-helpers.cjs:388 | **нет** |
| `animastor:scene-transition-lock` | 2 | config/runtime-config.js:117, orch:runtime/reconciliation-engine.js:913 | `animastor:scene-transition-lock:*` |
| `animastor:scene-video` | 5 | video/video-service.js:174, video/video-service.js:180, helpers/redis-helpers.cjs:419, config/runtime-config.js:136 … | `animastor:scene-video:*` |
| `animastor:scope` | 1 | helpers/redis-helpers.cjs:461 | `animastor:scope:*` |
| `animastor:snapshot` | 3 | routes/debug-routes.cjs:307, routes/debug-routes.cjs:307, helpers/redis-helpers.cjs:430 | `animastor:snapshot:*` |
| `animastor:vbook-scene-idx` | 4 | routes/book/agent-routes.cjs:107, routes/book/agent-routes.cjs:147, services/agent/pipeline-runner.js:386, services/agent/pipeline-runner.js:1062 | `animastor:vbook-scene-idx:*` |
| `animastor:video-book-merge-lock` | 2 | video/video-merge.js:494, video/video-merge.js:579 | `animastor:video-book-merge-lock:*` |
| `animastor:video-dedup` | 1 | routes/debug-routes.cjs:351 | `animastor:video-dedup:*` |
| `animastor:video-lock` | 4 | routes/debug-routes.cjs:349, helpers/redis-helpers.cjs:428, config/runtime-config.js:130, orch:runtime/reconciliation-engine.js:911 | `animastor:video-lock:*` |
| `animastor:video-merge-lock` | 1 | video/video-merge.js:393 | `animastor:video-merge-lock:*` |
| `animastor:video-orch` | 3 | services/cancel-scene-state.cjs:33, services/video-orchestrator.js:54, services/entity-cleanup.cjs:255 | `animastor:video-orch:*` |
| `animastor:worker-auth` | 1 | services/worker-auth.js:29 | `animastor:worker-auth` |
| `animastor:worker:heartbeat` | 1 | config/runtime-config.js:226 | `animastor:worker:heartbeat:*` |


## 5. GPU-хаб (animastor-gpu-hub)

Префиксы: `hub:` = `/home/animastor/src/animastor-gpu-hub/` (коммит `c9aa24f`; вся логика в `gpu-hub.js`, 2273 строки; `server.js` — 49 строк, запуск); backend — от `backend/src/`; `orch:` = `packages/animastor-orchestration/src/`. Версия протокола — `PROTOCOL_VERSION` из `@animastor/contracts`.jobProtocolV2 (`hub: gpu-hub.js:39`), проверяется в каждом эндпоинте.

### 5.1 API хаба

| Эндпоинт | hub: файл:строка | Кто вызывает | Аутентификация | Тело / query (вход) | Ответ / побочные эффекты |
|---|---|---|---|---|---|
| POST `/task` (поставить задачу) | `gpu-hub.js:882` | backend `runtime/gpu-dispatcher.js:513` (`sendUnified`, 3 попытки, abort 30 с, пауза 1 с) | `requireApiKey` (`gpu-hub.js:304`): заголовок `x-api-key` = `GPU_HUB_API_KEY`; без ключа — 503, если не `GPU_HUB_ALLOW_OPEN=1` | `job_id`, `params` (workflow), `job_type`, `assets` (`image` / `images` base64), `build_id`, `protocol_version`, `dispatch_id`, `book_id`, `chapter_id`, `scene_id`, `stage`, `workspace_id` (UUID или null), `timeout_ms`, `policy_id` (UUID, взаимоисключим с workspace_id) | dedup `animastor:job:{dispatch_id}:{job_id}` SET NX EX 3600 (`:949–950`, ключ `:424`); LPUSH в `queue:{type}` / `queue:{type}:ws:{ws}` / `queue:{type}:policy:{id}` (`:962`); `timeout_ms` = max(timeout_ms, `GPU_TIMEOUT_MS`) (`:960`); ответ `{ok}` или `{ok, duplicate:true}` |
| GET `/task/next` (pop) | `gpu-hub.js:1010` | воркер `worker.cjs:381` | `requireWorkerCredential` (`gpu-hub.js:176`): `Authorization: Bearer wrk.<b64 worker_id>.<b64 secret>` → sha256(secret) → HGET `animastor:worker-auth` (`:58`) | query `type` (сверяется с типом из учётных данных); `worker` в query игнорируется (id берётся из токена `:1018`) | RPOPLPUSH очередь → `animastor:processing` (`:1075`); проверка полосы (poison → dead-letter `:1117–1120`); HSET `animastor:running` `{worker, workspace_id, worker_mode, …, task_raw, started_at}` (`:1124`); heartbeat с `current_job_id` EX 30 (`:1184`); ответ `{task}` / `{task:null}` |
| POST `/task/result` | `gpu-hub.js:1198` | воркер `worker.cjs:715` | Bearer worker | `job_id`, `build_id`, `result_base64`, `dispatch_id`, `protocol_version` (+ `worker_version`, `worker_image_tag` — не читаются) | сверка с `animastor:running` по `dispatch_id` (иначе 409 `stale_or_unknown_dispatch`, `:568`) и по claimer (403 `not_task_claimer`); SET `animastor:result:{build}:{book}:{ch}:{sc}:{stage}` EX 3600 **до** отправки в backend (`:1255`); HDEL running, LREM processing; POST backend `/gpu/task/result` 5 попыток × 500 мс (`:1304`), тело + `worker_id`, `workspace_id`; при финальном ack — удаление result-ключа |
| POST `/task/error` | `gpu-hub.js:1355` | воркер `worker.cjs:765` | Bearer worker | `job_id`, `build_id`, `dispatch_id`, `protocol_version`, `reason`, опц. `error_class`, `comfy_status` | те же проверки; HDEL running, LREM processing, DEL dedup `animastor:job:…`; `notifyBackendError` (`:482`): POST `/gpu/task/error` 5 × 500 мс, при неудаче SET `animastor:error:{job_id}` EX 3600 (`:514`) |
| POST `/beacon` (heartbeat) | `gpu-hub.js:813` | воркер `worker.cjs:344`, каждые `BEACON_INTERVAL_MS` = 10 с (`worker.cjs:71`, `:785`) | Bearer worker | `gpu`, `vram`, `version`, `image_tag`, `protocol_version` (`id`, `type` из тела игнорируются — берутся из токена) | HSET `animastor:gpu-hub:workers` + EXPIRE 900 на весь hash (`:352`); SET `animastor:worker:heartbeat:{type}:{id}` EX 30 |
| DELETE `/queue/clear` (отмена) | `gpu-hub.js:2052` | backend: `routes/book/generation-routes.cjs:406/411/446` (`?book_id=`); `orch:runtime/dispatch-engine.js:1741` (`?book_id=`), `:1776` (`?dispatch_id=`) через `storage/hub-cancel-adapter.js`; `routes/book/cache-routes.cjs:143`, `:181`; `services/book-deletion.cjs:228`, `:260` | `requireApiKey` | query `book_id` \| `dispatch_id` \| `workspace_id`; **без параметров — полная очистка всех очередей, running, processing, `result:*`, `job:*`** (`:2159–2193`) | фильтрация очередей (DEL + RPUSH остатка), `running` (HSCAN), `result:*`, dedup; ответ `{ok, scope, removed:{queued,processing,running,results,dedup}}` |
| GET `/health`, `/worker-source`, `/worker-bundle[/sha256]`, `/workflow/:id`, `/installer[...]` | `gpu-hub.js:2025`, `:1448`, `:1639`, `:1662`, `:1719`, `:1818`, `:1989`, `:2006` | установка/обновление воркера | — | — | не участвуют в генерации |

Хаб→backend: заголовок `x-api-key` (если ключ задан, `gpu-hub.js:321`); backend проверяет его в `requireHubCallbackAuth` (`routes/generation-routes.cjs:54`), без ключа — открыт.

### 5.2 Redis-ключи хаба

| Ключ | Тип | TTL | hub: где |
|---|---|---|---|
| `animastor:queue:{type}` / `:ws:{workspace_id}` / `:policy:{policy_id}` | list | нет | `gpu-hub.js:372–385` |
| `animastor:processing` | list (сырые задачи после pop) | нет | `:1049` |
| `animastor:processing-claimed` | hash (job_id → first_seen) | нет | `:49` |
| `animastor:running` | hash (job_id → JSON с worker, dispatch_id, task_raw, started_at…) | нет | `:1080` |
| `animastor:dead-letter` | list | 7 сут | `:51`, `:403–410` |
| `animastor:job:{dispatch_id}:{job_id}` (dedup приёма) | string | 3600 с | `:424`, `:930` |
| `animastor:result:{build}:{book}:{ch}:{sc}:{stage}` | string (JSON с result_base64) | 3600 с | `:1255` |
| `animastor:error:{job_id}` | string | 3600 с | `:514` |
| `animastor:stale-dispatch-signal:…` | string | 3600 с (`STALE_SIGNAL_TTL_S`) | `:549–550` |
| `animastor:gpu-hub:workers` | hash (worker_id → JSON) | 900 с на весь hash | `:331`, `:352` |
| `animastor:worker:heartbeat:{type}:{worker_id}` | string (JSON) | 30 с | `/beacon`, `/task/next`, result/error, sweep (`:634`) |
| `animastor:worker-auth` | hash (sha256(secret) → identity) | — | читается `:58`; пишет backend `services/worker-auth.js` |

### 5.3 Выбор воркера (pop-модель)

Хаб не назначает задачу воркеру — воркер забирает её из полосы своего типа:

- Полоса задачи решается **в backend** (`runtime/gpu-dispatcher.js:213–222`): книга → `books.workspace_id`; если у workspace есть private-воркер этого типа → `workspace_id` (полоса `queue:{type}:ws:{ws}`); иначе, если есть grant users-политики → `policy_id` (полоса `queue:{type}:policy:{id}`); иначе системная `queue:{type}`.
- Pop (`gpu-hub.js:1071–1105`): тип — только из учётных данных; `mode='private'` → своя ws-полоса, иначе (`share`/`system`) — системная; private-воркер с активной share-политикой, если своя полоса пуста, «одалживает» системную (public) или полосу своей политики (users).
- Проверка соответствия полосы и задачи после pop (`:1109–1121`), несоответствие → `animastor:dead-letter`.

### 5.4 Если воркер пропал

Цикл `setInterval` 10 с (`gpu-hub.js:799`): `heartbeatAndTimeoutSweep` (`:589`) + `sweepProcessingOrphans` (`:728`).

| Ситуация | Условие | Действие |
|---|---|---|
| Задача дольше таймаута | `now - started_at > timeout_ms` (по умолчанию `GPU_TIMEOUT_MS` = 600 000, `gpu-hub.js:231`) | HDEL running, LREM processing, DEL dedup, `notifyBackendError(reason="worker_timeout")` — задача **не** возвращается в очередь хабом; повтор решает backend (`services/gpu-retry-policy.cjs`) |
| Воркер не шлёт beacon | `now - gpu.last_seen > GPU_TIMEOUT_MS` | для его незавершённых задач — то же `worker_timeout`; запись воркера удаляется из `gpu-hub:workers` |
| Пока задача выполняется | для каждой записи `running` | хаб сам продлевает heartbeat воркера EX 30 с `current_job_id` (`:594–634`) — воркер «жив» по Redis, пока жив хаб и запись running |
| Задача в `processing` без записи в `running` (pop без HSET, падение хаба) | дольше `ORPHAN_GRACE_MS` = 60 с (`:54`) | LPUSH обратно в свою полосу, `orphan_requeues+1`; при `MAX_ORPHAN_REQUEUES` = 3 (`:57`) — dead-letter + `notifyBackendError("orphaned_task")` |

### Странности (раздел 5)

- Результат хранится одновременно: `animastor:result:*` в Redis (хаб, 1 ч), тело POST в backend, staging/канон на диске backend (раздел 8). Reconcile backend переигрывает `result:*` (`orch:runtime/reconciliation-engine.js:2009`), хаб удаляет ключ только после «финального» ack.
- `DELETE /queue/clear` без параметров стирает всё у всех пользователей (`gpu-hub.js:2152–2176`); защищён только API-ключом.
- Backend напрямую меняет очереди хаба (`routes/worker-routes.cjs:146–165`), минуя API хаба.
- Хаб продлевает heartbeat воркеру по записи `running` без участия воркера (`gpu-hub.js:594–634`), поэтому «онлайн» в Redis/PG может держаться до истечения таймаута задачи (до 10 мин по умолчанию, для видео дольше) после реального падения воркера.
- Выполнение задачи отслеживается дважды: dispatch-lease/meta в backend (TTL по стадии, renewal 30 с) и `animastor:running` + `timeout_ms` в хабе — с разными часами и таймаутами.
- `/task/next?worker=…` и `id`/`type` в теле beacon воркер шлёт (`worker.cjs:345–346`, `:381`), хаб их игнорирует.


## 6. Воркер (animastor-worker)

Префикс: `worker:` = `/home/animastor/src/animastor-worker/packages/animastor-worker/worker/` (коммит `c34c4ea`; `worker.cjs` 975 строк, версия v2.3.0 по заголовку `:2`).

### 6.1 Что получает (job из `/task/next`)

Поля задачи — ровно то, что backend отправил в `/task` (раздел 5.1) плюс то, что добавил хаб: `job_id`, `params` (ComfyUI workflow), `job_type`, `assets` (`image` — base64, `images` — map unit_id → base64), `build_id`, `protocol_version`, `book_id`, `chapter_id`, `scene_id`, `stage`, `dispatch_id`, `workspace_id`, `policy_id`, `timeout_ms`, (`orphan_requeues` после requeue). Воркер использует: `protocol_version` и `dispatch_id` (иначе отказ с `error_class:"deterministic"`, `worker.cjs:803–808`), `assets.images`/`assets.image` (пишет в `COMFY_INPUT_DIR`, `:834`, `:848`), `params` (`runWorkflow`, `:860`), `timeout_ms` (`waitResult`, `:863`), `job_id`/`build_id`/`dispatch_id` (ответ). `book_id`/`workspace_id`/`policy_id` воркер не читает.

### 6.2 Что отправляет

| Куда | worker: строка | Поля |
|---|---|---|
| POST hub `/task/result` | `worker.cjs:713–731` (`sendResult`) | `job_id`, `build_id`, `dispatch_id`, `protocol_version`, `result_base64`, `worker_version`, `worker_image_tag` |
| POST hub `/task/error` | `worker.cjs:752–776` (`sendTaskError`) | `job_id`, `build_id`, `dispatch_id`, `protocol_version`, `reason` (≤500 символов), `worker_version`, `worker_image_tag`, опц. `error_class`, `comfy_status` |
| POST hub `/beacon` | `worker.cjs:340–365` | `id`, `type`, `gpu`, `vram`, `version`, `image_tag`, `protocol_version` |
| Заголовок | `worker.cjs:107–110` | `Authorization: Bearer ${ANIMASTOR_WORKER_TOKEN}` |

### 6.3 Передача файла результата

**В теле JSON, base64 data-URI.** `downloadResult` (`worker.cjs:667`): аудио — `data:audio/mp3;base64,…`; прочее — читает файл из `COMFY_OUTPUT_DIR` и кодирует `data:{mime};base64,…` (предупреждение при >50 МБ), иначе скачивает с ComfyUI `/view` и кодирует. Хаб пересылает ту же строку в backend `/gpu/task/result` (`result_base64`). URL-загрузки нет.

### 6.4 Повторы, таймауты, heartbeat

| Параметр | Значение | worker: строка |
|---|---|---|
| Таймаут HTTP к хабу | 30 000 мс (`fetchTimeout` по умолчанию) | `:89` |
| Повтор отправки result/error | нет: одна попытка; при неуспехе исключение → лог (`:887–893`); output-файл не удаляется, если доставка не прошла (`outputDelivered`) | `:713`, `:883–900` |
| Ожидание результата ComfyUI | `task.timeout_ms`, иначе `RESULT_TIMEOUT_MS` = 600 000 / `VIDEO_RESULT_TIMEOUT_MS` = 7 200 000 | `:63`, `:69`, `:547` |
| Пустая очередь | пауза `TASK_SLEEP_MS` = 2000, удвоение до 15 000 мс | `:70`, `:779`, `:796` |
| Готовность ComfyUI | backoff 1→30 с | `:211–229` |
| Heartbeat | `/beacon` каждые 10 с (`BEACON_INTERVAL_MS`) | `:71`, `:785` |
| Ошибка аутентификации (401/403) | `process.exit(1)` | `:116–120` |
| Повтор задачи после ошибки | воркер не повторяет; решение — backend `services/gpu-retry-policy.cjs:50–53` | — |

### Странности (раздел 6)

- Результат (до сотен МБ для видео) проходит три JSON-хопа целиком в памяти: воркер → хаб (base64) → Redis `animastor:result:*` (копия) → backend (base64), `worker.cjs:686`, `hub: gpu-hub.js:1255`, `backend/src/routes/generation-routes.cjs:433`.
- Три независимых таймаута одной задачи: воркер (`timeout_ms` / 600 с / 7200 с), хаб (`max(timeout_ms, GPU_TIMEOUT_MS)`), backend lease по стадии.
- `WORKER_ID` из env (`worker.cjs:52`) уходит в query/beacon, но идентичность определяется только токеном на стороне хаба.


## 7. Фронты: вызовы генерационных эндпоинтов

Префиксы: `web:` = `/home/animastor/src/animastor-web/` (коммит `d9cb135`; `frontends/app/src` + `packages/*/src`, без dist и тестов; пути API относительно `/api/v1`); `and:` = `/home/animastor/src/animastor-android/frontends/android/app/src/main/java/com/example/animastor/` (коммит `be1233c`).

### 7.1 Web

| Эндпоинт | Вызов (web:) | UI-действие | Читаемые поля ответа |
|---|---|---|---|
| POST `/book/import` | `frontends/app/src/state/fileStore.ts:189` | выбор файла книги | `ImportResponse` |
| PUT `/book/:id/layer-config` | `frontends/app/src/state/generateStore.ts:347` (`layerSync`, через `setAudioEnabled/…:357–359`); `frontends/app/src/pages/SettingsPage.tsx:562`, `:575`, `:589`, `:811`; `packages/animastor-web-generator-config/src/index.ts:79` | тумблеры слоёв `GeneratePage.tsx:391`, `:410`, `:429`; настройки chunk_size / analysis_mode | конфиг слоёв |
| GET `/book/:id/layer-config` | `generateStore.ts:361` (`loadLayerConfig`); `SettingsPage.tsx:542`, `:768`; `generator-config/src/index.ts:53` | открытие экрана | `audio_enabled`, `image_enabled`, `video_enabled`, `chunk_size`, `analysis_*` |
| POST `/book/:id/regenerate` | `generateStore.ts:654` (`startGeneration:640`; `retryStoppedTask:698` → `:701`) | кнопки генерации `GeneratePage.tsx:463`; ▶ в строке `GeneratePage.tsx:730` | тело: `rebuild_all:true`, `worker_types`, `scope`, `chapter_id`, `scene_id`, `client_action`; читает `res.build_id`, `res.summary`, `res.dirty_scenes`, `res.scope` (`generateStore.ts:667–672`) |
| POST `/book/:id/cancel-generation` | `generateStore.ts:754` (`cancelGeneration:804`) | «Стоп всё» `GeneratePage.tsx:247` | — |
| POST `/book/:id/cancel-worker` | `generateStore.ts:828` (`cancelTask:820`; `dismissStoppedTask:848`) | стоп секции `GeneratePage.tsx:267`; ■ в строке `GeneratePage.tsx:482`; «Снять» `GeneratePage.tsx:700` | `ok`, `task_ids` |
| GET `/book/:id/progress-panel` | `generateStore.ts:866` (`checkAndRestoreGenerationState:860`, запуск `GeneratePage.tsx:129`); `GeneratePage.tsx:179` (опрос) | открытие страницы, периодический опрос | `tasks[]`: `task_id`, `type`, `scope`, `ready`, `total`, `percent`, `done`, `cancelled`, `status`, `blocked`, `interrupted`, `failed`, `indeterminate`, `retrying`, ярлыки сцен; `any_incomplete` (`packages/animastor-web-generator/src/models.ts:11–68`) |
| GET `/worker/counts` | `generateStore.ts:867`; `GeneratePage.tsx:160`; `SettingsPage.tsx:772`; `packages/animastor-web-workers/src/WorkerSharingUI.tsx:518` | экран генерации / настройки | счётчики `available_*`, `active_*`, `vbook`, `active_vbook` |
| SSE `/book/:id/progress-stream` | `generateStore.ts:553` (`startProgressStream:561`, вызовы `:652`, `:876`) | после команды генерации / восстановления | поля `ProgressEvent` (`packages/animastor-web-generator/src/models.ts:73–100`); маршрутизация `packages/animastor-web-generator/src/sseRouting.ts:32–60`: обрабатываются только `type` = `vbook`, `analysis`, `generation_complete` (пустая ветка), `import_complete` |
| GET `/book/:id/agent-status` | `packages/animastor-web-generator-vbook/src/index.ts:201`, `:271`, `:317`, `:391` (через `generateStore.ts:507`) | VBook-генерация, опрос раз в 2 с (`web:packages/animastor-web-generator-vbook/src/index.ts:161`) | `step_type`, окна сцен, `progress_msg` |
| POST `/book/:id/bootstrap` / `bootstrap-next-window` | `packages/animastor-web-generator-vbook/src/index.ts:375`, `:377` (`startVBookGeneration`, `generateStore.ts:512`) | кнопка VBook `GeneratePage.tsx:251` | — |

### 7.2 Android

| Эндпоинт | Retrofit (and:) | Вызов → UI | Поля |
|---|---|---|---|
| POST `/book/import` | `repository/BackendApi.kt:10` `importBook` | `ui/GenerateViewModel.kt:969` (`importBookFromFile:945`) | — |
| GET `/worker/counts` | `BackendApi.kt:107` | `ui/GenerateViewModel.kt:173`; `ui/GenerateFragment.kt:229`; `ui/WorkerSettingsFragment.kt:115`; `ui/PrivateWorkersFragment.kt:372` | счётчики воркеров |
| POST `/book/:id/regenerate` | `BackendApi.kt:305` `regenerateBook` (тело с `new_book`, `rebuild_all`, `repository/Repository.kt:466`), `:311` `regenerateBookScoped` | только scoped: `ui/GenerateViewModel.kt:573` (`startGeneration:529`) ← кнопки `ui/GenerateFragment.kt:140–150`, ▶ строки `:1138` | ожидает `build_id` (`GenerateViewModel.kt:597`) |
| GET/PUT `/book/:id/layer-config` | `BackendApi.kt:317`, `:322` | GET `GenerateViewModel.kt:455`, `ui/VBookSettingsFragment.kt:120`, `ui/WorkerSettingsFragment.kt:248`; PUT `GenerateViewModel.kt:389`, `:401`, `:504`, `VBookSettingsFragment.kt:67` | конфиг слоёв, `analysis_mode`, `analysis_parallelism` |
| POST `/book/:id/cancel-generation` | `BackendApi.kt:357` | `GenerateViewModel.kt:917` (`cancelGeneration:902`); `GenerateFragment.kt:1004` (`onStopAllClicked:1002`, кнопка `:141`) | — |
| POST `/book/:id/cancel-worker` | `BackendApi.kt:362` | `GenerateViewModel.kt:1780` (`cancelTask:1759`) ← стоп секций `GenerateFragment.kt:144–150`, ■ `:1148` | — |
| POST `/book/:id/bootstrap`, `bootstrap-next-window`; GET `agent-status` | `BackendApi.kt:441`, `:451`, `:446` | `GenerateViewModel.kt:749`, `:752`, `:770` (`startVBookGeneration:711`); опрос `:1215` | `step_type`, окна сцен |
| GET `/book/:id/progress-panel` | `BackendApi.kt:475` | `GenerateViewModel.kt:172`; `GenerateFragment.kt:425` | строки задач (как web) |
| SSE `/book/:id/progress-stream` | `network/ProgressStream.kt:164` | `GenerateViewModel.kt` ~`:1700–1730` | `data class ProgressEvent` `network/ProgressStream.kt:34–68`; ветки `vbook`, `generation_complete` (`GenerateViewModel.kt:1721`), `import_complete` |
| POST `resume-bootstrap`, `trigger-next-window`; GET `generation-state` | `BackendApi.kt:456`, `:469`, `:483` | вызовов из UI/ViewModel нет | — |

### 7.3 Эндпоинты раздела 1 без вызовов из web и Android

`POST /api/v1/generate`, `POST /book/:id/generate-next`, `POST /book/load-vbook`, `POST /book/import-txt`, `POST /book/:id/resume-bootstrap`, `POST /book/:id/trigger-next-window`, `POST /book/:id/recover-placeholders`, `GET /book/:id/generation-state`, `GET /worker/status` — в `web:frontends/app/src`, `web:packages/*/src` и Android-коде (кроме неиспользуемых Retrofit-деклараций) вызовов не найдено (`grep` по путям).

### Странности (раздел 7)

- Оба фронта читают `build_id` из ответа `/regenerate` (`web:frontends/app/src/state/generateStore.ts:667`, `and:ui/GenerateViewModel.kt:597`), web также `summary`; backend эти поля не возвращает (`backend/src/routes/book/generation-routes.cjs:937–948`: `book_id, scope, dirty_scenes, marked, skipped_worker_types, tasks`).
- Android `regenerateBook` шлёт `new_book` (`and:repository/Repository.kt:466`), backend это поле не читает (`backend/src/routes/book/generation-routes.cjs:491–497`); метод не вызывается.
- SSE-события прогресса изображений от `backend/src/services/task-handler.cjs:529` (`{layer, chapterId, sceneId, ready}` без `type`) фронтами игнорируются: web маршрутизирует только по `type` (`web:packages/animastor-web-generator/src/sseRouting.ts:39–59`); фактический прогресс берётся опросом `progress-panel`.
- Событие `{type:"generation_complete"}` публикует пакет оркестрации через порт (`packages/animastor-orchestration/src/orchestration/scene-callbacks.js:526`, `:590`), но в web ветка для него пустая (`sseRouting.ts:54`) — завершение определяется только опросом `progress-panel`.


## 8. Файлы в data/output

Корень: `OUTPUT_DIR` = env `OUTPUT_DIR` \| `${DATA_ROOT}/output` \| `/data/output` (`backend/src/config/runtime-config.js:80`). Структура: `{OUTPUT_DIR}/{build_id}/…`. Имена — единственный владелец `packages/animastor-generation/src/core/artifact-naming.js` (далее `naming:`).

### 8.1 Имена файлов

| Артефакт | Шаблон | naming: |
|---|---|---|
| префикс сцены | `{book}_{chapter}_{scene}` | `:37` |
| аудио сцены | `{prefix}.mp3` | `:42` |
| чанк аудио | `{prefix}_{NNNN}.mp3` (4 цифры) | `:47` |
| изображение IU | `{prefix}_{unit_id}.png` (IU-префикс `{prefix}_iu`) | `:52`, `:98` |
| базовое изображение сцены | `{prefix}.png` | `:57` |
| превью | `{prefix}_pr{unit}.png` | `:62` |
| группа видео | `{prefix}{group_suffix}.mp4` | `:68` |
| видео сцены / книги | `{prefix}.mp4` / `{book}.mp4` | `:73`, `:78` |
| аудио книги | `{book}.mp3` | `:83` |
| sidecar заглушки | `{audio}.placeholder.json` (`kind: animastor-placeholder`) | `backend/src/audio/placeholder-marker.js:29–32` |
| staging результата | `{build}/.staging/{enc(job_id)}/{fence}/artifact` + `.previous-canonical` (откат) | `backend/src/services/result-publication.cjs:67–69`, `:86`, `:306–311` |
| versioned IU-изображение (флаг) | финал `{build}/.versions/{asset}/{fence}.png`, staging `{build}/.staging/{asset}/{fence}.{attempt}.tmp` | `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js:156`, `:179` |

### 8.2 Кто создаёт / переименовывает

| Путь записи | Где | Как |
|---|---|---|
| Результат GPU с fence (основной) | `backend/src/services/task-handler.cjs:424` → `services/result-publication.cjs:821` (`commitFencedResult`), `:334` (`stageResult`: tmp → fsync → rename в fence-dir), `:386` (`publishStaged`: атомарный rename staged → канон), `:471` (`publishCommittedFence`) | маркер `renaming` до rename и `published` после; канон заменяется только после атомарного commit fence в Redis (Lua, `helpers/queue-idempotency.cjs`) |
| Результат GPU без fence (`RESULT_FENCING_MODE=off`) | `backend/src/services/task-handler.cjs:489` | прямой `fs.writeFileSync(asset.fullPath)` |
| Versioned IU-изображение | `backend/src/services/task-handler.cjs:103` (`publishVersionedIuImage`), запись tmp `:180`, rename + указатель PG `iu_image_pointers` (`:231`) | под флагом `versionedEnabled` |
| Превью | `backend/src/services/task-handler.cjs:262–264` | |
| Заглушка-тишина + sidecar | `backend/src/audio/silence.js:88` (`writePlaceholderMarker`), `backend/src/audio/pipeline.js:104`, `:156`; создатель — `services/placeholder-audio.js` (`ensureAllPlaceholderAudio`, импорт `routes/book/import-routes.cjs:294`) | sidecar снимается при публикации реального аудио: `clearPlaceholderMarker` `services/audio-orchestrator.js:374` |
| Склейка аудио сцены из чанков | `backend/src/audio/pipeline.js`, `audio/generation.js` | tmp-файлы удаляются: `pipeline.js:194`, `generation.js:192` (rmSync каталога) |
| Склейка видео | `backend/src/video/video-merge.js` | concat-list и временные файлы удаляются `:109`, `:144`, `:294`, `:422`, `:470`, `:546`, `:570` |
| Снимок книги | `backend/src/services/task-handler.cjs:693` (`saveBookSnapshot`) | |
| Lock-каталоги публикации | `backend/src/services/publication-lock.cjs` (rmSync `:299`, `:379`, `:501`, `:588`) | |

### 8.3 Кто удаляет

| Что | Где |
|---|---|
| Весь каталог build | `backend/src/services/cleanup-service.cjs:70` (`cleanupBuild:56`); `backend/src/services/book-deletion.cjs:133`; `backend/src/routes/book/cache-routes.cjs:61` |
| Записи книги в каталогах | `backend/src/services/book-deletion.cjs:115` (snapshot), `:140` |
| Файлы сцены / IU (удаление сущности) | `backend/src/services/entity-cleanup.cjs:182`, `:203` |
| Устаревшие PNG перед регенерацией | `packages/animastor-orchestration/src/orchestration/orchestrator.js:569–572` (`resetScenes`, `cleanPngUnitIds`); `backend/src/image/iu-processor.js:290`, `:302` |
| Чанки аудио | `backend/src/services/audio-orchestrator.js:326`, `:446`; `backend/src/audio/generation.js:527` |
| Существующая заглушка при замене | `backend/src/services/placeholder-audio.js:409` |
| Staging: отброшенный fence / GC старше 24 ч | `backend/src/services/result-publication.cjs:758` (`discardStagedFence`), `:1031` (`collectStaleStaging`, `STAGING_MAX_AGE_MS` `:88`, вызов из reconcile `backend/src/runtime/runtime-loop.js:169`) |
| Versioned tmp при ошибке | `backend/src/services/task-handler.cjs:224` |
| Прочее | `packages/animastor-orchestration/src/orchestration/scene-orchestrator.js:627`, `scene-restoration.js:65`; `backend/src/storage/filesystem-store.js:105`, `:120` |

### Странности (раздел 8)

- Две ветки записи результата: через staging + атомарный rename (`services/task-handler.cjs:424`) и прямой `writeFileSync` поверх канона (`:489`) при `RESULT_FENCING_MODE=off`; ещё отдельная третья для versioned IU (`:103`).
- Признак «заглушка» хранится в файле-sidecar (`.placeholder.json`), в Redis chunk (`audio_status:'placeholder'`, `routes/book/import-routes.cjs:286`) и в PG `scene_assets.status='placeholder'` (`schema.js:589`, upsert из `services/placeholder-audio.js:248–440`).
- Каталог build удаляется из трёх мест с разной логикой (`cleanup-service.cjs:70`, `book-deletion.cjs:133`, `cache-routes.cjs:61`); `cleanupService` в debug-routes используется только как источник `stats` (`routes/debug-routes.cjs:21`), а комментарий `backend.cjs:951` говорит, что reconciliation его заменяет.
- `routes/book/generation-routes.cjs:676–686` (обложка в /regenerate) определяет «готовность» обложки по количеству `*.png` с префиксом `{book}_{ch}_{sc}_iu` в каталоге build — параллельно PG/Redis-состоянию.


## 9. Пользователи: user_id / workspace_id по цепочке

Префиксы как в разделах 1–6 (`backend/src/…`, `orch:`, `hub:`, `worker:`).

| Звено | Есть ли идентичность | Поле / источник | файл:строка |
|---|---|---|---|
| HTTP-команда (/regenerate, cancel-*, layer-config, progress-*) | доступ проверяется по workspace, user_id дальше не передаётся | middleware `requireBookAccess('bookId')` на `/api/v1/book/:bookId/*` (кроме import/import-txt/import-text/load-vbook/blank); `req.user`, `req.workspace` из `authContext` | `backend/src/backend.cjs:344`, `:372–377`; `backend/src/middleware/auth-context.js:208` |
| /regenerate → workspace задачи | workspace_id **из книги**, не из запроса | `bookRepo.getWorkspaceId(bookId)` | `backend/src/routes/book/generation-routes.cjs:894–899` |
| Реестр задач Redis `animastor:generation-progress:{book}` | нет user_id / workspace_id | `createTasks(redis, bookId, workerTypes, scope, dirtyScenes)` | `backend/src/services/generation-progress.js:30` |
| PG `generation_tasks` | `workspace_id` (UUID, FK), `worker_id`; **user_id нет** | `createTask(…, taskWorkspaceId)`; `recordTaskClaim(…, workerId, workspaceId)` | `backend/src/storage/postgres/schema.js:241–242`; `backend/src/routes/book/generation-routes.cjs:904–916`; `backend/src/routes/generation-routes.cjs:94` |
| PG `books` | `workspace_id`, `user_id` (колонка есть, записи в неё нет: INSERT без user_id `repositories/book-repo.js:7–8`, других INSERT/UPDATE с user_id не найдено) | | `backend/src/storage/postgres/schema.js:141–142` |
| PG `scene_assets`, `scenes`, Redis asset-state / leases / chunks / active-index | нет user_id / workspace_id (только book_id) | | разделы 3, 4 |
| Dispatch backend → хаб (`POST /task`) | `workspace_id` или `policy_id` (полоса); user_id нет | `resolveWorkspaceForBook` (кэш 60 с `backend/src/runtime/gpu-dispatcher.js:58`) → private-воркер workspace → ws-полоса, иначе grant → policy-полоса, иначе системная | `backend/src/runtime/gpu-dispatcher.js:76`, `:213–222`, `:237–255` |
| Хаб: очередь | ключ полосы `queue:{type}:ws:{workspace_id}` / `:policy:{policy_id}`; в теле задачи `workspace_id`, `policy_id` | | `hub: gpu-hub.js:372–385`, `:962` |
| Хаб: pop | идентичность воркера из токена: `worker_id`, `workspace_id`, `mode`, `share_policy` | `authenticateWorkerMirror` → HGET `animastor:worker-auth` | `hub: gpu-hub.js:54–70`, `:1071–1075` |
| Хаб: `animastor:running` | `worker`, `workspace_id` (задачи), `worker_mode`, `worker_workspace_id`, `worker_share_policy` | | `hub: gpu-hub.js:1124` |
| Воркер | получает `workspace_id`/`policy_id` в задаче, **не использует**; в result/error их не шлёт | | `worker: worker.cjs:713–731`, `:752–776` |
| Хаб → backend колбэк | `worker_id`, `workspace_id` (из записи running) | | `hub: gpu-hub.js:1304`, `:482–499` |
| Backend приём колбэка | `workspace_id` только для аудита: сверка с `books.workspace_id` (несовпадение → 403; null принимается) | `verifyCallbackWorkspace`, `persistTaskClaim` | `backend/src/routes/generation-routes.cjs:71–98`, `:458–463`, `:696–701` |
| Публикация (файлы, scene_assets, Redis) | нет user_id / workspace_id; путь `{OUTPUT_DIR}/{build}/{book}_…` | | раздел 8 |
| SSE progress-stream | канал `animastor:progress:{book}`; доступ — через `requireBookAccess` на `/api/v1/book/:bookId/*` | | `backend/src/routes/generation-routes.cjs:372`, `backend/src/services/progress-pubsub.cjs:13` |
| `GET /worker/counts` | `req.workspace.id` для private-счётчиков (гостям — нули) | | `backend/src/routes/generation-routes.cjs:274–277` |

**Где теряется:** user_id не проходит дальше HTTP-слоя (нет ни в Redis-реестре задач, ни в `generation_tasks`, ни в задаче хаба). workspace_id отсутствует в Redis-состоянии backend (реестр задач, leases, asset-state) и в результатах публикации; в задаче хаба он есть только как признак полосы. Колбэки `/gpu/task/*` аутентифицируются общим API-ключом хаба, а не пользователем.

### Странности (раздел 9)

- `books.user_id` существует в схеме (`schema.js:142`), но не заполняется ни одним INSERT/UPDATE.
- workspace книги кэшируется в диспетчере на 60 с (`backend/src/runtime/gpu-dispatcher.js:58`), а в /regenerate читается из PG напрямую (`routes/book/generation-routes.cjs:896`) — смена владельца книги в течение минуты даёт разные workspace_id в `generation_tasks` и в задаче хаба.
- Колбэк с `workspace_id = null` принимается для любой книги (`routes/generation-routes.cjs:66–67`, `:84`) — проверка срабатывает только при непустом значении.
- `/gpu/task/result|error` открыты без ключа, если `GPU_HUB_API_KEY` не задан (`routes/generation-routes.cjs:55`); хаб в той же ситуации `/task` и `/queue/clear` закрывает (503, `hub: gpu-hub.js:304–307`).


## 10. Классификация файлов backend/src

Список: `cd backend && (rg -il "dispatch|lease|fence|reconcile|orchestrat|scene-window|asset-state|generation_tasks|scene_assets|layer-config|regenerate|cancel" src; rg -l "@animastor/orchestration" src) | sort -u` → **99 файлов, 37 753 строки** (первый `rg` даёт 99, второй — 12, все 12 уже входят в первый список). Важно: регистронезависимое `lease` совпадает с `release`, а `cancel` — с отменой HTTP-запросов, поэтому в список попадают нерелевантные файлы (например, `storage/postgres/repositories/workspace-repo.js` — одно совпадение `lease`, `services/ai-connector/transport.js` — 26 × `cancel`).

Категории: **A** — оркестрация (статусы, очереди, повторы, циклы, отправка на хаб, приём результата); **B** — медиа/домен (workflow/промпты, склейка, данные книги, VBook-анализ, инфраструктура PG/AI, не связанная с очередями); **C** — смешанный. Импортёры — статические `require`/`import` с относительным путём по `backend/src` и `packages/*` (скрипт `s10tools/imp.js`, тесты исключены); `backend.cjs` подключает роуты как `require('./routes/x.cjs')(app, redis, deps)` — это тоже статический импорт. Пакет `@animastor/orchestration` подключается по имени пакета (12 файлов — `rg -l "@animastor/orchestration"`), в колонке импортёров не отражён.

Итого: **A = 41, B = 41, C = 17**.

| Файл (`backend/src/…`) | Строк | Кат. | Для C: функции A / B | Импортёры (статические, без тестов) |
|---|---|---|---|---|
| `audio/audio-service.js` | 90 | B |  | `audio/index.js:6` |
| `audio/chunks.js` | 88 | B |  | `audio/audio-service.js:25`, `audio/generation.js:16`, `audio/pipeline.js:12` (+2) |
| `audio/generation.js` | 753 | C | A: generateSceneAudio:239, sendPerSegmentAudio:494 (отправка через provider seam + idempotency); B: buildMergedDialogueWorkflow:54, trimPaddedSceneAudio:119, trimPaddedAudioBuffer:176, voiceForCharacter:229, mergeBookAudio:677 | `audio/audio-service.js:28` |
| `audio/pipeline.js` | 310 | B |  | `audio/audio-service.js:27` |
| `audio/placeholder-marker.js` | 117 | B |  | `audio/pipeline.js:16`, `audio/silence.js:13`, `audio/validation.js:12` (+2) |
| `audio/validation.js` | 197 | B |  | `audio/audio-service.js:24`, `audio/generation.js:15`, `audio/pipeline.js:11` (+1) |
| `backend.cjs` | 1135 | C | composition root: A — startup-хуки :931–1022, setInterval :866/:883; B — сборка deps/роутов | **нет** |
| `config/generation-config-adapter.js` | 38 | B |  | `backend.cjs:23` |
| `config/runtime-config.js` | 398 | C | A: TIMEOUTS/LEASE/ключи Redis :115–231; B: пути OUTPUT_DIR :80, HUB_URL :82 | `backend.cjs:158`, `backend.cjs:219`, `config/generation-config-adapter.js:23` (+31) |
| `contracts/runtime-result.js` | 23 | A |  | **нет** |
| `helpers/queue-idempotency.cjs` | 2252 | A |  | `audio/generation.js:20`, `audio/generation.js:474`, `backend.cjs:537` (+10) |
| `helpers/redis-helpers.cjs` | 515 | C | B: saveChunk/getChunk/getAllChunks :47–71; A: cleanBookRedisKeys :378 | `backend.cjs:446` |
| `image/iu-processor.js` | 492 | C | A: checkInFlightMarker:51, processSingleIU:177 (in-flight маркер, отправка); B: saveIUMetadata:100, getSceneDuration:128, generateSceneIUImages:432 | `image/image-service.js:24` |
| `image/preview.js` | 151 | B |  | `image/image-service.js:25` |
| `image/registry.js` | 198 | B |  | `helpers/redis-helpers.cjs:210`, `image/image-service.js:21`, `image/iu-processor.js:19` (+2) |
| `metrics/prometheus.js` | 331 | A |  | `backend.cjs:771`, `helpers/queue-idempotency.cjs:943`, `helpers/queue-idempotency.cjs:952` (+4) |
| `routes/ai-connector-routes.cjs` | 919 | B |  | `backend.cjs:740`, `backend.cjs:912` |
| `routes/book-routes.cjs` | 128 | B |  | `backend.cjs:685` |
| `routes/book/agent-routes.cjs` | 164 | B |  | `routes/book-routes.cjs:61` |
| `routes/book/cache-routes.cjs` | 213 | C | A: очистка PG/Redis/хаба :78–181; B: удаление каталога build :61 | `routes/book-routes.cjs:83` |
| `routes/book/generation-routes.cjs` | 956 | C | A: cancel-worker:186, cancel-generation:303, regenerate:468 (состояние/очереди); B: поиск PNG обложки :664–698, collectScenes/diff | `routes/book-routes.cjs:56` |
| `routes/book/import-routes.cjs` | 985 | C | B: import:215, load-vbook:418, import-txt:574, bootstrap:645; A: trigger-next-window:738 (cooldown/dedup/sessions) | `routes/book-routes.cjs:50` |
| `routes/book/iu-progress-utils.cjs` | 70 | A |  | `backend.cjs:258`, `routes/book/progress-panel.cjs:22` |
| `routes/book/progress-panel.cjs` | 448 | A |  | `routes/book-routes.cjs:64` |
| `routes/book/recovery-routes.cjs` | 40 | B |  | `routes/book-routes.cjs:67` |
| `routes/book/versions-routes.cjs` | 118 | B |  | `routes/book-routes.cjs:70` |
| `routes/debug-routes.cjs` | 589 | C | A: runtime/* интроспекция и apply-fix :168–537; B: scene-assets/files :89 | `backend.cjs:713` |
| `routes/generation-routes.cjs` | 782 | C | A: /gpu/task/result:430, /gpu/task/error:666, worker/counts:265; B: /api/v1/generate:103 (разбор бандла) | `backend.cjs:693` |
| `routes/worker-routes.cjs` | 822 | A |  | `backend.cjs:756` |
| `runtime/gpu-dispatcher.js` | 595 | A |  | `backend.cjs:25`, `backend.cjs:190`, `backend.cjs:215` (+3) |
| `runtime/job-schema.js` | 31 | A |  | `helpers/queue-idempotency.cjs:337`, `routes/generation-routes.cjs:432`, `routes/generation-routes.cjs:668` (+5) |
| `runtime/orchestration-seams.js` | 87 | A |  | `backend.cjs:180`, `backend.cjs:198` |
| `runtime/runtime-loop.js` | 392 | A |  | `backend.cjs:214` |
| `services/agent-prompts.js` | 179 | B |  | `backend.cjs:667`, `routes/book/agent-routes.cjs:5`, `routes/config-routes.cjs:12` (+9) |
| `services/agent-session-control.js` | 81 | B |  | `backend.cjs:595`, `routes/book/generation-routes.cjs:17`, `routes/generation-routes.cjs:43` |
| `services/agent-session.js` | 129 | B |  | `routes/book/agent-routes.cjs:9`, `routes/book/import-routes.cjs:14`, `services/agent/bootstrap.js:13` (+5) |
| `services/agent/bootstrap.js` | 805 | B |  | `services/agent-service.js:23` |
| `services/agent/parallel-analysis-orchestrator.js` | 441 | B |  | `services/agent/pipeline-runner.js:414` |
| `services/agent/pipeline-runner.js` | 1371 | B |  | `services/agent/bootstrap.js:17`, `services/agent-service.js:54` |
| `services/agent/pipeline-steps.js` | 1342 | B |  | `services/agent/bootstrap.js:16`, `services/agent/pipeline-runner.js:16` |
| `services/ai-connector/shared-pool.js` | 432 | B |  | `backend.cjs:526`, `routes/settings-ai-routes.cjs:67`, `services/ai-service.js:143` (+4) |
| `services/ai-connector/transport.js` | 581 | B |  | `routes/ai-connector-routes.cjs:7`, `services/ai-connector/shared-pool.js:341`, `services/ai-connector/shared-pool.js:370` (+1) |
| `services/ai-service.js` | 656 | B |  | `routes/generation-routes.cjs:300`, `scripts/test-scene-split.cjs:11`, `services/agent/ai-caller.js:14` (+2) |
| `services/audio-orchestrator.js` | 545 | C | A: FSM createState:89…setFailed:209, failWaitingScene:412, scanAllStates:493; B: completeChunk:218 (склейка чанков) | `routes/generation-routes.cjs:485`, `services/task-handler.cjs:309`, `services/task-handler.cjs:613` (+1) |
| `services/audio-recovery.cjs` | 238 | A |  | `routes/debug-routes.cjs:25` |
| `services/book-deletion.cjs` | 277 | C | A: PG/Redis/хаб :164–260; B: файлы :115–140 (одна фабрика createBookDeletion:58) | `backend.cjs:237` |
| `services/book-sync.js` | 395 | C | A: markSceneAssetsStale:222, markGenerationTasksStale:260, purgeRemovedSceneRows:311; B: reconcileFromDiff:53, findSceneData:159, detectChangedScenes:173, syncImageUnitTexts:292 | `storage/index.js:26` |
| `services/cancel-scene-state.cjs` | 131 | A |  | `services/stage-cancellation.cjs:155` |
| `services/cleanup-service.cjs` | 193 | B |  | `backend.cjs:451` |
| `services/entity-cleanup.cjs` | 450 | C | A: scanAndDel:110, purgeScene:223 (Redis/PG), retryPendingPurges:390; B: deleteSceneFiles:165, deleteUnitFiles:191 | `backend.cjs:483` |
| `services/gen-scope.js` | 172 | A |  | `backend.cjs:179`, `storage/index.js:28` |
| `services/generation-progress.js` | 289 | A |  | `routes/book/generation-routes.cjs:8`, `routes/book/progress-panel.cjs:23`, `services/gpu-retry-policy.cjs:81` (+2) |
| `services/gpu-error-classifier.cjs` | 138 | A |  | `services/gpu-retry-policy.cjs:47` |
| `services/gpu-retry-policy.cjs` | 424 | A |  | `backend.cjs:148` |
| `services/layer-config.js` | 298 | A |  | `services/agent/bootstrap.js:14`, `services/agent/pipeline-runner.js:15`, `storage/index.js:27` (+1) |
| `services/orphan-books-audit.js` | 174 | B |  | **нет** |
| `services/placeholder-audio.js` | 606 | C | B: getSceneEstimatedDurationSec:71, ensurePlaceholderAudio:178, ensureAllPlaceholderAudio:284, recoverMissingPlaceholders:502; A: replacePlaceholderWithRealAudio:331, markPlaceholderStale:470 (статусы scene_assets) | `backend.cjs:281`, `storage/placeholder-audio-adapter.js:33` |
| `services/progress-pubsub.cjs` | 34 | A |  | `routes/book/import-routes.cjs:9`, `routes/generation-routes.cjs:371`, `services/task-handler.cjs:10` (+2) |
| `services/provider-gateway.js` | 174 | B |  | `backend.cjs:522` |
| `services/publication-lock.cjs` | 610 | A |  | `services/result-publication.cjs:64` |
| `services/regenerate-hub-sweep.cjs` | 59 | A |  | `backend.cjs:567` |
| `services/result-publication.cjs` | 1144 | A |  | `runtime/runtime-loop.js:160`, `services/audio-recovery.cjs:12`, `services/task-handler.cjs:21` |
| `services/scene-asset-registry.js` | 308 | A |  | **нет** |
| `services/stage-cancellation.cjs` | 157 | A |  | `backend.cjs:564` |
| `services/task-handler.cjs` | 724 | C | A: handleTaskResult:283 (fence/commit/статусы), publishVersionedIuImage:103; B: saveBookSnapshot:685, loadBookSnapshot:702 | `backend.cjs:478` |
| `services/video-orchestrator.js` | 529 | C | A: FSM createState:90…setFailed:185, failWaitingScene:434, scanAllStates:477; B: groupFilePath:229, isGroupFileValid:236, completeGroup:252 (склейка) | `routes/generation-routes.cjs:485`, `services/task-handler.cjs:309`, `services/task-handler.cjs:636` (+1) |
| `services/window-generator.cjs` | 178 | B |  | `backend.cjs:465` |
| `services/worker-liveness-sync.cjs` | 55 | A |  | `runtime/runtime-loop.js:180` |
| `services/workflow-manager.js` | 557 | B |  | `backend.cjs:206` |
| `startup-resume.js` | 115 | A |  | `backend.cjs:137` |
| `state/asset-state-store.js` | 157 | A |  | `state/scene-state-ops.js:87`, `state/scene-state-ops.js:148`, `state/scene-state-ops.js:179` (+3) |
| `state/event-journal.js` | 256 | A |  | `backend.cjs:161`, `backend.cjs:207`, `services/gpu-retry-policy.cjs:80` (+1) |
| `state/scene-state-ops.js` | 266 | A |  | `backend.cjs:160`, `services/placeholder-audio.js:475`, `services/scene-asset-registry.js:163` |
| `state/scene-state.js` | 10 | A |  | `state/index.js:6` |
| `storage/audio-fsm-adapter.js` | 104 | A |  | `backend.cjs:83`, `state/scene-state-ops.js:68` |
| `storage/hub-cancel-adapter.js` | 44 | A |  | `backend.cjs:108` |
| `storage/index.js` | 31 | B |  | `backend.cjs:208`, `storage/runtime-persistence-adapter.js:45` |
| `storage/layer-config-adapter.js` | 48 | A |  | `backend.cjs:121` |
| `storage/placeholder-audio-adapter.js` | 51 | A |  | `backend.cjs:60` |
| `storage/postgres/database.js` | 89 | B |  | `image/iu-processor.js:141`, `image/iu-processor.js:153`, `image/iu-processor.js:164` (+48) |
| `storage/postgres/repositories/ai-connector-repo.js` | 438 | B |  | `routes/ai-connector-routes.cjs:4`, `routes/settings-ai-routes.cjs:18`, `services/ai-connector/discovery.js:35` (+3) |
| `storage/postgres/repositories/ai-endpoint-repo.js` | 412 | B |  | `routes/ai-endpoint-routes.cjs:33`, `services/ai-connector/shared-pool.js:80` |
| `storage/postgres/repositories/events-repo.js` | 163 | B |  | `services/book-event-log.js:9`, `storage/postgres/repositories/index.js:6` |
| `storage/postgres/repositories/generation-cancel-repo.js` | 78 | A |  | `routes/book/generation-routes.cjs:12`, `routes/generation-routes.cjs:131`, `services/agent/bootstrap.js:110` (+3) |
| `storage/postgres/repositories/guest-repo.js` | 226 | B |  | `auth/index.cjs:29`, `backend.cjs:882`, `routes/auth-routes.cjs:21` (+1) |
| `storage/postgres/repositories/index.js` | 13 | B |  | `image/iu-processor.js:112`, `storage/postgres/index.js:3` |
| `storage/postgres/repositories/iu-image-pointer-repo.js` | 391 | A |  | `image/iu-processor.js:27`, `image/iu-processor.js:199`, `image/registry.js:116` (+10) |
| `storage/postgres/repositories/registration-tx.js` | 91 | B |  | `auth/index.cjs:31` |
| `storage/postgres/repositories/scene-assets-repo.js` | 909 | A |  | `audio/generation.js:284`, `backend.cjs:471`, `routes/book/generation-routes.cjs:7` (+9) |
| `storage/postgres/repositories/task-repo.js` | 162 | A |  | `routes/book/generation-routes.cjs:10`, `routes/generation-routes.cjs:93`, `services/gpu-retry-policy.cjs:82` (+5) |
| `storage/postgres/repositories/worker-repo.js` | 867 | A |  | `routes/admin-routes.cjs:28`, `routes/worker-routes.cjs:41`, `routes/worker-setup-routes.cjs:36` (+4) |
| `storage/postgres/repositories/workspace-repo.js` | 171 | B |  | `auth/index.cjs:27`, `middleware/workspace-ownership.js:11`, `routes/worker-routes.cjs:43` (+2) |
| `storage/postgres/schema.js` | 1922 | B |  | `storage/postgres/index.js:1` |
| `storage/progress-events-adapter.js` | 107 | A |  | `backend.cjs:71` |
| `storage/runtime-persistence-adapter.js` | 287 | A |  | `backend.cjs:41` |
| `storage/scene-data-adapter.js` | 50 | B |  | `backend.cjs:50` |
| `storage/video-fsm-adapter.js` | 110 | A |  | `backend.cjs:95`, `state/scene-state-ops.js:69` |
| `video/video-merge.js` | 665 | B |  | `routes/book/export-routes.cjs:18`, `services/video-orchestrator.js:332`, `services/video-orchestrator.js:375` |
| `video/video-service.js` | 217 | B |  | `video/index.js:7` |


### Странности (раздел 10)

- Без production-импортёров (импортируются только тестами или никем): `services/scene-asset-registry.js` (только `backend/tests/scene-asset-registry.test.js:13`, `backend/tests/book-sync.test.js:26`) — при этом это единственный вызывающий `scene-assets-repo.deleteSceneAssets/deleteBookAssets/deleteBuildAssets` и 7 из 13 вызовов `upsertAsset` (раздел 3); `services/orphan-books-audit.js` (только `backend/tests/orphan-books-diagnosis.test.js:43`); `contracts/runtime-result.js` — перенесён в `packages/animastor-contracts/src/runtime-result.js` (комментарий `:4` «Moved verbatim from backend/src/contracts/runtime-result.js»), backend-копия не импортируется.
- `services/audio-recovery.cjs` импортируется только `routes/debug-routes.cjs:25`, хотя `backend.cjs:951` описывает reconciliation как его замену; фаза A reconcile (`orch:runtime/reconciliation-engine.js:1987`) дублирует его сканирование `animastor:result:*` (`services/audio-recovery.cjs:46`).
- Две FSM-модели одной стадии: `services/audio-orchestrator.js` / `video-orchestrator.js` (Redis JSON `audio-orch`/`video-orch`) и asset-state (`state/asset-state-store.js`, hash) + адаптеры портов `storage/audio-fsm-adapter.js`, `storage/video-fsm-adapter.js` для пакета.
- Три места ведут учёт отмены книги на стороне backend: `services/stage-cancellation.cjs`, `services/cancel-scene-state.cjs` и инлайн-последовательность в `routes/book/generation-routes.cjs:303–463`.


## 11. Странности (общий раздел)

Только факты; подробности и ссылки — в «Странностях» разделов 1–10.

### 11.1 Одно состояние в нескольких хранилищах

| Состояние | Где хранится | Ссылки |
|---|---|---|
| Статус задачи генерации | Redis `animastor:generation-progress:{book}` (hash, TTL 4 ч) · PG `generation_tasks.status` (N строк на задачу) · хаб `animastor:running` / очереди | `backend/src/services/generation-progress.js:25`; `backend/src/storage/postgres/schema.js:240`; `hub: gpu-hub.js:1124` |
| Состояние стадии сцены | Redis `animastor:asset-state:*` (hash) · Redis `animastor:audio-orch:*` / `video-orch:*` (JSON FSM) · PG `scene_assets.status` · PG `scenes.status/is_dirty/dirty_unit_ids` · пустая PG `asset_states` | `backend/src/state/asset-state-store.js:100`; `backend/src/services/audio-orchestrator.js:112`; `schema.js:589`, `:172`, `:187` |
| «Выполняется сейчас» | active-index `animastor:active-scenes` · счётчики `runtime:active-*` · dispatch-lease + dispatch-meta (backend) · `animastor:processing` + `animastor:running` + `timeout_ms` (хаб) · heartbeat `current_job_id` | `orch:runtime/active-scenes-index.js:11`; `orch:runtime/dispatch-engine.js:136`, `:143`, `:596`; `hub: gpu-hub.js:1075`, `:1124` |
| Отмена книги | Redis `animastor:generation:cancel:{book}` (без TTL) · Redis `animastor:cancelled-workers:{book}` (vbook, TTL 1 ч) · PG `generation_cancellations` | `orch:runtime/scene-window.js:404`; `backend/src/routes/book/generation-routes.cjs:248`; `repositories/generation-cancel-repo.js:26` |
| Результат GPU | тело POST (base64) · Redis `animastor:result:*` (хаб, 1 ч) · staging-файл + манифест/маркеры в Redis · канонический файл | `hub: gpu-hub.js:1255`; `backend/src/services/result-publication.cjs:334`, `:386` |
| Признак заглушки аудио | sidecar `*.placeholder.json` · chunk `audio_status:'placeholder'` (Redis) · `scene_assets.status='placeholder'` (PG) | `backend/src/audio/placeholder-marker.js:29`; `backend/src/routes/book/import-routes.cjs:286`; `schema.js:589` |
| Живость воркера | Redis heartbeat (TTL 30 с, пишет хаб и продлевает по `running`) · `animastor:gpu-hub:workers` (TTL 900 с) · PG `workers.status/last_seen` (синхронизация раз в 60 с) | `hub: gpu-hub.js:594–634`, `:352`; `backend/src/storage/postgres/repositories/worker-repo.js:814–824` |
| Повторы | Redis `animastor:gpu-retry:*` + таймер в памяти (`gpu-retry-policy`) · `animastor:retry-budget:*` (пакет) · PG `generation_tasks.retry_count/max_retries` (не обновляется) · хаб `orphan_requeues` (до 3) | `backend/src/services/gpu-retry-policy.cjs:56`, `:291`; `orch:runtime/retry-budget-manager.js:35`; `schema.js:243–244`; `hub: gpu-hub.js:57` |
| Таймаут задачи | lease по стадии (backend) · `max(timeout_ms, GPU_TIMEOUT_MS)` (хаб) · `timeout_ms` / 600 с / 7200 с (воркер) · stall-watchdog `GPU_TIMEOUT_MS × 3` (×6 для видео) | `orch:runtime/dispatch-engine.js:71`; `hub: gpu-hub.js:992`; `worker: worker.cjs:63`, `:69`; `backend/src/config/runtime-config.js:180`, `:194–199` |

### 11.2 Мёртвый / неиспользуемый код (по статическим импортам и вызовам)

- `backend/src/services/scene-asset-registry.js` — импортируют только тесты; через него идут 3 DELETE и 7 вызовов upsert `scene_assets`.
- `backend/src/contracts/runtime-result.js` — копия, перенесённая в `@animastor/contracts`; не импортируется.
- `backend/src/services/orphan-books-audit.js` — импортирует только тест.
- `task-repo.incrementRetry`, `iu-repo.deleteImageUnitsForBuild/ForScene` — без вызовов.
- PG-таблицы без INSERT/UPDATE: `asset_states`, `cache_entries`, `asset_dependencies`, `reconciliation_events`, `output_manifests`; колонка `books.user_id` не заполняется.
- ~15 семейств Redis-ключей упоминаются только в шаблонах очистки/debug без писателя в backend и пакете (раздел 4).
- 9 эндпоинтов раздела 1 не вызываются ни web, ни Android; 4 Retrofit-декларации Android без вызовов (раздел 7).

### 11.3 Дубли логики

- Сценарий «загрузить бандл → восстановить чанки → окно сцен» — в `POST /api/v1/generate`, `POST /book/import` (vbook) и `POST /book/load-vbook`.
- Отмена: `routes/book/generation-routes.cjs:303–463` (инлайн), `services/stage-cancellation.cjs`, `services/cancel-scene-state.cjs`; очистка хаба по книге — 4 вызывающих (`routes/book/generation-routes.cjs:411`, `routes/book/cache-routes.cjs:143`, `services/book-deletion.cjs:228`, `orch:runtime/dispatch-engine.js:1741`).
- Списки PG-таблиц для удаления книги — в `services/book-deletion.cjs:164–186` и `routes/book/cache-routes.cjs:78–97` (с расхождениями).
- Сканирование `animastor:result:*`: `services/audio-recovery.cjs:46` и фаза A reconcile `orch:runtime/reconciliation-engine.js:2009`.
- Расхождение контракта: фронты читают `build_id`/`summary` из ответа `/regenerate`, backend их не отдаёт.


## 12. Выборочная проверка ссылок

1. **Автоматическая проверка всех ссылок** `файл:строка` документа (скрипт резолвит префиксы `hub:/worker:/web:/and:/orch:/repo:/naming:`, относительные пути и уникальные имена файлов по коммитам из шапки; для каждой ссылки — файл существует и номер строки не больше длины файла): **874 ссылки, 0 ошибок**. Проверка не подтверждает смысл строки — для этого п. 2.
2. **Ручная сверка содержимого** 25 случайных ссылок (seed 42) — строка кода по ссылке:

| Ссылка | Строка в коде |
|---|---|
| `audio/silence.js:13` | `const { writePlaceholderMarker } = require('./placeholder-marker');` |
| `backend/src/startup-resume.js:44–48` | `marked++;` |
| `backend/src/routes/worker-routes.cjs:174` | `app.post('/api/v1/worker/verify', requireWorkerAuth(redis), async (req, res) => {` |
| `runtime/runtime-loop.js:180` | `const wl = await require('../services/worker-liveness-sync.cjs').syncWorkerLiveness(redis);` |
| `orch:runtime/dispatch-engine.js:71` | `const LEASE_TTLS = new Proxy({}, {` |
| `routes/book/cache-routes.cjs:79–86` | `'cache_entries',` |
| `repo/worker-repo.js:242` | `UPDATE workers SET token_hash = $3, token_prefix = $4` |
| `storage/progress-events-adapter.js:66` | `await taskRepo.updateTaskStatus(task.task_id, 'blocked', reason);` |
| `backend.cjs:478` | `const taskHandler = require('./services/task-handler.cjs')(redis, config, taskHandlerDeps);` |
| `backend/src/services/ai-connector/transport.js:333` | `entry.timer = setTimeout(() => {` |
| `backend.cjs:215` | `gpuDispatcher: require('./runtime/gpu-dispatcher'),` |
| `backend.cjs:465` | `const windowGenerator = require('./services/window-generator.cjs')({` |
| `web:packages/animastor-web-generator/src/sseRouting.ts:39–59` | `}` |
| `reconciliation-engine.js:1987–2060` | `async function recoverResultKeys(redis, deps, scope) {` |
| `cache-routes.cjs:61` | `try { fs.rmSync(buildPath, { recursive: true, force: true }); } catch (e) {` |
| `routes/worker-routes.cjs:146–165` | `}` |
| `backend/src/routes/worker-routes.cjs:395` | `app.delete('/api/v1/workers/:workerId/purge', async (req, res) => {` |
| `backend/src/routes/worker-routes.cjs:314` | `app.post('/api/v1/workers/:workerId/rotate', async (req, res) => {` |
| `backend/src/helpers/queue-idempotency.cjs:1172` | `await new Promise((r) => setTimeout(r, 20));` |
| `repo/iu-image-pointer-repo.js:213` | `'INSERT INTO ${RESERVATION_TABLE}` |
| `repo/guest-repo.js:199` | `'DELETE FROM books WHERE workspace_id = $1 RETURNING book_id',` |
| `ui/GenerateFragment.kt:229` | `val counts = RetrofitClient.api.getWorkerCounts()` |
| `backend/src/routes/book/generation-routes.cjs:904–916` | `await taskRepo.createTask(` |
| `backend/src/routes/worker-routes.cjs:258` | `app.get('/api/v1/workers', async (req, res) => {` |
| `backend/src/audio/pipeline.js:104` | `if (clearPlaceholderMarker(finalPath)) {` |

3. В ходе сверки исправлены ошибки черновика: номера строк хаба (`gpu-hub.js`) сдвинуты на реальные; утверждение «публикатора `generation_complete` нет» заменено фактом (`packages/animastor-orchestration/src/orchestration/scene-callbacks.js:526`, `:590`); `schema.js:1735` → `:1737`; `book-sync.js:326` → `:324`.
4. Не проверялось: поведение во время выполнения (ничего не запускалось), содержимое Redis/PG на проде, код установщика воркера (`packages/animastor-installer`), пакеты `animastor-player`/`animastor-editor` — только как вызывающие репозиториев (раздел 3).

