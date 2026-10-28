# Stage 122 — Fix regenerate lane clearing and audio/video orphaned completion (N1, N2)

**Base:** Stage 121 audit (`/home/animastor/reorg-2026-10-22/121-gpu-dispatch-independent-audit.md`) over commit `78bbfe18` (Stage 120)
**Результат:** commit `57c3d58f` — `fix(gpu-dispatch): functional book-scoped hub sweep + audio/video orphan-marker release (stage 122 / N1, N2)` (12 файлов, +700/−35)
**Дата:** 2026-10-22
**Артефакты:** `/tmp/opencode/stage122/`

**Итог: PASS.** Обе находки Stage 121 закрыты функционально, с поведенческими регрессионными тестами. Полный suite — 2678 passing / 28 pending / 85 failing, набор падений **byte-identical** к baseline Stage 118/121 (все 85 — environmental `ECONNREFUSED 127.0.0.1:1`). Регрессий нет.

---

## 1. N1 — regenerate / Hub lane sweep (был no-op)

### Дефект (аудит 121 · N1)
`generation-routes.cjs:673` вызывал `hubCancelOp('clearHubDispatches')([], { book_id: bookId })`, но `clearHubDispatches` (`dispatch-engine.js:1597`) итерировал **только** по `dispatchIds` и игнорировал `options.book_id` ⇒ пустой список ⇒ **0 HTTP-запросов** к хабу. Коммитный тест был структурным (строковая проверка), поэтому проходил, не проверяя поведения.

### Исправление
**`packages/animastor-orchestration/src/runtime/dispatch-engine.js` — контракт `clearHubDispatches`:**
- ids присутствуют → по одному `?dispatch_id=` DELETE на id (прежнее поведение без изменений);
- **пустой список + `book_id` → ровно ОДИН book-scoped `DELETE {hub}/queue/clear?book_id=...`** — тот самый эндпоинт, которым уже пользуются cache/delete пути (проверен в hub: фильтрация по `record.book_id === book_id`, чужие книги не затрагиваются);
- ни ids, ни book_id → **ни одного запроса** (никаких фиктивных HTTP);
- **проверка ответа Hub:** при `ok` парсится тело и сверяется эхо `scope.book_id` — если хаб ответил ok, но эхнул **чужой** scope, запрос считается `failed` с warn (защита от «очистил не ту книгу»); нечитаемое тело не фейлит (доверяем `ok`);
- ошибки hub (не-ok статус, сеть) → `failed++` + warn, **никогда не throw** (best-effort контракт, callers сохраняют claims);
- честный accountинг: `{ requested: 1, cleared, failed }` для book-sweep (requested = фактическиattempted-запросы).

**`backend/src/routes/book/generation-routes.cjs` (regenerate-вызов):** результат sweep перехватывается; `failed > 0` → явный warn `Post-release lane sweep ... incomplete (requested, cleared, failed)`; ошибки порта → warn. Sweep **никогда не сообщается как успех** при ошибке; claims к этому моменту уже освобождены (безопасное направление — осиротевшая запись ограничена claim TTL), как и в cache-пути.

**`packages/animastor-orchestration/src/runtime/hub-cancel-port.js`:** doc-контракт дополнен (двухформенный контракт: per-id / book-scoped). Адаптер (`hub-cancel-adapter.js`) — 1:1 делегирование, изменений не требует.

### Тесты (поведенческие, `backend/tests/gpu-lane-release-order.test.js` — блок «clearHubDispatches book-scoped sweep (audit 121 · N1)», 6 кейсов)
1. пустые ids + book_id → **ровно один** `DELETE http://hub.test/queue/clear?book_id=bk-n1`, результат `{requested:1, cleared:1, failed:0}`;
2. hub-ошибка (500) → `{requested:1, cleared:0, failed:1}` — честный отчёт;
3. недостижимый hub (throw) → `{requested:1, cleared:0, failed:1}`, без throw наружу;
4. **foreign-scope эхо → failed** (никогда не чужие книги);
5. пустые ids БЕЗ book_id → **0 запросов** (нет фиктивного HTTP);
6. per-id форма не изменилась (по DELETE на id).

Старый структурный тест regenerate (call-site wiring) сохранён и проходит.

---

## 2. N2 — audio/video и осиротевший done-маркер

### Дефект (аудит 121 · N2)
`releaseTaskDone` имел ровно **один** production-вызов — `iu-processor.js:340` (image). Audio и video send-пути не освобождали осиротевший маркер ⇒ `already_completed` → деферал 900 с → вечный цикл, сцена навсегда в active-index.

### Исправление — общий хелпер + три точки подключения
**`backend/src/helpers/queue-idempotency.cjs` — `releaseTaskDoneIfOrphan(redis, sendResult)`** (новый экспорт): инвариант M-c — send-путь достигает `provider.generate` только после пробы артефакта/чанка ОТСУТСТВУЮЩИМ (наличие = cache-hit, никогда не диспатчится), поэтому `already_completed` с send-пути **по построению** — осиротевший маркер. Возвращает `true` (release выполнен best-effort ⇒ ровно ОДИН retry) только при `!sent && reason==='already_completed' && idem_key`; **`duplicate_pending` и прочие вердикты — false ⇒ без retry** (bounded, цикл невозможен).

- **Image** (`iu-processor.js`): рефакторнут на общий хелпер; image-специфичный re-arm in-flight маркера остался на месте. Существующий интеграционный тест `gpu-orphan-completed-marker.test.js` проходит без изменений.
- **Audio** (`backend/src/audio/generation.js`, backend-тир — прямой require): обе точки отправки — merged (pure-dialogue) и per-segment — release + один retry с теми же аргументами generate.
- **Video** (`packages/animastor-orchestration/src/orchestration/scene-orchestrator.js`, orchestration-тир — тир-граница не позволяет требовать backend-хелпер напрямую): send-цикл освобождает маркер через **новую op персистенс-порта `idem.releaseTaskDoneIfOrphan`**:
  - `persistence-port.js`: op добавлен в OPS (декларативно — архитектурный тест o2 это энфорсит);
  - `runtime-persistence-adapter.js`: `idem.releaseTaskDoneIfOrphan(redis, sendResult)` → делегирование реальному `queue-idempotency.releaseTaskDoneIfOrphan` (host-тир, Redis-домен как `registry.*Redis`);
  - вызов в video-цикле защищён `isPersistencePortWired()` + try/catch (в production порт всегда wired в `backend.cjs`; в Harness'ах без orphan-очистки — skip, best-effort, ограничен claim TTL).

Инварианты соблюдены: **не бесконечный цикл** (ровно один retry, только на `already_completed`), **не вечный active-index** (задача регенерируется на этой же попытке / нормальный bounded-деферал далее), **не принимаются результаты старого intent** (retry пересаживает свежий pending-claim той же логической задачи — идентичность та же, post-условия не менялись).

### Тесты
**`backend/tests/gpu-orphan-audio.test.js` (4 кейса)** — реальный `generateSceneAudio` (обе ветки) через proxyquire-стабы provider/сегментов + **реальный queue-idempotency** против in-memory Redis:
1. orphan освобождён, чанк регенерирован **ровно один раз** (2 вызова provider, маркер удалён);
2. **восстановление после рестарта**: последующий диспатч отправляется с первого вызова (маркер уже освобождён — сцена не залипла);
3. **параллельный/не-orphan вердикт**: `duplicate_pending` → без release, без retry (1 вызов, bounded-деферал);
4. orphan без `idem_key` → без retry (defensive).

**`backend/tests/gpu-orphan-video.test.js` (3 кейса)** — реальный `dispatchStage → executeVideoDispatch` (orchestration-пакет), orphan-release через реальный хелпер:
1. orphan освобождён, video-job регенерирован ровно один раз (2 вызова provider, маркер удалён, `dispatched:true`);
2. `duplicate_pending` → без retry, bounded (`retryable:true`, 1 вызов);
3. orphan без `idem_key` → без retry.

**Дизайн изоляции видео-теста (важно):** mocha-bootstrap (`tests/generation-test-bindings.cjs`, подключаемый через `.mocharc` в КАЖДОМ прогоне) глобально вносит `bindHostModules(HOST_MODULE_BINDINGS)` и ВСЕ порты (persistence, sceneData, audioFsm, videoFsm, hubCancel, layerConfig). Первая версия видео-теста портила этот глобальный стейт (`clearHostBindings()` + `_reset*Port()` в afterEach) → 241 падение в reconciliation/orchestrator-сюитах. Финальная версия **полностью изолирована**: host-bindings и persistence-port застаблены через proxyquire (модуль-локальные фейки), а video-fsm-порт (лениво требуемый внутри `executeVideoDispatch` — proxyquire его не перехватывает) восстанавливает ровно production-адаптер (`../src/storage/video-fsm-adapter`) в afterEach. Глобальный стейт не трогается.

---

## 3. Синхронизация `backend/node_modules/@animastor/orchestration` (архитектурное замечание)

`backend/package.json` объявляет `@animastor/orchestration: ^0.1.4`; `backend/node_modules/@animastor/orchestration` — **сгенерированная копия** (gitignored; `.gitignore: node_modules/`), а git-tracked источник — `packages/animastor-orchestration/` (та же версия 0.1.4). До синхронизации backend-тесты видели отсутствие правок (N1-тест давал `{requested:0}`). Синхронизированы ровно 4 изменённых файла копированием `packages/ → backend/node_modules/` (diff всего src-дерева после синхронизации — пуст). Это не меняет версий, lockfiles и tracked-источников; на production-инфраструктуру не влияет. Обе копии теперь идентичны (`diff -rq` — IN SYNC).

---

## 4. Тестовая матрица (независимый прогон, изоляция `127.0.0.1:1`)

| Suite | Результат | Лог |
|---|---|---|
| Syntax smoke (`scripts/syntax-smoke.sh`) | **OK** (exit 0, все файлы) | `syntax.log` |
| Целевые GPU-тесты (6 файлов) | **88 passing / 0 failing** (75 baseline + 13 новых: 6 N1 + 4 audio + 3 video) | `targeted.log` |
| Пакет `@animastor/orchestration` | **35 passing / 0 failing** | `orchestration.log` |
| Архитектурные (`tests/architecture/*`, вкл. o2-контракт персистенс-порта) | **935 passing / 24 pending / 0 failing** | full-suite.log |
| Полный suite (`npx mocha --exit --reporter min "tests/**/*.test.js"`) | **2678 passing / 28 pending / 85 failing** (52 s) | `full-suite.log` |

**Сравнение с baseline:** 2665 (baseline) + 13 (новые тесты) = 2678 passing ✓. Извлечённые 85 заголовков падений **byte-identical** к `/tmp/opencode/118-committed.failures.txt` (`diff` пустой). Все 85 — environmental: **431** вхождение `ECONNREFUSED 127.0.0.1:1`, **0** обращений к любому другому хосту. Production Redis/PG/Hub не затронуты.

Все БД/Redis-прогоны выполнены с `PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1`.

---

## 5. Границы — соблюдены

- Локальный коммит создан **только после** прохождения всех тестов: `57c3d58f` (12 файлов, +700/−35), только **свои** файлы; чужие dirty-файлы не тронуты и не закоммичены (`backend/scripts/audit-orphan-books.js` D, `backend/tests/ai-endpoint-sharing.test.js`, `ai-shared-inference.test.js`, `architecture/installer-package-boundary.test.js`, `architecture/phase5-runtime-result.test.js`, `deploy/`, `freebuff-chat-*.md`).
- npm-публикация, версии/зависимости/lockfiles, push, CI, GHCR, deploy — не выполнялись.
- Production Redis/PG, Hub, контейнеры, очередь 457/438, `.env`, Compose, hooks, remote refs — не затронуты.
- HEAD до работ: `78bbfe18`; после: `57c3d58f` (1 новый локальный коммит).

---

## 6. Остаточные замечания (не блокеры)

1. **Параллельный dispatch audio/video** на уровне реального guardEnqueue в этих сюитах моделируется вердиктом (`duplicate_pending` — без release/retry, bounded). Полноценный гоночный сценарий «два одновременных диспатча одной логической задачи» уже покрыт коммитными тестами `gpu-queue-idempotency.test.js` (F2) и не изменился этим stage'ем.
2. **Мок fidelity** (наследие аудита 121): `tests/mocks/redis-mock.js` игнорирует `SET XX` и не истекает TTL — на новые тесты не влияет (audio/video используют реальные qidem-операции против полного мока; временные кейсы — в gpu-queue-idempotency с его FakeRedis). Рекомендация остаётся в силе.
3. `deploy/` и `freebuff-chat-*.md` — чужие untracked-файлы, оставлены как есть.
