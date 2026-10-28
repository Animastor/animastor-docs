# Stage 98 — DATA_ROOT Commit Portability Audit

**Дата:** 2026-10-21 (UTC, 04:2x–04:4x)
**Итог:** **PASS (аудит выполнен)** — коммит `088f3fa9` портируем; перенос НЕ выполнялся.
**Строго read-only:** ни одного изменения в рабочих деревьях, refs, remotes, production, БД.
(Записи `/tmp/opencode/*` — временные копии для `diff`, вне репозиториев.)

---

## 1. Коммит `088f3fa97c12273e093459839dca6b8a677d791b` — состав подтверждён

Репозиторий: `/home/animastor/animastor`, ветка
`c21.4-physically-extract-analysis-from-backend`, родитель `4574b3b9`,
автор `Animastor <animastor@66-116-225-136.webhostbox.net>`, 9 файлов,
542+/12−. Состав 1:1 с отчётом Stage 96 §2:

```
M backend/src/backend.cjs
M backend/src/config/runtime-config.js
M backend/src/services/book-deletion.cjs
M backend/src/services/task-handler.cjs
A backend/tests/architecture/data-path-literals.test.js
A backend/tests/data-path-config.test.js
M packages/animastor-orchestration/src/orchestration/scene-callbacks.js
M packages/animastor-orchestration/src/runtime/reconciliation-engine.js
A packages/animastor-orchestration/test/artifact-root-binding.test.js
```

Коммитов 95–98 в аудируемом диапазоне нет; `088f3fa9` — единственный кандидат.

## 2. Сравнение базовых версий (монорепо `@4574b3b9` vs `animastor-backend @82c80af`)

| Файл коммита | База монорепо | База backend | Вердикт порта |
|---|---|---|---|
| `backend/src/config/runtime-config.js` | `45a42e86` | `45a42e86` | **ИДЕНТИЧНЫ → чистое применение** |
| `backend/src/services/book-deletion.cjs` | `fdbbe860` | `fdbbe860` | **ИДЕНТИЧНЫ → чисто** |
| `backend/src/services/task-handler.cjs` | `a795a75d` | `a795a75d` | **ИДЕНТИЧНЫ → чисто** |
| `backend/src/backend.cjs` | `3e41676b` | `1ac3aa2e` | дивергенция **80 строк в других регионах**; регион правки (комментарий §32.29 step 4a + строка `artifactRoot`) **байт-в-байт идентичен** (в backend это строки 172–177) → ожидается чистое применение ганка, проверить после |
| `backend/tests/architecture/data-path-literals.test.js` | отсутствует | отсутствует | новый → чистое добавление |
| `backend/tests/data-path-config.test.js` | отсутствует | отсутствует | новый → чистое добавление |
| `packages/…/scene-callbacks.js` | `afac1118` | `afac1118` | **ИДЕНТИЧНЫ → чисто** |
| `packages/…/reconciliation-engine.js` | `1393bd49` | `4cf567f3` | дивергенция **224 строки** (в backend-репо свои правки Stage 47/50); все **4 сайта правки** в backend-версии локально идентичны базе монорепо (import :18, `videoPath` :124, `resolveCanonicalSceneImage('/data/output')` :158, помощник) → ганки применяются по контексту, но файл в целом различается → см. конфликт C2 |
| `packages/…/test/artifact-root-binding.test.js` | отсутствует | отсутствует | новый → чистое добавление |

Дополнительно: объекты git **не разделяются** между репозиториями
(`git cat-file` для `088f3fa9`/`4574b3b9` в `animastor-backend` → отсутствуют) →
прямой `cherry-pick` без предварительного локального `fetch` невозможен (§5).

## 3. Собственные изменения `animastor-backend` — конфликтов с DATA_ROOT нет

Рабочее дерево (7 записей, все прежние, сняты до/после аудита — идентичны):

```
 D backend/scripts/audit-orphan-books.js
 M backend/tests/ai-endpoint-sharing.test.js
 M backend/tests/ai-shared-inference.test.js
 M backend/tests/architecture/installer-package-boundary.test.js
 M backend/tests/architecture/phase5-runtime-result.test.js
?? deploy/
?? freebuff-chat-2026-10-11T07-41-12.445Z.md
```

- Пересечение грязи с 9 файлами коммита — **пустое** (0 совпадений).
- Дифы всех 4 изменённых тестов: **0 упоминаний** `DATA_ROOT|OUTPUT_DIR|BOOKS_DIR|/data/books|/data/output|artifactRoot`.
- Удалённый `audit-orphan-books.js` **не входит** в коммит `088f3fa9` (и в монорепо его нет).
- Никаких иных конфликтующих правок в `backend/src` и `packages/` нет (кроме дивергенции историй, §2).

## 4. Классификация: что применимо к backend, что уходит в orchestration-публикацию

### 4.1 Применимо к `animastor-backend` напрямую (6 файлов)
`backend/src/backend.cjs`, `backend/src/config/runtime-config.js`,
`backend/src/services/{task-handler,book-deletion}.cjs` + 2 новых теста.
Инфраструктура портируемости подтверждена:
- раскладка идентична (`backend/…`, `packages/…`); `pretest: bash ../scripts/syntax-smoke.sh`
  и `scripts/syntax-smoke.sh` есть; `test` = `mocha --exit tests/**/*.test.js` → новые тесты подхватываются;
- `data-path-config.test.js` резолвит пути от `__dirname/..` (= `backend/`) → переносим;
- гейт `REPO_ROOT = ../../..` от `backend/tests/architecture` → корень репо; отсутствующие корни
  (`frontends`, `backups` в backend-репо) обрабатываются через `fs.existsSync` → не падают;
  `deploy/` в `SCAN_ROOTS` не входит → compose-литералы backend-репо гейтом не сканируются.

### 4.2 Относится к orchestration → публикация отдельным процессом (3 файла)
`scene-callbacks.js`, `reconciliation-engine.js` + пакетный тест.
- В `animastor-backend` есть **собственная копия** `packages/animastor-orchestration`
  (версия `0.1.3`, в монорепо `0.1.1`; npm-зависимости: монорепо `^0.1.1`,
  backend `^0.1.3`; npm-копии в `node_modules`: `0.1.1` vs `0.1.3`).
- Тестовый шов переносим: новый тест сам биндит `artifactRoot` через `bindHostModules`
  (`wire()`, строка 59), `test/test-bindings.js` в обоих репо идентично его не содержит —
  пакетный тест воспроизводим без доработок.
- **Согласованная версия пакета — решение владельца** (какая линия публикуется:
  `0.1.1→0.1.2`, `0.1.3→0.1.4` или обе), до публикации зависимость `^…` продолжает
  тянуть прежний код из registry → **публикация npm и пересборка образов запрещены Stage 98**.

**Рекомендация по составу порта:** переносить **все 9 файлов** (6 backend + 3 как зеркало
`packages/` в backend-репо) — иначе пакетный гейт («orchestration-src не содержит литералов»)
в backend-репо будет падать. Зеркальные правки `packages/` **не влияют** на npm-зависимость
и не заменяют отдельный процесс публикации (§4.2).

## 5. Потенциальные конфликты и обязательные адаптации

| # | Конфликт/адаптация | Серьёзность | Решение |
|---|---|---|---|
| **C1** | `backend.cjs`: файлы дивергировали (80 строк), но регион правки идентичен | низкая | ожидается чистый `cherry-pick`; после порта проверить строку `artifactRoot: () => config.OUTPUT_DIR,` |
| **C2** | `reconciliation-engine.js`: дивергенция 224 строки (свои Stage 47/50 в backend) при идентичных локальных контекстах всех 4 правок | средняя | ожидается чистое применение ганков; при конфликте — точечная ручная правка тех же 4 строк, **не** копирование файла целиком |
| **C3** | **Гейт упадёт в `animastor-backend` из-за 2 backend-only литералов в `backend/src`:** `storage/postgres/repositories/scene-assets-repo.js:91` (`runtimeConfig.OUTPUT_DIR \|\| '/data/output'`) и `services/orphan-books-audit.js:39,53` (`opts.booksDir \|\| process.env.BOOKS_DIR \|\| '/data/books'` + JSDoc). В монорепо первого файла с литералом нет (там `buildIdFromArtifactPath` отсутствует, версии различаются на 372 строки — копировать файл целиком **нельзя**), второго файла в монорепо нет вовсе | **высокая — гейт падает (тесты «все литералы в разрешённых местах» и «единственный владелец»)** | **расширение объёма, требует согласования владельца:** минимальные правки в backend-репо — убрать фолбэк (`nodePath.resolve(runtimeConfig.OUTPUT_DIR)`) и перевести `orphan-books-audit` на `config.BOOKS_DIR` + перефразировать JSDoc. Альтернатива (ослабление гейта — не рекомендуется) |
| C4 | Грязное рабочее дерево backend (7 записей) | средняя | порт делается **выборочным `git add` только файлов порта**; прежнюю грязь не трогать; перед портом сохранить `git diff > …/99-preport-dirty.patch` |
| C5 | Git-объекты не разделяются | средняя | будущему этапу нужен разрешённый **локальный `git fetch /home/animastor/animastor 088f3fa9`** (меняет `FETCH_HEAD`) и/или `git format-patch`; без этого cherry-pick невозможен |
| C6 | Версионирование orchestration (`0.1.1` vs `0.1.3`, `^0.1.1` vs `^0.1.3`) | высокая для публикации | отдельное решение владельца; Stage 98 публикацию запрещает |
| C7 | **Контекст доставки в production (уточнение к Stage 96 §7 B1):** у `animastor-backend` код `/app/src` **запечён в образ** (`ghcr.io/animastor/animastor-backend@sha256:182b0252…` от 19.10), bind-монтируются только `backend/ai`, `backend/tests`, `data/*` — **рестарта НЕ достаточно**, изменения backend/src доходят до production только через **порт в `animastor-backend` + GHCR-релиз/пересборку** (запрещены Stage 98). В контейнере `DATA_ROOT` отсутствует (`grep = 0`), `backend.cjs:175` — старый фолбэк | справочно | зафиксировано в плане: порт — необходимое, но не достаточное условие доставки |

## 6. Состояние репозиториев (до и после аудита — идентично)

| | монорепо `animastor` | `animastor-backend` |
|---|---|---|
| Ветка / HEAD | `c21.4-physically-extract-analysis-from-backend` / `088f3fa9` | `main` / `82c80af` |
| Upstream | `origin/c21.4-…` = `4574b3b9` → **ahead 1** | `origin/main` = `github/main` = `82c80af` → **в синхроне** |
| Remotes | `origin = /home/animastor/repos/animastor.git` | `origin = /home/animastor/repos/animastor-backend.git`, `github = git@github.com:Animastor/animastor-backend.git` |
| Dirty | 2 прежних (`frontends/website/index.html`, `?? docker/compose/overlay…`) | 7 прежних (§3) |
| FETCH_HEAD | mtime **10.10** (до Stage 96) | mtime **19.10** (до Stage 96) → fetch в 96–98 не выполнялся |

Production: контейнеры без рестартов (backend Up 46 h, pg/redis 8 weeks, gpu-hub 8 days);
образ backend не менялся; `.env`/Compose/БД/данные не трогались; npm publish не выполнялся.

## 7. Рекомендуемый способ переноса (план для будущего этапа, НЕ выполнялся)

**Этап 99 (после согласования C3, C5, C6):**

1. **Базлайн:** `cd /home/animastor/animastor-backend/backend && npm test` → зафиксировать
   список отказов ДО порта (4 теста в грязи правил локально — различить «свои» и «порта»).
   Сохранить грязь: `git -C /home/animastor/animastor-backend diff > /home/animastor/reorg-2026-10-19/99-preport-backend-dirty.patch`.
2. **Перенос (только чтение объектов монорепо):**
   `git -C /home/animastor/animastor-backend fetch /home/animastor/animastor 088f3fa97c12273e093459839dca6b8a677d791b`
   → `git cherry-pick -n 088f3fa9` (все 9 файлов, **без коммита**).
   Альтернатива без fetch-ref-изменений: `git -C монорепо format-patch -1 088f3fa9 --stdout > patch` + `git -C backend apply --3way` (3way всё равно требует объекты → фактически fetch).
3. **Адаптация C3 (после согласования):** точечные правки `scene-assets-repo.js:91`
   и `orphan-books-audit.js:39,53`; в противном случае коммитировать порт **без гейт-теста**
   и отложить его до C3 — не рекомендуется.
4. **Staged-состав:** только 11 файлов (9 порта + 2 адаптации). Прежняя грязь (§3) остаётся
   не-staged; `deploy/`, `freebuff-chat-*.md` — не добавлять. Проверить `git diff --cached --name-status`,
   скан секретов.
5. **Коммит:** сообщение, например, `feat(config): port DATA_ROOT abstraction (Stage 96 → backend)`.
   Без push/publish/deploy.
6. **Тесты после порта:**
   - `cd backend && npx mocha --exit tests/data-path-config.test.js tests/architecture/data-path-literals.test.js` → все зелёные (при выполненной C3);
   - полный `cd backend && npm test` → сравнить с базлайном п.1: новые тесты зелёные, отказов «порта» нет;
   - `npm test` в `packages/animastor-orchestration` → 19 passing;
   - `npm run test:syntax` (и pretest в полном прогоне);
   - контроль: `git status` — порт в коммите, прежняя грязь не стёрта.
7. **Rollback:**
   - до коммита: `git restore --staged --worktree -- <только файлы порта>` (грязь не затрагивается);
   - после коммита: `git revert <sha-порта>` (без переписывания истории);
   - **запрещено** `git reset --hard` без предварительного сохранения `diff` из п.1 — он уничтожит 7 прежних записей рабочего дерева;
   - production-откат не требуется (контейнер работает от образа, Stage 98–99 на него не влияют).
8. **Отдельными этапами (вне порта):** публикация согласованной версии `@animastor/orchestration` (C6),
   GHCR-релиз/пересборка backend-образа (C7), push обеих веток — всё по явному согласованию.

## 8. Подтверждение отсутствия изменений

- Монорепо: HEAD `088f3fa9`, статус = снапшот Stage 97 (2 прежних посторонних записи) — не менялся.
- `animastor-backend`: HEAD `82c80af`, ветка `main`, 7 прежних записей рабочего дерева, refs remotes (`origin/main`, `github/main` = `82c80af`) — не менялись; `FETCH_HEAD` со старой датой.
- `cherry-pick`, `merge`, `rebase`, `reset`, `commit`, `push`, `fetch` в Stage 98 **не выполнялись**;
  ветки/refs/remotes/рабочие файлы не изменялись.
- Docker/`.env`/Compose/PostgreSQL/Redis/данные/GPU Hub — не изменялись (read-only: `docker inspect`, `docker ps`, SQL `SELECT count`, `redis-cli DBSIZE/SCAN`).
- npm publish, сборка образов, deploy — не выполнялись.
- Все аудиторские чтения — через `git show`/`grep`/`rg`/`sed`/`docker inspect`; временные копии — только в `/tmp/opencode/`.
