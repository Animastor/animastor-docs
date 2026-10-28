# Stage 134 — Independent Audit of the Stage 133 Fenced-Publication Fixes

**Вердикт: BLOCKED.**

B1–B5 из Stage 132 **действительно устранены** commit'ом `cd31d279` и независимо подтверждены на
реальном изолированном Redis с исполнением настоящего `FENCE_COMMIT_SCRIPT` и на временной FS.
Однако аудит нашёл **один новый P1-блокер (B6)** в том же протоколе fenced-публикации: он не введён
Stage 133 (существовал уже в Stage 131), но он нарушает acceptance-критерий B4 и критерий Stage 134
«актуальный callback и crash recovery продолжают работать» — текущий fence после regeneration может
навсегда не попасть в canonical, при этом система сообщает об успехе и ставит ready-метаданные.

- **Проверенный commit:** `cd31d2790231617f0c90b3ac523a54692aab5357` (`cd31d279`, Stage 133).
- Аудируемые файлы байт-в-байт равны HEAD (`git show HEAD:<path> | sha256sum` == рабочее дерево).
- **Production-код, тесты, конфигурация не изменялись**; commit/push/deploy/npm/CI не выполнялись;
  `.env`/Compose/`GPU_FENCING_MODE` не тронуты; production Redis/PG/Hub/очереди/контейнеры не
  использовались. Артефакты — только `/home/animastor/reorg-2026-10-23/audit-134/`.

---

## 1. Исходное состояние и diff

```
HEAD  cd31d2790231617f0c90b3ac523a54692aab5357
       fix(gpu-result): receipt-only fence gate for callbacks + intent-first commit
       (stage 133 / audit 132 B1–B5)

git status --porcelain (до и после аудита — идентично, 10 записей):
 D backend/scripts/audit-orphan-books.js
 M backend/src/routes/book/generation-routes.cjs
 M backend/tests/ai-endpoint-sharing.test.js
 M backend/tests/ai-shared-inference.test.js
 M backend/tests/architecture/installer-package-boundary.test.js
 M backend/tests/architecture/phase5-runtime-result.test.js
 M backend/tests/gpu-lane-release-order.test.js
 M packages/animastor-orchestration/src/runtime/dispatch-engine.js
?? deploy/
?? freebuff-chat-2026-10-11T07-41-12.445Z.md
```

Хэши посторонних файлов (baseline → финал, совпадают):

| файл | sha256 (первые 16) |
|---|---|
| `backend/src/routes/book/generation-routes.cjs` | `bafa0c7366940ee3` |
| `backend/tests/ai-endpoint-sharing.test.js` | `c0e08565df9e90d3` |
| `backend/tests/ai-shared-inference.test.js` | `3f0ef0f9e1d30449` |
| `backend/tests/architecture/installer-package-boundary.test.js` | `f7889f41edd70f95` |
| `backend/tests/architecture/phase5-runtime-result.test.js` | `5d531cc48de5224d` |
| `backend/tests/gpu-lane-release-order.test.js` | `e4cb7478e280a11c` |
| `packages/animastor-orchestration/src/runtime/dispatch-engine.js` | `478d3fa7a998b32f` |
| `freebuff-chat-2026-10-11T07-41-12.445Z.md` | `2134973a625895c4` |

**Commit `cd31d279` содержит ровно 12 ожидаемых файлов** (+885/−231); пересечение с foreign
dirty/untracked-множеством — **пусто** (`comm -12` → 0 строк):

```
backend/src/config/runtime-config.js               | 21 +-
backend/src/helpers/queue-idempotency.cjs          | 76 +-
backend/src/metrics/prometheus.js                  |  4 +
backend/src/routes/debug-routes.cjs                | 11 +-
backend/src/routes/generation-routes.cjs           | 55 +-
backend/src/services/audio-recovery.cjs            | 274 +-
backend/src/services/result-publication.cjs        | 45 +-
backend/src/services/task-handler.cjs              | 50 +-
backend/tests/gpu-fenced-publication-gates.test.js | 557 +
backend/tests/gpu-result-fencing-commit.test.js    |  7 +-
backend/tests/mocks/redis-mock.js                  |  4 +-
backend/tests/private-worker-phase2.test.js        | 12 +
```

Diff прочитан пофайлово; неожиданных правок (тестов «под фикс», скрытых kill-switch'ей, ослабления
guard'ов) не найдено. Изменение `gpu-result-fencing-commit.test.js` — усиление ожидания
(`duplicate_same_fence` → `stale_intent` для superseded fence), файл в canonical не регрессирует.

### Происхождение harness Stage 133 и воспроизводимость

- `audit-133/01-real-redis-blockers.cjs` — harness автора Stage 133, изолированный
  (`127.0.0.1:6397`, throwaway `redis:7`, mkdtemp-FS, только локальные модули). Перечитан и
  перезапущен независимо (см. §6), но **доказательством аудита не считается** — он писал автор.
- Для аудита написаны собственные сценарии (`audit-134/01-independent.cjs`,
  `audit-134/02-minimal-repro.cjs`), сформулированные из отчёта Stage 132, а не скопированные.
- Старые логи Stage 133 **не** использовались как доказательство; все числа ниже получены новым
  прогоном на `cd31d279`.

---

## 2. Матрица B1–B5 (независимые сценарии, реальный Redis + Lua + FS)

Источник: `audit-134/01-independent.cjs` → `01-results.json`, `01-log.txt` (**15/15** проверок,
failed=0; плюс 2 probe-находки §3).

| ID | Сценарий (из отчёта Stage 132) | Фактический результат на `cd31d279` | Вердикт |
|---|---|---|---|
| **B1** | stale callback без receipt, mutable ref указывает на **текущий** fence; intent = F2 | `receipt_missing` (terminal); canonical отсутствует; staging F1/F2 отсутствует; `done:F2`=нет; manifest=null; chunk-metadata не писалась; затем **настоящий** результат F2 публикуется штатно (`committed`, canonical=`REAL-F2`, manifest/done=F2) | ✅ |
| **B1** | тот же отказ в `GPU_FENCING_MODE=enforce` | идентично observe: `receipt_missing`, ноль записей | ✅ |
| **B1** | явный `off` (kill-switch) | прямая запись canonical (`OFF-WRITE`), `fenced:false`, **без** manifest/done — ровно то, что документирует contract 126 §6 | ✅ (документированный bypass, §7) |
| **B2** | receipt F1 существует, intent = F2 (superseded) | `stale_intent`; canonical отсутствует; `done:F1`=нет; metadata не писалась | ✅ |
| **B2** | mutable ref не является резолвером | в callback-путях резолв только `resolveDispatchFence` (receipt); `readTaskRef` остался только в settlement/error (§5) | ✅ |
| **B5** | реальный `WRONGTYPE` на ключе receipt (LIST), `redis.get` → ошибка | `resolveDispatchFence`=`error`; handler → `fence_lookup_unavailable`; canonical/staging/done/metadata не тронуты | ✅ |
| **B5** | то же через HTTP `/gpu/task/result` | **503** `{error:'fence_lookup_unavailable', retryable:true}`; dedup-ключ снят; handler не вызван; файлов нет | ✅ |
| **B5** | ошибка Redis не превращается в `receipt_missing` | статусы `ok/absent/corrupt/error` различимы; legacy-ветка при `error` недостижима (guard в handler, строка 157–164) | ✅ |
| **B3** | `missing_dispatch_id` | `{recovered:false, reason:'missing_dispatch_id'}`, canonical/staging/metadata не тронуты, handler не вызван, replay-ключ сохранён | ✅ |
| **B3** | `receipt_missing` | отказ, ноль записей, handler не вызван | ✅ |
| **B3** | `stale_intent` через **реальный** handler | отказ до записи; canonical/metadata не изменены; staged удалён только у своего fence | ✅ |
| **B3** | успех для актуального fence | recovery делегирует в общий fenced flow: canonical=`RECOVERED-CURRENT`, `done:F1`, manifest F1, chunk-metadata записана, replay-ключ удалён | ✅ |
| **B4** | `done:F1` + crash до rename + supersede F2 + crash F2 + replay F1 + resume | replay F1 = `stale_intent`, canonical не создан; resume публикует **F2** (`resumed=1`), canonical=`v2`, manifest/done=F2, staged F2 перемещён | ✅ |
| **B4** | crash-окно **текущего** fence (canonical пуст) | `resume` публикует (`resumed=1`), повторный проход `resumed=0`, canonical стабилен | ✅ |
| **B4** | порядок в Lua | intent (`intent_missing`/`intent_corrupt`/`stale_intent`) проверяется **до** `EXISTS done`; `duplicate_same_fence` — только после подтверждения current+active | ✅ |

Дополнительно проверено по коду: в `handleTaskResult` прямая запись `fs.writeFileSync(asset.fullPath)`
достижима только при `fencingMode === 'off'` (строки 157–164 `task-handler.cjs`); иного writer'а
GPU-результата в callback-пути нет (§5).

---

## 3. Новый блокер **B6 (P1)** — canonical/manifest/fence расходятся после regeneration

### 3.1 Что воспроизведено

`audit-134/02-minimal-repro.cjs` (детерминированно, реальный Redis + реальный Lua + реальная FS):

**R1 — `publish_failed` + retry (crash не нужен, достаточно EACCES/ENOSPC на rename):**

```
F1 опубликован (canonical = F1-BYTES, manifest/done = F1)
regeneration → F2: stage OK, commit OK, rename staged→canonical падает (EACCES)
handler отдаёт retryable publish_failed (как задокументировано)
hub повторяет ТОТ ЖЕ fence F2 через production handler:
  → retry = { fenced: true, commit: "duplicate_same_fence" }
  → записаны chunk/ready метаданные (1 запись)
  → canonical по-прежнему "F1-BYTES", manifest.published_fence = F2, done:F2 = true
```

**R2 — crash-окно текущего fence после regeneration:**

```
F1 опубликован (canonical = F1-BYTES)
F2: stage + durable commit, процесс падает до rename
restart resume: { scanned:1, resumed:0, cleaned:1 }  ← УДАЛИЛ staged-байты F2
canonical = "F1-BYTES", manifest = F2, done:F2 = true
повторный результат F2 → duplicate_same_fence, published:false → canonical всё ещё F1-BYTES
```

Инвариант «canonical содержит байты текущего fence и согласован с manifest/done» нарушен в обоих
случаях (`consistent:false`), а в R1 система **сообщает успех** (`fenced:true`, route ответил бы
`{ok:true}`) и помечает артефакт готовым.

### 3.2 Причина (по коду `cd31d279`)

1. `publishStaged` (`result-publication.cjs:212`): при `duplicate_same_fence` вызывается с
   `overwrite:false` и при существующем canonical возвращает `already_published` — без проверки,
   **чей** это файл. Canonical-путь не содержит fence (он общий для всех генераций одного job),
   поэтому «canonical существует» ≠ «этот fence уже опубликован».
2. `resumePendingPublications` (`result-publication.cjs:416`): «canonical существует → удалить
   staged» — та же ложная посылка. В R2 это уничтожает единственную копию закоммиченных байтов
   **текущего** fence (`cleaned=1`).
3. Комбинация даёт: `manifest.published_fence = F2`, `done:F2`, а canonical = байты F1 — и никакой
   путь (retry, resume) это не исправляет до следующей regeneration F3.

### 3.3 Классификация и почему тесты зелёные

- **Не введено Stage 133.** `git show fa1fa1d6:backend/src/services/result-publication.cjs` содержит
  те же правила (`overwrite: verdict.status === 'committed'`; строка 212 `!overwrite && exists`);
  Stage 133 добавил только intent-гейт, который в R1/R2 не срабатывает (intent = F2, он актуален).
- **Тесты не покрывают:** оба существующих resume-теста используют **пустой** canonical
  (`gpu-result-fencing-commit.test.js:209` «restart between commit and rename») либо намеренно
  закрепляют ложную посылку (`:227` «resume removes only the staged leftover of an already-published
  fence»: canonical существует + staged «stray» ⇒ `cleaned=1`). Сценарий «предыдущая генерация уже
  в canonical» отсутствует.
- **Почему это блокер Stage 134:** критерий PASS требует «crash recovery не восстанавливает
  superseded artifact» (выполнено) **и** «актуальный callback и recovery продолжают работать»
  (нарушено: retry текущего fence рапортует успех, не публикуя; resume удаляет текущую публикацию).
  Acceptance B4 из Stage 132 прямо требовал: «После восстановления canonical artifact, manifest и
  fence должны быть согласованы» — не выполнено.

### 3.4 Влияние

- После любой regeneration (F1 → F2) достаточно сбоя rename/`publish_failed` или crash в окне
  commit→rename, чтобы сцена навсегда отдавала **старый** артефакт, помеченный ready, при
  manifest/done = F2. Пользователь видит результат предыдущей генерации.
- В R2 resume удаляет staged-байты текущего fence — потеря единственной копии закоммиченного
  результата (durable в Redis, но байты на диске уничтожены).
- Восстановление возможно только новой генерацией F3 (`committed` пишет с `overwrite:true`).

### 3.5 Направление исправления (только предложение, в Stage 134 НЕ реализовывалось)

Нужен durable-признак **завершённого** rename, отделяющий «этот fence уже опубликован» от
«в canonical лежит файл предыдущей генерации»: например, `published_at`/`renamed_fence` в manifest
или отдельный ключ `animastor:fence-published:{fence}` (SET после успешного rename, best-effort с
последующей сверкой). Тогда:
- `resume`/`duplicate` считают canonical «уже опубликованным» только при совпадении маркера с
  `manifest.published_fence`; иначе переигрывают rename (`overwrite:true` — intent-гейт уже
  гарантирует актуальность fence);
- `cleaned` не удаляет staging коммитнутого fence без такого маркера;
- acceptance: R1 и R2 заканчиваются `canonical == байты текущего fence`, `manifest.published_fence ==
  fence`, `done` присутствует, повторный resume идемпотентен, а redelivery уже опубликованного fence
  по-прежнему **не** перезаписывает canonical.

---

## 4. Дополнительные entry points (не обходят ли гейт)

| Путь | Запись canonical/ready | Гейт | Вывод |
|---|---|---|---|
| `POST /gpu/task/result` | через `handleTaskResult` | receipt-гейт в route (`generation-routes.cjs:528–553`) + повторно в handler (`task-handler.cjs:104–124`) | нельзя пройти без receipt; единственная регистрация маршрута в `src` |
| `POST /gpu/task/error` | нет записи артефакта (state/journal через `failStage`, identity-проверка внутри) | `verifyDispatchIdentity` (route + `failStage`) | публикации нет |
| `taskHandler.handleTaskResult` — прямые вызовы | route, `audio-recovery`, reconcile Phase A | route/audio-recovery передают receipt-fence; Phase A вызывает без fence → handler сам резолвит receipt и **бросает** `receipt_missing` (ключ истекает по TTL, ноль записей) | гейт общий |
| `recoverAudioForScene` (`POST /api/v1/debug/audio/recover`) | только через handler после receipt | gate первым (dispatch id → receipt) | ✅ |
| `recoverAudioResults` (scan, в production не подключён) | собственных записей больше нет — делегирует в gated per-scene | ✅ | ✅ |
| audio merge (`audio/generation.js`), video merge (`video/merge`) | пишут производные файлы | вызываются только из `completeChunk`/`completeGroup` **после** fenced commit чанка/группы | производные, не callback-вход |
| `scene_assets.markReady` (PG) | ready-строка | только `orchestrator.completeStage` после version-gate + identity | не из callback напрямую |
| `recoverChunksFromDisk` (startup) | ready по наличию файлов на диске | не callback-путь (pre-existing, вне scope) | не обходит гейт callback'ов |
| `placeholder-audio` | синтетические заглушки | не GPU-результат | вне scope |

Fence-резолв в callback-путях — **только** `resolveDispatchFence` (receipt). `readTaskRef` остался в
двух местах: settlement (`settleCompletedTask`) и `/gpu/task/error` (release claim) — это ownership-
индекс, не резолвер fence.

---

## 5. Telemetry и режимы

- Метрика отказов существует и растёт: `animastor_fence_commit_total{outcome="receipt_missing"}` (и
  `receipt_corrupt`), плюс degraded `animastor_intent_fence_degraded_total{reason="receipt_read_error"}`.
  Проверено независимо (`M1`): `receipt_missing ≥ 3`, `stale_intent ≥ 1`, метрики
  `animastor_legacy_no_receipt*` **нет** (упоминания в коде — только комментарии). Это счётчик
  **отклонённых** callback'ов, а не историческая экспозиция небезопасных legacy-записей — в отчёте
  и в комментариях это сказано корректно.
- HTTP/dedup: первый достав stale-callback'а получает явный `{rejected:true, reason:'receipt_missing'}`;
  повтор — `{deduped:true}` (терминальный отказ, записей нет). Поведение соответствует Stage 131/133 и
  ничего не публикует, но повтор **не** отличим от успеха — это осознанная семантика (наблюдение, не
  блокер).
- `GPU_FENCING_MODE`: default `observe` (`process.env.GPU_FENCING_MODE || 'observe'`), неизвестное
  значение → `observe`; `enforce` нигде не включён (в репозитории только чтение переменной); `observe`
  и `enforce` идентичны по построению; `off` — единственный путь прямой записи, требует явного
  действия оператора.

---

## 6. Тесты (свежий прогон, не старые логи)

Все команды выполнены на `cd31d279`, изолированно; PG-тесты используют штатную локальную тестовую БД
проекта (создают/удаляют только свои stamped-записи), production не затрагивался.

| # | Команда (cwd) | Exit | Результат | Лог |
|---|---|---|---|---|
| 1 | `npx mocha --exit tests/gpu-fenced-publication-gates.test.js` (`backend/`) | 0 | **18 passing**, 0 failing | `audit-134/gates.log` |
| 2 | `npx mocha --exit tests/gpu-result-fencing-commit.test.js tests/gpu-queue-idempotency.test.js tests/gpu-intent-fence-regressions.test.js tests/gpu-intent-fence-receipt.test.js tests/gpu-lane-release-order.test.js tests/dispatch-meta-lease-lifecycle.test.js tests/markready-build-id-idempotency.test.js` (`backend/`) | 0 | **189 passing**, 0 failing | `audit-134/targeted.log` |
| 3 | `npx mocha --exit tests/private-worker-phase2.test.js` (`backend/`) | 0 | **40 passing, 1 pending**, 0 failing | `audit-134/pw2.log` |
| 4 | `npx mocha --exit 'tests/architecture/*.test.js'` (`backend/`) | 0 | **935 passing, 24 pending**, 0 failing | `audit-134/architecture.log` |
| 5 | `npx mocha --recursive tests/ --exit` (`backend/`) | 0 | **3473 passing, 28 pending, 0 failing** | `audit-134/full-suite.log` |
| 6 | `./scripts/syntax-smoke.sh backend` (repo root) | 0 | `All production JS/CJS files pass syntax check` | `audit-134/syntax.log` |
| 7 | `node audit-133/01-real-redis-blockers.cjs` (harness автора, перезапуск) | 0 | **12/12** | `audit-134/rerun-audit133-harness.log` |
| 8 | `node audit-134/01-independent.cjs` (собственный) | 0 | **15/15** проверок, probes=2 | `audit-134/01-log.txt` |
| 9 | `node audit-134/02-minimal-repro.cjs` (собственный) | 0 | `blocked=true` (R1/R2 инвариант нарушен) | вывод + `02-results.json` |

**Ключевое:** зелёный полный suite (3473/28/0) **не скрывает** B6 — ни один существующий тест не
воспроизводит «в canonical уже лежит предыдущая генерация», поэтому R1/R2 проходят мимо suite.
Все проверенные сценарии Stage 132 (T1, T2, T4, T6, T7, T8, R8) действительно закрыты — это
подтверждено двумя независимыми harness'ами на реальном Lua.

---

## 7. Явно оставшиеся риски (не исправлялись, scope не расширялся)

| Риск | Проверялся в этом аудите? | Статус |
|---|---|---|
| PostgreSQL fenced projection/replay, отсутствие `generation_fence` migration | нет (schema/код не менялись) | **открыт**, как и в 132/133 |
| manifest retention: нет TTL, `RESUME_MANIFEST_LIMIT=200`, GC только `.staging` | частично (код прочитан) | **открыт** |
| Redis epoch-gap на send-side | нет (dispatch-side читатели не ревьюировались) | **не объявляется устранённым** |
| Redis Cluster CROSSSLOT / reply-length fallback | нет | **открыт** (fail-closed `unavailable`) |
| устаревшая копия `@animastor/orchestration` в `backend/node_modules` | да: reconcile Phase A вызывает handler без fence → `receipt_missing`; в установленной копии код не входит в terminal-список, ключ живёт до TTL, **записей нет** | **открыт** (деплой-долг) |
| `GPU_FENCING_MODE=off` допускает прямую запись | да (`A6`) | **сохранён осознанно**, вне scope |
| `observe == enforce` | да (код + `A5`) | **по построению**, миграция не завершена |
| **B6: canonical/manifest/fence расходятся после regeneration** (R1/R2) | да, воспроизведено | **НОВЫЙ БЛОКЕР** |

---

## 8. Критерии вердикта

| Критерий | Статус |
|---|---|
| Проверен точный commit `cd31d279…` | ✅ `cd31d2790231617f0c90b3ac523a54692aab5357`, файлы == HEAD |
| B1–B5 независимо подтверждены адресными сценариями | ✅ 15/15 + повтор harness 12/12, реальный Redis/Lua/FS |
| Stale callback не публикует под чужим/current fence | ✅ A1/A2 (+A1b: настоящий F2 публикуется) |
| Ошибки Redis и отсутствие receipt не дают fail-open | ✅ A3/A4/A5 |
| Debug recovery не пишет до gate | ✅ A7a–A7c, успех A7d |
| Crash recovery не восстанавливает superseded artifact | ✅ A8 |
| **Актуальный callback и recovery продолжают работать** | ❌ **R1/R2 (B6)**: retry текущего fence рапортует успех без публикации; resume удаляет staged текущего fence |
| Повторные тесты успешны, непроверенное перечислено | ✅ §6, §7 |
| Рабочее дерево и посторонние файлы не изменены | ✅ HEAD/10 статусов/8 хэшей идентичны baseline |

**Итог: BLOCKED** — B1–B5 закрыты, но B6 (P1) воспроизводится на `cd31d279` и нарушает
«canonical/manifest/fence согласованы» + «актуальный callback/recovery работают». Код в рамках
аудита не менялся; минимальное воспроизведение сохранено:
`audit-134/02-minimal-repro.cjs` (+ `02-results.json`, `01-results.json`, `01-log.txt`).

### Артефакты

```
/home/animastor/reorg-2026-10-23/audit-134/
  01-independent.cjs      01-results.json   01-log.txt
  02-minimal-repro.cjs    02-results.json
  gates.log  targeted.log  pw2.log  architecture.log  full-suite.log  syntax.log
  rerun-audit133-harness.log
```

Throwaway-контейнеры `a134-redis` (6398) и `a134-redis-6397` удалены; production-контейнеры
(`animastor-backend/proxy/pg/redis`, `gpu-hub`, `repro-redis`, buildkit) не трогались.
