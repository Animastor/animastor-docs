# Stage 113 — GPU queue deduplication and worker recovery plan (read-only, design only)

**Дата проверки:** 2026-10-22, окно **03:10Z → 03:55Z**.
**Объект:** production после Stage 109 cutover + Stage 112 (диагностика роста очереди и отсутствующего asset).
**Режим:** строго read-only + **проектирование**. Изменений работающей системы не вносилось: генерация не запускалась, статусы/leases/очередь/БД/Redis/файлы/конфигурация workers **не изменялись**, сервисы **не перезапускались**, push/CI/GHCR/deploy **не выполнялись**, дубликаты **не удалялись**.
**Итог: WARN** — причина отсутствия исполнителей и механизм роста очереди доказаны на уровне кода; стратегия идемпотентности спроектирована и покрыта **19 изолированными тестами (все зелёные) + 7 conformance-тестами на реальном Redis (все зелёные) + воспроизведением дефекта на реальном коде hub-а**. Требуются отдельные этапы; ничего не применено.

---

## 0. Источники, метод, ограничения

| Источник | Что взято |
|---|---|
| Stage 112 `reorg-2026-10-19/112-gpu-queue-missing-asset-diagnosis.md` | baseline: 457 записей ws-lane, 19 уникальных `job_id`, 50 `dispatch_id`, `gpus:0`, 7 workers `offline`, 4 dead-path строки `scene_assets`, `schema.js:1211` |
| Живые системы (read-only) | `docker inspect/logs`, `GET http://gpu-hub:5000/{health,installer,installer/sha256,worker-bundle/sha256}`, `redis-cli` (SCAN/TYPE/LLEN/LRANGE/TTL/GET/HGETALL), `psql` (только SELECT), `GET https://animastor.org/gpu/health` |
| Код | `animastor-gpu-hub/gpu-hub.js`; `animastor-backend/backend/src/**`; `animastor-backend/packages/animastor-orchestration/src/**`; `animastor-worker/packages/animastor-worker/worker/**` |
| Изолированные прототипы | `/tmp/opencode/s113/` — `lib/mem-redis.js`, `lib/task-idempotency.js`, `test-idempotency.cjs`, `test-current-hub-behavior.cjs`, `test-real-redis-conformance.cjs` |

**Метод.** Три независимых артефакта, все воспроизводимы:
1. **Прототип исправления** (`task-idempotency.js`) — исполняемая спецификация идемпотентности; 19 тестов на hermetic in-memory Redis.
2. **Воспроизведение дефекта на реальном коде** (`test-current-hub-behavior.cjs`) — настоящий `gpu-hub.js` (read-only `require`), 50 re-dispatch → 50 записей в lane.
3. **Conformance на реальном Redis** (`test-real-redis-conformance.cjs`) — изолированный контейнер `repro-redis` (Redis 7.4.9), **db 15**; production Redis (`animastor-redis`, db0) не затрагивался.

**Что НЕ делалось:** ни одной записи в production Redis/PG/файлы/очередь; ни одного `LPUSH/LREM/SET/DEL` в production; ни одного рестарта; ни одного изменения в репозиториях (прототипы вынесены в `/tmp`, репозитории остались в исходном состоянии: backend dirty-набор 7 записей — тот же; gpu-hub — 0).

---

# A. Доступность GPU workers

## A.1. Жизненный цикл worker'а (факты из кода)

| Шаг | Код | Что делает | TTL/срок |
|---|---|---|---|
| Регистрация | `worker-routes.cjs:196` `POST /api/v1/workers` → `worker-repo.createWorker` | создаёт строку в PG `workers` (`status` DEFAULT `'offline'`), выдаёт **одноразовый** Worker Key (`token_prefix` вида `wrk_ofkr6Lcb`) | бессрочно, пока не отозван |
| Зеркало в Redis | `animastor:worker-auth` (hash) | копия учётных данных для hub'а; hub'а **никогда не пишет** этот ключ | без TTL |
| Самопроверка | `worker-routes.cjs:174` `POST /api/v1/worker/verify` → `workerRepo.touchLastSeen` | единственное место, где обновляется PG `last_seen` | — |
| Beacon | `worker.cjs:226` `sendBeacon()` → `POST {HUB_URL}/beacon` (`gpu-hub.js:698`) | пишет `animastor:worker:heartbeat:{type}:{worker_id}` | **EX 30 с** (`gpu-hub.js:744-746`) |
| Регистрация GPU | `gpu-hub.js:731` `setGpuInRedis` → hash `animastor:gpu-hub:workers` | источник значения `gpus` в `/health` | **EX 900 с** (`gpu-hub.js:352-357`) |
| Получение задачи | `worker.cjs:258` `getTask()` → `GET {HUB_URL}/task/next` (`gpu-hub.js:895`) | `RPOPLPUSH` из lane'а, соответствующего credential'у | claim-ы живут в `animastor:processing` |
| Периодичность | `worker.cjs:65` `BEACON_INTERVAL_MS = 10000`; `worker.cjs:571` `setInterval(sendBeacon, 10 s)` | 10 с < TTL 30 с ⇒ корректно | — |
| GPU discovery | `worker.cjs:179` `getGPUInfo()` → `execSync('nvidia-smi …')` | при отсутствии `nvidia-smi` возвращает `{name:'unknown', vram:'unknown'}` — **воркер зарегистрируется даже без GPU** | — |

**Ключевой факт о маршрутизации:** `gpu-hub.js:945-950` — private-воркер может попасть **только** в lane своего workspace (`queue:{type}:ws:{workspace_id}`), system/share — только в общий пул. Lane определяется credential'ом, не телом запроса.

**Ключевой факт о выборе lane'а на стороне backend:** `gpu-dispatcher.js:62-79` `workspaceHasPrivateWorker()` → `worker-repo.js:216` `hasActivePrivateWorkerOfType()` — запрос
```sql
SELECT 1 FROM workers WHERE workspace_id=$1 AND worker_type=$2 AND mode='private' AND revoked_at IS NULL LIMIT 1
```
То есть маршрутизация в **private ws-lane** опирается на **факт регистрации**, а **не на живость** (`last_seen`/heartbeat не проверяются). Для workspace `3317e019-…` в БД есть незарегистрированно-отозванный, но **не отозванный** image-воркер `e2e-qwen-image` ⇒ задачи уходят в **private ws-lane**, который умеет читать только этот (мёртвый) воркер.

## A.2. Диагноз `offline` по каждому из 7 workers

| # | worker | type | mode | workspace | создан | `last_seen` (последний `POST /worker/verify`) | revoked | **Причина offline** | Класс |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `parity-test-gpu` | image | private | `a6df593b…` | 2026-08-21 13:22:25 | NULL | **2026-08-21 13:22:41** (через 16 с) | **Отозван** (`revoked_at` задан) ⇒ токен невалиден ⇒ `POST /beacon` → 401 (`gpu-hub.js:176-189`) | CONFIRMED |
| 2 | `e2e-audio` | audio | private | `3317e019…` | 2026-08-24 17:48:03 | 2026-08-26 02:56:58 | — | Процесс воркера больше не существует; heartbeat истёк (TTL 30 с) | PRE-EXISTING |
| 3 | `e2e-qwen-image` | image | private | `3317e019…` | 2026-08-26 02:59:30 | **2026-08-26 03:01:19** | — | То же — **последний image-воркер этого workspace**, мёртв с 2026-08-26 | PRE-EXISTING |
| 4 | `e2e-ltx-2_3` | video | private | `3317e019…` | 2026-08-26 03:44:40 | 2026-08-28 03:10:29 | — | Процесс больше не существует | PRE-EXISTING |
| 5 | `e2e-qwen-tts-50` | audio | private | `3317e019…` | 2026-08-27 06:29:44 | **NULL** | — | Никогда не подтверждал себя (`/worker/verify` не вызывался) ⇒ токен выдан, но воркер не запускался | PRE-EXISTING |
| 6 | `vps-audio` | audio | private | `3317e019…` | 2026-08-28 11:35:02 | 2026-08-31 04:50:36 | — | Процесс больше не существует (последний heartbeat **любого** worker'а в системе) | PRE-EXISTING |
| 7 | `docker-e2e-audio` | audio | private | `4ad7157c…` | 2026-08-30 17:03:55 | 2026-08-31 02:06:19 | — | То же; чужой workspace | PRE-EXISTING |

**Сводка по причинам:**

* **Ни один worker не является production-ресурсом** — все 7 имеют тестовые имена (`e2e-*`, `vps-audio`, `docker-e2e-audio`, `parity-test-gpu`), заведены E2E/тест-наборами 2026-08-21…08-30.
* **Ни один не был отключён «сломанной сетью» или «неверной регистрацией»**: во всех случаях причина — **отсутствие процесса** (или явный `revoked_at`). Регистрация корректна, токены выпущены, зеркало `animastor:worker-auth` синхронно с PG.
* **Последний heartbeat в системе — 2026-08-31 04:50:36Z** (`vps-audio`). Последний heartbeat **image**-воркера — **2026-08-26 03:01:19Z** (`e2e-qwen-image`).
* ⇒ **Первая запись ws-lane (2026-08-30 05:45:26Z) появилась ПОСЛЕ последнего heartbeat'а image-воркера** ⇒ **ни одна из 457 задач никогда не имела исполнителя.**
* **PG `workers.status = 'offline'` у всех 7 — это DEFAULT, а не наблюдение.** В production-коде колонка `status` **никогда не обновляется**: единственные `UPDATE workers` — `token_hash`, `revoked_at`, `last_seen` (`worker-repo.js:242, 258, 314, 326, 753`). Реальный статус выводится в `worker-setup-routes.cjs:60-74` `liveInfo()`: `REVOKED` (есть `revoked_at`) → `ONLINE` (есть Redis-heartbeat) → `OFFLINE`. **Это уточнение к Stage 112**: `status='offline'` не является самостоятельным доказательством; доказательством являются отсутствие heartbeat-ключей и `gpus:0`.

## A.3. Фактическое состояние GPU Hub и GPU-машины (без запуска/перезапуска)

| Проверка | Факт | Источник |
|---|---|---|
| `GET http://gpu-hub:5000/health` | `{"gpus":0,"queues":{"image":8,"audio":0,"video":0},"workspace_queues":{…:457},"running":0}` | HTTP 200 |
| `GET https://animastor.org/gpu/health` (через nginx) | HTTP 200, тот же JSON ⇒ **публичный маршрут для удалённого воркера работает** | `proxy/conf/default.conf:163` |
| `GET https://animastor.in/gpu/health` | HTTP **301** → `https://animastor.org/gpu/health` ⇒ **кросс-доменный редирект** | см. A.5, п. 5 |
| Реестр GPU `animastor:gpu-hub:workers` | **отсутствует** ⇒ `gpus:0` | `redis-cli TYPE` |
| Heartbeat `animastor:worker:heartbeat:*` | **0 ключей** из 321 | `redis-cli --scan` |
| `animastor:running` / `animastor:processing` | отсутствуют ⇒ ни одна задача не выполняется | `TYPE` |
| Лог hub'а за всё время контейнера (с 2026-10-12 13:41Z) | 187 `📥 Task:` (enqueue), **0 `📤 Result:`** ⇒ ни одна задача не была выдана/возвращена | `docker logs gpu-hub` |
| Соединения контейнера hub'а | единственное ESTABLISHED — на `:6379` (Redis); на `:5000` никто не подключён | `/proc/net/tcp` |
| GPU на этом хосте | `nvidia-smi` **отсутствует**, `/dev/nvidia*` **отсутствует**, `lspci` → только `Virtio GPU` ⇒ **этот хост не является GPU-машиной** | хост |
| Compose-проект `animastor` | сервисы: backend, postgres, redis, nginx, **gpu-hub** — **worker-сервиса нет**; воркеры ставятся на внешние GPU-машины инсталлятором | `docker compose ps` |
| Артефакты инсталлятора в hub'е | `/installer` 200 (8 262 B), `/installer/sha256` 200, `/installer/bundle` 200 (181 447 B), `/worker-bundle` sha `3d23b4de…` (17 676 B, 8 файлов, `worker.cjs` в комплекте) | GET |
| Профиль image | `install-manifests/image/qwen-image.json` (revision `2026.08.27-r1`): ComfyUI (pin **не определён**), Python ≥ 3.10, ComfyUI-GGUF@`6ea2651e`, модели **≈21.2 GiB**, референс-GPU NVIDIA L40S (46068 MiB), `gpu_min_vram_gb: null` | манифест |

## A.4. Почему graceful shutdown приводит к отмене dispatch и повторной постановке

Полная цепочка (каждое звено — с точкой кода):

1. **SIGTERM → отмена активных диспатчей.** `backend.cjs:983-1003`: обработчик завершения получает `dispatchEngine.getActiveLeases(redis)` и для каждого lease вызывает `cancelActiveDispatch(..., 'graceful_shutdown')`.
2. **Отмена атомарно сносит lease и dispatch-meta.** `dispatch-engine.js:1080-1160` `finalizeDispatch(outcome='cancelled')` → Lua `claimFinalization` **удаляет** `dispatch-meta` и lease, уменьшает квоту; `dispatch-engine.js:1175-1188` — `releaseDispatchInFlightMarkers` (индекс маркеров; сами ключи маркеров остаются до TTL).
3. **FSM-состояние сцены остаётся `generating`.** Отмена не откатывает состояние. В журнале это видно как `DISPATCH_CANCELLED(graceful_shutdown)` → `SCENE_PENDING(orphan_generating_repair)` (откатывает именно reconciliation).
4. **Следующий старт backend'а: reconciliation считает генерацию мёртвой.** `reconciliation-engine.js:1196-1244` → `dispatchEngine.getDispatchEvidence()` (`dispatch-engine.js:457-482`) ищет `lease_present` → `dispatch_meta_present` → `iu_in_flight_present`; после п.2 **все три отсутствуют** ⇒ `GENERATING → DIRTY → PENDING` + возврат сцены в active-index.
5. **Scheduler диспетчеризует image-стадию заново с НОВЫМ `dispatch_id`.** `runtime-scheduler.js:457` → `attemptDispatch` → `dispatchStage` (`dispatch-engine.js:733`).
6. **Единственный guard против повторной постановки — `iu-in-flight` — оказывается обезврежен отменой.** `iu-processor.js:43-88` `checkInFlightMarker` считает маркер «живым» только если (а) владелец == текущий `dispatch_id`, либо (б) владелец == `dispatch_id` **активного** dispatch'а из `dispatch-meta`. После п.2 `dispatch-meta` удалён ⇒ условие (б) ложно, (а) ложно (новый id) ⇒ маркер признаётся **stale**, удаляется через `compareAndDeleteMarker` (`dispatch-engine.js:383`) ⇒ **IU отправляется заново**.
7. **Hub не может подавить повтор.** `gpu-hub.js:423-425` `jobDedupKey(job_id, dispatch_id)` = `animastor:job:{dispatch_id}:{job_id}`; `SET NX EX 3600` (`gpu-hub.js:829-847`). Новый `dispatch_id` ⇒ новый ключ ⇒ дедуп **никогда** не срабатывает ⇒ `LPUSH` добавляет **дубль**.

**Доказательство из данных (естественный эксперимент, сцена `sc-5f18dd0f`, 2026-10-18):**

| Время | Событие | Hub-enqueue | Вывод |
|---|---|---|---|
| 03:12:56 | image `DISPATCH_STARTED` → `IMAGE_DISPATCHED` | **10 задач** (лог hub'а 03:12:56) | базовая постановка |
| 03:17:41 | `DISPATCH_CANCELLED(graceful_shutdown)` | — | отмена |
| 03:17:47 | **только audio-стадия** диспетчеризована; image-стадия не запускалась (её asset-state ещё `generating`) | **0** | FSM не дал re-dispatch image |
| 03:33:43 | `SCENE_PENDING(orphan_generating_repair)` | — | reconciliation откатил image |
| 03:33:45/46 | image `DISPATCH_STARTED` → `IMAGE_DISPATCHED` | **10 задач** | повторная постановка |

Между двумя enqueue — **1249 с**; TTL in-flight маркера `IU_IN_FLIGHT_TTL_S = 1200` (`runtime-config.js:211`) — маркер истёк за **49 с** до повторной постановки. Все 50 enqueue-раундов в production разделены **≥ 1210 с** (минимум по журналу) — ни один не попал внутрь TTL-окна, при этом каждый создал полный дубликат.

**Дополнительный факт (важен для плана):** `dispatch-meta.retry_attempt` **захардкожен в 0** (`dispatch-engine.js:262`) — у системы **нет** счётчика попыток, который можно было бы использовать как измерение идемпотентности. Retry-budget (`retry-budget-manager.js:35`) — это **бюджет** («сколько раз ещё можно»), а не номер попытки.

**Дополнительный факт (результат дубликатов):** backend проверяет `dispatch_id` результата (`verifyDispatchIdentity`, `generation-routes.cjs` до строки 490). ⇒ **результаты от 42 из 43 копий одного IU будут отклонены как `stale_dispatch`** — дубликаты не просто тратят GPU-часы, они дают бесполезные результаты.

## A.5. Минимальный план восстановления workers (отдельный этап; ничего не выполнялось)

> Требуется **внешняя GPU-машина** (этот хост — `Virtio GPU`, `nvidia-smi` отсутствует). Установка инсталлятором — **write-операция на чужом хосте**, поэтому она выносится в отдельный, одобренный этап.

| # | Шаг | Команда/действие | Проверка после шага (PASS-критерий) |
|---|---|---|---|
| 1 | **Выпустить новый Worker Key** для workspace `3317e019-…`, type `image`, в UI (Settings → Private Workers) **или** `POST /api/v1/workers` | токен показывается один раз; **не** попадает в отчёт/лог | `SELECT name, worker_type, status, token_prefix FROM workers WHERE workspace_id='3317e019…'` — новая строка, `token_prefix` вида `wrk_…`; старый `e2e-qwen-image` **не трогаем** (историческая запись) |
| 2 | **Подготовить GPU-машину**: NVIDIA GPU (референс L40S 46 GB; минимум VRAM в манифесте не зафиксирован — `gpu_min_vram_gb: null`), ≥ 25 ГБ свободного диска (≈21.2 GiB моделей + ComfyUI + venv), Node.js ≥ 20, `curl`/`wget`, `tar`, `sha256sum`, Python ≥ 3.10 | проверка пререквизитов инсталлятором | `nvidia-smi` печатает модель и VRAM; `df -h` показывает запас; `node -v` ≥ 20 |
| 3 | **Установить через bootstrap-скрипт hub'а** | `curl -fsSL https://animastor.org/gpu/installer \| bash` — **интерактивно** вставить Worker Key (скрипт принципиально отказывается принимать токен через env/аргументы) | инсталлятор завершится кодом 0; появится `$HOME/.animastor-installer/install-state.json` с `components`; `nvidia-smi` по-прежнему доступен |
| 4 | **Проверить, что worker пишет `HUB_URL=https://animastor.org/gpu`** | проверить `.env` рядом с `worker.cjs` | ⚠ **Важно:** bootstrap по умолчанию качает бандл с `https://animastor.in/gpu`, а `animastor.in` отдаёт **301** на `animastor.org`; кросс-доменный редирект в Node `fetch` **снимает заголовок `Authorization`** ⇒ beacon получит 401. Поэтому: использовать канонический `https://animastor.org/gpu` и **не** передавать `--hub-url https://animastor.in/gpu`. Проверка: `curl -sI https://animastor.org/gpu/health` → 200 без редиректа |
| 5 | **Запустить worker** | `node worker.cjs` (или `start-worker.sh`) из каталога бандла | в логе worker'а — успешные beacon'ы (`BEACON_INTERVAL_MS = 10 c`); `GET /gpu/health` → `gpus ≥ 1` |
| 6 | **Проверить регистрацию в hub'е** | `redis-cli EXISTS animastor:gpu-hub:workers` / `HLEN` | `HLEN ≥ 1`; `HGET animastor:gpu-hub:workers <worker_id>` содержит `type=image`, `workspace_id=3317e019…`, `protocol_version` |
| 7 | **Проверить heartbeat** | `redis-cli GET animastor:worker:heartbeat:image:<worker_id>` | ключ существует, `ts` обновляется (TTL 30 c ⇒ обновлять раз в ~10 c) |
| 8 | **Проверить UI-статус** | `GET /api/v1/private-worker/setup/workers/<worker_id>` (авторизованный запрос владельца workspace) | `base_status: "ONLINE"` (`worker-setup-routes.cjs:60-74`) |
| 9 | **Проверить, что очередь начала убывать** | `GET /gpu/health` дважды с интервалом 60 c | `workspace_queues[…]` уменьшается; в логе hub'а появляются `📤 Result:` |
| 10 | **Откат при неудаче** | остановить worker-процесс; при необходимости `DELETE /api/v1/workers/<id>` (отзыв) | `workers.revoked_at` задан; heartbeat-ключ исчезает; очередь **перестаёт расти** (после п. B.5 — не расти совсем) |

**Риски и предосторожности:**
* **Пока исполнителя нет — очередь будет расти на каждом graceful-рестарте backend'а.** Поэтому §B.3/B.4 (идемпотентность) и §B.5 (гейт по наличию исполнителя) должны быть применены **до или одновременно** с шагом 3, иначе каждое рестартование backend'а добавит ещё +19 записей.
* Существующий `e2e-qwen-image` **не переиспользовать**: его токен был выпущен в тестовом контуре; безопаснее выпустить новый.
* `SHARE_FEATURES_ENABLED=1` на hub'е ⇒ при наличии активной share-policy private-воркер может заимствовать общий пул; для image-профиля system-пул пуст ⇒ этого не произойдёт.

---

# B. Дедупликация очереди

## B.1. Реальная схема очереди, ключи и алгоритм dedup

**Ключи Redis, задействованные в очереди (hub — единственный владелец lane'ов):**

| Ключ | Тип | Назначение | Владелец |
|---|---|---|---|
| `animastor:queue:{type}` | list | **system pool** (без `workspace_id`) | hub |
| `animastor:queue:{type}:ws:{workspace_id}` | list | **private lane** workspace'а | hub |
| `animastor:queue:{type}:policy:{policy_id}` | list | lane выданной users-policy (SH-2) | hub |
| `animastor:processing` | list | in-flight claim (RPOPLPUSH-цель) | hub |
| `animastor:running` | hash | метаданные выполняющихся задач | hub |
| `animastor:job:{dispatch_id}:{job_id}` | string | **dedup enqueue** hub'а, `SET NX EX 3600` | hub |
| `animastor:result:*` / `animastor:error:*` | string | доставка результата/ошибки в backend | hub |
| `animastor:dispatch-lease:{book}:{ch}:{sc}:{stage}` | string | lease (token), TTL, обновляется каждые ~30 c | backend |
| `animastor:dispatch-meta:{book}:{ch}:{sc}:{stage}` | string | метаданные диспатча (`dispatch_id`, `lease_token`, `quota_owned`, `retry_attempt`) | backend |
| `animastor:iu-in-flight:{book}_{ch}_{sc}_{unit}` | string | **guard от повторной отправки IU**, TTL 1200 c | backend |
| `animastor:iu-in-flight-index:{dispatch_id}` | set | индекс маркеров диспатча | backend |
| `animastor:result-processed:{dispatch_id}:{job_id}:{build_id}` | string | **dedup результата** backend'а, `SET NX EX 3600` | backend |
| `animastor:worker-auth` | hash | зеркало учётных данных воркеров | backend (hub только читает) |

**Идентификаторы:**
* `job_id` = `{book}_{chapter}_{scene}_{unit}:{kind}` (напр. `import_…_ch-1bb5123c_sc-45c789c6_iu-5d64fc7d:iu_image`) — **стабильный** между диспатчами; парсится `job-schema.parseJobId`.
* `dispatch_id` = `dispatch-{epoch_ms}-{rand}` — **меняется на каждом** re-dispatch'е (создаётся в `dispatchStage`, `dispatch-engine.js:733+`).
* `lease` — пара `(lease_key, lease_token)`; `lease_active` ⇒ guard `shouldSkipDispatch` (`dispatch-engine.js:696-715`).

**Алгоритм dedup в текущем коде — и где он ломается:**

| Слой | Ключ | Слабость |
|---|---|---|
| enqueue (hub) | `animastor:job:{dispatch_id}:{job_id}`, `NX EX 3600` | `dispatch_id` входит в ключ ⇒ **не подавляет re-dispatch**; TTL 3600 c короче наблюдавшихся интервалов (до 11 ч) |
| in-flight guard (backend) | `animastor:iu-in-flight:{book}_{ch}_{sc}_{unit}`, TTL 1200 c | **обезвреживается отменой** (A.4, п. 2/6): после удаления `dispatch-meta` маркер всегда признаётся stale |
| «DEDUP-CLEAR» в backend | `redis.del('animastor:job:{iu}:iu_image')` (`iu-processor.js:206-213`) | **неверный формат ключа** — hub пишет `animastor:job:{dispatch_id}:{job_id}` ⇒ операция является **no-op** относительно реальных ключей hub'а |
| «DEDUP-CLEAR-BACKEND» | `redis.del('animastor:result-processed:{iu}:iu_image:{buildId}')` (`iu-processor.js:275, 307`) | **тот же неверный формат** — реальный ключ backend'а содержит `dispatch_id` ⇒ тоже **no-op** |
| result dedup (backend) | `animastor:result-processed:{dispatch_id}:{job_id}:{build_id}` (`generation-routes.cjs:490`) | `dispatch_id` ⇒ повторная доставка результата **из другого** dispatch'а **не дедуплицируется** (хотя комментарий hub'а `gpu-hub.js:831` описывает именно dispatch-независимый ключ) |

**Итог: ни один dedup-слой в системе не подавляет повторную постановку одной и той же логической задачи.**

## B.2. Доказательство: какие из 457 записей — повторные представления одной логической задачи

> Требование задания: «Не считать одинаковую сцену достаточным доказательством». Поэтому доказательство построено на **полном семантическом содержимом** записи.

**Метод.** Для каждой из 457 записей вычислен канонический SHA-256 (рекурсивно отсортированные ключи, массивы сохраняют порядок) над набором полей **без `dispatch_id` и без `assets`**:
`job_id, job_type, build_id, protocol_version, book_id, chapter_id, scene_id, stage, workspace_id, timeout_ms, assets, params`.
Отдельно посчитан SHA-256 **только** `params` (дерево ComfyUI-workflow: промпты, seed, модели, узлы).

**Результат:**

| Метрика | Значение |
|---|---|
| Всего записей в ws-lane | 457 |
| **Семантических групп** (исключая только `dispatch_id`) | **19** |
| Уникальных `job_id` | 19 (совпадает) |
| Уникальных `dispatch_id` | 50 |
| Размер группы | 7 (`sc-5f18dd0f`) или 43 (`sc-45c789c6`) |
| SHA-256 `params` внутри группы | **идентичен во всех копиях** |
| SHA-256 `params` между группами | **различен для всех 19** |
| Seed внутри группы | фиксирован (напр. `458007174637134`), prompt/модели различаются между IU |
| Сопоставление `dispatch_id` с журналом сцен | **50 из 50** найдены в `DISPATCH_STARTED` (0 несовпадений) |

**Вывод (CONFIRMED):** 457 записей = **19 логических задач**, каждая представлена 7 или 43 копиями с **побайтово идентичными** входными данными (включая seed и промпты). 438 записей (95,8 %) — **точные повторные представления**. Разные IU и разные версии входных данных **не** схлопываются (19 разных `params`-хэшей).

**Дополнительное доказательство из production-данных:** минимальный интервал между двумя enqueue-раундами одной сцены — **1210 с** (`2026-09-04T05:20:35Z → 05:47:05Z`), максимальный — **11 ч 13 м** (`2026-10-17T15:59Z → 2026-10-18T03:12:56Z`); интервалы **всегда > TTL in-flight маркера (1200 с)**, поэтому guard каждый раз успевал протухнуть.

**Воспроизведение дефекта на реальном коде:** `/tmp/opencode/s113/test-current-hub-behavior.cjs` — настоящий `gpu-hub.js`, in-memory Redis: **50 re-dispatch-ов с разными `dispatch_id` ⇒ 50 записей в lane** (4/4 проверок зелёные). Это доказывает, что дубликаты — **свойство кода**, а не разовое состояние.

## B.3. Предлагаемый устойчивый ключ идемпотентности

**Требования к ключу:** переживать повторную диспетчеризацию, рестарт и появление нового `dispatch_id`; **не** схлопывать разные IU; **не** схлопывать разные версии входных данных; **не** блокировать обоснованный retry.

**Предложение:**

```
task_identity = ( workspace_id, job_id, build_id )
input_version = sha256( canonicalJson(params) )        # меняется при смене промпта/модели/seed
generation_epoch = INCR-счётчик на (workspace_id, job_id), бамп только при обоснованном retry
idem_key = sha256( workspace_id | job_id | build_id | input_version | generation_epoch )
```

* `dispatch_id` **исключён** — он по определению меняется при каждом re-dispatch'е и потому непригоден как измерение идемпотентности.
* `input_version` защищает от «схлопывания ошибочно»: изменённый промпт ⇒ новая работа ⇒ новый `idem_key`.
* `generation_epoch` — единственное измерение, которое позволяет **обоснованному** retry пройти: счётчик принадлежит backend'у и инкрементируется **только** в двух местах:
  1. **израсходованный failure** — `orchestrator.failStage()` (`orchestrator.js:255`), где уже потребляется retry-бюджет (`finalizeDispatch(outcome='failure')`, `orchestrator.js:326-338`);
  2. **явная регенерация юнита** — ветка dirty-unit в `iu-processor.js:196` (сегодня она делает no-op `DEDUP-CLEAR` — заменяется на `bumpGenerationEpoch`).
  Обычный re-dispatch из reconciliation/restart **эпоху не меняет** ⇒ подавляется.
* Ключи в Redis:
  * `animastor:job-idem:{idem_key}` — «pending/running-claim», `SET NX EX` (постоянный до терминального состояния; TTL — только как backstop);
  * `animastor:job-done:{idem_key}` — «задача уже выполнена», ставится по терминальному result; блокирует повторную постановку до бампа эпохи;
  * `animastor:iu-epoch:{workspace_id}:{job_id}` — счётчик эпохи (INCR).

**Место enforcement'а:** hub, обработчик `POST /task` (`gpu-hub.js:767`) — он единственный знает фактическое содержимое lane'а и является точкой записи. Backend присылает `idem_key` в теле `/task` (вычисляется в `gpu-dispatcher.js:123` `sendUnified`).

**Альтернатива (индекс lane'а).** Вместо `SET NX` — SET-индекс pending-записей lane'а (`animastor:queue-idx:{type}:ws:{ws}`) с `SADD` при enqueue и `SREM` при pop/requeue. Семантика «не более одной **ожидающей** записи на задачу» выражается буквально, но требует правок в pop-пути (`/task/next`), в requeue-пути (sweep таймаутов) и в `/queue/clear`. **Рекомендация:** `SET NX` (вариант A) как основной — он атомарен и не требует правок в pop/requeue; индекс lane'а — только если понадобится отличать «pending» от «running».

## B.4. Конкурентные сценарии

| # | Сценарий | Поведение при текущем коде | Поведение при предложенной схеме | Комментарий |
|---|---|---|---|---|
| 1 | **Два dispatch'а одной задачи одновременно** | Оба `LPUSH` ⇒ 2 записи | `SET NX` ⇒ ровно одна запись | Атомарность `SET NX` в Redis; при равном `idem_key` победитель — первый |
| 2 | **Живой lease (задача уже в работе)** | Backend-side guard `shouldSkipDispatch` → `lease_active` ⇒ повторный dispatch не создаётся (уже работает) | То же + hub-side guard как второй эшелон | Guard'ы не конфликтуют: lease — на backend, idem — на hub |
| 3 | **Отмена при graceful shutdown → re-dispatch** | **Дубликат** (воспроизведено на реальном коде) | `idem_key` тот же (эпоха не бампнута) ⇒ enqueue отклонён ⇒ **1 запись** | Это и есть целевой сценарий |
| 4 | **Crash/restart backend'а** | Re-dispatch ⇒ дубликат | То же ⇒ дубликат **не** создаётся (claim живёт в Redis) | Claim не зависит от TTL-окна между рестартами |
| 5 | **Crash/restart GPU Hub'а** | Re-dispatch ⇒ дубликат | Claim в Redis переживает рестарт hub'а ⇒ дубликат **не** создаётся | |
| 6 | **Завершённая задача (артефакт на диске)** | Возможна повторная отправка (если PNG отсутствует) — но `probeIUImage` (`iu-processor.js:185`) даёт CACHE HIT и не отправляет | `animastor:job-done:{idem_key}` ⇒ enqueue отклонён, пока эпоха не бампнута | Двойная защита: артефакт на диске **и** маркер выполнения |
| 7 | **Обоснованный retry (failure / явная регенерация)** | Новая отправка (ожидаемо) | Эпоха бампается ⇒ новый `idem_key` ⇒ enqueue разрешён | Единственный путь, при котором повтор допустим |
| 8 | **Повторная доставка результата от worker'а** | Dedup-ключ содержит `dispatch_id` ⇒ **не дедуплицируется**, если диспатч другой | Ключ `animastor:result-processed:{job_id}:{build_id}` (без `dispatch_id`) ⇒ дедуплицируется | Отдельно: `iu-processor.js:275/307` должны чистить **этот** ключ, а не legacy-формат |
| 9 | **Разные IU одной сцены** | Разные записи (корректно) | Разные `job_id` ⇒ разные `idem_key` ⇒ обе ставятся | Проверено тестом |
| 10 | **Разные версии входных данных (промпт/модель)** | Разные записи (корректно) | Разный `input_version` ⇒ разные `idem_key` ⇒ обе ставятся | Проверено тестом |
| 11 | **Изменение build_id (пересборка)** | Новая запись | Новый `build_id` ⇒ новый `idem_key` | Проверено тестом |
| 12 | **Два разных workspace с одним и тем же job_id** | Разные lane'ы | `workspace_id` входит в ключ ⇒ разные `idem_key` | Изоляция сохраняется |
| 13 | **Ручная очистка очереди (`DELETE /queue/clear`)** | Ключи `animastor:job:*` удаляются для снятых задач (`gpu-hub.js:2014-2019`) | Дополнительно удалять `animastor:job-idem:*`/`job-done:*` для снятых задач | Иначе после очистки задача останется «занятой» |
| 14 | **Таймаут задачи на hub'е → requeue** | `gpu-hub.js:667-678` возвращает задачу в lane | Claim **не** освобождается (задача всё ещё pending) ⇒ повторная постановка по-прежнему подавляется | Корректно: задача не «потеряна» |
| 15 | **Lease протух (renewal остановлен) ⇒ `stale_lease`** | `cancelActiveDispatch` + re-dispatch ⇒ дубликат | Тот же `idem_key` ⇒ enqueue отклонён ⇒ без дубликата | Ключевая выгода: «устаревший» dispatch не порождает мусор |

## B.5. Безопасный порядок работ

> Каждый шаг — отдельный, одобряемый этап. **Ничего из перечисленного в Stage 113 не выполнялось.**

| Этап | Содержание | Зачем именно здесь |
|---|---|---|
| **113 → 114.1** | **Код + тесты** (без деплоя): (a) idem-ключ и `generation_epoch` в backend; (b) hub-guard в `POST /task`; (c) исправление форматов dedup-ключей (`iu-processor.js:206-213, 275, 307`, `generation-routes.cjs:490`); (d) гейт «нет исполнителя ⇒ не диспетчеризовать» (§B.4/шт. ниже) | Сначала код и тесты — чтобы чистка нешла под защитой |
| **114.2** | **Тесты в изолированной среде** (прототипы §C переносятся в репозитории: `animastor-gpu-hub/tests/` + `animastor-backend/backend/tests/`), включая регрессию «дефект не воспроизводится» | Без этого чистка небезопасна |
| **114.3** | **Деплой кода** (согласование, push, CI, GHCR, rollout) | Порядок «код → проверка → чистка» |
| **114.4** | **Наблюдение**: минимум 1 graceful-рестарт backend'а ⇒ очередь **не должна** вырасти ни на одну запись | Прямая проверка исправления на production-механизме |
| **114.5** | **Отдельная проверка очереди** (§B.6, dry-run) | Чистка только после подтверждения инвариантов |
| **114.6** | **Постепенная чистка доказанных дубликатов** (по шагам, с журналом и rollback) | Отдельное решение владельца; требует рабочего исполнителя |
| **114.7** | Восстановление workers (§A.5) | До этого момента queue должна **перестать расти** (иначе чистка бессмысленна) |

**Гейт «нет исполнителя ⇒ не диспетчеризовать»** (рекомендуется в 114.1, как отдельный слой):
`worker-health.js:255` `isAvailable(redis, type, workspaceId)` уже реализует нужную семантику («живой system-воркер ИЛИ живой private-воркер своего workspace»). В `dispatch-engine.dispatchStage` (`dispatch-engine.js:733`) — **до** захвата квоты — добавить проверку: если исполнителей типа нет ⇒ не диспетчеризовать, оставить стадию `PENDING`, залогировать `GPU_CAPACITY_UNAVAILABLE`. Сцена остаётся в active-index и будет диспетчеризована автоматически, как только появится воркер.

**Побочный (отдельно, не в этом этапе):** маршрутизация lane'а опирается на **регистрацию**, а не на **живость** (`worker-repo.js:216`). Пока это так, задачи уходят в private-lane мёртвого воркера. Корректная правка — считать private-lane доступным только при живом воркере; но это меняет семантику SH-1 ⇒ отдельное решение и отдельный этап.

## B.6. План постепенной очистки (dry-run → журнал → rollback). **Сейчас ничего не удаляется.**

**Инвентаризация (уже снята, read-only):** 457 записей = 19 групп; копий на группу: 43 (`sc-45c789c6`) и 7 (`sc-5f18dd0f`); уникальных `dispatch_id` = 50; текущие активные диспатчи (из `dispatch-meta`): `dispatch-1792588545466-08fa446ea42b786a28bc15af838a1fb5` (`sc-45c789c6`) и `dispatch-1792588545927-2e83aeae60c18f9f524464a0231c62a4` (`sc-5f18dd0f`).

**Шаг 0 (подготовка, write в файлы, не в Redis).** Снять полный слепок lane'а:
`LRANGE animastor:queue:image:ws:3317e019-… 0 -1` → сохранить как `queue-snapshot-<ts>.jsonl` (одна строка на запись, канонический JSON) + `sha256` файла. Размер: 457 записей ≈ 1,5 МБ (payload'ы содержат полные workflow-параметры).

**Шаг 1 (dry-run, только чтение).** Скрипт-анализатор:
1. группирует записи по каноническому хэшу семантики (§B.2) — **не** по сцене;
2. внутри группы выбирает **KEEP**-экземпляр: запись, чей `dispatch_id` == **текущему активному** `dispatch_id` из `animastor:dispatch-meta:{book}:{ch}:{sc}:image`; если такого нет — самую новую (последний LPUSH = индекс 0);
3. все остальные → **DROP**;
4. печатает сводку: `groups=19, keep=19, drop=438, bytes_reclaimed≈…` и проверяет инварианты:
   * в каждой группе `params` идентичны у всех копий (иначе — стоп, группа неоднородна);
   * `job_id` KEEP-экземпляра == `job_id` группы;
   * `dispatch_id` KEEP == активный `dispatch_id` (иначе — стоп: результаты KEEP будут отклонены как `stale_dispatch`).
5. **Ничего не пишет в Redis.**

**Шаг 2 (журнал).** Сформировать `queue-drop-journal-<ts>.jsonl` — по строке на каждую удаляемую запись:
```
{"seq":<порядковый номер в lane сверху вниз>, "group":<семантический хэш>, "job_id":"…",
 "dispatch_id":"…", "raw_sha256":"…", "raw_len":<байт>, "keep_dispatch_id":"…"}
```
Плюс `queue-drop-manifest.json` с: общим числом записей, числом KEEP/DROP, sha256 журнала, sha256 слепка, списком 19 `job_id`, списком 50 `dispatch_id`, временем. Хранить **вне** production-хоста (например, `reorg-2026-10-19/114-queue-cleanup/` + копия в `backups/`).

**Шаг 3 (поэтапное удаление, только после approval).** Удаление — **точечное** `LREM <lane> 1 <exact raw string>` по каждой DROP-записи (не `DEL` lane'а и не `LREM` по шаблону):
* порядок — **от хвоста к голове** (сначала самые старые), чтобы индексы не «съезжали»;
* после каждого пакета (например, 50 записей) — контрольная точка: `LLEN lane` уменьшился на ожидаемое число; `LRANGE` показывает, что KEEP-записи на месте; в логах backend/hub нет 5xx;
* **стоп-условия:** любое расхождение `LLEN` с ожиданием ⇒ немедленный `BREAK` и rollback;
* время: очередь должна быть **неподвижной** (воркеров нет ⇒ lane не меняется) — это делает операцию безопасной.

**Шаг 4 (rollback, точный).** Так как удаление — точечное `LREM` по **полному сырому значению**, откат восстанавливает записи **дословно и в исходном порядке**:
```
MULTI
  RPUSH <lane> <raw_drop_1> <raw_drop_2> … <raw_drop_N>   # в обратном порядке удаления
EXEC
```
(слепок `queue-snapshot-<ts>.jsonl` содержит все исходные строки, поэтому сырые значения восстановимы побайтово). Проверка отката: `LLEN` возвращается к 457; `sha256` канонизированного списка совпадает с исходным; `LRANGE` совпадает с исходным слепком.

**Отдельно про 8 записей глобальной lane** (`animastor:queue:image`, книги `import_1783751905430…`, `import_1783860199734…`, июль 2026): у них нет `book_id`/`scene_id`/`dispatch_id`/`workspace_id`, `book_id` = `undefined` ⇒ фильтр `/queue/clear?book_id=` их **не** поймает; полный clear (`DELETE /queue/clear` без параметров) снёс бы и ws-lane. ⇒ Для них требуется **отдельное решение владельца** и отдельный точечный `LREM`-проход по raw-значениям из `LRANGE animastor:queue:image`.

**Риски чистки (честно):**
* **438 удаляемых записей несут stale `dispatch_id`** ⇒ их результаты были бы отклонены backend'ом ⇒ удаление безопасно с точки зрения «потери результата»;
* **19 KEEP-записей** сохраняются и будут выполнены, когда появится воркер;
* риск «потерять единственную копию» исключается проверкой «в каждой группе есть KEEP» в dry-run и пошаговым контролем `LLEN`;
* **чистку имеет смысл делать после 114.1–114.4**, иначе следующий graceful-рестарт вернёт +19 записей.

---

# C. Обязательные тесты будущего исправления

## C.1. Требуемый список → реализация

| # | Требование из задания | Тест в прототипе | Результат |
|---|---|---|---|
| 1 | повторный dispatch одной задачи не создаёт вторую логическую запись | «второй dispatch той же задачи отклоняется (одна pending-запись)» | ✅ |
| 2 | новый `dispatch_id` не обходит дедупликацию | «re-dispatch с новым `dispatch_id` … не плодит дубли» + «50 re-dispatch-ов → 1 pending-запись» | ✅ |
| 3 | активный lease не отбирается у живой задачи | «пока задача в работе (claim не освобождён), повторный dispatch отклоняется» | ✅ |
| 4 | завершённая задача не ставится повторно без обоснованного retry | «без обоснованного retry (epoch не бампнут) … отклонена» + «обоснованный retry (epoch бампнут) … допускается» | ✅ |
| 5 | crash/restart не создаёт дубликаты | «restart backend …», «restart GPU Hub …», «claim не зависит от короткого TTL» | ✅ |
| 6 | разные IU или разные версии входных данных не схлопываются ошибочно | «разные IU …», «разные сцены …», «изменение входных данных …», «порядок ключей в params не влияет …» | ✅ |
| 7 | завершение и результат от worker остаются идемпотентными | «повторная доставка результата … дедуплицируется», «результат от ДРУГОГО dispatch_id тоже дедуплицируется», «терминальный result освобождает pending-claim ровно один раз» | ✅ |

**Итог: 19/19 зелёные.** Плюс 4/4 на воспроизведение дефекта (ожидаемо «зелёные» — они фиксируют текущее дефектное поведение) и 7/7 conformance на реальном Redis.

## C.2. Изолированные прототипы (созданы, лежат вне репозиториев)

```
/tmp/opencode/s113/
├── lib/mem-redis.js                     # in-memory Redis: get/set(NX,EX)/del/expire/ttl/incr/
│                                         # lpush/rpush/lrange/llen/lrem/hset/hget/hgetall/sadd/srem/scan…
├── lib/task-idempotency.js              # прототип исправления (спецификация §B.3)
├── test-idempotency.cjs                 # 19 тестов, 7 требуемых сценариев  → ALL GREEN
├── test-current-hub-behavior.cjs        # воспроизведение дефекта на РЕАЛЬНОМ gpu-hub.js → 4/4
└── test-real-redis-conformance.cjs      # conformance на реальном Redis (repro-redis, db15) → 7/7
```

Запуск:
```
node /tmp/opencode/s113/test-idempotency.cjs
node /tmp/opencode/s113/test-current-hub-behavior.cjs
node /tmp/opencode/s113/test-real-redis-conformance.cjs
```

**Изоляция:** hermetic-тесты работают на in-memory Redis (0 сетевых обращений); conformance работает на **отдельном контейнере** `repro-redis`, **db 15** (production Redis `animastor-redis`, db0, не затрагивался; после прогонa db15 очищен `FLUSHDB`); воспроизведение дефекта поднимает **настоящий** `gpu-hub.js` на `127.0.0.1:<ephemeral>` с in-memory Redis. Ни один прогон не пишет в production.

## C.3. План переноса тестов в репозитории (следующий этап, не выполнялся)

| Файл | Содержание | Куда |
|---|---|---|
| `animastor-gpu-hub/tests/run-all.cjs` (существующий раннер) или новый `tests/queue-idempotency.test.cjs` | unit-тесты hub-guard: повторный `POST /task` с тем же `idem_key` → одна запись; с разным `dispatch_id` → всё ещё одна; разные `job_id`/`params` → две; `job-done` блокирует повтор; `/task/result` и `/task/error` освобождают claim | `animastor-gpu-hub` (репозиторий чистый, HEAD `0f489c7b`) |
| `animastor-backend/backend/tests/iu-epoch-idempotency.test.js` | epoch-логика backend'а: эпоха не меняется при re-dispatch, меняется при `failStage` и при явной регенерации; `idem_key` стабилен между dispatch'ами | `animastor-backend` (внимание: в рабочем дереве есть чужие dirty-файлы — добавлять **только новые** файлы, существующие не трогать) |
| `animastor-backend/backend/tests/gpu-result-dedup.test.js` | dedup результата не зависит от `dispatch_id` | там же |
| `animastor-backend/backend/tests/architecture/*.test.js` | архитектурная проверка: «все dedup-ключи очереди не содержат `dispatch_id`» (защита от регрессии) | там же |

**Минимальные требования к тестам при переносе:** дефект-регрессия обязательна (тест на текущем коде должен ПАдать, на исправленном — проходить); тесты не должны требовать сети/контейнеров; тесты не должны обращаться к production Redis (явная проверка `REDIS_URL`/явный in-memory double).

---

# D. MP4 и schema ensure — только описание отдельных задач

## D.1. Legacy `scene_assets` (`/data/output/b1/…`) — безопасность repoint

**Факты (read-only, подтверждены в Stage 112 и перепроверены здесь):**

| Факт | Значение |
|---|---|
| Строки | `scene_assets.id` = **25096, 25097, 25098, 25100** — все `video`/`ready`, `build_id = NULL`, `scene_hash = NULL`, `path = /data/output/b1/…_sc-a740d763.mp4`, `created_at` 2026-08-26 10:38:42 / 10:40:49 / 10:42:45 / 10:50:23 |
| Каноническая копия | `/data/output/build_import_1786345731767_1786345734345/…_sc-a740d763.mp4` — 579 008 Б, SHA-256 `e30eebc2000df7ecc62723d2f8423fc692785fdd95deb7ff15d29be9fed99320` (совпадает с Stage 75 preflight) |
| Покрывающая строка | `scene_assets.id = 25101` — тот же путь, `status='ready'`, **тоже `build_id = NULL`**, `created_at` 2026-08-26 12:55:23 (на 2 ч 05 мин позже) |
| Уникальный индекс | `scene_assets_book_id_chapter_id_scene_id_asset_type_build_i_key` UNIQUE `(book_id, chapter_id, scene_id, asset_type, build_id)` |
| Следствие | Поскольку **у всех пяти строк `build_id IS NULL`**, а PostgreSQL считает NULL-ы различными, уникальный индекс **не** ограничивает дубликаты. Как только `build_id` проставляется — ограничение включается. |
| Ссылок извне | Внешних FK на `scene_assets` **нет** (`pg_constraint` пуст); `asset_dependencies` — пустая (0 строк), схема — по book/layer, не по asset-id; `output_manifests` — пустая (0 строк) |
| Хэш содержимого в БД | **отсутствует** (`scene_hash = NULL` у всех пяти) ⇒ сопоставление «строка 25101 ↔ найденный файл» опирается только на совпадение basename + внешний SHA-256, а не на хэш, хранимый в БД |

**Оценка безопасности repoint (задача для отдельного этапа; ничего не менялось):**

* **Репoint только `path` (оставив `build_id = NULL`)** — технически безопасен (уникальный индекс не нарушается), делает 4 строки «правдивыми» (путь резолвится). **Но**: (а) остаётся 5 строк на один и тот же артефакт; (б) возникает **латентный конфликт** с планом Stage 75 batch A (репойнт 6 канонических строк на доказанный build): как только `build_id` проставят строке **25101**, пять строк получат одинаковый ключ ⇒ **unique violation**.
* **Репoint `path` + простановка `build_id`** — **небезопасно** в текущем состоянии БД (конфликт со строкой 25101, у которой `build_id` ещё NULL ⇒ после её простановки — 5 одинаковых ключей).
* ⇒ **Корректный порядок (рекомендация):** сначала **Stage 75 batch C** — заархивировать 4 dead-path строки и **удалить** их; затем batch A — проставить доказанный `build_id` строке 25101. Repoint как замена удалению **не рекомендуется**: он оставляет 4 дубликата и создаёт конфликт с batch A.
* **Минимальный неразрушающий вариант** (если удаление не согласовано): обновить у 4 строк `status` с `'ready'` на **`'missing'`** (значение разрешено CHECK-констрейнтом `scene_assets_status_check`) — это **правдиво** (файла по указанному пути нет) и не создаёт конфликта уникального индекса. Требует транзакции и проверки, что строка 25101 осталась `ready`.
* **Обязательные гейты для любого варианта:** (1) архив 4 строк в `row_to_json` + SHA-256 sidecar (готовый превью-контент: `/tmp/opencode/stage75/deadpath-archive-preview.json`, sha256 `deed59fcf2df90e84cf576fae40c7a6c496f2599feb3f03154eba6c6d6bc361f`, id `25096,25097,25098,25100` — **живые строки ему идентичны**, проверено в Stage 112); (2) повторное чтение архива непосредственно перед изменением; (3) `scene_assets` 459 → 455 (или 459 при смене `status`), `build_id IS NULL` 437 → 433; (4) контроль `sha256` файла `…_sc-a740d763.mp4` = `e30eebc2…` до и после; (5) подтверждение, что `/data/output/b1` по-прежнему отсутствует.

**Класс: PRE-EXISTING (рассогласование пути, потери данных нет) + NEEDS ACTION (не выполненные batch C/A) + INCONCLUSIVE (происхождение литерала `b1` — в истории исходников backend он не встречается).**

## D.2. `schema.js:1211` — устранение ожидаемой ошибки без изменения схемы

**Текущий код (`backend/src/storage/postgres/schema.js:1204-1217`):**
```js
try { await query(`ALTER TABLE users ALTER COLUMN username SET NOT NULL`); } catch (err) { … }
try {
    await query(`ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username)`);  // строка 1211
    console.log('[PG] Added unique constraint on users.username');
} catch (err) {
    if (!err.message.includes('already exists')) { console.error(…); }
}
```

**Предлагаемое устранение (проектирование; не применялось, схема не меняется):**

* **Вариант B (рекомендуется) — предварительная проверка, без DROP-окна:**
```js
try {
    const { rows } = await query(
        `SELECT 1 FROM pg_constraint
          WHERE conname = 'users_username_unique' AND conrelid = 'users'::regclass
          LIMIT 1`);
    if (rows.length === 0) {
        await query(`ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username)`);
        console.log('[PG] Added unique constraint on users.username');
    }
} catch (err) {
    if (!err.message.includes('already exists')) {
        console.error('[PG] Failed to add unique constraint on users.username:', err.message);
    }
}
```
Свойства: **схема не меняется** (ограничение уже существует и не пересоздаётся); **нет** окна, в котором ограничение отсутствует (в отличие от `DROP … IF EXISTS` + `ADD`); ошибка `already exists` исчезает из лога PG; риск изменения данных — нулевой (констрейнт не пересоздаётся, индекс не трогается).
* **Вариант A (как в `workers_*`, `schema.js:1484-1490`)** — `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`: идемпотентен, но оставляет краткое окно без ограничения ⇒ для `users` предпочтителен вариант B.
* **Регрессионный тест:** «повторный `runMigrations()` на уже смигрированной БД не порождает ни одной ERROR в логе PG» + «после `runMigrations()` ограничение `users_username_unique` существует ровно в одном экземпляре и `pg_get_constraintdef` не изменился».
* **Правка формулировки runbook'а:** Stage 109 §B.4 п.13 утверждает «миграции **не выполнялись**» — фактически `runMigrations()` (schema-ensure) **выполняется на каждом старте**; он идемпотентен и схему не меняет (уточнение уже фиксировалось в Stage 111 §4.2).
* **Класс: PRE-EXISTING** (хронический шум: 19 909 ERROR на 19 909 стартов backend'а с 2026-08-19; функционального влияния нет — падение `ADD CONSTRAINT` в auto-commit без транзакции, `database.js:32-39`, схема идентична Stage 93).

---

# E. Итоговая классификация

| # | Пункт | Класс | Ключевое доказательство |
|---|---|---|---|
| A1 | Жизненный цикл worker'а и места регистрации/heartbeat/GPU-discovery | **CONFIRMED** | `worker.cjs:179/226/258/571`, `gpu-hub.js:698/744/352`, `worker-routes.cjs:174`, `worker-repo.js:751` |
| A2 | Причина `offline` по каждому из 7 workers | **CONFIRMED** | PG `workers` (создан/last_seen/revoked_at) + `liveInfo()` (`worker-setup-routes.cjs:60-74`) + отсутствие heartbeat-ключей |
| A3 | PG `workers.status='offline'` — это DEFAULT, а не наблюдение; колонка нигде не обновляется | **CONFIRMED** | `worker-repo.js`: единственные UPDATE — `token_hash`/`revoked_at`/`last_seen` |
| A4 | Производных GPU-воркеров у деплоя не было; последний image-heartbeat 2026-08-26 03:01Z, первая запись очереди — 2026-08-30 05:45Z | **CONFIRMED** | журнал сцен + PG `last_seen` + лог hub'а |
| A5 | Маршрутизация в private ws-lane опирается на **регистрацию**, а не на **живость** | **CONFIRMED** | `gpu-dispatcher.js:62-79` → `worker-repo.js:216-227` (SQL без проверки живости) |
| A6 | Graceful shutdown → cancel → `orphan_generating_repair` → re-dispatch → дубликат | **CONFIRMED** | цепочка §A.4 + натуральный эксперимент 2026-10-18 (03:12:56 / 03:17:47 / 03:33:45) + воспроизведение на реальном `gpu-hub.js` (50→50) |
| A7 | Единственный guard (`iu-in-flight`) обезврежен отменой (удаление `dispatch-meta`) | **CONFIRMED** | `iu-processor.js:43-88` + `dispatch-engine.js:1175-1188` + `finalizeDispatch` (Lua `claimFinalization` сносит lease и meta) |
| A8 | Нет счётчика попыток (`retry_attempt` захардкожен 0) ⇒ нечего использовать как измерение идемпотентности | **CONFIRMED** | `dispatch-engine.js:262` |
| A9 | Результаты от stale-копий будут отклонены backend'ом (`stale_dispatch`) ⇒ дубликаты бесполезны вдвойне | **CONFIRMED (код)** | `generation-routes.cjs` (`verifyDispatchIdentity` до строки 490) |
| A10 | Отсутствие исполнителя — **не** следствие cutover/Stage 109–111 | **PRE-EXISTING** | последний heartbeat 2026-08-31; Stage 111 фиксировал `gpus:0` уже 2026-10-14 |
| A11 | План восстановления workers (10 шагов с проверками) | **NEEDS ACTION** | §A.5; требуется внешняя GPU-машина (на этом хосте `nvidia-smi` отсутствует) |
| A12 | Риск кросс-доменного редиректа `animastor.in → animastor.org` с потерей `Authorization` | **CONFIRMED** (механизм) / **NEEDS ACTION** (профилактика) | `curl --resolve animastor.in…` → 301; `installer` default `ANIMASTOR_HUB_URL=https://animastor.in/gpu`; `installer-src/engine/engine.js:993` пишет в `.env` `https://animastor.org/gpu` |
| B1 | Реальная схема очереди/ключей/алгоритм dedup | **CONFIRMED** | §B.1 (таблица ключей + владельцы) |
| B2 | **Можно ли доказательно классифицировать дубликаты** | **CONFIRMED — ДА** | канонический SHA-256 семантики (без `dispatch_id`) даёт ровно **19 групп** на 457 записей; `params`-хэши уникальны внутри групп и различены между ними; 50/50 `dispatch_id` сопоставлены с журналом |
| B3 | Ни один dedup-слой не подавляет re-dispatch; 3 из 4 ключей используют **неверный (legacy) формат** ⇒ no-op | **CONFIRMED** | `gpu-hub.js:423-425`, `iu-processor.js:206-213/275/307`, `generation-routes.cjs:490` |
| B4 | Предложен устойчивый `idem_key` (+ `input_version` + `generation_epoch`), переживающий re-dispatch/reстарт/новый `dispatch_id` | **CONFIRMED (спроектировано и проверено тестами)** | `/tmp/opencode/s113/lib/task-idempotency.js`; 19/19 тестов |
| B5 | Конкурентные сценарии разобраны (15 сценариев) | **CONFIRMED** | §B.4 |
| B6 | Безопасный порядок: код+тесты → проверка очереди → чистка | **CONFIRMED (план)** | §B.5 |
| B7 | План постепенной чистки: dry-run, журнал на каждую запись, точный rollback | **CONFIRMED (план, не выполнен)** | §B.6 (слепок 457 записей; KEEP=19 / DROP=438; `LREM` по точному raw-значению; откат через `RPUSH` из слепка) |
| C1 | 7 обязательных тестов реализованы в изолированной среде и зелёные | **CONFIRMED** | 19/19 hermetic; 7/7 conformance на реальном Redis (db15 изолированного `repro-redis`) |
| C2 | Дефект воспроизводится на реальном коде hub'а | **CONFIRMED** | 50 re-dispatch → 50 записей (4/4) |
| C3 | Тесты в репозитории не добавлены (репозитории не тронуты) | **PRE-EXISTING (по заданию)** | §C.3 — план переноса |
| D1 | Repoint 4 legacy-строк: **не рекомендуется** (латентный конфликт уникального индекса с Stage 75 batch A); рекомендован batch C (архив+удаление), минимальная альтернатива — `status='missing'` | **CONFIRMED** (анализ) / **NEEDS ACTION** (решение владельца) | `pg_indexes`, `pg_constraint`, значения `build_id` всех пяти строк, отсутствие внешних FK |
| D2 | Устранение ошибки `schema.js:1211` без изменения схемы — вариант B (пред-проверка `pg_constraint`) | **CONFIRMED (проект)** / **NEEDS ACTION** (внедрение) | §D.2 |
| D3 | Происхождение литерала `b1` в коде | **INCONCLUSIVE** | `git log --all -S "output/b1"` → только тестовая фикстура Stage 66 |

---

# F. Предлагаемый порядок последующих этапов

| Этап | Содержание | Критерий приёмки | Риск |
|---|---|---|---|
| **114.1** | Код: `idem_key`/`generation_epoch` в backend; hub-guard в `POST /task`; исправление форматов dedup-ключей; гейт «нет исполнителя ⇒ не диспетчеризовать» | тесты §C в репозиториях зелёные; **регрессия дефекта падает на старом коде** | средний (изменение пути enqueue) |
| **114.2** | Изолированный прогон тестов + ревью | все зелёные; `git status` чист кроме новых файлов | низкий |
| **114.3** | Push/CI/GHCR/deploy по обычному гейту | образ собран, `RestartCount=0`, health 200 | стандартный для репозитория |
| **114.4** | Наблюдение ≥ 1 graceful-рестарта backend'а | `workspace_queues` **не растёт** (457 → 457) | низкий |
| **114.5** | Dry-run анализатор очереди (read-only) | сводка `groups=19 keep=19 drop=438`, все инварианты зелёные, журнал с sha256 | нулевой |
| **114.6** | Постепенная чистка 438 дубликатов | после каждого пакета `LLEN` совпадает с ожиданием; KEEP-записи на месте; 19 задач в работе после появления воркера | средний ⇒ требует approval + работающего воркера |
| **114.7** | Восстановление workers (§A.5) | `gpus ≥ 1`, heartbeat живой, `base_status=ONLINE`, очередь убывает | внешняя машина |
| **114.8** | Отдельно: batch C + batch A по `scene_assets` (с архивом) | `scene_assets` 459 → 455; `build_id IS NULL` 437 → 433; sha256 файла не изменился | низкий, но требует решения владельца |
| **114.9** | Отдельно: `schema.js:1211` (вариант B) + тест + правка runbook'а | ноль ERROR `users_username_unique` в логе PG | низкий |

**Порядок жёсткий:** 114.1–114.4 **до** 114.5–114.6; 114.7 **до** 114.6 (иначе чистка бессмысленна); 114.8 и 114.9 независимы и могут идти параллельно.

---

# G. Границы этапа — соблюдены

| Ограничение | Статус |
|---|---|
| Только read-only диагностика и локальные изолированные тесты | ✅ production-системы — только чтение; тесты — hermetic (in-memory Redis) + отдельный контейнер `repro-redis` db15 (после прогонов db15 очищен) |
| Не изменять production Redis, PostgreSQL, файлы, очередь, leases, статусы, конфигурацию | ✅ `dbsize` = 321 (как в Stage 111/112), `scene_assets` = 459/437 NULL, `data/books` sha `200beb1a…`, `data/output` sha `2a03a8c7…` — **без изменений**; ни одного `LPUSH/LREM/SET/DEL` в production |
| Не перезапускать backend, GPU Hub, workers | ✅ `StartedAt`/`RestartCount` всех контейнеров неизменны (backend `2026-10-21T13:15:38.819Z`, gpu-hub `2026-10-12T13:41:43Z`, pg/redis `2026-08-24T16:30:12Z`, proxy `2026-10-19T06:18:24Z`), `RestartCount=0` у всех |
| Не запускать генерацию | ✅ ни одного `POST /task` в production; ни одного `📤 Result:` в логе hub'а; 0 файлов `data/**` новее cutover |
| Не выполнять push, CI, GHCR, deploy, restart | ✅ не выполнялись; `git` в репозиториях не менялся |
| Не удалять дубликаты, не менять `dispatch_id`, не менять активные leases | ✅ очередь не изменялась (457 → 457); leases не трогались (только `TTL`/`GET`) |
| Не трогать dirty-файлы и другие репозитории | ✅ backend: `git status --porcelain` = 7 записей — **тот же** dirty-набор, что в Stage 111/112 (1 D, 4 M, 2 ??); gpu-hub: 0 (чисто); worker/др. — не менялись; прототипы вынесены в `/tmp/opencode/s113/` |
| Секреты | ✅ Worker Key, `GPU_HUB_API_KEY`, `PG_PASSWORD` не вынесены; в отчёте — только префиксы `wrk_…` и факты наличия |
| Записи на диск этим этапом | `/tmp/opencode/s113/*` (прототипы и тесты) + настоящий отчёт |

---

# H. Краткий итог

**WARN.**

* **Причина `offline` у 7 workers:** все 7 — тестовые артефакты (E2E/vps/parity), созданные 2026-08-21…08-30; **ни один production-GPU-воркер у деплоя никогда не существовал**; последний heartbeat image-воркера — 2026-08-26 03:01Z, последний heartbeat любого — 2026-08-31 04:50Z; первая запись очереди (2026-08-30 05:45Z) появилась уже после этого ⇒ ни одна из 457 задач не имела исполнителя. Один воркер отозван. Причина — **отсутствие процесса**, а не сеть/регистрация/конфигурация. Дополнительно: `workers.status='offline'` — это DEFAULT (колонка не обновляется), а маршрутизация в private ws-lane опирается на **регистрацию**, а не на **живость** ⇒ задачи уходят в lane, который читает только мёртвый воркер.
* **Стратегия идемпотентности:** `idem_key = sha256(workspace_id | job_id | build_id | sha256(canonical(params)) | generation_epoch)`; `dispatch_id` исключён; `generation_epoch` (INCR) бампается **только** при обоснованном retry (`failStage`) или явной регенерации ⇒ re-dispatch из reconciliation/restart подавляется, а легитимный retry проходит. Enforcement — на hub'е (`SET NX` + маркер выполнения); при этом ключи `result-processed` и «dedup-clear» в backend'е приводятся к **фактическим** форматам (сейчас они — no-op из-за legacy-формата). Плюс гейт «нет исполнителя ⇒ не диспетчеризовать».
* **Дубликаты классифицируются доказуемо:** 457 записей = **19 логических задач** (канонический SHA-256 семантики без `dispatch_id`: одинаковые `params`, включая seed и промпты; 19 различных `params`-хэшей между группами; 50/50 `dispatch_id` сопоставлены с журналом) ⇒ **438 дубликатов**, из них 42 из 43 копий одного IU несут stale `dispatch_id` и дали бы отклонённые результаты.
* **Оставшиеся блокеры:** (1) нет GPU-машины — исполнителя надо разворачивать отдельно; (2) исправление идемпотентности должно быть **до** чистки, иначе следующий graceful-рестарт вернёт +19 записей; (3) `workers.status` не обновляется и routing не учитывает живость — отдельная правка; (4) точный литерал `b1` недоказуем; (5) решение владельца по архиву/удалению 4 legacy-строк `scene_assets` и по 8 орфанным записям глобальной lane.
