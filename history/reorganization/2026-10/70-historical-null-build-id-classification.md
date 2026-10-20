# Stage 70 — Classify historical NULL build_id records (`scene_assets`)

**Вердикт: PASS** (read-only; все 437 строк классифицированы; данные не изменялись)

Дата: 2026-10-18
Область: **только чтение** — БД (SELECT), файловая система (ls/find/sha256sum), код (read), HTTP GET.
**Никаких UPDATE/DELETE, миграций схемы, генерации, деплоя, коммитов.** Секреты и `.env` в отчёт не включены,
посторонние рабочие файлы не менялись (создан только этот отчёт; временные скрипты — в `/tmp/opencode/`).

Отчёты предыдущих стейджов: `66-image-units-build-id-fix.md`, `67-…`, `68-test-postgres-side-effects-audit.md`,
`69-test-stability.md`.

---

## 1. Снапшот production на момент стейджа (факт, не допущение)

| Проверка | Значение |
|---|---|
| Образ backend | `ghcr.io/animastor/animastor-backend@sha256:9aac015a6990a4134b5a5f482367a9bdc41b251fff8a7a96b45e0eda13bd9560` |
| OCI revision label | `774052504caed92d3af22941cb04052b415e2add` → **rev `7740525`** (Stage 64; Stage 66 `0d9b468` **не задеплоен**) |
| Контейнер | `animastor-backend`, `running`, `restarts=0`, started `2026-10-18T03:17:41Z`, Up 12h |
| Health | `GET http://<backend>:3000/health` → 200 `{"status":"ok","loop":true,"redis":"PONG"}`; `GET https://localhost/health` → 200 |
| `scene_assets` всего | **459** |
| `scene_assets` с `build_id IS NULL` | **437** (`import_…` 428 + `ba_…` 9) |
| `image_units` всего / NULL | **58 / 0** |
| `books` / `scenes` | **2 / 13** |
| `GET /api/v1/books` | 200 (анонимный скоуп показывает только 8 disk-книг без владельца — см. §7) |

Повторный замер в конце сессии (15:25 UTC): `437` и `0` — **счётчики не сдвинулись**.

## 2. Расхождения с формулировкой задания и прошлым аудитом (фиксация, без «автоисправления»)

1. **Таблица.** Задание говорит «437 исторических строк `image_units` с `build_id IS NULL`».
   Факт: `image_units.build_id` — `text NOT NULL`, строк с NULL там **0** (58 строк, все с конкретным build).
   437 NULL-строк — это **`scene_assets`**. Это же исправлено в Stage 66 §1; мои замеры подтверждают Stage 66
   и **противоречат формулировке задания**. Число 437 и разбивка по книгам (428/9) **совпадают** с Stage 68 §6/§8.
2. Stage 66 §2 упоминает «450/503 строк с NULL» — это текст комментария в коде (историческая цифра на момент
   написания), к текущему состоянию отношения не имеет.
3. Никаких других расхождений: `scene_assets`=459, `books`=2, `scenes`=13, `image_units`=58 — как в Stage 66/68/69.

## 3. Методика классификации

Ось А (принадлежность) и ось Б (доказательства → действие). Ось Б даёт **взаимоисключающие** категории с суммой 437.

Для каждой NULL-строки проверялось 7 признаков:
`book_id` → регистрация в `books`; `chapter_id`/`scene_id` → наличие в `scenes`; `asset_type`/`status`;
`path` (тип, существование файла, единственность basename под `/data/output`); наличие **versioned-эквивалента**
в `scene_assets` (тот же ключ + конкретный `build_id`); наличие эквивалента в `image_units` (для image);
ссылки из manifest/других таблиц (FK + содержимое).

## 4. Ось А — принадлежность (все 437)

| Категория | Строк | Доказательство |
|---|---|---|
| **К-1. Принадлежат двум сохраняемым книгам** | **437** (`ba_1788172242081` 9, `import_1786345731767_1786345734345` 428) | обе книги есть в `books` (registered = books-row ownership, Stage 63/64 `isBookRegistered`), в `book_source` (txt), на диске `/data/books/<id>/`, в `scenes` (8+5 сцен) |
| **К-2. Удалённые/незарегистрированные книги** | **0** | `SELECT … WHERE build_id IS NULL AND book_id NOT IN (SELECT book_id FROM books)` = 0; сирот в `scenes` = 0; в `scene_assets` ровно 2 разных `book_id` |
| «Исторические legacy без однозначного build» (по оси Б) | 4 | §5, К-3 |
| «Дубликаты с доказанным эквивалентом» (по оси Б) | 425 | §5, К-4 |
| «Данных недостаточно» (по оси Б) | 2 | §5, К-5 |

Итого по оси А: 437 + 0 = 437 ✅. Категории «принадлежат сохранённым книгам» и «дубликаты/перепривязка» —
пересекающиеся оси; однозначное разложение по действиям приведено ниже.

## 5. Ось Б — доказательства и действия (взаимоисключающие, Σ = 437)

### Сводка

| Категория (действие) | Строк | Состав |
|---|---|---|
| **К-4. Дубликаты с доказанным эквивалентом → УДАЛИТЬ** | **425** | 408 image-дублей + 17 audio-строк |
| **К-6. Канонические строки с доказанным build → ПЕРЕПРИВЯЗАТЬ** | **6** | 3 image + 3 video |
| **К-3. Исторические legacy-строки с недоказуемым build → АРХИВИРОВАТЬ, затем удалить** | **4** | video `25096/25097/25098/25100` (путь `/data/output/b1/…`) |
| **К-5. Данных недостаточно → ОСТАВИТЬ** | **2** | image `48344`, `48349` (synthetic pending, `path IS NULL`) |
| **К-2. Незарегистрированные книги → ничего** | **0** | — |
| **Итого** | **437** | |

### 5.1 Ключи (21 ключ `(book, chapter, scene, asset_type)` на 437 строк)

Дубли внутри ключа: **4 ключа / 420 строк** → 416 избыточных строк; остальные 17 ключов — по 1 строке.

| Книга | Сцена | Тип | NULL-строк | canonical (по `updated_at DESC, id DESC`) | versioned-эквивалент | Файл на диске | Категория |
|---|---|---|---|---|---|---|---|
| import | ch-37eadabb/sc-5f0068ca | image | **409** | `25095` | в `scene_assets` нет; **в `image_units` есть** (`build_import_…`, unit `iu-64e77055` ✓) | basename ровно 1 копия: `/data/output/build_import_…/…_iu-64e77055.png` | canonical → **К-6**, остальные 408 → **К-4** |
| import | ch-1bb5123c/sc-45d38693 | image | 1 | `21344` | `image_units` (`iu-5a1befa0` ✓) | 1 копия в `build_import_…` | **К-6** |
| import | ch-1bb5123c/sc-a740d763 | image | 1 | `25094` | `image_units` (`iu-070ed92b` ✓) | 1 копия в `build_import_…` | **К-6** |
| import | ch-1bb5123c/sc-45c789c6 | image | 1 | `48344` | `image_units` есть, но у строки **нет пути/юнита** | нет ссылки на файл | **К-5** |
| import | ch-1bb5123c/sc-5f18dd0f | image | 1 | `48349` | то же | нет ссылки на файл | **К-5** |
| import | ch-1bb5123c/sc-45d38693 | video | 1 | `21346` | нет нигде | `/data/output/build_import_…/….mp4` **OK** | **К-6** |
| import | ch-37eadabb/sc-5f0068ca | video | 1 | `27577` | нет нигде | `build_import_…/….mp4` **OK** | **К-6** |
| import | ch-1bb5123c/sc-a740d763 | video | **5** | `25101` (путь build-каталога) | нет нигде | `25101` → build-каталог **OK**; `25096–25100` → `/data/output/b1/…` **MISSING** (basename найден только в `build_import_…`) | `25101` → **К-6**, `25096/25097/25098/25100` → **К-3** |
| import | ch-1bb5123c/sc-5f18dd0f | audio | **4** | `48353` | **есть** `build_import_…` (ready, duration 74.904) | путь build-каталога OK (у versioned тот же) | **К-4** (все 4) |
| import | 45c789c6 / 45d38693 / 5f0068ca / a740d763 | audio | по 1 (итого 4) | — | **есть** versioned ready (duration заполнен) | путь build-каталога OK | **К-4** (все 4) |
| ba_ | 8 сцен (1c3d246a, 3c042685, 4bb85e02, 6ef8bb0d×2, 79201cbd, 7cd391e4, 7e229d62, d75dee8e) | audio | **9** | — (по 1–2 на ключ) | **есть** versioned `build_ba_1788172242081` (stale/placeholder) | у NULL-строк `path IS NULL`; файлы versioned-строк в `build_ba_…` **OK** | **К-4** (все 9) |

Σ: 409+1+1+1+1+1+1+5+4+4+9 = **437** ✅; К-6 = 1+1+1+1+1+1 = 6; К-4 = 408+4+4+9 = 425; К-3 = 4; К-5 = 2.

### 5.2 Доказательства по видам связи

**Файлы на диске** (12 различных непустых `path` у 426 строк; 11 строк `path IS NULL`):
- 11 строк с абсолютным путём `build_import_…` → файл **существует по указанному пути**;
- 411 строк с **относительным** путём (только basename): код `buildIdFromArtifactPath()` не может вывести build
  (потому строки и получили NULL), но basename найден **ровно в одной копии** под `/data/output/` — в
  `build_import_…/` → build доказан косвенными уликами + `image_units`;
- 4 строки `/data/output/b1/…` → **папки `b1` нет**, файл по пути отсутствует (basename существует в
  `build_import_…`) → build из пути недоказуем (**К-3**);
- 11 строк `path IS NULL`: 9 ba_ audio (версии не несут файла; файл есть у versioned-строк) + 2 image pending (**К-5**).

**Versioned-эквивалент в `scene_assets`:** 14 из 21 ключа (все 17 audio NULL-строк) → конкретный
`build_id` `build_ba_1788172242081` / `build_import_1786345731767_1786345734345`, который совпадает с
`manifest.json` соответствующей книги и с каталогами `/data/output/<build>/`.
Уникальный ключ `(book_id, chapter_id, scene_id, asset_type, build_id)` → **перепривязка audio невозможна**
(конфликт со существующей versioned-строкой) → только удаление дубля.

**`image_units`:** 58 строк, все с `build_id`; покрывают все 17 сцен ba_ и все 5 сцен import; для image-ключей
`unit_id` совпадает с `iu-…` из имени файла NULL-строки (3 из 3 путевых строк) → доказательство build для image.

**Видео:** versioned video-строк в `scene_assets` нет вообще (22 non-NULL строки — только audio);
build для 3 канонических строк доказан **самим путём**: `/data/output/<manifest.build_id>/<book>_<ch>_<sc>.mp4`
+ существование файла + имя, закодировавшее книгу/главу/сцену.

**Ссылки из manifest и других таблиц:**
- `pg_constraint`: **нет ни одного FK** на `scene_assets` (список FK — только books/workspaces/users/…);
- пустые (0 строк): `output_manifests`, `asset_states`, `asset_dependencies`, `book_events`, `storyboard_elements`,
  `book_snapshots`, `reconciliation_events`, `cache_entries`, `audio_layers`;
- `generation_tasks` — 17 строк: ссылаются на `(book_id, chapter_id, scene_id, task_type)`, колонки `build_id` нет,
  ссылок на id строк `scene_assets` нет;
- `scenes` — 13 строк: **все 21 ключ NULL-строк присутствует в `scenes`** (0 сирот); `scenes.build_id` у всех 13 = NULL;
- `manifest.json` обеих книг: `{vbook_version, book_id, build_id, source, state, created_at, updated_at, import_meta}`
  — ссылок на ассеты нет; `build_id` = `build_ba_…` / `build_import_…` (те же, что у versioned-строк).

**Возраст (историчность):** 409 image-дублей созданы 2026-08-13…2026-08-26, последнее обновление **2026-08-28**
(≈7 недель без изменений). 6 строк созданы 2026-10-17 15:59:07 (секунда после старта контейнера Stage 62) и
2026-10-18 03:17:48 (секунды после старта текущего контейнера) — **их создал pre-66 production-рантайм**
(`markReady`/`stampSceneVersionsForDispatch`/`markSceneAssetsStale`); последнее обновление NULL-строк —
**2026-10-18 03:33:46**. То есть «историческая» масса статична, но 6 строк — свежие и трогаются рантаймом.

## 6. Пункт 4: используют ли runtime-пути legacy-строки

### 6.1 Для versioned-книг — **ДА, используют** (обе книги versioned: `manifest.build_id` + build-каталоги)

| Путь | Где | Что делает с NULL-строками |
|---|---|---|
| `getDirtyMarkers` | `backend/src/storage/runtime-persistence-adapter.js:97-107` (`status IN ('stale','failed','pending')` **без фильтра build_id**) → потребитель `@animastor/orchestration` `src/runtime/reconciliation-engine.js:2353` | читает: из NULL-строк получено **12 dirty-ключей** (ba_ 8 audio + import: image `5f0068ca`, image `45c789c6`, image `5f18dd0f`, audio `5f18dd0f`) → стадии помечаются PENDING в worklist |
| `getDirtyScenesByVersion` | `scene-assets-repo.js:643-679` → `reconciliation-engine.js:2334` | JOIN без build-фильтра; 14 NULL-строк со статусом `ready` участвуют, но у них `scene_*_version IS NULL` → фактически no-op (условие требует non-null) |
| `markSceneAssetsStale` | `backend/src/services/book-sync.js:228-238` | `UPDATE … WHERE status='ready'` по всем строкам ключа, **включая NULL** → штампует версии и ставит stale в legacy-строки |
| `stampSceneVersionsForDispatch` | `scene-assets-repo.js:248-297` | UPDATE всех строк ключа (build не фильтруется) + INSERT синтетической pending-строки **с `build_id IS NULL`** (guard `NOT EXISTS … build_id IS NULL`) → источник строк `48344/48349` |
| `getAsset(…, buildId=null)` / `isSceneReady` / `get*Asset` | `scene-assets-repo.js:339-353` (`ORDER BY (build_id IS NOT NULL) DESC`) | без versioned-строки возвращает legacy-строку: **image/video ключи всегда читаются из NULL-строк** (`scene-asset-registry.js:217-237`, `orchestration/src/runtime/scene-window.js:246-247,283-284` — явный fallback `getAsset(build) \|\| getAsset()`) |
| версионный gate READY | `orchestration/src/orchestration/orchestrator.js:160` | `getAsset(stage, buildId)` → для image/video возвращает `null` → `shouldWriteReady=false` (fail-closed). Существующие NULL-строки **не спасают** gate; перепривязка (К-6) даёт gate строку, но без версии READY всё равно заблокирован до `stampSceneVersionsForDispatch` |
| `getSceneAssets` / `getStaleAssets` / `getOutdatedByHash` / `getOutdatedByVersions` / `getBookAssetSummary` / `getSceneAssetVersions` | `scene-assets-repo.js:355-454,476-493,708-716`; фасад `scene-asset-registry.js:207-256` | читают все строки; `getSceneAssets` схлопывает по `asset_type` → из 409 дублей выбирается **недетерминированная** строка |
| `markStale(..., buildId=null)` | `scene-assets-repo.js:218-230` | апдейтит все строки ключа |
| `deleteBuildAssets(buildId)` | `scene-assets-repo.js:472-474` | `WHERE build_id = $1` → **NULL-строки никогда не удаляются этим путём** (они не «прилипают» к build'ам автоматически) |
| `GET /api/v1/book/:id/versions` | `routes/book/versions-routes.cjs:22,38` | читал бы все строки, но **сейчас отдаёт 500** `{"error":"assetResult is not defined"}` — баг есть и в репозитории, и в прод-образе (sha256 файла репо == контейнеру `b51e9a9a…`) |

**Не используют NULL-строки** (фильтр по build): `image/iu-processor.js:135-140,158-163` (duration-пробы строго по `build_id`).

Практический эффект сейчас: слои `image/video` у `import_…` **выключены** (`layer-config` в Redis и в `book.json`:
`image_enabled=false, video_enabled=false`), у `ba_…` выключены **все** слои → dirty-маркеры из NULL-строк
превращаются в PENDING только для `import_…/audio` (сцена `sc-5f18dd0f`), и там же версии уже совпадают
(`scenes.audio_config_version=1` = versioned-строка) — Redis: `audio=ready`.

### 6.2 Для незарегистрированных книг — **НЕТ**

- строк в `scene_assets` для книг вне `books`: **0**; сирот в `scenes`: **0**;
- worklist строится из `SELECT DISTINCT book_id FROM scenes` (`runtime-persistence-adapter.js:196`) →
  обходятся только 2 зарегистрированные книги;
- recovery-путь читает по `isBookRegistered` с fail-closed гейтом (Stage 63/64, `redis-helpers.cjs:290-303`);
- в Redis есть `asset-state` для disk-only книг (`новая_книга_*`), но это не `scene_assets`-строки, и строк
  NULL-класса для них не существует.

## 7. Рекомендации по категориям (отдельно для каждой) с рисками

> Все рекомендации — **план для следующего стейджа**, здесь ничего не выполнялось.

### К-4. Дубликаты с доказанным эквивалентом — **УДАЛИТЬ** (425 строк)
- **408** — побайтово идентичные (`path`, `status`, версии, метаданные → `count(distinct md5(payload)) = 1`)
  дубли одной image-строки; канон `25095` перепривязывается в К-6 → удаление лишних не меняет ни одного
  dirty-маркера (маркер `image/stale` для `sc-5f0068ca` сохраняется канонической строкой).
- **17 audio** (9 `ba_` + 8 `import_`): у каждого ключа уже есть versioned-строка с тем же build;
  payload NULL-строк строго беднее (`duration_sec`/`path` отсутствуют у ba_ и у ready-import; у import-`stale`
  versioned-строка несёт те же `scene_*_version`). Перепривязка невозможна (unique-конфликт) → только удаление.
- **Риск:** у 9 строк `ba_` единственная в БД штамповка `scene_content_version/scene_audio_config_version`
  (1–2) для этих ключей — versioned-строки их не имеют. **В текущем поведении это инертно** (условия
  `getOutdatedByVersions`/`getDirtyScenesByVersion` требуют `status='ready'`, а versioned-строки ba_ =
  `stale/placeholder`). Опционально: перед удалением скопировать штампы в versioned-строки (guarded UPDATE).
- **Риск:** исчезнет 1 dirty-ключ (`import_…/audio/sc-5f18dd0f`) → worklist перестанет помечать стадию PENDING.
  Проверено: `scenes.is_dirty=false`, `content_version=1/audio_config_version=1`, versioned-строка `ready` со
  версией 1, Redis `audio=ready` → маркер противоречит фактическому состоянию; удаление **выравнивает** БД.

### К-6. Канонические строки с доказанным build — **ПЕРЕПРИВЯЗАТЬ** (6 строк)
- `21344`, `25094`, `25095` (image) → `build_import_1786345731767_1786345734345`;
  доказательство: единственный basename на диске лежит в `/data/output/build_import_…/`, имя закодировано
  `<book>_<ch>_<sc>_iu-<unit>`, и `image_units` содержит `unit_id` с тем же `build_id`.
- `21346`, `27577`, `25101` (video) → тот же build; доказательство: абсолютный путь
  `/data/output/<manifest.build_id>/<book>_<ch>_<sc>.mp4` + файл существует.
- **Условие применения:** только при guard «в ключе нет строки с этим build_id» (сейчас таких строк нет —
  non-NULL в `scene_assets` исключительно audio, проверено). Без предположений, только по перечисленным уликам.
- **Риски:** меняется поведение `getAsset(…, buildId)` (image/video перестают быть «невидимыми» для версионных
  запросов — Stage 66 §6); версионный gate READY **не откроется сам** (строка без `scene_content_version`),
  откроется после очередного `stampSceneVersionsForDispatch` (он штампует и versioned-строки). Слои image/video
  сейчас выключены → прямого эффекта на прод-генерацию не будет. Рекомендуется предварительная проверка на
  копии БД/в тестах Stage 66.

### К-3. Исторические legacy без однозначного build — **АРХИВИРОВАТЬ, затем УДАЛИТЬ** (4 строки)
- `25096/25097/25098/25100`, все `import_/ch-1bb5123c/sc-a740d763/video/ready`, путь `/data/output/b1/…`:
  каталога `b1` нет → артефакт по заявленному пути недоступен, build из пути не выводится;
  они **дубликаты ключа** относительно `25101` (путь в build-каталоге, файл существует).
- **Порядок:** JSON-снапшот 4 строк (+ sha256) → контроль, что `25101` сохранён и после К-6 перепривязан →
  удаление. Иначе сохранить как есть (архив вместо удаления).
- **Риск:** минимальный (нет FK, нет ссылок из manifest/задач/сцен; `deleteBuildAssets` их и так не трогает);
  единственный довод «за» — байтовая идентичность артефакта `b1`/`build_import_…` **не доказуема** (b1 удалён).

### К-5. Данных недостаточно — **ОСТАВИТЬ** (2 строки)
- `48344`, `48349` — image/`pending`, `path IS NULL`, `scene_*_version = 1`, созданы 2026-10-17 15:59:07
  стампером при старте рантайма (не «исторические»). Привязывать не к чему (нет пути/юнита), удаление —
  бессмысленно: маркер будет воссоздан следующим `stampSceneVersionsForDispatch`, а dirty-маркер image
  для этих сцен исчезнет. Оставить до деплоя Stage 66+, затем переклассифицировать.

### К-2. Незарегистрированные/удалённые книги — **0 строк, действий нет**
Продолжать мониторинг в рамках `orphan-books-audit` (Class I–III) — сейчас сирот нет.

### К-1 (ось А). Обе сохранённые книги — **не трогать**
SHA-256 и содержимое подтверждены (§8); чистка затрагивает только `scene_assets`.

## 8. Сверка с сохранёнными книгами и контрольными SHA-256

| Проверка | Контроль (Stage 56/57/60/62) | Сейчас |
|---|---|---|
| `/data/books/ba_1788172242081/book.json` | `e50bcc6147d9331af6409947ef84ff93c5f5ee20bef2d7af69b681c1ae295ae2` | ✅ совпало |
| `/data/books/import_1786345731767_1786345734345/book.json` | `60e6e4b11f77a9a650b709b525f4643fab0d6e81a311155933927abb4a0a26ea` | ✅ совпало |
| `books` / `scenes` | 2 / 13 | ✅ 2 / 13 |
| `image_units` / NULL | 58 / 0 | ✅ 58 / 0 |
| `scene_assets` | 459 (ba_ 26 + import_ 433) | ✅ 459 (та же разбивка) |
| исторические NULL | 437 (import_ 428 + ba_ 9) | ✅ 437 (та же разбивка) |
| строки 25096/25097/25098/25100 | присутствуют (4) | ✅ присутствуют |
| build-каталоги на диске | — | ✅ `/data/output/build_ba_…` (21 файл), `/data/output/build_import_…` (68 файлов) |
| health / API | 200 | ✅ 200 (`/health`, `/api/v1/books`) |

## 9. План безопасной очистки (следующий стейджа; **здесь не выполнялся**)

1. **Сначала деплой Stage 66+** (`0d9b468` или новее). Иначе pre-66 рантайм продолжает создавать/обновлять
   NULL-строки (доказано: 6 строк созданы при старте контейнера 10-17 15:59 и 10-18 03:17; последнее
   обновление 03:33:46). Чистка без деплоя будет недолговечной.
2. **Снапшот:** `pg_dump` таблицы `scene_assets` (файл + sha256) + JSON-выборка всех 437 строк (id, ключи, path, status, версии).
3. **Повторный замер непосредственно перед чисткой:** guard «ровно 437, import_ 428 / ba_ 9»; при отклонении —
   стоп и переклассификация (как предписывает Stage 68 §9).
4. **Порядок партий** (каждая — отдельной транзакцией с guard `rowCount == ожидаемому`):
   a) К-6: 6 × `UPDATE … SET build_id = $build WHERE id = $id AND build_id IS NULL AND NOT EXISTS(версионная строка)` → ожидается 6;
   b) К-4: 408 (image-дубли `id <> 25095`) → ожидается 408; затем 17 audio → ожидается 17;
   c) К-3: архив 4 строк → `DELETE` → ожидается 4;
   d) К-5: 2 строки не трогать.
5. **Проверки после:** `scene_assets` = 30 (ba_ 17 + import_ 13), NULL = 2 (только К-5),
   versioned-строк = 28 (22 + 6), `image_units` = 58/0, `books`=2, `scenes`=13, sha256 `book.json` — без изменений,
   health 200, отсутствие роста NULL в течение контрольного окна.
6. **Откат:** восстановление из снапшота по id (данные только в `scene_assets`, FK нет).

## 10. Риски и наблюдения (вне скоупа, не исправлялось)

- **`GET /api/v1/book/:id/versions` → 500** `{"error":"assetResult is not defined"}` — баг в
  `routes/book/versions-routes.cjs:38` (`assetResult` вместо `assetRows`); файл в прод-образе байт-в-байт
  совпадает с репозиторием. Отдельный стейдж-фикс.
- **Прод на pre-66 образе** продолжает производить NULL-строки (см. §9.1) — деплой Stage 66+ остаётся
  непреработанной задачей.
- Redis: `animastor:generation:cancel:ba_1788172242081 = true` (без TTL), в PG `generation_cancellations`
  только `orphan_book` → рассинхрон источников отмены; на классификацию не влияет (слои ba_ выключены).
- Redis `asset-state`: `image=generating` у `sc-45c789c6` и `sc-5f18dd0f` (слой image выключен) —
  возможно застрявшие состояния; чистка NULL-строк их не трогает (мы не меняем Redis).
- Анонимный `GET /api/v1/books` не показывает две сохранённые книги — это **ожидаемо** (обе имеют
  `workspace_id`, анонимный скоуп фильтрует `workspace_id IS NULL`, `recent-books-routes.cjs:180-185`),
  не расхождение данных.

## 11. Доказательства read-only

- Выполненные обращения к БД: только `SELECT`/`\d`/`pg_tables`/`pg_constraint` (через `psql` в контейнере `animastor-pg`);
  ни одного `INSERT/UPDATE/DELETE/ALTER/CREATE/DROP`.
- Файловая система: только `ls`, `find`, `sha256sum`, чтение `book.json`/`manifest.json`.
- HTTP: только `GET` (`/health`, `/api/v1/books`, `/api/v1/book/:id/versions`).
- Код и конфигурация не изменялись; git-дерево не трогалось; отчёт — единственный созданный файл.
- Контрольные счётчики **до и после** идентичны: `scene_assets` 459/NULL 437, `image_units` 58/0, `books` 2, `scenes` 13.
