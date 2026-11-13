# Разведка пути изображения (ORCHESTRATION_V2_RECON_IMAGE)

Дата: 2026-11-06. Тип: разведка, только чтение кода (изменений в коде и на проде нет). Документ фиксирует текущее устройство слоя изображения по коду пяти репозиториев; архитектурных предложений не содержит. Привязка — к ADR `architecture/ORCHESTRATION_V2.md` (§4.3 — `scene_assets`, §6.3 — переходы стадий, §7 — приём результата) и к формату `architecture/ORCHESTRATION_V2_RECON.md`.

## Версии кода

| Репозиторий | Коммит (main) | Дата коммита | Префикс в ссылках |
|---|---|---|---|
| animastor-backend | `59b06b1` | 2026-11-06 | `backend/src/...`, `packages/...` (пакет оркестрации — `packages/animastor-orchestration/src/...`) |
| animastor-gpu-hub | `f39e704` | 2026-11-06 | `hub:` = корень репо |
| animastor-worker | `db3bdb9` | 2026-11-06 | `worker:` = `packages/animastor-worker/worker/` |
| animastor-web | `d9cb135` | 2026-11-05 | `web:` = корень репо |
| animastor-android | `be1233c` | 2026-11-05 | `and:` = `frontends/android/app/src/main/java/com/example/animastor/` |
| animastor-docs | `3c75fb2` | 2026-11-06 | `docs:` = корень репо |

Каждая ссылка `файл:строка` указывает на строку в этих коммитах. Пакет `@animastor/orchestration` лежит в `packages/animastor-orchestration` в корне репо backend (не в `backend/packages`).

## Методика и границы

- Читался только исходный код (backend, worker, gpu-hub, web, android) и документ ADR. Ничего не запускалось, прод-БД и Redis не читались, `.env` не открывался.
- Проверялись только статические факты: имена файлов, ключи, поля, вызовы. Поведение во время выполнения (реальные значения в Redis/PG прода, порядок файлов в каталоге) не проверялось.
- «Писателя нет» означает «поиск по репозиториям не нашёл записи»; это не доказательство отсутствия во время выполнения.
- Ссылки проверены скриптом: 144 ссылки `файл:строка` (44 файла) — файл существует, номер строки не больше длины файла, 0 ошибок; смысл строк выборочно сверен по 16 случайным ссылкам.

## Сводка

| Что | Сколько | Раздел |
|---|---|---|
| Форм юнита/артефакта изображения | 4: IU-кадр (`iu_image`), превью (`pr-*`), «сценовый» legacy-кадр `{prefix}.png`, обложка (сцена `cover` через те же IU) | 1 |
| GPU-видов работ изображения | 1 (`iu_image`, executor `gpu:image`) | 1, 6 |
| HTTP-эндпоинтов backend, связанных с изображением | 14 (10 чтения/готовности, 2 запуска/отмены, 2 приёма результата GPU) | 4 |
| Имён файлов на диске (раздел 2.1) | 5: 3 PNG изображения (`{prefix}_{unitId}.png`, `{prefix}_pr-{hex}.png`, `{prefix}.png`) + 2 MP4 видео (`_gN` и склейка) | 2 |
| Семейств Redis-ключей | 6 (`iu-registry`, `iu-in-flight`, `iu-progress`, `iu-progress-ids`, `chunk`, `asset-state`) | 3 |
| Таблиц PG | 3 базовые (`image_units`, `scene_assets`, `generation_tasks`) + 2 при `IU_IMAGE_VERSIONED` (`iu_image_pointers`, `iu_image_fence_reservations`) | 3 |
| Вызовов с фронтов (web / Android) | 4 / 5 | 4 |

## Содержание

1. Единицы работы изображения
2. Имена файлов и пути
3. Где живёт «готово»
4. Что читают web и Android
5. Зависимость видео от изображения
6. Отличия от v2-аудио: что влезает в существующие порты, что требует нового
7. Странности (общий раздел)

---

## 1. Единицы работы изображения

### 1.1 Кто создаёт GPU-задачу

Генерация изображения — **только legacy-контур**. Цепочка вызовов:

1. Периодический runtime-scheduler отбирает сцену для стадии `image`, если `assetStates.image != READY|FAILED|GENERATING` и слой включён: `packages/animastor-orchestration/src/legacy/runtime/runtime-scheduler.js:326-331`.
2. Диспетчер сцены вызывает `image.generateSceneIUImages(...)`: `packages/animastor-orchestration/src/legacy/orchestration/scene-orchestrator.js:456-464`.
3. `generateSceneIUImages` собирает юниты сцены (`collectSceneUnits`) и по одному вызывает `processSingleIU`: `backend/src/image/iu-processor.js:432-467`.
4. `processSingleIU` строит `job_id = provider.buildJobId(imageIUId, 'iu_image')` и отправляет полный workflow через `provider.generate({ jobId, workflow, jobType: 'image', buildId, dispatchId })`: `backend/src/image/iu-processor.js:354-361`.

Оркестрация v2 в этот путь не вмешивается: маршрут v2 отклоняет `worker_types`, отличные от `audio`, и передаёт в `createCommand` жёстко `layers: ['audio']`: `backend/src/orchestration-v2/routes.js:148-156,188`; `planUnits` v2-хоста возвращает `[]` для любого слоя, кроме аудио: `backend/src/orchestration-v2/audio-ports.js:99-100`.

### 1.2 Идентификаторы, тип и стадия

| Поле | Значение | Источник |
|---|---|---|
| Канонический id юнита | `unit.id` из payload сцены (`units[]` и `dialogue_blocks[].units[]`) | `backend/src/image/registry.js:174-187` |
| Формат нового id | `iu-<8 hex>` (legacy — `iu0001`) | `packages/animastor-vbook-runtime/src/lazy-book/paths.js:20-25` |
| `imageIUId` (assetId) | `{book}_{chapter}_{scene}_{unitId}` | `packages/animastor-generation/src/core/artifact-naming.js:88-90` |
| `job_id` | `{imageIUId}:iu_image` | `packages/animastor-contracts/src/job-protocol-v2.js:58-66` |
| `jobType` (провод) | `'image'` | `backend/src/image/iu-processor.js:357-358` |
| Вид работы v2 | `kind='iu_image'`, executor `gpu:image`, слой `image` | `packages/animastor-orchestration/src/gen/util.js:58-71` |
| Очередь хаба | `animastor:queue:image` | `hub:gpu-hub.js:60,373-391` |
| Таймаут хаба | 600 000 мс (10 мин) на задачу | `hub:gpu-hub.js:227-230` |
| Таймаут v2 (если бы шло через v2) | `iu_image: 30 * 60_000` | `packages/animastor-orchestration/src/gen/ports.js:81-89` |

### 1.3 Payload

Payload — **полный снимок ComfyUI-workflow** `img-qwen-image`, в котором исполнитель меняет ровно два текстовых узла:

| Что | Значение / узел | Источник |
|---|---|---|
| Workflow целиком | `wfImg = provider.loadWorkflow('img-qwen-image')`, уходит как `workflow` | `backend/src/image/iu-processor.js:328,357` |
| Positive prompt | узел `108`, `inputs.text` = `buildImagePrompt(...)` | `backend/src/image/iu-processor.js:326,332`; `backend/ai/connectors/conn-image-generation.json:27-34` |
| Negative prompt | узел `109`, `inputs.text` = `{custom}, {baseNegative}` | `backend/src/image/iu-processor.js:329-333`; `backend/ai/connectors/conn-image-generation.json:35-43` |
| Seed | `458007174637134` — статичен в файле workflow, не патчится | `backend/ai/workflows/img-qwen-image.json:67-70` |
| Размер | `width 768`, `height 1024` — статичен (узел 110) | `backend/ai/workflows/img-qwen-image.json:56-59` |
| Steps | `8` — статичен (узел 120) | `backend/ai/workflows/img-qwen-image.json:67-70` |
| LoRA | `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors`, `strength_model 0.6` — статична | `backend/ai/workflows/img-qwen-image.json:126-129` |
| Сэмплер/CFG/scheduler | `euler` / `2` / `normal` — статичны | `backend/ai/connectors/conn-image-generation.json:84-108` |

Коннектор объявляет параметры `width/height/steps/cfg/sampler/scheduler/seed` (`backend/ai/connectors/conn-image-generation.json:54-120`), но исполнитель вызывает `applyValue` только для `positivePrompt` и `negativePrompt` (`backend/src/image/iu-processor.js:332-333`) — остальные значения остаются такими, какие лежат в JSON workflow.

### 1.4 Входные файлы и ссылки

- **Нет входных изображений.** В `provider.generate` передаются только `jobId`, `workflow`, `jobType`, `buildId`, `dispatchId`; поля `assets`/референсов нет: `backend/src/image/iu-processor.js:354-361`. Это чистое text-to-image.
- Референсы/персонажи влияют только на **текст** промпта: `buildImagePrompt(unit, sceneData.payload, sceneData.chapter, loadedBook, ...)`: `backend/src/image/iu-processor.js:326`; сборка промпта — `backend/src/image/prompt-builder.js:340-390`.
- Побочная запись при отправке — метаданные IU в PG `image_units` (текст, длина, пропорция, длительность, имя аудиофайла сцены): `backend/src/image/iu-processor.js:100-125`; таблица — `backend/src/storage/postgres/repositories/iu-repo.js:17-23`.

### 1.5 Четыре формы артефакта

| Форма | Кто создаёт | Job / триггер | Имя | «Готово» |
|---|---|---|---|---|
| IU-кадр | GPU-воркер по задаче backend | `job_id ...:iu_image`, `jobType='image'` | `{book}_{ch}_{sc}_{unitId}.png` | файл на диске + counters/asset-state (раздел 3) |
| Превью | **backend**, лениво на GET | запрос `GET /preview/...` | `{book}_{ch}_{sc}_pr-{hex}.png` (240 px) | наличие файла; создаётся из IU |
| «Сценовый» legacy-кадр | писателя в текущем коде не найдено | остался только читатель | `{book}_{ch}_{sc}.png` | файл на диске |
| Обложка | тот же GPU-путь, что IU | сцена главы `type='cover'` | `{book}_{ch}_{sc}_{unitId}.png` | те же механизмы; отдельного job нет |

Обложка не имеет отдельного типа задачи: это первая сцена главы `type='cover'`, её юниты генерируются тем же `generateSceneIUImages` (`backend/src/image/iu-processor.js:432-467`). Legacy-роут `/regenerate` лишь гарантирует, что сцена обложки попадёт в грязные сцены при `whole_book` (`backend/src/routes/book/generation-routes.cjs:675-719`), а `assets-state` отдельно считает `coverIuTotal/coverIuReady` (`packages/animastor-player/src/playback-queue.cjs:182-205`).

---

## 2. Имена файлов и пути

### 2.1 Канон имён

Все имена строятся из `scenePrefix = {book}_{chapter}_{scene}`: `packages/animastor-generation/src/core/artifact-naming.js:37-39`.

| Артефакт | Формула | Пример | Источник |
|---|---|---|---|
| IU-кадр | `{prefix}_{unitId}.png` | `bk_ch1_sc2_iu-1a2b3c4d.png` | `packages/animastor-generation/src/core/artifact-naming.js:51-54` |
| Превью | `{prefix}_pr{strippedUnitId}.png`, где `stripped = unitId.replace(/^iu/,'')` | `bk_ch1_sc2_pr-1a2b3c4d.png` | `packages/animastor-generation/src/core/artifact-naming.js:61-65` |
| Legacy «сцена» | `{prefix}.png` | `bk_ch1_sc2.png` | `packages/animastor-generation/src/core/artifact-naming.js:56-59`; reader: `packages/animastor-player/src/artifact-naming.cjs:42-44` |
| Группа видео | `{prefix}_g{N}.mp4` (N≥1) | `bk_ch1_sc2_g1.mp4` | `packages/animastor-generation/src/core/artifact-naming.js:67-70` |
| Склейка видео | `{prefix}.mp4` | `bk_ch1_sc2.mp4` | `packages/animastor-generation/src/core/artifact-naming.js:72-75` |

Путь на диске — `{OUTPUT_DIR}/{build_id}/{имя}`: путь собирает `resolveAssetPath` по суффиксу job_id (`backend/src/services/cleanup-service.cjs:125-177`), запись — `fs.writeFileSync(asset.fullPath, ...)` в task-handler (`backend/src/services/task-handler.cjs:482-489`).

### 2.2 Что такое `pr-`

`pr-` — **превью (thumbnail) IU-кадра**, а не отдельная генерация. Префикс `pr` + id юнита без ведущего `iu`. Бэкенд получает запрос `GET /api/v1/preview/:book/:chapter/:scene/:iuId` и при отсутствии файла строит его через `sharp`, ресайз до ширины 240 px: `backend/src/image/preview.js:26-29,70-71,109-110`; ширина — `backend/src/image/helpers.js:58`. Воркер превью не делает.

Особенность: в URL `:iuId` уже содержит дефис (`iu-1a2b3c4d`), `replace(/^iu/,'')` оставляет `-1a2b3c4d`, поэтому имя превью — `..._pr-1a2b3c4d.png` (дефис сохраняется): `backend/src/image/preview.js:27-29`; `packages/animastor-generation/src/core/artifact-naming.js:61-65`.

### 2.3 Кто пишет, переименовывает, удаляет

| Действие | Кто | Источник |
|---|---|---|
| Пишет IU PNG | task-handler: результат из `/gpu/task/result` кладётся по `asset.fullPath` | `backend/src/services/task-handler.cjs:482-489` |
| Пишет versioned IU (флаг ON) | `publishVersionedIuImage` → `.versions/{asset}/{fence}.png` + указатель в PG | `backend/src/services/task-handler.cjs:103-...` (см. 3.3) |
| Атомарная публикация (fenced) | staging → rename в канонический путь | `backend/src/services/task-handler.cjs:417-471` |
| Пишет превью | backend, лениво в `getOrCreatePreview` | `backend/src/image/preview.js:26-121` |
| Удаляет превью при новой публикации IU | task-handler | `backend/src/services/task-handler.cjs:253-270` |
| Удаляет превью при смене книги/книги | web, `URL.revokeObjectURL` (blob-URL, не файл) | `web:packages/animastor-web-player/src/playbackStore.ts:345-352,744-751` |
| Удаляет артефакты книги | сервис очистки (по расширениям `.mp3/.png/.mp4`) | `backend/src/services/entity-cleanup.cjs:69` |
| Переименовывает IU-файл | никто (имя детерминировано job_id) | — |

Отдельного «переименования» у изображения нет: канонический путь детерминирован, а versioned-режим публикует новый файл и двигает указатель, не переименовывая старый.

---

## 3. Где живёт «готово»

### 3.1 Диск

- Канонический признак готовности IU «по умолчанию» — наличие `{OUTPUT_DIR}/{build}/{prefix}_{unitId}.png`: `backend/src/image/registry.js:25-40` (`probeIUImage`).
- При `IU_IMAGE_VERSIONED` канонический файл может отсутствовать (файл лежит в `.versions/`), и доказательством служит указатель PG: `backend/src/image/registry.js:115-160` (`resolveIuImagePath`), `:162-...` (`resolveVersionedSceneProof`).

### 3.2 Redis

| Ключ / семейство | Кто пишет | Кто читает | Источник |
|---|---|---|---|
| `animastor:iu-registry:{imageIUId}` | backend при отправке/кэш-хите | оркестрация | `backend/src/image/registry.js:13-20`; `backend/src/image/iu-processor.js:353` |
| `animastor:iu-in-flight:{imageIUId}` (TTL) | iu-processor до отправки | повторная отправка/dispatch finalize | `backend/src/image/iu-processor.js:184,336-340`; `backend/src/config/runtime-config.js:207` |
| `animastor:iu-progress:{book}:{ch}:{sc}:image` | task-handler, инкремент на подтверждённый IU | `computeIuReady`, `assets-state`, progress-panel | `backend/src/services/task-handler.cjs:516-532`; `backend/src/routes/book/iu-progress-utils.cjs:60-67` |
| `animastor:iu-progress-ids:...` | task-handler (идемпотентность подсчёта) | task-handler | `backend/src/services/task-handler.cjs:519-524` |
| `animastor:chunk:{id}` поля `image`, `image_status` | сценовые колбэки/чтение | фронты, `assets-state`, scheduler | `packages/animastor-orchestration/src/legacy/orchestration/scene-callbacks.js:444`; `packages/animastor-player/src/playback-queue.cjs:99-120` |
| `animastor:asset-state:{book}:{ch}:{sc}` поле `image` | фасад оркестратора | scheduler, чтение | `packages/animastor-orchestration/src/legacy/orchestration/orchestrator.js:215-216` |

Счётчик `iu-progress` идемпотентен по паре `iuId:fence`: повторный колбэк того же fence не увеличивает счётчик: `backend/src/services/task-handler.cjs:516-529`.

### 3.3 Postgres

| Таблица | Что хранит для изображения | Источник |
|---|---|---|
| `image_units` | по одному юниту на IU: порядок, текст, длина, пропорция, оценка длительности, имя аудиофайла сцены | `backend/src/storage/postgres/repositories/iu-repo.js:17-40`; запись — `backend/src/image/iu-processor.js:100-125` |
| `scene_assets` | строка сцены `asset_type='image'`: `status`, `path`, `job_id`, `sha256`, `metadata.gen_parts` | `backend/src/storage/postgres/repositories/scene-assets-repo.js:251-...` (`markReady`), `:408` (`getAsset`) |
| `generation_tasks` | legacy-задачи типов `image` (прогресс/отмена) | `backend/src/routes/book/generation-routes.cjs:904-916` |

Сцена помечается готовой **только при полном наборе IU**: task-handler считает `readyCount` по каноническим файлам (и, при флаге, по опубликованным указателям), и при `readyCount >= totalIUs` вызывает `orchestrator.completeStage(..., 'image', ...)`: `backend/src/services/task-handler.cjs:545-566`. `completeStage` пишет PG `sceneAssets.markReady` и Redis `asset-state=READY`: `packages/animastor-orchestration/src/legacy/orchestration/orchestrator.js:205-217`. Сценовый колбэк дополнительно выставляет `image_status='ready'` в chunk: `packages/animastor-orchestration/src/legacy/orchestration/scene-callbacks.js:444`.

### 3.4 `IU_IMAGE_VERSIONED`: указатели и резервации

Флаг читается на каждом вызове (kill-switch), значение по умолчанию — **выключен**: `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js:71-81`.

| Механизм | Таблица/файл | Источник |
|---|---|---|
| Резервация fence по hex-квитанции | `iu_image_fence_reservations`: `idem_key → integer fence + identity` | `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js:8-14,204-240` |
| Указатель публикации | `iu_image_pointers`: `(book, chapter, scene, iu, build) → относительный путь + publish_fence` | `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js:10-15,277-313` |
| Публикация результата | immutable-файл `.versions/{asset}/{fence}.png` (temp → `O_EXCL`), затем upsert указателя; старый fence не перезаписывает новый | `backend/src/services/task-handler.cjs:103-...`; `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js:270-300` |
| Чтение «опубликовано» | `listPublishedIuIds` — доказательство готовности сцены | `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js:326-335` |
| Чтение для отдачи/превью | `resolveIuImagePath`, `resolveVersionedSceneProof` | `backend/src/image/registry.js:115-...`, `:162-...` |

При флаге OFF все функции-читатели возвращают `null/[]` без обращения к PG (`:204`, `:243`, `:277`, `:315`, `:326`, `:338`, `:363`) — легаси-поведение байт-в-байт.

### 3.5 Состояние на проде

- Флаг по умолчанию выключен: `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js:78-81`.
- В конфигурации прода и репозитория деплоя ссылок на `IU_IMAGE_VERSIONED` нет: `grep -rn "IU_IMAGE_VERSIONED" prod/ src/animastor-deploy/ --include=*.yml --include=*.yaml --include=*.json --include=*.sh` не даёт совпадений; в backend флаг встречается только в коде/тестах (`packages/animastor-player/src/iu-media.cjs:319`, `backend/tests/stage143a-phase2bc-consumers.test.js:6`).
- Вывод (по статической конфигурации): на проде изображения публикуются и читаются по каноническому пути, таблицы `iu_image_pointers`/`iu_image_fence_reservations` в работе не участвуют. Проверка значений `.env` не выполнялась (правило секретов).

---

## 4. Что читают web и Android

### 4.1 Эндпоинты изображения (backend)

| # | Метод + путь | Регистрация | Что отдаёт |
|---|---|---|---|
| 1 | GET `/api/v1/iu-image/:bookId/:chapterId/:sceneId/:iuId` | `packages/animastor-player/src/iu-media.cjs:313` | PNG конкретного IU (указатель при флаге, иначе канонический файл) |
| 2 | GET `/api/v1/preview/:bookId/:chapterId/:sceneId/:iuId` | `packages/animastor-player/src/iu-media.cjs:371` | PNG-превью 240 px (создаёт при отсутствии) |
| 3 | GET `/api/v1/chunk/:id/storyboard` | `packages/animastor-player/src/iu-media.cjs:175-306` | список IU сцены + `build_id` (поле `ius`) |
| 4 | GET `/api/v1/scene/:bookId/:chapterId/:sceneId/storyboard` | `packages/animastor-player/src/scene-data.cjs:108-...` | storyboard сцены |
| 5 | GET `/api/v1/chunk/:id/image` | `packages/animastor-player/src/scene-media.cjs:32-43` | первый `{prefix}*.png` каталога |
| 6 | GET `/api/v1/scene/:bookId/:chapterId/:sceneId/image` | `packages/animastor-player/src/scene-media.cjs:88-100` | первый `{prefix}*.png` каталога |
| 7 | GET `/api/v1/book/:bookId/storyboard` | `backend/src/routes/book/export-routes.cjs:73` | zip изображений книги |
| 8 | GET `/api/v1/book/:bookId/cover` | `packages/animastor-editor/src/editor-routes.cjs:740-753` | JSON первой сцены главы `cover` (не картинка) |
| 9 | GET `/api/v1/book/:bookId/assets-state` | `packages/animastor-player/src/playback-queue.cjs:94` | счётчики готовности, в т.ч. `image_ready`, `all_image_ready`, `cover_*` |
| 10 | GET `/api/v1/book/:bookId/progress-panel` | `backend/src/routes/book/progress-panel.cjs:405` | строки прогресса задач |
| 11 | POST `/api/v1/book/:bookId/regenerate` | `backend/src/routes/book/generation-routes.cjs:483` | запуск слоя image (legacy) |
| 12 | POST `/api/v1/book/:bookId/cancel-worker` | `backend/src/routes/book/generation-routes.cjs:196` | отмена `image`/`cover` |
| 13 | POST `/gpu/task/result` | `backend/src/routes/generation-routes.cjs:430` | приём PNG от воркера |
| 14 | POST `/gpu/task/error` | `backend/src/routes/generation-routes.cjs:666` | ошибка задачи |

### 4.2 Web

- URL кадра: `iuPath()` собирает `/iu-image/{book}/{ch}/{sc}/{unitId}?build_id={buildId}` — **только** `build_id`, без версии/hash: `web:packages/animastor-web-player/src/playbackStore.ts:273-275`.
- Последовательность кадров: storyboard сцены → по каждому `iu.unit_id` `getBlob(iuPath(...))`: `web:packages/animastor-web-player/src/playbackStore.ts:1172-1199`.
- Обложка: первая сцена книги → её storyboard → `iu-image` первого IU: `web:packages/animastor-web-player/src/playbackStore.ts:457-475`.
- Кэш: ключ `(buildId, sceneKey, kind)` с `kind ∈ {audio, video, image, preview, iu}`: `web:packages/animastor-web-player/src/mediaCache.ts:1-30`.
- Опрос готовности генерации: `GET /book/{id}/progress-panel` каждые 1500 мс (`POLL_PANEL_MS`): `web:frontends/app/src/pages/GeneratePage.tsx:40,179-191`. SSE-события изображения не несут отдельной ветки (роутинг типов — `web:packages/animastor-web-generator/src/sseRouting.ts:39-59`).

### 4.3 Android

| Вызов | Эндпоинт | Источник |
|---|---|---|
| IU-кадр | `GET /api/v1/iu-image/...` с `@Query("build_id")` | `and:repository/BackendApi.kt:43-52` |
| Превью | `GET /api/v1/preview/...` с `@Query("build_id")` | `and:repository/BackendApi.kt:54-62` |
| Storyboard сцены/книги | `GET /api/v1/scene/.../storyboard`, `GET /api/v1/book/.../storyboard` | `and:repository/BackendApi.kt:379,286` |
| Сценовое изображение | `GET /api/v1/scene/.../image` | `and:repository/BackendApi.kt:397` |
| Прогресс | `GET /api/v1/book/{bookId}/progress-panel` | `and:repository/BackendApi.kt:475` |

- Кэш кадров — дисковый, ключ по `iuId`/`buildId`: `and:repository/Repository.kt:152-163`.
- Обложка строится из storyboard первой сцены и первого IU, а не из `/cover`: `and:ui/PlaybackViewModel.kt:656-676`.
- Поля `image_ready`, `all_image_ready`, `scope_image_ready` разобраны в моделях: `and:repository/LayerConfig.kt:51,73-88`.

### 4.4 Обложка (факты)

- `GET /api/v1/book/:id/cover` отдаёт JSON сцены обложки, без изображения: `packages/animastor-editor/src/editor-routes.cjs:740-753`.
- Android объявляет метод `getBookCover` и `Repository.getCover` (`and:repository/BackendApi.kt:113`; `and:repository/Repository.kt:200-207`), но вызовов `getCover(` в UI нет — обложка берётся из storyboard/IU (`and:ui/PlaybackViewModel.kt:656-676`).
- Web `/cover` не вызывает; обложка — первый IU первой сцены (`web:packages/animastor-web-player/src/playbackStore.ts:457-475`).
- `assets-state` считает готовность обложки отдельно (`coverIuTotal/coverIuReady`) и только при `image_enabled !== false`: `packages/animastor-player/src/playback-queue.cjs:180-205`.

---

## 5. Зависимость видео от изображения

1. **Планирование.** Scheduler добавляет стадию `video` только если `assetStates.image === READY`; если слой image выключен — проверяет наличие картинок по chunk-ключам (`image === true && image_status === 'ready'`): `packages/animastor-orchestration/src/legacy/runtime/runtime-scheduler.js:334-346,54-75`.
2. **Чтение.** Видео-сервис для каждой группы берёт имя `"{book}_{ch}_{sc}_{unit.id}.png"`, читает файл из `{OUTPUT_DIR}/{build}` и кодирует в base64; отсутствие файла — жёсткая ошибка `images_missing`: `backend/src/video/video-service.js:61-96,117-121`.
3. **Передача.** В задачу кладётся `assets: { images: { [unitId]: base64 } }`: `backend/src/video/video-service.js:119-130`. Путь (path) не передаётся — только basename в workflow и base64 в транспорте.
4. **Workflow.** Узлы `LoadImage` получают `inputs.image = "{book}_{ch}_{sc}_{unit.id}.png"` (basename): `backend/src/workflows/video/video-workflows.js:380-390`.
5. **Воркер.** Раскладывает base64 в `COMFY_INPUT_DIR` под именем `{scenePrefix}_{unitId}.png`, затем ждёт готовности файла: `worker:worker.cjs:1186-1197`.

Следствие: видео зависит от **канонического файла** IU. Versioned-указатель при этом не читается — `readImageAsBase64` смотрит только канонический путь (`backend/src/video/video-service.js:61-64`). При `IU_IMAGE_VERSIONED=ON` канонического файла может не быть (файлы в `.versions/`), и видео-группа получит `images_missing`.

---

## 6. Отличия от v2-аудио: что влезает в существующие порты, что требует нового

### 6.1 Что уже готово в ядре v2 (менять не нужно)

| Механизм | Факт | Источник |
|---|---|---|
| Вид работы `iu_image` | объявлен: executor `gpu:image`, слой `image`, first-stage | `packages/animastor-orchestration/src/gen/util.js:58-73` |
| Таймаут | `iu_image: 30 мин` | `packages/animastor-orchestration/src/gen/ports.js:81-89` |
| Валидация | PNG-сигнатура для `iu_image` | `packages/animastor-orchestration/src/gen/validate-media.js:145-147,164` |
| `scene_assets` | `iu_image` — «part»: пишется `status='pending'` + `metadata.gen_parts[unit_key]`, не `ready` | `packages/animastor-orchestration/src/gen/accept.js:26,86-105` |
| Переход image→video | после последнего IU планируется `video_group` через `planUnits(..., 'video')` | `packages/animastor-orchestration/src/gen/accept.js:194-230` |
| Полнота сцены | `sceneStageComplete` по `gen_jobs.status` для вида работы | `packages/animastor-orchestration/src/gen/accept.js:156-175` |
| Приём результата | атомарный rename в `artifactPath(job)`, запись `result_path/sha` | `packages/animastor-orchestration/src/gen/accept.js:234-283` |
| Транспорт | v3: воркер забирает задачу и делает PUT результата, входных ассетов не несёт | `worker:worker.cjs:994-1008,1092-1101` |

### 6.2 Что нужно добавить для image (по портам)

| Порт | Сегодня (аудио) | Для image | Тип изменения |
|---|---|---|---|
| `planUnits` | возвращает `[]` для `layer !== 'audio'`: `backend/src/orchestration-v2/audio-ports.js:99-100`; юнит аудио несёт `input.workflow_json` + `part_meta`: `:82-96` | нужен планировщик: сцена → юниты (`units[]`+`dialogue_blocks[].units[]`) → один `iu_image` на `unit.id`; `unit_key=<unit.id>`, `input` с промптом/негативом/`scene_hash` | новый модуль (контракт порта не меняется) |
| `buildPayload` | парсит `input.workflow_json`: `backend/src/orchestration-v2/audio-ports.js:113-115` | вернуть полный workflow с пропатченными узлами 108/109 (снимок на этапе планирования либо патч на этапе claim) | новый модуль |
| `artifactPath` | для `iu_image` **бросает** «not supported yet»: `backend/src/orchestration-v2/audio-ports.js:117-127` | `{OUTPUT_DIR}/{build}/{prefix}_{unit_key}.png` (`sceneImageName` + `getOutputPath`) | новый модуль, контракт тот же |
| `runLocal` | только `audio_merge`: `backend/src/orchestration-v2/audio-ports.js:130-160` | не нужен (изображение всегда GPU); порт обязателен (`packages/animastor-orchestration/src/gen/ports.js:34-37`) — оставить бросок | без изменений контракта |
| `validateResult` | уже PNG для `iu_image`: `packages/animastor-orchestration/src/gen/validate-media.js:164` | без изменений | — |
| `onArtifactPlaced` | очистка placeholder-маркера аудио: `backend/src/orchestration-v2/audio-ports.js:161-165` | для image не требуется | — |
| `laneFor/timeoutFor/retryPolicy` | общие дефолты: `backend/src/orchestration-v2/index.js:85-93`; `packages/animastor-orchestration/src/gen/ports.js:81-89` | без изменений | — |

### 6.3 Что требует решения/новых колонок или каналов

1. **`scene_assets.status` для сцены.** Ядро v2 пишет для `iu_image` только `status='pending'` + `gen_parts` (`packages/animastor-orchestration/src/gen/accept.js:86-105`), тогда как legacy помечает сцену `ready` через `markReady` (`packages/animastor-orchestration/src/legacy/orchestration/orchestrator.js:212`; `backend/src/storage/postgres/repositories/scene-assets-repo.js:251`). Нужен шаг «все парты сцены готовы → `scene_assets.status='ready'`» либо перевод читателей на `gen_parts`. Новых колонок не требует (`metadata` — jsonb), но контракт §4.3 меняется.
2. **Redis/legacy-готовность.** v2 не пишет `animastor:iu-progress:*`, `animastor:chunk:*`, `animastor:asset-state:*`; `assets-state` и счётчики Generate-страницы читают именно их (`packages/animastor-player/src/playback-queue.cjs:94-176`; `backend/src/routes/book/iu-progress-utils.cjs:53-67`). `progress-panel` v2 слой-агностичен (`backend/src/orchestration-v2/progress-adapter.js:27-75`), но строка появится только если команда запросила слой `image` (`backend/src/orchestration-v2/routes.js:188` сейчас передаёт только `['audio']`).
3. **Versioned-публикация.** Приём v2 (`finishAccept` → rename) не трогает `iu_image_pointers` и fence-резервации (`packages/animastor-orchestration/src/gen/accept.js:234-283`), а `/iu-image` при флаге ON читает указатель (`backend/src/image/registry.js:115-160`). Совмещение v2-image и `IU_IMAGE_VERSIONED=ON` требует отдельного решения; новых колонок нет.
4. **Видео-вход.** v3-задача не несёт `assets`, воркер чистит `inputFiles: []` (`worker:worker.cjs:1099`), а видео требует base64-картинки и файлы в `COMFY_INPUT_DIR` (`backend/src/video/video-service.js:119-130`; `worker:worker.cjs:1186-1197`). Для image это не нужно (text-to-image, раздел 1.4); для video нужен новый канал входных ассетов либо отдельный порт/колонка.
5. **Грязные юниты.** Legacy таргетирует конкретные IU через `scene_assets.dirty_unit_ids` (`packages/animastor-orchestration/src/legacy/orchestration/scene-orchestrator.js:437-445`; `backend/src/storage/postgres/repositories/scene-assets-repo.js:651-...`), v2 `force` лишь пересоздаёт задачи, а точечность задаётся `scope.level='unit'` (`packages/animastor-orchestration/src/gen/commands.js:26-36`) — планировщик image должен её учитывать.
6. **Переход в видео.** `transitions` для `iu_image` вызывает `planUnits(..., 'video')` (`packages/animastor-orchestration/src/gen/accept.js:217-229`); пока видео-планировщика нет, переход молча создаст ноль задач.

---

## 7. Странности (только факты)

1. **Две несовместимые `sceneImageName`.** В generation — 4 аргумента и суффикс юнита: `{prefix}_{unitId}.png` (`packages/animastor-generation/src/core/artifact-naming.js:51-54`). В player — 3 аргумента и «сценовое» имя `{prefix}.png` (`packages/animastor-player/src/artifact-naming.cjs:42-44`). Одинаковое имя функции, разные контракты.
2. **`/chunk/:id/image` и `/scene/.../image` отдают первый попавшийся PNG.** Роут фильтрует каталог по `{prefix}` и `.png` и берёт `files[0]`: `packages/animastor-player/src/scene-media.cjs:35-41,92-97`. При нескольких IU порядок зависит от `readdir` каталога.
3. **Превью делает backend, а не воркер**, и удаляет его task-handler при каждой новой публикации IU: `backend/src/image/preview.js:26-71`; `backend/src/services/task-handler.cjs:253-270`.
4. **Дефис в имени превью.** `:iuId` = `iu-<hex>`, `replace(/^iu/,'')` даёт `-<hex>`, итог `{prefix}_pr-<hex>.png`: `backend/src/image/preview.js:27-29`; `packages/animastor-generation/src/core/artifact-naming.js:61-65`.
5. **Два словаря одного job.** Провод: `jobType: 'image'` (`backend/src/image/iu-processor.js:357-358`); v2: `kind: 'iu_image'` (`packages/animastor-orchestration/src/gen/util.js:60,68`). Парсер job_id знает и `:iu_image`, и legacy `:image` (`packages/animastor-contracts/src/job-protocol-v2.js:53`).
6. **Legacy `:image` без `_iu` — «scene_image»**, путь тот же `{build}/{assetId}.png`: `backend/src/services/cleanup-service.cjs:165-176`. Писателя для такого имени в текущем коде не найдено, читатели остались (`packages/animastor-player/src/scene-media.cjs:32-43`).
7. **Видео читает только канонический файл**, без versioned-указателя: `backend/src/video/video-service.js:61-64`. При `IU_IMAGE_VERSIONED=ON` и отсутствии канонического файла — `images_missing` (`:117-121`).
8. **`assets-state` считает готовность изображения по `image_status` чанков и счётчику `iu-progress`, а не по `scene_assets.status`**: `packages/animastor-player/src/playback-queue.cjs:135-176`; `backend/src/routes/book/iu-progress-utils.cjs:53-67`. PG-статус сцены и ответ `assets-state` могут расходиться.
9. **`GET /book/:id/cover` реализован, клиент Android его объявляет, но UI не вызывает**: `packages/animastor-editor/src/editor-routes.cjs:740-753`; `and:repository/BackendApi.kt:113`; `and:repository/Repository.kt:200-207`; фактическая обложка — из storyboard (`and:ui/PlaybackViewModel.kt:656-676`).
10. **Маршрут v2 знает про image/video только чтобы отказать**: проверка `t !== 'audio'` → 409: `backend/src/orchestration-v2/routes.js:148-156`; при этом ядро v2 полностью описывает `iu_image` (`packages/animastor-orchestration/src/gen/util.js:58-73`; `packages/animastor-orchestration/src/gen/ports.js:81-89`; `packages/animastor-orchestration/src/gen/accept.js:194-230`).
11. **`IU_IMAGE_VERSIONED` по умолчанию OFF** и отсутствует в конфигурации прода/деплоя: `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js:78-81`; grep по `prod/` и `src/animastor-deploy/` совпадений не даёт.
12. **Счётчик IU идемпотентен по fence, но имена ключей — «на поколение»**: `animastor:iu-progress:*` и `animastor:iu-progress-ids:*` живут с TTL 14 400 с: `backend/src/services/task-handler.cjs:519-524`.
13. **Раскладка base64-картинок для видео зависит от `job_id`**: имя файла = `scenePrefix` из `job_id` (с обрезкой `_gN`) + `unitId`: `worker:worker.cjs:1186-1191`. Тот же `scenePrefix` должен совпасть с `LoadImage` workflow (`backend/src/workflows/video/video-workflows.js:383`).
14. **`image_ready`/`all_image_ready` в ответе `assets-state` — производные поля**, не хранимые статусы: `packages/animastor-player/src/playback-queue.cjs:250-258`.