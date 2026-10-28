# Stage 126 — GPU result fencing: implementation contract

**Вход:** дизайн [Stage 125](125-gpu-result-fencing-design.md) (атомарный fence для lifecycle result/artifact/completion), фактический код рабочего дерева `main` (HEAD `57c3d58f`) и текущие архитектурные/функциональные тесты.
**Режим:** только анализ и план. Ни один исходник, тест, lockfile, версия, ref, конфигурация, сервис, очередь и продакшен-данные не изменены; коммитов нет.
**Рабочее дерево на момент анализа:** присутствуют незакоммиченные изменения Stage 124 (N1: sweep-before-release в `/regenerate`, `packages/animastor-orchestration/src/runtime/dispatch-engine.js`, `backend/tests/gpu-lane-release-order.test.js`, `backend/tests/architecture/phase5-runtime-result.test.js` и др.), удалён `backend/scripts/audit-orphan-books.js`, незатронутые задачей изменения AI-тестов и untracked `deploy/`. Контракт ниже совместим с ними (как и требовал дизайн 125).

---

## 0. Верификация контракта против фактического кода

### 0.1 Что есть сейчас (проверено по файлам, не по памяти)

| Фаза | Файл / функция (проверено) | Что делает сейчас | Разрыв fence |
|---|---|---|---|
| Identity | `backend/src/helpers/queue-idempotency.cjs:124` `computeIdemKey` | `sha256(workspace\|job_id\|job_type\|build_id\|sha256(canonical(params))\|epoch)`; `dispatch_id` сознательно исключён | Это и есть готовый `fence_id`, но он нигде не объявлен авторитетным для приёма результата |
| Identity | `queue-idempotency.cjs:212` `resolveJobEpoch` (SET NX pin, TTL 24 h), `:175` `bumpStageEpoch`, `:253` `resetJobEpoch`, `:283` `resetJobEpochForStage` | Per-task pinned epoch: первый отправитель пинит; сбрасывается только при смене собственного intent задачи (regen / consumed failure) | Пин живёт в Redis 24 h — единственные «доказательства intent» имеют TTL |
| Dispatch | `packages/animastor-orchestration/src/runtime/dispatch-engine.js:885` `dispatchStage` → `generateDispatchToken()` (`:167`), `createDispatchMetadata` (`:256`), `setDispatchMetadata` (`:273`) | Монетит `dispatch_id` на каждый dispatch; metadata — **одна запись на (book,chapter,scene,stage)**, перезаписывается новым dispatch, удаляется при finalize | Нет immutable-квитанции dispatch→fence: поздний callback вида «dispatch X → idem Y» ничем не подкреплён |
| Identity check | `dispatch-engine.js:287` `verifyDispatchIdentity` | Сравнивает `dispatch_id` callback с **текущим** dispatch metadata сцены/стадии | Это проверка «dispatch-а», не «intent-а»: новая регенерация валидна по phase, старый fence — не опознаётся |
| Send | `backend/src/runtime/gpu-dispatcher.js` `sendUnified`: executor gate → `resolveJobEpoch` → `computeIdemKey` → `guardEnqueue` (`queue-idempotency.cjs:556`) → `rememberTaskRef` (`:398`) → 3× POST `/task` с классификацией definitive/ambiguous → `releaseTask`/`shortenClaimTtl` | Claim `animastor:idempotency:claim:{fence}` (24 h / 90 min ambiguous), ref `…:ref:{book}:{ch}:{sc}:{job}` → fence (mutабельный job_id→idem_key) | ref перезаписывается при новом send (`SET EX`, не NX) — не может служить receipt; receipt до POST не пишется |
| Hub POST | `backend/node_modules/@animastor/gpu-hub/gpu-hub.js:~770-849` (`jobDedupKey`, lpush в lane), `:1157-1171` (callback envelope) | Envelope callback собирается явно: `{job_id, build_id, dispatch_id, protocol_version, result_base64, worker_id, workspace_id}` — лишние поля **не прокидываются** | Протокол v2 заморожен (`packages/animastor-contracts/src/job-protocol-v2.js:23`, `RESULT_ENVELOPE_REQUIRED_FIELDS`), поэтому fence в callback требует изменения hub/contracts. Контракт ниже решает это серверным lookup'ом receipt |
| Hub handoff | `gpu-hub.js:1114` — при неудачной доставке hub пишет `animastor:result:{build}:{book}:{ch}:{sc}:{type}` (TTL 1 h, ownership: gpu-hub, `tests/architecture/redis-registry.js:90`) | Результат доживает до reconciliation | Recovery-ключи несут dispatch_id (см. ниже), но не fence |
| Result route | `backend/src/routes/generation-routes.cjs:424` POST `/gpu/task/result`: валидация envelope → workspace re-verify → `verifyDispatchIdentity` → **stale-исключение audio/video по FSM phase** (`:470-489`) → dedup `resultDedupKey(job_id, build_id)` SET NX EX 3600 → `handleTaskResult` → `readTaskRef` → `settleCompletedTask` (`:540`) | Stale audio/video принимаются лишь на основании FSM phase `WAITING_CHUNKS/MERGING` | Принимается результат **чужого intent**; settlement читает mutable ref уже **после** записи файла |
| Task handler | `backend/src/services/task-handler.cjs:26` `handleTaskResult`: повторный `verifyDispatchIdentity` (`:33`) + stale-исключение (`:42-61`), `resolveAssetPath` (`:69`), **`fs.writeFileSync(asset.fullPath, …)` (`:87`) в canonical path до какого-либо commit** | Канонический файл перезаписывается синхронно; затем iu-registry/iu-progress/`completeStage`, chunk metadata/`audioOrch.completeChunk`, `videoOrch.completeGroup` | Ключевой TOCTOU: файл уже опубликован до settle/CAS; перезапись canonical до проверки fence запрещена требованием 3 |
| Completion | `packages/animastor-orchestration/src/orchestration/orchestrator.js:84` `completeStage`: `verifyDispatchIdentity` (`:106`) → handler (`scene-callbacks.js`) → version gate → `persist('sceneAssets.markReady')` (`:193`) → READY → `finalizeDispatch` | PG-проекция безусловная | `markReady` = unconditional upsert (`backend/src/storage/postgres/repositories/scene-assets-repo.js:251`); нет поля `generation_fence` |
| Settlement | `queue-idempotency.cjs:529` `settleCompletedTask`: extend/ref-repair → verify ref == idem → `markTaskDone` → `releaseTask` | Реф «чинится» из job_id (route: `settled.refRepaired`) | Повреждает старый ref; не доказывает текущий intent |
| Orphan | `queue-idempotency.cjs:497` `releaseTaskDoneIfOrphan` — вызовы: `backend/src/image/iu-processor.js:343`, `backend/src/audio/generation.js:347,560`, видео через `backend/src/storage/runtime-persistence-adapter.js:224` | На send-пути при `already_completed` удаляет done-маркер и ретраит один раз | Удаление маркера по ответу, без сравнения с текущим fence; гонка «completion между probe и release» |
| Bulk release | `queue-idempotency.cjs:805/817` `releaseClaimsForScene/Book` → `:827` `releaseClaimsByPrefix` | prefix-scan по ownership-ключам | Не требует текущего fence; применим только после intent-инвалидации |
| Regenerate (N1) | `backend/src/routes/book/generation-routes.cjs:649-690` (незакоммиченный Stage 124): hubCancel-порт `hubCancelOp('clearHubDispatches')` book-scoped sweep **до** `releaseClaimsForScene`, fail-closed throw → claims retained | Подтверждает sweep-before-release | Fence-совместим: заменяет слепой release на `releaseFenceIfCurrent(oldFence)` |
| Recovery | `packages/animastor-orchestration/src/runtime/reconciliation-engine.js:1826` `recoverResultKeys`: скан `animastor:result:*`, **требует buildId+dispatchId** (legacy без — skip, fail-closed), `TERMINAL_REJECTIONS` удаляет ключи при `no_active_dispatch/stale_dispatch/missing_dispatch_id/...` | Уже частично fail-closed | Нет fence/receipt; «stale_dispatch» здесь означает потерю легитимного позднего чанка той же генерации |
| Legacy recovery | `backend/src/services/audio-recovery.cjs:85,166` вызывают `handleTaskResult(job_id, …, build_id)` **без dispatch_id** | Сейчас de-facto падает в `missing_dispatch_id` (error ловится вызывающим) | Должен стать явным fail-closed или получить receipt-lookup по job_id (см. §2, риск R4) |
| TTL | `queue-idempotency.cjs:56-92`: claim 24 h, ambiguous 90 min, done 7 d, ref 24 h / ref-done 7 d, job-epoch 24 h, stage-epoch 30 d | — | Истечение ref/claim/done может убрать единственное различие «старый результат vs текущий retry» |

### 0.2 Что проверено по тестам (базовый замер, эта сессия)

- `cd backend && npx mocha --exit tests/architecture/*.test.js` → **935 passing / 24 pending / 0 failing**. Замечание Stage 125 о двух failing-ах (`assistant-package-boundary`, `phase10d` — `npm pack --json` с пустым stdout) в текущем worktree **не воспроизводится**: зелёный.
- `npx mocha --exit tests/gpu-queue-idempotency.test.js tests/gpu-lane-release-order.test.js tests/dispatch-meta-lease-lifecycle.test.js tests/markready-build-id-idempotency.test.js` → **111 passing**.
- Ограничения среды (из Stage 125, применимы и сейчас): изолированные TCP-listener'ы дают `listen EPERM`; полноценные интеграционные сетевые варианты требуют окружения с разрешёнными listener'ами и заведомо недоступными `127.0.0.1:1` для PG/Redis. Не использовать прод как подмену.
- Тестовая инфраструктура под fencing: in-memory `FakeRedis` (например `backend/tests/gpu-queue-idempotency.test.js:29`) умеет `SET NX/XX EX`, сканы и **`eval` со снiffer'ом скрипта** (эталон паттерна: `backend/tests/happy-path.test.js:351` — распознаёт конкретный Lua по подстрокам и эмулирует). Новый CAS-Lua должен добавить эмуляцию в FakeRedis по тому же сигнатурному паттерну.

### 0.3 Архитектурные тесты, ограничивающие контракт (сверено)

| Тест | Что замораживает | Последствие для контракта |
|---|---|---|
| `backend/tests/architecture/redis-registry.js` + `redis-ownership.test.js`, `phase2-redis-ownership-contract.test.js` | Каждое семейство `animastor:*` обязано быть зарегистрировано (owner/readers/writers); `animastor:idempotency:*` уже зарегистрировано | Новые семейства `animastor:intent:*`, `animastor:dispatch-intent:*`, `animastor:artifact-manifest:*`, `animastor:outbox:*` — обязательная регистрация (owner: backend) |
| `gpu-hub-contract.test.js`, `phase10a-gpu-hub-contract-freeze.test.js`, `phase2-hub-worker-boundary.test.js` | Route surface hub + `protocol_version=2` + точный набор полей envelope (deep-equal в `packages/animastor-contracts/tests/job-protocol-v2.test.cjs:286-287`) | **v1 fencing не меняет протокол**: fence в callback не добавляем; hub остаётся нетронутым |
| `phase5-runtime-result.test.js` (в worktree изменён) | Правила boundaries пакета runtime (хост-require, barrel удалён — guard вакуумно-верный) | Fence-логика, нуждающаяся в Redis+FS, живёт host-side (`queue-idempotency.cjs` / services) или в `@animastor/orchestration`; не в `runtime/` пакета |
| `o9-hub-cancel-port.test.js` | HubCancel-порт не знает endpoint/`fetch`/`HUB_URL` | Sweep-before-release остаётся на текущем порте; fencing меняет только что удаляется после sweep |
| `data-path-literals.test.js` | Запрет литералов `/data/output`, `/data/books` вне `runtime-config.js` | Staging-пути выводить только из `config.OUTPUT_DIR` (`backend/src/config/runtime-config.js:80`) |
| `markready-build-id-idempotency.test.js`, `null-duplicate-self-heal.test.js`, `synthetic-null-recreation-fix.test.js` | Upsert-семантика `scene_assets`, NULL-build_id дубликаты, concurrent markReady = 1 row | Условный (fenced) upsert обязан сохранить эти инварианты: один row на ключ, идемпотентный повтор, NULL-build legacy |
| `gpu-lane-release-order.test.js` (worktree, Stage 122/124) | Порядок sweep→release в cancel/cache/delete/regenerate; N1: неудачный sweep → claims retained | Fence-release вписывается в этот порядок: intent supersede → sweep (подтверждён) → `releaseFenceIfCurrent` |
| Сборочная инфраструктура | `backend/package.json`: `@animastor/orchestration ^0.1.4` — **обычная копия в `backend/node_modules` (не symlink), сейчас байт-в-байт идентична `packages/animastor-orchestration/src`** (diff пуст, версии 0.1.4=0.1.4); автоматической синхронизации в репозитории не найдено | Любое изменение orchestration требует ручной синхронизации/публикации + bump зависимость — это и есть ворота 3–4 (§8); тесты backend видят именно node_modules-копию |

**Вывод раздела:** выбранный контракт (§1–§7) опирается на существующие primitive'ы (`computeIdemKey`, `resolveJobEpoch`, claim/done/ref, N1 sweep, version gate, FakeRedis+Lua) и не требует ни изменения hub-протокола, ни purge-очередей; конфликтующих с тестами решений нет, но требуются регистрация новых Redis-семейств и условный PG-upsert, сохраняющий инварианты Stage 66/76.

---

## 1. Identity: поля fence и receipt, уникальность

### 1.1 Fence

`fence_id` := **существующий** `idem_key` (`computeIdemKey`, `queue-idempotency.cjs:124`), состоящий ровно из:

```
fence = sha256( workspace_id | job_id | job_type | build_id | sha256(canonicalJson(params)) | pinned_epoch )
```

- `workspace_id` — server-derived (PW-2, `gpu-dispatcher.js` `resolveWorkspaceForBook`); null → пустая строка.
- `job_id` — стабильный логический id задачи, грамматика `runtime/job-schema.js` (`parseJobId`): книга/глава/сцена/юнит|чанк|группа + тип. Разные задачи → разные `job_id` → разные fence.
- `build_id`, `params` (input version), `pinned_epoch` (`resolveJobEpoch`, SET NX) — как в коде.

Не вводим `generation_id` в v1 (опакационный коррелятор — только если операторский аудит его потребует): минимум изменений.

### 1.2 Новые записи (data model)

| Запись | Ключ (владелец: backend; **регистрация в redis-registry обязательна**) | Значение / TTL | Назначение |
|---|---|---|---|
| Текущий intent | `animastor:intent:{enc(book)}:{enc(chapter)}:{enc(scene)}:{enc(jobId)}` (encodeKeyComponent, `queue-idempotency.cjs:148`) | JSON `{ fence, epoch, state: active\|cancelled\|superseded, supersedes: prevFence\|null, updated_at }`; TTL = максимум из (done TTL 7 d, job-epoch 24 h) + запас, освежается при claim refresh; **не 24 h** | Единственный authority «какой fence текущий» |
| Dispatch receipt (иммутабельный) | `animastor:dispatch-intent:{dispatch_id}:{enc(jobId)}` | plain fence; `SET NX` (при конфликте — fail-closed); TTL ≥ max(hub result retention 1 h, ambiguous claim 90 min, reconciliation result TTL 1 h) → принять **48 h** | Маппинг callback `(dispatch_id, job_id)` → fence |
| Claim / done / ref | как сейчас (`animastor:idempotency:claim|done|ref:…`) | текущие TTL | unchanged, кроме §3 (release только свой fence) |
| Manifest публикации | `animastor:artifact-manifest:{book}:{ch}:{sc}:{enc(jobId)}` | JSON `{ published_fence, path, build_id, bytes, published_at }`; durable (без TTL) | Указатель «что сейчас читать» |
| Completion journal / outbox | `animastor:fence-journal:{book}:{ch}:{sc}:{jobId}:{fence}` (+ PG- outbox-строка) | идемпотентная запись `(job, fence)`; TTL 7 d | Перезапуск/реплей проекции |

### 1.3 Уникальность между задачами / стадиями / попытками / новым intent

- **Задачи и стадии**: различие внутри `job_id` (юнит/чанк/группа/тип) — fence различается по построению.
- **Повторный dispatch, restart, recovery той же логической задачи**: `dispatch_id` меняется каждый раз (`dispatchStage:891` `generateDispatchToken`), но исключён из fence; первый send пинит epoch (`resolveJobEpoch`), последующие send/re-dispatch читают тот же pin → **тот же fence**; `guardEnqueue` держит один claim; оба receipt'а (два dispatch_id) валидны и указывают на один fence.
- **Повторная попытка с новым intent** (consumed failure: `/gpu/task/error` → `releaseTask`+`forgetTaskRef`+`bumpStageEpoch`+`resetJobEpoch`, `generation-routes.cjs` error-хендлер; dirty-unit regen: `iu-processor.js:~250-270`; stage-regen: `resetJobEpochForStage`): pin сброшен → новый epoch → **новой fence**. Это оправданные новой генерации случаи.
- **Explicit regenerate** (`/regenerate` → `resetScenes` + release): до enqueue **обязательно** перевести intent в `superseded` и записать новый fence (§4) — иначе старый результат валиден для нового dispatch.

### 1.4 Почему повторный dispatch — не новая генерация, а регенерация — новая

Логическая задача = `(job_id, input version, pinned epoch)`. Re-dispatch существует только потому, что `dispatch_id` детерминированно непригоден как idempotency-dimension (hub dedup `animastor:job:{dispatch_id}:{job_id}` — цитата из шапки `queue-idempotency.cjs`); он меняется при каждом `dispatchStage` при неизменном содержании работы. Fence намеренно построен от контента и закреплённого epoch, поэтому re-dispatch получает тот же fence, один claim и одну публикацию. Регенерация же — это **смена содержания работы** (новый epoch через `bumpStageEpoch`/`resetJobEpoch*`); новый epoch меняет fence по построению, и старый fence становится `superseded` и не может опубликоваться. Иными словами: fence — это не «попытка», а «версия намерения генерации».

### 1.5 Создание receipt'а и intent'а (Send)

В `gpu-dispatcher.js` `sendUnified`, между `rememberTaskRef` и первым POST (текущие строки ~300-310):

1. `ensureIntent(job, fence, epoch)` — Lua/атомарно: либо intent уже `{state:active, fence}` (тот же intent — ок), либо отсутствует → создать active; **state ≠ active или другой fence → отказ `intent_superseded`** (send не идёт).
2. `writeDispatchReceipt(dispatch_id, job_id, fence)` — `SET NX`; существующее значение ≠ fence → fail-closed (никогда не перезаписывать immutable receipt).
3. Далее `guardEnqueue`/`rememberTaskRef` как сейчас. При **definitive rejection** POST освобождается только `claim:{fence}` (при совпадении receipt/intent); при ambiguous — claim остаётся (текущая классификация Stage 118 B2 сохраняется). Receipt не удаляется (пусть живёт TTL).

---

## 2. Result contract: что обязано приходить, как обрабатываются legacy/stale/duplicate/malformed/unknown

### 2.1 Обязательные идентификаторы callback

Замороженный контракт (`packages/animastor-contracts/src/job-protocol-v2.js`, hub собирает envelope в `gpu-hub.js:1157`):
`job_id`, `build_id`, `dispatch_id`, `protocol_version===2`, `result_base64` (+ audit-only `worker_id`, `workspace_id`).

**Fence в callback не требуется и не добавляется в v1** (иначе — hub bump + protocol bump + замораживающие тесты). Backend резолвит fence сам: `receipt = GET animastor:dispatch-intent:{dispatch_id}:{job_id}`. Опционально на будущее: необязательный `fence` echo в v2.1 — вне объёма v1.

### 2.2 Приём результата (порядок операций в `/gpu/task/result`, заменяющий текущий блок `generation-routes.cjs:443-567`)

1. Валидация envelope (без изменений, 400 при отсутствии полей; unparseable `job_id` → 400/`ignored`).
2. Workspace re-verify + `persistTaskClaim` (PW-2, без изменений).
3. **Fence admission** (заменяет `verifyDispatchIdentity`-как-единственный-гейт и stale-исключение по phase):
   - receipt есть → `fence`; читаем intent: `state==active && fence==fence` → **accept** (даже если dispatch устарел — это поздний чанк той же генерации; закрывает легитимный batch/recovery-ordering, который сейчас защищён исключением `WAITING_CHUNKS/MERGING`);
   - receipt есть, intent не active или fence другой → **`stale_intent`**: ответ `{ok:true, rejected:true, reason:'stale_intent'}`, async-удаление только staged-файлов этого fence, никакого touches текущего состояния;
   - receipt нет → режим (см. §5/§6): `observe` — текущее консервативное поведение; `enforce` — **`legacy_no_receipt`**: ответ `{ok:true, rejected:true, reason}`, результат кладётся/остаётся в hub-owned `animastor:result:*` (hub уже положил его при неудачной доставке) — reconciliation решает позже; **никогда не вызывать `handleTaskResult`**;
   - неизвестный/испорченный → 400.
4. Dedup: `resultDedupKey(job_id, build_id)` SET NX EX 3600 (существующий, dispatch-independent by design) — **только после** fence admission; при исходе `handleTaskResult` ошибка → удалить dedup-ключ (как сейчас, `generation-routes.cjs:~560`).
5. `handleTaskResult` → staged-запись + CAS-коммит (§3). Возврат `committed | duplicate_same_fence | stale_intent`.
6. Вместо `settleCompletedTask` — CAS-скрипт уже выставил done/claim/manifest (§3); legacy `settleCompletedTask` остаётся только для observe-режима.

### 2.3 Гарантии обработки

| Случай | Поведение (обязательно идемпотентно, повтор безопасен) |
|---|---|
| **Legacy callback без receipt** | observe: как сегодня; enforce: fail-closed `legacy_no_receipt`, без записи canonical и без вызова handler'а (см. тест 9 в §7) |
| **Stale** (receipt ≠ текущий fence или intent terminal) | `{ok:true, rejected:true, reason:'stale_intent'}`; async-GC только staged этого fence; done/manifest/PG не трогаются |
| **Duplicate** (повторная доставка того же результата) | dedup → `{ok:true, deduped:true}`; если dedup истёк — CAS вернёт `duplicate_same_fence` (done NX) → один и тот же ответ, повторная публикация невозможна |
| **Malformed** | 400 (shape) или `ignored` (не парсится job_id) — как сейчас |
| **Неизвестный результат** (нет receipt, нет intent, нет job) | enforce: fail-closed; reconcile-очередь; никогда не публикуется |
| `/gpu/task/error` | та же receipt-admission: применять `failStage` и consumed-failure epoch bump только при `receipt.fence == intent.fence == active`; иначе отклонить (закрывает «поздний error сбивает новый dispatch») |

---

## 3. Artifact publication: staging, атомарность, CAS, порядок manifest/PG, ошибки

### 3.1 Staging-пути (конкретные имена)

Деривировать только из `config.OUTPUT_DIR` (гейт `data-path-literals`; новых литералов нет):

```
{OUTPUT_DIR}/{build_id}/.staging/{job_id}/{fence}/artifact.tmp   → rename → artifact.{png|mp3|mp4}
```

- image (IU): `{job_id} = {iuAssetId}:iu_image` — одна staged-директория на IU-fence.
- audio per-segment: `{chunkId}:audio` — **per-chunk fence-директории**; сцена-аудио-манифест (§3.4) хранит набор fence-путей чанков, merge читает только из манифеста.
- video: `{sceneAssetId}[_gN]:video` — per-group fence-директории; merge групп — только группы, чьи fence входят в текущий scene/video intent манифест.

Canonical path (`resolveAssetPath`, `cleanup-service.cjs:125`) в staging-режиме **не пишется** до публикации (сейчас запрещено требованием «нельзя публиковать до проверки fence»; нарушитель — `task-handler.cjs:87` — переносится в staged-ветку).

### 3.2 Атомарность

1. `fs.writeFileSync(fenceDir/artifact.tmp, buf)` → `fsyncSync(fd)` (открытый файл) → `fsyncSync(dirfd)` директории fence после rename.
2. Rename **внутри той же fence-директории** (та же FS — атомарно).
3. Минимальная валидация буфера (magic bytes PNG/ID3-MP3/ftyp-MP4; нулевой буфер — ошибка, не «успех»; сейчас 0-байт файл просто пишется — `task-handler.cjs:~80`).

### 3.3 CAS-коммит (одна атомарная операция, Redis Lua — авторитет)

Скрипт `fenceCommit(redis, KEYS=[intent, receipt, ref, claim, done, manifest, journal], ARGV=[fence, stagedRelPath, stagedMeta, expectedEpoch])`:

1. `GET intent` → JSON; require `state=='active' && fence==ARGV.fence` (иного — вернуть `stale_intent`);
2. `GET receipt` == fence (нет/другой — `stale_intent`);
3. `GET ref(job)` == fence (при отсутствии — **не чинить вслепую** (в отличие от `settleCompletedTask:529`), а требовать совпадения либо отсутствия; расхождение → `stale_intent`);
4. `GET done:{fence}`: существует → вернуть `duplicate_same_fence` (и ничего не менять);
5. записать manifest `{published_fence: fence, path: stagedRelPath, meta}` (SET);
6. `SET done:{fence} 1 EX 7d`;
7. `DEL claim:{fence}` — **только этот** claim, никогда производный от более позднего ref;
8. append journal `(job, fence)` (идемпотентно);
9. вернуть `committed`.

Правила исхода:
- `committed` → затем асинхронно: условная PG-проекция (§3.5) и удаление staged-файлов прошлых fence'ов этой задачи (не текущего).
- `stale_intent` → async-GC только свои staged-файлы; **никаких** изменений canonical/ready/progress/chunk-metadata/video-group/PG (список из дизайна §Result acceptance — проверен против `task-handler.cjs:95-230`, всё это сейчас происходит до settle).
- `duplicate_same_fence` → удалить свой staged (байты уже опубликованы), ответ дедуплицирован.
- Ошибка Redis во время CAS → **неудачный/неопределённый commit = не успех**: staged остаётся, claim/receipt остаются, ответ не `ok`; reconciler идемпотентно повторяет CAS для `(receipt, fence)` (перезапуск между staging и CAS — ровно этот случай).
- Ошибка fsync/rename/валидации → CAS не вызывается, claim живёт (retryable по текущей таксономии), staged чистится.

### 3.4 Дurable manifest и читатели

- Redis-манифест `animastor:artifact-manifest:…` — authority «что опубликовано»; PG `scene_assets` — проекция.
- Читатели (плеер/export/cleanup): новая функция `resolvePublishedArtifact(...)` — сначала манифест; манифеста нет (legacy) → текущий canonical путь **без изменений** (совместимость чтения старых артефактов, §5).
- `completeStage` (orchestrator.js:84) продолжает верифицировать артефакт, но путь берёт из результата staged/CAS, а не из преждевременной canonical-записи; version gate (T1.11 fail-closed) остаётся как есть.

### 3.5 PG-проекция (условная, не безусловный markReady)

Миграция: `ALTER TABLE scene_assets ADD COLUMN generation_fence TEXT NULL` (+ аналогичное поле в metadata image_units, если требуется для IU-аудита). Затем новый условный upsert `markReadyFenced(bookId, chapterId, sceneId, assetType, path, fence)`:

- `UPDATE scene_assets SET path=$path, status='ready', generation_fence=$fence … WHERE key AND (generation_fence IS NULL OR generation_fence <= $fence …)` — но т.к. fence — это не нумерика, а производная epoch+input, корректная форма: `WHERE key AND (generation_fence IS DISTINCT FROM $fence)` + `ON CONFLICT (book,chapter,scene,asset_type,build_id) DO UPDATE … WHERE scene_assets.generation_fence IS NULL OR scene_assets.generation_fence = $fence` (идемпотентный повтор того же fence — одна строка, инварианты `markready-build-id-idempotency.test.js` сохраняются; NULL-дубликаты не плодятся — см. инварианты Stage 75/76 в `scene-assets-repo.js`).
- Двойная запись: после Redis-CAS кладётся outbox-задача (`generation_fence`, path); реплей идемпотентен. Redis-flush → PG перестаёт быть authority? Нет: PG-строка с `generation_fence` — свидетельство публикации, но «current» определяет Redis-intent/манифест; при утрате Redis — fail-closed до пересоздания intent первым send (§6).
- **Никакого безусловного `markReady` после fenced-коммита** — флагом режима выбирается одна ветка, не обе.

### 3.6 Обработка ошибок (сводная)

| Отказ | Результат |
|---|---|
| fsync/rename/валидация | нет CAS, staged удалён/лежит до GC, claim остаётся, retry по таксономии |
| Redis недоступен на CAS | staged + claim + receipt остаются; reconciler повторяет; success не возвращается |
| Lua вернул `stale_intent` | terminal для этого результата: не retry, не publish |
| PG условный update conflict/failure | Redis уже committed; outbox ретраит; READY не теряется и не дублируется |
| Hub sweep упал (N1) | claims/intent остаются; повтор sweep идемпотентен |

---

## 4. Concurrency-матрица (обязательные исходы)

| Сценарий | Исход (с якорями текущего кода) |
|---|---|
| **cancel vs result** | Сначала атомарно перевести intent `active→cancelled` (новый helper `supersedeIntent(oldFence,'cancelled')`), затем существующая очистка (`generation-routes.cjs` cancel-хендлер ~277-365: orphan GENERATING sweep + release + post-release sweep Stage 120 M-b). Результат, пришедший до или после Hub-sweep'а, видит не-active intent → `stale_intent`, публикация невозможна. Результат успел закоммититься первым → cancel удаляет только тот терминальный fence (по user-intent), не смешивая с новым. |
| **regenerate vs result** | `/regenerate` (`book/generation-routes.cjs:649-690`, Stage 124): **до** hubCancel-sweep — `supersedeIntent(oldFence,'superseded')`; после подтверждённого sweep — `releaseFenceIfCurrent(oldFence)` вместо слепого `releaseClaimsForScene→releaseClaimsByPrefix` (тот же порядок sweep→release, что закреплён `gpu-lane-release-order.test.js:455-470`). Старый staged/поздний результат → CAS fail, canonical/manifest не перезаписываются. На ошибке sweep — claims+intent старого fence сохраняются (как сейчас: throw → claims retained). |
| **Два параллельных dispatch одной задачи** | Один claim (`guardEnqueue` SET NX), один Hub-вход; оба receipt'а указывают на один fence; результаты в любом порядке → ровно один `committed`, второй `duplicate_same_fence`. |
| **Два dispatch разных intent'ов** | Разные fence; старый receipt не может опубликоваться (intent.fence другой); старые done/claim не влияют на новый. |
| **Timeout после приёма Hub** | Ambiguous classification Stage 118 B2 (`gpu-dispatcher.js`): claim остаётся (90 min TTL), receipt уже записан до POST → поздний результат резолвится; re-dispatch той же задачи подавлен тем же fence'ом. |
| **Рестарт между staging и CAS** | Staged-файл на диске, commit'а нет; reconciler (`recoverResultKeys`, reconciliation-engine.js:1826) находит hub-handoff ключ, резолвит receipt→fence, провалидирует staged и запускает тот же условный CAS; либо GC как мусор. Никакой автокоммит по факту существования файла. |
| **Повторная reconciliation** | CAS идемпотентен (`duplicate_same_fence`), outbox-проекция идемпотентна (conditional update), `TERMINAL_REJECTIONS` удаляет только terminally stale ключи — расширить список причиной `stale_intent`, чтобы не крутить 1 h цикл. |
| **TTL-истечения** | Истечение claim/ref/done/receipt **не может** превратить старый результат в текущий: authority — intent (7 d+); истёкший receipt → `legacy_no_receipt`/quarantine, не публикация. Новый send при живом active intent допустим (как сейчас: TTL лишь разрешает новую отправку того же fence). |
| **Гонка «completion между probe и orphan-release»** | Текущий inline `releaseTaskDoneIfOrphan` (+retry once: `iu-processor.js:343`, `audio/generation.js:347,560`, persistence-port 224) **удаляется**: на send-пути `already_completed` при живом манифесте того же fence = успех (короткий circuit); при отсутствии манифеста — отдельный repair-intent (новая генерация, новый fence), а не удаление маркера. Точка TOCTOU исключена тем, что решение принимает CAS, а не existence-probe. |

**Доказательство отсутствия TOCTOU (по построению):** единственные изменения, зависящие от fence, происходят внутри одного Lua-скрипта по текущим значениям Redis; файловые байты до коммита не видны читателям (canonical не трогается), после — публикуются только из staged директории текущего fence. Ни один `fs.existsSync`/`fs.unlink` не участвует в решении о публикации.

---

## 5. Migration: без массового перемещения файлов и без очистки очереди (457/438)

Очередь Hub (те самые 457 записей = 19 логических задач / 438 дубликатов — история из `gpu-queue-idempotency.test.js:1-10`) **не трогается**: fence — backend-side, hub и lane-формат не меняются; lane-входы несут `dispatch_id`+`job_id`, которых достаточно для receipt-резолва.

1. **Фаза 0 (additive):** миграция PG (`generation_fence` nullable, без backfill), новые Redis-семейства (+регистрация в `redis-registry.js`). Старые строки/ключи = `legacy`, остаются читаемыми.
2. **Фаза 1 (dual-write, mode=observe):** каждый новый send пишет intent + receipt; callback-обработка прежняя; читатели сначала смотрят манифест, при отсутствии — canonical (старые артефакты читаются ровно как сейчас; **никакого mass-move файлов** — staged появляется только для новых результатов).
3. **Фаза 2 (mode=enforce)** — только после окна, когда у **каждого живого** dispatch есть receipt: окно = max(TTL claim 24 h, ambiguous 90 min) + margin ⇒ **≥ 48 h простоя observe перед включением** (критерий измерим: метрика `legacy_no_receipt` == 0 за 24 h).
4. **Legacy `already_completed` без артефакта:** не удалять маркер (текущий `releaseTaskDoneIfOrphan` удалял — это запрещено новым контрактом); вместо этого repair-intent через обычный regenerate-путь (новый fence; legacy-маркер безвреден до 7 d TTL).
5. **Staging orphan GC:** удалять `.staging/{job}/{fence}/*` только когда `(fence ≠ текущий intent.fence) AND (age > 24 h)` (24 h > 1.5×самого длинного job timeout 60 min); опубликованный fence никогда; запуск из reconciliation/retention (шаблон `entity-cleanup.cjs`), идемпотентно.
6. **Ничего не дренировать:** без queue-drain, без глобального сброса claim, без Redis-flush. Restart перечитывает durable intent/манифест; отсутствующий receipt → fail-closed/reconcile.

---

## 6. Rollback

- **Kill-switch:** `GPU_FENCING_MODE=off|observe|enforce` в `runtime-config.js` по образцу `shareFeaturesEnabled()` (`runtime-config.js:246`). Все новые ветки — аддитивные; `off` = байт-в-байт текущий путь (`verifyDispatchIdentity` + stale-исключение + прямая canonical-запись + `settleCompletedTask`).
- **`off` не принимает stale results хуже сегодняшнего:** гейт dispatch-identity остаётся; ничего из нового не ослабляет существующие проверки (admission только добавляет условия).
- **Не терять опубликованное:** canonical-файлы никогда не удаляются откатом; манифест игнорируется в `off`; `generation_fence` в PG остаётся (nullable, читается как обычный path); staged-файлы уходят GC по retention, а не по откату.
- **Откат деплоя (предыдущий образ) безопасен** — формат данных аддитивен (нет переименований, нет purge); legacy-читатели игнорируют новые записи.

---

## 7. Tests (конкретные)

Транспорт: mocha+chai+proxyquire, FakeRedis (добавить в `gpu-queue-idempotency.test.js:29`-стиль `eval`-снiffer для `fenceCommit` по образцу `happy-path.test.js:351`). Новые файлы:

1. `backend/tests/gpu-result-fencing-identity.test.js`
   - re-dispatch новым dispatch_id → тот же fence/один claim/подавление; restart+re-dispatch → тот же fence;
   - consumed failure / dirty-unit regen / stage-regen (`resetJobEpochForStage`) → новый fence; sibling-unit regen не двигает пин соседа;
   - immutable receipt: повторный write с другим fence → fail-closed.
2. `backend/tests/gpu-result-fencing-publication.test.js` — **image / audio / video**: dispatch A → пауза после staged-записи → supersede to B → resume A: A не публикует байты, не двигает ready/progress/chunk-metadata/video-group/PG, не трогает claim/done B (файловая проверка через подменённый `fs`/tmpdir).
3. `backend/tests/gpu-result-fencing-cas.test.js` — Lua-семантика через FakeRedis-эмуляцию: `committed`, `duplicate_same_fence` (done NX), `stale_intent` (intent/receipt/ref три варианта), отказ claim'а другого fence; PG-условный upsert: повтор/concurrent → 1 row (сверить с инвариантами `markready-build-id-idempotency.test.js`).
4. `backend/tests/gpu-result-fencing-concurrency.test.js` — cancel-vs-result и regenerate-vs-result на **каждой** границе: до staging / после staging до CAS / после CAS до PG-проекции / после проекции; два параллельных send одного fence; повторная reconciliation; TTL-истечение claim/ref/done/receipt по отдельности.
5. `backend/tests/gpu-result-fencing-restart.test.js` — рестарт между staging и CAS (reconciler завершает условным CAS), рестарт после commit до PG (outbox-реплей идемпотентен), Redis-недоступность на CAS (нет success, staged+claim сохранены).
6. `backend/tests/gpu-result-fencing-legacy.test.js` — callback без receipt: observe = текущее поведение; enforce = `legacy_no_receipt`, **assert: `taskHandler.handleTaskResult` не вызван, canonical не записан**; legacy `already_completed` без манифеста → repair-intent, маркер не удалён; `audio-recovery.cjs:85,166` — явный fail-closed (или receipt-lookup после решения R4).
7. `backend/tests/gpu-result-fencing-hub.test.js` — Hub partial failures на базе `gpu-lane-release-order.test.js`: неудачный book-sweep → claims+intent целы, повтор идемпотентен; успешный повтор суперседит только точный старый fence; ambiguous POST → claim+receipt сохранены.
8. `backend/tests/gpu-result-fencing-toctou.test.js` — доказательство: интреплированная гонка «probe→commit→resume» (сценарий 2) + одновременные CAS двух fence'ов → ровно один winner; отсутствие любых existence-check'ов в решении о публикации (grep-gate по source: в fenced-ветке запрещены `existsSync`/`exists(` как предикат коммита).
9. **Регрессия поздних чанков** (в `gpu-result-fencing-concurrency.test.js` или отдельно): stale dispatch того же fence принимается при `WAITING_CHUNKS/MERGING`; stale dispatch **старого** fence отклоняется **даже** при `WAITING_CHUNKS/MERGING` (прямая замена исключения `task-handler.cjs:42-61` / `generation-routes.cjs:470-489`).
10. Архитектурные обновления: `redis-registry.js` (+4 семейства), `phase2-redis-ownership-contract` (если пиннит список), `phase5-runtime-result`/`generation-package-boundary` при добавлении файлов в пакет/хост, `data-path-literals` (нет новых литералов). `gpu-hub-contract`/`phase10a` — без изменений (протокол не меняется).
11. Интеграционные варианты (реальный Redis Lua + рестарт) — отдельным сьют-файлом с gating на разрешённые listener'ы (см. ограничения среды §0.2); в песочнице — skipped, не deleted.

---

## 8. Rollout gates (раздельные этапы с PASS/FAIL)

| # | Этап | PASS | FAIL → действие |
|---|---|---|---|
| 1 | Локальные тесты | `bash scripts/syntax-smoke.sh`; `cd backend && npm test` и `npm run test:arch` без новых падений относительно базы **935 passing / 24 pending / 0 failing** (замер этой сессии) и **111 passing** целевых сьютов; пакетные тесты `packages/animastor-orchestration` | Любое новое падение → не идти дальше |
| 2 | Независимый аудит | Ревью контракт↔код: матрица §4, TOCTOU §3.6/§4, регистрация Redis-семейств, PG-инварианты; ноль blocker'ов | Blocker → возврат к этапу 1 |
| 3 | Ручная публикация orchestration-пакета | `@animastor/orchestration` (напр. 0.1.5) упакован и опубликован вручную; tarball ставится в чистый префикс, его собственные тесты зелёны | Не публиковать; версия не поднята |
| 4 | Bump backend-зависимости | `backend/package.json`: `@animastor/orchestration ^0.1.5` + установка; **проверить байт-идентичность** `backend/node_modules/@animastor/orchestration/src` ↔ `packages/animastor-orchestration/src` (сейчас diff пуст — расхождение = FAIL, т.к. синхронизация ручная, автоматики в репо нет); backend-сьюты зелёны на установленной копии | Расхождение копий или падения → откат bump'а |
| 5 | CI/образ | `deploy/backend-ghcr-release.yml` собирает образ; staging-прогон: backend+hub+мини-worker, dispatch→result smoke проходит через fenced-путь (mode=observe) | Сборка/smoke FAIL → не деплоить |
| 6 | Deploy в observe | Образ развёрнут; ≥ 3 дней: ноль роста orphan-маркеров, метрики `stale_intent`, `legacy_no_receipt`, CAS-conflict логируются; queue-глубины не растут к 457/438-паттерну | Аномалия → `GPU_FENCING_MODE=off` + откат образа |
| 7 | Переключение в enforce | Метрика `legacy_no_receipt` == 0 за предыдущие 24 ч (окно > claim TTL 24 h ⇒ у каждого живого dispatch есть receipt); регенерация сцен не волна rejection'ов | Волна rejection → вернуть observe; не трогать данные |
| 8 | Наблюдение после enforce | Логи `[GPU RESULT]`, `stale_intent`, `duplicate_same_fence`, outbox-реплеи в пределах ожидаемого; READY/прогресс сцен не деградируют; staging-GC работает только по правилам §5.5 | Регрессия → `off` (kill-switch, §6) без потери артефактов |

**Порядок внедрения** (адаптированный из дизайна §Implementation order, с указанием мест): (1) data model + receipt на send без смены приёма callback (`gpu-dispatcher.js`, `queue-idempotency.cjs`); (2) staged-пути + manifest-чтение (`task-handler.cjs`, `cleanup-service.cjs`); (3) `fenceCommit` Lua + условная PG-проекция + outbox, callback через них (`generation-routes.cjs`, `scene-assets-repo.js`); (4) supersede-before-cleanup в cancel/regenerate/cache/delete + `releaseFenceIfCurrent` вместо слепого prefix-release; (5) удалить inline `releaseTaskDoneIfOrphan`-retry, ввести repair-intent; (6) миграция/реконсилиация legacy, затем enforce-gate.

---

## 9. Главные риски (ранжировано)

- **R1 — снятие stale-исключения audio/video** (`task-handler.cjs:42-61`, `generation-routes.cjs:470-489`): оно сейчас защищает легитимный batch/reorder-приём поздних чанков. Fence-receipt это покрывает (тот же fence → accept), но любая ошибка в receipt-TTL/lookup сломает аудио/видео-сборки. Митигация: receipt TTL 48 h ≥ claim 24 h; тест 9 (§7) обязателен до enforce.
- **R2 — Redis как commit authority + PG как проекция**: окно рассинхрона после Redis-CAS до PG-UPDATE; Redis-flush теряет intent/манифест → fail-closed (безопасно, но требует repair-пути и явного runbook).
- **R3 — TTL-семейство**: 6 пересекающихся TTL (claim/ambiguous/done/ref/job-epoch/stage-epoch) + новые (receipt/intent); истечение никогда не должно превращать старый результат в текущий — покрыто тестом 4, но эксплуатационно требует алертов на «receipt missing при active intent».
- **R4 — `audio-recovery.cjs` legacy-пути** (строки 85, 166) зовут `handleTaskResult` без dispatch_id: сейчас это скрытый fail (`missing_dispatch_id`); контракт требует явного решения — сделать их fail-closed либо резолвить «последний receipt по job_id» (рекомендую fail-closed + упразднение к включению enforce).
- **R5 — ручная синхронизация пакета**: `backend/node_modules/@animastor/orchestration` — обычная копия без автоматической синхронизации; рассинхрон версий = тесты зелёные на старом коде (гейт 4 обязан сверять байт-идентичность).
- **R6 — FakeRedis-эмуляция Lua снiffer'ом** может разойтись с реальным Redis: интеграционный вариант (реальный Lua) обязателен перед enforce, в окружении с разрешёнными listener'ами.
- **R7 — PG upsert и NULL-build legacy**: условный upsert обязан сохранить инварианты Stage 66/76 (одна NULL-строка, нет дубликатов при concurrent) — покрыть сверкой с `markready-build-id-idempotency.test.js`/`null-duplicate-self-heal.test.js`.

---

## 10. Что НЕ делалось (границы stage)

Исходники, тесты, lockfile, версии, ref, конфигурация, сервисы, очереди и продакшен-данные не изменялись; коммитов не создавалось; fencing не внедрялось. Незакоммиченные изменения worktree Stage 124 не тронуты. Отчёт — единственный артефакт stage.
