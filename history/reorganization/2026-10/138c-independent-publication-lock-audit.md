# Stage 138C — Complete Isolated Concurrency and Recovery Audit

**VERDICT: BLOCKED** — двойное владение publication-lock воспроизведено независимо и воспроизводимо (L1-PAUSE 3/3, L2-EIO 3/3), плюс два зависания (L5 busy-loop). Слой публикации (fencing/content-proof) при этом 25/25 — ложных success, stale publication и потери committed-данных в проверенных сценариях НЕ обнаружено.

Дата: 2026-10-25. Изоляция: throwaway Redis `a138-redis` (127.0.0.1:6438, `--save '' --appendonly no`, loopback-only, пустая БД, Lua/EVAL работает), временные каталоги `mkdtemp(/tmp/a138c-*)`.

---

## 1. Фиксация SHA и состояние Git (до и после)

Репозиторий: `/home/animastor/animastor-backend`

- **HEAD**: `5ea37b91d8cbd24421dc93d325ff6df75e405a6a` — совпадает с `audit-138/baseline-head.txt`; до и после работы идентичен.
- **SHA256 аудируемых файлов** — побайтово совпали с `audit-138/baseline-sha256.txt` (до и после, см. `audit-138c/baseline.txt`, `audit-138c/post-work-verify.txt`):

| Файл | SHA256 |
|---|---|
| `backend/src/services/publication-lock.cjs` | `e3fa5cc09bb7aa826b6175bb578c8fd28b6ba057c982b88a8c07b9924c743cee` |
| `backend/src/services/result-publication.cjs` | `98b74523256deae65f52b93b75957d4b441e74dc421a4b842c57c1c3b4cee927` |
| `backend/src/services/task-handler.cjs` | `5e936725792c4167dc827a72468039dce4d8323a8075f0a345350390f8c118fd` |
| `backend/src/services/audio-recovery.cjs` | `d6237a354da1bac685cac881517bc1f0b144c0a3426b1ed1ae302054a18f121c` |
| `backend/src/helpers/queue-idempotency.cjs` | `0bc0f8fc0c41106bf96617630638ddbfbc2555d44d0cc64d83423e5f7221c623` |

- **git status**: до и после — идентичны, те же 10 предсуществующих записей (`D backend/scripts/audit-orphan-books.js`, `M …` × 8, `?? deploy/`, `?? freebuff-chat-…md`); diff пуст (`audit-138c/post-work-verify.txt`). Ничего постороннего не тронуто.
- **Коммитов создано: 0.** push/deploy/CI/npm publish не выполнялись. `.env`, Compose, `GPU_FENCING_MODE` не менялись. Production Redis/PostgreSQL/GPU Hub не обращались.

**Замечание по 138-report:** прежний отчёт указывал SHA `088f3fa…` — это HEAD репозитория `/home/animastor/animastor` (другой репозиторий), а не аудируемого `animastor-backend`. Корректный проверяемый код: `5ea37b91…` (подтверждён паритетом с baseline audit-138).

---

## 2. Разбор прежних результатов (не «безвредные 6/14»)

Прежний `audit-138/01-run.log` (14 сценариев, 6 нарушений) — каждый случай разобран:

| # | Прежнее наблюдение | Разбор | Классификация |
|---|---|---|---|
| V1 | L1-STEAL (a): 3/3 двойное удержание | Окончательная проверка в старом harness была слабой («≥2 verified среди всех», а не пара пересекающихся). Пара с пересечением и обоими `verify()==true` (B∩C) существует — воспроизведено мной (L1-PAUSE (a)) | **Реальный дефект** |
| V2 | L1-STEAL (b): свежий lock вытеснен в `.stale-*` | Живой владелец теряет lock-каталог; restore не успевает, когда третий процесс входит в свободный путь | **Реальный дефект** (воспроизведён) |
| V3 | L2-OWNER-READ-ERROR (a): захват живого owner при EIO | Невоспроизводимо в моей первой итерации из-за ошибки предиката в моём же harness; после исправления — воспроизводится 3/3 (L2-EIO). Невdefined ownership лечится как «нет owner» → после grace удаляется чужой живой lock | **Реальный дефект** (воспроизведён) |
| V4 | L2-OWNER-READ-ERROR (b): rename в quarantine удаляет свежий lock | Тот же механизм, что V3 (общий поток) | **Реальный дефект** (воспроизведён) |
| V5 | L5-RENAME-EACCES: busy-loop, waitMs не соблюдается | `catch{continue}` пропускает и timeout, и sleep → бесконечный цикл, `publication_lock_timeout` никогда не бросается; withPublicationLock висит навсегда | **Реальный дефект** (воспроизведён: child убит по таймауту) |
| V6 | L5-STAT-EIO: busy-loop | Аналогично `if (!st) continue` | **Реальный дефект** (воспроизведён) |

Вывод: «6/14 violations» — это не безвредные особенности, а 6 реальных дефектов (2 класса: двойное владение/потеря чужого lock + невыполнимый контракт таймаута). Итоговый отчёт 138 («документированные инвариантные поведения») был некорректен в этой части.

---

## 3. Независимые изолированные проверки lock L1–L5

Файлы: `audit-138c/l-child.cjs`, `audit-138c/l-harness.cjs`, результаты `audit-138c/l-results.json`, лог `l-run2.log`.
Реальные OS-процессы, реальная ФС (`mkdtemp`), НЕИЗМЕНЁННЫЙ production-модуль (SHA256 выше). Инъекции — только через публичные швы `opts.fs/pid/hostname/kill/waitMs` и настоящие SIGKILL на барьерах. Redis не нужен. Для каждого сценария фиксировались владельцы (owner.json token/pid/host), токены каждого процесса, интервалы удержания, verify-результаты, tomb-список.

**Итог: 17 проверок — 12 PASS / 5 FAIL (нарушения).**

### PASS (12)

| Проверка | Фактическое состояние |
|---|---|
| L1-NATURAL (10 раундов, 3 процесса, dead owner, без инъекций) | Взаимное исключение держится: нет пересечений, `v1=v2=rel=true`, owner.json всегда наш |
| L2-PIDREUSE | Живой чужой PID → `publication_lock_timeout`, lock не тронут |
| L2-FOREIGN-HOST | Чужой хост → fail closed, lock не тронут |
| L2-UNKNOWN-OWNER (junk/partial, fresh/aged, 4 варианта) | Свежий не воруется; aged возвращается после grace (5s) — по дизайну; частично записанный owner живого процесса, поставленного на паузу >5s — уязвимость grace (задокументирована) |
| L3-CRASH-BEFORE-OWNER (настоящий SIGKILL между mkdir и owner) | Свежий не воруется; после aging — возвращён |
| L3-CRASH-AFTER-QUARANTINE (SIGKILL после rename) | Путь свободен, следующий берёт сразу (<2s); tomb остаётся мусором навсегда (нет GC) — minor |
| L3-CRASH-DURING-RELEASE (SIGKILL внутри release) | Остаётся owner с мёртвым PID → следующий возвращает dead-owner и берёт |
| L4-DELETE-DURING-HOLD | Внешнее удаление lock между verify() и rename → `v2=false`, `rel=false`, без исключений |
| L4-REPLACE-DURING-HOLD | Подмена owner.json чужим токеном → `v2=false`, release() НЕ удаляет чужой lock (compare-and-delete) |
| L5-MKDIR | `publication_lock_failed`, без зависания |
| L5-OWNER-READ | `publication_lock_timeout` в пределах waitMs |
| L5-RM | release() возвращает false, не бросает, состояние без изменений |

### FAIL / VIOLATION (5)

**V-1. L1-PAUSE (a) — ДВОЙНОЕ ВЛАДЕНИЕ, 3/3 раунда.**
Устройство: A (reclaimer) читает мёртвого владельца, попадает под десchedul­инг внутри quarantine-rename (pre-pause 200ms — обычная задержка планировщика, НЕ fs-ошибка); B в это время возвращает мёртвый lock и берёт его (+64ms); A просыпается и rename'ит СВЕЖИЙ lock B в tomb; A засыпает post-pause 250ms — lock-путь свободен; C входит (+225ms).
Факт: B[64..564] и C[225..625] — пересечение 225..564, **оба `v1=true`** (оба верифицировали владение внутри своих критических секций), токен B stranded в `.stale-*`, `v2/rel` у B = false.
Производственный смысл: два процесса одновременно в «перечитать intent → rename → verify» — ровно то, зачем lock создан. Окно достижимо без единой fs-ошибки (пауза GC/планировщика между `_readOwner` и `renameSync`).

**V-2. L1-PAUSE (b) — свежий lock живого владельца вытеснен в tomb, 3/3** (тот же поток; restore затирается входом C).

**V-3. L2-EIO — ДВОЙНОЕ ВЛАДЕНИЕ при неопределённом владении, 3/3.**
A: чтения owner.json падают с EIO (включая чтение tomb после rename) → `owner=null`; решение о reclaim принято по AGED сироте (mtime 10s) → rename с pause; B в окне возвращает сироту и берёт свежий lock (+62ms); A просыпается, rename'ит свежий lock B, чтение tomb → EIO → `moved=null` → `sameOwner=(!moved)=true` → `rmSync(tomb)` — **живой lock B удалён**; A берёт (+204ms). Пересечение [62..562]∩[204..604], оба `v1=true`, `bLockGone=true`.
Спека L2 требует: «неопределённое владение должно завершаться безопасным отказом». Код отказывает небезопасно. Триггер: транзиентная ошибка чтения ФС + сирота ≥5s (возможны на деградированной ФС).

**V-4. L5-RENAME — зависание (busy-loop), child убит по таймауту 3000ms при waitMs=800.**
`catch (_) { continue }` пропускает и проверку `now-started >= waitMs`, и `_sleep(POLL_MS)` → бесконечный цикл, `publication_lock_timeout` никогда не бросается → `withPublicationLock`/`publishCommittedFence` висят вечно (availability-дефект, не ложный success).

**V-5. L5-STAT — зависание (busy-loop)**, та же причина: `if (!st) continue`.

---

## 4. Fencing и восстановление F1–F13 (реальный Redis + Lua + барьеры)

Файлы: `audit-138c/f-child.cjs`, `audit-138c/f-harness.cjs`, результати `audit-138c/f-results.json`, логи `f-run4.log`.
Критические гонки — два реальных процесса с файловыми барьерами (`.f-parked/.f-release/.f-renamed/.f-continue`, SIGKILL на барьере), НЕ случайные задержки. Состояние проверялось по canonical/staged/intent/manifest/marker/ready-saveChunk, не по exit code.

**Итог: 25 проверок — 25 PASS / 0 FAIL.**

| Сценарий | Результат |
|---|---|
| F1 superseded до rename (2 proc, парк внутри lock) | F1 откатился `stale_intent`, saveChunk=0/completeStage=0; canonical/manifest/marker = F2, sha контент-доказан | PASS |
| F2 ожидает lock, пока F1 в critical section (2 proc) | F2 НЕ завершился до открытия барьера; завершился только после release (`h2End > tRelease`), fenced=true | PASS |
| F3 lock потерян ДО rename (2 proc) | `publication_lock_lost`, canonical восстановлен, committed staged-байты сохранены (`F1-BYTES`), saveChunk=0 | PASS |
| F4 lock потерян ПОСЛЕ rename (2 proc) | fail closed, байты откачены в staged; retry после лечения публикует (canonical=F1, marker published, saveChunk=1) | PASS ×2 |
| F5 Redis-fail ДО rename (marker set) | `publish_failed` «marker write failed — the rename was not attempted», canonical не тронут, staged сохранён; retry лечит | PASS ×2 |
| F6 Redis-fail на финализации (marker 'published') | rename контент-доказан, marker остался `renaming`, `verifyPublishedFence=not_published` (никакой ложной proofs); resume чинит → published | PASS ×2 |
| F7 Redis-fail в post-rename intent read | `publish_failed` (публикация НЕ подтверждена), marker=renaming; redelivery сходится к published, байты F1 | PASS ×2 |
| F8 crash между rename и marker 'published' (настоящий SIGKILL, 2 proc) | canonical=F1 + marker=renaming + staged удалён; verify=not_published; resume → published, sha маркера = sha256(F1) | PASS ×2 |
| F9a staged-байты неверные при верном размере | `staged_content_mismatch`, canonical не тронут, tampered staged НЕ удалён; restage+retry → published | PASS ×2 |
| F9b canonical подменён (верный размер) | redelivery НЕ `already_published` — реально републикует правильные байты; без staged: `canonical_content_mismatch`, чужие байты НЕ удалены (M8/M8R) | PASS ×2 |
| F10a manifest fence ≠ intent | `stale_intent`, canonical/staged/marker не тронуты | PASS |
| F10b чужой marker + неподтверждённый canonical | `publication_unproven`, чужие байты не тронуты (M7) | PASS |
| F11 ready/saveChunk до доказанной публикации | (a) доставка superseded fence → saveChunk=0, completeStage=0; (b) fs-ошибка rename → фейл, saveChunk=0, staged сохранён; (c) control: лечение → saveChunk=1 | PASS ×3 |
| F12 callback vs restart recovery (2 proc) | recovery паркован в lock → callback ждал (`cbEnd > tRelease`), один корректный публиш, canonical sha верна, saveChunk=1 | PASS |
| F13 resume vs supersede (RACE2-эквивалент, 2 proc) | recovery откатился (superseded≥1), F2 ждал lock и победил; итог везде F2, staged F1 сохранён | PASS |

---

## 5. Повторная проверка прежних инвариантов

Все прогоны на изолированном `AUDIT_REDIS_URL=redis://127.0.0.1:6438/0`, копии harness-ов audit-137 (без изменений), логи в `audit-138c/prior-*.log`:

| Harness | Что покрывает | Результат |
|---|---|---|
| `01-core.cjs` | P1-A/P1-B, M9, B3e/f/g, RACE1-1/RACE1-2/RACE2 (R1/R2) | **24/24 PASS**, exit 0 (RACE1-1, RACE1-2, RACE2 — PASS нативно) |
| `10-rerun-audit136-b1b6.cjs` | B1–B6, B6-R5a/R6 | **24/24 PASS**, exit 0 |
| `11-rerun-audit136-marker-safety.cjs` | M1–M9 + RACE1/RACE2 | **15/15 M-проверок PASS** (M1…M9 включая M8/M8b/M9); **но** зависание 2/2 прогонов на RACE1 после `RACE1-MIDSTATE F2-BYTES` — дефект САМОГО harness'а: родитель подписывается на `child.on('exit')` ПОСЛЕ собственной F2-публикации и пропускает уже завершившийся exit → `await` вечен, `timeout 300` → exit 124. Доказательства: `.race-result.json` записан ребёнком в 04:37:30.303 с `error=stale_intent` (корректный откат), `.race-unparked` 04:37:30.291, canonical = `F2-BYTES`, живых процессов нет. **Инвариант RACE1 фактически держится** (canonical=F2, F1 откатился); RACE2 этим harness'ом не запускался. Отличие задокументировано: заменено независимыми сценариями F1 (RACE1) и F13 (RACE2) + нативным RACE1/RACE2 в 01-core — все PASS |
| `12-rerun-audit134-independent.cjs` | R1/R2 идиемпотентность, телеметрия | **15/15 PASS** + 2 probe-информативных (probe N2: retry не сообщает успех при `staged_content_mismatch` — инвариант «успех ⇒ текущие байты» соблюдён; `consistent:false` в probe — это ожидание probe на случай успеха retry, не FAIL) |
| `13-rerun-audit134-minimal-repro.cjs` | minimal repro B6/R1/R2 | **blocked=false, R1=true, R2=true**, exit 0 |

**Итого по прежним инвариантов: 78 проверок PASS, 0 FAIL** (24+24+15+15+1) + нативные RACE1/RACE2 в 01-core.

---

## 6. Непроверенные сценарии (явно, не «PASS по отсутствию ошибки»)

1. **Комбинация «двойное владение из L1-PAUSE/L2-EIO → два конкурентных publishCommittedFence с разными fence» (не RUN).** Причина: требует 3–4 процессов с одновременным reclaim-окном и публикацией; воспроизводимость требует отдельного раунда тюнинга барьеров. Слой публикации показал корректное поведение при потере lock (F3/F4) и при supersede (F1/F13), НО containment именно сценария двойного владения через content-proof **не доказан** — остаётся открытым.
2. **Нативный RACE1/RACE2 в `11-rerun` (NOT RUN)** — harness воспроизводимо зависает на своей гонке подписки на exit (2/2); заменено F1/F13 + 01-core RACE (все PASS). Сам дефект — на стороне harness-копии, не production.
3. **EIO-сценарий в реальной ФС не инжектился** — только через публичный `opts.fs` шов (по правилам задачи); реальный аппаратный EIO не воспроизводился.

---

## 7. Найденные дефекты (без исправлений — production не менялся)

| ID | Серьёзность | Описание | Воспроизводимость |
|---|---|---|---|
| **D1** | **Критический (BLOCKED)** | Двойное владение lock: отложенный reclaimer rename'ит СВЕЖИЙ lock живого процесса, третий входит в свободный путь — два `verify()==true` в пересекающихся интервалах. Требует только задержки планировщика между `_readOwner` и `renameSync` (L1-PAUSE (a)) | 3/3 независимых раунда |
| **D2** | **Критический (BLOCKED)** | EIO при чтении owner.json в фазе reclaim → «неопределённое владение» лечится не безопасным отказом, а захватом: живой lock удаляется (`rmSync(tomb)`), двойное владение (L2-EIO) | 3/3 независимых раундов |
| D3 | Высокий | `acquire()` не соблюдает `waitMs` при постоянных rename/stat ошибках — бесконечный busy-loop, `publication_lock_timeout` никогда; публикация висит вечно (L5-RENAME/STAT) | 2/2 (убит по таймауту) |
| D4 | Средний | Вытеснение свежего lock в `.stale-*` без восстановления при входе третьего процесса (L1-PAUSE (b)) — потеря владельцем lock-каталога | 3/3 |
| D5 | Низкий | `.stale-*` tombs никогда не удаляются (нет GC) — накопление мусора | постоянно |
| D6 | Низкий (harness) | Копия harness'а `11-rerun` (audit-137) теряет exit-событие ребёнка — RACE1 зависает; дефект тестовой инфраструктуры, инвариант выдержал | 2/2 |

Отсутствие ложных success/stale publication/pотери committed-данных/ready-без-публикации в проверенных сценариях fencing слоя (25/25) — **не отменяет** D1/D2: критерий «двойное владение» уже найден.

---

## 8. Критерии и вердикт

| Вердикт | Условие |
|---|---|
| PASS | Критические инварианты подтверждены воспроизводимыми независимыми проверками |
| **BLOCKED** | **Найдены двойное владение (D1, D2 — 3/3 каждый), см. также D3–D5** |
| INCONCLUSIVE | Существенные сценарии не проверены |

### **VERDICT: BLOCKED**

**Счётчики:**
- Независимые новые проверки: **42** — PASS **37** (12 lock + 25 fencing) / FAIL **5** (L1-PAUSE (a)(b), L2-EIO, L5-RENAME, L5-STAT)
- Повтор прежних инвариантов: **78** — PASS **78** / FAIL **0** (01:24, 10:24, 11:15, 12:15, 13:1) + нативные RACE1/RACE2 в 01-core
- NOT RUN: **3** (комбинация двойного владения end-to-end; нативный RACE1/RACE2 в 11-rerun — заменены F1/F13; реальный аппаратный EIO)

**Production-код и посторонние изменения не затронуты:** HEAD `5ea37b91…` и все 5 SHA256 идентичны baseline до и после; git status идентичен (те же 10 предсуществующих записей); коммитов/push/deploy/CI/npm — 0; `.env`/Compose/`GPU_FENCING_MODE` — не менялись; к production Redis/PostgreSQL/GPU Hub — подключений не было (только loopback throwaway `a138-redis`:6438 и временные каталоги); прежние артефакты `audit-138/` и отчёты не перезаписаны.

---

## 9. Артефакты и команды

Все в `audit-138c/` (новые) — прежние `audit-138/*` не тронуты:

```
baseline.txt                 # HEAD + sha256 до работы
baseline-git-status.txt      # git status до работы
post-work-verify.txt         # HEAD + sha256 + git status после работы (паритет)
l-child.cjs, l-harness.cjs   # независимый L1–L5 harness
l-results.json, l-run2.log   # 17 проверок: 12 PASS / 5 VIOLATION
f-child.cjs, f-harness.cjs   # независимый F1–F13 harness
f-results.json, f-run4.log   # 25 проверок: 25 PASS
prior-01-core.log            # 24/24 (вкл. RACE1-1/RACE1-2/RACE2)
prior-10-rerun-audit136-b1b6.log            # 24/24
prior-11-rerun-audit136-marker-safety.log   # 15/15, зависание RACE1 (harness)
prior-11-retry.log           # повтор: 15/15, то же зависание (2/2)
prior-12-rerun-audit134-independent.log     # 15/15 + 2 probes
prior-13-rerun-audit134-minimal-repro.log   # blocked=false R1/R2=true
```

Ключевые команды:

```
# изоляция (существовала с фазы 138: loopback, без persistence)
docker run --rm -d --name a138-redis -p 127.0.0.1:6438:6379 redis:7 --save '' --appendonly no
docker exec a138-redis redis-cli ping            # PONG
docker exec a138-redis redis-cli eval "return 1+1" 0   # 2 (Lua)

# независимые проверки (cwd audit-138c)
node l-harness.cjs                                                # exit 1: 17 checks, 5 VIOLATION (ожидаемо — найденные дефекты)
AUDIT_REDIS_URL=redis://127.0.0.1:6438/0 node f-harness.cjs       # exit 0: 25/25 PASS

# повтор прежних инвариантов (cwd audit-137, копии без изменений)
AUDIT_REDIS_URL=redis://127.0.0.1:6438/0 node 01-core.cjs                              # exit 0 — 24/24
AUDIT_REDIS_URL=redis://127.0.0.1:6438/0 node 10-rerun-audit136-b1b6.cjs               # exit 0 — 24/24
AUDIT_REDIS_URL=redis://127.0.0.1:6438/0 node 11-rerun-audit136-marker-safety.cjs      # exit 124 — 15/15 M, зависание RACE1 (harness-дефект, 2/2)
AUDIT_REDIS_URL=redis://127.0.0.1:6438/0 node 12-rerun-audit134-independent.cjs        # exit 0 — 15/15
AUDIT_REDIS_URL=redis://127.0.0.1:6438/0 node 13-rerun-audit134-minimal-repro.cjs      # exit 0 — blocked=false

# контроль целостности
cd /home/animastor/animastor-backend && git rev-parse HEAD && git status --porcelain=v1
sha256sum backend/src/services/{publication-lock,result-publication,task-handler,audio-recovery}.cjs backend/src/helpers/queue-idempotency.cjs
```

Throwaway Redis `a138-redis` оставлен работать (loopback, без persistence; создан до этой фазы, другими фазами) — удалять/менять не стал, чтобы не нарушить чужие процессы.

---

*Аудит выполнен без изменений production-кода и тестов; без коммитов, push, deploy, CI, npm publish. Дефекты D1–D6 не исправлялись — по условию этапа.*
