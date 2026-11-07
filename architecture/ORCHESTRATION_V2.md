# Оркестрация генерации v2 (ADR)

Статус: **УТВЕРЖДЁН** владельцем 2026-11-05 (вариант «очередь только в PG»; решения по открытым вопросам — §13). Реализация по этапам §12.
Основание: разведка `architecture/ORCHESTRATION_V2_RECON.md` (e3c754c; backend 34634ca, gpu-hub c9aa24f, worker c34c4ea, web d9cb135, android be1233c). Ссылки вида «разведка §N» — туда.
Заменяет: `@animastor/orchestration` 0.3.x — новая архитектура выходит в том же пакете как **1.0.0** (код с нуля; старый код на время миграции — `src/legacy/`, корень пакета отдаёт прежний API 0.3.5 + пространство `gen`; legacy удаляется на этапе 4), оркестрационную часть backend (категория A разведки §10), Job Protocol v2 (`JOB_PROTOCOL_V2.md`) — для путей v2.
Не трогает: агенты VBook / LLM-пайплайн (`pipeline-runner`), установщик, сборку workflow ComfyUI, склейку медиа (категория B).

---

## 1. Проблема

Одно и то же состояние хранится в нескольких местах и согласуется фоновыми циклами (разведка §11.1):

- статус задачи — 3 места (Redis-реестр `generation-progress`, PG `generation_tasks`, хаб `running`);
- стадия сцены — 5 мест (PG `scene_assets`, `asset_states`, Redis `asset-state`, `audio-orch`/`video-orch`, active index);
- отмена книги — 3 места (cancel flag, PG tombstone, `cancelled-workers`);
- признак заглушки — 3 места (sidecar, Redis chunk, PG `scene_assets`);
- у одной GPU-задачи три таймаута с разными часами (воркер, хаб, lease backend);
- хаб держит свои очереди, processing, running, dedup, result, dead-letter и сам продлевает heartbeat воркеру.

108 семейств ключей Redis, 4 генерационных цикла, 6 стартовых хуков, fence / lease / dedup / circuit breaker / retry budget. Почти все баги 10–11.2026 — рассинхрон между этими местами. При нескольких пользователях число столкновений растёт.

## 2. Решение в одной фразе

**Единственный источник правды — две таблицы PG: `gen_commands` (что попросил пользователь) и `gen_jobs` (единицы работы). Воркеры сами забирают работу через хаб одним SQL-запросом; результат принимается одной транзакцией. Ни одно другое хранилище не решает, что делать.**

## 3. Инварианты (нарушение любого = баг)

1. **I1 Только команда.** Строки `gen_jobs` создаёт только обработка команды пользователя (или переход внутри уже идущей команды, §6.3). Никаких циклов, которые создают работу.
2. **I2 Одна правда.** Статус работы — только `gen_jobs.status`. Готовность ассета — только `scene_assets` (пишется только транзакцией приёма, §7). Redis, хаб, файлы на диске статус не определяют. Legacy-ветки, которые пишут `scene_assets` сами (read-repair placeholder-аудио на `GET /book` и `POST recover-placeholders`), для v2-книги не работают: гейт — общий предикат изоляции `orchestration.isV2Book` (fail-closed), тот же, что у scheduler, reconcile и scene window (2026-11-07, О2).
3. **I3 Один владелец времени.** У запущенной работы один `deadline` в `gen_jobs`. Хаб и воркер своих таймаутов, влияющих на статус, не имеют.
4. **I4 Принять можно только текущую попытку.** Результат принимается, если `job_id` и `attempt` совпадают и статус `running`. Всё остальное — 409 и выброс.
5. **I5 Готово только по GPU.** `ready` у ассета — только после приёма реального результата (с sha256). Заглушка — это `placeholder`, и только так.
6. **I6 Хаб без состояния задач.** Хаб аутентифицирует воркера и пересылает запросы. Очередей, running, dedup, копий результата у хаба нет.
7. **I7 Изоляция пользователей.** Каждая строка несёт `workspace_id` и `user_id`; выдача учитывает полосу; ни одна операция без фильтра по книге/команде не меняет чужие задачи (полная очистка очередей удаляется).

## 4. Модель данных

### 4.1 `gen_commands` — команда пользователя

| Колонка | Тип | Смысл |
|---|---|---|
| `command_id` | UUID PK | |
| `workspace_id` | UUID NOT NULL | из книги (проверено доступом) |
| `user_id` | UUID NOT NULL | кто нажал (из `req.user`) |
| `book_id` | TEXT NOT NULL | |
| `kind` | TEXT | `regenerate` (этапы 1–2), `generate_all` (этап 3, задача H) |
| `scope` | JSONB | `{level: book|chapter|scene|unit, chapter_id?, scene_id?, unit_id?}` |
| `layers` | TEXT[] | `{audio,image,video}` — что просили и что было включено на момент команды |
| `force` | BOOL | перегенерировать готовое |
| `client_action_id` | TEXT | идемпотентность клика; `UNIQUE (book_id, client_action_id)` |
| `status` | TEXT | `active → done | failed | cancelled` (+ `partial`: завершена, есть failed-работы) |
| `summary` | JSONB | `{jobs_created, joined, skipped_ready}` на момент создания (возвращается и при повторном клике) |
| `created_at`, `finished_at`, `cancelled_by`, `error` | | |

### 4.2 `gen_jobs` — единица работы

Гранулярность — как сейчас у GPU (contracts `job-protocol-v2`): аудио-чанк, IU-картинка, видео-группа; плюс локальные шаги backend (склейка).

| Колонка | Тип | Смысл |
|---|---|---|
| `job_id` | UUID PK | новый, не строковая грамматика v2 |
| `command_id` | UUID FK | команда, создавшая работу (кто ещё ждёт её — `gen_command_jobs`, §4.2a) |
| `workspace_id`, `user_id`, `book_id`, `chapter_id`, `scene_id` | | денормализованы для выдачи и фильтров |
| `build_id` | TEXT NOT NULL | build книги на момент команды (пути артефактов §7) |
| `layer` | TEXT | `audio | image | video` — для отмены по слою (§6.4); выводится из kind |
| `unit_key` | TEXT | `0003` (чанк), `iu-<id>` (IU), `g2` (группа видео), `scene` (склейка) |
| `kind` | TEXT | `audio_chunk`, `iu_image`, `video_group`, `audio_merge`, `video_merge` |
| `executor` | TEXT | `gpu:audio`, `gpu:image`, `gpu:video`, `local` |
| `lane` | JSONB | `{kind: private|policy|system, workspace_id?, policy_id?}` — считается при создании (логика `gpu-dispatcher.js:213–222`) |
| `status` | TEXT | `queued → running → done | failed | cancelled` |
| `attempt` | INT | растёт при каждой выдаче |
| `max_attempts` | INT | из политики повторов по kind (сейчас `gpu-retry-policy.cjs:50–53`) |
| `worker_id` | UUID | кто держит текущую попытку |
| `deadline` | TIMESTAMPTZ | `claimed_at + timeout(kind)` (таймауты из layer-config) |
| `not_before` | TIMESTAMPTZ | пауза перед повтором (backoff) |
| `input` | JSONB | всё, что нужно для построения payload (тексты, голос, промпт, ссылки на входные файлы) — снимок на момент команды |
| `result_path`, `result_sha256`, `result_bytes` | | заполняются приёмом |
| `error_class`, `error` | | последняя ошибка |
| `created_at`, `claimed_at`, `finished_at` | | |

Индексы:
- выдача: `(executor, status, not_before) WHERE status='queued'`;
- **одна живая работа на юнит:** `UNIQUE (book_id, chapter_id, scene_id, kind, unit_key) WHERE status IN ('queued','running')` — повторный клик или пересекающаяся команда не создаёт дубль (§6.2);
- сторож: `(deadline) WHERE status='running'`; прогресс: `(command_id, status)`.

### 4.2a `gen_command_jobs` — какие команды ждут работу

`(command_id, job_id)` PK. Строка пишется для каждой работы, которую команда создала **или к которой присоединилась** (§6.1 п.4), и для работ следующих ступеней (§6.3). Прогресс и завершение команды считаются только по этой таблице.

### 4.3 Что остаётся и что уходит

- `scene_assets` — остаётся как «что лежит на диске»: пишется только транзакцией приёма (§7) и созданием заглушек при импорте. Добавить `job_id`, `sha256`. Ключ — сцена × тип: `ready` + `sha256` + `job_id` ставятся только склейкой (`audio_merge` / `video_merge`; для картинок склейки нет — приём IU, закрывающий набор IU сцены, §13 п.9); готовые части (чанк, IU, группа) — в `metadata.gen_parts[unit_key]` (с `part_hash`, если планировщик его дал). Статусы: `placeholder | pending | ready | stale` (`pending` — часть работ сцены принята, набор не закрыт, §13 п.9). Убрать NULL-build дубли (409 строк) миграцией.
- `layer-config` — переносится из Redis в PG (`book_layer_config`).
- Удаляются после этапа 4: `generation_tasks`, `asset_states`, `generation_cancellations`, `iu_image_fence_reservations`, `iu_image_pointers` (если versioned IU не включён), `reconciliation_events`; все генерационные ключи Redis (разведка §4.5), кроме pub/sub прогресса — его заменяет PG `LISTEN/NOTIFY` (§9), так что Redis генерации не нужен вовсе.
- Пять таблиц, в которые никто не пишет (разведка §3.3: `asset_states`, `cache_entries`, `asset_dependencies`, `reconciliation_events`, `output_manifests`), — удалить на этапе 2.

## 5. Компоненты

```
web / Android ──HTTP──▶ backend: роуты (тонкие)
                           │
                           ▼
                 @animastor/orchestration 1.0.0 (новая архитектура)
                 ├─ commands   — создать / отменить команду, план работ
                 ├─ claim      — выдать работу воркеру (SQL)
                 ├─ accept     — принять результат / ошибку (транзакция)
                 ├─ local-runner — выполнять executor='local' (склейка)
                 ├─ sweeper    — один цикл: дедлайны, офлайн-воркеры, завершение команд
                 └─ progress   — агрегаты + NOTIFY
                           │ порты (категория B, остаются в backend):
                           │  buildPayload(job) — workflow ComfyUI / промпты
                           │  mergeAudio(scene), mergeVideo(scene)
                           │  artifactPath(job) — artifact-naming
                           │  planUnits(book, scope, layer) — чанки / IU / группы
                           ▼
                        PostgreSQL

GPU-нода: worker ──▶ gpu-hub (auth + relay, без состояния) ──▶ backend /internal/gen/*
           worker ──PUT результата (прямо, по токену)──▶ backend /internal/gen/jobs/:id/result
```

Пакет не знает про Express и ComfyUI; backend подключает его через порты. Оценка: 1,5–3 тыс. строк + тесты.

## 6. Команды

### 6.1 Создание (`POST /api/v1/book/:bookId/regenerate`, далее `/generate`)

Одна транзакция:
1. `INSERT gen_commands … ON CONFLICT (book_id, client_action_id) DO NOTHING` → дубль клика возвращает существующую команду (`200`, тот же `command_id`). Этап 2–3 защиты /regenerate (428, дедуп по action_id) закрывается этим.
2. Слои = запрошенные ∩ включённые. Пусто → `409 layer_disabled` (как сейчас).
3. `planUnits` → список юнитов. Без `force` пропускаются юниты, у которых `scene_assets.status='ready'` для текущего контента (сравнение `scene_hash` / `content_version`).
4. `INSERT gen_jobs … ON CONFLICT (живой юнит) DO NOTHING` → если юнит уже в работе по другой команде, новая работа не создаётся, а команда «присоединяется»: строка в `gen_command_jobs` на существующую работу.
5. Создаются только работы **первой ступени** (§6.3). Ответ: `{command_id, summary: {jobs_created, joined, skipped_ready}}` — закрывает расхождение контракта (фронты ждут `summary`; `build_id` больше не нужен, вместо него `command_id`).

Ничего не отменяется у других команд. Широкая отмена — только явной кнопкой (§6.4).

### 6.2 Повторный клик, пересечение команд

Защищено двумя ограничениями: `UNIQUE (book_id, client_action_id)` и «одна живая работа на юнит». Случай 04.11 (случайный тап «Текущая сцена» снёс задачи всей книги) в v2 невозможен: новая команда ничего не отменяет и не дублирует.

### 6.3 Ступени внутри команды

Зависимости не хранятся графом; переход создаётся в той же транзакции, что завершает предыдущую работу (§7), **только если хотя бы одна связанная с ней (`gen_command_jobs`) команда `active`, в её `layers` есть этот слой, и слой включён**; новая работа связывается со всеми такими командами:

| Завершилось | Что создаётся |
|---|---|
| последний `audio_chunk` сцены | `audio_merge` (local) |
| `audio_merge` | — (аудио сцены ready) |
| все `iu_image` сцены приняты и чистые (§6.5), если со сценой связана активная команда со слоем video | `video_group` по группам (этап 3; §6.5) |
| последний `video_group` сцены | `video_merge` (local) |

Это не автозапуск: работа создаётся в рамках команды, которую нажал пользователь (I1).

### 6.4 Отмена

- **Стоп всего по книге** (`cancel-generation`): `UPDATE gen_commands SET status='cancelled' WHERE book_id=$1 AND status='active'` + `UPDATE gen_jobs SET status='cancelled' WHERE command_id IN (…) AND status IN ('queued','running')`. Одна транзакция.
- **Стоп слоя** (`cancel-worker type=…` или выключение слоя в `PUT layer-config`): то же с фильтром по `layer` (аудио снимает и `audio_merge`).
- **Стоп команды** (по `command_id`): команда → `cancelled`; её работы → `cancelled` **только если они не связаны (`gen_command_jobs`) с другой активной командой**; общие работы продолжаются для оставшихся команд.
- Запущенная на воркере работа: воркер узнаёт из ответа на beacon (`cancel: [job_id…]`, §8.3) и прерывает ComfyUI (`/interrupt`). Если результат всё равно придёт — 409 по I4, файл выбрасывается.
- Флагов отмены, tombstone, TTL нет: отменённость = статус строк.

### 6.5 Видео и картинки в разных командах (этап 3)

Видео сцены строится из её картинок. Видео-команда (`layers ∋ video`) при планировании (§6.1) смотрит на картинки каждой сцены в scope:

| Картинки сцены | Что делает видео-команда |
|---|---|
| все IU приняты и **чистые** (`gen_parts[unit_key].part_hash` = текущий `part_hash` планировщика image) | создаёт `video_group` сразу |
| есть живые (`queued`/`running`) `iu_image` сцены по другой команде | новых работ не создаёт, **присоединяется** к этим IU (`gen_command_jobs`, §4.2a); `video_group` создаётся переходом §6.3 в транзакции приёма последнего IU |
| есть **грязные** IU (промпт / шаблон изменён после приёма: `part_hash` не совпадает), и они не в работе | сцена пропускается: `summary.skipped_image_dirty` + список сцен; видео по устаревшим кадрам не генерируется (лишний расход GPU) |
| картинок нет (или набор IU неполный) и ничего не идёт | сцена пропускается: `summary.skipped_needs_image` + список сцен |

- **Недостающие или грязные IU видео-команда сама не ставит.** Человек мог не запускать картинки намеренно (правит промпт); всё запускается только вручную (Stage 155, I1).
- Ожидание — без нового статуса и без опроса: у видео-команды просто есть связанные живые IU.
- «Чистота» считается только сравнением `part_hash` (текущий снимок workflow IU против принятого), не по `scene_assets.status`: после правки промпта статус сцены остаётся `ready`, пока не принят новый кадр. Та же проверка — в переходе §6.3: если принятый последним IU уже грязный (промпт правили во время генерации), `video_group` не создаётся, причина по сцене `image_dirty`.
- IU, к которому присоединилась видео-команда, упал (`failed`) или отменён → `video_group` сцены не создаётся; команда завершается `partial`, причина по сцене — `image_failed` / `image_cancelled`.
- Стоп команды картинок: общие IU продолжаются ради видео-команды (§6.4). Стоп слоя «картинки» или всей книги снимает их, и видео этих сцен не создаётся (`image_cancelled`). Прогресс (§9) показывает такие IU как «нужны видео».
- Хэш «готово для текущего контента» у `video_group` включает sha256 входных кадров группы: новые картинки → видео этой группы считается отсутствующим в режиме `missing`.
- Позже возможно: старт `video_group` по готовности кадров группы, а не всей сцены.

## 7. Приём результата (одна транзакция)

`PUT /internal/gen/jobs/:job_id/result?attempt=N` — тело = сырой файл (stream), заголовок `Authorization: Bearer <upload_token>` (HMAC от `job_id`, `attempt`, `exp`; выдаётся при claim).

1. Поток → `{OUTPUT_DIR}/{build}/.incoming/{job_id}.{attempt}.tmp`, на лету sha256 и размер; fsync. Проверка формата (mp3/png/mp4 — magic bytes, длительность аудио > 0 и не тишина — порог RMS, чтобы «тишина = ready» не повторилась; png (1.1.0) — структура и CRC, размеры > 0, поток пикселей, не пустой / однотонный кадр — порог стандартного отклонения яркости, §13 п.9).
2. `BEGIN; SELECT … FROM gen_jobs WHERE job_id=$1 FOR UPDATE;` статус `running` и `attempt=N`? Нет → `ROLLBACK`, удалить tmp, `409 stale_attempt`.
3. `rename(tmp → artifactPath(job))` (атомарно, тот же раздел).
4. `UPDATE gen_jobs SET status='done', result_*`; `scene_assets`: для части (чанк, IU, группа) — `metadata.gen_parts[unit_key]`, для склейки — `ready` + `sha256` + `job_id` (§4.3); переходы §6.3; `NOTIFY gen_progress`.
5. `COMMIT` → `200`.

С 1.2.0 (О3): у картинки `scene_assets.width/height` — размеры из PNG-валидатора (они же в `gen_parts[unit_key]`; у строки сцены — размеры файла `path`, т. е. первой части); принятый файл после `rename` получает права `0644`, как legacy-файлы (временный в `.incoming` — `0640`).

Сбой между 3 и 5: файл уже новый (это валидный результат этого юнита), статус остался `running` → воркер повторит PUT (идемпотентно: тот же attempt, та же sha → после commit 200) или сработает дедлайн → новая попытка перезапишет файл. Состояния «ready без файла» не бывает: ready пишется только после rename.

Ошибка: `POST /internal/gen/jobs/:job_id/error?attempt=N` `{error_class, reason, comfy_status}` → транзакция: та же проверка attempt → `failed` или `queued` с `not_before = now + backoff` (если `attempt < max_attempts` и класс transient/oom). Классы и паузы — из текущей `gpu-retry-policy` (TRANSIENT 30/120 с ×2, OOM 60 с ×1, DETERMINISTIC 0); `timeout` и `worker_offline` — transient; `invalid_result` (тишина, битый файл) — один повтор, затем failed.

Что исчезает: fence, `result-processed` dedup, staging-дерево с `.previous-canonical`, `animastor:result:*`, Phase A recovery, `RESULT_FENCING_MODE`, versioned-IU ветка (если не нужна), base64 и три JSON-хопа.

**Контракт приёма (уточнено на этапе 1b).** `PUT …/result?attempt=N`: тело — сырой файл (`Content-Type` любой, не JSON), `Authorization: Bearer <upload_token>`; токен действителен до `deadline + 15 мин`. Ответы: `200 {status, sha256, job_status:'done', stage_jobs_created}` (повтор того же PUT после commit — `200 {idempotent:true}`); `401` — нет / неверный токен; `409 {code:'stale_attempt'}` — не текущая попытка (файл выброшен); `413` — больше лимита `ORCH_V2_MAX_UPLOAD_BYTES` (по умолчанию 512 МиБ, nginx `client_max_body_size 512m`, `proxy_request_buffering off`); `422 {code:'invalid_result', reason, job_status}` — проверка формата / тишины не пройдена (`queued` для повтора или `failed`); `503 {code:'orch_v2_disabled'}` — мастер-флаг выключен. `POST …/error?attempt=N` — тот же токен, ответы `200 {job_status, retry}` / `401` / `409`. Временный файл — `{dir(artifactPath)}/.incoming/{job_id}.{attempt}.{nonce}.tmp` (тот же раздел, что итоговый путь).

## 8. Воркер и хаб (протокол v3)

### 8.1 Выдача (pull, без очереди в хабе)

`GET hub /v3/task/next?type=audio` (Bearer worker, как сейчас) → хаб проверяет токен (`animastor:worker-auth`) → `POST backend /internal/gen/claim {worker_id, worker_type, mode, workspace_id, policy_ids}` (x-api-key хаба) → backend:

```sql
WITH cand AS (
  SELECT j.job_id
  FROM gen_jobs j
  WHERE j.status = 'queued'
    AND j.executor = 'gpu:' || $type
    AND j.not_before <= now()
    AND <полоса совпадает: private → j.lane.workspace_id = $ws;
         policy → j.lane.policy_id = ANY($policies);
         system → j.lane.kind = 'system' (+ «одалживание» как сейчас)>
    AND ($lane_kind = 'private' OR $shared_limit IS NULL OR
         (SELECT count(*) FROM gen_jobs r
          WHERE r.workspace_id = j.workspace_id AND r.status = 'running'
            AND r.executor = j.executor AND r.lane->>'kind' <> 'private') < $shared_limit)
  ORDER BY
    (SELECT count(*) FROM gen_jobs r
     WHERE r.workspace_id = j.workspace_id AND r.status = 'running'),  -- справедливость
    j.created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE gen_jobs j SET status='running', attempt=attempt+1, worker_id=$worker,
       claimed_at=now(), deadline=now()+timeout(kind)
FROM cand WHERE j.job_id = cand.job_id
RETURNING j.*;
```

Нет работы → `{task: null}` (воркер ждёт, как сейчас backoff 2→15 с). Есть → backend строит payload портом `buildPayload` и возвращает `{task: {job_id, attempt, params, assets, timeout_ms, upload_url, upload_token}}`; хаб пересылает воркеру как есть.

Входные файлы (картинка для видео и т.п.) — по ссылке `GET /internal/gen/jobs/:id/input/:name` с тем же токеном, а не base64 в задаче.

**Внутренний контракт выдачи (этап 1b).** `POST backend /internal/gen/claim` — заголовок `x-api-key` = `GPU_HUB_API_KEY` **обязателен** (без ключа или при не заданном ключе — `401`); тело `{worker_id, worker_type?}`. Тип, режим, workspace и политика шаринга воркера берутся из PG (`workers` + `share_policies`), а не из тела: users-политика → `policy_ids`, public-политика private-воркера → «одалживание» system. Ответ `{task: null}` или `{task: {job_id, attempt, kind, book_id, chapter_id, scene_id, unit_key, params, timeout_ms, deadline, upload_token, upload_url, error_url, job_type, protocol_version: 3}}`. Снаружи (nginx) `/internal/gen/claim` и `/internal/gen/beacon` недоступны — хаб ходит в docker-сети; публичен только `/internal/gen/jobs/`.

**Как сделано (этап 1c, хаб `orch-v2/1c`).** `GET hub /v3/task/next?type=…` — та же проверка Bearer-токена воркера по зеркалу `animastor:worker-auth`; `type` ≠ типу учётных данных → `409 worker_type_mismatch`. Затем один `POST {BACKEND_INTERNAL_URL}/internal/gen/claim {worker_id, worker_type}` с `x-api-key` (`GPU_HUB_API_KEY`). `mode` / `workspace_id` / `policy_ids` хаб не шлёт: backend берёт их из PG (контракт выше). Ответ backend уходит воркеру как есть (статус и тело). Исключение: `401` backend (не принят ключ хаба) → воркеру `502 backend_rejected_hub_key`, это ошибка настройки хаба, а не воркера. Таймаут relay 10 с, своих повторов у хаба нет; backend недоступен или таймаут → `503 backend_unavailable` (воркер ждёт и повторяет). На этом пути хаб ничего не пишет в Redis. `BACKEND_INTERNAL_URL` — новый env хаба (docker-сеть, напр. `http://animastor-backend:3000`); не задан → `/v3/*` отвечают `503 v3_not_configured`; не задан `GPU_HUB_API_KEY` → `503 hub_api_key_not_configured`.

### 8.2 Результат и ошибка

Воркер: `PUT upload_url` (поток файла из `COMFY_OUTPUT_DIR`, без base64), повтор с backoff до 5 раз при сетевой ошибке / 5xx; `409` → прекратить. Ошибка — `POST /internal/gen/jobs/:id/error` прямо на backend тем же токеном (§13.2); хаб в пути результата и ошибки не участвует.

**Как сделано (этап 1c, воркер 2.4.0).**
- **Результат.** `PUT upload_url` потоком: файл из `COMFY_OUTPUT_DIR`, если его нет на диске — поток ComfyUI `/view`. `Content-Type` — по расширению, `Content-Length` — размер файла, `Authorization: Bearer upload_token`.
- **Повторы доставки.** При сетевой ошибке / 5xx — до 5 попыток всего, пауза 1 → 2 → 4 → 8 с. `409` / `401` и любой другой 4xx → доставка прекращается, работа бросается (решение уже принял backend).
- **Ошибка выполнения.** `POST error_url {error_class, reason, comfy_status}` тем же токеном, с теми же повторами. Классы — как у воркера 2.3.0 (`deterministic` / `transient` / `oom`, без класса = unknown) плюс `timeout`.
- **Таймаут (I3).** `timeout_ms` из задачи только прерывает ComfyUI (`/interrupt` с `prompt_id`) и даёт `error_class=timeout`; статус работы воркер сам не меняет.
- **Входные файлы.** Ссылки `…/input/:name` на этапе 1 не реализованы: у аудио входных файлов нет.

### 8.3 Живость

`POST hub /v3/beacon` раз в 10 с `{gpu, vram, version, current_job_id?}` → хаб пересылает → backend `UPDATE workers SET last_seen=now(), current_job_id=…` и отвечает `{cancel: [job_id…]}` (работы этого воркера в статусе `cancelled`). Хаб **не** продлевает heartbeat сам (I6). Redis-ключ heartbeat не нужен.

**Внутренний контракт beacon (этап 1b).** `POST backend /internal/gen/beacon` (`x-api-key` обязателен) `{worker_id, current_job_id?}` → `{cancel: [job_id…]}`: отменённые работы воркера за последний час + `current_job_id`, если она у этого воркера уже не `running` (переочередь сторожем, отдана другому).

**Access-лог хаба (v0.3.3, О3).** Одна строка на запрос `/v3/*` и legacy-путей: `[HTTP] <метод> <путь без query> → <код> worker=<worker_id> <мс>ms`; заголовки, тела, токены не печатаются, `worker_id` — из credential. Холостой трафик (пустой `task/next` / `v3/task/next` `{"task":null}`, 2xx beacon, `/health`) — одной сводкой раз в минуту.

**Как сделано (этап 1c).** Воркер 2.4.0 шлёт `POST hub /v3/beacon {gpu, vram, version, image_tag, current_job_id}` раз в 10 с (`BEACON_INTERVAL_MS`) рядом с прежним `/beacon`. Сразу после выдачи задачи — внеочередной beacon. Хаб пересылает `{worker_id (из токена), current_job_id}` на `/internal/gen/beacon` и отдаёт `{cancel}` воркеру. `current_job_id` ∈ `cancel` → ComfyUI `/interrupt` (с `prompt_id`; если prompt ещё не создан — сразу после ответа `/prompt`), результат не отправляется, ошибка тоже, воркер переходит к следующей задаче.

Отступление от «Redis-ключ heartbeat не нужен» (по заданию 1c): на `/v3/beacon` хаб обновляет **свой** ключ `animastor:worker:heartbeat:{type}:{id}` (EX 30, та же форма, что у `/beacon`, плюс `protocol_version: 3` и `current_job_id`). Его читают UI-статус и legacy-подсчёт воркеров. Это единственная запись в Redis на v3-пути. Продления по записи `running` на v3-пути нет: записи `running` там не существует. Реестр `animastor:gpu-hub:workers` v3-beacon не трогает: по нему v2-выдача сверяет `protocol_version=2`.

### 8.4 Хаб v3 — что остаётся

Аутентификация воркеров, `/installer`, бандл воркера, `/workflow/:id`, два relay-эндпоинта (`next`, `beacon`). Удаляются: `POST /task`, очереди и полосы в Redis, `processing`, `running`, dead-letter, dedup, `result:*`, `DELETE /queue/clear` (особенно полная очистка), сторож таймаутов и orphan-requeue. Прямые правки очередей хаба из backend (`worker-routes.cjs:146–165`) уходят вместе с очередями.

Совместимость: v2-эндпоинты хаба живут, пока есть воркеры 2.x; v3 — новые пути. Воркер 2.4.0 = v3 (протокол 3); тип ноды переводится на v3 переустановкой однострочником.

**Как сделано (этап 1c).**
- **v2-путь хаба.** Не менялся, кроме одного: `DELETE /queue/clear` без `book_id` / `dispatch_id` / `workspace_id` (пустые значения считаются отсутствующими) → `400 scope_required` до любого обращения к Redis. Ветка полной очистки удалена (I7). Все вызывающие в backend передают `book_id` или `dispatch_id`. Остальное (`/task`, очереди, `running`, сторож, `/queue/clear` с параметрами) удаляется на этапе 4.
- **Совместимость воркера 2.4.0** (`WORKER_PROTOCOL=both`, по умолчанию). За итерацию: `/v3/task/next`; `{task:null}` / 404 (старый хаб) / 503 (backend выкл. или недоступен) / сетевая ошибка → один прежний v2-pop `/task/next` (обработка 2.3.0 без изменений). Пауза 2 → 15 с — только когда пусто в обоих.
- **Приоритет.** v3 имеет приоритет: пока в v3 есть работа, v2-задачи берутся только в промежутках, когда v3 пуст.
- **`WORKER_PROTOCOL=v2only`.** Ровно цикл 2.3.0, без вызовов `/v3`.

### 8.5 Логи воркера (свежие логи на VPS)

Воркер держит в памяти кольцевой буфер последних **2000 строк / 256 КиБ** (что достигается первым) всего, что пишет его логгер — плюс stderr ComfyUI, если ComfyUI запускает сам воркер. Каждые **30 с** он отправляет **только новые** строки:

```
POST hub /v3/logs   (Bearer-токен воркера)
gzip-JSON {worker_id, seq_from, seq_to, lines: [{ts, level, msg}]}
≤ 64 КиБ ПОСЛЕ сжатия (остальное — в следующий раз)
```

Инварианты воркера: новых строк нет → POST нет; ошибка / таймаут 5 с → молча, строки остаются в буфере и уйдут в следующий раз; отправка **не блокирует цикл задач** (fire-and-forget, ни один await в цикле на неё не стоит). Редактирование секретов применяется **до** отправки, никогда после:

- значения `Authorization` / `Bearer`;
- `upload_token`;
- `key|token|secret|password=` + значение формы `[A-Za-z0-9_-]{32,}`;
- содержимое `.env` (строки `NAME=VALUE` → значение `[redacted]`);
- явно зарегистрированные секреты (собственный credential воркера).

Переключатель `WORKER_LOG_SHIP=on|off`, по умолчанию `on`. Ответ beacon с `send_log_tail:true` вызывает **одноразовый** сброс всего буфера (тоже кусками ≤ 64 КиБ) — так оператор получает хвост даже у молчащего воркера.

**Хаб `POST /v3/logs`.** Та же проверка Bearer-токена, что у `/v3/*`; тело читается сырым потоком с потолком **128 КиБ** (дальше `413 payload_too_large`), gunzip/inflate — с потолком распаковки (по умолчанию 1 МиБ, `413` при превышении). Готовое JSON-тело пересылается в backend `POST /internal/workers/:worker_id/logs` с `x-api-key` по docker-сети; записи в Redis нет, своей копии логов хаб не хранит. `worker_id` для URL берётся **из токена** — поле `worker_id` тела всего лишь метка и не проверяется.

**Backend `POST /internal/workers/:id/logs`.** `x-api-key` обязателен (снаружи маршрут закрыт nginx: `/internal/`, кроме `/internal/gen/jobs/`, → 404). Дальше: `worker_id` валидируется как UUID **до** любого обращения к файловой системе (путь из тела невозможен) → иначе `400`; тело > 128 КиБ → `413`; `lines[]` не массив → `400`; строк больше 2000 → `413`; воркер неизвестен или отозван → `404`. При `log_shipping=false` → `204` **без записи**. Иначе строки дописываются в `{WORKER_LOGS_DIR}/<worker_id>/current.log` форматом `ts level msg` (одна строка на запись, переводы строки в `msg` экранируются), права: каталог `0700`, файл `0600`; при размере > 5 МБ файл ротируется в `current.log.1` (старый `.1` удаляется — на воркера ровно два файла). `WORKER_LOGS_DIR` задаётся через `runtime-config` (`WORKER_LOGS_DIR`), по умолчанию `${DATA_ROOT}/worker-logs`, в контейнере `/data/worker-logs`.

**Логи — всегда хозяину (`workers.log_shipping`).** Решение владельца 07.11 (миграция **WLOG-2**): логи пишутся для **всех** воркеров. Читает их хозяин — владелец workspace, которому принадлежит воркер, — и админ платформы (поддержка). Пользователи, которым воркер расшарен (`share_policies`: и `users`-гранты, и `public`), логов **не видят**: им отвечает `404`, как чужому воркеру; аноним — `401`. Колонка `BOOLEAN NOT NULL DEFAULT TRUE` остаётся выключателем на будущее (UI позже): `false` → ingest отвечает `204` без записи. WLOG-2 один раз переключает `DEFAULT` на `TRUE` и поднимает `TRUE` у всех неотозванных строк (логируется число строк); если оператор выставил `false` позже, рестарт его не переключает. Расчёт начального значения по роли владельца удалён — новый воркер всегда `TRUE`.

**Запрос и чтение хвоста.**
- `POST /api/v1/workers/:id/request-log` (владелец workspace / админ) — ставит **одноразовый** in-memory флаг по `worker_id` (ни таблицы, ни Redis: потерянный beacon просто доставит его позже). Флаг потребляется ровно одним ответом `/internal/gen/beacon` — `{cancel, send_log_tail: true|false}`, и только после успешного beacon, чтобы отключённый beacon не съедал запрос.
- `GET /api/v1/workers/:id/log?lines=N` — хвост файла (`current.log` + при необходимости `current.log.1`), `N` по умолчанию 200 и ограничено 2000, строки от старых к новым (как `tail -n N`); доступ — владелец workspace / админ, иначе `404`, аноним `401`; `N` вне 1..2000 → `400`.

**Как сделано (ветка `feat/worker-logs`, 2026-11-06; не влито, не выкачено).** Воркер **2.4.1** — модуль `worker/worker-logs.cjs` (буфер, редакция, отправка; без зависимостей, только `zlib`), вставка в `worker.cjs` (логгер пишет в буфер, хаб-отправчик запускается при `WORKER_LOG_SHIP`, `send_log_tail` обрабатывается в ответе beacon). Хаб — маршрут `/v3/logs` (исключён из глобального `express.json` через `type`, читает сырое тело) плюс relay. Backend — `services/worker-logs-store.js` (диск), `services/worker-log-tail.js` (одноразовый флаг), ingest в `orchestration-v2/routes.js`, два публичных маршрута в `worker-routes.cjs`, колонка и миграция в `schema.js`, `log_shipping` во всех выборках `worker-repo.js`, `WORKER_LOGS_DIR` в `runtime-config.js`. Тесты: воркер `tests/worker-logs.test.cjs` (в составе `run-all.cjs`), хаб `tests/v3-logs.cjs` (freeze-тест маршрутов теперь пинит **17**), backend `tests/worker-logs.test.js` (opt-in, диск + ротация, HTTP-поверхность, одноразовый флаг, GET). Профильные договорённости — `architecture/GPU_HUB_CONTRACT.md` §3 (маршрут 17), §12, §16.

**Закрыто решением владельца 07.11:** критерий «платформенный воркер» больше не нужен — логи пишутся у всех, читает хозяин и админ, расшаренным пользователям лог закрыт (WLOG-2, закреплено тестами `tests/worker-logs.test.js`: владелец `200`, админ `200`, держатель `users`-гранта `404`, участник `public`-политики `404`, аноним `401`).

Открытые вопросы к владельцу: трактовка «содержимое `.env`» (зануляется значение каждой `NAME=VALUE`, имя остаётся); путь stderr ComfyUI активен только при `COMFY_SPAWN_CMD` (в поставочных деплоях ComfyUI поднимается извне — там он не работает).

## 9. Сторож и прогресс

**Сторож** — единственный фоновый цикл генерации, раз в 10 с, идемпотентный, работу не создаёт (кроме повтора уже существующей работы, у которой есть попытки):
1. `running` с `deadline < now()` → как ошибка `timeout` (§7: повтор или failed).
2. `running` у воркера с `last_seen < now() - 60 s` → то же `worker_offline` (раньше дедлайна).
3. Команда `active`, у которой нет `queued`/`running` работ → `done` / `partial` / `failed`; `NOTIFY`.
4. `.incoming/*.tmp` старше 1 ч → удалить.

**Рестарт backend:** делать нечего — всё в PG; воркеры продолжают, результаты принимаются после старта, сторож доберёт просроченное. (Решено §13.1: продолжать.)

**Журнал шагов (1.2.0, О3).** Ядро пишет одну info-строку на шаг через порт логгера хоста (`createOrchestration({ logger })`; backend передаёт `console`), сам `console` не вызывает:
`[gen-v2] command-created` (книга, команда, слои, scope, `jobs_created`/`joined`/`skipped_ready`, `existing` для повторного клика) · `claim` (job, kind, unit_key, attempt/max_attempts, worker_id, ms) · `accept` (sha256, bytes, width/height, `idempotent`, `stage_jobs_created`, ms приёма, `run_ms` от claim) · `error` (каждая неудачная попытка: error_class, job_status, retry; `code=stale_attempt` для 409) · `requeue` (возврат в очередь, `delay_ms`) · `command-finished` (status, done/failed/cancelled, `run_ms`). Печатаются только поля белого списка (`gen/log.js`): токены загрузки, пути и параметры задач в лог не попадают. Ошибка доставки NOTIFY→SSE в backend — `console.warn` `[ORCH-V2] progress NOTIFY→SSE failed …` (раньше глушилась).

**Прогресс:** `GET /api/v1/book/:bookId/progress` = SQL-агрегат по `gen_command_jobs` ⨝ `gen_jobs` активных команд книги (по команде, слою, сцене: queued / running / done / failed). SSE `progress-stream` подписан на `LISTEN gen_progress` (payload: `book_id`, `command_id`) и при событии отдаёт свежий агрегат. «Призрачных задач» нет: панель показывает строки таблицы.

## 10. Многопользовательский режим

- `workspace_id` — из книги (проверка доступа уже есть), `user_id` — из запроса; оба в каждой строке.
- Справедливость: выдача по наименьшему числу `running` у workspace, затем по времени (§8.1).
- Команды не ограничиваются: пользователь запускает сколько угодно (аудио, картинки, видео другой сцены, VBook — одновременно).
- Свои (private) воркеры — без лимита: каждый воркер берёт одну работу за раз, так что естественный предел = число его нод.
- Лимит `shared_limit` — только на общих GPU (полосы system и policy): сколько единиц работы одного workspace могут **одновременно выполняться** на чужом железе, чтобы один пользователь не занял весь общий пул. Настройка админа, по умолчанию выключен (NULL), пока общих GPU для других пользователей нет. Дневная квота на общие GPU — позже.
- Агенты VBook (LLM) — не GPU-работа, лимит их не касается.
- Приватные воркеры видят только свою полосу (как сейчас). Нет операций без фильтра по книге или команде.
- Нагрузка: 100 пользователей × книги по сотням сцен — сотни тысяч строк, единицы переходов в секунду; claim — индексный запрос. Масштаб упирается в GPU и диск, не в оркестрацию.

## 11. API генерации и фронты (web + Android, паритет в той же задаче)

Решение владельца 06.11: один глагол `generate` с явным режимом вместо пары generate/regenerate (граница «новое / повторное» размыта: в одном scope часть готова, часть нет).

### 11.1 Целевые эндпоинты (этап 2)

| Метод и путь | Тело | Что делает | Заменяет |
|---|---|---|---|
| `POST /api/v1/book/:bookId/generate` | `{scope, layers, mode: "missing" \| "all", client_action_id}` | создаёт команду (§6.1). `missing` (по умолчанию) — только отсутствующее или устаревшее по хэшу контента; `all` — всё в scope (`force`). Ответ `{command_id, existing, summary}` | `/regenerate` (`rebuild_all` → `mode:"all"`) |
| `POST /api/v1/book/:bookId/generate/stop` | `{command_id}` \| `{layer}` \| `{}` | стоп команды / слоя / всего по книге (§6.4) | `cancel-worker`, `cancel-generation` |
| `GET /api/v1/book/:bookId/generate/progress` | — | агрегат §9: команды × слои × сцены | `progress-panel` |
| `GET /api/v1/book/:bookId/generate/stream` | — | SSE по `gen_progress` | `progress-stream` |
| `GET` / `PUT /api/v1/book/:bookId/layer-config` | как сейчас | хранилище — PG (`book_layer_config`) | — |

`scope`: `{level: "book" | "chapter" | "scenes" | "scene" | "unit", chapter_id?, scene_ids?, scene_id?, unit_key?}`; «с текущей сцены до конца» фронт или backend разворачивает в `scenes` (этап 1c). `layers`: `audio`, `image`, `video`; на этапе 3 добавляется `vbook` (задача H: VBook-окно как ступень той же команды; `bootstrap` / `bootstrap-next-window` становятся внутренними).

### 11.2 Фронты

- Две кнопки вместо одной: «Сгенерировать недостающее» (`mode:"missing"`) и «Перегенерировать» (`mode:"all"`, с подтверждением для scope шире сцены).
- `client_action_id` на каждый клик; читать `command_id`, `summary`; поле `build_id` из ответа больше не читать.
- Прогресс — новый формат (по команде и слою); «Стоп» — по команде (новое), по слою и по книге.
- Android: удалить мёртвые Retrofit-декларации (`regenerateBook` с `new_book`, вызовы §11.3).

### 11.3 Миграция и удаление

- Этап 2: новые эндпоинты; `/regenerate` — синоним `generate` (`rebuild_all:true` → `all`, иначе `missing`), `cancel-worker` / `cancel-generation` / `progress-panel` / `progress-stream` — синонимы новых для v2-книг; фронты переходят на новые.
- Этап 3: `vbook` как слой `generate`.
- Этап 4: удалить синонимы и эндпоинты без вызовов из фронтов (разведка §7.3): `POST /api/v1/generate`, `POST /book/:id/generate-next`, `POST /book/load-vbook`, `POST /book/import-txt`, `POST /book/:id/resume-bootstrap`, `POST /book/:id/trigger-next-window`, `POST /book/:id/recover-placeholders`, `GET /book/:id/generation-state`, `GET /worker/status` — перед удалением повторить grep по web, Android и docs. Импорт остаётся единым `POST /book/import`.

## 12. Этапы

| Этап | Кто | Что | Готово, когда |
|---|---|---|---|
| 1 | Claude Code | `@animastor/orchestration` 1.0.0 (новый код; старый — в `src/legacy/` до этапа 4), таблицы `gen_commands`/`gen_jobs`, `book_layer_config`; claim/accept/sweeper/progress; backend `/internal/gen/*`; хаб v3 relay; воркер 2.4.0 (pull v3, PUT результата, cancel из beacon). **Только аудио**, книга переключается флагом `books.orchestration='v2'`. Старая оркестрация для такой книги аудио не трогает (гейт в scheduler/reconcile по флагу). | BA на v2: «аудио» одной сцены, всей главы, Стоп посередине, рестарт backend посередине, выключение ноды посередине, двойной клик — всё по ожиданиям; тесты пакета на чистом PG. |
| 2 | Claude Code | image (IU), API §11 + фронты (паритет), перенос layer-config, удаление 5 мёртвых таблиц | BA: аудио + картинки по команде |
| 3 | Claude Code | video (группы + merge), слой `vbook` в `generate` (задача H, окна VBook как ступень команды) | BA целиком |
| 4 | Claude Code + кодер | Все книги на v2; удаление `src/legacy/` пакета (старый 0.3.x), кода категории A, генерационных ключей Redis, v2-путей хаба, таблиц §4.3; docs | grep по удалённым ключам/модулям пуст; тесты зелёные |

Ход реализации:
- **1a** (2026-11-05) — ядро `@animastor/orchestration` 1.0.0 (`src/gen/`, старый код в `src/legacy/`) + схема PG; без роутов. Backend `orch-v2/1a` `4aaa791`.
- **1b** (2026-11-06) — доработка ядра (§4.2a `gen_command_jobs`, `build_id`/`layer`/`summary`, отмена по слою, `invalid_result` ×1) + подключение к backend: только аудио, только `books.orchestration='v2'`, мастер-флаг `ORCH_V2_ENABLED` (по умолчанию выкл.); единый предикат изоляции legacy; nginx `/internal/gen/jobs/`. Backend `orch-v2/1b` `7b24fab`, `49e58d7`; deploy `orch-v2/1b` `81dff42`. Без выкатки и npm publish.
- **1c** (2026-11-06) — хаб v3 relay (`/v3/task/next`, `/v3/beacon`, `BACKEND_INTERNAL_URL`, `/queue/clear` без параметров → 400); воркер 2.4.0 (протокол 3: PUT результата потоком, cancel из beacon, режим `both` с v2); хвосты 1b: `from_current_scene` → `scope.level='scenes'` (миграция 003), `DELETE /book/:id/cache` для v2-книги без хаба; сквозной тест backend + хаб + воркер 2.4.0 + мок ComfyUI. Хаб `orch-v2/1c` `e4e5e67`, воркер `orch-v2/1c` `32ef1e7`, backend `orch-v2/1c` `224fcc2`. Без выкатки, npm publish и релиза GHCR.
- **1d** (2026-11-06) — **этап 1 выкачен на прод.**
  - **Код и релиз:** `@animastor/orchestration` 1.0.0 опубликован в npm, backend берёт его из реестра (без `file:`); backend `deploy-1189a31` (`sha256:1e33a5f0…`), gpu-hub `v0.3.0` (`sha256:d0a64209…`, бандл воркера 2.4.0), nginx `/internal/gen/jobs/`; `ORCH_V2_ENABLED=1`, миграции 001–003 применены.
  - **Книги на v2:** только BA (`ba_1788172242081`); остальные — legacy.
  - **Проверки на проде:**
    - legacy до и после включения: заглушка → `ready`, реальный звук;
    - сценарии §12 на тестовой книге в workspace владельца: сцена, двойной клик, глава, «Стоп» посередине (interrupt на ноде подтверждён логом воркера), рестарт backend посередине, остановка воркера посередине (`worker_offline` → queued → attempt 2 → done);
    - на BA — «аудио» одной сцены → `ready`.
  - Тестовая книга и аккаунт удалены. Отчёт: `reports/2026-11-06/orch-v2-1d-release.md`, backend `stage164-prod-release.md`.

- **2a** (2026-11-07) — **изображения (IU) на v2** для `books.orchestration='v2'`; без выкатки, npm publish, merge. Backend `orch-v2/2a-image` (`@animastor/orchestration` 1.1.0 в `packages/` + backend); хаб и воркер не менялись. Разведка — `architecture/ORCHESTRATION_V2_RECON_IMAGE.md`.
  - **Ядро 1.1.0:** проверка PNG (`inspectPng`: структура + CRC, размеры 1…16384, поток пикселей, пустой кадр → `invalid_result`, один повтор, затем failed); пропуск готового по части (`input.part_hash`); готовность сцены без склейки (`input.scene_parts`); `cancel({commandId})` отдаёт `layers`; legacy `scene-window` (окно и read-repair chunk-статусов) не трогает v2-книгу.
  - **Порты image (backend `orchestration-v2/image-ports.js`):** `planUnits` — один `iu_image` на юнит сцены (`units[]` + `dialogue_blocks[].units[]`), `unit_key` = id юнита; `buildPayload` — снимок workflow той же функции, что у legacy (`iu-processor.buildIUWorkflow`, байт-в-байт, seed статичен в шаблоне); `artifactPath` — канонический `{OUTPUT_DIR}/{build}/{book}_{ch}_{sc}_{unit}.png`; `onArtifactPlaced` — удаление устаревшего превью. Входных файлов нет (text-to-image, разведка §1.4).
  - **Команда:** `/regenerate` v2-книги принимает `image`; `video` — без работ, `summary.skipped_unsupported` (только video → 409); `IU_IMAGE_VERSIONED` включён или ядро < 1.1.0 → 409 `v2_image_unavailable`; layer-config image off → 409 / отмена слоя.
  - **Воркер / хаб:** v3-путь типонезависим (SaveImage → PNG из `COMFY_OUTPUT_DIR` → PUT, cancel из beacon → `/interrupt`) — проверено сквозным прогоном с бандлом 2.4.0 (`reports/2026-11-07/orch-v2-2a-e2e/`).
  - Отчёт: `reports/2026-11-07/orch-v2-2a-image.md`.

Задача G и крупные правки старой оркестрации заморожены (решение 05.11). Хвосты todo, которые закрываются v2: G, этапы 2–3 защиты /regenerate, retry policy соседних job, ложный «онлайн» воркера, `/queue/clear` всех, NULL-дубли `scene_assets`, D (счётчики панели).

## 13. Решения владельца (2026-11-05)

1. **Рестарт backend:** начатые команды продолжаются (состояние в PG, потерь нет). Режима `interrupted` для команд нет; правило Stage 155 «без автозапусков» соблюдено — после рестарта не создаётся ни одной новой работы, выполняются только уже созданные командой.
2. **Результат:** воркер загружает файл напрямую на backend по токену задачи (хаб вне пути данных). Ошибку — тоже напрямую тем же токеном.
3. **Лимиты:** команды не ограничены; private-воркеры без лимита; `shared_limit` только для общих GPU, по умолчанию выключен (§10).
4. **Проверка тишины** при приёме аудио — сразу на этапе 1; тишина = `invalid_result`: один повтор, затем failed.
5. **Имя пакета:** остаётся `@animastor/orchestration`, новая архитектура = мажорная версия **1.0.0**.
6. **Присоединение (по итогам 1a, 06.11):** явная связь `gen_command_jobs`; стоп команды не трогает работы, нужные другой активной команде. Отмена — по слою. `build_id` и `summary` — колонки. Удаление книги чистит `gen_*`.
7. **API (06.11):** один эндпоинт `generate` с `mode: missing | all` вместо generate / regenerate; стоп и прогресс — под `/generate/*`; неиспользуемые эндпоинты удаляются на этапе 4 (§11).
8. **По итогам 1b (06.11):** `from_current_scene` разворачивается в `scope.level='scenes'` (1c); хэш «готово для текущего контента» = sha256 снимка workflow — принят, одна пересборка legacy-аудио допустима; `rebuild_all → force` остаётся до §11 (этап 2); чанки после склейки не удаляются (нужны для перегенерации одного чанка); `DELETE /book/:id/cache` для v2-книги хаб не вызывает (1c).
9. **Этап 2a, изображения (07.11; решения исполнителя по заданию владельца — отчёт `reports/2026-11-07/orch-v2-2a-image.md`):**
   - **Готовность (I2/I5).** Приём `iu_image` пишет в `scene_assets` (тип `image`, та же сборка) часть `metadata.gen_parts[unit_key] = {path, sha256, bytes, job_id, attempt, part_hash}`. Сцена `ready` — когда **все IU сцены** (список `input.scene_parts` = `[{unit_key, part_hash}]` из планировщика) приняты с тем же `part_hash`; приём, закрывающий набор, ставит `ready` + `sha256` (манифест «unit_key:sha256» по порядку) + `job_id` + `path` (файл первого IU) + `format='png'`. Незакрытый набор (часть IU с новым контентом, отмена части) → `pending`. Пропуск без `force` — по части: IU с тем же `part_hash` (sha256 снимка workflow = промпт + негатив + шаблон: seed, размер, шаги, LoRA) не перегенерируется; строка `stale` ничего не доказывает.
   - **Чтение без правок фронтов.** v2 пишет **канонический** файл IU — его отдают `/iu-image`, `/preview` (строит из него), `/scene/…/image`, `/scene/…/storyboard` (список IU из `image_units` / JSON книги, от готовности не зависит), `/book/:id/storyboard` (zip), `/scene/…/status` (`image_ready` по файлам); прогресс — `progress-panel` v2 (у image нет строки склейки). Не обновляются для v2-книги (Redis-счётчики legacy): `assets-state` (`image_ready`, `scope_iu_ready`, `cover_iu_ready`) и `/chunk/:id/image` (флаг `chunk.image`) — фронты по ним картинки не показывают (web/Android берут кадры из storyboard + `iu-image`; из `assets-state` читается только `has_assets`), правка отложена до §11 (этап 2).
   - **Превью `pr-<id>`** — не отдельная работа: его по-прежнему строит backend лениво на `GET /preview`; v2 только удаляет устаревшее превью при приёме нового IU (`onArtifactPlaced`), как legacy-публикация.
   - **`IU_IMAGE_VERSIONED`** (на проде выкл.): v2 его ветку не использует; флаг включён → слой image v2-книги fail-closed (`409 v2_image_unavailable`), аудио и legacy не затронуты.
   - **video** для v2-книги не поддерживается до этапа 3: работ не создаётся, `summary.skipped_unsupported: ['video']`; переход image→video (§6.3) в ядре есть, но не срабатывает (video не входит в слои команды, планировщик video пуст).
   - **Обложка** — первая сцена главы `cover`, её IU идут тем же `iu_image`; отдельной работы нет. Legacy-«сценовый» кадр `{prefix}.png` писателя не имеет и в v2 не делается.
10. **Видео ждёт картинки (07.11, этап 3):** видео-команда присоединяется к уже идущим IU сцены и стартует по приёму последнего; по грязным кадрам (`part_hash` не совпадает с текущим) видео не генерирует — `skipped_image_dirty`; при отсутствии картинок сцену пропускает — `skipped_needs_image`; недостающие и грязные IU сама не ставит — только вручную (§6.5).
