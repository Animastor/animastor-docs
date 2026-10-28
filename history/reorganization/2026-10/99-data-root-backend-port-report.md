# Stage 99 — Port DATA_ROOT to animastor-backend

**Дата:** 2026-10-21 (UTC)
**Итог:** **PASS** — изменения Stage 96 перенесены в `animastor-backend` локальными
коммитами; тесты и grep-гейт зелёные; push/publish/deploy/production не выполнялись.

---

## 1. Источник и целевой репозиторий (до операции)

| | монорепо `animastor` | `animastor-backend` |
|---|---|---|
| Путь | `/home/animastor/animastor` | `/home/animastor/animastor-backend` |
| Ветка / HEAD | `c21.4-physically-extract-analysis-from-backend` / `088f3fa9` | `main` / `82c80af` |
| Upstream | `origin/c21.4-…` = `4574b3b9` → ahead 1 | `origin/main` = `82c80af` → в синхроне |
| Remotes | `origin = /home/animastor/repos/animastor.git` | `origin = /home/animastor/repos/animastor-backend.git`, `github = git@github.com:Animastor/animastor-backend.git` |
| Dirty | 2 прежних (`frontends/website/index.html`, `?? docker/compose/overlay…`) | 7 прежних (§4) |

**Исходный коммит:** `088f3fa97c12273e093459839dca6b8a677d791b`
(`feat(config): add DATA_ROOT path abstraction`, 9 файлов, 542+/12−, родитель `4574b3b9`).
Состав сверен со Stage 98 §1 — 1:1.

## 2. Получение объектов и перенос

1. Грязь целевого репо сохранена до операции:
   `99-preport-backend-dirty.patch` (243 строки, в `/home/animastor/reorg-2026-10-19/`).
2. Базлайн `cd backend && npm test`: **929 passing / 24 pending / 0 failing**
   (в отличие от монорепо Stage 96 — предсуществующих отказов в backend-репо нет).
3. Локальный fetch (изменён только `FETCH_HEAD`, опубликованные refs не тронуты):
   `git -C /home/animastor/animastor-backend fetch /home/animastor/animastor 088f3fa97c…`
4. `git cherry-pick -n 088f3fa9…` — **без конфликтов**, auto-merge
   `backend/src/backend.cjs` и `packages/…/reconciliation-engine.js` (дивергентные
   файлы по Stage 98 §2 C1/C2; регионы правок применены по контексту).
5. Сверка содержимого staged vs исходный коммит:
   - 7 из 9 файлов — **байт-в-байт идентичны** исходному коммиту;
   - `backend.cjs` и `reconciliation-engine.js` — ожидаемо отличаются от монорепо-версий
     собственной историей backend-репо (Stage 47/50 и др.), но все **4 ханка
     reconciliation-engine** (импорт `hostBinding`, `videoPath`,
     `resolveCanonicalSceneImage('/data/output')→artifactRoot()`, помощник) и ханк
     `backend.cjs` (`artifactRoot: () => config.OUTPUT_DIR,`, строка 176) применены
     точно — проверено по `git diff --cached`.
6. Портированы все **9 файлов**, как рекомендовано Stage 98 §4 (6 backend + 3 как
   зеркало `packages/animastor-orchestration`); зеркало не влияет на npm-зависимость.

## 3. Адаптация C3 — два backend-only литерала (отдельный коммит)

Оба литерала **подтверждены как обходы** нового интерфейса: до правки grep-гейт падал
ровно на них (2 теста: «литерал вне whitelist» и «единственный владелец»):

| Файл | Было | Стало | Семантика |
|---|---|---|---|
| `backend/src/storage/postgres/repositories/scene-assets-repo.js:91` | `nodePath.resolve(runtimeConfig.OUTPUT_DIR \|\| '/data/output')` | `nodePath.resolve(runtimeConfig.OUTPUT_DIR)` | `OUTPUT_DIR` после Stage 96 всегда определён → фолбэк был мёртвым кодом; поведение байт-в-байт то же |
| `backend/src/services/orphan-books-audit.js:39,53` | JSDoc `(default /data/books)`; `opts.booksDir \|\| process.env.BOOKS_DIR \|\| '/data/books'` | JSDoc `(default: config.BOOKS_DIR)`; `opts.booksDir \|\| config.BOOKS_DIR` (+ `require('../config/runtime-config')`) | без env — прежние значения байт-в-байт; `opts.booksDir` (передаётся тестом и CLI) имеет приоритет; с `DATA_ROOT`/`BOOKS_DIR` аудит теперь следует каноничному конфигу (ранее литерал его обходил) |

Правки минимальные (2 файла, 4+/3−), в объёме, согласованном Stage 98 §5 C3.
`scripts/audit-orphan-books.js` (удалён в прежней грязи) не трогался. Semantics
аудит-скрипта не менялись — проверено явным прогоном
`tests/orphan-books-diagnosis.test.js`: **6 passing** (живой PostgreSQL, READ-ONLY SELECT).

## 4. Локальные коммиты (созданы, НЕ опубликованы)

| # | SHA | Сообщение | Состав |
|---|---|---|---|
| 1 | **`fae1beed61d8350354f7c44535221a8ed1385c8a`** | `feat(config): port DATA_ROOT abstraction (Stage 96 -> backend)` | 9 файлов порта, 542+/12− (1:1 с `088f3fa9`) |
| 2 | **`e4255524eed3d54e9fa4c1612cea118275a084ed`** | `refactor(config): close backend-only data-path literals bypassing runtime-config (Stage 98 C3)` | 2 файла, 4+/3− |

Автор/коммиттер: `Animastor <animastor@66-116-225-136.webhostbox.net>` — разовые
флаги `-c` (как Stage 97; `git config` repo/global не менялся).
Родительская цепочка линейна: `82c80af → fae1beed → e4255524`. История не переписывалась.

## 5. Тесты

| Прогон | До порта | После порта |
|---|---|---|
| `backend npm test` (pretest syntax-smoke + mocha) | 929 passing / 24 pending / 0 failing | **935 passing / 24 pending / 0 failing** |
| Целевые: `tests/data-path-config.test.js` + `tests/architecture/data-path-literals.test.js` | (файлов нет) | **22 passing / 0 failing** — вкл. контракт «контейнерные пути PG/Redis `/data/books`,`/data/output` байт-в-байт» и весь grep-гейт (6 тестов) |
| Grep-гейт литералов | — | **PASS**: `backend/src` — только `runtime-config.js` владеет дефолтами; `packages/animastor-orchestration/src` — **0** литералов |
| `packages/animastor-orchestration npm test` | 19 passing | **19 passing / 0 failing** (включая 6 `artifact-root-binding`) |
| `npm run test:syntax` | — | **All production JS/CJS files pass syntax check** |
| `tests/orphan-books-diagnosis.test.js` (явный, живой PG) | — | **6 passing** |

Замечание (предсущественная особенность репо, не регрессия порта): shell-глоб
`tests/**/*.test.js` в `npm test` разворачивается как `tests/*/*.test.js` — верхнеуровневые
тест-файлы (`tests/*.test.js`, включая новый `data-path-config.test.js`) в полный
прогон не попадают (так было и до порта для 120 прежних top-level файлов; в монорепо
глоб идентичен). `data-path-literals.test.js` (в `tests/architecture/`) в полный прогон
входит и зелёный. Оба новых файла зелёные при явном запуске (22 passing).

## 6. Git-состояние и отсутствие публикаций

| Проверка | Результат |
|---|---|
| Ветка / HEAD после | `main` / `e4255524`; **ahead 2** от `origin/main` (= `82c80af`) |
| Refs (до/после, `for-each-ref`) | изменился **только** локальный `refs/heads/main` (`82c80af` → `e4255524`); все remote refs (`origin/main`, `github/main`, др.) **идентичны** |
| Reflog | только 2 записи `commit:`; push/merge/rebase/reset — **не выполнялись** |
| `git push` / merge в опубликованную ветку | **не выполнялись** |
| npm publish / сборка образов / deploy | **не выполнялись** |
| Рабочее дерево после | прежняя грязь **сохранена нетронутой** (5 M/D + `?? deploy/`, `?? freebuff-chat-…md`); staged пуст; в коммиты попали только 11 файлов порта/адаптаций; скан секретов staged-дифов — 0 (6 ложных `sk-` внутри «ta**sk-**handler») |
| Монорепо | HEAD `088f3fa9`, статус = снапшот Stage 97 — **не менялся** |

## 7. Production и данные — без изменений

| Граница | Проверка (read-only) | Результат |
|---|---|---|
| Контейнеры | `docker ps` | backend **Up 2 days**, pg/redis **Up 8 weeks (healthy)**, gpu-hub 8 days — рестартов Stage 99 нет |
| Монты | `docker inspect animastor-backend` | `…/data/output → /data/output`, `…/data/books → /data/books`, `backend/ai → /app/ai`, `backend/tests → /app/tests` — **идентичны** Stage 96 |
| Путевые env в контейнере | `docker inspect` env | `DATA_ROOT/BOOKS_DIR/OUTPUT_DIR` отсутствуют (как Stage 96) |
| Контейнерные пути в коде | grep | дефолты `'/data/output'`,`'/data/books'` — **только** `runtime-config.js:80-81`; orchestration-src — 0 |
| `.env` / Compose | mtimes | `deploy/.env` **19.10 06:31**, `deploy/docker-compose.yml` **19.10 06:17** — не менялись |
| Данные | подсчёт файлов | `data/books` **61**, `data/output` **95** — как Stage 93/96; не изменялись |
| PostgreSQL / Redis | — | обращений на запись не было (аудит-тест — READ-ONLY SELECT) |
| GPU Hub | — | не затронут |

Правки `backend/src` (включая C3) и коммиты Stage 99 в production **не действуют**:
код `/app/src` запечён в образ (Stage 98 C7); доставка — отдельный GHCR-релиз,
запрещённый этим этапом. Новые тест-файлы видны в контейнере только через bind-mount
`/app/tests` и на работающий процесс не влияют.

## 8. Оставшиеся блокеры (вне объёма Stage 99)

| # | Блокер | Природа |
|---|---|---|
| B2/C6 | Публикация согласованной версии `@animastor/orchestration` (0.1.1 vs 0.1.3) и пересборка образа — правки `packages/` в backend-репо зеркальны и npm-копию не заменяют | решение владельца |
| C7 | Доставка backend-правок в production — GHCR-релиз/пересборка образа (запрещены Stage 99) | решение владельца |
| — | Push ветки `main` (ahead 2) — запрещён Stage 99 | решение владельца |
| G-глоб | Предсущественное исключение top-level `tests/*.test.js` из `npm test` (§5) — расширение глоба может вскрыть старые отказы 121 файла | отдельное решение, не порт |

## 9. Rollback

- Коммит 2 (C3): `git revert e4255524` (гейт при этом снова упадёт).
- Коммит 1 (порт): `git revert fae1beed` (затем e4255524, если не откачен).
- Запрещено `git reset --hard` — уничтожит 7 прежних записей рабочего дерева
  (восстановление — `99-preport-backend-dirty.patch` + `git checkout --` по списку §6).
- Production-откат не требуется (образ не менялся).

## 10. Отчёты

- Отчёт Stage 99: `/home/animastor/reorg-2026-10-19/99-data-root-backend-port-report.md` (этот файл).
- Сохранённая грязь до порта: `/home/animastor/reorg-2026-10-19/99-preport-backend-dirty.patch`.
- Посторонних изменений и секретов нет; отчёты в коммиты не включались (лежат вне репозиториев).
