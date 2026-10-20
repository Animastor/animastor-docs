# План синхронизации 4 репозиториев с монорепо c21.4 (аудиторский, 2026-10-11)

Статус: **план, ничего не выполнено**. Этот этап — только аудит; merge/cherry-pick/
push/копирование файлов не выполнялись. Базовые HEAD и состояние зафиксированы в
`03-baseline-2026-10-11.txt`; матрица расхождений — в `04-sync-matrix.md`.

## 0. Исходные данные

- Монорепо `c21.4` (`465453df`) опережает все 4 репозитория на 11 содержательных
  коммитов (08–11.10): домен `.org`, npm-бампы, fix(editor), fix(assistant), артефакты.
- Репозитории, в свою очередь, имеют 04–08.10 post-split коммиты, которых нет в
  монорепо (metadata/README/.gitignore, compose gpu-hub как pinned-image,
  собственная линия gpu-hub 06–08.10).
- Поэтому синхронизация — **двусторонняя задача 3-way слияния**, а не «скопировать
  из монорепо». Монорепо авторитетен только для §2 списка; репозитории авторитетны
  для своих post-split изменений (§3 матрицы).

## 1. Принципы

1. История каждого репозитория сохраняется: работа идёт в новой ветке поверх
   текущего `main`/`master`; никаких reset/rebase/force-push.
2. Коммиты репозиториев не переписываются; монорепо и его ветка `c21.4` не трогаются.
3. Новые коммиты ссылаются на SHAs монорепо в сообщениях (трассируемость), но не
   являются cherry-pick (истории переписаны filter-repo, cherry-pick потребует
   ручного отсечения чужих путей и даст шумные конфликты).
4. GPU Hub и живая инфраструктура (compose-проект, контейнеры, `.env`, `data/`) —
   вне скоупа.
5. Свободного места 6.7 ГБ — синхронизация ограничивается git/правками файлов;
   `npm ci`/сборки/тесты не запускаются до отдельного решения (см. §6).

## 2. Что переносится из монорепо (по репозиториям)

### 2.1 animastor-backend — приоритет 1 (production-фиксы)

| Блок | Файлы | Источник (SHA) |
|---|---|---|
| Домен `.org` | 39 файлов: `.env.example`, `docker-compose.yml` (только строки домена), `proxy/conf/default.conf`, `proxy/docker-compose.yml`, `backend/src/**` (7), `backend/tests/**` (2), `packages/animastor-auth/{README.md,test/auth-contract.test.js}`, `packages/animastor-installer/{package.json,src/**,tests/**}`, `scripts/enable-admin-https.sh`, `docs/01-overview/**` (3), `docs/architecture/{AUTH_IMPLEMENTATION,EXPERIMENTAL_BETA_DOCKER_DEPLOYMENT,GPU_HUB_CONTRACT}.md`, `docs/index.html`, `ARCHITECTURE.md`, `SECURITY.md`, `README.md` (точечно) | `60f8b9ee`, `9ae1d7ba` |
| npm-бампы | `backend/package.json` + `package-lock.json`; `packages/animastor-installer/{package.json,package-lock.json,README.md}` | `ce1fb69c`, `c7ca6d2e` |
| **fix(editor)** | `backend/src/routes/book-routes.cjs` + новый тест `backend/tests/editor-route-registration.test.js` | `e233d64d` |
| **fix(assistant)** | `backend/src/backend.cjs` (блок assistantPorts в module scope) + новый тест `backend/tests/architecture/assistant-purge-wiring.test.js` | `0dbdae4a`, `465453df` |

Особые условия (3-way, см. §4 матрицы):
- `docker-compose.yml` и `.env.example`: **сохранить** репозиторионную
  gpu-hub-секцию (`GPU_HUB_IMAGE` pinned, без build) и перенести только строки
  домена `.org` — монорепо-версия gpu-hub-секции устарела.
- `backend/package.json`: сохранить `license: MIT` репо + применить бампы версий.
- `packages/animastor-installer/package.json`: сохранить `repository.url` репо + версию 0.1.1.
- `packages/animastor-auth/README.md`: сохранить clone-URL репо + домен `.org`.
- `README.md`: репозиторионный README не заменять; домен применить точечно (если есть строки).

**Не переносить:** `backend/.dockerignore` (см. §5.1 матрицы — fixture-специфичен),
split-журналы `docs/architecture/repository-split-*` и `post-split-*`.

### 2.2 animastor-web — приоритет 2

Домен `.org` в 15 файлах: `frontends/app/src/pages/{AdminPage,LibraryPage}.tsx`,
`frontends/website/{index.html,library/index.html,site.js,styles.css}`,
`app-web-rebuild.sh`, `packages/animastor-web-workers/test/workerSetup.test.ts`,
`tools/{desktop,mobile}-web-tester/**` (8), `ANDROID_WEB_PARITY.md`.

3-way: `frontends/app/package.json` (сохранить `license: MIT` + описание `.org`);
`frontends/website/index.html` (сохранить ссылки GitHub → `Animastor/animastor-web`
+ канонический/og-теги `.org`); `README.md` репозитория не заменять.

### 2.3 animastor-android — приоритет 3

Домен `.org` в 6 файлах: `frontends/android/apk-build-in.sh`,
`frontends/android/app/build.gradle.kts`,
`.../ui/LibraryFragment.kt`, тесты `BetaSettingsHelpersTest.kt`,
`WorkerSetupHelpersTest.kt`, `ANDROID_WEB_PARITY.md`.
`README.md` репозитория не заменять.

### 2.4 animastor-worker — приоритет 3

Домен `.org` в 8 файлах: `docker/worker/{docker-run.md,entrypoint.sh}`
(файлы общие с backend — правятся в обоих репо),
`packages/animastor-worker/{new/MEMORY.md,new/SYSTEM.md,new/start-worker.sh,start-worker.sh,tests/worker-env.test.cjs,worker/.env.example,worker/worker.cjs}`.

3-way: `worker/package.json` — сохранить `repository`/`bugs` → `animastor-worker`,
принять `homepage: https://animastor.org`.

### 2.5 animastor-gpu-hub — **синхронизация НЕ требуется**

Его собственная линия коммитов (06–08.10, pinning артефактов + воспроизводимый
digest) новее монорепо-фикстуры; расхождение `packages/animastor-gpu-hub/*` ↔
репозиторий — ожидаемое следствие split. Фикстуру в монорепо не трогать.

## 3. Порядок выполнения (минимальный, обратимый)

На каждый репозиторий, в этом порядке:

1. **Предусловие**: `git status` чист, HEAD = зафиксированному baseline
   (`bce64db3` / `c7fe52ac` / `254e2f08` / `618f87a6`).
2. Ветка `sync/c21.4-domain-and-fixes` от текущего `main`.
3. Перенос «чистых» файлов (только монорепо новее, без 3-way):
   `git checkout 465453df -- <список путей из §2>`; спорные пути не включать.
4. Ручная 3-way правка файлов из §2.1/§2.2/§2.4 (см. таблицы решений).
5. Коммиты (рекомендуемая нарезка, по 2–4 на репозиторий):
   - `feat(domain): migrate canonical domain animastor.in → animastor.org` (ссылая `60f8b9ee`);
   - `fix(editor): register the editor contour via package factories` (ссылая `e233d64d`) — только backend;
   - `fix(assistant): bind assistantPorts in module scope` (ссылая `0dbdae4a`, `465453df`) — только backend;
   - `chore(deps): bump @animastor/installer@0.1.1, @animastor/gpu-hub@0.1.2` (ссылая `ce1fb69c`, `c7ca6d2e`) — только backend.
6. Проверка в ветке (см. §5) — без merge в `main`.
7. Остановка. Push в bare/GitHub и переключение инфраструктуры — **отдельное
   решение после ревью** (в рамках этой задачи не выполняется).

## 4. Что НЕ переносится (контрольный список)

- `packages/animastor-gpu-hub/**` и `backend/.dockerignore` (fixture, не канон).
- `docs/architecture/repository-split-*.md`, `post-split-*.md`,
  `DOMAIN_MIGRATION_2026-10_IN_TO_ORG.md` (журнал процесса, ведётся в монорепо).
- Монорепо-версии `README.md` и `.gitignore` для web/android/worker/gpu-hub
  (в репозиториях — собственные, более новые).
- Всё из `master`, что уже в репозитории (split выполнен, дублировать нельзя).
- `data/`, `.env`, `proxy/conf/.htpasswd`, `node_modules`, артефакты, ключи.

## 5. Верификация (после каждой ветки)

Обязательные (дешёвые, без сборок):
1. `git status` чист; `git log --oneline main..sync/…` — только ожидаемые коммиты.
2. `git diff main..sync/… --stat` — число файлов совпадает с планом (backend ~55,
   web ~16, android ~7, worker ~11; отклонение >2 → разобраться).
3. `grep -rn 'animastor\.in' . --exclude-dir=.git` — ожидаемо **0** (кроме
   исторических документов, если они не в скоупе).
4. `grep -rn 'Animastor/animastor\.git\|github.com/Animastor/animastor[^-a-z]' .`
   — не появилось новых ссылок на старый monorepo.
5. Контроль 3-way-файлов: `git diff main..sync/… -- <файл>` — присутствуют обе
   части (repo-фикс + монорепо-правка), ничего не потеряно.
6. Для backend дополнительно: `node -c`/синтаксическая проверка изменённых `.cjs`
   (без запуска тестов).

Отложенные (после освобождения места / отдельного разрешения):
`npm test` backend/worker, `typecheck`+`vitest`+`build` web, `assembleDebug`
android. Baseline ожиданий — `repository-split-final-verification.md` (2026-10-05).

## 6. Блокеры и риски

| # | Блокер | Влияние | Обход |
|---|---|---|---|
| B1 | Диск 93% (6.7 ГБ) | нельзя запускать сборки/`npm ci` для верификации | верификация только git-уровневая; сборки — отдельным этапом |
| B2 | 6 файлов backend + 3 web + 1 android + 2 worker изменены с обеих сторон | автоматический `checkout` затрёт repo-фиксы | ручная 3-way по таблицам §2 |
| B3 | gpu-hub-секция в монорепо-композе устарела | слепой перенос сломал бы pinned-image деплой | переносить только строки домена |
| B4 | `docker/worker/*` и `ANDROID_WEB_PARITY.md` делятся между репо | риск расхождения после правок | править в обоих репо одинаково, проверять grep'ом |
| B5 | Синхронизация ≠ деплой | production-образ собирается из монорепо | cutover — отдельная задача (см. §8 рекомендаций предыдущего отчёта) |
| B6 | Нет тестового прогона после правок | регресс возможен | явно помечать «tests NOT RUN»; не объявлять PASS |

## 7. Rollback

На каждом репозитории: ветка `sync/c21.4-domain-and-fixes` — единственное
изменение. Откат: `git checkout main && git branch -D sync/…`.
Рабочее дерево, bare, GitHub, монорепо, контейнеры не затрагиваются до merge/push
(которые в этой задаче не выполняются).

## 8. Артефакты этапа

- `03-baseline-2026-10-11.txt` — базовые HEAD/статус/диск
- `04-sync-matrix.md` — полная матрица расхождений и классификация
- `05-sync-plan.md` — этот план
