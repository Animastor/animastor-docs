# Stage 137 — Fix Publication Race, Content Integrity and Recovery Short-Circuits

**Вердикт: PASS.**

Все P1/P2-блокеры независимого аудита Stage 136 (commit
`6a6f18910cc73085533d3bf1b5c51996f90541bd`) устранены и подтверждены
независимыми сценариями на реальном Redis/Lua/FS:

| Блокер Stage 136 | Статус Stage 137 |
|---|---|
| **P1-A** — stale in-flight публикация перезаписывает новый fence (RACE1/RACE2) | ✅ закрыт: cross-process сериализация + content-проверка + post-rename authority check |
| **P1-B** — `already_published` без доказательства содержимого (M8) | ✅ закрыт: sha256+bytes в manifest/marker, проверка canonical против committed artifact |
| **M9** — `ENOENT → rename_verified` принимает чужой canonical | ✅ закрыт: `rename_verified` только при совпадении hash/size |
| **B3e/f/g** — debug recovery выбрасывает результат текущей генерации | ✅ закрыт: short-circuit только после proof опубликованного актуального fence |

- **Изменённые файлы** (6): `backend/src/services/publication-lock.cjs` (новый),
  `backend/src/services/result-publication.cjs`,
  `backend/src/services/task-handler.cjs`,
  `backend/src/services/audio-recovery.cjs`,
  `backend/src/helpers/queue-idempotency.cjs`,
  `backend/tests/gpu-result-fencing-commit.test.js` (фикс тестируемого fixture,
  не ослабление).
- **Локальный commit Stage 137:** `5ea37b91` (6 files, +853/−105; push/deploy
  не выполнялись). Staged diff проверен пофайлово; посторонние изменения
  в commit не вошли.
- **Тесты:** полный backend suite **3489 passing / 28 pending / 0 failing,
  exit 0**; real-Redis harness'ы: **01-core 24/24, B1–B6 24/24, marker-safety
  17/17, audit-134 rerun 15/15, minimal repro blocked=false**.
- **Посторонние dirty/untracked-файлы** — байт-в-байт как в baseline (sha256, §1).
- **Полный отчёт:** этот файл. Артефакты и воспроизведение — `audit-137/`.

---

## 1. Исходное состояние и границы

```
HEAD   6a6f18910cc73085533d3bf1b5c51996f90541bd
        fix(gpu-publication): publication marker so retry/resume never mistake
        an older generation for the current fence (stage 135 / audit 134 B6)

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

sha256 посторонних файлов (baseline → финал, совпадают; `audit-137/00-foreign-hashes.txt`
→ `00-foreign-hashes-final.txt`):

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

`deploy/` (docker-compose.yml, .env, overlay, README) не открывался и не
изменялся (mtimes 12–21 октября). Branches не переключались,
`reset/clean/stash/checkout` не выполнялись. Единственные изменения рабочего
дерева — 6 файлов Stage 137 (5 модификаций + 1 новый модуль) и тестовый fixture.

### 1.1 Изоляция

- Redis: собственный throwaway `docker run --rm --name a137-redis
  -p127.0.0.1:6402:6379 redis:7 --save '' --appendonly no` — без volume,
  без persistence, loopback-only, после прогонов удаляется. Production-контейнеры
  (`animastor-backend`, `animastor-redis`, `animastor-pg`, `gpu-hub`,
  `animastor-proxy`) и контейнеры аудитов 135/136 (порты 6398/6399/6401) не
  затрагивались.
- FS: `fs.mkdtempSync(os.tmpdir()/a137*)`, удаляется после каждого сценария.
- `.env`, Compose, production-конфигурация, `GPU_FENCING_MODE` не менялись.
  `enforce` нигде не включался (все сценарии — `observe`, который по построению
  идентичен `enforce` в пути публикации).
- Commit/push/deploy/npm/CI не выполнялись (локальный commit — только в конце).

---

## 2. Метод

Доказательством считались собственные сценарии Stage 137
(`audit-137/01-core.cjs` + `02-race-child.cjs`) на реальном Redis/Lua/FS,
сформулированные из ТЗ Stage 137, плюс повторные прогоны НЕЗАВИСИМЫХ harness'ов
предыдущих аудитов на изменённом коде (`10/11/12/13`), которые не писались
Stage 137 и потому не могут «подгоняться» под фикс.

Каждый сценарий снимает полный срез:
`canonical bytes · staged (F1/F2) · marker {fence,stage,sha256,bytes} ·
manifest.published_fence/sha256/bytes · done(F1/F2) · saveChunk ·
ответ handler/recovery/resume · наличие lock-директории`.

Гонки — **два реальных процесса** с контролируемым interleaving непосредственно
на границе staged→canonical rename: дочерний процесс выполняет production
entry point (`taskHandler.handleTaskResult` или `resumePendingPublications`),
его `fs.renameSync` паркуется (monkey-patch внутри throwaway-процесса,
production-файлы не меняются) ровно на staged→canonical; родитель в это время
делает supersede intent и публикует новый fence.

---

## 3. Что реализовано

### 3.1 P1-A — сериализация публикации одного logical task

**Новый модуль `backend/src/services/publication-lock.cjs`** — per-task
cross-process блокировка каталогом (atomic `mkdir` на POSIX):

```
{OUTPUT_DIR}/.publication-locks/{sha256(book|chapter|scene|job)}.lock/owner.json
```

`owner.json` = `{token, pid, host, created_at}`. Свойства и ответы на
обязательные вопросы ТЗ §2.5:

| Требование | Решение |
|---|---|
| владение | токен (crypto random 16B) + pid + host; release — только compare-token-и-remove |
| срок действия | **wall-clock TTL нет**: живой владелец никогда не теряет lock (пауза/swap/GC не «истекают» — устаревший владелец не может потерять lock и потом сделать rename) |
| восстановление после crash | владелец, чей PID мёртв **на том же хосте**, реклеймится автоматически (`rename` lock-каталога в карантин + проверка токена после rename карантинa, чтобы не украсть чужой свежий lock); owner-less каталог старше 5 с — тоже |
| потеря Redis | lock от Redis не зависит; при потере Redis публикация fail-closed ДО/ПОСЛЕ rename (readIntentStrict → `publish_failed`), staged не трогаются |
| мульти-процессность | mkdir-атомарность + проверка токена; проверено двумя процессами (RACE1×2, RACE2, LK2–LK5, CRASH1) |
| чужой хост | владелец с другим `host` **не реклеймится** — ожидание до `publication_lock_timeout` (fail closed), т.к. liveness PID на чужом хосте недоказуем (LK4) |
| «Redis lock недостаточен» | lock — файловый, а не Redis; владелец дополнительно перепроверяет токен `lock.verify()` **непосредственно перед rename** и **сразу после rename**; при потере lock — `publication_lock_lost`, rename не выполняется / canonical откатывается (LK5) |

**Критическая секция `publishCommittedFence`** (единая для in-process публикации,
restart recovery и redelivery — `commitFencedResult` и
`resumePendingPublications` зовут одну функцию):

1. **внутри lock** строгий `readIntentStrict` — superseded/missing/corrupt
   intent → `stale_intent`/`intent_missing`/`intent_corrupt`, ничего не
   трогается (это и есть «актуальность fence доказана перед публикацией»);
2. строгий manifest-read, `published_fence == fence`, извлечение
   **content proof** (`sha256`, `bytes`) — manifest другой fence → `stale_intent`;
3. marker/staged/canonical решения (см. 3.2);
4. запись durable-маркера `renaming` (с sha256/bytes) **перед** rename;
5. `lock.verify()` **перед** rename;
6. `rename(staged → canonical)` + fsync;
7. проверка содержимого canonical против manifest **после** rename;
8. **повторное чтение intent + `lock.verify()` после rename** — если fence
   был superseded (или lock потерян) в момент, когда владелец держал lock:
   atomic rollback — restore предыдущего canonical (hardlink-бэкап в fence-dir
   `.previous-canonical`, либо возврат своих байтов в staged), restore
   маркера, **`stale_intent`/`publication_lock_lost`, никакого success**;
9. только после этого — маркер `published` (с sha256/bytes) и возврат success.

Так как публикация F2 обязана взять тот же per-task lock, **F1 физически не
может выполнить rename после того, как F2 стал текущим и опубликовался**:
если F2 опубликовался — значит, lock был свободен, значит, F1 уже вышел из
критической секции, значит, при входе/выходе F1 intent был проверен и F2 тогда
ещё не был опубликован. Единственное окно «supersede во время критической
секции F1» закрывается post-rename проверкой + откатом: F2 в этот момент ещё
**не опубликован** (ждёт lock), поэтому инвариант «F1 не переименовывает после
опубликованного F2» соблюдается буквально, а итоговое состояние — F2
(RACE1/RACE2, midState и final).

**Handler-уровень (`task-handler.cjs`):** после `commitFencedResult`
дополнительно (а) требуется подтверждённая публикация
(`publication.published || publication.publication === 'already_published'`),
(б) повторно читается intent перед записью ready-метаданных — supersede между
публикацией и ready не даёт записать stale ready (`stale_intent`, saveChunk=0).

**Retry/recovery после supersede:** `resumePendingPublications` считает
`stale_intent`/`publication_lock_lost` как `superseded`, а не `resumed` —
никаких «resumed=1» для устаревшего fence (RACE2: `resumed:0, superseded:1,
errors:0`).

### 3.2 P1-B — доказательство целостности canonical

- `buildCommitManifest` теперь пишет `version:2`, `sha256` и фактический
  `bytes` staged-артефакта (в in-process пути hash считается из buffer,
  в общем случае — потоковое чтение файла чанками, `artifactProof`).
- Маркер `renaming`/`published` тоже несёт `{sha256, bytes}` — маркер без
  proof не может «доказать» публикацию.
- **`already_published` разрешён только при совпадении canonical
  hash+size с manifest** (плюс marker.published==fence). Mismatch + staged
  отсутствует → `canonical_content_mismatch` (контролируемый отказ, маркер не
  переписывается, ready не пишется, восстановление — новой доставкой, которая
  re-stage'ит committed fence; M8R).
- Mismatch + staged текущего fence есть → **безопасный fenced re-publish**:
  staged НЕ удаляется до подтверждённого восстановления; бэкап текущего
  canonical; marker `renaming`; rename; post-проверка hash; marker `published`.
  Итоговый canonical hash == manifest (M8).
- Staged сам проверяется против manifest **до** rename
  (`staged_content_mismatch` — tamper/partial write, CI1/CI2), staged при
  отказе сохраняется.
- ENOENT-ветка: `rename_verified` допустим только при совпадении содержимого
  canonical с manifest этого fence (M9, CRASH3).

### 3.3 M9

Ветка `ENOENT` больше не трактует «canonical существует» как доказательство
rename: при ENOENT содержимое canonical проверяется против manifest; чужой
canonical → `publish_failed` (M9-сценарий: `err.code='publish_failed'`,
marker остаётся `renaming F1`, canonical F2 не тронут; повторная доставка
F1-байтов публикует корректно). Дополнительно сценарий с manifest другого
fence отвергается ещё раньше — на intent/manifest-гейте (`stale_intent`).

### 3.4 B3e/f/g — debug recovery

`audio-recovery.cjs`: после receipt-резолюции вызывается
`resultPublication.verifyPublishedFence(config, redis, {..., fence})` —
read-only proof под тем же per-task lock: intent==fence (active) ∧
manifest.published_fence==fence ∧ marker.published==fence ∧ canonical
hash+size==manifest. Только тогда разрешены short-circuit'ы
`already_on_disk`/`already_ready`/`already_ready_pg` (и новый
`already_published`) с удалением result-key. Если proof = not_published /
superseded — результат текущего fence идёт через обычный fenced
publication flow (handler). `status:'error'` (Redis/FS) →
`recovered:false, reason:'publication_unproven'`, result-key сохраняется;
ошибка PG в ready-проверке тоже не даёт `recovered:true`.

### 3.5 Идемпотентность и B1–B6

Поведение для действительно опубликованного актуального fence сохранено:
redelivery → `duplicate_same_fence` + `already_published`, canonical не
флапает, stray staged убирается только после content-проверки (IDEM1,
B6/R4). Все guard'ы B1–B6 проверены повторно независимым harness'ом
Stage 136 (§4, 24/24).

### 3.6 Осознанное изменение одного теста (не ослабление)

`backend/tests/gpu-result-fencing-commit.test.js` («a repeat of the same fence
completes a crashed rename»): fixture коммита был `manifest: {x:1}` — манифест
**без** content-proof и без `published_fence`, что при новом протоколе по
определению не может авторизовать rename (это ровно класс M8/M9). Fixture
заменён на настоящий `pub.buildCommitManifest(...)`, а повторная доставка — на
те же committed-байты `'v1'` (раньше тест требовал, чтобы redelivery с
ДРУГИМИ байтами перезаписал canonical — это противоречит инварианту
«canonical == committed manifest» и смыслу content-proof). Тест стал
строже: тот же сценарий crash-window завершается, но только при совпадении
байтов. Ни один guard не убран; количество passing в full suite не изменилось
(3489).

---

## 4. Матрица результатов

### 4.1 Обязательные сценарии Stage 137 (real Redis + real Lua + tmp FS)

`audit-137/01-core.cjs` → `01-results.json`, `01-run.log` — **24/24 PASS, exit 0**.

| ID | Сценарий | Ключевые проверки |
|---|---|---|
| HASH1 | normal callback | canonical=F1, manifest.sha256==sha256(F1), marker.published{sha256}, saveChunk≥1, lock освобождена |
| IDEM1 | повторная доставка published fence | duplicate_same_fence, published=false, publication=already_published, canonical не флапает, staged нет |
| **RACE1-1/2** | F1 handler паркуется на rename **держа lock**; родитель: supersede F2 + публикация F2 | F2 ждал lock (dur≥1200ms), midState canonical=F2, final canonical/manifest/marker=F2, **child error stale_intent, saveChunk=0**, `.race-unparked` есть, resume errors=0. Два раунда с разными парами fence |
| **RACE2** | resume F1 паркуется после intent-проверки; родитель публикует F2 | canonical F2 до выхода child, child `{resumed:0, superseded:1, errors:0}`, final всё F2 |
| LK5 | потеря lock до rename (внешнее удаление lock-каталога) | child `publication_lock_lost`, ничего не переименовано, canonical=null, staged цел, marker восстановлен; повторная доставка F1 публикует штатно |
| CRASH1 | child SIGKILL во время park (держит lock, marker renaming) | F2 публикуется (мёртвый владелец реклеймлен), canonical/manifest/marker=F2, **staged F1 не тронут**, resume errors=0, lock-каталог удалён |
| **M8** | canonical подменён вне протокола + redelivery F2 | НЕ `already_published` до проверки; canonical восстановлен из staged, hash==manifest, marker{sha256}, saveChunk≥1 |
| M8R | tampered canonical + staged отсутствует | `canonical_content_mismatch`, ничего не изменено, marker остаётся published-F2; redelivery восстанавливает |
| CI1/CI2 | staged tamper / partial write | `staged_content_mismatch`, resume errors, staged сохранён, canonical=null; после восстановления байтов — публикация |
| CI3 | canonical нечитаем (EACCES) | контролируемый отказ (resume errors), после chmod/redelivery восстановление |
| CRASH2 | crash после rename до `published` | resume `rename_verified` **по содержимому**, marker починен, hash==manifest |
| CRASH3 | тот же crash-window, но canonical — чужие байты | НЕ rename_verified: `publication_unproven`, marker остаётся renaming, redelivery публикует F2 |
| **M9** | ENOENT + конкурентный discard staged + чужой canonical | ошибка `publish_failed` (не `rename_verified`), canonical/marker не тронуты; повторный stage F1 → публикация |
| LK2 | живой владелец lock | ожидание, `publication_lock_timeout` при waitMs=400, **никакого wall-clock expiry**; после release — захват |
| LK3 | мёртвый владелец | автоматический реклейм, захват |
| LK4 | владелец чужого хоста | **не реклеймится**, fail closed `publication_lock_timeout` |
| INT1 | Redis GET error на intent внутри lock | `publish_failed` ДО rename, canonical/staged не тронуты |
| B3e | chunk-1 ready от предыдущей генерации | recovery публикует **F2** (success), canonical=F2, done F2 |
| B3f | scene-level canonical от предыдущей генерации | то же |
| B3g | PG ready от предыдущей генерации | то же |
| B3P | реально опубликованный актуальный fence | short-circuit сохранён (`already_ready`), canonical не тронут, saveChunk=0 |
| B3E2 | Redis error при proof | `recovered:false, publication_unproven`, result-key сохранён |

### 4.2 Повторные прогоны независимых harness'ов предыдущих аудитов

Прогоны на коде Stage 137, копии harness'ов в `audit-137/` (артефакты
audit-134/135/136 не изменялись):

| # | Harness | Результат | Лог |
|---|---|---|---|
| 10 | `01-b1-b6-real-redis.cjs` (Stage 136, 24 сценария B1–B6) | **24/24 PASS, exit 0** | `10-run.log` |
| 11 | `02-marker-safety.cjs` (Stage 136, M1–M9 + RACE1/RACE2) | **17/17 PASS, exit 0** | `11-full3.log` |
| 12 | `05-rerun-audit134-independent.cjs` | **15/15 PASS, probes=2, exit 0** | `12-run.log` |
| 13 | `06-rerun-audit134-minimal-repro.cjs` | **blocked=false, R1/R2 invariants=true, exit 0** | `13-run.log`, `02-results.json` |

Примечания к копиям: (1) в `11-…` сценарий M9 принимал только
`err.code==='publish_failed'`; после Stage 137 intent/manifest-гейт отвергает
stale fence раньше (`stale_intent`), поэтому условие M9 в копии расширено до
«любой контролируемый не-success код» (commit/publish/marker не проверяются —
инвариант «никакого rename_verified для чужого canonical» сохранён и покрыт
отдельным M9-сценарием в 01-core с точным кодом `publish_failed`). (2) В
`10-…` порт «мёртвого» Redis для B5d перенаправлен на 6499 (в оригинале 6402,
который в этой сессии занят изолированным a137-redis). Остальной код копий не
менялся.

### 4.3 Тесты проекта (cwd `backend/`)

| # | Команда | Результат | Лог |
|---|---|---|---|
| 1 | `npx mocha --exit tests/gpu-publication-consistency.test.js` | **16 passing**, exit 0 | `10-gpu-publication-consistency.log` |
| 2 | `npx mocha --exit tests/gpu-fenced-publication-gates.test.js tests/gpu-result-fencing-commit.test.js` | **48 passing** (18+30), exit 0 | `11-gates-and-fencing.log` |
| 3 | `npx mocha --exit tests/gpu-queue-idempotency.test.js tests/gpu-intent-fence-regressions.test.js tests/gpu-intent-fence-receipt.test.js tests/gpu-lane-release-order.test.js tests/dispatch-meta-lease-lifecycle.test.js tests/markready-build-id-idempotency.test.js tests/book-registry-recovery-gate.test.js tests/startup-recovery-registry-gate.test.js` | **168 passing**, exit 0 | `12-targeted-idempotency-dispatch-recovery.log` |
| 4 | `npx mocha --exit tests/private-worker-phase2.test.js` | **40 passing / 1 pending**, exit 0 | `13-private-worker-phase2.log` |
| 5 | `npx mocha --exit 'tests/architecture/*.test.js'` | **935 passing / 24 pending**, exit 0 | `14-architecture.log` |
| 6 | `npx mocha --recursive tests/ --exit` | **3489 passing / 28 pending / 0 failing**, exit 0 | `16-full-backend-suite.log` |
| 7 | `./scripts/syntax-smoke.sh backend` (cwd repo) | `All production JS/CJS files pass syntax check`, exit 0 | `15-syntax-smoke.log` |

Baseline Stage 136: 3489 passing / 0 failing. Итог Stage 137: **3489 / 0** —
ни одного нового failure (один существующий тест Stage 131 усилен, см. §3.6).

Промежуточная итерация (зафиксирована для честности): после первого варианта
правки task-handler full suite показал 2 failing — `publication` был `null`
на legacy-пути `GPU_FENCING_MODE=off` (return-объект). Исправлено null-guard'ом;
в финальном прогоне 0 failing. Промежуточный лог перезаписан финальным.

---

## 5. Критерии PASS Stage 137 — статус

| Критерий | Статус | Доказательство |
|---|---|---|
| RACE1/RACE2 больше не позволяют F1 перезаписать F2 | ✅ | 01-core RACE1-1/RACE1-2/RACE2 (два реальных процесса, park на границе rename); 11-full3 RACE1/RACE2 |
| canonical hash и размер соответствуют committed manifest актуального fence | ✅ | HASH1/IDEM1/M8/M8R/CRASH2: manifest.sha256==canonical; CI1/CI2/CRASH3 — отказ при mismatch |
| M8 не приводит к ложному `already_published` | ✅ | M8 (восстановление), M8R (отказ без staged) |
| M9 не позволяет чужому canonical подтвердить rename | ✅ | M9 (publish_failed, marker renaming), CRASH3 (publication_unproven) |
| B3e/f/g не выбрасывают результат текущей генерации | ✅ | B3e/B3f/B3g публикуют F2; B3P — прежнее поведение; B3E2 — error fail closed |
| ready metadata только после подтверждённой публикации текущего fence | ✅ | handler: publication-проверка + повторный intent-чек; RACE1 saveChunk=0; R1/R1b |
| B1–B6 продолжают проходить | ✅ | 10-run.log 24/24; 12-run.log 15/15; 13-run.log blocked=false |
| Полный backend suite без новых failures | ✅ | 3489/28/0, exit 0 (16-full-backend-suite.log) |
| Посторонние dirty/untracked не изменены | ✅ | §1, sha256 baseline→final |
| Отчёт содержит воспроизводимые доказательства | ✅ | audit-137 (§7) |

Дополнительные обязательные проверки ТЗ §7: lock loss (LK5), lock expiry —
n/a по построению (wall-clock expiry отсутствует; live-holder блокировка LK2,
dead-owner reclaim LK3, foreign-host fail closed LK4), hash mismatch
(CI1/CI2/M8R/CRASH3), normal callback и повторная доставка (HASH1/IDEM1),
crash до/после rename (CRASH1/CRASH2/CRASH3 + B6-окна R2a–d в harness 10),
Redis/FS errors (INT1/B3E2/CI3 + B5*/M3/M4/R5a в harness 10/11).

---

## 6. Свойства решения и оставшиеся ограничения

1. **Атомарность Redis↔FS по-прежнему не транзакция.** Гарантия даётся
   сериализацией (per-task FS-lock через всю критическую секцию) + durable
   content-proof (manifest.sha256/bytes) + post-rename authority check +
   atomic rollback. Сценарий «supersede во время критической секции» даёт
   корректный итог (F2) без ложного success (RACE1/RACE2).
2. **Lock однораздельный (same-host).** Владелец чужого хоста не реклеймится —
   fail closed с `publication_lock_timeout` (LK4). Для мульти-хостового
   общего FS потребуется host-кооперативный lock (flock/lock-manager) — вне
   scope, зафиксировано как ограничение, не как регресс.
3. **Crash владельца lock** восстанавливается автоматически (PID-реклейм,
   CRASH1); owner-less lock-каталог старше 5 с — тоже.
4. **Потеря lock извне** (ручное удаление каталога) не позволяет stale
   владельцу публиковать: проверка токена до и после rename + rollback (LK5).
5. **Маркер без proof** (legacy `version:1` manifest или marker без sha256)
   больше не даёт успеха: `content_proof_missing`/`manifest_*` — fail closed.
   После деплоя все новые коммиты пишут version:2.
6. **Committed-superseded staged bytes** (F1 закоммичен, потом supersede):
   staged живёт до age-GC (24h) — как и в Stage 135; восстановление F2 не
   блокируется.
7. Не регрессировали: receipt-gate (B1/B2/B5), fail-closed Redis (B5c/d),
   stale done marker (B4/R3), idempotent redelivery (R4), GC (не трогает
   committed/current), `GPU_FENCING_MODE=off` kill-switch (unit-тесты прошли),
   architecture-границы (935 passing).

## 7. Артефакты и воспроизведение

```
/home/animastor/reorg-2026-10-23/audit-137/
  00-baseline.txt                     HEAD + git status baseline
  00-foreign-hashes.txt               sha256 посторонних файлов (baseline)
  00-foreign-hashes-final.txt         sha256 после Stage 137 (посторонние — идентичны)
  01-core.cjs                         независимый real-Redis harness Stage 137 (24 сценария)
  02-race-child.cjs                   child-процесс для RACE1/RACE2/LK5/CRASH1/LK2/LK3
  01-run.log  01-results.json         24/24 PASS, exit 0
  03-race-child.cjs                   оригинальный child Stage 136 (использовался при отладке)
  10-rerun-audit136-b1b6.cjs  10-run.log       B1–B6: 24/24 PASS, exit 0
  11-rerun-audit136-marker-safety.cjs 11-full3.log  M1–M9+RACE: 17/17 PASS, exit 0
  12-rerun-audit134-independent.cjs   12-run.log   15/15 PASS, probes=2, exit 0
  13-rerun-audit134-minimal-repro.cjs 13-run.log, 02-results.json  blocked=false, exit 0
  10-gpu-publication-consistency.log  16 passing, exit 0
  11-gates-and-fencing.log            48 passing, exit 0
  12-targeted-idempotency-dispatch-recovery.log  168 passing, exit 0
  13-private-worker-phase2.log        40 passing / 1 pending, exit 0
  14-architecture.log                 935 passing / 24 pending, exit 0
  15-syntax-smoke.log                 exit 0
  16-full-backend-suite.log           3489 passing / 28 pending / 0 failing, exit 0
  17-commands.md                      точные команды, cwd, exit codes
```

Воспроизведение:

```bash
docker run --rm -d --name a137-redis -p 127.0.0.1:6402:6379 \
  redis:7 --save '' --appendonly no

cd /home/animastor/reorg-2026-10-23/audit-137
export AUDIT_REDIS_URL=redis://127.0.0.1:6402/0
node 01-core.cjs                       # 24/24 PASS
node 10-rerun-audit136-b1b6.cjs        # 24/24 PASS
node 11-rerun-audit136-marker-safety.cjs  # 17/17 PASS
node 12-rerun-audit134-independent.cjs    # 15/15 PASS
node 13-rerun-audit134-minimal-repro.cjs  # blocked=false

cd /home/animastor/animastor-backend/backend
npx mocha --recursive tests/ --exit    # 3489 passing / 28 pending / 0 failing

docker rm -f a137-redis
```

Ключевые доказательства в `01-results.json`: `RACE1-1`/`RACE1-2` —
`childResult.error.code='stale_intent'`, `saveChunk=0`, `f2Dur≥1200`
(сериализация), `midCanonical`/`final.canonical`/`marker.fence` = F2;
`RACE2` — `outcome.resumed=0, superseded=1`; `M8` — `canonical='F2-BYTES'`,
`marker.sha256==manifest.sha256`; `M9` — `err.code='publish_failed'`;
`B3e/f/g` — `out.reason='success'`, `canonical='F2-NEW-BYTES'`.
