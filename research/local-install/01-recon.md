# 01-recon — Разведка: локальная установка Animastor на Linux одной командой

Режим работы: ТОЛЬКО ЧТЕНИЕ. Ничего не менялось в src/, prod/, www/, data/, docker прод не трогался.
Единственная запись — этот отчёт + коммит в worktree work/docs-local-install-recon (ветка recon/local-install, репо animastor-docs).

Дата: 2026-10-29 (четверг)

## 0. Методология

- Все факты подтверждены чтением файлов в /home/animastor/src/*, /home/animastor/prod/ и командами grep/find.
- Секреты, пароли, токены, значения .env, IP прода НЕ выводятся и не коммитятся.
- Пометка «ПРЕДПОЛОЖЕНИЕ» использована там, где нет прямого доказательства в коде.
- Факты даются со ссылкой путь:строка. Иначе — ПРЕДПОЛОЖЕНИЕ.
- В тексте допускаются только кириллица, латиница, цифры и знаки препинания.

## 1. Компоненты (полный список сервисов прода)

Источник: /home/animastor/prod/docker-compose.yml (lines 1–133), /home/animastor/src/animastor-backend/docker-compose.yml,
/home/animastor/src/animastor-backend/ARCHITECTURE.md, /home/animastor/src/animastor-gpu-hub/DEPLOYMENT.md.

| # | Сервис | Образ / сборка | Порты | Тома / mounts | Зависимости | Версия |
|---|--------|----------------|-------|---------------|-------------|--------|
| 1 | postgres | `postgres:16` | 127.0.0.1:5432:5432 | `animastor_pg-data` (external) | — | PG 16 |
| 2 | redis | `redis:7` | (внутренняя сеть) | `animastor_redis-data` (external) | — | Redis 7 |
| 3 | backend | `ghcr.io/animastor/animastor-backend@sha256:f85470bb…` (прод) / `build: ./backend` (src compose) | 3000 (внутри сети) | /data/output, /data/books, ./backend/ai → /app/ai, ./backend/src → /app/src, ./backend/tests → /app/tests | postgres (healthy), redis (healthy) | Node 20-bookworm |
| 4 | gpu-hub | `ghcr.io/animastor/animastor-gpu-hub@sha256:3611c644…` (прод) / `build: .` (standalone) | 5000 | artifacts baked-in в образ (прод); bind mounts локально (overlay-gpu-hub-local.yml) | redis (через REDIS_URL), backend (через BACKEND_URL для колбэков) | Node >=18, Dockerfile node:20@sha256 |
| 5 | nginx | `nginx:alpine` | 80:80, 443:443 | /home/animastor/prod/nginx/default.conf, LETS_ENCRYPT_DIR, www/site, www/app, www/docs, data/downloads, secrets/.htpasswd, /var/www/acme | backend | alpine |

Дополнительно (не в compose, но часть продукта):
- **worker** — работает отдельно от compose, на GPU-машине (не в прод-компосе). Пакет `@animastor/worker-dev` v2.1.1 (репо animastor-worker, `worker/worker/worker.cjs`). Не образы, а скрипты `start-worker.sh`, `start-video.sh`.
- **web-frontend** — собранный SPA (Preact) в `www/app` (dist), отдаётся nginx статикой. Источник: `src/animastor-web/frontends/app/` (vite build → `dist/`).

Зависимости между сервисами (прод):
- backend → postgres, redis (service_healthy)
- gpu-hub → redis (REDIS_URL, дефолт `redis://animastor-redis:6379`), backend (BACKEND_URL, дефолт `http://animastor-backend:3000`) — для колбэков `/gpu/task/result`, `/gpu/task/error`
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
- Статус: фаза 1.5 реализована (manifest + resolver + plan builder + engine + CLI).

**b) Документ `architecture/LINUX_INSTALLER_RECONNAISSANCE.md`** (src/animastor-docs) — reconnaissance архитектуры Linux-инсталлятора (worker-узла) одной командой `curl … | bash`. Статус reconnaissance only, нет реализации `install.sh`.

**c) Документ `04-planning/INSTALLER_ARCHITECTURE.md`** — описание уже реализованной архитектуры `@animastor/installer` (код-аудит, не дизайн нового).

**d) IB-G тесты** — `backend/tests/architecture/installer-package-boundary.test.js`, хранители IB-G1…IB-G17. Проверяют границу пакета `@animastor/installer`. IB-G1…G17 охраняют границу пакета, проходят. (Абзац «Почему падает IB-G15» удалён — IB-G15 не падает; базовая линия: 6 failing = Stage 76 synthetic-null-recreation.)

**Документ в animastor-docs про полную локальную установку backend+web+БД одной командой — НЕ НАЙДЕН.** Есть только reconnaissance worker-установщика (`LINUX_INSTALLER_RECONNAISSANCE.md`) и документ по уже реализованному `@animastor/installer` (`INSTALLER_ARCHITECTURE.md`). Никакого `install.sh` для полной локальной установки (backend + web + PG + Redis + опционально gpu-hub) в репо нет.

## 3. Жёсткие привязки к проду

### Захардкожено (не через env):
- `https://animastor.org/gpu` — дефолт `HUB_URL` в `worker.cjs:28` и `runtime-config.js:82` (src/animastor-backend/backend/src/config/runtime-config.js). Дефолтный origin worker-а.
- `https://animastor.in/gpu` — fallback `publicHubUrl()` в `gpu-hub.js:1686` когда Host не валиден.
- `/api/v1` — относительный base URL в вебе (`src/animastor-web/frontends/app/src/api/client.ts:6`), хост берётся из браузера (hostname).
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
- `GPU_HUB_API_KEY` — shared secret backend → gpu-hub (fail-closed если unset без `GPU_HUB_ALLOW_OPEN=1`).
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `AI_MODEL`, `AI_API_BASE_URL` — AI/LLM.
- `COOKIE_DOMAIN` — scope сессионной куки.
- `HUB_URL` — URL GPU Hub (worker читает `HUB_URL` или дефолт `https://animastor.org/gpu`).
- `ANIMASTOR_WORKER_TOKEN` — credentials работника (fail-closed, без него worker не стартует).
- `WORKER_TYPE`, `WORKER_ID`, `COMFY_PORT`, `COMFY_INPUT_DIR` — настройки worker.
- `LETS_ENCRYPT_DIR` — путь к сертификатам (дефолт `/etc/letsencrypt`).
- `GPU_TIMEOUT` / `GPU_TIMEOUT_MS` — таймаут задачи hub.
- `SHARE_FEATURES_ENABLED` — kill-switch шаринга (дефолт 0).
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
| POSTGRES_PASSWORD | REQUIRED (postgres контейнер) | — | Суперпользователь PG | Да |
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
| GPU_HUB_API_KEY | OPTIONAL (dev: open, GPU_HUB_ALLOW_OPEN=1) | — | Shared secret backend → gpu-hub | Да |
| COOKIE_DOMAIN | — | animastor.org | Scope сессионной куки | Нет |
| KEEP_AUDIO_CHUNKS | OPTIONAL (research) | — | Сохранять исходные аудио-чанки | Нет |
| AUDIO_CLEANUP_TAIL_ONLY | OPTIONAL (research) | — | Tail-only очистка аудио | Нет |
| TRACK_CHUNK_DURATIONS | OPTIONAL (research) | — | Отслеживание длительностей чанков | Нет |
| SHARE_FEATURES_ENABLED | — | 0 | Kill-switch шаринга ворккеров | Нет |
| GPU_TIMEOUT / GPU_TIMEOUT_MS | — | 600000 | Таймаут задачи GPU (мс) | Нет |
| LETS_ENCRYPT_DIR | — | /etc/letsencrypt | Директория сертификатов | Нет |
| GPU_FENCING_MODE | — | observe | Режим оформления результатов GPU | Нет |
| GUEST_WORKSPACE_TTL_DAYS | — | 7 | TTL гостевого рабочего пространства | Нет |
| GUEST_WORKSPACE_GRACE_PERIOD_DAYS | — | 23 | Период льготы гостевого WS | Нет |
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
| SHARE_FEATURES_ENABLED | — | false | Kill-switch шаринга | Нет |
| ORPHAN_GRACE_MS | — | 60000 | Grace для орфанов | Нет |
| MAX_ORPHAN_REQUEUES | — | 3 | Лимит переподключений орфанов | Нет |
| WORKER_BUNDLE_DIR, WORKFLOW_DIR, INSTALLER_SRC_DIR, INSTALLER_MANIFESTS_DIR, INSTALLER_WORKFLOWS_DIR, INSTALLER_PKG_DIR | — | (frozen mounts /app/...) | Переопределение директорий артефактов | Нет |

### Секреты, которые установщик должен генерировать сам:
1. `WORKSPACE_SECRET_KEY` — 32+ случайных символов, шифрует per-workspace API-ключи.
2. `GPU_HUB_API_KEY` — shared secret backend → gpu-hub.
3. `PG_PASSWORD` (пароль роли приложения) — для локальной PG.
4. `ANIMASTOR_WORKER_TOKEN` — выдаётся при регистрации работника (backend Settings → Private Workers), не генерируется установщиком, а вводится пользователем.
5. Сессионные секреты backend — требует проверки кода (не найдено явного `SESSION_SECRET`, см. §9).

## 5. Генерация и маршрутизация задач

### 5.1 Протокол Worker → hub
- Worker опрашивает `GET /task/next?worker=<id>&type=<type>` с `Authorization: Bearer <token>` (gpu-hub.js:895).
- Регистрация: `POST /beacon` с Bearer-токеном, отчитывает `gpu`, `vram`, `version` (gpu-hub.js:698).
- Авторизация: только Bearer в заголовке `Authorization`. Fail-closed — без токена 401 (gpu-hub.js:176, PW-4).
- Токен формата `wrk.<worker_id_b64url>.<secret_b64url>`, идентичность через Redis-зеркало `animastor:worker-auth` (поддерживается backend через `worker-auth.startWorkerAuthMirrorSync`).
- Заявка возможностей: в беконе `gpu` (имя из `nvidia-smi`), `vram`, `type` (image/audio/video), `version`, `protocol_version`. Регистр в Redis `animastor:gpu-hub:workers` с TTL 900с.
- Выбор задачи: worker pops только свою очередь — private → `queue:{type}:ws:{workspace}`, share/system → `queue:{type}` (system pool). SH-1: при пустой своей очереди и активной политике шаринга — borrow из system pool или policy lane.

### 5.2 Работа с ComfyUI: задачи берутся только из hub
- **Задачи берутся только из gpu-hub** (`/task/next`). Worker не принимает задачи напрямую от пользователя и не читает их из ComfyUI (worker.cjs:259).
- **Worker сам отправляет workflow в ComfyUI**: `runWorkflow()` формирует POST-запрос на `comfyUrl("/prompt")` с телом `{ prompt: workflow, client_id: WORKER_ID }` (worker.cjs:326–337). ComfyUI отвечает `prompt_id`.
- Ожидание результата: опрос `comfyUrl("/history/<prompt_id>")` (worker.cjs:390, 400), затем чтение файлов вывода из `COMFY_OUTPUT_DIR` или HTTP-загрузка через `/view` (worker.cjs:508–518).
- Результат отправляется в hub: `POST ${HUB_URL}/task/result` с `result_base64` (worker.cjs:525–543). Hub в свою очередь колбэчит на `BACKEND_URL/gpu/task/result` (gpu-hub.js:1189).
- Вывод: локальная установка с локальным GPU требует локальный gpu-hub + Redis. Worker не может обходить hub.

### 5.3 Фильтр «задача → подходящий воркер» в hub/очереди
- Есть частично: тип работника (`worker_type`) строго сверяется с типом задачи (gpu-hub.js:909). Очереди делятся по типам audio/image/video и по workspace/policy.
- Нет фильтра по модели, по VRAM, по книге/сцене. job_type только `audio|image|video` (gpu-hub.js:59 SYSTEM_JOB_TYPES).
- Естественная точка для выбора по модели/VRAM: `GET /task/next` в gpu-hub (в момент pop) или `POST /task` в момент enqueue — сейчас тип проверяется, а модель/VRAM не учитываются.

### 5.4 Hub как ретранслятор для локального узла

**5.4a Кто может ставить задачи в hub**
- Единственный эндпоинт постановки: `POST /task` (gpu-hub.js:767). Авторизация: `requireApiKey` — заголовок `x-api-key` должен совпадать с `GPU_HUB_API_KEY` (gpu-hub.js:304–318). Если ключ не настроен, эндпоинт отвечает 503, если не `GPU_HUB_ALLOW_OPEN=1` — 401.
- `GPU_HUB_API_KEY` — общий секрет одного backend. Backend отправляет его в заголовке `x-api-key` при постановке задачи (gpu-dispatcher.js:485–486).
- Чужой узел не может ставить задачи под своим аккаунтом: нет механизма регистрации узла, нет токена на пользователя/узел для постановки. Задача привязывается к workspace/policy на стороне backend (PW-2: `workspace_id` авторитетно от backend, hub только валидирует форму, gpu-hub.js:804–820).

**5.4b Результаты: где файл лежит, как забирать**
- Worker отдаёт результат в hub: `POST /task/result` с `result_base64` (worker.cjs:525). Hub колбэчит на `BACKEND_URL/gpu/task/result` (gpu-hub.js:1189). Это **только push (колбэк)** — нет эндпоинта «забрать результат опросом (pull)».
- Backend получает `result_base64` в теле колбэка (generation-routes.cjs:424) и пишет файл в `OUTPUT_DIR/<buildId>/<filename>` через `filesystem-store.saveFile()` (filesystem-store.js:98–127).
- Хранение до выдачи: результат временно в Redis `animastor:result:<buildId>:<bookId>:<chapterId>:<sceneId>:<type>` с TTL 1 час (gpu-hub.js:1140–1146), затем в PG/файловой системе через backend. Нет отдельного TTL/очистки для готовых файлов OUTPUT_DIR (кроме cleanup-service).
- Большие mp4: результат передаётся base64 в JSON-теле колбэка. Ограничение размера тела express `50mb` (backend.cjs:331) и `500mb` на hub (gpu-hub.js:298). Докачка (range requests) не предусмотрена — весь результат приходит одним запросом. Это ограничение для видео.

**5.4c Учёт: квоты, лимиты, привязка к аккаунту**
- Квоты на активные задачи: `QUOTAS.MAX_ACTIVE_AUDIO=8, MAX_ACTIVE_IMAGE=4, MAX_ACTIVE_VIDEO=2` (runtime-config.js:149–153). Это слоты concurrency, не финансовые лимиты.
- Rate-limit: `/api/` — 500 req/мин (backend.cjs:323–328), `/auth/login` — 10/мин, `/auth/register` — 5/мин (backend.cjs:341–354).
- Привязка задач к аккаунту: `generation_tasks.workspace_id` (schema.js:242), PW-2. Нет квот по пользователю, нет тарификации, нет лимита стоимости задач.
- Для платных/больших моделей: ничего не существует (квоты, лимиты, платёжный учёт отсутствуют).

**5.4d Private Workers: существующий «обратный гибрид»**
- Private Worker регистрируется в Settings → Private Workers на облачном аккаунте, выдаётся токен `wrk.<id>.<secret>` (показан один раз).
- Worker с этим токеном пулит свой workspace-очередь `queue:{type}:ws:{workspace}` через hub (gpu-hub.js:944–958).
- Это «обратный гибрид»: домашний/удалённый GPU → облачный аккаунт. Для схемы «локальный узел → облачный hub» переиспользуется тот же механизм: локальный backend+HUB_URL указывает на облачный hub, локальный worker с токеном изSettings пулит задачи, результаты колбэком на BACKEND_URL (требует публичного URL локального backend).

### 5.5 Возможности машины
- Проверка GPU/VRAM: `getGPUInfo()` в worker.cjs:179 — `nvidia-smi --query-gpu=name,memory.total`. Отправляется в беконе.
- Список моделей с требованиями: нет в коде. Манифесты установщика (`ai/install-manifests/*`) содержат `hardware.gpu_min_vram_gb: null` (unknown, Open question 12). Reference GPU = L40S 46 GB.
- Workflow ComfyUI в репо: `backend/ai/workflows/` — 7 активных + 3 legacy. Модели: Qwen-Image (≈16 GB), LTX 2.3 (≈31 GB), Qwen3-TTS (ModelScope, on-demand).

### 5.6 Связь с AI-sharing (/ai-endpoints)
- `/api/v1/ai-endpoints` — routes/ai-endpoint-routes.cjs (SH-AI-1, LLM Sharing Phase 1 control plane). Workspace-owner lifecycle shareable inference endpoints.
- Локальный ComfyUI как endpoint — не проверено. Механизм эндпоинтов для подключения локального ComfyUI или облачных моделей — не найдено прямого переиспользования.

### 5.7 Работа без GPU
- CPU fallback: torch CPU pin в манифесте (install-manifests/video `cpu.pin: 2.6.0`, audio `cpu.pin: 2.10.0`). Установщик предупреждает: CPU-only mode для TTS/audio теста, не для image/video.
- Весь generate уходит в облако — если локальный узел без GPU, он может быть только web+backend клиентом, задачи в облачный hub. Локальный worker без GPU не имеет смысла (worker_type image|audio|video требует GPU).

## 6. Аккаунты и БД

- Регистрация/логин: да, `POST /api/v1/auth/register`, `/api/v1/auth/login`, `/api/v1/auth/me` (auth-routes.cjs). Сессия HttpOnly cookie `animastor_sid`, `Domain=COOKIE_DOMAIN`.
- Первой пользователь: создаётся через register. Админ: `requireAdmin` (admin-routes).
- Однопользовательский режим: системы не спроектирована явно, но "System designed for 1–5 concurrent users. Designed for a single user with one book" (ORCHESTRATION.md:350). Гостевые рабочие пространства (Guest Workspace MVP) — без пароля, временные.
- Миграции БД: `storage/postgres/schema.js`, функция `runMigrations()` (строка 715), вызывается `storage.postgres.initialize()` при старте backend (backend.cjs:839). SCHEMA_SQL + idempotent column additions. Запускается автоматически при старте backend.

## 7. Web локально

- Сборка: `vite build` → `frontends/app/dist/` (Preact SPA).
- API base URL: относительный `/api/v1` (client.ts:6), хост — текущего браузера. В dev vite проксирует `/api` → `localhost:3000`, `/gpu` → `localhost:5000` (vite.config.ts:18-19).
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
- Backend+web+PG+Redis локально (docker или нативно), worker локальный с GPU, gpu-hub локальный или облачный.
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
- Доказательство: `worker.cjs:228` (`fetchTimeout(`${HUB_URL}/beacon`)`), `worker.cjs:259` (`${HUB_URL}/task/next`), ComfyUI используется через `COMFY_PORT`/`COMFY_INPUT_DIR` для чтения/записи файлов вывода, не для приёма задач.

**B3. Нет механизма доставки результатов локальному backend за NAT.**
- Hub колбэчит на `BACKEND_URL/gpu/task/result` и `/gpu/task/error` (gpu-hub.js:431, 1189). Если локальный backend не имеет публичного URL — колбэк не дойдёт.
- Нет альтернативы: нет эндпоинта «забрать результат опросом (pull)», нет per-node токена на постановку задач, нет хранения результатов на hub для забора локальным узлом (см. §5.4a–b).
- Fallback: `animastor:error:{job_id}` в Redis с TTL 1ч — только буфер, не доставка.

**B4. Hardcoded дефолт origin `https://animastor.org/gpu` в worker.cjs:28 и runtime-config.js:82.**
- Для локальной установки требует переопределения через `HUB_URL` env. Некритично, но нужно учитывать.

**B5. `COOKIE_DOMAIN=animastor.org` захардкожен как дефолт.**
- Локальная установка без домена требует пустого `COOKIE_DOMAIN` (host-only cookies) или локального домена.

**B6. Образ backend доступен только как digest-pinned в prod; для локальной установки доступен нативный запуск.**
- Прод использует `ghcr.io/animastor/animastor-backend@sha256:f85470bb…` (прод compose, строка 69).
- Dockerfile backend существует в репо (`backend/Dockerfile`): `FROM node:20-bookworm`, `apt-get install ffmpeg`, `npm install --omit=dev`, `CMD ["node", "src/backend.cjs"]`. Сборка из публичного контекста, зависимости `@animastor/*` из npm (публичные). Сборку не запускали — только анализ файлов.
- Для локальной установки можно использовать нативный запуск `node src/backend.cjs` без образа. B6 перенесён в замечания, не в блокеры.

**B7. Custom nodes: 6 из 9 plain dirs без .git (LINUX_INSTALLER_RECONNAISSANCE.md §1.7).**
- Не могут быть переклонированы одной командой. Требуется `source: bundle` — бандлы нодов должны поставляться с релизом установщика.

**B8. Минимальный VRAM / требования к GPU не документированы.**
- install-manifests: `hardware.gpu_min_vram_gb: null`, Open question 12. Reference GPU = L40S 46 GB. Неизвестно, будет ли работать на 8-12 GB.

### Высокие (усложняют, но не блокируют полностью)

**B9. Backend не отдаёт веб-статику самостоятельно.**
- В прода отдаёт nginx. Локальная установка без nginx нуждается в Express static middleware или отдельном static-сервере. Не найдено в коде backend.

**B10. Migrate БД запускается автоматически при старте backend, но требует PG.**
- Для нативной установки нужно запустить PG и Redis отдельно (не в репо как готовые сервисы).

**B11. Gated модели требуют HF_TOKEN / ModelScope.**
- Установщик должен спрашивать токен интерактивно, нельзя полностью автоматизировать без участия пользователя.

**B12. Работа без GPU — только клиентская часть (web+backend), generate уходит в облако.**
- Локальный worker без GPU не имеет смысла. Если локальная установка должна генерировать локально без GPU — невозможно (требуется CUDA для ComfyUI).

### Средние

**B13. Нет единого источника моделей (источник, sha256, размер в одном месте).**
- Модели разброшаны по workflow JSON (inline), манифестам установщика (install-manifests), SYSTEM.md (prose). Нет единой модели-каталога.

**B15. kjnodes AudioVAE патч не декларативен (LINUX_INSTALLER_RECONNAISSANCE.md §2.11).**
- Живёт как проста инструкция в SYSTEM.md. Если установщик не применит патч — видео генерация ломается молча.

## 12. Открытые вопросы к владельцу (только решения владельца)

1. **Лицензии моделей:** разрешено ли автоматически скачивать Qwen-Image, LTX-2.3, Qwen3-TTS в установщике, или требуется ручное принятие лицензии пользователем?
2. **Минимальный VRAM:** каков минимальный VRAM для image (Qwen-Image ≈16 GB моделей) и video (LTX ≈31 GB)? Можно ли квантовать для 8-12 GB?
3. **Локальный gpu-hub:** нужен ли полноценный gpu-hub в локальной установке, или достаточно упрощённого dispatch-а без hub?

## 13. Факты отдельно от предположений

### Факты (подтверждены кодом/командами)

1. Прод-компози содержит: postgres:16, redis:7, backend (ghcr digest), gpu-hub (ghcr digest), nginx:alpine. — `/home/animastor/prod/docker-compose.yml`
2. `@animastor/installer` v0.1.1 существует как npm пакет, устанавливает только рабочий узел (worker + ComfyUI), не backend/веб/БД. — `packages/animastor-installer/package.json`, `cli.js`
3. Worker опрашивает hub через `/task/next` и `/beacon` с Bearer-токеном; отправляет workflow в ComfyUI через `/prompt` и забирает результат через `/history/<prompt_id>` и `/view`. — `worker.cjs`, `gpu-hub.js`
4. Web API base URL относительный `/api/v1`. — `client.ts:6`
5. Миграции БД в `schema.js`, запускаются при старте backend через `storage.postgres.initialize()`. — `backend.cjs:839`, `schema.js:715`
6. `HUB_URL` дефолт `https://animastor.org/gpu`. — `worker.cjs:28`, `runtime-config.js:82`
7. `COOKIE_DOMAIN` дефолт `animastor.org`. — `.env.example`
8. Custom nodes 6 из 9 без .git. — `LINUX_INSTALLER_RECONNAISSANCE.md §1.7`
9. Имена файлов/пути `/home/animastor/data/books|output|downloads` захардкожены в монтированиях прода. — `prod/docker-compose.yml`
10. Формат имён артефактов: `{bookId}_{chapterId}_{sceneId}.mp3|mp4|png`, чанки `{prefix}_{NNNN}.mp3`, превью `{prefix}_pr{id}.png`, группы видео `{prefix}_gN.mp4`. — `packages/animastor-generation/src/core/artifact-naming.js:37-80`
11. Файл пишет backend по колбэку от hub через `filesystem-store.saveFile()` в `OUTPUT_DIR/<buildId>/<filename>`. — `generation-routes.cjs:424`, `filesystem-store.js:98-127`
12. Результат передаётся base64 в JSON-теле колбэка `POST /gpu/task/result`; нет pull-эндпоинта. — `worker.cjs:525-543`, `generation-routes.cjs:424`
13. Сессия: токен `sid.<session_id_b64url>.<secret_b64url>`, секрет 32 байта, hash SHA-256 в PG. Нет отдельного `SESSION_SECRET` env. — `session-repo.js:15-31`
14. `POST /task` в hub защищён `x-api-key` = `GPU_HUB_API_KEY` (если настроен). — `gpu-hub.js:304-318, 767`
15. Backend отправляет `GPU_HUB_API_KEY` в заголовке `x-api-key` при постановке задачи в hub. — `gpu-dispatcher.js:485-486`

### Предположения (требуют подтверждения)

1. ПРЕДПОЛОЖЕНИЕ: для локальной установки без облачного gpu-hub нужен локальный gpu-hub + Redis (worker не может обходить hub).
2. ПРЕДПОЛОЖЕНИЕ: результаты облачных задач не доходят до локального backend за NAT без публичного URL backend.
3. ПРЕДПОЛОЖЕНИЕ: полная локальная установка одной командой (`curl | bash`) пока не реализована ни в коде, ни в планах.
4. ПРЕДПОЛОЖЕНИЕ: минимальный VRAM для локальной генерации video ≥ 16-24 GB (по reference L40S 46 GB).
5. ПРЕДПОЛОЖЕНИЕ: нативный запуск `node src/backend.cjs` возможен без docker (Dockerfile есть, зависимости из публичного npm) — сборка не проверялась.

## 14. Доказательства (репо, путь:строка)

- Сервисы прода: `/home/animastor/prod/docker-compose.yml:31-133`
- Backend env: `/home/animastor/src/animastor-backend/backend/.env.example:1-98`
- Worker env: `/home/animastor/src/animastor-worker/packages/animastor-worker/worker/.env.example:1-34`
- gpu-hub server: `/home/animastor/src/animastor-gpu-hub/server.js:1-45`
- gpu-hub routes (beacon, task, result, error, installer): `/home/animastor/src/animastor-gpu-hub/gpu-hub.js:698-1886`
- Worker polling + ComfyUI /prompt: `/home/animastor/src/animastor-worker/packages/animastor-worker/worker/worker.cjs:224-277, 326-337, 525-543`
- GPU info: `worker.cjs:179-191`
- Web API base: `/home/animastor/src/animastor-web/frontends/app/src/api/client.ts:6`
- Vite proxy: `/home/animastor/src/animastor-web/frontends/app/vite.config.ts:18-19`
- Миграции: `/home/animastor/src/animastor-backend/backend/src/storage/postgres/schema.js:715-730`
- Установщик CLI: `/home/animastor/src/animastor-backend/packages/animastor-installer/src/installer/cli.js:1-1067`
- Установщик манифесты: `/home/animastor/src/animastor-backend/packages/animastor-installer/ai/install-manifests/`
- Linux installer reconnaissance: `/home/animastor/src/animastor-docs/architecture/LINUX_INSTALLER_RECONNAISSANCE.md`
- IB-G тесты: `/home/animastor/src/animastor-backend/backend/tests/architecture/installer-package-boundary.test.js`
- Архитектура доменов: `/home/animastor/src/animastor-backend/ARCHITECTURE.md:5-63`
- Именование артефактов: `/home/animastor/src/animastor-backend/packages/animastor-generation/src/core/artifact-naming.js:37-80`
- Сессия: `/home/animastor/src/animastor-backend/backend/src/storage/postgres/repositories/session-repo.js:15-31`
- Hub callback auth: `/home/animastor/src/animastor-backend/backend/src/routes/generation-routes.cjs:51-57`
- Backend → hub x-api-key: `/home/animastor/src/animastor-backend/backend/src/runtime/gpu-dispatcher.js:485-486`
- Dockerfile backend: `/home/animastor/src/animastor-backend/backend/Dockerfile:1-13`
- Dockerfile gpu-hub: `/home/animastor/src/animastor-gpu-hub/Dockerfile:1-38`

---

Отчёт готов. Ветка `recon/local-install` в worktree `work/docs-local-install-recon`, репо `animastor-docs`. Коммит и push в origin выполнены отдельно. Не мержено в main.



