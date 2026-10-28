# Stage 115 — Independent audit of the GPU idempotency patch (8b375dc0)

**Дата:** 2026-10-22, окно **04:25Z → 05:05Z**.
**Аудируемый патч:** `8b375dc0d0efe32b4ff5381399270957340a3d85` (родитель `53ce504536c14413c2c5e7b8546d529db8ee2530`), репозиторий `animastor-backend`.
**Режим:** независимый аудит, read-only по production; изменения в патч **не вносились** (коммит не переписан, amend не делался), репозиторий после аудита идентичен состоянию коммита (изменены только чужие dirty-файлы, они не тронуты).
**Вердикт: BLOCKED для публикации** — ключевые сценарии закрыты не полностью: обнаружены **3 дефекта публикационного уровня** (D2, D3, D4) и **1 дефект низкой тяжести** (D1, самовосстанавливающийся). Ничего не применено; production не затронут.

---

## 0. Сводка

| Область | Вердикт | Комментарий |
|---|---|---|
| Архитектура, ownership ключей, каноникализация, единый формат idem-ключа | **PASS** | семейство `animastor:idempotency:*` зарегистрировано (backend-owned); все 4 пути вызова сводятся к одному `sendUnified`; `params` проходит verbatim |
| Идемпотентность при re-dispatch / конкуренции / lease / crash | **PASS** с оговоркой | подтверждено тестами; остаётся «окно неоднозначности» POST (D2) |
| **Жизненный цикл: отмена / очистка lane'а** | **BLOCKED** (D4) | claim не освобождается при очистке lane'а ⇒ повторный запуск подавляется на 24 ч |
| **Поведение при отсутствии исполнителя / при подавлении дублей** | **BLOCKED** (D3) | dispatch/cancel-хорда каждые 5 с на сцену + неограниченный рост журнала Redis |
| Регенерация одного IU (stage-level epoch) | **PASS с оговоркой** (D1) | stage-эпоха **не** подавляет регенерацию *другого* IU; собственный dirty-IU подавляется на первом attempt (самовосстанавливается) |
| Регрессии в репозитории | **PASS** | полный backend-suite: 2612 pass / 85 fail — **множество падений идентично** Stage 114 (0 новых) |
| Production | **PASS** | Redis/PG/очередь/инвентари/контейнеры/refs — без изменений |

---

# 1. Diff и архитектура

## 1.1 Состав патча (прочитан целиком)

| Файл | Δ | Что сделано |
|---|---|---|
| `backend/src/helpers/queue-idempotency.cjs` (новый, 375) | +375 | `canonicalJson`, `computeInputVersion`, `computeIdemKey`, stage/dispatch-эпохи, claim/done/ref, `guardEnqueue`, `listAliveWorkers`, `hasLiveExecutorForLane`, `resultDedupKey` |
| `backend/src/runtime/gpu-dispatcher.js` | +103 | `setRedis`, гейт исполнителя, claim перед POST, ref для callback'а, освобождение claim при ошибке POST, счётчики |
| `backend/src/routes/generation-routes.cjs` | +52 | dispatch-независимый dedup-ключ результата, фиксация завершения, освобождение claim + bump эпохи на ошибке |
| `backend/src/image/iu-processor.js` | +43 | dedup-clear по реальному формату hub'а, bump эпохи при регенерации, явная причина `no_worker_available` |
| `backend/src/state/scene-state-ops.js` | +25 | bump эпохи в `markDirtyScene` |
| `backend/src/backend.cjs` | +12 | `setRedis(redis)`, инъекция `queueIdempotency` в deps маршрута |
| `backend/src/storage/postgres/repositories/worker-repo.js` | +1 | `owner_workspace_id` в `findGrantPolicyForRouting` |
| `backend/tests/architecture/redis-registry.js` | +15 | регистрация семейства `animastor:idempotency:*` |
| `backend/tests/gpu-queue-idempotency.test.js` (новый, 593) | +593 | 22 изолированных теста |

## 1.2 Ownership Redis-ключей — **PASS**

* Новое семейство `animastor:idempotency:*` зарегистрировано в `tests/architecture/redis-registry.js`: owner `backend`, readers/writers `backend`, `crossModule: false`, пояснение в `note`.
* Namespace выбран **намеренно отдельным** от hub-owned `animastor:job:*` и `animastor:queue:*` ⇒ backend-writes не пересекаются с hub-owned семействами (иначе cross-owner write). Проверено тестом `redis-ownership.test.js` (проходит).
* Guard-rail `T6: contour routes do not gain new implementation-detail deps` и `PM-G2: backend/src/runtime` — соблюдены: модуль в `helpers/`, маршрут получает порт через `deps`.

## 1.3 Единый формат idem-ключа и каноникализация — **PASS**

Все четыре пути вызова сводятся к одной точке:

```
image/iu-processor.js:293 ─┐
audio/generation.js:329,506 ├→ provider.generate() → comfyui-provider.generate()
scene-orchestrator.js:556 ┘   → packages/animastor-generation/src/ports/dispatch-transport.js
                              → runtime/gpu-dispatcher.sendUnified()   ← единственная точка расчёта idem_key
```

* `dispatch-transport.js` передаёт taskSpec **verbatim** («Job Protocol v2 is UNCHANGED») ⇒ `params` не теряются и не нормализуются по дороге.
* `canonicalJson` обходит всё дерево `params` рекурсивно (ключи сортированы, порядок массивов сохранён) ⇒ различие в seed/промпте/модели/версии даёт разный `input_version`; перестановка ключей — тот же хэш (тест).
* Нормализация `null`: `workspace_id` (null → `''`), `build_id` (`taskSpec.build_id || 'default'` ⇒ никогда не null), `generation_epoch` (0 по умолчанию), `params` (undefined → `null`).
* Значимые параметры не теряются: `input_version` считается по полному workflow-дереву (`inputs`, `clip`, `model`, `seed`, текст промпта).

## 1.4 Проверка мест вызова — **PASS**

| Место | Проверено | Итог |
|---|---|---|
| `gpu-dispatcher.sendUnified` | единственная точка расчёта claim/idem_key; гейт → claim → POST | корректный порядок (claim **до** POST) |
| `routes/generation-routes.cjs` (`/gpu/task/result`) | dedup-ключ dispatch-независимый; фиксация завершения **после** успешного `handleTaskResult` | корректно; при `throw` dedup-ключ откатывается (как раньше) |
| `routes/generation-routes.cjs` (`/gpu/task/error`) | освобождение claim + bump эпохи перед `failStage` | корректно |
| `state/scene-state-ops.markDirtyScene` | bump эпохи только для `audio\|image\|video` | корректно; reconciliation-откат (`rollbackStageToPending`) эпоху **не** двигает (проверено чтением кода) |
| `image/iu-processor` dedup-clear | теперь `animastor:job:{dispatch_id}:{job_id}` — реальный формат hub'а | корректно; прежний формат был no-op |
| `image/iu-processor` result-processed clear | `animastor:result-processed:{job_id}:{build_id}` — совпадает с форматом маршрута | корректно (было — legacy-no-op) |
| `worker-repo.findGrantPolicyForRouting` | +`owner_workspace_id` (аддитивно) | корректно, используется для проверки живости policy-lane |

---

# 2. IU и generation epoch

## 2.1 Stage-level epoch и регенерация одного IU

**Вопрос задания: подавляет ли stage-level epoch законную регенерацию другого IU?**
**Ответ: НЕТ** (проверено тестом AUDIT-7).

| IU | Состояние | Идентичность | Результат |
|---|---|---|---|
| IU-A (не менялся) | завершён ранее (done-marker на эпохе E) | после bump'а эпохи (E+1) его done-marker **не совпадает** ⇒ защита ослаблена | задача **не подавлена**; фактический enqueue предотвращает проверка артефакта на диске (`probeIUImage`) ⇒ лишней GPU-работы нет |
| IU-B (изменён пользователем) | dirty | новая эпоха E+1 ⇒ новая идентичность | **разрешён** ✔ |

⇒ Риск stage-level эпохи направлен в сторону «лишней работы», а не «потерянной работы» — приемлемо.

## 2.2 Дефект D1 — первый attempt после регенерации подавляется (LOW-MEDIUM, самовосстанавливается)

**Сценарий (воспроизведён, AUDIT-1):**

1. IU-X отработал ранее ⇒ его `done`-маркер записан на эпохе E.
2. Пользователь правит IU-X ⇒ сцена помечается dirty ⇒ `/regenerate` **не** двигает эпоху заранее (путь `/regenerate` → `orchestrator.resetScenes` → `bookDiff.markDirtyScenes` → Lua `RESET_SCENE_LUA`, а **не** `state/scene-state-ops.markDirtyScene` — проверено по коду).
3. Диспатч стадии D2: **первым** уходит другой, не-dirty IU-Y (его артефакта нет ⇒ не cache-hit ⇒ отправка) ⇒ `resolveDispatchEpoch(D2)` **замораживает эпоху E** на весь диспатч.
4. Затем IU-X (dirty): ветка dirty-unit **поднимает эпоху до E+1** (это происходит уже внутри диспатча) и удаляет старый PNG, затем отправляет.
5. `resolveDispatchEpoch(D2)` возвращает **замороженную** эпоху E ⇒ `idem_key` IU-X = идентичность предыдущей успешной попытки ⇒ `done`-маркер найден ⇒ **enqueue подавлен** (`already_completed`).
6. Следующий тик (5 с): эпоха стадии уже E+1 ⇒ новый диспатч D3 замораживает E+1 ⇒ IU-X получает новую идентичность ⇒ **отправка разрешена** ✔.

**Итог:** регенерация **не теряется**, но выполняется **со второго attempt'а** (через ~5 с) и в лог пишется вводящий в заблуждение `already_completed`. Если старый PNG уже удалён (его удаляет dirty-ветка), между attempt'ами картинка отсутствует (окно в несколько секунд).

**Минимальная правка (backend-only, ~10 строк):** снять заморозку эпохи на диспатч и **читать stage-эпоху в момент отправки** (`resolveDispatchEpoch` → `getStageEpoch`). Эпоха тогда применяется к каждому job'у ровно один раз, и bump в dirty-ветке (который происходит до отправки своего IU) сразу виден своему IU. Побочно устраняется замечание O4 (заморозка на 1 ч может пережить длинный видео-диспатч).

**Регрессионные тесты, которые должны сопровождать правку:** (1) dirty-IU отправляется в том же диспатче, где раньше ушёл другой IU ⇒ enqueue разрешён; (2) эпоха, поднятая между двумя отправками одного диспатча, не делит идентичность одного job'а.

## 2.3 Разделение разных IU / workspace / build / модели / seed / промптов / версий — **PASS**

Подтверждено тестами Stage 114 (6 задач → 6 enqueue, разные `params`-хэши) и аудита (AUDIT-7). Схлопывания разных логических задач **не обнаружено**.

---

# 3. Claim / done / TTL

## 3.1 Атомарность `SET NX` — **PASS**

`SET animastor:idempotency:claim:{idem_key} 1 NX EX` — атомарно; 25 параллельных claim'ов ⇒ ровно 1 победитель (тест Stage 114). Конкурентные dispatch'и (4 параллельных) ⇒ 1 POST (тест).

## 3.2 Сбой после claim, до POST — **PASS с оговоркой (D5)**

Claim берётся **до** POST ⇒ окно «claim без задачи» существует. При падении процесса в этом окне claim живёт до TTL (24 ч) ⇒ задача блокируется на это время (AUDIT-5: `ttl > 86000`).

Оценка: **не дефект, а документированный компромисс** — claim обязан пережить graceful shutdown (ради этого он и сделан), а TTL 24 ч — единственный backstop. Альтернатива (короткий TTL) открыла бы окно повторного enqueue после crash ⇒ **D5 лечится не укорочением TTL, а D2-фиксом** (не отпускать claim при неоднозначной ошибке) — тогда «claim без задачи» возникает только при реальном crash процесса, что редко.

## 3.3 Сбой во время POST / после принятия задачи hub'ом — **BLOCKED (D2)**

**Сценарий (воспроизведён, AUDIT-2):** POST `/task` дошёл до hub'а, но ответ не пришёл (обрыв сети / таймаут 30 с). Диспетчер после 3 неудачных попыток **освобождает claim** (`releaseTask`) ⇒ следующий dispatch видит свободный claim ⇒ **отправляет задачу второй раз** ⇒ в lane'е появляется **вторая копия** той же логической задачи (dedup hub'а dispatch-scoped и её не поймает).

То есть окно неоднозначности **возвращает исходный дефект** в том редком случае, когда ответ потерян.

**Минимальная правка (backend-only, ~10 строк):** различать исход отказа:
* **окончательный отказ** (HTTP-статус ≥ 400 от hub'а ⇒ hub точно не принял задачу) ⇒ claim освобождать;
* **неоднозначный отказ** (сетевая ошибка / таймаут / 5xx ⇒ hub мог принять) ⇒ **claim НЕ освобождать** (задача, возможно, в lane'е; результат/ошибка от hub'а её освободят). Чтобы «потерянный» POST не блокировал задачу на 24 ч, для неоднозначного случая использовать отдельный, более короткий TTL (например, 3× таймаут задачи ≈ 90 мин).

**Регрессионные тесты:** (1) неоднозначный сетевой сбой ⇒ claim остаётся, повторная отправка подавлена; (2) HTTP 400 ⇒ claim освобождён, повторная отправка разрешена.

## 3.4 Завершение задачи, повторная доставка результата — **PASS**

* `done`-маркер ставится **только** после принятия реального результата (`handleTaskResult` OK) ⇒ «запись в очереди» никогда не считается выполнением.
* Dedup результата теперь dispatch-независимый ⇒ повторная доставка (в т.ч. из другого dispatch'а) отбрасывается.
* Завершённая задача не ставится повторно без разрешённого retry: `done`-маркер блокирует ту же эпоху; обоснованный retry (bump эпохи) даёт новую идентичность ⇒ разрешён (тесты Stage 114).

## 3.5 TTL после 24 ч / 7 сут и повторная доставка старого dispatch/result — **PASS с оговорками**

| TTL | Что происходит при истечении | Оценка |
|---|---|---|
| claim 24 ч | задача может быть поставлена снова | приемлемо: артефакт на диске всё равно проверяется (`probeIUImage`) ⇒ лишней GPU-работы нет |
| done 7 сут | завершённая задача может быть поставлена снова | приемлемо (тот же артефактный контроль) |
| stage-эпоха 30 сут | эпоха сбрасывается в 0 | приемлемо: старые done-маркеры (7 сут) к тому моменту истекли |
| dispatch-эпоха 1 ч | может быть перезаморожена посреди длинного диспатча | см. O4 (устраняется правкой D1) |

**Повторная доставка старого result:** для image отклоняется раньше dedup (`verifyDispatchIdentity` ⇒ `stale_dispatch`) ⇒ `done`-маркер не ставится, claim остаётся (задача всё ещё в lane'е) ⇒ согласованно. Для audio/video возможен приём «stale dispatch» при фазе `WAITING_CHUNKS/MERGING` ⇒ тогда `done`-маркер ставится (по ref'у) ✔.

## 3.6 Активный lease не снимается; завершённая задача не перезапускается — **PASS**

Патч **не трогает** lease-логику (`lease-manager`, `dispatch-engine`), guard `lease_active`/`stale_lease` сохранён (тесты Stage 114 + регрессии пакета 19/0). Завершённая задача не перезапускается без разрешённого retry (см. 3.4).

---

# 4. Worker gate и reconciliation

## 4.1 Проверки исполнителя — **PASS**

| Кейс | Результат |
|---|---|
| worker offline (нет heartbeat) | enqueue заблокирован, `no_worker_available`, запись в очередь не создаётся (AUDIT-3) |
| истёкший heartbeat | TTL 30 с ⇒ ключ исчезает ⇒ блокировка та же; проверка дополнительно фильтрует по `ts` |
| несовместимый тип | audio-воркер не разблокирует image-задачу (тест Stage 114) |
| чужой workspace (private) | не разблокирует ws-lane другого workspace (тест Stage 114) |
| system-пул без system-воркера | блокировка ✔ |
| policy-lane | проверяется по `owner_workspace_id` (аддитивный SQL) |

## 4.2 Уже принятые задания не теряются — **PASS**

Гейт срабатывает **до** enqueue и не трогает содержимое lane'а ⇒ уже принятые задания остаются в `animastor:queue:image:ws:…` и доступны для последующего dispatch'а (в т.ч. после появления воркера). Проверено: `LLEN` lane'а в тестах не меняется при гейте.

## 4.3 Graceful shutdown → cancellation → reconciliation → re-dispatch — **PASS**

Цепочка не изменилась патчем; изменён **результат**: re-dispatch получает тот же `idem_key` ⇒ enqueue подавлен ⇒ **дубликат не создаётся** (тест Stage 114 «graceful shutdown → reconciliation → re-dispatch creates no duplicate»). Новое: lease/dispatch-meta по-прежнему удаляются (cancel), FSM откатывается reconciliation'ом — т.е. **состояние сцены не «залипает»** ✔.

## 4.4 Новые ключи не нарушают существующие lease и старые задачи — **PASS**

Новое пространство имён (`animastor:idempotency:*`) не пересекается с lease/dispatch-meta/iu-in-flight/lane-ключами; старые 457 записей lane'а патчем не затрагиваются (проверено: `LLEN` 457 до и после, `animastor:idempotency:*` — 0 ключей в production).

---

# 5. Дефекты (итог)

| ID | Дефект | Сценарий | Тяжесть | Самовосстановление | Блокер публикации |
|---|---|---|---|---|---|
| **D1** | Первый attempt после регенерации dirty-IU подавляется (`already_completed`): эпоха поднимается внутри диспатча, а эпоха диспатча уже заморожена более ранней отправкой | §2.2 (AUDIT-1) | LOW-MEDIUM | да (следующий attempt, +5 с) | нет (но править до деплоя) |
| **D2** | Неоднозначный сбой POST (hub мог принять задачу) ⇒ claim освобождается ⇒ следующий attempt создаёт **дубликат** в lane'е | §3.3 (AUDIT-2) | MEDIUM | нет | **ДА** |
| **D3** | Подавление enqueue (`duplicate_pending`) ⇒ executor видит `jobs=0` ⇒ `no_jobs_sent` ⇒ dispatch отменяется ⇒ FSM откатывается ⇒ **следующий тик (5 с) начинает то же самое**: цикл dispatch/cancel каждые 5 с на сцену | §5.1 | HIGH | нет | **ДА** |
| **D4** | Claim не освобождается при очистке lane'а hub'ом (cancel / regenerate / удаление книги) ⇒ повторный запуск тех же задач на той же эпохе **молча подавляется** на TTL claim'а (24 ч) | §5.2 (AUDIT-6) | HIGH | нет | **ДА** |
| **D5** | Падение процесса между claim и POST ⇒ задача заблокирована до TTL claim'а | §3.2 (AUDIT-5) | LOW (доступность) | да (TTL) | нет |

## 5.1 D3 — подробно (цикл dispatch/cancel каждые 5 с)

**Цепочка (все ссылки — на код патча/пакета):**

1. Тик scheduler'а — `SCHEDULER_TICK_MS = 5000` (`packages/animastor-orchestration/src/runtime/runtime-scheduler.js:89`).
2. Стадия в состоянии `PENDING` ⇒ попадает в `attemptDispatch` (`runtime-scheduler.js:338-343`: стадия диспетчеризуется, если состояние не READY/FAILED/GENERATING).
3. `dispatch-engine.dispatchStage` создаёт **lease** и **dispatch-meta** (`dispatch-engine.js:733+`), затем вызывает executor.
4. Executor (`scene-orchestrator.js:313-381`) отправляет 9-10 IU-задач; **все** получают `sent:false` (подавление `duplicate_pending` либо `no_worker_available`) ⇒ `jobsSent = 0` ⇒ возвращается `{dispatched:false, jobs:0, reason:'no_jobs_sent'}`.
5. `dispatch-engine` видит `!result.dispatched` ⇒ `finalizeDispatch(outcome='cancelled')` (lease и meta удаляются) ⇒ executor откатывает FSM `GENERATING→DIRTY→PENDING` (`scene-orchestrator.js:614-632`).
6. Сцена остаётся в active-index ⇒ **через 5 с всё повторяется**.

**Последствия:**

| Следствие | Величина |
|---|---|
| Циклов в минуту | 12 на сцену (2 сцены ⇒ 24/мин) |
| Событий в журнале | ~5 на цикл ⇒ ~60/мин на сцену ⇒ **неограниченный рост списка журнала** |
| Текущий размер журналов | `sc-5f0068ca` — 380 919 записей, `_recovery:_cycle` — 278 410, `sc-45c789c6` — 68 544 |
| Redis | `maxmemory = 0`, `policy = noeviction`, used 237 MB ⇒ **медленная утечка без лимита** (хост: 3.9 GB RAM, 2.2 GB available) |
| Логи backend'а | ~8 строк на цикл ⇒ ~120/мин |
| Данные/артефакты | не теряются; корректность FSM сохраняется |

**Когда это начнётся в production:** сцена сейчас в `generating` с живым lease'ом ⇒ тики её пропускают. После ближайшего graceful-рестарта backend'а (то есть сразу после деплоя) произойдёт re-dispatch; т.к. claim'ов ещё нет, первые 9-10 задач **снова попадут в lane** (очередь вырастет до **476**), а claim'ы появятся ⇒ **со следующего re-dispatch'а начнётся цикл 5 с**. Т.е. цикл стартует автоматически, без появления воркера.

**Минимальная правка:** ��роверка исполнителя должна выполняться **до создания lease/dispatch-meta** — т.е. в `dispatch-engine.dispatchStage` (владелец диспатча) через существующий seam-механизм. Это **правка пакета `@animastor/orchestration`** ⇒ требует bump версии + переиздания + обновления зависимости backend'а (как Stages 102/103) — **отдельный этап**, не «скрытая миграция».
Backend-only альтернативы нет: любая попытка сделать так, чтобы диспатч «успешно» завершился без отправки, противоречит требованию «явный retryable/no-worker результат» и «не создавать dispatch-записи».

## 5.2 D4 — подробно (claim переживает очистку lane'а)

**Сценарий (воспроизведён, AUDIT-6):**

1. Диспатч отправляет задачу ⇒ claim создан (`animastor:idempotency:claim:{idem_key}`) + ref (`…:ref:{job_id}`).
2. Пользователь отменяет генерацию ⇒ backend вызывает `DELETE /queue/clear?book_id=…` (`routes/book/generation-routes.cjs:317`; также `cache-routes.cjs:124`, `book-deletion.cjs:211`, `hub-cancel-adapter` → `clearHubDispatches`) ⇒ **hub удаляет записи lane'а**.
3. Hub **не знает** про backend-ключ claim ⇒ **claim остаётся** (и ref остаётся).
4. Пользователь запускает генерацию снова ⇒ та же сцена/стадия/параметры ⇒ та же эпоха (cancel **не** двигает эпоху) ⇒ тот же `idem_key` ⇒ claim занят ⇒ enqueue **подавлен** (`duplicate_pending`) ⇒ задача **молча не выполняется** — до истечения TTL claim'а (24 ч).

Тот же путь срабатывает при `resetScenes` (то есть при `/regenerate`), который чистит lane'а через `clearHubDispatches` перед новой отправкой ⇒ **повторная генерация сцены, чьи задачи уже были в lane'е, может быть молча подавлена**.

**Минимальная правка (backend-only, ~15 строк):** в путях отмены/очистки освобождать claim'ы затронутых задач. Ref-ключ содержит book/ch/sc внутри `job_id` (`{book}_{ch}_{sc}_{unit}:iu_image`) ⇒ достаточно SCAN'а по шаблону `animastor:idempotency:ref:{book}_{ch}_{sc}_*` (для книги — `…:ref:{book}_*`) ⇒ по найденным ref'ам удаляются claim и ref. Хелпер `releaseClaimsForScene(redis, bookId, chapterId, sceneId)` / `releaseClaimsForBook(redis, bookId)`.

**Регрессионные тесты:** (1) claim → очистка lane'а → повторный запуск **разрешён**; (2) очистка lane'а **не** трогает claim'ы чужих сцен/книг.

---

# 6. Наблюдения (не дефекты)

| ID | Наблюдение | Рекомендация |
|---|---|---|
| O1 | Первый post-deploy re-dispatch **добавит +19 записей** (claim'ов ещё нет ⇒ первые отправки не подавятся) ⇒ очередь 457 → 476, дальше рост прекращается | Учесть в плане чистки (Stage 118) либо чистить **до** деплоя |
| O2 | `getRedis() === null` **молча** отключает весь идемпотентент-слой и гейт (в production клиент всегда регистрируется в `backend.cjs`, но деградация не сигнализируется) | Одноразовый `WARN` при первом send без зарегистрированного клиента |
| O3 | `hasLiveExecutorForLane` делает Redis SCAN **на каждую отправку** (9-10 на диспатч) | Кэш на 1-5 с при большом числе воркеров |
| O4 | Заморозка эпохи на диспатч (TTL 1 ч) может пережить длинный видео-диспатч (таймаут 60 мин) ⇒ теоретическая смена идентичности одного job'а внутри диспатча | Устраняется правкой D1 (читать эпоху в момент отправки) |
| O5 | `markDirtyScene` двигает эпоху **на стадию**; `/regenerate` идёт через Lua `RESET_SCENE_LUA` и её **не** вызывает ⇒ эпоха для regenerate-пути поднимается только внутри диспатча (см. D1) | Думать о единой точке «новая работа запрошена» (book-diff Lua → `markDirtyScene`/эпоха) |

---

# 7. Тестирование

## 7.1 Изоляция (проверено ДО запуска тестов)

* **production PostgreSQL опубликован на `0.0.0.0:5432`** (контейнер `animastor-pg`) ⇒ любой локальный прогон БД-тестов писал бы в production.
* Проверено реальными адресами: `ss -lntp` → `0.0.0.0:5432` (production PG), на `6379` слушателя на хосте **нет** (production Redis не опубликован).
* ⇒ **Все** прогоны выполнялись с `PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1`: БД-зависимые тесты падают по соединению, но физически не могут дойти до production.
* Новые аудит-тесты используют in-memory double Redis + заглушки PG + перехват `global.fetch` ⇒ ни одного сетевого обращения.

## 7.2 Прогоны

| Прогон | Stage 114 (patched) | Stage 115 (audit) | Сравнение |
|---|---|---|---|
| Новый набор патча `tests/gpu-queue-idempotency.test.js` | 22 pass / 0 fail | 22 pass / 0 fail | идентично |
| Полный backend-suite (`tests/**/*.test.js`) | 2612 pass / 28 pending / **85 fail** | **2612 pass / 28 pending / 85 fail** | **множество падений идентично** (`comm` → 0 новых, 0 исчезнувших) ⇒ **0 регрессий** |
| Архитектурные `tests/architecture/*.test.js` | 935 pass / 0 fail | 935 pass / 0 fail | идентично |
| `packages/animastor-orchestration` (`npm test`) | 19 pass / 0 fail | 19 pass / 0 fail | идентично |
| Syntax smoke (`scripts/syntax-smoke.sh backend`) | OK | OK | идентично |
| **Аудит-тесты (новые, изолированные)** | — | `/tmp/opencode/s115/audit-idempotency.test.cjs` — **19/19 проверок** (7 сценариев) | дефекты D1/D2/D4 воспроизведены |

## 7.3 Почему аудит-тесты лежат вне репозитория

Аудит-тесты **документируют текущие дефекты** (они «зелёные» только потому, что утверждают наличие дефекта). Добавление таких тестов в репозиторий оставило бы в CI постоянно «зелёные» тесты, фиксирующие неверное поведение, и замаскировало бы регрессию после исправления. Поэтому они вынесены в `/tmp/opencode/s115/` как **evidence**, а регрессионные тесты, которые должны войти в репозиторий вместе с исправлениями, специфицированы в §8.

---

# 8. Минимальный план исправления (рекомендация)

| # | Дефект | Правка | Файлы | Объём |
|---|---|---|---|---|
| F1 | D1 (+O4) | Читать stage-эпоху **в момент отправки**; убрать заморозку на диспатч (удалить `resolveDispatchEpoch` и семейство `dispatch-epoch` из реестра) | `backend/src/helpers/queue-idempotency.cjs`, `backend/src/runtime/gpu-dispatcher.js`, `backend/tests/architecture/redis-registry.js` | ~15 строк, backend-only |
| F2 | D2 | Освобождать claim **только** при окончательном отказе (HTTP ≥ 400); при сетевой ошибке/таймауте/5xx — **оставлять** claim (короткий отдельный TTL, например 3× таймаут задачи) | `backend/src/runtime/gpu-dispatcher.js` | ~10 строк, backend-only |
| F3 | D4 | Освобождать claim'ы при очистке lane'а: хелпер `releaseClaimsForScene/releaseClaimsForBook` (SCAN по `animastor:idempotency:ref:{book}_{ch}_{sc}_*`) + вызовы в путях отмены/чистки | `backend/src/helpers/queue-idempotency.cjs`, `backend/src/routes/book/generation-routes.cjs`, `backend/src/routes/cache-routes.cjs`, `backend/src/services/book-deletion.cjs` | ~20 строк, backend-only |
| F4 | D3 | **Проверка исполнителя ДО создания lease/dispatch-meta** — в `dispatch-engine.dispatchStage` (пакет `@animastor/orchestration`) через существующий seam-механизм; backend отдаёт реализацию проверки | `packages/animastor-orchestration/**` (bump версии + переиздание) + `backend/src/runtime/orchestration-seams.js` + `backend/src/backend.cjs` | **отдельный этап: переиздание пакета и обновление зависимости backend'а** |
| F5 | O1/O2/O5 | Учесть +19 при первом post-deploy re-dispatch; `WARN` при отсутствии зарегистрированного Redis-клиента; единая точка «новая работа запрошена» (эпоха) вместо Lua-пути `/regenerate` | по итогам F1-F4 | отдельный этап |

**Регрессионные тесты, которые должны войти в репозиторий вместе с F1-F3** (backend/tests, изолированные):

1. `dirty-IU отправляется в том же диспатче после другой отправки ⇒ enqueue разрешён` (закрывает D1).
2. `неоднозначный сетевой сбой ⇒ claim остаётся, повторная отправка подавлена` (закрывает D2).
3. `окончательный отказ (HTTP 4xx) ⇒ claim освобождён` (закрывает D2, вторая сторона).
4. `claim → очистка lane'а → повторный запуск разрешён; claim'ы чужих сцен не тронуты` (закрывает D4).
5. `lease активен ⇒ диспатч не создаётся` (не даёт регрессию F4).
6. `нет исполнителя ⇒ ни lease, ни dispatch-meta, ни записи в журнале не создаётся` (закрывает F4 — требует теста в пакете).

---

# 9. Рекомендация по следующим этапам

| Этап | Содержание | Гейт |
|---|---|---|
| **116** | F1 + F2 + F3 (backend-only) + регрессионные тесты 1-4 ⇒ **новый локальный коммит поверх 8b375dc0** | тесты зелёные, 0 регрессий |
| **117** | F4: capacity-gate в пакете `@animastor/orchestration` (bump версии, переиздание, обновление зависимости backend'а) + тест 5-6 | отдельное решение по публикации пакета |
| **118** | Ревью обоих коммитов → решение о публикации | одобрение владельца |
| **119** | Push/CI/GHCR/deploy + наблюдение: очередь 457→476 (первый re-dispatch) и **дальше без роста**; отсутствие 5-секундного цикла | критерий: журнал/логи не растут |
| **120** | Очистка дублей (Stage 113 §B.6: dry-run → журнал → точечный `LREM` → rollback) — после 119 | отдельное approval |
| **121** | Восстановление workers (Stage 113 §A.5) | `gpus ≥ 1`, очередь убывает |

**Порядок жёсткий:** 116 → 117 → 119 → 120 → 121. Публикация **без** 117 недопустима (D3: цикл 5 с начнётся после ближайшего рестарта backend'а).

---

# 10. Подтверждение отсутствия production-изменений

| Объект | Значение | Ожидаемое | Статус |
|---|---|---|---|
| Redis `dbsize` | 321 | 321 | ✅ |
| ws-lane `queue:image:ws:3317e019…` | 457 | 457 | ✅ |
| глобальная lane `queue:image` | 8 | 8 | ✅ |
| `animastor:idempotency:*` | **0** | 0 (код в production не попадал) | ✅ |
| `animastor:worker:heartbeat:*` | 0 | 0 | ✅ |
| PG `scene_assets` | 459 (437 NULL) | 459 (437 NULL) | ✅ |
| `data/books` inventory sha | `200beb1a…` | `200beb1a…` | ✅ |
| `data/output` inventory sha | `2a03a8c7…` | `2a03a8c7…` | ✅ |
| контейнеры `StartedAt` / `RestartCount` | backend `2026-10-21T13:15:38.819Z`/0, gpu-hub `2026-10-12T13:41:43Z`/0, pg/redis `2026-08-24T16:30:12Z`/0 | те же | ✅ |
| Git | HEAD `8b375dc0`, `origin/main`/`github/main` = `53ce5045` | без изменений (push не выполнялся) | ✅ |
| рабочее дерево | чужие dirty-файлы (`D` + 4 `M` + 2 `??`) | те же, не тронуты | ✅ |
| другие репозитории | gpu-hub / worker / web — чисто | чисто | ✅ |
| генерация / очистка дублей / рестарты | не выполнялись | не выполнялись | ✅ |

**Аудит не менял патч:** `8b375dc0` не переписан, amend не выполнялся; аудит-артефакты — вне репозитория (`/tmp/opencode/s115/`).

---

# 11. Классификация

| Пункт | Класс | Основание |
|---|---|---|
| Diff и архитектура изучены полностью | **CONFIRMED** | §1 |
| Ownership Redis-ключей соответствует правилам | **PASS** | §1.2 (guard-rail проходит) |
| Все пути dispatch используют один формат idem-ключа и корректную каноникализацию | **PASS** | §1.3, §1.4 |
| Атомарность `SET NX` | **PASS** | §3.1 (25 claim'ов → 1) |
| Активный lease защищён; завершённая задача не перезапускается без разрешённого retry | **PASS** | §3.6 |
| Новый `generation_epoch` разрешает легитимный retry | **PASS** | §3.4 |
| Stage-эпоха не подавляет регенерацию другого IU | **PASS** | §2.1 (AUDIT-7) |
| Разные IU / workspace / build / модель / seed / промпт / версия не схлопываются | **PASS** | §2.3 |
| Регенерация dirty-IU на первом attempt подавляется (самовосстанавливается) | **DEFECT D1** (LOW-MEDIUM, self-healing) | §2.2 (AUDIT-1) |
| Неоднозначный сбой POST оставляет дубль | **DEFECT D2** (MEDIUM) | §3.3 (AUDIT-2) |
| Цикл dispatch/cancel каждые 5 с + неограниченный рост журнала | **DEFECT D3** (HIGH) | §5.1 |
| Claim переживает очистку lane'а ⇒ повторный запуск подавлен на 24 ч | **DEFECT D4** (HIGH) | §5.2 (AUDIT-6) |
| Claim блокирует задачу до TTL при crash между claim и POST | **Наблюдение D5** (документировано) | §3.2 (AUDIT-5) |
| Регрессий в репозитории нет | **PASS** | §7.2 (идентичное множество падений) |
| Production не изменён | **PASS** | §10 |
| Публикация патча в текущем виде | **BLOCKED** | D2 + D3 + D4; требуются F1-F4 (§8) |
