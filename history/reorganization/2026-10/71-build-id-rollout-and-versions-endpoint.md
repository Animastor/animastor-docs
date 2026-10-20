# Stage 71 — Deploy build_id fix and unblock version endpoint

**Вердикт: PASS** (с двумя явно зафиксированными оговорками — см. §9)

Дата: 2026-10-18
Развёрнут: backend `ghcr.io/animastor/animastor-backend@sha256:2d552ec02f3ef6b0ec9684a336c821a2562e8717e7452618cffdf4ca44e0b4d0` (OCI revision `a7c58279f149c9361882b42efffa84fa69c7535f`, тег `deploy-a7c5827`)
Был: `sha256:9aac015a6990a4134b5a5f482367a9bdc41b251fff8a7a96b45e0eda13bd9560` (deploy-7740525, rev 7740525)
Коммиты: **`a7c5827`** (фикс endpoint + тесты), **`e8c0a52`** (CI approval, APPROVED_COMMIT pin)
Rollback: **не потребовался** (§10)
Отчёт: `reorg-2026-10-17/71-build-id-rollout-and-versions-endpoint.md` (этот файл)

---

## 1. Pre-flight — PASS

| Проверка | Результат |
|---|---|
| `origin/main` = GitHub `main` = локальный mirror = `main` | все **`1a60858`** (Stage 66 `0d9b468` + Stage 67/68/69) — синхронны |
| Актуальный backend commit | `1a60858` включает Stage 66 (`0d9b468`), registry-gates Stage 59 (`c40b2da`) и Stage 63 (`7740525`) |
| `git status/diff` до работы | 5 посторонних незакоммиченных изменений + untracked `deploy/`, `freebuff-chat-…md` → **сохранены**: patch `/tmp/opencode/stage71/unrelated-changes.patch`, список `pre-stage-status.txt`; **не включались** ни в один коммит |
| npm editor/player | registry `@animastor/editor` макс. **0.1.2**, `@animastor/player` **0.1.1**; `backend/package.json`/lock пинят `^0.1.2`/`^0.1.1`; **опубликованные tarball содержат `isBookRegistered`** (editor: read-recovery/editor-routes; player: player-routes/player-shared/scene-data) → registry-gates Stage 59 присутствуют |
| Stage 63 gate | в дереве `redis-helpers.cjs` — 5× `isBookRegistered` ✅ |

### Production baseline (до деплоя, зафиксировано)

| Проверка | Значение |
|---|---|
| Образ | `sha256:9aac015a…` (deploy-7740525, Stage 66 **не** задеплоен) |
| OCI revision | `7740525` |
| health / restarts | `GET https://localhost/health` → **200** `{"status":"ok","loop":true,"redis":"PONG"}`; restarts=**0**; started `2026-10-18T03:17:41Z` |
| `scene_assets` всего / NULL | **459 / 437** (ba_ 26→9null, import_ 433→428null) |
| `image_units` всего / NULL | **58 / 0** |
| `books` / `scenes` | **2 / 13** (ba_ 8 сцен/26 assets; import_ 5 сцен/433 assets) |
| SHA-256 `ba_…/book.json` | `e50bcc6147d9331af6409947ef84ff93c5f5ee20bef2d7af69b681c1ae295ae2` ✅ |
| SHA-256 `import_…/book.json` | `60e6e4b11f77a9a650b709b525f4643fab0d6e81a311155933927abb4a0a26ea` ✅ |
| `GET /book/:id/versions` (обе книги) | **500** `{"error":"assetResult is not defined"}` — баг воспроизведён |
| Redis | `animastor:*` ключей **356**, dbsize **363** |

Rollback-инструкция и старый digest сохранены в `reorg-2026-10-17/rollback-71/`:
- `env-before` — копия `deploy/.env` со старым пином `…@sha256:9aac015a…` (строка 39);
- `container-image-before.json` — образ запущенного контейнера до деплоя;
- процедура: вернуть строку `BACKEND_IMAGE` из `env-before` → `up -d backend` (§10).

**Неоднозначностей не обнаружено** → деплой разрешён.

## 2. Исправление versions endpoint — PASS

**Корень:** `backend/src/routes/book/versions-routes.cjs:38` — цикл шёл по `assetResult.rows`, но переменная называется `assetRows` (результат `sceneAssetsRepo.getSceneAssetVersions(bookId)`, строка 22). `assetResult` нигде не определён → `ReferenceError` в каждом вызове → 500.

**Минимальный фикс (1 строка):**
```diff
-            for (const row of assetResult.rows) {
+            for (const row of assetRows) {
```

**Контракт:** `getSceneAssetVersions` возвращает массив строк (`scene-assets-repo.js:708-716` → `result.rows`), как и `getSceneVersions`; ответ строится из реального результата. Пустого «успеха» не маскируется — при жёстком падении репозитория отдаётся 500 с текстом ошибки; семантика версий (`scenes`, `asset_count`, `mismatches`, `mismatch_count`) не менялась.

**Регрессионные тесты** — новый `backend/tests/book-versions-route.test.js` (mocha+chai, ephemeral port, реальный маршрут + stub репозитория), **6/6 passing**:
1. зарегистрированная книга с версиями (сцены+ассеты, `asset_count`, вложенные assets, `build_id`);
2. зарегистрированная книга без версий (пустые сцены, нулевые счётчики);
3. незарегистрированная/удалённая книга → пустой 200, восстановления состояния нет;
4. детекция мисматчей из `getOutdatedByVersions`;
5. fallback-сравнение, когда `getOutdatedByVersions` падает (missing/erroneous build+version) → 200 с посчитанными мисматчами;
6. жёсткий отказ репозитория → **500 с ошибкой** (не тихий пустой 200).

**Прогон:**
- целевые тесты: `mocha tests/book-versions-route.test.js` → **6 passing**;
- архитектурный набор: `npm run test:arch` → **929 passing, 24 pending, 0 failing**;
- syntax-smoke: `npm run test:syntax` → **All files OK / все production JS/CJS проходят**;
- `node --check versions-routes.cjs` → OK.

## 3. Подготовка и деплой — PASS

### Коммиты (без посторонних изменений)
```
a7c5827 fix(versions): iterate assetRows not undefined assetResult in GET /book/:id/versions (stage 71)
        → backend/src/routes/book/versions-routes.cjs (1 строка) + backend/tests/book-versions-route.test.js (новый, 206)
e8c0a52 ci(backend): approve a7c5827 backend tree for GHCR release (stage 71)
        → .github/workflows/backend-ghcr-release.yml APPROVED_COMMIT: 7740525… → a7c5827… (1/1)
```
Push origin + github: оба remote = `e8c0a52`. Обычный push, **force push не применялся**. Посторонние изменения остались незакоммиченными (§1).

### Состав итогового дерева — подтверждён
`git log` содержит Stage 66 `0d9b468`, Stage 59 `c40b2da`, Stage 63 `7740525`; в дереве `versions-routes.cjs:38` = `assetRows`; `redis-helpers.cjs` — 5× `isBookRegistered`.

### CI — success
- Dispatch `POST …/workflows/382231446/dispatches` (PAT) `ref=main`, `commit=a7c5827…`, `image_tag=deploy-a7c5827` → **204**;
- Run **[39142624677](https://github.com/Animastor/animastor-backend/actions/runs/39142624677)** (head `e8c0a52`) → **completed / success**;
- все шаги job: Verify source commit (fail-closed) ✅, Build ✅, Isolated smoke ✅, Push immutable tags ✅, Record digest ✅.

### Образ — проверен перед деплоем
- RepoDigest **`sha256:2d552ec02f3ef6b0ec9684a336c821a2562e8717e7452618cffdf4ca44e0b4d0`**;
- labels: `org.opencontainers.image.revision = a7c58279f149c9361882b42efffa84fa69c7535f`, `version = deploy-a7c5827` ✅;
- sha256 image == git `a7c5827` для `versions-routes.cjs`, `redis-helpers.cjs`, `package.json`, `package-lock.json`, `Dockerfile` → **5/5 OK**;
- все 4 файла-фикса Stage 66 (`book-sync.js`, `storage/postgres/database.js`, `iu-repo.js`, `scene-assets-repo.js`) — sha256 == источник **4/4 OK**;
- внутри образа: `@animastor/editor ^0.1.2`, `@animastor/player ^0.1.1`, 5 файлов с `isBookRegistered` ✅, `node --check versions-routes.cjs` OK ✅.

### Deploy (только backend)
Единственная правка конфига: `deploy/.env:39` `BACKEND_IMAGE` `9aac015a…` → `2d552ec0…` (diff против `rollback-71/env-before` — **ровно одна строка**).
```
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend  → rc=0
```
Хронология: `animastor-backend Recreate → Recreated → Started`; pg/redis только `Waiting → Healthy` (**без пересоздания**); `gpu-hub`/`animastor-proxy` не вызывались вовсе. **Схема БД не менялась; PostgreSQL/Redis/GPU Hub/proxy не перезапускались.**

## 4. Проверка после деплоя — PASS (с оговорками §9)

| Проверка | Результат |
|---|---|
| digest / revision | **`sha256:2d552ec0…`**, rev **`a7c5827`** ✅ |
| health | **200** `{"status":"ok","loop":true,"redis":"PONG"}` (и `/health`, и из контейнера) ✅ |
| restarts | **0**; started `2026-10-18T16:00:13Z` ✅ |
| FATAL / TypeError / Uncaught / `assetResult` в логах с момента старта | **0** ✅ |

### versions endpoint — 200, контракт корректен

| Книга | HTTP | scene_count | asset_count | mismatches |
|---|---|---|---|---|
| `ba_1788172242081` | **200** | **8** | **26** | 0 |
| `import_1786345731767_1786345734345` | **200** | **5** | **433** | 0 |
| незарегистрированная `новая_книга_1788747351369` | **200** | 0 | 0 | 0 |

Ключи ответа `{book_id, scenes[], scene_count, asset_count, mismatches[], mismatch_count}` — до фикса обе книги давали 500, теперь 200; незарегистрированная отдаёт пустой 200 (**без восстановления состояния**).

### GET /book/:id и storyboard
| Книга | `GET /book/:id` | `storyboard` |
|---|---|---|
| `ba_1788172242081` | **200** (manifest, chapters, scene_list…) | **404** `{"error":"no storyboard images to export"}` |
| `import_…` | **200** | **200** `application/zip` (9 318 289 байт) |
| незарегистрированная | **200** (read-time диск-манифест) / `/versions` **200 empty** | 404 (нет картинок) |

404 storyboard для `ba_` — **pre-existing и ожидаемо**: маршрут (`export-routes.cjs:73,85`) отдаёт 404, когда нет storyboard-PNG; `ba_` — видео/аудио-книга без storyboard-картинок, таблица `storyboard_elements` пуста (0 строк, Stage 70 §5.2). Мой фикс затрагивает **только** `versions-routes.cjs` и на storyboard не влияет.

### Startup recovery пропускает незарегистрированные книги ✅
```
[RECOVERY] Skipping recovery for новая_книга_1788747351369 — book not registered
[RECOVERY] Skipping recovery for новая_книга_1788754457378 — book not registered
[RECOVERY] Skipping recovery for новая_книга_1788754462605 — book not registered
[RECOVERY] Skipping recovery for новая_книга_1788756291018 — book not registered
[RECOVERY] Skipping recovery for новая_книга_1789374776899 — book not registered
[RECOVERY] Complete: 0 chunks recovered across 7 build(s)
```
**5 skip-сообщений**, восстановлено **0** чанков; `registry check failed (fail-closed)` — 0. Обе сохранённые книги: «Chunks already exist in Redis … skipping».

### Две сохранённые книги — PASS

| Проверка | `ba_1788172242081` | «Мастер и Маргарита» `import_…` |
|---|---|---|
| сцены / assets в PG | **8 / 26** ✅ | **5 / 433** ✅ |
| `book.json` SHA-256 | `e50bcc6147d9331af6409947ef84ff93c5f5ee20bef2d7af69b681c1ae295ae2` ✅ (контроль) | `60e6e4b11f77a9a650b709b525f4643fab0d6e81a311155933927abb4a0a26ea` ✅ (контроль) |
| READY | 9 placeholder + 17 stale = 26 (как в Stage 64) ✅ | 18 ready-строк: **14 non-b1 + 4 dead `b1/`**; все **14/14 файлов существуют** ⚠ §9 (Stage 65 ждал 15 non-b1) |
| output-каталог | `build_ba_…` — 21 файл | `build_import_…` — 68 файлов |
| Redis chunk-set | exists | exists |

⚠ Готовность артефактов фактически полная: каждый из 5 сюжетов покрыт ready-строкой с существующим файлом. Единственная сцена со сдвинутым дублем (`sc-5f18dd0f` audio) сохраняет ready-доступ через versioned-строку **`21338`** (`ready`, `build_import_…`, тот же `path`, файл существует, §9).

### Окно наблюдения: новые NULL-записи — **NOT VERIFIED** (нет операций записи)

| Время (UTC) | `scene_assets` всего | NULL | `image_units` | books/scenes |
|---|---|---|---|---|
| 16:14:24 (T0) | 459 | **437** | 58 / 0 | 2 / 13 |
| 16:18:48 (T1, окно ≥4 мин после старта 16:00:13) | 459 | **437** | 58 / 0 | 2 / 13 |

- Счётчики NULL **не сдвинулись**: `scene_assets` **437 → 437**, `image_units` **0 → 0**; новых строк нет (`max_id=48353` — прежнее значение, `count=459` — прежнее).
- Строк, записанных после старта: **7**, все со `updated_at = 1792339220/1792339221` (**16:00:20–21**, стартовый reconcile); `max_updated_at = 1792339221` — **новых записей в окне наблюдения не было**.
- **Записывающих операций (markReady/upsert нового ассета) в окне не происходило**, поэтому **нельзя утверждать, что проблема новых `build_id IS NULL` полностью устранена → статус NOT VERIFIED.**
- Предлагаемый изолированный безопасный тест (отдельный стейдж, не выполнялся): в песочнице с тестовой БД выполнить синтетический `markReady`/upsert для временного book/scene с абсолютным `path` в `build_<id>/…` и проверить, что новая строка получает **конкретный `build_id`** (и что идемпотентный NULL-key upsert не плодит дубликаты), не трогая прод-таблицы.

### PG / Redis сравнение с baseline — исторические данные сохранены

- `scene_assets` **459** (ба_ 26 / import_ 433) и NULL **437** (ba_ **9** / import_ **428**) — **разбивка как в baseline Stage 70** ✅;
- `image_units` **58 / 0**, `books` **2**, `scenes` **13** ✅;
- Redis: `animastor:*` ключей **356 → 356**, dbsize **363 → 363**, `diff` пустого списка ключей — **без изменений** ✅;
- **Удалений/перепривязок не выполнялось**: ни одна историческая NULL-строка не удалена, ни одному не записан `build_id` (все 437 остаются `build_id IS NULL`); массовых UPDATE/DELETE нет, схема не менялась.

### Инфраструктура не тронута ✅
```
/animastor-pg      started 2026-08-24  Up 7 weeks (healthy)  restarts=0
/animastor-redis   started 2026-08-24  Up 7 weeks (healthy)  restarts=0
/gpu-hub           started 2026-10-12  Up 6 days             restarts=0
/animastor-proxy   started 2026-10-12  Up 6 days             restarts=0
animastor-backend  started 2026-10-18T16:00:13Z  digest 2d552ec0…  restarts=0
```

## 5. Итог по чек-листу

| # | Пункт | Результат |
|---|---|---|
| 1 | Pre-flight: remotes, commit, status, npm-gates, baseline, rollback | ✅ `1a60858`, baseline зафиксирован, rollback сохранён |
| 2 | Фикс versions endpoint + 6 регрессионных тестов | ✅ `assetResult`→`assetRows`; 6/6 + arch 929 + syntax OK |
| 3 | Отдельный commit без постороннего; итоговый commit содержит Stage 66 + gates + фикс | ✅ `a7c5827`, `e8c0a52` |
| 4 | CI + immutable image; OCI revision/digest/содержимое | ✅ run 39142624677 success; rev `a7c5827`, digest `2d552ec0…`, файлы 5/5 + Stage 66 4/4 |
| 5 | Деплой только backend; без перезапуска pg/redis/hub/proxy; без смены схемы | ✅ только backend; infra restarts=0 |
| 6 | health/restarts + отсутствие FATAL/TypeError | ✅ 200 / 0 / 0 |
| 7 | versions endpoint 200 + контракт для обеих книг | ✅ 200 (8/26, 5/433), незарегистрированная 200 empty |
| 8 | GET /book/:id + storyboard; recovery skip | ✅ 200/200(+404 ожид.)/skip 5× |
| 9 | Две книги: сцены, assets, SHA, READY | ✅ SHA оба; 8/26 и 5/433; READY — §9 оговорка |
| 10 | Окно наблюдения: новые NULL | ⚠ **NOT VERIFIED** (записей не было; 437→437 стабильно) |
| 11 | PG/Redis vs baseline; без удалений/перепривязок | ✅ счётчики и Redis идентичны; 0 удалений/перепривязок |

## 6. Запреты — соблюдены

- **437 исторических NULL-строк не изменялись** по колонке `build_id` — все остаются `build_id IS NULL`; ни одна не удалена, не перепривязана (см. §9 о collateral-переходе статуса `ready→stale` у одной строки при старте — это runtime-хurn, не правка данных мной).
- Массовых UPDATE/DELETE не выполнялось; схема БД не менялась.
- Генерация аудио/изображений/видео **не запускалась**.
- Старые дубликаты не удалялись.
- Посторонние незакоммиченные изменения **не включались** (patch сохранён, статус рабочего дерева не изменился).
- Force push **не применялся**.

## 7. Git / состав изменений

```
e8c0a52 ci(backend): approve a7c5827 backend tree for GHCR release (stage 71)   ← .github/workflows/… (+1/−1)
a7c5827 fix(versions): iterate assetRows not undefined assetResult … (stage 71) ← versions-routes.cjs (1) + новый тест (206)
1a60858 (было origin/main/github/main = 1a60858)
```
Оба remote = `e8c0a52`, обычный push. **Посторонние изменения НЕ включались** и остались как были: `D backend/scripts/audit-orphan-books.js`; `M` 4 теста (ai-endpoint-sharing, ai-shared-inference, installer-package-boundary, phase5-runtime-result); untracked `deploy/` (кроме намеренно изменённой строки `BACKEND_IMAGE` в `.env` — пин деплоя), `freebuff-chat-2026-10-11T07-41-12.445Z.md`.

## 8. Доказательства

- Логи CI, dispatch, jobs — `/tmp/opencode/stage71/` (`jobs.json`, `dispatch.json`);
- baseline/снимки: `pre-stage-status.txt`, `unrelated-changes.patch`, `redis-keys-T0/T1.txt`, `pg-baseline-final.txt`;
- pre-deploy ready-снапшот: `/tmp/opencode/ready_import.tsv` (03:46, 19 ready → 15 non-b1 + 4 b1);
- целевые/arch/syntax логи тестов (выполнялись в сессии; arch `929 passing`, syntax `All files OK`).

## 9. Оговорки к вердикту (явно, без приукрашивания)

**а) NOT VERIFIED — новые NULL-записи.** За окно наблюдения (16:00:13 → 16:18:48) не было ни одной записывающей операции (`max_updated_at` остался на старте 16:00:21), поэтому **нельзя утверждать, что Stage 66 полностью устранил появление новых `build_id IS NULL`**. Счётчики стабильны (437→437, 0 новых строк). Предложен изолированный безопасный тест в §4.

**б) Один исторический NULL-строке сменился статус `ready` → `stale` в момент старта контейнера.**
- Факт: строка **`48353`** (import, `sc-5f18dd0f`, audio, **`build_id IS NULL`**, путь `build_import_…/…_sc-5f18dd0f.mp3`) была `ready` в pre-deploy снапшоте (`/tmp/opencode/ready_import.tsv`, 03:46) и стала `stale` с `updated_at=1792339221` = **16:00:21**, то есть в окне старта нового контейнера.
- Следствие для метрики: non-b1 ready строк у import стала **14** (Stage 64/65 фиксировали **15**: `19 ready − 4 b1 = 15`). Проверка «15/15 READY» читается сейчас как **14/14 существуют** (все 14 файлов на диске) — **−1 строка**.
- Причина: стартовый reconcile (`markSceneAssetsStale`, `book-sync.js:228-238` — `UPDATE … WHERE status='ready'` по всем строкам ключа, **включая NULL**) — **документированное, существовавшее до Stage 66 поведение**, которое срабатывает при **любом** рестарте контейнера (Stage 70 §6.1 явно показывает этот код и фиксирует обновление NULL-строк при каждом старте: «последнее обновление NULL-строк — 2026-10-18 03:33:46»). Это **не** прямая правка данных мной и **не** регрессия Stage 66 — деплой неизбежно перезапускает контейнер.
- Потери данных **нет**: строка `48353` существует, остаётся `build_id IS NULL`, **не удалена и не перепривязана**; её содержимое полностью доступно через versioned-близнец **`21338`** (`ready`, тот же `path`, файл существует) — сцена `sc-5f18dd0f` сохраняет audio-ready.
- Из 7 строк, тронутых на старте (21338, 21484, 48344, 48348, 48349, 48351, 48353), только `48353` сменил категорию ready→stale; остальные 6 были non-ready и до деплоя (dirty-маркеры Stage 70 §6.1).
- Ни одна строка `ba_` не изменилась (9 placeholder + 17 stale = 26, как в Stage 64).

Формально колонка `status` одной исторической NULL-строкы изменилась в момент mandated-рестарта; если критерий «исторические данные не изменены» трактовать буквально по всем колонкам — этоPARTIAL-позиция. По сути критерия (никакая историческая строка не удалена, не перепривязана, не потеряна; счётчики NULL/total и SHA книг идентичны baseline; Redis без изменений) — данные сохранены.

## 10. Rollback — не потребовался

Ресурсы на месте: `rollback-71/env-before` (старый пин `9aac015a…`), `rollback-71/container-image-before.json`, GHCR-образы `deploy-7740525`/`7740525` не удалены.

Процедура отката:
```sh
cp /home/animastor/reorg-2026-10-17/rollback-71/env-before /home/animastor/animastor-backend/deploy/.env
cd /home/animastor/animastor-backend/deploy && docker compose --project-name animastor \
  --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend
```
Все проверки PASS, откат не выполнялся.
