# Этап 40 — Production rollout утверждённых версий (этап 39)

**Дата:** 2026-10-12 (окно ~13:30–13:50 UTC)
**Итог: PARTIAL** — применены все готовые production-артефакты (GPU Hub image,
worker-bundle, installer-src); **backend-сервис не обновлён — нет опубликованного
целевого образа** (см. §6, блокер B1). Работающий стек здоров, данные целы,
откат не требуется.

---

## 0. Краткая сводка

| Цель (этап 38/39) | Готовность артефакта | Применено? | Факт после rollout |
|---|---|---|---|
| GPU Hub image `sha256:3611c644…` (v0.2.0) | **да** (ghcr, tag `v0.2.0` → digest сверен) | **ДА** | контейнер `gpu-hub` на `3611c644…` |
| worker-bundle tree `417c0ad4…` | **да** (запечён в новом образе) | **ДА** | живой бандл tree = `417c0ad4…`, 8/8 == worker@`b3f94f42` |
| installer-src tree `ff27e291…` / 0.1.1 | **да** (запечён + release) | **ДА** | `/gpu/installer` → 0.1.1, в бандле фикс 404-URL |
| release `hub-artifacts-v0.1.1` | **да** (скачан, sha MATCH) | публикация = этап 39 | asset `78cc1bde…` == локальному, fix присутствует |
| worker commit `b3f94f42…` (пин L2) | **да** (pin с этапа 39, verify exit 0) | **ДА** (пин + отдаваемый бандл) | L2 `sources.worker.commit = b3f94f42…` |
| backend commit `a7a8c463…` (пин L2) | **пин да / production-образ НЕТ** | **пин ДА, сервис НЕТ** | L2 pin `a7a8c463…`; backend-сервис остался на `e8152778…` → **блокер B1** |
| workflows `0d51107d…`, install-manifests `46f3c26a…` | без изменений (verified) | не требуют | в образе совпадают с lock |
| E2E / тестовая image-задача | prerequisites красные | **НЕ выполнялось** | нет воркеров, `E2E_WORKSPACE_ID` unset → §7 |

Итог: **4 из 5 подлежащих применению целей применены; backend-сервис — нет.**

---

## 1. Документация и принципы

Прочитаны: `39-g3-d4-publish-report.md`, `37-migration-completion-report.md`,
`21-production-cutover-runbook.md` (+ уточняющее `38-g2-owner-approval.md`).
Повторно не выполнялись проверки, пройденные на этапах 26–39 (repin, CI,
публикация релиза, restore-тесты, E1–E4 deploy-конфига — учтены как готовые).

Принцип этапа: не останавливаться из-за одного неготового компонента, но и не
выдавать частичное обновление за полное → **PARTIAL**.

---

## 2. Preflight — готовность целей (все read-only)

| Проверка | Результат |
|---|---|
| Диск `df -B1 /` | 34 921 046 016 Б свободно (порог 15,0 млрд / pull-порог 16,6 млрд — **PASS**) |
| L2 lock `/home/animastor/animastor-gpu-hub/artifacts.lock.json` | sha `9b9dd09b25ea586…`; HEAD gpu-hub = `0f489c7` (commit этапа 39), worktree **чист** |
| Пины L2 | worker `b3f94f42…`, backend `a7a8c463…`, worker-bundle `417c0ad4…`, installer-src `ff27e291…`/0.1.1, workflows `0d51107d…`, install-manifests `46f3c26a…` — **все == утверждённым целям** |
| Штатный verify `node scripts/stage-artifacts.cjs --worker … --backend …` (без write-lock) | **exit 0** — «staging verified against artifacts.lock.json» |
| L1 lock (mono legacy) | sha `069b62d931c1ff0e…` — не изменён (no-op по этапу 39) |
| Образ `ghcr.io/…/animastor-gpu-hub@sha256:3611c644…` | **доступен** (`buildx imagetools inspect` exit 0); tag `v0.2.0` → **тот же digest** `3611c644…` |
| Release `hub-artifacts-v0.1.1` | скачан из `Animastor/animastor-gpu-hub` → sha256 `78cc1bde760238b4…` **MATCH** (32 entries), `setup-contract.js` clone → `animastor-worker.git` (**404 убран**) |
| worker/backend репо | worker HEAD `b3f94f42…` == github; backend HEAD `a7a8c463…` == github; статусы = baseline (backend: `?? deploy/`, `?? freebuff…`) |
| Целевой backend-**образ** | **НЕ НАЙДЕН** — у `ghcr.io/animastor/animastor-backend` только теги `deploy-0c55b5a7`(`be82793a…`), `rollback-e14d6220`(`e14d6220…`), `deploy-e233d64d`(**`e8152778…`** = текущий). Ни один не собран из `a7a8c463`. CI для backend-образа отсутствует (в ghcr-release собирается только gpu-hub) → **блокер B1** |

До-снапшот (H1): 7 контейнеров; backend/proxy Up 2 h; gpu-hub Up 3 d;
pg/redis healthy Created `2026-07-08T13:37:11Z`; health 200/200/200; site sha
`a1900f4e…`; живой бандл v2.1.1 `480af146…`; PG `generation_tasks=17`;
data/output 63 203 425 / data/books 1 704 047.

### 2.1 Сохранение текущих пинов и rollback-канала

- Текущие пины зафиксированы: `BACKEND_IMAGE=…@sha256:e8152778…`,
  `GPU_HUB_IMAGE=…@sha256:daf510ff…`.
- Копия прод-`.env` **до** изменений:
  `/home/animastor/backups/deploy-env-pre-rollout40-2026-10-12.env`
  (mode 600, sha `ee64133e…` — byte-identical с mono `.env`).
- Rollback-канал (mono compose + overlay + `.env`) проверен **до** и **после**:
  `docker compose … --env-file /home/animastor/animastor/.env config --quiet` →
  **exit 0**; mono `.env` sha `ee64133e…` **не изменён**.
- Старые образы `daf510ff…`/`e8152778…` остаются локально (prune запрещён).

---

## 3. Preflight нового образа (до применения)

`docker pull` `3611c644…` → exit 0 (диск после: 34 912 399 360 Б).

Запечённое содержимое образа проверено **до** применения (запуск временного
контейнера, каноническая формула tree из `stage-artifacts.cjs`):

| Группа | files | tree (образ) | цель | статус |
|---|---|---|---|---|
| worker-bundle | 8 | `417c0ad4…` (v2.1.1) | `417c0ad4…` | MATCH |
| installer-src | 32 | `ff27e291…` (0.1.1) | `ff27e291…` | MATCH |
| workflows | 9 | `0d51107d…` | `0d51107d…` | MATCH |
| install-manifests | 3 | `46f3c26a…` | `46f3c26a…` | MATCH |

- Запечённый `artifacts.lock.json` образа: worker `b3f94f42…`, backend `a7a8c463…` — MATCH.
- `setup-contract.js` в образе: clone → `animastor-worker.git`, 404-URL отсутствует — PASS.
- `scripts/content-hash.cjs` → **`836 fb14aae5ecd4c65f161ec287d6bfba5f802dc8bd30d3811ffed097b9d1b89493`**
  == digest из run summary этапа 39 — **образ = ровно тот, что опубликован**.

---

## 4. Выполнение rollout

Изменён **ровно один пин** в `/home/animastor/animastor-backend/deploy/.env`:

```
-GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:daf510ff8e6d713bf9e2e2caebe11e590f61a896e30cb9aec7e7be79672be2d0
+GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:3611c64461049489c048a4d200836ff36fbd5e083a96a3c3c3b752c12eb793c0
```

- `BACKEND_IMAGE` **не менялся** (целевого образа нет — B1).
- mode `.env` сохранён (600); diff против backup — **только строка GPU_HUB_IMAGE** (sha `.env` до `ee64133e…` → после `87ea6f42…`).

Штатная процедура проекта (deploy-compose, runbook H2):

1. `docker compose --project-name animastor --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml up --dry-run`
   → **`gpu-hub Recreate`; pg/redis/backend/proxy Running** (pg/redis НЕ пересоздаются) — гейт D3/E3 соблюдён; `config` без `build:`, образы = digest.
2. `… up -d` → exit 0: gpu-hub `Recreate → Started` за 1.6 с; остальные контейнеры **не тронуты**.

Не выполнялось: `docker compose down/restart`, пересоздание pg/redis, остановка
стека, prune, очистка Redis, изменения схем/DNS/TLS, git push, lock-правки.

---

## 5. Проверка результата

### 5.1 Сервисы и health

| Проверка | Результат |
|---|---|
| `/health` (site→backend) | **200** |
| `/gpu/health` | **200** `{"gpus":0,"queues":{"image":8,...},"running":0}` |
| backend health (внутр. `127.0.0.1:3000/health`) | **200** `{"status":"ok","redis":"PONG"}` |
| hub health (внутр. `127.0.0.1:5000/health`) | **200** |
| `https://app.animastor.org/` | **200** |
| главная страница sha | **`a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c`** (= канон web-репо) |
| `nginx -t` | syntax ok |
| 301 legacy `.in`×3 + http→https | **301 ×3 + 301** → `https://animastor.org/` |
| TLS SNI | `.org` notAfter **Jan 6 2027**; `.in` **Jan 10 2027** — не тронуты |
| APK / ACME webroot | apk **200**; `.well-known/acme-challenge/` отвечает (404 на несуществующий токен — норма; монты не менялись) |

### 5.2 Фактические образы и версии артефактов

| Компонент | Было | Стало | Проверка |
|---|---|---|---|
| `gpu-hub` image | `sha256:daf510ff…` | **`sha256:3611c644…`** | `docker inspect gpu-hub` == пину `.env` |
| `animastor-backend` image | `sha256:e8152778…` | **`sha256:e8152778…`** (не менялся) | == пину `.env` (B1) |
| `/gpu/worker-bundle/sha256` | `480af146…` (17672 Б) | **`3d23b4de8af68b14549db6f113e270c6db8a9b63f48c78bb88683905d8d4f8ae`** (17676 Б, 8 файлов, v2.1.1) | скачан и распакован |
| tree живого бандла | `4bb0408b…` | **`417c0ad4…`** | пересчёт канонической формулой == цель; **8/8 файлов byte-identical** к `worker@b3f94f42` (W1-стиль) |
| `/gpu/installer/sha256` | 0.1.0 | **`{"version":"0.1.1","sha256":"48a05cc3…","bytes":181447}`** | 200 |
| `/gpu/installer/bundle` | старый | содержит `src/installer/setup-contract.js` с **`git clone …/animastor-worker.git`** и `package.json` 0.1.1 | скачан и проверен |
| `/gpu/workflow/tts-qwen-narrator` | 200 | **200** | — |
| запечённый content-hash образа | — | `836 fb14aae…` == этап 39 | PASS |

### 5.3 Данные, PG, Redis, lock-файлы

| Проверка | Результат |
|---|---|
| pg/redis `Created` | `2026-07-08T13:37:11Z` — **не пересоздавались**, healthy |
| `generation_tasks` | **17** (= до rollout) |
| Redis | `PONG` |
| data/output / data/books | 63 203 425 / 1 704 047 Б — **равны до-снапшоту** |
| L1 lock | `069b62d9…` **не изменён** |
| L2 lock | `9b9dd09b…` **не изменён** (изменялся только на этапе 39) |
| git | gpu-hub/worker чистые; mono baseline (M3 + overlay untracked); backend `?? deploy/`, `?? freebuff…` — **как до** |
| rollback-канал | mono `config --quiet` **exit 0**, mono `.env` `ee64133e…` не тронут |
| диск | 34 909 896 704 Б свободно |

### 5.4 Логи

- `gpu-hub`: старт чистый (`[ARTIFACTS] … baked-in`, `GPU HUB running on 5000`);
  grep error/exception за окно — **0**. Строка `INSTALLER_PKG_DIR (missing → frozen 404)`
  присутствует и в старом образе (`/app/installer-pkg` нет и там) — **не регрессия**.
- `animastor-backend`: scheduler/runtime-loop/lease без ошибок; grep
  error/exception/fatal за 10 мин — **0**.

### 5.5 Очереди и тестовая image-задача

- Очереди стабильны до/после: `image 8`, `ws:3317e019… 270`, `running 0`, `gpus 0`
  (значения extern к окну; на этапе 37 было 261 — рост от внешних продьюсеров, не от rollout).
- **Тестовая image-задача / E2E — НЕ выполнялась:** `E2E_WORKSPACE_ID` unset,
  воркеров 0 (нет ни контейнера, ни подключённого воркера, `gpus 0`). По правилу
  задачи идентификатор не выдумывался, dispatch не запускался, повторных попыток не было.
  Блокер **G5** (окно владельца) остаётся открытым — на результат rollout не влияет.

---

## 6. Блокеры (rollout применён частично)

**B1 — backend-сервис не обновлён (главный).**
Целевой коммит backend `a7a8c463…` **не имеет опубликованного production-образа**:
в ghcr только `deploy-0c55b5a7` / `rollback-e14d6220` / `deploy-e233d64d`(=`e8152778…`),
CI для backend-образа нет (этап 39 собирал только gpu-hub). Содержимое текущего
образа `e8152778…` (сверено с репо) **не равно** `a7a8c463` — в нём нет фикса
`8cb02d86` (assistantPorts в module scope) и правок `a7a8c463`.
Вместе с тем **пин** backend `a7a8c463` в L2 применён, и staging/installer-src,
workflows — взяты из этого коммита (через новый hub-образ).
Что закроет: сборка + публикация backend-образа из `a7a8c463` (отдельное окно,
штатная процедура проекта) → обновление `BACKEND_IMAGE` в `deploy/.env` + `up`.
**Откат не требуется** — backend работает на проверенном пине `e8152778…`.

**B2 — E2E / тестовая задача (G5):** нет `E2E_WORKSPACE_ID` и воркеров (§5.5).

Не-блокеры (косметика, из этапа 37): исторические метки pg/redis/gpu-hub;
uncommitted `index.html` в mono (фаза J); untracked `deploy/` в backend-repo.

---

## 7. Откат — не потребовался, канал готов

Все проверки зелёные → **откат не выполнялся**. Процедура на случай позднейших
проблем (задокументирована, не запускалась):

```sh
# вернуть прежний пин gpu-hub
sed -i 's|^GPU_HUB_IMAGE=.*|GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:daf510ff8e6d713bf9e2e2caebe11e590f61a896e30cb9aec7e7be79672be2d0|' \
  /home/animastor/animastor-backend/deploy/.env
cd /home/animastor/animastor-backend/deploy && docker compose --project-name animastor \
  --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml up -d
# либо полный mono-канал:
cd /home/animastor/animastor && docker compose -f docker-compose.yml \
  -f docker/compose/overlay-backend-standalone.yml up -d --force-recreate
```

Контроль отката: health 200/200; site sha `a1900f4e…`;
`/gpu/worker-bundle/sha256` → `480af146…`; образы `daf510ff…`/`e8152778…`;
`nginx -t` ok; pg healthy, `generation_tasks=17`.

---

## 8. Запреты — соблюдены

Не выполнялось: `git push` / force / переписывание истории; правки lock-файлов;
публикация релизов/образов; `docker compose down/restart`; пересоздание
PostgreSQL/Redis; остановка всего стека; `docker image|volume prune` (старые
образы сохранены); очистка Redis; необратимые изменения схем БД; изменения
DNS/TLS; `certbot`; E2E-dispatch; удаление данных/монорепо/бэкапов/исходников.
Секреты `.env` в отчёт не выгружались (только sha и имён-пинов).

---

## 9. Фактические значения (для следующих окон)

| Что | Значение |
|---|---|
| gpu-hub image (применён) | `ghcr.io/animastor/animastor-gpu-hub@sha256:3611c64461049489c048a4d200836ff36fbd5e083a96a3c3c3b752c12eb793c0` (tag `v0.2.0`, content-hash `836 fb14aae…`) |
| backend image (текущий, не менялся) | `ghcr.io/animastor/animastor-backend@sha256:e8152778e1f00d09c9436ff295eeada7248fef8f9823f727e728a2c79a35c9f9` (tag `deploy-e233d64d`) |
| rollback-пины | gpu-hub `daf510ff8e6d713bf9e2e2caebe11e590f61a896e30cb9aec7e7be79672be2d0`; backend `e8152778…` |
| deploy/.env | до `ee64133e…` (backup `/home/animastor/backups/deploy-env-pre-rollout40-2026-10-12.env`), после `87ea6f426a6cb142faa1a0b2311b1c46cb69c2f3e2f66a9c9198a8869b572d08` |
| живой worker-bundle | v2.1.1, tarball sha `3d23b4de…`, **tree `417c0ad4…`** (8/8 == `b3f94f42`) |
| живой installer | 0.1.1, tarball sha `48a05cc3…`, fix 404 присутствует; release asset `78cc1bde…` |
| L1 / L2 lock | `069b62d9…` / `9b9dd09b…` (без изменений в этом окне) |
| site sha | `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c` |

---

## 10. Резюме для чата

**PARTIAL.** Применён новый **GPU Hub `sha256:3611c644…`** (v0.2.0) — вместе с ним
в production ушли утверждённые **worker-bundle `417c0ad4…`** (живой бандл 8/8 ==
worker@`b3f94f42`) и **installer-src `ff27e291…`/0.1.1** (фикс 404-URL на месте),
**L2-пины worker `b3f94f42` / backend `a7a8c463`** и release `hub-artifacts-v0.1.1`
верифицированы. Изменён ровно один пин в `deploy/.env`; dry-run подтвердил
пересоздание только gpu-hub (pg/redis/backend/proxy не тронуты).
Проверки: `/health` **200**, `/gpu/health` **200**, backend health **200**,
app **200**, site sha `a1900f4e…`, `nginx -t` ok, 301×3, TLS не тронуты,
image content-hash == этапу 39, логи без ошибок, PG `generation_tasks=17`,
data байт-в-байт, Redis PONG, lock-файлы и git не изменены, диск 34,9 ГБ.
**Блокер B1:** backend-сервис остался на `e8152778…` — для коммита `a7a8c463`
**нет опубликованного образа** (в ghcr только 3 старых тега, backend-CI нет);
это единственный неприменённый компонент, откат не нужен. **Блокер B2 (G5):**
E2E/тестовая image-задача не запускалась — `E2E_WORKSPACE_ID` unset, воркеров 0.
Откат не требуется; канал цел (mono `config --quiet` exit 0, backup `.env` сохранён,
старые образы не удалялись).
Отчёт: `/home/animastor/reorg-2026-10-12/40-production-rollout-report.md`.
