# Stage 96 — Implement DATA_ROOT Configuration Safely

**Дата:** 2026-10-21 (UTC, 03:1x–03:5x)
**Область:** первый этап плана Stage 95 (шаги S1–S3): `DATA_ROOT` в
`backend/src/config/runtime-config.js`, закрытие подтверждённых production-литералов,
обходящих существующий интерфейс, тесты и статический grep-гейт.
**Режим:** изменение кода и тестов в монорепо. Production-конфигурация, деплой,
рестарты, реальные пути хранения, bind mounts, PostgreSQL, Redis, данные книг,
Docker Compose, `.env`, публикации (push/merge/publish) — не затрагивались.
GPU Hub не изменялся.

---

## 0. Итоговый статус

**PASS** — `DATA_ROOT` реализован, обходы интерфейса устранены, тесты и grep-гейт
зелёные, все границы (Этап 5) подтверждены read-only проверками.

| Показатель | Результат |
|---|---|
| Изменено production-файлов | **6** (`backend/src` ×4, `packages/animastor-orchestration/src` ×2) |
| Добавлено тест-файлов | **3** (backend ×2, orchestration ×1) |
| Локальные коммиты | **не созданы** (рабочее дерево; HEAD `4574b3b9`) |
| `backend npm test` (включая pretest syntax-smoke) | **986 passing / 5 failing** — все 5 отказов **предсуществующие** (§3.3) |
| `packages/animastor-orchestration npm test` | **19 passing / 0 failing** (6 новых) |
| Новые целевые тесты (config + grep-гейт) | **22 passing / 0 failing** |
| Syntax-smoke (pretest) | **All production JS/CJS files pass syntax check** |
| Literals `/data/books`,`/data/output` вне whitelist | **0** (гейт Stage 95 §3 S4) |
| Production/данные/БД/Compose/.env/GPU Hub | **без изменений** (§5) |

**Ключевые факты:**

1. Этап 1 (сверка плана Stage 95 с файлами) — все ссылки (строки, швы, тестовые
   привязки) совпали; устаревших предположений не обнаружено.
2. **Важное уточнение к плану (зафиксировано, не меняло задачу):** в монорепо
   `packages/animastor-orchestration` и в `backend/node_modules/@animastor/orchestration`
   — **разные копии**. npm-копия `0.1.1` устанавливается из registry
   (`package-lock.json:176`), production-контейнер собирает зависимости из registry
   (`backend/Dockerfile`: `npm install --omit=dev`), а `backend/src` монтируется в
   контейнер bind-mount (`/app/src`). Следствия:
   - правки `backend/src` вступят в силу **только при следующем рестарте backend**
     (сейчас в памяти процесса старый код) — рестарт запрещён Stage 96;
   - правки `packages/…/src` не влияют ни на backend-тесты (они грузят npm-копию),
     ни на production до **публикации пакета и пересборки образа** — запрещено Stage 96;
   - поэтому поведение закрытых сайтов проверяется **пакетными тестами по свежим
     исходникам** `src/` (§3.2), а не через npm-копию.
3. Контракт сохранённых путей соблюдён: дефолты `/data/books`,`/data/output`
   байт-в-байт сохранены (тесты §3.2), контейнерные монты и отсутствие путевых
   env в контейнере подтверждены (§5).

---

## 1. Этап 1 — Проверка плана Stage 95

Сверены все опорные пункты `95-data-path-abstraction-plan.md` с фактическим кодом
**до** изменений:

| Опора плана | Факт | Совпадение |
|---|---|---|
| `runtime-config.js:60-61` (единая точка), экспорт :282-283 | да | ✓ |
| `backend.cjs:163` `artifactRoot: () => config.OUTPUT_DIR \|\| '/data/output'` | да | ✓ |
| `backend.cjs:209` `configureBooksRoot(() => config.BOOKS_DIR)`, `:536` `outputRoot` | да | ✓ |
| `task-handler.cjs:244,256`, `book-deletion.cjs:104` (fallback) | да | ✓ |
| `scene-callbacks.js:281,393`, `reconciliation-engine.js:124,158` (литералы) | да | ✓ |
| `scene-callbacks.js:23` `artifactRoot`-шов; `reconciliation-engine.js:18` только `lazyHostBinding` | да — шов в reconciliation отсутствовал, добавлен | ✓ (план S2 предполагал именно это) |
| Оркестрация-тесты не вызывают затрагиваемые функции (`test/` содержит только `counter-reconciliation.test.js`) | да | ✓ |
| Биндят host-bindings только `backend.cjs:146` и `backend/tests/generation-test-bindings.cjs` (полная копия runtime-config) | да | ✓ — риск частичного мока `config` без `OUTPUT_DIR` отсутствует |
| `physical-move-gate.test.js:230` требует лишь наличие `artifactRoot:` (не строку-фолбэк) | да | ✓ — правка безопасна |
| Whitelist grep-гейта (§3 S4): runtime-config, tests, vbook-комментарии/README, compose, backups | фактический список подтверждён сканированием; добавлены `backend/scripts/audit-*` (Этап 3 запретил их менять) и `packages/*/test/` (пакетные тесты Stage 96) | ✓ (уточнение whitelist зафиксировано в коде гейта) |

Архитектура и файлы к моменту правок не изменились — устаревшие предположения
не применялись.

---

## 2. Изменённые файлы

### 2.1 Production-код (6 файлов)

| Файл | Изменение | Этап плана |
|---|---|---|
| `backend/src/config/runtime-config.js` | `DATA_ROOT` (нормализация: трим, только абсолютные, хвостовые слэши → пусто для `""`,`" "`,`"data/x"`,`"/"`); вычисление `OUTPUT_DIR`/`BOOKS_DIR`; экспорт `DATA_ROOT`; комментарий-контракт (§2.2 плана) | S1 (Этап 2) |
| `backend/src/backend.cjs:163` | `artifactRoot: () => config.OUTPUT_DIR` — локальный фолбэк убран (единый владелец дефолта — runtime-config) | S3 (Этап 3) |
| `backend/src/services/task-handler.cjs:244,256` | `path.join(config.BOOKS_DIR, …)` — 2 fallback-а убраны | S3 |
| `backend/src/services/book-deletion.cjs:104` | `path.join(config.BOOKS_DIR, …)` — fallback убран | S3 |
| `packages/animastor-orchestration/src/orchestration/scene-callbacks.js:281,393` | литерал → `artifactRoot()` (шов уже был в файле) | S2 |
| `packages/animastor-orchestration/src/runtime/reconciliation-engine.js:124,158` (+ импорт :18, помощник :21-23) | литералы → `artifactRoot()` через `hostBinding('artifactRoot')` | S2 |

`backend/scripts/audit-video-actions.js:29` и `audit-scenes.js:13` — **не изменялись**
(Этап 3: для корректности runtime не требуется; они в whitelist гейта).
Массовой замены строк по репозиторию не проводилось: правки точечные (6 файлов,
13 строк кода + комментарии).

### 2.2 Новые тест-файлы (3)

| Файл | Содержание |
|---|---|
| `backend/tests/data-path-config.test.js` | 13 тестов: дефолты без env, нормализация/невалидные `DATA_ROOT`, приоритет явных переменных, старые конфигурации, контракт контейнерных путей PG/Redis, статическое отсутствие fallback-ов в 3 backend-файлах |
| `backend/tests/architecture/data-path-literals.test.js` | grep-гейт Stage 95 §3 S4: рекурсивный скан 7 зон, whitelist, плюс позитивные проверки (orchestration чист, единственный владелец — runtime-config, composition-root без фолбэка) |
| `packages/animastor-orchestration/test/artifact-root-binding.test.js` | 6 поведенческих тестов по свежим исходникам пакета: 4 закрытых сайта строят пути из привязанного корня + байт-в-байт совпадение при корне `/data/output` |

**Коммиты:** не создавались (без отдельного согласования). Рабочее дерево:
4 modified + 3 untracked (новые тесты) в монорепо; HEAD `4574b3b9`.

---

## 3. Этап 4 — Тесты и статические проверки

### 3.1 Запуски

| Команда | Результат |
|---|---|
| `npm test` в `packages/animastor-orchestration` | **19 passing** (6 новых + 13 прежних), 0 failing |
| `npm test` в `backend` (pretest `syntax-smoke.sh` + mocha `tests/**/*.test.js`) | **986 passing, 5 failing** (все 5 — предсуществующие, §3.3) |
| Целевые: `mocha tests/data-path-config.test.js tests/architecture/data-path-literals.test.js` | **22 passing**, 0 failing |
| Grep-гейт (в составе suites) | **PASS**: литералы только в whitelist; `packages/animastor-orchestration/**` — 0; `backend/src/**` — только `runtime-config.js` |

### 3.2 Покрытие требований Этапа 4

| № | Требование | Где |
|---|---|---|
| 1 | дефолтные пути без переменных окружения | `data-path-config.test.js` «1. дефолты…» (2 теста) |
| 2 | `DATA_ROOT` с вычислением books/output | «2. DATA_ROOT как общий корень» (3 теста) |
| 3 | приоритет явных `BOOKS_DIR`/`OUTPUT_DIR` | «3. приоритет…» (3 теста) |
| 4 | обратная совместимость старых конфигураций | «4. обратная совместимость…» (4 теста) + пакетный тест «байт-в-байт равна прежнему литералу» |
| 5 | поведение затронутых orchestration/backend-компонентов | `artifact-root-binding.test.js` (6: `checkOrphanVideoState`, `checkOrphanImageState`, `handleVideoCompleted`, `handleImageCompleted` + совместимость) + «5. backend: локальные fallback-литералы устранены» (3) + существующие `reconciliation-engine.test.js`, `happy-path.test.js` и др. в составе 986 |
| 6 | сохранение контейнерных путей PG/Redis | «6. контейнерные пути PG/Redis сохранены» (`/data/output`, `/data/books` байт-в-байт) + гейт (никакой код вне runtime-config не задаёт эти корни) + read-only проверки данных (§5) |

Семантика закрытых сайтов не менялась: подстановка `artifactRoot()` даёт ровно ту же
строку при том же корне (доказано тестом на корне `/data/output`).

### 3.3 Предсуществующие отказы (5) — не вызваны Stage 96

| Отказ | Причина | Доказательство не-причастности Stage 96 |
|---|---|---|
| `installer-package-boundary.test.js` IB-G15 «package stays private» | в `packages/animastor-installer/package.json` нет поля `private` (пакет опубликован: `ce1fb69c npm(release): bump … installer to 0.1.1`) | файл Stage 96 не изменялся |
| `phase2-redis-ownership-contract.test.js` ×3 | нет `docs/architecture/PHASE_2_CONTRACTS.md` — удалён коммитом `4574b3b9` (Stage 87 «remove migrated docs/»), это HEAD | документ не восстанавливался Stage 96 |
| `phase5-runtime-result.test.js` T9 | нет `backend/src/runtime/index.js` — удалён `d4444cbb`/`b71b9674` (до HEAD) | файл не изменялся Stage 96 |

Отказы статические (ENOENT/чтение package.json), не загружают изменённые модули.
Исправление — отдельное решение владельца (не в объёме Stage 96).

**Итерация в Этапе 4:** первая версия гейта дала 3 отказа (собственный пакетный тест
содержал литерал в whitelist-нужном месте; дубль файла в списке владельца). Гейт
уточнён: whitelist `packages/*/test/`, дедупликация, фильтр whitelist в проверке
orchestration — итог 22/22 passing.

---

## 4. Подтверждение обратной совместимости

1. **Без переменных окружения — прежние значения байт-в-байт:** `DATA_ROOT=''`,
   `OUTPUT_DIR='/data/output'`, `BOOKS_DIR='/data/books'` (тест «1. дефолты…»).
2. **Старые конфигурации не изменились:** только `OUTPUT_DIR`, только `BOOKS_DIR`,
   обе переменные, пустые строки — все комбинации дают прежние результаты
   (тесты «4. обратная совместимость…»).
3. **Нормализация не меняет семантику:** `'/srv/x/'` → `'/srv/x'`; относительные
   пути, `'/'`, `'//'`, пустое/шумное — игнорируются → прежние дефолты.
4. **Поведение закрытых сайтов идентично:** при корне `/data/output`
   `handleVideoCompleted`/`checkOrphanVideoState` формируют ровно прежние строки
   `/data/output/<buildId>/<book_ch_sc>.mp4` (пакетный тест совместимости).
5. **Контейнерные пути данных не тронуты:** тест п.6 + `grep` показывает, что
   дефолты остались `'/data/output'`/`'/data/books'` только в runtime-config;
   в контейнере `animastor-backend` путевых env (`DATA_ROOT`/`BOOKS_DIR`/`OUTPUT_DIR`)
   не задано → при рестарте применятся те же значения.
6. **Отсутствие побочных эффектов загрузки конфига в тестах:** helper
   `loadConfig()` восстанавливает и env, и `require.cache` (синглтон остальных
   тестов не затрагивается) — подтверждено полным прогоном 986 тестов.

---

## 5. Этап 5 — Проверка границ (read-only)

| Граница | Проверка | Результат |
|---|---|---|
| Production не изменён | `docker ps`: backend **Up 45 h**, proxy **Up 46 h**, pg/redis **Up 8 weeks (healthy)**, gpu-hub **Up 8 days** | ✓ рестартов нет |
| Монты не изменены | `docker inspect animastor-backend`: `…/data/output → /data/output`, `…/data/books → /data/books`, `backend/ai → /app/ai`, `backend/tests → /app/tests` | ✓ идентично Stage 95 |
| Путевых env в контейнере нет | `docker inspect` env: `DATA_ROOT/BOOKS_DIR/OUTPUT_DIR` отсутствуют | ✓ |
| Docker Compose не изменён | mtimes: `animastor-backend/deploy/docker-compose.yml` **19.10 06:17**, `deploy/overlay…yml` **12.10**, `docker-compose.yml` (монорепо) **08.10**, `docker/compose/overlay…` **10.10** — все раньше Stage 96 | ✓ |
| `.env` не изменён | mtime `deploy/.env` **19.10 06:31**; значения не читались | ✓ |
| Контейнерные пути `/data/*` в коде сохранены | `grep`: только runtime-config (строки 80-81), дефолты прежние | ✓ |
| PostgreSQL не менялась | `scene_assets` = **459** (как в Stage 95) | ✓ только SELECT |
| Redis не менялся | `DBSIZE` = **302**, `animastor:assets:*` = **74** (как в Stage 95) | ✓ только SCAN/GET |
| Данные не изменялись | `data/books`: **61 файл / 1 703 724 Б** (== Stage 93), mtime `2026-10-10 13:47`; `data/output`: **95 файлов / 63 203 425 Б** (== Stage 93), mtime `2026-09-14 08:32` | ✓ |
| Контрольные суммы (baseline на будущее) | tree-hash `books` = `f9b2731f…32633` (sha256 от отсортированного списка sha256), `output` = `71d32682…e750e` | ✓ зафиксировано в отчёте |
| GPU Hub не затронут | `git -C animastor-gpu-hub status --porcelain` пуст, HEAD `0f489c7`; контейнер Up 8 days | ✓ |
| Изменения только в ожидаемом репо | монорепо: 4 modified + 3 новые тест-файлы + **прежние** `frontends/website/index.html` и `docker/compose/overlay…` (были до этапа); `animastor-backend`: статус **идентичен** снапшету до этапа (`D audit-orphan-books.js`, `M backend/tests/*` ×4, `?? deploy/`, `?? freebuff-chat-…md`) | ✓ |
| Git-публикации | `git log` HEAD не изменился (`4574b3b9`), stash пуст, push/merge/deploy не выполнялись | ✓ |
| Данные БД/Redis не нормализовались | изменений строк с путями не производилось (код Stage 96 путей в БД/Redis не пишет в принципе) | ✓ |

**BLOCKED-условие не наступило:** production-деплой и изменение сохранённых путей
не требовались и не выполнялись.

---

## 6. Оставшиеся блокеры

| # | Блокер | Природа |
|---|---|---|
| B1 | **Эффект backend-правок на production наступит только после рестарта `animastor-backend`** (bind-mount `/app/src` читается при загрузке модулей). Рестарт запрещён Stage 96 и требует окна/согласования (Stage 92 N1). Изменения обратно-совместимы, но деплой — отдельный этап. | решение владельца |
| B2 | **Правки `packages/animastor-orchestration` не действуют в production и в backend-тестах** до публикации новой версии пакета в npm и пересборки образа backend (`Dockerfile` тянет `@animastor/orchestration@0.1.1` из registry). Публикация/deploy запрещены Stage 96. | решение владельца (Stage 82/83-подобный релиз) |
| B3 | **Расхождение копий:** `backend/node_modules/@animastor/orchestration@0.1.1` содержит прежние литералы (npm-копия). Backend-тесты этих путей проверяют старую (production-актуальную) копию; монорепо-исходники покрыты пакетными тестами. Синхронизация наступит с B2. | следствие B2 |
| B4 | **5 предсуществующих отказов тестов** (§3.3: удалённые Stage 87 документы, удалённый `runtime/index.js`, поле `private` у installer) — требуют отдельного решения; не связаны со Stage 96. | решение владельца |
| B5 | **Решения Stage 95 §4 / Stage 94 §5:** D1–D9 (независимое хранилище и др.), Q2 (окно/путь миграции), Q3 (конфликт `/home/animastor/data`), Q4 (нормализация 37 PG + 74 Redis путей), Q5 (запуск следующих шагов S6). | решение владельца |

## 7. Следующий безопасный шаг

1. **Согласовать локальный коммит** Stage 96 (4 изменённых файла + 3 новых теста;
   без push) — по явному решению владельца, поскольку коммиты не создавались.
2. Решение по B1 (рестарт backend в согласованное окно — изменения уже покрыты
   тестами и обратно-совместимы) и по B2 (публикация `@animastor/orchestration`
   с закрытыми литералами + пересборка образа) — **отдельные этапы**;
   до этого production работает прежним кодом, что полностью детерминировано.
3. Опционально: реанимация/исправление 5 предсуществующих отказов (B4) и
   нормализация персистентных путей (B5/Q4) — после решений владельца.
