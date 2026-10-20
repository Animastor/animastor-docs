# Animastor — Этап 23: BACKUP / RESTORE READINESS

- Дата: 2026-10-12
- Режим: **только аудит и подготовка. Ничего не создавалось (архивы/копии),
  не исправлялось в источниках, не восстанавливалось.** Restore и тестовые
  контейнеры не запускались; исходный `/home/animastor/backups/git_backup.sh`
  не изменялся (проверено: 240 Б, mtime Apr 19 — прежние); production
  нетронут; секреты не читались и не выводились (psql — через сокет контейнера
  под пользователем animastor, без паролей; `.env` не открывался).
- Источники: `22-g1-readiness-audit.md`, `21-production-cutover-runbook.md`,
  скрипты `/home/animastor/backups/*.sh`, `docker-compose.yml`, фактические
  измерения этого этапа (все команды — read-only, перечислены в тексте).
- Подготовленный patch: `23-git-backup-proposed.patch` (47 строк, отдельный файл).

---

## 1. PostgreSQL

### 1.1 Что найдено (конфигурация и механизмы)
- Подключение (из `docker-compose.yml`, **без вывода паролей**): контейнер
  `animastor-pg` (`postgres:16`), БД `animastor`, пользователь `animastor`,
  том `animastor_pg-data`→`/var/lib/postgresql/data`; backend получает
  `PG_HOST=postgres PG_PORT=5432 PG_DB=animastor PG_USER=animastor` (пароль —
  через `${POSTGRES_PASSWORD}` из `.env`, не читался).
- Версия (read-only SELECT): **PostgreSQL 16.14** (Debian), `data_directory`
  = `/var/lib/postgresql/data` (named volume), `wal_level=replica`.
- Существующих PG-backup-механизмов в скриптах/документации **нет**
  (`rg 'pg_dump'` по backups/mono-tools — 0 находок, этап 22 §2.3). Дампов
  не существует.

### 1.2 Что включать в backup (инвентаризация, read-only)
- БД: **`animastor` (16 MB)** — обязательно; `postgres` (7,5 MB) — служебная,
  включить опционально (`--create` не нужен, шаблоны пропускаются).
- Схема: `public`, **41 таблица** (полный список: agent_conversations,
  agent_messages, agent_sessions, agent_steps, ai_chat_sessions, ai_connectors,
  ai_endpoint_share_policies, ai_endpoints, asset_dependencies, asset_states,
  audio_layers, book_events, book_generation_sessions, book_snapshots,
  book_source, books, cache_entries, character_aliases, character_mentions,
  character_resolution_runs, character_window_candidates,
  generation_cancellations, generation_tasks, guests, image_units,
  output_manifests, reconciliation_events, scene_assets, scenes,
  sentence_resolutions, sessions, share_policies, share_policy_grants,
  storyboard_elements, system_ai_providers, system_settings, users, workers,
  workspace_ai_providers, workspace_members, workspaces).
- Критические данные (счётчики зафиксированы как baseline для проверки
  восстановления): `users=83`, `workspaces=393`, `guests=255`, `book_source=3`,
  `generation_tasks=17`, `scene_assets=503`; плюс `books`, `scenes`,
  `audio_layers`, `output_manifests` (связь с файлами `data/output`),
  `workspace_ai_providers`/`system_ai_providers` (секреты провайдеров —
  зашифрованы AES-256-GCM, входят в дамп как ciphertext).

### 1.3 Подготовленная процедура (НЕ выполнялась)
```bash
# 1) Дамп (без пароля: внутри контейнера — trust/socket для POSTGRES_USER)
docker exec animastor-pg pg_dump -U animastor -Fc animastor \
  > /home/animastor/backups/cutover-pg-$(date +%F).dump
# 2) Проверки дампа
test -s <дамп>                                  # непустой
head -c5 <дамп> | grep -q 'PGDMP'               # заголовок custom-формата
docker exec -i animastor-pg pg_restore --list <дамp> | wc -l   # >0, ожидается ~100+ TOC-записей
# 3) Проверка целостности БД на месте (read-only)
docker exec animastor-pg psql -U animastor -d animastor -tAc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public';"   # ожидается 41
```
pg_restore — в рамках изолированного restore-теста (§5), НЕ в production.
ABORT-критерии: код != 0; пустой файл; `pg_restore --list` падает; счётчик
таблиц != 41. Ожидаемый размер дампа: **≤ 5 MB** (custom, БД 16 MB).
Права: **не требует root** (docker-доступ пользователя animastor).

---

## 2. DATA / OUTPUT

### 2.1 Что находится и как используется
- `/home/animastor/animastor/data/output`: **63 438 848 Б, 95 файлов**
  (66 mp3, 14 png, 10 mp4, 5 json). Доминирует `build_import_1786345731767_…`
  (61 890 560 Б) + `build_ba_1788172242081` (1 400 832 Б) + мелкие `manual_*`.
- Использование (по исходникам): `backend/src/config/runtime-config.js:60`
  `OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output'`;
  `backend/src/backend.cjs:163` `artifactRoot: () => config.OUTPUT_DIR` —
  это корень артефактов генерации (аудио- и видео-результаты сборки книг,
  манифесты json, изображения), смонтирован rw в backend (`/data/output`).
- `data/books`: 1 904 640 Б, 61 файл (входные материалы книг). Итого каталог
  `data/` ≈ 65,3 MB.
- **Почему исключён из backup:** `backup_animastor.sh` содержит
  `--exclude="animastor/data/output"` (проверено grep-ом по архиву этапа 22:
  0 вхождений) — историческое решение ради размера; сейчас это всего ~63 MB.

### 2.2 Изменяемость и восстановимость
- Изменяемость: свежайший файл — 2026-10-10 (mp3); каталог пишется во время
  сборок → бэкап во время активной генерации может захватить «рваный» файл.
  Рекомендация: снимать в тихое окно (нет активных generation_tasks) либо
  принять риск для mp3/mp4.
- Восстановимость: mp3/mp4/png — результат пайплайна (книга → сцены →
  TTS/GPU-генерация). **Повторная генерация практически недоступна** без
  рабочего GPU-Hub E2E (это отдельный блокер D4/F) и внешних API →
  **считать must-save, а не воспроизводимым**.
- Связь с БД: таблица `output_manifests` отражает файлы output — при restore
  сверять состав каталога с манифестами.

### 2.3 Что обязательно сохранять перед cutover
1. `data/output` целиком (63,4 MB) — единственные копии артефактов.
2. `data/books` (1,9 MB) — входные материалы.
3. pg_dump (§1) — без него файлы output теряют связь с книгами/сценами.
Итого «data-часть» ≈ **65,3 MB + ≤5 MB дамп** — не критично для диска.

---

## 3. GIT BACKUP (неисправный git_backup.sh)

### 3.1 Анализ (файл `/home/animastor/backups/git_backup.sh`, 240 Б, Apr 19)
```bash
SRC="$HOME/git"; DEST="$HOME/net-disk"; mkdir -p "$DEST"
tar -czf "$DEST/$ARCHIVE" -C "$HOME" git
```
- **Точная причина отказа:** `$HOME/git` не существует (до-реорг-лейаут;
  сейчас git-хранилище — worktrees + `/home/animastor/repos/*.git`);
  `$HOME/net-disk` не существует и не смонтирован как сетевой диск.
- **Поведение:** `mkdir -p` **молча создаёт пустой каталог** `~/net-disk`
  (ловушка-декорация), затем `tar` падает с «Cannot stat», `set -e`
  прерывает скрипт (exit 2) — **архив не создаётся**. Никакого лога/алерта.
- **Последствия:** (1) ложное ощущение резервирования; (2) пустой каталог
  выглядит как «рабочее хранилище»; (3) даже исправленный по-старому скрипт
  писал бы архив на тот же единственный диск — копии не защищены от отказа
  диска. На хосте **одна файловая система** (`/dev/sda2` на `/`) — off-host
  копии нет ни у какого существующего механизма.

### 3.2 Подготовленное исправление (НЕ применялось)
- Файл: `23-git-backup-proposed.patch` (отдельный файл в каталоге отчётов).
- Содержание: SRC → `$HOME/repos` (реальное git-хранилище, bare-зеркала),
  DEST → `$HOME/backups` (существующий каталог); fail-fast проверки
  существования SRC/DEST (без молчаливого mkdir); `set -euo pipefail`;
  имя `git_repos_<дата>.tar.gz`; верификация `gzip -t` после создания;
  явное предупреждение «архив на том же диске — скопируйте off-host».
- **Статическая проверка (выполнена):** `bash -n` новой версии → OK;
  `patch --dry-run -p1` против копии оригинала во временной директории →
  «patching file git_backup.sh», применимость подтверждена; **оригинал не
  изменён** (240 Б, прежний mtime); запуск скрипта и push — не выполнялись.
- Применение патча — отдельное действие с разрешением владельца (этапом
  запрещено менять исходный скрипт).

---

## 4. BACKUP STORAGE / DISK

### 4.1 Текущее место (точные байты)
- Свободно (`df -B1`, 2026-10-12): **15 135 170 560 Б** (всего 105 496 965 120,
  занято 85 844 692 992, 86%) ≥ порога 15 000 000 000 Б (запас 135 170 560 Б).
- **Одна ФС:** `lsblk` — только `sda` (100 GB) с `sda2 ext4 /`; **отдельных
  смонтированных хранилищ нет** (вывод df без строк кроме `/`; `~/net-disk`
  отсутствует).
- Где хранятся архивы сейчас: `/home/animastor/backups` (**3 374 948 352 Б**)
  и `/home/animastor/animastor/backups` (**1 271 095 296 Б**) — оба на том же
  диске, что production.

### 4.2 Оценка будущих копий (по фактическим размерам источников, без создания)
| Источник | Факт (Б) | Оценка архива (gzip) |
|---|---|---|
| Конфиг (compose/overlay/proxy-conf/.env) | < 100 000 | < 50 000 |
| pg_dump (custom, БД 16 MB) | — | ≤ 5 000 000 |
| `data/output` + `data/books` | 65 343 488 | ~64 000 000 (мало сжимается) |
| mono-исходники (без data/backups/node_modules) | 326 565 888 | 80–150 млн |
| bare-репозитории `~/repos` | 60 755 968 | ~30 000 000 |
| **Итого новый комплект** | — | **≈ 0,18–0,27 GB** |

Свободных 15,14 GB **достаточно** для комплекта cutover-копий (A2+A3+git-тар).
Отдельно остаётся pull-гейт D0 (16,6 GB под новый gpu-hub-образ — root-vacuum
журнала 3,83 GB).

### 4.3 Варианты хранения (без удаления, без переноса Docker data-root)
1. Продолжать `/home/animastor/backups` (вмещается) + обязательная off-host
   копия комплекта (scp/rclone на удалённый хост или внешний USB-носитель —
   **требует оборудование/учётки владельца**, на хосте второго носителя нет).
2. Инкрементальные копии `rsync -a --link-dest` вместо повторных таров
   (экономия места при периодичности).
3. Жёсткая экономия: `tar -1` для mp3/mp4-каталога не помогает (несжимаемы) —
   не применяется.
4. **Запрещено без отдельного разрешения:** `docker image/volume prune`,
   удаление старых бэкапов, перенос Docker data-root, `journalctl --vacuum`
   (последнее — только root и с разрешением).
- Побочно зафиксированы неиспользуемые тома-реликвии: `animastor_migration_pg`,
  `animastor_migration_redis`, `animastor_sqlite-data` (LINKS 0) — чистка
  только отдельным разрешением.

---

## 5. RESTORE VALIDATION (процедура подготовлена, НЕ запускалась)

### 5.1 Требования среды
- **Место:** ≥ 1 GB свободного (дамп ≤5 MB + тестовый PG-кластер ~30 MB +
  распаковка data-тара ~65 MB + запас). Текущих 15,14 GB достаточно.
- **Изоляция сети:** `docker network create --internal animastor-restore-test`
  (без egress) **либо** `--network none` для проверочных одноразовых
  контейнеров; тестовые контейнеры НЕ подключать к сети `animastor_net`.
- **Тестовые имена/порты:** контейнеры `animastor-pg-restoretest`,
  `animastor-backend-restoretest`; тома `restoretest-pgdata` (**создаётся
  пустым и наполняется pg_restore — файлы продакшн-тома не копируются**);
  порт PG только `127.0.0.1:15432` (не 5432/6379); compose-проект —
  отдельный (например, `animastor-restoretest`; запуск любых `up` в проекте
  animastor по-прежнему запрещён до G7).

### 5.2 Шаги (для будущего разрешённого окна)
1. `gzip -t`/`gunzip -t` всех архивов комплекта.
2. Поднять чистый `postgres:16` в изолированной сети с новым томом.
3. `pg_restore -U animastor -d animastor <дамп>` (или `pg_restore --clean` в
   тестовую БД), проверить exit=0.
4. Сверка целостности: `pg_tables`=41; счётчики `users=83, workspaces=393,
   guests=255, book_source=3, generation_tasks=17, scene_assets=503`;
   `SELECT max(created_at)` по `generation_tasks` — не позже снапшота дампа.
5. Распаковать data-тар в изолированный каталог (`/tmp/restoretest-data`,
   не в prod-путь!), сверить: 95 файлов output, 61 books; `sha256sum`
   выборочных файлов против `output_manifests`/живого каталога.
6. (Опционально) backend-тест-контейнер с `PG_HOST=<restoretest-pg>`,
   `PG_PORT=5432` внутри тестовой сети — только на чтение.
7. Удаление тест-среды — отдельным разрешением (сейчас ничего не создавалось).

### 5.3 Исключения связи с production (обязательные правила)
Тестовая копия **не должна** иметь возможности достать до prod:
- не использовать `/home/animastor/animastor/.env` (prod-секреты/адреса);
  в тестовый compose вносить только тестовые значения, без `${POSTGRES_PASSWORD}`
  из prod;
- не монтировать prod-пути `data/*` на запись (только распакованная копия);
- не подключаться к `animastor_net`; egress блокируется `--internal`;
- не указывать `HUB_URL` на prod gpu-hub; `GPU_HUB_API_KEY` не переносить;
  `E2E_WORKSPACE_ID` не задавать; шаринг (`SHARE_FEATURES_ENABLED`) оставить 0;
- не поднимать redis-тест рядом с прод-очередями; prod-тома
  `animastor_pg-data`/`animastor_redis-data` не монтировать вообще.

---

## 6. G1: статус блокеров после этапа 23

| Блокер G1 (из 22) | Статус | Доказательства | Права | Действия для закрытия | Критерий PASS |
|---|---|---|---|---|---|
| A3: pg_dump отсутствует | **FAIL → готово к закрытию** | инвентаризация §1 (41 таблица, счётчики зафиксированы), процедура §1.3 | animastor (docker exec), без root | выполнить §1.3 в разрешённое окно | дамп существует, `PGDMP`-заголовок, `pg_restore --list` ok, таблиц=41 |
| A3: `data/` не в бэкапах | **FAIL → готово к закрытию** | размеры/состав §2 (63,4+1,9 MB, must-save) | animastor, без root | tar `data/` целиком в тихое окно + `gzip -t` + сверка 95/61 файлов | архив ok, состав совпадает |
| A2: конфиг-бэкап | **FAIL → готово к закрытию** | runbook A2; состав подтверждён (compose/.env/proxy-conf) | animastor, без root; хранить 600 | tar конфига, `chmod 600`, `gzip -t` | архив 600 и проверен |
| git_backup.sh сломан | **PASS (подготовлено)** | анализ §3.1; patch проверен статически (`bash -n`, `patch --dry-run` OK); оригинал не изменён | применение — animastor, разрешение владельца | применить `23-git-backup-proposed.patch` отдельным действием | скрипт проходит dry-run и создаёт проверенный архив (запуск — в окне) |
| Хранилище/диск | **PASS** | §4: свободно 15 135 170 560 Б; комплект ≈0,18–0,27 GB вмещается | animastor; off-host копия — владелец (носитель/учётки) | решить канал off-host | копия комплекта существует вне данного диска |
| Restore-тест | **BLOCKED** | процедура §5 готова, не запускалась | окно + разрешение владельца | выполнить §5 в изолированной среде | таблицы/счётчики/файлы сверены, тест-среда удалена с разрешения |
| TLS-продление `.in` (root) | **BLOCKED** (не тема этапа) | 22 §5 | root (G6/D5) | `certbot renew --dry-run` → renew до 19.11 | notAfter продлён ≥60 дней |
| D4 republish zip | **BLOCKED** (не тема этапа) | 22 §4.2 | владелец | решение по упаковке/загрузке | актив заменён, sha зафиксирован |
| Pull-гейт диска D0 | **BLOCKED** (не тема этапа) | §4.2: не хватает ~1,46 GB | root + разрешение | `journalctl --vacuum-size=200M` | `df -B1` ≥ 16 600 000 000 |

**Итог G1: NO-GO сохраняется**, но backup-блокеры переведены из «нет
механизма/нет данных» в «процедуры готовы и проверены статически»: закрытие
A2/A3 + restore-тест выполнимы animastor-пользователем **без root** в
разрешённое окно; владельцу/ root нужны: разрешение на создание копий
(текущий запрет этапа), off-host канал, применение git-патча, TLS (root),
решение D4, vacuum (root).

**Что animastor может без root:** pg_dump через docker exec; tar конфига и
`data/`; `gzip -t`/сверки; изолированный restore-тест в `--internal`-сети
(docker-сокет доступен пользователю); применение git-патча (после разрешения).
**Что требует владельца/root:** разрешение создавать копии (сейчас запрещено);
off-host носитель/учётки; публикация/секреты (D4); TLS и `/etc/letsencrypt`
(root); `journalctl --vacuum` (root); push (запрещён до G8); удаление
артефактов/томов (запрещено вовсе без отдельного решения).

---

## 7. Что НЕ выполнялось / ограничения

| Действие | Статус |
|---|---|
| Создание архивов/копий | не выполнялось (в /tmp только одиночная копия 240-байтного скрипта для статической валидации патча — не архив и не бэкап проекта) |
| Restore / тестовые контейнеры | не запускались (процедура §5 — подготовлена) |
| `git_backup.sh` | не изменён и не запускан (проверено stat: 240 Б, прежний mtime) |
| Секролы | `.env` не читался; пароль PG не запрашивался (psql внутри контейнера) |
| root-действия | не выполнялись: `/etc/letsencrypt/live`, `journalctl --vacuum`, логи контейнеров (`docker inspect .LogPath` — доступ запрещён без root, зафиксировано) |
| push / удаления / очистка | не выполнялись |
