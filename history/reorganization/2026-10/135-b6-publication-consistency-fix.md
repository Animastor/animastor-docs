# Stage 135 — Fix B6: Fenced Publication and Recovery Consistency

**Вердикт: PASS.**

B6 из Stage 134 устранён: публикация текущего fence больше не определяется фактом
существования canonical-файла. Введён crash-consistent **per-task publication marker**
(`renaming` до rename, `published` после) и единый state machine
`publishCommittedFence`, используемый и retry'ем в процессе, и restart-recovery. Все три
crash-окна разрешаются детерминированно в пользу закоммиченных байтов актуального fence;
superseded fence по-прежнему не может опубликоваться; ready-метаданные пишутся только после
подтверждённой публикации. B1–B5 не регрессировали.

- **Исходный HEAD:** `cd31d2790231617f0c90b3ac523a54692aab5357` (Stage 133, аудированный в 134).
- **Новый локальный commit:** `6a6f1891` — 4 файла, **+758 / −39** (push/deploy не выполнялись).
- **Отчёт аудита:** `/home/animastor/reorg-2026-10-23/134-independent-fenced-publication-audit.md`.
- **Артефакты Stage 135:** `/home/animastor/reorg-2026-10-23/audit-135/`
  (`01-b6-real-redis.cjs`, `01-results.json`, `full-suite.log`, `rerun-audit134-independent.log`).

---

## 1. Baseline и границы

Зафиксировано до изменений: HEAD `cd31d279…`, 10 записей `git status --porcelain` (8 посторонних
dirty/deleted + `deploy/` и `freebuff-chat-…md` untracked), sha256 посторонних файлов:

```
bafa0c7366940ee3…  backend/src/routes/book/generation-routes.cjs
c0e08565df9e90d3…  backend/tests/ai-endpoint-sharing.test.js
3f0ef0f9e1d30449…  backend/tests/ai-shared-inference.test.js
f7889f41edd70f95…  backend/tests/architecture/installer-package-boundary.test.js
5d531cc48de5224d…  backend/tests/architecture/phase5-runtime-result.test.js
e4cb7478e280a11c…  backend/tests/gpu-lane-release-order.test.js
478d3fa7a998b32f…  packages/animastor-orchestration/src/runtime/dispatch-engine.js
2134973a625895c4…  freebuff-chat-2026-10-11T07-41-12.445Z.md
```

После работы хэши и статус идентичны; `reset/clean/stash/checkout` чужих файлов не выполнялись,
массового форматирования нет. Production Redis/PG/Hub/очереди/контейнеры не затрагивались,
`.env`/Compose/`GPU_FENCING_MODE` не менялись (`enforce` не включался), commit/push/deploy/npm/CI —
только локальный commit `6a6f1891`. Все воспроизведения — throwaway `redis:7` + `mkdtemp` FS.
Scope не расширялся: PG-миграции, retention, epoch-gap и синхронизация runtime-пакета не трогались.

---

## 2. Причина B6 (кратко)

`done` доказывает **commit**, а не **rename**. Canonical-путь общий для всех генераций одного
job (`{prefix}_0001.mp3` и т.п.), поэтому:

- `publishStaged(overwrite:false)` при `duplicate_same_fence` и существующем canonical возвращал
  `already_published` — без проверки, чей это файл;
- `resumePendingPublications` по той же посылке удалял staged **текущего** fence (`cleaned=1`).

Итог Stage 134: retry рапортовал успех и писал ready-метаданные поверх байтов предыдущей
генерации, а recovery уничтожал единственную копию закоммиченного результата.

---

## 3. Решение: publication marker + единый state machine

### 3.1 Marker

`backend/src/helpers/queue-idempotency.cjs`:

```
animastor:fence-publish:{book}:{ch}:{sc}:{job}   TTL = IDEM_DONE_TTL_S (7 d)
{ fence, stage: 'renaming'|'published', at }
```

- `readFencePublication` — строгий (`ok | absent | corrupt | error`), ошибка Redis не маскируется;
- `markFencePublication` — `SET EX`; для стадии `renaming` запись **обязательна** (иначе публикация
  прерывается), для `published` — best effort (rename уже состоялся, окно восстановимо);
- для отклонённых callback'ов (нет receipt / stale / corrupt intent) маркер **никогда** не пишется.

### 3.2 Состояния и решения (`publishCommittedFence`, `result-publication.cjs`)

| marker | staged | canonical | Решение |
|---|---|---|---|
| `published == fence` | есть/нет | есть | **already_published**: canonical не трогаем; stray staged удаляется |
| `published == fence` | есть | **нет** (файл удалён) | переиграть rename из staged (текущий fence восстановим) |
| `renaming == fence` | есть | любой | завершить rename (перезапись) → `published` |
| `renaming == fence` | нет | есть | **rename_verified**: rename уже произошёл, маркер чинится |
| отсутствует / другой fence | есть | любой | перезаписать (intent-гейт уже подтвердил актуальность) |
| отсутствует / другой fence | нет | есть | `publication_unproven` — **не** success |
| любой | нет | нет | `staged_missing` — не success (orphan) |
| marker read error | — | — | `publish_failed` (retryable, ничего не тронуто) |

`commitFencedResult` (in-process публикация) и `resumePendingPublications` (restart recovery)
вызывают **один и тот же** `publishCommittedFence`, поэтому разойтись не могут. `publishStaged`
остался только как low-level rename-примитив с явным предупреждением в docblock.

### 3.3 Crash windows (доказательство восстановления)

| Окно | Состояние на диске/в Redis | Восстановление |
|---|---|---|
| W1: crash после Lua-commit, до записи marker | manifest+done=F, staged=F, canonical = F-1 | marker absent + staged ⇒ rename (перезапись) |
| W2: crash после `renaming`, до rename | marker renaming=F, staged=F, canonical = F-1 | staged ⇒ завершить rename |
| W3: crash после rename, до `published` | marker renaming=F, staged нет, canonical=F | rename_verified ⇒ маркер `published`, ничего не удаляется |
| W4: crash до commit | staged инертен, manifest/done нет | GC по возрасту (не публикуется) |
| marker SET fail до rename | staged=F, canonical = F-1 | `publish_failed`, **rename не выполняется**, retry/resume публикует |
| marker GET error | любое | `publish_failed`/`errors++`, ни записи, ни удаления |
| rename error (`publish_failed`) | staged=F сохранён, marker renaming=F | retry текущего fence завершает публикацию (R1) |

Ни одно окно не является неоднозначным: маркер пишется **до** rename, поэтому «нет staged + marker
renaming» однозначно означает завершённый rename; «есть staged» однозначно означает незавершённый.

### 3.4 Ready-метаданные

Handler запускает metadata-цепочку только для статусов, возвращённых `commitFencedResult` после
успешного `publishCommittedFence` (`committed`/`duplicate` + `published`/`rename_verified`/
`already_published` при существующем canonical). Любая ошибка маркера/rename/Redis → throw
(`publish_failed` / `staged_missing` / `publication_unproven`) → metadata не пишется.

---

## 4. Требования Stage 135 → где выполнены

1. Текущий fence восстанавливаем, пока байты не опубликованы — W1/W2/W3 + R1/R2. ✅
2. Retry не успешен только из-за `done`/canonical — решение по маркеру; `already_published` требует
   `marker.published == fence` **и** наличия canonical. ✅
3. Canonical предыдущего fence корректно заменяется актуальными staged-байтами — R1, R2a–c. ✅
4. Superseded fence не перезаписывает canonical — intent-гейт скрипта + маркер не пишется для
   reject'ов; R3. ✅
5. Повторная доставка опубликованного fence идемпотентна — R4 (canonical не флапает, staged stray
   удаляется). ✅
6. `resumePendingPublications` не удаляет единственную staged-копию текущего committed fence —
   `cleaned` возможен только при `marker.published == fence`; R2. ✅
7. Ошибки rename/marker/Redis/FS — контролируемый отказ либо безопасное восстановление — §3.3, R5a/b. ✅
8. Ready не подтверждается до согласованности canonical с актуальным fence — §3.4 + R1. ✅
9. Traversal/staging-изоляция/intent-проверка сохранены — старые guard'ы оставлены, тесты
   `path traversal…` зелёные; контракт immutable receipt и отсутствие ref-fallback не менялись. ✅

---

## 5. Тесты

### 5.1 Новые регрессионные тесты (репозиторий)

`backend/tests/gpu-publication-consistency.test.js` — **16 passing / 0 failing**:

- **R1**: F1 опубликован → F2 committed, rename падает → `publish_failed`, canonical=F1,
  staged F2 сохранён, marker `renaming` → retry через production handler → canonical=F2,
  manifest/done=F2, marker `published`, chunk/ready-метаданные записаны **после** публикации;
- **R1b**: неудачный rename не помечает публикацию завершённой;
- **R2a**: crash сразу после commit (marker отсутствует) → resume публикует F2 (`resumed=1`),
  staged не удалён до публикации, повторный resume идемпотентен;
- **R2b**: crash после `renaming` до rename → resume завершает rename;
- **R2c**: crash после rename до `published` → resume подтверждает и чинит маркер, ничего не удаляет;
- **R2d**: committed fence без staged и без canonical → `orphans=1`, **не** success;
- **R3**: late F1 после supersede → `stale_intent`, canonical не тронут, staged F2 цел, затем F2
  публикуется; resume не переигрывает superseded manifest (B4);
- **R4**: redelivery опубликованного fence → идемпотентно, canonical не перезаписан, staged stray
  удалён только resume'ом;
- **R5a**: marker SET failure до rename → `publish_failed`, canonical не тронут, staged сохранён,
  следующий resume публикует;
- **R5b**: marker GET failure в recovery → `errors=1`, ничего не записано/удалено, здоровый resume
  публикует;
- **R5c**: удалённый canonical текущего fence восстанавливается redelivery'ем;
- **R6**: отклонённые callback'и (`receipt_missing`, `stale_intent`) не создают ни canonical, ни
  маркер, ни ready-метаданные;
- нормальный fenced callback: canonical/manifest/done/marker согласованы.

Изменены: `backend/tests/architecture/redis-registry.js` — новый key family
`animastor:fence-publish:*` зарегистрирован (owner/readers/writers/note); иначе архитектурный
guard `redis-ownership` падает (это единственный «красный» прогон в процессе этапа, см. §6).

### 5.2 Реальный Redis + настоящий Lua + временная FS

`audit-135/01-b6-real-redis.cjs` (throwaway `redis:7`, `127.0.0.1:6399`, `--save '' --appendonly no`):
**12/12 PASS** — R1, R2a, R2b, R2c, R3, R4, R5a, R5b, R6a (normal), R6b (B1), R6c (B2), R6d (B5).

Повторное воспроизведение Stage 134 на исправленном коде:

```
audit-134/02-minimal-repro.cjs → blocked=false
  R1: retry → canonical "F2-BYTES", manifest F2, done F2, invariantOk=true
  R2: resume → resumed=1, canonical "F2-BYTES", invariantOk=true
audit-134/01-independent.cjs  → 15/15, probes:
  N1 … canonicalAfterResume "v2", manifest F2, consistent=true
  N2 … canonicalAfterRetry "V2-RETRY", consistent=true
```

### 5.3 Обязательные прогоны (точные команды, cwd, exit codes)

| # | Команда | Exit | Результат | Лог |
|---|---|---|---|---|
| 1 | `npx mocha --exit tests/gpu-publication-consistency.test.js` (`backend/`) | 0 | **16 passing** | — |
| 2 | `npx mocha --exit tests/gpu-publication-consistency.test.js tests/gpu-fenced-publication-gates.test.js tests/gpu-result-fencing-commit.test.js` (`backend/`) | 0 | **64 passing** (16+18+30) | — |
| 3 | `npx mocha --exit tests/gpu-queue-idempotency.test.js tests/gpu-intent-fence-regressions.test.js tests/gpu-intent-fence-receipt.test.js tests/gpu-lane-release-order.test.js tests/dispatch-meta-lease-lifecycle.test.js tests/markready-build-id-idempotency.test.js` (`backend/`) | 0 | **159 passing** | — |
| 4 | `npx mocha --exit tests/private-worker-phase2.test.js` (`backend/`) | 0 | **40 passing / 1 pending** | — |
| 5 | `npx mocha --exit 'tests/architecture/*.test.js'` (`backend/`) | 0 | **935 passing / 24 pending** | — |
| 6 | `npx mocha --recursive tests/ --exit` (`backend/`) | 0 | **3489 passing / 28 pending / 0 failing** | `audit-135/full-suite.log` |
| 7 | `./scripts/syntax-smoke.sh backend` (repo root) | 0 | `All production JS/CJS files pass syntax check` | — |
| 8 | `node audit-135/01-b6-real-redis.cjs` | 0 | **12/12** | `audit-135/01-results.json` |
| 9 | `node audit-134/02-minimal-repro.cjs` | 0 | `blocked=false` | — |
| 10 | `node audit-134/01-independent.cjs` | 0 | **15/15**, probes consistent=true | `audit-135/rerun-audit134-independent.log` |

Baseline Stage 134: 3473 passing → **3489** (+16 новый сьют). B1–B5 (18 кейсов gates) и B4 (30
кейсов fencing) зелёные.

**Честно о красном прогоне:** первый полный suite дал `1 failing` в
`tests/architecture/redis-ownership.test.js` — новый ключ `animastor:fence-publish:` не был
зарегистрирован в `tests/architecture/redis-registry.js`. Это ожидаемое требование guard'а
(а не дефект логики); family зарегистрирован, после чего guard и полный suite зелёные. Тесты не
ослаблялись.

---

## 6. Изменённые файлы (commit `6a6f1891`)

```
 backend/src/helpers/queue-idempotency.cjs          |  77 +   (fencePublishKey/read/mark, TTL, exports)
 backend/src/services/result-publication.cjs       | 226 +-  (publishCommittedFence, retry+resume на нём,
                                                             crash-window документация)
 backend/tests/architecture/redis-registry.js      |  14 +   (регистрация animastor:fence-publish:*)
 backend/tests/gpu-publication-consistency.test.js | 480 +   (R1–R6, 16 кейсов)
```

Staged diff проверен пофайлово; посторонние dirty/untracked-файлы в commit не попали (пересечение
пустое), их хэши не изменились.

---

## 7. Оставшиеся риски (вне scope, не исправлялись)

1. **PostgreSQL fenced projection/replay**, миграция `generation_fence` — не делались.
2. **Manifest retention**: нет TTL, `RESUME_MANIFEST_LIMIT=200`, GC только `.staging`.
3. **Redis epoch-gap на send-side**, CROSSSLOT/reply-length fallback — не менялись.
4. **Устаревшая копия `@animastor/orchestration` в `backend/node_modules`** — не синхронизировалась
   (byte-equality guard в тестах). Phase A reconcile по-прежнему получит `receipt_missing` и
   оставит ключ до TTL (записей нет).
5. **`GPU_FENCING_MODE=off`** — явный kill-switch, единственный путь прямой записи (не включался).
6. **Новый маркер и eviction:** при вытеснении маркера (maxmemory) и живом `done` recovery сообщит
   `publication_unproven`/`errors` (без записи и без удаления) до истечения `done` (7 d); это
   безопасный, но шумный режим. При штатном TTL маркер не истекает раньше `done` (пишется позже).

---

## 8. Критерии PASS

| Критерий | Статус |
|---|---|
| R1 и R2 исправлены и воспроизводимо проходят | ✅ мок-сьют + реальный Redis/Lua + повтор repro Stage 134 |
| Canonical содержит байты актуального fence после retry/recovery | ✅ R1/R2a–c |
| Canonical/manifest/done/marker/ready согласованы | ✅ проверяется в каждом кейсе |
| Stale fence не может опубликоваться | ✅ R3 (+ B4 regression) |
| Recovery не удаляет единственную staged-копию | ✅ R2, R5b |
| B1–B5 продолжают проходить | ✅ gates 18/18, real-Redis R6b–d |
| Полный backend suite без новых failures | ✅ 3489/28/0, exit 0 |
| Посторонние dirty/untracked не изменены | ✅ sha256 + status идентичны baseline |
| Описаны crash windows и доказательства восстановления | ✅ §3.3, §5.2 |
