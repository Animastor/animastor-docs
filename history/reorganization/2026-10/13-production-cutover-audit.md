# Animastor — Этап 9: предпереключательный аудит production-инфраструктуры

- Дата: 2026-10-11 (UTC)
- Режим: **read-only**. Ничего не изменено: конфигурация, контейнеры, образы,
  DNS/TLS, симлинки, Git refs, bare, монорепо, GPU Hub — не тронуты. Сборка,
  деплой, перезапуск, push/merge — не выполнялись.
- Итог: **PASS** (инвентаризация и карта зависимостей подтверждены; план cutover
  готов §5; нерешённые вопросы и невыполнимые read-only проверки — §6–§7)

## 0. Подтверждение исходного состояния (pre-flight)

| Репозиторий | HEAD (worktree, main) | Дерево | GitHub `main` | Совпадение |
|---|---|---|---|---|
| animastor-backend | `a7a8c463` | чистое | `a7a8c463` | ✓ |
| animastor-web | `fbc93662` | чистое | `fbc93662` | ✓ |
| animastor-android | `92a56c0d` | чистое | `92a56c0d` | ✓ |
| animastor-worker | `b3f94f42` | чистое | `b3f94f42` | ✓ |

Монорепо `465453df` (1 untracked-файл — pre-existing от 10.10, §2.4), GPU Hub
`ecefd0b7` (clean), bare всех 4 — на довоенных SHA (отстают на 1/1/1/4).
Отчёты 10/11/12 перечитаны; все зафиксированные там SHA подтверждены заново.

## 1. Состояние production на момент аудита

### 1.1 Docker Compose

Проект **`animastor` — running(5)**, конфигурация из compose ls:

| Файл | Статус |
|---|---|
| `/home/animastor/animastor/docker-compose.yml` | существует (монорепо) |
| `/home/animastor/animastor/docker/compose/overlay-backend-standalone.yml` | существует (untracked, mtime 2026-10-10) |
| `/home/sureg/animastor/docker-compose.yml` | **ОТСУТСТВУЕТ на диске** — запись сохранилась в состоянии compose-проекта (§6.2) |

`docker compose config --services` (с этими -f, read-only): postgres, redis,
backend, gpu-hub, nginx. Фактически разрешённая конфигурация = базовый
compose + overlay pinned-image для backend; `.env` монорепо задаёт
`BACKEND_IMAGE` и `GPU_HUB_IMAGE` (pin по digest).

### 1.2 Контейнеры, образы, digest

| Контейнер | Образ (Config.Image) | Digest | Up | Restart |
|---|---|---|---|---|
| animastor-backend | `ghcr.io/animastor/animastor-backend@sha256:e8152778…` | `e8152778e1f0…` | 22h | unless-stopped |
| gpu-hub | `ghcr.io/animastor/animastor-gpu-hub@sha256:daf510ff…` | `daf510ff8e6d…` | 2d | unless-stopped |
| animastor-proxy | `nginx:alpine` | `54f2a904…` | 5w | unless-stopped |
| animastor-pg | `postgres:16` | `f8e2cc2a…` | 6w | unless-stopped (healthy) |
| animastor-redis | `redis:7` | `b2b95679…` | 6w | unless-stopped (healthy) |

Не в compose-проекте: `ollama` (docker run, 127.0.0.1:11434), `repro-redis`,
`buildx_buildkit_repro0` — репро/исследовательские, к production не относятся.

### 1.3 Mounts / volumes / сети / env

Сеть одна: `animastor_net` (bridge). Named volumes: `pg-data`, `redis-data`.
Bind-монты:

| Контейнер | Источник (хост) | Назначение | rw |
|---|---|---|---|
| backend | `/home/animastor/animastor/data/output` | `/data/output` | rw |
| backend | `/home/animastor/animastor/data/books` | `/data/books` | rw |
| backend | `/home/animastor/animastor/backend/ai` | `/app/ai` | rw |
| backend | `/home/animastor/animastor/backend/tests` | `/app/tests` | rw |
| proxy | `/home/animastor/animastor/frontends/website` | `/usr/share/nginx/frontends/website` | ro |
| proxy | `/home/animastor/animastor/frontends/app` | `/usr/share/nginx/frontends/app` | ro |
| proxy | `/home/animastor/animastor/docs` | `/usr/share/nginx/docs` | ro |
| proxy | `/home/animastor/animastor/proxy/conf/default.conf` | `/etc/nginx/conf.d/default.conf` | ro |
| proxy | `/home/animastor/animastor/proxy/conf/.htpasswd` | `/etc/nginx/.htpasswd` | ro |
| proxy | `/etc/letsencrypt` | `/etc/letsencrypt` | ro |

Env — только имена (значения секретов не раскрываются): backend
(`COOKIE_DOMAIN`, `HUB_URL`, `PG_*`, `OPENROUTER_API_KEY`, `WORKSPACE_SECRET_KEY`,
`GPU_HUB_API_KEY`, `SHARE_FEATURES_ENABLED`, `AI_*`, research-флаги);
gpu-hub (`GPU_HUB_API_KEY`, `GPU_TIMEOUT`, `SHARE_FEATURES_ENABLED`);
proxy — только базовые nginx. В `.env` монорепо (ключи): POSTGRES_PASSWORD,
OPENROUTER_API_KEY, WORKSPACE_SECRET_KEY, GPU_HUB_API_KEY — секреты;
публичные значения: `COOKIE_DOMAIN=animastor.org`, `SHARE_FEATURES_ENABLED=1`,
`GPU_HUB_IMAGE=…@sha256:daf510ff…`, `BACKEND_IMAGE=…@sha256:e8152778…`.

### 1.4 Health / логи

- pg/redis: **healthy**; остальные — healthcheck не определён (pre-existing).
- Живые эндпоинты (read-only HTTP): `https://animastor.org/health` → **200**;
  `https://animastor.org/gpu/health` → **200**; `/gpu/` root → 404 (норма).
- `docker exec animastor-proxy nginx -t` → **syntax ok / test successful**
  (только депрекейшн-варны `listen … http2` — косметика).
- Логи: backend — штатный runtime-loop/scheduler без ошибок в хвосте;
  gpu-hub — штатные сводки.

### 1.5 Каталоги / владельцы / права

Все mount-каталоги: владелец `animastor:animastor`, `drwxrwxr-x` (кроме
`data` — `drwxr-xr-x`). `.htpasswd` (44 байта) существует и смонтирован.
`data/` — 63 МБ, в `.gitignore` монорепо (`data/output/`, `data/books/`).

### 1.6 TLS (через живой SNI, не файловая система — /etc/letsencrypt без root)

| Домен | Issuer | SAN | Действует |
|---|---|---|---|
| animastor.org (+app/admin/www) | LE YE2 | 4 × `.org` | 2026-10-08 → **2027-01-06** |
| animastor.in (+app/admin/www) | LE YR1 | 4 × `.in` | 2026-08-21 → **2026-11-19** |

Живые редиректы `.in → .org` **подтверждены фактически**:
`http://animastor.in/`, `https://animastor.in/`, `http://www.animastor.in/` —
все **301 → https://animastor.org/**. (Это закрывает «живую» проверку,
которая числилась невыполненной в отчётах 06–07.)

## 2. Зависимости от монорепозитория (подтверждены)

### 2.1 Сводная таблица зависимостей

| # | Текущий путь (монорепо) | Сервис | Тип | Путь после миграции | Что может сломаться | Проверка / восстановление |
|---|---|---|---|---|---|---|
| D1 | `docker-compose.yml` + `docker/compose/overlay-backend-standalone.yml` + `.env` | все (compose-проект) | инфраструктура | корень нового деплой-каталога (backend-репо `docker-compose.yml` уже содержит все 5 сервисов с pinned gpu-hub; нужен 3-way с текущим продакшн-вариантом + перенос `.env`) | неверная комбинация -f теряет pinned overlay → `build:` из монорепо | `docker compose config` до `up`; откат = прежние -f-файлы монорепо |
| D2 | `data/output`, `data/books` | backend | **общие данные** (не в git) | оставить на месте (или переадресовать mount-ом в новом compose) | потеря книг/аутпутов | ничего не перемещать на этапе cutover; откат = вернуть volumes в прежний compose |
| D3 | `backend/ai` (rw) | backend | репо backend (идентично: `diff -rq` mono↔backend-репо — **0 различий**) | `/home/animastor/animastor-backend/backend/ai` (тот же git-контент) | расхождение AI-конфигов после первого прав-коммита в новом репо | diff mono↔repo перед переключением mount; откат — прежний mount |
| D4 | `backend/tests` (rw) | backend | репо backend | `…/animastor-backend/backend/tests` | тест-фикстуры в контейнере | на прод редко критично; откат — прежний mount |
| D5 | `proxy/conf/default.conf` | proxy | репо backend (**byte-identical**: `diff` пуст) | `/home/animastor/animastor-backend/proxy/conf/default.conf` | nginx отдаёт старую конфигурацию | `nginx -t` в контейнере после переключения; rollback — вернуть mount |
| D6 | `proxy/conf/.htpasswd` | proxy | **инфраструктура-секрет** (в git репо отсутствует) | остаётся на текущем месте, вне git | потеря basic-auth | копия уже смонтирована; не коммитить в репо |
| D7 | `frontends/website` (ro) | proxy | репо web (расхождения см. §2.3) | `/home/animastor/animastor-web/frontends/website` | сайт/ACME webroot/скачивание APK | сравнить с mono до переключения; откат — прежний mount |
| D8 | `frontends/app` (ro, SPA dist) | proxy | репо web (**dist отсутствует в web-репо** — gitignored build-артефакт) | web-репо требует `vite build` → копия dist в деплой-каталог | пустой `app.animastor.org` | проверить index.html+assets перед up; откат — прежний mount |
| D9 | `docs` (ro) | proxy | репо backend (расхождения — split-журналы, см. §2.3) | `/home/animastor/animastor-backend/docs` | косметика документации | diff; откат — прежний mount |
| D10 | `/etc/letsencrypt` + ACME webroot в `frontends/website/.well-known` | proxy, certbot (`/etc/cron.d/certbot`) | **инфраструктура** (вне git) | без изменений | продление `.in`-сертификата 19.11.2026 уйдёт в web-репо-каталог | после переключения website-монта — проверить webroot; откат — прежний mount |
| D11 | `packages/animastor-gpu-hub/` (фикстура монорепо) | не используется в production | — | **не переносить**; production-образ pinится из GHCR, репо-источник — `/home/animastor/animastor-gpu-hub` (`ecefd0b7`) | ложное ощущение, что GPU Hub собирается из монорепо | осознанно не трогать |
| D12 | `/home/animastor/animastor-worker` (worktree) | не смонтирован | репо worker | источник для repin worker-bundle (§3.1) | — | — |
| D13 | `scripts/` (enable-admin-https.sh и пр.), `backups/` | операторские скрипты | инфраструктура | остаются; в репо backend есть свои `scripts/` — не перезаписывать | путаница двух `scripts/` | использовать явные пути |

### 2.2 Отсутствующие/неожиданные находки

- **D1-продолжение:** третий конфиг compose-проекта — `/home/sureg/animastor/docker-compose.yml`
  (файл удалён/перемещён, осталась запись состояния). Проект запущен и работает;
  при следующем `docker compose up` с восстановлением compose ls эта запись
  может вызвать предупреждение/ошибку. Требует решения до cutover (§6.2).
- В `/home/sureg/animastor/` остался только каталог `worker/` (rwxrwxr-x) —
  не смонтирован в работающие контейнеры; касается лика «старые deploy-каталоги».

### 2.3 Сверка содержимого mono ↔ новые репозитории (read-only)

| Каталог | Результат |
|---|---|
| `backend/ai` | **идентичны** (0 различий) ✓ |
| `proxy/conf/default.conf` | **byte-identical** ✓ |
| `docs` | расхождения только в `docs/architecture`: split-журналы и DOMAIN_MIGRATION-док присутствуют в mono, отсутствуют/различаются в backend-репо (ожидаемо — осознанно не переносились, отчёт 06 §7) |
| `frontends/website` | mono содержит `downloads/animastor-android-latest.apk` и `.well-known/` (runtime-артефакты); `index.html` **различается** — требует 3-way перед переключением монта (§6.3) |
| `frontends/app/dist` | в web-репо **отсутствует** (собирается локально; в mono есть) |

### 2.4 Прочее

- Монорепо: untracked `docker/compose/overlay-backend-standalone.yml`
  (mtime 2026-10-10, до этапов публикации) — **составная часть работающего
  продакшн-запуска**, хотя и не в git. Должен быть перенесён в backend-репо
  отдельным решением (не в рамках read-only аудита).
- Systemd-юнитов animastor нет; cron — только `certbot`, `e2scrub_all`.
  CI/CD-агентов на хосте не обнаружено; сборка образов — через GitHub Actions
  gpu-hub (`.github/workflows/ghcr-release.yml`) и GHCR-пиннинг.
- Installer/npm: `@animastor/installer@0.1.1`, `@animastor/gpu-hub@0.1.2`
  опубликованы (отчёт 10 §5.5, R4) — npm-зависимости восстановимы без монорепо.

## 3. Риски и блокеры (проверенные)

### 3.1 ⚠️ Repin `artifacts.lock.json` — подтверждён расчётом

Пин gpu-hub: `worker-bundle` v2.1.1, `sha256_tree = 4bb0408b…` (8 файлов из
`packages/animastor-worker/worker`). Пересчитал дерево нового worker main
(`b3f94f42`) по той же формуле tool-а (`sha256` строк `"<sha256>  <relpath>"`,
C-locale sort, LF; worker-bundle group исключает `package-lock.json`):

- **новый `sha256_tree` = `ad20386cb0f1…` ≠ пин `4bb0408b…` → repin ОБЯЗАТЕЛЕН.**
- Изменённые файлы бандла: `worker.cjs`, `package.json`, `.env.example`
  (3 из 8) — как и предсказывал отчёт 10 §5.1.

Дополнительно: backend main (`a7a8c463`) изменил `packages/animastor-installer/src/installer/*`
(engine.js, cli.js) и `package.json` — группа **`installer-src`** тоже выходит
из-под пина (пин `version 0.1.1`, tool той же формулой). Группы
`hub-workflows` (`backend/ai/workflows`) и `install-manifests` — в diff backend
main не попали.

**Вывод:** repin нужен минимум для `worker-bundle` и `installer-src`; выполнять
`tools/update-artifacts-lock.cjs` + rebuild/release pinned-образа gpu-hub +
обновление `GPU_HUB_IMAGE` в `.env` — отдельное решение, здесь не выполнялось.

### 3.2 Контракт worker-bundle в живом GPU Hub

`https://animastor.org/gpu/worker-bundle/sha256` → v2.1.1,
`sha256=480af146451e…` (это digest собранных байтов бандла внутри текущего
pinned-образа `daf510ff`; иной формат, чем `sha256_tree` лока — не путать).
Список файлов = 8, включает `package-lock.json`. Контракт `/worker-bundle` +
sha256-verify жив и согласован между backend-installer и worker (отчёт 10 §4).
После repin значение `sha256` изменится — installer будет фетчить новое.

### 3.3 Nginx/TLS — живые проверки ВЫПОЛНЕНЫ

301-редиректы `.in → .org` работают на всех трёх вариантах; `.org`-сертификат
свежий (до 2027-01-06); `.in`-сертификат истекает **2026-11-19** — продление
через certbot + ACME webroot в `frontends/website/.well-known` (см. D10:
webroot переедет вместе с website-монтом — проверить после переключения).
`nginx -t` успешен.

### 3.4 Зависимость деплоя от монорепо

**Production сейчас целиком живёт в монорепо**: compose-файлы, `.env`,
все bind-mounts, ACME webroot. Pinned-образы backend/gpu-hub из GHCR не
зависят от монорепо; но nginx-конфиг, статика, AI-дерево и данные — монтируются
из него. Cutover = переключение compose-проекта на новые пути, а не сборка.

### 3.5 Возможность сборки/запуска из новых каталогов

- backend-репо содержит свой `docker-compose.yml` (все 5 сервисов, gpu-hub
  `${GPU_HUB_IMAGE:?…}` pinned) + `.env.example` — **но это не байт-идентично
  текущей прод-комбинации** (в проде — базовый mono-compose + overlay;
  в репо — единый файл с pinned gpu-hub и `build: ./backend`). Требует 3-way
  (см. план, шаг 2).
- Сборка backend-образа из репо: выполнима (Dockerfile в репо, npm-версии
  опубликованы), **не проверялась** (запрет на сборку в этом этапе).
- web-репо: dist не собран — нужен `vite build` перед выкладкой статики.
- android: к production отношения не имеет (APK раздаётся как файл
  `frontends/website/downloads/animastor-android-latest.apk` — mono-копия;
  после переключения website-монта убедиться, что APK-файл сохранён).

### 3.6 Диск

**6.3 ГБ свободно (94% занято)** — критично мало. Сборка/загрузка новых
образов (~2.5 ГБ backend-образ + слои) и любые `npm ci` рискованно упрутся
в диск. Требуется освободить место до cutover (кандидаты: старые docker-образы,
`backups/*.zip`, `~/.gradle`, кеши) — **блокер cutover**.

### 3.7 Стратегия синхронизации bare Git

Bare (`/home/animastor/repos/*.git`) отстаёт от GitHub: worker 1, web 1,
android 1, backend 4 коммита. Синхронизация — обычный `git push origin main`
(FF, без force) из worktree каждого репо; предковость уже подтверждена в
этом аудите. Никаких merge/rebase не требуется. Выполняется отдельным решением
(в рамках этапа 9 — запрет на изменение refs).

## 4. Что осознанно НЕ менялось (контроль)

Конфиги, контейнеры (без перезапуска), образы (без pull), DNS, TLS,
симлинки, git-refs (worktree/bare/GitHub/монорепо/gpu-hub), data/,
`artifacts.lock.json`, backups — **не тронуты**. Все проверки — read-only
(inspect, ls-remote, curl GET, `nginx -t` exec, `compose config`).

## 5. План cutover (пошагово; активация — только отдельным решением)

**Фаза A — подготовка (без активации):**

1. **Очистка диска** до ≥15 ГБ свободных (старые образы `docker image prune`
   по согласованию, старые бэкап-зипы). Измерить `df -h` — критерий входа.
2. **Новый деплой-каталог**: перенести/скопировать `docker-compose.yml`,
   `docker/compose/overlay-*.yml`, `.env` (секреты — вручную оператором,
   не через git) в `animastor-backend/deploy/`; сверить 3-way текущий прод
   (mono-compose + overlay) vs репо-compose; зафиксировать итоговый файл.
3. **Проверка путей**: все mount-источники существуют и доступны
   (data/*, backend/ai, backend/tests, proxy/conf/default.conf,
   .htpasswd — ручная копия вне git, frontends (см. 4), docs, letsencrypt).
   `docker compose -f <новый> config` без ошибок.
4. **Репозитории**: `git status` чист, HEAD == опубликованным SHA;
   синхронизация bare (`git push origin main` ×4, FF).
5. **Web-статика**: `vite build` в web-репо → сверить `dist/` с текущим
   mono-`; проверить `index.html` сайта 3-way (§2.3) — разрешить расхождение
   до переключения; сохранить `downloads/animastor-android-latest.apk` и
   `.well-known/acme-challenge/` при переезде website-каталога.
6. **Repin GPU Hub** (отдельное решение): `update-artifacts-lock.cjs`
   (worker-bundle → `ad20386c…`, installer-src из backend-репо) → release
   ghcr-release.yml → новый pinned digest → обновить `GPU_HUB_IMAGE` в `.env`
   (rollback: прежний `daf510ff…`).

**Фаза B — проверка до переключения (dry-run):**

7. Поднять **теньевой стек** на альтернативных портах/именах из нового
   каталога (backend+gpu-hub pinned; proxy с копией conf на 8080/8443):
   `docker compose --project-name animastor-cutover-test up -d` — без
   остановки текущего. Проверить `/health`, `/gpu/health`, `/gpu/worker-bundle/sha256`
   (новый sha после repin), `nginx -t`, редиректы с теневого SNI/хоста.
8. Решение по repin: либо repin до переключения (рекомендуется — иначе новый
   gpu-hub-образ будет отдавать старый worker-bundle, несогласованный с
   worker main), либо осознанно оставить 2.1.1.

**Фаза C — последовательность переключения (минимальный простой):**

9. Окно обслуживания. `docker compose` (текущий проект) `stop backend nginx`
   → `up -d` с новым compose из нового каталога (те же container_name =
   переиспользируют контейнеры) → проверки §5.10. Простой = секунды на каждый
   сервис; postgres/redis **не пересоздавать** (данные в named volumes —
   новый compose обязан объявлять те же `pg-data`/`redis-data` и сеть
   `animastor_net`, либо подключать контейнеры к той же сети).
10. **Проверки после**: `docker ps` (5 контейнеров Up), `/health` 200,
    `/gpu/health` 200, `/gpu/worker-bundle/sha256` == ожидаемому,
    HTTPS 200 на app/docs, 301 `.in → .org`, `nginx -t`, TLS SAN legacy,
    логи backend/gpu-hub без ошибок 5 минут, PG-данные на месте
    (счётчик книг/задач), очередь/очередь GPU Hub.

**Фаза D — критерии отката:**

11. Немедленный откат, если: `/health` или `/gpu/health` ≠ 200 более 60 с;
    301-редиректы `.in` не работают; ошибка TLS/SAN legacy; потеря видимости
    PG-данных; nginx не стартует (`nginx -t` fail); backend-crashloop.
12. **Команды отката** (точные, прежняя конфигурация не удалена):
    ```
    cd /home/animastor/animastor
    docker compose -f docker-compose.yml \
      -f docker/compose/overlay-backend-standalone.yml up -d --force-recreate
    ```
    (образы `e8152778…`/`daf510ff…` локально на месте — сеть/тома/имена
    совпадают; `BACKEND_IMAGE`/`GPU_HUB_IMAGE` в моно-`.env` не менялись.)
    Затем §5.10-проверки. Git-refs не менялись — откат чисто инфраструктурный.

**Фаза E — условия остановки (не начинать/прервать):**

13. Свободный диск <15 ГБ; неразрешённые расхождения `frontends/website/index.html`
    (§2.3); не принято решение по repin (§5.8) и по записи compose-проекта
    со ссылкой на `/home/sureg/animastor/docker-compose.yml` (§6.2); нет
    резервной копии `data/` (63 МБ — быстрая) и pg-dump; сертификат `.in`
    не продлён до 19.11.2026; любой из тестов фазы B красный.

**Старая структура (монорепо) сохраняется полностью** до отдельного
подтверждения стабильности новой инфраструктуры (≥7 дней наблюдения).

## 6. Нерешённые вопросы

1. **Репин**: выполнять ли repin до переключения (рекомендуется) и в каком
   составе (worker-bundle + installer-src).
2. **Запись состояния compose** ссылается на несуществующий
   `/home/sureg/animastor/docker-compose.yml` — чем и когда она была создана;
   безопасно ли для `docker compose up` из нового каталога (§2.2).
3. **`frontends/website/index.html`** различается mono↔web-репо — какой
   вариант каноничен (требует 3-way-решения владельца).
4. Судьба untracked `overlay-backend-standalone.yml` — закоммитить в
   backend-репо (`deploy/`) или заменить единым репо-compose.
5. Каталог `/home/sureg/animastor/worker/` — к чему относится, нужен ли.
6. Дисковое пространство (блокер): план очистки и квота ≥15 ГБ.

## 7. Проверки, которые НЕ удалось выполнить (read-only / вне скоупа)

| Что | Причина |
|---|---|
| Файлы `/etc/letsencrypt/live/*` напрямую | нужны root; обходной путь — SNI-пробы openssl (выполнены) ✓ |
| Сборка образов из новых каталогов | запрет на сборку/деплой в этапе 9 |
| Подъём теневого стека | требует `up` контейнеров |
| Push bare (синхронизация) | запрет на изменение refs |
| Repin artifacts.lock | запрет; расчёт новых digest выполнен read-only |
| `docker compose logs` за длительный период | только хвосты логов |
| Проверка после cutover | будущая задача (§5.10) |
