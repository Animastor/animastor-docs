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
в обеих линиях — fast-forward невозможен. Нужны конфликтный разбор
(не терять изменения `main` в этих 22 файлах) и прогон тестов
`stage143a-*`, `stage146/d2`, `stage147-a1`, `stage141-ready-chain-idempotency`.

Документы ветки:
[stage143a-checkpoint.md](https://github.com/Animastor/animastor-backend/blob/feature/gpu-queue-143a/stage143a-checkpoint.md),
[stage147-a1-and-release-plan.md](https://github.com/Animastor/animastor-backend/blob/feature/gpu-queue-143a/stage147-a1-and-release-plan.md).

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

Документы:
[stage150-queue-inventory.md](https://github.com/Animastor/animastor-backend/blob/main/stage150-queue-inventory.md),
[stage148-hotfix.md](https://github.com/Animastor/animastor-backend/blob/main/stage148-hotfix.md).

## Порядок

1 → 2 → 3 → включение воркеров. Пункты 1 и 2 — код/ветки, 3 — данные прода
(только SELECT; изменение очереди — отдельная задача с бэкапом Redis).
