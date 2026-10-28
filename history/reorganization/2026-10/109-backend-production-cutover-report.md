# Stage 109 — Backend production cutover (deploy-78e8f1a по digest)

**Дата:** 2026-10-21 (UTC)
**Итог:** **PASS** — production backend переключён с
`sha256:182b02525b704d531797a3432ffe2adea494dddd69c5a5b69b0d05c08bd37082` (`deploy-74088d6`)
на проверенный образ **`sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd`**
(`deploy-78e8f1a`, release-коммит `78e8f1ae`, CI run `39590195580`, provenance-цепочка
подтверждена в Stage 107 §B.3). Изменён **только** пин `BACKEND_IMAGE` (строка 39 `deploy/.env`).
Health `200 {"status":"ok","redis":"PONG"}` — напрямую и через nginx/HTTPS; книги и артефакты
`DATA_ROOT` (`/data/books`, `/data/output`) читаются; данные до/после **побайтово идентичны**
(61+95 файлов, API-список 8 книг sha `5cce51ed…` совпадает). **Откат не потребовался**;
rollback-образ доступен локально и в GHCR.

---

## A. Этап 1 — Pre-flight (read-only, без изменений)

### A.1 Актуальность Stage 107 §C и состояние production до cutover

| Проверка | Факт | Статус |
|---|---|---|
| `deploy/.env` | mtime `2026-10-19 06:31:53Z`, size 2112, mode 600, sha256 **`fc70bfeb2248c3b59a0e733efa2e940f8b596e43a697e93537c52e2a40047437`** — идентичен базовой линии Stage 107 §C.1 | ✓ |
| Контейнер `animastor-backend` | `running`, `StartedAt=2026-10-19T06:32:08Z`, `RestartCount=0`, Up 2 days | ✓ |
| Текущий image digest | `sha256:182b0252…` (= ImageID = `Config.Image`) — **консистентен** с `BACKEND_IMAGE` | ✓ |
| `BACKEND_IMAGE` (.env:39) | `ghcr.io/animastor/animastor-backend@sha256:182b02525b704d531797a3432ffe2adea494dddd69c5a5b69b0d05c08bd37082` | ✓ |
| Labels | `revision=74088d60…`, `version=deploy-74088d6` | ✓ |
| Health baseline | `200 {"status":"ok","loop":true,"redis":"PONG"}` (exec `/health`) | ✓ |
| Compose | проект `animastor`; config = `deploy/docker-compose.yml` + `deploy/overlay-backend-standalone.yml`; overlay пинит `${BACKEND_IMAGE:?…}`; **никаких `DATA_ROOT`/`OUTPUT_DIR`/`BOOKS_DIR`** в .env/рендере → изменение только пина достаточно | ✓ |
| Соседи | `animastor-proxy` (Up 2 days), `animastor-pg`/`animastor-redis` (healthy, Up 8 weeks), `gpu-hub` — не перезывались | ✓ |
| Логи | 0 `FATAL`/`Uncaught`/`panic` за 2 ч; runtime-loop тикает штатно | ✓ |
| 7 dirty-файлов backend | нетронуты (`git status`: 1 D, 4 M, 2 ?? — список идентичен Stage 106–108) | ✓ |

### A.2 Доступность образов

| Образ | GHCR (анонимный `imagetools inspect`) | Локально | Статус |
|---|---|---|---|
| **Новый** `sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd` | digest совпал, OCI index, состав `9ac1fd23…` (amd64) + `ae4b201f…` (attestation) — 1:1 Stage 107 §B.1 | да, labels `revision=78e8f1ae…`, `version=deploy-78e8f1a`, `RepoDigests` = тот же digest | ✓ |
| **Rollback** `sha256:182b02525b704d531797a3432ffe2adea494dddd69c5a5b69b0d05c08bd37082` | digest совпал (Docker manifest v2) | да, tag `deploy-74088d6` | ✓ |

`docker pull` нового digest перед cutover: `Status: Image is up to date` (уже локально), exit 0.

### A.3 Диск, резервная копия, возможность отката

| Проверка | Факт | Статус |
|---|---|---|
| Свободное место | `/` (и Docker root `/var/lib/docker`): **18 G свободно** (99G total, 82%) — достаточно для смены образа | ✓ |
| Резервная копия данных | Stage 93 `backups/stage93-data-2026-10-20/` (2026-10-20 15:15): `data-books-output-2026-10-20.tgz` (61.8 MB), PG dump 435 KB + schema, Redis RDB 25.9 MB, `manifest-sha256.txt` — **перепроверен в этом этапе: 28/28 OK, exit 0**; восстановление ранее проверено в изолированной среде (156/156 файлов sha256, PG 41/41 таблицы 2081/2081 строк, Redis `dbsize=302`) | ✓ |
| Актуальность копии | данных с момента копии не менялось: 0 файлов в `books`/`output` новее `2026-10-20 15:15`; текущие счётчики 61+95 = 156 файлов = как в копии | ✓ |
| Возможность отката | rollback-образ локально + GHCR (§A.2); пин — одна строка `.env`; `deploy/README.md` фиксирует штатную команду и rollback-процедуру; откат не требует миграций (Stage 107 §C.5) | ✓ |
| «Изменяется только image pin» | diff `.env` до cutover показал **ровно одну** строку к изменению (39 `BACKEND_IMAGE`); Compose-рендер не содержит DATA_ROOT-переменных | ✓ |

**Все 6 pre-flight проверок PASS → переход к cutover (Этап 2).**

---

## B. Этап 2 — Cutover

### B.1 Backup конфигурации (до изменения)

| Артефакт | Значение |
|---|---|
| Файл (вне репозитория, mode 600) | `/home/animastor/backups/deploy-env-pre-cutover-stage109-2026-10-21.env` (+ `.sha256`, mode 600) |
| **SHA-256 (до)** | **`fc70bfeb2248c3b59a0e733efa2e940f8b596e43a697e93537c52e2a40047437`** — совпал с pre-flight |
| Снимок контейнера | `/tmp/opencode/s109/backend-inspect-before.json` (`docker inspect`) |

### B.2 Изменение `.env` — только `BACKEND_IMAGE`

```diff
- BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:182b02525b704d531797a3432ffe2adea494dddd69c5a5b69b0d05c08bd37082   (строка 39)
+ BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd   (строка 39)
```

| Параметр | После |
|---|---|
| diff backup → edited | **ровно `39c39`**, других строк нет (проверено `diff`) |
| **SHA-256 (после)** | **`8d21af9a85da34d680062435436f029ad0133bac19e71beb46db03f00b826ee7`** |
| Строк / mode / size | 39 / **600** / 2112 (без изменений, кроме строки 39) |
| Compose-рендер | `image: ghcr.io/…@sha256:f6aefe57…` — новый пин подхватан |

Замена выполнена точечным `sed` по полному строковому значению (без вывода секретных
значений в контекст); корректность подтверждена `diff` backup↔edited.

### B.3 Пересоздание backend — замечание о фактической production-процедуре

**Инцидент процедуры (без impact на production, устранён до cutover):** первая команда
`docker compose -f … -f … up -d backend` (дословно по Stage 107 §C.2 п.4) **без
`--project-name animastor`** разрешила имя проекта как `deploy` (по каталогу) и попыталась
создать дубликаты `animastor-redis`/`animastor-pg` → `Conflict` (exit 1). Побочные эффекты:
созданы **пустые** orphan-объекты `deploy_net`, `deploy_pg-data`, `deploy_redis-data`.
**Backend НЕ пересоздавался** (упал на depends_on-шаге, до backend), оставался `running` на
`sha256:182b0252…`, `StartedAt` прежний; живой стек использует `animastor_net` /
`animastor_pg-data` / `animastor_redis-data` — **не затронуты**. Orphan-объекты проверены
(0 контейнеров в сети; тома пустые, созданы 13:14:21Z) и **удалены**.

Каноническая процедура взята из `deploy/README.md` («Управление (актуальная команда)»),
где `--project-name animastor` **обязателен**; Stage 107 §C.2 п.4 эту деталь не отражал
(erratum ниже). Выполнено (только сервис `backend`; `postgres`/`redis`/`nginx`/`gpu-hub`
в логе — `Running`/`Healthy`, **не пересоздавались**):

```sh
cd /home/animastor/animastor-backend/deploy
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend
```

Лог: `Container animastor-backend Recreate → Recreated → Starting → Started`, exit 0.

### B.4 Проверки после cutover (по шагам Stage 107 §C.2 п.5 + задание)

| # | Проверка | Результат |
|---|---|---|
| 1 | `docker ps` / `inspect` | `animastor-backend` Up, **Image=`sha256:f6aefe57…`**, `Config.Image` = полная новая ссылка; `StartedAt=2026-10-21T13:15:38Z`; **RestartCount=0** (проверено повторно через ~3.5 мин — без рестартов) | ✓ |
| 2 | Labels | **`revision=78e8f1ae4bb581f52b736bc64e5ae603dedab839`**, **`version=deploy-78e8f1a`** — ровно ожидаемые (Stage 107 §C.3) | ✓ |
| 3 | `/health` (exec, 3 прогона + финальный) | **200** `{"status":"ok","loop":true,"redis":"PONG"}` каждый раз | ✓ |
| 4 | `/health` через nginx (HTTPS :443) | **200**, та же строка с `"redis":"PONG"` (HTTP :80 → 301 на HTTPS — штатно) | ✓ |
| 5 | Логи | **0** `FATAL`/`Uncaught`/`panic`/`error`/`ECONNREFUSED`; `[PG] PostgreSQL initialized`; 7 connectors + workflows загружены; `[HTTP] GET /health → 200`; scheduler-loop тикает (tick #9…) | ✓ |
| 6 | Монты | 4 bind-mount'а на **тех же host-путях**: `data/output→/data/output`, `data/books→/data/books`, `backend/ai→/app/ai`, `backend/tests→/app/tests` (RW) | ✓ |
| 7 | **`DATA_ROOT`**: чтение книг | `/data/books`: 16 записей; `новая_книга_1788747351369/book.json` прочитан, **sha256 `b4d264b9233f…`** — совпадает с эталоном свежей версии из Stage 93 §5 | ✓ |
| 8 | **`DATA_ROOT`**: артефакты | `/data/output`: 7 записей; существующие артефакты читаются (mp3 c валидными ID3-заголовками из `build_ba_1788172242081/`) | ✓ |
| 9 | Функциональный смоук API | `GET /api/v1/books` → **200**, **8 книг**; тело **побайтово идентично** pre-cutover baseline (sha256 `5cce51ed5177a3d9…` до = после), в т.ч. через nginx/HTTPS | ✓ |
| 10 | `DATA_ROOT` env | не задан (`.env`/контейнер) → дефолты `/data/books`,`/data/output` — как до (Stage 107 §C.1); доп. переменные не вводились | ✓ |
| 11 | Соседи | `proxy` Up 2 days, `pg`/`redis` healthy Up 8 weeks, `gpu-hub` Up 9 days — **никто не перезапущен** | ✓ |
| 12 | 7 dirty-файлов | `git status` идентичен до-cutover (`1 D, 4 M, 2 ??`) — нетронуты | ✓ |
| 13 | Схема БД / Redis / данные | миграции **не выполнялись**; БД/Redis не трогались; `.env` изменён только строкой 39 | ✓ |

### B.5 Сверка данных до / после (обязательный шаг)

| Объект | До | После | Diff |
|---|---|---|---|
| `data/books` | 61 файл, 1 703 724 Б; inventory sha `200beb1a…` | 61 файл, 1 703 724 Б | **IDENTICAL** (побайтово по списку path+size) |
| `data/output` | 95 файлов, 63 203 425 Б; inventory sha `2a03a8c7…` | 95 файлов, 63 203 425 Б | **IDENTICAL** |
| API `/api/v1/books` | 8 книг, sha `5cce51ed…` | 8 книг, sha `5cce51ed…` | **IDENTICAL** |

Не обнаружено: удалений, массовых изменений, потери доступности, неожиданных новых файлов.

### B.6 Условия остановки / откат — не сработали; откат НЕ выполнялся

Ни одно условие Stage 107 §C.3 / задания не наступило: контейнер healthy **< 60 с** после
старта (первый `/health` 200 на 3-й секунде после `Started`), Redis PONG, crash-signatures
отсутствуют, labels/монты/данные/книги в норме, отклонений плана нет (кроме устранённого
процедурного эпизода §B.3, не затронувшего production).

**Rollback НЕ выполнялся.** Канал отката не тронут и готов:
- пин: `BACKEND_IMAGE` → вернуть `sha256:182b0252…` (backup `.env` sha `fc70bfeb…` сохранён, mode 600);
- образ `sha256:182b0252…` присутствует локально (`deploy-74088d6`) и читается из GHCR;
- команда: `docker compose --project-name animastor --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend` (тот же smoke после).

---

## C. Границы этапа — соблюдены

| Ограничение | Статус |
|---|---|
| Git refs / hooks / код / версии пакетов | **не изменялись**; 7 dirty-файлов нетронуты; HEAD `53ce5045…` прежний |
| Push / CI dispatch / GHCR build | **не выполнялись** (только `imagetools inspect` и `docker pull` — read-only/fail-fast) |
| Схема БД / Redis / пользовательские данные | **не изменялись** (миграций нет; данные IDENTICAL §B.5) |
| Другие сервисы (proxy/pg/redis/gpu-hub) | **не пересоздавались/не перезапускались** ( Up-времена прежние) |
| Compose-файлы | **не изменялись** (только `.env`, строка 39) |
| Старый образ / резервные копии | **не удалялись** (`deploy-74088d6` локально; Stage 93 backup и новый env-backup сохранены) |
| `.env` | mode 600 сохранён; изменена **только** строка 39; секреты не печатались |
| Записи на диск (этап) | `deploy/.env` (строка 39), env-backup + `.sha256` (backups/, mode 600), временные снимки `/tmp/opencode/s109/`, отчёт Stage 109; orphan-объекты `deploy_*` (созданы ошибочной командой §B.3) — удалены |

## D. Erratum в отчёт Stage 107

**§C.2 п.4** приводит команду `docker compose -f docker-compose.yml -f
overlay-backend-standalone.yml up -d backend` **без `--project-name animastor`**. Фактически
production-процедура (canonical — `deploy/README.md`) **требует** `--project-name animastor
--env-file .env`; без него compose разрешает проект как `deploy` по каталогу и пытается
создать конфликтующие контейнеры pg/redis (§B.3). Рекомендуется при следующем
редактировании runbook-документов использовать команду из README.

## E. Итог

| Артефакт | Значение |
|---|---|
| Статус | **PASS** (cutover выполнен; откат не потребовался) |
| Старый image (было) | `ghcr.io/animastor/animastor-backend@sha256:182b02525b704d531797a3432ffe2adea494dddd69c5a5b69b0d05c08bd37082` (`deploy-74088d6`, `revision=74088d60…`) |
| Новый image (стало) | `ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd` (`deploy-78e8f1a`, `revision=78e8f1ae…`) |
| `.env` | только строка 39 `BACKEND_IMAGE`; sha256 до `fc70bfeb…` → после `8d21af9a…`; backup `backups/deploy-env-pre-cutover-stage109-2026-10-21.env` (mode 600) |
| Health / smoke | 200 `{"status":"ok","redis":"PONG"}` напрямую и через nginx/HTTPS; `/api/v1/books` 200, 8 книг, тело идентично baseline; RestartCount=0; 0 crash-signatures |
| Книги / артефакты | `/data/books` 16 записей, `/data/output` 7 записей; `book.json` sha `b4d264b9…` (эталон); артефакты читаются |
| Данные до/после | books 61 файл IDENTICAL; output 95 файлов IDENTICAL; API IDENTICAL — удалений/потерь нет |
| Откат | **не выполнялся**; канал готов (backup `.env` + образ `sha256:182b0252…` локально и в GHCR) |
