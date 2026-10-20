# Stage 63 — Gate startup recovery by book registry

**Вердикт: PASS**

Дата: 2026-10-17
Коммит: `7740525` — `fix(backend): gate startup disk recovery on book registry (stage 63)`
Push: origin (`/home/animastor/repos/animastor-backend.git`) + github (`Animastor/animastor-backend`, main → `7740525`), обычный push, без force.
Деплой: **не выполнялся** (по заданию — только фикс + тесты + отчёт; rollout согласуем отдельно).

---

## 1. Что восстанавливала `recoverAllBooksFromDisk` (аудит до правки)

Реализация: `backend/src/helpers/redis-helpers.cjs:228` (factory `module.exports = function(redis)`).

Алгоритм: скан `config.OUTPUT_DIR` → по каждому build-каталогу читает `*.mp3` с `_ch*_sc*` → парсит из имени файла `bookId` → если у bookId **нет** чанков в Redis и `book.loadBook(bookId)` находит `book.json` на диске → `recoverChunksFromDisk` + установка window-счётчиков.

Точный набор Redis-ключей, которые она записывает для одной книги (со сценой на диске):

| Ключ | Команда | Кто пишет |
|---|---|---|
| `animastor:chunk:{bookId}_{ch}_{sc}_0001` | SET | `saveChunk` |
| `animastor:chunks:{bookId}` | SADD | `saveChunk` |
| `animastor:asset-state:{bookId}:{ch}:{sc}` | HSET (audio/image/video → ready) | `state.unsafeRestoreAssetStates` |
| `animastor:book-scenes:{bookId}:total` | SET | `recoverAllBooksFromDisk` |
| `animastor:book-scenes:{bookId}:next-index` | SET | `recoverAllBooksFromDisk` |

Это те самые **5 ключей**, которые после Stage-62 рестарта воссоздали удалённую книгу `новая_книга_1788747351369` (PG при этом не менялся — восстановление было чисто Redis- и disk-ориентированным).

**Условия, при которых срабатывала запись** (все — до Stage 63):
1. Каталог `OUTPUT_DIR/<buildId>/` существует;
2. В имени файла распознан bookId (грамматика `{bookId}_{chapterId}_{sceneId}.mp3`);
3. В Redis **нет** чанков книги (`getAllChunks` пуст) — иначе skip;
4. `book.loadBook(bookId)` вернул book.json с распознанной сценой — **наличия book.json на диске было достаточно**;
5. Проверки регистрации в `books` (PG) **не было вообще**.

**Вызывается только в двух местах, оба — через одну и ту же замыкание:**
- `backend/src/backend.cjs` → `reconcileDeps.recoverAllBooksFromDisk` → `reconciliation-engine.js:1655` (Phase C0, только при `startup: true` — первый прогон после старта);
- `runtime-loop.setReconcileDeps` периодического цикла — тот же объект deps, но `reconcileCycle(..., { startup: false })` фазу C0 **не выполняет** (проверено: `reconciliation-engine.js:1651 if (startup)`).

Обхода гейта нет: флаг/проверка живёт **внутри** `recoverAllBooksFromDisk`, а не на точке вызова, поэтому любой будущий caller тоже получает гейт. Прямых вызовов функции вне deps-цепочки (`grep recoverAllBooksFromDisk(`) — ноль. В routes файлы она только деструктуризируется, но не вызывается; `recoverChunksFromDisk` (без `All`) в import/generation routes — отдельные request-time сценарии, не startup, и в скоуп Stage 63 не входили.

**Stage-59 гейты не менялись**: `packages/animastor-editor/src/read-recovery.cjs`, `player`-пути, composition-root `isBookRegistered` — untouched (см. diff: только перенос определения `isBookRegistered` выше по файлу + передача в factory; логика та же).

## 2. Исправление

### `backend/src/helpers/redis-helpers.cjs`
- Factory: `function(redis)` → `function(redis, deps = {})`; из deps извлекается `isBookRegistered`.
- В `recoverAllBooksFromDisk`, **в начале** цикла по bookId, до любого Redis read/write для книги:
  - порт не внедрён → log `no isBookRegistered gate injected — skipping recovery (fail-closed)` + skip (**fail-closed**);
  - `isBookRegistered(bookId)` бросил → log `registry check failed … (fail-closed)` + skip (**fail-closed**);
  - вернул falsy → log `Skipping recovery for {bookId} — book not registered` + skip — **целиком**, без чтения `getAllChunks`, без `loadBook`, без каких-либо записей;
  - вернул truthy → прежний путь без изменений (в т.ч. skip «chunks already exist»).

### `backend/src/backend.cjs`
- Блок `bookRepo` + `isBookRegistered` + комментарий перенесены **выше** factory-вызова `redis-helpers` (иначе TDZ: `const` ещё не инициализирован). Логика `isBookRegistered` не менялась — тот же host-side порт (books-row ownership через `bookRepo.getWorkspaceId`, fail-closed при ошибке PG).
- Factory вызывается как `require('./helpers/redis-helpers.cjs')(redis, { isBookRegistered })`.

Инъекция, а не `require('../storage/...')` внутри helpers — сохраняет архитектурный стиль Stage 59 (composition root — единственное место, решающее «зарегистрирована ли книга»).

## 3. Тесты

Новый файл: `backend/tests/startup-recovery-registry-gate.test.js` (mocha +chai, FakeRedis, реальный `recoverAllBooksFromDisk` из `backend/src/helpers/redis-helpers.cjs`, tmp OUTPUT_DIR c mp3-файлами ОБОИХ книг на диске, стаб book-модуля через require.cache):

| # | Кейс | Результат |
|---|---|---|
| 1 | Зарегистрированная книга — восстановление выполняется: chunk SET, chunks SADD, asset-state HSET=ready×3, total/next-index SET | ✔ |
| 2 | Незарегистрированная книга — **ноль** Redis-ключей при book.json+mp3 на диске; log `book not registered` | ✔ |
| 3 | Ошибка проверки регистрации (throw) — fail-closed skip, ноль ключей; зарегистрированная «сестринская» книга при этом восстанавливается | ✔ |
| 4 | Порт не внедрён — fail-closed, полный skip (store и sets пусты) | ✔ |
| 5 | Существующие сохранённые книги не затронуты: предзаписанные chunk+chunks байт-в-байт сохранены, asset-state/window-счётчики не материализуются (skip-путь «chunks already exist»), удалённая книга ничего не добавляет | ✔ |

**Прогон:**
- целевой файл: `5 passing`;
- Stage-59 `book-registry-recovery-gate.test.js` + `private-worker-visibility.test.js` (использует реальную factory): `27 passing`;
- `txt-import-ownership.test.js` + `architecture/assistant-purge-wiring.test.js` (стабы deps): `13 passing`;
- архитектурный набор `npm run test:arch`: **929 passing, 24 pending, 0 failing**;
- `bash ../scripts/syntax-smoke.sh`: **All production JS/CJS files pass syntax check**;
- `node --check` по изменённым файлам: OK.

Известный pre-existing фейл `entity-crud-routes.test.js` (editor package, Stage-62 находка, воспроизводится на нетронутом `c40b2da`) — не в скоупе, не трогали.

## 4. Git

```
7740525 fix(backend): gate startup disk recovery on book registry (stage 63)
  M backend/src/backend.cjs
  M backend/src/helpers/redis-helpers.cjs
  + backend/tests/startup-recovery-registry-gate.test.js
```

`git status` перед коммитом: в коммит попали **только** эти 3 файла. Pre-existing незакоммиченные изменения не включены и не тронуты:
` D backend/scripts/audit-orphan-books.js`, ` M` 4 теста (ai-endpoint-sharing, ai-shared-inference, installer-package-boundary, phase5-runtime-result), untracked `deploy/`, `freebuff-chat-2026-10-11T07-41-12.445Z.md`.

Push: обычный, `origin` и `github` → `7740525` (сверено `ls-remote`).

## 5. Подтверждение по production Redis/PG (read-only, ничего не очищалось)

По заданию (п. 11) пять восстановленных ключей **не очищались** — они на месте как свидетельство старого поведения до rollout:

```
animastor:chunk:новая_книга_1788747351369_ch-c289a7ac_sc-eebaac15_0001
animastor:chunks:новая_книга_1788747351369
animastor:asset-state:новая_книга_1788747351369:ch-c289a7ac:sc-eebaac15
animastor:book-scenes:новая_книга_1788747351369:next-index
animastor:book-scenes:новая_книга_1788747351369:total
```

Сохранённые книги — без изменений:
- PG `books`: `ba_1788172242081`, `import_1786345731767_1786345734345` (2 строки);
- PG `scenes`: 13 (как в конце Stage 62);
- PG `image_units id=250444`: **1 строка** (не удалялась);
- Redis `animastor:chunks:ba_1788172242081` и `animastor:chunks:import_1786345731767_1786345734345` — присутствуют.

## 6. Оставшиеся действия

1. **Rollout отдельной стадией** (не выполнялся): CI `backend-ghcr-release.yml` (workflow_dispatch, `APPROVED_COMMIT: 7740525…`) → pin digest в `deploy/.env:BACKEND_IMAGE` → `docker compose --project-name animastor … up -d backend`.
2. После rollout — первый рестарт backend и проверка в логах: `[RECOVERY] Skipping recovery for новая_книга_1788747351369 — book not registered`; количество ключей книги не растёт; keep-книги восстанавливаются/читаются штатно.
3. Тогда же (по желанию) можно вручную удалить 5 ключей удалённой книги — Stage 63 чинит причину повторного появления, но сами ключи остаются до ручной чистки или `cleanBookRedisKeys`.
4. В production-логах после rollout искать также `[RECOVERY] registry check failed … fail-closed` — если PG будет недоступен в момент старта, recovery просто пропустится (безопасное поведение).
