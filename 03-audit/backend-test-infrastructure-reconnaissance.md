# Разведка тестовой инфраструктуры backend (отчёт)

> Статус: разведка, ничего не менялось.

## 1. Как тесты запускаются в CI — и сколько реально запускается

**Команда:** `mocha --exit tests/**/*.test.js` (скрипт `test` в `backend/package.json`; в рабочем варианте передаётся в одинарных кавычках).

**CI (`.github/workflows/backend-ghcr-release.yml`) не запускает тесты вообще.** В workflow только:
- `docker build ./backend`,
- изолированный **smoke**: проба `GET /health` (+ redis PONG) на собранном образе,
- пуш тегов в GHCR.

`npm test` / `npx mocha` / `mocha` в workflow **нет** (подтверждено grep'ом). Тесты в CI не крутятся — зелёный CI не защищает от регрессий в тестах.

**Последний полный прогон (мой, локально, полное окружение: PG localhost:5432, Redis 127.0.0.1:6379, NODE_ENV=test, временные BOOKS_DIR/OUTPUT_DIR):**
```
total=3216  pass=3208  fail=8  pending=0   files=176
```
(прогон через programmatic API Mocha с `.mocharc.json` биндингами; результат в `/tmp/opencode/results.json`)

## 2. Восемь падающих тестов — полный прогон и изолированный

Запустил каждую из 176 тестовых папок/файлов в **отдельном процессе** (чистый `require.cache`, свежий `process`), чтобы убрать порядок. Результат: **те же 8 упали и в изоляции** — т.е. они **не зависят от порядка**.

| # | Тест (файл :: название) | Ошибка | Причина (1 строка) |
|---|---|---|---|
| 1 | `architecture/phase2-redis-ownership-contract.test.js :: Phase 2 ownership docs mention the four dangerous places` | `ENOENT … PHASE_2_CONTRACTS.md` | **устаревший тест** — ссылается на несуществующий документ |
| 2 | `…phase2-redis-ownership-contract.test.js :: dangerous place 4 … is documented as best-effort` | `ENOENT … PHASE_2_CONTRACTS.md` | **устаревший тест** — документ не создан |
| 3 | `…phase2-redis-ownership-contract.test.js :: shared-pool and LAC in-process state are documented as backend-owned` | `ENOENT … PHASE_2_CONTRACTS.md` | **устаревший тест** — документ не создан |
| 4 | `architecture/phase5-runtime-result.test.js :: T9: no dynamic/template/concat require … runtime/**` | `ENOENT … backend/src/runtime/index.js` | **устаревший тест** — ссылается на удалённый файл |
| 5 | `architecture/installer-package-boundary.test.js :: IB-G15: package.json pins (main, bin, private)` | `expected undefined to equal true` | **устаревший тест** — в `packages/animastor-installer/package.json` нет `private: true` |
| 6 | `ai-endpoint-sharing.test.js :: no policy row is enabled unless the owner explicitly enabled it` | `expected 1 to equal +0` | **зависит от окружения / общий state PG** — строка политики осталась в БД от прошлого прогона |
| 7 | `ai-shared-inference.test.js :: 16b. shared snapshot is safe for health checks` | `expected 1 to equal +0` | **зависит от окружения / общий state** — shared-snapshot не сбрасывается между прогонами |
| 8 | `bootstrap-cancel-continue.test.js :: clears the tombstone when the user explicitly continues` | message не совпал с `/cannot determine next window offset/` | **зависит от окружения** — приложение возвращает «AI assistant is not available…» вместо ожидаемого |

**20 в изолированном не нашлось:** изоляция не добавила новых падений — ровно 8, и те же самые.

## 3. Откуда зависимость от порядка

В этом прогоне **зависимости от порядка среди падающих нет** — все 8 падают в одиночку.

Но **общий state в инфраструктуре есть**, и он потенциальный источник порядка-зависимости для других тестов:
- **`.mocharc.json`** требует `tests/vbook-test-bindings.cjs` + `tests/generation-test-bindings.cjs` *до каждого теста* — они мутируют **глобальные порты** `@animastor/generation` (dispatchTransport, profileStore, bookData), `@animastor/orchestration` (persistence, sceneData, placeholderAudio, progressEvents, audioFsm, videoFsm, hubCancel, layerConfig), `configureBooksRoot`, `setStructureDetector`, `bindHostModules` — все в общем `require.cache`.
- **Общий PG-пул** (`src/storage/postgres/database`,单例 `pool`) — тесты пишут строки (политики, сессии, книги) и не всегда чистят за собой → остатки между файлами.
- **Общий Redis** (`ioredis` на `localhost:6379`, ключи `REDIS.*` из `runtime-config`) — локи, сессии, pub/sub не сбрасываются между файлами.
- **`process.env`** (`BOOKS_DIR`, `OUTPUT_DIR`, `DATA_ROOT`, `LEASE_TTL_S` и т.д.) — читается_once при загрузке `runtime-config`.

**Виновники порядка (потенциально):** `ai-endpoint-sharing` и `ai-shared-inference` — пишут в PG/Redis общие ключи без `beforeEach`-очистки.

## 4. Симлинки `node_modules/@animastor/editor` и `/generation`

**animastor-backend** — все 16 пакетов `@animastor/*` — симлинки на `../../packages/<имя>`, включая `editor` → `../../packages/animastor-editor` и `generation` → `../../packages/animastor-generation`.

**animastor-backend-hotfix** — `editor` и `generation` — **абсолютные** симлинки на `/home/animastor/animastor-backend/backend/node_modules/@animastor/{editor,generation}` (соседний репозиторий).

**animastо (монорепо) backend** — `editor` и `generation` — обычные директории (реестровые копии), только `contracts` — symlink.

**Чем грозит Docker-сборке (там симлинков нет):**
- Сборка контекста `./backend` (`Dockerfile` в `backend/`), `npm install` ставит `@animastor/*` **из реестра**, а не из локальных `packages/`. Симлинков в образе не будет.
- В разработке тесты и приложение тянут код из локальных `packages/` (через symlink — актуальный, может быть неопубликованным). В Docker-образе окажется код из реестра — **возможно другая версия**, с иными экспортами/портами.
- Итог: **«работает у меня, не работает в прод-образе»** — невоспроизводимая сборка, разное поведение портов orchestration/generation, возможны `Cannot find module` или broken `bindHostModules`. Нет детерминизма между dev, тестами и образом.

## План чинения (порядок, чтобы `npx mocha --exit 'tests/**/*.test.js'` дал зелёный CI)

| Шаг | Что чинить | Почему primero |
|-----|-----------|----------------|
| 1 | **Устаревшие тесты (6 шт.)**: `phase2-redis-ownership-contract` ×3 (удалить/skip или создать `docs/architecture/PHASE_2_CONTRACTS.md`), `phase5-runtime-result` (удалить/skip или восстановить `backend/src/runtime/index.js`), `installer-package-boundary` (скорректировать ожидание или добавить `private: true` в `packages/animastor-installer/package.json`) | Самый быстрый выигрыш — 6/8 падений убраны без touching продакшена |
| 2 | **Общий state PG/Redis (2 шт.)**: в `ai-endpoint-sharing` и `ai-shared-inference` добавить `beforeEach`/`after` очистку своих строк и ключей | Убирает зависимость от остатков прошлых прогонов — тесты детерминированные |
| 3 | **Окружение/сообщение (1 шт.)**: `bootstrap-cancel-continue` — актуализировать ожидаемое сообщение под текущий ответ приложения | Последний 낙ший тест |
| 4 | Проверить `npm test` = `3216 / 3216` зелёный локально | Критерий готовности |
| 5 | **CI**: добавить job `npm test` (с сервисами `postgres:16` + `redis:7`) в `backend-ghcr-release.yml` | Сейчас тесты в CI не запускаются — только `/health` smoke |
| 6 | **Симлинки**: привести версии `@animastor/*` в `package.json` к реестровым; добавить `.dockerignore` для контекста `./backend` и запинить версии | Docker-образ будет собирать тот же код, что и тесты — детерминированная сборка |

После шагов 1–4 `npm test` зелёный; после шага 5 CI будет зелёным и по тестам; после шага 6 сборка образа перестанет зависеть от локальных симлинков.
