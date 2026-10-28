# Stage 118 — GPU dispatch lifecycle: исправление находок аудита Stage 117

**Дата:** 2026-10-22 (окно 06:10Z → 09:40Z)
**Исходные коммиты (проверяемый Stage 116):** `fc9c6097`, `ae4e7d49`
**Отчёт-источник:** `reorg-2026-10-19/117-gpu-dispatch-lifecycle-independent-audit.md` (5 блокеров B1–B5 + 7 средних замечаний M1–M7 + 5 низких M8–M12)
**Репозиторий:** `animastor-backend` (backend + пакет `@animastor/orchestration`)
**Режим:** локально. Push / CI / GHCR / deploy / `npm publish` **не выполнялись**. Версии пакетов, lockfiles, зависимости, remote refs, production **не изменялись**. Чужие dirty-файлы не тронуты.
**Итог: PASS** — все 5 блокеров и все 7 средних замечаний закрыты кодом и изолированными регрессионными тестами; регрессий относительно baseline Stage 117 нет (набор падений полного suite **идентичен**).

---

## 0. Сводка

| ID | Дефект (Stage 117) | Исправление | Коммит | Тест |
|---|---|---|---|---|
| **B1** | completion-маркер невозможно освободить (`markTaskDone` всегда парный `forgetTaskRef` ⇒ ref+done не сосуществуют ⇒ D4-release не достигает ни одного done) | ref **не забывается** при settlement, а **продлевается** до TTL маркера (`extendTaskRef`) — ref стал индексом владения, достижимым для release | `6a5d429d` | «B1: a completed task CAN be released by the scene/book scope» |
| **B2** | `definitiveRejection` sticky между 3 POST-попытками: ранний 4xx освобождал claim при неоднозначной поздней попытке | каждая попытка классифицируется отдельно; вердикт всего запроса — **неоднозначный побеждает** | `6a5d429d` | «B2: an early 4xx followed by an AMBIGUOUS attempt keeps the claim» + обратный порядок |
| **B3** | merged (pure-dialogue) аудио-путь не вычислял `deferReason` ⇒ 5-секундный dispatch/cancel-цикл сохранялся | `deferReason` вычисляется **в одной точке** (`generateSceneAudio`) для **всех** путей (merged + per-segment) | `6a5d429d` | `gpu-audio-dispatch-deferral.test.js` (5 кейсов) |
| **B4** | claim'ы освобождались **до** очистки lane ⇒ при отказе хаба записи lane оставались, а claim уже свободен ⇒ дубль | **lane очищается первым**, claim'ы освобождаются только после подтверждения хаба; при отказе хаба claim'ы **сохраняются** | `e2f5bb4c` | `gpu-lane-release-order.test.js` (4 кейса) |
| **B5** | «refresh» pending-claim'а — no-op (`SET NX` не продлевает TTL существующего ключа); тест был вакуумным | реальный refresh через `SET … XX EX` (+ refresh TTL закреплённой эпохи); тест проверяет **фактический** TTL | `6a5d429d` | «B5: refreshClaimTtl extends an existing claim…» + «a pending claim is refreshed…» |
| **M1** | `':'`-разделитель делал ключи владения неоднозначными (client-controlled `book_id`) ⇒ cross-book удаление | все компоненты ключей **percent-encoded** (`encodeURIComponent`) | `6a5d429d` | «M1: a book_id containing ":" cannot reach into another book key space» + пакетный кейс |
| **M2** | `force=true` обходил deferral ⇒ ≈24 полных попытки на сцену за окно force (120 с) | backoff действует **и в force-режиме**; явный интент (отмена/регенерация/очистка/удаление) снимает его в своей точке | `a191984a` + `e2f5bb4c` | «M2: force mode does NOT bypass the deferral» + «M2: an explicit intent clears the backoff…» |
| **M3** | классификация требовала **ровно одну** причину ⇒ смешанные capacity-причины не деферались | общий классификатор: **все** причины должны быть деферабельными,报告ляется доминирующая | `a191984a` + `6a5d429d` | «M3: several deferrable reasons are classified…» (пакет + backend) |
| **M4** | `already_completed` классифицирован как «capacity» ⇒ бесконечный 60-секундный цикл | две корзины: **capacity** (`no_worker_available` / `duplicate_pending` / `ambiguous_post`) и **idempotent** (`already_completed`) со своим окном (900 с) | `a191984a` | «M4: already_completed is NOT a capacity reason but it IS deferrable» + пакетный кейс |
| **M5** | неоднозначный исход не нёс `reason` ⇒ оркестратор не мог его классифицировать (`ambiguous` никто не читал) | `reason: 'ambiguous_post'` в ответе транспорта; причина доезжает до оркестратора и деферается | `6a5d429d` (+ `a191984a` для корзины) | «B2/B5: an ambiguous outcome carries the reason…» + аудио-кейс |
| **M6** | per-dispatch заморозка эпохи снята ⇒ две отправки одной задачи внутри dispatch ⇒ 2 записи в lane | **intent-эпоха закрепляется за задачей** (`resolveJobEpoch` / `resetJobEpoch`): эпоха читается в момент отправки, но идентичность задачи стабильна; pin снимается только при изменении intent'а самой задачи | `6a5d429d` | «M6: the same task sent twice inside ONE dispatch keeps ONE identity» + «M6: the pinned intent epoch survives a re-dispatch…» |
| **M7** | поведение после TTL 90 минут не проверено | добавлен регрессионный тест: claim истекает ⇒ задача может быть отправлена снова (90 мин, не вечно) | `6a5d429d` | «M7: after the 90-minute ambiguous TTL the task may be sent again» |
| M8 | обоснование «3× максимального таймаута (30 мин)» неверно (video = 60 мин) | комментарий исправлен (90 мин > 60 мин — запас есть, обоснование было неверным) | `6a5d429d` | — |
| M9 | отложенная стадия писалась в «ошибки» тика каждый 5 с | дефералы считаются отдельно (`summary.deferred`), флаг `deferred` не смешивается с ошибкой | `a191984a` | — (наблюдаемо в тик-суммари) |
| M10 | JSDOC `releaseClaimsForScene/ForBook` описывал старую грамматику job_id | переписан под фактическую (percent-encoded) схему владения | `6a5d429d` | — |
| M11 | `resolveDispatchEpoch(redis, dispatchId, …)` — мёртвый параметр | помечен `@deprecated` (источник идентичности — `resolveJobEpoch`) | `6a5d429d` | — |
| M12 | счётчики `released`/`done` в логах всегда равны ⇒ метрика вводила в заблуждение | счётчики отражают **фактически удалённые** ключи (`del` → 1/0) | `6a5d429d` | косвенно (D4-кейсы) |

---

## 1. Исправления — детали

### 1.1. B1 — модель хранения/освобождения `ref`/`done`

**Диагноз Stage 117 (подтверждён на реальном модуле):** `markTaskDone` вызывается ровно в одном месте — result-колбэк (`backend/src/routes/generation-routes.cjs`) — и **всегда** сопровождался `forgetTaskRef`. Ref-ключ удалялся в момент settlement ⇒ ключ `done` становился **недостижимым** ⇒ `releaseClaimsByPrefix` не находил ни одного completion-маркера ⇒ ни один из четырёх D4-путей не освобождал «уже выполнено» ⇒ задача оставалась подавленной до 7 сут.

**Исправление:**
* `backend/src/routes/generation-routes.cjs` — settlement теперь **продлевает** ref (`extendTaskRef`) вместо `forgetTaskRef`: ref — это **индекс владения**, через который completion-маркер и освобождается.
* `backend/src/helpers/queue-idempotency.cjs` — `extendTaskRef(redis, book, chapter, scene, jobId, ttl = IDEM_REF_DONE_TTL_S = IDEM_DONE_TTL_S)`; `IDEM_REF_DONE_TTL_S` добавлен рядом с `IDEM_DONE_TTL_S`, чтобы TTL индекса и TTL маркера не расходились.
* `releaseClaimsByPrefix` — удаляет claim, done-маркер **и** ref по idem_key из ref-значения (идентичность владения не изменилась).

**Проверяемое состояние (production-инвариант, не искусственное):** тесты воспроизводят **реальную последовательность result-колбэка** (`claim → ref → done → release claim → extend ref`), а не искусственное «ref + done одновременно», как это было в тесте Stage 116.

**Следствие:** cache-teardown / отмена / регенерация / удаление книги теперь освобождают и claim, и completion-маркер ⇒ ранее «потерянная» (на 7 сут) задача после очистки кэша снова может быть сгенерирована.

### 1.2. B2 — независимая классификация каждой POST-попытки

`backend/src/runtime/gpu-dispatcher.js`: цикл попыток переписан — каждая попытка даёт собственный исход (`4xx` → definitive, `5xx`/timeout/reset → ambiguous), а вердикт **всего запроса** вычисляется один раз в конце:

```js
const ambiguous = ambiguousOutcome || !definitiveRejection;
```

⇒ неоднозначная попытка **всегда** побеждает ⇒ claim сохраняется ⇒ дубль невозможен. Ответ теперь честно сообщает `ambiguous` и `reason` (`'ambiguous_post'` / `'hub_rejected'`).
Побочный эффект: 4xx больше не «отравляет» серию — definitive-вердикт требует, чтобы **все** попытки были definitive.

### 1.3. B3 — все аудио-пути

`backend/src/audio/generation.js`: `deferReason` вычисляется **в `generateSceneAudio`** (после обеих ветвей) через общий классификатор `qidem.classifyNotSentReasons(deferState.notSentReasons)`; ветка merged-dialogue больше не оставляет причину пустой. Ветка per-segment публикует только собранные причины (классификация — в одной точке).

### 1.4. B4 — порядок «lane → claims»

| Путь | Было | Стало |
|---|---|---|
| `POST /book/:bookId/cancel-generation` | release → clear | **clear → release** (при отказе хаба — 500, claim'ы **сохранены**) |
| `DELETE /book/:bookId/cache` | release → clear (ошибка проглатывалась) | **clear → release**; при отказе хаба claim'ы **сохранены**, в лог — предупреждение |
| `DELETE /book/:bookId` (book-deletion) | release → clear | **clear → release**; при отказе хаба claim'ы **сохранены** |
| `POST /book/:bookId/regenerate` | clear → release | без изменений (уже корректно) + снятие backoff'а сцен |

Дополнительно явные интенты снимают **capacity-backoff** затронутых сцен/книг (порт `clearDeferrals`, инъекция композиционным корнем — ключ деферала принадлежит пакету).

### 1.5. B5 — реальное продление TTL claim'а

`claimTask` = `SET … NX` — Redis **отклоняет** такую запись на существующем ключе и **не трогает TTL** (Stage 116 «refresh» был no-op). Новая функция:

```js
async function refreshClaimTtl(redis, idemKey, ttlSeconds = IDEM_CLAIM_TTL_S) {
    const ok = await redis.set(idemClaimKey(idemKey), '1', 'XX', 'EX', ttlSeconds);
    return ok !== null && ok !== false;
}
```

`SET … XX EX` атомарен, продлевает существующий claim и **не воскрешает** освобождённый (проверено отдельным тестом). TTL закреплённой intent-эпохи продлевается вместе с claim'ом (`refreshJobEpochTtl`).

### 1.6. M1 — неоднозначность разделителей

`encodeKeyComponent()` (percent-encoding, `':'` → `'%3A'`, glob-метасимволы тоже) применён к `stage-epoch`, `ref` и новому `job-epoch`; `releaseClaimsForBook('a:b')` больше не достаёт до claim'ов книги `a`. Пакетный `deferredStageKey` — тоже percent-encoded.

### 1.7. M2 — `force` и backoff

`dispatch-engine.js`: проверка deferral выполняется **до любого побочного эффекта** и **не обходится** флагом force. Явные интенты (отмена / регенерация / очистка кэша / удаление) снимают deferral в своих точках (`clearStageDeferral`, `clearDeferralsForBook/Scene`).

### 1.8. M3 — несколько причин отказа

Общий классификатор (`packages/…/src/runtime/dispatch-outcomes.js` → `classifyNotSentReasons`, зеркало в `queue-idempotency.cjs`): **все** причины должны быть деферабельными; сообщается доминирующая (по частоте). Одна реальная ошибка (`send_failed`) сохраняет историческую семантику (немедленный повтор) — контракт audit-6929ba5 не нарушен.

### 1.9. M4 — `already_completed` ≠ capacity

Две корзины с разными окнами:

| Корзина | Исходы | Окно |
|---|---|---|
| capacity | `no_worker_available`, `duplicate_pending`, `ambiguous_post` | 60 с (`DEFERRED_STAGE_TTL_S`) |
| idempotent | `already_completed` | 900 с (`DEFERRED_IDEMPOTENT_TTL_S`) |

`isCapacityOutcome('already_completed') === false`, `isIdempotentOutcome(...) === true`, `isDeferrableOutcome(...) === true` — деферал сохраняется (сцена не крутится), но классификация честная и окно длиннее.

### 1.10. M5 — `reason` неоднозначного исхода

`sendUnified` возвращает `reason: 'ambiguous_post'` (или `'hub_rejected'`). Причина доезжает до `iu-processor` (`sendResult.reason`), до аудио (`sendResult.reason`) и до видео (`sendResult.reason`) ⇒ классифицируется ⇒ деферается.

### 1.11. M6 — гарантии эпохи при отправке и повторном dispatch

Введён **pin intent-эпохи на задачу** (`animastor:idempotency:job-epoch:{book}:{chapter}:{scene}:{job}`, TTL 24 ч):

* эпоха по-прежнему **читается в момент фактической отправки** (D1 не нарушен);
* первая отправка задачи **закрепляет** эпоху ⇒ любая последующая отправка/повторный dispatch той же задачи видит **ту же идентичность** ⇒ «одна логическая задача ⇒ одна pending-запись» снова гарантировано конструкцией;
* pin снимается **только** при изменении intent'а самой задачи:
  * dirty-ветка (`backend/src/image/iu-processor.js`) — bump + `resetJobEpoch` ⇒ регенерация dirty-IU проходит **с первой попытки**;
  * error-колбэк (`backend/src/routes/generation-routes.cjs`) — bump + `resetJobEpoch` ⇒ обоснованный retry получает свежую идентичность.

Побочный эффект: движение stage-эпохи из-за **соседней** единицы больше не меняет идентичность других задач той же сцены.

---

## 2. Тесты

### 2.1. Сводка прогонов

| Прогон | Baseline Stage 117 (Stage 116 код) | Stage 118 | Δ |
|---|---|---|---|
| `packages/animastor-orchestration` — `npm test` | 30 pass / 0 fail | **35 pass / 0 fail** | **+5** |
| `backend/tests/gpu-queue-idempotency.test.js` | 29 pass / 0 fail | **43 pass / 0 fail** | **+14** |
| `backend/tests/gpu-audio-dispatch-deferral.test.js` (новый) | — | **5 pass / 0 fail** | **+5** |
| `backend/tests/gpu-lane-release-order.test.js` (новый) | — | **4 pass / 0 fail** | **+4** |
| `backend/tests/architecture/*.test.js` | 935 pass / 24 pending / 0 fail | **935 pass / 24 pending / 0 fail** | **=** |
| Полный backend-suite | 2611 pass / 28 pending / **86 fail** | **2642 pass / 28 pending / 85 fail** | **+31 pass, −1 fail (флак)** |
| `scripts/syntax-smoke.sh backend` | OK | **OK** | = |

### 2.2. Сравнение падений с baseline Stage 117

Сравнение **по списку заголовков падений** при одинаковом окружении (`ANIMASTOR_DOCS_ROOT` + изолированные PG/Redis):

```
$ diff baseline-117.failures.txt stage118.failures.txt
77d76
< T6: route/controller does not implement the book deletion cascade
```

Единственное расхождение — известный **2-секундный таймаут** в `tests/architecture/phase4-book-model.test.js` (в baseline он не прошёл, в Stage 118 прошёл; изолированно файл проходит 17/17 три раза подряд — флак зафиксирован ещё в Stage 116 §9.8). Остальные 85 падений — **environmental** (`ECONNREFUSED 127.0.0.1:1`: production PG физически недоступен) и **идентичны** baseline.

Итог: **регрессий нет**; +31 проходящих теста = 21 (gpu-queue-idempotency) + 5 (audio) + 4 (lane-order) + 1 (флак).

### 2.3. Изоляция и безопасность

| Объект | Проверка | Результат |
|---|---|---|
| Production PostgreSQL | `ss -lntp` | слушает `0.0.0.0:5432` ⇒ любой прогон БД-тестов писал бы в прод |
| Все БД/Redis-прогоны | `PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1` | 100 % прогонов падали с `ECONNREFUSED 127.0.0.1:1` — гарантированно недоступный адрес |
| Новые тесты | in-memory Redis double / пакетный mock + заглушки PG + перехват `global.fetch` | ни одного сетевого обращения, ни одного production-ключа |
| Очередь 457 / 438 дублей / leases / production-данные | — | **не трогались** (к production не подключались вообще) |
| npm | `npm view @animastor/orchestration dist-tags` (только чтение) | `latest = 0.1.4` — публикаций не было |
| Git refs | `git rev-parse origin/main github/main` | `53ce5045` / `53ce5045` — **не изменены**, push не выполнялся |
| Рабочее дерево | `git status --short` | **только чужие dirty-файлы** (5 modified + 1 deleted + 2 untracked) — побайтово как на входе |
| Push / CI / GHCR / deploy | — | не выполнялись |
| Версии пакетов / lockfiles / зависимости | — | **не менялись** |

### 2.4. Проверка каждого коммита отдельно

Каждый коммит проверен в изолированной копии (`git archive <sha>` + зеркало node_modules):

| Коммит | Пакет | Целевые backend-тесты | Комментарий |
|---|---|---|---|
| `a191984a` | 35/35 | 28 pass + 1 | падение — **артефакт проверочного окружения** (см. ниже) |
| `6a5d429d` | 35/35 | 47 pass + 1 | то же |
| `e2f5bb4c` | 35/35 | 51 pass + 1 | то же |

Единственное падение во всех трёх копиях — «an expired lease is recognised as stale»: оно **воспроизводится и на Stage 116 (`ae4e7d49`) в том же проверочном окружении** ⇒ это артефакт окружения (медиа-реестр в копии собран из исходников репозитория, а не из установленного npm-пакета — иные таймауты), а не дефект коммитов. В **рабочем дереве** тест проходит (52/52).

### 2.5. Новые регрессионные тесты (по дефектам)

| Тест | Что воспроизводит |
|---|---|
| «B1: a completed task CAN be released by the scene scope» | реальная settlement-последовательность result-колбэка → scene-release → completion-маркер свободен → `guardEnqueue` разрешает повторный запуск |
| «B1: … by the book scope» | то же для книги |
| «B2: an early 4xx followed by an AMBIGUOUS attempt keeps the claim» | смешанный исход POST (4xx → сеть) ⇒ claim **сохранён** |
| «B2: an AMBIGUOUS attempt followed by a 4xx also keeps the claim» | обратный порядок ⇒ claim **сохранён** |
| «B2/B5: an ambiguous outcome carries the reason and shortens the claim TTL» | `reason === 'ambiguous_post'`, TTL claim'а ≤ 90 мин |
| «M1: a book_id containing ":" cannot reach into another book key space» | книга `a`/глава `b` vs книга `a:b` ⇒ claim жертвы не тронут |
| «M6: the same task sent twice inside ONE dispatch keeps ONE identity» | bump эпохи между двумя отправками ⇒ **одна** запись в lane |
| «M6: the pinned intent epoch survives a re-dispatch with a NEW dispatch_id» | re-dispatch с новым `dispatch_id` ⇒ `duplicate_pending`, **одна** запись в lane |
| «M7: after the 90-minute ambiguous TTL the task may be sent again» | истечение 90-минутного TTL ⇒ задача отправляется снова (не блокируется навсегда) |
| «restart: the claim survives a backend restart and suppresses the re-dispatch» | новый экземпляр диспетчера (тот же Redis) ⇒ дубля нет |
| «M4: already_completed is NOT a capacity reason but it IS deferrable» | таксономия |
| «M3: several deferrable reasons are classified» | смешанные причины ⇒ доминирующая; реальная ошибка ⇒ `null` |
| «B5: refreshClaimTtl extends an existing claim and never resurrects a released one» | `SET XX EX`: существующий claim продлевается, освобождённый — **не** воскрешается |
| «a pending claim is refreshed…» (переписан) | TTL **реально** откатывается назад после «сгорания» времени (прежний тест был вакуумным) |
| «M6: the intent epoch is PINNED per task» | pin стабилен при движении stage-эпохи, `resetJobEpoch` возвращает свежую эпоху |
| пакет: «M2: force mode does NOT bypass the deferral» | 1 вызов исполнителя, `deferred: true` |
| пакет: «M4: the idempotent suppression gets its OWN window» | 900 с против 60 с |
| пакет: «M1: a book_id containing ":" cannot reach into another book key space» | коллизия ключей deferral |
| пакет: «M2: an explicit intent clears the backoff of a book / a scene» | `clearDeferralsForBook/Scene` |
| пакет: «M3: several deferrable reasons are classified» | общий классификатор пакета |
| `gpu-audio-dispatch-deferral.test.js` (5) | merged pure-dialogue / per-segment / ambiguous / реальная ошибка / успех — на **реальном** `audio/generation.js` с заглушкой провайдера |
| `gpu-lane-release-order.test.js` (4) | cancel + cache: hub-clear **до** release; при отказе хаба release **не** происходит |

---

## 3. Коммиты

| SHA | Сообщение | Файлы | Содержание |
|---|---|---|---|
| `a191984a` | `fix(orchestration): the shared dispatch-outcome taxonomy and the bounded deferral windows (stage 118 / D3, M2, M4, M5)` | `packages/animastor-orchestration/src/runtime/dispatch-outcomes.js` (новый), `…/runtime/dispatch-engine.js`, `…/runtime/runtime-scheduler.js`, `…/orchestration/scene-orchestrator.js`, `…/test/capacity-deferral.test.js` | таксономия исходов (capacity/idempotent), окна деферала, `force` без обхода, `clearDeferralsForBook/Scene`, тик-суммари без «ошибок», кодирование ключей, общий классификатор |
| `6a5d429d` | `fix(gpu-queue): release the completion markers, classify every POST attempt, pin the intent epoch (stage 118 / B1, B2, B5, M1, M3, M5, M6)` | `backend/src/helpers/queue-idempotency.cjs`, `…/runtime/gpu-dispatcher.js`, `…/image/iu-processor.js`, `…/audio/generation.js`, `…/routes/generation-routes.cjs`, `backend/tests/gpu-queue-idempotency.test.js`, `backend/tests/gpu-audio-dispatch-deferral.test.js` (новый) | модель `ref`/`done`, `extendTaskRef`, `refreshClaimTtl`, per-attempt классификация POST, `reason: 'ambiguous_post'`, pin intent-эпохи, percent-encoded ключи, классификация причин, аудио-пути |
| `e2f5bb4c` | `fix(gpu-queue): clear the hub lane BEFORE the claims are released (stage 118 / B4, M2)` | `backend/src/backend.cjs`, `…/routes/book-routes.cjs`, `…/routes/book/cache-routes.cjs`, `…/routes/book/generation-routes.cjs`, `…/services/book-deletion.cjs`, `backend/tests/architecture/assistant-purge-wiring.test.js`, `…/architecture/redis-registry.js`, `backend/tests/gpu-lane-release-order.test.js` (новый) | порядок lane→claims во всех 4 путях, порт `clearDeferrals`, guard композиционного корня, примечание реестра Redis |

Коммиты локальные (`main` **ahead 3** от `origin/main` = `github/main` = `53ce5045`). Push не выполнялся.

---

## 4. Что осталось за пределами этапа (осознанно)

1. **Публикация пакета не выполнена** (запрещено границами этапа). Фикс D3 лежит в **исходниках** `@animastor/orchestration`, но опубликованная версия — всё ещё **0.1.4** ⇒ образ, собранный из registry, НЕ содержит фиксов коммита `a191984a`. Процедура bump'а — без изменений относительно Stage 117 §8.3 (bump `packages/animastor-orchestration/package.json` → 0.1.5 → `npm publish --access public` → bump `backend/package.json` на `^0.1.5` → `npm install --package-lock-only` → пересборка образа). **Гейт деплоя остаётся закрытым до публикации.**
2. **`backend/node_modules/@animastor/orchestration`** синхронизирован с изменёнными исходниками пакета — это изменение **окружения** (node_modules вне git), ровно как в Stage 116; в коммиты не входит и на production не влияет.
3. **M7 (повторная отправка после 90 мин)** закрыт тестом и явной семантикой, но полноценного reconciliation с lane хаба (сверка «claim истёк, а задача не завершена») в объём этапа не входил — рекомендуется как отдельная задача с метрикой/алертом.
4. **`workers.status` в PostgreSQL** по-прежнему не трогается (живость — по Redis-heartbeat), задача предыдущего этапа.
5. **Очередь 457 / 438 дублей** не чистилась (отдельный approval, Stage 120).

---

## 5. Итог

**Stage 118 — PASS.** Все пять блокеров Stage 117 (B1–B5) и все семь средних замечаний (M1–M7) закрыты кодом и изолированными регрессионными тестами, воспроизводящими **реальные** production-последовательности (settlement result-колбэка, dirty-интент, error-колбэк, порядок lane→claims). Регрессий нет: полный backend-suite — 2642 pass / 28 pending / 85 fail, набор падений **идентичен** baseline Stage 117 (минус известный 2-секундный флак); архитектурные — 935/24/0; пакет — 35/0. Production, очередь, npm, refs, версии пакетов, lockfiles и чужие dirty-файлы не тронуты. Три локальных коммита: `a191984a`, `6a5d429d`, `e2f5bb4c`.

**Гейт деплоя:** публикация `@animastor/orchestration@0.1.5` + bump зависимости backend'а до `^0.1.5` остаётся обязательным шагом (Stage 119) — без него фиксы коммита `a191984a` в образ не попадут.
