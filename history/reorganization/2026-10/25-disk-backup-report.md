# Animastor — Этап 25: DISK CLEANUP + LOCAL BACKUPS (+ Redis)

- Дата: 2026-10-12
- Разрешения владельца (использованы): удаление Ollama с моделями; сброс
  истории OpenCode CLI; создание **локальных** backup-копий Animastor
  (внешнее хранилище не настраивалось).
- Режим: production cutover **не выполнялся**; DNS/TLS, секреты, lock-файлы
  не менялись; старый монорепозиторий, книги, `data/output`, Docker-тома
  pg/redis не удалялись; `docker system prune` не выполнялся; restore в
  production не выполнялся; `git push` и перезапись истории не выполнялись;
  FLUSHDB/FLUSHALL, изменение конфигурации и перезапуск Redis не выполнялись.
- Источники: отчёты 21/22/23/24 + фактические измерения этого этапа
  (все команды перечислены в тексте).

---

## 1. ДИСК — точные байты «до» и «после»

| Момент | Всего (Б) | Занято (Б) | Свободно (Б) | Use% |
|---|---|---|---|---|
| До этапа (05:56) | 105496965120 | 85870292992 | **15109570560** | 86% |
| После удаления Ollama (06:00) | 105496965120 | 75307962368 | **25671901184** | 75% |
| После всех backup + reset (финал, контрольный замер) | 105496965120 | 75571085312 | **25408778240** | 75% |
| Повторный замер при сдаче (06:25) | 105496965120 | 75571863552 | **25408000000** | 75% |

- **Освобождено удалением Ollama: `10562330624` Б (≈10,56 ГБ).**
- Потрачено на backup-копии: `263122944` Б (из них файлы копий
  `260062349` Б + staging-копии в `/tmp` 236 390 Б + рост runtime ≈2,8 МБ).
- **Чистый прирост свободного места на момент сдачи этапа: `+10299207680` Б.**
- **Ожидаемый дополнительный прирост: `+9651436056` Б** — после выхода
  текущего процесса OpenCode (см. §3.4): файлы базы удалены из дерева, но
  их inode ещё удерживает работающий процесс сессии.
- Итог с учётом перезапуска OpenCode: ≈ `35060214296` Б свободно.
- Пороги runbook §6: `15000000000` — **выполнен с большим запасом**;
  порог D0 под pull нового образа `16600000000` — **тоже выполнен**
  (25,4 млрд ≥ 16,6 млрд) → root-`journalctl --vacuum` для pull больше не требуется.

---

## 2. УДАЛЕНИЕ OLLAMA

### 2.1 Что найдено (read-only перед удалением)
| Компонент | Факт |
|---|---|
| Контейнер | `ollama` (образ `ollama/ollama:latest`, создан 2026-09-04, Up 5 weeks), порт `127.0.0.1:11434`, env `OLLAMA_HOST=0.0.0.0:11434`, NVIDIA-переменные |
| Образ | `ollama/ollama:latest` = 9,19 ГБ (unique 9,187 ГБ) — использовался **только** контейнером `ollama` |
| Том | `ollama-data` → `/root/.ollama`, **LINKS = 1** (только контейнер `ollama`), 1,359 ГБ, создан 2026-09-04 |
| Хост-установка | **нет**: `ollama` не в PATH; `~/.ollama`, `/usr/share/ollama`, `/usr/local/bin/ollama`, systemd-unit — отсутствуют |
| Open WebUI | **не установлено**: ни контейнера, ни образа, ни каталога (`docker ps -a`, `docker images`, `ls /home/animastor/*webui*`, `/opt/*webui*`) → удалять нечего |
| Зависимости Animastor | `.env` — переменных с `OLLAMA` нет; `docker-compose.yml`/overlay — упоминаний ollama нет; исходники backend/gpu-hub — обращений на `11434` нет; окружения backend/gpu-hub — переменных `*OLLAMA*` нет |

### 2.2 Удалённые компоненты (только подтверждённые)
1. `docker stop ollama && docker rm ollama` — контейнер (12,3 kB).
2. `docker rmi ollama/ollama:latest` — образ (9,19 ГБ).
3. `docker volume rm ollama-data` — том моделей (1,359 ГБ; доказательство
   принадлежности: LINKS=1, единственный монтирующий — контейнер `ollama`).

**Не удалялось:** `docker system prune` не выполнялся; остальные тома
сохранены — `animastor_pg-data` (75,1 МБ, LINKS 1), `animastor_redis-data`
(58,37 МБ, LINKS 1), `animastor_migration_pg`, `animastor_migration_redis`,
`animastor_sqlite-data`, `buildx_buildkit_repro0_state`, анонимные тома;
образы backend/gpu-hub/postgres/redis/nginx/buildkit не тронуты;
Open WebUI отсутствует; файлы проекта, книги и output не тронуты.

### 2.3 Фактический эффект
- `docker system df`: Images 7 → **6** (12,92 GB → **3,73 GB**),
  Containers 8 → **7**, Local Volumes 36 → **35** (3,629 GB → **2,27 GB**);
  reclaimable 634,8 МБ (не трогали).
- Свободно на диске: `15109570560` → `25671901184` = **+10 562 330 624 Б**.

### 2.4 Зафиксированные последствия (в БД проекта не вмешивались)
- Таблица `ai_connectors`: строка **`Test`** (`runtime_type=ollama`,
  `status=online`) и `ai_endpoints`: **`Test endpoint`** (`runtime_type=ollama`)
  остаются в PostgreSQL, но станут **недоступны** (их бэкенд-прокси ходит на
  удалённый `127.0.0.1:11434`). Строки НЕ удалялись (данные проекта).
- Фронтенд-пакет `packages/animastor-web-local-ai` (секция Local AI,
  `local_ai_runtime_ollama`) перестанет работать — это ожидаемо после
  удаления Ollama; на `/health`, `/gpu/health` и пайплайн генерации не влияет
  (проверено: health 200/200 после удаления, §7).

---

## 3. СБРОС ИСТОРИИ OPENCODE CLI

### 3.1 Идентификация базы (это история OpenCode, не данные Animastor)
- Путь: `/home/animastor/.local/share/opencode/opencode.db`
  (определяется штатно: `opencode db path` → тот же путь).
- Инструмент: OpenCode CLI **v1.18.35** (`opencode --version`), команды
  `opencode db`, `opencode session list`, `opencode stats` работают с ней.
- Содержимое (по `sqlite_master`): таблицы `workspace`, `account`, `session`,
  `message`-производные, `event`, `permission`, `project_directory` и т.д. —
  схема OpenCode; **анимасторских данных в ней нет** (БД Animastor —
  PostgreSQL в контейнере `animastor-pg`, отдельно).
- Размер на момент сброса: `opencode.db` **9 574 322 176 Б**,
  `opencode.db-wal` **77 081 112 Б**, `opencode.db-shm` **32 768 Б**
  (итого **9 651 436 056 Б**); каталог также содержит `auth.json`, `log/`,
  `repos/`, `snapshot/`, `tool-output/` — **не тронуты**.

### 3.2 Процессы и WAL/SHM
- Держат файлы базы (проверка `/proc/*/fd`): **только PID 5119 `opencode`**
  (fd 24 → db, 25 → -wal, 26 → -shm) — это текущий процесс сессии агента
  (предок shell-инструмента; цепочка `bash ← opencode(PID5119) ← -bash ← tmux`).
- Прочие процессы: `tmux attach -t opencode` (5076), `tmux new -s opencode1`
  (4094861), `node /tmp/opencode/run-connector.js` (945866, 38 дней) —
  базу **не держат**; других процессов OpenCode **нет**.
- «Соответствующие процессы» к остановке: **кроме текущей сессии — нет**.
  Остановка PID 5119 остановила бы сам этап (агент работает внутри этой
  сессии), поэтому сброс выполнен штатным удалением файлов, а освобождение
  места привязано к выходу процесса (§3.4).

### 3.3 Выполненный сброс и проверка новой базы
```bash
rm -v ~/.local/share/opencode/opencode.db{,-wal,-shm}   # 3 файла удалены (06:19)
```
Проверки после удаления:
- каталог: `opencode.db*` отсутствуют; `auth.json`, `log/`, `repos/`,
  `snapshot/`, `tool-output/` на месте (другие базы/настройки не тронуты);
- `opencode session list` → exit 0, созданы новые `opencode.db` (249 856 Б)
  + `-wal` + `-shm` (06:19); вывод: **Sessions 0, Messages 0** (история пуста);
- `opencode stats` → exit 0 (пустая статистика, «Days 0»);
- `opencode db "SELECT name FROM sqlite_master …"` → запрос выполняется,
  таблицы новой схемы читаются → **OpenCode запускается и создаёт новую базу**.

### 3.4 Фактическое освобождение места
- **Освобождено прямо сейчас по OpenCode: 0 Б** — файлы удалены из дерева
  каталогов, но inode старой базы удерживается работающим процессом PID 5119
  (`/proc/5119/fd/24..26 → …opencode.db (deleted)`). Это штатное поведение
  POSIX: диск освобождается только после выхода процесса.
- **Освободится при завершении/перезапуске текущей сессии OpenCode:
  `+9 651 436 056` Б** (проверка после перезапуска: `df -B1 /` станет
  ≈ `35060214296` Б свободно; новых `opencode.db` — маленькая новая база).
- Вместе с удалением Ollama общий эффект после перезапуска OpenCode
  составит ≈ **+20,2 ГБ** к исходным 15,1 ГБ.

---

## 4. ЛОКАЛЬНЫЕ BACKUP-КОПИИ ANIMASTOR

Каталог: **`/home/animastor/backups/`** (существующий, тот же, что в
runbook A2/A3). Внешнее хранилище не настраивалось. Исходные данные после
копирования **не удалялись** (проверено: `data/output` — 95 файлов,
`data/books` — 61, mono `HEAD 465453df`, PG 41 таблица — см. §7).

| # | Артефакт | Размер (Б) | sha256 | Проверка целостности |
|---|---|---|---|---|
| 1 | `cutover-pg-2026-10-12.dump` (pg_dump -Fc) | 441 269 | `5ac76d7b37f49a166d1e9d17f87a81b3df4381c0e3a5cd0d6cf87544bd0356b4` | заголовок `PGDMP` ✓; `pg_restore --list` = **278** TOC-записей, exit 0 ✓ |
| 2 | `cutover-pg-schema-2026-10-12.sql` (schema-only) | 68 263 | `3bafcfa5043d81726e853b99b243d524a9a79a56f4425b54b192a426b0c582b7` | `grep -c 'CREATE TABLE'` = **41** ✓ |
| 3 | `cutover-data-2026-10-12.tgz` (`data/` целиком) | 61 786 941 | `dfc1cafa79c17f9c2f070161a5babfe3cbe7628d24fa53028acb90c4b31cec78` | `gzip -t` exit 0 ✓; в архиве **95** файлов output + **61** books (== источник) ✓ |
| 4 | `cutover-config-2026-10-12.tgz` (композ, overlay, `.env`, `proxy/conf`) — **600** | 8 067 | `2f76049f7e32f4e6328e628312ed414f3d8588acd8b76050c40616e13015debe` | `gzip -t` ✓; состав: `docker-compose.yml`, `docker/compose/overlay-{backend,gpu-hub-local,gpu-hub-standalone}.yml`, `.env`, `proxy/conf/default.conf`, `proxy/conf/.htpasswd` (содержимое секретов не раскрывалось) ✓ |
| 5 | `git_repos_2026-10-12_06-00-27.tar.gz` (bare-репозитории, см. §5) | 51 801 578 | `e03b1c5da444919d62a8a05215b5e0e2d13f774bab74fb65d00e7db0f1a9573d` | `gzip -t` ✓ (создан исправленным `git_backup.sh`); 2 786 записей, все 6 `*.git` ✓ |
| 6 | `git-worktrees-2026-10-12_06-00-43.tar.gz` (`.git` 6 worktree) | 87 343 374 | `070742b3bc2cd11bdc390eb91265a4a063fc3a0e56ad1ec1525d02e571d51f19` | `gzip -t` ✓; 4 269 записей ✓ (включая незапушенные коммиты mono) |
| 7 | `git-untracked-2026-10-12_06-17-10.tar.gz` (незакоммиченные файлы) | 236 390 | `6ab5750b7a385077b758162e28cd33f58f630f018fe383ad4c3416d0056707d2` | `gzip -t` ✓; содержит mono `docker/compose/overlay-backend-standalone.yml` (sha `eac32cb0…`) и backend `freebuff-chat-2026-10-11T07-41-12.445Z.md` (sha `2134973a…`) ✓ |
| 8 | `git-refs-status-2026-10-12.txt` (HEAD/status/ref-манифест) | 1 450 | `1aa56849453d260b95a1fb0e9a729807e4b1840a2044c468ac96bab41f0a9f18` | реестр ссылок bare + статусы 6 worktree ✓ |
| 9 | `redis-dump-2026-10-12.rdb` (**600**, см. §6) | 58 372 973 | `3202408cf444385da80d0dd8f1858e76e2e9ad0bae422ec4162d94afa69a5942` | `redis-check-rdb` → «Checksum OK / RDB looks OK / 321 keys read» ✓; sha == sha файла в контейнере ✓ |
| 10 | `backup-manifest-2026-10-12.sha256` (манифест) | 888 | — | sha256 всех 9 артефактов выше ✓ |

**Итого новых backup-данных: 260 062 349 Б** (все не пустые, все проверены).

### 4.1 PostgreSQL (штатный pg_dump)
- `docker exec animastor-pg pg_dump -U animastor -Fc animastor > …dump`
  (custom-формат, без пароля — через сокет контейнера) + schema-only вариант
  для A3-проверки `CREATE TABLE`.
- Структура дампа проверена штатными средствами: `PGDMP`-заголовок,
  `pg_restore --list` (278 записей), 41 `CREATE TABLE`.
- Целостность живой БД после съёмки: таблиц **41**; счётчики
  `users=83, workspaces=393, guests=255, book_source=3, generation_tasks=17,
  scene_assets=503` — совпали с baseline этапов 22–24.
- Restore в production **не выполнялся** (запрещено).

### 4.2 data/ (books + output)
- `tar -czf cutover-data-….tgz -C /home/animastor/animastor data` — каталог
  целиком (books — входные материалы, output — результаты генерации).
- Проверки: `gzip -t`, состав 95/61 == источнику, исходники на месте.

### 4.3 Конфигурация (без раскрытия секретов)
- Архив `chmod 600`; `.env` входит в архив (как требует runbook A2),
  содержимое не читалось и в отчёт не выносилось; sha256 `.env` до/после
  `ee64133e96734a4b82fedc2fcffb2aeb597c30a9bc1afc53324b070d42c980ba`
  (файл не изменялся).

---

## 5. GIT BACKUP (patch применён, push не выполнялся)

### 5.1 Проверка и применение `23-git-backup-proposed.patch`
- `bash -n` новой версии (на временной копии) → OK; `patch --dry-run -p1` → OK.
- Применение: `patch -p1 < …/23-git-backup-proposed.patch` в
  `/home/animastor/backups/` → `git_backup.sh`: **240 Б → 1 156 Б**,
  mtime `2026-04-19 14:26` → `2026-10-12 06:00`; `bash -n` после — OK.
- Запуск: `bash git_backup.sh` → exit 0, создан и проверен
  `git_repos_2026-10-12_06-00-27.tar.gz` (51 801 578 Б, `gzip -t` OK,
  6 bare-репозиториев).
- **`git push` не выполнялся; история не переписывалась** (никаких
  `--force`, `update-ref`, `commit`).

### 5.2 Полнота гит-копии (архив bare + worktree `.git` + untracked)
| Репо | HEAD worktree | bare | Покрытие в копии |
|---|---|---|---|
| mono `animastor` | `465453df` (ветка `c21.4-…`, **36 коммитов ahead of master**, не запушено) | master `64127b9e` + `c21.4-…` = `465453df` | bare-тар + worktree-тар; **untracked overlay отдельно** (tar №7, sha `eac32cb0…` == известному) |
| web | `fbc93662` | `c7fe52ac` (−1) | worktree-тар закрывает расхождение |
| backend | `a7a8c463` | `bce64db3` (−4) | worktree-тар + untracked `freebuff-chat…md` |
| worker | `b3f94f42` | `618f87a6` (−1) | worktree-тар |
| android | `92a56c0d` | `254e2f08` (−1) | worktree-тар |
| gpu-hub | `ecefd0b7` | `ecefd0b7` (==) | bare-тар полон |
- GitHub (read-only `ls-remote`, push не выполнялся): HEAD == worktree для
  web/backend/worker/android/gpu-hub; репозиторий `Animastor/animastor`
  (mono) на GitHub **не существует** → локальная копия mono критична и
  обеспечена (bare + worktree + untracked).
- Рекомендация (на будущее, не блокер): после разрешения G8 синхронизировать
  bare ↔ worktree, чтобы bare-копия сама по себе была полной.

---

## 6. REDIS BACKUP

### 6.1 Фактическая конфигурация (только чтение, `CONFIG GET`/`INFO`)
| Параметр | Значение |
|---|---|
| Контейнер / образ | `animastor-redis` (`redis:7`), Up 6 weeks (healthy), **не перезапускался** |
| Запуск | `redis-server` без флагов (проверено `docker inspect … .Args`) |
| Доступ | без пароля (`redis-cli PING` → `PONG`); **хост-порт не публикуется** (только docker-сеть) |
| **Режим хранения** | **только RDB**: `save 3600 1 300 100 60 10000`, **`appendonly = no` (`aof_enabled:0`)** → файлов AOF **нет** |
| Файлы | `dir=/data`, `dbfilename=dump.rdb` → `/var/lib/docker/volumes/animastor_redis-data/_data/dump.rdb` (том `animastor_redis-data`, 58,37 МБ) |
| Политика | `maxmemory=0`, `maxmemory-policy=noeviction` (данные не вытесняются) |
| Состояние до снимка | `rdb_changes_since_last_save:186`, `rdb_last_bgsave_status:ok`, `rdb_saves:13987` (Redis и так регулярно делает BGSAVE по своему `save`-правилу) |

**Используемые Redis DB:** только **db0** (`INFO keyspace`: `db0:keys=321,
expires=2`); db1–db15 пусты. Итого **321 ключ**.

### 6.2 Назначение ключей и деление на A/B
**A. Постоянные / критичные для восстановления (Redis-уникальные или
чувствительные) — сохранены в копии:**

| Ключ(и) | Кол-во | Что это | Восстановимость из других источников |
|---|---|---|---|
| `animastor:prompt-profiles` | 1 (string, 59 Б) | глобальный выбор пользователем prompt-профилей (audio/image/video), Settings → Worker settings; **единственное хранилище — Redis** (в PG таких ключей нет: `system_settings` — 0 строк) | **НЕ восстанавливается** из PG → терять нельзя; сохранено |
| `animastor:worker-auth` | 1 (hash) | **зеркало** таблицы `workers` PostgreSQL (token_hash → worker), «mirror fast-path»; содержит чувствительные token-hash | восстановимо из PG (`workers`) автосинхронизацией, но в копии сохранено; файл копии — права 600 |
| `animastor:layer-config:<bookId>` | 3 | пер-книжная runtime-конфигурация слоёв; сервис умеет `restoreFromBooks(redis)` — канон в PG (books/audio_layers) | пересоздаётся из PG; сохранено |

**B. Очереди, временные ключи и кэш (восстановимы/пересоздаваемы):**

| Группа ключей | Кол-во | Характер |
|---|---|---|
| `animastor:queue:image`, `animastor:queue:image:ws:3317e019-…` | 2 (list: 8 + 252 элемента) | очереди задач image-генерации → **восстанавливаются из `generation_tasks`/пересоздаются** |
| `animastor:event-journal:*` (+ `_system:_recovery:_cycle`) | 10 (list, до 515 139 элементов) | журнал прогресса/событий сборки → операционный лог; частично дублируется PG (`book_events`, `reconciliation_events`) → **требует отдельной проверки полноты** |
| `animastor:chunk*`, `chunks`, `assets`, `asset-state`, `iu`, `audio-orch`, `video-orch`, `book-scenes`, `scene-state`, `retry-budget`, `cancelled-workers` | 77+7+60+18+46+8+3+14+3+6+44 = **286** | runtime-состояние пайплайна генерации; канон в PG (`generation_tasks`, `asset_states`, `scene_assets`, `image_units`, `output_manifests`) → кэш/прогресс, пересоздаётся |
| `dispatch-lease:*`, `dispatch-meta:*` (TTL), `trigger_cooldown:*` | 2 + 9 | аренды/кулдауны с TTL (2 ключа уже с TTL) → временные |
| `runtime:*`, `circuit:*`, `active-scenes`, `processing-claimed`, `generation`, `scheduler history` (1 000 записей) | 2+2+1+1+1+(runtime) | health/limiter/scheduler-состояние → пересоздаётся при старте |

Итого: A ≈ 5 ключей (единственное Redis-уникальное содержимое —
`prompt-profiles`, 59 Б), B ≈ 316 ключей. **Вся БД (обе группы) сохранена
полностью** в `redis-dump-2026-10-12.rdb`.

### 6.3 Метод резервирования (штатный RDB, без обхода ограничений)
1. Согласованность: **прямое копирование работающего `dump.rdb`/AOF не
   применялось** (задача запрещала). Вместо этого использован **штатный
   механизм RDB — `BGSAVE`** (его же использует сам Redis по конфигурации
   `save`, `rdb_saves:13987`): данные на момент снимка согласованы,
   запись идёт во временный файл с атомарным rename.
   AOF отключён (`aof_enabled:0`) → **важных данных вне RDB нет**
   (аргумент «снимок недостаточен» не срабатывает).
2. `BGSAVE` → «Background saving started»; опрос до
   `rdb_bgsave_in_progress:0` + `rdb_last_bgsave_status:ok`
   (затрачено ~2 с); `LASTSAVE` **1791785847** (= **2026-10-12 06:17:27 UTC**);
   `rdb_changes_since_last_save` 186 → **4** (перехвачены все изменения на
   момент снимка; остаток — записи, сделанные уже после снимка).
3. Копирование согласованного файла потоком через docker-exec (без правок
   конфигурации, без перезапуска, без FLUSHDB/FLUSHALL, без удаления ключей):
   `docker exec animastor-redis cat /data/dump.rdb > backups/redis-dump-2026-10-12.rdb`,
   затем `chmod 600`.
4. **Проверка целостности штатным инструментом `redis-check-rdb`:**
   - исходный файл в контейнере: «RDB looks OK», **321 keys read**, 2 expires → exit 0;
   - **скопированный** файл (возвращён в контейнер во временный `/tmp/verify.rdb`,
     без подключения к production Redis): «**Checksum OK** / RDB looks OK /
     321 keys / 2 expires» → exit 0.
5. Зафиксировано: размер **58 372 973 Б**; sha256
   **`3202408cf444385da80d0dd8f1858e76e2e9ad0bae422ec4162d94afa69a5942`**
   (совпадает с sha файла в контейнере); время создания
   **2026-10-12 06:17:45 UTC** (mtime копии; снимок `LASTSAVE` 06:17:27);
   заголовок `REDIS0012`; права 600.
6. После снимка: `DBSIZE` = **321**, `rdb_last_bgsave_status=ok`,
   `aof_enabled=0` — состояние Redis не изменилось, контейнер не
   перезапускался (startedAt `2026-08-24T16:30:12Z` — прежний).
7. Секреты в отчёт не выносились (пароля у Redis нет; содержимое ключей
   `worker-auth`/`prompt-profiles` не печаталось). Тестовое восстановление
   к production Redis **не подключалось** (проверка — только `redis-check-rdb`
   по файлу).

**Ограничения, которые НЕ обходились:** конфигурация не менялась,
`CONFIG SET/REWRITE` не выполнялись, контейнер не перезапускался,
`FLUSHDB/FLUSHALL` не выполнялись. Штатный BGSAVE состоянию работающего
Redis не противоречит и не требовал остановки — остановка не понадобилась.

### 6.4 Что сохранено / что восстановимо / что временно (итог по Redis)
- **Сохранено полностью:** все 321 ключей db0 в одном RDB-снимке
  (включая A-группу и очереди), sha+check-rdb подтверждены.
- **Можно восстановить без этой копии (из PG/пересоздать):** worker-auth
  (зеркало `workers`), layer-config (из books/audio_layers), все runtime-ключи
  B-группы, очереди image (из `generation_tasks`).
- **Временные / требуют отдельной проверки:** `event-journal:*` (полнота
  журнала относительно PG — проверить до cutover), непустые очереди
  `animastor:queue:image*` (8 + 252 элемента при **0 активных**
  `generation_tasks` — вероятно, устаревшие, проверить), ключи с TTL
  (`dispatch-lease/meta`) и «hluk» scheduler history.
- **Единственное критичное Redis-уникальное содержимое:**
  `animastor:prompt-profiles` (59 Б) — входит в снимок.

---

## 7. ПРОВЕРКИ ДИСКА И СИСТЕМЫ (после всех действий)

| Проверка | Результат | Статус |
|---|---|---|
| Свободное место (точные байты) | `df -B1 /` → всего `105496965120`, занято `75571085312`, **свободно `25408778240`** (было `15109570560`) | PASS (порог `15000000000` и D0 `16600000000` выполнены) |
| Backup-копии существуют и не пусты | 10 новых файлов, 260 062 349 Б, все с sha256 в манифесте; `gzip -t`/`pg_restore --list`/`redis-check-rdb` — OK | PASS |
| PostgreSQL структура | 41 таблица; `users=83, workspaces=393, guests=255, book_source=3, generation_tasks=17, scene_assets=503` | PASS (== baseline) |
| Исходные данные целы | `data/output` 95 файлов, `data/books` 61; mono `HEAD 465453df`; tomы `animastor_pg-data`/`animastor_redis-data` на месте | PASS |
| Uptime контейнеров | `animastor-backend` Up 41 h (startedAt 2026-10-10T13:46:31Z), `gpu-hub` Up 3 d (10-08), `animastor-proxy` Up 5 w (09-02), `animastor-pg` Up 6 w healthy (08-24), `animastor-redis` Up 6 w healthy (08-24), `repro-redis` 5 d, `buildx_buildkit_repro0` 3 d — **ни один не перезапускался**; контейнеров стало 7 (удалён только `ollama`) | PASS |
| `/health` | 200 | PASS |
| `/gpu/health` | 200 | PASS |
| Lock-файлы | L1 `069b62d931c1ff0e139cd870b287972db3ac66d166cf1906f45f13b87fba6cde`; L2 `2a221e3ba626326c432c542c5417ab3cdc38af67d294e404bf69586b480b7684` — **== baseline** | PASS |
| Git-деревья | mono `?? docker/compose/overlay-backend-standalone.yml`; backend `?? freebuff-chat-2026-10-11T07-41-12.445Z.md`; web/worker/gpu-hub/android — пусто — **== baseline** (новых изменений не появилось) | PASS |
| Docker (без prune) | Images 6 / 3,73 GB; Containers 7; Local Volumes 35 / 2,27 GB; reclaimable 634,8 МБ — **не удалялось** | PASS |
| Redis после BGSAVE | `DBSIZE 321`, `rdb_last_bgsave_status=ok`, `aof_enabled=0` | PASS |

**Действия, которые не выполнялись (зафиксировано):** production cutover;
Compose switch; `docker compose up/stop/restart/down`; dispatch/repin/republish;
push; `docker system prune`/`volume prune`; удаление книг/output/mono;
изменение DNS/TLS/секретов/lock-файлов; FLUSHDB/FLUSHALL; перезапуск Redis;
restore в production; очистка журналов; настройка внешнего хранилища.

---

## 8. ЧТО ОСТАЛОСЬ ДО CUTOVER

Закрыто этим этапом (из блокеров G1/этапов 22–24):
- ✅ **A2/A3 выполнены**: конфиг-тар (600), `data/` целиком, `pg_dump`
  (custom + schema) — созданы и проверены.
- ✅ **Локальные копии git**: bare-тар (исправленный `git_backup.sh`),
  worktree-тар, untracked-файлы, ref-манифест.
- ✅ **Redis-копия**: штатный RDB-снимок с `redis-check-rdb`-проверкой.
- ✅ **Диск**: `25 408 778 240` Б свободно → пороги `15e9` (A1) и `16,6e9`
  (D0) выполнены → root-`vacuum` для pull не требуется.
- ✅ **Место**: ~10,56 ГБ от Ollama; ещё ≈9,65 ГБ вернётся после перезапуска OpenCode.

Осталось (прежние блокеры, требуют решений/разрешений):
1. **Off-host/внешнее хранилище отсутствует** (B1) — копии локальные, на том
   же диске; владелец должен определить канал (внешний диск / endpoint) и
   перенести комплект; mono-кода на GitHub нет.
2. **Restore-тест** (B5) не выполнялся — окно и разрешение (план в отчёте 24 §5).
3. **Синхронизация bare ↔ worktree** — G8 (push запрещён); отставание bare
   покрыто worktree-таром, но постоянная схема не закрыта.
4. **D4** — механизм republish zip-активов не подтверждён (решение владельца).
5. **G6/TLS**: продление `.in` (дедлайн **2026-11-19**) — root; webroot-зависимость от mono `frontends/website`.
6. **G4** — утверждение layout deploy-каталога; E-фазы (compose-сверка, E6 перенос downloads/`.well-known`).
7. **F/G5** — E2E-окно; **G3** — разрешение на push/CI; **G7** — единый GO/NO-GO.
8. Проверить до cutover: непустые очереди `queue:image` (8+252 при 0 активных
   задач) и полнота `event-journal` (см. §6.4).
9. После перезапуска OpenCode — повторить `df -B1` (ожидание ≈35,06e9 Б).

---

## 9. Отдельно: что сохранено, что восстановимо, что временное

| Объект | Сохранено (копия) | Восстановление | Статус |
|---|---|---|---|
| PostgreSQL `animastor` | `cutover-pg-2026-10-12.dump` + schema.sql | `pg_restore` (в изолированной среде) | **сохранено и проверено** (41 таблица, счётчики == baseline) |
| `data/books` + `data/output` | `cutover-data-2026-10-12.tgz` | распаковка, сверка 95/61 + sha | **сохранено и проверено** |
| Конфигурация (compose/overlay/`.env`/proxy) | `cutover-config-2026-10-12.tgz` (600) | распаковка; sha `.env` зафиксирован | **сохранено и проверено** |
| Git: bare (6) + worktree (6) + untracked | `git_repos_*`, `git-worktrees_*`, `git-untracked_*`, `git-refs-status-*` | распаковка, сверка ref/status | **сохранено и проверено** (mono-изменения покрыты) |
| Redis db0 (321 ключ) | `redis-dump-2026-10-12.rdb` (600) | `redis-cli --rdb`/запуск тестового Redis на копии (вне production) | **сохранено и проверено** (`redis-check-rdb`) |
| Redis: `prompt-profiles` (A) | входит в RDB-копию | только из этой копии | **критично, сохранено** |
| Redis: `worker-auth`, `layer-config` (A/B) | входят в копию | из PostgreSQL (`workers`, `books`/`audio_layers`) | восстановимо без копии |
| Redis: очереди/журнал/кэш (B) | входят в копию | пересоздаются; `event-journal` — **требует отдельной проверки полноты** | временные |
| История OpenCode CLI | **намеренно удалена** (сброс по решению владельца) | восстановлению не подлежит (и не требовалось) | сброшена; новая база работает |
| Ollama с моделями | **намеренно удалена** | при необходимости — переустановка (вне скоупа) | удалено (10,56 ГБ) |
