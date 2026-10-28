# Stage 87 — Legacy Monorepo Retirement — Этап 1: READ-ONLY аудит

**Дата:** 2026-10-20 (UTC)
**Область:** `/home/animastor/animastor` (legacy монорепозиторий)
**Режим:** только чтение; ни одно изменение на диске/в git/в Docker не выполнялось.
**Итог:** **BLOCKED** — обнаружены незакрытые production-зависимости, уникальные данные
и неясный источник истины (GPU Hub). Этапы 2–4 **не выполнялись**.

---

## 1. Существование, путь, состояние git

| Параметр | Значение |
|---|---|
| Путь | `/home/animastor/animastor` (real path совпадает, симлинков нет) |
| Размер | 3.7G рабочее дерево + 78M `.git` (итого ~3.8G) |
| HEAD | `4574b3b96a86a2caa3e94df5b133f6e2970dfcd3` |
| Ветка | `c21.4-physically-extract-analysis-from-backend` (не detached) |
| Последний коммит | `4574b3b9` «chore: remove migrated docs/ and tools/», 2026-10-20 05:32 |
| Remote | `origin → /home/animastor/repos/animastor.git` (fetch+push); **GitHub-remote отсутствует** |
| Worktree | один (без доп. worktrees), stash пуст |
| Refs | 3 ветки (`c21.4-…` 4574b3b9, `master` 64127b9e, `tmp/parser-audit-backup` db5ff61f) + 3 remote-tracking |
| Загрязнение | `M frontends/website/index.html`, `?? docker/compose/overlay-backend-standalone.yml` |
| Git hooks | только `.sample` (кастомных нет) |
| Диск | `/` 99G, занято 76G, свободно **19G** (перемещение в пределах FS физически возможно) |

**Reflog:** активная работа до 2026-10-20; ветка `c21.4…` развивалась после сплита
(последние коммиты 11.10 и 20.10).

---

## 2. Уникальные коммиты и файлы

### 2.1 Коммиты
- Вся git-история монорепо **сохранена локально**: bare `repos/animastor.git` (40M) содержит
  все 3 ветки, HEAD `4574b3b9` присутствует (`cat-file -t = commit`, `fsck` чистый,
  `merge-base --is-ancestor` → reachable). Дополнительно
  `backups/animastor-pre-split-64127b9e.git` + `backups/before-split-64127b9e-refs/`.
- **GitHub-репозиторий `Animastor/animastor` не найден** (`ls-remote` → Repository not found):
  история монорепо существует только на этом хосте.
- Коммиты монорепо **не входят** в новые репозитории (разные истории после сплита) —
  это ожидаемо; они сохранены в bare-хранилище, а не «теряются».

### 2.2 Файлы рабочего дерева vs новые репозитории
Сравнение `git ls-files` монорепо (1304 файла) с объединением трекинга
`animastor-backend`, `animastor-web`, `animastor-android`, `animastor-worker`,
`animastor-gpu-hub`, `animastor-docs`:

- **21 путь** не имеет одноимённого файла в новых репозиториях:
  - `packages/animastor-gpu-hub/*` (19 файлов) — **расхождение содержимого, см. §7**;
  - `backend/.dockerignore` (файла нет в `animastor-backend` вообще);
  - `gpu-hub-rebuild.sh` (нет ни в одном новом репо).
  Все они покрыты git-историей монорепо (bare), т.е. восстановимы из git.

### 2.3 Нетрекингаемые (ignored) данные — только в монорепо, **не покрыты git**
| Объём/файл | Что это | Статус |
|---|---|---|
| `data/books` (1.9M), `data/output` (61M) | продовые данные книг/результатов | **смонтированы в production-контейнер** |
| `backend/ai` | AI-конфиги (workflows, connectors, rules, profiles) | **смонтированы в production** (RW) |
| `backend/tests` | тесты, смонтированы в backend-контейнер (RW) | **смонтированы в production** |
| `frontends/app/dist` | собранный SPA-бандл, отдаётся nginx | **смонтирован в production**; в `animastor-web` dist отсутствует |
| `frontends/website` | живой сайт | **смонтирован в production** |
| `proxy/conf/default.conf`, `proxy/conf/.htpasswd` | конфиг nginx и basic-auth | **смонтированы в production** |
| `backups/` внутри монорепо (1.2G, 111 файлов) | исторические архивы | **52 файла (~1023M) уникальны** — их нет в `~/backups/` |
| `.env` (2112 Б) | env монорепо-compose | не используется production-стеком (там `deploy/.env`), но запрещён к удалению заданием |
| `app_pictures/` (4.4M), `node_modules/`, `packages/*/node_modules`, `frontends/*/dist` | артефакты сборок | воспроизводимы |

Неизменённая правка `frontends/website/index.html` **байт-в-байт идентична**
`animastor-web/frontends/website/index.html` (правка = переход ссылок на `animastor-web`),
т.е. уникальных изменений в ней нет; но именно эта копия отдаётся в прод.

---

## 3. Согласованность действующих репозиториев (рабочие копии ↔ bare ↔ GitHub)

| Репозиторий | Рабочая копия HEAD | `repos/*.git` | GitHub `refs/heads/*` | dirty |
|---|---|---|---|---|
| `animastor-backend` | main `82c80af` | main/`github/main` `82c80af` | main `82c80af` | **7 записей** (см. §9) |
| `animastor-web` | main `fee4050` | main/`github/main` `fee4050` | main `fee4050` | 0 |
| `animastor-android` | main `92a56c0` | main/`github/main` `92a56c0` | main `92a56c0` | 0 |
| `animastor-worker` | main `b3f94f4` | main/`github/main` `b3f94f4` | main `b3f94f4` | 0 |
| `animastor-gpu-hub` | master `0f489c7` | master/`github/master` `0f489c7` | master `0f489c7` | 0 |
| `animastor-docs` | main `961709d` | — (bare нет) | main `961709d` | 0 |
| `animastor-tools` | **пусто: 0 коммитов, 0 файлов** | — (bare нет) | main **`8851479`** | — |
| монорепо | `4574b3b9` | `c21.4…` `4574b3b9` | репозитория нет | 2 записи |

- Синхронизация рабочих копей с bare и с GitHub — **соответствует** по всем действующим репо.
- Аномалия (вне цели этого этапа, но зафиксирована): локальный `animastor-tools` —
  **пустой** репозиторий (remote настроен, `fetch` не выполнялся), при том что на GitHub
  `main = 8851479`. Локальный источник истины для tools не существует.
- В `animastor-backend` **untracked `deploy/`** — продовый compose + `.env` не под git-контролем.

---

## 4. Использование монорепо

### 4.1 Работающие процессы и контейнеры — **ЗАВИСИМОСТЬ (критично)**
`docker inspect` по всем контейнерам:

| Контейнер | bind-mount из монорепо | Режим |
|---|---|---|
| `animastor-proxy` (nginx) | `proxy/conf/default.conf` → `/etc/nginx/conf.d/default.conf` | ro |
| | `proxy/conf/.htpasswd` → `/etc/nginx/.htpasswd` | ro |
| | `frontends/website` → `/usr/share/nginx/frontends/website` | ro |
| | `frontends/app` → `/usr/share/nginx/frontends/app` | ro |
| `animastor-backend` | `data/output` → `/data/output` | **RW** |
| | `data/books` → `/data/books` | **RW** |
| | `backend/ai` → `/app/ai` | **RW** |
| | `backend/tests` → `/app/tests` | **RW** |

Источник этих mount-ов — **активный** deploy-compose:
`/home/animastor/animastor-backend/deploy/docker-compose.yml`
(строки 107–111, 142–147) и `deploy/overlay-backend-standalone.yml`.

Подтверждение, что прод реально читает из монорепо:
`sha256(/home/animastor/animastor/frontends/website/index.html) ==
sha256(/usr/share/nginx/frontends/website/index.html)` = `a1900f4e…`.

Процессы с cwd **внутри** монорепо:
- PID 4094862 `-bash`, cwd `/home/animastor/animastor`, живёт с 2026-09-10;
- PID 945866 `node /tmp/opencode/run-connector.js`, cwd `/home/animastor/animastor`, с 2026-09-04.

Контейнеры `animastor-pg`/`animastor-redis` собраны из `/home/sureg/animastor/docker-compose.yml`
(другой пользователь) — к целевому каталогу **не привязаны**.

### 4.2 Скрипты запуска и обслуживания
- `~/backups/backup_animastor.sh`: `PROJECT_DIR=~/animastor` — **бэкап всего каталога монорепо**
  (кроме `animastor/data/output` и `*.tar.gz`).
- `~/backups/git_backup.sh`: бэкапит `$HOME/repos` (bare) — к монорепо **не привязан**.
- `~/backups/src-backup.sh` — общий src-архиватор, работает из cwd.
- Скрипты самого монорепо (`scripts/animastor-runtime-audit.sh:415,540-544`) содержат
  абсолютные пути `/home/animastor/animastor/…` (диагностические).
- `gpu-hub-rebuild.sh` (только в монорепо) собирает hub из `./packages/animastor-gpu-hub` (local dev).

### 4.3 cron и systemd
- `crontab -l` → «no crontab»; `/etc/cron.d/*` — animastor-записей нет; `/etc/crontab` — нет.
- Systemd-юнитов (user/system) с animastor нет; активных animastor-сервисов systemd нет.

### 4.4 Git hooks
- В монорепо кастомных hooks нет (только `.sample`). В действующих репо hooks не обнаружены.

### 4.5 CI/CD и deployment-скрипты
- GitHub workflows (`animastor-backend`, `animastor-gpu-hub`) ссылаются только на
  namespace-имена `animastor/…`, **путей к монорепо не содержат**.
- **Продовый deploy зависит от путей монорепо** (§4.1) через
  `animastor-backend/deploy/docker-compose.yml`, `deploy/overlay-backend-standalone.yml`,
  `deploy/README.md`.
- `animastor-backend/scripts/animastor-runtime-audit.sh` — упоминает пути монорепо (диагностика).
- Docker buildx: кэш/refs билдера (`~/.docker/buildx/refs/...`) указывают на пути монорепо
  (влияет только на будущие пересборки из mono-контекста).

### 4.6 Конфигурации и переменные окружения
- `animastor-backend/deploy/.env` — продовый env (пиннинг `BACKEND_IMAGE`, `GPU_HUB_IMAGE` по digest);
  **не содержит** путей к монорепо.
- `monorepo/.env` — legacy env монорепо-compose; production-стеком не читается.
- `~/.gitconfig` — `safe.directory = /home/sureg/repos/animastor.git` (к монорепо не относится).
- `~/.config/opencode/*`, `~/.bashrc`, `~/.profile` — путей к монорепо не содержат.

### 4.7 TLS / certbot — **ЗАВИСИМОСТЬ (критично)**
```
/etc/letsencrypt/renewal/animastor.org.conf: webroot_path = /home/animastor/animastor/frontends/website
/etc/letsencrypt/renewal/animastor.in.conf:  webroot_path = /home/animastor/animastor/frontends/website
```
Продовый ACME HTTP-01 webroot и nginx-location `/.well-known/acme-challenge/`
(`root /usr/share/nginx/frontends/website` = mount из монорепо) указывают на монорепо.
Перемещение каталога ломает **продление сертификатов** animastor.org/in.

### 4.8 Backup и recovery
- `backup_animastor.sh` → архивы `~/backups/backup_animastor_*.tar.gz`
  (последний: `2026-10-08_19-46.tar.gz`, 1.08G): покрывает `.git`, `data/books`,
  `backend/ai`, `proxy/conf`, `frontends/app/dist`, `.env`, `backups/*.zip`;
  **не покрывает** `data/output` и `backups/*.tar.gz` (исключены правилами), **не свежий** (08.10).
- `cutover-data-2026-10-12.tgz` (61M) — покрывает `data/books` + `data/output` **на 12.10**.
- `git_repos_2026-10-12.tar.gz` — bare-хранилище.
- **Актуальной (20.10) полной резервной копии монорепо не существует.**

### 4.9 Документация и автоматизация
- `animastor-docs/history/reorganization/2026-10/*`, `animastor-docs-deploy/architecture/*`,
  `animastor-worker/docs/architecture/WORKER_PACKAGE_RELOCATION_AUDIT.md` — упоминают пути
  монорепо как исторические факты/аудиты (не рабочие зависимости).
- `.config/manicode/**`, `.bash_history`, opencode-логи — следы прошлой работы (не зависимости).

---

## 5. Относительные пути и симлинки
- Симлинков **извне** в монорепо не найдено (поиск `find -xdev -type l -lname '/home/animastor/animastor/*'`).
- Внутри монорепо: `packages/animastor-comfyui-workflow-connector/node_modules/{.bin,mocha,chai}`
  → `backend/node_modules/…` (внутренние, исчезают вместе с каталогом).
- Относительные пути в **продовом** контексте: `animastor-backend/deploy/overlay-backend-standalone.yml`
  явно документирует, что относительные `./…` были заменены на абсолютные пути **в монорепо**,
  т.к. иначе монтировались бы пустые каталоги. Т.е. deploy-конфиг **спроектирован** вокруг монорепо.

---

## 6. Назначение проверяемых каталогов (пункт 6 задания)

| Путь | Наличие | Назначение |
|---|---|---|
| `/home/animastor/repos/*.git` | 6 bare-репо: `animastor`, `animastor-backend`, `animastor-web`, `animastor-android`, `animastor-worker`, `animastor-gpu-hub` | локальное git-хранилище + mirror `github/*`; **не трогать** |
| `/home/animastor/backups/` | 3.5G: `backup_animastor_*.tar.gz` ×3, `git_repos_*`, `cutover-{data,pg,config}-*`, `redis-dump`, `animastor-pre-split-64127b9e.git`, бэкап-скрипты | резервные копии; **не трогать** |
| `/home/animastor/data/` | **не существует** | продовые данные лежат в `monorepo/data/{books,output}` (смонтированы в контейнеры) |
| `.env` | `monorepo/.env` (legacy), `animastor-backend/deploy/.env` (продовый) | **не трогать** |
| Рабочие каталоги репо | `animastor-backend` (329M), `animastor-web` (186M), `animastor-android`, `animastor-worker`, `animastor-gpu-hub` (7.5M), `animastor-docs` (15M), `animastor-docs-deploy` (7.3M) | действующие; **не трогать** |
| GPU Hub | репозиторий `animastor-gpu-hub` + GHCR-образ `ghcr.io/…/animastor-gpu-hub@sha256:3611c644…` (контейнер `gpu-hub` Up 7d) + **дивергентная копия** `monorepo/packages/animastor-gpu-hub` | источник истины неоднозначен (§7) |
| Deployment-артефакты | `animastor-backend/deploy/` (untracked), GHCR `animastor-backend@sha256:182b0252…`, `artifacts.lock.json` в двух версиях | продовый стек; **не трогать** |

---

## 7. Неясный источник истины: GPU Hub package (BLOCKER)

`monorepo/packages/animastor-gpu-hub` и `animastor-gpu-hub/` **разошлись в обе стороны**:

| Файл | Монорепо (mtime) | Репозиторий (mtime) | Характер расхождения |
|---|---|---|---|
| `gpu-hub.js` | 10.10 — есть «BAKED-ARTIFACT STARTUP GATE» | 06.10 — есть `artifactDirEnvConfig` (3 вхождения), gate отсутствует | **двустороннее** |
| `server.js` | 01.09 — без `artifactDirEnvConfig` | 06.10 — с `artifactDirEnvConfig` | репо новее |
| `package.json` | `version 0.1.2`, publishConfig, URL mono | `version 0.1.0`, URL standalone | mono новее |
| `Dockerfile` | 10.10 — dual-stage `stager-monorepo`/`stager-release` | 07.10 — только release-режим | mono новее |
| `artifacts.lock.json` | 12.10 **12:32** (иной формат, sha256_asset) | 12.10 **12:15** (иная структура `sources`) | разные схемы |

Прод использует **GHCR-образ по digest**, т.е. ни одна из этих копий напрямую не «работает»,
но однозначного указания, какая копия является источником истины для будущих правок/сборок,
в документации и конфигурациях **нет**. Перенос/архивирование монорепо без этого решения
может потерять более новые файлы (baked-gate, Dockerfile dual-stage, 0.1.2).

---

## 8. Резюме: почему BLOCKED

1. **Production bind-mounts** (nginx: сайт, app, конфиг, `.htpasswd`; backend: `data/books`,
   `data/output`, `backend/ai`, `backend/tests`) указывают на монорепо и подтверждены
   `docker inspect` + sha256. Перемещение каталога = разрыв рестартов контейнеров,
   отдачи сайта и записи данных.
2. **Certbot renewal** (`animastor.org`, `animastor.in`) — `webroot_path` в монорепо.
3. **Бэкап-процедура** `~/backups/backup_animastor.sh` адресует `~/animastor`.
4. **Уникальные данные**: `data/{books,output}` (прод-данные), `backend/ai`, `frontends/app/dist`,
   52 архива (~1023M) в `monorepo/backups/`, `.env`; **актуальной полной резервной копии нет**
   (последняя полная — 08.10, `data/output` — 12.10, git-bare — 20.10 только для tracked-файлов).
5. **Неясный источник истины** по `packages/animastor-gpu-hub` (двустороннее расхождение, §7).
6. **Активные процессы** с cwd внутри монорепо (bash 4094862, node 945866).
7. Сопутствующее (не блокирует цель, но зафиксировано): пустой локальный `animastor-tools`
   при существующем GitHub `main@8851479`; untracked `deploy/` в `animastor-backend`.

**Выполненные действия:** только чтение и запись настоящего отчёта.
**Не выполнялось:** этапы 2–4 (подготовка, перемещение/удаление, пост-проверки),
изменение remotes/refs/истории, `docker compose down`, любая очистка.
