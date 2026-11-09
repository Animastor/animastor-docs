# Разведка пути видео (ORCHESTRATION_V2_RECON_VIDEO)

Дата: 2026-11-07. Тип: разведка, только чтение кода. Код, прод, Redis и `.env` не менялись; агрегатные запросы к PG не выполнялись. Документ фиксирует фактический legacy-контур видео и подготовленные, но не подключённые элементы ядра v2. Архитектурных предложений нет, кроме перечня решений, которые прямо оставлены для этапа 3.

## Версии кода

| Репозиторий | Коммит (main) | Дата | Префикс в ссылках |
|---|---:|---|---|
| animastor-backend | `c8fb5c0` | 2026-11-07 | `backend/…`, `packages/…` |
| animastor-gpu-hub | `3b4f1ae` | 2026-11-07 | `hub:` = корень репо |
| animastor-worker | `c7c43b5` | 2026-11-07 | `worker:` = `packages/animastor-worker/worker/` |
| animastor-web | `d9cb135` | 2026-11-05 | `web:` = корень репо |
| animastor-android | `be1233c` | 2026-11-05 | `and:` = `frontends/android/app/src/main/java/com/example/animastor/` |
| animastor-docs | `130b38d` | 2026-11-07 | `docs:` = корень репо |

## Методика и границы

- До чтения выполнен `git -C src/<repo> status --porcelain` для всех шести репозиториев; вывод пуст. Читались только `src/<repo>` на `main`, включая ADR и две прежние разведки.
- Не запускались сервисы, тесты, команды Docker, Redis и `.env`; PG также не читался. Поэтому ниже нет утверждений о фактическом числе строк или текущих значениях прод-данных.
- «Не найдено» означает результат статического поиска по указанным репозиториям, а не доказательство отсутствия при исполнении.
- Ссылки проверены скриптом после подготовки документа: 88 ссылок `файл:строка` (33 файла), файл существует, номер строки не превышает длину файла, 0 ошибок. Смысл 16 случайно выбранных ссылок сверен вручную.

## Сводка

| Что | Сколько | Раздел |
|---|---:|---|
| Форм артефакта видео | 2: групповой `_gN.mp4`, итоговый сцены `.mp4` | 1, 3 |
| Виды GPU-работ | legacy `job_type='video'`; в ядре v2 `video_group` (`gpu:video`) | 1, 7, 8 |
| Локальные работы | legacy-склейка внутри video-orch; в ядре v2 `video_merge` (`local`) | 3, 8 |
| Эндпоинты чтения/воспроизведения | 4: scene/chunk × `video` | 6 |
| Семейства Redis-ключей видео | 7 | 5 |
| Таблицы PG, относящиеся к видео | 3: `scene_assets`, `generation_tasks`, `gen_jobs` | 5 |
| Вызовы фронтов (web / Android) | 3 / 4 | 6 |

## Содержание

1. Единицы работы видео
2. Входные файлы и путь к воркеру
3. Склейка, имена и очистка
4. Workflow LTX
5. Где живёт «готово»
6. Читатели web и Android
7. Хаб, воркер и установщик
8. Отличия от v2
9. Расхождения ADR с кодом
10. Странности

## 1. Единицы работы видео

### 1.1 Legacy-диспетчеризация

Legacy scheduler вызывает `scene-orchestrator.executeVideoDispatch`; тот проверяет доступность стадии и вызывает `video.generateVideoAnimation`, затем инициализирует `video-orch` состоянием всех групп: `packages/animastor-orchestration/src/legacy/orchestration/scene-orchestrator.js:508`, `:542`, `:555`. `video-service` строит по одному job spec на workflow-группу, с `job_id={scenePrefix}_gN:video`, `job_type='video'`, workflow в `params`, base64-картинками в `assets.images`, `build_id`, `dispatch_id`, `workflow_name` и `unit_ids`: `backend/src/video/video-service.js:87`, `:98`, `:123`.

Задача передаётся через provider, а не напрямую сервисом видео: `backend/src/video/video-service.js:11`. Legacy тип результата — `scene_video`; `task-handler` передаёт его в `video-orchestrator.completeGroup`: `backend/src/services/task-handler.cjs:628`.

### 1.2 Как образуются группы `gN`

`buildVideoWorkflows` берёт IU сцены в порядке `collectSceneUnits`, считывает для каждого `estimated_duration_sec` из `image_units` (fallback 1 секунда), вызывает `selectWorkflowGroups`, а затем берёт последовательные срезы исходного массива: `backend/src/workflows/video/video-workflows.js:428`, `:437`, `:448`, `:453`. В состоянии Redis сохраняются `suffix` и `unit_ids` каждой группы: `backend/src/services/video-orchestrator.js:86`.

Алгоритм — динамическое программирование: минимизирует суммарную надбавку LTX выравнивания кадров и мягкий штраф за длительность выше 20 секунд. Ограничения: максимум 4 IU, для группы из более чем одного IU длительность не больше `VIDEO_CHUNK_MAX_SEC` (по умолчанию 30); на равной цене предпочитается более крупная левая группа: `backend/src/workflows/video/video-workflows.js:546`, `:564`, `:589`, `:601`, `:621`. Длительность связана с аудио только через сохранённую оценочную длительность IU; стабильность между повторными разборами отдельно не хранится и не гарантируется: группы заново вычисляются из текущих IU и их метаданных.

### 1.3 Таймаут и повтор

Legacy берёт `video_timeout_minutes` из layer-config при dispatch: `packages/animastor-orchestration/src/legacy/orchestration/scene-orchestrator.js:538`. Hub сохраняет в очереди переданный `timeout_ms`, с нижней границей собственного `GPU_TIMEOUT_MS`: `hub:gpu-hub.js:1031`. В v2-дефолтах уже есть 60 минут для `video_group` и 20 минут для `video_merge`; общий retry-policy: transient два повтора 30/120 секунд, OOM один через 60 секунд, invalid result один: `packages/animastor-orchestration/src/gen/ports.js:45`, `:87`.

## 2. Входные файлы и путь к воркеру

### 2.1 Legacy: IU PNG → base64 → `COMFY_INPUT_DIR`

Для каждой IU `video-service` читает `{OUTPUT_DIR}/{build_id}/{book}_{chapter}_{scene}_{unit}.png`, отвергает отсутствующий или файл меньше 1024 байтов и превращает байты в base64: `backend/src/video/video-service.js:61`. Имя, переданное в workflow, имеет ту же формулу; base64 помещается в `assets.images[unit.id]`: `backend/src/video/video-service.js:106`.

Воркер v2-пути декодирует base64, создаёт `COMFY_INPUT_DIR`, записывает файл с полученным именем и ждёт до 5 секунд, пока размер файла совпадёт с ожидаемым: `worker:worker.cjs:522`, `:538`. Затем workflow передаётся ComfyUI. `COMFY_INPUT_DIR` по умолчанию `/home/jovyan/ComfyUI/input`, output — соседний `../output`: `worker:worker.cjs:106`.

### 2.2 V3

В worker v3 очистка умеет принять `inputFiles`, но запуск `runV3Task` передаёт пустой массив: `worker:worker.cjs:1196`. Поиск не находит реализации `GET /internal/gen/jobs/:id/input/:name`: текущий внутренний маршрут монтирует только claim, beacon, result и error: `backend/src/orchestration-v2/routes.js:4`. Следовательно, описанный в ADR §8.1 файловый канал в текущем коде не реализован; v3 аудио не нуждается во входных файлах.

Приём результата v2 потоковый: стандартный максимум 512 МиБ, временный файл создаётся рядом с итоговым в `.incoming`, на лету считаются sha256 и размер: `backend/src/orchestration-v2/index.js:60`, `packages/animastor-orchestration/src/gen/accept.js:363`. Ограничение nginx `client_max_body_size` статически в этих шести репозиториях не найдено; его значение из ADR не проверялось по прод-конфигурации.

## 3. Склейка, имена и очистка

### 3.1 Имена и запись

Канон имён: групповой `{prefix}_gN.mp4`, итоговый `{prefix}.mp4`; первая группа тоже `_g1`, поскольку несусффиксное имя зарезервировано для плеера: `packages/animastor-generation/src/core/artifact-naming.js:67`, `:72`; `backend/src/video/video-service.js:100`. Legacy task-handler сперва кладёт байты группового результата, потом `completeGroup` ожидает все группы в порядке массива состояния: `backend/src/services/video-orchestrator.js:247`, `:355`.

### 3.2 Склейка

Когда все валидные `_gN` есть на диске, video-orch ставит `MERGING`, вызывает `mergeSceneVideoGroups`, после успеха — `DONE` и `completeStage`: `backend/src/services/video-orchestrator.js:362`, `:376`, `:408`. Склейка защищена Redis NX-lock на 300 секунд: `backend/src/video/video-merge.js:392`. Она берёт файлы в переданном порядке suffixes; при нескольких группах подрезает их под audio/start_ms timeline и склеивает через ffmpeg concat с `-c copy` и `+faststart`: `backend/src/video/video-merge.js:400`, `:441`; `:99`.

Аудио сцены в итоговый scene mp4 **не накладывается** на этом пути: merge использует длительности IU для выравнивания, но `muxVideoAudio` — отдельная экспортная функция, не вызываемая `mergeSceneVideoGroups`: `backend/src/video/video-merge.js:113`, `:392`, `:615`. Переходы из `book.json` в этой функции не читаются; поиск в legacy video merge не находит их применения. Группы остаются на диске после итоговой склейки: `backend/src/services/video-orchestrator.js:40`.

### 3.3 Удаление

Удаление книги сопоставляет canonical scene audio/video и расширения `.mp3/.png/.mp4`, а также удаляет ключи `video-orch` и `scene-video`: `backend/src/services/entity-cleanup.cjs:160`, `:255`. В v2 `DELETE /book/:id/cache` отменяет gen-команды и очищает только `.incoming` по списку job id; постоянные video-артефакты должны быть покрыты обычной очисткой сущности: `backend/src/orchestration-v2/routes.js:332`, `:355`.

## 4. Workflow LTX

Для группы builder клонирует шаблон, через connector получает `sourceImages`, `totalFrames`, positive/negative prompt; подставляет имена в LoadImage, frame index в LTXVAddGuide, последний кадр заполняет неиспользованные слоты, output prefix — `video/{scenePrefix}`: `backend/src/workflows/video/video-workflows.js:343`, `:359`, `:378`, `:399`, `:409`.

Число кадров — сумма округлённых `duration × 24 fps`, минимум 24 на IU, затем выравнивание к `8n+1`: `backend/src/workflows/video/video-workflows.js:515`, `:519`, `:540`. Prompt собирает character video tokens, location/environment, для каждого IU временную строку с `video.action` (fallback image prompt), shot и lip movement для dialogue speaker: `backend/src/workflows/video/video-workflows.js:211`, `:232`, `:245`, `:283`. Negative prompt сочетает уникальные unit/scene negatives и базовый профиль: `backend/src/workflows/video/video-workflows.js:309`, `:328`.

## 5. Где живёт «готово»

| Хранилище | Запись/признак | Источник |
|---|---|---|
| Диск | `{OUTPUT_DIR}/{build}/{prefix}_gN.mp4`, затем `{prefix}.mp4` | `backend/src/services/video-orchestrator.js:229`; `packages/animastor-generation/src/core/artifact-naming.js:67` |
| Redis | `animastor:video-orch:{book}:{chapter}:{scene}`: phase, groups (`suffix`, `unit_ids`, status), счётчик | `backend/src/services/video-orchestrator.js:54`, `:86`, `:195` |
| Redis | `animastor:scene-video:{book}:{chapter}:{scene}`, TTL 86400, status | `backend/src/video/video-service.js:164` |
| Redis | `animastor:video-merge-lock:{…}`, NX EX 300 | `backend/src/video/video-merge.js:392` |
| Redis | `animastor:asset-state:{…}` поле `video`, `animastor:chunk:{id}` поля `video`, `video_status` | `packages/animastor-orchestration/src/legacy/orchestration/scene-callbacks.js:484`, `:503` |
| Redis | legacy hub `animastor:queue:video`, running/dedup `animastor:job:*:{job_id}` | `hub:gpu-hub.js:60`; `backend/src/services/video-orchestrator.js:447` |
| PG | `scene_assets`, `asset_type='video'`, status/path/job_id/sha256/metadata | `backend/src/storage/postgres/repositories/scene-assets-repo.js:177`, `:210` |
| PG | `generation_tasks` legacy tasks; v2 `gen_jobs` имеет kinds для видео | `backend/src/routes/book/generation-routes.cjs:904`; `packages/animastor-orchestration/src/gen/util.js:57` |

`scene_assets` legacy обновляется после callback сцены; reader-методы получают asset по типу video: `backend/src/storage/postgres/repositories/scene-assets-repo.js:711`, `:416`. В v2 acceptance обновляет `gen_jobs` и затем scene asset в транзакции: `packages/animastor-orchestration/src/gen/accept.js:329`. Фактические агрегаты `scene_assets(asset_type='video')`, `gen_jobs(layer='video')`, `generation_tasks(type='video')` не снимались.

## 6. Что читают web и Android

| Контур | Читает/вызывает | Поведение | Источник |
|---|---|---|---|
| Backend player | `GET /api/v1/scene/:book/:chapter/:scene/video` | ищет итоговый scene MP4 и отдаёт Range `video/mp4` | `packages/animastor-player/src/scene-media.cjs:74` |
| Backend player | `GET /api/v1/chunk/:id/video` | legacy chunk → итоговый MP4, Range | `packages/animastor-player/src/scene-media.cjs:46` |
| Web player | status сообщает `video_ready`, видео не входит в bundle; загружается direct URL при включённом слое | fallback — IU image | `web:packages/animastor-web-player/src/playbackStore.ts:137`; `web:packages/animastor-web-player/src/PlayPage.tsx:236` |
| Web generate | конфигурация/прогресс и start/cancel по общим generator API для `video` | отдельного v2-video вызова нет | `web:packages/animastor-web-generator/src/taskStatus.ts:69`; `web:packages/animastor-web-generator/src/progressRows.ts:295` |
| Android player | `buildSceneVideoUrl` → scene endpoint с `build_id` и version | прогрессивный playback; отсутствие видео оставляет иной слой | `and:ui/PlaybackViewModel.kt:226` |
| Android API | scene и chunk video endpoints | stream response | `and:repository/BackendApi.kt:33`; `:388` |
| Android generate | UI имеет Generate/Stop video, layer config и video timeout | legacy/general route surface | `and:ui/WorkerSettingsFragment.kt:47`; `and:ui/GenerateViewModel.kt:154` |

Плееры выбирают итоговый MP4 сцены, не `_gN`; при его отсутствии поверх остаётся картинка IU. Web скрывает `<video>` если `videoVisible` или `layerVideo` false: `web:packages/animastor-web-player/src/PlayPage.tsx:236`, `:255`. Android строит тот же scene URL и использует video surface: `and:ui/PlayFragment.kt:1351`.

## 7. Хаб, воркер и установщик

Hub принимает тип worker из credential; v3 `GET /v3/task/next?type=…` не ограничен audio в самом hub: сверяет тип с credential и relay-ит его backend как `worker_type`: `hub:gpu-hub.js:2280`. Поэтому video credential технически совместим с v3 relay; выдача video зависит от backend claim и v2 host ports, которые сейчас video не планируют: `backend/src/orchestration-v2/index.js:81`.

Воркер определяет video по output-node, ждёт `task.timeout_ms` либо video fallback, OOM распознаёт по CUDA-тексту; для v3 timeout шлёт `/interrupt` и error class `timeout`: `worker:worker.cjs:661`, `:577`, `:1155`. Beacon v3 может получить cancel и вызвать `/interrupt`, не загружая результат: `worker:worker.cjs:931`, `:955`. Legacy hub имеет отдельные queue/timeout sweep и нормализует error class `oom`: `hub:gpu-hub.js:648`, `:480`.

Манифест установщика содержит профиль `video/ltx-2.3`, custom node `ComfyUI-LTXVideo` и video manifest `ltx-2.3.json`: `packages/animastor-installer/tests/installer-v026.test.js:66`; `packages/animastor-installer/ai/install-manifests/video/ltx-2.3.json:1`. Установочный allowlist включает workflow из manifest; hub выдаёт только allowlisted workflows: `hub:gpu-hub.js:1727`. По статическому коду нельзя установить, есть ли у владельца реально зарегистрированная video-нода.

## 8. Отличия от v2

### 8.1 Уже есть в ядре

`KINDS`, executor и layer уже содержат `video_group → gpu:video` и `video_merge → local`; `video_group` входит в first stage: `packages/animastor-orchestration/src/gen/util.js:57`. Время, retry и MP4 validation готовы: `packages/animastor-orchestration/src/gen/ports.js:87`; `packages/animastor-orchestration/src/gen/validate-media.js:349`. `accept.transitions` уже умеет: после всех `video_group` создать `video_merge`, после последнего `iu_image` запросить `planUnits(..., 'video')`; `sceneStageComplete` проверяет latest jobs одной build/сцены: `packages/animastor-orchestration/src/gen/accept.js:211`, `:248`, `:262`.

Но host создаёт только audio/image ports: `backend/src/orchestration-v2/index.js:24`, и для video возвращает `[]`; `byKind` направляет всё не-`iu_image` в audio port: `backend/src/orchestration-v2/index.js:76`, `:81`. Следовательно, вызов video v2 сейчас неработоспособен, хотя generic core перечисляет его.

### 8.2 Порты

| Порт | Сегодня | Для video по существующим фактам |
|---|---|---|
| `planUnits` | audio и image; video возвращает `[]` | Нужен planner групп, стабильный `unit_key`, snapshot входных IU |
| `buildPayload` | audio/image workflow snapshot | Нужен video workflow и способ доставить его кадры |
| `artifactPath` | audio/image, иначе ошибка unsupported kind | Нужны пути `_gN.mp4` и scene `.mp4` |
| `runLocal` | только `audio_merge` | Нужен local `video_merge` поверх accepted groups |
| `validateResult` | default validator уже выбирает MP4 | Дополнительного порта по типу не требуется для magic `ftyp` |
| `onArtifactPlaced` | image удаляет preview, audio marker | Нужен только если video publication потребует побочного действия |

Контракт всех обязательных портов определён в `packages/animastor-orchestration/src/gen/ports.js:8`; audio host явно выбрасывает ошибку для неизвестного kind: `backend/src/orchestration-v2/audio-ports.js:83`.

### 8.3 Вопросы, оставленные кодом для решения

- Нет реализации канала кадров (`input/:name`), хотя legacy отправляет base64.
- Нет video planner, поэтому нет `part_hash` группы из sha256 входных кадров и нет проверки чистоты IU по `metadata.gen_parts[unit_key].part_hash` ни при планировании, ни в переходе.
- В существующем summary/progress статически не найдены поля `skipped_image_dirty`, `skipped_needs_image`, `image_failed`, `image_cancelled`.
- `video_merge` core создаётся только по готовности всех video_group; зависимость от готового audio сцены в transition отсутствует: `packages/animastor-orchestration/src/gen/accept.js:267`.
- Legacy-ready IU без `gen_parts` (в частности с `build_id NULL`) в v2 image planner не классифицируются как допустимый video input: planner image строит hash только из текущего workflow: `backend/src/orchestration-v2/image-ports.js:69`.

## 9. Расхождения ADR §6.3, §6.5, §7 с кодом

1. ADR описывает видео как следующий этап; backend host прямо говорит «Video is not on v2 yet» и не подключает video ports: `backend/src/orchestration-v2/index.js:4`, `:88`.
2. ADR §8.1 предусматривает URL входного файла; внутренний HTTP surface кода такого маршрута не содержит: `backend/src/orchestration-v2/routes.js:4`.
3. ADR §6.5 предполагает чистоту принятых IU и причины пропуска; generic `accept` после IU только вызывает `planUnits`, без такой проверки, а host planner video отсутствует: `packages/animastor-orchestration/src/gen/accept.js:270`.
4. ADR описывает video_merge как часть v2; legacy merge выполняется сразу внутри callback `completeGroup`, а не как `gen_jobs` local job: `backend/src/services/video-orchestrator.js:374`.
5. ADR результата v2 использует raw stream и лимит; это реализовано, но nginx-лимит не установлен/не подтверждён кодом этих репозиториев: `packages/animastor-orchestration/src/gen/accept.js:363`.

## 10. Странности (только факты)

- Комментарий `readIUMetadata` говорит «SQLite», но фактически делает запрос к PostgreSQL `image_units`: `backend/src/workflows/video/video-workflows.js:46`.
- `video-service` объявляет `FPS = 24`, а workflow использует отдельный `VIDEO_FPS` из environment: `backend/src/video/video-service.js:18`; `backend/src/workflows/video/video-workflows.js:515`.
- Итоговое scene video не содержит аудио, несмотря на то, что выравнивается по audio timeline; отдельный mux существует, но в scene merge не вызывается: `backend/src/video/video-merge.js:441`; `:618`.
- Legacy state `scene-video` имеет TTL сутки, тогда как `video-orch` является отдельным состоянием групп; их статусы могут иметь разные сроки жизни: `backend/src/video/video-service.js:174`; `backend/src/services/video-orchestrator.js:107`.
- Worker v3 уже умеет отмену beacon/`/interrupt`, но v2 legacy-канал всё ещё опирается на очередь и hub timeout sweep: `worker:worker.cjs:955`; `hub:gpu-hub.js:648`.
