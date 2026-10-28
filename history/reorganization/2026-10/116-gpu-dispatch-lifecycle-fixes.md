# Stage 116 — GPU dispatch lifecycle fixes D1–D4 (local, unpublished)

**Дата:** 2026-10-22, окно **06:05Z → 07:15Z**.
**Исходная спецификация:** `reorg-2026-10-19/115-gpu-idempotency-independent-audit.md` (дефекты D1–D4 + регрессионные тесты).
**Исправляемый патч:** `8b375dc0` (Stage 114).
**Репозиторий:** `animastor-backend` (единственный затронутый; в нём же лежит пакет `@animastor/orchestration`).
**Режим:** локально, без публикации. Push/CI/GHCR/deploy не выполнялись; npm-пакет не публиковался; production не изменялся.
**Итог: PASS** — все четыре дефекта закрыты кодом и изолированными тестами; регрессий нет (множество падений полного suite **идентично** baseline Stage 115); production не затронут.

| Коммит | Область | Состав |
|---|---|---|
| **`fc9c6097`** | **orchestration (D3)** | `packages/animastor-orchestration/src/runtime/dispatch-engine.js`, `.../src/orchestration/scene-orchestrator.js`, `.../test/capacity-deferral.test.js` (новый) — 3 файла, +339/−7 |
| **`ae4e7d49`** | **backend (D1, D2, D4)** | `backend/src/helpers/queue-idempotency.cjs`, `.../runtime/gpu-dispatcher.js`, `.../image/iu-processor.js`, `.../audio/generation.js`, `.../routes/generation-routes.cjs`, `.../routes/book/generation-routes.cjs`, `.../routes/book/cache-routes.cjs`, `.../routes/book-routes.cjs`, `.../services/book-deletion.cjs`, `.../backend.cjs`, `backend/tests/gpu-queue-idempotency.test.js`, `backend/tests/architecture/assistant-purge-wiring.test.js` — 12 файлов, +546/−82 |

HEAD после этапа: `ae4e7d49`; `origin/main` и `github/main` — без изменений (`53ce5045`).

---

# 1. D3 — bounded capacity deferral (приоритетный, orchestration)

## 1.1 Разбор механики (что именно чинилось)

| Слой | Было | Стало |
|---|---|---|
| Исполнитель стадии (`scene-orchestrator.js`) | Любой «ничего не отправлено» сводился к `no_jobs_sent` / `no_jobs_generated` / `send_failed` — причина терялась | Причина «ничего не отправлено» **доносится** (image/audio/video). В **capacity-исхода** (`no_worker_available`, `duplicate_pending`, `already_completed`) возвращается конкретный `reason` + `retryable:true`; во всех остальных случаях прежняя семантика сохранена **дословно** (`no_jobs_sent`) |
| Движок диспатча (`dispatch-engine.js`) | `!result.dispatched` ⇒ `finalizeDispatch('cancelled')` ⇒ откат FSM ⇒ **следующий тик (5 с) — всё сначала** | Тот же финализатор, **плюс** ограниченный deferral: `deferStage()` ставит `animastor:runtime:deferred:{book}:{ch}:{sc}:{stage}` (EX 60 с) |
| Точка входа (`dispatchStage`) | Никакой защиты | **Первым** проверяется deferral: `isStageDeferred()` ⇒ возврат `{dispatched:false, reason:'deferred_capacity', retryable:true}` **до любого побочного эффекта** (нет lease, нет dispatch-meta, нет записи FSM, нет события журнала) ⇒ отложенная стадия стоит **один Redis GET на тик** |
| Снятие deferral | — | Успешный dispatch ⇒ `clearStageDeferral()`; явная отмена (`cancelActiveDispatch`) ⇒ `clearStageDeferral()` (пользователь снова попросил работу — откладывать нельзя) |

**Классификация исходов (узкая — только «ёмкость»):**

```js
const DEFERRABLE_OUTCOMES = new Set([
    'no_worker_available',   // нет живого совместимого исполнителя
    'duplicate_pending',     // задача уже ожидает в lane'е
    'already_completed',     // задача уже выполнена (артефакт отсутствует)
]);
```
`no_jobs_sent` / `no_jobs_generated` / `send_failed` **не** откладываются — они сохраняют контракт «повтор на следующем тике», на который опираются регрессионные тесты audit-6929ba5 (проверено — см. §4).

## 1.2 Почему это устраняет цикл и рост журнала

| Показатель | Было | Стало |
|---|---|---|
| Попыток диспатча за 100 тиков (500 с) | 100 | **1** (+ 1 после истечения окна) |
| Lease/dispatch-meta на тик | создание+удаление | 0 (deferral возвращается до создания) |
| Записей FSM на тик | GENERATING→DIRTY→PENDING | те же 3 перехода, но 12 раз в минуту ⇒ **1 раз в 60 с** |
| Событий журнала | ~5 на попытку ⇒ ~720/час на сцену | ~5 на окно ⇒ **~60/час на сцену** (×12 меньше) |
| Retry-бюджет | не расходуется (исход `cancelled`) | **не расходуется** (проверено тестом) |

## 1.3 Восстановимость и совместимость FSM

* Отложенная стадия остаётся **PENDING** и **в active-index** ⇒ следующий тик после истечения окна (60 с) диспетчеризует её снова ⇒ появление живого worker'а безопасно продолжает работу (тест «the deferral window expires ⇒ the stage is dispatched again»).
* Откат FSM остаётся **FSM-валидным путём исполнителя** (`GENERATING → DIRTY → PENDING`, `scene-orchestrator.js`), движок его не дублирует.
* Cancel / retry / успешное завершение / повторная доставка результата — не затронуты: deferral снимается на успешном dispatch'е и на явной отмене; путь результата не менялся.

## 1.4 Новые файлы/функции (пакет)

| Файл | Функция/экспорт | Назначение |
|---|---|---|
| `packages/animastor-orchestration/src/runtime/dispatch-engine.js` | `DEFERRED_STAGE_KEY_PREFIX`, `DEFERRED_STAGE_TTL_S` (60), `deferredStageKey()`, `isStageDeferred()`, `deferStage()`, `clearStageDeferral()`, `isDeferrableOutcome()` | ограниченный backoff |
| `packages/animastor-orchestration/src/orchestration/scene-orchestrator.js` | `executeImageDispatch` / audio / video: сбор причин «не отправлено» ⇒ `reason` + `retryable` | различение «потеря задачи» и «нет ёмкости» |
| `packages/animastor-orchestration/test/capacity-deferral.test.js` | 11 изолированных тестов | регрессии D3 |

---

# 2. D1 — epoch читается в момент фактической отправки

**Дефект.** Эпоха была **заморожена на диспатч** (`animastor:idempotency:dispatch-epoch:{dispatch_id}`, `SET NX`+`GET`). Ветка dirty-unit поднимала эпоху стадии **внутри** диспатча, но уже отправленный ранее IU «закреплял» старую эпоху ⇒ dirty-IU получал идентичность **предыдущей успешной попытки** ⇒ `already_completed` ⇒ регенерация требовала второго attempt'а (PNG к этому моменту уже удалён веткой dirty).

**Исправление.**
* `helpers/queue-idempotency.cjs`: `resolveDispatchEpoch()` теперь просто читает **текущую** эпоху стадии (`getStageEpoch`); ключ `dispatch-epoch` и его константы **удалены** (нет «заморозки», нет лишнего ключа).
* `runtime/gpu-dispatcher.js`: эпоха читается в момент отправки каждой задачи ⇒ bump из dirty-ветки виден своему IU сразу.
* Семантика идентичности не изменилась: каждая задача разрешает свою эпоху **ровно один раз** ⇒ одна задача никогда не получает две идентичности; разные IU / build / workspace / params по-прежнему не схлопываются.

**Регрессии (в репозитории, `backend/tests/gpu-queue-idempotency.test.js`):** «D1: a dirty-unit regeneration is allowed on the FIRST attempt», «D1: a unit sent earlier in the same dispatch does not freeze the epoch of a later one»; тест Stage 114 «all jobs of one dispatch observe the SAME frozen epoch» переписан под новый контракт («the epoch is read at the moment of EACH send»).

---

# 3. D2 — окончательный отказ ≠ неоднозначный результат

**Дефект.** Любой сбой POST освобождал claim ⇒ при потерянном ответе hub уже мог принять задачу, а следующий attempt ставил её **второй раз** (dedup hub'а dispatch-scoped и её не ловит) ⇒ исходный дефект возвращался в окне неоднозначности.

**Исправление** (`runtime/gpu-dispatcher.js`):

| Исход POST | Действие с claim'ом |
|---|---|
| HTTP **4xx** (окончательный отказ — hub ответил и **не** поставил задачу) | claim **освобождается**, ref удаляется ⇒ следующий attempt разрешён |
| timeout / connection reset / потерянный ответ / HTTP **5xx** (неоднозначно — hub мог принять) | claim **сохраняется** (иначе дубль), TTL **укорочивается** до `IDEM_AMBIGUOUS_CLAIM_TTL_S` = 90 мин (3× максимального таймаута задачи) ⇒ потерянный запрос не блокирует задачу на полные 24 ч; результат/ошибка от hub'а освободят claim раньше |

Результат возвращается с флагом `ambiguous` и `status` ⇒ вызывающий может различить исходы.

**Регрессии:** «D2: an AMBIGUOUS network failure keeps the claim (no duplicate)» (claim жив, TTL укорочен), «D2: a DEFINITIVE hub rejection releases the claim»; тест Stage 114 «a failed POST releases the claim» переписан под новый контракт (две ветви).

---

# 4. D4 — освобождение claims по границам задачи (cancel / regenerate / удаление книги)

**Дефект.** Очистка lane'а в hub'е (`DELETE /queue/clear`) удаляла записи очереди, но **не трогала** backend-side claim'ы ⇒ повторный запуск тех же задач на той же эпохе молча подавлялся (`duplicate_pending`) на весь TTL claim'а (24 ч); путь cancel **не** двигает эпоху ⇒ самоочистки не было.

**Исправление — ownership СКОНСТРУКТИВЕН, без широкого SCAN+DEL:**

```
animastor:idempotency:ref:{bookId}:{chapterId}:{sceneId}:{jobId}  →  idem_key
```

* Ref-ключ **сам** несёт принадлежность ⇒ сцена/книга выделяется **префиксом ключа**, а не выводом грамматики job_id (заодно устранена коллизия `_` в book_id — разделитель `:`).
* `releaseClaimsForScene(redis, book, chapter, scene)` и `releaseClaimsForBook(redis, book)` сканируют **только** префикс своего book/scene (`MATCH animastor:idempotency:ref:{book}:{ch}:{sc}:*`), и каждый найденный ключ **ещё раз** проверяется на принадлежность префиксу перед удалением; удаляются только claim + done-маркер + сам ref **этого** ключа.
* Вместе с claim освобождается и **done-маркер** того же задания: пользователь явно попросил выполнить работу снова ⇒ прежнее «выполнено» больше не применимо.

**Точки вызова (порт внедрён, а не require-нут):**

| Путь | Scope | Файл |
|---|---|---|
| `POST /api/v1/book/:bookId/cancel-generation` | книга | `backend/src/routes/book/generation-routes.cjs` |
| `POST /api/v1/book/:bookId/regenerate` | каждая dirty-сцена | `backend/src/routes/book/generation-routes.cjs` |
| Cache teardown | книга | `backend/src/routes/book/cache-routes.cjs` |
| Удаление книги | книга | `backend/src/services/book-deletion.cjs` |

**Регрессии:** «D4: a cleared lane releases the claims of THAT scene only» (чужой сцене/книге не тронуто), «D4: a book-scoped release does not touch another book».

**Дополнительно (тот же дефект, TTL):** при подавлении дубликата claim **обновляется** (`claimTask` заново ⇒ TTL продлён) ⇒ задача, которая продолжает лежать в lane'е, не теряет claim по истечении TTL; тест «a pending claim is refreshed while the task stays queued».

---

# 5. Архитектурные ограничения, которые пришлось соблюсти

Первая версия патча нарушила три guard'а репозитория — все обнаружены прогоном и исправлены **до** коммита:

| Нарушение | Исправление |
|---|---|
| `PM-G2`: `backend/src/runtime` — ровно 4 host-stay файла | модуль остался в `backend/src/helpers/` (изменений в `runtime/` нет) |
| `relative require sets of the contour routes stay frozen` + `T6: contour routes do not gain new implementation-detail deps` | порт **инъецируется** (`deps.queueIdempotency` / `ctx.queueIdempotency`) — новых относительных require в маршрутах нет |
| `book-deletion.cjs must not depend on backend/src/helpers/...` (Book Model layer boundary) | порт инъецируется в фабрику `createBookDeletion({...})` |
| `raw scene-grammar literals outside the canonical owner` | грамматика job_id больше не выводится в ключах — владение выражено структурой ref-ключа |
| `architecture: assistant purge wiring (composition root)` | новый module-scope require в композиционном корне зарегистрирован в guard'е (`tests/architecture/assistant-purge-wiring.test.js` → карта заглушек slice'а) |

---

# 6. Тесты

## 6.1 Изоляция (адреса подключения проверены ДО запуска)

* **production PostgreSQL опубликован на `0.0.0.0:5432`** (контейнер `animastor-pg`) ⇒ любой локальный прогон БД-тестов писал бы в production.
* Проверено реальными адресами: `ss -lntp` → `0.0.0.0:5432` (production PG); на `6379` слушателя на хосте **нет** (production Redis не опубликован).
* ⇒ **Все** прогоны выполнялись с `PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1`: БД-зависимые тесты падают по соединению (это baseline), но физически не могут дойти до production.
* Новые тесты: in-memory Redis double (backend) / пакетный mock (orchestration) + заглушки PG + перехват `global.fetch` ⇒ ни одного сетевого обращения, ни одного production-ключа.

## 6.2 Результаты

| Прогон | Stage 115 baseline | Stage 116 | Вывод |
|---|---|---|---|
| `packages/animastor-orchestration` (`npm test`) | 19 pass / 0 fail | **30 pass / 0 fail** | +11 (новый набор D3) |
| `backend/tests/gpu-queue-idempotency.test.js` | 22 pass / 0 fail | **29 pass / 0 fail** | +7 (D1×2, D2×2, D4×2, TTL-refresh) + 2 переписанных под новый контракт |
| Полный backend-suite (`tests/**/*.test.js`) | 2612 pass / 28 pending / **85 fail** | **2619 pass** / 28 pending / **85 fail** | множество падений **идентично** baseline (307 записей, `comm` → 0 новых, 0 исчезнувших) ⇒ **0 регрессий** |
| Архитектурные (`tests/architecture/*.test.js`) | 935 pass / 0 fail | **935 pass / 0 fail** | ✔ |
| Syntax smoke (`scripts/syntax-smoke.sh backend`) | OK | **OK** | ✔ |

Падения в полном suite — только БД-зависимые (production PG заблокирован) ⇒ **environmental**, идентичны baseline.

## 6.3 Что покрыто тестами (по требованиям задания)

| Требование | Тест |
|---|---|
| Повторный dispatch с новым `dispatch_id` — одна логическая задача | Stage 114 «a re-dispatch with a NEW dispatch_id stays ONE logical task» (3 dispatch'а → 1 POST) |
| Одновременные dispatch не создают дубликаты | «concurrent dispatches create exactly one lane entry» + «concurrent claims: exactly one winner» (25 → 1) |
| Активный lease защищён | «an active (renewed) lease makes the dispatch engine skip» + «an expired lease is recognised as stale» |
| Graceful shutdown → reconciliation → re-dispatch без дублей | «graceful shutdown → reconciliation → re-dispatch creates no duplicate» |
| Обоснованный retry с новой эпохой разрешён | «a justified retry with a new generation_epoch is allowed» |
| Разные параметры / IU / модель / seed / версия не схлопываются | «different IU / seed / prompt / model are never collapsed» (6 задач → 6 POST) + «different params … input versions» |
| Завершённая задача не ставится повторно без разрешённого retry | «a completed task is not re-queued without an allowed retry» (`already_completed`) |
| **Отсутствие живого совместимого worker блокирует enqueue** | «the absence of a live compatible worker blocks the enqueue» (0 POST) + «a live worker of ANOTHER type…» + «a private worker of ANOTHER workspace…» + «a live PRIVATE worker of the workspace unblocks the ws lane» |
| **Цикл тика scheduler'а 5 с** | **новый** «100 scheduler ticks inside the deferral window ⇒ ONE attempt (bounded churn)» + «a deferred stage is NOT re-dispatched on the next tick (no side effects)» |
| **Нет неограниченного роста журнала Redis** | **новый** — в том же тесте: число событий журнала не растёт с числом тиков (`< 10`) |
| **Истечение lease и crash/restart** | «an expired lease is recognised as stale» + «a failed POST … keeps the claim» (ambiguous) + «the deferral window expires ⇒ the stage is dispatched again» |
| **Результаты worker и повторная доставка** | «a redelivered result is deduplicated independently of the dispatch_id» + «the identity of a job can be resolved back from its job_id» |
| **D1** | «D1: a dirty-unit regeneration is allowed on the FIRST attempt», «D1: a unit sent earlier in the same dispatch does not freeze the epoch of a later one» |
| **D2** | «D2: an AMBIGUOUS network failure keeps the claim (no duplicate)», «D2: a DEFINITIVE hub rejection releases the claim» |
| **D4** | «D4: a cleared lane releases the claims of THAT scene only», «D4: a book-scoped release does not touch another book» |
| Deferral: явное retryable-состояние, ограниченный backoff, без новых записей | «a stage that enqueued nothing is deferred and reported as retryable», «a deferred attempt does NOT consume the retry budget», «the deferral is per stage», «deferrable outcomes are classified explicitly (capacity only)», «the deferral window is bounded» |
| Deferral: задача восстановима, cancel/retry/успех/redelivery не ломают FSM | «the deferral window expires ⇒ the stage is dispatched again», «a successful dispatch clears the deferral», «an explicit cancel clears the deferral», «the FSM is rolled back on a deferred attempt», «a deferred attempt is not reported as a failure» |

---

# 7. Коммиты

```
ae4e7d49f08051f7b8d164763ca4441334a103c3  fix(gpu-queue): close the Stage 115 lifecycle defects D1/D2/D4 (stage 116)
fc9c6097                                   fix(orchestration): bounded capacity deferral for stages that cannot enqueue (stage 116 / D3)
8b375dc0                                   fix(gpu-queue): make GPU dispatch idempotent across re-dispatch/restart (stage 114)   ← аудируемый патч
53ce5045                                   ci(backend): approve 78e8f1ae backend tree for GHCR release (stage 105)
```

* Оба коммита — **в одном репозитории** (`animastor-backend`), разделены по областям: сначала пакет `@animastor/orchestration` (D3), затем backend (D1/D2/D4).
* В коммиты вошли **только** мои файлы (`git add` по явным путям); чужие изменения (`D backend/scripts/audit-orphan-books.js`, 4 `M` в `backend/tests/**`, `?? deploy/`, `?? freebuff-chat-*.md`) остались в рабочем дереве нетронутыми.
* **Push не выполнялся**: `origin/main` = `github/main` = `53ce5045`.
* Локальная среда: `backend/node_modules/@animastor/orchestration` (установленная копия 0.1.4, **gitignored**) синхронизирована с изменённым исходником пакета — без этого тесты backend'а исполняли бы старый код пакета. Это изменение окружения, **не** часть коммита, и на production не влияет (контейнер работает из образа).

---

# 8. Подтверждение отсутствия production-изменений

| Объект | Значение | Статус |
|---|---|---|
| Redis `dbsize` | 321 | ✅ без изменений |
| ws-lane `queue:image:ws:3317e019…` | 457 | ✅ (438 дублей **не** очищались) |
| глобальная lane `queue:image` | 8 | ✅ |
| `animastor:idempotency:*` | **0** | ✅ (код в production не попадал) |
| `animastor:runtime:deferred:*` | **0** | ✅ |
| `animastor:worker:heartbeat:*` | 0 | ✅ |
| PG `scene_assets` | 459 (437 NULL) | ✅ |
| PG `generation_tasks` | 17 | ✅ |
| `data/books` inventory sha | `200beb1a…` | ✅ |
| `data/output` inventory sha | `2a03a8c7…` | ✅ |
| контейнеры (backend/gpu-hub/pg/redis/proxy) | `StartedAt` и `RestartCount=0` — те же | ✅ рестартов не было |
| Git refs | `origin/main` = `github/main` = `53ce5045` | ✅ push/CI/GHCR/deploy не выполнялись |
| npm | пакет `@animastor/orchestration` **не опубликован** | ✅ |
| генерация | не запускалась | ✅ |
| другие репозитории | gpu-hub / worker / web — чисто | ✅ |

---

# 9. Известные ограничения и остаток

1. **Публикация пакета — отдельный обязательный шаг.** Изменён исходник **опубликованного** пакета `@animastor/orchestration@0.1.4`. Чтобы фикс D3 попал в production, нужны: bump версии пакета → `npm publish` → bump зависимости backend'а (`^0.1.5`) → пересборка образа. **Версию и зависимость в этом этапе намеренно НЕ поднимали**: npm не перезаписывает уже опубликованную 0.1.4 ⇒ publish «немого» провалится loudly, а не разойдётся молча с backend'ом, который тянет 0.1.4. То есть состояние репозитория **честно** выглядит как «не готово к публикации» — publish требует явного bump'а.
2. **Deferral-окно = 60 с** (константа пакета). При 12 сценах это ≤ 12 попыток/мин на сцену вместо 720. Окно не конфигурируется извне (пакет не читает host-config в этом месте) — при необходимости вынести в `runtimeConfig.TIMEOUTS` отдельным этапом.
3. **Подавление дубликата оставляет сцену в PENDING**, пока существующая копия задачи не будет выбрана воркером; её результат приходит со **старым** `dispatch_id` ⇒ для image backend отклонит его как `stale_dispatch` ⇒ задача завершится через error-путь (ретрай-бюджет), а не «с первого раза». Это поведение **предсуществующее** (оно же объясняет, почему очистка 438 дублей обязательна до появления воркера), и Stage 116 его не менял.
4. **Очистка 438 дублей не выполнялась** (вне рамок этапа, требует approval). После неё освобождение claim'ов (D4) делает возможной свежую постановку с текущим `dispatch_id`.
5. **Claim освобождается только в известных точках** (cancel / regenerate / cache-teardown / удаление книги). Прямое `DELETE /queue/clear` внешним оператором оставит claim ⇒ задача останется подавленной до TTL (90 мин / 24 ч). Это осознанный компромисс (ownership-безопасность важнее).
6. **`workers.status` в PostgreSQL по-прежнему не трогается** — живость определяется по Redis-heartbeat (задача предыдущего этапа, вне этого объёма).
7. **Первый post-deploy re-dispatch добавит +19 записей** в lane (claim'ов ещё нет ⇒ первые отправки не подавятся) ⇒ очередь 457 → 476, дальше рост прекращается. Это надо учесть в плане чистки.
8. **`phase4-book-model.test.js` флакует** (2-секундный таймаут) — воспроизводится и на baseline, к патчу отношения не имеет.

---

# 10. Рекомендуемый порядок следующих этапов

| Этап | Содержание | Гейт |
|---|---|---|
| **117** | Публикация `@animastor/orchestration@0.1.5` (с фиксом D3) + bump зависимости backend'а до `^0.1.5` + пересборка образа. **Публикация npm-пакета — только здесь и только по явному approval** | тесты пакета зелёные; зависимость разрешается |
| **118** | Ревью обоих коммитов (`fc9c6097`, `ae4e7d49`) + решение о публикации | одобрение владельца |
| **119** | Push/CI/GHCR/deploy + наблюдение: очередь 457→476 (первый re-dispatch) и далее **без роста**; журнал не растёт (≤60 событий/час на сцену вместо ~720) | критерий: журнал/логи не растут, тик не крутится |
| **120** | Очистка 438 дублей (Stage 113 §B.6: dry-run → журнал → точечный `LREM` → rollback) | отдельное approval; после 119 |
| **121** | Восстановление workers (Stage 113 §A.5, 10 шагов) | `gpus ≥ 1`, heartbeat живой, очередь убывает |
| **122** | Отдельно: Stage 75 batch C (архив + удаление 4 dead-path строк `scene_assets`) и `schema.js:1211` (вариант B) | решения владельца |

**Порядок жёсткий:** 117 → 118 → 119 → 120 → 121. Без 117 фикс D3 в production не попадёт (изменён опубликованный пакет).
