# Stage 136 — Independent Audit of Fenced Publication Consistency

**Вердикт: BLOCKED.**

Commit Stage 135 (`6a6f18910cc73085533d3bf1b5c51996f90541bd`) действительно закрывает
B6 из Stage 134 в его исходной формулировке (rename failure + crash между commit и
rename для **того же** fence): R1/R2a–d воспроизводятся и проходят на реальном
Redis/Lua/FS, B1–B5 не регрессировали, полный backend suite зелёный
(3489 passing, 0 failing).

Однако независимые сценарии Stage 136 нашли **два P1-блокера** в самом протоколе
публикации, которые Stage 135 не покрывает:

1. **P1-A — отсутствует сериализация между проверкой intent и файловым rename.**
   In-flight публикация устаревшего fence может после supersede перезаписать
   canonical уже опубликованного нового fence. Воспроизведено детерминированно
   двумя процессами: `canonical = F1`, `manifest/done = F2`, `marker = published F1`,
   ready-метаданные пишет stale-handler, а restart-recovery для F2 после этого
   навсегда получает `publication_unproven`. Recovery-вариант той же гонки
   возвращает `resumed=1`, то есть **сам рапортует успех** после перезаписи.
2. **P1-B — «canonical уже опубликован» доказывается только маркером и фактом
   существования файла.** Если canonical заменён вне протокола (ручная правка,
   другой writer), redelivery возвращает success (`already_published`), удаляет
   единственную staged-копию правильных байтов и пишет ready-метаданные поверх
   неверного файла. Проверки содержимого (hash/size/atime) нет ни в одном решении
   state machine.

Дополнительно найдены два P2: debug-recovery короткозамыкает на устаревших
ready-флагах и «успешно» выбрасывает результат текущей генерации (B3e/f/g), а
ветка `ENOENT → rename_verified` принимает чужой canonical за доказательство
завершённого rename (M9).

- **Проверенный commit:** `6a6f18910cc73085533d3bf1b5c51996f90541bd` (Stage 135).
- **HEAD на момент аудита не менялся**, рабочее дерево и посторонние
  dirty/untracked-файлы — байт-в-байт как в baseline (sha256, §1).
- Production-код, тесты, конфигурация, `.env`, Compose, `GPU_FENCING_MODE` не
  изменялись; commit/push/deploy/npm/CI не выполнялись; production
  Redis/PostgreSQL/GPU Hub/очереди/контейнеры не использовались.
- **Полный отчёт:** этот файл. Артефакты и воспроизведение — `audit-136/`.

---

## 1. Исходное состояние и границы

```
HEAD   6a6f18910cc73085533d3bf1b5c51996f90541bd
        fix(gpu-publication): publication marker so retry/resume never mistake
        an older generation for the current fence (stage 135 / audit 134 B6)
        2026-10-24 07:34:29 +0000, 4 files, +758/−39

git status --porcelain (до и после — идентично, 10 записей):
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

sha256 посторонних файлов (baseline → финал, совпадают; `00-foreign-hashes.txt`,
`17-foreign-hashes-final.txt`):

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
| `deploy/docker-compose.yml`, `deploy/README.md`, `deploy/overlay-backend-standalone.yml`, `deploy/.env` | `c955be06…`, `8f3b49db…`, `9f13d888…`, `8d21af9a…` |

Commit содержит ровно 4 файла и не пересекается с посторонними:

```
 backend/src/helpers/queue-idempotency.cjs          |  77 ++++
 backend/src/services/result-publication.cjs       | 226 ++++++++--
 backend/tests/architecture/redis-registry.js      |  14 +
 backend/tests/gpu-publication-consistency.test.js | 480 ++++++++++++++++++++++
```

Аудируемые production-файлы байт-в-байт равны HEAD
(`git diff --stat HEAD -- <file>` пуст, `git show HEAD:<file> | sha256sum` совпадает):
`result-publication.cjs` `f7053dae…`, `queue-idempotency.cjs` `b2f76910…`,
`task-handler.cjs` `66653803…`, `generation-routes.cjs` `7345f9ad…`,
`audio-recovery.cjs` `318d7d4c…`.

Branches не переключались, `reset/clean/stash/checkout` не выполнялись.

### 1.1 Изоляция

- Redis: собственный throwaway `docker run --rm -p127.0.0.1:6401:6379 redis:7
  --save '' --appendonly no` (`a136-redis`), без volume с данными, без
  persistence, доступен только с loopback. После прогонов удалён.
  Production-контейнеры (`animastor-backend`, `animastor-redis`, `animastor-pg`,
  `gpu-hub`, `animastor-proxy`, `repro-redis`, buildkit) не затрагивались.
- FS: `fs.mkdtempSync(os.tmpdir()/a136*)`, удаляется после каждого сценария.
- FPGA/GPU/PG/очереди не использовались. Реальный `FENCE_COMMIT_SCRIPT`
  исполнялся через настоящий `EVAL` в изолированном Redis.
- Оставшиеся от Stage 135 контейнеры `a135-redis` (6399) и `a135-redis-6398`
  (6398) не останавливались и не изменялись; harness автора был перезапущен
  как есть на 6399 (проверено: anonymous volume, `--save '' --appendonly no`,
  loopback-only) — см. §8, примечание о перезаписанном `audit-135/01-results.json`.

---

## 2. Метод

Доказательством считались только собственные сценарии Stage 136 на реальном
Redis/Lua/FS (`audit-136/01-*.cjs`, `02-*.cjs`, `03-race-child.cjs`),
сформулированные из ТЗ, а не скопированные из предыдущих harness'ов. Отчёты
Stage 134/135 и их harness'ы использовались только как объект проверки; их
повторные прогоны приведены отдельно (§8) и доказательством не считаются.

Каждый сценарий снимает полный срез:

```
canonical bytes · staged файлы (F1/F2) · marker {fence,stage} · manifest.published_fence
· done(F1)/done(F2) · число записей ready-метаданных (saveChunk) · ответ handler/recovery
```

Для гонок использован контролируемый interleaving двух реальных процессов:
дочерний процесс выполняет production-публикацию, а его `fs.renameSync`
паркуется **только** на staged→canonical (monkey-patch внутри throwaway
процесса, production-файлы не меняются). Родитель в это время выполняет
supersede и публикацию нового fence. Это точная модель окна «intent проверен —
rename ещё не выполнен», а не синтетический вызов внутренней функции.

---

## 3. Матрица B1–B6 (независимые сценарии)

Источник: `audit-136/01-b1-b6-real-redis.cjs` → `01-results.json`
(**21/24 PASS**; 3 FAIL — находки B3e/f/g, §9). Реальный Redis + настоящий Lua +
временная FS.

| ID | Сценарий | Фактический результат на `6a6f1891` | Вердикт |
|---|---|---|---|
| **B1** | callback без receipt, mutable `job→fence` ref указывает на **текущий** F1 | `receipt_missing`; canonical/staging/manifest/done/marker отсутствуют, `saveChunk=0`; затем настоящий F1 публикуется штатно (`committed`, canonical=`REAL-F1`, manifest/done/marker=F1) | ✅ |
| **B2** | receipt F1 существует, intent = F2 (superseded) | `stale_intent`; ничего не записано, marker отсутствует, `saveChunk=0` | ✅ |
| **B3** | debug recovery: нет dispatch id | `{recovered:false, reason:'missing_dispatch_id', gated:true}`; результат остаётся в Redis, файлов/метаданных нет | ✅ |
| **B3** | debug recovery: receipt F1, intent F2 | `stale_intent` (через handler), ничего не записано | ✅ |
| **B3** | debug recovery: реальный `WRONGTYPE` на receipt | `fence_lookup_unavailable`, ничего не записано | ✅ |
| **B3** | debug recovery здорового fence при пустом canonical | `recovered:true/success`, canonical=`RECOVERED-CURRENT`, manifest/done/marker=F1, `saveChunk=1` | ✅ |
| **B3e/f/g** | debug recovery, когда ready-флаг/файл относится к **предыдущей** генерации | `already_ready` / `already_on_disk` / `already_ready_pg` → `recovered:true`, результат текущего fence **выброшен**, canonical остаётся F1 (или отсутствует), F2 не коммитится, результат-key удалён | ❌ **P2** (§9.3) |
| **B4** | F1 commit → crash до rename → supersede F2 → commit F2 → retry F1 → resume | retry F1 = `stale_intent`, его staged удалён; resume публикует **F2** (`resumed=1`), canonical=`F2-BYTES`, manifest/done/marker=F2; повторный resume `resumed=0`; F1 не восстановлен | ✅ |
| **B5** | реальный `WRONGTYPE` receipt в handler | `fence_lookup_unavailable`; нулевые записи | ✅ |
| **B5** | инъекция Redis GET error на receipt | `fence_lookup_unavailable`; нулевые записи | ✅ |
| **B5c** | Redis GET error на **publication marker** до rename | `publish_failed`; canonical не тронут, staged сохранён | ✅ |
| **B5d** | Redis полностью недоступен (закрытый порт) | `fenceCommitResult → unavailable`; handler бросает; нулевые записи, legacy-публикации нет | ✅ |
| **B6/R1** | F1 в canonical, F2 committed, rename падает EACCES, затем retry F2 | `publish_failed`, canonical=F1, staged F2 цел, marker `renaming F2`; retry → `duplicate_same_fence`, canonical=**F2**, staged убран, manifest/done=F2, marker `published`, ready-метаданные только после публикации | ✅ |
| **B6/R1b** | rename падает **внутри handler** | handler бросает `publish_failed`, `saveChunk=0`, canonical не создан, staged цел; повторный handler публикует и только тогда пишет ready | ✅ |
| **B6/R2a** | crash после commit, до marker | marker = предыдущий fence (или absent), staged F2 цел; resume → F2 опубликован, повторный resume идемпотентен | ✅ |
| **B6/R2b** | crash после `renaming`, до rename | resume завершает rename → canonical F2, marker published | ✅ |
| **B6/R2c** | crash после rename, до `published` | resume `rename_verified`, canonical F2 не потерян, marker починен | ✅ |
| **B6/R2d** | committed, staged и canonical отсутствуют | `orphans=1`, не success, ничего не пересоздано | ✅ |
| **B6/R3** | late F1 через handler после supersede | `stale_intent`; canonical F1 не тронут; затем F2 публикуется штатно | ✅ |
| **B6/R4** | redelivery опубликованного fence | `already_published`, canonical не флапает, stray staged удалён | ✅ |
| **B6/R5a** | marker SET failure до rename | `publish_failed`, canonical не тронут, staged цел; resume публикует | ✅ |
| **B6/R6** | отклонённый (без receipt) callback | ни canonical, ни staging, ни marker, ни done, ни ready | ✅ |

**Вывод по B1–B6:** исходный B6 Stage 134 закрыт корректно; B1–B5 не
регрессировали. Новые блокеры лежат **вне** сценариев, которые проверял Stage
135: межгенерационная гонка (§6) и отсутствие content-level доказательства (§5).

---

## 4. Аудит publication marker (8 обязательных сценариев)

Источник: `audit-136/02-marker-safety.cjs` → `02-results.json`
(**13/17 PASS**, FAIL: M8, M9, RACE1, RACE2). Для каждого сценария снят полный
срез (canonical/staged/marker/manifest/done/ready).

| # | Сценарий | Результат |
|---|---|---|
| 1 | **Eviction**: F2 committed+published, marker удалён, `done` жив | resume: `errors=1`, `resumed=0`, `publication_unproven`, canonical/manifest/done не тронуты; redelivery F2 пере-стейджит байты и публикует, marker восстановлен. **Ложного success нет**, но автоматическое восстановление невозможно → эксплуатационное ограничение (M1). Вариант со staged: resume публикует (M1b). Вариант «нет ни staged, ни canonical»: `orphans=1`, не success (M1c) |
| 2 | **TTL expiry**: marker истёк, manifest/done/canonical живы | принудительный `PEXPIRE 1`: marker `absent`, resume `errors=1`, `resumed=0`, canonical F1 цел — ложного success нет (M2). Штатный TTL маркера = TTL `done` (604800 s) и маркер пишется позже, поэтому при штатном течении маркер не истекает раньше `done` (M2b) |
| 3 | **Marker GET error** в recovery | `errors=1`, ничего не записано/удалено; следующий здоровый resume публикует F2 (M3) |
| 4 | **Marker SET error до rename** | `publish_failed`; canonical = предыдущая генерация, staged текущего fence сохранён, marker остался F1 (M4) |
| 5 | **Crash после rename до `published`** | resume `rename_verified`, canonical = F2 байты, staged отсутствует, marker починен, ничего не удалено (M5) |
| 6 | **Crash до записи `renaming`** | commit уже durable, marker предыдущего fence, staged F2 цел → resume публикует F2 (M6a). Без commit staging инертен, resume его не публикует (M6b) |
| 7 | **Marker другого fence** | staged отсутствует + canonical есть → `publication_unproven`, не success (M7); staged текущего fence есть → canonical корректно заменяется и marker становится F2 (M7b) |
| 8 | **Canonical заменён/удалён вручную** | заменён → **ложный success**: `already_published`, canonical=`TAMPERED-OTHER-BYTES`, staged-копия правильных байтов удалена, `saveChunk=1` (**M8, P1**). Удалён → `staged_missing` (не success); redelivery пере-стейджит и публикует (M8b) |

### 4.1 Каким доказательством код подтверждает соответствие canonical fence'у

**Никаким content-level доказательством.** В `publishCommittedFence` используются
только:

1. `marker.published == fence` **и** `fs.existsSync(canonical)` → `already_published`;
2. `marker.renaming == fence` **и** отсутствие staged-файла **и**
   `fs.existsSync(canonical)` → `rename_verified`.

Ни размера, ни хэша, ни mtime, ни сверки с `manifest.bytes` нет. Следствия:

- **M8** — при замене canonical вне протокола система сообщает success и удаляет
  staged-копию, которая была единственным правильным экземпляром байтов.
- **M9** — ветка `ENOENT` (`result-publication.cjs:358`) трактует *любой* ENOENT
  rename'а при существующем canonical как «конкурент переставил тот же файл» и
  возвращает `rename_verified`, **не проверяя, чей это canonical**. Воспроизведено:
  stale F1, чей staging удалён конкурентным `discardStagedFence`, получает
  `published:true / rename_verified`; marker переписывается на F1, хотя canonical
  содержит F2; последующий resume F2 → `publication_unproven` (`errors=1`).
  Канонические байты при этом не портятся (в отличие от RACE), но marker и
  ready-семантика — ложные.
- Кроме того, «отсутствие staged + marker renaming ⇒ rename завершён» верно
  только пока staged-файл не может исчезнуть иначе. В протоколе это
  гарантируется (GC проверяет `done`, `discardStagedFence` вызывается только для
  reject'ов), но M9 показывает, что конкурентный reject **того же** fence ломает
  эту посылку.

---

## 5. Crash-consistency state machine

### 5.1 Реальный порядок операций (по коду `6a6f1891`)

`commitFencedResult` (`result-publication.cjs:431`):

1. `stageResult`: `mkdir` fence-dir → write `artifact.tmp` → `fsync(file)` →
   `rename(tmp → artifact.ext)` **внутри** fence-dir → best-effort `fsync(dir)`;
2. `buildCommitManifest` (пути relative к build-dir);
3. `qidem.fenceCommitResult` → **один** Lua `EVAL` (`FENCE_COMMIT_SCRIPT`):
   intent (`GET`+`cjson`) → `stale_intent`/`intent_missing`/`intent_corrupt` →
   `EXISTS done` → `duplicate_same_fence` → `EXPIRE ref` (если совпал) →
   `SET manifest` (**без TTL**) → `SET done EX 7d` → `DEL claim` → `SET journal EX 7d`;
4. только для `committed | duplicate_same_fence` — `publishCommittedFence`:
   `readFencePublication` (строгий GET) → решение по marker/staged/canonical →
   при необходимости `SET marker renaming EX 7d` (**обязателен**, иначе
   `publish_failed` без rename) → `rename(staged → canonical)` + `fsync(dir)` →
   `SET marker published EX 7d` (best-effort).

`resumePendingPublications` (`result-publication.cjs:507`): SCAN manifest-ключей →
`isTaskDone(fence)` → `GET intent` (битый/нечитаемый → `errors`, никаких
изменений) → сверка `intent.fence` (superseded → skip) → **тот же**
`publishCommittedFence`. То есть retry и restart-recovery действительно
используют один state machine.

### 5.2 Crash-window таблица

| Окно / операция | Durable state в Redis | Фактическое состояние FS | Допустимый retry | Ожидаемое recovery | Проверено |
|---|---|---|---|---|---|
| crash до завершения stage | intent есть, manifest/done нет | только `artifact.tmp` (или ничего) | повторный stage | staging инертен, не публикуется; GC по возрасту | M6b |
| crash после stage, до Lua | intent есть, manifest/done нет | полный staged | повторный результат | resume не видит manifest → ничего | M6b |
| crash **внутри** Lua | — | staged | — | скрипт атомарен: либо всё, либо ничего | code + R2a |
| crash после Lua, до marker | manifest+done=F, claim удалён | staged=F, canonical=F−1 | `duplicate` → publish | marker чужой/absent + staged → rename (W1) | R2a/M6a |
| crash после `SET renaming`, до rename | marker renaming=F, manifest/done=F | staged=F, canonical=F−1 | publish | завершить rename (W2) | R2b |
| crash после rename, до `published` | marker renaming=F, manifest/done=F | staged нет, canonical=F | `rename_verified` | починить marker, файл не трогать (W3) | R2c/M5 |
| crash после `published` | marker published=F, manifest/done=F | canonical=F | `already_published` | идемпотентно | R4 |
| marker SET fail до rename | marker прежний, manifest/done=F | staged=F, canonical=F−1 | `publish_failed` → retry | rename не выполнялся, ничего не потеряно | R5a/M4 |
| rename fail (EACCES/ENOSPC) | marker renaming=F | staged=F, canonical=F−1 | `publish_failed` → retry публикует | resume публикует | R1/R1b |
| marker GET error | — | без изменений | retryable | `errors`, ничего не трогается | R5b/M3 |
| marker evicted после publish | marker нет, manifest/done=F | canonical=F, staged нет | — | `publication_unproven` (не success); нужен redelivery | M1 |
| marker TTL истёк | как выше | как выше | — | `publication_unproven` (не success) | M2 |
| **supersede во время публикации** | manifest/done=F2, marker может стать F1 | **canonical=F1** | — | **не восстанавливается** (`publication_unproven`); stale handler пишет ready | **RACE1/2 — FAIL** |
| canonical заменён вне протокола | marker published=F | canonical=чужие байты | redelivery → success без проверки | **ложный success** | **M8 — FAIL** |

**Расхождение с формулировкой Stage 135:** строка W1 в §3.3 отчёта 135 говорит
«marker absent». Если предыдущая генерация уже публиковалась (обычный случай
regeneration), marker в этот момент — `published F1`, а не absent. Код обрабатывает
оба состояния одинаково (важно лишь `marker.fence != fence`), поведение
корректно; неточность только в тексте отчёта.

### 5.3 Что именно доказывает каждый durable-факт

| Факт | Что доказывает | Чего НЕ доказывает |
|---|---|---|
| `done:F` | Lua-коммит F состоялся и F был current/active в этот момент | что staged→canonical rename произошёл |
| `manifest` | что и куда коммитилось (fence, relative paths, bytes) | что canonical содержит эти байты |
| `marker.published=F` | последняя **попытка** публикации F была помечена завершённой | что canonical сейчас содержит байты F (M8) |
| `marker.renaming=F` + staged отсутствует | при корректном протоколе — rename уже произошёл | что staged не удалил кто-то ещё (M9) |
| `intent.fence` | какой fence current **на момент чтения** | что он останется current до rename (RACE) |

---

## 6. Гонка stale F1 vs публикация F2 (P1-A)

### 6.1 Механизм

Между проверкой intent (внутри Lua-коммита или в `resumePendingPublications`) и
файловым `rename` нет никакой сериализации:

- `publishCommittedFence` **не перечитывает intent** перед rename;
- `markFencePublication` — обычный `SET … EX`, **не** `NX`/`XX`/WATCH/CAS;
- marker не содержит epoch и не сравнивается «новее ли он»;
- нет per-task lock, нет fencing token у файловой операции;
- `resume` проверяет intent **до** `publishCommittedFence`, а не внутри него.

Поэтому валидный на момент коммита F1, приостановленный (GC/swap/сетевой
round-trip между GET marker и SET marker — минимум 1–2 RTT) в окне
«intent проверен → rename не выполнен», после supersede на F2 и успешной
публикации F2 всё равно выполнит свой rename и перезапишет canonical.

### 6.2 Воспроизведение RACE1 (in-process publish)

Два реальных процесса, реальный Redis+Lua+FS. F1 handler паркуется на
staged→canonical rename на 4 s; родитель делает `markFenceDirty`-эквивалент
(supersede intent → F2) и вызывает production handler для F2.

```
F1 handler: identity → stage → Lua commit = committed → marker renaming=F1 → [PARK]
main:       intent=F2 → F2 handler → stage → commit=committed → marker renaming=F2
            → rename F2→canonical → marker published=F2 → ready(F2) → HTTP {ok:true}
F1:         rename F1→canonical (!) → marker published=F1 → ready(F1) → HTTP {ok:true}

итог: canonical = "F1-BYTES"
      manifest.published_fence = F2
      done(F2) = true, marker = published F1
      stale F1 handler: fenced=true, commit="committed", saveChunk=1
      resume(F2) = {resumed:0, errors:1}  ← publication_unproven
```

`02-results.json` (RACE1):

```json
{ "midCanonical": "F2-BYTES",
  "childResult": { "mode": "handler", "saveChunk": 1,
                   "outcome": { "fenced": true, "commit": "committed" } },
  "final": { "canonical": "F1-BYTES",
             "manifestFence": "<F2>",
             "marker": { "fence": "<F1>", "stage": "published" },
             "doneF2": true },
  "resume": { "scanned": 1, "resumed": 0, "errors": 1 } }
```

### 6.3 Воспроизведение RACE2 (restart recovery)

`resumePendingPublications` паркуется на rename уже после проверки
`intent.fence == F1`; родитель публикует F2; затем resume выполняет rename F1.

```
child resume: manifest F1 + done F1 + intent F1 → marker renaming=F1 → [PARK]
main:         intent=F2 → F2 publish → canonical F2, marker published F2
child:        rename F1→canonical → marker published F1
              возвращает { scanned:1, resumed:1, errors:0 }   ← сам рапортует успех

итог: canonical = F1, manifest = F2, marker = F1, done(F2) = true
```

Здесь особенно опасно то, что recovery **рапортует `resumed=1`** для уже
superseded fence, то есть подтверждает восстановление устаревшей генерации.

### 6.4 Последствия

- После regeneration пользователь видит байты предыдущей генерации, при этом
  `manifest`/`done` = новая генерация, а ready-метаданные записаны stale-handler'ом
  (в реальном коде — `saveChunk` + `audioOrch.completeChunk`, вплоть до merge /
  `completeStage`).
- Автоматическое восстановление невозможно: у F2 нет staged (его уже
  переставили), marker указывает на F1 → `publication_unproven`.
- Восстановление возможно только новой доставкой F2 (redelivery пере-стейджит и
  перезапишет canonical) или F3; это не гарантируется протоколом.
- Это ровно тот критерий, который Stage 136 требует проверить: «Ни один stale
  worker не должен перезаписать canonical после того, как актуальность fence была
  подтверждена раньше, но intent успел измениться до rename» — **нарушен**.

---

## 7. Ready-метаданные и canonical

- В штатном пути ready пишется только после `commitFencedResult`, вернувшего
  `committed/duplicate_same_fence` и успешный `publishCommittedFence`
  (`task-handler.cjs:239–277`). R1b подтверждает: при падении rename внутри
  handler `saveChunk=0`, повтора метаданных нет.
- Однако **отсутствует повторная проверка intent после публикации**: RACE1
  показывает, что stale handler доходит до ready (`saveChunk=1`) уже после
  supersede и публикации F2.
- M8 показывает, что ready может быть записан поверх canonical, который не
  содержит байты этого fence.
- Recovery-short-circuit (B3e/f/g, §9.3) возвращает `recovered:true` вообще без
  публикации и без ready — то есть «success» без каких-либо изменений.

---

## 8. Тесты (свежий прогон на `6a6f1891`)

| # | cwd | Команда | Exit | Результат | Лог |
|---|---|---|---|---|---|
| 1 | `backend/` | `npx mocha --exit tests/gpu-publication-consistency.test.js` | 0 | **16 passing** | `10-gpu-publication-consistency.log` |
| 2 | `backend/` | `npx mocha --exit tests/gpu-fenced-publication-gates.test.js tests/gpu-result-fencing-commit.test.js` | 0 | **48 passing** (18+30) | `11-gates-and-fencing.log` |
| 3 | `backend/` | `npx mocha --exit tests/gpu-queue-idempotency.test.js tests/gpu-intent-fence-regressions.test.js tests/gpu-intent-fence-receipt.test.js tests/gpu-lane-release-order.test.js tests/dispatch-meta-lease-lifecycle.test.js tests/markready-build-id-idempotency.test.js tests/book-registry-recovery-gate.test.js tests/startup-recovery-registry-gate.test.js` | 0 | **168 passing** | `12-targeted-idempotency-dispatch-recovery.log` |
| 4 | `backend/` | `npx mocha --exit tests/private-worker-phase2.test.js` | 0 | **40 passing / 1 pending** | `13-private-worker-phase2.log` |
| 5 | `backend/` | `npx mocha --exit 'tests/architecture/*.test.js'` | 0 | **935 passing / 24 pending** | `14-architecture.log` |
| 6 | `backend/` | `npx mocha --recursive tests/ --exit` | 0 | **3489 passing / 28 pending / 0 failing** | `16-full-backend-suite.log` |
| 7 | repo | `./scripts/syntax-smoke.sh backend` | 0 | `All production JS/CJS files pass syntax check` | `15-syntax-smoke.log` |
| 8 | `audit-136/` | `node 01-b1-b6-real-redis.cjs` | 1 | **21/24**, 3 FAIL = B3e/f/g | `01-run.log`, `01-results.json` |
| 9 | `audit-136/` | `node 02-marker-safety.cjs` | 1 | **13/17**, 4 FAIL = M8/M9/RACE1/RACE2 | `02-run.log`, `02-results.json` |
| 10 | `audit-136/` | `node 05-rerun-audit134-independent.cjs` | 0 | **15/15**, probes=2 | `05-rerun-audit134-independent.log` |
| 11 | `audit-136/` | `node 06-rerun-audit134-minimal-repro.cjs` | 0 | `blocked=false`, invariants=true | `06-rerun-audit134-minimal-repro.log` |
| 12 | `audit-136/` | `node ../audit-135/01-b6-real-redis.cjs` | 0 | **12/12** | `07-rerun-audit135-harness.log` |

Baseline Stage 134: 3473 → **3489** (+16 новый сьют Stage 135), failures нет.
Зелёный suite **не скрывает** P1: ни один существующий тест не запускает
конкурентную публикацию двух fence и не заменяет canonical после публикации.

Примечание: harness Stage 135 пишет результаты в свой `__dirname`, поэтому
повторный прогон обновил `audit-135/01-results.json` (копия нового файла —
`07-audit135-results-rerun.json`). Исходные `.cjs`, отчёты и остальные артефакты
Stage 135 не изменялись; это единственное отклонение от «не трогать чужие
артефакты», зафиксировано здесь.

---

## 9. Находки

### 9.1 P1-A — stale in-flight publication перезаписывает новый fence

- **Где:** `result-publication.cjs:294–377` (`publishCommittedFence`), вызовы из
  `commitFencedResult:472` и `resumePendingPublications:568`;
  `queue-idempotency.cjs:1623` (`markFencePublication`, безусловный SET).
- **Условие:** F1 был current и получил `committed`; публикация F1 приостановлена
  после проверки intent (в handler — между `fenceCommitResult` и rename; в
  resume — между `GET intent` и rename). За это время intent → F2, F2
  опубликован. F1 продолжает rename.
- **Факт:** canonical = F1, manifest/done = F2, marker = published F1; handler F1
  возвращает success и пишет ready; resume F2 = `publication_unproven`; recovery
  RACE2 рапортует `resumed=1`.
- **Почему это блокер Stage 136:** прямо нарушает «ни один stale worker не должен
  перезаписать canonical…» и «canonical/manifest/ready согласованы»; актуальные
  байты F2 теряются из canonical без автоматического восстановления.
- **Воспроизведение:** `node 02-marker-safety.cjs` → RACE1/RACE2
  (`02-results.json`, `03-race-child.cjs`).

### 9.2 P1-B — `already_published` не доказывает содержимое canonical

- **Где:** `result-publication.cjs:317–323`.
- **Условие:** marker `published == fence`, canonical существует, но содержит не
  байты этого fence (ручная замена, другой writer, а также теоретически
  interleaving, при котором `published` нового fence финализируется после rename
  старого).
- **Факт:** `already_published`, staged-копия правильных байтов удаляется,
  handler возвращает success, ready пишется; canonical остаётся чужим (M8:
  `canonical = "TAMPERED-OTHER-BYTES"`, `saveChunk=1`).
- **Почему блокер:** «если система сообщает успех при несогласованных данных —
  это блокер» (ТЗ §3). Доказательства соответствия canonical fence'у нет.
- **Ограничение:** для M8 требуется изменение canonical вне протокола (или
  экзотический interleaving финализаций). Но протокол сам объявляет canonical
  «опубликованным» исключительно по маркеру, поэтому любое такое изменение
  превращается в постоянный ложный success.

### 9.3 P2-A — debug-recovery выбрасывает результат текущей генерации по устаревшему ready-флагу

- **Где:** `audio-recovery.cjs:152–177` — short-circuit **до** проверки
  публикации текущего fence.
- **Факт (реальный Redis/FS):**
  - chunk-1 `audio_status=ready` от F1 → `{recovered:true, reason:'already_ready'}`,
    canonical остаётся F1, F2 не коммитится, result-key удалён (`doneF2=false`,
    `saveChunk=0`);
  - scene-level canonical (`{prefix}.mp3`) существует → `already_on_disk`, то же;
  - `isSceneAudioReady()===true` (PG от предыдущей генерации) → `already_ready_pg`.
- **Почему P2, а не P1:** canonical/manifest/done остаются согласованными между
  собой (F1), но **текущий intent F2 игнорируется**, а клиент получает
  `recovered:true`; единственная копия результата F2 (mailbox) удаляется.
- **Примечание:** для chunk-job `already_on_disk` фактически смотрит на другой
  путь (`{prefix}.mp3` vs `{prefix}_0001.mp3`), т.е. для основного audio-пайплайна
  живым является short-circuit по chunk-1/PG. Это pre-existing поведение, не
  введённое Stage 135.
- **Воспроизведение:** `01-b1-b6-real-redis.cjs` → B3e/B3f/B3g.

### 9.4 P2-B — `ENOENT → rename_verified` принимает чужой canonical

- **Где:** `result-publication.cjs:356–363`.
- **Условие:** staged-файл исчезает между `_stagedFilesIn` и rename (конкурентный
  `discardStagedFence` того же fence после supersede), canonical существует и
  принадлежит новому fence.
- **Факт (M9):** `published:true, reason:'rename_verified'`, marker переписан на
  stale F1, canonical остаётся F2; последующий resume F2 → `publication_unproven`.
  Канонические байты не портятся, но marker/ready лгут, а recovery F2 блокируется.
- **Воспроизведение:** `02-marker-safety.cjs` → M9.

### 9.5 Наблюдения (не блокеры)

- При eviction/TTL маркера система **безопасно отказывает**
  (`publication_unproven`), но теряет автоматическое восстановление до redelivery
  — это подтверждает §7 Stage 135 и является эксплуатационным ограничением.
- `marker published==fence + canonical отсутствует` → `staged_missing` (не
  success), redelivery пере-стейджит и восстанавливает (M8b).
- Staged F1 после supersede остаётся на диске до age-GC (24 h), если не было
  retry F1; это ожидаемо.
- `resume` считает `already_published && cleaned` как `cleaned`, а не `resumed`;
  семантика счётчиков не влияет на корректность.

---

## 10. Оставшиеся риски (проверялись только обзорно; НЕ исправлялись)

| Риск | Проверка в этом аудите | Статус |
|---|---|---|
| PostgreSQL fenced projection/replay, миграция `generation_fence` | `grep generation_fence` по `backend/src`/`migrations` — пусто; схема не менялась | **открыт**, как в 132–135 |
| Manifest retention: нет TTL (`SET KEYS[4] ARGV[2]` без EX), `RESUME_MANIFEST_LIMIT=200`, GC только `.staging` | код прочитан; лимит подтверждён (`result-publication.cjs:77`) | **открыт** |
| Redis epoch-gap на send-side | dispatch-side не ревьюировался (вне scope) | **не объявляется устранённым** |
| Redis Cluster CROSSSLOT / reply-length fallback | `fenceCommitResult` → `unavailable`, клиентского fallback нет (fail closed) | **открыт** (fail-closed) |
| Устаревшая копия `@animastor/orchestration` в `backend/node_modules` | sha256 `28bb8246…` ≠ workspace `478d3fa7…`; в установленной копии отсутствует Stage 129 F5 (`isFenceRejectedOutcome` → DEFERRED_IDEMPOTENT_TTL_S). `verifyDispatchIdentity` идентичен, поэтому выводы B1–B6 не зависят от расхождения | **открыт** (деплой-долг) |
| `GPU_FENCING_MODE=off` — прямая запись canonical | код: единственная ветка `fs.writeFileSync(asset.fullPath)` достижима только при `off` (`task-handler.cjs:157–169`); не включалась | **сохранён осознанно** |
| `observe` vs `enforce` | `runtime-config.js:272–275`: оба значения ведут в один и тот же fenced-путь; `enforce` нигде не включён | **идентичны по построению** |
| Eviction/TTL publication marker | проверено (M1/M2): ложного success нет, авто-восстановление теряется | **эксплуатационное ограничение** |
| Stale ready flags в debug recovery | B3e/f/g: результат текущей генерации выбрасывается с `recovered:true` | **P2, открыт** |
| Отсутствие content-level проверки canonical | M8 | **P1, открыт** |
| Отсутствие сериализации intent→rename | RACE1/RACE2 | **P1, открыт** |

---

## 11. Критерии вердикта

| Критерий Stage 136 | Статус |
|---|---|
| B1–B6 независимо подтверждены | ✅ (B1–B6 в исходной формулировке), но **новые B3e/f/g — FAIL** |
| R1/R2 проходят | ✅ (R1, R2a–d на реальном Redis/Lua/FS; audit-134 repro `blocked=false`) |
| Потеря/истечение marker не даёт ложного success | ✅ (M1, M2) |
| Crash recovery сохраняет/восстанавливает актуальные committed bytes | ✅ в окнах W1–W3; ❌ при конкурентном supersede (RACE2) |
| Ready metadata согласована с фактически опубликованным canonical | ❌ RACE1 (stale ready после supersede), M8 (ready поверх чужого canonical) |
| Конкурентные retry/recovery не позволяют F1 перезаписать F2 | ❌ **RACE1/RACE2** |
| Новые независимые сценарии проходят на реальном Redis/Lua/FS | ❌ 4 FAIL в `02`, 3 FAIL в `01` |
| Полный backend suite без новых failures | ✅ 3489/28/0, exit 0 |
| Посторонние dirty/untracked не изменены | ✅ sha256 + status идентичны baseline |

**Итог: BLOCKED.** P1-A (гонка intent→rename) и P1-B (success без доказательства
содержимого canonical) нарушают acceptance-критерии Stage 136. Код в рамках
аудита не изменялся; минимальные воспроизведения сохранены.

---

## 12. Артефакты и воспроизведение

```
/home/animastor/reorg-2026-10-23/audit-136/
  00-baseline.txt                     HEAD/status baseline
  00-foreign-hashes.txt               sha256 посторонних файлов (baseline)
  17-foreign-hashes-final.txt         sha256 после аудита (идентичны)
  01-b1-b6-real-redis.cjs             независимый harness B1–B6 (24 сценария)
  01-run.log  01-results.json
  02-marker-safety.cjs                marker-сценарии 1–8 + M9 + RACE1/RACE2
  02-run.log  02-results.json
  03-race-child.cjs                   parked-rename процесс для RACE1/RACE2
  05-rerun-audit134-independent.cjs   копия harness 134 (порт 6398→6401)
  06-rerun-audit134-minimal-repro.cjs копия Repro 134 (порт 6398→6401)
  07-rerun-audit135-harness.log       прогон harness 135 как есть (12/12)
  07-audit135-results-rerun.json
  10-gpu-publication-consistency.log
  11-gates-and-fencing.log
  12-targeted-idempotency-dispatch-recovery.log
  13-private-worker-phase2.log
  14-architecture.log
  15-syntax-smoke.log
  16-full-backend-suite.log
  17-commands.md
```

Воспроизведение:

```bash
docker run --rm -d --name a136-redis -p 127.0.0.1:6401:6379 \
  redis:7 --save '' --appendonly no

cd /home/animastor/reorg-2026-10-23/audit-136
node 01-b1-b6-real-redis.cjs          # 21/24 (B3e/f/g — находки)
node 02-marker-safety.cjs             # 13/17 (M8/M9/RACE1/RACE2 — находки)
node 03-race-child.cjs                # только через 02

cd /home/animastor/animastor-backend/backend
npx mocha --recursive tests/ --exit   # 3489 passing / 28 pending / 0 failing

docker rm -f a136-redis
```

Минимальные доказательства блокеров:

- `02-results.json` → `RACE1-…`, `RACE2-…`: `canonical=F1`, `manifestFence=F2`,
  `marker=published F1`, `saveChunk=1`, `resume={resumed:0|1, errors:1|0}`.
- `02-results.json` → `M8-…`: `canonical="TAMPERED-OTHER-BYTES"`, handler
  `{fenced:true, commit:"duplicate_same_fence"}`, `saveChunk=1`.
- `02-results.json` → `M9-…`: `{published:true, reason:"rename_verified"}` для
  stale F1, canonical F2, последующий `resume.errors=1`.
- `01-results.json` → `B3e/B3f/B3g`: `{recovered:true, reason:"already_*"}` без
  публикации текущего fence, `saveChunk=0`, result-key удалён.
