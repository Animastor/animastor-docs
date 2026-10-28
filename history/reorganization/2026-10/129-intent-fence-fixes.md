# Stage 129 — Fix intent-fence regressions (audit 128 · B1, B2, F3–F8)

**Объект:** `/home/animastor/animastor-backend` (ветка `main`), база — `a2d088cf` (Stage 127).
**Основание:** [Stage 128 audit](128-intent-fence-dispatch-receipt-audit.md) §6 (B1 P0, B2 P1), §7 (F3–F8), контракт [126](126-result-fencing-implementation-contract.md) §1/§1.5.
**Статус: PASS.** B1 и B2 устранены, F3/F4/F5/F6/F7/F8 закрыты в объёме фазы 1; полный backend-suite зелёный; локальный коммит `c5239cf4` (не запушен).
Production Redis/PG/Hub, очередь (457/438), контейнеры, `.env`, Compose, версии и lockfiles не затрагивались.

---

## 0. Что именно исправлено (по пунктам задания)

| № | Требование | Реализация | Где |
|---|---|---|---|
| 1 | Старый fence не может перезаписать новое намерение | вердикт `stale_intent` + проверка истории/эпохи до любых записей | `queue-idempotency.cjs:737-836` (JS-решение), `:918-1035` (Lua) |
| 2 | Проверять актуальность intent и epoch до записей | все чтения — до первого `SET`; в Lua один атомарный `EVAL` | `:918-1035` |
| 3 | Не вводить вторую систему идентичности | порядок берётся из существующего монотонного stage-epoch (`INCR`) | `:202-235` |
| 4 | Однозначный терминальный вердикт | `stale_intent` — `retryable:false`, Hub POST не выполняется | `gpu-dispatcher.js:376-430` |
| 5 | Проверка и запись защищены от гонки | Lua; fallback — `WATCH/MULTI/EXEC` (CAS) с ретраями | `:1153-1265` |
| 6 | Epoch не единственная защита | bounded `history` (8 последних fence) + `supersedes` + состояние | `:790-810` |
| 7 | Fallback: нет частичного состояния | запись intent+receipt — ОДНА транзакция | `:1226-1252` |
| 8 | Lock: удаление только своим owner-token’ом | 16-hex токен, TTL 15 s, продление перед фазой чтения, compare-and-delete | `:1093-1152` |
| 9 | Не путать «нет EVAL» и ошибки Redis | capability-ошибки отделены от ACL/CROSSSLOT/READONLY/timeout | `:1058-1070`, `:1296-1330` |
| 10 | Fail closed, если атомарность не гарантирована | fallback только для объявленных double’ов; иначе `unavailable` | `:1326-1334` |
| 11 | Структурированный лог и метрика деградации | `[INTENT-FENCE]` warn + Prometheus-счётчики | `:700-735`, `prometheus.js:83-115` |
| 12 | TTL/admission (F3) | правило привязки dispatch_id + согласованные TTL + `intent_missing` | §3 ниже |
| 13 | F4–F8 | см. §4 | |

---

## 1. B1 — запрет воскрешения устаревшего fence (P0)

**Причина (подтверждена аудитом 128):** ветка «другой fence» была безусловным supersede, `epoch` писался в запись и **нигде не сравнивался**, поэтому `F1@0 → F2@1 → F1@0` возвращало `created` и dispatcher отправлял устаревшую генерацию в Hub.

**Новое правило допуска** (`_decideIntentReceipt`, зеркально в Lua):

```
receipt существует и fence ≠ наш            → receipt_conflict          (immutable)
intent отсутствует:
    receipt существует                      → intent_missing            (fail closed)
    иначе                                   → create                    (created)
intent.fence == наш:
    state ≠ active                          → intent_not_active:<state>
    иначе                                   → refresh                   (reused/created)
intent.fence ≠ наш (supersede-попытка):
    fence ∈ history ∪ {supersedes}          → stale_intent   ← F3/B1
    incoming < stored epoch (counter жив)   → stale_intent   ← B1
    state ≠ active и epoch не новее         → intent_not_active:<state>  (F8)
    иначе                                   → supersede (history += старый fence, ≤8)
```

- **Ни одна запись не выполняется до вердикта отказа** — вызывающий может безопасно откатить свои claim/ref.
- `history` — durable-доказательство supersede: работает и когда эпохи равны (изменённые входные данные при том же epoch), и когда stage-epoch ключ уже истёк.
- Ветка `if receiptFence then return 'reused'` больше не может пропустить устаревший dispatch: проверка supersede стоит **до** неё.

**Регрессионный сценарий из задания** (`F1 → F2 → повтор F1`) — `tests/gpu-intent-fence-regressions.test.js`:
`B1: F1 → supersede F2 → repeat F1 …` — третий вызов `stale_intent`, запись `intent` байт-в-байт не меняется, receipt для отклонённого dispatch отсутствует, `intent.fence === F2`. Выполняется **на обоих путях** (Lua и fallback).

**Легитимная регенерация не сломана:** `bumpStageEpoch` (`INCR`) всегда идёт в паре с `resetJobEpoch` (`backend/src/state/scene-state-ops.js:106-114`, `image/iu-processor.js:229-237`, `routes/generation-routes.cjs:651-652`), поэтому новое намерение имеет строго больший epoch и проходит supersede. Это проверено существующим тестом Stage 127 «a NEW intent (reset task epoch)…» (зелёный).

---

## 2. B2 — безопасный fallback без EVAL (P1)

**Что было:** lock с константой `'1'` и TTL 5 s на 5–6 roundtrip’ов, `finally { del(lockK) }` без проверки владельца, любые ошибки `eval` (включая ACL/CROSSSLOT) молча уводили в неатомарный read-check-write, частичная запись intent без receipt (проба E5), удаление чужого lock’а (E6).

**Что стало:**

1. **Fallback возможен только для объявленного double’а** — `redis.__allowNonLuaFallback === true`. В production-клиенте такого флага нет: отсутствие/поломка `eval` → `unavailable` → `intent_receipt_unavailable` (retryable) → **Hub POST не выполняется**.
2. **Классификация ошибок:**
   - capability (`unknown command`, `is not a function`, `not implemented`, `unsupported command`) → допустим fallback (только при флаге);
   - любой другой throw (ACL `NOPERM`, `CROSSSLOT`, `READONLY`, `LOADING`, timeout, reset) → `unavailable`, **без** fallback;
   - непустой нераспознанный ответ скрипта → `unavailable` (`unexpected_eval_reply`), второй, более слабый путь не запускается;
   - `null/undefined` от `eval` (double, который скрипт не исполнял) → fallback.
3. **Транзакционная запись:** `WATCH(intent, receipt)` → чтения → `_decideIntentReceipt` → `MULTI(SET intent, SET receipt NX, EXPIRE stage)` → `EXEC`; `null` от `EXEC` (ключ изменился) → повтор, до 5 раз, затем `busy` (retryable). Частичного состояния «intent без receipt» больше не возникает; `replies.length !== queued` (double с no-op MULTI) → `unavailable`.
4. **Lock:** случайный 16-hex owner-token, TTL 15 s, `EXPIRE` перед фазой чтения, освобождение — compare-and-delete по токену (через `WATCH/MULTI`; без транзакций — read-then-delete, но всё равно только при совпадении токена). Истёкший/чужой lock не удаляется — тест `the fallback lock has an OWNER TOKEN and is never deleted after it lapsed`.
5. **Наблюдаемость:** каждый вердикт → `animastor_intent_fence_total{outcome}`; каждая деградация/ошибка атомарного пути → `animastor_intent_fence_degraded_total{reason}` + строка `[INTENT-FENCE] …` (без секретов) + `jobs_intent_fencing_degraded`/`getStats()`.

**Корректность без Lua:** fallback строго корректен только при наличии `WATCH/MULTI` (транзакция, `transactional:true`). Double без транзакций поддерживается legacy read-check-write путём, который **явно помечается** `transactional:false, degraded:true` (используется старыми FakeRedis-тестами) и в production недостижим, так как сам fallback закрыт флагом. В отчёте это зафиксировано как ограничение, а не как «атомарность».

---

## 3. TTL и admission (F3)

**Правила, которые теперь действуют:**

1. **Receipt истёк, intent жив.** Привязка dispatch_id разрешена только к **текущей** генерации: `fence == intent.fence` (тот же epoch) → `created`/`reused`; устаревшая генерация → `stale_intent`, receipt не создаётся. То есть «old dispatch_id → новый fence» **не** допускается, если отправитель предъявляет старый fence; предъявление нового fence означает, что вызывающий сам пересчитал идентичность на актуальной генерации (нормальный re-dispatch).
2. **Intent истёк, receipt жив** (потеря данных/эвикция): `intent_missing` — fail closed, запись не создаётся; следующая отправка с **новым** dispatch_id начинает заново. Воскрешение старого intent невозможно.
3. **Согласованность TTL:** intent 14 d; receipt 48 h; claim 24 h; ambiguous 90 min; stage-epoch 30 d, причём **TTL счётчика продлевается на каждой принятой отправке** (`touchStage()` в Lua, `EXPIRE` в транзакции). Следствие: пока intent жив (≤14 d после последней отправки), счётчик поколений тоже жив (≤30 d), поэтому правило «старый epoch» не может ложно сработать из-за истечения счётчика.
4. **Потеря счётчика** (эвикция/ручное удаление) больше не выглядит как регрессия: `stageKnown=false` отключает сравнение эпох (история fence остаётся защитой), так что задача не «залипает» на 14 дней. Тест: `the generation counter is kept alive by accepted sends and its loss cannot jam the task`.
5. **Tombstone не понадобился** — отдельный долговечный tombstone не вводился; роль durable-доказательства выполняет `history` в самой записи intent (≤8 fence), а не TTL. Это осознанно минимально: PG-схема и протокол Hub не менялись.
6. **Явная admission-граница:** receipt не перезаписывается, пока жив (`receipt_conflict`); после истечения повторная привязка возможна только к текущей генерации; все окна, в которых результат ещё может прийти (hub retention 1 h, ambiguous claim 90 min, claim 24 h), строго меньше 48 h — проверяется тестом `the receipt TTL outlives every window…`.

---

## 4. F4–F8

| ID | Исправление |
|---|---|
| **F4** | `forgetTaskRef(..., {fence})` — compare-and-delete: удаляет ref только если он указывает на наш fence; `releaseTask`/`forgetTaskRef` возвращают результат. Dispatcher использует `rollbackOwnEnqueue()` (`gpu-dispatcher.js:30-53`) и на обоих терминальных путях (fence-reject и definitive 4xx) считает `jobs_fence_rollback_failed` + `warn`, а не «best effort». |
| **F5** | `FENCE_REJECTED_OUTCOMES` в общей таксономии (`dispatch-outcomes.js`): `stale_intent`, `receipt_conflict`, `intent_not_active`, `intent_corrupt`, `intent_missing` — `isDeferrableOutcome=true`, `deferralWindowFor=900 s` (`DEFERRED_IDEMPOTENT_TTL_S`), т.е. нет 5-секундного churn. `intent_receipt_unavailable` — наоборот, bounded retry (capacity bucket). Зеркально в `queue-idempotency` (`CAPACITY_REASONS`/`FENCE_REJECTED_REASONS`, `:1394-1420`) для image/audio путей. |
| **F6** | Запись без `fence` (или с невалидным fence) → `intent_corrupt`, никакого fail-open; тест на уровне dispatcher’а (POST=0). |
| **F7** | Счётчики выведены в существующий реестр Prometheus (`prometheus.js:83-115`) и в `getStats()` диспетчера; события деградации — отдельный counter по `reason`. |
| **F8** | `cancelled`/`superseded` блокируют только ту же/старую генерацию; строго больший epoch — проверяемый admission-переход обратно в `active` (тест `F8: a cancelled record blocks the same generation but a NEWER epoch revives it`). |

---

## 5. Тесты и результаты

Все прогоны — изолированно (`/home/animastor/animastor-backend/backend`), только fake Redis / локальные двойники, без сети, без production Redis/PG/Hub.

```
npx mocha --exit tests/gpu-intent-fence-regressions.test.js      → 33 passing
npx mocha --exit tests/gpu-intent-fence-receipt.test.js \
   tests/gpu-intent-fence-regressions.test.js \
   tests/gpu-queue-idempotency.test.js tests/happy-path.test.js \
   tests/gpu-hub-contract.test.js tests/layer-config-port.test.js \
   tests/scope-slide.test.js tests/startup-recovery-registry-gate.test.js
                                                                 → 216 passing (exit 0)
npx mocha --exit 'tests/architecture/**/*.test.js'               → 935 passing / 24 pending (exit 0)
npx mocha --exit 'tests/**/*.test.js'                            → 3425 passing / 28 pending / 0 failing (exit 0)
bash scripts/syntax-smoke.sh backend                              → All files OK
```

Новый сьют (`backend/tests/gpu-intent-fence-regressions.test.js`, 33 теста) покрывает обязательный список §5:

1. `F1 → F2 → повтор F1` — отклонён (оба пути).
2. Два конкурентных вызова с разными fence — новый epoch выигрывает, старый отклоняется.
3. Ошибка записи receipt — очередь транзакции отклонена (`EXECABORT`), состояния нет; ретрай сходится.
4. Lock истёк в критической секции, lock перехвачен другим владельцем — чужой lock не удаляется.
5. ACL / CROSSSLOT / timeout / READONLY / нераспознанный ответ — `unavailable`, fallback не включается, записей нет; клиент без `eval` без флага — тоже `unavailable`.
6. Receipt истёк при живом intent — привязка только к текущей генерации.
7. Intent истёк при живом receipt — `intent_missing`.
8. Повтор старого dispatch_id после TTL — `stale_intent`, receipt не создан.
9. Rollback чужого ref/claim — `not_owner`, ref не тронут; ошибка rollback — не success.
10. Нет fence → `intent_corrupt`, POST отсутствует.
11. `stale_intent` и прочие терминальные причины — 900-секундное окно, а не 5 s.
12. После supersede старый fence не становится current ни при повторе, ни после «рестарта» (свежий инстанс диспетчера на том же Redis).

Плюс диспетчерский e2e: устаревший отправитель → `sent:false, reason:'stale_intent', retryable:false`, Hub не вызван, intent не изменён, собственные claim/ref откачены.

**Изменения в существующих тестах** (не ослабление проверок):
- `gpu-intent-fence-receipt.test.js`: `deep.equal` → `deep.include` + явная проверка `degraded:true` для fallback-вердикта (добавленное поле проверяется, а не отбрасывается).
- Пять FakeRedis-двойников объявляют себя double’ом (`__allowNonLuaFallback = true`) — это и есть новое требование fail-closed гейта; ни одно утверждение не изменено.

---

## 6. Подтверждённые ограничения (не маскируются как PASS)

1. **Lua-скрипт ни разу не исполнялся**: в окружении нет redis-server и Lua-рантайма (`redis-server`, `lua`, `luajit` отсутствуют). Атомарный путь проверяется через **независимое зеркало** в `tests/mocks/redis-mock.js` (обновлено вместе со скриптом) и матрицу вердиктов; синтаксическая валидация скрипта выполнена только чтением. **Перед включением в production обязателен прогон против реального Redis** (ACL-разрешённый `EVAL`) — это первый пункт следующего этапа.
2. **Нет тестового Redis** → конкуренция `WATCH/MULTI` на общем соединении ioredis не проверена вживую. Транзакционный fallback рассчитан на double’ы и на клиентов с корректным `WATCH`; в production он недостижим (флаг).
3. **Fallback без транзакций** (`transactional:false`) остаётся read-check-write: он помечен degraded и используется только старыми FakeRedis-тестами; в production недостижим.
4. **Redis-транзакция не откатывает уже выполненные команды** при runtime-ошибке внутри `EXEC` (семантика Redis). Практически это только OOM/WRONGTYPE; OOM отклоняет команды на этапе постановки в очередь, и транзакция не применяется (`EXECABORT`) — проверено тестом.
5. **Правило «равный epoch, другой fence» намеренно разрешает supersede** (изменённые входные данные без bump’а эпохи — легитимный путь); защита от «пинг-понга» — `history`: fence, который уже был вытеснен, не вернётся.
6. **Эвикция stage-счётчика** отключает сравнение эпох (fail-open в сторону допуска нового fence); защита — история. Полная устойчивость потребует durable-счётчика (PG/журнал) — это уже фаза 2.
7. **TTL не является защитой от устаревшего результата** (как и в Stage 128): consumer’а receipt’а в фазе 1 нет. Admission результатов (включая `legacy_no_receipt` при отсутствующем receipt) — предмет фазы 2.

---

## 7. Отличия от контрактов 126/127

| # | Контракт | Факт после Stage 129 |
|---|---|---|
| D1 | 126 §1.5: «другой fence → отказ `intent_superseded`» | отказ `stale_intent` только для устаревшей генерации (история/epoch); новая генерация supersede’ит — иначе невозможна легитимная регенерация без отдельного cancel-писателя |
| D2 | 127: «fallback — для double’ов без eval» | теперь **только** для объявленных double’ов; production fail-closed (реализует намерение 127-отчёта) |
| D3 | 127: `{fence,state,epoch,supersedes,updated_at}` | добавлено `history: [[fence, epoch]…]` (≤8) — обратно совместимо, старые записи читаются |
| D4 | 126 §1.2: intent TTL «освежается при claim refresh» | освежается при каждой принятой отправке; дополнительно продлевается stage-epoch TTL (нужно для порядка версий) |
| D5 | 126: 4 новых семейства | +3 (journal/outbox — фаза 2); families не менялись |
| D6 | 126 §1.2: receipt immutable | immutable, пока жив; после истечения — только привязка к текущей генерации (admission-правило §3) |

---

## 8. Безопасный следующий этап

1. **Верификация Lua на реальном Redis** (изолированный контейнер): `EVAL` для всех вердиктов, гонки двух клиентов, `WATCH/MULTI`-путь, ACL-отказ. Без этого скрипт считается «непроверенным вживую».
2. Наблюдаемое окно dual-write: `animastor_intent_fence_total{outcome}` и `animastor_intent_fence_degraded_total` — `degraded` должен быть строго 0, `stale_intent` — объясним.
3. Только затем фаза 2: admission результата (receipt → fence), `legacy_no_receipt` при отсутствии receipt, отказ от приёма результатов при истёкшем/отсутствующем receipt, а также решение по durable-счётчику поколений (п. 6 ограничений).

---

## 9. Границы соблюдены

- Изменён только код fencing-контура и его тесты; result route, canonical artifact paths, completion semantics, PG schema, Hub envelope, `deploy/`, `.env`, Compose, версии и lockfiles — не тронуты.
- Чужие dirty-файлы (`generation-routes.cjs`, 5 тестов Stage 122/124, `audit-orphan-books.js`, `deploy/`, `freebuff-chat-*.md`) не изменены и **не вошли** в коммит: из `dispatch-engine.js` в индекс добавлены только мои 3 хунка, чужой хунк (`enforcedScope`) остался в рабочем дереве.
- Нет push/CI/GHCR/deploy/npm-публикации; нет подключений к production Redis/PG/Hub; очередь 457/438 не читалась и не менялась; контейнеры не перезапускались.
- Проверки не ослаблялись: существующие утверждения либо сохранены, либо усилены (`degraded:true`).

**Коммит:** `c5239cf4 fix(gpu-queue): versioned fence admission + fail-closed atomic receipt (stage 129 / audit 128 B1, B2)` — локальный, 13 файлов, +1501/−182, не запушен.
