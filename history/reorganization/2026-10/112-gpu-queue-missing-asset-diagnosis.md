# Stage 112 — Диагностика роста очереди GPU Hub и отсутствующего scene-asset (read-only)

**Дата проверки:** 2026-10-22, окно **02:50Z → 03:09Z** (финальные замеры 03:05–03:09Z; отчёт Stage 111 закрыт 2026-10-21 14:55Z).
**Объект:** production после Stage 109 cutover (`ghcr.io/animastor/animastor-backend@sha256:f6aefe57…`, `deploy-78e8f1a`) + Stage 110 (mirror hooks).
**Режим:** строго read-only. Генерация не запускалась; статусы, leases, очередь, БД, Redis, файлы, настройки workers, Git refs/hooks **не изменялись**.
**Итог: WARN** — все три пункта диагностированы; критичных (BLOCKED) условий нет. Рост очереди объяснён полностью и воспроизводится арифметически; отсутствующий MP4 — доказанно legacy-путь (потери артефакта нет); сообщение PG `users_username_unique` — доказанно ожидаемое идемпотентное поведение, скрытой ошибки нет. Требуются отдельные этапы (ничего не применено).

---

## 0. Источники и метод

| Источник | Что взято |
|---|---|
| Stage 111 `reorg-2026-10-19/111-post-cutover-health-audit-report.md` | baseline: cutover 13:15:38Z, GPU `gpus:0`, очередь 457, 2 сцены `Skipped`, `scene_assets` b1-путь, PG ERROR на старте |
| Stage 109 / Stage 93 | `books-before.txt`, `output-before.txt` (path+size), `source-manifest-pass1.sha256` (156 SHA-256 содержимого), `pg-animastor-schema-2026-10-20.sql`, `data-books-output-2026-10-20.tgz` |
| `/tmp/opencode/base-gpu.json` (2026-10-14 02:37) и `post-gpu.json` (2026-10-14 02:41) | исторические снимки GPU Hub: `workspace_queues.image = 306` и `315` |
| Stage 65/70/75/76 (`reorg-2026-10-17`) | история «мёртвого» пути `/data/output/b1/…`, классификация К-3, архивный preview, запрет на миграцию |
| Код | `backend/src/storage/postgres/schema.js:1204-1217`, `packages/animastor-orchestration/src/runtime/{dispatch-engine,lease-manager,reconciliation-engine,runtime-scheduler}.js`, `backend/src/backend.cjs:983-1003`, `animastor-gpu-hub/gpu-hub.js` |
| Живые системы | `docker inspect`, `docker logs`, `GET http://gpu-hub:5000/health`, `redis-cli` (SCAN/TYPE/LLEN/LRANGE/TTL/GET), `psql` (только SELECT), `find`/`sha256sum` |

**Метод:** все команды — чтение. `redis-cli` использовался только на `SCAN/TYPE/LLEN/LRANGE/TTL/GET/HGETALL`; `psql` — только `SELECT`/`\dt`/`information_schema`. Записи этого этапа: `/tmp/opencode/s112/*` и настоящий отчёт.

---

# A. GPU Hub и очередь изображений

## A.1. Текущее состояние (2026-10-22 03:05Z)

`GET http://gpu-hub:5000/health` (HTTP 200, из контейнера backend по `HUB_URL=http://gpu-hub:5000`):

```json
{"gpus":0,"queues":{"image":8,"audio":0,"video":0},
 "workspace_queues":{"animastor:queue:image:ws:3317e019-879d-4dfb-a9f8-edc9b72da7f4":457},
 "running":0}
```

| Ключ Redis | Тип | Значение | Комментарий |
|---|---|---|---|
| `animastor:queue:image:ws:3317e019-…` | list | **457** | workspace-lane, единственная активная lane |
| `animastor:queue:image` (глобальная/system lane) | list | **8** | старые джобы без `workspace_id`/`dispatch_id` (книги `import_1783751905430…`, `import_1783860199734…`, импорт 2026-07-11/12) |
| `animastor:queue:audio` / `:video` | — | отсутствуют | 0 |
| `animastor:running` | — | отсутствует | ни одной выполняемой задачи |
| `animastor:processing` | — | отсутствует | — |
| `animastor:gpu-hub:workers` (реестр GPU) | — | отсутствует | ⇒ `gpus: 0` (ключ создаётся `setGpuInRedis` c TTL 900 с) |
| `animastor:worker:heartbeat:*` | — | **0 ключей** | ни один worker не шлёт heartbeat |
| `animastor:iu-in-flight:*` | — | **0 ключей** | ни одна IU-задача не «в полёте» |

**Состав 457 workspace-записей (полный разбор `LRANGE 0 -1`):**

| Сцена | Уникальных `job_id` | Копий каждого | Уникальных `dispatch_id` | Вклад |
|---|---|---|---|---|
| `ch-1bb5123c/sc-45c789c6` | **9** (IU `iu-5d64fc7d, iu-0c92b6b9, iu-1a6c4052, iu-ec4410b8, iu-37fdb339, iu-be44228d, iu-700b11cf, iu-29468fa8, iu-68f31f96`) | **43** | 43 | 387 |
| `ch-1bb5123c/sc-5f18dd0f` | **10** (IU `iu-f3ba0af0, iu-da4524b7, iu-b2256d52, iu-702b84b0, iu-38adb6b3, iu-19239655, iu-d9bd4014, iu-f659655e, iu-b63f75d3, iu-ea5adb7e`) | **7** | 7 | 70 |
| **Итого** | **19** | — | **50** | **457** |

* 19 уникальных логических задач; **438 из 457 записей (95,8 %) — точные дубликаты** тех же `job_id`.
* Все 50 `dispatch_id` из очереди **найдены** в журнале сцен (`DISPATCH_STARTED`) — т.е. очередь не содержит «чужих»/поддельных записей.
* Все записи: `book_id=import_1786345731767_1786345734345`, `chapter_id=ch-1bb5123c`, `stage=image`, `build_id=build_import_1786345731767_1786345734345`, `timeout_ms=1800000`, `policy_id=null`.
* 8 записей глобальной lane — старые джобы книг, импортированных 2026-07-11/12; у них нет `book_id`, `scene_id`, `dispatch_id`, `workspace_id` → они не принадлежат ни одной workspace и «зависли» ещё с июля; **не растут** (последняя активность — 2026-07).

## A.2. Текущее число задач по статусам

**PostgreSQL** (`generation_tasks`, `scene_assets`, `image_units`, `workers`):

| Таблица | Значение | Δ к Stage 111 |
|---|---|---|
| `generation_tasks` (17) | `completed` 8, `cancelled` 9; **нет** pending/running/queued/failed | 0 (без изменений) |
| `scene_assets` (459) | `audio`: ready 9 / placeholder 9 / stale 21; `image`: ready 2 / pending 2 / stale 409; `video`: ready 7 | 0 |
| `scene_assets` с `build_id IS NULL` | 437 | 0 (совпадает с Stage 75/76) |
| `image_units` (58) | все с `build_id`; 19 из них — по 9/10 IU двух сцен ниже, `build_import_1786345731767_1786345734345` | 0 |
| `workers` (7) | **все 7 — `status='offline'`** | 0 |

**Redis / runtime:**

| Показатель | Значение |
|---|---|
| `animastor:active-scenes` | 2 элемента: `…:ch-1bb5123c:sc-45c789c6`, `…:ch-1bb5123c:sc-5f18dd0f` |
| `animastor:runtime:active-image` | `2` |
| Тик scheduler (03:05Z, tick 9930) | `Active: 2, Dispatched: 0, Skipped: 2, Throttled: 0, Completed: 0, errors: []` |
| Счётчик дрейфа | `image: leaseCount 2, counterValue 2, drift 0` — расхождения нет |
| Reconciliation | `6 scenes scanned, 0 inconsistencies found` |
| `dbsize` / keyspace | 321 / `db0:keys=321, expires=23` (как в Stage 111) |
| PG `scenes.status` для обеих сцен | `pending` (updated_at 2026-10-17 12:47:57) |
| Redis `asset-state` | `sc-45c789c6`: audio=ready, **image=generating**; `sc-5f18dd0f`: audio=ready, **image=generating**, video=dirty |

**Файлы:** в `data/output/build_import_1786345731767_1786345734345/` для `sc-45c789c6` и `sc-5f18dd0f` есть только `.mp3` + чанки; **ни одного `_iu-*.png`** ⇒ image-стадия для этих двух сцен **никогда не завершалась**, «потерянного результата» нет.

## A.3. Рост 306 → 457: подтверждение источниками (арифметика сходится точно)

Реконструкция выполнена по журналу сцен (`animastor:event-journal:…:sc-45c789c6` — 68 544 записи, `…:sc-5f18dd0f` — 60 057) и по `dispatch_id` из очереди: **все 50 `dispatch_id` очереди сопоставлены с событиями `DISPATCH_STARTED`**, 0 несовпадений.

| Снимок | Источник | Раундов `sc-45c789c6` | Раундов `sc-5f18dd0f` | Расчёт | Снимок | **СОВПАЛО** |
|---|---|---|---|---|---|---|
| 2026-10-14 02:37Z | `base-gpu.json` | 34 | 0 | 34 × 9 = **306** | `306` | ✅ |
| 2026-10-14 02:41Z | `post-gpu.json` | 35 | 0 | 35 × 9 = **315** | `315` | ✅ |
| 2026-10-22 03:05Z | живое состояние | 43 | 7 | 43×9 + 7×10 = **457** | `457` | ✅ |

* Вывод: **306 → 457 подтверждено**, причём разница (+151) раскладывается точно: +9 раундов `sc-45c789c6` (81) и +7 раундов `sc-5f18dd0f` (70) за период 2026-10-14 → 2026-10-21.
* Рост **не** является регрессией cutover: базовое состояние `gpus:0` и очередь 306 зафиксированы **2026-10-14**, за 7 дней до cutover. Первый раунд в очереди — 2026-08-30 05:45:26Z.
* Полный хронологический ряд 50 раундов (по 1 строке на раунд) восстановлен и приложен в §A.5.

## A.4. GPU, workers, heartbeat, leases

| Проверка | Факт | Источник |
|---|---|---|
| Реестр GPU в Redis | `animastor:gpu-hub:workers` **отсутствует** ⇒ `gpus: 0` | `gpu-hub.js:331` (`GPU_REGISTRY_KEY`), `setGpuInRedis` c `EXPIRE 900` |
| Heartbeat workers | `animastor:worker:heartbeat:*` — **0 ключей** из 321 | `redis-cli --scan` |
| Реестр workers в PG | 7 записей, **все `offline`**; image-воркеры: `e2e-qwen-image` (online-нет), `parity-test-gpu` (отозван, `revoked_at` задан) | `SELECT … FROM workers` |
| Heartbeat-ключи воркеров | `animastor:worker-auth` (hash, 6 записей) — регистрации есть, подключений нет; TTL `-1` (без срока) | `redis-cli HGETALL` |
| Соединения контейнера `gpu-hub` | единственное ESTABLISHED — на `:6379` (Redis); на `:5000` (API hub'а) **никто не подключён** (только LISTEN) | `/proc/net/tcp` из контейнера, `ss -tn` на хосте |
| Лог hub'а за всё время жизни контейнера (с 2026-10-12 13:41Z) | 187 строк `📥 Task:` (enqueue), **0 строк `📤 Result:`** ⇒ ни одна задача не была получена и возвращена | `docker logs gpu-hub` |
| GPU на этом хосте | `nvidia-smi` отсутствует, `/dev/nvidia*` отсутствует, `lspci` → только `Virtio GPU` | хост |
| Compose-проект `animastor` | сервисы: backend, postgres, redis, nginx, **gpu-hub** — **worker-сервиса нет**; воркеры ставились на удалённые GPU-машины инсталлятором | `docker compose ps`, `deploy/docker-compose.yml` |
| Leases | по 1 активному lease на сцену, TTL **1380 с**, обновляется каждые ~30 с | `TTL` + лог `[LEASE] RENEWED … (ttl re-pinned to 1380s)` |
| `dispatch-meta` | `status: dispatched`, `worker: scheduler`, `retry_attempt: 0`, `quota_owned: true` | `GET animastor:dispatch-meta:…` |

Ключи lease (значения токенов — идентификаторы диспетчеризации, не секреты):

```
animastor:dispatch-lease:import_1786345731767_1786345734345:ch-1bb5123c:sc-45c789c6:image
  token=dispatch-1792588545470-c600fef941295915765f27c6f4c15ae9   TTL 1365…1357 (наблюдалось снижение TTL → renewal работает)
animastor:dispatch-lease:import_1786345731767_1786345734345:ch-1bb5123c:sc-5f18dd0f:image
  token=dispatch-1792588545930-6a0d9a28f4270d7577596b7008430476   TTL 1366
```

`dispatch-meta` подтверждает, что обе сцены находятся в состоянии «диспетчеризовано, владелец — scheduler», `retry_attempt=0` (т.е. это не ретраи после ошибки, а первые попытки).

## A.5. Последовательность событий по двум сценам (восстановлено)

Полный ряд раундов диспетчеризации (последние 12 раундов; полный список из 50 — в §A.3 и в `/tmp/opencode/s112/journal-*.txt`):

| Время (UTC) | Событие | Источник |
|---|---|---|
| 2026-10-19 05:05:14 | `DISPATCH_CANCELLED` (reason=`graceful_shutdown`) — shutdown-хук backend'а снял активный image-диспатч | `backend.cjs:987-1000`; журнал |
| 05:05:17 | `SCENE_PENDING` + `AUTO_RECOVER` (`generating → reconciliation-engine`) | журнал |
| 05:05:21/22 | `DISPATCH_STARTED` → `IMAGE_DISPATCHED` (9 и 10 IU-задач) → `SCENE_GENERATING` | журнал; hub log `📥` 9 + 10 |
| 06:32:07 → 06:32:16 | тот же цикл (ещё +19 в очередь) | журнал; hub log `📥` 9 + 10 |
| **2026-10-21 13:15:37** | `DISPATCH_CANCELLED` (`graceful_shutdown`) — контейнер backend остановлен на cutover | журнал; лог Stage 111 |
| **13:15:40** | `SCENE_PENDING` + `AUTO_RECOVER` (`generating→dirty→pending`, reason `orphan_generating_repair`) | журнал; лог `[ORCH] [ROLLBACK] … (reason=orphan_generating_repair)` |
| **13:15:45** | `DISPATCH_STARTED` (`dispatch-1792588545466-08fa446ea42b786a28bc15af838a1fb5` / `…45927-2e83aeae60c18f9f524464a0231c62a4`) → lease приобретён (TTL 1380 с) → `IMAGE_DISPATCHED` (9 / 10 IU-задач) → hub `LPUSH` в `animastor:queue:image:ws:3317e019…` | журнал; hub log `📥` 9 + 10 (13:15:45 и 13:15:46) |
| 13:15:45 | `SCENE_GENERATING` (asset-state image=generating) | журнал |
| 13:15:46 → сейчас | каждый тик: `Active: 2, Dispatched: 0, Skipped: 2`; lease `RENEWED` каждые ~30 с; reconciliation — `0 inconsistencies` | лог backend + `animastor:runtime:scheduler:history` (tick 9930) |

**Почему `Skipped: 2` — это не ошибка (доказано кодом):**
`runtime-scheduler.js:457` → `attemptDispatch` → `dispatch-engine.js:787` → `shouldSkipDispatch()` (`dispatch-engine.js:696-715`):
* lease существует, TTL не опустился ниже `getRenewalTargetTtlS(image) − STALE_LEASE_GRACE_S` ⇒ **не** `stale_lease`;
* ⇒ возвращается `{ skip: true, reason: 'lease_active' }` ⇒ `summary.skipped++` (`runtime-scheduler.js:465-466`).
То есть `Skipped: 2` — это **работающий guard от повторной диспетчеризации**, а не сбой. Он же блокирует новый enqueue, поэтому очередь не растёт между рестартами.

**Почему при рестарте guard снимается (доказано кодом):**
* Graceful-shutdown отменяет диспатч → удаляются lease и `dispatch-meta` (`backend.cjs:987-1000`);
* на следующем старте `reconciliation-engine.js:1199-1243` проверяет `getDispatchEvidence()` (`dispatch-engine.js:457-482`) — при отсутствии lease/metadata/`iu-in-flight` считает генерацию мёртвой → `GENERATING → DIRTY → PENDING` (`orphan_generating_repair`) → сцена возвращается в active-index;
* scheduler диспетчеризует image-стадию заново ⇒ **+9 / +10 записей в очередь**.

**Почему не каждый рестарт давал рост:** рестарты 2026-10-21 06:33, 06:50, 09:13 (подтверждены по PG-логу `users_username_unique` ERROR в эти секунды) **не** дали `DISPATCH_CANCELLED(graceful_shutdown)` в журнале ⇒ graceful-путь не отработал ⇒ lease в Redis остался живым ⇒ на старте `getDispatchEvidence()` вернул `lease_present` ⇒ repair не сработал ⇒ re-dispatch не было ⇒ очередь не выросла. Это подтверждает, что рост привязан именно к graceful-рестарту.

## A.6. Механизм роста — сводка (уровень кода)

1. **Нет исполнителя.** GPU-реестр пуст (`gpus:0`), все 7 workers `offline`, ни одного heartbeat. 19 IU-задач лежат в очереди бесконечно.
2. **Dedup hub'а не схлопывает повторы.** `gpu-hub.js:829-847`: dedup-ключ = `jobDedupKey(job_id, dispatch_id)` = **`job_id` + `dispatch_id`** (`SET NX EX 3600`). При re-dispatch `dispatch_id` **всегда новый** ⇒ дедуп не срабатывает никогда ⇒ `LPUSH` добавляет **дубль** той же логической IU-задачи.
3. **Backend не проверяет наличие GPU перед диспетчеризацией.** В `dispatch-engine.js` нет обращения к `/health` hub'а; единственный бэкпрешер — квота (`acquireQuota`), которая не заблокирована (`quota_owned: true`, `counterValue: 2`).
4. **Graceful-рестарт = +19 записей.** Цикл «отмена → repair → re-dispatch» (§A.5).
5. **Очередь не уменьшается**, т.к. `RPOPLPUSH` из lane выполняет только worker (их нет).

Итог: **457 = 19 реальных задач + 438 накопившихся дублей**, порождённых отсутствием GPU-воркера при неидемпотентном enqueue.

## A.7. Что действительно застряло, а что ждёт доступного GPU/worker

| Класс | Кол-во | Классификация |
|---|---|---|
| Уникальные image-задачи двух сцен (9 + 10 IU) | **19** | **ЖДУТ GPU/worker.** Артефактов (`_iu-*.png`) для этих сцен не существует → работа не потеряна, а не начата. Как только поднимется image-воркер с токеном workspace `3317e019-…` и начнёт опрашивать `/task/next`, задачи будут выполнены. |
| Дубликаты тех же 19 задач | **438** | **РЕАЛЬНО ЗАСТРЯЛИ (мусор).** Никогда не будут нужны по отдельности; при появлении воркера он выполнит 19×N дубликатных генераций (лишние GPU-часы). Требуют явной чистки. |
| 8 записей глобальной lane (книги 2026-07-11/12) | **8** | **Старая орфанная группа**, не растёт, не привязана к workspace; отдельная тема. |
| PG `generation_tasks` | 17 | Все `completed`(8)/`cancelled`(9) — «висящих» задач в БД нет. |
| Поведение `Skipped: 2` | — | **Не застревание.** Корректный guard (`lease_active`). |

**Доказательство «ждут, а не застряли»:** ни одного `animastor:iu-in-flight:*`; `animastor:running` отсутствует; hub никогда не получал результат; на диске нет ни одного изображения для этих сцен; `image_units` для всех 19 IU имеют `build_id=build_import_…` и `created_at 2026-08-13` (задание создано, результат не получен).

---

# B. Отсутствующий MP4 (`/data/output/b1/…`)

## B.1. Точная запись

`scene_assets` — **ровно 4 строки** (все — video/ready, `build_id IS NULL`, `scene_hash IS NULL`):

| id | book / chapter / scene | path | created_at (UTC) | updated_at |
|---|---|---|---|---|
| **25096** | `import_1786345731767_1786345734345` / `ch-1bb5123c` / `sc-a740d763` | `/data/output/b1/import_1786345731767_1786345734345_ch-1bb5123c_sc-a740d763.mp4` | 1787740722 = **2026-08-26 10:38:42** | 1787740722 |
| **25097** | то же | тот же | 1787740849 = **2026-08-26 10:40:49** | 1787740849 |
| **25098** | то же | тот же | 1787740965 = **2026-08-26 10:42:45** | 1787740965 |
| **25100** | то же | тот же | 1787741423 = **2026-08-26 10:50:23** | 1787741423 |

Все 4 строки в `scene_assets` идентичны по path/status/build_id; различаются только `id`/`created_at`/`updated_at` ⇒ это 4 записи одного и того же события, заведённые с интервалом ~2 мин.

## B.2. Существует ли файл и сравнение с `build_import_…`

| Проверка | Результат |
|---|---|
| Каталог `/data/output/b1` на хосте | **не существует** (`/home/animastor/animastor/data/output/b1` — `No such file or directory`) |
| Файл по указанному пути | **отсутствует**; снять размер/SHA-256 «мёртвого» файла невозможно |
| Файл с тем же basename по каноничному пути | **существует ровно 1 копия**: `/data/output/build_import_1786345731767_1786345734345/import_1786345731767_1786345734345_ch-1bb5123c_sc-a740d763.mp4`, **579 008 Б**, **SHA-256 `e30eebc2000df7ecc62723d2f8423fc692785fdd95deb7ff15d29be9fed99320`** (совпадает со значением, зафиксированным в Stage 75 preflight) |
| Покрытие канонического пути в БД | да — строка **25101** (`ready`, тот же build-каталог, `created_at` 1787748923 = **2026-08-26 12:55:23**, т.е. на **2 ч 05 мин позже** «b1»-строк) |
| Stage 93 манифест содержимого (156 SHA-256, 2026-10-20 15:07) | `b1` — **0 совпадений** ⇒ каталога `b1` не было уже 2026-10-20 |
| Stage 93 архив данных `data-books-output-2026-10-20.tgz` (186 записей) | только `data/output/build_*` и `manual_*`; `b1` — **0 совпадений** |
| Stage 109 `output-before.txt` (2026-10-21) | `b1` — **0 совпадений** |
| 58 архивов в `/home/animastor/backups` | `output/b1` — **0 совпадений** (это архивы исходников, не данных) |

**Вывод по B.2:** сравнивать «файл по b1-пути» с каноническим файлом **побайтово невозможно** — файла нет. Но basename встречается ровно один раз, и он покрыт отдельной `ready`-строкой ⇒ **артефакт не потерян**.

## B.3. Ссылки на asset в БД, Redis и файловых манифестах

| Источник | Ссылка | Значение |
|---|---|---|
| Redis `animastor:assets:import_…:ch-1bb5123c:sc-a740d763` (hash) | `video` | `{"path":"/data/output/build_import_1786345731767_1786345734345/import_1786345731767_1786345734345_ch-1bb5123c_sc-a740d763.mp4", "ready":false, "registeredAt":1788064582835}` — **канонический** путь |
| Redis `animastor:video-orch:…:sc-a740d763` | string | `{"phase":"DONE","groups_received":1,"build_id":"build_import_1786345731767_1786345734345","started_at":1787748921331,…}` |
| Redis `animastor:asset-state:…:sc-a740d763` | hash | `image=ready, audio=ready, video=ready` |
| Redis `animastor:chunk:…_sc-a740d763_0001` | — | чанк видео присутствует |
| Файловые манифесты `data/books/import_…/manifest.json` | — | `build_id: build_import_1786345731767_1786345734345`; ссылок на `b1` нет |
| Поиск `output/b1` по всему `data/` | — | **0 совпадений** |
| Поиск `/output/b1/` по всем text/json/jsonb-колонкам всех таблиц PG (Stage 65) | — | **ровно 4 совпадения, все в `scene_assets`** |
| `scene_assets` (прочие строки по сцене) | — | `21336` audio `/data/output/build_import_…/…mp3` (ready); `25094` image `…_iu-070ed92b.png` (ready); `25101` video `/data/output/build_import_…/…mp4` (ready); `32312` audio (ready, дубль) |

## B.4. Классификация

* Это **не** актуальный production-артефакт: путь `b1` не существует ни на диске, ни в манифестах, ни в архивах — как минимум с 2026-10-20, а по данным Stage 65/70/75 — и ранее.
* Это **старая импортированная запись**: книга `import_1786345731767_1786345734345` (импорт TXT 2026-08-10), сцена `sc-a740d763`; 4 записи созданы **2026-08-26 10:38–10:50**, во время первичной генерации видео, когда runtime build-каталог сцены буквально назывался `b1`; через 2 ч 05 мин тот же артефакт был произведён в канонический каталог `build_import_…` (строка 25101, 12:55:23Z), а каталог `b1` впоследствии не сохранился.
* Итог: **несогласованность пути в 4 legacy-записях БД**, а не потеря данных. Канонический путь и Redis указывают на существующий файл; на диске он **побайтово идентичен** Stage 93 манифесту (проверено: 156/156 файлов `data/**` совпадают по SHA-256; `data/output` inventory sha `2a03a8c7…` — как в Stage 109/111).
* **Точное происхождение литерала `b1` не доказуемо из доступных источников** (INCONCLUSIVE): строка `"output/b1"` никогда не встречалась в исходниках backend (`git log --all -S "output/b1"` → только тестовая фикстура Stage 66), т.е. `b1` подставлялся в рантайме как `buildId`.
* **История вопроса уже зафиксирована**: Stage 56 (2026-10-17) — «stale NULL-build_id duplicates … untouched»; Stage 65 — «dead path»; Stage 70 — категория **К-3 «архивировать, затем удалить»**; Stage 75 (2026-10-19) — dry-run `C_deadpath = 4` + обязательный архив-гейт и preview `/tmp/opencode/stage75/deadpath-archive-preview.json` (SHA-256 `deed59fcf2df90e84cf576fae40c7a6c496f2599feb3f03154eba6c6d6bc361f`); Stage 76 — фикс synthetic-NULL, **миграция `scene_assets` не выполнялась**.
* **Состояние на 2026-10-22:** 4 строки живы и **побайтово совпадают** с архивным preview (id/path/status/build_id/timestamps). Долговременный архив `reorg-2026-10-17/stage76-archive/deadpath-4.json` **не создан**, batch C (удаление) **не выполнялся** — сознательно, это требует решения владельца и является write-операцией.

---

# C. Schema ensure (`users_username_unique`)

## C.1. Код

`backend/src/storage/postgres/schema.js:1204-1217` (внутри `runMigrations()`):

```js
try { await query(`ALTER TABLE users ALTER COLUMN username SET NOT NULL`); } catch (err) { … }
try {
    await query(`ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username)`);   // ← строка 1211
    console.log('[PG] Added unique constraint on users.username');
} catch (err) {
    if (!err.message.includes('already exists')) {
        console.error('[PG] Failed to add unique constraint on users.username:', err.message);
    }
}
```

* PostgreSQL не имеет `ADD CONSTRAINT IF NOT EXISTS` ⇒ оператор срабатывает на **каждом** старте и **всегда** падает, если ограничение уже есть.
* Ошибка «already exists» **намеренно проглатывается** — в логе backend соответствующей строки нет (это подтверждено ещё в Stage 111).

## C.2. Является ли это ожидаемым идемпотентным поведением

**Да — идемпотентное ожидаемое поведение; скрытой ошибки нет.** Доказательства:

| # | Доказательство |
|---|---|
| 1 | Ошибка — **не** в транзакции: `storage/postgres/database.js:32-39` — каждая `query()` выполняется на своём соединении пула в **auto-commit**; `withTransaction()` для этого кода не используется ⇒ падение одного DDL **не** каскадирует и **не** прерывает последующие шаги ensure. |
| 2 | Падение `ALTER TABLE … ADD CONSTRAINT` при существующем ограничении — **no-op**: схема не меняется. Подтверждено Stage 111 §3.3 (схема идентична Stage 93 дампу; единственные отличия — случайные `\restrict`/`\unrestrict`) и проверено здесь: `pg_constraint` содержит ровно одно `users_username_unique UNIQUE (username)`; `pg_indexes` — `users_pkey, users_email_key, users_username_unique, idx_users_username_lower`. |
| 3 | Ограничение **реально и валидно** (создано в какой-то из первых миграций; данные ему удовлетворяют). |
| 4 | Строка в PG-логе — это **серверное** логирование неудачного оператора; его нельзя подавить со стороны клиента без изменения самого DDL. Функционального влияния нет. |
| 5 | **Хроническое поведение, не регрессия:** в PG-логе **19 909** таких ERROR на **19 909 различных метках времени** (т.е. ровно одна на каждый старт backend), впервые — `2026-08-19 12:33:02.066Z`. Основная масса приходится на прогоны тест-наборов Stages 66–76 против живой PG (700 — 2026-10-13, 508 — 2026-10-18, 390 — 2026-10-14); в production-окне 2026-10-17…10-21 — 4 + 17 + 4, включая старт cutover `2026-10-21 13:15:40.353Z`, а также `2026-10-19 06:32:10.536`, `2026-10-21 06:33:26.148`, `06:50:46.389`, `09:13:33.774`. |
| 6 | **Строка 1211 — единственный «add-only» constraint в файле.** Все остальные (`791 scene_assets_status_check`, `843 agent_sessions_status_check`, `858 agent_steps_step_type_check`, `1432/1435/1484/1488 workers_*`) выполняются по схеме `DROP CONSTRAINT IF EXISTS` → `ADD CONSTRAINT` и потому идемпотентны по построению. |

**Побочные эффекты (незначительные, но фиксируемые):**
* одна строка `ERROR` в серверном логе PG на каждый старт (шум мониторинга/алертов);
* PostgreSQL берёт **ACCESS EXCLUSIVE lock** на `users` до обнаружения дубликата имени ⇒ кратковременная блокировка небольшой таблицы в момент старта;
* формулировка Stage 109 §B.4 п.13 «миграции **не выполнялись**» неточна: `runMigrations()` (schema-ensure) **выполняется на каждом старте**; он идемпотентен и схему не меняет. Stage 111 это уже отметила.

---

# D. Итоговая классификация

| # | Пункт | Класс | Ключевое доказательство |
|---|---|---|---|
| A1 | Текущее число задач по статусам зафиксировано | **CONFIRMED** | PG `generation_tasks` 17 (completed 8 / cancelled 9); `scene_assets` 459; `image_units` 58; Redis: активных сцен 2, `runtime:active-image=2`, тик `Active 2 / Dispatched 0 / Skipped 2`, `dbsize 321` |
| A2 | **306 → 457 подтверждено источниками** | **CONFIRMED** | 34×9=306 (base-gpu.json), 35×9=315 (post-gpu.json), 43×9+7×10=457 (живое) — совпадение **точное**; все 50 `dispatch_id` очереди сопоставлены с журналом сцен |
| A3 | GPU недоступен: `gpus:0`, 7/7 workers `offline`, 0 heartbeat, 0 `iu-in-flight` | **CONFIRMED** | `redis-cli SCAN` (321 ключ), `SELECT … FROM workers`, лог hub'а (0 `📤 Result`), `/proc/net/tcp` контейнера (нет соединений на :5000) |
| A4 | Lease живы и обновляются (TTL 1380 с, renewal ~30 с) | **CONFIRMED** | `TTL` + `[LEASE] RENEWED … (ttl re-pinned to 1380s)` в логе backend |
| A5 | `Skipped: 2` — не сбой, а guard `lease_active` | **CONFIRMED** | `dispatch-engine.js:696-715` (`shouldSkipDispatch`) → `runtime-scheduler.js:465-466` |
| A6 | Рост вызван: graceful-рестарт → cancel → `orphan_generating_repair` → re-dispatch → дубль enqueue (dedup по `job_id+dispatch_id` не работает); исполнителя нет | **CONFIRMED** | `backend.cjs:987-1000`, `reconciliation-engine.js:1199-1243`, `dispatch-engine.js:457-482`, `gpu-hub.js:829-847`; 50 раундов восстановлены по журналу |
| A7 | **PRE-EXISTING**: отсутствие GPU и рост очереди не являются регрессией cutover | **PRE-EXISTING** | `gpus:0` и очередь 306 зафиксированы 2026-10-14 (base-gpu.json), первый раунд — 2026-08-30 |
| A8 | **PRE-EXISTING / NEEDS ACTION**: 438 дубликатов (95,8 % очереди) — накопившийся мусор | **PRE-EXISTING** (происхождение) + **NEEDS ACTION** (чистка) | подсчёт уникальных `job_id`/`dispatch_id` |
| A9 | 19 уникальных задач **ждут** GPU/воркера, а не застряли | **CONFIRMED** | ни одного `_iu-*.png` для этих сцен на диске; `iu-in-flight` 0; `running` отсутствует; 0 результатов в логе hub'а |
| A10 | 8 записей глобальной lane (книги 2026-07-11/12) | **CONFIRMED** (факт) / **NEEDS ACTION** (решение) | `LRANGE animastor:queue:image` |
| B1 | Точная запись найдена: `scene_assets` id **25096/25097/25098/25100** | **CONFIRMED** | `SELECT … WHERE path LIKE '%/b1/%'` |
| B2 | Файла по `b1`-пути нет; каталог `b1` отсутствует; basename встречается ровно 1 раз, SHA-256 `e30eebc2…` (579 008 Б) | **CONFIRMED** | `ls`, `sha256sum`, Stage 93/109 baselines (0 совпадений) |
| B3 | В БД `scene_assets` — единственное место со ссылкой на `b1`; Redis и манифесты указывают на канонический путь | **CONFIRMED** | `HGETALL` трёх ключей, `grep -r output/b1` по `data/` (0), Stage 65 (4 совпадения только в `scene_assets`) |
| B4 | Это **старые импортированные записи с несогласованностью пути**, не актуальный production-артефакт, не потеря данных | **PRE-EXISTING** | даты 2026-08-26 10:38–10:50 против канонической 12:55; Stage 65/70/75 |
| B5 | Долговременный архив не создан, batch C не выполнялся | **NEEDS ACTION** | `/tmp/opencode/stage75/deadpath-archive-preview.json` есть (sha `deed59fcf…`), `reorg-2026-10-17/stage76-archive/` — отсутствует; живые строки идентичны preview |
| B6 | Точное происхождение литерала `b1` (какой runtime-код подставлял такой buildId) | **INCONCLUSIVE** | `"output/b1"` отсутствует в истории исходников backend; `git log --all -S "output/b1"` → только тестовая фикстура |
| C1 | `schema.js:1211` — `ADD CONSTRAINT` без `IF NOT EXISTS`, ошибка «already exists» проглатывается | **CONFIRMED** | код 1204-1217 |
| C2 | Это **ожидаемое идемпотентное поведение**, скрытой ошибки нет | **CONFIRMED** | auto-commit без транзакции (`database.js:32-39`); схема == Stage 93; `pg_constraint` — одно корректное ограничение; 19 909 ERROR в PG-логе на 19 909 стартов backend (с 2026-08-19) |
| C3 | Уточнение формулировки Stage 109 («миграции не выполнялись») | **PRE-EXISTING** неточность | `runMigrations()` вызывается из `storage/postgres/index.js:5` (`initialize()`) при каждом старте |

---

# E. Предлагаемый следующий этап (НЕ применяется в этом этапе)

Предлагается оформить как **Stage 113** (отдельный этап с отдельным approval). Ничего из перечисленного не выполнено.

### E.1. Доступность GPU (устранение корневой причины)
* Поднять image-воркер для workspace `3317e019-879d-4dfb-a9f8-edc9b72da7f4` (`e2e-qwen-image` зарегистрирован, но `offline`) либо развернуть system/shared image-воркер. **Альтернатива** (осознанный продуктовый выбор): явно приостановить (cancel) image-стадию этих двух сцен, чтобы backend не диспетчеризовал её на каждом старте.
* Проверка приёмки: `GET /health` hub'а показывает `gpus ≥ 1`; появляются ключи `animastor:worker:heartbeat:image:*`; очередь убывает; в логе hub'а появляются `📤 Result:`.

### E.2. Идемпотентность enqueue (минимальное безопасное изменение)
Проблема: dedup hub'а привязан к `dispatch_id`, который всегда нов ⇒ повторы не схлопываются.
* **Минимальный вариант (рекомендуется):** в обработчике `POST /task` hub'а (`gpu-hub.js:767`) перед `LPUSH` проверять, не присутствует ли в целевой lane запись с тем же `job_id` (тот же `build_id` + `workspace_id`); при совпадении — не добавлять вторую копию, а вернуть `ok` с пометкой `duplicate_queued`. Это идемпотентно по job и **не** ломает легитимный retry: если задача уже была выдана воркеру (popped), её копии в lane отсутствуют и повтор пройдёт.
* Альтернатива (backend): перед re-dispatch image-стадии проверять, что в lane нет ещё не выполненных IU-задач этой сцены (или глубину очереди/наличие свободного воркера) и воздерживаться от диспетчеризации.
* Обязательно: регрессионные тесты (a) повторная отправка того же `job_id` с новым `dispatch_id` не создаёт вторую запись; (b) задача, уже выданная воркеру, может быть отправлена повторно.

### E.3. Чистка накопленных дублей (write-операция, требует approval)
* Для 2 сцен/1 книги: `DELETE /queue/clear?book_id=import_1786345731767_1786345734345` — существующий, покрытый endpoint (`gpu-hub.js:1919`), фильтрует по `book_id` и корректно чистит **ws-lane**, `running`, `result:*` и dedup-ключи. Ожидаемый эффект — удаление 457 записей этой книги (остаются 8 глобальных). **Перед вызовом:** снять контрольный снимок (LRANGE + SHA-256) и сохранить его как evidence.
* Для 8 глобальных записей (книги 2026-07-11/12, без `workspace_id`) — отдельное решение владельца (полный clear недопустим: снёс бы и ws-lane).

### E.4. Legacy-путь `b1` (Stage 75 batch C)
1. Записать долговременный архив `reorg-2026-10-17/stage76-archive/deadpath-4.json` (полный `row_to_json` 4 строк) + sidecar с SHA-256 и списком id. Готовый превью-контент уже существует: `/tmp/opencode/stage75/deadpath-archive-preview.json`, sha256 `deed59fcf2df90e84cf576fae40c7a6c496f2599feb3f03154eba6c6d6bc361f`, id `25096,25097,25098,25100` (живые строки ему идентичны — проверено).
2. Перечитать архив непосредственно перед удалением, сверить SHA-256 и состав id.
3. Удалить 4 строки (только `scene_assets`), снять пост-проверку: `scene_assets` 459 → 455, `build_id IS NULL` 437 → 433, каноническая строка 25101 и файлы не тронуты, `/data/output/b1` по-прежнему отсутствует.

### E.5. Идемпотентность schema-ensure (`schema.js:1211`)
Рекомендуется **вариант B** (без DROP-окна):
```js
const { rows } = await query(
  `SELECT 1 FROM pg_constraint WHERE conname='users_username_unique' AND conrelid='users'::regclass`);
if (rows.length === 0) {
    await query(`ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username)`);
    console.log('[PG] Added unique constraint on users.username');
}
```
(вариант A — `DROP CONSTRAINT IF EXISTS` + `ADD` — уже применён в коде для `workers_*`, но оставляет краткое окно без ограничения; для `users` предпочтителен вариант B.)
Плюс: регрессионный тест «второй `runMigrations()` на уже смигрированной БД не даёт ни одной ERROR в логе PG» и правка формулировки runbook'а: «schema-ensure выполняется при старте, идемпотентен и не изменяет схему».

---

# F. Границы этапа — соблюдены

| Ограничение | Статус |
|---|---|
| Только read-only | ✅ операции: `docker inspect/logs/ps`, `curl` к `/health` (GET), `redis-cli` SCAN/TYPE/LLEN/LRANGE/TTL/GET/HGETALL/HLEN, `psql` только SELECT, `find`/`sha256sum`/`ls`/`grep`. Ни одной команды записи |
| Не запускать генерацию | ✅ ни одного `POST /task`, `/task/next`, `/regenerate`; файлов `data/**` новее cutover — **0** |
| Не менять статусы, leases, очередь, workers, настройки | ✅ `LPUSH/LPOP/SET/DEL/EXPIRE` не выполнялись; `POST /queue/clear` **не вызывался**; leases не трогались (только `TTL`/`GET`) |
| Не менять PostgreSQL / Redis / книги / output / hooks | ✅ `scene_assets` 459/437 — как в Stage 111; `dbsize` 321 — как в Stage 111; `data/books` 61 файл (sha `200beb1a…`) и `data/output` 95 файлов (sha `2a03a8c7…`) — **побайтово идентичны** снимкам Stage 111 (`diff` пуст) |
| Не удалять файлы/архивы/бэкапы/временные данные | ✅ ничего не удалено; существующие архивы `stage93-data-2026-10-20`, `stage75/*`, `stage76`-preview сохранены как есть |
| Не выполнять deploy / restart / push / CI / миграции | ✅ контейнеры не перезапускались: `RestartCount=0` у всех; `StartedAt` backend `2026-10-21T13:15:38.819Z` (как в Stage 111), gpu-hub `2026-10-12T13:41:43Z`, pg/redis `2026-08-24T16:30:12Z`; `git status` backend — dirty-набор **тот же** (1 D, 4 M, 2 ??), HEAD `53ce5045`; gpu-hub HEAD `0f489c7b`, чистый |
| Секреты | ✅ `GPU_HUB_API_KEY`, `PG_PASSWORD`, токены воркеров не вынесены в отчёт (только факт наличия/отсутствия) |
| Записи на диск этим этапом | только `/tmp/opencode/s112/*` (снимки очереди, журналов, ключей, инвентарей) и настоящий отчёт |

---

# G. Итог

**Статус: WARN.**

* **Причина роста очереди (доказана полностью):** GPU-исполнителей нет (`gpus:0`, 7/7 workers `offline`, 0 heartbeat, 0 `iu-in-flight`, 0 результатов в логе hub'а), а при каждом **graceful-рестарте backend** остановка отменяет активный image-диспатч → на старте reconciliation считает генерацию мёртвой (`orphan_generating_repair`) → image-стадия диспетчеризуется заново ⇒ hub добавляет **те же 9/10 IU-задач** ещё раз, потому что его dedup-ключ включает **новый** `dispatch_id` и никогда не срабатывает. Отсюда 306 (2026-10-14) → 315 (2026-10-14) → **457** (сейчас) — арифметика сходится **точно** (34→35→43 раундов `sc-45c789c6` и 7 раундов `sc-5f18dd0f`). Из 457 записей **19 уникальных** (ждут GPU), **438 — дубликаты** (мусор).
* **Две сцены:** `sc-45c789c6` (9 IU) и `sc-5f18dd0f` (10 IU) — корректно задиспетчеризованы, lease жив (TTL 1380 с, renewal ~30 с), состояние `image=generating`; `Skipped: 2` — штатный guard `lease_active`, не сбой; изображений для этих сцен на диске нет ⇒ работа не потеряна, а не начата; рост очереди дают только graceful-рестарты.
* **MP4:** 4 legacy-записи `scene_assets` (25096/25097/25098/25100) указывают на несуществующий `/data/output/b1/…` (созданы 2026-08-26 10:38–10:50); тот же артефакт существует по каноническому пути `build_import_…` (579 008 Б, SHA-256 `e30eebc2…`, строка 25101 от 12:55:23Z) и во всех Redis/манифестах. **Потери файла нет** — это несогласованность пути в старых импортированных записях (PRE-EXISTING). Долговременный архив и batch C (Stage 75) не выполнены → NEEDS ACTION.
* **Schema ensure:** `schema.js:1211` — ожидаемое идемпотентное поведение; падение `ADD CONSTRAINT` в auto-commit без транзакции, схема не меняется, скрытой ошибки нет; 19 909 ERROR в PG-логе на 19 909 стартов backend (с 2026-08-19, по одному на старт) — хронический шум. PRE-EXISTING; минимальная идемпотентная правка предложена в §E.5.
* **Необходимые следующие действия:** (1) Stage 113 — поднять image-воркер или осознанно приостановить эти две сцены; (2) Stage 113 — идемпотентный enqueue в hub'е (dedup по `job_id`, а не по `job_id+dispatch_id`) + регресс-тесты; (3) Stage 113 — чистка 438 дублей через существующий `DELETE /queue/clear?book_id=…` после снятия evidence-снимка, и отдельное решение по 8 глобальным записям; (4) Stage 113 — долговременный архив 4 dead-path строк и batch C удаления по процедуре Stage 75; (5) Stage 113 — идемпотентный `schema.js:1211` + тест + правка формулировки runbook'а. **В рамках Stage 112 ничего не применялось.**
