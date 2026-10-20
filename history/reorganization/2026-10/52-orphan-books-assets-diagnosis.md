# Этап 52 — Диагностика книг, потерянных из `scenes`, и 450 записей `scene_assets` с `build_id=NULL`

**Дата:** 2026-10-14
**Статус:** ✅ **PASS** — причины установлены и доказаны read-only данными; написан минимальный детектор дрейфа (SELECT-only), фикс предотвращения рецидива (`/regenerate` материализует `scenes`), 8 регрессионных тестов; полный набор тестов 3206 passing / 28 pending / 4 failing (failure-set идентичен базе stage 49/50/51). **Production rollout, изменения данных и схем — не выполнялись** (п.9–11).

## 1. Скоуп и запреты

Задача: выяснить, почему книга `import_1786345731767_1786345734345` (владелец сцен Case A `ch-1bb5123c:sc-5f18dd0f` и Case B `ch-37eadabb:sc-5f0068ca`) отсутствует в таблице `scenes`, хотя имеет 427 строк `scene_assets`, 17 `generation_tasks`, 26 `image_units`, Redis-состояние и канонический бандл на диске; и почему в `scene_assets` 450 строк с `build_id=NULL`.

Запреты соблюдены: без production rollout, без изменения production-данных/схем, без публикации npm, без запуска генерации, без удаления assets/output/books, без перезапуска сервисов. Все обращения к PG/Redis — read-only (`psql`/`redis-cli` SELECT/GET/LRANGE/SCAN).

## 2. Кросс-таблица источников истины (снимок 2026-10-14)

Источники, которые утверждают «какая книга/сцена существует»: `books`, `scenes` (= `listBooks` = `SELECT DISTINCT book_id FROM scenes`, `runtime-persistence-adapter.js:195`), `scene_assets`, `generation_tasks`, `image_units`, `/data/books/*/book.json`, Redis (`animastor:chunk:*`, `book-scenes:*`, event-journal).

| book_id | books | scenes | scene_assets | gen_tasks | IU | диск | Redis chunks |
|---|---|---|---|---|---|---|---|
| `import_1786345731767_1786345734345` (**Case A/B**) | ✓ 08-20 02:02 | **✗ 0** | **427** | 17 | 26 | ✓ 08-10 | 34 |
| `ba_1788172242081` | ✓ 08-31 10:30 | ✓ 8 | 26 | 0 | 32 | ✓ | 21 |
| `новая_книга_1789374776899` | ✓ 09-14 08:32 | ✗ | 1 (placeholder) | 0 | 0 | ✓ | 1 |
| `новая_книга_1791640039242` / `…71055` | ✓ 10-10 | ✗ | 0 | 0 | 0 | ✓ | 0 |
| `новая_книга_1788747351369`, `…1788754457378`, `…1788754462605`, `…1788756291018` | ✗ | ✗ | 1 | 0 | 0/1 | ✓ | 1 |
| `import_1783656905372_…`, `import_1784518044598_…` (**зеркальные сироты**) | ✗ | **✓ 3 / 1** | 25 / 12 | 0 | 42 / 24 | ✗ | 0 |
| `book-1`, `b`, `test-edit`, `smoke_book`, `ghost_book` (остатки тестов) | ✗ | ✗ | 6/1/1/0/0 | 0 | 9/9 | ✗ | 0 |

Итог: **ни одна из 5 строк `books` не имеет ни одной общей сцены с `scenes`** — таблица `scenes` (12 строк / 3 book_id) и реестр `books` (5 book_id) описывают почти непересекающиеся множества. Это системный, не разовый дрейф.

## 3. Case A/B — доказанная хронология

| Когда (UTC) | Событие | Источник |
|---|---|---|
| 08-10 07:08:51–07:19:59 | TXT-импорт: `source.txt`, `book.json`, 5 сцен, `build_import_…`; Redis-чанки; **placeholder-строки `scene_assets` (status='placeholder', build_id=build_import_…)** + `BOOK_SCENE_TOTAL/NEXT` | `book_id`-ts, mtimes `/data/books/…`, `import-routes.cjs:294` (синхронная ветка: fresh chunks) |
| 08-10 07:19 → 08-13 14:29 | **Удаление импортных строк `scene_assets`** (≥5 placeholder-строк с created_at 08-10 отсутствуют; earliest выжившая строка = 08-13 14:29:28) | сравнение created_at; контроль: у других книг импортные placeholder-строки выживают (`ba_` — 9 шт., `новая_книга_1789…` — 1 шт., created_at = момент импорта) |
| 08-13 14:29–14:34 | Первая генерация: аудио/чанки/IU-файлы; создание 4 audio-строк (build-scoped), 17 `generation_tasks`, 26 `image_units` | PG created_at, mtimes `output/build_import_…` (earliest файл 08-13 14:32) |
| 08-13/08-14 | Журналы сцен (Redis) начинаются (`SCENE_RESET_STARTED`, `DISPATCH_STARTED`), Case A аудио готово 08-14 09:22 | Redis `event-journal:*` |
| 08-16 → 08-24 | ~50 image-`markReady`/день для `ch-37eadabb:sc-5f0068ca` → **409 строк image с build_id=NULL** (один и тот же путь `…_iu-64e77055.png`) | created_at дублей |
| 08-20 02:02:24 | Создана строка `books` (ensureBook — только из `workspace-ownership.js:75`; **импорт `books` не пишет**) | `books.created_at` ≠ book_id-ts |
| 08-24 | Создана строка `book_source` | PG |
| 08-28 03:02:32 | Один `markStale` без buildId переводит все 409+ image-строк сцены в `stale` | одинаковый `updated_at` |
| после 08-13 | **`scenes` не пересоздана никогда**: ни импортом, ни `/regenerate`, ни editor-reconcile | 0 строк + **0 штампов версий** на всех 427 строках (`scene_content_version`/`scene_audio_config_version` = NULL у 100% строк → `markSceneAssetsStale` (`book-sync.js:215`) для этой книги не выполнялся ни разу) |

## 4. Причина (два независимых слоя)

### Слой 1 (доказан): удаление производного состояния в окне 08-10…08-13

Удаление импортных `scene_assets`-строк доказано (§3). Кандидаты, **исключённые**:

- `book-deletion.deleteBook` (`book-deletion.cjs:71`) — шаг 2 удаляет диск-бандл и snapshot; `source.txt`/`book.json`/`*.snapshot.json` выжили → не он.
- `scene-asset-registry.deleteSceneAssets/deleteBookAssets/deleteBuildAssets` — экспортируются, но **не имеют ни одного production-вызова**.

Кандидаты, **оставшиеся** (оба — «частичная очистка производного состояния без последующего пересоздания»):

1. `DELETE /api/v1/book/:bookId/cache` (`cache-routes.cjs:44-130`): удаляет 18 PG-таблиц включая `scenes` и `scene_assets`, Redis-ключи книги и build-каталог; **сознательно сохраняет** `books`, `book_source`, `book_snapshots`, `book_events` и `/data/books`.
2. `book-sync.purgeRemovedSceneRows` (`book-sync.js:294`) через reconcile с пустым/другим fingerprint: `getBookFingerprint` (`book-source.js:147`) возвращает **пустую Map**, если `bookLoader.loadBook` → null, и тогда все существующие ключи выглядят «removed» (purge assets/tasks/IU, затем `scenes`); Redis/FS не трогает.

**Разделить их по выжившим данным невозможно**: все импортные артефакты Redis (чанки, `BOOK_SCENE_*`, журналы) и файлы build-каталога были перезаписаны генерацией 08-13/08-14; логов за 08-10…08-13 нет (контейнеры пересоздавались, ротация не настроена), `book_events`/`reconciliation_events` пусты, pg-дампов нет. Для вывода принципиально, что **любой** из двух путей приводит к одинаковому наблюдаемому состоянию, а защита от него одна и та же (слой 2).

### Слой 2 (системная причина невидимости — устранена фиксом): `scenes` не пересоздаётся никогда

`scenes` — лениво наполняемая производная таблица. Её писатели в production:

- editor-save reconcile → `book-sync.updateSceneHashes:206` (INSERT…ON CONFLICT) — вызывается **только** из editor-routes/`entity-cleanup`;
- `scene-assets-repo.ensureSceneRow:364` — вызывается **только** из `setDirtyUnitIds`/`clearDirtyUnitIds`, т.е. только когда `/regenerate` передал непустой `dirty_unit_ids` (image-сцены).

Импорт (`import-routes.cjs`) и `/regenerate` (сознательно, комментарий `generation-routes.cjs:560-565`) в `scenes` не пишут. Поэтому:

1. после любой очистки `scenes` (слой 1) и до первого editor-сохранения с непустой диффой книга **не существует** для `listBooks`;
2. C8 `rebuildWorkList` и `reconciliation-engine.js:2219/2300` берут книги именно из `listBooks` → сцены Case A/B не попадают в active index, регенерация аудио не стартует (наблюдаемый эффект stage 50/51);
3. повторный `/regenerate` по «спящей» книге ситуацию **не чинил**: он выполнял `resetScenes`/диспатч, но без `ensureSceneRow` (срабатывал только при image-`dirty_unit_ids`), т.е. книга оставалась невидимой.

Доказательство, что editor-reconcile для книги не выполнялся: **0 штампов версий** на 100% строк `scene_assets` (штампы проставляет только `markSceneAssetsStale`, а он требует существующих строк `scenes`).

### Зеркальный дрейф (обратный знак) и schema drift

`import_1783656905372_…` и `import_1784518044598_…`: есть `scenes` (3/1), `scene_assets` (25/12), `image_units` (42/24), но **нет** `books` и `/data/books`. В production-БД на `scenes.book_id` **нет FK** (`\d scenes`: только PK + CHECK), хотя `schema.js:165` объявляет `REFERENCES books ON DELETE CASCADE` — `CREATE TABLE IF NOT EXISTS` не добавляет FK в существующую таблицу (schema drift). Каскад не работает → дочерние строки переживают удаление `books` (например, `guest-repo.purgeExpired` удаляет `books` по workspace), а диск-бандл удаляется отдельным чистильщиком.

## 5. NULL `build_id` (450 из 503 строк)

- `scene_assets` UNIQUE `(book_id, chapter_id, scene_id, asset_type, build_id)` при `build_id IS NULL` **не дедуплицирует** (NULLS DISTINCT): каждый `upsertAsset`/`markReady` с NULL вставляет новую строку. Доказано тестом (§8): два `upsertAsset(... build_id: null)` → 2 строки; та же клавиша с `build_id='build-real'` → легитимная 3-я строка.
- 450 NULL-строк / 23 ключа / **427 избыточных строк**; дубликаты: `ch-37eadabb:sc-5f0068ca image` ×**409** (08-16…08-24, ~50/день), `ch-1bb5123c:sc-a740d763 video` ×5, аудио-ключи у ghost-книг ×8/×3/×3/×4, `ba_…` ×2.
- Писатели с `buildId = null` по умолчанию: `orchestrator.js:193 persist('sceneAssets.markReady')` (вызывается из `completeStage` **без** buildId), `scene-asset-registry.js` (defaults), `book-sync.js:245` (синтетическая audio-строка). Все image/video-строки — только NULL.
- Корректное поведение в границах: `getAsset` при NULL build_id читает fallback-строку; `markStale` без buildId обновляет все строки типа; version-gate в `orchestrator.js:150-155` для сцены без строки `scenes` fail-open.
- **Фикс требует изменения схемы** (`NULLS NOT DISTINCT`/partial unique index + миграция дедупликации) — запрещены на этом этапе; детектор (§6) фиксирует объём.

## 6. Минимальное обнаружение (сделано)

Новые файлы:

- `backend/src/services/orphan-books-audit.js` — read-only кросс-проверка всех источников истины; **только SELECT** (принимает инъекционный `query`, сам `postgres/database` не импортирует — соблюдён SQL-boundary `tests/architecture/sql-boundary.test.js`);
- `backend/scripts/audit-orphan-books.js` — CLI (`BOOKS_DIR=… node scripts/audit-orphan-books.js [--strict]`; `--strict` → exit 1 при находках).

Классы: **I** `books_without_scenes` (невидимые для `listBooks`), **II** `scenes_without_books` (зеркальные сироты), **III** `disk_books_without_scenes` (бандл без регистрации в PG), **IV** `null_build_id_duplicates`.

Текущий прогон на production-данных: **23 issues** (лог `/tmp/opencode/audit-final-52.log`):

- I: 13 книг — `import_1786345731767_…` (assets=427, tasks=17, iu=26, books_row=yes, disk=yes), `новая_книга_1789374776899` (books_row=yes, disk=yes), 4× `новая_книга_17887…` (disk=yes, books_row=no), `new_1791640039242/71055` (books_row=yes, disk=yes, derived=0), тестовые остатки (`book-1`, `b`, `test-edit`, `smoke_book`, `ghost_book`);
- II: `import_1783656…` (3 сцены), `import_1784518…` (1 сцена);
- III: `новая_книга_1788754459266`;
- IV: 7 NULL-ключей, 427 избыточных строк (§5).

## 7. Фикс кода (без rollout)

`backend/src/routes/book/generation-routes.cjs:537-562` — `/regenerate` теперь для **каждой** сцены `filteredDirty` (все слои, не только image) вызывает `sceneAssetsRepo.ensureSceneRow` **до** `resetScenes`/`setDirtyUnitIds`:

- `INSERT … ON CONFLICT DO NOTHING` — идемпотентно, без bump'а версий;
- fail-open (try/catch + `typeof`-guard) — недоступный репозиторий не блокирует генерацию;
- закрывает слой 2: активная книга, оставшаяся без строк `scenes`, материализуется при первом же regenerate и снова видна `listBooks`/C8.

Почему именно здесь: `/regenerate` — единственная точка, где генерация гарантированно касается конкретного списка сцен и где в инциденте 08-13 книга всё ещё могла быть спасена (очистка произошла **до** первой генерации; все строки 08-13+ выжили бы). Восстановление уже потерянных строк Case A/B — data-repair, отдельным этапом (запрещено здесь).

## 8. Тесты (сделано)

- `backend/tests/orphan-books-diagnosis.test.js` (6): Class I (активные derived-строки без `scenes` → flagged, `listBooks`-эквивалент не содержит книгу); recovery-примитив (`ensureSceneRow` очищает находку, идемпотентен, книга становится видима); Class II (ghost scenes → flagged, исчезает после `books`-строки); Class III (бандл в изолированном temp-`booksDir`, без пересечения с Class I); Class IV (NULL build_id не дедуплицируется: 2 NULL-строки + 1 build-scoped → dup-key rows=2, redundant>0, `countIssues` = сумме классов); read-only-инвариант (все выданные audit'у SQL — SELECT).
- `backend/tests/generation-routes.test.js` (+2): `/regenerate` вызывает `ensureSceneRow` для каждой dirty-сцены до reset (порядок важен: `resetScenes`/`setDirtyUnitIds` — UPDATE, который без строки ничего не делает); fail-open при отказе `ensureSceneRow` (200 + задача создаётся).

Прогон: `pretest` OK; таргетированный 18 passing; **полный: 3206 passing / 28 pending / 4 failing** (`ai-endpoint-sharing.test.js:688`, `ai-shared-inference.test.js:806`, `installer-package-boundary.test.js:243`, `phase5-runtime-result.test.js:401`) — идентичен базе stage 49/50/51, все 4 pre-existing. Прирост = ровно 8 новых тестов. (`npx mocha --exit "tests/**/*.test.js"`.)

## 9. Что НЕ делалось (сознательно)

1. Production rollout / перезапуск сервисов — код изменён только в git-рабочем дереве; контейнер `animastor-backend` работает на прежнем image `sha256:8440ced7…`.
2. Миграция NULL `build_id` (schema change) и data-repair строк `scenes` для Case A/B — отдельные этапы.
3. Изменение production-данных: ни одной INSERT/UPDATE/DELETE вне тестовых book_id с последующей очисткой (`test-orphan-audit-*`, удалены в `afterEach`).
4. Расширение `listBooks` (смена семантики discovery) — отклонено как не-minimal: без материализации сцен C8 всё равно не получил бы сцены; покрывается детектором.

## 10. Недостающие данные и как их безопасно получить

Не хватает: backend-логов 08-10…08-13 (выводов `[CACHE] Cache cleared for …`, `[BOOK-SYNC] RECONCILE … purged`), записей `reconciliation_events`/`book_events`, pg-дампов. Способы (на будущее, без вмешательства сейчас):

1. json-file ротация логов backend-контейнера (`max-size`/`max-file`) — фиксация `[CACHE]`, `[DELETE-BOOK]`, `[BOOK-SYNC]` на постоянной базе;
2. писать событие в `reconciliation_events` при purge и в `book_events` при cache-clear/deleteBook (сейчас purge молчит);
3. периодический `pg_dump` (только данные) в `/home/animastor/backups` — сейчас в тарах есть только исходники;
4. при рецидиве: сверка `books.created_at` vs book_id-ts (как здесь: 08-20 vs 08-10 — маркер позднего пересоздания `books`) и created_at min по `scene_assets` (маркер окна удаления).

## 11. Артефакты

- Детектор: `backend/src/services/orphan-books-audit.js`, `backend/scripts/audit-orphan-books.js`
- Фикс: `backend/src/routes/book/generation-routes.cjs` (+23 строки)
- Тесты: `backend/tests/orphan-books-diagnosis.test.js` (новый), `backend/tests/generation-routes.test.js` (+2)
- Логи прогонов: `/tmp/opencode/audit-final-52.log`, `/tmp/opencode/full-suite-52b.log`
- Изменённые файлы в git: `M backend/src/routes/book/generation-routes.cjs`, `M backend/tests/generation-routes.test.js`, `?? backend/scripts/audit-orphan-books.js`, `?? backend/src/services/orphan-books-audit.js`, `?? backend/tests/orphan-books-diagnosis.test.js` (не коммитилось — коммит не запрашивался)
