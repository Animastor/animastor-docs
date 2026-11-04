# Генерация только по команде

> **Статус:** Current (2026-10-31). Правило владельца. Реализация:
> animastor-backend ветка `fix/command-only-generation` (`e03bc9a`, `e0074f1`),
> `@animastor/orchestration` 0.3.0.
> **Основание:** разбор инцидента BA (`reports/2026-10-31/auto-image-task-ba-incident.md`,
> §6, §8). Там reconcile сам запустил image после готового аудио при выключенном
> слое image, и эта задача по кругу повторялась 13 часов.

## Правило

GPU-генерация (audio / image / video) запускается **только** кнопками
«аудио» / «картинки» / «всё». Это команда `POST /api/v1/book/:id/regenerate`,
она создаёт задачи реестра. Нет автозапусков следующих стадий и нет фоновых
запусков. Задачи создаются только для слоёв, включённых в layer-config.

## Живой режим отложен

Живой режим (генерация книги на лету со стриминговым буфером) отложен решением
владельца 31.10.2026 из-за стоимости GPU. Текущий продукт — студия: генерация
только по команде, с правкой героев и раскадровки. Код окон сохранён за
`WINDOW_AUTO_NEXT_ENABLED` (off); при возврате к живому режиму он должен идти
отдельной явной командой «смотреть вживую», а не фоном.

## Инвариант

Сцена×стадия попадает в active index и в dispatch **только** когда выполнены
все три условия:

1. есть **активная** задача реестра (`animastor:generation-progress:<book>`,
   PG `generation_tasks`), созданная явной командой: в её `targets` есть эта
   сцена, а её `type` — эта стадия;
2. слой стадии включён в layer-config книги;
3. у книги нет отмены (Redis cancel flag / PG tombstone `generation_cancellations`).

Инвариант вычисляется в одном месте: `@animastor/orchestration`
`runtime/command-gate.js` (`getAuthorizedStages`). Его используют:

| Точка | Поведение |
|---|---|
| `active-scenes-index.addActiveScene` | единственный путь записи в active index; без авторизованной стадии сцена **не** записывается (`{added:false, denied:true}`). Через неё пишут все: `/regenerate`, reconcile, scene-window, book-diff, debug-роуты, player (`iu-media`) |
| `runtime-scheduler.shouldScheduleAssets` | диспатчатся только авторизованные стадии; сцена без них считается `allDone` и уходит из индекса |
| `reconciliation-engine.applyFix` | фиксы, которые ставили работу, выполняются только для авторизованной стадии |
| `scene-window.startScene` | без авторизованной стадии сцена не стартует, окно дальше не сдвигается |

Если реестр не читается, срабатывает fail-closed: стадия не авторизована.

**Следствие:** без команды стадия не может быть PENDING. Мёртвый или неотправленный
GENERATING без команды переводится в **DIRTY** (FSM-валидный переход), а не в
PENDING.

## Бывшие автозапуски и что с ними стало

| № (§6 разбора) | Место | Было | Стало |
|---|---|---|---|
| 1 | reconcile фаза D, `PROGRESS_TO_IMAGE` / `PROGRESS_TO_VIDEO` | после audio/image READY ставил следующую стадию, layer-config не смотрел | **удалено**; partial build остаётся только диагностикой (`report.partialBuilds`) |
| 2 | `REGENERATE_MISSING_ASSET` | READY без файла → PENDING + индекс | только под активной командой этой стадии, иначе диагностика в логе |
| 3 | `RELEASE_STALE_LEASE`, `MOVE_TO_PENDING` | снимал lease и возвращал сцену в работу | только для авторизованных стадий; без команды — диагностика. Осиротевший GENERATING без команды → DIRTY |
| 3a | `RECOVER_ORPHAN_ASSETS` | ставил audio PENDING | реестр ассетов чинится, audio PENDING — только под командой |
| 4 | C8 `rebuildWorkList` (старт) | по PG-маркерам ставил PENDING + индекс | пересобирает только **факты** asset-state: READY для доказанного файла; DIRTY для READY без файла и для устаревшего или помеченного артефакта. PENDING и индекс не пишет; PLACEHOLDER не трогает |
| 5 | tick: повтор после `no_worker_available` | стадия возвращалась в PENDING, повтор каждую минуту | стадия **blocked**: GENERATING → DIRTY; задача реестра `blocked` (`blocked_reason: no_worker:<type>`); PG `generation_tasks.status=blocked`; PG `scene_assets` pending → `failed` с причиной. Автоповтора нет, повтор — только новой командой |
| 6 | `isInFlight`-override в `shouldScheduleAssets` | PENDING/GENERATING перебивали выключенный слой | **удалён**, вместе с fallback «без задачи — по layer-config» |
| 7 | force-dispatch | книжный флаг `animastor:force-dispatch:<book>` (120 с) на всю книгу | набор `animastor:force-dispatch-stages:<book>` — только сцены×стадии этой команды |
| 8 | `startup-resume` | на старте перезапускал окна `generating/pending` | сессии → `failed` с `error='interrupted: …'`, ничего не запускается. Задачи реестра `active` → `interrupted` (Redis + PG), active index очищается **до** старта планировщика |
| 9 | `window-generator` | регистрировал сцены нового окна в GPU; после окна запускал следующее из очереди | сцены в GPU не регистрируются (в том числе placeholder-сцены). Следующее окно — за флагом `WINDOW_AUTO_NEXT_ENABLED` (по умолчанию **выключен**) до решения владельца. Тот же флаг закрывает `scene-window.trySlideWindowOnComplete` |
| 10 | placeholder-audio read-repair | создаёт silent-mp3 | без изменений: файл-заглушка, не GPU-работа |
| 11 | Phase A `recoverResultKeys` | доигрывает потерянные результаты | без изменений: принимает результат, работу не создаёт |
| 12 | `markVersionStaleDirty` | READY → DIRTY и сразу в работу | только помечает stale (READY → DIRTY + PG stale) для включённых слоёв; диспатч решает гейт |
| — | `iu-media` (player, GET чанка) | клал сцену в active index для «редиспатча» | запись проходит через гейт → без команды отклоняется |
| — | `book-diff.markDirtyScenes` (правка в редакторе) | клал сцену в индекс, планировщик диспатчил по layer-config | запись проходит через гейт → без команды отклоняется |

## Window-generator больше не ставит сцены на GPU

`backend/src/services/window-generator.cjs` (окна VBook, `trigger-next-window`)
создаёт чанки и placeholder-аудио новых сцен, но **не** записывает их в active
index. Параметр запроса `register_for_gpu` больше ничего не делает. GPU-работа
по этим сценам начинается только после команды «аудио»/«картинки»/«всё».

## Флаг WINDOW_AUTO_NEXT_ENABLED

Переменная окружения backend, читается при каждом вызове
(`runtime-config.windowAutoNextEnabled()`). Значения `1`/`true`/`on` включают
флаг, всё остальное — **выключено (по умолчанию)**. Флаг управляет двумя
автозапусками:

- window-generator: после окна обработать следующую сессию из очереди
  (`queued`). При выключенном флаге очередь ждёт явной команды;
- `scene-window.trySlideWindowOnComplete`: сдвиг окна сцен после их
  завершения. При выключенном флаге возвращает `reason: 'auto_next_disabled'`.

Даже с включённым флагом гейт не стартует сцену без задачи реестра. Окно
останавливается на такой сцене, указатель окна дальше не сдвигается.

## Статусы

| Где | Статус | Когда ставится | Что значит |
|---|---|---|---|
| реестр задач (Redis) + PG `generation_tasks` | `blocked` | `no_worker_available` при dispatch стадии | нет живого воркера нужного типа; `blocked_reason: no_worker:<type>`; стадия → DIRTY; задача ничего не авторизует, повтор — только новой командой (она вытесняет blocked-задачу) |
| реестр задач + PG `generation_tasks` | `interrupted` | старт backend: все `active` / `queued` / `running` | прогон прервал перезапуск; возобновление только кнопкой (новая команда вытесняет interrupted-задачу) |
| реестр задач + PG `generation_tasks` | `failed` | терминальная ошибка GPU-попытки (deterministic / unknown или исчерпаны повторы transient / oom), §«Повтор после ошибки воркера» | `error_class` / `error_code` / `error_message` / `failed_scene`; задача ничего не авторизует; повтор — только новой командой (вытесняет failed-задачу) |
| реестр задач + PG `generation_tasks` | `cancelled` | cancel-worker, `PUT /layer-config` X=false, cancel-generation | команда отменена пользователем или выключением слоя |
| PG `scene_assets` | `cancelled` | те же отмены | бывшая `pending`-строка отменённой стадии; `ready` / `placeholder` / `stale` не трогаются; reconcile и C8 её как работу не читают |
| PG `scene_assets` | `failed` (`error: blocked:no_worker:<type>`) | `no_worker_available` | бывшая `pending`-строка заблокированной стадии |
| PG `scene_assets` | `failed` (`error: gpu_failed:<class>:<message>`) | терминальная ошибка GPU-попытки | бывшая `pending`-строка упавшей стадии |
| asset-state (Redis) | `failed` | любая ошибка GPU-попытки (и во время паузы повтора) | планировщик не диспатчит; повтор политики переводит FAILED → PENDING только под живой командой |
| PG `book_generation_sessions` | `failed` (`error: interrupted: …`) | старт backend: сессии `generating` / `pending` | окно VBook прервано перезапуском, не возобновляется само |
| asset-state (Redis) | `dirty` вместо `pending` | no_worker, Stop All, осиротевший GENERATING без команды | стадия освобождена, но в работу не поставлена |

progress-panel показывает строки `blocked`, `interrupted` и `failed` (поля
`status`, `blocked`, `blocked_reason`, `interrupted`, `failed`, `error_*`), но
не считает их «в работе».

## Команды и отмены

- `POST /regenerate`: задачи только для включённых слоёв. Выключенные слои из
  `worker_types` отбрасываются (`skipped_worker_types` в ответе). Если не
  осталось ни одного — **409** `{error:'layer_disabled', disabled_worker_types}`,
  tombstone и cancel flag при этом **не** снимаются. Принятая команда снимает
  cancel flag и tombstone (флаг без TTL следующей команде не мешает),
  вытесняет `blocked`/`interrupted`/`failed` задачи тех же типов на тех же
  сценах и создаёт новые.
- `PUT /layer-config` с `X_enabled=false` останавливает стадию X по книге:
  задачи реестра и строки PG → cancelled; lease и копии в очереди хаба
  снимаются; GENERATING без lease → DIRTY; сцены без авторизованной стадии
  уходят из индекса; PG `scene_assets` pending → `cancelled`. В ответе есть поле
  `cancelled_stages`.
- `POST /cancel-worker` по `task_id` действует только на цели задачи, по `type` —
  на стадию по всей книге. Та же процедура
  (`backend/src/services/stage-cancellation.cjs`).
- `POST /cancel-generation`: всё прежнее, плюс PG `scene_assets` pending →
  `cancelled` по всем стадиям; осиротевший GENERATING → DIRTY (раньше PENDING);
  force-набор очищается.

## Контракт (изменения)

- `GET /progress-panel` показывает **только реальные задачи реестра**. Синтетических
  строк `task_id=null` больше нет. Новые поля строки: `status`
  (`active|completed|cancelled|blocked|interrupted`), `blocked`, `blocked_reason`,
  `interrupted`. Строки blocked/interrupted видимы, но не «в работе»
  (`any_incomplete` их не учитывает).
- PG: `scene_assets.status` += `cancelled`; `generation_tasks.status` +=
  `blocked`, `interrupted` (миграция CHECK при старте backend).
- ProgressEventsPort (O-5): новая операция `blockSceneStage`.
- Фронты (2026-10-31): web (`@animastor/web-generator` 0.2.0 + app) и Android
  0.2.2 показывают blocked «Нет воркера: <тип>» + «Повторить», interrupted
  «Прервано» + «Продолжить», cancelled «Отменено». Повтор — новая явная
  команда `/regenerate` (тот же тип и scope), никогда не автоматически.
  409 `layer_disabled` → «Включите слой «…», чтобы генерировать». Ни один
  фронт не запускает генерацию сам: проверены таймеры, открытие книги и
  завершение стадий. Мёртвый Android `regenerateFromSnapshot` удалён.
  Статус ассета сцены (`scene_assets`) фронты не выводят; при отсутствии
  файла показывается нейтральное «Не сгенерировано».

## Уборка хаба при /regenerate и потерянный claim (2026-11-04)

Основание: `reports/2026-11-04/gpu-generation-stall.md` §5.3, §9.1–9.2.
`/regenerate` одной сцены (audio, `current_scene`) в конце делал
`clearHubDispatches([], { book_id })` → `DELETE /queue/clear?book_id=`. Хаб
удалил running-запись image-задачи **другой** сцены (её результат отклонён
`409 stale_or_unknown_dispatch` и потерян, ≈100 с V100) и queued-задачу
(восстановлена stale-lease recovery только через 7 мин). Отчёт исправления —
`reports/2026-11-04/regenerate-sweep-fix.md`.

- **`/regenerate` убирает на хабе только свои dispatch'и.** Повторная уборка
  после освобождения claim'ов идёт по `?dispatch_id=` тех сцена×стадий,
  которые этот вызов сбросил (`resetScenes` → `dispatchIds`). Book-wide
  `?book_id=` — только при полном перезапуске всей книги: scope `whole_book`
  + `rebuild_all` + все включённые слои книги. Сцена, глава, «с текущей
  сцены», один слой всей книги — никогда (backend
  `services/regenerate-hub-sweep.cjs`). Сброшенные сцены остаются вне active
  index до записи реестра (`readdToActiveIndex:false`), поэтому между
  уборкой и освобождением claim'ов новый dispatch этих сцен появиться не может.
- **Fail-closed в пакете.** `clearHubDispatches([], { book_id })` без
  `allowBookSweep: true` не шлёт ничего (warn `… REFUSED`, `refused: 1`;
  `@animastor/orchestration` 0.3.3). Явные book-wide очистки —
  `/cancel-generation`, очистка кэша, удаление книги — не меняются.
- **Лог.** `[REGENERATE] <book>: command scope=… worker_types=… rebuild_all=…
  client_action=<source id=… trusted=…>|absent ua=…` и
  `[REGENERATE] <book>: hub sweep scope=… dispatch_ids=[…] book_sweep=true|false mode=…`.
- **Потерянный claim доходит до backend сразу.** Хаб v0.2.9 на `409`
  с `detail=no_running_record` один раз шлёт `POST /gpu/task/error`
  `reason=stale_dispatch_result`, `error_class=transient` (фолбэк
  `animastor:error:{job}`), `GPU_HUB_CONTRACT.md` §11.1. Backend проверяет
  identity dispatch'а: отменённый/вытесненный → `rejected`, ничего не
  делается; живой → `failStage` сразу и повтор по политике (класс
  `transient`, код `stale_dispatch`: через 30 с, только под живой командой).
  «Осиротевший» результат **не** принимается: без running-записи хаб не может
  доказать, что отправитель — тот, кто взял задачу (PW-4), а поздний
  результат отменённой работы обошёл бы отмену. Цена — один повтор
  (у ComfyUI результат обычно в кэше, 13:51:57 — 0,3 с).
- **Команда — только по клику (паритет фронтов).** Web и Android шлют
  `/regenerate` только из обработчиков кликов («Старт» диалога масштаба,
  «Повторить» строки): без `UserAction` клика запрос не уходит. В теле —
  аддитивное `client_action {kind:'user_click', source, action_id, trusted}`
  (`source` = `generator.scope_dialog` | `generator.retry_row`). «Старт»
  игнорирует нажатия первые 400 мс после появления диалога (тап, открывший
  диалог, или двойной тап не подтверждает его). Backend пока только логирует
  `client_action` (старые клиенты — `absent`), не отказывает.

## Эпоха dispatch, отмена и stale-записи (2026-11-02)

Основание: `reports/2026-11-02/gpu-e2e-installer-025-logs.md` §6.1, §8 п.3–5.
Запись `animastor:audio-orch:*` отменённой попытки (11:09) пережила отмену.
Новая команда (12:25) унаследовала её `started_at`, и watchdog через 28 с
после dispatch'а пометил здоровый прогон FAILED (`chunk_stall_timeout:4619s`).
Затем последовали `[FAIL-STAGE] Rejected … missing_dispatch_id` и
`[INVARIANT] 1 audio-orch violations`.

- **Каждый dispatch открывает новую эпоху audio-orch.**
  `executeAudioDispatch` переводит запись в WAITING_CHUNKS с
  `started_at=now`, `dispatch_id`, `expected_count`, `chunks_received=0`.
  `fail_reason`, `failed_at` и `last_chunk_at` прошлой попытки удаляются
  (`@animastor/orchestration` 0.3.2, хост `setWaitingChunks(…, epoch)`).
- **Watchdog застоя сверяет dispatch_id.** Запись проваливается, только если
  её `dispatch_id` равен живому `dispatch-meta` сцены. Запись без
  `dispatch_id` (legacy) или другого dispatch получает статус
  `stale_state_ignored`: одна info-строка на запись, FAILED не ставится.
- **`failStage` без `dispatch_id`** возвращает
  `{failed:false, reason:'stale_state_ignored'}`. Это штатный no-op, а не
  `Rejected`. `failWaitingScene` без идентичности dispatch ничего не пишет:
  нет FAILED, нет сброса dedup и нет нарушения инварианта.
- **Отмена чистит состояние сцены.** `cancel-generation` (по книге) и
  `cancelStage` (cancel-worker, `layer-config` X=false; сцены × стадия)
  удаляют записи `audio-orch`/`video-orch` не в фазе DONE и
  dispatch-receipts `animastor:dispatch-intent:*` отменённых job'ов. Поздний
  результат отменённого dispatch'а отклоняется как `receipt_missing`.
  `dispatch-completed:*` остаются до TTL: по ним поздний callback
  распознаётся как финализированный.

## Повтор после ошибки воркера

> Решение владельца 02.11.2026. Реализация: animastor-backend `e88210f`
> (merge `1900578`; `backend/src/services/gpu-error-classifier.cjs`,
> `backend/src/services/gpu-retry-policy.cjs`), воркер 2.2.3 `262d08a`
> (merge `6443aa2`), gpu-hub `fcba751` + repin v0.2.8 `0311abc` (merge
> `c190ce2`). `@animastor/orchestration` не менялся. Отчёт:
> `reports/2026-11-02/gpu-retry-policy.md`.

**Основание.** Разведка 02.11 11:08–11:12 (задача 6323, `sc-3708615c`).
Воркер 2.2.0 брал задачу и через ~0.1 с отвечал `task/error` «No prompt_id»:
ComfyUI без qwen-нод отклонял prompt. Backend считал ошибку `transient`
(`FAIL-STAGE → PENDING`, retry budget 10). Активная задача реестра продолжала
авторизовывать стадию, и за 85 с прошло 6 dispatch'ей. Остановили их circuit
breaker и ручная отмена.

**Правило.** Инвариант «только по команде» распространяется и на повторы.
Ошибка попытки сначала классифицируется, и класс определяет, будет ли повтор:

| Класс (`error_class`) | Что сюда входит | Повторы | Пауза | Потом |
|---|---|---|---|---|
| `deterministic` | ComfyUI отклонил prompt: HTTP 400, `node_errors`, «No prompt_id», нет класса ноды, неверный workflow, модель не найдена, несовместимый протокол задачи | 0 | — | failed |
| `transient` | таймаут выполнения; сеть или HTTP 5xx между воркером и хабом/ComfyUI; воркер пропал (протух heartbeat, хаб `worker_timeout`) | 2 | 30 с, затем 120 с | failed |
| `oom` | CUDA out of memory | 1 | 60 с | failed |
| `unknown` | всё остальное (fail-closed) | 0 | — | failed |

Повтор выполняется только если **в момент окончания паузы** команда ещё
жива. Это значит: задача реестра, которой принадлежала упавшая попытка, всё
ещё `active`, и command gate авторизует сцену×стадию (активная задача, слой
включён, отмены нет). Отмена, выключение слоя, новая команда или рестарт
backend во время паузы снимают повтор. Пользователь повторяет сам кнопкой,
а `/regenerate` снимает failed как обычно: новая команда вытесняет задачу
`failed` так же, как `blocked`/`interrupted`.

**Классификатор** (`gpu-error-classifier.cjs`, чистая функция с таблицей
правил) работает с любым воркером 2.2.0+. Порядок:

1. Структурное поле воркера `error_class` (2.2.3+): `deterministic` /
   `transient` / `oom`.
2. `comfy_status`, HTTP-статус ComfyUI `POST /prompt`: 400 → deterministic,
   5xx → transient.
3. Правила по тексту `reason` для старых воркеров, причин хаба и watchdog'ов:
   OOM → deterministic → transient.
4. Иначе `unknown`.

Выход классификатора: `error_class`, `error_code` (уточнение:
`comfy_rejected`, `comfy_missing_node`, `comfy_model_missing`,
`comfy_invalid_workflow`, `worker_lost`, `execution_timeout`, `network`,
`cuda_oom`, `unknown`) и `error_message`. `error_message` — одна строка
до 200 символов, без стектрейса.

**Механика** (`gpu-retry-policy.cjs`, на стороне хоста):

- Все источники ошибки попытки идут через политику: хаб `/gpu/task/error`,
  watchdog застоя audio/video (`failWaitingScene`) и reconcile-доигрывание
  недоставленных ошибок хаба (`animastor:error:*`). Composition root
  оборачивает фасад `orchestrator.failStage`; вызов с явным
  `redispatch:false` идёт напрямую.
- Стадия всегда переводится в FAILED **без** немедленного возврата в
  PENDING (`failStage(…, {redispatch:false})`). Планировщик FAILED не
  диспатчит.
- Повтор: запись `animastor:gpu-retry:pending:<book>:<ch>:<sc>:<stage>` и
  таймер в процессе. По окончании паузы запись забирается через `DEL`
  (выполняется ровно один раз). Затем проверяются задача и гейт, после
  чего FAILED → PENDING и сцена добавляется в active index (через гейт).
  Dispatch делает обычный tick.
- Терминальный провал: задачи реестра этой стадии, нацеленные на сцену,
  переходят в `failed` (`error_class`, `error_code`, `error_message`,
  `failed_scene`, `attempts`). PG `generation_tasks.status=failed`
  (`error = gpu_failed:<class>:<message>`), PG `scene_assets` pending →
  `failed` с той же причиной. Задача `failed` ничего не авторизует.
- Счётчик попыток ведётся на (задача реестра × сцена × стадия), ключ
  `animastor:gpu-retry:attempts:*` (24 ч). Каждая попытка пишется в журнал
  сцены: `GPU_ATTEMPT_FAILED` (класс, причина, решение),
  `GPU_RETRY_SCHEDULED`, `GPU_RETRY_REQUEUED`, `GPU_RETRY_SKIPPED`
  (причина: `task_cancelled`, `cancelled`, `layer_disabled`, `interrupted`,
  `asset_<state>`), `GPU_FAILURE_TERMINAL`.
- Ошибка без активной команды: стадия FAILED, повтора нет (`no_command`).
  Поздний или чужой сигнал, который `failStage` отклонил, игнорируется.
- Рестарт backend во время паузы: задачи становятся `interrupted`
  (startup-resume), записи `pending` удаляются и журналируются как
  `interrupted`. Запись чужого процесса (`boot_id`) не исполняется.
- Retry budget и circuit breaker `@animastor/orchestration` остаются
  внешней защитой. Half-open probe берёт только PENDING-стадии, а
  deterministic-провал в PENDING не возвращается, поэтому probe его не
  повторяет. Retry budget (10 на сцену×стадию) при не более чем 3
  попытках не исчерпывается.
- Хаб сам задачу в очередь не переставляет. Единственное исключение —
  orphan-requeue: ремонт доставки после падения хаба между RPOPLPUSH и
  записью running, не более 3 раз, потом `orphaned_task` → backend, класс
  `unknown`. См. `GPU_HUB_CONTRACT.md` §13.
- Воркер 2.2.3 распознаёт `execution_error` в history ComfyUI и сообщает о
  нём сразу. До 2.2.3 воркер ждал таймаута результата, поэтому CUDA OOM
  выглядел как таймаут. OOM даёт `error_class=oom`; остальные ошибки
  выполнения идут без класса, backend считает их `unknown`.

### Статус задачи и генерации (контракт API)

`GET /api/v1/book/:id/progress-panel`, строка задачи, новые поля
(аддитивно):

| Поле | Значение |
|---|---|
| `status` | += `failed` |
| `failed` | `true` для `failed`; такая строка видима, но не «в работе» (`any_incomplete` её не учитывает) |
| `failed_scene` | `{chapter_id, scene_id}` сцены, на которой команда упала, или `null` |
| `error_class` | `deterministic` \| `transient` \| `oom` \| `unknown` \| `null`: у `failed` — класс терминальной ошибки; у `active` во время паузы — класс последней ошибки |
| `error_code` | уточнение класса (список выше) или `null` |
| `error_message` | короткий текст без стектрейса (≤200 символов) или `null` |
| `retrying` | `true`, пока задача `active` и ждёт паузы повтора |
| `retry_no` / `retry_max` | номер повтора и максимум (transient — 2, oom — 1) |
| `retry_at` | время повтора (мс epoch) или `null` |

Ответ хабу на `/gpu/task/error`: `{ok, failed, reason, redispatch:false,
policy:{action: failed|retry_scheduled|no_command|ignored, error_class,
error_code, error_message, attempt, retry_no?, pause_ms?, due_at?}}`.

### Отображение на фронтах (2026-11-03)

Web (`@animastor/web-generator` 0.3.0 `taskStatus.ts` + app `GeneratePage.tsx`)
и Android (`TaskStatusHelpers.kt` + `GenerateFragment.kt`, 0.2.5) — одной
задачей, паритет по `ANDROID_WEB_PARITY.md` (ТЗ —
`reports/2026-11-02/gpu-retry-policy.md` §«ТЗ фронтам»).

- **Состояние строки.** Приоритет: `cancelled` > `blocked` > `interrupted` >
  `failed` > `done` > `active`. `failed` — «остановленная» строка (как
  blocked/interrupted): без спиннера и таймера, без автоповтора.
- **Строка `failed`.** Основной текст — `причина — имя задачи`. Причина
  выбирается чистым `failureText(error_class, error_code, error_message, type)`
  → i18n-ключ + аргумент (первая строка `error_message`, «…» если строк
  больше; фронт сообщение не разбирает):
  `comfy_missing_node` → `task_failed_comfy_nodes`,
  `comfy_model_missing` → `task_failed_comfy_model`,
  `deterministic` → `task_failed_comfy_rejected`,
  `transient` → `task_failed_transient`, `oom` → `task_failed_oom`,
  остальное → `task_failed_unknown`. Пустой аргумент — суффикс « — …»
  отбрасывается. Кнопка «Повторить» — новая явная команда `/regenerate` с тем
  же типом и scope (`retryCommandFor`).
- **Подпись сцены.** Если scope ≠ `current_scene` и есть `failed_scene` — под
  строкой мелко `Scene N — Title` / `Cover` по уже загруженной книге (как
  backend считает `scene_label`); сцены нет в книге → `chapter_id/scene_id`.
- **Пауза повтора.** Строка с `retrying=true` остаётся `active` (спиннер,
  таймер, «стоп»); под ней мелко «Повтор `retry_no`/`retry_max` через mm:ss»
  — отсчёт до `retry_at` по часам клиента, после него «Повтор…» до следующего
  опроса progress-panel; ниже — причина последней ошибки (тот же
  `failureText`). Фронт при этом ничего не делает — повторяет сервер.
- **Старый backend** без новых полей — строки как раньше (поля
  необязательные).

## Выкатка

Образ backend ставит `@animastor/orchestration` из npm. Порядок: публикация
0.3.0 (владелец) → коммит `backend/package.json` + lock на `^0.3.0` → тесты →
merge → approve-коммит → CI → digest → `up -d backend`.
