# GPU restart — предварительные условия

Дата: 2026-10-29. Статус: **план, воркеры не включены**. Очередь генерации к
этому моменту накоплена (Stage 150), поэтому всё ниже — именно блокеры перед
запуском, а не «после запуска».

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

### 2. Сверить `feature/gpu-hub-monorepo-import` с `main` gpu-hub

На 2026-10-29 ветка — это `main` (`0f489c7`) + 1 коммит, пересечений с `main`
нет: импорт `packages/animastor-gpu-hub` микромонорепо (15 файлов,
+1385/−289) — `scripts/fetch-pinned-assets.sh`,
`scripts/verify-staged-artifacts.sh`, `tools/g4-standalone-build.sh`,
`tools/g5-artifact-integrity.sh`, `tools/standalone-fixture.cjs`,
`tools/update-artifacts-lock.cjs`, `CHANGELOG.md`, обновления
`Dockerfile`/`gpu-hub.js`/`server.js`/`package*.json`/`artifacts.lock.json`.

Сверку повторить перед слиянием (main мог уйти):
`git -C repos/animastor-gpu-hub.git log --oneline main..feature/gpu-hub-monorepo-import`
и `git diff main feature/gpu-hub-monorepo-import`. `artifacts.lock.json` не
перепубликовывать без отдельной проверки `g5-artifact-integrity.sh`.

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
— `ready` 439 / `placeholder` 9, `stale`/`pending` 0. Побочный эффект очистки
кэша: reconcile раз в минуту логирует 8 invariant-несоответствий (`audio-orch`/
`video-orch` в фазе `DONE` против удалённого `asset-state:*`) — действий и
диспатчей нет; лечится пересборкой `animastor:asset-state:*` из PG (отдельная
задача).

Документы:
[stage150-queue-inventory.md](https://github.com/Animastor/animastor-backend/blob/main/stage150-queue-inventory.md),
[stage148-hotfix.md](https://github.com/Animastor/animastor-backend/blob/main/stage148-hotfix.md).

## Порядок

1 → 2 → 3 → включение воркеров. Пункты 1 и 2 — код/ветки, 3 — данные прода
(только SELECT; изменение очереди — отдельная задача с бэкапом Redis).
