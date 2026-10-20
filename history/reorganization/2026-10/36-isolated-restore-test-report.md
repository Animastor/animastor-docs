# Animastor — Этап 36: ISOLATED RESTORE TEST

- Дата: 2026-10-12 (окно ~11:15–11:30 UTC)
- Режим: **изолированное тестовое восстановление** в отдельном окружении Docker.
  Production не изменялась: без переключений, без Compose/Nginx/DNS/TLS/Git/lock,
  без перезапуска рабочих контейнеров, без очистки Redis, без записи в рабочие
  тома и каталоги `data/`. Все временные ресурсы — только `restore-test-*`
  и `/tmp/restore-test-*`; после теста удалены.
- Источники (прочитаны): `35-remaining-blockers-restore-readiness.md` (§3.3 —
  процедура, применена), `25-disk-backup-report.md` (эталоны бэкапа: 41 таблица,
  `users=83 workspaces=393 guests=255 book_source=3 generation_tasks=17
  scene_assets=503`, 95/61 файлов data, `redis-check-rdb` 321 keys / 2 expires),
  `21-production-cutover-runbook.md` (A2/A3, §5.2, запреты §9).
- **Итог: PASS по всем трём направлениям.**

| Направление | Результат | Однострочник |
|---|---|---|
| **PostgreSQL** | **PASS** | `pg_restore --exit-on-error` exit 0, вывод пустой; 41 таблица, 278 TOC-записей, 114 индексов; счётчики == эталону времени бэкапа; md5-отпечатки 4 таблиц == production |
| **Redis** | **PASS** | `redis-check-rdb`: Checksum OK, **321 keys read / 2 expires / 2 already expired**; после загрузки `dbsize=319` = 321−2 (истёкшие TTL); все ожидаемые ключи на месте, `prompt-profiles` sha-в-значении == production |
| **Файлы (`data/`)** | **PASS** | 156/156 файлов (95 output + 61 books), размеры 63 203 425 / 1 704 047 Б; агрегатная сумма манифестов sha256 **идентична** production (`4d4644de…`) |
| Production | **не изменена** | 7/7 контейнеров (те же ID/CreatedAt), mounts, health 200/200, `dbsize=321`, data/lock/git/.env == baseline |
| Очистка | **выполнена** | контейнеры, сеть, том `restore-test-pgdata` и все `/tmp/restore-test-*` удалены; остатков 0 |

---

## 1. Preflight — PASS

| Проверка | Команда | Результат |
|---|---|---|
| SHA-256 всех 9 артефактов | `cd backups && sha256sum -c backup-manifest-2026-10-12.sha256` | **9/9 OK, exit 0** (артефакты не изменились с этапа 25/35) |
| Свободное место | `df -B1 /` | **34 721 804 288** Б (портог 15 000 000 000; на тест нужно ~250 МБ) — достаточно |
| Локальные образы | `docker images` | `postgres:16` (`f8e2cc2a36dd`, 642 МБ), `redis:7` (`b2b95679e3b4`, 170 МБ) — **есть, pull не нужен** |
| Production PG | `docker inspect animastor-pg` | **healthy**, Created `2026-07-08T13:37:11Z`, Started `2026-08-24T16:30:12Z` |
| Production Redis | `docker inspect animastor-redis` | **healthy**, Created/Started те же; `dbsize=321` |
| Health | curl `--resolve …127.0.0.1` | `/health`=200, `/gpu/health`=200 |
| Чистота окружения | `docker ps -a`, `volume ls`, `network ls`, `ls /tmp/restore-test-*` | ресурсов `restore-test-*` **0**; контейнеров 7, томов 35, сетей 5 — зафиксировано как baseline |
| Baseline неизменности | lock, git, data, `.env` | L1 `069b62d9…`, L2 `2a221e3b…`; git = baseline M3; `data/output` 63 203 425, `data/books` 1 704 047; `.env` `ee64133e…` (== отчёту 25) |

Стоп-условия (архивы изменились / мало места / нет изоляции) — **не сработали**.

### 1.1 Read-only снимок production до теста (для финальной сверки)

- Контейнеры: backend `847089ce2967` (2026-10-10 13:46:30), pg `49202ac1b6ed`
  (2026-07-08 13:37:11), redis `fd01e09ae05a` (2026-07-08 13:37:11),
  proxy `276de9920247` (2026-08-22 09:11:56), gpu-hub `e55b9a123f54`,
  repro-redis `1882ae428ee4`, buildkit `49424243ac4e`.
- PG counts: `users=83 workspaces=357 guests=231 book_source=3
  generation_tasks=17 scene_assets=503 books=5 scenes=12 output_manifests=0
  asset_states=0`, таблиц 41, индексов 114.
- Redis: `dbsize=321`, `prompt-profiles` string 59 Б, `worker-auth` hash 6 полей,
  `queue:image` 8, `queue:image:ws:3317e019-…` 252, `event-journal:*` 10 ключей.
- Файлы: `data/output` 95 файлов, `data/books` 61 файл.

---

## 2. Изолированное окружение — PASS (проверено до и после запуска)

```sh
docker network create --internal --driver bridge restore-test-net   # <SUBNET>/16, без выхода наружу
docker volume create restore-test-pgdata                            # новый том, прод-томы не трогаются
docker run -d --name restore-test-pg --network restore-test-net --restart no \
  -e POSTGRES_USER=animastor -e POSTGRES_PASSWORD=restore-test-only-not-prod -e POSTGRES_DB=animastor \
  -v restore-test-pgdata:/var/lib/postgresql/data \
  -v /home/animastor/backups:/backups:ro \
  postgres:16
docker run -d --name restore-test-redis --network restore-test-net --restart no \
  -v /tmp/restore-test-redis:/data redis:7 \
  redis-server --dir /data --save '' --appendonly no
```

### 2.1 Доказательства отсутствия возможности записать в production

| Аспект | Проверка | Факт |
|---|---|---|
| Mounts PG | `docker inspect restore-test-pg` | ровно 2: `restore-test-pgdata → /var/lib/postgresql/data (rw)` и `/home/animastor/backups → /backups (ro)`. **Ни одного прод-пути** (нет `animastor_pg-data`, нет `data/`) |
| Mounts Redis | `docker inspect restore-test-redis` | ровно 1: `/tmp/restore-test-redis → /data (rw)` (наш временный каталог) |
| Сеть | inspect | только `restore-test-net`; **`--internal`** → без маршрута наружу и на хост; `animastor_net` не подключён |
| Порты | `NetworkSettings.Ports` | `{"5432/tcp":null}`, `{"6379/tcp":null}` — **ничего не опубликовано** (5432 на хосте занят prod-PG — тест его не занимает и не ходит туда) |
| DNS/имена | `docker exec restore-test-pg getent hosts animastor-pg` | **нет** — прод-контейнеры по именам недостижимы |
| Креды | env тестового PG | собственный тестовый пароль; прод-креды нигде не передавались |
| Рестарт-политика | `--restart no` | тестовые контейнеры не переживут демон в «автоматическом» режиме |
| Доступ к тесту | — | только через `docker exec`, не через `127.0.0.1:5432/6379` |
| Запись | — | запись шла только в `restore-test-pgdata` и `/tmp/restore-test-*`; рабочие `data/`, тома, lock, git открывались **только на чтение** (`diff`, `sha256sum`, `cmp`, `du`, `find`, `psql select`) |

---

## 3. PostgreSQL — **PASS**

### 3.1 Восстановление

```sh
docker exec restore-test-pg pg_restore --exit-on-error -U animastor -d animastor \
  /backups/cutover-pg-2026-10-12.dump
```
- **exit 0**, вывод (stdout+stderr) — **0 строк** → ни одной ошибки/предупреждения.
- Готовность: `pg_isready` → «accepting connections» (первая попытка, 2 с).
- Версия тестового сервера: PostgreSQL 16.14 (тот же мажор, что в production).

### 3.2 Структура и контрольные количества

| Проверка | Восстановлено | Эталон (отчёт 25, время бэкапа) | Production сейчас (read-only) | Вердикт |
|---|---|---|---|---|
| Базовых таблиц | **41** | 41 | 41 | ✓ |
| `pg_restore --list` (TOC) | **278** записей | 278 | — | ✓ |
| Индексов (`pg_indexes`) | **114** | — | 114 | ✓ |
| Последовательностей | 0 | — | 0 | ✓ |
| `users` | **83** | 83 | 83 | ✓ |
| `workspaces` | **393** | 393 | 357 | ✓ к бэкапу (prod изменилась после — §6) |
| `guests` | **255** | 255 | 231 | ✓ к бэкапу (prod изменилась после — §6) |
| `book_source` | **3** | 3 | 3 | ✓ |
| `generation_tasks` | **17** | 17 | 17 | ✓ |
| `scene_assets` | **503** | 503 | 503 | ✓ |
| `books` / `scenes` | 5 / 12 | — | 5 / 12 | ✓ |
| `output_manifests` / `asset_states` | 0 / 0 | — | 0 / 0 | ✓ |

**Содержимое (md5 отпечатки `string_agg(md5(row))`), восстановлено vs production:**

| Таблица | Восстановлено | Production | Итог |
|---|---|---|---|
| `books` | `c4c50c0a2b67947d4a40e56d0be6e95b` | `c4c50c0a2b67947d4a40e56d0be6e95b` | **совпадает** |
| `scenes` | `b85e6a12380ae9680dc7ece1f1d1ab87` | `b85e6a12380ae9680dc7ece1f1d1ab87` | **совпадает** |
| `generation_tasks` | `09500bae1e624cb53851cad7b5abdf5a` | `09500bae1e624cb53851cad7b5abdf5a` | **совпадает** |
| `users` | `5d24bdd4d11754f46b48ef3f9c6cc59e` | `5d24bdd4d11754f46b48ef3f9c6cc59e` | **совпадает** |

Счётчики восстановленной БД в точности равны **эталону времени съёмки** (отчёт 25 §7),
отпечатки строк — **production** (по неизменным с 06:00 таблицам).
Данные **обратно в production не копировались**.

**Вердикт PostgreSQL: PASS.**

---

## 4. Redis — **PASS**

### 4.1 Восстановление

```sh
mkdir -p /tmp/restore-test-redis
cp -p backups/redis-dump-2026-10-12.rdb /tmp/restore-test-redis/dump.rdb   # sha 3202408c… == манифесту
chmod 644 /tmp/restore-test-redis/dump.rdb                                  # только наша копия в /tmp
docker run -d --name restore-test-redis --network restore-test-net ... redis:7 \
  redis-server --dir /data --save '' --appendonly no
```
Лог загрузки: `Loading RDB produced by version 7.4.9` → `RDB age 18297 seconds`
(снимок 06:17) → `Done loading RDB, keys loaded: 319, keys expired: 2` →
`Ready to accept connections` (загрузка 1.409 с).

### 4.2 Целостность и ключи

| Проверка | Результат |
|---|---|
| `redis-check-rdb` на копии (`--network none`, без сервера) | `Checksum OK`, `RDB looks OK!`, **321 keys read, 2 expires, 2 already expired**, exit 0 == отчёту 25 |
| `dbsize` в тесте | **319** = 321 − 2 (два ключа с TTL истекли к моменту загрузки — абсолютный дедлайн в прошлом) |
| Diff множеств ключей TEST vs PROD | только в PROD: ровно **2** ключа — `animastor:dispatch-lease:import_…` и `animastor:dispatch-meta:import_…` (оба **с TTL**; в проде ttl≈1375 с — их версия была обновлена после снимка). «Только в TEST» — **0** |
| `animastor:prompt-profiles` (Redis-уникальный, критичный) | type=string, strlen=59; **sha256 значения: тест `44127d09…` == прод `44127d09…`** |
| `animastor:worker-auth` | hash, 6 полей — как в проде (значения не выводились) |
| `animastor:layer-config:*` | **3** ключа |
| `animastor:queue:image` / `…:ws:3317e019-…` | **8 / 252** элемента — == проде и отчёту 27 |
| `animastor:event-journal:*` | **10** ключей; длины 8/10 идентичны проду, 2 отличаются (`…sc-45c789c6` 65 795 vs 66 100; `_system:_recovery:_cycle` 249 844 vs 250 454) — **прод дописывал журнал после 06:17**, восстановленное = снимок (ожидаемо) |
| Доступ к прод-Redis из теста | невозможен: сеть `--internal`, порты не публикуются; сверка выполнялась **read-only** `docker exec animastor-redis redis-cli` с хоста |

Очистку Redis (`FLUSHDB/DEL/RPOP`) **не выполняли ни в тесте, ни в проде**.

**Вердикт Redis: PASS.**

---

## 5. Файлы `data/` — **PASS**

```sh
mkdir -p /tmp/restore-test-data
tar -xzf backups/cutover-data-2026-10-12.tgz -C /tmp/restore-test-data
```

| Проверка | Восстановлено (`/tmp/restore-test-data`) | Источник (production, read-only) | Итог |
|---|---|---|---|
| Записей в архиве | 186 | — | ✓ |
| Файлов `output` | **95** | 95 | ✓ |
| Файлов `books` | **61** | 61 | ✓ |
| Всего файлов | **156** | 156 | ✓ |
| Размер `output` | 63 203 425 Б | 63 203 425 Б | ✓ |
| Размер `books` | 1 704 047 Б | 1 704 047 Б | ✓ |
| **Контрольные суммы всех 156 файлов** | манифест `4d4644de8403c4228922fdafea0b7bfcb29c4a220fa8aec1195d16efd4d9a03c` | манифест `4d4644de8403c4228922fdafea0b7bfcb29c4a220fa8aec1195d16efd4d9a03c` | **`diff` пуст → байт-в-байт совпадение** |

Метод: `find . -type f -print0 | sort -z | xargs -0 sha256sum` от корня `data/`
в обоих наборах → `diff` → идентичны. Рабочий `data/` открывался только на чтение,
размеры после теста не изменились (63 203 425 / 1 704 047, 95/61 файлов).
Восстановленные данные обратно не копировались.

**Вердикт файлы: PASS.**

### 5.1 Дополнительно (сверх трёх обязательных направлений) — PASS

| Артефакт | Проверка | Результат |
|---|---|---|
| `cutover-config-2026-10-12.tgz` | распаковка в `/tmp/restore-test-config`; `sha256` 4 файлов vs prod | `docker-compose.yml` `ed1b290d…`, `overlay-backend-standalone.yml` `eac32cb0…`, `proxy/conf/default.conf` `99f706af…`, `.htpasswd` `6405f1b7…` — **4/4 MATCH** |
| `.env` (секреты) | только `stat` + `cmp -s`, содержимое не печаталось | size 2112, mode 600; `cmp` **exit 0** (байт-в-байт идентичен текущему) |
| `git_repos_2026-10-12_06-00-27.tar.gz` | распаковка в `/tmp/restore-test-git`; `git fsck --connectivity-only` ×6 | **6/6 exit 0**, ошибок нет |
| HEAD восстановленных bare vs `git-refs-status-2026-10-12.txt` | сверка | android `254e2f08`, backend `bce64db3`, gpu-hub `ecefd0b7`, web `c7fe52ac`, worker `618f87a6`, mono master `64127b9e` — **== эталону** (bare-копия соответствует состоянию 06:00, до sync-этапа 26 — ожидаемо) |

---

## 6. Наблюдение (не следствие теста): production изменилась после бэкапа

Съёмка сделана **06:00–06:17 UTC**, тест — ~11:20 UTC. Read-only сравнение:

| Объект | На момент бэкапа | Сейчас в production | Δ |
|---|---|---|---|
| `workspaces` | 393 | **357** | −36 |
| `guests` | 255 | **231** | −24 |
| `event-journal:…sc-45c789c6` | 65 795 | 66 100 | +305 |
| `event-journal:_system:_recovery:_cycle` | 249 844 | 250 454 | +610 |
| `dispatch-lease/meta` (2 ключа) | в снимке (TTL истёк к 11:22) | обновлены, ttl ≈ 1375 с | пересозданы |
| `users`, `generation_tasks`, `scene_assets`, `books`, `scenes`, `data/*` | 83 / 17 / 503 / 5 / 12, 95+61 | **без изменений** | 0 |

Это изменение **сделано приложением в production в течение дня** (журнал и
сроковые ключи пишутся постоянно; уборка `workspaces/guests` — вне нашего окна).
Тест к этому отношения не имеет: тестовые контейнеры физически не могли достучаться
до production (`--internal`, без портов, без DNS-имён, свои креды).
**К сведению владельца:** сокращение `workspaces`/`guests` на 36/24 строк за ~5 часов —
отдельный повод проверить механизм уборки (вне скоупа этапа 36).

---

## 7. Очистка — выполнена, каждый ресурс проверен перед удалением

| # | Ресурс | Проверка перед удалением | Действие | Результат |
|---|---|---|---|---|
| 1 | контейнер `restore-test-pg` | `inspect`: image `postgres:16`, сеть `restore-test-net`, mounts = `restore-test-pgdata` + `backups(ro)` | `docker rm -f restore-test-pg` | удалён |
| 2 | контейнер `restore-test-redis` | `inspect`: image `redis:7`, сеть `restore-test-net`, mount = `/tmp/restore-test-redis` | `docker rm -f restore-test-redis` | удалён |
| 3 | том `restore-test-pgdata` | `inspect` (mountpoint `/var/lib/docker/volumes/restore-test-pgdata/_data`), `docker ps -a --filter volume=…` → **0** контейнеров | `docker volume rm restore-test-pgdata` | удалён |
| 4 | сеть `restore-test-net` | `inspect` → attached containers **0** | `docker network rm restore-test-net` | удалена |
| 5 | `/tmp/restore-test-*` | список перед удалением: `data`, `config`, `git`, `redis`, `pg-restore.log`, `keys-{test,prod}.txt`, `sha-{extracted,prod}.txt` | `rm -rf` (точные пути) | удалены |
| 6 | остаток `/tmp/restore-test-redis` | пустой каталог, владелец uid 999 (remapped-root контейнера `redis:7`) → **sticky-бит `/tmp` запретил** удаление пользователем `animastor` | удаление **точным путём** через временный контейнер: `docker run --rm --entrypoint /bin/sh -v /tmp:/hosttmp redis:7 -c 'rm -rf /hosttmp/restore-test-redis'` (путь проверен внутри `if`) | удалён |

Не использовались: `docker prune`, `volume prune`, `image prune`, массовое удаление,
`rm` чего-либо кроме перечисленных `restore-test-*` путей.
**После очистки:** `restore-test` = 0 контейнеров / 0 томов / 0 сетей / 0 путей в `/tmp`;
всего контейнеров **7**, томов **35**, сетей **5** — ровно как до теста.

---

## 8. Финальная проверка production — PASS (снимок «до» == «после»)

| Проверка | До теста | После очистки | Итог |
|---|---|---|---|
| Контейнеры | 7 шт., ID/CreatedAt как в §1.1 | **те же 7, те же ID и CreatedAt**, pg/redis healthy, StartedAt `2026-08-24T16:30:12Z` | ✓ без перезапусков |
| Mounts backend/pg/redis/proxy | 4 rw / 1 том / 1 том / 6 ro | **идентичны** | ✓ |
| `/health`, `/gpu/health` | 200 / 200 | **200 / 200** | ✓ |
| Site sha | `a1900f4e…` | `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c` | ✓ |
| `nginx -t` | ok | **syntax ok / test is successful** | ✓ |
| Redis `dbsize` | 321 | **321** | ✓ |
| `data/output`, `data/books` | 63 203 425 / 1 704 047 | **63 203 425 / 1 704 047** | ✓ |
| Lock L1 / L2 | `069b62d9…` / `2a221e3b…` | **те же** | ✓ |
| `.env` | `ee64133e…` (2 112 Б, 600) | **тот же sha** | ✓ |
| `docker-compose.yml` / overlay | `ed1b290d…` / `eac32cb0…` | **те же** | ✓ |
| Git (6 репо) | baseline M3 (` M index.html`, `?? overlay…`, `?? deploy/`, `?? freebuff…`, прочие чисто) | **идентично** | ✓ (ничего не коммитилось) |
| Бэкапы | 9/9 OK | **9/9 OK** (повторено из каталога `backups`) | ✓ не изменены |
| Диск | 34 721 804 288 Б | 34 719 830 016 Б (−2 МБ — системный шум tmp/log) | ✓ ≥ порога |
| Остатки теста | 0 | **0** | ✓ |

---

## 9. Что НЕ выполнялось (запреты соблюдены)

Restore в production / использование рабочих томов `animastor_pg-data`,
`animastor_redis-data` / очистка Redis (`FLUSHDB/FLUSHALL/DEL/RPOP`) / перезапуск
production-контейнеров (`docker stop/restart/rm` рабочих) / правки Compose, Nginx,
DNS, TLS, Git (`commit/push`), lock-файлов, `.env`, артефактов / запись
восстановленных данных обратно в production / `docker prune` и массовые удаления /
удаление бэкапов, данных, монорепо. Содержимое `.env` и значений секретных ключей
Redis (`worker-auth`, `prompt-profiles`) в отчёт не выносилось (только sha/размер/тип).
Использованные разрешённые операции: `sha256sum`, `tar`, `gzip`, `cmp`, `diff`,
`find`, `du`, `stat`, `git fsck/rev-parse/symbolic-ref` (во временных копиях),
`docker network/volume create`, `docker run` (только с префиксом `restore-test`),
`docker inspect`, `docker rm -f` (только тестовые), `docker exec` (тестовые на запись,
production — только read-only `psql select` / `redis-cli get/type/llen/scan/ttl`),
`redis-check-rdb`, `curl` (GET).

## 10. Резюме для чата

**PASS по всем трём направлениям.**
**PostgreSQL — PASS:** `pg_restore --exit-on-error` exit 0 без единого сообщения,
41 таблица / 278 TOC / 114 индексов; счётчики в точности == эталону времени бэкапа
(`users=83, workspaces=393, guests=255, book_source=3, generation_tasks=17,
scene_assets=503`); md5-отпечатки `books/scenes/generation_tasks/users` **совпали
с production**.
**Redis — PASS:** `redis-check-rdb` — Checksum OK, **321 key / 2 expires**; после
загрузки `dbsize=319` (ровно 2 TTL-ключa истекли к моменту восстановления —
подтверждено diff-ом множеств: других расхождений **0**); `prompt-profiles`
(Redis-уникальный) — sha256 значения **== production**; очереди 8/252, журнал 10 ключей,
`worker-auth` hash 6 полей на месте.
**Файлы — PASS:** 156/156 (95 output + 61 books), размеры идентичны, агрегатная
sha256-манифеста восстановленного набора **== production** (`4d4644de…`).
**Изоляция подтверждена:** сеть `--internal restore-test-net`, порты не публиковались,
mounts теста — только новый том `restore-test-pgdata` и ro-mount `backups/` (+ `/tmp`
для Redis), DNS прод-имён недоступен, свои креды; сверка с prod — только read-only;
восстановленное обратно не копировалось.
**Production не изменена:** 7/7 контейнеров (те же ID/CreatedAt, pg/redis healthy
и не перезапускались), mounts/health 200/200/`dbsize=321`/data/lock/git/.env/сайт
`a1900f4e…` == baseline. **Очистка завершена:** 0 тестовых контейнеров/томов/сетей/
файлов (единственный нюанс — sticky `/tmp` не дал удалить пустой каталог, снят
удалением точного пути через временный контейнер).
**Наблюдение:** production после съёмки изменилась приложением (`workspaces` −36,
`guests` −24, журнал +) — к тесту отношения не имеет, отмечено для владельца.
Отчёт: `/home/animastor/reorg-2026-10-12/36-isolated-restore-test-report.md`.
