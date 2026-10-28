# Stage 127 — Durable intent fence + immutable dispatch receipt (фаза 1)

**Основа:** [Stage 126 implementation contract](126-result-fencing-implementation-contract.md) (§1 Identity, §1.5 Send, §7 Tests, §8 gates), дизайн [Stage 125](125-gpu-result-fencing-design.md).
**Статус: PASS.** Реализована только фаза 1; все проверки пройдены; локальный коммит создан после успешных проверок. Push/CI/GHCR/deploy не выполнялись.

## 0. Границы соблюдены

| Граница | Соблюдение |
|---|---|
| Только фаза 1 (intent record + receipt до Hub POST) | ✅ Выполнено в backend/src (host) |
| `computeIdemKey` / `resolveJobEpoch` — та же система идентичности | ✅ Fence = существующий `idem_key`; вторая система не создана |
| Не менять envelope Hub / result route / canonical paths / completion / PG | ✅ Ни один из этих файлов не изменён (список изменений — §1) |
| Не публиковать npm, не менять версии/зависимости/lockfiles | ✅ `package.json`/`package-lock.json` не тронуты; `packages/*` не тронуты |
| Нет push/CI/GHCR/deploy | ✅ Только локальный коммит `a2d088cf` |
| Нет production Redis/PG, Hub, очереди 457/438, контейнеров, `.env`, Compose, hooks, remote refs | ✅ Ничего из этого не читалось и не изменялось; тесты используют фейковые Redis/stub fetch |
| Чужие dirty-файлы не менять | ✅ Stage-124/прочие dirty-файлы остались нетронутыми и незакоммиченными (проверено `git status` до/после) |
| Сначала тесты, коммит после успешных проверок | ✅ Коммит создан только после полного зелёного прогона (§3) |
| Не обходить sandbox, не обращаться к production | ✅ TCP-listener'ы работали штатно (`LISTEN_OK`), тесты направлены только на локальные фейки |

## 1. Изменения (5 файлов, 932 строки, коммит `a2d088cf`)

### `backend/src/helpers/queue-idempotency.cjs` (+298)

Новый раздел «Stage 127 — durable intent fence + immutable dispatch receipt»:

- **Константы/TTL**: `IDEM_INTENT_PREFIX='animastor:intent:'`, `IDEM_RECEIPT_PREFIX='animastor:dispatch-intent:'`, `IDEM_INTENT_LOCK_PREFIX='animastor:intent-lock:'`; `IDEM_INTENT_TTL_S = 14 д` (переживает claim 24 ч, done 7 д), `IDEM_RECEIPT_TTL_S = 48 ч` (> самого длинного claim 24 ч — контрактное окно из 126 §5), `INTENT_RECEIPT_LOCK_TTL_S = 5`; `INTENT_STATES = {active, superseded, cancelled}`.
- **Ключи**: `intentKey(book,chapter,scene,job)` и `dispatchReceiptKey(dispatchId, jobId)` — компоненты через существующий `encodeKeyComponent` (никаких новых грамматик ключей).
- **Чтение**: `readIntent(...)` → JSON-запись `{fence, state, epoch, supersedes, updated_at}` или `null`; `readDispatchReceipt(dispatch, job)` → fence или `null`.
- **`ensureIntentAndReceipt(redis, {bookId, chapterId, sceneId, jobId, dispatchId, fence, epoch})`** — одна атомарная операция «ensure intent + запись receipt»:
  - **Продовый путь**: Lua-скрипт `ENSURE_INTENT_RECEIPT_SCRIPT` (проверка hex-fence → проверка существующего receipt → проверка `state == active` → запись/refresh intent → `SET NX` receipt). Verdict'ы: `created | reused | receipt_conflict | intent_not_active:<state> | intent_corrupt | invalid_fence`. До первого reject-вердикта ничего не записывается (позволяет вызывающему откатить свои claim/ref).
  - **Fallback для double'ов без рабочего `eval`**: lock-guard'нутый read-check-write (`SET NX` lock под ключом `animastor:intent-lock:*`, ожидание до 500 мс → `busy`), те же verdict'ы, lock всегда освобождается в `finally`; **никогда не «молчаливый успех»** — нераспознанный возврат `eval` проваливается в fallback, а не выдаётся за успех.
- **Свойства**: receipt — только `SET NX`, никогда не перезаписывается; повторный ensure того же fence идемпотентен (intent не переписывается, только refresh TTL); смена fence при `state=active` записывает `supersedes: <старый fence>`; `state != active` → reject без записей.

### `backend/src/runtime/gpu-dispatcher.js` (+70)

В `sendUnified`, **после** выигранного `guardEnqueue`+`rememberTaskRef` и **перед** первым POST:

1. `qidem.ensureIntentAndReceipt(..., fence: idemKey, epoch)` — fence берётся из уже вычисленного `idem_key` (`resolveJobEpoch` → `computeIdemKey` — существующая идентичность, §1.5 контракта).
2. Вердикт `created|reused` → продолжение (POST идёт как раньше).
3. Любой другой вердикт → **send не достигает Hub**: откат собственных side-effects этого отправителя (`releaseTask` + `forgetTaskRef` — claim был взят этим же вызовом через SET NX) и структурированный not-sent:
   - транзиентные (`busy`, `unavailable`, `invalid`, `unknown`, нет вердикта) → `{sent:false, reason:'intent_receipt_unavailable', retryable:true, suppressed:true}` + счётчик `stats.jobs_intent_fencing_unavailable`;
   - терминальные (`receipt_conflict`, `intent_not_active[:state]`, `intent_corrupt`, `invalid_fence`) → `{sent:false, reason:<статус>, retryable:false}` + счётчик `stats.jobs_fence_rejected`.
4. Логи `[GPU] Intent fence created|reused|REJECTED`.

Классификация B2 (definitive/ambiguous POST), claim-TTL логика, payload и всё остальное не менялись.

### `backend/tests/architecture/redis-registry.js` (+35)

Зарегистрированы 3 новых backend-владельных семейства (требование guardrail'а Redis ownership): `animastor:intent:*`, `animastor:dispatch-intent:*`, `animastor:intent-lock:*` — с note'ами про запись до POST, SET NX только и 48 h TTL.

### `backend/tests/mocks/redis-mock.js` (+53)

Ветка `eval` для нового скрипта — точное зеркало Lua-вердиктов (установлено гвардиантом `'receipt_conflict' && 'intent_not_active' && 'intentTtl'`), по прецеденту Stage 120 F2 (`REFRESH_CLAIM_TTL_SCRIPT`). Без неё catch-all mock'а незаметно портил бы ключи.

### `backend/tests/gpu-intent-fence-receipt.test.js` (новый, 15 тестов)

Покрытие обязательных регрессий (п. 7 задания):

| Требование | Тест(ы) |
|---|---|
| same-intent redispatch | «same-intent re-dispatch preserves the fence and writes one receipt per actually-POSTed dispatch» (403→retry, дубликат-suppress без POST и без receipt) |
| new intent | «a NEW intent (reset task epoch) gets a new fence, supersedes the old one, old receipt untouched» (зеркало error-пути: release+forget+bump+reset) |
| immutable receipt | unit: «re-running … idempotent», «a receipt is IMMUTABLE …» |
| конфликт существующего receipt | unit `receipt_conflict` + интеграционный «dispatch/job collision: reusing a dispatch_id with a NEW fence is rejected, state reverted, hub never called» (постов = 1, intent/receipt не тронуты, claim/ref откачены) |
| timeout после приёма Hub | «timeout after the hub may have taken the task: the receipt was already written before the POST» (3 попытки, claim `ambiguous`, receipt существует, re-dispatch подавлен) |
| recovery после рестарта | «restart recovery: a fresh dispatcher instance reuses the pinned identity and receipts survive» (новый экземпляр модуля, пин/фенс/receipt'ы пережили «рестарт», поздний callback d1 резолвится) |
| плюс | non-active intent, corrupt intent, non-hex fence, коллизии dispatch×job (fanned-out jobs), гонка двух писателей (`Promise.all` → ровно один winner), fallback-путь без `eval` (вердикты идентичны, lock не утёк), Lua — продовый путь (spy: скрипт реально вызван) |

## 2. Поведение по сценариям (п. 5 задания)

- **Timeout после приёма Hub**: receipt написан ДО POST → ambiguous-исход (Stage 118 B2) сохраняет claim, идентичность уже доказуема; повторный send того же intent подавлен `duplicate_pending` (одна запись в лейне), receipt новому dispatch не монтируется (POST не было — значит callback с его dispatch_id невозможен).
- **Retry/definitive rejection**: 4xx-отказ освобождает claim/ref (как раньше), receipt остаётся (immutable, 48 h) — безвреден; следующий send того же intent пишет receipt для нового dispatch с ТЕМ ЖЕ fence.
- **Рестарт**: intent (14 d) и receipt'ы (48 h) живут в Redis; после рестарта `resolveJobEpoch`-пин даёт тот же fence, intent `reused`, старые receipt'ы читаются через `readDispatchReceipt`.
- **Повторное создание receipt**: `SET NX` → `reused`, байты intent не меняются (проверено сравнением raw-строки).
- **Коллизия dispatch/job**: один dispatch на многие jobs — отдельные receipt'ы; точная пара (dispatch, job) с другим fence → `receipt_conflict`, ничего не перезаписано, отправитель откатывает claim/ref, Hub не вызывается.

## 3. Проверки (все PASS)

| Проверка | Команда | Результат |
|---|---|---|
| Новые регрессии | `npx mocha --exit tests/gpu-intent-fence-receipt.test.js` | **15 passing / 0 failing** |
| Целевые сьюты (dispatch/idempotency/artifact) | `npx mocha --exit tests/gpu-queue-idempotency.test.js tests/gpu-orphan-completed-marker.test.js tests/gpu-lane-release-order.test.js tests/dispatch-meta-lease-lifecycle.test.js tests/orchestration-stabilization.test.js tests/generation-provider-seam.test.js tests/reconciliation-engine.test.js tests/markready-build-id-idempotency.test.js` | **222 passing / 0 failing** |
| Доп. целевые | happy-path, generation-media-registry, gpu-audio-dispatch-deferral, stage-dispatch-lifecycle | **91 passing / 0 failing** |
| Hub/восстановление | gpu-hub-*, cancellation-recovery, image-orphan-generating-repair, startup-recovery, scene-asset-registry, circuit-breaker | **зелёные** |
| Listener-сьюты | worker-share-grants (27), private-worker-phase2 (40+1 pending) | **зелёные** |
| Архитектурный suite | `npx mocha --exit tests/architecture/*.test.js` | **935 passing / 24 pending / 0 failing** (база Stage 126 — без изменений; ownership-guard принял новые семейства) |
| **Полный backend-suite** | `npx mocha --exit 'tests/**/*.test.js'` | **3392 passing / 28 pending / 0 failing, exit 0 (~2 мин)** |
| Синтаксис | `bash scripts/syntax-smoke.sh backend` | OK (pretest гейт зелёный) |

Ограничения среды: TCP-listener'ы в этой среде работают (`LISTEN_OK`), тесты используют только локальные фейки/stub-fetch — production не затрагивался. Обнаружено: скрипт `npm test` в shell раскрывает `tests/**/*.test.js` только на один уровень (без globstar) и фактически прогоняет `tests/*/`, поэтому полный прогон делался явной glob-строкой mocha — это особенность окружения, не связанная с этим stage'ом, код не менялся.

## 4. Известные ограничения (осознанные, вне объёма фазы 1)

1. **Receipt только для реально POST-нутых dispatch'ов**: подавленный до POST send (`duplicate_pending`/`already_completed`) receipt не пишет — callback с его dispatch_id невозможен. Контракт 126 §1.5 («may add a second receipt») выполняется для dispatch'ов, доходящих до POST.
2. **Порядок при конкурентных старом/новом fence**: запись `supersedes` фиксирует порядок ВЫПОЛНЕНИЯ ensure, а не поколения (fence — хэш, не упорядочен). Гарантия «старый никогда не перекроет новый» приходит в фазе 4 (supersede intent до cleanup в cancel/regenerate) — в фазе 1 cancel/regenerate-пути не менялись.
3. **Fallback-путь** (double'ы без `eval`) — lock-guard'нут, продовый ioredis всегда идёт по Lua; тесты покрывают оба пути.
4. Потребление receipt'а (admission в result route), staged-записи, CAS-коммит, PG `generation_fence` — следующие фазы контракта 126 (этапы 2–6), здесь не внедрялись.

## 5. Коммиты

- **`a2d088cf`** `feat(gpu-queue): durable intent fence + immutable dispatch receipt (stage 127 / fencing phase 1)` — 5 файлов, 932 insertions, локальный, **не запушен**.
- Чужие dirty-файлы (Stage 124 и др.) не staged и не committed; untracked `deploy/`, `freebuff-chat-*.md` не тронуты; remote refs/hooks/Compose/.env не изменялись.
