# GPU restart — предварительные условия

Дата: 2026-10-29. Статус: **план, воркеры не включены**. Очередь генерации к
этому моменту накоплена (Stage 150), поэтому всё ниже — именно блокеры перед
запуском, а не «после запуска». Дополнено 2026-10-30: разделы 4–5 —
совместимость воркера и сухой прогон цепочки на изолированном стенде
(подтверждены, см. `reports/2026-10-29/gpu-chain-dry-run.md`).

## Перед включением воркеров

### 1. Перенести `feature/gpu-queue-143a` (backend) в `main`

Ветка содержит Stage 143a (B-lite foundation) и его продолжения:

- идемпотентная отправка задачи (idem-key, durable receipt, повторный POST не
  создаёт вторую задачу);
- intent-fence на стороне диспетчера резервирований;
- атомарная публикация результата (pointer как единственная authority на
  текущий опубликованный путь и версию);
- versioned image-пути под флагом `IU_IMAGE_VERSIONED` — **флаг отдельно** от
  merge: включать только после адаптации потребителей (`IU_IMAGE_VERSIONED`
  читается в `image-service.js`, `iu-processor.js`, `gpu-dispatcher.js`,
  `task-handler.cjs`, `iu-image-pointer-repo.js`, `schema.js`).

Состояние на 2026-10-29: ответвлена от Stage 105 (`53ce504`); в ветке 32
коммита, `main` с тех пор ушёл на **41 коммит** вперёд, **22 файла** менялись
в обеих линиях — fast-forward невозможен.

**Статус: выкачено Stage 154 (2026-10-29).** Ветка влита fast-forward
(`main` `e654a58` → `a824eb4`, 34 коммита), `feature/gpu-queue-143a` удалена в
origin; `backend/package-lock.json` запинен на опубликованный
`@animastor/orchestration@0.2.0` (`sha512-G98OHbid…`), approve-коммит
`e2305d3` (`APPROVED_COMMIT = a824eb4`). Прод: образ `deploy-e2305d3` =
`sha256:f85470bb8ed7e1a2ef9e86afc84470a260ea3c593b42b0b482d2f885c4b3d27c`
(было `1fde561c…`), в контейнере orchestration `0.2.0`; старт без ошибок,
0 диспатчей, смоук пройден. Аудит и решения по 8 конфликтам:
`reports/2026-10-29/gpu-143a-port-audit.md`.

Флаги оставлены как есть: `GPU_FENCING_MODE` и `IU_IMAGE_VERSIONED` в
`prod/.env` и compose **не заданы** (действуют значения по умолчанию —
`observe` и «выключено»).

Документы:
[stage143a-checkpoint.md](https://github.com/Animastor/animastor-backend/blob/main/stage143a-checkpoint.md),
[stage147-a1-and-release-plan.md](https://github.com/Animastor/animastor-backend/blob/main/stage147-a1-and-release-plan.md).

### 2. `feature/gpu-hub-monorepo-import` — проверен и заархивирован

Состояние на 2026-10-29: ветка — `main` (`0f489c7`) + 1 коммит `38c09c6`
(импорт `packages/animastor-gpu-hub` микромонорепо, 15 файлов, +1385/−289).
Тесты пакета на ветке зелёные (`node tests/run-all.cjs` → 22 passed / 0 failed),
но **fast-forward не выполнен**: импорт не «новее прода», а другая линия пакета,
и в пяти местах он противоречит `main`.

Что в проде: `gpu-hub` = `ghcr.io/animastor/animastor-gpu-hub@sha256:3611c644…`
(тег `v0.2.0`), собран 2026-10-12 из `0f489c7`, в контейнере
`/app/package.json` → `0.1.0`. Backend объявляет `@animastor/gpu-hub ^0.1.2`
только в `devDependencies` (0.1.2 — npm-публикация линии микромонорепо, в
прод-образ не попадает).

Новее прода в импорте: версия `0.1.2` + `CHANGELOG.md` (фикс версии installer в
`0.1.1`, канонический домен `animastor.org` в `0.1.2`), стартовый гейт целостности
запечённых артефактов (`verifyBakedArtifacts` против `artifacts.lock.json`),
инструменты сборки (`scripts/fetch-pinned-assets.sh`,
`scripts/verify-staged-artifacts.sh`, `tools/g4-standalone-build.sh`,
`tools/g5-artifact-integrity.sh`, `tools/standalone-fixture.cjs`,
`tools/update-artifacts-lock.cjs`), переработанный `Dockerfile`.

Старше / хуже прода в импорте: (1) нет `GET /worker-source` — 13 маршрутов
вместо 14, а прод его отдаёт (онбординг приватного воркера, `9cf51ce`);
(2) обратный порядок резолва артефактов — `config > baked-in > mount` без
валидации каталога (main: `config` с громким отказом → живой mount → baked-in,
фикс Phase 10T `d1471e1`); (3) нет `INSTALLER_PKG_DIR`; (4) `server.js` больше
не прокидывает `WORKER_BUNDLE_DIR`/`WORKFLOW_DIR`/… в `config`, т.е. env-оверрайды
в контейнере мертвы; (5) `artifacts.lock.json` в другом формате (release-asset
пины, нет `sources`) и пинит старые артефакты: worker-bundle 7 файлов
(`c59dab5d…`) против 8 (`417c0ad4…`) в main, installer-src `777e4ade…` —
**до** фикса D3/D4 (`ff27e291…`). CI `ghcr-release.yml` (ветка его не меняет)
читает `lock.sources` → на этом lock падает `TypeError`.

**Статус: импорт не вливается, ветка в архиве.** Импорт старше `main`
(`/worker-source`, Phase 10T, env-проксирование, `INSTALLER_PKG_DIR`, формат
lock) — вести пакет по этой линии нельзя без регрессии прода; полезное из него
(канонический домен `animastor.org`, `verifyBakedArtifacts`, инструменты сборки
`tools/*`, `scripts/fetch-pinned-assets.sh`/`verify-staged-artifacts.sh`) —
переносить точечно отдельными задачами при необходимости. Ветка
`feature/gpu-hub-monorepo-import` (`38c09c6`) переименована в
`archive/gpu-hub-monorepo-import-20261028` и больше не используется.
**Старый домен закрыт 2026-10-29.** `PUBLIC_HUB_URL=https://animastor.org/gpu`
задан в `prod/docker-compose.yml` (animastor-deploy `f18e556`, пересоздан только
`gpu-hub`); в `main` gpu-hub `publicHubUrl()` fallback исправлен на
`https://animastor.org/gpu`, а `PUBLIC_HUB_URL` теперь прокидывается из
`server.js` (раньше env-ключ был мёртв), тесты 27/27 (`a1e1589`). **Образ
gpu-hub не пересобирался** — правка уйдёт со следующим релизом хаба; до него
прямой вызов контейнера без валидного `Host` всё ещё отдаёт `.in` (в образе
`0.1.0` `server.js` не читает `PUBLIC_HUB_URL`), а публичный
`https://animastor.org/gpu/installer` — уже `.org`. Выкатка gpu-hub не
выполнялась. Сборка gpu-hub — отдельный
workflow `gpu-hub-ghcr-release` (`workflow_dispatch` с `image_tag`: пины из
`artifacts.lock.json` → stage+verify → reproducible build → smoke → push в GHCR),
деплой — ручной: digest в `prod/docker-compose.yml` + `up -d gpu-hub` (в
backend-CI не входит). Подробности и набор изменений для прода — в отчётах
`reports/2026-10-29/gpu-restart-final-prep.md` и
`reports/2026-10-29/gpu-hub-import-archive.md`.

### 3. Очистить накопленную очередь GPU-задач — решение владельца

Stage 150 (read-only): 478 задач `image` в workspace-lane
(`animastor:queue:image:ws:3317e019…`, книги `import_1786345731767…` — 476,
`ba_1788172242081` — 2) + 8 задач в system-lane, причём этих книг **нет** в
`books` (сироты). Воркеров 0 (`GET /health` → `gpus:0`), `processing`,
`running`, `dead-letter` пусты, 33 старых claim-записи `:audio` без TTL.

Пока решение (удалить / переотправить / оставить как есть) не принято,
воркеры не включать: хаб начнёт разбирать 478 задач по 2 книгам и 8 сиротских,
а результат ляжет на уже накопленные артефакты.

**Статус: очередь очищена 2026-10-29** (Stage 154 prep, решение владельца;
бэкап `/home/animastor/backups/pre-queue-cleanup-20261029T125514Z/`).
Очереди хаба были уже пусты после части 2 Stage 150 (2026-10-27) — свежая
инвентаризация 2026-10-29 дала 0 задач и 0 в полёте, новых отправок не было
(`Active: 0, Dispatched: 0`, за 24 ч ноль `IMAGE_DISPATCHED`). Чистились
маркеры в PG и кэш состояний: `scene_assets` — 434 `stale` + 2 `pending` →
421 `ready` (файл ассета валиден в `data/output`) + 15 `DELETE` (сироты без
файла); итог 439 `ready` / 9 `placeholder`, `stale`/`pending` — 0. `scenes`:
`is_dirty` 8 и `dirty_unit_ids` 1 → 0. Redis: `asset-state:*` 13 ключей
удалено, все GPU-ключи (`queue:*`, `active-scenes`, `processing`,
`running`, `dead-letter`, `processing-claimed`, `dispatch-lease/meta`) — 0.
Тамбстоны `generation_cancellations` (2 книги) оставлены.

После выкатки Stage 154 (2026-10-29) очередей по-прежнему нет: 10 минут
наблюдения — все тики `Active: 0, Dispatched: 0`, hub `queues` 0, в Redis нет
новых `intent`/`dispatch-intent`/`iu-in-flight`/`dispatch-lease`, `scene_assets`
— `ready` 439 / `placeholder` 9, `stale`/`pending` 0.

**Побочный эффект очистки кэша — закрыт 2026-10-29.** Reconcile логировал 8
invariant-несоответствий (`audio-orch`/`video-orch` в фазе `DONE` против
удалённого `asset-state:*`) по 5 сценам книги `import_1786345731767_…`.
Пересборка `asset-state` из PG штатной фазой C8 (`rebuildWorkList`,
startup-only) к этой книге неприменима: C8 пропускает книги с тамбстоном
отмены (fail-closed), а ручной прогон его предиката дал бы два новых
`partial_audio_only` (audio READY без image у `sc-45c789c6`, `sc-5f18dd0f`).
Удалены 8 осиротевших terminal-записей `audio-orch`/`video-orch` этой книги
(бэкап `/home/animastor/backups/pre-orch-orphan-cleanup-20261029T135943Z/`,
BGSAVE). Итог: `Full reconciliation complete: … 0 inconsistencies found` в трёх
циклах подряд, 0 диспатчей, `scene_assets` без изменений (448 строк, тот же
md5), `asset-state:*` остаётся осознанно пустым.

Документы:
[stage150-queue-inventory.md](https://github.com/Animastor/animastor-backend/blob/main/stage150-queue-inventory.md),
[stage148-hotfix.md](https://github.com/Animastor/animastor-backend/blob/main/stage148-hotfix.md).

### 4. Совместимость воркера с хабом и backend — подтверждена 2026-10-30

Продовый бандл воркера (8 файлов, версия `2.1.1`, digest по rel-path
`417c0ad489badd77c64d5ca5cad06f5d75d56c50407fab1ce2b62f03620a3584`)
байт-идентичен `main` `animastor-worker` (`b3f94f4`); `worker.cjs` sha256
`0f8350b30cc415b60ee057706c89a845a93ffa65315a2a0bec191de73e169304`,
совпадает с `/app/artifacts/worker-bundle/worker.cjs` в продовом образе хаба
`ghcr.io/animastor/animastor-gpu-hub@sha256:3611c644…`.

Контракт callback-цепочки (воркер → hub `POST /task/result` → backend
`POST /api/v1/gpu/task/result`) согласован по всем обязательным полям:
`job_id`, `build_id`, `dispatch_id`, `protocol_version = 2`,
`result_base64` (+ `worker_version`/`worker_image_tag` у воркера,
`worker_id`/`workspace_id` у хаба). Воркер ничего не «подписывает»: все
`intent`/`receipt`/`epoch`/`fence` — собственность backend'а, fence резолвится
из неизменяемого dispatch-receipt
(`resolveDispatchFence({dispatchId, jobId})`), idem-key — по
`sha256([workspaceId, jobId, jobType, buildId, inputSha256(params), epoch]|…)`.
Backend закрывает дубли ключом `animastor:result-processed:<job>:<build>`
(`SETNX`, TTL 1 ч). **Изменений в воркере для `observe` не требуется.**

Мелкая находка: `artifacts.lock.json` формулирует digest как «по порядку строк
хэшей» (`c91f9e7c…`), тогда как `scripts/stage-artifacts.cjs` считает по
rel-path-порядку (`417c0ad4…`, совпадает с lock) — неверна формулировка, не
значение; правку внести вместе со следующей правкой lock.

### 5. Сухой прогон цепочки на изолированном стенде — пройден 2026-10-30

Стенд: продовый образ хаба (`3611c644…`) и backend'а (`f85470bb…`, Stage 154)
в тестовом compose-проекте `animastor-test`, продовый бандл воркера,
ComfyUI-заглушка, пустая тестовая книга (1 глава / 1 сцена / 2 unit'а).
Чистое окно: image 2/2, audio 1/1, video 1/1 отправлено/принято, 0
отклонений, 0 дублей; hub 4 результата, 0 ошибок; `PG-IMAGE/AUDIO/VIDEO-READY`
по сцене; файлы на диске, итоговый mp4 валиден. Сценарии устойчивости —
дубликат доставки, убийство воркера в середине задачи, перезапуск backend в
середине задачи, отмена в середине задачи — **PASS**, публикация ровно одна
(fence уникален) в каждом.

Находка прогона: replay уже сохранённого результата после рестарта backend
**не** восстанавливает dispatch-identity (отклоняется `no_active_dispatch`);
восстановление идёт повторным диспатчем через worklist (цена — одна лишняя
генерация). Для `observe` не блокер; кандидат на улучшение отдельной задачей.

Временный `GPU_FENCING_MODE=off` **не нужен**: fence-цепочка целиком
backend↔Redis, воркер лишь эхом возвращает `dispatch_id`/`protocol_version`;
`off` снял бы именно защиту от дублей и гонок. Детали и таблицы — в
`reports/2026-10-29/gpu-chain-dry-run.md`.

## Первое включение воркера (черновик)

Один воркер, одна тестовая книга, флаги по умолчанию. Цель — увидеть один
полный цикл `dispatch → результат → публикация → reconcile` без побочных
эффектов, а не разгрузить очередь.

**Предусловия.** Пункты 1–3 закрыты; очередь хаба пуста (`/health` → `queues` 0,
`running` 0); бэкап PG и Redis снят. Env backend: `GPU_FENCING_MODE` **не
задан** (`observe` — поведение идентично `enforce` с Stage 131, отличается
только громкостью логов), `IU_IMAGE_VERSIONED` **не задан** (выключен). Hub:
`GPU_HUB_API_KEY` задан, `SHARE_FEATURES_ENABLED=0`, `gpus: 0`.

**Шаги.**

1. Тестовая книга только для проверки: тестовый аккаунт, `POST
   /api/v1/book/blank {language:'en'}` → 1 глава / 1 сцена; записать `book_id`.
   Книги и аккаунты пользователей не трогать.
2. Запустить **один** воркер на GPU-хосте (одна карта, `workers=1`). Ждать
   `GET /health` → `{"gpus":1,"queues":{…0},"running":0}`.
3. Включить генерацию только на тестовой книге — `image` для одной сцены
   (или `start` окна из одной сцены). Ничего больше не ставить в очередь.
4. Наблюдать 3 цикла reconcile (3 мин) и до терминального состояния задачи.

**Что смотреть.**

| Где | Ожидание |
|---|---|
| backend лог | `[SCHEDULER] Active: 1, Dispatched: 1`; один `IMAGE_DISPATCHED`/`GPU Task sent` на unit; `[RECONCILE] … 0 inconsistencies`; ни одного `[INVARIANT]`, `dead-letter`, `duplicate`, `idem`-конфликта |
| hub `/health` | `gpus:1`, `queues.image` 1 → 0, `running` 1 → 0 |
| Redis | `dispatch-lease`/`dispatch-meta` с живым TTL (продлевается), `intent`/`receipt` парой, `iu-in-flight` исчезает по завершении, `active-scenes` 1 → 0 |
| PG | `generation_tasks`: `queued → running → completed`; `scene_assets`: `pending → ready` ровно по тестовой сцене; `iu_image_pointers` — строка на unit (published), `iu_image_fence_reservations` — 1 |
| диск | файл ассета по каноническому пути (`data/output`), без `tmp`/частичных файлов |

**Критерии остановки (немедленно):** любой `dead-letter`; повторный диспатч
того же `unit_id`; `[INVARIANT]`/`inconsistencies > 0`; `dispatch-lease` без
TTL или `processing`/`running`, не убывающие после TTL; диспатч задачи вне
тестовой книги; `scene_assets` ушёл в `stale`/`failed` без ошибки в логе;
воркер пропал (`gpus:0`) при `running:1`. Действия при остановке: снять
воркер с сети (не убивать backend), дождаться истечения lease, разобрать
`dead-letter`/`intent`/`receipt`, только потом повторять. Расширять до
нескольких воркеров/книг — после трёх чистых циклов и одной полностью
опубликованной сцены.

## Порядок

1 → 2 (импорт gpu-hub в архив — решение принято) → 3 → 4 → 5 → первое
включение по разделу выше. Пункты 1–2 — код/ветки, 3 — данные прода (только
SELECT; изменение очереди — отдельная задача с бэкапом Redis), 4–5 —
подтверждены на изолированном стенде 2026-10-30. Перед первым включением
остаётся выкатить правку хаба `a1e1589` (fallback `PUBLIC_HUB_URL` → `.org` +
прокидывание env в `server.js`) со следующим релизом `gpu-hub-ghcr-release` и
переустановить воркеров владельцем с новым бандлом.
