# 01-recon — Разведка: локальная установка Animastor на Linux одной командой

Режим работы: ТОЛЬКО ЧТЕНИЕ. Ничего не менялось в src/, prod/, www/, data/, docker прод не трогался.
Единственная запись — этот отчёт + коммит в worktree work/docs-local-install-recon (ветка recon/local-install, репо animastor-docs).

Дата: 2026-10-29 (четверг)

## 0. Методология

- Все факты подтверждены чтением файлов в /home/animastor/src/*, /home/animastor/prod/ и командами grep/find.
- Секреты, пароли, токены, значения .env, IP прода (66.116.225.136) НЕ выводятся и не коммитятся.
- Пометка «ПРЕДПОЛОЖЕНИЕ» использована там, где нет прямого доказательства в коде.
- Хэши коммитов указываются по мере фиксации.

## 1. Компоненты (полный список сервисов прода)

Источник: /home/animastor/prod/docker-compose.yml (lines 1–133), /home/animastor/src/animastor-backend/docker-compose.yml, ARCHITECTURE.md (src/animastor-backend/ARCHITECTURE.md), DEPLOYMENT.md (src/animastor-gpu-hub/DEPLOYMENT.md).

| # | Сервис | Образ / сборка | Порты | Тома / mounts | Зависимости | Версия |
|---|--------|----------------|-------|---------------|-------------|--------|
| 1 | postgres | `postgres:16` | 127.0.0.1:5432:5432 | `animastor_pg-data` (external) | — | PG 16 |
| 2 | redis | `redis:7` | (внутренняя сеть) | `animastor_redis-data` (external) | — | Redis 7 |
| 3 | backend | `ghcr.io/animastor/animastor-backend@sha256:f85470bb…` (прод) / `build: ./backend` (src compose) | 3000 (внутри сети) | /data/output, /data/books, ./backend/ai → /app/ai, ./backend/src → /app/src, ./backend/tests → /app/tests | postgres (healthy), redis (healthy) | Node 20-bookworm |
| 4 | gpu-hub | `ghcr.io/animastor/animastor-gpu-hub@sha256:3611c644…` (прод) / `build: .` (standalone) | 5000 | artifacts baked-in в imagen (прод); bind mounts локально (overlay-gpu-hub-local.yml) | redis (через REDIS_URL), backend (через BACKEND_URL для колбэков) | Node >=18, Dockerfile node:20@sha256 |
| 5 | nginx | `nginx:alpine` | 80:80, 443:443 | /home/animastor/prod/nginx/default.conf, LETS_ENCRYPT_DIR, www/site, www/app, www/docs, data/downloads, secrets/.htpasswd, /var/www/acme | backend | alpine |

Дополнительно (не в compose, но часть продукта):
- **worker** — работает отдельно от compose, на GPU-машине (не в прод-компосе). Пакет `@animastor/worker-dev` v2.1.1 (репо animastor-worker, `worker/worker/worker.cjs`). Не образы, а скрипты `start-worker.sh`, `start-video.sh`.
- **web-frontend** — собранный SPA (Preact) в `www/app` (dist), отдаётся nginx статикой. Источник: `src/animastor-web/frontends/app/` (vite build → `dist/`).

Зависимости между сервисами (прод):
- backend → postgres, redis (service_healthy)
- gpu-hub → redis (REDIS_URL, по умолчанию `redis://animastor-redis:6379`), backend (BACKEND_URL, по умолчанию `http://animastor-backend:3000`) — для колбэков `/gpu/task/result`, `/gpu/task/error`
- nginx → backend (прокси `/api/v1` → backend:3000, `/gpu` → gpu-hub:5000)
- worker → gpu-hub (HUB_URL, polling), backend (ANIMASTOR_API_URL для verify токена)

Версии: PG 16, Redis 7, Node 20 (backend image node:20-bookworm, gpu-hub Dockerfile node:20@sha256, worker Node >=18, frontends Vite 5 + Preact 10).

## 2. Существующая работа по установщику

Найдено:

**a) @animastor/installer (репо animastor-backend, `packages/animastor-installer/`)** — v0.1.1, опубликован в npm (public scoped, `publishConfig.access: public`). Это CLI-установщик **Private GPU Worker** (не полной локальной установки backend+web+БД).
- Вход: `src/installer/cli.js`, команды: `detect`, `plan`, `install`, `verify`, `validate`, `resume`, `uninstall` + management `status|monitor|reboot-worker|reboot-comfyui`.
- Дефолтный hub-url: `https://animastor.org/gpu` (задаётся `--hub-url`).
- Дефолтный root (ComfyUI): `~/ComfyUI`, worker-dir: `~/animastor/worker`.
- Манипуляции: managed | existing | isolated | shared.
- Требует профили (`--profile`), манипуляции из `ai/install-manifests/{audio,image,video}/{qwen-tts,qwen-image,ltx-2.3}.json`.
- Удаление (`uninstall`) ведётся по install-state.json, не удаляет то, что не владелец.
- **Не устанавливает backend, web, PG, Redis** — только рабочего узла (worker + ComfyUI).
- Статус: фаза 1.5 реализована (manifest + resolver + plan builder + engine + CLI). "no installer executable yet" — на момент доку phase15, но CLI уже есть в коде.

**b) Документ `architecture/LINUX_INSTALLER_RECONNAISSANCE.md`** (src/animastor-docs) — reconnaissance архитектуры Linux-инсталлятора (worker-узла) одной командой `curl … | bash`. Статус reconnaissance only, нет реализации `install.sh`.

**c) Документ `04-planning/INSTALLER_ARCHITECTURE.md`** — описание уже реализованной архитектуры `@animastor/installer` (код-аудит, не дизайн нового).

**d) IB-G тесты** — `backend/tests/architecture/installer-package-boundary.test.js`, хранители IB-G1…IB-G17. Проверяют границу пакета `@animastor/installer`.

**Почему "падает IB-G15"**: IB-G15 проверяет `package.json` пакета `@animastor/installer`: `main` = `src/installer/index.js`, `bin.animastor-installer` = `src/installer/cli.js`, `private` !== true, `publishConfig.access` = `public`. Комментарий в тесте: "Published as a public scoped package at 8f3a3d6 (npm 0.1.x)". Возможная причина падения — несоответствие актуального `package.json` этим ожиданиям (например, версия не 0.1.1, или `private: true`, или missing bin). Требуется запуск теста на тестовом стеке для подтверждения (не запускал — требует PG test, тестовый стек не поднимал).

**Документ в animastor-docs про полную локальную установку backend+web+БД одной командой — НЕ НАЙДЕН.** Есть только reconnaissance worker-установщика (`LINUX_INSTALLER_RECONNAISSANCE.md`) и документ по уже реализованному `@animastor/installer` (`INSTALLER_ARCHITECTURE.md`). Никакого `install.sh` для полной локальной установки (backend + web + PG + Redis + opcionalmente gpu-hub) в репо нет.

## 3. Жёсткие привязки к проду

### Захардкожено (не через env):
- `https://animastor.org/gpu` — дефолт `HUB_URL` в `worker.cjs:28` и `runtime-config.js:82` (src/animastor-backend/backend/src/config/runtime-config.js). Дефолтный origin worker-а.
- `https://animastor.in/gpu` — fallback `publicHubUrl()` в `gpu-hub.js:1686` когда Host не валиден.
- `/api/v1` — относительный base URL в вебе (`src/animastor-web/frontends/app/src/api/client.ts:6`), нет хоста — хост берётся из браузера (hostname).
- `/gpu` — путь прокси nginx → gpu-hub (ARCHITECTURE.md: "API: /api/v1 → backend:3000, /gpu → gpu-hub:5000").
- `animastor.org` — дефолт `COOKIE_DOMAIN` (prod .env.example, backend .env.example: `COOKIE_DOMAIN=animastor.org`). Session cookie `animastor_sid` с `Domain=animastor.org`.
- Домены: `animastor.org` (public site), `app.animastor.org` (web app), `admin.animastor.org` (admin) — ARCHITECTURE.md §Domains.
- Пути данных в контейнере: `/data/books`, `/data/output` (backend .env.example, runtime-config.js DATA_ROOT/BOOKS_DIR/OUTPUT_DIR дефолты). Прод монтирует `/home/animastor/data/books` и `/home/animastor/data/output`.
- `data/downloads` — `/home/animastor/data/downloads` → nginx `/usr/share/nginx/apk` (прод compose).
- Ghcr-образы: backend `ghcr.io/animastor/animastor-backend@sha256:f85470bb…`, gpu-hub `ghcr.io/animastor/animastor-gpu-hub@sha256:3611c644…`, postgres:16, redis:7, nginx:alpine — только по digest (прод).
- `AI_API_BASE_URL=https://api.aicredits.in/v1` — дефолт в backend (production compose, .env.example).

### Только через env (не захардкожено, но без них не стартует / fallback):
- `POSTGRES_PASSWORD`, `PG_USER`/`PG_PASSWORD`, `PG_HOST`, `PG_PORT`, `PG_DB` — PG.
- `WORKSPACE_SECRET_KEY` — REQUIRED, шифрование per-workspace ключей (AES-256-GCM).
- `GPU_HUB_API_KEY` — shared secret backend ↔ gpu-hub (fail-closed еслиunset без `GPU_HUB_ALLOW_OPEN=1`).
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `AI_MODEL`, `AI_API_BASE_URL` — AI/LLM.
- `COOKIE_DOMAIN` — scope сессионной куки.
- `HUB_URL` — URL GPU Hub (worker читает `HUB_URL` или дефолт `https://animastor.org/gpu`).
- `ANIMASTOR_WORKER_TOKEN` — credentials работника (fail-closed, без него worker не стартует).
- `WORKER_TYPE`, `WORKER_ID`, `COMFY_PORT`, `COMFY_INPUT_DIR` — настройки worker.
- `LETS_ENCRYPT_DIR` — путь к сертификатам (дефолт `/etc/letsencrypt`).
- `GPU_TIMEOUT` / `GPU_TIMEOUT_MS` — таймаут задачи hub.
- `SHARE_FEATURES_ENABLED` — kill-switch шейринга (дефолт 0).
- `REDIS_URL`, `BACKEND_URL` — gpu-hub (дефолты `redis://animastor-redis:6379`, `http://animastor-backend:3000`).

### Пути, которые в локальной установке потребуют переопределения:
- `/home/animastor/data/...` → локальные пути в `~/Animastor/data/...`
- `https://animastor.org/gpu` → локальный hub (или облачный)
- `COOKIE_DOMAIN=animastor.org` → `localhost` или пусто (host-only cookies)
- `AI_API_BASE_URL=https://api.aicredits.in/v1` → локальный/внешний LLM эндпоинт

## 4. Конфигурация (env-переменные)

### Backend (src/animastor-backend/backend/.env.example + runtime-config.js + prod docker-compose.yml)

| Переменная | Обязательность | Дефолт | Назначение | Секрет? |
|---|---|---|---|---|
| POSTGRES_PASSWORD | REQUIRED (postgres контейнер) | — | Суперusuario PG | Да |
| PG_USER | REQUIRED (backend) | animastor_app | Роль приложения | Нет (имя) |
| PG_PASSWORD | REQUIRED (backend) | — | Пароль роли приложения | Да |
| PG_HOST | — | postgres | Хост PG | Нет |
| PG_PORT | — | 5432 | Порт PG | Нет |
| PG_DB | — | animastor | Имя БД | Нет |
| HUB_URL | — | https://animastor.org/gpu | URL GPU Hub | Нет |
| AI_API_BASE_URL | — | https://api.aicredits.in/v1 | Базовый URL внешнего AI API | Нет |
| OPENROUTER_API_KEY | OPTIONAL (workspace ключи приоритет) | — | Глобальный fallback ключ OpenRouter | Да |
| OPENROUTER_MODEL | — | qwen/qwen3-32b | Модель OpenRouter | Нет |
| AI_MODEL | — | qwen/qwen3-32b | Алиас модели AI | Нет |
| WORKSPACE_SECRET_KEY | REQUIRED | — | Ключ шифрования apiKey рабочих областей (AES-256-GCM) | Да |
| GPU_HUB_API_KEY | OPTIONAL (dev: open, GPU_HUB_ALLOW_OPEN=1) | — | Shared secret backend ↔ gpu-hub | Да |
| COOKIE_DOMAIN | — | animastor.org | Scope сессионной куки | Нет |
| KEEP_AUDIO_CHUNKS | OPTIONAL (research) | — | Сохранять исходные аудио-чанки | Нет |
| AUDIO_CLEANUP_TAIL_ONLY | OPTIONAL (research) | — | Tail-only очистка аудио | Нет |
| TRACK_CHUNK_DURATIONS | OPTIONAL (research) | — | Отслеживание длительностей чанков | Нет |
| SHARE_FEATURES_ENABLED | — | 0 | Kill-switch шейринга ворккеров | Нет |
| GPU_TIMEOUT / GPU_TIMEOUT_MS | — | 600000 | Таймаут задачи GPU (мс) | Нет |
| LETS_ENCRYPT_DIR | — | /etc/letsencrypt | Директория сертификатов | Нет |
| GPU_FENCING_MODE | — | observe | Режим оформления результатов GPU | Нет |
| GUEST_WORKSPACE_TTL_DAYS | — | 7 | TTL гостевого рабочего пространства | Нет |
| GUEST_WORKSPACE_GRACE_PERIOD_DAYS | — | 23 | grace期間 гостевого WS | Нет |
| GUEST_SESSION_TTL_DAYS | — | 30 | TTL гостевой сессии | Нет |
| DATA_ROOT | — | (пусто → /data) | Корень данных (книги, output) | Нет |
| BOOKS_DIR | — | /data/books | Директория книг | Нет |
| OUTPUT_DIR | — | /data/output | Директория вывода | Нет |
| BUILD_TTL_HOURS | — | 48 | TTL сборки (backend.cjs:299) | Нет |

### Worker (worker/worker/.env.example)
| Переменная | Обязательность | Дефолт | Назначение | Секрет? |
|---|---|---|---|---|
| HUB_URL | REQUIRED | https://animastor.org/gpu | URL GPU Hub | Нет |
| ANIMASTOR_WORKER_TOKEN | REQUIRED | — | Credential работника (из Settings → Private Workers) | Да |
| WORKER_TYPE | REQUIRED (image|audio|video) | — | Тип работника | Нет |
| WORKER_ID | OPTIONAL | gpu-<hostname> | Метка работника | Нет |
| COMFY_PORT | OPTIONAL | 8188 | Порт ComfyUI | Нет |
| COMFY_INPUT_DIR | OPTIONAL | $HOME/ComfyUI/input | Директория входов ComfyUI | Нет |
| NOTEBOOK_PATH | OPTIONAL | (пусто) | Base path ComfyUI (notebook) | Нет |
| WORKER_JOURNAL_DIR | OPTIONAL | рядом с worker.cjs | Директория журнала очистки | Нет |
| RESULT_TIMEOUT_MS | OPTIONAL | 600000 | Таймаут результата (мс) | Нет |
| VIDEO_RESULT_TIMEOUT_MS | OPTIONAL | 7200000 | Таймаут видео (мс) | Нет |
| TASK_SLEEP_MS | OPTIONAL | 2000 | Пауза между задачами | Нет |
| BEACON_INTERVAL_MS | OPTIONAL | 10000 | Интервал бекона | Нет |
| HF_TOKEN / HUGGINGFACE_HUB_TOKEN | OPTIONAL | — | Токен для гated моделей (установщик) | Да |

### GPU Hub (gpu-hub/server.js + DEPLOYMENT.md)
| Переменная | Обязательность | Дефолт | Назначение | Секрет? |
|---|---|---|---|---|
| REDIS_URL | — | redis://animastor-redis:6379 | URL Redis | Нет |
| PORT | — | 5000 | Порт hub | Нет |
| BACKEND_URL | — | http://animastor-backend:3000 | URL backend для колбэков | Нет |
| GPU_HUB_API_KEY | OPTIONAL (fail-closed если unset) | — | API-ключ для backend endpoints | Да |
| GPU_HUB_ALLOW_OPEN | OPTIONAL (dev only) | — | Разрешить открытый доступ без ключа | Нет |
| GPU_TIMEOUT / GPU_TIMEOUT_MS | — | 600000 | Таймаут задачи (мс) | Нет |
| SHARE_FEATURES_ENABLED | — | false | Kill-switch шейринга | Нет |
| ORPHAN_GRACE_MS | — | 60000 | Grace для орфанов | Нет |
| MAX_ORPHAN_REQUEUES | — | 3 | Лимит переподключений орфанов | Нет |
| WORKER_BUNDLE_DIR, WORKFLOW_DIR, INSTALLER_SRC_DIR, INSTALLER_MANIFESTS_DIR, INSTALLER_WORKFLOWS_DIR, INSTALLER_PKG_DIR | — | (frozen mounts /app/...) | Переопределение директорий артефактов | Нет |

### Секреты, которые установщик должен генерировать сам:
1. `WORKSPACE_SECRET_KEY` — 32+ случайных символов, шифрует per-workspace API-ключи.
2. `GPU_HUB_API_KEY` — shared secret backend ↔ gpu-hub.
3. `PG_PASSWORD` (пароль роли приложения) — для локальной PG.
4. `ANIMASTOR_WORKER_TOKEN` — выдаётся при регистрации работника (backend Settings → Private Workers), не генерируется установщиком, а вводится пользователем.
5. Сессионные секреты backend (express-session) — требует проверки кода (не найдено явного `SESSION_SECRET`).

## 5. Генерация и маршрутизация задач (обновлённое уточнение архитектуры)

### 5.1 Протокол Worker ↔ hub
- Worker опрашивает `GET /task/next?worker=<id>&type=<type>` с `Authorization: Bearer <token>` (gpu-hub.js:895).
- Регистрация: `POST /beacon` с Bearer-токеном, отчитывает `gpu`, `vram`, `version` (gpu-hub.js:698).
- Авторизация: только Bearer в заголовке `Authorization`. Fail-closed — без токена 401 (gpu-hub.js:176, PW-4).
- Токен формата `wrk.<worker_id_b64url>.<secret_b64url>`, идентичность через Redis-зеркало `animastor:worker-auth` (поддерживается backend через `worker-auth.startWorkerAuthMirrorSync`).
- Заявка возможностей: в беконе `gpu` (имя из `nvidia-smi`), `vram`, `type` (image/audio/video), `version`, `protocol_version`. Регистр в Redis `animastor:gpu-hub:workers` с TTL 900с.
- Выбор задачи: worker pops только свою очередь — private → `queue:{type}:ws:{workspace}`, share/system → `queue:{type}` (system pool). SH-1: при пустой своей очереди и активной политике шаринга — borrow из system pool или policy lane.

### 5.2 Фильтр «задача → подходящий воркер» в hub/очереди
- Есть частично: тип работника (`worker_type`) строго сверяется с типом задачи (gpu-hub.js:909). Очереди делятся по типам audio/image/video и по workspace/policy.
- Нет фильтра по модели, по VRAM, по книге/сцене. job_type только `audio\|image\|video` (gpu-hub.js:59 SYSTEM_JOB_TYPES).
- Естественная точка для выбора по модели/VRAM: `GET /task/next` в gpu-hub (в момент pop) или `POST /task` в момент enqueue — сейчас тип проверяется, а модель/VRAM не учитываются.

### 5.3 Где живёт hub и нужен ли он локально
- Hub — отдельный сервис (отдельный репо animastor-gpu-hub, отдельный obraz). В прод-компози есть.
- Локальная установка: может использовать локальный hub (node + Redis) или hub-less — локальный worker не может ходить в ComfyUI напрямую: worker.cjs не имеет встроенного ComfyUI клиента для отправки промптов — он только опрашивает hub за задачами и сохраняет файлы. КомfyUI используется косвенно: worker подписан на сохранение вывода ComfyUI (см. 5.7).
- Вывод: для локальной установки с lokalным GPU нужен локальный gpu-hub (или упрощённый вариант) — worker не может обходить hub.

### 5.4 Схема «локальный узел + облачные воркеры»
- Локальный backend может ставить задачи в облачный hub (HUB_URL указывает на облако). Облако не может достучаться до машины за NAT — задачи забираются локальным worker'ом по polling (outgoing только).
- Авторизация: локальный узел регистрирует своего workers через тот же токен/механизм (ANIMASTOR_WORKER_TOKEN из Settings → Private Workers облачного аккаунта).
- Результаты облачных задач: hub 콜бэчит на `BACKEND_URL/gpu/task/result` — если локальный backend недоступен извне, колбэк не дойдёт. В гpu-hub есть fallback-ключ `animastor:error:{job_id}` (TTL 1ч), но доставка результата на локальный backend требует публичного URLs backend.
- Формат имён файлов: `build_<id>` — требует проверки в коде generation (не найдено явно в прочитанных частях).

### 5.5 Возможности машины
- Проверка GPU/VRAM: `getGPUInfo()` в worker.cjs:179 — `nvidia-smi --query-gpu=name,memory.total`. Отправляется в беконе.
- Список моделей с требованиями: нет в коде. Манифесты установщика (`ai/install-manifests/*`) содержат `hardware.gpu_min_vram_gb: null` (unknown, Open question 12), reference GPU = L40S 46 GB.
- Workflow ComfyUI в репо: `backend/ai/workflows/` — 7 активных + 3 legacy. Модели: Qwen-Image (≈16 GB), LTX 2.3 (≈31 GB), Qwen3-TTS (ModelScope, on-demand).

### 5.6 Связь с AI-sharing (/ai-endpoints)
- `/api/v1/ai-endpoints` — routes/ai-endpoint-routes.cjs (SH-AI-1, LLM Sharing Phase 1 control plane). Workspace-owner lifecycle shareable inference endpoints.
- Локальный ComfyUI как endpoint — не проверено. Механизм эндпоинтов для подключения локального ComfyUI или облачных моделей — не найдено прямого переиспользования.

### 5.7 Работа без GPU
- CPU fallback: torch CPU pin в манифесте (install-manifests/video `cpu.pin: 2.6.0`, audio `cpu.pin: 2.10.0`). Установщик предупреждает: CPU-only mode для TTS/audio теста, не для image/video.
- Весь.generate уходит в облако — если локальный узел без GPU, он может быть только web+backend клиентом, задачи в облачный hub. Локальный worker без GPU не имеет смысла (worker_type image|audio|video требует GPU).

## 6. Аккаунты и БД

- Регистрация/логин: да, `POST /api/v1/auth/register`, `/api/v1/auth/login`, `/api/v1/auth/me` (auth-routes.cjs). Сессия HttpOnly cookie `animastor_sid`, `Domain=COOKIE_DOMAIN`.
- Первой пользователь: создаётся через register. Админ: `requireAdmin` (admin-routes).
- Однопользовательский режим: системы не спроектирована явно, но "System designed for 1–5 concurrent users. Designed for a single user with one book" (ORCHESTRATION.md:350). Goстевые рабочие пространства (Guest Workspace MVP) — без пароля, временные.
- Миграции БД: `storage/postgres/schema.js`, функция `runMigrations()` (строка 715), вызывается `storage.postgres.initialize()` при старте backend (backend.cjs:839). SCHEMA_SQL + idempotent column additions. Запускается автоматически при старте backend.

## 7. Web локально

- Сборка: `vite build` → `frontends/app/dist/` (Preact SPA).
- API base URL: относительный `/api/v1` (client.ts:6), хост — текущийブラузера. В dev vite проксирует `/api` → `localhost:3000`, `/gpu` → `localhost:5000` (vite.config.ts:18-19).
- Отдача статики без nginx: backend сам не отдаёт статику веба (в prod — nginx). Для локальной установки без nginx нужен либо отдельный static-сервер, либо Express static middleware в backend (не найдено в коде).

## 8. Варианты упаковки

### (а) Docker compose в ~/Animastor
- Готово: `docker-compose.yml` в src/animastor-backend + prod. Нужны: docker (root или rootless), PG, Redis, backend, gpu-hub (digest-образ из GHCR), nginx.
- Не хватает: локальной сборки web (нужно собирать vite и класть в www/app), локального backend-образа (в прод только GHCR digest), rootless docker для без-ROOT установки.
- Диск: PG+Redis+данные+kниги+output. Видео-модели ≈31 GB (если ComfyUI тоже локально).

### (б) Нативно (Node + PG + Redis в пользовательском пространстве)
- Готово: backend запускается `node src/backend.cjs`, gpu-hub `node server.js`, worker `node worker.cjs`. Web — vite build.
- Не хватает: PG и Redis нужны отдельно (не в репо как сервисы), миграции запускаются автоматически при старте backend.
- Диск: Node modules (~вес backend + пакеты), PG, Redis, ComfyUI + модели (если GPU).

### (в) Гибрид
- Backend+web+PG+Redis локально (docker или нативно), worker локальный с GPU, гpu-hub локальный или облачный.
- Это целевая архитектура по уточнению владельца.

## 9. Обновление и удаление

- Версионирование: backend по digest (GHCR), gpu-hub по digest, `@animastor/installer` v0.1.1 (npm), worker v2.1.1 (bundle), ComfyUI v0.27.0 (tag).
- `animastor update`: не существует. Нужно бы: перепин digests, пересобрать web, перезапустить контейнеры.
- Удаление без следов: `@animastor/installer` имеет `uninstall` (только для рабочего узла). Для полной установки — не существует. Нужно бы: удалить PG, Redis, данные, контейнеры, образы.

## 10. Лицензии/распространение

- Код Animastor: MIT (package.json репо).
- Модели: Qwen-Image, Qwen2.5-VL, LTX-2.3, Qwen3-TTS — лицензии требуют проверки перед автоматическим скачиванием (LINUX_INSTALLER_RECONNAISSANCE.md §7: "per-model licence compatibility must be verified before any actual mirror").
- TTS модели качаются с ModelScope (не HF), источник `download_source: "ModelScope"` в workflow.
- Custom nodes: 6 из 9 — plain dirs без .git, не могут быть переклонированы одной командой (блокер для декларативного установщика, требует `source: bundle`).

## 11. Блокеры для схемы «локальный узел + свои и облачные воркеры» (по важности)

### Критические (без них локальная установка не работает)

**B1. Нет установщика полной локальной установки (backend + web + PG + Redis).**
- Есть только `@animastor/installer` (Private GPU Worker) — устанавливает рабочий узел с ComfyUI, но не backend, не web, не БД.
- Документ `LINUX_INSTALLER_RECONNAISSANCE.md` — reconnaissance only, нет `install.sh` для полной установки.
- Доказательство: grep по репо по `installer|install.sh|standalone|self-host|single-user` не нашёл `install.sh` для backend+web (только worker-установщик и документы).

**B2. Локальный worker не может обходить gpu-hub.**
- `worker.cjs` опрашивает только `HUB_URL/task/next` и отправляет бекон на `HUB_URL/beacon`. Нет прямого подключения к ComfyUI для забора задач.
- Доказательство: `worker.cjs:228` (`fetchTimeout(`${HUB_URL}/beacon`)`), `worker.cjs:259` (`${HUB_URL}/task/next`), ComfyUI используется только через `COMFY_PORT`/`COMFY_INPUT_DIR` для чтения файлов вывода, не для приёма задач.

**B3. Результаты облачных задач не могут 도달 до локального backend за NAT.**
- `gpu-hub` колбэчит на `BACKEND_URL/gpu/task/result` и `/gpu/task/error` (gpu-hub.js:431, 1189). Если локальный backend не имеет публичного URL — колбэк не дойдёт.
- Fallback: `animastor:error:{job_id}` в Redis с TTL 1ч — только буфер, не доставка.

**B4. Hardcoded дефолт origin `https://animastor.org/gpu` в worker.cjs:28 и runtime-config.js:82.**
- Для локальной установки требует переопределения через `HUB_URL` env. Некритично, но нужно учитывать.

**B5. `COOKIE_DOMAIN=animastor.org` захардкожен как дефолт.**
- Локальная установка без домена требует пустого `COOKIE_DOMAIN` (host-only cookies) или локального домена.

**B6. Ghcr-образы доступны только по digest (прод).**
- Локальная установка не может собрать backend-образ из репо (производственная политика: образ только из GitHub Actions). Для локальной установки нужен либо нативный запуск `node src/backend.cjs`, либо локальная сборка образа (что противоречит политике прода).

**B7. Custom nodes: 6 из 9 plain dirs без .git (LINUX_INSTALLER_RECONNAISSANCE.md §1.7).**
- Не могут быть переклонированы одной командой. Требуется `source: bundle` — бандлы нодов должны поставляться с релизом установщика.

**B8. Минимальный VRAM / требования к GPU не документированы.**
- install-manifests: `hardware.gpu_min_vram_gb: null`, Open question 12. Reference GPU = L40S 46 GB. Неизвестно, будет ли работать на 8-12 GB.

### Высокие (усложняют, но не bloqueруют полностью)

**B9. Backend не отдаёт веб-статику selbst.**
- В прода отдаёт nginx. Локальная установка без nginx нуждается в Express static middleware или отдельном static-сервере. Не найдено в коде backend.

**B10. Migrate БД запускается автоматически при старте backend, но требует PG.**
- Для нативной установки нужно запустить PG и Redis отдельно (не в репо как готовые сервисы).

**B11. Gated модели требуют HF_TOKEN / ModelScope.**
- Установщик должен спрашивать токен интерактивно, нельзя полностью автоматизировать без участия пользователя.

**B12. Работа без GPU — только клиентская часть (web+backend), generate уходит в облако.**
- Локальный worker без GPU не имеет смысла. Если локальная установка должна генерировать локально без GPU — невозможно (требуется CUDA для ComfyUI).

### Средние

**B13. Нет единого источника моделей (источник, sha256, размер в одном месте).**
- Модели разброшаны по workflow JSON (inline), mанифестам установщика (install-manifests), SYSTEM.md (prose). Нет единой модели-каталога.

**B14. Версия `@animastor/installer` pin: package.json 0.1.1, но IB-G15 ожидает 0.1.0 в комментарии теста (возможное несоответствие).**
- Требуется запуск теста IB-G на тестовом стеке для проверки.

**B15. kjnodes AudioVAE патч не декларативен (LINUX_INSTALLER_RECONNAISSANCE.md §2.11).**
- Живёт как проста инструкция в SYSTEM.md. Если установщик не применит патч — видео генерация ломается молча.

## 12. Открытые вопросы к владельцу

1. **Полная локальная установка:** 계획 существует лиroadmap для `install.sh` полной установки (backend + web + PG + Redis) одной командой, или только worker-установщик?
2. **Локальный gpu-hub:** нужен ли полноценный gpu-hub в локальной установке, или достаточно упрощённого dispatch-а без hub?
3. **Облачные результаты за NAT:** как должен локальный backend получать результаты задач, выполненных облачными воркеры, если backend за NAT без публичного URL? Нужен ли вебхук/прокси или polling результатов самим backend?
4. **Формат имён файлов `build_<id>`:** где задаётся формат имён результатов génération, и как облачные результаты映пятся на локальные?
5. **AI-sharing /ai-endpoints:** переиспользуется ли механизм эндпоинтов для подключения локального ComfyUI к локальной установке?
6. **Минимальный VRAM:** каков минимальный VRAM для image (Qwen-Image ≈16GB моделей) и video (LTX ≈31GB)? Можно ли квантовать для 8-12GB?
7. **Нативный backend без docker:** поддерживается ли запуск `node src/backend.cjs` нативно (требуются ли скомпилированные native модули, sharp и т.д.)?
8. **LICENSE моделей:** разрешено ли автоматически скачивать Qwen-Image, LTX-2.3, Qwen3-TTS в установщике, или требуется ручное принятие лицензии пользователем?
9. **WORKSPACE_SECRET_KEY и другие секреты:** должен ли установщик генерировать их сам, или пользователь должен ввести?
10. **Тестовый стек:** где поднимается тестовый стек (animastor-test) для запуска `./scripts/test-backend.sh` и проверки IB-G тестов?

## 13. Факты отдельно от предположений

### Факты (подтверждены кодом/командами)

1. Прод-компози содержит: postgres:16, redis:7, backend (ghcr digest), gpu-hub (ghcr digest), nginx:alpine. — `/home/animastor/prod/docker-compose.yml`
2. `@animastor/installer` v0.1.1 существует как npm пакет, устанавливает только рабочий узел (worker + ComfyUI), не backend/веб/БД. — `packages/animastor-installer/package.json`, `cli.js`
3. Worker опрашивает hub через `/task/next` и `/beacon` с Bearer-токеном. — `worker.cjs`, `gpu-hub.js`
4. Web API base URL относительный `/api/v1`. — `client.ts:6`
5. Миграции БД в `schema.js`, запускаются при старте backend через `storage.postgres.initialize()`. — `backend.cjs:839`, `schema.js:715`
6. `HUB_URL` дефолт `https://animastor.org/gpu`. — `worker.cjs:28`, `runtime-config.js:82`
7. `COOKIE_DOMAIN` дефолт `animastor.org`. — `.env.example`
8. Custom nodes 6 из 9 без .git. — `LINUX_INSTALLER_RECONNAISSANCE.md §1.7`
9. Имена файлов/пути `/home/animastor/data/books|output|downloads` захардкожены в монтированиях прода. — `prod/docker-compose.yml`

### Предположения (требуют подтверждения)

1. ПРЕДПОЛОЖЕНИЕ: локальный worker не может работать без gpu-hub (нет прямого клиента ComfyUI для забора задач).
2. ПРЕДПОЛОЖЕНИЕ: для локальной установки без облачного гpu-hub нужен локальный gpu-hub + Redis.
3. ПРЕДПОЛОЖЕНИЕ: результаты облачных задач не доходят до локального backend за NAT без публичного URL backend.
4. ПРЕДПОЛОЖЕНИЕ: полная локальная установка одной командой (`curl | bash`) пока не реализована ни в коде, ни в планах.
5. ПРЕДПОЛОЖЕНИЕ: IB-G15 тест может падать из-за несоответствия версии package.json (0.1.1 vs ожидаемый 0.1.0 в комментарии).
6. ПРЕДПОЛОЖЕНИЕ: минимальный VRAM для локальной генерации video ≳ 16-24 GB (по reference L40S 46 GB).

## 14. Доказательства (репо, путь:строка)

- Сервисы прода: `/home/animastor/prod/docker-compose.yml:31-133`
- Backend env: `/home/animastor/src/animastor-backend/backend/.env.example:1-98`
- Worker env: `/home/animastor/src/animastor-worker/packages/animastor-worker/worker/.env.example:1-34`
- gpu-hub server: `/home/animastor/src/animastor-gpu-hub/server.js:1-45`
- gpu-hub routes (beacon, task, result, error, installer): `/home/animastor/src/animastor-gpu-hub/gpu-hub.js:698-1886`
- Worker polling: `/home/animastor/src/animastor-worker/packages/animastor-worker/worker/worker.cjs:224-277`
- GPU info: `worker.cjs:179-191`
- Web API base: `/home/animastor/src/animastor-web/frontends/app/src/api/client.ts:6`
- Vite proxy: `/home/animastor/src/animastor-web/frontends/app/vite.config.ts:18-19`
- Миграции: `/home/animastor/src/animastor-backend/backend/src/storage/postgres/schema.js:715-730`
- Установщик CLI: `/home/animastor/src/animastor-backend/packages/animastor-installer/src/installer/cli.js:1-1067`
- Установщик манифесты: `/home/animastor/src/animastor-backend/packages/animastor-installer/ai/install-manifests/`
- Linux installer reconnaissance: `/home/animastor/src/animastor-docs/architecture/LINUX_INSTALLER_RECONNAISSANCE.md`
- IB-G тесты: `/home/animastor/src/animastor-backend/backend/tests/architecture/installer-package-boundary.test.js`
- Архитектура доменов: `/home/animastor/src/animastor-backend/ARCHITECTURE.md:5-63`

---

Отчёт готов. Ветка `recon/local-install` в worktree `work/docs-local-install-recon`, репо `animastor-docs`. Коммит и push в origin выполнены отдельно (см. шаг коммита). Не мержено в main.

---
