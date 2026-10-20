# Stage 66 — scene_assets build_id fix: NULL-key idempotency (markReady)

**Вердикт: PASS**

Дата: 2026-10-18
Область: только бэкенд-код + тесты. **Схема не менялась, исторические строки не трогались, деплой не выполнялся.**
Коммит: `0d9b468` (ветка `main`), запушен в `github` и `origin`. Никаких force-push.

Report-задача: устранить дубликаты `scene_assets` с `build_id IS NULL` и сделать `markReady` идемпотентным.
Репорты Stage 63/64/65: PASS (см. `63-startup-recovery-registry-gate.md`, `64-startup-recovery-rollout.md`, `65-final-cleanup.md`).

---

## 1. Фактическая коррекция (важно)

IDs 25096 / 25097 / 25098 / 25100 — это **строки `scene_assets` с `asset_type='video'` и `build_id IS NULL`**, а не `image_units`.
Таблица `image_units` (до фикса): 58 строк, **0** строк с NULL/пустым `build_id`, колонка `build_id text NOT NULL`,
уникальный ключ `(build_id, book_id, chapter_id, scene_id, unit_id)`.

Все NULL-дубликаты в `scene_assets` относятся к production-книгам `ba_1788172242081` (26 строк) и
`import_1786345731767_1786345734345` (433 строки), которые **не изменялись** (§6).

---

## 2. Причина (root cause)

Уникальный ключ `scene_assets`: `(book_id, chapter_id, scene_id, asset_type, build_id)`.
В PostgreSQL `NULL`-значения **не равны друг другу** даже внутри уникального индекса, поэтому:

```
INSERT ... ON CONFLICT (book_id, chapter_id, scene_id, asset_type, build_id) DO UPDATE ...
```

**никогда не матчился** на `build_id IS NULL` → каждая вставка создавала **новую** строку-дубликат.

Активные продюсеры NULL-строк (по `updated_at`, до фикса):

| Кто | `scene_assets.id` | `updated_at` |
|---|---|---|
| `markReady` | 48353 | 2026-10-18 03:17:48 |
| `book-sync.markSceneAssetsStale` | 48348, 48351 | 2026-10-18 |
| `stampSceneVersionsForDispatch` | 48344, 48349 | 2026-10-18 |

Итог по NULL-строкам на момент диагностики: **409** `image`/`stale`, **12** `audio`/`stale`, **5** `audio`/`ready`,
плюс legacy `video`-строки (25096…).

`completeStage(redis, bookId, chapterId, sceneId, stage, buildId, dispatchId)` принимает `buildId`,
но **не передавал его** в `persist('sceneAssets.markReady')(bookId, chapterId, sceneId, stage, artifactPath)` —
build-контекст терялся на уровне orchestrator'а. Это и есть точка утечки.

---

## 3. Решение (что именно изменено)

### 3.1 `backend/src/storage/postgres/database.js`
Добавлен `withTransaction(work)` — `BEGIN` / `COMMIT` / `ROLLBACK` + `client.release()`.
Экспорт: `{ getPool, closePool, query, withTransaction }`.

### 3.2 `backend/src/storage/postgres/repositories/scene-assets-repo.js` (ядро фикса)
- **`markReady(bookId, chapterId, sceneId, assetType, artifactPath, extras = {})`** теперь **выводит `build_id` из пути артефакта**
  (`<OUTPUT_DIR>/<buildId>/<file>`, хендлеры конструируют все пути из build-каталога; `artifactRoot = config.OUTPUT_DIR`,
  дефолт `/data/output`), если `extras.build_id == null`.
- **`upsertAsset`** при `build_id == null` идёт через `upsertAssetWithNullBuildId`:
  `pg_advisory_xact_lock(hashtextextended(...))` внутри транзакции → `UPDATE` канонической NULL-строки
  (`ORDER BY updated_at DESC, id DESC LIMIT 1`) → иначе `INSERT`.
- **`stampSceneVersionsForDispatch`**: fast-path `UPDATE` сохранён; insert-ветка — в транзакции с advisory-lock,
  повторный `UPDATE`-recheck и guard `NOT EXISTS (... AND sa.build_id IS NULL)`.
- **Новый экспорт `ensureSyntheticStaleAsset(bookId, chapterId, sceneId, assetType='audio')`**:
  транзакция + advisory-lock → `SELECT` версий из `scenes` → `UPDATE` существующей NULL-строки в stale+версии → иначе `INSERT`.

**Документированное решение по provenance `build_id`:** источник — **хост-сторона (путь к артефакту)**,
потому что `@animastor/orchestration` установлен **из npm registry** (`backend/package-lock.json` →
`registry.npmjs.org/.../0.1.3.tgz`), а `backend/node_modules/@animastor/*` — это копии.
Изменения в `packages/` потребовали бы publish + version bump, чтобы попасть в рантайм.
Поэтому **`packages/` не менялся и версии не бампались**.

### 3.3 `backend/src/storage/postgres/repositories/iu-repo.js`
Добавлен `assertBuildId(buildId, fnName)` — бросает `"build_id is required — image_units rows are identified by build_id and the unique key cannot deduplicate a missing one"`.
Вызывается из `upsertImageUnit` и `upsertIuTiming`. Поведение успешного upsert не изменилось.

### 3.4 `backend/src/services/book-sync.js` (файл в `DIRECT_SQL_WHITELIST`)
Сырой `INSERT ... ON CONFLICT` для синтетического stale-аудио заменён на `ensureSyntheticStaleAsset(bookId, chapterId, sceneId)`;
`total += ensured || 0`. Комментарии и остальной код не менялись.

### 3.5 Тесты
- **Новый:** `backend/tests/markready-build-id-idempotency.test.js` (18 тестов):
  markReady штампует build_id из пути; повторный/concurrent markReady не плодит строки; явный `extras.build_id` главенствует;
  legacy NULL-путь; build'ы не смешиваются; исторические NULL-строки не трогаются; stamp-идемпотентность;
  `ensureSyntheticStaleAsset` no-op без `scenes`; book-sync не создаёт второй NULL-аудио-строки;
  `image_units` всегда с реальным build_id, идемпотентны, конкуренция безопасна, отсутствие build_id отклоняется.
- **Изменён:** `backend/tests/orphan-books-diagnosis.test.js` — комментарий Class IV переписан, тест переименован в
  `Class IV: historical NULL build_id duplicates are still detected and reported`, вторая NULL-строка вставляется сырым SQL
  после идемпотентного repo-upsert. Ассерты аудита **не менялись**.

### 3.6 Schema migration — **сознательно не делалась**
NULL-safe уникальный индекс невозможно безопасно накатить в этом стейдже: 437 NULL-строк **уже содержат дубликаты**.
Фикс — только в коде, через advisory-lock.

---

## 4. Тесты и проверки (все — PASS)

| Команда (из `backend/`) | Результат |
|---|---|
| `npx mocha --exit tests/markready-build-id-idempotency.test.js` | **18 passing** (после фикса require-пути и переписанного legacy-теста) |
| `npx mocha --exit tests/orphan-books-diagnosis.test.js tests/book-sync.test.js tests/scene-asset-registry.test.js` | **26 passing** |
| `npx mocha --exit tests/happy-path.test.js` | **75 passing** |
| `npx mocha --exit tests/generation-routes.test.js tests/orchestration-stabilization.test.js tests/orchestrator-convergence.test.js tests/image-orphan-generating-repair.test.js tests/dispatch-meta-lease-lifecycle.test.js` | **99 passing** |
| `npm run test:arch` | **929 passing**, 24 pending |
| `bash scripts/syntax-smoke.sh` | **All files OK** |
| `npx mocha --exit "tests/**/*.test.js"` (полный бэкенд-набор) | **3241 passing**, 0 failing, 28 pending |

Примечание: во время первого прогона споткнулся `require('../../config/runtime-config')` из `scene-assets-repo.js`
(глубина пути неверна: из `storage/postgres/repositories/` до `src/config/` — три уровня). Исправлено на
`../../../config/runtime-config`.

---

## 5. База данных после стейджа (production PG, read-only сверка)

| Проверка | До | После |
|---|---|---|
| `scene_assets` всего | 459 | **459** ✅ (не изменилось) |
| по книге | `ba_` 26, `import_` 433 | **то же самое** ✅ |
| `image_units` всего | 58 | **58** ✅ |
| `books` / `scenes` | 2 / 13 | **2 / 13** ✅ |
| строки с `book_id LIKE 'test-%'` | — | **0** ✅ |

**Побочный эффект тестов и его уборка:** полный прогон тестов оставил 9 строк
`image_units book_id='ghost_book' build_id='build-ghost'` (загрязнение из
`tests/image-ghost-no-jobs-sent.test.js`, который пишет в реальный PG и не чистит `image_units` —
**поведение существовало до стейджа** и не связано с моим фиксом). Эти 9 строк удалены
охранной транзакцией (`DELETE ... WHERE book_id='ghost_book' AND build_id='build-ghost'`, guard `n=9` и `total=58`),
`image_units` вернулся к baseline 58.

Исторические строки **25096 / 25097 / 25098 / 25100 не удалялись и не перепривязывались**.
Обе сохранённые книги (`ba_1788172242081`, `import_1786345731767_1786345734345`) не изменялись.

---

## 6. Что осталось / наблюдения (вне скоупа)

- **Наблюдение (не фиксилось):** для versioned-книг `getAsset(..., buildId)` не видит NULL-строки,
  потому что ищет по конкретному `build_id`. Если ассет живёт в legacy NULL-строке, а книга уже versioned,
  READY-чек может не найти её. Это осознанно оставлено как есть (может упоминаться как следующий шаг).
- **Существующее тестовое загрязнение:** `image-ghost-no-jobs-sent.test.js` пишет 9 строк в production PG на каждый прогон
  и не удаляет их. Предложение на будущее: добавить cleanup-хук или stub для `iu-repo` в этом тесте.
- **NULL-строки в production (437 шт.) не вычищались** — чистка исторических NULL-строк и выяснение,
  какие из них ещё актуальны, — отдельный стейдж с миграцией/скриптом.
- Деплой образа: коммит `0d9b468` **не задеплоен** (как и требовал мандат — только commit + push).
  Текущий production-образ по-прежнему `sha256:9aac015a…` (revision `7740525`).

---

## 7. Изменённые файлы (коммит `0d9b468`)

```
backend/src/services/book-sync.js
backend/src/storage/postgres/database.js
backend/src/storage/postgres/repositories/iu-repo.js
backend/src/storage/postgres/repositories/scene-assets-repo.js
backend/tests/markready-build-id-idempotency.test.js   (новый)
backend/tests/orphan-books-diagnosis.test.js
```

В коммит **не включены** (по мандату) незавершённые/чужие изменения:
` D backend/scripts/audit-orphan-books.js`, ` M backend/tests/ai-endpoint-sharing.test.js`,
` M backend/tests/ai-shared-inference.test.js`, ` M backend/tests/architecture/installer-package-boundary.test.js`,
` M backend/tests/architecture/phase5-runtime-result.test.js`, `?? deploy/`, `?? freebuff-chat-*.md`.
