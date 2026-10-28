# Stage 132 — Independent Audit: Fenced Publication & Recovery

**Вердикт: BLOCKED.**
Найдены подтверждённые (на production-коде, реальном изолированном Redis и реальной FS) пути
публикации устаревшего результата в обход fenced commit, путь commit'а устаревших байтов **под
именем текущего fence**, путь записи canonical-артефакта вообще без какого-либо гейта, и
взаимодействие «старый done-маркер × crash-окно», разрушающее текущую публикацию. Ложный
`ready` не найден; восстановление FS/Redis-окон в остальном доказано корректным.

- **Аудируемый HEAD:** `fa1fa1d6a795c488171294807b68d1ab06c37ade` (Stage 131, 10 файлов, +1532/−13).
- **Состояние рабочего дерева на старте и на финише идентично** (чужие dirty-файлы не тронуты):
  `M backend/src/routes/book/generation-routes.cjs`, `M` 4 AI/arch-теста, `M backend/tests/gpu-lane-release-order.test.js`,
  `M packages/animastor-orchestration/src/runtime/dispatch-engine.js`, `D backend/scripts/audit-orphan-books.js`,
  untracked `deploy/`, `freebuff-chat-2026-10-11T07-41-12.445Z.md`. HEAD не менялся.
- **Fencing-файлы байт-в-байт == fa1fa1d6** (`git diff fa1fa1d6` по 10 файлам Stage 131 пуст) — аудит
  проверяет именно закоммиченный код, не более поздние правки.
- **Ничего не изменено:** ни production-код, ни Compose, ни `.env`, ни контейнеры, ни hooks, ни ref'ы,
  ни чужие dirty-файлы; коммитов/push нет; `GPU_FENCING_MODE=enforce` не включался; production
  Redis/PG/Hub/очередь не читались и не изменялись; manifest/journal/staging/legacy-артефакты не удалялись.
- **Изолированная инфраструктура:** throwaway `redis:7` (`a132-redis`, `127.0.0.1:6395`, `--save ''`,
  `--appendonly no`, без volume) — удалён после прогона (`docker rm -f`); временные FS через `mkdtemp`;
  PostgreSQL не подключалась (сценарии PG решены чтением кода — см. §2, отдельная тестовая БД не понадобилась,
  schema не менялась). Harness: `/home/animastor/reorg-2026-10-23/audit-132/`
  (`01-p0-legacy-callbacks.cjs` → `01-results.json`, `02-publication-recovery.cjs` → `02-results.json`,
  `full-suite.log`). Оба харнесса исполняют **production-модули** (`task-handler.cjs`,
  `result-publication.cjs`, `queue-idempotency.cjs` с реальным `FENCE_COMMIT_SCRIPT` через ioredis,
  `audio-recovery.cjs`, `verifyDispatchIdentity`) против реального Redis — не мока.

---

## 1. Legacy callbacks без receipt (P0) — BLOCKED

### 1.1 Где вызывается `verifyDispatchIdentity` и что он доказывает

| Вызов | Файл |
|---|---|
| `POST /gpu/task/result` (до dedup) | `backend/src/routes/generation-routes.cjs:460` |
| `POST /gpu/task/error` | `backend/src/routes/generation-routes.cjs:651` |
| `handleTaskResult` (внутри handler) | `backend/src/services/task-handler.cjs:42` |
| `completeStage` / `failStage` | `packages/animastor-orchestration/src/orchestration/orchestrator.js:106, :272` |

`verifyDispatchIdentity` (`dispatch-engine.js:287`) сравнивает `dispatch_id` callback с полем
`dispatch_id` **единой mutable-записи** `animastor:dispatch-meta:{book}:{ch}:{sc}:{stage}`
(`SET EX` = lease-TTL, ~десятки минут; перезаписывается новым dispatch, удаляется при finalize).
Он доказывает ровно одно: «callback пришёл от dispatch'а, который сейчас числится активным для
этой сцены/стадии». Он **не** доказывает принадлежность текущему intent/fence, а для
audio/video ещё и ослаблён исключением `stale_dispatch` при фазе FSM
`WAITING_CHUNKS|MERGING` (`generation-routes.cjs:470-489`, зеркально `task-handler.cjs:42-61`).
Dispatch-meta переживает supersede до истечения lease-TTL — окно, в котором устаревший
callback проходит оба гейта (route и handler), потому что суперсед происходит на **send**-стороне
(`ensureIntentAndReceipt` в `sendUnified`), а meta ставится раньше и живёт отдельно.

### 1.2 Цепочки callback-путей и разрешения fence

```
/gpu/task/result (требует dispatch_id — 400 без него)
  → verifyDispatchIdentity (+ phase-исключение audio/video)
  → dedup SET NX EX 3600 (dispatch-independent)
  → fence = readDispatchReceipt(dispatch_id, job_id)          ← 48 h TTL, immutable
            || readTaskRef(book,ch,sc,job)                     ← ЛУЧШИЙ Effort ref (blind SET при send)
            : null                                             ← оба чтения в try/catch → null при ЛЮБОЙ ошибке Redis
  → handleTaskResult(..., { fence })
       fence = opts.fence || readDispatchReceipt              ← handler ref-fallback НЕ использует
       fence && mode!=off → stage → FENCE_COMMIT_SCRIPT (Lua) → publish
       иначе              → LEGACY: fs.writeFileSync(canonical) до всякой commit-проверки
```

Альтернативные входы в `handleTaskResult`:
- reconcile Phase A `recoverResultKeys` (`reconciliation-engine.js:1930`): пропускает legacy-ключи
  без `dispatch_id` (fail-closed skip), дальше — та же цепочка (receipt → иначе legacy);
- `POST /api/v1/debug/audio/recover` → `recoverAudioForScene` (`debug-routes.cjs:514`) — см. B3;
- `recoverAudioResults` (`audio-recovery.cjs:16`) — в production **не вызывается** (логика
  перенесена в Phase A; используется только отладочный per-scene вход).

`GPU_FENCING_MODE`: `off` = legacy; `observe` и `enforce` в Stage 131 **идентичны**
(`runtime-config.js:267`, отклонение 131 §6). То есть закрытие legacy-ветки меткой `enforce`
**недоступно**, и метрики `legacy_no_receipt`, на которую ссылается окно ≥48 h observe
(131 §6/§9.2-Л1), в коде **нет** (`grep legacy_no_receipt` по `backend/src` — 0 совпадений):
оператор даже не может измерить величину экспозиции.

### 1.3 Доказательные результаты (01-results.json: 8/8)

| ID | Тип | Что доказано (production-код, реальный Redis) |
|---|---|---|
| **B1 = T1** | **блокер** | Callback **без receipt, без ref** после supersede: `routeFence=null` → identity принимает (`stale_dispatch` + `WAITING_CHUNKS`) → **legacy `fs.writeFileSync(canonical)`**, chunk-metadata `audio_status:'ready'` записаны, fenced commit **пропущен**, manifest/done отсутствуют. Устаревший байт-string опубликован. |
| **B2 = T2** | **блокер** | Callback d1 **без receipt**, при этом ref указывает на **текущий** F2 (слепой `rememberTaskRef` нового send'а): route резолвит `fence=F2` → identity принимает → `FENCE_COMMIT_SCRIPT` видит `intent.fence==F2 active` → **`committed`**: устаревшие байты F1 записаны в manifest **под текущим fence**, `done:F2` создан, canonical содержит `STALE-F1-CHUNK`. Хуже: последующий **настоящий** результат F2 получит `duplicate_same_fence`, а `publishStaged(overwrite:false)` **не перезапишет** уже занятый canonical (`already_published`) → текущая генерация навсегда показывает устаревший файл; в пределах 1 h настоящий результат ещё и гасится route-dedup'ом `(job,build)`. |
| **T3** | контроль | Тот же сценарий, но receipt d1→F1 существует → route резолвит F1 → `stale_intent`, canonical не тронут, metadata не писались. Гейт работает **только при живом immutable receipt**. |
| **B5 = T4** | **блокер** | Ошибка чтения receipt/ref (WRONTYPE/timeout — временный сбой Redis): оба чтения поглощаются в try/catch → `fence=null` → **fail-open в legacy-ветку**: контроль при здоровом Redis дал `fenced:true, done:true`, при сбое чтения — прямая запись canonical **без commit**. Отказ гейта — в сторону небезопасности, а не fail-closed. |
| **T5** | контроль | Устаревший ref (F1 при intent F2) → `stale_intent`, fail-closed ✔. Но см. B2: «правильный» ref устаревшего callback'а опаснее устаревшего ref'а. |
| **B1b = T6** | **блокер** | Истёкший receipt (TTL 48 h — правдоподобен для replay'а/ручной повторной доставки; debug-recovery и reconcile-ключи живут 1 h, но сценарий ≥48 h после send достижим через отложенные реплеи): `routeFence=null` → legacy-запись устаревшего байта. |
| **B3 = T7** | **блокер** | `recoverAudioForScene` (production, `POST /api/v1/debug/audio/recover`): **сначала** `fs.writeFileSync(canonicalSceneAudio)` и `saveChunk(… audio_status:'ready')`, **потом** `handleTaskResult` — который отклоняет (`missing_dispatch_id`). Ворота нет вовсе: запись происходит до identity/fence-проверки, при superseded intent (F2) устаревший файл (в т.ч. scene-level `{prefix}.mp3` — целиком сцена) опубликован, ключ результата остаётся и повторяет попытку до self-heal по `existsSync`. Ни receipt, ни dispatch_id, ни intent не читаются. |
| **T8** | факт (контракт 131 §5-фаза 1) | Callback текущего dispatch без какого-либо fence-доказательства → canonical пишется, `fenced:false`, manifest/done не создаются. Документированное поведение observe-фазы, но см. §1.4 — фикс-измерения (`legacy_no_receipt`) отсутствуют. |

**Ответы на вопросы раздела 1:**
- *Может ли callback без receipt попасть в legacy-ветку?* **Да** — любой callback, чей receipt
  отсутствует/истёк/не читается, при `fence=null` (B1, B4, B6, T8).
- *После supersede / повторного dispatch / TTL?* **Да** — T1 (supersede), T6 (TTL), T4 (ошибка чтения).
- *Может ли legacy-путь записать canonical / изменить completion-метаданные / обойти fenced commit?*
  **Да на все три** — T1/T6/T8: `fs.writeFileSync` до commit; chunk-metadata/iu-progress/`saveChunk`
  (ready) и вызовы `completeChunk`/`completeStage` идут после legacy-записи; done/manifest не создаются.
  (`completeStage` дополнительно перепроверяет identity без phase-исключения — ready-флаг по stale
  dispatch не ставится, но файл и chunk-metadata уже изменены.)
- *Fallback-пути:* receipt (48 h) → job→fence ref (blind SET, best-effort) → `opts.fence`; в handler —
  только `opts.fence` → receipt. При **отсутствующем** ref/receipt — **fail-open** (legacy);
  при **повреждённом** ref (не-hex) — `invalid_fence` → terminal reject (fail-closed, код-анализ:
  JS-предпроверка `fenceCommitResult` + `FENCE_COMMIT_REJECTED`); при **устаревшем** ref —
  либо `stale_intent` (T5), либо **commit устаревших байтов под текущим fence** (B2).
  Безопасность обеспечена **только** при живом immutable receipt; все остальные случаи небезопасны.

### 1.4 Минимальные воспроизводимые сценарии (блокеры)

**B1 — устаревший audio-callback без receipt публикуется:**
1. `ensureIntentAndReceipt(d1, F1)`; удалить `animastor:dispatch-intent:d1:{job}` (TTL/pre-127);
2. регенерация: `ensureIntentAndReceipt(d2, F2)` → intent superseded, ref=F2, dispatch-meta=d2;
3. FSM-состояние сцены = `WAITING_CHUNKS` (идёт сбор чанков новой генерации);
4. `POST /gpu/task/result {dispatch_id:d1, …}` → identity: `stale_dispatch` + фаза → accepted;
   `readDispatchReceipt(d1)=null`, `readTaskRef=F2…` (или null при отсутствии ref);
5. при `fence=null` → legacy-запись устаревшего чанта в canonical + chunk `ready` без commit;
   при `fence=F2` (ref) → **committed под F2** (B2), настоящий результат F2 далее не публикуется.

**B3 — запись без единого гейта:** `POST /api/v1/debug/audio/recover` с ключом
`animastor:result:{build}:{b}:{c}:{s}:audio` при superseded intent → canonical scene-аудио и
chunk-метаданные пишутся до отклонённого `handleTaskResult`.

**B5 — сбой чтения = обход:** любому вызову route-резолва против Redis, отвечающего ошибкой на
`GET animastor:dispatch-intent:*`/`animastor:idempotency:ref:*`, при здоровом dispatch-meta
→ legacy-запись вместо commit (01 · T4).

---

## 2. PostgreSQL metadata и crash recovery

Фактическая последовательность (проверена по коду): `STAGE (fsync) → FENCE_COMMIT_SCRIPT (Redis Lua:
manifest → done → release claim → journal) → publishStaged (rename, fsync dir) → handler-метаданные
(chunk/iu/progress) → completeStage: verifyDispatchIdentity → handler → version-gate (fail-closed,
PG-read ошибка = нет READY) → sceneAssets.markReady (PG, безусловный upsert) → Redis asset→READY →
finalizeDispatch`. Redis-commit, FS-publish и PG — **не одна транззакция**; ordering «PG до Redis-READY»
явный (`orchestrator.js:195-200`).

| # | Сценарий | Фактическое поведение (доказательство) | Оценка |
|---|---|---|---|
| 1 | Redis commit OK, rename не состоялся | durable `manifest+done`; успех не заявлен; `resumePendingPublications` (каждый reconcile-цикл, до оркестрации, вне kill-switch) переигрывает rename идемпотентно; manifest **без** done не публикует (02 · R1, R4) | **корректно** (retry/resume) |
| 2 | Rename состоялся, metadata-update с ошибкой | `completeStage` **поглощает** ошибку markReady (`catch(completionErr)` → `handlerOk=false`, `finalizeDispatch(failure)`, возврат без throw) → handler возвращает успех → route отвечает `ok:true`, dedup **сохраняется** → повторного callback от hub не будет; READY не ставится ни в PG, ни в Redis (порядок fail-closed) | **нет ложного ready и потери** (файлы+manifest durable), но «metadata chain» молча не доигрывается; самолечение только через reconcile Phase D (auto-fix/orphan-репейр → re-dispatch = повторная генерация). Задержка до 60 s + возрастные пороги Phase D; при длительном сбое PG — цикл re-dispatch (rework, ограничен восстановлением PG). **Non-blocking debt**: replay metadata из commit-journal отсутствует |
| 3 | PostgreSQL недоступен во время markReady | version-gate уже fail-closed (`shouldWriteReady=false`, `DIRTY` → re-dispatch); если PG упала между gate и markReady — как сценарий 2. Ложный ready невозможен: markReady предшествует Redis-READY, и то и другое в общем try/catch | **безопасно**, возможен rework |
| 4 | Рестарт между публикацией файла и обновлением metadata | durable: canonical + manifest + done; metadata отсутствуют. `resumePendingPublications` только переигрывает rename (файл уже есть → no-op), **metadata не реплеится**; Phase D находит зависшую сцену и чинит/перегенерирует | **нет зависшей навсегда задачи**, но см. сценарий 2 — тот же долг |
| 5 | Повторный callback / reconcile после любого из состояний | callback: dedup (terminal reject → dedup сохранён, retryable → снят → hub-ретрай); commit идемпотентен (`duplicate_same_fence` не меняет manifest байт-в-байт — 131 V1.7/1.8, повторён нами: 02 · R1 pass2, R9b); reconcile-повтор — no-op | **корректно** |
| 6 | Manifest/done есть, metadata отсутствует/отстаёт | состояние не считается «ready» ни в PG, ни в Redis → ложного ready нет; задача не потеряна (publish-durable), Phase D эвентуально доводит; риск лишней генерации (rework) — см. долг выше | **корректно с долгом** |
| 7 | Повторный результат **другого** fence после восстановления | intent-authority: `stale_intent` при параллельной гонке (02 · R7), свой staged удаляется, canonical/manifest текущего fence не трогаются. **Но** см. блокер B4 ниже — старый done-маркер + crash-окно | **частично** — B4 блокер |

**B4 (блокер, 02 · R8) — старый done-маркер переиздаёт superseded-фence, resume добивает текущий:**
`FENCE_COMMIT_SCRIPT` шаг 1 (`EXISTS done`) возвращает `duplicate_same_fence` **до** проверки intent,
а `publishStaged` при `duplicate_same_fence` (`overwrite:false`) выполняет rename, **если canonical
отсутствует**. Воспроизводство (все состояния — реальные crash-окна §7 Stage 131):
1. commit F1 → **crash до rename** (canonical отсутствует, staged F1 лежит, `done:F1` durable);
2. регенерация → intent=F2; результат F2 закоммичен, но его rename тоже не случился ( crash/препятствие );
3. hub-ретрай/реплей **F1** → `duplicate_same_fence` → rename staged F1 → canonical = **устаревшие байты**;
4. следующий `resumePendingPublications`: manifest=F2, `done:F2` есть, canonical существует →
   «already published» → `cleaned=1` **удаляет staged F2**;
5. итог: canonical = байты F1, manifest+done = F2, staged F2 уничтожен → F2 не может быть переопубликован
   (оба сигнала resume «сходятся» на чужом файле) → перманентное расхождение до ручного вмешательства.

**PG-проекция для Stage 133 (design only, schema в 132 не менялась):**
- миграция `ALTER TABLE scene_assets ADD COLUMN generation_fence TEXT NULL`;
- условный upsert `markReadyFenced(...)`:
  `INSERT … ON CONFLICT (book,chapter,scene,asset_type,build_id) DO UPDATE SET path,status='ready',generation_fence=EXCLUDED.generation_fence WHERE scene_assets.generation_fence IS NULL OR scene_assets.generation_fence = EXCLUDED.generation_fence`
  — идемпотентный повтор того же fence = одна строка (инварианты `markready-build-id-idempotency`,
  NULL-дубликаты Stage 75/76 сохраняются); порядок fencing-файлов не зависит от лексики hex-fence,
  потому что «current» определяет Redis (manifest/intent), а не PG;
- вместо прямого вызова после commit — реплей из уже существующего `animastor:fence-journal:*`
  (TTL 7 d): reconcile-проjection идемпотентно доводит PG до `manifest.published_fence`;
  journal пишется только для `committed`, поэтому отклонённый stale-fence в PG не попадает;
  конфликт разрешается только вперёд (`generation_fence IS DISTINCT FROM` + защита от отката на
  fence, не являющийся текущим, сверкой с manifest при реплее).

**Acceptance criteria следующего этапа:** (а) сценарии 2–4 из таблицы заканчиваются READY без
re-dispatch при восстановленной PG (реплей журнала); (б) PG-строка никогда не показывает ready
файла, чей commit отсутствует/отменён; (в) урон journal > 7 d → задача завершается через
существующий Phase D, без ложного ready; (г) инварианты Stage 66/76-тестов зелёные.

---

## 3. Manifest и commit journal

### 3.1 Ключи, TTL, жизненный цикл (проверено по коду и реальному Redis, 02 · R0)

| Ключ | TTL | Владелец/цикл |
|---|---|---|
| `animastor:intent:{b}:{c}:{s}:{job}` | **14 d** (освежается каждым принятым send) | supersede/`history` (≤8); единственный authority |
| `animastor:dispatch-intent:{dispatch}:{job}` (receipt) | **48 h**, immutable SET NX | пишется до hub POST, не удаляется |
| `animastor:idempotency:claim:{fence}` | 24 h (90 min ambiguous) | удаляется commit'ом / rollback'ом / release'ами |
| `animastor:idempotency:done:{fence}` | **7 d**, NX | создаётся только commit-скриптом; удаляется authorized release'ами / `releaseTaskDoneIfOrphan` |
| `animastor:idempotency:ref:{b}:{c}:{s}:{job}` | 24 h → 7 d после commit | best-effort индекс; продлевается скриптом только при согласии |
| `animastor:artifact-manifest:{b}:{c}:{s}:{job}` | **без TTL (durable)** | перезаписывается каждым `committed` |
| `animastor:fence-journal:{b}:{c}:{s}:{job}:{fence}` | **7 d** | идемпотентная запись `(job,fence)` |
| `.staging/{enc(job)}/{fence}/` (FS) | age-gate GC 24 h | удаляется: terminal reject (свой), GC (не-текущие+немолодые+не-committed) |
| dispatch-meta / result-handoff / route-dedup | lease-TTL / 1 h / 1 h | pre-131, без изменений |

### 3.2 Рост manifest, GC, retention

- **Manifest не имеет TTL по дизайну** («что сейчас читать») и **никогда не удаляется**: GC трогает
  только `.staging`-каталоги. Ключей — по одному на каждый логический task, когда-либо коммитнувший
  результат (перезапись на месте, но удалений нет) → рост монотонный и неограниченный (RAM ~сотни байт ×
  число задач). На больших кумулятивных объёмах — memory-debt; плюс `RESUME_MANIFEST_LIMIT=200` на
  проход: при >200 manifest'ов resume обрабатывает «первые 200» от SCAN-порядка — при стабильном
  порядке слотов возможна starvation хвоста (безопасно, но задержка восстановления). **Non-blocking debt.**
- **GC не может удалить данные восстановления:** staged коммитнутой публикации защищён проверкой
  `done` **первым** шагом; любая ошибка Redis → `aborted`, ноль удалений (02 · R6); текущий fence —
  всегда skipped; manifest/journal GC не трогает вовсе.
- **Старый done/marker × новый fence:** done-key содержит fence → старый done не может подтвердить
  **новый** fence; manifest хранит свой `published_fence` и сверяется с done **того же** fence
  (02 · R4). Единственный найденный разрыв — B4 (§2): старый done подтверждает **старый** fence и,
  через crash-окно, переиздаёт его файл.
- **Частичное/повреждённое/противоречивое состояние:** corrupt manifest → `errors`, без публикации
  (R3); manifest без done → не публикует (R4); traversal-пути → `errors`, запись наружу невозможна (R5);
  done-значение не валидируется (existence-check `!= null` — мусорное значение сочтётся commited'ом;
  парой сигналов это покрыто лишь потому, что manifest должен быть валиден). Recovery-решения всегда
  из пары durable-сигналов, никогда из факта существования файла — подтверждено (131 §2 инвариант 7, повторено).
- **Крайний случай send-пути:** `releaseTaskDoneIfOrphan` (`queue-idempotency.cjs:608`) удаляет done
  при `already_completed` на send'е, чей артефакт пробован как отсутствующий — для
  committed-but-unrenamed публикации (canonical отсутствует!) это удалит done **коммитнутой** публикации.
  Последствие ограничено: resume перестаёт публиковать (manifest без done), но та же задача заново
  проходит commit (тот же fence, receipt жив) и публикуется; staged при этом GC не удалит (intent
  текущий). **Non-blocking edge**, описать в retention-этапе.
- **Retention-политика (предложена, НЕ выполнялась):** (1) manifest — periodic prune:
  при `resume`-проходе навешивать `EXPIRE ~30 d` (touch) и удалять запись, если `done:{fence}` истёк
  **и** staged отсутствует **и** canonical существует (т.е. публикация археологически завершена);
  (2) journal — оставить 7 d (реплей PG-проекции укладывается в это окно); (3) staging — существующий
  age-gate 24 h не менять; (4) `releaseTaskDoneIfOrphan` в следующем этапе проверять manifest того же
  fence перед удалением done. Риски: prune при живом Redis-флеше (manifest — единственный durable-указатель)
  → сначала только `EXPIRE` без DEL, DEL — отдельным решением после ≥1 наблюдательного окна.

---

## 4. Наблюдения Stage 130 в контексте Stage 131 (перепроверены)

| # | Observation | Классификация для publication-пути | Перепроверка |
|---|---|---|---|
| 1 | lost-counter epoch-gap | **Non-blocking debt (send-side), системный риск НЕ устранён** | commit-скрипт не читает stage-счётчик (источник: `FENCE_COMMIT_SCRIPT` — только intent) → сама публикация от счётчика не зависит. Но: при утрате счётчика send- admission пропускает «никогда виденный» старый fence (`created`) → intent переключается → публикация **будет** его коммитить. Проверена только публикация и route/handler-чтения; dispatch-side читатели (claim/ref/release-префиксы, `guardEnqueue`, `releaseClaimsByPrefix`) в 132 **не** ревьюировались целиком → риск считать закрытым нельзя |
| 2 | `rememberTaskRef` blind-SET | **Для самой записи ref — non-blocking; но route-фоллбэк на ref — новая ПЛОЩАДКА B2** | ref не является гейтом скрипта (02 · 131 §5 + `FENCE_COMMIT_SCRIPT` шаг 3 только EXPIRE при согласии). Однако route **использует ref как резолвер fence** для commit'а: ref, указывающий на текущий fence + stale dispatch без receipt → B2 (01 · T2). Это иная опасность, чем исходная гонка перезаписи, — она подтверждена экспериментом |
| 3 | reply-length fallback | **Non-blocking debt** (теоретический) | для commit-пути fallback не существует вовсе: `fenceCommitResult` без `eval` → `unavailable` (fail-closed); production ioredis всегда Lua |
| 4 | local vs Prometheus degraded signal | **Non-blocking debt (observability)** | сохраняется: commit-деградации пишутся в send-side `animastor_intent_fence_degraded_total{reason=commit_*}` best-effort'ом, локальный `getStats()` их не видит; вердикты — отдельный `animastor_fence_commit_total{outcome}`. Сбои экспорта на корректность протокола не влияют |
| 5 | Redis Cluster CROSSSLOT | **Non-blocking debt (deployment, fail-closed)** | 6 ключей скрипта хешируются в разные слоты → на cluster `EVAL` бросит CROSSSLOT → `unavailable` → публикация безопасно недоступна. Production — standalone. Hash-tags не вводились (осознанно) |

---

## 5. Тесты

### 5.1 Аудиторские харнессы (изолированная область `/home/animastor/reorg-2026-10-23/audit-132/`, вне рабочего дерева)

| Харнесс | Результат |
|---|---|
| `01-p0-legacy-callbacks.cjs` (реальный redis:7 + реальная FS + production-модули) | **8/8 проверок** выполнены в заявленном смысле: 6 findings (T1, T2, T4, T6, T7, T8) + 2 controls (T3, T5) |
| `02-publication-recovery.cjs` (реальный `FENCE_COMMIT_SCRIPT` через ioredis) | **11/11**: R0 TTL-профиль, R1–R2 crash-окна, R3–R5 повреждённое состояние, R6 GC при Redis-down, R7 два fence параллельно, **R8 находка (B4)**, R9a/b сбой metadata после publish |

### 5.2 Повторённые тесты Stage 131 и архитектура

| Сьют | Результат | База |
|---|---|---|
| `tests/gpu-result-fencing-commit.test.js` | **30 passing / 0 failing** — состав подтверждён: в файле ровно 30 `it(`, прогнаны все 30 | == 131 |
| gpu-queue-idempotency + gpu-lane-release-order + dispatch-meta-lease-lifecycle + markready-build-id-idempotency | **111 passing / 0 failing** | == 131 |
| gpu-intent-fence-regressions + gpu-intent-fence-receipt | **48 passing / 0 failing** | == 131 |
| happy-path | **75 passing** | == 131 |
| `tests/architecture/*.test.js` | **935 passing / 24 pending / 0 failing** | == 131 |
| полный `npx mocha --recursive tests/` (изолированно) | **3455 passing / 28 pending / 0 failing, exit 0** (`audit-132/full-suite.log`) | 131: 3453 → +2 (поздние hook-тесты 131) |
| `scripts/syntax-smoke.sh backend` | exit 0 | == 131 |

Зелёный full-suite **не** покрывает найденные блокеры: существующие тесты 131 проверяют fenced-ветку,
но ни один не проверяет route-резолв `receipt || ref` со **старым** dispatch_id, legacy-реплей
`recoverAudioForScene`, fail-open при ошибке чтения receipt и интерливинг «старый done × crash-окно»
(R8 — на самом реальном Lua). Регресс-блокеры добавлены только в аудиторский каталог, как и требовало задание.

### 5.3 Ограничения среды

- PG-сценарии не исполнялись на живой БД (production credentials запрещены; временная тестовая БД не
  требовалась — поведение доказано код-порядком `markReady → READY` + version-gate fail-closed + R9 на
  уровне handler'а). Наблюдение: `completeStage` поглощает ошибку markReady — харнест R9a использовал
  проброс-стаб, реальный оркестратор возвращает `completed:false` без throw (см. §2, сценарий 2).
- Деплой-контур: backend-контейнер монтирует только `./backend/src`, а `@animastor/orchestration@^0.1.4`
  берётся из npm-зависимостей образа; локальная копия `backend/node_modules/@animastor/orchestration`
  **устарела** относительно HEAD (нет `FENCE_REJECTED_OUTCOMES`/`isFenceRejectedOutcome` из Stage 129,
  `dispatch-outcomes.js` соответствует `a2d088cf`). Тесты берут taxonomy напрямую из `../../packages/…`,
  поэтому сьюты зелёные; backend-код, резолвящий `require('@animastor/orchestration')`
  (в т.ч. `verifyDispatchIdentity` в handler'е), исполняет копию. Различие не меняет identity-логику
  (не затронута) — **non-blocking debt на стыке деплоя** (ворота «синхронизация npm-пакета» из контракта
  126 §0.3), но отложить синхронизацию нельзя: send-side классификация (F5) в образе может быть старой.
- Dispatch-side читатели (§4 obs.1) не ревьюировались целиком — заявлено как граница аудита.

---

## 6. Границы безопасности — соблюдены

Production-код не изменён; коммитов/push/npm publish/CI/GHCR/deploy нет; production Redis/PG/Hub и
очередь не читались/не менялись; Compose/`.env`/контейнеры/hooks/remote refs/чужие dirty-файлы не
тронуты (`git status` до/после идентичен); manifest/journal/staging/legacy-артефакты не удалялись;
`GPU_FENCING_MODE=enforce` не включался; тесты и эксперименты — только в `/home/animastor/reorg-2026-10-23/audit-132/`
и временных FS; sandbox не обходился; throwaway-контейнер удалён (`a132` leftovers: 0; production-контейнеры
`animastor-backend/proxy/pg/redis`, `gpu-hub`, `repro-redis`, `buildx_buildkit_repro0` в списке присутствуют
и не трогались).

---

## 7. Вердикт

**BLOCKED** — критерий «legacy callback может публиковать устаревший результат» выполнен (B1, B3, B5;
B2 — хуже: commit устаревших байтов под текущим fence с permanent-блокировкой настоящего результата);
критерий «восстановление способно разрушить текущую публикацию» выполнен (B4). Ложный `ready` не найден.

### Блокеры (все воспроизводимы harness'ами §5.1; исправления в рамках аудита НЕ делались)

| ID | Суть | Минимальный сценарий | Где |
|---|---|---|---|
| **B1 (P0)** | Stale-колбэк без receipt → canonical + chunk-metadata **без** fenced commit (phase-исключение audio/video + mutable dispatch-meta) | §1.4 B1, харнесс 01 · T1 (+ TTL-вариант T6) | `generation-routes.cjs:518-531`, `task-handler.cjs:101-150` |
| **B2 (P0)** | Stale-колбэк без receipt + ref на **текущий** fence → route резолвит текущий fence → **`committed` под F2 байтами F1**; настоящий результат F2 далее `duplicate_same_fence` и не перезаписывает canonical (`overwrite:false`), 1 h — ещё и гасится dedup'ом | §1.4 B1, харнесс 01 · T2 | `generation-routes.cjs:521-522` (ref-fallback), `result-publication.cjs:publishStaged` (duplicate → `!overwrite` при отсутствии canonical) |
| **B3 (P0)** | `recoverAudioForScene` пишет canonical scene-аудио и `ready`-метаданные **до** любого identity/fence-гейта; работает в production через `POST /api/v1/debug/audio/recover` | §1.4 B3, харнесс 01 · T7 | `audio-recovery.cjs:244-267` (write) → `:285` (handler, уже после) |
| **B4 (P1)** | `duplicate_same_fence` (done-first) до проверки intent + rename при отсутствии canonical → **старый done переиздаёт superseded-файл**, затем resume удаляет staged **текущего** fence → перманентное расхождение canonical(F1) × manifest(F2) | §2 B4, харнесс 02 · R8 | `queue-idempotency.cjs:1524` (скрипт шаг 1), `result-publication.cjs:publishStaged/overwrite:false`, `resumePendingPublications` (cleaned) |
| **B5 (P0)** | Ошибка чтения receipt/ref (любой GET-сбой) поглощается → `fence=null` → **fail-open в legacy-ветку**; отказ гейта не fail-closed | харнесс 01 · T4 | `generation-routes.cjs:518-528` (try/catch → null), `task-handler.cjs:101-104` |

### Основные результаты тестов

Харнессы: **01 — 8/8**, **02 — 11/11** (реальный изолированный redis:7, реальная FS, production-код,
фактический `FENCE_COMMIT_SCRIPT`). Сьюты: fencing-commit **30/30** (все 30 включены и прошли),
targeted **111**, intent-fence **48**, happy-path **75**, architecture **935/24 pending**,
full backend **3455 passing / 28 pending / 0 failing (exit 0)**, syntax-smoke **exit 0**. Регрессий нет.

### Что не является блокером (но требует этапа)

PG-metadata replay из commit-journal (§2, сценарии 2–4 — долг, ложного ready нет); рост manifest без
TTL + resume-limit/starvation (§3.2); `releaseTaskDoneIfOrphan` × committed-unrenamed (§3.2);
5 наблюдений Stage 130 — non-blocking debt, кроме сохранённого send-side epoch-gap, риск по которому
**не объявляется устранённым** (dispatch-side читатели не проверялись); устаревшая локальная копия
`@animastor/orchestration` в `backend/node_modules` (деплой-долг, §5.3); отсутствие метрики
`legacy_no_receipt` и равенство `enforce==observe` — инструментов фазы 2 пока нет.

### Предлагаемые acceptance criteria для Stage 133 (не выполнялись)

1. **Phase-2 гейтинг:** callback без receipt → `legacy_no_receipt` (метрика реализована) → reject
   в `enforce`; ≥48 h observe с нулевой метрикой как условие включения; при этом debug-recovery
   либо получает receipt-lookup, либо становится fail-closed (B3).
2. **Fence-резолв без fail-open:** ошибка чтения receipt/ref → retryable reject (не legacy-запись);
   ref-fallback для **stale** dispatch'а запрещён (B1/B2/B5): резолвить только по receipt; отсутствие
   receipt у не-legacy dispatch → reject, не legacy-ветка.
3. **B4:** порядок в скрипте — intent-check до `duplicate_same_fence` для не-текущего fence
   (или запрет rename при `duplicate`, если canonical отсутствует, в пользу resume), + тест интерливинга
   «commit F1 → crash → supersede F2 → ретрай F1 → resume» на реальном Lua.
4. **PG-проекция** (§2 design): `generation_fence` + условный upsert + реплей из fence-journal;
   acceptance — §2 в конце.
5. **Retention** (§3.2): touch-EXPIRE manifest, prune-критерии, `releaseTaskDoneIfOrphan` × manifest;
   ни одна очистка не выполняется без отдельного этапа.

---

## 8. Артефакты

- `/home/animastor/reorg-2026-10-23/audit-132/01-p0-legacy-callbacks.cjs` + `01-results.json`
- `/home/animastor/reorg-2026-10-23/audit-132/02-publication-recovery.cjs` + `02-results.json`
- `/home/animastor/reorg-2026-10-23/audit-132/full-suite.log`
- Throwaway-контейнер `a132-redis` удалён; данные не сохранялись (no volume, no persistence).