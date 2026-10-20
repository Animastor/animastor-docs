# Animastor — синхронизация Backend с монорепо c21.4 (отчёт)

- Дата: 2026-10-11 (UTC)
- Рабочее дерево: `/home/animastor/animastor-backend`
- База: `bce64db3731414b9755e7b5e2f902cb3cf59f772` (= bare = GitHub, подтверждено)
- Итог: ветка `sync/c21.4-domain-and-fixes` = **`a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad`**
- Результат: **PASS** (с оговорками §6 — один осознанно не перенесённый файл и pre-existing дефект)
- `main` не тронут (`bce64db`), bare/GitHub не тронуты, push/merge/deploy не выполнялись.

---

## 1. Pre-flight

| Проверка | Значение |
|---|---|
| HEAD == baseline | `bce64db3` ✓ (03-baseline-2026-10-11.txt) |
| Ветка / status | `main`, 0 строк ✓ |
| remotes | `origin` → локальный bare, `github` → GitHub ✓ |
| Свободный диск | 6.7 ГБ (93%) — учтён: тесты запускались только после оценки (§5) |
| Матрица/план | `04-sync-matrix.md`, `05-sync-plan.md` прочитаны, решения применены по ним |

## 2. Созданные коммиты (4)

| SHA | Тема | Объём | Источник (монорепо c21.4) |
|---|---|---|---|
| `f84f43e` | feat(domain): animastor.in → animastor.org | 34 файла, +271/−156 | `60f8b9ee`, `9ae1d7ba` |
| `e045c51` | fix(editor): регистрация editor-контура через фабрики | 2 файла, +187/−4 | `e233d64d` |
| `8cb02d8` | fix(assistant): assistantPorts в module scope | 2 файла, +346/−27 | `0dbdae4a`, `465453df` |
| `a7a8c46` | chore(deps): installer 0.1.1 / gpu-hub 0.1.2 | 7 файлов, +19/−19 | `ce1fb69c`, `c7ca6d2e` |

Итого: **44 файла** (42 изменённых + 2 новых теста), +823/−206.

## 3. Перенесённые исправления

### 3.1 fix(editor) — `e045c51`
`backend/src/routes/book-routes.cjs`: шим `require('./editor/index.cjs')(app, redis, deps)`
вызывал объект-неймспейс (TypeError на boot, молча выпадала entity/structure CRUD
leg из 15 endpoint'ов) → деструктуризация `createEditorRoutes` +
`createEntityCrudRoutes` и вызов обоих. Composition root (`routeDeps`) уже содержал
`editorModel`/`editorPorts` (проверено: строки 501/550) — других файлов не требуется.
Добавлен новый тест `backend/tests/editor-route-registration.test.js` (177 строк).

### 3.2 fix(assistant) — `8cb02d8`
`backend/src/backend.cjs`: адаптер каскадного удаления `purgeAssistantForBook`
замыкался на СВОБОДНЫЙ идентификатор `assistantPorts` (существовал только как
свойство `routeDeps`) → ReferenceError в момент вызова, проглатываемый как
warning, чат-сессии переживали удаление книги. Решение: `const assistantPorts =
createAssistantPorts({...})` в module scope до `routeDeps`, `routeDeps` переиспользует
тот же объект. Добавлен тест `backend/tests/architecture/assistant-purge-wiring.test.js`
(305 строк, T1–T4 в vm-песочнице поверх реального `createBookDeletion`).

### 3.3 Домен `.org` — `f84f43e`
34 файла: runtime-дефолты и комментарии (`COOKIE_DOMAIN`, `HUB_URL`,
admin/app/docs хосты), nginx-маршрутизация с legacy-.in → .org 301
(`proxy/conf/default.conf`, `proxy/docker-compose.yml`), `scripts/enable-admin-https.sh`
(включая fix cert-script webroot), `docker/worker/*`, `docker/e2e/dispatch-task.cjs`,
docs (`docs/01-overview/*`, `AUTH_IMPLEMENTATION`, `EXPERIMENTAL_BETA_DOCKER_DEPLOYMENT`,
`GPU_HUB_CONTRACT`, `docs/index.html`, `ARCHITECTURE.md`, `SECURITY.md`),
источники/тесты installer и auth-контрактный тест.

### 3.4 Зависимости — `a7a8c46`
`backend/package.json`: `@animastor/installer ^0.1.0→^0.1.1`,
`@animastor/gpu-hub ^0.1.1→^0.1.2`; сохранён пост-сплит `license: MIT`.
`backend/package-lock.json`: ровно 2 registry-записи (resolved/integrity).
`packages/animastor-installer/{package.json,package-lock.json,README.md}`: версия
0.1.1 + `homepage: https://animastor.org`; сохранены пост-сплит
`repository`/`bugs` → `animastor-backend`. Арх-тесты с зафиксированными версиями
(`installer-package-boundary` → 0.1.1, `phase10d` → 0.1.2).

## 4. Решения по файлам «изменён с обеих сторон» (3-way)

| Файл | Решение |
|---|---|
| `docker-compose.yml` | сохранена пост-сплит секция gpu-hub (`image: ${GPU_HUB_IMAGE:?…}`, **без** build/fixture) + перенесены только строки `.org` |
| `.env.example` | сохранён текст «GPU HUB — PUBLISHED IMAGE» + `COOKIE_DOMAIN=animastor.org` |
| `packages/animastor-auth/README.md` | сохранён doc-link → `animastor-backend` + `cookieDomain: 'animastor.org'` |
| `backend/package.json` | сохранён `license: MIT` + перенесены бампы |
| `packages/animastor-installer/package.json` | сохранены `repository`/`bugs` → `animastor-backend` + версия 0.1.1 + homepage `.org` |
| `README.md` | **не изменён** — репозиторионный README (logo raw URL, clone URL, таблица репозиториев, структура) новее монорепо; домена `.org` в нём нет |
| `backend/src/backend.cjs` | доменные строки — в `f84f43e`; блок assistantPorts — в `8cb02d8`; итоговый blob идентичен монорепо |

Контроль: 39 из 44 файлов после синхронизации **байт-в-байт идентичны** монорепо
`465453df`; 5 отличий — ровно перечисленные 3-way решения (+ `README.md`/`phase10j`
остались репозиторионными).

## 5. Проверки

| Проверка | Результат |
|---|---|
| `git status` после каждого коммита | чисто (0 строк) |
| Diff bce64db..HEAD: планируемые файлы | 44 = 50 − 6 split-журналов − `README.md` − `phase10j` + 2 новых теста ✓ |
| Блобы vs монорепо | 39 идентичны, 5 — документированные 3-way ✓ |
| Пост-сплит артефакты сохранены | logo raw.githubusercontent, clone URL, 15× `repository.url` → animastor-backend, `GPU_HUB_IMAGE` pinned, `license: MIT` ✓ |
| Секреты в diff | нет (менялся только `.env.example`; `.env`/ключи/htpasswd не тронуты) ✓ |
| Синтаксис `node --check` (все изменённые .js/.cjs) | OK ✓ |
| Остатки `animastor.in` | 40 файлов — все идентичны состоянию монорепо: legacy-редиректы/пути сертификатов в `proxy/*`, `scripts/enable-admin-https.sh` (намеренно) + исторические docs ✓ |
| **`npm test` (полный прогон, `backend/`, mocha)** | **927 passing / 24 pending / 2 failing** |
| Целевой прогон (2 новых теста + 2 изменённых arch-теста) | 40 passing / 1 failing (см. ниже) |

Условия тестов: `npm ci` выполнен в `backend/` и в 15 `packages/*` (node_modules —
gitignored, `git status` остался чистым; суммарно ~350 МБ, удалёмы по желанию).
Это воспроизводит окружение baseline-прогона.

### 5.1 Сравнение с baseline (2026-10-05, `repository-split-final-verification.md`)

| | baseline | сейчас |
|---|---|---|
| passing | 923 | **927** (+4: два новых теста, 2+2 кейса) |
| pending | 24 | 24 |
| failing | 2 | **2 — те же самые** |

Обе failing — **pre-existing, не вызваны синхронизацией** (воспроизведены на базе
и идентичны задокументированным):
1. `installer-package-boundary` IB-G15 «package stays private» — ожидание `"private": true`,
   которого в `packages/animastor-installer/package.json` нет (ни до, ни после我们的 правок);
2. `phase5-runtime-result` T9 — ENOENT `backend/src/runtime/index.js` (файла нет в репо вовсе).

## 6. Осознанно НЕ перенесено / блокеры

| # | Что | Почему |
|---|---|---|
| 1 | `docs/architecture/repository-split-*.md`, `post-split-*.md` (6) | split-журналы, ведутся в монорепо; переписывание исторических аудитов запрещено |
| 2 | `packages/animastor-gpu-hub/**`, `backend/.dockerignore` | GPU Hub-фикстура; канон — репозиторий animastor-gpu-hub (собственная линия 06–08.10), фикстура с ним расходится |
| 3 | `README.md`, `.gitignore` | репозиторионные версии новее (post-split) |
| 4 | **`backend/tests/architecture/phase10j-gpu-hub-transitional-fixture.test.js`** | версия монорепо замораживает transitional-контракт (compose обязан собирать gpu-hub из `packages/animastor-gpu-hub/Dockerfile`), что **противоречит** пост-сплит pinned-image compose этого репозитория. Оставлена репозиторионная версия. **Pre-existing дефект:** репозиторионная версия того же теста утверждает тот же fixture-контракт и уже расходится с compose-переработкой `ca825d6`/`6943db2` — тест требует отдельного решения (переписать контракт под pinned-image либо перенести в gpu-hub репо). В полном прогоне он не упал только потому, что читает файлы, которых нет, — см. отдельную пометку ниже |
| 5 | npm publish / cutover деплоя | вне скоупа; production-образ по-прежнему собирается из монорепо |

Примечание к п.4: полный `npm test` прошёл927/2, т.к. phase10j при отсутствии
`packages/animastor-gpu-hub/` в репозитории не находит fixture-каталог; его
assert'ы по compose (`dockerfile: packages/animastor-gpu-hub/Dockerfile`) при этом
**не выполняются** — тест фактически стал неактивен для compose-секции. Это
зафиксировано как наблюдение, не чинилось (вне скоупа синхронизации).

## 7. Rollback

```
cd /home/animastor/animastor-backend
git checkout main          # main не двигался (bce64db)
git branch -D sync/c21.4-domain-and-fixes
```
Локальные артефакты окружения (gitignored, можно удалить):
`backend/node_modules`, `packages/*/node_modules`, корневой `node_modules/@animastor/*` (симлинки).
Ничего за пределами `/home/animastor/animastor-backend` не изменялось:
bare `repos/animastor-backend.git` = `bce64db3`, GitHub `main` = `bce64db3`,
монорепо `465453df` (status без изменений), контейнеры без рестартов.

## 8. Следующие шаги (отдельные решения, НЕ выполнены)

1. Ревью ветки → merge в `main` → push bare → GitHub (по отдельному разрешению).
2. Решение по phase10j (п.4 §6).
3. Синхронизация web/android/worker (по `05-sync-plan.md`, §2.2–2.4).
4. Cutover: переключение сборки/деплоя backend с монорепо на репозиторий (§8 `01-report.md`).
