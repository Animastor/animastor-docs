# Stage 128 — Independent audit: intent fence & dispatch receipt

**Объект:** commit `a2d088cf945cebd7562abf8193d691d9dfa7f930` (parent `57c3d58f`) в `/home/animastor/animastor-backend`.
**Основание:** [Stage 126 contract](126-result-fencing-implementation-contract.md) §1, §1.5, §4, §7; отчёт [Stage 127](127-intent-fence-dispatch-receipt.md).
**Статус: BLOCKED.** Два блокера (B1 — регрессия authority-записи; B2 — неатомарный fallback с тихой деградацией в production). Остальные проверки — PASS либо зафиксированы как ограничения фазы 1.
Аудит read-only: production-код не менялся, коммиты не делались, Redis/PG/Hub не затрагивались.

---

## 0. Объект аудита (зафиксировано, не по отчёту)

```
$ git -C /home/animastor/animastor-backend log --oneline -1
a2d088cf feat(gpu-queue): durable intent fence + immutable dispatch receipt (stage 127 / fencing phase 1)

$ git show --name-status --format='' a2d088cf
M backend/src/helpers/queue-idempotency.cjs        (+298)
M backend/src/runtime/gpu-dispatcher.js            (+70)
M backend/tests/architecture/redis-registry.js     (+35)
A backend/tests/gpu-intent-fence-receipt.test.js   (+476)
M backend/tests/mocks/redis-mock.js                (+53)
```

- `932 insertions(+), 0 deletions(-)` — аддитивный патч, переписывания нет.
- В коммите **нет** `generation-routes.cjs` (result route), `deploy/`, `package.json`, lockfile'ов, PG-миграций, canonical-путей, `.env`, Compose — граница фазы 1 соблюдена.
- Рабочее дерево на момент аудита содержит 8 чужих dirty-файлов (`audit-orphan-books.js`, `book/generation-routes.cjs`, 5 тестов, `dispatch-engine.js`) + untracked `deploy/`, `freebuff-chat-…md`. Они **не входят** в `a2d088cf`; их диффы — Stage 124/122 fail-closed sweep, к fencing отношения не имеют, но full-suite ниже исполняет рабочее дерево, а не чистый коммит (оговорка в §5).
- Аудит не менял и не откатывал эти файлы.

---

## 1. Метод

1. Чтение фактического кода коммита (не отчёта): `queue-idempotency.cjs:583-836`, `gpu-dispatcher.js:262-366`, `redis-registry.js`, `redis-mock.js`.
2. Пошаговый разбор Lua (`ENSURE_INTENT_RECEIPT_SCRIPT`, `queue-idempotency.cjs:674-716`) и fallback (`:732-791`), `ensureIntentAndReceipt` (`:794-817`).
3. Трассировка реального call-path: `dispatchStage` (`dispatch-engine.js:887`) → `sendUnified` (`gpu-dispatcher.js:162`) → `resolveJobEpoch`/`computeIdemKey` (`:258-269`) → `guardEnqueue` → `rememberTaskRef` → **ensure** (`:319`) → POST.
4. Независимые пробы: `/home/animastor/reorg-2026-10-23/audit-128/experiments.cjs` (10 сценариев) на **реальном** `queue-idempotency` + `tests/mocks/redis-mock.js`. Ни одного production-подключения.
5. Регресс: существующий сьют Stage 127, целевые сьюты, arch-сьют, полный backend-suite.

---

## 2. Проверенные инварианты

| # | Инвариант | Итог | Доказательство |
|---|---|---|---|
| 2.1 | intent + receipt создаются атомарно в Lua; частичного состояния нет | **PASS (Lua)** / **FAIL (fallback, см. B2)** | Один `EVAL` c 2 ключами, все GET до первого SET (`:685-716`); проба E5 показывает частичную запись только в fallback |
| 2.2 | проверки intent/state/fence — в той же атомарной операции, что и запись receipt | **PASS по state/fence**, **FAIL по порядку версий** | `:685-716`; но `epoch` не проверяется вообще, а «другой fence» = безусловная перезапись → **B1** |
| 2.3 | receipt immutable; повтор с тем же — идемпотентен, с другим — конфликт | **PASS внутри TTL** | `:678-681` (конфликт до любых записей), `:715` `SET NX`; тест «IMMUTABLE»; проба E3 — граница TTL |
| 2.4 | два конкурентных вызова с одинаковыми параметрами не создают противоречий | **PASS** | Проба E7: `created/created`, intent.fence = F1, `supersedes=null`; тест «re-running the same … is idempotent» |
| 2.5 | конкурентные вызовы с разными fence на одну `(dispatch_id, job_id)` — ровно один успех | **PASS** | Тест «two racing writers of one receipt»: `['created','receipt_conflict']`, значение не перезаписано; проба E8 (разные dispatch_id — оба receipt'а, как и требует §4 контракта) |
| 2.6 | fallback без `eval` корректен при конкуренции, частичных ошибках, рестарте | **FAIL** | Пробы E5 (частичная запись), E6 (DEL чужого lock'а без проверки владельца), 5-секундный lock на 5+ roundtrips (`:120`) → **B2** |
| 2.7 | ошибки Redis / неоднозначный ответ не дают ложный `success` | **PASS** | `eval`-throw → fallback; fallback-`catch` → `unavailable` (`:787`); нераспознанный ответ → `unknown` → fallback (`:812-816`); dispatcher возвращает `sent:false` для всех не-ok вердиктов (`:330-365`) |
| 2.8 | receipt пишется строго до Hub POST | **PASS** | `:319` vs POST (`:370+`); тест «timeout after the hub may have taken the task» |
| 2.9 | новый intent supersedes старый; **старый вызов не может затереть новое состояние** | **FAIL** | Проба E1 (Lua) и E2 (fallback): после supersede F1→F2 приход F1 даёт `verdict=created`, `intent.fence=F1`, `supersedes=F2` → **B1** |
| 2.10 | rollback откатывает только свой claim/ref | **FAIL (частично)** | claim — fence-scoped (безопасно); `forgetTaskRef` удаляет ref по ключу без сверки fence (`gpu-dispatcher.js:334`) → F4 |
| 2.11 | ошибки очистки claim/ref не маскируются под успешный rollback | **FAIL** | `releaseTask`/`forgetTaskRef` глотают ошибки (`:423-426`, `:472-474`), dispatcher результат не проверяет (`:333-334`) → F4/F5 |
| 2.12 | envelope Hub, result route, canonical paths, completion, PG, версии/lockfiles не изменены | **PASS** | Список файлов коммита (§0); `payload` собирается до fence-блока (`:204-224`); arch-сьют зелёный |

---

## 3. TTL и восстановление

- **TTL 14 d intent / 48 h receipt** — соответствуют contract 126 §1.2 (`queue-idempotency.cjs:103`, `:113`), проверено тестом (`ttl == IDEM_INTENT_TTL_S/IDEM_RECEIPT_TTL_S`).
- **Receipt истёк, intent жив (E3):** тот же `(dispatch_id, job_id)` можно **заново привязать к другому fence** → `created`, receipt = F3. То есть «immutable» ограничена TTL: единственная привязка dispatch'а исчезает, и старый dispatch становится неотличим от нового намерения. Для фазы 1 (write-only) безвредно, **для enforce — блокер входа результата** (нужно правило `legacy_no_receipt` + запрет re-bind'а). → F3.
- **Intent истёк, receipt жив (E4):** повторная отправка того же dispatch'а **воскрешает** старый fence как текущий intent (`reused`, intent.fence = F1). Durable-истории «intent истёк» нет. → F3.
- **Частичное истечение:** покрыто двумя пунктами выше; ключи независимы, TTL не синхронизированы.
- **Restart recovery:** состояние только в Redis, in-memory нет; 127-тест «restart recovery» (новый инстанс модуля, старый store) зелёный; `reused` после рестарта возвращает тот же fence.
- **«Hub принял, backend не получил ответ»:** receipt уже записан до POST, claim остаётся в состоянии `ambiguous` — 127-тест подтверждает (`reason=ambiguous_post`, receipt(d1)=fence, claim='ambiguous'); повторная отправка той же задачи остаётся suppressed и **не меняет fence**.
- **TTL не является защитой от устаревшего результата** — подтверждено (E3/E4); в фазе 1 consumer'а нет, поэтому это ограничение, а не дефект фазы.

---

## 4. Интеграция с dispatch

Порядок в `sendUnified` (system/private/policy lane): executor gate → `resolveJobEpoch` → `computeIdemKey` → `guardEnqueue` → `rememberTaskRef` → **ensure** → POST.

- Receipt только после выигранного claim, строго до POST — **PASS**.
- `receipt_conflict` / `intent_not_active` — `retryable:false`, POST не выполняется — **PASS** по коду; но очистка не проверяется (F4).
- `busy` / `unavailable` / `invalid` / `unknown` — `retryable:true` — **PASS** по классификации, но:
  - эти reason'ы отсутствуют в таксономии (`dispatch-outcomes.js:26-33`, `queue-idempotency.cjs:871-875`), поэтому stage **не деферится** и переотправляется каждые 5 s (lease/FSM churn); `receipt_conflict` терминален, но orchestration будет ретраить его вечно → **F5**;
  - при `unavailable` (Redis сбой) `releaseTask` скорее всего тоже упадёт, claim останется до 24 h и заблокирует re-dispatch (наблюдаемость нулевая — см. F7).
- Timeout после приёма Hub не меняет fence — **PASS** (тест).
- Новый intent supersedes старый — **PASS**; обратное направление (старый затирает новый) — **FAIL, B1**.
- Envelope и result route не тронуты — **PASS** (§0, arch-сьют).

---

## 5. Регрессионные проверки (команды и результаты)

Выполнено в `/home/animastor/animastor-backend/backend`, изолированно (fake Redis, stubbed fetch):

```
npx mocha --exit tests/gpu-intent-fence-receipt.test.js
  → 15 passing (4s)

npx mocha --exit tests/gpu-queue-idempotency.test.js tests/happy-path.test.js \
   tests/gpu-hub-contract.test.js tests/architecture/redis-ownership.test.js \
   tests/architecture/gpu-hub-contract.test.js
  → 147 passing, 4 pending

npx mocha --exit 'tests/architecture/**/*.test.js'
  → 935 passing, 24 pending

npx mocha --exit 'tests/**/*.test.js'
  → 3392 passing, 28 pending, 0 failing (2m)
```

Новые тесты аудита (в репозиторий не добавлялись, чтобы не оставлять dirty-файлов):

```
node /home/animastor/reorg-2026-10-23/audit-128/experiments.cjs
DEFECT E1  stale fence overwrites the newer intent (Lua)      created → intent.fence=F1, supersedes=F2
DEFECT E2  same через fallback                                 created → intent.fence=F1
DEFECT E3  receipt TTL: old dispatch_id re-bound to new fence  created → receipt(d1)=F3
DEFECT E4  intent TTL: re-send resurrects old intent           reused  → intent.fence=F1
DEFECT E5  fallback partial write                              unavailable, intent=F2, receipt=null
DEFECT E6  fallback lock deleted without ownership check        lock=null (DELETED)
PASS   E7  two racing same-fence senders                       created/created, supersedes=null
PASS   E8  two racing different-intent senders                 created/created, receipts=F1/F2
DEFECT E9  active intent WITHOUT fence accepted                created, stored fence=undefined
DEFECT E10 non-active record blocks every NEW fence            intent_not_active:cancelled
```

Оговорки к прогонам:
- Full-suite исполняет рабочее дерево, в котором 8 чужих dirty-файлов (Stage 122/124 sweep); на файлы fencing они не влияют, но «3392/0» относится к дереву, а не к байт-в-байт `a2d088cf`.
- Существующие тесты Stage 127 **не покрывают** B1 (регрессию intent) и не проверяют fallback на частичную запись — поэтому 15/15 зелёных не являются доказательством по 2.6/2.9.

---

## 6. Блокеры

### B1 — P0. Устаревший fence перезаписывает текущий intent (регрессия authority)

**Где:** `backend/src/helpers/queue-idempotency.cjs:699-712` (Lua), `:759-777` (fallback), вызов `backend/src/runtime/gpu-dispatcher.js:319-365`.

**Минимальный воспроизводимый сценарий:**

```
ensureIntentAndReceipt(F1, dispatch d1, epoch 0)   → created   (intent = F1)
ensureIntentAndReceipt(F2, dispatch d2, epoch 1)   → created   (intent = F2, supersedes = F1)
ensureIntentAndReceipt(F1, dispatch d3, epoch 0)   → created   (intent = F1, supersedes = F2)  ← ДЕФЕКТ
```

Фактический вывод пробы E1: `verdict=created after.fence=fc36a847 (F1) supersedes=b0c93c9e (F2)`.
Ожидалось: вердикт, при котором запись не меняется (`intent_not_active`/`intent_superseded`), — т.к. F1 больше не текущий.

**Почему это критично:** вердикт `created` — это «ok» для dispatcher'а, поэтому устаревший отправитель не просто портит запись, а **допускается к POST**; authority-запись начинает указывать на старую генерацию, и фаза 2 отклонит результат актуальной. Дополнительно ветка `if receiptFence then return 'reused'` (`:714`) позволяет старому dispatch'у (чей receipt ещё жив) пройти этот путь без `receipt_conflict`.

**Достижимость:** окно `resolveJobEpoch` (`:258`) → `ensure` (`:319`) внутри одного `sendUnified` (2 Redis RTT + `rememberTaskRef`); за это окно должен успеть пройти reset epoch + новый send. Плюс независимый от гонки путь: `resolveJobEpoch` глотает ошибки и возвращает `0` (`:267-269`), поэтому Redis-сбой даёт fence эпохи 0, и при свободном claim он «легально» суперседит более новое намерение.

**Первопричина:** contract 126 §1.5 требует «state ≠ active **или другой fence** → отказ `intent_superseded`». Stage 127 заменил отказ на безусловный supersede (по ТЗ этапа), но не добавил проверку версии: `epoch` пишется в запись и **нигде не сравнивается**, `updated_at` — часы отправителя, а fence — хэш (порядка не задаёт).

**Требуемое исправление (не вносилось):** принимать новый fence только при доказанном старшинстве версии — сравнивать переданный `epoch` с `intent.epoch` (stage epoch монотонен: `bumpStageEpoch` = `INCR`, `:214-220`) и разрешать supersede лишь при `incomingEpoch > storedEpoch`; при `incomingEpoch < storedEpoch` — терминальный отказ без записи; при равенстве — требовать равенства fence. Плюс регрессионный тест «stale fence does not regress the intent» (E1/E2 как тест).

### B2 — P1. Fallback не атомарен и включается в production молча

**Где:** `queue-idempotency.cjs:732-791` (fallback), `:824-828` (тихий переход на fallback при любом throw из `eval`), `:120` (lock TTL 5 s).

**Доказательства:**
- **E5:** если запись receipt падает после записи intent, остаётся частичное состояние: `verdict=unavailable`, `intent.fence=F2`, `receipt=null`. Redis Lua тоже не откатывает записи при runtime-ошибке, но там окно ограничено одним `SET` без промежуточных решений.
- **E6:** `finally { redis.del(lockK) }` (`:790`) удаляет lock **по имени, без токена владельца**. Симуляция истечения 5-секундного TTL внутри критической секции: lock удалён (`null (DELETED)`), т.е. второй держатель остаётся без защиты. Критическая секция — 5–6 последовательных roundtrip'ов.
- **Тихая деградация:** `catch` вокруг `eval` (`:824-828`) не различает «double не умеет» и «production Redis отказал в EVAL» (ACL, прокси, CROSSSLOT в кластере). Метрики/лога нет.

**Почему блокер по правилам аудита:** строгая атомарность без Lua не гарантируется (доказано E5/E6), а mock-тест «produces the same verdicts» — не доказательство обратного. Отчёт Stage 127 корректно называет fallback «для double'ов без eval», но код не обеспечивает fail-closed, если EVAL недоступен в production.

**Требуемое исправление (не вносилось):** при ошибке `eval` возвращать `unavailable` (fail-closed) вместо прозрачного перехода на fallback; fallback оставить только для явно помеченного double'а (флаг/`NODE_ENV=test`) или сделать lock owner-token'ным (случайный токен + compare-and-delete) и логировать деградацию счётчиком.

---

## 7. Не-блокирующие дефекты и долги (исправить до enforce)

| ID | P | Дефект | Где | Минимум |
|---|---|---|---|---|
| F3 | P1 | receipt TTL позволяет заново привязать старый `dispatch_id` к новому fence (E3); intent TTL воскрешает старый intent из живого receipt (E4) | `:674-716` | в фазе 2: отсутствующий/истёкший receipt ⇒ `legacy_no_receipt`, никогда не публиковать; решить политику запрета re-bind'а |
| F4 | P2 | rollback не fence-scoped: `forgetTaskRef` удаляет ref по ключу, даже если он уже указывает на новый fence; ошибки очистки глотаются | `gpu-dispatcher.js:333-334`, `queue-idempotency.cjs:423-426,472-474` | compare-and-delete ref'а по fence + вернуть/залогировать результат rollback'а |
| F5 | P2 | новые reason'ы (`receipt_conflict`, `intent_not_active`, `intent_receipt_unavailable`) отсутствуют в таксономии → нет deferral, 5-секундный churn вместо fail-closed/quarantine | `dispatch-outcomes.js:26-33`, `queue-idempotency.cjs:871-875`, `dispatch-engine.js:1096` | добавить bucket/quarantine и метрику |
| F6 | P3 | active-запись без `fence` принимается как «тот же intent» и только продлевает TTL → fail-open для повреждённой записи (E9) | `:699` (`if intent.fence and …`), fallback `:759` (`intent.fence != null`) | считать отсутствие fence `intent_corrupt` |
| F7 | P3 | счётчики `jobs_intent_fencing_unavailable` / `jobs_fence_rejected` пишутся в неэкспортируемый `stats` → наблюдаемости нет | `gpu-dispatcher.js:344,356`; `:480` | экспорт/getStats или метрика |
| F8 | P3 | запись `state != active` навсегда (14 d) блокирует **любой** новый fence; писателя `cancelled/superseded`/`supersedeIntent` в фазе 1 нет (E10) | `:697-701`; `INTENT_STATES` только читается | до подключения cancel/regenerate — явный supersede-helper, а не отказ всем |

---

## 8. Отличия реального поведения от контрактов 126/127

| # | Контракт | Факт | Оценка |
|---|---|---|---|
| D1 | 126 §1.5: «другой fence → отказ `intent_superseded`» | безусловный supersede in-place | осознанно по ТЗ Stage 127, но именно отсюда B1 |
| D2 | 126 §1.2: intent TTL «освежается при claim refresh» | `duplicate_pending` освежает только claim/job-epoch (`gpu-dispatcher.js:279-287`) | безвредно (14 d ≫ 24 h), но контракт не выполнен |
| D3 | 126 §1.2: 4 новых семейства | +3 (journal/outbox — фаза 2) | ожидаемо |
| D4 | 126 §1.5: ensure → receipt → `guardEnqueue` | guard → ref → ensure → POST | **лучше** контракта (нет receipt'а для подавленного дубликата); зафиксировано в отчёте 127 |
| D5 | ключ receipt `{dispatch_id}:{enc(jobId)}` | оба компонента percent-encoded | безвредно, `-` не экранируется; фаза 2 обязана использовать `dispatchReceiptKey` |
| D6 | 127: «receipt immutable» | immutable в пределах 48 h (F3) | ограничение, не ложное утверждение отчёта |

---

## 9. Ограничения фазы 1 (не дефекты)

- Receipt/intent никто не потребляет: result route, canonical paths, completion и PG не изменены — так и задумано.
- Нет писателя `cancelled`/`superseded`, нет `supersedeIntent` — cancel/regenerate wiring относится к следующим фазам (но см. F8: форма записи уже сейчас создаёт ловушку).
- TTL не защищает от устаревшего результата (E3/E4) — требуется admission-правило фазы 2.
- Рестарт между staging и CAS, reconciler, staged-пути — вне объёма фазы 1.

---

## 10. Безопасный следующий этап

1. **Stage 129 (fix B1, минимальный):** в Lua и fallback добавить сравнение `epoch`/`fence` перед supersede (см. §6 B1), вернуть терминальный вердикт для устаревшего fence **без записи**, добавить регрессионные тесты E1/E2 (оба пути) и «reused не воскрешает superseded-fence».
2. **Stage 130 (fix B2):** fail-closed на ошибке `eval`; owner-token lock либо gating fallback'а; лог/метрика деградации; тест «частичная ошибка receipt SET не оставляет intent» (E5) и «истёкший lock не удаляется» (E6).
3. Только после этого — dual-write/observe-окно ≥48 h и фаза 2 (admission + F3), с обязательным тестом «receipt истёк ⇒ fail closed».

---

## 11. Границы соблюдены

- Production-код Stage 127 не изменён; `git status` после аудита — те же 8 чужих dirty-файлов и 2 untracked, новых изменений нет.
- Нет commit/push/CI/GHCR/deploy, нет npm-публикации, нет изменений версий/lockfiles/`.env`/Compose/hooks/remote refs.
- Нет подключений к production Redis/PG/Hub, нет операций с очередью (457/438), контейнеры не перезапускались.
- Все пробы — на `tests/mocks/redis-mock.js` и real-модулях в изоляции; артефакты аудита лежат вне репозитория (`/home/animastor/reorg-2026-10-23/audit-128/`).
