# Матрица расхождений монорепо c21.4 ↔ 4 репозитория (аудит 2026-10-11, read-only)

- Монорепо: `/home/animastor/animastor`, ветка `c21.4-physically-extract-analysis-from-backend`, HEAD `465453df`.
- Frozen source: `master` = `64127b9e` (split-база).
- Репозитории: bare == worktree == GitHub (сверено 2026-10-11).
- Метод: (1) `git diff master..HEAD` монорепо → 101 файл; (2) принадлежность пути определена по наличию в дереве репозитория;
  (3) для каждого расходящегося файла — последний коммит монорепо (`master..HEAD`) и последний коммит репозитория,
  (4) «сторона новее» по датам + ручная проверка диффов для файлов, изменённых с обеих сторон.

## 0. Сводка

| Репозиторий | Файлов в репо | Расходятся | Только монорепо новее | Только репо новее (post-split) | Изменены с обеих сторон |
|---|---|---|---|---|---|
| backend | 1045 | 74 | 50 | 24 | 6* |
| web | 351 | 34 | 19 | 15 | 3* |
| android | 219 | 9 | 7 | 2 | 1* |
| worker | 60 | 12 | 11 | 1 | 2* |

\* «Изменены с обеих сторон» — файл менялся и в `master..HEAD` монорепо, и в post-split коммитах репозитория;
  это подмножество двух предыдущих колонок, требующее 3-way слияния, а не «взять монорепо».

## 1. Принадлежность 101 изменённого файла (по деревьям репозиториев)

| Принадлежность | Файлов | Комментарий |
|---|---|---|
| backend | 47 | +2 файла `docker/worker/*` и `README.md`/ANDROID_WEB_PARITY.md делятся с другими репо |
| web | 17 | +1 общий `README.md`-путь и ANDROID_WEB_PARITY.md |
| android | 5 | +1 общий |
| worker | 8 | +2 общих (`docker/worker/*`) |
| gpu-hub | 1 | `README.md` (путь-коллизия, см. §5) |
| MONOREPO-ONLY | 20 | **не синхронизировать** (см. §5) |

## 2. Пропущенные коммиты монорепо по репозиториям

36 коммитов `master..HEAD`: **25** — `docs(split)` (журналы split в `docs/architecture/`, 03–05.10),
**11** — содержательные (08–11.10). Содержательные коммиты и их распределение:

| Коммит | Дата | Тема | backend | web | android | worker | gpu-hub | MONOREPO-ONLY |
|---|---|---|---|---|---|---|---|---|
| `60f8b9ee` | 08.10 | feat(domain): animastor.in → animastor.org | 39 | 15 | 5 | 8 | 0 | 2 |
| `282f3a9c` | 08.10 | docs(domain): отчёт о миграции | 0 | 0 | 0 | 0 | 0 | 1 |
| `9ae1d7ba` | 08.10 | docs(domain) + fix cert-script webroot | 1 | 0 | 0 | 0 | 0 | 1 |
| `a9d71d81` | 08.10 | docs(domain): GitHub consistency | 0 | 0 | 0 | 0 | 0 | 1 |
| `ce1fb69c` | 10.10 | npm(release): gpu-hub 0.1.2 / installer 0.1.1 | 4 | 0 | 0 | 0 | 0 | 6 |
| `c7ca6d2e` | 10.10 | npm(deps): backend → новые версии | 2 | 0 | 0 | 0 | 0 | 0 |
| `1c37e14a` | 10.10 | chore(artifacts): 4 zip + sha256_asset | 0 | 0 | 0 | 0 | 0 | 2 |
| `0c55b5a7` | 10.10 | fix(deploy): blockers сборки образа | 0 | 0 | 0 | 0 | 0 | 3 |
| `e233d64d` | 10.10 | **fix(editor)**: регистрация editor-контура | 1 | 0 | 0 | 0 | 0 | 1 |
| `0dbdae4a` | 11.10 | **fix(assistant)**: assistantPorts в module scope | 1 | 0 | 0 | 0 | 0 | 1 |
| `465453df` | 11.10 | test(assistant): purge order T4 | 0 | 0 | 0 | 0 | 0 | 1 |

### 2.1 Пропущенные коммиты, сгруппированные по темам

**backend (ожидает синхронизации):**
- домен `.org` — 39 файлов (`.env.example`, `docker-compose.yml`, `proxy/**`, `backend/src/**`, `scripts/enable-admin-https.sh`, `docs/01-overview/**`, `docs/index.html`, README/ARCHITECTURE/SECURITY и др.);
- npm-бампы — `backend/package.json`+`package-lock.json` (installer ^0.1.1, gpu-hub ^0.1.2), `packages/animastor-installer/{package.json,package-lock.json,README.md}`;
- **fix(editor)** — `backend/src/routes/book-routes.cjs` (factory-регистрация `createEditorRoutes`+`createEntityCrudRoutes` вместо вызова шима-объекта);
- **fix(assistant)** — `backend/src/backend.cjs` (блок `assistantPorts` в module scope);
- тесты — `tests/auth-mvp.test.js`, `tests/gpu-hub-artifacts.test.js`, `packages/animastor-auth/test/auth-contract.test.js`, `packages/animastor-installer/tests/*` (5), архитектурные тесты npm-бампов (3).

**web:** домен `.org` в `frontends/app/src/pages/{AdminPage,LibraryPage}.tsx`, `frontends/website/{index.html,library/index.html,site.js,styles.css}`, `app-web-rebuild.sh`, `packages/animastor-web-workers/test/workerSetup.test.ts`, `tools/*-web-tester/**` (8 файлов), `ANDROID_WEB_PARITY.md`.

**android:** домен `.org` в `frontends/android/{apk-build-in.sh,app/build.gradle.kts}`, `LibraryFragment.kt`, тестах `BetaSettingsHelpersTest.kt`, `WorkerSetupHelpersTest.kt`, `ANDROID_WEB_PARITY.md`.

**worker:** домен `.org` в `docker/worker/{docker-run.md,entrypoint.sh}`, `packages/animastor-worker/{new/*,start-worker.sh,tests/worker-env.test.cjs,worker/.env.example,worker/worker.cjs}`.

## 3. Что уже перенесено в целевые репозитории (не дублировать)

Post-split коммиты репозиториев (04–08.10), которых нет в монорепо:

| Репозиторий | Коммиты | Содержание | Файлов |
|---|---|---|---|
| backend | `b89954f`, `98c4fbd` | README/metadata → `animastor-backend`, logo, clone-URL, `setup-contract.js`, архитектурные guard'ы | 30 |
| backend | `ca825d6`…`bce64db` (6) | compose: gpu-hub как pinned-image (без build из монорепо), overlay-фиксы, dual-mount артефактов | вкл. `docker-compose.yml`, `.env.example`, `overlay-gpu-hub-local.yml` |
| web | `c7fe52a` | root README/.gitignore, `repository.url` → `animastor-web`, ссылки сайта на `Animastor/animastor-web` | 18 |
| android | `860bd8b`, `254e2f0` | root README/.gitignore, ссылка issue → `animastor-android` | 3 |
| worker | `618f87a` | root README/.gitignore, `repository.url` → `animastor-worker` | 3 |
| gpu-hub | `9b42075`…`ecefd0b` (11, 06–08.10) | pinning артефактов, воспроизводимый digest, CI | собственная линия |

Выводы:
1. Метаданные `repository`/`bugs`/`homepage`, root README/.gitignore, исправленные ссылки на GitHub **уже в репозиториях** — переносить их обратно из монорепо нельзя (регресс).
2. Пиннинг GPU Hub как pinned-image (**без** build из monorepo fixture) уже в `backend` — монорепо `docker-compose.yml`/ `.env.example` в gpu-hub-секции **устарели** и при синхронизации не должны их затирать.
3. Пиннинг артефактов/репро-digest уже выполнен **в самом gpu-hub репозитории** (11 коммитов 06–08.10) — монорепо-фикстура `packages/animastor-gpu-hub/*` с ним **не совпадает** (artifacts.lock.json, gpu-hub.js, package.json, Dockerfile, server.js различаются) и не является источником истины.
4. Домен `.org`, fix(editor), fix(assistant), npm-бампы — **ни в одном из 5 репозиторий** (`grep animastor.org` = 0 hits во всех; соответствующие диффы подтверждены).

## 4. Файлы, изменённые с обеих сторон (требуют 3-way, не «взять монорепо»)

### backend

| Файл | Что в репозитории (post-split) | Что в монорепо (c21.4) | Решение |
|---|---|---|---|
| `docker-compose.yml` | gpu-hub: `image: ${GPU_HUB_IMAGE:?…}`, **без** build (фикс `ca825d6`) | gpu-hub: build из monorepo fixture + `COOKIE_DOMAIN=…org` | объединить: repo-секция gpu-hub + домен `.org` |
| `.env.example` | текст «hub is a published image», digest-пример | текст «transitional fixture» + `COOKIE_DOMAIN=…org` | объединить: repo-текст + домен `.org` |
| `backend/package.json` | `+license: MIT` | `installer ^0.1.1`, `gpu-hub ^0.1.2` | объединить оба |
| `packages/animastor-installer/package.json` | `repository.url` → `animastor-backend` | версия 0.1.1 | объединить оба |
| `packages/animastor-auth/README.md` | clone-URL → `animastor-backend` | домен `.org` | объединить оба |
| `README.md` | новый README репозитория (logo, структура backend) | старый корневой README монорепо + `.org` | **оставить репозиторионный**; домен применить точечно |

### web

| Файл | Что в репозитории (post-split) | Что в монорепо (c21.4) | Решение |
|---|---|---|---|
| `frontends/app/package.json` | `+license: MIT` | `description` с `app.animastor.org` | объединить оба |
| `frontends/website/index.html` | ссылки GitHub → `Animastor/animastor-web` | canonical/og-теги `.org`, кнопки `app.animastor.org` | объединить оба |
| `README.md` | новый README репозитория | старый корневой README монорепо | **оставить репозиторионный** |

### android

| Файл | Что в репозитории (post-split) | Что в монорепо (c21.4) | Решение |
|---|---|---|---|
| `README.md` | новый README репозитория | старый корневой README монорепо | **оставить репозиторионный** |

### worker

| Файл | Что в репозитории (post-split) | Что в монорепо (c21.4) | Решение |
|---|---|---|---|
| `packages/animastor-worker/worker/package.json` | `repository`/`bugs` → `animastor-worker` | `homepage: https://animastor.org` | объединить оба |
| `README.md` | новый README репозитория | старый корневой README монорепо | **оставить репозиторионный** |

## 5. Файлы монорепо, которые НЕ должны попадать в новые репозитории

Из 101 изменённого файла — **20** не принадлежат ни одному из 5 репозиториев:

### 5.1 GPU Hub-фикстура (`packages/animastor-gpu-hub/`, 9 файлов)
`CHANGELOG.md`, `Dockerfile`, `artifacts.lock.json`, `gpu-hub.js`, `package.json`, `package-lock.json`, `tests/run-all.cjs`, `tools/update-artifacts-lock.cjs` + `backend/.dockerignore`.
Причины: (a) GPU Hub физически вынесен в `Animastor/animastor-gpu-hub` (собственная линия коммитов, свой Dockerfile в корне);
(b) фикстура в монорепо — transitional и **расходится** с каноничным репозиторием (см. §3.3);
(c) `backend/.dockerignore` существует только потому, что в монорепо backend-контекст включает fixture-пути.

### 5.2 Новые тесты backend, отсутствующие в backend-репо (3 файла)
`backend/tests/architecture/assistant-purge-wiring.test.js`, `backend/tests/editor-route-registration.test.js` — принадлежат backend
(покрывают fix(assistant)/fix(editor)) и **должны** переехать вместе с соответствующими фиксами; здесь перечислены, потому что
пока не имеют пары в репозитории. `backend/.dockerignore` — см. §5.1 (кандидат на перенос только после решения о layout backend-контекста).

### 5.3 Split-журналы `docs/architecture/repository-split-*` и `post-split-*` (7 файлов)
`repository-split-{execution-pack,final-gate,final-verification,post-split-audit,pre-split-go-blockers,r3-decision,worker-root-layout-diagnostic}.md`,
`post-split-build-deploy-diagnostic.md`, `DOMAIN_MIGRATION_2026-10_IN_TO_ORG.md` — документы процесса split/миграции, ведомые в монорепо.
В backend-репо уже лежит их более ранняя часть (126 файлов `docs/architecture`).
**Рекомендация: не синхронизировать** (исторический журнал; `repository-split-final-verification.md` прямо запрещает переписывание исторических аудитов).

### 5.4 Пути-коллизии (одинаковое имя в разных репозиториях — не копировать вслепую)
- `README.md` — в каждом из 5 репозиториев это **свой** файл (в monorepo — один корневой README, принадлежащий backend).
- `.gitignore` — аналогично (monorepo-версия не менялась в c21.4, но различается с новыми корневыми .gitignore репозиториев).
- `ANDROID_WEB_PARITY.md` — общий для web и android (в обоих есть в репо, изменение домена применяется к обоим).
- `docker/worker/{docker-run.md,entrypoint.sh}` — входят и в backend, и в worker; правки домена нужны в обоих.

## 6. Источники данных

- `00-sha-snapshot.txt`, `03-baseline-2026-10-11.txt` — базовые HEAD/state/диск.
- `02-divergence-matrix.txt` — per-file blob-сравнение (предыдущий этап).
- Логика классификации: `MONO-NEWER` / `REPO-NEWER` (по датам последнего коммита) + пересечение множеств файлов, изменённых после split-базы с обеих сторон.
