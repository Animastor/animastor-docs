# Stage 139 — Исправление владения publication-lock и ошибок timeout (D1–D5)

**ВЕРДИКТ: PASS** — дефекты D1–D4 закрыты и воспроизведены/погашены в 20/20 раундах каждого
критического сценария; D5 закрыт безопасной консервативной политикой GC; все регрессии чисты.

- Проверяемый commit (baseline): `5ea37b91d8cbd24421dc93d325ff6df75e405a6a`
- Локальный commit с исправлением: **`c500b221`** — `backend/src/services/publication-lock.cjs` (+415/−54)
- Изменённых production-файлов: **1** (publication-lock.cjs). `result-publication.cjs`,
  `task-handler.cjs`, `audio-recovery.cjs` — SHA256 идентичны baseline.

---

## 1. Механизм D1/D2/D4 — claim-gated reclaim (доказуемая эксклюзивность)

Ранее: reclaimer читал owner → решал «мертв» → `rename(lockDir→tomb)`. TOCTOU между чтением и
rename: пока reclaimer приостановлен, другой процесс мог удалить старый каталог и создать свежий,
и rename переносил УЖЕ ЧУЖОЙ живой lock (L1-PAUSE), либо EIO при чтении owner.json трактовался
как «владельца нет» и живой lock забирался (L2-EIO). Дополнительно `continue` пропускал
проверку deadline и sleep → busy-loop при постоянных ошибках (D3).

Новый протокол захвата (порядок обязателен):

1. **Три-состоятельное чтение owner** (`_readOwnerTri`): `present` / `absent` (ENOENT) /
   `unknown` (EIO, EACCES, битый JSON). `unknown` = неопределённое владение → **никогда** не
   считается отсутствием владельца: без rename, только ожидание до deadline → `publication_lock_timeout`.
   Путь по времени (orphan grace) доступен **только** для `absent`.
2. **Атомарный claim**: `mkdir(lockDir/.reclaim)` — атомарен на POSIX, ровно один reclaimer
   получает `held`. Конкуренты получают `busy` и ждут (или чистят claim только если его владелец
   доказуемо мёртв на этом же хосте).
3. **Gate-перечитывание под claim**: owner перечитывается, уже держа claim. Если владелец стал
   живым/неопределимым/другим — reclaim отменяется (claim освобождается, rename не выполняется).
4. **Post-rename идентичность**: после `rename(lockDir→tomb)` tomb обязан содержать **наш claim-файл**
   И owner, совпадающий с gate-доказательством. Иначе перенесён не тот каталог → восстановление
   (rename обратно, только если путь свободен; никогда не перезапись чужого) + fail closed.

**Почему это безопасно (для production-акторов)**: пока удерживается claim, каталог не может сменить
идентичность — смена требует предварительного удаления пути, а удаление возможно только через
release() владельцем (в ветке reclaim владелец доказуемо мёртв), rename другого конкурента
(заблокировано claim'ом) или собственный rename. Замороженный reclaimer всегда продолжает работу
с ТЕМ ЖЕ инстансом каталога, что он валидировал. Post-rename сверка claim-файла превращает
«stat перед rename» в доказательство идентичности.

**Предпосылки и ограничения (задокументированы в шапке модуля):**
- Внешний `rm -rf` lock-каталога во время приостановленного reclaim может подменить инстанс —
  обнаруживается fail-closed (восстановление + verify() издателя до/после rename). Защита от
  враждебного rm -rf не заявляется; заявляется защита от гонок конкурентных reclaimer/прекемпции.
- Крэш процесса внутри его own-окна «mkdir(lockDir) → write owner.json»: если owner.json записан
  частично (битый), владение неопределимо → **навсегда fail-closed до ручной очистки оператором**
  (L3-PARTIAL-OWNER: тест проверяет fail-closed + лечение после ручного удаления). Раньше битый
  owner откатывался по grace — это и была дыра D2.
- Владелец, приостановленный ≥ ORPHAN_GRACE_MS между mkdir и записью owner.json (файл отсутствует),
  теряет lock (документированный остаточный риск, как в Stage 138C); обнаруживается gate'ом.
- `release()`: compare-and-delete по токену — чужую блокировку никогда не удаляет (L4 ×5 OK);
  при нечитаемом owner возвращает false (не удаляет).

## 2. D3 — deadline и отсутствие busy-loop

Одна структура цикла: **каждая** итерация начинается с `_checkDeadline(waitMs)`, **каждый** путь
повтора заканчивается `await _sleep(POLL_MS)`. Ни один `continue` не обходит ни deadline, ни sleep.
Постоянные ошибки rename/stat/owner-read → контролируемый `publication_lock_timeout` в пределах
waitMs + ε; структурные ошибки (root mkdir, запись своего owner) → `publication_lock_failed`.
Ошибки не маскируются под «lock отсутствует» (три-состоятельные read/stat).

## 3. D5 — GC карантина `.stale-*`

`collectStaleQuarantine(config, opts)` (opt-in, экспортирован): удаляет **только** каталоги
`*.stale-*` (никогда активные `*.lock`), причём только доказанно неактивные: возраст ≥ 60 s,
owner отсутствует ИЛИ владелец доказуемо мёртв на этом хосте, и нет живого `.reclaim`-кандидата.
Нечитаемое/чужое/молодое/живое — пропускается. Политика проверена тестом D5-GC (см. §4).

## 4. Регрессионные тесты (audit-139/, реальные процессы, реальная ФС, throwaway Redis 127.0.0.1:6440)

### 4.1 Сценарии аудита Stage 138C — l-harness: **20 checks, 0 failed (exit 0)**, `l-results.json`, `l-run.log`

| Сценарий | Раунды | Результат |
|---|---|---|
| L1-NATURAL (3 конкурентных reclaimer, мёртвый владелец) | **20** | OK — нет пересекающихся verified-hold, токен всегда свой |
| L1-PAUSE (a) двойное владение при приостановке в rename | **20** | **OK (было VIOLATION 3/3)** |
| L1-PAUSE (b) вытеснение свежего lock в .stale-* | **20** | **OK (было VIOLATION)** |
| L2-EIO чтение owner с ошибкой | **20** | **OK (было VIOLATION 3/3)** — EIO-читатель входит в hold только на СВОБОДНОМ пути после нормального release; holder в intact |
| L2-PIDREUSE / L2-FOREIGN-HOST | 5 | PASS — fail-closed, lock не тронут |
| L2-UNKNOWN-OWNER junk/partial fresh+aged, absent fresh/aged | 6 вариантов | PASS — **битый owner: fail-closed в любом возрасте, байты не тронуты**; absent: fresh→timeout, aged→reclaim (восстановление после крэша) |
| L3-CRASH-BEFORE-OWNER / AFTER-QUARANTINE / DURING-RELEASE | 3 | PASS ×3 |
| L3-PARTIAL-OWNER (крэш при записи owner) — **новый** | 3 | PASS — fail-closed + ручное лечение |
| L4-DELETE / L4-REPLACE-DURING-HOLD | 5 | PASS ×2 — v2=false, release не удаляет чужое |
| L5-RENAME / L5-STAT / L5-OWNER-READ (постоянная ошибка) | **20** | PASS ×3 — **publication_lock_timeout, killed=false, никакого busy-loop** |
| L5-MKDIR / L5-RM | 1 | PASS ×2 |
| D4-LIVE-OWNER-AGED — **новый** | 5 | PASS — живой владелец со старым каталогом удерживает lock против 3 конкурентов |
| D5-GC — **новый** | 1 | PASS — удалены только старые мёртвые/пустые tombs; young/live/foreign/claimant/unreadable пропущены; активный lock не тронут |

**Отклонение от ожиданий 138C (по требованию Stage 139):** `partial/junk-aged` больше НЕ
перехватывается по grace — битый owner.json есть неопределённое владение, не доказательство
отсутствия владельца; ожидание теперь `publication_lock_timeout` без изменения байтов.

### 4.2 Fencing-сценарии + параллельная публикация — f-harness: **27 checks, 0 failed (exit 0)**

- Все **25 сценариев** Stage 138C (F1–F13: супersede до/после rename, потерянный lock до/после
  rename, redis-отказы до rename/на finalize/после rename, крэш SIGKILL, tampered staged/canonical
  (M8/M8R/M7/M6), ready/saveChunk-гейты, callback-vs-recovery, resume-vs-supersede) — PASS.
- **S14a (20 раундов)**: два прямых `publishCommittedFence` с разными fence (F1+F2) параллельно,
  пока отложенный reclaimer приостановлен **непосредственно перед reclaim-rename** (lock-pre):
  P1 → `stale_intent` (refusal), P2 → `published:true`; конечное состояние целиком F2
  (canonical=sha, stagedF1 сохранён, stagedF2 поглощён, manifest/marker/intent=F2 active,
  lockDir удалён); «оба успеха» — 0.
- **S14b (20 раундов)**: два handler с разными `opts.fence`, reclaimer приостановлен **после**
  quarantine-rename (окно входа третьего процесса): P1 → `stale_intent`, saveChunk=0,
  completeStage=0; P2 → `fenced:true`, saveChunk=1; конечное состояние F2 везде; lock не остался.
- Логи: `f-run.log`, `f-results.json`.

### 4.3 Прежние инварианты (audit-137, throwaway Redis) — `prior-regressions.log`

| Harness | Результат |
|---|---|
| 01-core (B1–B6, RACE1-1/2, RACE2 и др.) | **24/24 PASS, exit 0** |
| 10 (B1–B6) | **24/24 PASS, exit 0** |
| 11 (M1–M9 + RACE1/RACE2) | **15/15 PASS**, затем зависание в **дефекте самого harness'а** (RACE1: exit-listener race, задокументирован ещё в 138C) — процесс родителя убит вручную; RACE1/RACE2 покрыты нативно 01-core (24/24) |
| 12 | **15/15 PASS, probes=2, exit 0** |
| 13 | **blocked=false, exit 0** |

### 4.4 Тесты проекта

- Полный backend suite: **3489 passing / 0 failing / 28 pending, exit 0** (`full-suite.log`).
- Прицельные: gpu-publication-consistency + gpu-fenced-publication-gates +
  gpu-result-fencing-commit + gpu-queue-idempotency → **122 passing, exit 0**
  (`targeted-fencing-tests.log`) — включает тесты kill-switch **`GPU_FENCING_MODE=off`**
  (gpu-fenced-publication-gates:324, gpu-result-fencing-commit:513) и штатную идемпотентность.
- Синтаксис: `./scripts/syntax-smoke.sh backend` → exit 0 (`syntax-smoke.log`).

## 5. Соблюдение ограничений

1. Baseline зафиксирован: HEAD `5ea37b91`, `git status --porcelain`, SHA256 изменяемых файлов
   (`audit-139/baseline.txt`).
2. Посторонние dirty/untracked-файлы (10 предсуществующих записей + `deploy/`, freebuff-chat) —
   не тронуты и **не включены** в commit; git status после коммита идентичен baseline + 1 наш файл.
3. Production Redis/PostgreSQL/GPU Hub — подключений не было; только throwaway
   `a139-redis` (127.0.0.1:6440, `--save '' --appendonly no`, loopback) — удалён после прогонов.
4. Тесты — реальные дочерние процессы, временная ФС (`mkdtemp`), управляемые барьеры
   (файлы + `Atomics.wait`), реальные SIGKILL-крэши, throwaway Redis.
5. `.env`, Compose, production-конфигурация, `GPU_FENCING_MODE` — не изменялись.
6. push/deploy/CI/npm publish — 0. Локальный commit `c500b221` создан после прохождения всех критериев.
7. Полный diff просмотрен (§1–§3 соответствуют коду); паритет SHA256 неизменённых файлов подтверждён.

## 6. Критерии завершения

| Критерий | Статус |
|---|---|
| D1/D2 не воспроизводятся в 20/20 раундах каждого критического сценария | ✅ L1-PAUSE(a), L1-PAUSE(b), L2-EIO, L5×3, L1-NATURAL, S14a, S14b — 20/20 |
| D3/D4 закрыты и подтверждены тестами | ✅ L5 (timeout, no busy-loop) + D4-LIVE-OWNER-AGED |
| Двойное владение и удаление чужого lock невозможны в проверенных сценариях | ✅ 0 нарушений во всех раундах |
| Публикация не может завершиться успешно при нарушении эксклюзивности | ✅ S14a/b: ровно одна публикация, проигравший — fail-closed |
| Нет новых падений полного backend suite | ✅ 3489/0 |
| Посторонние изменения сохранены | ✅ parity-проверка |

**NOT RUN (документированные ограничения, как в 138C):** реальный аппаратный EIO (эмуляция через
public-seam `opts.fs`); нативный RACE1/RACE2 внутри harness'а 11 (зависает на собственном
дефекте записи — покрыто 01-core 24/24). Иных непройденных пунктов нет — вердикт PASS не
ослаблялся: все проверки либо прошли, либо явно перечислены здесь.

## 7. Артефакты

| Путь | Содержимое |
|---|---|
| `/home/animastor/reorg-2026-10-23/139-publication-lock-fix.md` | этот отчёт |
| `audit-139/baseline.txt` | HEAD/status/SHA256 до работ |
| `audit-139/l-harness.cjs`, `l-child.cjs`, `l-results.json`, `l-run.log` | lock-регрессия L1–L5 + D4/D5 |
| `audit-139/f-harness.cjs`, `f-child.cjs`, `f-results.json`, `f-run.log` | 25 fencing + S14a/b |
| `audit-139/prior-regressions.log` | повтор 01/10/11/12/13 |
| `audit-139/full-suite.log`, `targeted-fencing-tests.log`, `syntax-smoke.log` | тесты проекта |
