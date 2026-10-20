# Stage 72 — Verify NULL prevention and resolve the READY twin

**Вердикт: PASS**

Дата: 2026-10-19 (окно 03:53–04:15 UTC)
Область: проверка записи через `markReady`/`iu-repo` (изолированный тест) + read-only разбор строк `48353`/`21338`.
**Код, схема, конфигурация, деплой — не менялись. Коммитов нет. Генерация не запускалась.**
Исторические NULL-строки (437), обе сохранённые книги, файлы `book.json`/output/assets — не тронуты.
Отчёты предыдущих стейджей: `70-historical-null-build-id-classification.md`, `71-build-id-rollout-and-versions-endpoint.md`.

Рабочие артефакты: `/tmp/opencode/stage72/` (`snapshot.sh`, `baseline.txt`, `pre-prod.txt`, `post-prod.txt`,
`final.txt`, `verify-write-path.js`, `testdb-run1.log`, `mocha-testdb.log`, `prod-run1.log`,
`rows-5f18dd0f-audio.txt`, `versions-import.json`, `schema.sql`).

---

## 0. Production baseline (зафиксирован до работ, 04:01 UTC)

| Проверка | Значение |
|---|---|
| Образ / OCI revision | `ghcr.io/animastor/animastor-backend@sha256:2d552ec02f3ef6b0ec9684a336c821a2562e8717e7452618cffdf4ca44e0b4d0`, rev **`a7c5827`**, tag `deploy-a7c5827` (Stage 71) |
| Контейнер | started `2026-10-18T16:00:13Z`, restarts **0** |
| health | `GET https://localhost/health` → **200** `{"status":"ok","loop":true,"redis":"PONG"}` |
| `scene_assets` всего / `build_id IS NULL` | **459 / 437** (ba_ 9, import_ 428); `max_id=48353`, `max(updated_at)=1792339221` |
| `image_units` всего / NULL | **58 / 0** |
| `books` / `scenes` | **2 / 13** |
| per-book `scene_assets` | `ba_` 26 (9 null, 0 ready, 17 stale, 9 placeholder); `import_` 433 (428 null, **18 ready**, 413 stale, 2 pending) |
| md5 всех строк `scene_assets` (row_to_json по id) | `9e0b3001ae826179c38ef3e5d2915200` |
| md5 всех строк `image_units` | `01538346da61d1300cf201bc62da2747` |
| SHA-256 `ba_/book.json` | `e50bcc6147d9331af6409947ef84ff93c5f5ee20bef2d7af69b681c1ae295ae2` |
| SHA-256 `import_/book.json` | `60e6e4b11f77a9a650b709b525f4643fab0d6e81a311155933927abb4a0a26ea` |
| строки `48353` / `21338` | `stale/NULL` и `ready/build_import_…`, `updated_at=1792339221` |
| тестовых строк (`test%`, `ghost%`, `*stage66*`) | **0 / 0** |

Локальный источник == прод-образ по записи-путевым файлам (sha256, 7/7 OK):
`database.js`, `scene-assets-repo.js`, `iu-repo.js`, `runtime-persistence-adapter.js`, `postgres/index.js`,
`schema.js`, `book-sync.js`. `git HEAD = e8c0a52` (дерево Stage 71); посторонние изменения рабочего
дерева те же 5 позиций, что и до стейджа — **не трогались**.

В окне работы рантайм был активен (image-диспатчи для `sc-45c789c6`/`sc-5f18dd0f`), поэтому все сравнения
делались по **md5 полных таблиц**, а не только по счётчикам.

---

## Часть A. Проверка новых NULL — PASS

### A.1 Доступный изолированный путь записи

Путь, которым реально пишет прод (и который проверялся):

```
orchestrator.completeStage  →  persistence-port 'sceneAssets.markReady'
                             →  storage/runtime-persistence-adapter.sceneAssets.markReady
                             →  scene-assets-repo.markReady → upsertAsset
                                (build_id из buildIdFromArtifactPath(path), Stage 66)
iu-processor.saveIUMetadata →  iu.upsertImageUnit → postgres/repositories/iu-repo.upsertImageUnit
                                (assertBuildId — build_id обязателен, Stage 66)
```

Изолированный доступ:
1. **Отдельная тестовая БД** — эфемерный контейнер `stage72-tb` (`postgres:16`, `127.0.0.1:55433`,
   БД `animastor_stage72`), схема загружена `pg_dump --schema-only` из прод (2183 строк, данные не копировались).
   Контейнер после тестов **удалён** (`docker rm -f`) — `docker ps -a` не содержит `stage72*`.
2. **Production** — тот же скрипт выполнен **внутри запущенного контейнера**
   (`docker exec -i animastor-backend node`, `BACKEND_DIR=/app`, прод-окружение `PG_HOST=postgres`),
   т.е. на прод-коде и прод-БД, с уникальными тестовыми id и гарантированной очисткой.

Тестовые идентификаторы — уникальные на каждый запуск (`Date.now-pid-rand`):
`test72-<run>` / `ch-test72-<run>` / `sc-test72-<run>` / `build_test72_<run>` (+ `-iu`).
Скрипт **не ссылается ни на один прод-идентификатор книги**, не пишет в `scenes`/`books`
(cleanup подтверждает `scenes:0, books:0`), не создаёт файлов (markReady — чистая SQL-запись).

Дополнительно прогнан штатный набор Stage 66 `backend/tests/markready-build-id-idempotency.test.js`
против **изолированной** тестовой БД: **18 passing / 0 failing** (`mocha-testdb.log`).
В прод этот набор сознательно **не** запускался: он создаёт временные строки в `scenes`
(тест `stampSceneVersionsForDispatch`), а `listBooks = SELECT DISTINCT book_id FROM scenes` →
фейковая книга на мгновение попала бы в worklist активного рантайма.

### A.2 Результаты — 13/13 в обеих средах

| # | Проверка | Изолированная БД | Production (внутри контейнера) |
|---|---|---|---|
| A1 | первый `markReady` штампует `build_id` из пути | PASS (`build_test72_…`) | PASS (`build_test72_mveqdcra-207-tq0iuy`) |
| A2 | ровно одна каноническая строка | PASS (1) | PASS (1, `id=49163`) |
| A3 | stamped-запись не создаёт NULL-строку | PASS (0 null) | PASS (0 null) |
| A4 | 3 повторных вызова → тот же `id`, 1 строка | PASS (1/1/1/1) | PASS (49163 ×4) |
| A5 | **5 конкурентных** вызовов → 1 строка, один `build_id` | PASS | PASS (все `49163`) |
| A6 | ноль NULL-дубликатов после repeat+concurrent | PASS | PASS |
| B1 | `iu-repo`: upsert ×3 → 1 строка с реальным `build_id` | PASS | PASS |
| B2 | `iu-repo`: 3 конкурентных upsert → 1 строка | PASS | PASS |
| C1 | **нет build-контекста (iu)**: `null/undefined/""/"   "` → ошибка `build_id is required`, 0 строк | PASS (4/4 отклонено) | PASS (4/4 отклонено) |
| C2 | row для отклонённого no-build вызова отсутствует | PASS (0) | PASS (0) |
| C3 | **нет build-контекста (markReady)**: путь вне `OUTPUT_DIR` → предсказуемый завершшение: `build_id=NULL`, 1 строка на ключ, повтор и 2 конкурентных → тот же `id` | PASS | PASS (`49172`×2, конкурентные `49173`) |
| C4 | legacy-NULL и stamped-строки не смешиваются и не размножаются | PASS (1 stamped + 2 NULL) | PASS (1 + 2) |
| Z1 | **очистка**: все тестовые строки удалены (scene_assets/image_units/scenes/books) | PASS (0/0/0/0) | PASS (0/0/0/0) |

Итог: **13/13 PASS** в изолированной БД и **13/13 PASS** в production → вердикт `PASS` в обоих логах.

Что это доказывает по существу критерия Stage 71 §9а («NOT VERIFIED — новых NULL-записей не было»):
* **корректная запись с `build_id`** — новая строка всегда получает конкретный `build_id` из build-каталога;
* **идемпотентность** — повторные и конкурентные записи одного артефакта остаются одной канонической
  строкой (advisory-lock `lockNullBuildKey` + `ON CONFLICT` для stamped-ключа, UPDATE-canonical для
  legacy-NULL-ключа) — новых NULL-дубликатов не плодится ни в одной из сред;
* **отсутствие build-контекста** — `image_units` отклоняет запрос жёстко (predictable error, ноль строк,
  «некорректная запись» не создаётся); `markReady` без выводимого build-контекста завершается
  предсказуемо и **не плодит дубликаты**: пишется ровно одна legacy-NULL строка на ключ
  (это легальный legacy-shape для `scene_assets`, колонка NULLable; в прод такой вызов возникает только
  для артефактов вне `OUTPUT_DIR` — сам прод-путь всегда строит путь из build-каталога).

### A.3 Возврат к baseline — PASS

| Проверка | baseline (04:01) | после теста (04:04) | финал (04:12) |
|---|---|---|---|
| `scene_assets` / NULL | 459 / 437 | 459 / 437 | 459 / 437 |
| `image_units` / NULL | 58 / 0 | 58 / 0 | 58 / 0 |
| `books` / `scenes` | 2 / 13 | 2 / 13 | 2 / 13 |
| per-book (ba_ / import_) | 26+9 / 433+428, ready 0 / 18 | идентично | идентично |
| md5 `scene_assets` | `9e0b3001ae826179c38ef3e5d2915200` | `9e0b3001…` | `9e0b3001…` |
| md5 `image_units` | `01538346da61d1300cf201bc62da2747` | `01538346…` | `01538346…` |
| строки `48353` / `21338` | `stale/NULL` / `ready/build_…` | идентично | идентично |
| SHA-256 `book.json` (обе) | `e50bcc61…` / `60e6e4b1…` | идентично | идентично |
| тестовые строки | 0 | 0 | 0 |
| health / restarts | 200 / 0 | 200 / 0 | 200 / 0 |

`diff baseline.txt final.txt` (без строки времени) — **пустой**: все 459 строк `scene_assets` и все 58 строк
`image_units` побайтово идентичны baseline, т.е. **ни одна историческая строка не изменена и не удалена**.
Во время прогона в production счётчики уходили в `462/439/59` (только тестовые строки) и после cleanup
вернулись в `459/437/58` — атрибутируется исключительно по `book_id` тестовой книги.

### A.4 Подтверждённые изменения данных (единственные за стейдж)

1. INSERT + DELETE 3 строк `scene_assets` и 1 строки `image_units` под `book_id='test72-<run>'`
   (production) — **нетто-эффект 0**; cleanup-отчёт скрипта: `{"scene_assets":3,"image_units":1,"scenes":0,"books":0}`.
2. Продвинулись курсоры identity-последовательностей (штатный gap, строк не создаёт и не теряет):
   `scene_assets_id_seq = 49173` (прогон потребил ровно 11 nextval: 49163…49173 — по 1 на INSERT и по 1 на
   каждый `INSERT … ON CONFLICT`, включая конфликтные), `image_units_id_seq = 253671` (+6 по построению скрипта).
3. Эфемерный контейнер `stage72-tb` создан и удалён. Файлы в `/data/output` и `/data/books`,
   изменённые после 03:55, — **0**; файлов `*test72*` в output — **0**.
4. `git status` не изменился (те же 5 посторонних позиций), коммитов/деплоев/миграций не было.

---

## Часть B. Строки 48353 и 21338 — PASS (без изменения данных)

### B.1 Полные поля обеих строк

| Поле | **21338** | **48353** |
|---|---|---|
| `book_id` | `import_1786345731767_1786345734345` | то же |
| `chapter_id` / `scene_id` | `ch-1bb5123c` / `sc-5f18dd0f` | то же |
| `asset_type` | `audio` | `audio` |
| `build_id` | `build_import_1786345731767_1786345734345` | **NULL** |
| `status` | **`ready`** | **`stale`** |
| `path` | `/data/output/build_import_…/import_…_ch-1bb5123c_sc-5f18dd0f.mp3` | **то же самое значение, байт-в-байт** |
| `duration_sec` / `format` / `sample_rate` / `channel_count` | `74.904` / `mp3` / `24000` / `1` | `NULL` / `NULL` / `NULL` / `NULL` |
| `chunks` / `scene_hash` / `error` / `metadata` | `NULL` ×4 | `NULL` ×4 |
| `created_at` | `1786631368` = 2026-08-13 02:29:28 | `1792293468` = 2026-10-18 03:17:48 |
| `updated_at` | `1792339221` = 2026-10-18 16:00:20–21* | то же |
| `scene_content_version` / `scene_audio_config_version` | `1` / `1` | `1` / `1` |

\* `EXTRACT(EPOCH FROM NOW())::bigint` в PostgreSQL **округляет**, а не отсекает: `1792339220.632::bigint = 1792339221`
(проверено в psql), поэтому `updated_at=1792339221` соответствует реальному окну 16:00:20.5–21.5.

**Семья ключа** `(import_, ch-1bb5123c, sc-5f18dd0f, audio)` — 5 строк (не 2):
`21338` (versioned, ready) + NULL-дубли `21484` (создан 2026-08-14 09:22:27), `48348` (2026-10-17 15:59:07),
`48351` (2026-10-18 03:12:56), `48353` (2026-10-18 03:17:48) — все `stale`, все с тем же `path`.

### B.2 Сопоставление с файлом, manifest, сценой и версией билда

| Источник | Значение | Совпадение |
|---|---|---|
| Файл на диске | `299 853` байт, mtime `2026-08-14 09:22`, sha256 `24b110ba930ba4a9036dec6cade9a300c9182c14c25052f470bce311a840e54a`; `find /data/output -name '…_sc-5f18dd0f.mp3'` → **ровно 1 путь** | путь `21338` == путь `48353` == единственный файл |
| Фактические метаданные файла (`music-metadata`) | `duration 74.904`, `sampleRate 24000`, `channels 1`, `MPEG 2 Layer 3` | **точное совпадение** с полями `21338`; у `48353` эти поля `NULL` |
| `manifest.json` книги | `vbook_version 3.1`, `book_id import_…`, **`build_id build_import_1786345731767_1786345734345`** | == `build_id` строки `21338`; у `48353` `NULL` |
| `book.json` | `version 3.0`, `book_id import_…`, `updated_at 2026-08-10` | книга версионная (build-схема) |
| `scenes` (`sc-5f18dd0f`) | `content_version=1`, `audio_config_version=1`, `is_dirty=f`, `dirty_unit_ids={}` | штампы **обеих** строк = `1/1` — версии согласованы |
| Redis | `asset-state: … audio = ready`, `17/17 chunk:…_0001…0017`, `audio-orch` присутствует | артефакт фактически ready |
| `GET /api/v1/book/import_…/versions` | `scene_count 5`, `asset_count 433`, **`mismatch_count 0`**; по сцене ровно 5 audio-строк (4 `stale/NULL` + 1 `ready/build_import_…`) + image `pending` | версионный слой согласован |

### B.3 Twin-доказательство — 21338 действительно тот же артефакт

Не «похожий файл», а каноническая versioned-строка **того же** артефакта:
1. `path` у `21338`, `48353`, `21484`, `48348`, `48351` — идентичная строка, а под ней **единственная**
   копия файла во всём `/data/output`;
2. метаданные `21338` (74.904 s / 24 kHz / 1 ch / mp3) — это чтение тех же байтов файла, что и
   независимая проба `music-metadata`;
3. `build_id = manifest.build_id`, каталог `/data/output/build_import_…/` существует;
4. `created_at=21484` (09:22:27) == mtime файла (09:22) — NULL-дубль порождён `markReady` по этому же файлу;
5. штампы версий обоих строк равны версиям сцены, `mismatch_count=0`.

Т.е. `48353` — payload-пустой legacy-дубль (категория **К-4** Stage 70), `21338` — несущая READY-строка.

### B.4 Почему изменился статус 48353 при старте — и является ли это штатным

**Атрибуция: исполнитель — НЕ `book-sync.markSceneAssetsStale`, а `sceneAssetsRepo.markStale`
через `scene-state-ops.markDirtyScene`.** Это корректирует версию Stage 71 §9б; данные при этом
объясняются одинаково (оба UPDATE дали бы одинаковый видимый результат для этого ключа), но лог-доказательства
однозначны:

| # | Доказательство |
|---|---|
| 1 | `docker logs … | grep -c BOOK-SYNC` за весь жизненный цикл контейнера = **0** → `reconcileFromDiff`/`markSceneAssetsStale` (единственные логирующие точки `[BOOK-SYNC]`) **не вызывались вообще** |
| 2 | `2026-10-18T16:00:15.347Z [RECONCILE] [WORKLIST] import_…/sc-5f18dd0f audio: ready → DIRTY → PENDING (valid transitions)` — строка `reconciliation-engine.js:2427` |
| 3 | `…T16:00:15.349Z [ORCH] [DIRTY-SCENE] … cleared for re-dispatch` — эмитится **внутри** `markDirtyScene` (`state/scene-state-ops.js:76`), непосредственно перед PG-записью |
| 4 | `markDirtyScene` → `sceneAssetsRepo.markStale(book, ch, sc, asset, buildId=null)` (`scene-state-ops.js:97`) → `scene-assets-repo.js:218-230`: `UPDATE … SET status='stale' WHERE book/ch/sc/asset_type` **без фильтров `build_id` и `status`** → захватывает все 5 строк ключа, включая `ready`-строки `21338` и `48353` |
| 5 | `grep -c "PG stale write failed"` = **0** → запись выполнилась без ошибки |
| 6 | Далее `…T16:00:20.547 DISPATCH_REQUEST …:audio` → dispatch-time `stampSceneVersionsForDispatch` (`dispatch-engine.js:881`) поднял `updated_at` всех 5 audio-строк до `1792339221`, а `…T16:00:20.632 [PG-AUDIO-READY] … status=ready` → `markReady` со build-путём вернул `ready` **только** versioned-строке `21338` (ON CONFLICT по ключу с `build_id`; NULL-ключ не матчится) → `48353` осталась `stale`. Строки `48344`/`48349` (image, pending) получили `updated_at=1792339221` от dispatch-time штампа image-стадий в те же секунды |

**Пусковой механизм (root cause).** `rebuildWorkList` на старте собирает dirty-маркеры через
`getDirtyMarkers(bookId)` (`runtime-persistence-adapter.js:95-98`, фильтр `status IN ('stale','failed','pending')`
— по книге, **без** фильтра build). Для ключа `sc-5f18dd0f/audio` stale уже лежат NULL-дубли
`21484/48348/48351` → стадия `audio` помечена dirty → `stateMap=PENDING` при Redis-состоянии `ready`
→ ветка «C0 over-mark» (`reconciliation-engine.js` §3-4: `READY→DIRTY` через `markDirtyScene`,
затем `setScenePending`) → PG-побочный эффект `markStale`.

**Шатность? — ДА, это документированное, штатное поведение, существовавшее до Stage 66:**
* `scene-state-ops.js:90-99` — явная пометка «T8: PG side-effect — запись stale статуса (graceful failure)»;
* комментарий `reconciliation-engine.js` — «C0 over-mark (READY без файла) → READY→DIRTY (markDirtyScene) →
  PENDING — self-heal P1 через валидные переходы»;
* триггер — сам факт наличия legacy-NULL stale-дублей в ключе, поэтому цикл повторяется **на каждом старте**;
  он не регрессия Stage 66 и не моя правка данных (деплой неизбежно перезапускает контейнер).
* Потери данных **нет**: `48353` существует, `build_id` остался NULL, путь не изменён, строка не удалена и
  не перепривязана; `ready`-доступ сцены через 5.3 с восстановлен на `21338`.
* **Наблюдаемая разница с прошлым** (не регрессия данных): до Stage 66 та же последовательность
  «stale → markReady» каждый раз чеканила **новую ready-NULL-строку** (так родились `21484` 14.08 09:22,
  `48348` 17.10 15:59, `48353` 18.10 03:17:48 — по секунде после старта контейнера). Сейчас `markReady`
  всегда пишет versioned-ключ, поэтому существующая NULL-строка остаётся `stale` — отсюда «−1 ready»
  у import (15 → 14 non-b1) в сравнении со Stage 64/65.

### B.5 Минимальный план восстановления READY для 48353 (подготовлен, **НЕ выполнялся**)

**Важно: READY самого артефакта уже обеспечен.** READY-gate (`orchestrator.js:160-193`) вызывает
`getAsset(book, ch, sc, 'audio', buildId)` → запрос с `WHERE build_id = $5` (`scene-assets-repo.js:339-353`)
→ возвращает **только** `21338`; условие gate
`asset.scene_content_version >= sv.content_version && asset.scene_audio_config_version >= sv.audio_config_version`
выполняется (`1>=1`, `1>=1`) — это подтверждено живым прохождением gate на старте
(`AUDIO_CALLBACK … READY check passed` → `[PG-AUDIO-READY] status=ready`). `getAsset` без `buildId`
сортирует `ORDER BY (build_id IS NOT NULL) DESC, updated_at DESC` → versioned-строка тоже первая.
Читателям/гейту `48353` **не нужна**; её `stale` лишь кормит dirty-маркер, из-за которого каждый старт
запускает описанный выше self-heal-цикл.

Если задачей ставится буквальный возврат `status='ready'` у `48353` (отдельный стейдж, после проверки):

**Pre-flight (все условия обязаны быть истинны, иначе стоп):**
1. `SELECT content_version, audio_config_version FROM scenes WHERE book/import, ch-1bb5123c, sc-5f18dd0f` → `1/1`;
2. `SELECT status, build_id, path, scene_content_version, scene_audio_config_version FROM scene_assets WHERE id=48353` →
   `stale`, `NULL`, путь `…_sc-5f18dd0f.mp3`, штампы `1/1`;
3. файл существует, единственная копия, sha256 `24b110ba…`, длительность `74.904`;
4. `GET /api/v1/book/import_…/versions` → `mismatch_count = 0`; `getAsset(…, build_import_…)` → `21338 ready`
   (READY-gate вход не меняется);
5. счётчики сверены с baseline: `459/437`, import `433/428/18 ready`.

**Операция** — одна guarded-транзакция, ожидается `rowCount = 1` (никаких массовых UPDATE):
```sql
UPDATE scene_assets
SET status = 'ready', updated_at = EXTRACT(EPOCH FROM NOW())::bigint
WHERE id = 48353
  AND build_id IS NULL
  AND status = 'stale'
  AND scene_content_version >= (SELECT s.content_version FROM scenes s
        WHERE s.book_id = scene_assets.book_id AND s.chapter_id = scene_assets.chapter_id
          AND s.scene_id = scene_assets.scene_id)
  AND scene_audio_config_version >= (SELECT s.audio_config_version FROM scenes s
        WHERE s.book_id = scene_assets.book_id AND s.chapter_id = scene_assets.chapter_id
          AND s.scene_id = scene_assets.scene_id)
RETURNING id;
```

**Пост-проверки:** `rowCount=1`; md5 полной таблицы меняется ровно в одной строке (`id=48353`, только
`status`/`updated_at`); счётчики `459/437` неизменны (NULL не трогаем); `/versions` → `mismatch_count=0`;
SHA-256 обоих `book.json` без изменений; Redis `audio=ready`; health 200; `48353` появляется в ready-списке
наряду с `21338`. **Rollback** — тот же guarded UPDATE обратно в `'stale'`.

**Оговорка о долговечности (обязательна к учёту):** переключение статуса **недолговечно** — пока в ключе
есть stale NULL-соседи (`21484/48348/48351`), `getDirtyMarkers` снова пометит стадию dirty, и при следующем
старте `markStale` (без фильтров status/build) снова переведёт `48353` в `stale`. Долговременное решение —
не переключение статуса, а обработка `48353` по категории **К-4** Stage 70 (удаление дубля с сохранением
READY на `21338`). **В рамках Stage 72 ни `48353`, ни `21338` не изменялись** (финальная сверка:
`21338 ready/build_…`, `48353 stale/NULL`, `updated_at` обеих `1792339221` — как в baseline).

---

## Итог по чек-листу

| # | Пункт | Результат |
|---|---|---|
| A1 | Production baseline зафиксирован (digest/revision/health, счётчики, 2 книги) | ✅ §0 |
| A2 | Изолированный путь записи через `markReady` + актуальный `iu-repo` найден и прогнан | ✅ §A.1 (adapter→repo, iu-repo, штатный mocha 18/18) |
| A3 | Отдельная тестовая книга/build с уникальными id, очистка только тестовых записей | ✅ §A.1/A.2, cleanup 3+1 rows, `scenes/books` не тронуты |
| A4 | Повторные и конкурентные вызовы одного артефакта | ✅ A4/A5 (×3 repeat, ×5 concurrent) |
| A5 | Одна каноническая запись с корректным `build_id`, новых NULL-дубликатов нет | ✅ A2/A3/A6 — в изолированной БД и в production |
| A6 | Нет build-контекста → предсказуемое завершение, без некорректной записи | ✅ C1/C2 (iu: ошибка, 0 строк), C3/C4 (markReady: одна legacy-NULL строка на ключ, идемпотентно) |
| A7 | Счётчики и данные двух книг вернулись к baseline | ✅ `diff baseline final` пуст (md5 обеих таблиц) |
| A8 | Фолбэк на отдельную тестовую БД | ✅ выполнен (эфемерный `stage72-tb`, удалён) — но прод-тест тоже безопасен и выполнен, поэтому **production VERIFIED**, не NOT VERIFIED |
| B1 | Полные поля обеих строк | ✅ §B.1 (+ вся семья ключа из 5 строк) |
| B2 | Сопоставление с файлом/manifest/сценой/версией билда | ✅ §B.2 |
| B3 | `21338` — тот же артефакт, а не похожий файл | ✅ §B.3 (5 независимых улик) |
| B4 | Причина смены статуса `48353` и штатность | ✅ §B.4 (атрибуция скорректирована: `markStale` через `markDirtyScene`; поведение штатное) |
| B5 | Минимальный план восстановления READY с проверкой version stamps и READY-gate | ✅ §B.5 (план, pre/post-чеки, rollback, оговорка о долговечности) |
| B6 | `48353`/`21338` не изменялись | ✅ финальная сверка идентична baseline |
| PASS | Изолированный тест доказал запись с `build_id` + идемпотентность | ✅ 13/13 ×2 среды |
| PASS | Тестовые данные полностью убраны | ✅ 0 строк, тестовый контейнер удалён |
| PASS | Две сохранённые книги не изменились | ✅ md5 строк + SHA `book.json` + per-book счётчики |
| PASS | Все остальные исторические строки сохранены | ✅ md5 `scene_assets` = baseline (459 строк), `image_units` = baseline (58) |

## Запреты — соблюдены

- 437 исторических NULL-строк не изменялись и не удалялись (полный md5 таблицы идентичен baseline);
  строка `48353` не тронута, `21338` не тронута.
- Массовых UPDATE/DELETE/миграций не выполнялось; миграции запускались **только** на изолированной
  тестовой БД (штатным mocha-набором), прод-схема не изменялась (`[PG] Schema initialized` на старте
  контейнера — штатный старт Stage 71, не мой запуск).
- Генерация не запускалась (работающая image-диспетчеризация — собственный рантайм прод, не инициирована мной).
- Конфигурация production не менялась, деплой не выполнялся, коммитов нет, force-push не применялся.
- Посторонние изменения рабочего дерева сохранены и не включались никуда.
- Файлы книг, `output`, assets, bundles не трогались (`find -newermt` → 0 изменённых файлов).

## Оставшиеся риски / наблюдения

1. **Корневая причина dirty-ключа не устранена**: stale NULL-дубли `21484/48348/48351/48353` продолжают
   каждый старт переводить `sc-5f18dd0f/audio` в `ready→DIRTY→PENDING` (шум + повторный dispatch,
   который завершается `already_ready`). Лечение — категория К-4 Stage 70, отдельный стейдж с снапшотом.
2. **`markSceneAssetsStale` (book-sync) в этом контейнере не вызывался ни разу** — при необходимости
   атрибуцию Stage 71 §9б следует поправить в будущем отчёте (последствие для данных нулевое).
3. `GET /versions` показывает по ключу 5 audio-строк, из них 4 `stale/NULL` — ожидаемо до чистки К-4.
4. В прод идёт активная image-генерация (`sc-45c789c6`, `sc-5f18dd0f` — `image=generating`, lease продлевается):
   счётчики `scene_assets`/`image_units` могут сдвинуться по независимой от стейджа причине в любой момент;
   все сравнения ниже опираются на полные md5, снятые в пределах окна 04:01–04:12 (совпали).
5. Побочный эффект теста — только gap-нумерация identity-последовательностей (§A.4), данных не затрагивает.
6. Нюанс интерпретации п.6 Части A: для `scene_assets` «предсказуемое поведение без build-контекста» —
   это **легальная одиночная legacy-NULL строка** (идемпотентная, без дублей), а не отсутствие записи;
   строгое «ноль строк при отсутствии build» выполняется для `image_units` (жёсткий reject). Оба факта
   зафиксированы чеками C1–C4.
