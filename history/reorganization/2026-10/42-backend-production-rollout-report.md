# Этап 42 — Production rollout backend-сервиса на образ из коммита `a7a8c463`

**Дата:** 2026-10-12 (окно ~15:05–15:45 UTC)
**Итог: PASS** — `BACKEND_IMAGE` в `deploy/.env` переключён на опубликованный на
этапе 41 digest `sha256:e1fac1d2…`, пересоздан **только** контейнер
`animastor-backend` (2.1 с). Все проверки зелёные: health 200/200, сайт и app
200 (site sha без изменений), PG/Redis доступны из backend-контейнера,
`generation_tasks=17`, данные байт-в-байт, GPU Hub и nginx **не пересоздавались**
(ID/StartedAt идентичны), lock-файлы и git не тронуты. **Откат не требовался.**
Зафиксирован один **pre-existing** (не регрессия) warn при старте —
`Reconcile errors: audio_orch: …` (разбор и доказательства в §5; на работу
сервиса не влияет, follow-up для владельца).

---

## 0. Краткая сводка

| Шаг | Результат |
|---|---|
| Чтение отчётов 40/41 | выполнено; цель — закрыть блокер B1 этапа 40 (backend-сервис на старом образе) |
| Доступность образа по полному digest | **да**: `imagetools inspect @sha256:e1fac1d2…` exit 0; tag `deploy-a7a8c463` → **тот же digest**; `docker pull` по digest exit 0 |
| Соответствие образа `a7a8c463` | **да**: OCI-label `revision=a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad`, `version=deploy-a7a8c463`; свежая сверка содержимого pull-нутого образа с `git a7a8c463:backend/...` — **364/364 файлов MATCH, 0 расхождений** (src+tests+ключевые: backend.cjs, package.json, package-lock.json, Dockerfile) |
| Сохранение текущей конфигурации для отката | **да**: backup `deploy/.env` → `/home/animastor/backups/deploy-env-pre-rollout42-2026-10-12.env` (mode 600, sha `87ea6f42…`); прежний образ `e8152778…` присутствует локально и в GHCR (tag `deploy-e233d64d`) |
| Изменение конфига | **ровно одна строка** `BACKEND_IMAGE` (diff против backup — только она); mode 600 сохранён; новый sha `.env` — `21e3248c…` |
| Сухой прогон | `compose … up --dry-run`: **только `animastor-backend Recreate`**; pg/redis/gpu-hub/proxy `Running`; `config --quiet` exit 0; rendered `backend.image = …@sha256:e1fac1d2…` |
| Применение | `up -d` exit 0 за 2.1 с: `animastor-backend Recreated → Started`; остальные «Running» — не тронуты |
| Верификация | все проверки PASS (§4); production-данные целы |
| Откат | **не потребовался**, канал готов и задокументирован (§7) |
| E2E / тестовая image-задача | **не выполнялась** — `E2E_WORKSPACE_ID` unset, воркеров 0, `gpus:0` (блокер G5; по условию задачи dispatch не запускался) |

---

## 1. Применённый digest (разрешён из этапа 41)

```
BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:e1fac1d29f7acd9477080e4608be4670ba172d686e0e061fbbf84c322382def4
```

- Digest взят из отчёта этапа 41 (§6) и независимо подтверждён перед
  применением: `deploy-a7a8c463` и full-sha тег `a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad`
  указывают на **один и тот же** index `sha256:e1fac1d2…`
  (image manifest `sha256:ccd49d7f…` linux/amd64 + attestation `sha256:82d7d5e6…`).
- Pull по digest выполнен до правки `.env`; OCI-labels образа:
  `org.opencontainers.image.revision=a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad`,
  `source=https://github.com/Animastor/animastor-backend`,
  `version=deploy-a7a8c463`.
- Соответствие коммиту перепроверено свежей побайтовой сверкой содержимого
  pull-нутого образа с git-деревом `a7a8c463:backend` — **364/364, 0 mismatch**
  (этап 41 дал те же 424/424 для полного дерева; здесь — src/tests целиком +
  ключевые файлы корня).

## 2. Откат-подготовка (до изменений)

- Backup: `cp -p deploy/.env → /home/animastor/backups/deploy-env-pre-rollout42-2026-10-12.env`,
  mode 600, sha **`87ea6f426a6cb142faa1a0b2311b1c46cb69c2f3e2f66a9c9198a8869b572d08`**
  (== до-измененческому sha рабочего `.env`).
- Прежний образ **на месте**: локально `sha256:e8152778e1f00d09…` (created
  2026-10-10), в GHCR — tag `deploy-e233d64d`. Не удалялся.
- Baseline идентичностей контейнеров (для контроля «кто пересоздан»):
  backend `9bd52938…` (Started 11:45:21), gpu-hub `b771d050…` (Started 13:41:43),
  proxy `09cb6688…` (Started 11:45:22), pg `49202ac1…` / redis `fd01e09a…`
  (Created 2026-07-08T13:37:11Z).
- До-снапшот: health 200/200, site sha `a1900f4e…`, PG `generation_tasks=17`,
  Redis PONG, data/output 63 203 425 Б, data/books 1 704 047 Б,
  `config --quiet` exit 0.

## 3. Изменение и применение

Diff `deploy/.env` против backup — **единственная строка** (номер 39):

```
-BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:e8152778e1f00d09c9436ff295eeada7248fef8f9823f727e728a2c79a35c9f9
+BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:e1fac1d29f7acd9477080e4608be4670ba172d686e0e061fbbf84c322382def4
```

- `GPU_HUB_IMAGE` (и все прочие строки/секреты) — без изменений; mode 600;
  новый sha `.env` — `21e3248c9876d2f27bf8fca781f386171cffa0ee26f986dac8f2f1eb97012c44`.
- Dry-run (`docker compose --project-name animastor --env-file .env
  -f docker-compose.yml -f overlay-backend-standalone.yml up --dry-run`):
  pg/redis/gpu-hub/proxy `Running`, **только** `animastor-backend Recreate/Recreated`.
  Rendered-конфиг: `backend → …@sha256:e1fac1d2…`, `gpu-hub → …@sha256:3611c644…`
  (пины совпадают с `.env`).
- Применение: `up -d` → exit 0 за **2.1 с**: `animastor-backend Recreate →
  Recreated → Starting → Started`; pg/redis прошли `Waiting → Healthy` как
  зависимости; пересозданий pg/redis/gpu-hub/proxy нет.

## 4. Проверка результата

### 4.1 Контейнеры: пересоздан только backend

| Контейнер | Image | ID после | Изменение |
|---|---|---|---|
| `animastor-backend` | **`…@sha256:e1fac1d2…`** | `91fc2fad…` (Created 15:12:03) | **ПЕРЕСОЗДАН** (был `9bd52938…`) |
| `gpu-hub` | `…@sha256:3611c644…` | `b771d050…` | **не тронут** (Started 13:41:43 — тот же) |
| `animastor-proxy` (nginx) | `nginx:alpine` | `09cb6688…` | **не тронут** (Started 11:45:22 — тот же) |
| `animastor-pg` | `postgres:16` | `49202ac1…` | **не тронут** (Created 2026-07-08) |
| `animastor-redis` | `redis:7` | `fd01e09a…` | **не тронут** (Created 2026-07-08) |

### 4.2 HTTP и сервисы

| Проверка | Результат |
|---|---|
| `https://animastor.org/health` (site→backend) | **200** |
| `https://animastor.org/gpu/health` | **200** `{"gpus":0,"queues":{"image":8,"audio":0,"video":0},"running":0}` |
| `https://app.animastor.org/` | **200** |
| главная страница (sha256) | **`a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c`** — без изменений |
| backend health (внутр. `127.0.0.1:3000/health`) | **200** `{"status":"ok","loop":true,"redis":"PONG","ts":…}` |

### 4.3 PostgreSQL / Redis / данные

| Проверка | Результат |
|---|---|
| PG изнутри backend-контейнера (креды из его env: `PG_HOST/PORT/USER/DB/PASSWORD`) | **OK**: `generation_tasks=17`, `current_database=animastor, current_user=animastor` |
| Redis изнутри backend-контейнера (host `redis:6379`) | **OK**: PING → PONG |
| `generation_tasks` (прямой запрос к pg) | **17** (= до rollout) |
| data/output / data/books | **63 203 425 / 1 704 047 Б** — байт-в-байт равны до-снапшоту |
| Монты backend-контейнера | как в compose: `data/books→/data/books`, `backend/ai→/app/ai`, `backend/tests→/app/tests`, `data/output→/data/output` |

### 4.4 Логи backend (за окно 25+ мин)

- Старт чистый: роуты/workflows/connectors загружены (7/7, 0 warnings),
  `[STARTUP] Backend server running`, runtime loop запущен.
- Runtime loop жив: **1221** тиков за ~25 мин; scheduler обрабатывает активную
  image-задачу (Active:1), lease renewed (`ttl re-pinned to 1380s`),
  `[DRIFT] 0 corrected`.
- Реальных error/fatal строк **0**. Единственная warn-строка при старте —
  `[STARTUP] Reconcile errors: audio_orch: …` (разбор ниже, §5). Строка
  `[WORKFLOWS] Connectors: 7 loaded, 0 warnings, 0 errors` — grep-ложное
  срабатывание (счётчик ошибок = 0).
- Reconcile-фазы старта: `result_recovery:0, chunk_recovery:ok, video_orch:0,
  version_stale:12, counter_reconcile:2, session_resume, reconcile:3_issues` —
  выполнены без ошибок, кроме audio_orch (см. §5).

### 4.5 Неизменность всего остального

| Проверка | Факт |
|---|---|
| L1 lock `packages/animastor-gpu-hub/artifacts.lock.json` | `069b62d9…` — **не изменён** |
| L2 lock `animastor-gpu-hub/artifacts.lock.json` | `9b9dd09b…` — **не изменён** |
| mono `.env` | `ee64133e…` — **не изменён** |
| git | backend HEAD `a7a8c463` + baseline-статусы (`?? deploy/`, `?? freebuff…`); mono/gpu-hub/worker — без новых изменений |
| DNS/TLS | не трогались (proxy-контейнер и его конфиг не пересоздавались; health через TLS 200) |
| Диск | 33 288 810 496 Б свободно (68%) — в норме |

## 5. Находка: `[STARTUP] Reconcile errors: audio_orch: …` — pre-existing, не регрессия

**Что происходит.** При старте reconciliation-цикл (Phase C1
`recoverAudioOrchStates` в `@animastor/orchestration` 0.1.1) обрабатывает
non-terminal audio-orch-состояния Redis. Для фаз GENERATING/WAITING_CHUNKS он
делает `const chunks = lazyHostBinding('media.audio.chunks')` и вызывает
`chunks.findExistingSceneChunks(...)`. Хост-биндинг `media.audio.chunks`
**никем не зарегистрирован** → `chunks === undefined` → TypeError →
`summary.errors.push('audio_orch: …')` → console.warn; цикл продолжает работу,
сервис полностью функционален.

**Доказательство, что это не регрессия нового образа** (код-уровень):

| Проверка | Старый образ `e8152778` | Новый `e1fac1d2` |
|---|---|---|
| sha256 всего `node_modules` (js/cjs/json) | `a545f46ef30ade8a…` | **идентичен** `a545f46ef30ade8a…` |
| `@animastor/orchestration` | 0.1.1 | 0.1.1 |
| diff `/app/src` (179 файлов) | — | **различается ровно 1 файл: `src/backend.cjs`** |
| diff `backend.cjs` (68 строк) | — | **только** перенос `assistantPorts` в module scope (фикс `8cb02d86`); к audio-orch/биндингам/reconcile не относится |
| регистрация `media.audio.chunks` в `/app/src` | **0 вхождений** | **0 вхождений** |

То есть C1-лег приведения audio-состояний в порядок структурно **одинакова** в
обоих образах; сработает/не сработает она зависит только от содержимого Redis.

**Фактическое состояние Redis (read-only SCAN):** `animastor:audio-orch:*` — 8
ключей: 5 × `DONE` (текущий импорт `import_1786345731767…`) и **3 ×
`GENERATING` из импорта `import_1783656905372…` ≈ 2026-07-10** (трёхмесячной
давности; audio-очередь сейчас пуста). C1 упала на первой же GENERATING-записи,
поэтому эти 3 устаревших состояния не были «доиграны/помечены FAILED» — они и
так были сиротами задолго до rollout. Active-задача (image) и DONE-состояния
данной находки не касаются.

**Вердикт:** warn-level, non-fatal, влияет только на recovery трёх устаревших
сирот-состояний июля 2026; регрессией rollout не является, откат не нужен.

**Follow-up для владельца (вне этого окна):**
1. Зарегистрировать host-биндинг `media.audio.chunks` в composition root
   (`backend.cjs`) либо сделать C1-легу устойчивой к отсутствию биндинга
   (аналогично «optional-load → return 0»).
2. Почистить 3 устаревших ключа `animastor:audio-orch:import_1783656905372…:ch-c779d21c:sc-{1eb2306c,45fc1833,5860455d}`.

## 6. E2E / тестовая задача

**Не выполнялась**: `E2E_WORKSPACE_ID` unset, воркеров нет (контейнера нет,
подключённых воркеров нет, `gpus:0`). По правилам задачи идентификатор не
выдумывался, dispatch не запускался. Блокер **G5** (окно владельца) остаётся
открытым и не связан с этим rollout.

## 7. Откат — не потребовался, канал проверен и задокументирован

Все проверки зелёные → откат не выполнялся. Процедура на случай позднейших
проблем:

```sh
sed -i 's|^BACKEND_IMAGE=.*|BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:e8152778e1f00d09c9436ff295eeada7248fef8f9823f727e728a2c79a35c9f9|' \
  /home/animastor/animastor-backend/deploy/.env
cd /home/animastor/animastor-backend/deploy && docker compose --project-name animastor \
  --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml up -d
```

Ресурсы для отката: backup `.env` (`/home/animastor/backups/deploy-env-pre-rollout42-2026-10-12.env`,
sha `87ea6f42…`), локальный образ `e8152778…`, GHCR tag `deploy-e233d64d`,
rollback-комментарий в самом `.env`. Контроль отката: health 200/200, site sha
`a1900f4e…`, `generation_tasks=17`, Redis PONG.

## 8. Запреты — соблюдены

Не выполнялось: пересоздание/остановка pg, redis, gpu-hub, proxy; `compose
down/restart`; изменения DNS/TLS/схем БД; правки lock-файлов и git-истории
(никаких коммитов/push в этом окне); `prune`; очистка Redis; E2E-dispatch;
удаление образов/данных. Секреты `.env` в отчёт не выгружались (только sha и
пины).

## 9. Фактические значения (для следующих окон)

| Что | Значение |
|---|---|
| backend image (применён) | `ghcr.io/animastor/animastor-backend@sha256:e1fac1d29f7acd9477080e4608be4670ba172d686e0e061fbbf84c322382def4` (tags `deploy-a7a8c463`, full-sha; label `revision=a7a8c463…`) |
| gpu-hub image (без изменений) | `…@sha256:3611c644…` (v0.2.0) |
| rollback-пин backend | `…@sha256:e8152778e1f00d09c9436ff295eeada7248fef8f9823f727e728a2c79a35c9f9` (tag `deploy-e233d64d`) |
| `deploy/.env` | до `87ea6f42…` (backup `…pre-rollout42-2026-10-12.env`), после `21e3248c…` (mode 600) |
| backend-контейнер | `91fc2fad…`, Created 2026-10-12T15:12:03Z |
| Кодовое отличие образов | только `src/backend.cjs` (assistantPorts → module scope, `8cb02d86`) + `package.json` (+`license`); `node_modules` идентичен |
| L1 / L2 lock | `069b62d9…` / `9b9dd09b…` (не изменялись) |
| site sha | `a1900f4e…` (не изменился) |
| Данные | output 63 203 425 Б, books 1 704 047 Б; PG `generation_tasks=17` |

## 10. Резюме для чата

**PASS.** Backend-сервис переключён на утверждённый образ коммита `a7a8c463`
(digest `sha256:e1fac1d2…`, разрешён и сверён с этапом 41: доступен по полному
digest, tag→digest совпадает, 364/364 файлов == git, label revision верный).
Изменена ровно одна строка `BACKEND_IMAGE` в `deploy/.env` (backup сохранён),
`up --dry-run` и `up -d` подтвердили пересоздание только `animastor-backend`
(2.1 с); gpu-hub/nginx/pg/redis — не пересоздавались (ID/StartedAt идентичны).
Проверки: `/health` 200, `/gpu/health` 200, app 200, site sha `a1900f4e…` без
изменений, backend health 200 `{ok, loop:true, redis:PONG}`, PG/Redis доступны
из backend-контейнера, `generation_tasks=17`, данные байт-в-байт, runtime loop
и scheduler работают, логи без ошибок. Откат не требовался; канал готов.
Отмечен pre-existing non-fatal startup-warn `audio_orch` (host-binding
`media.audio.chunks` не зарегистрирован ещё со старого образа; кодовая база
доказательно идентична — см. §5) — follow-up для владельца. E2E не запускалась
(G5: нет `E2E_WORKSPACE_ID` и воркеров).

Отчёт: `/home/animastor/reorg-2026-10-12/42-backend-production-rollout-report.md`.
