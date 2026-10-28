# Stage 111 — Post-cutover observation and production health audit (read-only)

**Дата проверки:** 2026-10-21, окно **14:32:08Z → 14:55Z** (первый `date -u` = 14:32:08Z; финальные замеры ~14:53Z)
**Объект:** production после Stage 109 cutover на `ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd` (`deploy-78e8f1a`, CI Stage 106, provenance Stage 107 §B.3) и Stage 110 (mirror hooks).
**Режим:** строго read-only. Изменений кода, Git refs, hooks, тегов, `.env`, Compose, БД, Redis, книг и артефактов **не выполнялось**; генерация не запускалась.
**Итог:** **WARN** — все проверки целостности образа, health, данных, артефактов и инфраструктуры пройдены; обнаружены и объяснены 4 группы некритичных расхождений (housekeeping-удаления гостевых записей до cutover, ожидаемая PG-ошибка идемпотентной schema-ensure, один устаревший путь в `scene_assets`, отсутствие DB/Redis baseline в Stage 109) + 2 наблюдения (GPU Hub без GPU; слабое покрытие `docker events`). Потери данных, регрессий, рестартов и несоответствия образа **не обнаружено**.

---

## 0. Baselines, использованные в проверке

| Baseline | Источник | Что даёт |
|---|---|---|
| Stage 109 cutover-отчёт | `reorg-2026-10-19/109-backend-production-cutover-report.md` | ожидаемый digest/labels/health, `.env` sha до/после, счётчики книг/артефактов, список dirty-файлов |
| Stage 109 рабочие снимки | `/tmp/opencode/s109/`: `books-before.txt` (`200beb1a…`), `output-before.txt` (`2a03a8c7…`), `books-api-before.json`/`-after`/`-nginx` (`5cce51ed…`), `backend-inspect-before.json` | path+size-инвентарь `data/books` и `data/output`, тело API, инспекция контейнера |
| Stage 93 контент-манифест | `backups/stage93-data-2026-10-20/source-manifest-pass1.sha256` = `pass2` (156 файлов, SHA-256 **содержимого**), `pg-animastor-schema-2026-10-20.sql`, `pg-restore-test-rowcounts.txt` (41 таблица / 2081 строка), `redis-keyspace-at-copy.txt` (302 ключа) | побайтовый контроль данных, схема БД, счётчики строк, keyspace |
| Stage 110 hooks/refs | `reorg-2026-10-19/110-remaining-mirror-hooks-report.md` §1.3/§6 | SHA-256 hook'ов (`6e24ac6f…`/backup `6a63cb14…`), наборы refs |
| Эталон `book.json` | Stage 93 §5 / Stage 109 §B.4 п.7 | `b4d264b9…` |
| GPU Hub snapshot | `/tmp/opencode/base-gpu.json` (2026-10-14), `post-gpu.json` | `{"gpus":0,…}` — pre-existing состояние |

**Важно:** точных per-file SHA-256 baseline'ов от Stage 109 нет (там сохранён только path+size). Поэтому идентичность содержимого доказана сравнением с **Stage 93 контент-манифестом** (156 SHA-256), а не только совпадением количества/размеров. Stage 109 **не сохранял** baseline'ов по строкам PostgreSQL и keyspace Redis — это зафиксировано как ограничение (§4.1, §4.4).

---

## 1. Backend

### 1.1 Контейнер, image digest, labels

| Проверка | Факт | Baseline | Статус |
|---|---|---|---|
| Контейнер | `animastor-backend`, `running`, `Status=running`, `Paused=false`, `OOMKilled=false`, `ExitCode=0`, `Error=` (пусто) | Stage 109: running | ✓ |
| `Image` / `Config.Image` | `sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd` | задание: `…f6aefe57…` | ✓ |
| `RepoDigests` | `["ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd"]`, RepoTags: `deploy-78e8f1a` + тот же digest | Stage 109 §A.2 | ✓ |
| Labels | `org.opencontainers.image.revision=78e8f1ae4bb581f52b736bc64e5ae603dedab839`, `org.opencontainers.image.version=deploy-78e8f1a`, compose labels: `project=animastor`, `service=backend`, `image=sha256:f6aefe57…`, `environment_file=…/deploy/.env` | Stage 109 §B.4 п.2 | ✓ |
| **`StartedAt`** | `2026-10-21T13:15:38.819168837Z` (тот же, что в Stage 109 §B.4) | Stage 109: `13:15:38Z` | ✓ без изменений |
| **Uptime** | **1 ч 17 мин** на момент первого замера (14:32Z), **1 ч 38 мин** к финалу аудита | — | ✓ |
| **`RestartCount`** | **0** | Stage 109: 0 | ✓ |
| Docker healthcheck | `HealthCheckConfig = NONE` — health проверяется приложением `/health` (как в Stage 109) | — | ✓ (наблюдение) |

Команда: `docker inspect animastor-backend --format …`; подтверждено также `docker compose … ps` (проект `animastor`, `running(5)`).

### 1.2 Health

| Проверка | Метод | Результат | Статус |
|---|---|---|---|
| `/health` напрямую (3 прогона) | `docker exec animastor-backend curl http://127.0.0.1:3000/health` | каждый раз **200** `{"status":"ok","loop":true,"redis":"PONG","ts":<epoch-ms>}` | ✓ |
| `/health` через nginx HTTPS | `curl --resolve animastor.org:443:127.0.0.1 https://animastor.org/health` | **200**, та же строка | ✓ |
| `/health` через nginx HTTP :80 | `curl http://127.0.0.1/health` | **301** → `https://…/health` (штатный redirect TLS) | ✓ |
| `https://animastor.in/health` | `curl --resolve animastor.in:443:127.0.0.1` | **301** → канонический `animastor.org` (конфиг nginx `proxy/conf/default.conf`) | ✓ (штатно) |
| Health-конфиг в коде | `backend/src/backend.cjs:728` (`app.get('/health')`) | возвращает поля `status/loop/redis/ts`; `ts` присутствует в текущем коде → тело 61 B, как и в backend-логе Stage 109/111 (`[HTTP] GET /health → 200 (1ms, 61B)`) | ✓ |

### 1.3 Логи backend после Stage 109 (с `2026-10-21T13:15:38Z`)

Снимок: `/tmp/opencode/s111/backend-since-cutover.log`, **8 809 строк** (по состоянию на ~14:33Z).

| Проверка | Факт | Статус |
|---|---|---|
| Crash-signatures (`FATAL|Uncaught|panic|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|heap out of memory|ERR_MODULE`) | **0** | ✓ |
| `Error`/`ERROR`/`WARN`/`failed`/`Exception`/`disconnect`/`restart` | 0 (единственное совпадение `error` — строка загрузки `[WORKFLOWS] Connectors: 7 loaded, 0 warnings, 0 errors`) | ✓ |
| HTTP-статусы backend | 16×`200`, 1×`404` (`GET /api/mcp` — внешний сканер), **0×5xx** | ✓ |
| Startup | `[PG] PostgreSQL initialized`, `[WORKFLOWS] Loaded 7 workflows`, `[CONNECTOR] Loaded 7 connectors`, `Backend server running on port 3000` | ✓ |
| Runtime-loop | **938 тиков** подряд (`Starting tick #1 … #938`), без SIGTERM/крашей; тик 9–12 мс; `[DRIFT] COUNTER_RECONCILIATION_COMPLETE: 0 corrected` каждый тик | ✓ |
| Reconciliation | стартовый цикл: `6 scenes scanned, 2 inconsistencies found` → обе сцены восстановлены (`orphan_generating_repair`: `sc-45c789c6`, `sc-5f18dd0f`, состояние `generating → dirty → pending`); далее **все** последующие циклы — `0 inconsistencies` | ⚠ см. §4.3 |
| Перезапуск-циклы | отсутствуют (нет повторных startup-блоков, RestartCount=0) | ✓ |
| PostgreSQL-лог на старте | **1 ERROR** `13:15:40.353 relation "users_username_unique" already exists` | ⚠ см. §4.2 |

### 1.4 Фактические значения DATA_ROOT / BOOKS_DIR / OUTPUT_DIR

| Проверка | Факт | Статус |
|---|---|---|
| Переменные в контейнере | `DATA_ROOT`, `BOOKS_DIR`, `OUTPUT_DIR` — **не заданы** (`env | grep`, unset-check) | ✓ как Stage 109 §B.4 п.10 |
| `.env` (deploy) | этих ключей нет; ключ-набор **идентичен** pre-cutover backup Stage 109 (`comm -3` пуст) | ✓ |
| Код-производные значения | `backend/src/config/runtime-config.js:79-81`: `DATA_ROOT = normalizeDataRoot(process.env.DATA_ROOT)` → пусто; `OUTPUT_DIR = … '/data/output'`, `BOOKS_DIR = … '/data/books'` | ✓ |
| Bind-монты (из `/proc/self/mountinfo` контейнера) | `/home/animastor/animastor/data/output → /data/output`, `…/data/books → /data/books`, `…/backend/ai → /app/ai`, `…/backend/tests → /app/tests` (RW) — те же host-пути, что Stage 109 §B.4 п.6 | ✓ |

Секреты (токены, пароли, `.env` целиком) в отчёт не выносились; значения `GPU_HUB_API_KEY`, `OPENROUTER_API_KEY`, `PG_PASSWORD`, `WORKSPACE_SECRET_KEY` только зафиксированы как **присутствуют в контейнере** (redacted).

---

## 2. Книги и артефакты

Методы: `find … -printf '%P\t%s\n' | sort` (path+size, воспроизведение формата Stage 109), `sha256sum` по каждому файлу (контент), `cmp`/`diff` с baseline, `curl` для API.

### 2.1 API `/api/v1/books`

| Проверка | Факт | Baseline (Stage 109) | Статус |
|---|---|---|---|
| Напрямую (`docker exec … curl http://127.0.0.1:3000/api/v1/books`) | HTTP **200**, 1 923 B, **8 книг**; sha256 тела `5cce51ed5177a3d92403fb220eb3fe709ebee78b58fdda4fe25354acaea90977` | `books-api-before.json` = `5cce51ed…` | ✓ `cmp` идентично |
| Через nginx/HTTPS (`https://animastor.org/api/v1/books`) | HTTP **200**, sha256 `5cce51ed…` | `books-api-nginx.json` = `5cce51ed…` | ✓ |
| ID книг | `новая_книга_1788747351369`, `…1788754457378`, `…1788754459266`, `…1788754462605`, `…1788756291018`, `…1789374776899`, `…1791640039242`, `…1791640071055` | тот же список | ✓ |

### 2.2 `data/books` и `data/output`

| Объект | Факт сейчас | Stage 109 baseline | Stage 93 контент-baseline | Статус |
|---|---|---|---|---|
| `data/books` | 61 файл; **1 617 708 Б** по файлам; `du -sb` = **1 703 724** | 61 файл / `du` 1 703 724; inventory sha **`200beb1a7ec8b75240fd741639a1b89e51bbe796c8eca3f839c6e2569d64915c`** | — | ✓ inventory sha **совпал** (`sha256sum` + `diff` пуст) |
| `data/output` | 95 файлов; **63 162 465 Б** по файлам; `du -sb` = **63 203 425** | 95 файлов / `du` 63 203 425; inventory sha **`2a03a8c77ddbb20df2cbcbd73f1f65033a13c5f1c67f8b99bb6d104ec2e1274e`** | — | ✓ inventory sha **совпал** |
| **Контент всех 156 файлов** | SHA-256 каждого файла | в Stage 109 сохранён только path+size | `source-manifest-pass1.sha256` (156 строк, = pass2) | ✓ после `LC_ALL=C sort` **`cmp` идентично** — 156/156 файлов побайтово совпадают с манифестом 2026-10-20 15:07 |
| Верхнеуровневые записи | `books`: 16 (10 каталогов + 6 snapshot.json); `output`: 7 каталогов | Stage 109: 16 / 7 | — | ✓ |
| Изменения после cutover | **0 файлов и 0 каталогов** `data/**` с mtime ≥ `2026-10-21 13:15` | — | — | ✓ |

Состав `data/output`: 66 mp3, 14 png, 10 mp4, 5 json. Проверки читаемости: mp3 непустые (66/66), у контрольного файла `build_ba_1788172242081/…_sc-3c042685.mp3` валидный ID3v2-заголовок (`ID3 … TSSE`), png/mp4/json читаются (открытие без записи).

### 2.3 Контрольный `book.json`

`data/books/новая_книга_1788747351369/book.json` → SHA-256
**`b4d264b9233f0780e8b8302862cfc69f1d2fdc2d15a36a7f02bf177fd067fed3`** — совпадает с эталоном Stage 93/109 (`b4d264b9…`). ✓

### 2.4 Доступность артефактов, на которые ссылаются БД и Redis

| Источник ссылок | Проверка | Результат | Статус |
|---|---|---|---|
| `scene_assets` (459 строк; `ready`: 9 audio, 7 video, 2 image) | существование абсолютных путей `/data/...` на хосте | **8 из 9** существуют; 1 путь-историк — см. §4.4 | ⚠ |
| `scene_assets` (относительные имена image) | поиск по basename в `data/` | 2/2 `ready`-изображения найдены (`output/build_import_…/*_iu-5a1befa0.png`, `*_iu-070ed92b.png`) | ✓ |
| `image_units` (58 строк, 22 уникальных `scene_audio_file`) | поиск по basename в `data/output` | **22/22** найдены | ✓ |
| Redis (`animastor:chunk:*`, `animastor:chunks:*`, `animastor:iu:*`, `animastor:iu-registry:*`, `animastor:video-orch:*`, dispatch-leases) | типы/наличие ключей; скан 321 ключа на path-like значения | ключи присутствуют; path-like значений в строковых ключах нет (значения — счётчики/состояния), 0 missing | ✓ |
| Активность backend↔Redis | `[LEASE] RENEWED: animastor:dispatch-lease:…` каждые ~60 с, `redis: "PONG"` в /health | ✓ |

---

## 3. PostgreSQL и Redis (read-only)

### 3.1 Доступность и отсутствие рестартов/ошибок подключения

| Проверка | Факт | Baseline | Статус |
|---|---|---|---|
| PostgreSQL | `pg_isready`: `/var/run/postgresql:5432 - accepting connections`; `RestartCount=0`; `StartedAt=2026-08-24T16:30:12Z` (~58 дней); compose health `healthy/FailingStreak=0` | Stage 109: healthy, Up 8 weeks | ✓ |
| Ошибки подключения PG со стороны backend | **0** в логе backend (`ECONNREFUSED`/`connection` — нет); 2 активных соединения пула (`pg_stat_activity`: `animastor`=2) | — | ✓ |
| Redis | `PONG`; `RestartCount=0`; `StartedAt=2026-08-24T16:30:12Z`; `uptime_in_seconds=5 005 201` (57.9 дн.); health `healthy/0`; `connected_clients=3`, `used_memory=225.29M` | Stage 109: healthy | ✓ |
| Персистентность Redis | `rdb_last_bgsave_status:ok`, штатные `100 changes in 300 seconds` сохранения в 14:35 и 14:40 (`DB saved on disk`, `terminated with success`), `appendonly no`, `save 3600 1 / 300 100 / 60 10000` | Stage 93: `rdb_last_bgsave_status:ok` | ✓ |
| PG-лог сбоев | 0 crash/restart-событий; FATAL-класса «server down» нет | — | ✓ |

### 3.2 Счётчики записей PG (точные `count(*)`, 41 таблица)

| Таблица | Stage 93 (2026-10-20 15:08) | Сейчас | Δ |
|---|---|---|---|
| `guests` | 311 | **296** | **−15** ⚠ |
| `workspaces` | 455 | **432** | **−23** ⚠ |
| Остальные 39 таблиц (вкл. `books`=2, `book_source`=2, `scene_assets`=459, `image_units`=58, `users`=83, `generation_tasks`=17) | — | идентично baseline | 0 |
| **Итого** | 2081 | **2043** | −38 = −15 −23 |

Разбор и привязка ко времени — §4.1. Потери книг/артефактов нет (`books`, `book_source`, `scene_assets`, `image_units` без изменений; файлы на диске идентичны §2.2).

### 3.3 Схема

`pg_dump --schema-only -U animastor -d animastor` (снимок в память/файл, без изменений) → 2 265 строк; `diff` с `backups/stage93-data-2026-10-20/pg-animastor-schema-2026-10-20.sql` (игнорируя `--`-комментарии/пустые строки): **единственные отличия — случайный `\restrict`/`\unrestrict`-токен pg_dump** (2 строки). Схема **не изменилась**. ✓

### 3.4 Redis keyspace

| Проверка | Stage 93 (15:08, 2026-10-20) | Сейчас | Комментарий |
|---|---|---|---|
| `dbsize` | 302 | **321** (+19) | рост за счёт TTL-ключей: `expires` 4 → **23**; ключи `animastor:dispatch-lease:*`, `animastor:chunk:*`, `animastor:retry-budget:*`, `animastor:runtime:*` — рабочие ключи backend; потеря ключей не выявлена |
| keyspace | `db0:keys=302,expires=4` | `db0:keys=321,expires=23,avg_ttl≈73 597 с` | штатно |

---

## 4. Расхождения (факт → baseline → влияние → действия)

### 4.1 ⚠ PG: `guests` −15, `workspaces` −23 относительно Stage 93

- **Факт:** 296/432 против 311/455 (2026-10-20 15:08). Новых гостей/воркспейсов не создавалось (`created_at` за 24/48 ч = 0; `max(created_at)` ≈ 2026-10-19 10:47Z).
- **Baseline:** Stage 93 `pg-restore-test-rowcounts.txt`. **Stage 109 baseline'ов по строкам PG не сохранял** — прямой измеримый «до/после cutover» отсутствует.
- **Причина (установлена кодом):** встроенная housekeeping-задача `guestRepo.purgeExpired()` (`backend.cjs:810-830`, интервал 6 ч; `guest-repo.js:177` — `DELETE FROM guests WHERE expires_at < $1 OR revoked_at IS NOT NULL` + hard-delete `temporary`-воркспейсов после TTL+grace 23 дня, `ON DELETE CASCADE` от `guests → workspaces`).
- **Время (ограничение):** в логе backend **с начала cutover нет ни одной строки `[GUESTS] Purged …`** (строка печатается только при N>0), а первый запуск interval'а приходится на ~19:15Z. Следовательно удаления произошли **между 2026-10-20 15:08 и cutover 2026-10-21 13:15** (в окне работали 4 запуска purge старого контейнера: 18:32, 00:32, 06:32, 12:32), т.е. **до** смены образа.
- **Влияние:** гостевые идентичности/временные воркспейсы — эфемерные записи; `books`, `book_source`, `scene_assets`, `image_units` и файловый контент не затронуты; ни одна книга с диска не удалена (API по-прежнему 8 книг; `books`=2 в PG).
- **Действия:** рекомендуется на будущее сохранять в cutover-отчёте таблицу счётчиков строк (41 таблица) как baseline; опционально добавить лог с timestamp удалений. Ничего не исправлялось в рамках Stage 111 (read-only).

### 4.2 ⚠ PG ERROR на старте: `relation "users_username_unique" already exists` (13:15:40.353)

- **Факт:** одна строка ERROR в PG-логе за 2 с после старта backend; в логе backend **нет** соответствующего сообщения об ошибке.
- **Baseline:** Stage 109 §B.4 п.13 утверждает «миграции **не выполнялись**».
- **Причина:** schema-ensure при старте (`schema.js:1211` — `ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username)` без `IF NOT EXISTS`); код ловит сообщение `already exists` и молчит. Проверено: схема после старта **идентична** Stage 93 (§3.3) — реальных изменений схемы не было.
- **Влияние:** отсутствует (health/API/data в норме). Уточнение к формулировке Stage 109: идемпотентная schema-ensure при старте **выполняется**, но ничего не меняет.
- **Действия:** при следующем редактировании runbook'ов уточнить формулировку; при желании — в будущем перевести на `CREATE INDEX IF NOT EXISTS`-стиль (вне рамок Stage 111).

### 4.3 ⚠ GPU Hub: `gpus:0`, растущая очередь; 2 сцены «зависли» в skipped-режиме

- **Факт:** на старте backend reconcile нашёл 2 сцены в состоянии-сироте `generating` (`import_1786345731767_1786345734345` ch-1bb5123c: `sc-45c789c6`, `sc-5f18dd0f`) и восстановил их в `pending`; scheduler дважды диспетчеризовал image-стадию (leases приобретены и обновляются каждые ~60 с), но **каждый тик: `Active: 2, Dispatched: 0, Skipped: 2`** — GPU Hub отвечает `{"gpus":0,"queues":{"image":8,…},"workspace_queues":{…:457},"running":0}`.
- **Baseline:** `/tmp/opencode/base-gpu.json` (2026-10-14) — уже `{"gpus":0,…,306}`; позже 315. Т.е. отсутствие GPU **не появилось после cutover**.
- **Влияние:** нет генерации (соответственно нет и новых файлов — подтверждено: 0 файлов в `data/**` моложе cutover); backlog image-очереди вырос 306 (10-14) → **457** (сейчас) — длительная проблема доступности GPU, не регрессия cutover.
- **Действия:** вне рамок Stage 111 — вынести в отдельный этап вопрос доступности GPU worker'ов (причина `gpus:0` и роста очереди). Генерация этим этапом **не запускалась**; backend-фоновая активность не останавливалась (read-only).

### 4.4 ⚠ `scene_assets`: 1 устаревший путь к видео

- **Факт:** строка `status=ready, asset_type=video` ссылается на `/data/output/b1/import_1786345731767_1786345734345_ch-1bb5123c_sc-a740d763.mp4`; каталог `data/output/b1` **не существует**. Файл с тем же basename существует по каноничному пути `/data/output/build_import_1786345731767_1786345734345/…` и покрыт отдельной `ready`-строкой.
- **Baseline:** каталога `b1` нет ни в Stage 93 манифесте (0 совпадений), ни в Stage 109 `output-before.txt` (0 совпадений) → расхождение **существовало до cutover** (и до Stage 93).
- **Влияние:** потери файла нет; ссылка-дубликат ведёт на легаси-путь.
- **Действия:** опционально — вне Stage 111 — починить/пометить устаревшую запись (reconciliation-задача); **не делалось** в рамках read-only.

### 4.5 Наблюдения (не расхождения)

1. **`docker events` малопригоден как доказательство:** и `--since 10m`, и `--since 3h` возвращают ровно **256 событий** (буфер переигрыша daemon'а) — событие `start` контейнера (13:15:38) в него уже не попадает. Отсутствие `die/restart/oom/kill` в events-окне интерпретировалось **только вместе** с `RestartCount=0`, неизменным `StartedAt` и непрерывными логами (ticks #1…#938). Список контейнеров: 0 exited / 0 dead / 0 restarting.
2. **PostgreSQL对外开放:** `0.0.0.0:5432`, историческая брутфорс-активность (85 237 FATAL `password authentication failed` с 2026-07-08) и новые пробы `unsupported frontend protocol` в 13:57/14:39 — внешние сканеры, **успешных входов нет**; к cutover отношения не имеет (безопасность — вне рамок Stage 111).
3. **Внешний трафик через nginx:** за окно аудита 259 записей — 301×204, 200×37, 404×12, 400×5, 405×1, **5xx = 0**; боты (Censys/Infrawatch, `/wp-admin/install.php`, `/mcp`).
4. **Одна PG ERROR 14:37:42** (`unterminated quoted string`) — вызвана **опечаткой в собственной read-only SQL-команде этого аудита**; состояние не менялось. Указано для прозрачности.
5. Стиль тела `/health`: текущее тело содержит поле `ts` (61 B) — в тексте Stage 109 оно приведено сокращённо; код `backend.cjs:728` подтверждает наличие `ts` в текущем ревизии.

---

## 5. Соседние сервисы, `.env`, Git hooks/refs, диск

### 5.1 Сервисы

| Сервис | Статус | StartedAt | RestartCount | Статус Stage 111 |
|---|---|---|---|---|
| `animastor-backend` | Up 1 h 38 m (к финалу) | 2026-10-21T13:15:38Z | **0** | ✓ (cutover-старт) |
| `animastor-proxy` (nginx:alpine) | Up 2 days | 2026-10-19T06:18:24Z | **0** | ✓ |
| `animastor-pg` (postgres:16) | Up 8 weeks (healthy) | 2026-08-24T16:30:12Z | **0** | ✓ |
| `animastor-redis` (redis:7) | Up 8 weeks (healthy) | 2026-08-24T16:30:12Z | **0** | ✓ |
| `gpu-hub` (`…@sha256:3611c644…`) | Up 9 days | 2026-10-12T13:41:43Z | **0** | ✓ |
| Прочие (buildkit, repro-redis) | Up 12 дней / 2 недели | — | — | ✓ (вне compose `animastor`) |

`docker compose --project-name animastor … ps` → `running(5)`, конфиг = `deploy/docker-compose.yml` + `deploy/overlay-backend-standalone.yml` (+ `/home/sureg/animastor/docker-compose.yml` как внешняя третья строка конфига — как и в Stage 109 §A.1). Новых ошибок, связанных с cutover, в логах proxy/pg/redis/gpu-hub **не найдено**.

### 5.2 `.env` — пин `BACKEND_IMAGE`

| Проверка | Факт | Baseline | Статус |
|---|---|---|---|
| SHA-256 файла | `8d21af9a85da34d680062435436f029ad0133bac19e71beb46db03f00b826ee7` | Stage 109 «после cutover»: `8d21af9a…` | ✓ |
| mtime / size / mode | `2026-10-21 13:13:49Z` / 2112 / **600** | Stage 109: тот же (правка 13:13) | ✓ |
| Строка 39 | `BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd` | задание + Stage 109 | ✓ |
| Diff к pre-cutover backup (`fc70bfeb…`, mode 600, сохранён) | **только значение строки 39**; набор ключей идентичен (`comm -3` пуст) | Stage 109 §B.2 | ✓ |
| Локальные образы | `deploy-78e8f1a` = `f6aefe57045a`; rollback `deploy-74088d6` = `182b02525b70` **сохранён локально** | Stage 109 §A.2/B.6 | ✓ канал отката цел |

### 5.3 Hooks и Git refs (после Stage 108/110)

| Репозиторий | `hooks/post-receive` | Backup | Refs (bare origin) | Stage 110 baseline |
|---|---|---|---|---|
| `animastor-backend.git` | `6e24ac6fdbe922faf03cfd8f04361fdb447968b919b6c8b2e32f3081ca01011d` | `.bak-2026-10-21-stage108` = `6a63cb14…130c` | `main=53ce5045`, `remotes/github/main=53ce5045` | ✓ |
| `animastor-android.git` | `6e24ac6f…` | `.bak-…-stage110` = `6a63cb14…` | `main=92a56c0d` | ✓ |
| `animastor-gpu-hub.git` | `6e24ac6f…` | `.bak-…-stage110` = `6a63cb14…` | `master=0f489c7b` | ✓ |
| `animastor-web.git` | `6e24ac6f…` | `.bak-…-stage110` = `6a63cb14…` | `main=fee40509` | ✓ |
| `animastor-worker.git` | `6e24ac6f…` | `.bak-…-stage110` = `6a63cb14…` | `main=b3f94f42` | ✓ |
| `animastor.git` (монорепо) | только `post-receive.disabled` = `6a63cb14…` (не тронут) | — | `master=64127b9e` и 2 исторические ветки | ✓ |

- Файлов в `/home/animastor/repos/**`, изменённых после `2026-10-21 13:50` (т.е. после Stage 110): **0**.
- Рабочая копия backend: HEAD `53ce504536c14413c2c5e7b8546d529db8ee2530`; dirty-набор **тот же, что в Stage 109 §A.1**: `1 D` (`backend/scripts/audit-orphan-books.js`), `4 M` (4 файла `backend/tests/…`), `2 ??` (`deploy/`, `freebuff-chat-…md`) — нетронут.
- Web/Android/GPU Hub/Worker/Docs worktrees: чистые, HEAD прежние.

### 5.4 Диск

| Проверка | Факт | Baseline | Статус |
|---|---|---|---|
| `/` | 99 G total, 77 G used, **18 G free (18 554 458 112 Б)**, **82%** | Stage 109 §A.3: 18 G free, 82% | ✓ без динамики |
| inodes | 885 403 / 6 528 000 (14%) | — | ✓ |
| `data/` | 63 M (`books` 1.9M, `output` 61M) | Stage 109: те же счётчики | ✓ |
| `backups/` | 3.5 G; ничего не создавалось/удалялось (нет файлов новее 13:50) | Stage 93 копия сохранена | ✓ |

---

## 6. Границы этапа — соблюдены

| Ограничение | Статус |
|---|---|
| Только чтение/диагностика | ✓ все операции read-only; `pg_dump --schema-only` и `redis-cli info/scan/get` не изменяют состояние |
| Код / Git refs / hooks / теги / `.env` / Compose | **не изменялись** (`.env` mtime/sha не изменились; refs/hooks идентичны Stage 110; dirty-файлы нетронуты) |
| Push / CI / GHCR / deploy / restart / rollback | **не выполнялись** |
| PostgreSQL / Redis / книги / output | **не изменялись**: счётчики и инвентари стабильны на двух выборках (до и в конце аудита: `296|432|2|2|459|58`, `dbsize=321`, inventory shas `200beb1a…`/`2a03a8c7…`); миграции, восстановление, reconciliation-записи не выполнялись |
| Генерация изображений/аудио/видео | **не запускалась**; новых книг/файлов не создано (0 файлов `data/**` моложе cutover) |
| Удаление временных файлов/архивов/backup'ов | **не выполнялось**; dirty-файлы и чужие репозитории не тронуты |
| Секреты | токены/пароли/`.env` в отчёт не выносились |
| Записи на диск этим этапом | `/tmp/opencode/s111/*` (снимки логов, инвентари, schema-дамп, выборки) и **этот отчёт** |

---

## 7. Итоговая классификация

**Статус: WARN**

Все критерии PASS выполнены: образ, digest и labels соответствуют `deploy-78e8f1a`; health 200 напрямую и через nginx/HTTPS; `RestartCount=0` у всех сервисов; логи без crash-signatures; `data/books` и `data/output` **побайтово идентичны** baseline (path+size Stage 109 + SHA-256 содержимого Stage 93, 156/156); API `/api/v1/books` идентичен (`5cce51ed…`); `book.json` = `b4d264b9…`; схема PG не изменилась; Redis/Pg доступны без рестартов; `.env`-пин и Git hooks/refs не изменились; диск стабилен.

WARN обоснован некритичными, объяснёнными расхождениями и пробелами baseline (ничего не указывает на потерю данных или регрессию):

| # | Расхождение | Baseline | Влияние | Дальнейшие действия |
|---|---|---|---|---|
| 1 | PG `guests` −15, `workspaces` −23 (2081 → 2043) | Stage 93 (2026-10-20 15:08); **Stage 109 DB-baseline отсутствует** | эфемерные гостевые записи; данные/артефакты не тронуты; удаления датируются окном **до** cutover (нет `[GUESTS] Purged` в логе с 13:15) | фиксировать rowcount-baseline в cutover-отчётах; рассмотреть timestamp-лог purge |
| 2 | PG ERROR `users_username_unique already exists` на старте | Stage 109 «миграции не выполнялись» | нет (идемпотентная ensure, схема идентична Stage 93) | уточнить формулировку runbook'а; опционально `IF NOT EXISTS`-стиль |
| 3 | `scene_assets`: `ready|video` → несуществующий легаси-путь `/data/output/b1/…` | отсутствует в Stage 93/109 (т.е. pre-existing) | нет потери: файл существует по каноничному пути `build_import_…` | вне Stage 111: починить/пометить запись |
| 4 | GPU Hub `gpus:0`, image-очередь 457 (была 306/315), 2 сцены в `Skipped` с обновляемыми lease | `/tmp/opencode/base-gpu.json` 2026-10-14 — уже `gpus:0` | нет генерации и новых файлов; pre-existing | отдельный этап: доступность GPU worker'ов |
| 5 | `docker events`-окно ≈256 событий (непригодно как sole-evidence рестартов) | — | методологическое ограничение | опираться на RestartCount/StartedAt/логи |
| 6 | Проба внешними сканерами PG:5432 и новые `unsupported frontend protocol` FATAL (13:57, 14:39) | историческая активность с 2026-07-08 (85 237 FATAL) | успешных входов нет | вне рамок: сетевой доступ к PG |

**Критические условия (BLOCKED) не наступили:** несоответствия digest нет; потери доступности данных/артефактов нет; неожиданных рестартов нет (`RestartCount=0` у всех, непрерывные тики #1…#938); регрессий API/health нет.
