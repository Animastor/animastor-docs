# Этап 45 — Исправление audio host-binding и контролируемое production-развёртывание

**Дата:** 2026-10-13 (окно ~04:30–05:05 UTC)
**Итог: PASS** — подготовленный на этапе 44 host-side фикс (`media.audio.chunks` /
`media.audio.segments` в media-binding) проверен, закоммичен (`b2fb472`), собран
штатным CI в новый immutable-образ `deploy-b2fb472`
(digest `sha256:1e7e0260…`, OCI revision = коммит фикса) и выкатен в production.
**Startup-фаза C1 полностью восстановлена:** на новом образе ни одной
`TypeError`/`[STARTUP] Reconcile errors`, `audio_orch:3` — все три июльских
GENERATING-состояния обработаны. Откат не потребовался. Три ключа **не удалялись
и не изменялись вручную**; в ходе проверки обнаружен и зафиксирован **второй
pre-existing дефект** (карта переходов host-FSM запрещает `GENERATING → FAILED`),
из-за которого записи формально «восстановлены», но остаются `GENERATING` —
предложен отдельный follow-up.

---

## 0. Краткая сводка

| Пункт задачи | Статус | Факт |
|---|---|---|
| 1. Проверить diff и отчёт 44; фикс только host-side + тесты, пакет не меняется | **да** | diff = 4 файла (§1.1); `packages/**`, `node_modules`, `@animastor/orchestration` не тронуты |
| 2. Актуальность HEAD/дерева, без потери изменений и rewrite истории | **да** | HEAD был `a7a8c46` (позади `github/main` на 5 CI-коммитов) → ff-merge с переносом грязного дерева через stash; опубликованная история не переписана; новый коммит `b2fb472` + `ac54293` |
| 3. Тесты: исходный и итоговый наборы | **PASS** | pristine (тот же HEAD) **3130/28/4**; с фиксом **3133/28/4**; failure-set идентичен поимённо (§3); syntax OK; targeted 68/0 |
| 4. Коммит + публикация + immutable-образ через CI | **PASS** | push `e9d6566..ac54293` в `Animastor/animastor-backend`; ран `38347716252` success (все шаги); `deploy-b2fb472` → digest `sha256:1e7e0260ac5899dad60700976b879f1399d7cb15e421481f19b4d3adb569e638`; OCI revision `b2fb472…`; содержимое байт-в-байт == git; прежние теги не перезаписаны |
| 5. Контролируемый rollout | **PASS** | ровно одна строка `BACKEND_IMAGE` в `deploy/.env` (mode 600 сохранён); dry-run — только `animastor-backend Recreate`; `up -d` rc=0; прежний digest сохранён для отката |
| 6. Пост-проверки | **PASS** | health 200 `{ok,loop,redis:PONG}`, `/gpu/health` 200, сайт 200; Redis PONG + PG `generation_tasks=17` из контейнера; 0 `TypeError`/`FATAL`/`Uncaught`; **нет строки `Reconcile errors`**; C1 отработала (`audio_orch:3`); планировщик штатен; gpu-hub/nginx/pg/redis не пересозданы (те же ID и time старта) |
| 7. Три GENERATING-ключа | **не тронуты** | C1 все три попыталась перевести в FAILED, но host-FSM вернул `invalid_transition` (§6) — записи остались `GENERATING`; побочных эффектов нет; принудительной очистки не было |
| 8. Без лишних изменений | **да** | DNS/TLS/deploy-конфиг/locks/книги/output не менялись; новые генерации не запускались; активный image-dispatch существующей книги — штатная работа планировщика, существовавшая до rollout |
| 9. Rollback | **не потребовался** | процедура и прежний digest зафиксированы (§9) |

---

## 1. Предполётная проверка (diff, дерево, коммит)

### 1.1 Diff — только host-side binding + тесты

4 файла, 107+/2−:

- `backend/src/backend.cjs` — media-binding: `audio: { ...require('./audio'), chunks: require('./audio/chunks'), segments: require('./audio/segments') }` (единственное runtime-изменение);
- `backend/tests/generation-test-bindings.cjs` — зеркало той же композиции для mocha-харнесса;
- `backend/tests/architecture/physical-move-gate.test.js` — guard PM-G9: composition root обязан экспортировать оба под-модуля;
- `backend/tests/reconciliation-engine.test.js` — 3 регрессионных теста C1 (под-модули зарегистрированы; GENERATING без чанков → FAILED; GENERATING с полным набором чанков → merge-recovery).

`packages/animastor-orchestration/**`, `node_modules`, `package.json` — **без изменений**
(npm-пакет остаётся `@animastor/orchestration@0.1.1` из registry; фикс host-side).

### 1.2 Состояние репозитория

- Локальный HEAD до работы: `a7a8c46` (production-pin); `github/main` = `e9d6566`
  (5 CI-коммитов этапа 43, только `.github/workflows/`).
- Обновление: `git stash` → `merge --ff-only github/main` → `stash pop` —
  грязное дерево перенесено без конфликтов, опубликованная история не переписана.
- Коммиты (автор `animastor-coder <coder@animastor.org>`, как в репо):
  - `b2fb4723817713e0b200104ea744aaeed88576f1` — fix(audio): register media.audio.chunks/segments …;
  - `ac542932…` — ci(backend): approve b2fb472 backend tree for GHCR release
    (`APPROVED_COMMIT` workflow указывает на коммит фикса — требование provenance-gate);
- `git push github main` → `e9d6566..ac54293`. Bare-remote `origin` не синхронизировался (G8 — вне задачи, как на этапах 41–43).

## 2. CI-сборка immutable-образа

- Dispatch `workflow_dispatch` (run **38347716252**, все 10 шагов success):
  `commit=b2fb4723817713e0b200104ea744aaeed88576f1`, `image_tag=deploy-b2fb472`.
- Провенанс: checkout HEAD == requested commit; `backend/`-дерево == approved `b2fb472`;
  OCI label `revision=b2fb4723817713e0b200104ea744aaeed88576f1`, `version=deploy-b2fb472`.
- Результат: `ghcr.io/animastor/animastor-backend:deploy-b2fb472` и тег полного SHA →
  **digest `sha256:1e7e0260ac5899dad60700976b879f1399d7cb15e421481f19b4d3adb569e638`**.
- Прежние теги (`deploy-a7a8c463` → `sha256:e1fac1d2…`, `deploy-e9d6566` → `sha256:e147fa25…`) не перезаписаны.
- Локальная верификация после `docker pull`: sha256-сравнение `src/backend.cjs`,
  `tests/generation-test-bindings.cjs`, `tests/reconciliation-engine.test.js`,
  `tests/architecture/physical-move-gate.test.js`, `package.json` — **все OK (byte-for-byte)**.
- Изолированный smoke (эфемерный redis, PG недоступен — как в CI): `/health` 200
  `{status:ok, loop:true, redis:PONG}`, 0 crash-сигнатур; затравленные в эфемерный
  redis 2 GENERATING-записи после рестарта обработаны C1 (`audio_orch:2`) — и там же
  впервые проявился `Invalid transition: GENERATING → FAILED` (§7).

## 3. Тесты (исходный и итоговый наборы)

Команда: `npx mocha 'tests/**/*.test.js' --exit` в `backend/` (после ff-merge, HEAD `e9d6566`):

| Прогон | Результат |
|---|---|
| pristine (stash фикса) | **3130 passing / 28 pending / 4 failing** |
| с фиксом | **3133 passing / 28 pending / 4 failing** |

Одинаковый failure-set (pre-existing, документированный env-class — сверен на
прежних этапах, регрессий нет):

1. LLM Sharing Phase 1 — Control Plane (SH-AI-1): «no policy row is enabled …»;
2. LLM Sharing Phase 2 (SH-AI-3): «16b. shared snapshot is safe for health checks»;
3. installer boundary guards: «IB-G15: package.json pins»;
4. Phase 5 final audit: «T9: no dynamic/template/concat require …».

Дополнительно: targeted `reconciliation-engine.test.js` + `physical-move-gate.test.js`
→ **68 passing / 0 failing**; `bash ../scripts/syntax-smoke.sh` → OK.

## 4. Production rollout

- Backup `.env` → `/tmp/opencode/stage45-env.bak`; изменена **ровно одна строка**
  (mode 600 сохранён):

```
-BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:e1fac1d29f7acd9477080e4608be4670ba172d686e0e061fbbf84c322382def4
+BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:1e7e0260ac5899dad60700976b879f1399d7cb15e421481f19b4d3adb569e638
```

- sha `.env`: `21e3248c…` → `dddb781baa2a441b9428bf2667175cced1556370f07af7f3a5baf06b282f800e`.
- Dry-run: `gpu-hub / pg / redis / proxy Running`, только `animastor-backend Recreate`.
- `up -d` → rc=0: `Recreated → Started` (2026-10-13T04:54:47.821Z),
  новый контейнер `ef76f50c7b2d…`, image = `sha256:1e7e0260…` (digest-pin).
- Старый контейнер `91fc2fad9fb3` (image `e1fac1d2…`) удалён compose'ом —
  **digest `sha256:e1fac1d29f7acd9477080e4608be4670ba172d686e0e061fbbf84c322382def4`
  сохранён для быстрого отката** (§9).

## 5. Пост-проверки (все PASS)

- `https://animastor.org/health` → 200 `{"status":"ok","loop":true,"redis":"PONG"}`;
  `https://animastor.org/gpu/health` → 200 `{"gpus":0,…,"running":0}`;
  `https://app.animastor.org/` → 200.
- Из backend-контейнера: `ioredis` → `PONG`, 8 ключей `animastor:audio-orch:*`;
  `pg` → `generation_tasks = 17` (как до rollout).
- Логи нового бута: **0** `TypeError` / `Uncaught` / `FATAL`; **нет** строки
  `[STARTUP] Reconcile errors` (до фикса она появлялась каждым бутом);
  `Cycle complete [result_recovery:0, chunk_recovery:ok, audio_orch:3, video_orch:0, version_stale:12, counter_reconcile:2, session_resume, reconcile:3_issues]`.
- Scene-orchestrator/scheduler: штатная работа — активный image-dispatch существующей
  книги `import_1786345731767_…` (эта книга и её очереди image:8 / workspace:288
  существовали до rollout, `/gpu/health` до и после идентичен); по июльской книге
  `import_1783656905372_…`: 0 `scene_not_found`, worklist — «no book.json on disk — skipped»
  (только log-only упоминания в reconcile, без диспатча/очередей).
- Соседи не пересозданы (ID и time старта совпадают с baseline):
  `gpu-hub b771d0504a2b` (2026-10-12T13:41:43Z), `animastor-proxy 09cb668898dd`,
  `animastor-pg 49202ac1b6ed`, `animastor-redis fd01e09ae05a` (оба — Aug 24).
  `RestartCount=0`, статус running, стабильно спустя >3 минут.

## 6. Три GENERATING-ключа — что произошло

Ключи **не удалялись и не изменялись вручную** (baseline в
`/tmp/opencode/stage45-baseline-audio-orch.txt`, после —
`/tmp/opencode/stage45-post-audio-orch.txt`; идентичны, TTL=-1):

```
animastor:audio-orch:import_1783656905372_1783656918982:ch-c779d21c:sc-{1eb2306c,45fc1833,5860455d}
```

После фикса C1 **впервые дошла до всех трёх** (лог production-бута):

```
[RECONCILE] [AUDIO-ORCH] Recover …/sc-5860455d: GENERATING → FAILED (0/? chunks on disk)
[AUDIO-ORCH] ⚠️ Invalid transition: GENERATING → FAILED for …/sc-5860455d
… (аналогично sc-45fc1833, sc-1eb2306c)
[RECONCILE] [AUDIO-ORCH] 3 non-terminal states recovered
```

**Однако записи остались `GENERATING`.** Причина установлена точно (побочных
эффектов нет, диспатча/очередей/lease по июльской книге не появилось):

- вызываемый C1 `audioOrch.setFailed` → `transitionState(…, FAILED)` в host-FSM
  `backend/src/services/audio-orchestrator.js`;
- карта `VALID_TRANSITIONS` разрешает из `GENERATING` только `WAITING_CHUNKS` —
  `GENERATING → FAILED` отклоняется с warn `invalid_transition` (без записи в Redis и без throw);
- поэтому C1 логирует «→ FAILED» и увеличивает `recovered`, но состояние не меняется.
  Это **второй, независимый pre-existing дефект** (тот же класс «recovery-ножка
  упирается в host-контракт», что и фикс stage 45) — он маскировался тем, что C1 была
  мертва целиком, и воспроизводится изолированно (§2, smoke).

Следствие: пока карта не расширена (`GENERATING` → разрешить `FAILED`; ветка
`WAITING_CHUNKS → FAILED` уже разрешена), эти записи будут перебираться C1 на каждом
буте (3 warn, без роста очередей). **Follow-up (отдельный этап, по решению владельца):**
однострочная правка `VALID_TRANSITIONS` + тесты на C1-ножку через реальный адаптер
(текущие регрессионные тесты мокают `setFailed` и поэтому дефект карты не ловят) +
наблюдение после следующего бута, что ключи переходят в `FAILED`.

## 7. Прочие наблюдения (pre-existing, не трогали)

- `version_stale:12` и `counter_reconcile:2` — log-only фазы, работали и до фикса
  (diff их не затрагивает); сравнение со старым бутом недоступно (старый контейнер
  удалён recreate'ом).
- `reconcile:3_issues` — invariant-нарушения на сценах книги `import_1786345731767_…`
  с `phase=DONE` + `fail_reason=chunk_stall_timeout` (2 audio-orch + смежная).
  Существовали до rollout (записи не менялись); к этапу 45 отношения не имеют.

## 8. Откат (не выполнялся)

Быстрый откат — одна строка + `up -d`:

```bash
cp -a /tmp/opencode/stage45-env.bak /home/animastor/animastor-backend/deploy/.env   # или sed на прежний digest
cd /home/animastor/animastor-backend/deploy && \
  docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d
```

Прежний digest: `sha256:e1fac1d29f7acd9477080e4608be4670ba172d686e0e061fbbf84c322382def4`
(тег `deploy-a7a8c463`, коммит `a7a8c463`). Условий для отката не возникло:
health 200/200/200, 0 crash-сигнатур, C1 восстановлена, соседи не тронуты.

## 9. Артефакты

- Коммиты: `b2fb472` (fix) + `ac54293` (CI approval), push `e9d6566..ac54293` → `Animastor/animastor-backend`;
- CI-ран: `38347716252` (success);
- Образ: `ghcr.io/animastor/animastor-backend:deploy-b2fb472` / `@sha256:1e7e0260ac5899dad60700976b879f1399d7cb15e421481f19b4d3adb569e638`;
- `.env`: sha `dddb781b…`, backup `/tmp/opencode/stage45-env.bak`;
- Логи тестов: `/tmp/opencode/stage45-{pristine,fixed,syntax}.log`;
- Ключи Redis: `/tmp/opencode/stage45-{baseline,post}-audio-orch.txt`.
