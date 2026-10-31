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
| реестр задач + PG `generation_tasks` | `cancelled` | cancel-worker, `PUT /layer-config` X=false, cancel-generation | команда отменена пользователем или выключением слоя |
| PG `scene_assets` | `cancelled` | те же отмены | бывшая `pending`-строка отменённой стадии; `ready` / `placeholder` / `stale` не трогаются; reconcile и C8 её как работу не читают |
| PG `scene_assets` | `failed` (`error: blocked:no_worker:<type>`) | `no_worker_available` | бывшая `pending`-строка заблокированной стадии |
| PG `book_generation_sessions` | `failed` (`error: interrupted: …`) | старт backend: сессии `generating` / `pending` | окно VBook прервано перезапуском, не возобновляется само |
| asset-state (Redis) | `dirty` вместо `pending` | no_worker, Stop All, осиротевший GENERATING без команды | стадия освобождена, но в работу не поставлена |

progress-panel показывает строки `blocked` и `interrupted` (поля `status`,
`blocked`, `blocked_reason`, `interrupted`), но не считает их «в работе».

## Команды и отмены

- `POST /regenerate`: задачи только для включённых слоёв. Выключенные слои из
  `worker_types` отбрасываются (`skipped_worker_types` в ответе). Если не
  осталось ни одного — **409** `{error:'layer_disabled', disabled_worker_types}`,
  tombstone и cancel flag при этом **не** снимаются. Принятая команда снимает
  cancel flag и tombstone (флаг без TTL следующей команде не мешает),
  вытесняет `blocked`/`interrupted` задачи тех же типов на тех же сценах и
  создаёт новые.
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

## Выкатка

Образ backend ставит `@animastor/orchestration` из npm. Порядок: публикация
0.3.0 (владелец) → коммит `backend/package.json` + lock на `^0.3.0` → тесты →
merge → approve-коммит → CI → digest → `up -d backend`.
