# Этап 46 — FSM-переход GENERATING → FAILED в recovery

**Дата:** 2026-10-13 (окно ~05:10–05:40 UTC)
**Итог: PASS** — в audio-FSM (`backend/src/services/audio-orchestrator.js`)
разрешены ровно два recovery-перехода, зеркальные видео-FSM: `GENERATING → FAILED`
и `MERGING → FAILED`. Никаких обходов FSM, прямых записей в Redis и
специальных исключений не добавлено — recovery идёт через существующий
`transitionState()`. Diff: 1 source-файл (карта + таблица переходов) + 2 файла
тестов. Тесты: **3142 passing / 4 failing** — тот же failure-set, что и до
изменений (3133 → +9 новых тестов), регрессий нет. Immutable-образ
`deploy-c8837f0` (digest `sha256:8a05f2e6…`) выкатен в production;
**все три июльских сиротских ключа перешли в `FAILED`
(`fail_reason=restart_recovery`)**, активные задачи не затронуты. Откат не
потребовался.

---

## 0. Краткая сводка

| Пункт задачи | Статус | Факт |
|---|---|---|
| 1. Найти VALID_TRANSITIONS, FSM и все вызовы FAILED | **да** | §1 — карта в `audio-orchestrator.js:54` (+ зеркало `video-orchestrator.js:66`), 6 мест вызова `setFailed`/`failWaitingScene` |
| 2. Минимальное корректное исправление | **да** | 2 строки карты + таблица переходов; без bypass; `NEW`/`PLACEHOLDER_READY → FAILED` и `DONE` остаются запрещены (§2) |
| 3. Разрешить переход штатным механизмом FSM | **да** | ровно `transitionState()`; отдельных веток только для трёх ключей нет |
| 4. Тесты (5 сценариев) | **да** | §3: зависшая GENERATING → FAILED через реальный FSM; терминальная не меняется; запрещённые запрещены; активная генерация не фейлится по возрасту; идемпотентность повторного recovery |
| 5. Targeted + полный набор, сравнение failure-set | **PASS** | targeted `audio-orchestrator` 32/0, `reconciliation-engine` 63/0; полный **3142/28/4** — failure-set идентичен исходному (те же 4 pre-existing, §3); syntax OK |
| 6. Коммит + CI + immutable образ | **PASS** | `c8837f0` + `f9e9b11` (APPROVED_COMMIT), push `ac54293..f9e9b11`; ран `38351446536` success; `deploy-c8837f0` → digest `sha256:8a05f2e6024dad41407533f37be521c4526a3f3ac6cc1e35d061af72d6a707b4`, OCI revision = `c8837f0`, содержимое byte-identical |
| 7. Rollout только backend | **да** | одна строка `BACKEND_IMAGE`, dry-run — только `animastor-backend Recreate`; прежний digest сохранён (§5) |
| 8. Пост-проверки | **PASS** | §5: health 200/200/200, Redis PONG + PG из контейнера, **3 ключа → FAILED**, 0 `Invalid transition`/`TypeError`/`FATAL`, активные задачи не тронуты; ключи/книги/output не удалялись |
| 9. Откат при ошибке | **не потребовался** | процедура и прежний digest зафиксированы (§6) |
| 10. Без посторонних изменений | **да** | DNS/TLS/GPU Hub/locks не тронуты; соседи не пересозданы |

---

## 1. Где живёт FSM и кто зовёт FAILED

**Определение карты:** `backend/src/services/audio-orchestrator.js` —
`PHASES` (~L44), `VALID_TRANSITIONS` (до правки L54), валидация в
`transitionState()` (L113–130): запрещённый переход → `warn('Invalid transition:
…')` и `{success:false, reason:'invalid_transition'}` **без записи в Redis и без
throw**. Зеркальная видео-FSM: `backend/src/services/video-orchestrator.js:66` —
и она **уже разрешает** `GENERATING → FAILED` и `MERGING → FAILED` с момента
создания.

**Все вызовы перехода в FAILED (audio):**

| Место | Фаза-источник | До фикса |
|---|---|---|
| `audio-orchestrator.js:160` `setFailed` | единственная точка входа в FAILED | — |
| `completeChunk` merge-ошибки (`:355`, `:359`) | `MERGING` (после `transitionState → MERGING`) | **тоже** получал `invalid_transition` — зависший MERGING |
| `failWaitingScene` (`:401`, watchdog/recovery) | `WAITING_CHUNKS` | работал |
| startup C1 `recoverAudioOrchStates` (orchestration pkg) | `GENERATING`/`WAITING_CHUNKS`/`MERGING` | `GENERATING` и `MERGING` — **invalid** (дефект этапа 45) |
| `orchestrator.js:310` failStage-sync (orchestration pkg) | любая (сцена упала) | для `GENERATING`/`MERGING` — invalid |
| scene-orchestrator recovery-ножки (stale/no-state) | идут через `deleteState`/`init…`/`failWaitingScene` | не задеты |

Смежная находка: та же дыра закрывала merge-error-путь (`MERGING → FAILED`),
поэтому в карту добавлены оба перехода — ровно то, что уже разрешает
video-FSM.

## 2. Минимальное исправление

```js
[PHASES.GENERATING]: [PHASES.WAITING_CHUNKS, PHASES.FAILED],   // +FAILED
[PHASES.MERGING]:    [PHASES.DONE, PHASES.FAILED],              // +FAILED
```

Плюс обновлена таблица документации переходов в шапке файла (2 строки).

**Что осталось запрещено (жёсткость сохранена):** `NEW → FAILED`,
`PLACEHOLDER_READY → FAILED` (сцена обязана достичь GENERATING),
`GENERATING → DONE`, `WAITING_CHUNKS → GENERATING`, `FAILED → DONE`,
`DONE → что-угодно` (терминал). Никаких обходов/специальных веток для трёх
ключей: recovery идёт через тот же `transitionState()`, что и штатные вызовы.

## 3. Тесты

Добавлено 9 тестов (+2 happy, +2 invalid в FSM; +5 в recovery-сьют; в одном
существующем тесте усилена проверка неизменности терминала):

`backend/tests/audio-orchestrator.test.js` (32 passing):
- `GENERATING → FAILED (startup recovery / failStage sync, stage 46)`;
- `MERGING → FAILED (merge error / interrupted-merge recovery, stage 46)`;
- `rejects NEW → FAILED` (+ запись не меняется);
- `rejects FAILED → DONE` (+ запись остаётся FAILED);
- `rejects DONE → any` усилен: фаза `DONE` и `fail_reason` не изменились;
- ранее существующие запреты (`PLACEHOLDER_READY → FAILED/MERGING`,
  `GENERATING → DONE`, `WAITING_CHUNKS → GENERATING`, `no_state`) сохранены.

`backend/tests/reconciliation-engine.test.js` (63 passing) — новый сьют
**«recoverAudioOrchStates — real audio FSM (stage 46)»**: в отличие от тестов
этапа 44, `setFailed` подменён **на реальный** (захвачен до подмены модуля
mock'ом), т.е. под тестом сама карта переходов (ровно тот пробел, который
пропустил этап 45):
1. зависшая GENERATING → `FAILED` c `fail_reason=restart_recovery` + dirty-scene;
2. терминальная запись (`DONE`) не меняется, `deep.equal` исходного JSON;
3. активная генерация (все чанки на диске, `started_at` старый) → merge-recovery,
   `setFailed` не вызывается — возраст сам по себе не фейлит;
4. повторный recovery идемпотентен: 2-й прогон возвращает 0 и не меняет `FAILED`;
5. запрещённый переход остаётся запрещённым через реальный FSM
   (`PLACEHOLDER_READY → FAILED` → `invalid_transition`, запись не тронута).

**Прогоны:**
| Набор | Результат |
|---|---|
| `audio-orchestrator.test.js` | 32 passing / 0 failing |
| `reconciliation-engine.test.js` | 63 passing / 0 failing |
| targeted audio+recon+video | 116 passing / 0 failing |
| полный `tests/**/*.test.js` | **3142 passing / 28 pending / 4 failing** |
| исходный (этап 45, до изменения) | 3133 / 28 / 4 — тот же failure-set |

4 failing — прежние pre-existing (LLM Sharing SH-AI-1/SH-AI-3, installer
IB-G15, Phase5 T9), идентичны исходному набору; регрессий нет.
`bash ../scripts/syntax-smoke.sh` → OK.

## 4. Сборка (CI)

- Коммиты: `c8837f099e953705e302643707feb1e5f7978989` — fix(audio): allow
  GENERATING/MERGING → FAILED …; `f9e9b11` — ci: approve c8837f0 backend tree
  (APPROVED_COMMIT). Push `ac54293..f9e9b11` → `Animastor/animastor-backend`;
  `backend/`-дерево обоих коммитов идентично (проверено `git diff --quiet`).
- CI-ран **38351446536** — success, все шаги (verify/build/isolated smoke/login/push/record).
- Образ: `ghcr.io/animastor/animastor-backend:deploy-c8837f0` (тег полного SHA) →
  **digest `sha256:8a05f2e6024dad41407533f37be521c4526a3f3ac6cc1e35d061af72d6a707b4`**;
  OCI revision = `c8837f0…`; sha256-сверка `src/backend.cjs`,
  `src/services/audio-orchestrator.js`, обоих тестовых файлов, `package.json` —
  байт-в-байт == git; прежние теги не перезаписаны.
- Изолированный smoke (эфемерный redis + затравленная GENERATING-запись):
  `/health` 200 `{ok,redis:PONG}`, 0 crash-сигнатур, и ключ после бута —
  `{"phase":"FAILED",…,"fail_reason":"restart_recovery"}`, ни одного
  `Invalid transition`. Это прямое подтверждение фикса до выкатки.

## 5. Production rollout и пост-проверки

**Rollout.** Backup `.env` → `/tmp/opencode/stage46-env.bak`; изменена ровно
одна строка (mode 600 сохранён):

```
-BACKEND_IMAGE=…@sha256:1e7e0260ac5899dad60700976b879f1399d7cb15e421481f19b4d3adb569e638   (этап 45)
+BACKEND_IMAGE=…@sha256:8a05f2e6024dad41407533f37be521c4526a3f3ac6cc1e35d061af72d6a707b4   (этап 46)
```

sha `.env`: `dddb781b…` → `d9d1a8133e4a4a496cdc08cbf0a55bcac90d42b03e9861ae2dc29fb309f0ae9f`.
Dry-run: только `animastor-backend Recreate`. `up -d` rc=0: новый контейнер
`be739e49ecbf…` (started 2026-10-13T05:31:19Z), image = новый digest-pin.
Старый контейнер `ef76f50c7b2d` (digest `sha256:1e7e0260…`) удалён compose'ом —
**digest сохранён для отката (§6)**.

**Три сиротских ключа (главная проверка).** Ключи не удалялись и не
покасались вручную. Baseline — `/tmp/opencode/stage46-baseline-orphans.txt`
(все `GENERATING`, TTL=-1). На новом образе:

```
[RECONCILE] [AUDIO-ORCH] Recover import_1783656905372_…/sc-5860455d: GENERATING → FAILED (0/? chunks on disk)
[AUDIO-ORCH] import_1783656905372_…/sc-5860455d: FAILED
… (sc-45fc1833, sc-1eb2306c аналогично)
[RECONCILE] [AUDIO-ORCH] 3 non-terminal states recovered
```

После (пост-дамп `/tmp/opencode/stage46-post-orch.txt`):

| Ключ | phase | fail_reason |
|---|---|---|
| …sc-1eb2306c | **FAILED** | `restart_recovery` |
| …sc-45fc1833 | **FAILED** | `restart_recovery` |
| …sc-5860455d | **FAILED** | `restart_recovery` |
| 5 остальных (книга `import_1786345731767_…`) | `DONE` — не тронуты | — |

`Invalid transition: GENERATING → FAILED` больше не появляется (0 за весь бут);
повторные recovery идемпотентны (терминал не переписывается — проверено и
тестом, и наблюдением после рестарта: `failed_at` не меняется).

**Остальные пост-проверки:**
- `https://animastor.org/health` 200 `{ok,loop,redis:PONG}`; `/gpu/health` 200
  `{gpus:0,running:0,queues:…}`; `https://app.animastor.org/` 200.
- Из backend-контейнера: redis `PONG`, 8 audio-orch ключей; PG
  `generation_tasks=17`, `books=5` (как до rollout).
- Логи: 0 `TypeError`/`Uncaught`/`FATAL`, **нет** `[STARTUP] Reconcile errors`,
  0 `scene_not_found`; `Cycle complete [… audio_orch:3, video_orch:0 …]`.
- Активные задачи: `ATTEMPT_DISPATCH` за бут — 1 (image-stage существующей
  книги `import_1786345731767_…`, штатный поток, очереди image:8 живут);
  по июльской книге — **0** диспатчей (worklist: «no book.json — skipped»).
  `RestartCount=0`.
- Соседи не пересозданы: `gpu-hub b771d0504a2b` (Oct 12 13:41:43),
  `animastor-proxy 09cb668898dd`, `animastor-pg 49202ac1b6ed`,
  `animastor-redis fd01e09ae05a` (Aug 24) — ID и time старта совпадают с baseline.

## 6. Откат (не выполнялся)

```bash
cp -a /tmp/opencode/stage46-env.bak /home/animastor/animastor-backend/deploy/.env   # прежний digest
cd /home/animastor/animastor-backend/deploy && \
  docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d
```

Прежний digest: `sha256:1e7e0260ac5899dad60700976b879f1399d7cb15e421481f19b4d3adb569e638`
(тег `deploy-b2fb472`, коммит `b2fb472` — этап 45). Условий для отката не
возникло: все проверки PASS.

## 7. Наблюдения (pre-existing, не трогали)

- `reconcile:3_issues → 6_issues`: +3 — это те же три ключа, теперь
  `phase=FAILED`, а их `asset.audio` остался `dirty` (C1 после `setFailed`
  вызывает `unsafeRestoreAssetState → failed`, затем `markDirtyScene → dirty`).
  Проверка `audio_orch_invariant_failed` допускает только `FAILED|PENDING` →
  log-only запись в отчёт с рекомендацией `mark_dirty` (сама рекомендация
  противоречит списку допустимых — диссонанс в коде существует раньше).
  Никаких мутаций/очисток этот отчёт не вызывает (`getFixRecommendations`
  только логирует). Ровно такая же последовательность всегда срабатывала и
  для успешных `WAITING_CHUNKS → FAILED` recovery — поведение не новое,
  расширять список допустимых состояний (или чинить порядок в C1) — отдельный
  шаг по решению владельца.
- `version_stale:12`, `counter_reconcile:2`, invariant-нарушения на `DONE` +
  `fail_reason` (книга `import_1786345731767_…`) — как до rollout.

## 8. Артефакты

- Коммиты: `c8837f0` (fix) + `f9e9b11` (CI approval) → push `ac54293..f9e9b11`;
- CI-ран: `38351446536` (success);
- Образ: `ghcr.io/animastor/animastor-backend:deploy-c8837f0`
  / `@sha256:8a05f2e6024dad41407533f37be521c4526a3f3ac6cc1e35d061af72d6a707b4`;
- `.env`: sha `d9d1a813…`, backup `/tmp/opencode/stage46-env.bak`;
- Логи тестов: `/tmp/opencode/stage46-{fullsuite,syntax}.log`;
- Ключи Redis: `/tmp/opencode/stage46-{baseline,post}-*.txt`.
