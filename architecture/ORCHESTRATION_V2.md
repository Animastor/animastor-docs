# Оркестрация генерации v2 (ADR)

Статус: **УТВЕРЖДЁН** владельцем 2026-11-05 (вариант «очередь только в PG»; решения по открытым вопросам — §13). Реализация по этапам §12.
Основание: разведка `architecture/ORCHESTRATION_V2_RECON.md` (e3c754c; backend 34634ca, gpu-hub c9aa24f, worker c34c4ea, web d9cb135, android be1233c). Ссылки вида «разведка §N» — туда.
Заменяет: `@animastor/orchestration` 0.3.x — новая архитектура выходит в том же пакете как **1.0.0** (код с нуля; старый код на время миграции — `src/legacy/`, экспорт `legacy`, удаляется на этапе 4), оркестрационную часть backend (категория A разведки §10), Job Protocol v2 (`JOB_PROTOCOL_V2.md`) — для путей v2.
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
2. **I2 Одна правда.** Статус работы — только `gen_jobs.status`. Готовность ассета — только `scene_assets` (пишется только транзакцией приёма, §7). Redis, хаб, файлы на диске статус не определяют.
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
| `created_at`, `finished_at`, `cancelled_by`, `error` | | |

### 4.2 `gen_jobs` — единица работы

Гранулярность — как сейчас у GPU (contracts `job-protocol-v2`): аудио-чанк, IU-картинка, видео-группа; плюс локальные шаги backend (склейка).

| Колонка | Тип | Смысл |
|---|---|---|
| `job_id` | UUID PK | новый, не строковая грамматика v2 |
| `command_id` | UUID FK | |
| `workspace_id`, `user_id`, `book_id`, `chapter_id`, `scene_id` | | денормализованы для выдачи и фильтров |
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

### 4.3 Что остаётся и что уходит

- `scene_assets` — остаётся как «что лежит на диске»: пишется только транзакцией приёма (§7) и созданием заглушек при импорте. Добавить `job_id`, `sha256`. Статусы: `placeholder | ready | stale`. Убрать NULL-build дубли (409 строк) миграцией.
- `layer-config` — переносится из Redis в PG (`book_layer_config`).
- Удаляются после этапа 4: `generation_tasks`, `asset_states`, `generation_cancellations`, `iu_image_fence_reservations`, `iu_image_pointers` (если versioned IU не включён), `reconciliation_events`; все генерационные ключи Redis (разведка §4.5), кроме pub/sub прогресса — его заменяет PG `LISTEN/NOTIFY` (§9), так что Redis генерации не нужен вовсе.
- Пять таблиц, в которые никто не пишет (разведка §3.3), — удалить сразу на этапе 1.

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
4. `INSERT gen_jobs … ON CONFLICT (живой юнит) DO NOTHING` → если юнит уже в работе по другой команде, новая работа не создаётся (команда «присоединяется»; прогресс считает и такие юниты, §9).
5. Создаются только работы **первой ступени** (§6.3). Ответ: `{command_id, summary: {jobs_created, joined, skipped_ready}}` — закрывает расхождение контракта (фронты ждут `summary`; `build_id` больше не нужен, вместо него `command_id`).

Ничего не отменяется у других команд. Широкая отмена — только явной кнопкой (§6.4).

### 6.2 Повторный клик, пересечение команд

Защищено двумя ограничениями: `UNIQUE (book_id, client_action_id)` и «одна живая работа на юнит». Случай 04.11 (случайный тап «Текущая сцена» снёс задачи всей книги) в v2 невозможен: новая команда ничего не отменяет и не дублирует.

### 6.3 Ступени внутри команды

Зависимости не хранятся графом; переход создаётся в той же транзакции, что завершает предыдущую работу (§7), **только если команда `active` и слой включён**:

| Завершилось | Что создаётся |
|---|---|
| последний `audio_chunk` сцены | `audio_merge` (local) |
| `audio_merge` | — (аудио сцены ready) |
| все `iu_image` сцены, если в команде есть video | `video_group` по группам |
| последний `video_group` сцены | `video_merge` (local) |

Это не автозапуск: работа создаётся в рамках команды, которую нажал пользователь (I1).

### 6.4 Отмена

- **Стоп всего по книге** (`cancel-generation`): `UPDATE gen_commands SET status='cancelled' WHERE book_id=$1 AND status='active'` + `UPDATE gen_jobs SET status='cancelled' WHERE command_id IN (…) AND status IN ('queued','running')`. Одна транзакция.
- **Стоп слоя** (`cancel-worker type=…` или выключение слоя в `PUT layer-config`): то же с фильтром по `executor`.
- **Стоп команды** (новое, по `command_id`).
- Запущенная на воркере работа: воркер узнаёт из ответа на beacon (`cancel: [job_id…]`, §8.3) и прерывает ComfyUI (`/interrupt`). Если результат всё равно придёт — 409 по I4, файл выбрасывается.
- Флагов отмены, tombstone, TTL нет: отменённость = статус строк.

## 7. Приём результата (одна транзакция)

`PUT /internal/gen/jobs/:job_id/result?attempt=N` — тело = сырой файл (stream), заголовок `Authorization: Bearer <upload_token>` (HMAC от `job_id`, `attempt`, `exp`; выдаётся при claim).

1. Поток → `{OUTPUT_DIR}/{build}/.incoming/{job_id}.{attempt}.tmp`, на лету sha256 и размер; fsync. Проверка формата (mp3/png/mp4 — magic bytes, длительность аудио > 0 и не тишина — порог RMS, чтобы «тишина = ready» не повторилась).
2. `BEGIN; SELECT … FROM gen_jobs WHERE job_id=$1 FOR UPDATE;` статус `running` и `attempt=N`? Нет → `ROLLBACK`, удалить tmp, `409 stale_attempt`.
3. `rename(tmp → artifactPath(job))` (атомарно, тот же раздел).
4. `UPDATE gen_jobs SET status='done', result_*`; upsert `scene_assets` (`ready`, `sha256`, `job_id`); переходы §6.3; `NOTIFY gen_progress`.
5. `COMMIT` → `200`.

Сбой между 3 и 5: файл уже новый (это валидный результат этого юнита), статус остался `running` → воркер повторит PUT (идемпотентно: тот же attempt, та же sha → после commit 200) или сработает дедлайн → новая попытка перезапишет файл. Состояния «ready без файла» не бывает: ready пишется только после rename.

Ошибка: `POST /internal/gen/jobs/:job_id/error?attempt=N` `{error_class, reason, comfy_status}` → транзакция: та же проверка attempt → `failed` или `queued` с `not_before = now + backoff` (если `attempt < max_attempts` и класс transient/oom). Классы и паузы — из текущей `gpu-retry-policy` (TRANSIENT 30/120 с ×2, OOM 60 с ×1, DETERMINISTIC 0).

Что исчезает: fence, `result-processed` dedup, staging-дерево с `.previous-canonical`, `animastor:result:*`, Phase A recovery, `RESULT_FENCING_MODE`, versioned-IU ветка (если не нужна), base64 и три JSON-хопа.

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

### 8.2 Результат и ошибка

Воркер: `PUT upload_url` (поток файла из `COMFY_OUTPUT_DIR`, без base64), повтор с backoff до 5 раз при сетевой ошибке / 5xx; `409` → прекратить. Ошибка — `POST /internal/gen/jobs/:id/error` прямо на backend тем же токеном (§13.2); хаб в пути результата и ошибки не участвует.

### 8.3 Живость

`POST hub /v3/beacon` раз в 10 с `{gpu, vram, version, current_job_id?}` → хаб пересылает → backend `UPDATE workers SET last_seen=now(), current_job_id=…` и отвечает `{cancel: [job_id…]}` (работы этого воркера в статусе `cancelled`). Хаб **не** продлевает heartbeat сам (I6). Redis-ключ heartbeat не нужен.

### 8.4 Хаб v3 — что остаётся

Аутентификация воркеров, `/installer`, бандл воркера, `/workflow/:id`, два relay-эндпоинта (`next`, `beacon`). Удаляются: `POST /task`, очереди и полосы в Redis, `processing`, `running`, dead-letter, dedup, `result:*`, `DELETE /queue/clear` (особенно полная очистка), сторож таймаутов и orphan-requeue. Прямые правки очередей хаба из backend (`worker-routes.cjs:146–165`) уходят вместе с очередями.

Совместимость: v2-эндпоинты хаба живут, пока есть воркеры 2.x; v3 — новые пути. Воркер 2.4.0 = v3 (протокол 3); тип ноды переводится на v3 переустановкой однострочником.

## 9. Сторож и прогресс

**Сторож** — единственный фоновый цикл генерации, раз в 10 с, идемпотентный, работу не создаёт (кроме повтора уже существующей работы, у которой есть попытки):
1. `running` с `deadline < now()` → как ошибка `timeout` (§7: повтор или failed).
2. `running` у воркера с `last_seen < now() - 60 s` → то же `worker_offline` (раньше дедлайна).
3. Команда `active`, у которой нет `queued`/`running` работ → `done` / `partial` / `failed`; `NOTIFY`.
4. `.incoming/*.tmp` старше 1 ч → удалить.

**Рестарт backend:** делать нечего — всё в PG; воркеры продолжают, результаты принимаются после старта, сторож доберёт просроченное. (Решено §13.1: продолжать.)

**Прогресс:** `GET /api/v1/book/:bookId/progress` = SQL-агрегат по `gen_jobs` активных команд книги (по команде, слою, сцене: queued / running / done / failed; для «присоединённых» юнитов — по живой работе юнита). SSE `progress-stream` подписан на `LISTEN gen_progress` (payload: `book_id`, `command_id`) и при событии отдаёт свежий агрегат. «Призрачных задач» нет: панель показывает строки таблицы.

## 10. Многопользовательский режим

- `workspace_id` — из книги (проверка доступа уже есть), `user_id` — из запроса; оба в каждой строке.
- Справедливость: выдача по наименьшему числу `running` у workspace, затем по времени (§8.1).
- Команды не ограничиваются: пользователь запускает сколько угодно (аудио, картинки, видео другой сцены, VBook — одновременно).
- Свои (private) воркеры — без лимита: каждый воркер берёт одну работу за раз, так что естественный предел = число его нод.
- Лимит `shared_limit` — только на общих GPU (полосы system и policy): сколько единиц работы одного workspace могут **одновременно выполняться** на чужом железе, чтобы один пользователь не занял весь общий пул. Настройка админа, по умолчанию выключен (NULL), пока общих GPU для других пользователей нет. Дневная квота на общие GPU — позже.
- Агенты VBook (LLM) — не GPU-работа, лимит их не касается.
- Приватные воркеры видят только свою полосу (как сейчас). Нет операций без фильтра по книге или команде.
- Нагрузка: 100 пользователей × книги по сотням сцен — сотни тысяч строк, единицы переходов в секунду; claim — индексный запрос. Масштаб упирается в GPU и диск, не в оркестрацию.

## 11. Фронты (web + Android, паритет в той же задаче)

- `/regenerate` (и `/generate`): отправлять `client_action_id`; читать `command_id`, `summary`.
- Прогресс: новый формат агрегата (по команде и слою). Кнопка «Стоп» — по книге (как сейчас) и по команде (новое).
- `layer-config`: тот же контракт, хранилище PG.
- Поля, которые фронты читают и которых backend не отдаёт (`build_id` из /regenerate), — убрать.

## 12. Этапы

| Этап | Кто | Что | Готово, когда |
|---|---|---|---|
| 1 | Claude Code | `@animastor/orchestration` 1.0.0 (новый код; старый — в `src/legacy/` до этапа 4), таблицы `gen_commands`/`gen_jobs`, `book_layer_config`; claim/accept/sweeper/progress; backend `/internal/gen/*`; хаб v3 relay; воркер 2.4.0 (pull v3, PUT результата, cancel из beacon). **Только аудио**, книга переключается флагом `books.orchestration='v2'`. Старая оркестрация для такой книги аудио не трогает (гейт в scheduler/reconcile по флагу). | BA на v2: «аудио» одной сцены, всей главы, Стоп посередине, рестарт backend посередине, выключение ноды посередине, двойной клик — всё по ожиданиям; тесты пакета на чистом PG. |
| 2 | Claude Code | image (IU), фронты (паритет), перенос layer-config, удаление 5 мёртвых таблиц | BA: аудио + картинки по команде |
| 3 | Claude Code | video (группы + merge), `generate_all` (задача H, окна VBook как ступень команды) | BA целиком |
| 4 | Claude Code + кодер | Все книги на v2; удаление `src/legacy/` пакета (старый 0.3.x), кода категории A, генерационных ключей Redis, v2-путей хаба, таблиц §4.3; docs | grep по удалённым ключам/модулям пуст; тесты зелёные |

Задача G и крупные правки старой оркестрации заморожены (решение 05.11). Хвосты todo, которые закрываются v2: G, этапы 2–3 защиты /regenerate, retry policy соседних job, ложный «онлайн» воркера, `/queue/clear` всех, NULL-дубли `scene_assets`, D (счётчики панели).

## 13. Решения владельца (2026-11-05)

1. **Рестарт backend:** начатые команды продолжаются (состояние в PG, потерь нет). Режима `interrupted` для команд нет; правило Stage 155 «без автозапусков» соблюдено — после рестарта не создаётся ни одной новой работы, выполняются только уже созданные командой.
2. **Результат:** воркер загружает файл напрямую на backend по токену задачи (хаб вне пути данных). Ошибку — тоже напрямую тем же токеном.
3. **Лимиты:** команды не ограничены; private-воркеры без лимита; `shared_limit` только для общих GPU, по умолчанию выключен (§10).
4. **Проверка тишины** при приёме аудио — сразу на этапе 1.
5. **Имя пакета:** остаётся `@animastor/orchestration`, новая архитектура = мажорная версия **1.0.0**.
