# Этап 47 — invariant «FAILED / asset.audio=dirty»

**Дата:** 2026-10-13 (окно ~05:45–06:30 UTC)
**Итог: PARTIAL** — диагноз: **Case A, проверка ошибочна** (production-данные
корректны). Исправление применено в `packages/animastor-orchestration`
(аудио + зеркально видео), +16 тестов, полный набор без регрессий, коммит
`691bfa1` запушен. **Rollout удержан:** фикс живёт в npm-пакете
`@animastor/orchestration`, а `npm publish` невозможен (`401 Unauthorized`),
поэтому production-образ `deploy-c8837f0` остался прежним и по-прежнему
логирует 3 ложных `audio_orch_invariant_failed`. Production-данные
(Redis/PG/книги/output) не изменялись — только чтение.

---

## 0. Краткая сводка

| Пункт задачи | Статус | Факт |
|---|---|---|
| 1. Ложная ошибка или реальное нарушение | **Case A — ложная** | §2: единственный писатель `FAILED+DIRTY` — startup C1/C1b recovery, это намеренный итог; рекомендация самого чека — `mark_dirty` |
| 2. Минимальное корректное исправление | **да** | §3: в ветку `phase=FAILED` добавлено допустимое `DIRTY` (audio + video); `DONE`/промежуточные ветки **не ослаблены** |
| 3. Данные не чинить руками | **да** | 3 июльских ключа не переписаны, dirty не сброшен, PG `stale` не трогали (§5) |
| 4. Тесты: допустимые и запрещённые сочетания | **да** | §4: 16 новых — allowed → `null`; `FAILED×ready` / `DONE×dirty` / `intermediate×ready` → violation; идемпотентность повторного recovery; guard байтовой идентичности пакета |
| 5. Targeted + полный набор, сравнение failure-set | **PASS** | targeted `reconciliation-engine` **79/0** (было 63); полный **3158 passing / 28 pending / 4 failing**, failure-set **идентичен** базе stage 46 (3142 → +16); `test:syntax` OK |
| 6. Коммит + CI + immutable образ | **BLOCKED** | `691bfa1` запушен (`f9e9b11..691bfa1`); CI не запускался, образ не собирался — `backend/package-lock.json` пинит `@animastor/orchestration@0.1.1` |
| 7. Rollout | **не выполнялся** | §6: npm token → `401`; без `0.1.2` в registry `npm install` в Dockerfile поставит старый 0.1.1 → правка в образ не попадёт |
| 8. Пост-проверки production | **PASS (read-only)** | §5: контейнер/изображение не пересоздавались, health 200/200/200, 3 ключа `FAILED+dirty`, active=1, `reconcile:6_issues` как до правки |
| 9. Откат | **не потребовался** | изменений в production нет |
| 10. Без посторонних изменений | **да** | DNS/TLS/GPU Hub/PG/Redis-конфиги/deploy не тронуты; несвязанные ветки FSM и архивные доки не менялись |

**До PASS нужно:** обновить npm-аутентификацию → `npm publish` `0.1.2` →
обновить lock в `backend/` → approval-коммит → `workflow_dispatch` → rollout →
пост-проверка (§7).

---

## 1. Симптом

После выката этапа 46 (`deploy-c8837f0`, контейнер `be739e49ecbf`, started
2026-10-13T05:31:19Z) на каждом reconcile-цикле:

```
[RECONCILE] [INVARIANT] import_1783656905372_1783656918982/ch-c779d21c/sc-1eb2306c: 1 audio-orch violations
[RECONCILE] [INVARIANT] …/ch-c779d21c/sc-45fc1833: 1 audio-orch violations
[RECONCILE] [INVARIANT] …/ch-c779d21c/sc-5860455d: 1 audio-orch violations
[RECONCILE] Full reconciliation complete: 10 scenes scanned, 6 inconsistencies found
[RECONCILE] Cycle complete [result_recovery:0, reconcile:6_issues] …
```

Read-only снимок трёх ключей (запросы из контейнера, без записей):

| Сцена | audio-orch | asset.* | PG |
|---|---|---|---|
| `sc-1eb2306c` | `phase=FAILED`, `fail_reason=restart_recovery`, `failed_at=1791869480698` | audio/image/video = `dirty` | `scene_assets.status='stale'` |
| `sc-45fc1833` | то же (`…80694`) | `dirty` | `stale` |
| `sc-5860455d` | то же (`…80688`) | `dirty` | `stale` |

`failed_at` = 2026-10-13T05:31:20Z — первая загрузка нового образа, т.е. ровно
C1-recovery. Все три **вне** active-index (`SCARD animastor:active-scenes=1`,
`SISMEMBER`=0), `audio-orch`-ключей всего 8, из них `FAILED` — 3.

Разбор `6 inconsistencies`: **5 = audio-orch invariant** (эти 3 ложных + 2
pre-existing `audio_orch_invariant_done` на `sc-5f18dd0f`, `sc-5f0068ca` из
книги `import_1786345731767_…`), 1 = pre-existing инцидент другого типа (не
связан с FAILED+dirty — не трогали).

---

## 2. Диагностика: почему это ложное срабатывание (Case A)

**Факт:** `checkAudioOrchInvariants` (до правки) в ветке `phase=FAILED`
принимала только `FAILED | PENDING`, а штатный итог recovery — `DIRTY`.

**Кто пишет `FAILED` на стороне оркестратора:**

| Писатель | Что пишет в asset | До правки |
|---|---|---|
| `failStage(redispatch=true)` | сначала `FAILED`, тут же `PENDING` | допустимо |
| `failStage(redispatch=false)` | `FAILED` | допустимо |
| **startup C1/C1b `recoverAudioOrchStates`** | `setFailed` → `unsafeRestoreAssetState(…, FAILED)` → `markDirtyScene` → **`DIRTY`** (+ PG `stale`) | **нарушение** |

Почему `DIRTY` — это требование, а не дефект:

1. **Scheduler.** `shouldScheduleAssets()` (`runtime-scheduler.js:319-348`)
   считает `READY`/`FAILED` терминальными: такой asset уходит из active-index
   (`allDone`) и **не диспатчится никогда**; наружу идут только
   `PENDING`/`DIRTY`. Оставить `asset=FAILED` — сцена застревает навсегда.
2. **FSM ассетов** (`packages/animastor-generation/src/core/scene-state.js`):
   `FAILED → [PENDING, DIRTY]`, `DIRTY → [PENDING, PLACEHOLDER]`,
   `DIRTY → GENERATING` невалиден, т.е. `FAILED → DIRTY` — штатный переход.
3. **Самопротиворечие проверки.** Рекомендация нарушенного чека —
   `recommendation: 'mark_dirty'`: код требует перейти в состояние, которое
   сам же объявляет нарушением.
4. **Поведение с `DIRTY` — самолечение.** Dispatch → `ensureStageDispatchable`
   отклоняет `DIRTY → GENERATING` → abort → `rollbackStageToPending`
   (`DIRTY → PENDING`) → следующий тик диспатчит (2 тика). Бага поведения
   нет — есть только ложная запись в отчёт.
5. **Последствия нулевые.** `getFixRecommendations` → `REVIEW_MANUALLY`,
   `safeToExecute:false` (log-only); recovery идемпотентно (повторный запуск
   пропускает `FAILED`); плеер читает файлы с диска; PG `status='stale'` —
   пометка «нужна регенерация».
6. **Не новое.** Та же последовательность всегда срабатывала для успешных
   `WAITING_CHUNKS/MERGING → FAILED` recovery (§7 отчёта этапа 46).

**Отклонённые альтернативы:**
- *Case B — писать в C1 `PENDING` вместо `markDirtyScene`:* теряется семантика
  `asset=dirty` + PG `status='stale'`; правка всё равно требует выхода пакета.
- *Затереть dirty в проде:* запрещено инвариантом задачи и бесполезно —
  следующий restart снова породит это сочетание.

---

## 3. Исправление

`packages/animastor-orchestration/src/runtime/reconciliation-engine.js` —
4 правки (в связке с doc-комментариями: 4 файла, 259+/10−):

1. Заголовок секции аудио-invariant: `phase=FAILED ⇒ asset.audio ∈
   {FAILED, PENDING, DIRTY}` + обоснование stage 47 (кто пишет, почему
   `shouldScheduleAssets` требует dirty, про `recommendation: mark_dirty`).
2. Аудио-ветка `phase=FAILED`: добавлен `state.AssetState.DIRTY`,
   `expected: 'FAILED, PENDING or DIRTY'`; `READY`/`GENERATING` остаются
   настоящим противоречием.
3. Заголовок секции видео-invariant — зеркало.
4. Видео-ветка `phase=FAILED` — зеркальный `DIRTY`.

**Намеренно НЕ менялось:**
- ветка `phase=DONE` (audio и video): `DONE + dirty` по-прежнему даёт
  `audio_orch_invariant_done` — 2 pre-existing записи остаются видимыми;
- промежуточные ветки: флагируют только `READY` (и так допускают `DIRTY`);
- `recommendation: 'mark_dirty'` / `safeToExecute:false` — остаётся log-only;
- FSM переходы, `failStage`, `recoverAudioOrchStates`, PG-писатели — не
  тронуты: чинилась проверка, а не поведение;
- doc-комментарии инвариантов в `backend/src/services/audio-orchestrator.js`
  и `video-orchestrator.js` синхронизированы (только комментарии, 0 логики);
- архивные `docs/99-archive/…` не правились.

---

## 4. Тесты

Новый suite в `backend/tests/reconciliation-engine.test.js` —
**«orch invariants — FAILED + DIRTY (stage 47)»**, 16 тестов:

| Группа | Что фиксирует |
|---|---|
| allowed → `null` (7) | audio `FAILED × {dirty, failed, pending}`, `DONE × ready`, intermediate × `{dirty, pending, generating}`; video `FAILED × {dirty, failed, pending}` |
| real contradictions (5) | `FAILED × ready` → `audio_orch_invariant_failed` (`expected=FAILED, PENDING or DIRTY`), `FAILED × generating` → violation, `DONE × dirty` → `audio_orch_invariant_done`, intermediate × `ready` → `audio_orch_invariant_intermediate`, video `FAILED × ready` → `video_orch_invariant_failed` |
| log-only рекомендация (1) | `getFixRecommendations([audio_orch_invariant_failed])` → `REVIEW_MANUALLY`, `safeToExecute=false` |
| C1 end-to-end (2) | recovery (реальный `setFailed` + реальные записи) → `phase=FAILED` + `asset=dirty` → инвариант чист; **второй запуск → 0, `failed_at` и dirty не меняются**; запись `DONE+ready` recovery не трогает и даёт `null` |
| guard (1) | sha256 `backend/node_modules/…/reconciliation-engine.js` == `packages/…` (тесты проверяют ровно те байты, что уходят в пакет) |

Ветка audio читается через AudioFsmPort → замоканный host-модуль, поэтому
`getState` перекрыт чтением из Redis (иначе проверка проходила бы
пустотно); video — через реально подключённый VideoFsmPort (`.mocharc` test
bindings).

**Прогоны:**

| Набор | Результат |
|---|---|
| `npx mocha tests/reconciliation-engine.test.js` | **79 passing / 0 failing** (63 → +16) |
| полный `npx mocha 'tests/**/*.test.js' --exit` | **3158 passing / 28 pending / 4 failing** |
| failure-set vs база stage 46 (`/tmp/opencode/stage46-fullsuite.log`) | **идентичен** (`diff` пуст): те же 4 pre-existing (LLM Sharing ×2, `IB-G15`, `phase5 T9` ENOENT); 3142 → 3158 = ровно +16 новых |
| `npm run test:syntax` (`scripts/syntax-smoke.sh`) | все production JS/CJS проходят |

Логи: `/tmp/opencode/stage47-fullsuite.log`.

---

## 5. Production сейчас (read-only, без изменений)

| Проверка | Значение |
|---|---|
| контейнер `animastor-backend` | `be739e49ecbf`, image `8a05f2e6024d` = `deploy-c8837f0` (rollout этапа 46) — **не пересоздан, не перезапущен нами** |
| `animastor.org/health`, `gpu/health`, `app.animastor.org` | **200 / 200 / 200**; `{"gpus":0,…,"running":0}`, очереди image:8 живы |
| `audio-orch` ключей | 8, из них `phase=FAILED` — **3** (те же июльские сцены, `fail_reason=restart_recovery`, `failed_at` не изменились) |
| assets трёх сцен | audio/image/video = `dirty` — **не сбрасывались**; PG `stale` — **не менялся** |
| active-index | `SCARD=1`, три июльские сцены по-прежнему не в индексе |
| reconcile | `reconcile:6_issues`, `[INVARIANT]`-строк — те же 5 сцен (3 ложных + 2 pre-existing `DONE+dirty`) |
| counter drift | `COUNTER_RECONCILIATION_COMPLETE: 0 corrected, 0 total drift` |

**Что покажет прод после применения фикса** (проверено read-only прогоном
нового правила по текущим данным: 8 ключей × phase/asset):

```
FAILED + dirty ×3  → ok          (было: audio_orch_invariant_failed)
DONE    + ready ×3 → ok
DONE    + dirty ×2 → audio_orch_invariant_done   (pre-existing, остаются)
новых нарушений: failed=0, intermediate=0
```

Т.е. фикс снимает ровно 3 ложных записи и ничего больше — 2 настоящих
`DONE+dirty` остаются видимыми (вне скоупа этапа).

---

## 6. Статус rollout и блокер

**Rollout не выполнялся, изменений в production нет.**

Цепочка поставки: `packages/animastor-orchestration` → npm
`@animastor/orchestration` → `backend/package.json` (`^0.1.1`) +
`backend/package-lock.json` (пин `0.1.1`, integrity `sha512-Jd97Ge1H…`) →
`backend/Dockerfile` (`npm install --omit=dev` из registry) → immutable
image. CI (`backend-ghcr-release.yml`) строит с контекстом `./backend` и
требует `backend/` дерево == `APPROVED_COMMIT`.

- `npm whoami` → **`401 Unauthorized`** (токен из `~/.npmrc`, повторно
  проверено на этом шаге); `gh` CLI отсутствует.
- Без `0.1.2` в registry `npm install` в Dockerfile поставит тот же `0.1.1`
  (тарболл которого байт-в-байт == `packages/` на commit `f9e9b11`) → правка
  в образ **не попадёт**, а запуск CI дал бы image без фикса.
- Локальная синхронизация `backend/node_modules/@animastor/orchestration/…`
  сделана (тесты и guard читают те же байты), но `node_modules` в
  `.gitignore` — в репозиторий и в image она не попадает.

Решение оставлено владельцу: (а) обновить npm-аутентификацию и пройти штатный
путь §7 — рекомендуется; (б) альтернатива «vendored tarball пакета в
`backend/`» — более рискованная (обходит approval/pin), **не применялась**.

---

## 7. Путь к PASS

1. Обновить npm-токен для `@animastor` (`npm whoami` должен вернуть логин).
2. `npm version 0.1.2` + `npm publish` в `packages/animastor-orchestration`.
3. В `backend/`: `npm install @animastor/orchestration@0.1.2` (обновит
   `package.json` + `package-lock.json`), targeted-прогон.
4. Коммит фикса + lock (это меняет `backend/` дерево) → **approval-коммит**
   (`APPROVED_COMMIT` = новый SHA) → push.
5. `workflow_dispatch` (тег `deploy-<sha>`) → проверка success-рана и
   byte-identity образа.
6. Rollout одной строкой `BACKEND_IMAGE` (`docker compose … up -d`, dry-run
   только `animastor-backend Recreate`), прежний digest сохранить для отката.
7. Пост-проверки: health 200/200/200, `[INVARIANT]`-строк по июльским сценам
   **0**, `reconcile` без `audio_orch_invariant_failed`, 2 pre-existing
   `DONE+dirty` остались, активные задачи не тронуты.

---

## 8. Артефакты

- Коммит `691bfa1` `fix(reconcile): allow DIRTY with phase=FAILED in
  audio/video-orch invariants (stage 47)`, push `f9e9b11..691bfa1` (4 файла,
  259+/10−). CI-ран не создавался (см. §6).
- Правленные файлы:
  `packages/animastor-orchestration/src/runtime/reconciliation-engine.js`,
  `backend/src/services/audio-orchestrator.js` (комментарии),
  `backend/src/services/video-orchestrator.js` (комментарии),
  `backend/tests/reconciliation-engine.test.js`.
- Синхронизированная копия:
  `backend/node_modules/@animastor/orchestration/src/runtime/reconciliation-engine.js`
  (sha256 `16d53aa7c335f89b98c6020e267ec038ea4e92161d035de8b8c3f5a6f657fbf0`
  — идентична `packages/`, проверяется guard-тестом).
- Логи тестов: `/tmp/opencode/stage47-fullsuite.log`,
  база сравнения `/tmp/opencode/stage46-fullsuite.log`.
- Прод-данные: запросы только на чтение (Redis `GET/HGET/HGETALL/KEYS/SCARD/
  SISMEMBER` из контейнера, PG не писался, `reconcileScene` в проде **не
  вызывался**).


