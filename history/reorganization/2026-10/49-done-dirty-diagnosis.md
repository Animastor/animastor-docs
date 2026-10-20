# Этап 49 — Диагностика двух записей `DONE` + `dirty`

**Дата:** 2026-10-13
**Статус:** **PASS** (диагностика) + **PARTIAL** по одному подвопросу — см. §7 «Чего не удалось доказать».
**Production:** не затронут. Только read-only запросы к PG/Redis/логам, локальные тесты. Ни одна запись не изменена, ни один dirty не очищен, ни одна фаза не сброшена.

---

## 1. Что было в задаче

`reconcile:3_issues` в production (после `@animastor/orchestration@0.1.2`, этап 48). Две из трёх — это
`audio_orch_invariant_done`: сцены, у которых `audio-orch.phase = DONE`, а `asset.audio = dirty`.

Нужно было:

1. локализовать обе записи;
2. доказать причину каждого случая;
3. решить, допустимо ли `DONE`+`dirty` по модели проекта;
4. при неоднозначности / ошибочной проверке — добавить регрессионные тесты;
5. **не** менять бизнес-логику без доказанного дефекта;
6. не трогать production-данные.

---

## 2. Обе записи (п.1 — done)

Книга `import_1786345731767_1786345734345` («Мастер и Маргарита»), одна глава на сцену.

| | Case A | Case B |
|---|---|---|
| chapter / scene | `ch-1bb5123c` / `sc-5f18dd0f` | `ch-37eadabb` / `sc-5f0068ca` |
| `audio-orch` | `phase=DONE`, expected 17, chunks 17, `started_at=1786699233208`, `last_chunk_at=1786699341094` | `phase=DONE`, expected 17, chunks 17, `started_at=1786631788192`, **`fail_reason=chunk_stall_timeout:67377s`, `failed_at=1786699164897`, `last_chunk_at=1786699223318`** |
| `asset-state` | audio **dirty**, image pending, video dirty | audio **dirty**, image dirty, video ready |
| `assets` (registry) | audio `ready=true`, `registeredAt=1786699346945` (2026-08-14T09:22:26Z) | audio `ready=false`, image `ready=false`, video `ready=true` (`registeredAt=1787886805445`) |
| PG `scene_assets` | audio ×2, обе `status=stale`, `updated_at=1787060525` = **2026-08-18T13:42:05Z** | audio ×1 `stale` + image ×409 `stale` @ **2026-08-28T03:02:32Z**, video `ready` @ 2026-08-28T03:13:25Z |
| файл на диске | `…sc-5f18dd0f.mp3` 299 853 B, mtime 2026-08-14 09:22 — **есть** | — |
| в `animastor:active-scenes` | **нет** | **нет** |

Третья из `3_issues` — **не** эта пара и **не** invariant:
`[SET-PENDING] …/sc-45c789c6 image: generating→pending rejected` (§6).

---

## 3. Механизм: почему `DONE`+`dirty` вообще возможно (п.3)

### 3.1 Задокументированная модель запрещает эту пару

Одно и то же утверждение повторено в четырёх местах:

- `docs/01-overview/ARCHITECTURE.md:374` — «Invariants: phase=DONE ⇔ asset.audio=READY»
- `docs/02-orchestration/ORCHESTRATION.md:104`
- `backend/src/services/audio-orchestrator.js:15` (шапка модуля)
- `packages/animastor-orchestration/src/runtime/reconciliation-engine.js:609`

⇒ **по заявленной модели `DONE`+`dirty` недопустимо.** Проверка `audio_orch_invariant_done`
(строка 641-651) реализует именно это утверждение.

### 3.2 …но достигается по конструкции

Три независимых факта делают пару неизбежной:

1. **`DONE` — терминальная фаза.** `VALID_TRANSITIONS[DONE] = []`
   (`audio-orchestrator.js:75`). Из `DONE` не выходит **ни один** писатель, включая
   `transitionState`, — сброс фазы возможен только через `deleteState`/`setState`.
2. **Писатели `dirty` не трогают фазу.** Единственный владелец записи `DIRTY` —
   `markDirtyScene` (`backend/src/state/scene-state-ops.js:53-70`): он пишет только
   per-asset FSM + PG `scene_assets.status='stale'`. В его шапке прямо сказано:
   *«просто маркирует assets как DIRTY, оставляя активный индекс scheduler'у»*.
   То же верно для `markVersionStaleDirty` (`runtime-scheduler.js:264-290`),
   Lua `book-diff.markDirtyScenes` и `checkVersionStaleness` (`reconciliation-engine.js:2110`,
   фаза C2: `orchestrator.markDirtyScene(...)` со **всеми** ассетами).
3. **Фикс спроектирован, но не сделан.**
   `docs/99-archive/04-planning/ORCHESTRATOR_CONVERGENCE_TODO.md`, **Фаза 4**
   *«markDirtyScene чистит audio-orch»*, приоритет **HIGH**, шаг 4.1:
   *«в `markDirtyScene` → если `audio` в assets: `getState()` → DONE? `deleteState()`»*
   — статус 🔴 (не начато), как и Фаза 5 (`setScenePending` чистит `DONE`).

**Вывод:** `DONE`+`dirty` — не ложное срабатывание проверки, а **настоящий рассинхрон
двух state-machine, produцируемый самими писателями**. Ось `phase` («последний прогон
генерации завершён») и ось `dirty` («производный результат устарел, нужна регенерация»)
ортогональны, но модель документирована как равенство, а не как независимые флаги.

### 3.3 Следствие (liveness) — отдельный, доказанный дефект

`DIRTY` у audio при `phase=DONE` **не может быть пере-диспатчен**:

- `shouldScheduleAssets` включает `DIRTY` в кандидаты (`runtime-scheduler.js:292+`);
- но `executeAudioDispatch` первым делом читает фазу и при `DONE` возвращает
  `{dispatched:false, completed:true, reason:'already_done'}`
  (`packages/…/orchestration/scene-orchestrator.js:163-166`), плюс второй guard на 186;
- а выйти из `DONE` нельзя (п.3.2-1).

Итог: пометка «нужна регенерация аудио» на сцене с `phase=DONE` **молча необратима** —
грязный флаг висит вечно, регенерация не запускается ни при каком условии, кроме
ручного `deleteState` фазы. Это то самое, что Фаза 4 convergence-TODO и должна была устранить.

---

## 4. Хронология по случаям (п.2)

Journалы сцен в Redis полные (59 994 и 380 913 записей), не усечены.

### Case A — `sc-5f18dd0f`

| UTC | событие |
|---|---|
| 2026-08-14T09:20:28Z | `SCENE_RESET_STARTED/COMPLETED` (`scope=current_scene, force=false, marked=1`) |
| 2026-08-14T09:20:33Z | audio-orch `started_at` |
| 2026-08-14T09:22:26Z | `AUDIO_COMPLETED` / `state=audio_ready` → **asset.audio = ready**, registry `ready=true`, фаза → `DONE` |
| 2026-08-14T09:23:25Z → 2026-08-16T04:50:54Z | 2 623 попытки `setScenePending(audio)` → `INVALID state=ready attempted=pending` (READY→PENDING невалиден по FSM) |
| **2026-08-16T04:50:54.860 → 04:50:58.430** | в окне **3.6 с** asset.audio `ready` → **`dirty`** (первое наблюдение `state=dirty`); в те же миллисекунды `dirty` становится и image, image тут же откатывается `dirty→pending`, и в 04:50:58.429/04:50:58.432 оба ассета уходят в `DISPATCH_STARTED` |
| 2026-08-18T13:42:05Z | PG `scene_assets` audio ×2 → `stale` (обе строки одним `UPDATE` ⇒ вызов `markDirtyScene(..., ['audio'], buildId=null)`) |
| 2026-08-18T13:42:06Z | `AUDIO_DISPATCHED` → `INVALID state=dirty attempted=generating` (DIRTY→GENERATING невалиден) |
| 2026-08-18T13:50:20Z | `DISPATCH_CANCELLED reason=book_reset` |

Ключевой факт: **последнее наблюдение `ready` (04:50:54.860) и первое `dirty` (04:50:58.430)
разделены 3.6 с**, и в этот же тик scheduler уже диспатчит оба ассета — то есть запись
`DIRTY` произошла **внутри тика, непосредственно перед диспатчем**, а не позже.
PG-строка `stale` от 08-18 — это **повторный** `markStale`, а не первый.

### Case B — `sc-5f0068ca`

| UTC | событие |
|---|---|
| 2026-08-13T14:36:28Z | audio-orch `started_at`; первый `AUDIO_DISPATCHED` → `INVALID state=new attempted=generating` |
| 2026-08-14T09:19:24Z | `setFailed('chunk_stall_timeout:67377s')` ⇒ `fail_reason/failed_at` остаются в записи навсегда (`transitionState` делает `Object.assign`) |
| 2026-08-14T09:19:23Z | `DISPATCH_FAILED reason=invalid_asset_state` |
| **2026-08-14T09:50:26Z** | первое наблюдение `asset.audio = dirty` |
| 2026-08-16T04:31Z | первое `asset.image = dirty` |
| 2026-08-26T02:55:54Z | последнее наблюдение `audio=dirty` |
| 2026-08-26T03:49:36Z | 4 × `SCENE_RESET_STARTED/COMPLETED` (`marked=1`) |
| 2026-08-28T03:02:32Z | PG audio+image(×409) → `stale`; в ту же секунду `video` dispatch: `INVALID state=dirty attempted=generating` → cancel → rollback → `SCENE_GENERATING` |
| 2026-08-28T03:13:25Z | `VIDEO_COMPLETED` → video `ready` |

**Важно:** в журнале B **нет ни одного `AUDIO_COMPLETED`** — `completeStage('audio')` для этой
сцены не выполнялся, registry `audio.ready=false`. При этом фаза `DONE`. Т.е. `DONE` тут
достигнут путём `setDone` **без** синхронной записи READY (ветки `completeChunk` с
`expected_count=0`/fast-track, `scene-orchestrator.js:243-254`), после чего ассет ещё раз
ушёл в `dirty`. `fail_reason` в записи — ровно тот остаток FAILED, который потом не очищался.

### Общая причина (п.2, итог)

Оба случая — **один и тот же механизм**: пер-ассет `DIRTY` выставлен вызовом семейства
`markDirtyScene` (молчаливым: без journal-события и без success-лога — `scene-state-ops.js:53-70`),
а фаза `audio-orch = DONE` осталась нетронутой, потому что терминальна. Различие только в
предыстории (A: успешное завершение 08-14; B: провал `chunk_stall_timeout` + `setDone` без READY).

---

## 5. Допустимо ли `DONE`+`dirty` по модели? (п.3)

| Уровень | Ответ |
|---|---|
| **Заявленная модель** (ARCHITECTURE / ORCHESTRATION / шапка `audio-orchestrator` / шапка invariant-блока) | **Нет.** Утверждается `phase=DONE ⇔ asset.audio=READY`, проверка `audio_orch_invariant_done` (стр. 641) реализует его буквально. |
| **Реализованная модель** | **Да, достигается по конструкции** (§3.2): терминальная `DONE` + писатели `dirty`, которым планируемый синхронизатор (`convergence Фаза 4`) не был написан. |
| **Это ложное срабатывание?** | **Нет.** Проверка корректна и должна продолжать срабатывать. Ослаблять её (в духе stage 47 для `FAILED`) нельзя: у stage 47 ослабление было обосновано тем, что сама рекомендация вела в отвергаемое состояние, — здесь рекомендация ведёт в **потерю обязательной регенерации**. |
| **Это дефект?** | **Да, но в писателях, а не в диагностике.** Два поддефекта: (а) рассинхрон phase↔asset (§3.2), (б) liveness — грязный аудио-ассет при `DONE` никогда не пере-диспатчится (§3.3). |

### Второй, независимый пробел диагностики

`violation.recommendation = 'run_completeStage'` (строки 649 и 717) — **мёртвая и
ошибочная по смыслу строка**:

- `reconcileScene` отбрасывает violation целиком и кладёт в `inconsistentScenes`
  только `{scene, issue: v.type}` (стр. 982-990) — поле `recommendation` никуда не попадает;
- `getFixRecommendations` (стр. 1018) не знает `*_invariant_done` → `default` →
  `REVIEW_MANUALLY`, `safeToExecute: false` → в цикле авто-фиксов (стр. 1756-1763)
  **не выполняется**;
- если бы оно когда-либо и было бы использовано, `run_completeStage` записал бы
  `asset=READY` и **стер бы маркер dirty, требующий регенерации**, — т.е. предписывал бы
  ровно неверное действие.

Поведение «log-only» — **правильное**; исправлять нужно лишь вводящий в заблуждение текст.

---

## 6. Третий issue из `3_issues` (context)

Не invariant и не `DONE`+`dirty`:

- Сцена `ch-1bb5123c/sc-45c789c6`: `asset.audio=ready`, `asset.image=generating`
  (живой dispatch, lease `dispatch-1791881560393-…`), а в `animastor:assets:…` **есть только
  поле `audio`** — `image` ещё не зарегистрирован.
- `checkPartialBuilds` (стр. 353-364): `audioReady && !assets.image` → `partial_audio_only`.
- → `PROGRESS_TO_IMAGE` (`safeToExecute:true`, стр. 1331-1343) → `setScenePending(image)` →
  `generating→pending rejected` → фикс не срабатывает и **повторяется каждый цикл**.

Т.е. ложное срабатывание `partial_audio_only` на **активно генерирующейся** сцене: реестр
ассетов пишется только по факту готовности, а проверка требует его наличия уже «на старте
image». Это отдельный (не трогали) дефект диагностики — `3_issues` никогда не упадёт ниже 3,
пока идёт генерация `sc-45c789c6`.

---

## 7. Чего не удалось доказать (evidence gap)

Точного **вызывавшего `markDirtyScene`** для обоих случаев установить нельзя. Перечень
недостающих доказательств:

1. **`markDirtyScene` молчит** — ни journal-события, ни success-лога
   (`scene-state-ops.js:53-70`; `grep log(` показывает только warn-ветки). Видно только
   *эффект* (PG `stale`, `state=dirty`), но не *причину*.
2. **`reconciliation_events` в PG пуста полностью** (`count = 0`) — авто-фиксы
   `stuck_state` / `orphan_generating` журналируют `AUTO_RECOVER` в **Redis**-журнал сцены,
   а `RELEASE_STALE_LEASE`, `markVersionStaleDirty`, `checkVersionStaleness` (C2) — не журналируют вовсе.
3. **Логи backend за 2026-08-16/08-18 не сохранены** — `docker logs` покрывает только
   последние сутки; искать `[VERSION-STALE]`/`[VERSION-DIRTY]` за даты инцидента нечем.
4. **PG `scenes` содержит 0 строк для этой книги** (вообще 12 строк в таблице) —
   поэтому `detectVersionStaleness`/`checkVersionStaleness` сейчас для неё возвращают пусто;
   на даты инцидента наличие строк не проверяемо.

**Кандидаты, подходящие по подписи** (молчаливые, пишут `DIRTY` для READY-ассетов, не
трогают фазу), ранжированы по соответствию наблюдениям:

| Кандидат | Соответствие |
|---|---|
| `checkVersionStaleness` — фаза C2, `markDirtyScene(все ассеты)` (`reconciliation-engine.js:2134`) | **Высокое.** Живой: `[VERSION-STALE]` встречается 12 раз за 72 ч в production (для других книг) на старте. Тиражирует ровно нашу пару. |
| `markVersionStaleDirty` (`runtime-scheduler.js:287`) | Среднее: пишет в том же тике, что и диспатч, но требует `detectVersionStale=true`, что сейчас для этой книги даёт `false`. |
| `RELEASE_STALE_LEASE` авто-фикс (`reconciliation-engine.js:1286`) | Низкое: он ещё и гасит lease, а после записи dirty lease в обоих случаях оставался активен (`DISPATCH_SKIPPED_DUPLICATE reason=lease_active` продолжался). |
| `stuck_state` → `MOVE_TO_PENDING` | Низкое: журналирует `AUTO_RECOVER` — в окне записи его нет. |
| C1/C1b recovery | Исключён: `phase=DONE` терминальна, recovery её пропускает. |

**Решение:** причина в её *механизме* доказана (§3-§4), в *имени конкретного вызывающего* —
нет. Поэтому бизнес-логика на этом этапе **не менялась** (§8). Для закрытия gap'а нужен
отдельный этап с инструментарием: success-лог/journal-событие в `markDirtyScene`
(+ `book-diff.markDirtyScenes`) либо сохранение `reconciliation_events`.

---

## 8. Изменения и тесты (п.4-5)

**Изменён ровно один файл, только тесты:**

```
backend/tests/reconciliation-engine.test.js | 55 +++++++++++++++++++++
```

Новый блок `describe('DONE + dirty (stage 49) stays reported and log-only')`:

| # | Тест | Что закрепляет |
|---|---|---|
| 1 | `audio DONE + pending / generating / failed → audio_orch_invariant_done` | вся ветка `DONE` (не только `dirty`) по-прежнему репортится; `expected = 'READY or PLACEHOLDER'` |
| 2 | `audio DONE + placeholder → null` | `PLACEHOLDER` — разрешённый терминальный исход, ложного срабатывания нет |
| 3 | `video DONE + dirty → video_orch_invariant_done` | **закрытая ранее дыра**: зеркальная video-проверка вообще не имела теста на `DONE` |
| 4 | `audio/video *_invariant_done → REVIEW_MANUALLY, safeToExecute=false` | log-only для **обоих** invariant'ов (раньше пинился только `_failed`) |
| 5 | `no auto-fix path may run for DONE × dirty — the dirty marker must survive reconcile` | авто-фиксов для `DONE×dirty` нет ⇒ reconcile **не может** молча стереть обязательную регенерацию |

Почему добавлены именно они: обнаруженная неоднозначность — (а) dead/ошибочная строка
`recommendation: 'run_completeStage'` (§5) и (б) отсутствие какого-либо пина того, что
`DONE×dirty` остаётся ручным. Тесты фиксируют **текущее, правильное** поведение так, чтобы
«починить» его ослаблением проверки или включением авто-фикса было невозможно без явного
пересмотра этих пяти утверждений.

**Чего НЕ делали (по запрету):** не ослабляли `audio/video_orch_invariant_done`, не меняли
`recommendation`-строки, не трогали `markDirtyScene`/`markVersionStaleDirty`/`checkVersionStaleness`,
не выкатывали фикс, не меняли production-данные.

### Верификация

```
целевой файл:  79 → 84 passing   (+5, 0 pending, 0 failing)
полный suite:  3163 passing / 28 pending / 4 failing
```

Failure-set **идентичен базе stage 46/47** (`ai-endpoint-sharing`, `ai-shared-inference`,
`installer-package-boundary`, `phase5-runtime-result`) — регрессий нет.
Существующий тест `audio DONE + dirty → … (terminal invariant not weakened)` (стр. 1335)
и тест сверки `node_modules` ↔ `packages/` проходят.

---

## 9. Production (п.5)

**Не затронут.**

- Контейнер `animastor-backend` не перезапускался и не пересобирался, образ/digest не менялись.
- Все обращения к PG и Redis — `SELECT`/`GET`/`HGETALL`/`LRANGE`/`TYPE`; ни одного `SET`/`HSET`/`DEL`/`UPDATE`/`DELETE`.
- Журналы читались через `docker logs` только на чтение.
- Изменённые файлы: `backend/tests/reconciliation-engine.test.js` (в git-рабочем дереве, не выкачен).
- `git status`: ` M backend/tests/reconciliation-engine.test.js` (+ ранее существовавшие untracked `deploy/`, `freebuff-chat-2026-10-11T07-41-12.445Z.md`).

Состояние после этапа: `reconcile:3_issues` остаётся прежним (2 × `audio_orch_invariant_done`
+ 1 × `partial_audio_only`); ничего не чинилось и не должно было починиться.

---

## 10. Итог кратко

- **PASS** по диагностике; **PARTIAL** только по имени конкретного вызывающего `markDirtyScene`
  (§7) — с перечнем недостающих доказательств.
- **Причина Case A:** `ready` (2026-08-14T09:22:26Z) → `dirty` в окне
  **2026-08-16T04:50:54.860–04:50:58.430Z** молчаливым `markDirtyScene`-вызовом в том же тике,
  что и диспатч; повторный `markStale` в PG 2026-08-18T13:42:05Z; фаза `DONE` с 08-14 не менялась.
- **Причина Case B:** аудио провалилось (`chunk_stall_timeout:67377s`, 2026-08-14T09:19:24Z),
  позже фаза выставлена в `DONE` **без** записи READY (ни одного `AUDIO_COMPLETED`), ассет в
  `dirty` с 2026-08-14T09:50:26Z; остатки `fail_reason/failed_at` не очищены; параллельно
  audio+image застирены в PG 2026-08-28T03:02:32Z.
- **Допустимо ли по модели:** по заявленной — **нет** (`phase=DONE ⇔ asset.audio=READY`);
  по реализованной — **да, достигается по конструкции**; **проверка не ошибочна**,
  ослаблять нельзя. Дефект — в писателях (`convergence TODO Фаза 4`, 🔴 не сделана) и в
  liveness (§3.3).
- **Изменения:** только 5 регрессионных тестов, `backend/tests/reconciliation-engine.test.js`.
  Бизнес-логика не менялась.
- **Production:** не затронут.
- **Отчёт:** `/home/animastor/reorg-2026-10-12/49-done-dirty-diagnosis.md` (этот файл).

### Рекомендация на следующий этап (не выполнялось)

Отдельное решение, отдельное обоснование, отдельный approval:
`markDirtyScene` при `audio ∈ assets` и `phase=DONE` должен сбрасывать audio-orch запись
(`deleteState`) — ровно Фаза 4 `ORCHESTRATOR_CONVERGENCE_TODO`, приоритет HIGH; плюс
журналирование вызова `markDirtyScene` (закрывает §7), плюс отдельный фикс ложного
`partial_audio_only` на активно генерирующейся сцене (§6).
