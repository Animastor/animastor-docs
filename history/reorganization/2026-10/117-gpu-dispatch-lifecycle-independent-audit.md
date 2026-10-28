# Stage 117 — Независимый аудит GPU dispatch lifecycle fixes (Stage 116)

**Дата:** 2026-10-22 (окно аудита 06:05Z → 09:40Z)
**Проверяемые коммиты:** `fc9c6097` (orchestration, D3), `ae4e7d49` (backend, D1/D2/D4)
**Аудируемый патч:** `8b375dc0` (Stage 114) — базовая линия
**Репозиторий:** `animastor-backend` (в нём же находится публикуемый пакет `@animastor/orchestration`)
**Режим аудита:** read-only по проверяемым коммитам. Код, версии пакетов, lockfiles, refs и конфигурация **не изменялись**. Push/CI/GHCR/deploy/npm-publish **не выполнялись**. Production **не изменялся и не опрашивался**.
**Итог: BLOCKED** — 5 блокеров (D2 ×2, D3 ×1, D4 ×2), из них 3 — это заявленные в Stage 116 «исправления», которые фактически не работают.

---

## 0. Краткий вердикт

| Дефект Stage 115 | Заявлено в Stage 116 | Фактически | Вердикт |
|---|---|---|---|
| **D1** epoch заморожен на dispatch | epoch читается в момент отправки | ✅ работает (dirty-IU regen проходит с первой попытки) | **PASS** с оговоркой (M6) |
| **D2** окончательный отказ ≠ неоднозначный исход | 4xx → release, 5xx/timeout → keep + TTL 90 мин | ⚠️ частично: классификация «sticky» между попытками (B2); нет `reason` у неоднозначного исхода (M5); refresh claim — no-op (B5) | **PARTIAL → BLOCKED** |
| **D3** capacity deferral | deferral 60 с, без lease/FSM/journal на тик | ⚠️ работает для image/per-segment audio/video; **не покрывает merged-dialogue audio** (B3); обходится `force=true` (M2); требует ровно одну причину (M3) | **PARTIAL → BLOCKED** |
| **D4** освобождение claims по границам задачи | release по ref-префиксу + done-маркер | ❌ **done-маркер освободить невозможно** (B1) — мёртвый код в проде; release не связан с очисткой lane (B4); префиксы неоднозначны при `:` в id (M1) | **BLOCKED** |

Ключевой вывод: **Stage 116 нельзя публиковать/деплоить в текущем виде.** Три из пяти блокеров — это расхождение между отчётом Stage 116 и поведением кода (заявлено работающее — не работает), т.е. отчёт Stage 116 §4/§6 неверен по трём пунктам.

---

## 1. Метод и изоляция

### 1.1. Что делалось

1. **Полное чтение дифов** обоих коммитов (15 файлов) + чтение окружающего кода (`dispatch-engine.js`, `runtime-scheduler.js`, `orchestrator.js`, `scene-orchestrator.js`, `iu-processor.js`, `audio/generation.js`, `gpu-dispatcher.js`, `queue-idempotency.cjs`, `job-protocol-v2.js`, `redis-helpers.cjs`, `import-routes.cjs`).
2. **Построение baseline Stage 115** без изменения репозитория: `rsync` копия рабочего дерева в `/tmp/opencode/stage115`, в ней 14 файлов аудируемых коммитов восстановлены из `8b375dc0`, новый `capacity-deferral.test.js` удалён, а `backend/node_modules/@animastor/orchestration` заменён на исходники baseline-пакета. Итог: baseline отличается от дерева Stage 116 **ровно файлами аудируемых коммитов**; посторонние рабочие изменения (5 грязных файлов) одинаковы в обоих деревьях.
3. **8 изолированных доказательств** (proofs) на **настоящих модулях репозитория** с in-memory Redis double, заглушками PG и перехватом `global.fetch`: `/tmp/opencode/117-proofs.js`, `/tmp/opencode/117-d3-proofs.js`. Ни одного сетевого обращения.
4. Каждое доказательство запущено **на обоих деревьях** (baseline и Stage 116), чтобы отделить регрессии Stage 116 от предсуществующего поведения.

### 1.2. Изоляция и безопасность (проверено ДО запусков)

| Объект | Проверка | Результат |
|---|---|---|
| Production PostgreSQL | `ss -lntp` | слушает **`0.0.0.0:5432`** (production PG опубликован) ⇒ любой прогон БД-тестов писал бы в прод |
| Production Redis | `ss -lntp` | на `6379` слушателя на хосте **нет** (Redis не опубликован) |
| Все БД/Redis-прогоны | `PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1` | 100 % прогонов БД-зависимых тестов упали с `ECONNREFUSED 127.0.0.1:1` — физически недостижимый адрес |
| Публикация npm | `npm view @animastor/orchestration dist-tags` (только чтение) | `{"latest":"0.1.4"}` — не изменилось, публикаций не было |
| Git refs | `git rev-parse origin/main github/main HEAD` | `53ce5045` / `53ce5045` / `ae4e7d49` — не изменены, push не выполнялся |
| Рабочее дерево | `git status --short` | **побайтово то же** состояние, что на входе аудита (5 dirty + 1 deleted + 2 untracked) |
| Очередь 457 / 438 дублей / leases / production-данные | — | **не трогались** (к production не подключались вообще) |
| `deploy/`, чужие dirty-файлы | — | не тронуты |

> Аудит не выполнял ни одного подключения к production Redis/PG/hub — это более строгая гарантия, чем «проверить и не изменить».

---

## 2. Результаты тестов

### 2.1. Сводка

| Прогон | Baseline Stage 115 (`8b375dc0`) | Stage 116 (`ae4e7d49`) | Δ |
|---|---|---|---|
| `packages/animastor-orchestration` — `npm test` | **19 pass / 0 fail** | **30 pass / 0 fail** | **+11** (набор D3) |
| `backend/tests/gpu-queue-idempotency.test.js` | **22 pass / 0 fail** | **29 pass / 0 fail** | **+7** (D1×2, D2×2, D4×2, TTL-refresh) |
| `backend/tests/architecture/*.test.js` | **935 pass / 24 pending / 0 fail** | **935 pass / 24 pending / 0 fail** | **=** |
| Полный backend-suite (`tests/**/*.test.js`) | **2611 pass / 28 pending / 86 fail** | **2618 pass / 28 pending / 86 fail** | **+7 pass, набор падений ИДЕНТИЧЕН** |
| `scripts/syntax-smoke.sh backend` | OK | **OK** | = |

### 2.2. Сравнение падений с baseline Stage 115 — подробно

Падения сравнивались **по списку заголовков** (номер + имя suite), при одинаковом окружении (`ANIMASTOR_DOCS_ROOT` + изолированные PG/Redis):

```
$ diff baseline.failures.txt stage116.failures.txt
(нет вывода)  →  IDENTICAL failure sets (86 == 86)
```

Причина всех 86 падений — **environmental**: `connect ECONNREFUSED 127.0.0.1:1` (production PG физически недоступен) + производные от них. В частности, «image ghost GENERATING — no_jobs_sent lifecycle fix (audit 6929ba5)» падает только в `after all`-хуке (`teardownGhostBookPg` → ECONNREFUSED), т.е. **сам тест 6929ba5 проходит** — контракт audit-6929ba5 не нарушен.

**Флаки:** `tests/architecture/phase4-book-model.test.js` («T6: … cancellation signal is sent BEFORE canonical reset») — таймаут 2 с под нагрузкой полного прогона. Он падал в baseline и в прогоне Stage 116 №2, и **проходил** в прогоне Stage 116 №1 (2619/28/85). Изолированно файл проходит 17/17 три раза подряд. Отчёт Stage 116 фиксирует этот флак в §9.8 — подтверждаю. **Итог: регрессий от аудируемых коммитов нет; множество падений совпадает с baseline.**

> Расхождение в абсолютных числах с отчётом Stage 116 (2612→2619/85→85 против моих 2611→2618/86→86) объясняется **только этим флаком**: их baseline-прогон попал в «зелёную» ветку по флаку, мой — в «красную». Дельта (+7 тестов) совпадает.

### 2.3. Что тесты Stage 116 **не** покрывают (важно для решения о публикации)

| Непокрытый сценарий | Где должен был быть тест | Факт |
|---|---|---|
| Ambiguous-исход ⇒ `reason` доходит до оркестратора | `gpu-queue-idempotency.test.js` | нет — `reason` отсутствует (M5) |
| Deferral на pure-dialogue (merged) audio | `capacity-deferral.test.js` | нет — ветка не покрыта (B3) |
| `force=true` при открытой deferral | `capacity-deferral.test.js` | нет (M2) |
| Освобождение done-маркера в **прод-последовательности** (mark→forget) | `gpu-queue-idempotency.test.js` | нет — тест создаёт невозможное в проде состояние ref+done (B1) |
| TTL claim'а реально продлевается | `gpu-queue-idempotency.test.js` | тест вакуумный `after >= before - 1` (B5) |
| Поведение после истечения 90-минутного TTL | — | нет (M7) |
| Порядок «release claims ↔ clear lane» | — | нет (B4) |

---

## 3. D1 — epoch читается перед фактической отправкой

### 3.1. Что сделано

`resolveDispatchEpoch()` (`backend/src/helpers/queue-idempotency.cjs:166`) теперь просто читает `getStageEpoch()`; ключ `animastor:idempotency:dispatch-epoch:{dispatch_id}` и его TTL удалены. Эпоха читается в `gpu-dispatcher.js:248` непосредственно перед вычислением `idem_key` для конкретной задачи.

### 3.2. Проверка гонки «создание dispatch ↔ отправка»

* **Dirty-IU с первой попытки — РАБОТАЕТ.** Ветка dirty (`backend/src/image/iu-processor.js:227-233`) поднимает эпоху **до** вызова `provider.generate` (строка 301) ⇒ bump виден своей же задаче немедленно ⇒ `idem_key` отличается от предыдущей успешной попытки ⇒ `already_completed` не срабатывает. Подтверждено тестом «D1: a dirty-unit regeneration is allowed on the FIRST attempt» (29/29 зелёные) и моим независимым прогоном.
* **Внутри одного dispatch** эпоха больше не заморожена ⇒ две отправки одной и той же задачи с bump'ом эпохи между ними дают **две разные идентичности ⇒ две записи в lane** (proof 8):
  * baseline Stage 115 (заморозка на `dispatch_id`): **1 запись в lane**;
  * Stage 116 (чтение на каждую отправку): **2 записи в lane**.

  Это **осознанная смена контракта** («все задачи одного dispatch видят одну эпоху» → «эпоха читается в момент каждой отправки»), прямо описанная в commit-message. Регрессионный тест Stage 114 `all jobs of one dispatch observe the SAME frozen epoch` **заменён**, а не сохранён в ослабленном виде ⇒ инвариант «одна логическая задача = одна pending-запись» больше **не гарантируется конструкцией**. Практическая достижимость сейчас низкая (в image/audio/video-исполнителях одна задача отправляется один раз за dispatch; POST-retry внутри `sendUnified` использует один уже вычисленный `idem_key`), поэтому классифицирую как **M6 (средняя, латентная)**, а не как блокер.
* **Кросс-диспатчный сценарий (рестарт/истечение lease) не изменился**: и в baseline, и в Stage 116 два диспатча одной сцены с bump'ом эпохи между ними дают 2 записи ⇒ дубликат-шторм Stage 114 в этом сценарии **не вылечен** ни Stage 114, ни Stage 116. Это предсуществующий дефект, не регрессия Stage 116, но он важен для плана чистки очереди.

**D1 — PASS с оговоркой M6.**

---

## 4. D2 — окончательный HTTP-отказ vs неоднозначный исход

### 4.1. Что сделано

`gpu-dispatcher.js:290-354`: флаг `definitiveRejection` ставится при HTTP 4xx; при 5xx/timeout/connection reset/потерянном ответе claim **сохраняется**, его TTL укорачивается до `IDEM_AMBIGUOUS_CLAIM_TTL_S = 90 мин`; в результате появились `ambiguous` и `status`.

### 4.2. Проверка по классам исходов

| Исход | Ожидаемое поведение | Факт | Вердикт |
|---|---|---|---|
| HTTP 4xx (окончательный отказ) | claim освобождён | claim освобождён ✔ | OK |
| HTTP 5xx | claim сохранён | claim сохранён ✔ | OK |
| timeout (AbortController, 30 с) | claim сохранён | claim сохранён ✔ | OK |
| connection reset | claim сохранён | claim сохранён ✔ | OK |
| потерянный ответ после успешного приёма Hub | claim сохранён | claim сохранён ✔ (но см. B2) | OK |
| **смешанный исход: 4xx на попытке №1 + network-error на попытке №2** | claim сохранён (последняя попытка неоднозначна) | **claim ОСВОБОЖДЁН** | ❌ **B2** |
| после TTL 90 мин | задача может быть отправлена снова | да (по истечении TTL claim исчезает) | ⚠️ M7 |

### 4.3. B2 (BLOCKER) — классификация «sticky» между попытками

`definitiveRejection` объявлен **вне** цикла попыток (`gpu-dispatcher.js:298`) и **только** переводится в `true` (`:317`), никогда не сбрасываясь. Сценарий: попытка №1 → HTTP 400 (детерминированный отказ), попытка №2 → сеть/5xx (хаб мог принять задачу) ⇒ флаг остаётся `true` ⇒ **claim освобождается** ⇒ дубль возможен — ровно та дыра, которую D2 закрывал.

**Proof 3 (реальный модуль):**
```
attempts=3  sent=false  ambiguous=false  status=400
claim after the mixed outcome: RELEASED (no duplicate protection)
```
Дополнительно искажается сам отчёт: результат сообщает `ambiguous:false`, хотя последняя попытка была неоднозначной.

Побочно: HTTP 4xx тоже ретраится 3 раза с паузой 1 с — окончательный отказ ретраится бессмысленно (3× время ответа + 2 с на каждый отказ).

### 4.4. B5 (BLOCKER) — «refresh» pending-claim'а — no-op

`gpu-dispatcher.js:265-267` при подавлении дубля вызывает `qidem.claimTask(redis, idemKey)` ⇒ `SET key 1 NX EX 86400`. В Redis **`SET NX` на существующем ключе не обновляет TTL** (операция отклоняется целиком).

**Proof 1 (реальный модуль, семантика Redis воспроизведена точно):**
```
first send  sent=true   claim TTL = 86400s
second send sent=false  reason=duplicate_pending  claim TTL = 86400s  (refreshed? false)
redis log: SET NX refused (no TTL refresh): animastor:idempotency:claim:9870…
after the claim TTL elapsed, guardEnqueue -> allowed=true reason=enqueued
```
Т.е. заявленное в Stage 116 §4 «claim обновляется ⇒ задача, лежащая в lane, не теряет claim по TTL» **не работает**. Срок жизни claim'а остаётся 24 ч от создания; после его истечения задача может быть поставлена в lane **второй раз**, пока первая копия всё ещё там (ровно тот класс дефекта, что и шторм 457 записей).

Тест «a pending claim is refreshed while the task stays queued» **вакуумный**: `expect(after).to.be.greaterThanOrEqual(before - 1)` проходит и при неизменном TTL.

### 4.5. M5 (средняя) — неоднозначный исход не классифицируется на уровне оркестратора

При неоднозначном исходе `sendUnified` возвращает `{sent:false, error, ambiguous:true}` **без поля `reason`** ⇒ `iu-processor.js:324` подставляет `'enqueue_failed'` ⇒ `notSentReasons` остаётся пустым ⇒ `deferReason = null` ⇒ оркестратор возвращает историческое `no_jobs_sent` ⇒ **не деферабельно** ⇒ следующий тик (5 с) делает полноценную попытку диспатча. Флаг `ambiguous` не читается **нигде** в кодовой базе, кроме самого диспетчера и его теста (`grep -rn ambiguous backend/src packages/` → только `gpu-dispatcher.js`). Т.е. D2-различие «окончательный/неоднозначный» **до вызывающего кода не доходит**.

### 4.6. M7 (средняя) — путь к повторной отправке уже принятой задачи существует

Ответ на вопрос задания: **да, путь есть**.
* Неоднозначный исход: claim живёт 90 мин ⇒ после истечения TTL та же задача ставится в lane снова. Если хаб её принял, а результат **не был доставлен/принят** (нет done-маркера), получаем **вторую копию** в lane (dedup хаба — dispatch-scoped, dispatch_id другой ⇒ не сработает).
* Обычный (не неоднозначный) pending-claim: TTL 24 ч ⇒ после истечения — тоже дубль (см. B5).
Это осознанный компромисс D2, но он **не измерен и не задокументирован** как риск; требуется либо явный «reconciliation»-путь (сверка с lane хаба), либо метрика+алерт.

### 4.7. M8 (низкая) — обоснование TTL 90 мин фактически неверно

Комментарий `queue-idempotency.cjs:56-61` утверждает «3× the longest job timeout (30 min)». Реальный реестр медиа: `video → timeout=3600000 ms (60 мин)`, `image/audio → 1800000 ms (30 мин)`. 90 мин = **1.5×** самого длинного таймаута. Значение формально больше максимума (запас есть), но обоснование в коде неверно.

**D2 — BLOCKED (B2, B5) + M5, M7, M8.**

---

## 5. D3 — capacity deferral

### 5.1. Что сделано

В пакет добавлены `DEFERRED_STAGE_KEY_PREFIX='animastor:runtime:deferred:'`, `DEFERRED_STAGE_TTL_S=60`, `isStageDeferred/deferStage/clearStageDeferral/isDeferrableOutcome`. Проверка отложенности — **до любого побочного эффекта** (`dispatch-engine.js:817`), классифицируются только «capacity»-исходы: `no_worker_available`, `duplicate_pending`, `already_completed`.

### 5.2. Проверка требований задания

| Требование | Проверка | Факт |
|---|---|---|
| 100 последовательных тиков ⇒ 1 попытка | тест пакета + мой независимый прогон | **PASS** — executor вызывается 1 раз, журнал не растёт |
| Появление worker | тест «the deferral window expires ⇒ the stage is dispatched again» | **PASS с оговоркой**: worker не «разблокирует» сцену мгновенно — до 60 с ожидания окна (допустимо) |
| Явная отмена снимает deferral | `cancelActiveDispatch` → `clearStageDeferral` | **PASS** |
| Повторный запуск после deferral | окно истекает → следующая попытка | **PASS** |
| Нет lease / dispatch-meta / FSM / journal на тике | проверка до лега/квоты/метаданных | **PASS** (проверка стоит до `acquireQuota`/`acquireStageLease`/`createDispatchMetadata`) |
| Совместимость с контрактом audit-6929ba5 | `no_jobs_sent`/`no_jobs_generated`/`send_failed` **не** деферабельны | **PASS** (тест 6929ba5 проходит; его падение — только в PG-хук) |

### 5.3. B3 (BLOCKER) — merged (pure-dialogue) аудио-путь не покрыт

`backend/src/audio/generation.js`:
* `deferState.deferReason` вычисляется **только** в конце `sendPerSegmentAudio` (строка **545**);
* ветка merged-диалога (строки **326–351**) заполняет лишь `notSentReasons` и **не вызывает** `sendPerSegmentAudio` ⇒ `deferState.deferReason` остаётся `null`;
* `generateSceneAudio` возвращает `deferReason: null` ⇒ `executeAudioDispatch` (в пакете) откатывается на `'no_jobs_generated'` ⇒ **не деферабельно** ⇒ сцена чистого диалога продолжает крутить dispatch→cancel→rollback каждые 5 с (lease + dispatch-meta + FSM + журнал) — ровно тот дефект, который D3 закрывал.

**Proof 7 (реальный модуль `audio/generation.js`, заглушены только provider/segments/validation):**
```
generateSceneAudio -> {"generated":false,"chunks":0,"expectedChunkCount":1,
                       "reason":"no_jobs_accepted","deferReason":null}
```
(для сравнения: per-segment путь даёт `deferReason:"no_worker_available"` — там deferral работает).

### 5.4. M2 (средняя) — `force=true` обходит deferral

`dispatch-engine.js:817`: `if (!force && await isStageDeferred(...))`. Флаг `animastor:force-dispatch:{bookId}` ставится `orchestrator.resetScenes()` (`orchestrator.js:483`) с TTL `FORCE_DISPATCH_TTL_S = 120 с` (`backend/src/config/runtime-config.js:205`) ⇒ **после каждого `/regenerate` в течение 120 с каждый тик (5 с) делает полноценную попытку диспатча**, т.е. заявленная «1 попытка на 100 тиков» в этом окне не выполняется.

**Proof 6 (реальный dispatch-engine пакета):**
```
after attempt 1: executorCalls=1, deferred=true
tick 2 (normal): reason=deferred_capacity executorCalls=1   <- без побочных эффектов
20 forced ticks: executorCalls=21                            <- deferral обойдён, каждая попытка полноценная
```
Т.е. 24 полных попытки на сцену за окно force после каждой регенерации (для 12 сцен — до ~290 попыток за 2 минуты).

### 5.5. M3 (средняя) — деферал требует РОВНО одну причину

`iu-processor.js:380-390`, `audio/generation.js:539-545`, `scene-orchestrator.js:598-608`: условие `notSentReasons.size === 1`. Комментарий в коде говорит «a single **dominant** CAPACITY reason», но код требует единственную **различную** причину. Сцена, где две задачи не отправлены по **разным** capacity-причинам (`no_worker_available` + `duplicate_pending`), не деферается ⇒ 5-секундный цикл сохраняется. Нужна классификация «все неотправленные причины — capacity» (или «доминирующая причина — capacity»).

### 5.6. M4 (средняя) — `already_completed` отнесён к «capacity»

`already_completed` — терминальная идемпотентная подавление (артефакта нет, идентичность уже завершена), а **не** отсутствие ёмкости. Включение его в `DEFERRABLE_OUTCOMES`/`CAPACITY_REASONS` превращает «задача никогда не выполнится» в **бесконечный 60-секундный цикл**: сцена остаётся PENDING, retry-бюджет не расходуется, ошибка не фиксируется, сцена навсегда остаётся в active-index. Т.е. D3 не «чинит» этот случай, а лишь замедляет симптом (5 с → 60 с) и маскирует его как «capacity».

### 5.7. M9 (низкая) — отложенная стадия пишется в «ошибки» тика

`runtime-scheduler.js:598-611`: `dispatchStage` возвращает `dispatched:false, reason:'no_worker_available'` ⇒ попадает в `failures` ⇒ `success:false` ⇒ тик-суммари печатает `image:no_worker_available for <scene>` в `summary.errors` **на каждом тике** (12/мин на сцену), хотя фактически ничего не происходило. Флаг `retryable`, который `dispatchStage` теперь возвращает, планировщиком **не используется** — деферабельный результат неотличим от ошибки в наблюдаемости.

### 5.8. Восстановимость и рост Redis (пункт 5 задания)

| Свойство | Оценка |
|---|---|
| Перезапуск backend | deferral живёт в Redis (TTL 60 с) ⇒ после рестарта сцена ждёт ≤60 с, затем диспатчится заново — **корректно** |
| Перезапуск Hub | lane в Redis ⇒ записи переживают рестарт; claim в backend переживает ⇒ повторная отправка подавлена ⇒ **корректно** |
| Истечение TTL claim | 24 ч (обычный) / 90 мин (неоднозначный) ⇒ после истечения возможен дубль (M7) |
| Повторное выполнение задачи | защищено done-маркером (7 сут) — но его нельзя освободить (B1) |
| Неограниченный рост Redis | **ограничен**: `deferred` (EX 60, 1 ключ на стадию), `claim` (EX 24 ч/90 мин), `ref` (EX 24 ч), `stage-epoch` (EX 30 сут), `done` (EX 7 сут). Единственный «долгоживущий» вид — `done`-маркеры: они **не освобождаются** ни одним D4-путём (B1) ⇒ накапливаются со скоростью завершённых задач × 7 сут. Не «безгранично», но это лишняя память Redis, которую никто не умеет чистить |
| Бесконечный retry-loop | **частично остался**: merged-аудио (B3), `force`-окно (M2), смешанные причины (M3), `already_completed` (M4) |

**D3 — BLOCKED (B3) + M2, M3, M4, M9.**

---

## 6. D4 — освобождение claims/done по границам задачи

### 6.1. Что сделано

Ключ ref'а получил структурное владение: `animastor:idempotency:ref:{book}:{chapter}:{scene}:{jobId}`; добавлены `releaseClaimsForScene` / `releaseClaimsForBook` → `releaseClaimsByPrefix` (SCAN по префиксу + повторная проверка префикса + удаление claim/done/ref). Точки вызова: `cancel-generation` (книга), `/regenerate` (каждая dirty-сцена), cache teardown (книга), удаление книги (книга).

### 6.2. B1 (BLOCKER) — done-маркер освободить **невозможно**: код мёртвый в проде

* `markTaskDone` вызывается **ровно в одном месте** — result-колбэк (`backend/src/routes/generation-routes.cjs:525`) — и **сразу** за ним `forgetTaskRef` (`:527`) удаляет ref-ключ.
* `releaseClaimsByPrefix` доходит до done-маркера **только через ref** (`idemKey = redis.get(refKey)`) ⇒ в проде ref и done **никогда не сосуществуют** ⇒ `redis.del(idemDoneKey(idemKey))` не удаляет **ничего**.
* Error-путь (`generation-routes.cjs:610-621`) ref удаляет и не ставит done ⇒ тоже без ref.

**Proof 2 (реальный модуль, воспроизведена прод-последовательность结算):**
```
after settlement: ref=null done=1
releaseClaimsForScene -> {"released":0,"done":0,"scanned":0}
releaseClaimsForBook  -> {"released":0,"done":0,"scanned":0}
done marker still present? true
next dispatch of the same logical task -> allowed=false reason=already_completed
```
Т.е. **все четыре D4-пути (cancel / regenerate / cache-teardown / удаление книги) НЕ освобождают completion-маркер** — вопреки прямому утверждению Stage 116 §4 («Вместе с claim освобождается и done-маркер того же задания: пользователь явно попросил выполнить работу снова»).

Тест «D4: a cleared lane releases the claims of THAT scene only» проверяет `expect(await redis.get(qidem.idemDoneKey(keyA))).to.equal(null)`, но он **сам создаёт** ref+done одновременно (`rememberTaskRef` + `markTaskDone` без `forgetTaskRef`) — состояние, **невозможное в проде**. Тест проходит и создаёт ложную уверенность.

**Реальное последствие (достижимо):** cache teardown (`DELETE /api/v1/book/:bookId/cache`) удаляет build-каталог, но **не меняет `build_id`** (манифест) и **не поднимает эпоху** (ключ `animastor:idempotency:stage-epoch:*` не входит в `cleanBookRedisKeys`, `redis-helpers.cjs:357-414`) ⇒ следующая генерация вычисляет **тот же** `idem_key` ⇒ `isTaskDone` → `already_completed` ⇒ **книга не перегенерируется до 7 сут**, а сцена при этом уходит в 60-секундный деферал (M4). Путь `/regenerate` защищён бампом эпохи (`markDirtyScene` → `bumpStageEpoch`, `scene-state-ops.js:102-111`), т.е. там D4-освобождение done вообще не нужно — что лишний раз показывает, что заявленная семантика D4 не реализована.

### 6.3. B4 (BLOCKER) — освобождение claim'ов не связано с очисткой lane (гонка / рассогласование)

Порядок в 3 из 4 путей — **сначала освобождение claim'ов, потом очистка lane**:

| Путь | Файл:строки | Порядок |
|---|---|---|
| `POST /book/:bookId/cancel-generation` | `routes/book/generation-routes.cjs:317-330` (release) → `:331-345` (`DELETE {HUB}/queue/clear`) | **release → clear** |
| `DELETE /book/:bookId/cache` | `routes/book/cache-routes.cjs:116-128` (release) → `:130-139` (clear, ошибка **проглатывается**) | **release → clear** |
| Удаление книги | `services/book-deletion.cjs:200-212` (release) → `:215+` (clear) | **release → clear** |
| `POST /book/:bookId/regenerate` | `orchestrator.resetScenes` (сначала чистит lane) → затем release (`generation-routes.cjs:615-633`) | **clear → release** ✔ |

Последствия:
1. **Отказ хаба** ⇒ claim'ы уже освобождены, а записи lane остались ⇒ следующий диспатч ставит **вторую копию** ещё не выполненной задачи. В cache-teardown ошибка очистки проглатывается (`.catch(() => {})`) ⇒ пользователь получает `{cleared:true}`, а состояние рассогласовано. В cancel-пути ошибка превращается в HTTP 500, но **после** освобождения claim'ов.
2. **Гонка с активным диспатчем** (прямо требуется в задании): между release и clear активный диспатч успевает пере-заclaim'ить задачу и поставить её в lane; следующий `clear` удаляет запись, а claim остаётся на 24 ч ⇒ задача подавлена (`duplicate_pending`) на весь TTL.
3. `releaseClaimsForBook` сканирует весь keyspace (`SCAN MATCH`) — при большом keyspace это добавляет задержку **перед** сетевым вызовом к хабу, т.е. расширяет окно гонки.

Корректный порядок — «сначала очистить lane, потом (и только при успешной очистке) освобождать claim'ы», как уже сделано в `/regenerate`.

### 6.4. M1 (средняя) — неоднозначность префиксов при `:` в идентификаторах

Ref-ключ склеен через `:` ⇒ `bookId` с `:` делает границы неоднозначными. `book_id` **клиент-контролируемый** (импорт: `import-routes.cjs:228` — `bookData.manifest.book_id`; комментарий в коде `:88`: «bundle book_id is client-controlled»), формат не валидируется.

**Proof 4 (реальный модуль):**
```
releaseClaimsForBook('a:b') -> {"released":2,"done":2,"scanned":2}
the claim of book 'a' / chapter 'b' / scene 'c' still present? false
→ CROSS-BOOK DELETION
```
То есть освобождение claim'ов книги `a` задевает книгу `a:b` (и наоборот: `releaseClaimsForScene('a','b','c')` задевает `ref:a:b:c:…` книги `a:b`). Проверка `key.startsWith(prefix)` внутри `releaseClaimsByPrefix` этот дефект не ловит — она проверяет тот же неоднозначный префикс. Сценарий-сценарий и соседние сцены при этом не затрагиваются (проверено: `sc`, `sc2`, `sc_x` — корректно). Практический ущерб ограничен (освобождаются claim'ы, а не данные), но требование «освобождать **только** принадлежащие соответствующей книге и задаче» нарушено.

### 6.5. Проверка прочих аспектов D4

| Аспект | Результат |
|---|---|
| Prefix-сканирование без широкого `SCAN+DEL` по семейству | ✔ (SCAN по `MATCH prefix*`, без `KEYS`/`FLUSH`) |
| Чужие ключи не удаляются | ✔ для сцен/книг без `:` в id; ✘ при `:` (M1) |
| Ref-ключ не содержит «сырой грамматики job_id» | ✔ грамматика не выводится, владение выражено структурой; архитектурный guard доволен (935/0) |
| Кэш-тейardown / удаление книги / cancel / regenerate — все 4 пути подключены | ✔ (все 4 присутствуют в коде и в `backend.cjs` через инъекцию порта) |
| Инъекция порта вместо `require` в контурных роутах | ✔ (`routeDeps.queueIdempotency`, `createBookDeletion({queueIdempotency})`), архитектурные guard'ы проходят |
| Счётчики `released`/`done` в логах | ⚠️ `done` всегда равен `released`, хотя done-маркер фактически не удаляется ⇒ метрика вводит в заблуждение |

**D4 — BLOCKED (B1, B4) + M1.**

---

## 7. Пункт 5 задания — рестарты, TTL, повторное выполнение, рост Redis

| Сценарий | Поведение | Оценка |
|---|---|---|
| Рестарт backend при активном dispatch | dispatch отменяется (graceful) → reconciliation откатывает FSM → новый dispatch с новым `dispatch_id`; claim переживает ⇒ `duplicate_pending` ⇒ без дубля в lane | ✔ корректно (регрессия Stage 114 на месте) |
| Рестарт backend при открытом deferral | deferral в Redis, TTL 60 с ⇒ сцена ждёт ≤60 с и диспатчится заново | ✔ |
| Рестарт Hub | lane в Redis переживает; claim в backend переживает ⇒ повторная постановка подавлена | ✔ |
| Истечение TTL claim (24 ч / 90 мин) | claim исчезает ⇒ **возможна повторная отправка** уже принятой/потерянной задачи | ⚠️ M7 (осознанный компромисс, но не измерен) |
| «Обновление» pending-claim'а | **не работает** (`SET NX` не продлевает TTL) ⇒ после 24 ч дубль | ❌ **B5** |
| Повторное выполнение задачи (тот же idem_key) | подавляется done-маркером (7 сут) ⇒ **но его нельзя освободить** ⇒ задача теряется на срок TTL | ❌ **B1** |
| Бесконечный retry-loop | остался в 4 формах (merged-аудио, force-окно, смешанные причины, `already_completed`) | ⚠️ B3, M2, M3, M4 |
| Неограниченный рост Redis | ограничен TTL'ами; `done`-маркеры не чистятся никогда (7 сут × скорость завершений) | ⚠️ низкий, но чинить надо |
| Потерянные задачи | 2 сценария: (а) неоднозначный POST, потерянный в хабе ⇒ задача заблокирована на 90 мин; (б) cache-teardown ⇒ задача подавлена `already_completed` до 7 сут (следствие B1) | ⚠️ |

---

## 8. Пункт 6 задания — пакет `@animastor/orchestration`: публикуемость и потребление

### 8.1. Фактическое состояние (проверено, только чтение)

| Объект | Факт |
|---|---|
| Исходники пакета с фиксом D3 | `packages/animastor-orchestration/src/runtime/dispatch-engine.js`, `.../src/orchestration/scene-orchestrator.js` (коммит `fc9c6097`) |
| Версия в исходниках | `packages/animastor-orchestration/package.json:3` → **`0.1.4`** (та же, что уже опубликована) |
| npm registry (`npm view`, только чтение) | доступны `0.1.1 … 0.1.4`; **`latest = 0.1.4`**; **0.1.5 не существует** |
| Зависимость backend | `backend/package.json:26` → `"@animastor/orchestration": "^0.1.4"` |
| Lockfile backend | `backend/package-lock.json:20` → range `^0.1.4`; `:175-186` → `version 0.1.4`, `resolved …/orchestration-0.1.4.tgz`, `integrity sha512-WW/Imbc1IYBAjGtx5exHWcgMJTfHbWvr8HBmyzglBbuXl/WSQj2vl2mff6/MqwwDu/2LFlFcFfNidEu07TyIzw==` |
| Установленная локальная копия | `backend/node_modules/@animastor/orchestration` — **ручная синхронизация** с изменёнными исходниками (`diff -rq` → 0 различий). Это **изменение окружения**, не часть коммита (node_modules вне git) |
| Сборка образа | `backend/Dockerfile`: `COPY package.json package-lock.json*` → `RUN npm install -g npm@11 && npm install --omit=dev --ignore-scripts` ⇒ **образ тянет 0.1.4 из registry** |

### 8.2. Вывод (BLOCKER для деплоя, но состояние репозитория честное)

* Фикс **D3 живёт в уже опубликованном пакете** `0.1.4` ⇒ `npm publish` без bump'а версии невозможен (npm не перезаписывает), а backend, тянющий `^0.1.4`, в собранном образе получит **старый** dispatch-engine ⇒ **D3 в production не попадёт**.
* Локальные зелёные тесты этого **не показывают**: они идут по ручно синхронизированной копии в `backend/node_modules`, а CI/Docker-сборка её не воспроизводит. Это расхождение «локально зелёное / в сборке не то» — источник ложной уверенности.
* Итог ровно такой, как зафиксирован в Stage 116 §9.1: ** публикация пакета + bump зависимости backend — обязательный предшествующий шаг**. Подтверждаю и даю точные файлы/команды.

### 8.3. Точные файлы и команды для будущего bump'а версии и зависимости

**Шаг 1 — версия пакета (единственный файл):**
```bash
cd /home/animastor/animastor-backend
# packages/animastor-orchestration/package.json : "version": "0.1.4"  →  "0.1.5"
```
(остальное в манифесте не трогать; `publishConfig.access: "public"` уже задан — `package.json:30-32`)

**Шаг 2 — публикация (отдельный шаг, только по явному approval владельца):**
```bash
cd /home/animastor/animastor-backend/packages/animastor-orchestration
npm pack --dry-run                 # контроль состава (ожидается 38 файлов: 37 из 0.1.4 + test/capacity-deferral.test.js)
npm publish --access public        # npm-auth владельца (~/.npmrc: registry.npmjs.org + _authToken)
# проверка (только чтение):
npm view @animastor/orchestration@0.1.5 version dist.integrity dist.shasum
npm view @animastor/orchestration dist-tags
```
(процедура повторяет Stage 102/103: publish → сверка `dist.integrity` с локальным tarballом → bump в backend → пересборка образа)

**Шаг 3 — зависимость backend (2 файла):**
```bash
cd /home/animastor/animastor-backend/backend
# backend/package.json : "@animastor/orchestration": "^0.1.4"  →  "^0.1.5"
npm install --package-lock-only @animastor/orchestration@^0.1.5   # обновит backend/package-lock.json
# (root-range + запись node_modules/@animastor/orchestration: version/resolved/integrity)
npm install                                                        # освежить backend/node_modules
```
**Шаг 4 — верификация до коммита:**
```bash
cd /home/animastor/animastor-backend
node -e "console.log(require('./backend/node_modules/@animastor/orchestration/package.json').version)"   # → 0.1.5
diff -rq backend/node_modules/@animastor/orchestration/src packages/animastor-orchestration/src          # → пусто
grep -n "DEFERRED_STAGE_TTL_S" backend/node_modules/@animastor/orchestration/src/runtime/dispatch-engine.js
grep -n "orchestration" backend/package.json backend/package-lock.json
cd packages/animastor-orchestration && npm test     # ожидается 30 passing / 0 failing
cd ../../backend && npm test                        # полный suite, baseline падений = 86 (env)
```
**Шаг 5 — коммит (только эти 2 файла, как в Stage 103 / `78e8f1ae`):**
```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(backend): update orchestration to 0.1.5"
```
**Не трогать:** `packages/animastor-orchestration/package-lock.json` (в нём предсуществующий дрейф `0.1.2`; в разрешении backend-зависимостей он не участвует — Stage 103 §2), `packages/*/package.json` остальных пакетов, `backend/package-lock.json` кроме автоматически обновлённых строк.

**Шаг 6 — только после этого** пересборка образа backend (Stage 119), иначе D3 в контейнере не появится.

---

## 9. Сводка находок

| # | Severity | Область | Находка | Доказательство |
|---|---|---|---|---|
| **B1** | **BLOCKER** | D4 | done-маркер невозможно освободить: `markTaskDone` всегда парный `forgetTaskRef` ⇒ ref+done не сосуществуют ⇒ `releaseClaimsByPrefix` не находит ни одного done ⇒ **все 4 D4-пути оставляют completion-маркер на 7 сут** ⇒ повторная генерация (напр. после cache-teardown с тем же build_id) подавляется как `already_completed` | proof 2; `generation-routes.cjs:525-527`; `queue-idempotency.cjs:403-430` |
| **B2** | **BLOCKER** | D2 | `definitiveRejection` sticky между 3 попытками: 4xx на ранней попытке + неоднозначный исход на поздней ⇒ claim **освобождается** ⇒ дубль возможен; и `ambiguous` в ответе вводит в заблуждение | proof 3; `gpu-dispatcher.js:298,313-318,332-347` |
| **B3** | **BLOCKER** | D3 | merged (pure-dialogue) аудио-путь не вычисляет `deferReason` ⇒ деферал не применяется ⇒ 5-секундный dispatch/cancel/rollback-цикл сохраняется | proof 7; `audio/generation.js:326-351, 539-545` |
| **B4** | **BLOCKER** | D4 | в 3 из 4 путей claim'ы освобождаются **до** очистки lane ⇒ при отказе хаба записи lane остаются, а claim уже свободен ⇒ дубль; гонка с активным диспатчем ⇒ задача подавлена на 24 ч | `generation-routes.cjs:317-345`; `cache-routes.cjs:116-139`; `book-deletion.cjs:200-212` |
| **B5** | **BLOCKER** | D2/D4 | «refresh» pending-claim'а — no-op (`SET NX` не продлевает TTL) ⇒ заявленное в Stage 116 исправление TTL не работает; тест вакуумный | proof 1; `gpu-dispatcher.js:262-267`; `queue-idempotency.cjs:195-203` |
| M1 | средняя | D4 | неоднозначность префиксов при `:` в `book_id` (client-controlled) ⇒ cross-book удаление claim'ов | proof 4; `import-routes.cjs:88,228`; `queue-idempotency.cjs:387-401` |
| M2 | средняя | D3 | `force=true` обходит деферал ⇒ после каждого `/regenerate` (окно 120 с) — полная попытка каждый 5 с | proof 6; `dispatch-engine.js:817`; `runtime-config.js:205` |
| M3 | средняя | D3 | деферал требует **ровно одну** причину (`size === 1`) ⇒ смешанные capacity-причины не дефералятся | `iu-processor.js:380-390`; `audio/generation.js:539-545` |
| M4 | средняя | D3 | `already_completed` классифицирован как «capacity» ⇒ сцена навсегда уходит в 60-секундный деферал, не падает и не завершается | `queue-idempotency.cjs:276-280`; `dispatch-engine.js:756-762` |
| M5 | средняя | D2 | неоднозначный исход возвращается без `reason`; флаг `ambiguous` не читается нигде в оркестрации ⇒ D2-различие не доходит до вызывающего | proof 5; `gpu-dispatcher.js:348-354`; `iu-processor.js:319-327` |
| M6 | средняя | D1 | per-dispatch заморозка эпохи удалена ⇒ две отправки одной задачи внутри одного dispatch при движении эпохи дают 2 записи в lane (baseline давал 1); тест Stage 114 заменён, инвариант больше не гарантирован | proof 8 (baseline vs Stage 116); `dispatch-engine`/`gpu-dispatcher.js:242-258` |
| M7 | средняя | D2 | после TTL 90 мин (и 24 ч) возможна повторная отправка уже принятой задачи, если результат не доставлен ⇒ нужен reconciliation/алерт | `queue-idempotency.cjs:53-61` |
| M8 | низкая | D2 | обоснование «3× максимального таймаута (30 мин)» неверно: video-таймаут 60 мин ⇒ 90 мин = 1.5× | `queue-idempotency.cjs:56-61`; media-registry `video=3600000ms` |
| M9 | низкая | D3 | отложенная стадия пишется в `summary.errors` тика каждый 5 с; `retryable` планировщиком не используется | `runtime-scheduler.js:598-611, 470-478` |
| M10 | низкая | D4 | JSDOC `releaseClaimsForScene/ForBook` описывает **старую** грамматику (`{bookId}_{chapterId}_…`, `_`-разделитель), код использует `:`-форму ⇒ риск для будущего мейнтенера | `queue-idempotency.cjs:376-401` |
| M11 | низкая | D1 | `resolveDispatchEpoch(redis, dispatchId, …)` больше не использует `dispatchId` (мёртвый параметр); прежняя защита «нет dispatch_id ⇒ epoch 0» снята | `queue-idempotency.cjs:166-168` |
| M12 | низкая | D4 | счётчик `done` в логах всегда равен `released`, хотя done-маркер фактически не удаляется ⇒ метрика вводит в заблуждение | `queue-idempotency.cjs:422-423` |

---

## 10. Рекомендации

### 10.1. До публикации/деплоя (в порядке приоритета)

1. **B1** — сделать достижимым освобождение completion-маркера. Варианты: (а) не удалять ref при settlement, а хранить его до TTL done-маркера (тогда ref+done сосуществуют и release их найдёт); (б) хранить done-маркер под **структурным** ключом с владением (`animastor:idempotency:done:{book}:{ch}:{sc}:{job}`) вместо sha256 → тогда scene/book-release найдёт его напрямую; (в) явный `releaseCompletionMarkersForBook/Scene`. Вариант (б) наиболее согласован с уже принятой структурой ref-ключа.
2. **B2** — классифицировать **последний** исход, а не «любой 4xx за серию»: сбрасывать `definitiveRejection` в начале каждой попытки, либо запоминать исход каждой попытки и решать по последнему; 4xx не ретраить.
3. **B3** — вынести вычисление `deferReason` из `sendPerSegmentAudio` в `generateSceneAudio` (единая точка по всем веткам, включая merged).
4. **B4** — инвертировать порядок: сначала `DELETE {HUB}/queue/clear`, и только при успешном ответе — освобождение claim'ов (как уже сделано в `/regenerate`); при ошибке очистки claim'ы **не** трогать.
5. **B5** — реально продлевать TTL claim'а: `redis.expire(claimKey, ttl)` (или `SET key 1 XX EX ttl`) вместо `claimTask()` с `NX`; тест должен проверять **рост** TTL, а не `>= before - 1`.

### 10.2. Умеренные (M1…M12) — до или сразу после публикации

* M1: разделитель в ref-ключе, устойчивый к `:` в идентификаторах (например, длину-префикс или url-encode составляющих), либо проверка «составные части не содержат разделителя».
* M2: `force` должен **сбрасывать** деферал (и/или не обходить его).
* M3: классифицировать «все причины — capacity», а не «ровно одна причина».
* M4: убрать `already_completed` из ёмкостных исходов (это терминальная идемпотентная подавление, а не «нет мощности») — иначе сцена будет висеть бесконечно.
* M5: прокинуть `reason` (например `'ambiguous_post'`) из `sendUnified` в оркестратор и добавить его в набор деферабельных/ретраибельных исходов.
* M6: сохранить инвариант «одна задача = одна идентичность на dispatch» — например, фиксировать эпоху **на задачу** (а не на dispatch) при первом её вычислении, чтобы bump после её отправки её не задевал.
* M7: добавить сверку с lane хаба (reconciliation) либо метрику+алерт на «claim истёк, а задача не завершена».
* M8–M12: правки комментариев/метрик/сигнатур — косметика.

### 10.3. Порядок этапов (с учётом Stage 116 §10)

```
118  исправление B1…B5 (+ M1…M5 по возможности) в animastor-backend   ← обязательно ДО публикации
119  тесты пакета (>=30) и backend (регрессий 0) + повторный независимый аудит
120  публикация @animastor/orchestration@0.1.5 + bump backend ^0.1.5 (процедура §8.3)
121  push/CI/GHCR/деплой + наблюдение: очередь 457→476 и далее без роста, журнал не растёт
122  очистка 438 дублей (отдельный approval)
123  восстановление workers (Stage 113 §A.5)
```
Публикация пакета **до** исправления B1–B5 зафиксирует в npm версию с неполной D4/D2-семантикой; повторный bump (0.1.6) потребует ещё одного цикла публикации и bump'а зависимости.

---

## 11. Приложения

### 11.1. Воспроизведение доказательств

```bash
cd /home/animastor/animastor-backend
# 1) целевые тесты пакета и backend
(cd packages/animastor-orchestration && npm test)                       # 30 pass
(cd backend && PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1 \
   npx mocha --exit tests/gpu-queue-idempotency.test.js)                # 29 pass
# 2) архитектурные
(cd backend && PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1 \
   npx mocha --exit --reporter min "tests/architecture/*.test.js")       # 935 pass / 24 pending / 0 fail
# 3) полный suite (изолированные адреса!)
(cd backend && ANIMASTOR_DOCS_ROOT=/home/animastor/animastor-docs PG_HOST=127.0.0.1 PG_PORT=1 \
   REDIS_HOST=127.0.0.1 REDIS_PORT=1 npx mocha --exit --reporter min "tests/**/*.test.js")
# 4) доказательства (вне репозитория, без сети)
node /tmp/opencode/117-proofs.js            # proofs 1,2,3,4,5,8
node /tmp/opencode/117-d3-proofs.js         # proofs 6,7
AUDIT_REPO=/tmp/opencode/stage115 node /tmp/opencode/117-proofs.js   # то же на baseline
```

### 11.2. Ключевые строки кода (для ревью-фикса)

| Файл:строка | Что смотреть |
|---|---|
| `backend/src/helpers/queue-idempotency.cjs:166-168` | `resolveDispatchEpoch` — epoch на каждую отправку |
| `backend/src/helpers/queue-idempotency.cjs:195-203` | `claimTask` — `SET NX EX` (TTL не продлевается) |
| `backend/src/helpers/queue-idempotency.cjs:276-285` | `CAPACITY_REASONS` / `isCapacityReason` |
| `backend/src/helpers/queue-idempotency.cjs:365-373` | `shortenClaimTtl` (90 мин) |
| `backend/src/helpers/queue-idempotency.cjs:376-430` | `releaseClaimsForScene/ForBook/ByPrefix` (+ устаревшие JSDOC) |
| `backend/src/runtime/gpu-dispatcher.js:242-281` | epoch → `idem_key` → guard → ref |
| `backend/src/runtime/gpu-dispatcher.js:290-354` | цикл POST, `definitiveRejection`, ветвление claim |
| `backend/src/image/iu-processor.js:227-233, 354-393` | bump эпохи в dirty-ветке; агрегация причин |
| `backend/src/audio/generation.js:311-372, 526-548` | `deferState` (merged-ветка без `deferReason`) |
| `backend/src/routes/generation-routes.cjs:519-532, 609-621` | settlement пары `markTaskDone`+`forgetTaskRef` (корень B1) |
| `backend/src/routes/book/generation-routes.cjs:317-345, 612-635` | порядок release ↔ clear (B4) |
| `backend/src/routes/book/cache-routes.cjs:116-139` | порядок release ↔ clear (B4) |
| `backend/src/services/book-deletion.cjs:200-212` | порядок release ↔ clear (B4) |
| `packages/animastor-orchestration/src/runtime/dispatch-engine.js:747-762, 805-820, 985-1030, 1394-1400` | классификация, проверка деферала, `deferStage`/`clearStageDeferral` |
| `packages/animastor-orchestration/src/orchestration/scene-orchestrator.js:300-315, 358-400, 570-610` | сбор причин image/audio/video |

### 11.3. Состояние окружения на момент окончания аудита

| Объект | Значение | Изменено аудитом? |
|---|---|---|
| `HEAD` | `ae4e7d49f08051f7b8d164763ca4441334a103c3` | нет |
| `origin/main` / `github/main` | `53ce504536c14413c2c5e7b8546d529db8ee2530` | нет |
| Рабочее дерево | 5 modified + 1 deleted + 2 untracked — **как на входе** | нет |
| npm `@animastor/orchestration` | `latest = 0.1.4` | нет (только чтение) |
| Production Redis/PG/hub/очередь | не опрашивались и не изменялись | нет |
| Push / CI / GHCR / deploy | не выполнялись | нет |
| Артефакты аудита | `/tmp/opencode/stage115` (baseline-копия), `/tmp/opencode/117-*.log`, `/tmp/opencode/117-*proofs.js` | только в `/tmp` |

---

**Итог Stage 117: BLOCKED.** Тесты зелёные, регрессий относительно baseline Stage 115 нет (набор падений идентичен), но **5 блокеров** в самих исправлениях Stage 116 (D2 ×2, D3 ×1, D4 ×2) — три из них опровергают прямо утверждения отчёта Stage 116 (D4-done-маркер, refresh-claim, «D2 различает исходы»). Публикация npm-пакета и bump зависимости backend описаны точно (§8.3), но выполнять их следует **после** исправления B1–B5, иначе в npm попадёт версия с неполной D2/D3/D4-семантикой.
