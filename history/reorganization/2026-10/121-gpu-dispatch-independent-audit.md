# Stage 121 — Независимый аудит GPU dispatch retry-lifecycle fixes (Stage 120)

**Объект:** commit `78bbfe18` (Stage 120) поверх base `e2f5bb4c` в `/home/animastor/animastor-backend`
**Дата:** 2026-10-22
**Артефакты:** `/tmp/opencode/stage121/` (логи, пробы, доказательства)

**Итог: BLOCKED** — 1 блокер (**N1**: M-b sweep на regenerate-пути — фактически no-op, заявление «во всех четырёх путях» не соответствует реализации) + 1 средняя новая находка (**N2**: M-c-фикс покрывает только image; audio/video пути петляют на осиротевшем done-маркере). Регрессий нет: полный suite идентичен baseline, набор падений byte-identical. F1, F2, M-a, M-c (в заявленном объёме), M-d, M-e, M-f закрыты корректно.

---

## 0. Краткий вердикт

| Находка Stage 117/119 | Заявление Stage 120 | Фактический результат аудита | Вердикт |
|---|---|---|---|
| **F1** epoch сцены заморожен | `resetJobEpochForStage` снимает пин только затронутой стадии | Скан только префикса `job-epoch:{book}:*`, резолв стадии через `getStageForJobId`/`STAGE_BY_KIND` (audio/image/video, вкл. `iu_image`); пины соседних стадий и других книг не трогаются; свежая идентичность резолвится после `markDirtyScene` (проб P-A1 a–d) | **CLOSED** |
| **F2** refresh claim no-op / 90-мин окно продлевается | состояний claims `pending`/`ambiguous`, Lua `REFRESH_CLAIM_TTL_SCRIPT` + JS-fallback | Повторные `duplicate_pending` **не** продлевают ambiguous-окно (90 мин); released claim не воскресает; истечение TTL допускает повторную отправку (пробы P-A2/P-A3 на временном FakeRedis) | **CLOSED** |
| **M-a** ложный `cleared:true` при отказе хаба | честное тело ответа | DELETE возвращает `{cleared:false, hub_cleared:false, claims_kept:true, error:'hub_queue_clear_failed'}` при HTTP 200; claims сохранены; ни release, ни sweep при отказе первого прохода (cache-routes.cjs:191; проб P-A4) | **CLOSED** |
| **M-b** гонка clear-lane ↔ release | второй проход очистки **после** release «во всех четырёх путях: cache/delete/cancel — прямой fetch, regenerate — hubCancelOp('clearHubDispatches')» | cache/delete/cancel — подтверждённо функциональны; **regenerate — no-op: пустой список dispatch-id + `book_id` игнорируется → 0 HTTP-запросов к хабу** (см. N1) | **PARTIAL → BLOCKED** |
| **M-c** `already_completed` на SEND-пути | `releaseTaskDone` + одна повторная отправка в `processSingleIU` | Интеграционно подтверждено (3 диспатча: отправка → orphan-release+регенерация → `duplicate_pending`, цикл разорван). **Резидуал:** audio/video send-пути `releaseTaskDone` не вызывают (см. N2) | **CLOSED** (в заявленном объёме) + резидуал N2 |
| **M-d** мусорные `job-epoch` префиксы | glob-экранированный percent-encoded префикс в `cleanBookRedisKeys` | Подтверждено; `ref:*` намеренно сохраняется (проб P-A7) | **CLOSED** |
| **M-e** 4xx классификация | `RETRYABLE_4XX={400,408,409,425,429}`, break после 1 попытки для финального 4xx | Подтверждено: финальный 4xx → break + release; транзиентный 4xx → 3 попытки; B2 сохранён (gpu-dispatcher.js:154; пробы P-A8 + коммитные тесты) | **CLOSED** |
| **M-f** settleCompletedTask слепой | расширение/ремап ref-ключа до записи маркера | Ремапленный ref → `markerWritten:false`, слепой маркер не пишется, чужая задача не помечается завершённой (проб P-A6 + 3 коммитных теста) | **CLOSED** |

### Новые находки Stage 121

| ID | Серьёзность | Суть |
|---|---|---|
| **N1** | **блокер** (для утверждения M-b) | Sweep после release на regenerate-пути — функциональный no-op: `generation-routes.cjs:673` вызывает `hubCancelOp('clearHubDispatches')([], { book_id: bookId })` с **пустым** списком dispatch-id, а `clearHubDispatches` (`dispatch-engine.js:1597`) итерирует **только** по `dispatchIds` и игнорирует `options.book_id` ⇒ к хабу уходит **0 запросов**. Коммитный тест regenerate — структурная (строковая) проверка, поэтому проходит, не проверяя поведения. Гонка M-b на regenerate-пути не сужена (как до Stage 120); регрессии нет, но и заявленного исправления на этом пути нет. |
| **N2** | средняя | `releaseTaskDone` имеет ровно **один** production-вызов — `backend/src/image/iu-processor.js:340` (M-c). Аудио- и видео-send-пути его не вызывают: осиротевший done-маркер на audio/video задаче даёт `already_completed` → деферал 900 с → повтор каждые 15 мин, сцена остаётся в active-index (проб P-A5). Ограничено окном деферала (bounded, не hot-loop), поэтому не блокер; M-c по декларированному объёму (`processSingleIU`) закрыт честно. |

---

## 1. Метод, изоляция и безопасность

### 1.1. Что делалось

1. Чтение отчёта Stage 120 и полного `git diff e2f5bb4c 78bbfe18` (13 файлов, +1129/−12).
2. Кодовое подтверждение каждой находки F1, F2, M-a…M-f по production-путям.
3. Собственные поведенческие пробы (не полагаясь только на коммитные тесты Stage 120): `/tmp/opencode/stage121/audit-probe.js`, `probe-regenerate-sweep.js`, `probe-f2-fakeredis.js` (+ `fakeredis.js` — временное время-осведомлённое хранилище).
4. Перезапуск proof-скриптов Stage 119 (`proof-p10/p11/p12.js`) против текущего дерева с `PROOF_OUT=/tmp/opencode/stage121/`.
5. Независимый прогон всего тестового матрикса (см. §2).

### 1.2. Изоляция и безопасность (проверено ДО и ПОСЛЕ прогонов)

| Требование | Статус |
|---|---|
| Все БД/Redis-прогоны на гарантированно недоступном адресе | `PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1` на **каждом** запуске. Во всех 85 падениях полного suite — **431** вхождение `ECONNREFUSED 127.0.0.1:1`; **0** обращений к любому другому хосту. Production Redis/PG не затронуты. |
| Хаб | Все hub-fetch в тестах и пробах застаблены; реальные HTTP не выполнялись. |
| Код/версии/lockfiles/refs/config | Не изменялись. HEAD = `78bbfe18` до и после; `origin/main` = `53ce5045` не тронут. |
| Грязные файлы рабочего дерева | 5 M + 1 D + 2 ?? — не тронуты (сверено со Stage 120). |
| Очереди 457/438, `.env`, Compose, хуки, публикации, push/CI/GHCR | Не трогались. |

---

## 2. Результаты тестов (независимый прогон)

### 2.1. Сводка

| Suite | Команда | Результат | Лог |
|---|---|---|---|
| Syntax smoke | `bash ../scripts/syntax-smoke.sh` (pretest) | **OK**, все файлы `*` | `arch-npmtest.log` |
| Целевые GPU-тесты | `npx mocha --exit tests/gpu-queue-idempotency.test.js tests/gpu-audio-dispatch-deferral.test.js tests/gpu-lane-release-order.test.js tests/gpu-orphan-completed-marker.test.js` | **75 passing / 0 failing** (20 s) | `targeted.log` |
| Пакет `@animastor/orchestration` | `npm test` | **35 passing / 0 failing** | `orchestration.log` |
| Архитектурные | `npm test` (= smoke + `tests/architecture/*`) | **935 passing / 24 pending / 0 failing** | `arch-npmtest.log` |
| Полный suite | `npx mocha --exit --reporter min "tests/**/*.test.js"` | **2665 passing / 28 pending / 85 failing** (53 s) | `full-suite.log` |
| Proof-скрипты Stage 119 | `proof-p10/p11/p12.js` | p10 **9/12**, p11 **7/8**, p12 **5/5** (объяснения §7) | `p10.json`, `p11.json`, `p12.json` |

### 2.2. Сравнение падений с baseline — наборы **идентичны**

Извлечённые заголовки 85 падений (`full.failures.txt`) **byte-identical** к Stage 118 committed baseline (`/tmp/opencode/118-committed.failures.txt`, `diff` пустой). Все 85 — environmental: `ECONNREFUSED 127.0.0.1:1` (PG/Redis на закрытом порту), каскадные `before all` hook'и LAC/Share/Private-worker suites. **Ни одного падения, связанного с изменёнными файлами Stage 120.**

### 2.3. Числа vs отчёт Stage 20

Тройка `passing/pending/failing` (2665/28/85) совпадает с отчётом Stage 120 точно. Цифра «2696 total» из отчёта Stage 120 не сходится с суммой 2665+28+85 = 2778 — арифметическая неточность в отчёте, на решение не влияет.

---

## 3. F1 — epoch сцены сбрасывается по границе стадии (CLOSED)

`resetJobEpochForStage` (`backend/src/helpers/queue-idempotency.cjs:283`): сканирует **только** префикс `job-epoch:{book}:*` (glob-экранированный), стадию jobId резолвит через `getStageForJobId`/`STAGE_BY_KIND` протокола v2 (audio/image/video, `iu_image` → image), снимает пин **только** затронутой стадии. Проб P-A1 (a–d): пины соседних стадий и других книг не меняются; после `markDirtyScene` + `resetJobEpochForStage` повторный диспатч проходит с первой попытки. Вызов из `scene-state-ops.js` в месте инвалидации ассета — корректный.

## 4. F2 — claims: `pending` продлевается, `ambiguous` нет, released не воскресает (CLOSED)

`REFRESH_CLAIM_TTL_SCRIPT` (`queue-idempotency.cjs:705`): Lua (missing → 0, ambiguous → −1, иначе `SET XX EX` → 1) + JS-fallback. Ключевые поведения подтверждены пробами P-A2/P-A3 на время-осведомлённом FakeRedis:
- повторные `duplicate_pending` **не** продлевают 90-минутное ambiguous-окно;
- released claim никогда не восстанавливается refresh'ем;
- истечение TTL claim'а допускает повторную отправку (корректный resend после честного 4xx-release).

**Замечание (гигиена моков, не влияет на вердикт):** 3 изначальных «фейла» пробы P-A2/P-A3 были артефактом `tests/mocks/redis-mock.js` — мок игнорирует `SET XX` и не истекает TTL по времени. Коммитные F2-тесты используют корректный встроенный FakeRedis, поэтому детерминированы; рекомендуется привести общий мок в соответствие.

## 5. M-a — честный ответ при отказе хаба (CLOSED)

`cache-routes.cjs:147-191`: при отказе хаба DELETE отвечает `{cleared:false, hub_cleared:false, claims_kept:true, error:'hub_queue_clear_failed'}` (HTTP 200), claims **не** трогаются, ни release, ни второй проход sweep не выполняются (отказ первого прохода ⇒ sweep не нужен — безопасное направление). Подтверждено пробой P-A4.

## 6. M-b — второй проход очистки lane (PARTIAL → BLOCKED, см. N1)

- **cache / delete / cancel** — подтверждено: прямой `fetch` после release, при отказе хаба claims сохраняются (проба M-b-веток + коммитные кейсы cancel/cache/cache+throw/delete в `gpu-lane-release-order.test.js`).
- **regenerate** — **no-op** (N1, §10.1): вызов есть, запросов к хабу нет. Stage 120 пометил свой тест как «структурный», но в матрице claims заявил sweep «во всех четырёх путях» — это не соответствует реализации.

## 7. M-c — orphan done-маркер (CLOSED в заявленном объёме; резидуал N2)

`iu-processor.js:337-345`: при `!sent && reason==='already_completed' && idem_key` → `releaseTaskDone` (`queue-idempotency.cjs:467`) + **одна** повторная отправка. Интеграционный `gpu-orphan-completed-marker.test.js` (реальный `processSingleIU` → реальный transport → реальный `guardEnqueue`): 3 диспатча — отправка → orphan-release + регенерация (2 POST, done-маркер удалён) → третий диспатч получает `duplicate_pending` (bounded-деферал, POST не прибавился). Цикл `already_completed` разорван. Резидуал на audio/video — N2 (§10.2).

## 8. M-d / M-e / M-f (CLOSED)

- **M-d:** `cleanBookRedisKeys` (`redis-helpers.cjs`) добавляет glob-эскейпленный percent-encoded префикс `job-epoch:{book}:*`; `ref:*` сохраняется намеренно (проб P-A7).
- **M-e:** `RETRYABLE_4XX = {400,408,409,425,429}` (`gpu-dispatcher.js:154`); финальный не-retryable 4xx → break после 1 попытки + release claim; транзиентный 4xx → 3 попытки; классификация B2 между попытками не «липнет» (пробы P-A8 + коммитные тесты).
- **M-f:** `settleCompletedTask` (`queue-idempotency.cjs:497`) расширяет/ремапит ref-ключ **до** записи done-маркера; ремапленный ref → `markerWritten:false`, слепой маркер не пишется, чужая задача не помечается завершённой (проб P-A6 + 3 коммитных теста + структурная сверка `generation-routes.cjs`).

## 9. Объяснение результатов proof-скриптов

### p11 — 7/8

Единственная «неудачная» нога — **P11.7**: это сама M-a-assertion, написанная под **старое** поведение (`cleared===true` при отказе хаба). Новое честное тело `{cleared:false, hub_cleared:false, claims_kept:true, error:'hub_queue_clear_failed'}` и делает «фейл» старой проверки. Т.е. 7/8 — это **подтверждение** исправления M-a, а не дефект. Поведение всех 8 ног проверено по коду и пробой P-A4.

### p10 — 9/12

Три «неудачные» ноги — все **CONTROL**-ноги сценария «dropping the pinned intent epoch restores the regeneration». После F1 `markDirtyScene` **сам** сбрасывает пин, повторный диспатч уже создал свежий pending-claim, и ручной CONTROL-drop пина даёт **ту же** логическую идентичность → легитимный `duplicate_pending` (дедупликация ровно того, что F2 и должна давать). Никакого дефекта: CONTROL-механизм дублирует то, что исправление уже сделало автоматически.

### p12 — 5/5

Все ноги проходят.

## 10. Новые находки (детально)

### 10.1. N1 (блокер) — regenerate-sweep M-b есть только на бумаге

**Место:** `backend/src/routes/book/generation-routes.cjs:673` → `hubPort.hubCancelOp('clearHubDispatches')([], { book_id: bookId })`.
**Почему no-op:** `packages/animastor-orchestration/src/runtime/dispatch-engine.js:1597` — `clearHubDispatches(dispatchIds, options)` итерирует **только** по `dispatchIds`; `options.book_id` нигде не читается. Пустой массив ⇒ тело цикла не выполняется ни разу ⇒ **0 HTTP-запросов** к хабу.
**Поведенческое доказательство:** `/tmp/opencode/stage121/probe-regenerate-sweep.js` — реальный вызов маршрута с hub-стабом: результат `{requested:0, cleared:0, failed:0}`, список fetch к хабу **пуст**.
**Почему коммитный тест не ловит:** кейс regenerate в `gpu-lane-release-order.test.js` — структурная (строковая) проверка наличия вызова; поведения hub-стаба не проверяет.
**Эффект:** гонка M-b (dispatch между очисткой lane и release оставлял осиротевшую lane-запись) на regenerate-пути **не сужена** — состояние как до Stage 120. Ограничена claim TTL (F2), регрессии нет, но заявление «второй проход … во всех четырёх путях» — неточность, требующая либо исправления, либо корректировки claims-матрицы.
**Направление исправления:** передать в `clearHubDispatches` реальные dispatch-id (получить из hub/list или состояния) **либо** научить `clearHubDispatches` резолвить `book_id` → dispatch ids через hub; заменить структурный тест поведенческим (hub-стаб обязан получить запрос `clearHubDispatches` **после** release; отсутствие запроса — фейл).

### 10.2. N2 (средняя) — orphan-marker release есть только на image-пути

`releaseTaskDone` имеет ровно один production-вызов — `backend/src/image/iu-processor.js:340` (grep по `backend/src` + `packages`: больше вызовов нет). Аудио- (`backend/src/audio/generation.js` и смежные) и видео-send-путь (`scene-orchestrator`) при том же сценарии (осиротевший done-маркер при отсутствующем артефакте) получают `already_completed` → деферал 900 с → та же причина → сцена циклически, оставаясь в active-index. Подтверждено пробой P-A5 (hub-лог: `already_completed` без POST). Ограничено окном деферала (раз в 15 мин, не hot-loop), поэтому medium. M-c по декларированному объёму (`processSingleIU`, запрет менять `sendUnified`) — закрыт честно; это смежная поверхность той же категории.
**Направление исправления:** применить ту же пару `releaseTaskDone` + одна повторная отправка на audio/video путях, либо явно зафиксировать отложенный объём в отчёте Stage 120/122.

## 11. Что требуется для разблокировки

1. **N1 (обязательно):** сделать regenerate-sweep функциональным (реальные dispatch-id или поддержка `book_id` в `clearHubDispatches`) + поведенческий тест вместо структурного. Альтернатива — честная корректировка claims-матрицы Stage 120 с принятием того, что regenerate-путь не покрыт (тогда M-b переводится в «CLOSED с оговоркой» по прецеденту Stage 119/B4).
2. **N2:** решение — расширить M-c на audio/video **или** явно отложить с обоснованием.
3. **Гигиена (рекомендация):** `tests/mocks/redis-mock.js` — поддержать `SET XX` и время-осведомлённый expiry, чтобы мок соответствовал FakeRedis из `gpu-queue-idempotency.test.js`.

---

## Приложение. Артефакты (`/tmp/opencode/stage121/`)

| Файл | Содержимое |
|---|---|
| `targeted.log` | целевой прогон, 75 passing |
| `arch-npmtest.log` | syntax-smoke + архитектурные, 935 passing / 24 pending |
| `full-suite.log`, `full.failures.txt` | полный suite 2665/28/85 + извлечённые заголовки падений |
| `orchestration.log` | пакет @animastor/orchestration, 35 passing |
| `audit-probe.js` | пробы P-A1…P-A8 (F1/F2/M-a…M-f поведенческие проверки) |
| `probe-regenerate-sweep.js` | доказательство N1 (no-op sweep) |
| `probe-f2-fakeredis.js`, `fakeredis.js` | F2-пробы на время-осведомлённом FakeRedis |
| `p10.json`, `p11.json`, `p12.json` (+ `.log`) | перезапуск proof-скриптов Stage 119 |
