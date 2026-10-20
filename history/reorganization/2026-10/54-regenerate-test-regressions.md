# Этап 54 — разбор «падений после /regenerate fix» (c7eaa9c)

**Дата:** 2026-10-14
**Вердикт:** **PASS** — эмпирическое сравнение до/после c7eaa9c опровергает посылку этапа: **новых падений нет**. Failure-set «до» и «после» идентичен (одни и те же 4 pre-existing падения, существовавшие ещё в базе stage 49–51). Все 4 новых теста `/regenerate` проходят. Четыре оставшихся падения классифицированы (1×C, 3×B) и исправлены минимальными **тестовыми** правками с проверкой контрактов. Полный набор: **3214 passing / 0 failing** (exit 0, стабильно ×2). Production, deploy, пакеты, БД, книги — не тронуты.

---

## 1. Главное: «четыре новых падения» не существуют

Посылка этапа («новые падения связаны с повторным regenerate, частичной ошибкой ensureSceneRow, пустой книгой и HTTP 404») **не подтвердилась**. Эти четыре явления — это ровно четыре **новых теста**, добавленных в stage 53, и все они **проходят**:

| Новый тест (stage 53) | Результат |
|---|---|
| `regenerate is repeatable: ensureSceneRow re-invoked per run, no state corruption` | ✔ passing |
| `regenerate reports partial materialization failure (summary warn) and still fails open` | ✔ passing |
| `regenerate with a book that has no scenes materializes nothing and resets nothing` | ✔ passing |
| `regenerate returns 404 for a missing book before touching anything` | ✔ passing |

Проверено не по отчёту, а полным парным прогоном:

| Коммит | Full suite | failing |
|---|---|---|
| `e172075` (база **до** c7eaa9c, worktree + hardlink node_modules) | **3198 passing / 28 pending** | **4** |
| `4f6c779` (= c7eaa9c backend tree, HEAD) | **3210 passing / 28 pending** | **4** |

Failure-set обоих прогонов — **побайтно одинаков** (одни и те же 4 файла/строки):

1. `tests/ai-endpoint-sharing.test.js:688`
2. `tests/ai-shared-inference.test.js:806`
3. `tests/architecture/installer-package-boundary.test.js:243`
4. `tests/architecture/phase5-runtime-result.test.js:401`

Прирост passing 3198 → 3210 = ровно **+12** — все новые тесты c7eaa9c (6 в `generation-routes.test.js` + 6 в новом `orphan-books-diagnosis.test.js`). Ни одного нового провала. Числа stage 52/53 отчётов (3206/3210) согласуются: stage 52 мерил незакоммиченное дерево с 8 из 12 новых тестов.

> Методическая заметка: первый прогон baseline в worktree со **symlink**-node_modules дал 3 ложных провала `orchestrator-convergence` (require.cache-стабы в `withStubbedDispatchEngine` не находят модуль по symlink-пути). Повторный baseline с **hardlink**-копией node_modules (`cp -al`, та же ФС) дал чистые 3198/4 — ложность подтверждена и снята.

## 2. Классификация четырёх оставшихся падений (все — pre-existing, НЕ от c7eaa9c)

### 2.1 `ai-endpoint-sharing.test.js:688` — «no policy row is enabled unless the owner explicitly enabled it» — **C: тестовая среда**

- **Симптом:** `expected 1 to equal +0` — запрос теста нашёл 1 включённую share-политику вне своих stamped-workspaces.
- **Причина:** тест сформулирован для **пустой БД** («вне suites нет ни одной включённой политики»), но гоняется против общего dev PG, где живёт реальный пользователь. Репродукция (SELECT-only): включённая политика принадлежит `sureg's Workspace` — реальному workspace с **явно включённым владельцем** sharing'ом. Тест видит её и падает; при этом ни миграция, ни suite ничего не включали.
- **Почему не регрессия и не дыра:** строка существовала до c7eaa9c (падало и на e172075); политика валидна по контракту listSharedEndpoints (endpoint live/enabled/non-deleted, connector non-revoked).
- **Исправление (минимальное, security-preserving):** baseline-снапшот включённых политик вне stamp **до** `runMigrations()` (SELECT-only, guard на свежую БД → пустой baseline); регрессия теперь утверждает, что множество **не растёт** снаружи suite — миграция/suite по-прежнему не могут авто-включить ничего незамеченным. Инвариант не ослаблен: любое новое авто-включение (в т.ч. миграцией) по-прежнему валит тест.

### 2.2 `ai-shared-inference.test.js:806` — «16b. shared snapshot is safe for health checks» — **B: устаревшее ожидание**

- **Симптом:** `expected 1 to equal +0` — `checkAIHealth({}, snap)` вернул 1 для connector-snapshot'а.
- **Причина:** тест закреплял **старый** контракт («connector snapshot не несёт HTTP-credential → всегда 0»). Контракт **намеренно** изменён коммитом `5b98fbf` (2026-09-04, ancestor e172075): ветка `transport === 'connector'` возвращает **registry liveness** (`registry.isLive(connectorId) ? 1 : 0`) — честный сигнал доступности VBook-агента, Map-lookup без probe. В suite коннектор live (openLiveSession в before) → 1. Тест после смены контракта не обновили.
- **Контракт проверен:** `ai-service.js:592–595` (комментарий LAC §9), сообщение 5b98fbf.
- **Исправление:** тест теперь пинит **новый** контракт явно: `snap.transport === 'connector'` и `n === (registry.isLive(snap.connectorId) ? 1 : 0)`. «No fetch» сохранён: для connector-ветки HTTP-probe в коде не выполняется ни в одном направлении; security-направление (revocation → 0) сохранено.

### 2.3 `installer-package-boundary.test.js:243` — IB-G15 «package stays private» — **B: устаревшее ожидание**

- **Симптом:** `expected undefined to equal true` — в `packages/animastor-installer/package.json` нет `private: true`.
- **Причина:** ожидание «no publish yet» устарело: коммит `8f3a3d6` (2026-09-17) **намеренно** опубликовал `@animastor/installer@0.1.0` как public scoped package (удалил `private`, добавил `publishConfig.access: public`); на npm сейчас 0.1.1. Публикация — решение stage 48 (npm publish), контракт публичности подтверждён и `publishConfig` в файле.
- **Исправление:** IB-G15 пинит **фактический** контракт: `private !== true` (намеренно публичный) + `publishConfig.access === 'public'` (visibility не может незаметно смениться). main/bin-пины сохранены без изменений.

### 2.4 `phase5-runtime-result.test.js:401` — T9 «no dynamic require… from runtime/**» — **B: устаревшее ожидание**

- **Симптом:** `ENOENT: backend/src/runtime/index.js` — тест читает несуществующий файл.
- **Причина:** host-barrel `backend/src/runtime/index.js` **намеренно удалён** коммитом `4c5699c` (2026-09-14, B-4: «stale host barrel, zero consumers; all actual imports use submodules directly or @animastor/orchestration»). Сопутствующий `physical-move-gate.test.js` тогда обновили (убрали index.js из ALIVE_HOST_STAYS), а T9 в phase5 не тронули — он остался пытаться читать удалённый файл.
- **Исправление:** вторая половина T9 обёрнута в `fs.existsSync(barrelPath)`: при отсутствии barrel'а инвариант выполняется вакуумно (нет barrel'а — нет утечки), при появлении файла проверки «lazyRequire targets только ./…» и «не ссылается на orchestration» включаются снова. Первый (главный) скан `runtime/**` на computed/template/concat require — **сохранён без изменений**. Ничего не скрыто за fail-open: удалённый файл — намеренное состояние, зафиксированное физическим move-gate'ом.

## 3. Что НЕ менялось (проверено)

- **Production/rollout/deploy/.env** — нет. Backend в проде остаётся `sha256:71ab1468…` (c7eaa9c).
- **src/ (generation-routes.cjs и весь production-код)** — нет. Diff только в 4 тестовых файлах (`git diff --stat`: 4 файла, +57/−13).
- **package pin/lock, npm-публикации, БД (схема/данные), книги, assets, output** — нет. Новые проверки в тестах — SELECT-only / require-cache / fs-read.
- Коммит/публикация/сборка образа на этом этапе **не выполнялись** (правки оставлены рабочим деревом; коммит — по отдельному решению).

## 4. Регрессионные инвариенты /regenerate — все сохранены

Целевой прогон (`generation-routes` + `orphan-books-diagnosis` + `sql-boundary`): **22 passing**. В полном финальном прогоне подтверждены все 12:

| Инвариант | Тест | Итог |
|---|---|---|
| materialize-before-reset | `regenerate materializes scenes rows (ensureSceneRow) for every dirty scene — stage 52` | ✔ |
| fail-open не скрывает ошибку | `regenerate stays fail-open when ensureSceneRow rejects` | ✔ |
| идемпотентность повторного /regenerate | `regenerate is repeatable: ensureSceneRow re-invoked per run` | ✔ |
| частичная ошибка ensureSceneRow (сводный warn) | `regenerate reports partial materialization failure (summary warn)` | ✔ |
| пустая книга → no-op | `regenerate with a book that has no scenes materializes nothing` | ✔ |
| 404 несуществующей книги до прикосновений | `regenerate returns 404 for a missing book before touching anything` | ✔ |
| membership-guard / аноним → 403 | route-путь `requireBookAccess` (production-probe stage 53) + auth-suite | ✔ |
| нет дубликатов сцен (ON CONFLICT) | DB-уровневый тест stage 52/53 + production-probe | ✔ |
| сохранность scene_assets (READY-строки) | `orphan-books-diagnosis` — Class IV + asset-preservation | ✔ |
| SELECT-only аудит | `report is computed read-only` | ✔ |
| Class I/II/III детект | `orphan-books-diagnosis` 3 теста | ✔ |
| recovery primitive + идемпотентность | `recovery primitive: ensureSceneRow clears the finding` | ✔ |

Ни один из четырёх тестовых фиксов не касается этих путей (все правки — в AI-sharing/installer/phase5-файлах, ни один не импортирует regenerate-код).

## 5. Прогоны

| Шаг | Команда | Результат |
|---|---|---|
| pretest (syntax smoke) | `npm run pretest` | OK |
| Baseline до c7eaa9c | worktree e172075, `npx mocha --exit 'tests/**/*.test.js'` | 3198 pass / 28 pending / **4 fail** |
| HEAD до фиксов | `npx mocha --exit 'tests/**/*.test.js'` | 3210 pass / 28 pending / **4 fail** |
| 4 исправленных файла | `npx mocha --exit tests/ai-endpoint-sharing… phase5…` | **117 passing / 0 failing** |
| Целевые regenerate/orphan/sql-boundary | `npx mocha --exit tests/generation-routes… orphan-books-diagnosis… sql-boundary…` | **22 passing** |
| Полный (после фиксов) | `npx mocha --exit 'tests/**/*.test.js'` | **3214 passing / 28 pending / 0 failing (exit 0)** |
| Полный (повтор, стабильность) | то же | **3214 / 28 / 0 (exit 0)** |

Failure-set сравнение с базой stage 52: базовые 4 падения **устранены**; новых падений нет; **0 failing**.

## 6. Оставшиеся блокеры

Тестовых блокеров **нет** (suite полностью зелёный). Вне рамок этапа остаются известные прод-наблюдения stage 53 (не регрессии, не трогались): аудит orphan-books 23 issues (13 невидимых книг — восстановление только отдельным этапом с решением владельца), steady-state reconcile 2_issues.

## 7. Итог

| Пункт | Статус |
|---|---|
| 1. Сравнение до/после c7eaa9c полным прогоном (не по отчёту) | ✅ — новых падений нет, failure-set идентичен |
| 2. Классификация 4 падений с кодом и воспроизводимостью | ✅ — 1×C (общий dev PG), 3×B (намеренные изменения 5b98fbf / 8f3a3d6 / 4c5699c) |
| 3. Исправления минимальными тестовыми правками после проверки контрактов | ✅ — 4 файла, +57/−13, только tests/ |
| 4. Все инвариенты /regenerate сохранены | ✅ — 12/12 подтверждены |
| 5. Регрессионные тесты усилены, fail-open не добавлен | ✅ — baseline-diff строже; T9-баррель-проверка включается при появлении файла |
| 6. Целевые 22 + полный 3214/0 ×2, сравнение с базой stage 52 | ✅ |
| 7. Запрещённые поверхности не тронуты | ✅ |
| 8. Рискованные изменения API/данных | не потребовались |

**Итог: PASS.** Предположение о регрессиях /regenerate опровергнуто полным парным прогоном; оставшиеся 4 падения были pre-existing (унаследованы из базы stage 49–51), объяснены намеренными изменениями контрактов/окружения и устранены тестовыми правками без единого изменения production-кодa или данных.
