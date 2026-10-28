# Stage 95 — Data Path Abstraction (Preparation Only)

**Дата:** 2026-10-21 (UTC, 02:4x–03:15)
**Область:** аудит механизмов конфигурации путей `data/books` / `data/output` (backend,
worker, orchestration, installer/e2e, deploy), проектирование минимального логического
интерфейса хранения с единой точкой настройки корневого пути, пошаговый план перехода.
**Режим:** только аудит и проектирование. Никаких изменений: данных, кода, конфигураций,
Docker Compose, overlay, `.env`, Git, пакетов, внешних хранилищ — не выполнялось.
Production-контейнеры не перезапускались, отчёты Stage 87–94 не изменялись.

Не выполнялись: перемещение/копирование/удаление данных; правка `backend/src`, `packages/**`,
`docker/**`, `deploy/**`; `docker compose up/down/restart`; вывод секретов и содержимого
`deploy/.env` (имена переменных читались, значения — нет); `git add/commit/checkout`;
подключение хранилищ; исправление некаталогизированных книг (Stage 94 §3).

---

## 0. Итоговый статус

**PASS** — аудит выполнен, интерфейс спроектирован, пошаговый план подготовлен
(§2–§3), отчёт создан. Изменений в системе нет.

**Ключевые выводы:**

1. **Хост-пути уже отвязаны от кода приложения.** Абсолютный путь
   `/home/animastor/animastor/data/{books,output}` встречается *только* в compose-файлах
   (`animastor-backend/deploy/docker-compose.yml:107-108`, `deploy/overlay-backend-standalone.yml:36-37`,
   относительные `./data/…` — `docker-compose.yml:87-88`, `docker/compose/overlay-backend-standalone.yml:30-31`).
   В коде приложения хост-путей нет. Перемещение данных на уровне хоста = смена
   *источника* bind-mount, код не меняется.
2. **Логический корень почти един: `backend/src/config/runtime-config.js:60-61`**
   (`OUTPUT_DIR` = `env.OUTPUT_DIR || '/data/output'`, `BOOKS_DIR` = `env.BOOKS_DIR || '/data/books'`).
   Из него живут ~24 файла backend и три шва пакетов. Отсутствует один общий корень:
   нет переменной, задающей корень для *обоих* подкаталогов сразу.
3. **Вне единой точки — 9 production-литералов** (4 живых в orchestration, 3 fallback в
   backend, 1 в `backend.cjs:163`, 2 в `backend/scripts/audit-*.js`, плюс комментарии/доки/тесты).
   4 литерала orchestration — единственные, которые **игнорируют** уже существующий шов
   `artifactRoot` (соседний код в тех же файлах его использует).
4. **Персистентные данные привязаны к контейнерным путям `/data/*`**: PG `scene_assets.path`
   содержит 37 абсолютных строк `/data/output/…`, legacy-реестр Redis `animastor:assets:*` —
   74 ключа с `canonical=/data/output/…`; оба читаются живым кодом
   (`reconciliation-engine.js:237,242` — `fs.access`, `placeholder-audio.js:166,175,514` —
   `fs.existsSync`). **Следствие:** менять контейнерные пути `/data/books`, `/data/output`
   в рамках абстракции нельзя — персистентную нормализацию выполнять отдельным этапом.
5. **Worker/installer/e2e живут в другом неймспейсе** (`/data/animastor`, host-путь
   `~/animastor/data`), книг/артефактов не трогают, но **имя `/home/animastor/data` уже
   занято** e2e-драйвером установки (`docker/e2e/install-driver.cjs:16`) — это конфликт
   имён с целевым путём Stage 92 N6 (блокер для будущего этапа миграции, не для Stage 95).
6. **Отсутствие конфликтов env-имён:** в `deploy/.env` 14 переменных, `BOOKS_DIR`/`OUTPUT_DIR`/
   `DATA_ROOT` среди них нет; в compose backend не передаётся ни одна из них (значения по
   умолчанию из runtime-config). Существующие `*_DIR` (`AI_DIR`, `CONNECTOR_DIR`, `WF_DIR`,
   `COMFY_INPUT_DIR`, `WORKER_JOURNAL_DIR`) не пересекаются с предлагаемым `DATA_ROOT`.
7. **Фронты и Android путь ассетов не читают** (поля `path`/`canonical` из API не
   используются), в файлах книг (`data/books/**/book.json`) абсолютных путей нет —
   абстракция не затрагивает клиентов.
8. **Тестовая база готова к проверке:** `backend npm test` (mocha + syntax-smoke pretest),
   `packages/animastor-orchestration npm test`, `packages/animastor-vbook-runtime npm test`,
   `packages/animastor-installer` docker-deployment тест (фиксирует `~/animastor/data` →
   `/data/animastor` — не менять).

---

## 1. Этап 1 — Аудит механизмов конфигурации путей

### 1.1 Модель уровней (что где живёт)

| Уровень | Содержит | Где | Менять в Stage 95 |
|---|---|---|---|
| **A. Логический корень приложения** | `BOOKS_DIR`, `OUTPUT_DIR` (env + дефолты `/data/*`) | `backend/src/config/runtime-config.js:60-61`, экспорт :282-283 | только проектирование |
| **B. Швы пакетов** | `configureBooksRoot`, `artifactRoot`, `outputRoot` | `packages/animastor-vbook-runtime/src/books-root.js`, `packages/animastor-orchestration/src/host/host-bindings.js:42`, `backend/src/backend.cjs:163,209,536` | нет |
| **C. Физический уровень хоста** | источники bind-mount | `animastor-backend/deploy/docker-compose.yml:107-108`, `deploy/overlay-backend-standalone.yml:36-37`, `docker-compose.yml:87-88`, `docker/compose/overlay-backend-standalone.yml:30-31` | **нет (запрещено)** |
| **D. Персистентные пути** | абсолютные строки в PG/Redis | `scene_assets.path`, `animastor:assets:*` | нет (отдельный этап) |
| **E. Смежные компоненты** | корень установки worker | `docker/worker/entrypoint.sh:17` (`DATA=/data/animastor`), installer `docker.js:22`, e2e `install-driver.cjs:16` | нет |

### 1.2 Уровень A — единая точка конфигурации

```js
// backend/src/config/runtime-config.js:60-61
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output';
const BOOKS_DIR  = process.env.BOOKS_DIR  || '/data/books';
```

Потребители (группы, всего ~24 файла `backend/src`): `backend.cjs:163,380,536,816`;
`video/{video-service,video-timeline,video-merge}.js`; `image/{preview,iu-processor,registry}.js`;
`routes/book/{export,generation,cache}-routes.cjs`; `routes/debug-routes.cjs`;
`helpers/redis-helpers.cjs:170,229,231`; `services/{audio-orchestrator,audio-recovery,
book-deletion,cleanup-service,entity-cleanup,layer-config,placeholder-audio,task-handler,
video-orchestrator,waveform-service}.js`; `storage/{filesystem-store,placeholder-audio-adapter}.js`;
`utils/string-utils.js:16`; `routes/book/export-routes.cjs:23-24` (единственный потребитель
**обоих** корней в route-слое).

Отдельно: `backend/scripts/audit-video-actions.js:29`, `backend/scripts/audit-scenes.js:13` —
читают `process.env.BOOKS_DIR` напрямую со своим дефолтом (дублируют точку A).

### 1.3 Уровень B — швы пакетов (уже существуют, менять не нужно)

| Шов | Форма | Кто вяжет | Кто использует |
|---|---|---|---|
| `configureBooksRoot(() => config.BOOKS_DIR)` | live-provider, fail-closed без привязки | `backend/src/backend.cjs:209` | весь book-домен vbook-runtime (`src/lazy-book/paths.js:3-5`, `src/index.js`), т.е. и запись `POST /book/blank` |
| `artifactRoot: () => config.OUTPUT_DIR \|\| '/data/output'` | zero-arg resolver, `host-bindings.js:42` | `backend/src/backend.cjs:163` | `scene-restoration.js:23`, `scene-callbacks.js:23,129,333` |
| `outputRoot: config.OUTPUT_DIR` | deps-объект | `backend/src/backend.cjs:536` | `packages/animastor-player/src/player-shared.cjs:66-75` (поиск артефактов: `path.join(outputRoot, buildId, filename)`) |
| editor-ports | seam в host | `backend/src/book-routes.cjs`, `backend.cjs` | `packages/animastor-editor/src/entity-crud-routes.cjs` (через `editorPorts`, прямых `fs`-путей в файле нет) |

Т.е. **оба домена уже имеют по одному шву**; отдельного интерфейса «хранилища» в коде нет
и не требуется — достаточно, чтобы все обращения шли через швы.

### 1.4 Литералы `/data/output` и `/data/books` вне точки A (полный перечень)

| # | Файл:строка | Значение | Зона | Статус/действие плана |
|---|---|---|---|---|
| 1 | `backend/src/config/runtime-config.js:60` | `/data/output` | production | **владелец дефолта** — оставить |
| 2 | `backend/src/config/runtime-config.js:61` | `/data/books` | production | **владелец дефолта** — оставить |
| 3 | `backend/src/backend.cjs:163` | `\|\| '/data/output'` | production | мёртвый fallback (`config.OUTPUT_DIR` всегда задан) — убрать в S3 |
| 4 | `backend/src/services/task-handler.cjs:244` | `config.BOOKS_DIR \|\| '/data/books'` | production | дубль дефолта — убрать в S3 |
| 5 | `backend/src/services/task-handler.cjs:256` | то же | production | убрать в S3 |
| 6 | `backend/src/services/book-deletion.cjs:104` | то же | production | убрать в S3 |
| 7 | `packages/animastor-orchestration/src/orchestration/scene-callbacks.js:281` | `resolveCanonicalSceneImage('/data/output', …)` | production | **закрыть через `artifactRoot()`** — S2 |
| 8 | `packages/animastor-orchestration/src/orchestration/scene-callbacks.js:393` | `` `/data/output/${buildId}/…mp4` `` | production | закрыть — S2 |
| 9 | `packages/animastor-orchestration/src/runtime/reconciliation-engine.js:124` | то же (orphan video) | production | закрыть — S2 |
| 10 | `packages/animastor-orchestration/src/runtime/reconciliation-engine.js:158` | `resolveCanonicalSceneImage('/data/output', …)` | production | закрыть — S2 |
| 11 | `backend/scripts/audit-video-actions.js:29` | `env.BOOKS_DIR \|\| '/data/books'` | инструмент | перевести на runtime-config — S3 |
| 12 | `backend/scripts/audit-scenes.js:13` | то же | инструмент | перевести на runtime-config — S3 |
| 13 | `packages/animastor-vbook-runtime/src/index.js:11,21` | комментарии | документация | не трогать (иллюстративные) |
| 14 | `packages/animastor-vbook-runtime/README.md:30` | пример `configureBooksRoot('/data/books')` | документация | не трогать |
| 15 | `docker-compose.yml:87-88`, `docker/compose/overlay-backend-standalone.yml:30-31` | `./data/…:/data/…` | deploy | **запрещено менять** |
| 16 | `backend/tests/*` (7 вхождений: `happy-path.test.js:988,1006`, `stage-dispatch-lifecycle.test.js:146`, `generation-test-bindings.cjs:129`, `reconciliation-engine.test.js:86,99,305`) | заглушки/стабы | тесты | не трогать; whitelist grep-гейта |
| 17 | `backups/deploy-*` (inspect/compose-config снапшоты) | `/data/*` | архивы | не трогать |

**Важное наблюдение (§1.4, S2):** в `reconciliation-engine.js` уже импортирован
`lazyHostBinding` (строка 18), и на строках 157-159 он используется для `media.image` —
а на строке 158 корень передаётся литералом. Т.е. обход шва — локальная
непоследовательность, а не архитектурное ограничение: закрытие = замена литерала на
`lazyHostBinding('artifactRoot')()` (в `scene-callbacks.js` — на существующий
`artifactRoot()`).

### 1.5 Уровень D — персистентные пути (критично для дизайна)

**PostgreSQL `scene_assets` (459 строк):**

| Тип | Всего | `path` абсолютный (`/data/…`) | `path` = имя файла (отн.) | `path IS NULL` |
|---|---|---|---|---|
| audio | 39 | 30 | 0 | 9 |
| image | 413 | 0 | **411** | 2 |
| video | 7 | 7 | 0 | 0 |
| итого | 459 | 37 | 411 | 11 |

- Примеры: `/data/output/build_import_…/import_…_ch-…_sc-….mp3` (audio),
  `import_…_iu-…​.png` (image — только имя файла, **семантика смешанная**).
- `chunks JSONB`: 0 непустых записей; `metadata JSONB`: 0 совпадений `/data`.
- `cache_entries.file_path` (schema.js:199): колонка есть, **строк 0**, писателя в коде нет.
- Потребители: `services/placeholder-audio.js:166,175,514` — `fs.existsSync(asset.path)`
  (корректно только для абсолютных строк; для «имени файла» резолвится относительно cwd —
  скрытое расхождение, зафиксировано, не исправляется); `scene-asset-registry.js:188-189`
  отдаёт `path`/`canonical` в API (клиенты не используют).

**Redis (302 ключа, production):**

- Legacy-реестр `animastor:assets:*`: **74 ключа, все 74** содержат
  `canonical`/`path` = `/data/output/…` (проверено сканированием всех значений).
- Живые потребители: `reconciliation-engine.js:227→235-242`
  (`persist('registry.getSceneAssetsRedis')` → `fs.access(assets.audio.canonical)`),
  `:1349-1353` (перерегистрация `canonicalPath` из тех же значений — цикл закрепления),
  `checkOrphanImageState`/`checkOrphanVideoState` используют `assets.image.path` / литералы §1.4.
- Записывает legacy-реестр: оркестрация через `persist('registry.registerScene*Redis')`
  (`scene-callbacks.js:133,312,420`, `reconciliation-engine.js:1352,1358,1364`).
- Прочие ключи Redis (`animastor:*` 295 шт., `trigger_cooldown:*` 7) — путей не содержат
  (проверено полным обходом TYPE+значения).

**Вывод для дизайна:** контейнерные пути `/data/books` и `/data/output` являются
**негласным контрактом с персистентными данными**. Абстракция настраивает *корень*, но
дефолтное значение контейнерного корня `/data` обязано остаться неизменным; любая
нормализация строк в PG/Redis — отдельный, явно согласованный шаг.

### 1.6 Уровень C — deploy (только констатация)

- `animastor-backend/deploy/docker-compose.yml:107-108` — абсолютные источники
  `/home/animastor/animastor/data/{output,books}` → `/data/{output,books}`; backend-сервис
  **не получает** ни `OUTPUT_DIR`, ни `BOOKS_DIR` в `environment` (строки 61-83).
- `deploy/overlay-backend-standalone.yml:36-37` — те же абсолютные пути (overlay deploy-копии).
- В корне монорепо: `docker-compose.yml:87-88` и `docker/compose/overlay-backend-standalone.yml:30-31`
  — относительные `./data/…` (относительно корня монорепо, а не `deploy/` — потому
  абсолютные пути и появились в deploy-копии, см. комментарий compose:8-11).
- `nginx` (`proxy/conf/default.conf`): путей `/data/*` нет — только proxy, SPA-корни и
  `alias` для library; данные отдаёт backend API.
- `gpu-hub`: томов к data-каталогам нет вообще (compose: gpu-hub без `volumes:`).
- `deploy/.env` — 14 имён (`POSTGRES_PASSWORD … BACKEND_IMAGE`): `BOOKS_DIR`, `OUTPUT_DIR`,
  `DATA_ROOT` отсутствуют (значения не читались).

### 1.7 Уровень E — worker/installer/e2e и конфликты имён

| Место | Что задаёт | Резолвится на этом хосте как | Опасность |
|---|---|---|---|
| `docker/e2e/install-driver.cjs:16` | `-v /home/animastor/data:/data/animastor` | не существует (path отсутствует) | **имя занято** под будущий корень данных Stage 92 N6: каталог установки worker'а и каталог данных приложения — одно и то же имя |
| `packages/animastor-installer/src/installer/setup-contract.js:703,719` | `-v ~/animastor/data:/data/animastor` (документируемая команда) | `/home/animastor/animastor/data` = **текущий production-каталог данных** | если команду выполнить на этом сервере — каталог данных приложения монтируется как корень установки worker'а |
| `packages/animastor-installer/src/installer/platform/deployment/docker.js:47` | `volumeMap: '~/animastor/data' → /data/animastor` | то же | тест `tests/installer-docker-deployment.test.js:50-53` фиксирует строку `~/animastor/data` — менять нельзя без правки теста |
| `docker/worker/docker-run.md:6,16` | та же команда | то же | документация |
| `docker/worker/entrypoint.sh:17` | `DATA=/data/animastor` | внутри контейнера | неймспейс worker'а, с `/data/books`,`/data/output` **не пересекается** |
| `docker/e2e/install-driver.cjs:17` | `-v /home/sureg/ComfyUI/models/TTS:…` | legacy-путь sureg (Stage 90) | устаревшая зависимость драйвера; зафиксировано, не исправляется |

**Неймспейсы в контейнере:** `/data/books` + `/data/output` (приложение) и
`/data/animastor` (worker) — не конфликтуют. Конфликт только на уровне **имени хост-каталога**
`~/animastor/data` / `/home/animastor/data`.

### 1.8 Проверенные отсутствия

- Литералов `/data/books`,`/data/output` в sibling-репозиториях
  (`animastor-gpu-hub`, `animastor-worker`, `animastor-tools`, `animastor-web`,
  `animastor-android`, `Android`, `animastor-docs`) — **нет** (поиск по js/cjs/kt/java/ts/yml/sh/py/json).
- Использования полей `path`/`canonical` API-ассетов во фронтах
  (`frontends/*/src`) и Android — **нет**.
- Абсолютных путей внутри данных книг (`data/books/**`) — **нет** (поиск `/data/` по файлам).
- `process.env.BOOKS_DIR/OUTPUT_DIR` вне runtime-config и `backend/scripts/audit-*` —
  только тесты (`scope-slide.test.js:559,567` устанавливают/удаляют env) и комментарии.
- Литерала `'/data'` (без суффикса) — **нет**.
- `DATA_ROOT`/`data_root`/`ANIMASTOR_DATA`/`INSTALL_DIR` как конфигурации корня — в
  продакшн-коде не используются (вхождения только в installer/e2e, §1.7).

### 1.9 Границы аудита

Не исследовались (и не требовались для проектирования): внутренняя кухня ComfyUI-путей
worker'а (`COMFY_INPUT_DIR`/`COMFY_OUTPUT_DIR` — живут в неймспейсе worker'а),
секреты `deploy/.env` (значения), права доступа к каталогам (owner `animastor:animastor`
подтверждён ранее в Stage 92), версии файлов в Git-истории. Пропуски §1.4 помечены
как whitelist для grep-гейта (§3, S4).

---

## 2. Этап 2 — Проектирование минимального логического интерфейса

### 2.1 Принципы

1. **Одна настраиваемая величина** — корень; подкаталоги `books` и `output` — логические
   пространства имён с фиксированными именами (совпадают с контейнерными `/data/books`,
   `/data/output` → персистентные строки остаются валидными).
2. **Обратная совместимость в байтах:** без новых переменных окружения все три значения
   (`DATA_ROOT`, `OUTPUT_DIR`, `BOOKS_DIR`) обязаны дать ровно `/data`, `/data/output`,
   `/data/books`, как сегодня.
3. **Никаких новых абстракций** — используется существующая точка A (`runtime-config`)
   и существующие швы B; пакеты по-прежнему не читают `process.env`.
4. **Физический уровень не смешивается:** код приложения не знает хост-путей; deploy не
   знает внутренней структуры данных. Смена хост-каталога — только compose (отдельный этап).
5. **Fail-closed швы сохраняются** (`configureBooksRoot`, `host-bindings`).

### 2.2 Контракт интерфейса (логический)

```
DATA_ROOT  (env, опционально, абсолютный путь или пусто)
   ├── books  = <DATA_ROOT>/books
   └── output = <DATA_ROOT>/output

BOOKS_DIR  (env)  — точное переопределение, приоритет выше DATA_ROOT
OUTPUT_DIR (env)  — точное переопределение, приоритет выше DATA_ROOT
(отсутствуют обе) — DATA_ROOT-производные; DATA_ROOT пуст → дефолты /data/books, /data/output
```

Реализация (минимальная, ~6 строк в `runtime-config.js`):

```js
const DATA_ROOT = (process.env.DATA_ROOT || '').trim();          // '' = сегодняшнее поведение
// абсолютный путь или пусто; относительный → считать пустым (защита от опечатки)
const root = DATA_ROOT.startsWith('/') ? DATA_ROOT.replace(/\/+$/, '') : '';
const OUTPUT_DIR = process.env.OUTPUT_DIR || (root ? `${root}/output` : '/data/output');
const BOOKS_DIR  = process.env.BOOKS_DIR  || (root ? `${root}/books`  : '/data/books');
```

**Что остаётся интерфейсом для потребителей** (без изменений сигнатур):
`config.OUTPUT_DIR`, `config.BOOKS_DIR` (backend), `configureBooksRoot(provider)` (vbook),
`hostBinding('artifactRoot')` (orchestration), `deps.outputRoot` (player).
**Единственная новая величина для настройки:** `DATA_ROOT`.

### 2.3 Владение (таблица «одна точка»)

| Вопрос | Владелец (единственное место) | Потребители |
|---|---|---|
| Чему равен корень логических `books`/`output` | `runtime-config.js` (DATA_ROOT + 2 переопределения) | ~24 файла backend + 3 шва |
| Как пакет получает корень книг | `backend.cjs:209` → `configureBooksRoot` | vbook-runtime, editor (через него) |
| Как пакет получает корень артефактов | `backend.cjs:163` → `artifactRoot` binding | orchestration (вкл. 4 закрываемых сайта) |
| Как пакет получает output-root для стриминга | `backend.cjs:536` → player `outputRoot` | player-роуты |
| Каким хост-каталогом монтируется корень | compose (`deploy/docker-compose.yml`, overlay) | Docker; код приложения не участвует |
| Что хранится в PG/Redis | правило §2.4 (контейнерно-внутренние пути) | reconciliation, placeholder-audio |

### 2.4 Контракт персистентных путей (фиксация, не изменение)

- В `scene_assets.path` и `animastor:assets:*` хранятся **контейнерно-внутренние**
  абсолютные пути `/data/output/…` либо имена файлов (смешанная семантика — факт, §1.5).
- Правило на будущее: персистентно хранить путь **внутри контейнера** либо относительное
  имя; хост-путь в данные не попадает (сегодня так и есть — проверено §1.8).
- Поэтому **S1–S5 не меняют контейнерные пути**: `DATA_ROOT` по умолчанию пуст,
  дефолты `/data/*` байт-в-байт сохраняются, bind-mount'ы не трогаются.
- Нормализация 37+74 строк и смешанной семантики image — **отдельный этап** (§4, Q4),
  до или вместе с миграцией хост-каталога.

### 2.5 Явные не-цели Stage 95 (и плана S1–S5)

Не входят: правка compose/overlay/`.env`; перезапуск/рестарт контейнеров; перемещение
данных; изменение контейнерных путей `/data/*`; правка worker/installer/e2e путей
(конфликт §1.7 — только документируется); нормализация персистентных строк; Git-операции;
исправление 8 некаталогизированных книг (Stage 94); внешние хранилища.

---

## 3. Этап 3 — Пошаговый план внедрения (подготовлен, НЕ выполняется)

Все шаги — будущий отдельный этап (Stage 96+), с решением владельца. Каждый шаг
изолирован и откатывается `git revert` своего коммита.

### S1 — Корень в точке A

**Изменение:** `backend/src/config/runtime-config.js` — ввести `DATA_ROOT` и производные
(§2.2), экспортировать `DATA_ROOT`; комментарий-контракт (§2.3) над блоком PATHS.
**Тесты:** новый `backend/tests/data-path-config.test.js`:
- дефолты байт-в-байт: `OUTPUT_DIR==='/data/output'`, `BOOKS_DIR==='/data/books'`,
  `DATA_ROOT===''`;
- `DATA_ROOT=/srv/anim` → `/srv/anim/output`, `/srv/anim/books`;
- `OUTPUT_DIR=/x` + `DATA_ROOT=/srv/anim` → `/x` (переопределение выше корня);
- `DATA_ROOT=data/…` (относительный) → игнорируется, дефолты `/data/*`;
- `DATA_ROOT=/srv/anim/` (косой слэш) → без двойного слэша: `/srv/anim/output`;
- окружение очищается в `afterEach` (паттерн `scope-slide.test.js:559-567`).
**PASS:** новый тест зелёный + весь `backend npm test` зелёный.
**BLOCKED:** любой преждевременный импорт/побочный эффект runtime-config в тестах
(требуется рефакторинг — эскалировать, не форсировать).

### S2 — Закрытие 4 литералов orchestration

**Изменение:** `scene-callbacks.js:281,393` → `artifactRoot()` + `path.join`;
`reconciliation-engine.js:124,158` → `lazyHostBinding('artifactRoot')()` + `path.join`
(шов уже импортирован, строка 18). Поведение не меняется: резолвер возвращает
`config.OUTPUT_DIR` = `/data/output`.
**Тесты:** `packages/animastor-orchestration npm test` (mocha с test-bindings);
`backend npm test` (в т.ч. `reconciliation-engine.test.js`, `happy-path.test.js` — стабы
artifactRoot уже есть: `generation-test-bindings.cjs:129`).
**PASS:** обе сьюты зелёные + grep-гейт (S4) не находит литералов в `packages/*/src`.
**BLOCKED:** тест оркестрации завязан на литеральном `/data/output` вне whitelist
(зафиксировать, решать отдельно).

### S3 — Дубли дефолтов и скрипты

**Изменение:**
- `backend.cjs:163`: `artifactRoot: () => config.OUTPUT_DIR` (убрать `|| '/data/output'`);
- `task-handler.cjs:244,256`, `book-deletion.cjs:104`: `config.BOOKS_DIR` без fallback;
- `backend/scripts/audit-video-actions.js`, `backend/scripts/audit-scenes.js`:
  `require('../src/config/runtime-config')` вместо прямого `env || default`.
**Тесты:** `backend npm test` (task-handler/book-deletion покрыты существующими сьютами);
ручной прогон `node backend/scripts/audit-scenes.js --help`/фактический запуск в
read-only режиме (скрипты только читают).
**PASS:** сьют зелёный; скрипты запускаются и печатают `BOOKS_DIR=/data/books` при пустом env.
**BLOCKED:** скрипт завязан на запуск вне backend-каталога (путь require) — эскалировать.

### S4 — Верификация и grep-гейт

**Grep-гейт (новый тест `backend/tests/architecture/data-path-literals.test.js`):**

```
разрешено /data/books|/data/output:
  backend/src/config/runtime-config.js        (владелец дефолта)
  backend/tests/**                            (стабы)
  packages/animastor-vbook-runtime/src/index.js (комментарии)
  packages/animastor-vbook-runtime/README.md  (пример)
  docker-compose.yml, docker/compose/**        (deploy-конфиг, запрещён к правке)
  backups/**                                  (архивы)
всё остальное → FAIL
```

**Инварианты production (выполняются read-only, до и после S1–S3):**

| Проверка | Ожидание |
|---|---|
| `git status --porcelain` (монорепо) | только намеренные изменения S1–S3 (прежние `frontends/website/index.html`, `docker/compose/overlay…` — не наши, остаются) |
| `docker compose … config` (deploy-пара) | **diff пуст** (compose не правился) |
| `docker inspect animastor-backend` Mounts | источник/назначение идентичны (`…/data/output→/data/output`, `…/data/books→/data/books`) |
| `docker ps` | uptimes не сбрасывались (без рестартов) |
| `stat data, data/books, data/output` | mtime не изменились (`2026-08-21`, `2026-10-10`, `2026-09-14`) |
| `find data -newer <эталон>` | 0 файлов |
| PG/Redis: `scene_assets` 459, redis `DBSIZE` 302, `animastor:assets:*` 74 | без изменений |
| `npm test` в `backend`, `packages/animastor-orchestration`, `packages/animastor-vbook-runtime` | зелёные |
| `bash backend/../scripts/syntax-smoke.sh` (pretest) | зелёный |

**PASS:** все строки таблицы выполнены, гейт зелёный.
**BLOCKED:** любой инвариант нарушен → остановка, эскалировать владельцу.

### S5 — Документация в коде

Комментарий-контракт в `runtime-config.js` («единственная точка настройки корня;
`DATA_ROOT` → `books`/`output`; переопределения `BOOKS_DIR`/`OUTPUT_DIR`; персистентные
пуши — контейнерно-внутренние») + обновление примера `packages/animastor-vbook-runtime/README.md:30`
(показать `configureBooksRoot(config.BOOKS_DIR)` вместо литерала) — README-пример,
тесты не зависят.

### S6 — Отложено (явно вне S1–S5)

1. Передача `DATA_ROOT`/`BOOKS_DIR`/`OUTPUT_DIR` в compose `environment` (сейчас не нужна —
   дефолты совпадают; делать только вместе с миграцией хост-каталога).
2. Миграция хост-каталога: смена источников bind-mount (Stage 92 N1/N3, окно обслуживания).
3. Решение конфликта имени `/home/animastor/data` (e2e `install-driver.cjs:16` vs цель
   Stage 92) и правка `~/animastor/data` в installer-документации
   (`setup-contract.js:703,719`, `docker.js:47`, `docker-run.md`) — с учётом теста
   `installer-docker-deployment.test.js:50-53`.
4. Нормализация персистентных путей (37 строк PG + 74 ключа Redis + смешанная семантика
   image) — только с планом совместимости и откатом на копию Stage 93.
5. Устаревший путь `/home/sureg/…` в e2e-драйвере (Stage 90 наследие).

### Откат (общий)

- **S1–S5:** `git revert` одного коммита (или серии) → код возвращается к состоянию
  `4574b3b9`; конфигурация/данные/Git-история deploy не менялись, поэтому откат
  **не требует** рестартов, если `DATA_ROOT` не был выставлен в env контейнера
  (в S1–S5 он не выставляется — см. S6.1). Если владелец выставил его вручную —
  убрать переменную и выполнить один рестарт backend (документируется в задаче).
- **Данные:** не изменялись в принципе → откат не затрагивает данные.
- **Экстренный откат:** контейнер запущен с прежними образами/томами; при любой
  ошибке достаточно вернуть коммит — поведение байт-в-байт идентично дооткатному.

### Сводная таблица критериев

| Шаг | PASS | BLOCKED |
|---|---|---|
| S1 | новый конфиг-тест + полный `backend npm test` зелёные; дефолты байт-в-байт | побочные импорты/кэш конфига в тестах |
| S2 | orchestration + backend сьюты зелёные; гейт: литералов в `packages/*/src` нет | тесты завязаны на литерал вне whitelist |
| S3 | сьют зелёный; скрипты читают runtime-config | скрипт не запускается вне ожидаемого cwd |
| S4 | все инварианты таблицы выполнены, гейт зелёный | нарушен любой инвариант production |
| S5 | комментарий/README обновлены, сьюты зелёные | — |
| S6 | не выполняется (решения владельца) | конфликт имён, окно обслуживания, нормализация данных |

---

## 4. Блокеры и вопросы владельцу

| # | Вопрос | Откуда | Блокирует |
|---|---|---|---|
| Q1 | Решения D1–D9 Stage 94 (независимое хранилище, согласованность, канал уведомлений, носитель расписания, retention, судьба 8 книг, хранение `.env`, restore-drill, офсайт legacy) | Stage 94 §5 | Stage 94 (BLOCKED) |
| Q2 | Окно обслуживания и итоговый хост-путь (N1/N3 Stage 92) | Stage 92 | S6.2, миграция данных |
| Q3 | Конфликт имени `/home/animastor/data`: e2e-install-driver vs цель Stage 92 (§1.7) — переименовать цель, поменять драйвер, или согласовать общее назначение | Stage 92 N6 + §1.7 | S6.3, миграция |
| Q4 | Нормализация персистентных путей (37 PG + 74 Redis, смешанная семантика image): делать до миграции, вместе с ней или отложить | §1.5 | S6.4 |
| Q5 | Согласие на S1–S5 как на следующий этап (код-правки без влияния на поведение; рестарт backend не требуется) | §3 | запуск S1–S5 |

---

## 5. Подтверждение отсутствия изменений

| Что | Проверка | Результат |
|---|---|---|
| Данные `data/books`, `data/output` | `stat` mtime: `2026-08-21 12:16`, `2026-10-10 13:47`, `2026-09-14 08:32` | без изменений |
| Код монорепо | `git status --porcelain` = ` M frontends/website/index.html`, `?? docker/compose/overlay-backend-standalone.yml` — **прежнее состояние** (не создавалось этим этапом; HEAD `4574b3b9`) | без изменений |
| Чекаут `animastor-backend` | `git status` — прежние записи (deploy/, тесты, удалённый audit-orphan-books.js), HEAD `82c80af` | без изменений |
| Контейнеры | `docker ps`: backend/proxy **Up 45 hours**, pg/redis **Up 8 weeks**, gpu-hub 8 days — рестартов нет | без изменений |
| PostgreSQL | `scene_assets`=459 (read-only SELECT) | без изменений |
| Redis | `DBSIZE`=302 (read-only SCAN/GET/HGETALL) | без изменений |
| `.env` | читались только **имена** 14 переменных; значения не выводились | секреты не раскрыты |
| Отчёты Stage 87–94 | не открывались на запись | без изменений |
| Git-операции | `add/commit/checkout/stash` не выполнялись | без изменений |
| Пакеты/хранилища/сеть | `apt/npm install`, внешние хранилища, траты — нет | без изменений |

**Итог:** Stage 95 — **PASS**. Аудит (§1), контракт интерфейса (§2), план S1–S6 с
тестами, критериями PASS/BLOCKED и откатом (§3) подготовлены; система не изменена.
