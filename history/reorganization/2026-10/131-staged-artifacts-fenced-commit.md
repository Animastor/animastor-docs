# Stage 131 — Staged artifacts & fenced commit

**Дата:** 2026-10-23
**База:** HEAD `c5239cf4cd8217ef3bfaa0d61badec04ff3102ae` (Stage 129) + dirty-файлы других сессий (не тронуты)
**Коммит Stage 131:** `fa1fa1d6a795c488171294807b68d1ab06c37ade` (10 файлов, +1532/−13; только fencing-файлы)
**Контракт:** `126-result-fencing-implementation-contract.md` §3 (publication), §5 (migration), §6 (rollback)
**Вердикт: PASS** (см. §9 — условия и ограничения)

---

## 1. Что сделано

Результат GPU-задачи больше **не пишется в canonical-путь до подтверждённого fenced commit**. Протокол:

```
1. STAGE   {OUTPUT_DIR}/{build}/.staging/{enc(jobId)}/{fence}/artifact.tmp
           → fsync(файл) → rename внутри fence-директории → fsync(директории)
2. COMMIT  Redis Lua (ОДНА атомарная операция, FENCE_COMMIT_SCRIPT, 6 KEYS):
           committed | duplicate_same_fence | stale_intent
           | intent_missing | intent_corrupt | invalid_fence | unavailable
           Решение — ТОЛЬКО из durable intent-записи (никогда из файла).
3. PUBLISH только при committed/duplicate_same_fence: rename staged → canonical
           (внутри build-директории, та же FS).
```

Non-Lua fallback **не существует** (fail closed): клиент без EVAL или ошибка Redis = `unavailable`, staged-байты и claim остаются, retry/resume завершает commit.

### 1.1 Новые файлы

| Файл | Содержимое |
|---|---|
| `backend/src/services/result-publication.cjs` (505 строк) | Весь publication-протокол: `stageResult`, `publishStaged`, `discardStagedFence`, `buildCommitManifest`, `commitFencedResult`, `resumePendingPublications`, `collectStaleStaging`; деривация путей (`stagingRootFor`, `fenceDirFor`, `canonicalPathFor`), валидация (`isValidBuildId`, FENCE_RE, EXTENSION_RE), containment-проверки (`_isInside`), fsync-хелпер |
| `backend/tests/gpu-result-fencing-commit.test.js` (557+ строк) | 30 тестов: вердикты, F1→F2→F1, crash-window resume, GC, path-traversal, kill-switch, «no ready до commit», wiring recovery-hook |

### 1.2 Изменённые файлы (8, +434/−13 к HEAD)

| Файл | Изменение |
|---|---|
| `src/helpers/queue-idempotency.cjs` (+200) | `FENCE_COMMIT_SCRIPT` (Lua, 6 KEYS/6 ARGV), `fenceCommitResult` (fail-closed, без fallback), `artifactManifestKey`/`fenceJournalKey`, `readArtifactManifest`, наборы вердиктов, экспорт скрипта |
| `src/services/task-handler.cjs` (+87) | Fenced-ветка в `handleTaskResult`: резолв fence (receipt → opts.fence), stage→commit→publish через `commitFencedResult`; terminal-отклики — throw с классифицированным кодом; **legacy-путь сохранён байт-в-байт** (ветка else); возврат `{fenced, fence, commit}` |
| `src/routes/generation-routes.cjs` (+43) | Резолв fence для callback (receipt → job→fence ref), пропуск legacy settlement при fenced commit, terminal reject → `{ok:true, rejected:true, reason}` с СОХРАНЁННЫМ dedup-маркером |
| `src/runtime/runtime-loop.js` (+15) | Recovery hook в `executeReconcileCycle`: `resumePendingPublications` + `collectStaleStaging` **безусловно** (не зависит от kill-switch), до orchestration-цикла, в собственном try/catch (не влияет на цикл) |
| `src/config/runtime-config.js` (+22) | `GPU_FENCING_MODE=off|observe|enforce` (default `observe`, lazy read) |
| `src/metrics/prometheus.js` (+18) | `animastor_fence_commit_total{outcome}` — ОТДЕЛЬНЫЙ от SEND-side `animastor_intent_fence_total` счётчик |
| `tests/architecture/redis-registry.js` (+25) | Зарегистрированы семейства `animastor:artifact-manifest:*` (durable, без TTL) и `animastor:fence-journal:*` (TTL 7 d) |
| `tests/mocks/redis-mock.js` (+37) | Независимый mirror `FENCE_COMMIT_SCRIPT` + дизамбигуация ensure-скрипта |

---

## 2. Инварианты (контракт 126 §2/§3) и их подтверждение

| # | Инвариант | Подтверждение |
|---|---|---|
| 1 | Stale fence не становится текущим через файл/recovery | Решение — только Lua из intent; `resumePendingPublications` требует manifest **И** done-маркер; GC требует строгих Redis-чтений (ошибка → abort без удалений). Real-Redis: V2, V6, CR.6, GC.7 |
| 2 | Canonical не перезаписывается до fenced commit | Canonical пишется только на шаге 3 после вердикта. Real-Redis: PUB.7/PUB.8 (canonical не тронут при stale), DP.2 (Redis down → canonical нет) |
| 3 | Повтор того же fence идемпотентен | `duplicate_same_fence` — скрипт выходит ДО любой записи; manifest байт-в-байт не меняется. Real-Redis: V1.7/V1.8, PUB.5/PUB.6 (повтор не «хлопает» опубликованный файл) |
| 4 | Каждое удаление/rollback — ровно один fence dir | `discardStagedFence`/GC оперируют путём из `fenceDirFor` (containment-чек). Real-Redis: PUB.9, GC.1–GC.5 |
| 5 | Legacy canonical-файлы не перемещаются/не удаляются | Модуль пишет только в `.staging/…` и в заданный canonical при коммите; legacy не трогается (тест «legacy canonical files are never moved or removed») |
| 6 | 0-байтовый результат — ошибка, не успех | `empty_result` — hard error ДО коммита (тест PUB.13) |
| 7 | Никакого `fs.existsSync` в решении о публикации | Решение — Lua; resume решает из manifest+done, а не «файл есть» (CR.6: manifest без done не публикует) |
| 8 | Ready/complete metadata не раньше commit'а | Handler-level тест «a committed result updates metadata only AFTER the commit»; fenced-ветка кидает до `completeStage` |
| 9 | Recovery решает из durable-состояния | `resumePendingPublications`: manifest (durable) + done-маркер; оба сигнала обязательны |

---

## 3. Real-Redis gate (независимая инфраструктура, как Stage 130)

**Конфигурация:** throwaway `redis:7` (docker, `--network host`, порт 6396 loopback, без persistence, **без какого-либо контакта с production** `animastor-redis`/`animastor-pg`); контейнер и volume удалены после прогона. Продукционный Lua исполнен на реальном сервере через **настоящий production-код** (`queue-idempotency.fenceCommitResult`, `ensureIntentAndReceipt` — оба реальных скрипта из исходника).

**Harness:** `audit-131/01-fenced-commit-real-redis.cjs` → `01-fenced-commit.json`.

**Результат: 70 passed / 0 failed.**

| Секция | Проверено |
|---|---|
| 0. Идентичность скрипта | Исполняется ровно экспортированный `FENCE_COMMIT_SCRIPT` из source |
| 1. Вердикты | `committed` (manifest+done+journal с TTL, claim удалён), `duplicate_same_fence` (ничего не меняется, manifest байт-в-байт), `stale_intent` (supersede + cancelled-состояние; ничего не пишет), `intent_missing`, `intent_corrupt` (3 варианта), `invalid_fence`, `invalid` (аргументы) |
| 2. F1→F2→F1 | F2 забирает manifest; красоставка F1 → `duplicate_same_fence` (её done-маркер терминален), manifest НЕ откатывается к F1 |
| 3. Unavailable | Мёртвый клиент → `unavailable`/fail-closed; **на живом сервере не появилось ни одного ключа** (нет слабого fallback); клиент без EVAL → `atomic_script_unavailable` |
| 4. Публикация | Stage→commit→publish на реальной FS: байты точны, staged перемещён, `.staging/`-путь; повтор того же fence не «хлопает» файл; stale не трогает canonical и удаляет только свои staged; traversal (`../`, `..%2F`-начало) → null/hard error |
| 5. Crash-window | Commit в Redis, rename не случился → `resumePendingPublications` восстанавливает (resumed=1), второй проход — no-op; manifest без done-маркера **никогда** не публикует |
| 6. Staging GC | Текущий fence — выживает; superseded/absent-intent — удаляются; committed (done) — выживает; свежий — возрастной гейт; Redis-ошибка → abort, ноль удалений |
| 7. Redis down mid-publication | `unavailable` → staged СОХРАНЁН, canonical нет, успех не заявлен; retry после восстановления завершает commit+publish |
| 8. Mock parity | Последовательность вердиктов независимого mirror'а == реальному серверу |

Порядок вердиктов на реальном сервере: `committed → duplicate_same_fence → stale_intent → intent_missing → intent_corrupt → stale_intent → unavailable`.

---

## 4. Тесты

| Сьют | Результат |
|---|---|
| `tests/gpu-result-fencing-commit.test.js` (новый) | **30 passing / 0 failing** |
| Целевые: gpu-queue-idempotency + gpu-lane-release-order + dispatch-meta-lease-lifecycle + markready-build-id-idempotency | **111 passing** (совпадает с базовым замером Stage 130) |
| gpu-intent-fence-regressions + gpu-intent-fence-receipt | **48 passing** |
| happy-path | **75 passing** |
| `tests/architecture/**` | **935 passing / 24 pending** (базовый замер совпадает) |
| `scripts/syntax-smoke.sh` | All production JS/CJS files pass |
| Полный `tests/**` | см. §10 ниже |
| Real-Redis harness | **70 passed / 0 failed** (§3) |

Базовый замер до изменений (234 на целевых) не регрессировал; новые 30 тестов добавлены сверх.

---

## 5. Классификация пяти observations Stage 130

| # | Observation | Классификация | Обоснование |
|---|---|---|---|
| 1 | Lost-counter epoch-gap: при утрате stage-счётчика epoch-сравнение отключается (история — единственная защита) | **Non-blocking debt** (унаследованный send-side разрыв, 129 §6.6) | Commit-скрипт **не читает** stage-счётчик: вердикт — только из intent-записи. Утрата счётчика не делает stale fence публикуемым: чтобы stale fence закоммитился, intent-запись должна *снова* указывать на него — это возможно только через повторный ensure старым отправителем (окно: TTL счётчика истёк + параллельный старый sender). Цепочка остаётся не слабее существующего dispatch-гейта; фикс — send-side (отдельный stage), не publication |
| 2 | `rememberTaskRef` blind-SET race (отвергнутый старый sender транзиентно перезаписывает ref) | **Устранён для publication-пути** (deliberate deviation) | Job→fence ref **не является гейтом публикации**: intent-запись — единственный authority (Lua-шаг 3 только продлевает TTL согласованного ref). Проверено real-Redis V7.3/V7.4: несогласованный ref не блокирует текущий commit и не продлевается. Остаточный долг: ref всё ещё может транзиентно лгать ДРУГИМ читателям (dispatch-side) — вне scope 131 |
| 3 | Fallback reply-length check (MULTI/EXEC reply проверяется по длине, не по per-command ошибкам) | **Non-blocking debt** (теоретический, недостижимый) | Путь существует только у клиентов без EVAL; production-клиенты (ioredis) исполняют Lua. Для commit-пути fallback **не существует вовсе** (fail closed) — разрыв недостижим по построению в 131 |
| 4 | Local-vs-Prometheus degraded signal (расхождение локальных деградаций и Prometheus-счётчиков) | **Non-blocking debt** (observability) | 131 добавляет отдельный `animastor_fence_commit_total{outcome}` по тому же best-effort паттерну; деградация экспорта не влияет на корректность протокола. Фик инфраструктуры метрик — отдельная задача |
| 5 | Cluster CROSSSLOT (6 ключей скрипта могут попасть в разные слоты) | **Non-blocking debt** (задокументировано, fail-closed) | На cluster-топологии `EVAL` вернёт CROSSSLOT → `fenceCommitResult` = `unavailable` → публикация не случится (безопасно, но недоступно). Production Redis сегодня — standalone. Поддержка cluster потребует hash-tags в ключах — сознательно НЕ сделано молча; отдельная задача с миграцией ключей |

Ни одна observation не является blocker для Stage 131: нет пути публикации устаревшего результата через эти разрывы (см. §9.1).

---

## 6. Отклонения от контракта 126 (осознанные, задокументированные)

| Контракт | Реализация | Обоснование |
|---|---|---|
| §3.3 скрипт: 7 KEYS `[intent, receipt, ref, claim, done, manifest, journal]`, шаг 2 `receipt==fence`, шаг 3 `ref==fence` иначе `stale_intent` | **6 KEYS** (без receipt и без ref-гейта): fence резолвится из receipt/ref **до** commit'а; внутри скрипта шаг 3 — только продление TTL согласованного ref | (а) Receipt==fence выполняется по построению: fence берётся из immutable receipt (или ref-fallback), а скрипт повторно сверяет его с более сильным authority — intent. (б) Ref-гейт убран по audit 130 · obs. 2: blind-SET гонка превратила бы ref-проверку в ложный `stale_intent` для ТЕКУЩЕГО fence — fail-open в обратную сторону. Задокументировано в коде и в тестах |
| §3.3 аргумент `expectedEpoch` | Не передаётся: fence сам является производной (epoch + input) | Epoch уже закодирован в fence; сравнение fence==intent.fence покрывает семантику |
| §3.3 `committed` → удалить staged прошлых fence'ов этой задачи | Лениво: прошлые fence-директории удаляет возрастной GC (24 h, §5.5) | Тот же конечный результат без риска удалить не то; staged прошлых fence инертны (не видны читателям) |
| §3.3 `duplicate_same_fence` → удалить свой staged немедленно | Свой staged сохраняется до GC (24 h) | Инертные байты в `.staging/…`; удалять немедленно опаснее (резюм/crash-окно опирается на manifest+done, а не на файл, но лишняя запись состояния незачем). Не влияет на инварианты |
| §3.5 PG-проекция: `generation_fence` колонка + условный `markReadyFenced` | **Отложено целиком**: PG schema не менялась; metadata-цепочка идёт существующим `completeStage → markReady` — но **только после** подтверждённого commit'а | Требование «не обновлять ready раньше commit» выполнено (тест handler-level); условная проекция — отдельный stage (требует PG-миграцию) |
| §3.4 читатели: `resolvePublishedArtifact` | Не добавлен: публикация выполняется rename'ом в canonical, читатели видят файл только после commit'а | Read-after-commit-консистентность обеспечена самим протоколом; manifest остаётся authority для recovery/аудита |
| §3.2(3) magic bytes (PNG/ID3/ftyp) | Валидируются: непустой буфер + безопасное расширение; magic bytes не добавлены | Разрыв ДО-существующий (legacy-путь никогда не валидировал содержимое); сниффинг контента — риск ложных отказов (WAV/opus-сегменты) — отдельная задача |
| §5 фаза 2 `enforce` | `enforce` в этом stage == `observe` | Гейтинг legacy no-receipt колбэков требует окна ≥48 h observe (метрика `legacy_no_receipt`==0 за 24 h) — включение меткой без окна запрещено контрактом |

---

## 7. Протокол восстановления (Redis и FS — НЕ одна транзакция)

| Crash-окно | Durable-состояние | Восстановление |
|---|---|---|
| После stage, до commit | Staged-файл инертен; intent не тронут | Retry колбэка или повторный dispatch перезаписывают тот же fence dir; GC удаляет по возрасту+intent |
| После commit, до rename | **Manifest (durable, без TTL) + done-маркер** — полный протокол коммита | `resumePendingPublications` (recovery hook каждого reconcile-цикла) переигрывает rename; идемпотентно (каноничный уже есть → чистит staged-остаток) |
| Rename упал в процессе | То же: commit уже durable | **Успех не заявляется**, metadata-цепочка не идёт; retry/resume завершает rename (`publish_failed`) |
| Commit не подтвердился (Redis недоступен) | Ничего не записано (fail closed) | Staged + claim остаются; retry/`commitFencedResult` повторяет; dedup-маркер маршрута освобождается (retryable) |
| Terminal reject (stale/missing/corrupt) | Отвергнуто навсегда | Только СВОИ staged-байты удаляются; canonical/manifest/ready не тронуты; route отвечает `{ok:true, rejected:true}` с сохранённым dedup (без churn) |

---

## 8. Конкурентность (контракт §4) — сверка

- **cancel vs result:** не-active intent → `stale_intent` (real-Redis V6.1) ✔
- **regenerate vs result:** supersede → старый fence не публикуется, canonical не перезаписывается (V2, PUB.7–9) ✔
- **Два параллельных dispatch одной задачи:** ровно один `committed`, второй `duplicate_same_fence` (V1, SEQ) ✔
- **Разные intent'ы:** разные fence, старый не публикуется ✔
- **Рестарт между staging и CAS:** staged инертен; никакого автокоммита по факту файла (CR, GC) ✔
- **Повторная reconciliation:** CAS идемпотентен; hook повторного прохода — no-op (CR.5) ✔
- **TTL-истечения:** authority — intent (V3: нет intent → `intent_missing`, никогда не публикация) ✔
- **TOCTOU:** файловые проверки не участвуют в решении; решение — внутри одного Lua по текущим значениям Redis ✔

---

## 9. Условия вердикта PASS и остаточные ограничения

### 9.1 Выполнено
1. Staging → fenced commit → publish с атомарным Lua-вердиктом из durable intent — реализовано и доказано на реальном Redis (70/70).
2. Нет non-Lua fallback; `unavailable` — явный fail-closed.
3. Инварианты §2 подтверждены юнитами и real-Redis прогоном.
4. Real-Redis gate пройден на изолированной throwaway-инфраструктуре; production не затронут.
5. Пять observations 130 классифицированы (§5); ни одна не оставляет пути публикации устаревшего результата **через publication-протокол**: единственный обходной путь — legacy-колбэки БЕЗ fence-доказательств (см. ограничение Л1 ниже), которые по-прежнему закрыты существующим `verifyDispatchIdentity` (не ухудшено, контракт §5 фаза 1).
6. Kill-switch `off` = байт-в-байт legacy (тест); rollback безопасен (canonical не удаляется, staged уходит GC).
7. PG schema не изменена; ready/complete не раньше commit'а.

### 9.2 Ограничения (осознанные, без блокировки)
- **Л1. Legacy no-receipt колбэки** (аудио-recovery replay и т.п.) идут старым путём под `verifyDispatchIdentity` — fence-гейт на них не действует до фазы 2 (окно ≥48 h observe, метрика `legacy_no_receipt`).
- **Л2. `enforce` == `observe`** в этом stage (см. §6).
- **Л3. PG-ошибки metadata** затрагивают путь только через существующий `markReady` внутри `completeStage` — уже ПОСЛЕ commit'а (упорядочивание покрыто тестом, отдельного теста на сам PG-сбой не написано; обработка — существующая, до-существующая).
- **Л4. Magic bytes** не сниффятся (§6).
- **Л5. Cluster-топология** — fail-closed (§5, obs. 5).
- **Л6. Manifest без TTL** (durable по дизайну, recovery-указатель); зарегистрирован в `redis-registry.js` — оператор должен учитывать семейство при retention-политиках.
- **Л7. Свой staged при `duplicate_same_fence` чистится GC (24 h), а не немедленно** (§6).

---

## 10. Полный backend suite

`npx mocha --recursive tests/` (spec-прогон, изолированно от production):

**3453 passing / 28 pending / 0 failing** (лог: `audit-131/full-suite.log`)

База Stage 130 — 3425 passing / 28 pending → дельта **+28 = 28 тестов нового сьюта, присутствовавших на момент старта фонового прогона** (2 hook-теста добавлены позже; полный состав 30 подтверждён отдельным прогоном сьюта, см. §4; architecture-тесты, читающие `runtime-loop.js`, перепрогнаны после hook-правки — 30 passing). Регрессий нет.

---

## 11. Артефакты аудита

- `audit-131/01-fenced-commit-real-redis.cjs` — harness (реальный Redis + реальная FS + production-код)
- `audit-131/01-fenced-commit.json` — машинный результат (70 passed / 0 failed)
- Throwaway-контейнер `animastor-a131-redis` и volume удалены после прогона
