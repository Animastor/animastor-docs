# Безопасная реорганизация локальной структуры Animastor — отчёт

- Дата: 2026-10-11 (UTC)
- Режим: аддитивный. Ничего не удалялось, не перезаписывалось, не перемещалось.
  Никаких force-push / reset / clean / history rewrite не выполнялось.
- Результат: **PARTIAL** — локальные рабочие деревья 5 репозиториев приведены в
  соответствие с GitHub; **переключение инфраструктуры и паритет контента
  заблокированы** (см. §6).

---

## 1. Что сделано (изменения на диске)

Созданы 4 рабочих дерева клонами из локальных bare-репозиториев
(история сохранена, объекты hardlink'нуты с bare — bare не изменялись):

| Новый каталог | Источник | Ветка/HEAD | Размер |
|---|---|---|---|
| `/home/animastor/animastor-backend` | `repos/animastor-backend.git` | `main` @ `bce64db3` | 27M |
| `/home/animastor/animastor-web` | `repos/animastor-web.git` | `main` @ `c7fe52ac` | 15M |
| `/home/animastor/animastor-android` | `repos/animastor-android.git` | `main` @ `254e2f08` | 7.7M |
| `/home/animastor/animastor-worker` | `repos/animastor-worker.git` | `main` @ `618f87a6` | 1.3M |

Настройка git в каждом новом каталоге (только `.git/config`, аддитивно):
- `origin` → локальный bare (`/home/animastor/repos/animastor-<r>.git`) — как в монорепо;
- `github` → `git@github.com:Animastor/animastor-<r>.git` (fetch выполнен, только чтение);
- upstream ветки `main` → `origin/main`.

Существующие каталоги **не изменялись**:
`/home/animastor/animastor` (монорепо), `/home/animastor/animastor-gpu-hub`,
`/home/animastor/repos/*` (bare), `/home/animastor/backups/*`,
`/home/animastor/animastor/backups/*`, `data/`, `.env`, `node_modules`,
`proxy/conf`, ключи/сертификаты.

Также создан каталог отчёта `/home/animastor/reorg-2026-10-11/` (вне рабочих деревьев).

Итоговая структура `/home/animastor/`:

```
animastor-backend/     ← NEW  (worktree, main = bare = GitHub)
animastor-web/         ← NEW
animastor-android/     ← NEW
animastor-worker/      ← NEW
animastor-gpu-hub/     ← существующий worktree (master = bare = GitHub)
animastor/             ← монорепо: сохранён как живой инфраструктурный корень
repos/                 ← bare Git (не тронуты)
backups/               ← резервные копии (не тронуты)
reorg-2026-10-11/      ← этот отчёт
```

## 2. Проверки, пройденные (PASS)

| Проверка | Результат |
|---|---|
| `git status --porcelain` всех 5 worktree | 0 строк (чисто) |
| HEAD каждого worktree == bare-ref == GitHub (`ls-remote`) | PASS для всех 5 |
| SHA-дерева (`^{tree}`) worktree == bare == GitHub | PASS: backend `793ff627`, web `e85c8019`, android `6fb90488`, worker `06296fa8`, gpu-hub `49c05233` |
| `git fsck` всех 5 worktree | clean |
| `git worktree list` монорепо | не изменён (`465453df`, ветка `c21.4-physically-extract-analysis-from-backend`) |
| Bare-репозитории | refs/HEAD не изменены (снапшот §3) |
| Содержимое clone == bare (per-file blob) | 100% идентично во всех 5 |
| `docker compose config -q` (монорепо) | OK, конфигурация валидна |
| `docker compose ls -a` | проект `animastor` running(5), те же 3 файла конфигурации |
| Контейнеры | animastor-backend, gpu-hub, proxy, pg, redis — Up, без рестартов |
| Монорепо `git status` | без изменений (1 pre-existing untracked: `docker/compose/overlay-backend-standalone.yml`) |
| Свободный диск после клонов | 6.7 ГБ (не изменился — клоны ~51M) |

Соответствие GitHub (verified 2026-10-11): backend `bce64db3`, web `c7fe52ac`,
android `254e2f08`, worker `618f87a6`, gpu-hub `ecefd0b7` — bare == GitHub во всех случаях.

## 3. Снапшот до/после

`00-sha-snapshot.txt` — SHA всех refs 6 bare-репозиториев и монорепо-worktree,
снят непосредственно перед клонированием. После миграции refs bare не менялись
(сверка: HEAD 6 bare совпадают со снапшотом).

## 4. Аудит принадлежности и зависимостей

### 4.1 Принадлежность каталогов монорепо

| Каталог/файл | Принадлежность | Статус |
|---|---|---|
| `backend/`, `packages/animastor-{ai-*,assistant,auth,comfyui,contracts,editor,generation,installer,orchestration,parser,player,url-safety,vbook-runtime}`, `proxy/`, `scripts/`, `docker/`, `docker-compose.yml`, `docs/` | animastor-backend | уже в backend-репо |
| `frontends/{app,website}/`, `packages/animastor-web-*`, `tools/`, часть `docs/` | animastor-web | уже в web-репо |
| `frontends/android/`, `apk-build.sh`, `build-apk.sh` | animastor-android | уже в android-репо |
| `packages/animastor-worker/`, `docker/worker/` | animastor-worker | уже в worker-репо |
| `packages/animastor-gpu-hub/` (fixture), `gpu-hub-rebuild.sh` | animastor-gpu-hub (выполнен физический split, fixture остался в монорепо) | не трогали |
| `data/{books,output}` | пользовательские данные (mount в контейнеры) | **не переносить** |
| `.env`, `proxy/conf/.htpasswd`, ключи/TLS | секреты/конфиг | **не переносить** |
| `backups/`, `node_modules/`, `workflow.json/`, `local.properties` | локальные/сгенерированные | **не переносить** |

Реестр `packages/` монорепо (30 пакетов) разнесён по репозиториям через whitelist
split — каждый новый worktree несёт свой подмножество; пересечений и вложенных
дублей репозиторий нет.

### 4.2 Привязка инфраструктуры к абсолютным путям монорепо (НЕ трогали)

Compose-проект `animastor` (`docker compose ls`) монтирует/собирает:

| Путь | Роль |
|---|---|
| `/home/animastor/animastor/backend` | build context backend |
| `/home/animastor/animastor/backend/ai` | bind mount `/app/ai` (AI-конфиги, редактируются на хосте) |
| `/home/animastor/animastor/backend/{src,tests}` | bind mount (в pinned-image overlay отключены для src) |
| `/home/animastor/animastor/data/{output,books}` | пользовательские данные |
| `/home/animastor/animastor` (root) + `packages/animastor-gpu-hub/Dockerfile` | build context gpu-hub (в pinned-режиме не используется) |
| `/home/animastor/animastor/proxy/conf/{default.conf,.htpasswd}` | nginx |
| `/home/animastor/animastor/frontends/{website,app}` | nginx: live-раздача web (`app.animastor.org`), обновляется без рестарта |
| `/home/animastor/animastor/docs` | nginx: docs |

Прочие привязки:
- `.env`: `BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:…` (production pinning);
  untracked overlay `docker/compose/overlay-backend-standalone.yml` отключает
  `backend/src` mount и `build` — production-код берётся из образа, собранного из монорепо (`deploy-e233d64d`).
- В проекте compose числится **несуществующий** `/home/sureg/animastor/docker-compose.yml`
  (stale-запись, файл отсутствует) — задокументировано, не исправлялось.
- Рабочий процесс воркера живёт у другого пользователя: `/home/sureg/animastor/worker`
  (image/, worker/, logs/, start-worker.sh) — **вне скоупа, не трогали**.
- `front-backend-rebuild.sh` содержит `sdk.dir=/home/sureg/Android/Sdk` (Android SDK в чужом home).
- systemd-юнитов и crontab для animastor нет.
- Скрипты `*-rebuild.sh` работают относительно корня монорепо и по-прежнему указывают на него.

### 4.3 Симлинки/артефакты

- `node_modules/` монорепо — локальные симлинки `-> ../packages/*` (ручная раскладка), не входят ни в один репозиторий; **в клоны не переносились**.
- `frontends/app/node_modules` (172M), `backend/node_modules` (103M) — в монорепо, на месте.
- В новых клонах зависимостей нет (по ограничению: не тащить `node_modules` вслепую).

## 5. Существующие Git-репозитории (до/после)

| Репозиторий | Bare HEAD | GitHub | Worktree до | Worktree после |
|---|---|---|---|---|
| animastor (legacy monorepo) | `64127b9e` master / `465453df` c21.4 | — | `/home/animastor/animastor` | **без изменений** |
| animastor-backend | `bce64db3` | = | отсутствовал | создан |
| animastor-web | `c7fe52ac` | = | отсутствовал | создан |
| animastor-android | `254e2f08` | = | отсутствовал | создан |
| animastor-worker | `618f87a6` | = | отсутствовал | создан |
| animastor-gpu-hub | `ecefd0b7` | = | `/home/animastor/animastor-gpu-hub` | без изменений |

Примечание: у gpu-hub worktree remote только `origin` (bare), remote `github`
и upstream не настроены — **оставлено как есть** (существующее рабочее дерево
в этой задаче не модифицировалось).

## 6. Блокеры (почему PARTIAL, а не PASS)

### B1 — Контент монорепо новее всех пяти репозиториев (критично)

Ветка монорепо `c21.4` = **36 коммитов** после frozen `master` (`64127b9e`),
включая (HEAD `465453df`, 2026-10-11):

- `0dbdae4a` fix(assistant): purge при удалении книги;
- `e233d64d` fix(editor): регистрация editor-контура (boot + entity CRUD);
- `0c55b5a7` fix(deploy): blockers сборки backend-образа;
- `1c37e14a` chore(artifacts): 4 release-zip + sha256_asset;
- `60f8b9ee` feat(domain): миграция `animastor.in → animastor.org`.

Per-file blob-сравнение (см. `02-divergence-matrix.txt`):

| Репозиторий | Файлов в репо | Идентично монорепо | Расходятся | Нет в монорепо |
|---|---|---|---|---|
| backend | 1045 | 971 | **74** (в т.ч. `backend/src/**`, `packages/**`) | 0 |
| web | 351 | 317 | **34** (`frontends/app/src/**`, `frontends/website/**`) | 0 |
| android | 219 | 210 | **9** (UI-фрагменты, `build.gradle.kts`) | 0 |
| worker | 60 | 48 | **12** (`worker.cjs`, entrypoint) | 0 |

Во всех случаях содержимое в репозиториях **устарело** относительно монорепо
(последний кодовый коммит: web — 22.08, android — 12.08, worker — 07.09,
backend — 26.09 + compose-only правки 08.10; монорепо — 11.10).
При этом пять репозиториев **не теряют ни одного файла** относительно монорепо
(колонка «Нет в монорепо» = 0) — потери нет, есть **отставание**.

Следствие: новые рабочие деревья корректны как «локальная копия GitHub», но
**не должны** использоваться как источник сборки/деплоя до портирования работы
из `c21.4` в пять репозиториев. Это отдельная задача синхронизации контента,
не реорганизация каталогов.

### B2 — Живая инфраструктура привязана к монорепо (см. §4.2)

Репоинт compose/nginx/скриптов на новые worktree потребует правки
`docker-compose.yml`, перезапуска контейнеров и пересборки web-артефактов —
явно выходит за рамки «не переключать работающую инфраструктуру».
**Оставлено без изменений.**

### B3 — Диск заполнен на 93% (6.7 ГБ свободно)

Сборки web/backend/android и `npm ci` в новых клонах не выполнялись:
риск исчерпания места + косвенный риск для живых сервисов.

### B4 — Не выполнявшиеся проверки (явно)

- `npm test` backend/worker, `typecheck`/`vitest`/`vite build` web,
  `gradle :app:assembleDebug` android — **NOT RUN** в новых клонах
  (нет `node_modules`; см. B3). Их последний задокументированный результат —
  `docs/architecture/repository-split-final-verification.md` (2026-10-05):
  backend 923/2 pre-existing failing, web 201/201 + build, worker 45/45,
  android BUILD SUCCESSFUL. Эти данные **не перепроверялись** сегодня.
- e2e `docker/e2e/dispatch-task.cjs` — NOT RUN (требует живого GPU Hub + секретов).
- Проверка «исходники == ожидаемые версии репозиториев» пройдена на уровне
  Git-деревьев (bare == worktree == GitHub), **но** не на уровне «работа приложения»
  из-за B1.

## 7. Rollback

Полный и тривиальный: `rm -rf /home/animastor/animastor-{backend,web,android,worker}`
(только эти 4 каталога созданы этой задачей) + `rm -rf /home/animastor/reorg-2026-10-11`.
Более ничего не изменено: bare, GitHub-refs, монорепо, gpu-hub, данные, `.env`,
контейнеры — нетронуты.

## 8. Рекомендации (отдельные задачи, НЕ выполнены здесь)

1. **Синхронизация контента** `c21.4` → 5 репозиториев (cherry-pick/merge по
   границам репозиториев) — снимает B1 и делает репозитории источником истины.
2. **Cutover инфраструктуры**: перенос `docker-compose.yml`, `docker/`, `proxy/`,
   `.env`, `data/`, `docs/` в отдельный каталог инфраструктуры
   (например `/home/animastor/infra/`) с обновлением путей и плановым рестартом.
3. Репоинт `*-rebuild.sh` на новые worktree — только после 1 и 2.
4. Убрать stale-запись `/home/sureg/animastor/docker-compose.yml` из compose-проекта.
5. Настроить `github` remote/upstream у gpu-hub worktree (консистентность).
6. Проверить свободное место (93%) и почистить эфемерные `/tmp/*`-копии split-проверок.

## 9. Артефакты отчёта

- `00-sha-snapshot.txt` — SHA до миграции
- `01-report.md` — этот документ
- `02-divergence-matrix.txt` — per-file матрица расхождений монорепо ↔ репозитории
