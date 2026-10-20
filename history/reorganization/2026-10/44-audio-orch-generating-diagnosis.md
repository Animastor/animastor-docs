# Этап 44 — Диагностика `audio_orch` и трёх старых состояний GENERATING

**Дата:** 2026-10-13
**Итог: PASS** — причина warn `audio_orch: …` доказана на код- и runtime-уровне
(не зарегистрированы под-биндинги `media.audio.chunks` / `media.audio.segments`),
исправлено минимальным изменением в composition root (4 файла: 2 production-код +
2 теста), регрессионные тесты добавлены и зелёные (полный набор: 3133 passing /
4 failing — **тот же набор 4, что и на нетронутом pristine-дереве 3130/4**).
Три GENERATING-состояния исследованы read-only: **активных процессов нет**,
состояния — сироты удалённого книги `import_1783656905372_…` (июль); **сброс не
выполнялся**, предложены два варианта безопасного восстановления (ожидают
решения владельца). **Новый образ в production не выкатывался**, DNS/TLS/deploy
`.env`/Compose/locks/PG/Redis/GPU Hub не тронуты.

Отчёт: `/home/animastor/reorg-2026-10-12/44-audio-orch-generating-diagnosis.md`

---

## 0. Краткая сводка

| Блок | Результат |
|---|---|
| A. Источник warn `audio_orch` | **установлен**: `media.audio.chunks` не разрешается → TypeError в startup-фазе C1 |
| Характер | **не безвредное**: фаза C1 падает целиком на первой non-terminal записи (восстановление любого зависшего audio-состояния в проде отключено), плюс 2 recovery-ножки `scene-orchestrator` |
| Исправление | **минимальное, host-side**: composition root добавляет `chunks`/`segments` в `media.audio` (diff 4 файла) |
| Почему не в пакете | вызывающий код пакета верен (соответствует pre-move `require('../audio/chunks')`); `@animastor/orchestration@0.1.1` ставится из npm → фикс в пакете требовал бы репаблиша. Host-side фикс деплоится обычным rebuild backend-образа |
| Тесты (новые) | 3 в `backend/tests/reconciliation-engine.test.js` + guard в `physical-move-gate.test.js` (PM-G9) |
| Тесты (прогон) | reconciliation 58/0 (было 55/0 + 3 новых); arch 927 passing; **полный набор 3133 passing / 4 failing = pristine 3130 / те же 4**; syntax-smoke OK |
| Smoke в production-контейнере | текущий binding → **та же TypeError**; патченный binding → все 4 символа резолвятся (read-only, отдельный процесс) |
| Три GENERATING | сироты удалённого книги; активных процессов/lease/задач/файлов **нет**; последнее событие журнала 2026-07-26 (79 дней назад) |
| Сброс состояний | **НЕ выполнялся** (по условию) — предложены Option 1/2 (§5) |
| Production | изменение **подготовлено и протестировано, не закоммичено, не выкатывается** (§6) |

---

## 1. Источник предупреждения `audio_orch`

### 1.1 Факт в production

Лог текущего backend-контейнера (старт 2026-10-12 15:12, 88 555 строк), две
строки, обе на старте:

```
121: [RECONCILE] ⚠️ Phase C1 failed: Cannot read properties of undefined (reading 'findExistingSceneChunks')
189: [STARTUP] Reconcile errors: audio_orch: Cannot read properties of undefined (reading 'findExistingSceneChunks')
```

Больше `Cannot read properties` в логах нет; строк `AUDIO-ORCH` (ножки
диспатча) за окно — 0 (audio-очередь пуста, воркеров нет).

### 1.2 Код-уровневая цепочка

1. Startup-цикл `reconcileCycle({startup:true})` → фаза **C1**
   `recoverAudioOrchStates()` (`@animastor/orchestration` 0.1.1,
   `reconciliation-engine.js:1897–1993`).
2. Для фаз `GENERATING` / `WAITING_CHUNKS`:
   `const chunks = lazyHostBinding('media.audio.chunks')`
   → `chunks.findExistingSceneChunks(...)` (`reconciliation-engine.js:1929–1930`).
3. `lazyHostBinding('media.audio.chunks')` разбирается как
   `hostBinding('media')['audio']['chunks']` (`host/host-bindings.js:105–113`).
   Composition root `backend/src/backend.cjs:154` до патча отдавал
   `media: () => ({ audio: require('./audio'), … })`, а barrel
   `backend/src/audio/audio-service.js` **плоский** — ключей `chunks`/
   `segments` в нём нет (только `findExistingSceneChunks`, `buildSegments` и
   т.д. «в верхнем уровне»).
   → `undefined['findExistingSceneChunks']` → **TypeError**.
4. `try/catch` обёрнут вокруг **всей фазы** (`reconciliation-engine.js:1609–1616`),
   а не вокруг элемента цикла → первая же запись прерывает обработку **всех**
   остальных → `summary.errors.push('audio_orch: …')` → `console.warn` в
   `backend.cjs:850`.

### 1.3 Ожидаемая регистрация

Патч (этап 44) регистрирует под-модули в media-binding composition root —
ровно те объекты, которые файлы до экстракции требовали напрямую:

| До экстракции (§32.30, commit `41a5690`, 2026-09-13) | После экстракции (ожидание) | Факт до патча |
|---|---|---|
| `require('../audio/chunks')` | `media.audio.chunks` | `undefined` |
| `require('../audio/segments')` | `media.audio.segments` | `undefined` |
| `require('../audio')` | `media.audio` | OK (плоский barrel) |

Доказательство механики перевода: `git show 41a5690` содержит ровно
`-const chunks = require('../audio/chunks');` /
`+const chunks = lazyHostBinding('media.audio.chunks');` (и аналогично для
`segments`); в этом коммите появилась единственная вхождение
`media.audio.chunks` во всём репо.

Вхождения под-путей в пакете — **ровно три** (все recovery-ножки):

| Файл | Вызов | Когда достигается |
|---|---|---|
| `runtime/reconciliation-engine.js:1929` | `chunks.findExistingSceneChunks` | startup-фаза C1 |
| `orchestration/scene-orchestrator.js:175,217` | `segments.buildSegments` | audio-диспатч: состояние отсутствует (`no_state`) / stale-recovery (`invalid_transition`) |
| `orchestration/scene-orchestrator.js:192` | `chunks.findExistingSceneChunks` | stale-recovery `WAITING_CHUNKS`/`MERGING` |

### 1.4 Вредоносность — вердикт

**Не безвредное (структурное нарушение функциональности), но не регрессия
этапа 42 и не влияет на текущий трафик:**

- **Полностью отключена фаза C1** в проде: любое зависшее non-terminal
  audio-состояние (например, после сбоя посреди генерации реальной книги)
  **не будет восстановлено/помечено FAILED ни при одном рестарте** — фаза
  падает на первой же такой записи. Это и есть причина, по которой 3 июльских
  сироты «не доиграны» (§3).
- Две recovery-ножки `scene-orchestrator` (отсутствующее состояние / stale
  WAITING_CHUNKS) упадут с той же TypeError → инициализация/stale-восстановление
  аудио-диспатча недоступны. Обычный (не-recovery) путь аудио-диспатча под-пути
  **не использует** → штатная генерация не задета (за окно 25 мин лога этапа 42
  и 13 ч текущего лога — 0 срабатываний этих ножек).
- **Регрессией rollout этапа 42 не является**: defect появился на экстракции
  `41a5690` (2026-09-13) и присутствует в обоих образах (`e8152778` и
  `e1fac1d2`) — что уже зафиксировано в §5 отчёта 42; сейчас дополнительно
  воспроизведено в самом контейнере (§4.2).

### 1.5 Рассмотренные варианты фикса

| Вариант | Оценка |
|---|---|
| **(chosen)** composition root добавляет `chunks`/`segments` в `media.audio` | минимальный, deployable обычным rebuild backend-образа; не трогает npm-пакет; flat-поверхность `media.audio` сохранена (спред копии, мутации модулей нет) |
| правка 3 call-site в `packages/animastor-orchestration` | отклонён: в production-образ пакет ставится из npm (`^0.1.1`, `npm install` в Dockerfile) → требовал бы bump версии + репаблиша + пересборки образа; правильность call-site подтверждена (это буквальный перевод pre-move requires) |
| «устойчивая к отсутствию биндинга» C1-лега (optional-load → return 0) | отклонён: скрыл бы дефект и оставил recovery-ножки `scene-orchestrator` сломанными |

---

## 2. Изменённые файлы (подготовлено к выкатке)

```
backend/src/backend.cjs                       +14/-2  (production: media-binding)
backend/tests/generation-test-bindings.cjs    +10/-2  (зеркало composition root для тестов)
backend/tests/architecture/physical-move-gate.test.js  +7    (guard PM-G9 на production-сборку)
backend/tests/reconciliation-engine.test.js   +78     (3 регрессионных теста C1)
```

Ключевой фрагмент (`backend/src/backend.cjs`, bindHostModules → `media`):

```js
media: () => ({
    audio: {
        ...require('./audio'),
        chunks: require('./audio/chunks'),
        segments: require('./audio/segments'),
    },
    image: require('./image'),
    video: require('./video'),
}),
```

`packages/animastor-orchestration/**` — **не изменялся** (вызывающий код верен).
`node_modules` — не изменялся.

---

## 3. Три состояния GENERATING — инвентаризация (read-only)

Ключи (Redis, `animastor:`, TTL = **-1**):

```
animastor:audio-orch:import_1783656905372_1783656918982:ch-c779d21c:sc-1eb2306c
animastor:audio-orch:import_1783656905372_1783656918982:ch-c779d21c:sc-45fc1833
animastor:audio-orch:import_1783656905372_1783656918982:ch-c779d21c:sc-5860455d
```

Значения (все три, байт-в-байт отличаются только `started_at`):

```json
{"phase":"GENERATING","expected_count":0,"chunks_received":0,
 "started_at":1784004683190|1784004683204|1784004683219,"build_id":null}
```
`started_at` = **2026-07-14 04:51:23 UTC** (все три в одну секунду).

### 3.1 Связанные записи

| Источник | Что есть | Что нет |
|---|---|---|
| Redis `asset-state:*` ×3 | `audio=dirty, image=dirty, video=dirty` | — |
| Redis `scene-state:*` ×3 | `{"state":"audio_pending","build_id":null}` (updated 2026-07-16 03:21) | — |
| Redis `assets:*` ×3 | только `audio`: `ready:false, chunks:[], canonical=/data/output/{default\|build_import_…}/*.mp3`, `registeredAt` 2026-07-16 07:58 | файлов по этим путям нет |
| Redis `event-journal:*` ×3 | 101 981 / 102 032 / 102 024 событий | событий после **2026-07-26 03:51:50** нет |
| Redis прочее | `trigger_cooldown:<book>` (TTL -1) | нет `animastor:chunk*`, нет lease/dispatch-meta/queue/dispatch-lease для этой книги, нет `book-scenes:*`, нет в `active-scenes` |
| PG `generation_tasks` | **0 строк** для книги (все 17 строк — книга `import_1786345731767…`, авг.) | нет running/queued |
| PG `scenes` | 3 строки, `status=pending`, updated 2026-07-10 | — |
| PG `scene_assets` | 25 строк, `status='stale'` (обновлено **2026-10-12 15:12:06** — фазой C2 того же старта, что и warn) | — |
| PG `books` / `book_events` / `output_manifests` / `asset_states` | **0 строк** | — |
| Диск `/data/books` | **нет каталога** книги (16 записей — других книг) | — |
| Диск `/data/output` | нет ни `build_import_178365…`, ни `default/`, ни чанков этой книги | — |

### 3.2 Активные процессы — проверены, отсутствуют

- `animastor:active-scenes` = только сцена книги `import_1786345731767…` (август);
- `dispatch-lease` / `dispatch-meta` — только по image-задаче августа;
- `queue:image` — 8 (+279 в workspace), **`queue:audio` отсутствует**;
- `https://animastor.org/gpu/health` → `{"gpus":0,…,"running":0}`, аудио-очередь 0;
- контейнеров воркеров нет; PG: 0 queued/running задач по этой книге;
- последнее событие в журналах — **2026-07-26 03:51:50** (79 дней покоя).

**Вывод: реальных активных процессов и незавершённой работы по этим трем
состояниям нет.**

### 3.3 Таймлайн и причина зависания

| Время (UTC) | Событие (источник) |
|---|---|
| 2026-07-10 04:15 | импорт книги `import_1783656905372_1783656918982` (id), `scenes` обновлены в тот же день |
| 2026-07-11 04:14:21 | первая отправка диспатча (event-journal) |
| 2026-07-14 04:51:23 | `audio-orch` переведён в `GENERATING` с `build_id=null, expected_count=0` (0 сегментов → 0 задач) |
| 2026-07-16 03:21 / 07:58 | последние «нормальные» записи `scene-state` / registry `assets` |
| **2026-07-24 16:17:53** | **первый `DISPATCH_CANCELLED reason=scene_not_found`** → сцена перестала находиться в книге (`scene-orchestrator.js:142–149`: `loadBook` → `findSceneRuntimeData` = null) |
| 2026-07-24 16:17 → 2026-07-26 03:51 | горячий цикл: 25 579 dispatch-попыток, 25 492 отмены `scene_not_found`, 25 325 backpressure (≈2900/час) |
| **2026-07-26 03:51:50** | последнее событие; с тех пор тишина |
| 2026-09-13 | экстракция `41a5690`: C1-лега получает сломанный `media.audio.chunks` |
| 2026-10-12 15:12 | старт образа `a7a8c463`: C1 падает (warn), C2 помечает `scene_assets` `stale` |

**Установленная причина зависания (доказана):**

1. **Содержимое книги исчезло с диска не позднее 2026-07-24 16:17** (нет
   каталога `/data/books/<book>`, нет строк `books`, нет ключей
   `book-scenes`, `scene_not_found` с этой секунды) — структура `scenes`/
   `scene_assets` в PG и Redis-ключи сцен остались сиротами.
2. Аудио-FSM застрял в `GENERATING`, потому что **0 сегментов → 0 задач →
   чанков никогда не было** (`chunks_received=0`, `generation_tasks`=0),
   а переход `GENERATING → WAITING_CHUNKS` возможен только по приходу чанка.
3. Единственная **мутирующая** очистка для фазы `GENERATING` — startup-фаза
   **C1** — с 2026-09-13 структурно сломана (§1) и падает на первой записи,
   поэтому состояния не переведены в `FAILED` ни на одном рестарте.
4. Прочие охранники не подходят: watchdog B1 (`checkStalledAudioScenes`)
   обрабатывает **только** `WAITING_CHUNKS`; `checkAudioOrchInvariants` —
   report-only и сканирует только сцены в worklist (книги нет в индексе);
   asset-state = `dirty` (не `generating`), т.е. под image-орфан-ремонт не попадает.

**Недоказанное (зафиксировано как блокер, без догадок):**
- *механизм и точное время удаления содержимого книги* — журналов до
  2026-10-12 15:12 не сохранилось (контейнер backend пересоздан; старых
  контейнеров в `docker ps -a` нет), `book_events`/`output_manifests` пусты;
- *почему `expected_count=0` при `build_id=null`* — восстановить июльские
  параметры сегментации нельзя (контента книги нет); подтверждено лишь то,
  что чанков и задач не существовало никогда.

### 3.4 Судьба трёх состояний — **не сброшены**

Состояния **не изменялись** (только READ: `--scan`, `GET`, `TTL`, `HGETALL`,
`LRANGE`, `TYPE`, SQL `SELECT`). Ожидают решения владельца, варианты в §5.

---

## 4. Тесты и smoke

### 4.1 TDD-доказательство дефекта (до фикса)

Новые тесты на нетронутом дереве → **3 failing**, причём №2 падает с той же
цепочкой, что и в проде:

```
TypeError: Cannot read properties of undefined (reading 'findExistingSceneChunks')
  at Object.get (node_modules/@animastor/orchestration/src/host/host-bindings.js:111:26)
  at Object.recoverAudioOrchStates (.../reconciliation-engine.js:1930:46)
1) media.audio.chunks must be registered: expected undefined to be an object
```

### 4.2 Smoke в production-контейнере (read-only, отдельный процесс `node -e`)

```
CURRENT binding -> TypeError: Cannot read properties of undefined (reading 'findExistingSceneChunks')
PATCHED media.audio.chunks.findExistingSceneChunks: function
PATCHED media.audio.segments.buildSegments: function
PATCHED flat media.audio.findExistingSceneChunks: function
PATCHED flat media.audio.buildSegments: function
```

То есть дефект воспроизводится **внутри запущенного production-образа**, а
патченное выражение резолвится в том же рантайме (node 20, те же `node_modules`).
Никакые данные/состояние процесса не затрагивались.

### 4.3 Прогон тестов (после фикса)

| Набор | Результат |
|---|---|
| `tests/reconciliation-engine.test.js` | **58 passing / 0 failing** (было 55 + 3 новых) |
| `tests/architecture/physical-move-gate.test.js` (PM-G9 с новым guard) | **10 passing / 0** |
| `tests/architecture/*.test.js` | 927 passing / 24 pending / **2 failing** — `IB-G15 (installer private pin)` и `phase5 T9 ENOENT src/runtime/index.js` — **проверены на pristine-дереве: те же 2 (pre-existing)** |
| Полный набор `tests/**/*.test.js` | **3133 passing / 28 pending / 4 failing** |
| Полный набор на pristine (`git stash`, HEAD `a7a8c463`) | **3130 passing / 28 pending / 4 failing** — названия 4 идентичны |
| Failure-set сравнение | **без регрессий**: +3 passing (новые тесты), множество failing не изменилось; 2 из 4 — documented env-class (LLM Sharing ×2), 2 — pre-existing arch (сверены на pristine) |
| `npm run test:syntax` (`scripts/syntax-smoke.sh`) | All production JS/CJS files pass |

Логи: `/tmp/opencode/stage44-fullsuite.log`, `/tmp/opencode/stage44-pristine-fullsuite.log`.

### 4.4 Production smoke (после всех операций, read-only)

| Проверка | Значение |
|---|---|
| `https://animastor.org/health` | **200** |
| `https://animastor.org/gpu/health` | **200** `{"gpus":0,…,"running":0}` |
| `https://app.animastor.org/` | **200** |
| контейнер backend | `91fc2fad…`/image `e1fac1d29f7a` — **не пересоздан** (Up 13 h, тот же, что на этапе 42) |
| pg/redis/gpu-hub/proxy | ID/Status не изменены |
| `generation_tasks` | 17 (без изменений) |

---

## 5. Предлагаемое безопасное восстановление (НЕ выполнялось)

Оба варианта требуют **явного решения владельца**; автоматический сброс в этом
окне запрещён условием задачи.

### Option 1 (рекомендуемый) — выкатить фикс, дать доработать C1

1. Закоммитить подготовленный diff (§2) → сборка образа (CI GHCR, этап 43) →
   rollout по процедуре этапа 42 (отдельное окно, с backup `.env`).
2. На первом рестарте C1 обработает все 3 записи: `expected_count=0`, чанков на
   диске 0 → `setFailed('restart_recovery')` → `asset.audio=FAILED` →
   `markDirtyScene` (терминальное состояние, ключи остаются).
3. Контроль после рестарта: в логе `audio_orch:0` (warn исчез), счётчик событий
   `animastor:event-journal:<book>:*` не растёт 24 ч; если появится новый
   цикл `scene_not_found` (рискованный шаг — `markDirtyScene` для удалённой
   книги) → перейти к Option 2.

### Option 2 (явная чистка, только с одобрения владельца)

Удалить ровно 3 ключа-сироты (книга не существует нигде — ни в PG, ни на диске,
ни в индексе; никакие книги/output/assets не затрагиваются):

```sh
redis-cli DEL \
  animastor:audio-orch:import_1783656905372_1783656918982:ch-c779d21c:sc-1eb2306c \
  animastor:audio-orch:import_1783656905372_1783656918982:ch-c779d21c:sc-45fc1833 \
  animastor:audio-orch:import_1783656905372_1783656918982:ch-c779d21c:sc-5860455d
```

Опционально (отдельным решением, тоже не выполнено): остальные сироты удалённой
книги — `scene-state` ×3, `asset-state` ×3, `assets` ×3, `trigger_cooldown` ×1,
`event-journal` ×3 (~306 тыс. строк) и PG-сироты `scenes` ×3 / `scene_assets` ×25.

**Важно:** без фикса §1 Option 1 невозможен (C1 и так падает), а любой будущий
реальный зависший `GENERATING` останется невосстановимым — поэтому фикс
приоритетен независимо от выбора между Option 1/2.

---

## 6. Production-изменение: подготовлено, НЕ выкатывается

- Diff готов в рабочем дереве `backend` (4 файла, §2), **не закоммичен**
  (коммит в этом окне не выполнялся — явного запроса не было).
- Новый образ **не собирался и не публиковался**; `deploy/.env` не менялся
  (sha `21e3248c…` прежний); контейнер backend не пересоздавался.
- Порядок выката (следующее окно, по решению владельца):
  1) коммит diff → 2) CI сборки/публикации образа (этап 43) →
  3) сверка digest + `up --dry-run` (только `animastor-backend Recreate`) →
  4) `up -d` → 5) проверки: health 200/200, site sha `a1900f4e…`,
  `generation_tasks=17`, в логе **нет** `Reconcile errors: audio_orch`,
  `phases` содержит `audio_orch:0`; 6) мониторинг journal-счётчиков июльской
  книги 24 ч (см. Option 1).
- Откат-канал этапа 42 (пин `e8152778…`, backup `.env`) сохранён и не тронут.

---

## 7. Запреты — соблюдены

Не выполнялось: сброс/удаление каких-либо Redis-состояний (включая 3
GENERATING); правки `deploy/.env`, production Compose, DNS/TLS, lock-файлов,
PG/Redis-конфигурации, GPU Hub; удаление книг/output/assets/образов;
пересоздание/остановка контейнеров; коммиты/push; E2E-dispatch; широкие аудиты
(проверки ограничены книгой `import_1783656905372_…`, фазой C1 и
смежными guard-тестами). Все обращения к Redis/PG — read-only (`--scan`, `GET`,
`TTL`, `HGETALL`, `LRANGE`, `SELECT`); секреты `.env` в отчёт не выгружались.

Изменения в рабочем дереве — только 4 файла (§2); `git status` иных правок не
показывает (`?? deploy/`, `?? freebuff-chat-…` — baseline-незнакомые файлы
этапов 40/41, не трогались).

---

## 8. Фактические значения (для следующих окон)

| Что | Значение |
|---|---|
| backend image (deployed) | `ghcr.io/animastor/animastor-backend@sha256:e1fac1d29f7acd9477080e4608be4670ba172d686e0e061fbbf84c322382def4` (`deploy-a7a8c463`), контейнер не пересоздан |
| warn-строки | `docker logs` строки 121 (`Phase C1 failed`) и 189 (`[STARTUP] Reconcile errors: audio_orch: …`), старт 2026-10-12T15:12 |
| defect-место | `backend/src/backend.cjs` media-binding; `packages/…/host-bindings.js:111`; `reconciliation-engine.js:1929–1930`; появился в `41a5690` (2026-09-13) |
| подготовленный diff | 4 файла: `backend/src/backend.cjs`, `backend/tests/generation-test-bindings.cjs`, `backend/tests/architecture/physical-move-gate.test.js`, `backend/tests/reconciliation-engine.test.js` |
| тесты | полный 3133/4 (= pristine 3130/4, тот же failure-set); reconciliation 58/0; arch 927/2 (pre-existing) |
| 3 GENERATING | `animastor:audio-orch:import_1783656905372_1783656918982:ch-c779d21c:sc-{1eb2306c,45fc1833,5860455d}`, `started_at=2026-07-14T04:51:23Z`, TTL -1, `expected_count=0`, `build_id=null` |
| последние события журнала | 2026-07-26 03:51:50; первый `scene_not_found` 2026-07-24 16:17:53; всего 25 579 dispatch / 25 492 отмен |
| связанные PG | `scenes` ×3 (pending), `scene_assets` ×25 (`stale`, обновлено 2026-10-12 15:12:06), `generation_tasks`/`books`/`book_events`/`output_manifests`/`asset_states` — 0 строк по книге |
| site sha / PG / .env | `a1900f4e…` / 17 / `21e3248c…` — без изменений |

---

## 9. Резюме для чата

**PASS.** Причина warn `audio_orch` доказана: extraction `41a5690` заменил
`require('../audio/chunks'/'segments')` на `lazyHostBinding('media.audio.chunks'/
'.segments')`, но composition root регистрирует только плоский barrel
`media.audio` → TypeError → фаза C1 падает целиком (восстановление зависших
audio-состояний в проде отключено; 2 recovery-ножки `scene-orchestrator` тоже
сломаны; штатный диспатч не задет). Исправлено минимальным host-side изменением
(4 файла: media-binding в `backend.cjs` + зеркало тестовых bindings + guard
PM-G9 + 3 регрессионных теста); npm-пакет не тронут. Тесты: до фикса 3 failing
с той же TypeError, после — полный набор 3133/4 **равен pristine 3130/те же 4**
(без регрессий), syntax OK; smoke в production-контейнере: текущий binding →
та же TypeError, патченный → резолвится. Три GENERATING — июльские сироты
удалённой книги (нет ни PG-строк, ни `/data/books`, ни output; активных
lease/задач/очередей нет, последнее событие 2026-07-26) — **не сброшены**;
предложены Option 1 (выкатить фикс → C1 доработает до FAILED с мониторингом) и
Option 2 (явное DEL 3 ключей после одобрения). Изменение подготовлено, образ
**не выкатывался**; запреты соблюдены. Блокеры (недоказано, без догадок):
механизм/время удаления содержимого книги и июльские параметры сегментации —
логов до 2026-10-12 не существует.
