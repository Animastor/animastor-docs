# Animastor — Этап 35: REMAINING BLOCKERS & RESTORE READINESS

- Дата: 2026-10-12 (окно ~10:45–11:10 UTC)
- Режим: **только read-only проверка, анализ и документация.** Не выполнялось:
  переключение production, правки Compose/Nginx/DNS/TLS, перезапуск рабочих
  контейнеров, **restore**, очистка Redis, правка lock-файлов, публикация ZIP,
  `git commit`/`git push`, удаление данных/монорепо. Временные артефакты создавались
  **только** в `/tmp/stage35/` (собственный scratch этого этапа, удалён по завершении).
- Источники (прочитаны): `33-post-m3-verification-report.md`,
  `34-tls-renewal-report.md`, `27-deploy-layout-preparation-report.md`,
  `21-production-cutover-runbook.md` (полностью, вкл. §7 GO/NO-GO), точечно
  `19-cutover-readiness-plan.md` (P1–P9), `20-owner-decisions.md`, `28-cutover-readiness-audit.md`.
- Итог: **PASS по этапу (фактическая картина получена).** Выполнены **C-проверки
  W1–W3 (C1–C3) — все PASS**, restore-тест подготовлен (изоляция доказана, НЕ запускался),
  G7 прогнан фактически → **NO-GO** (7 из 13 пунктов чек-листа не выполнены).

---

## 0. Краткий итог

| Пункт | Статус | Однострочник |
|---|---|---|
| **G2** (цели repin) | **BLOCKED** | C1–C3 (W1–W3) выполнены сегодня и **PASS**; C4 (письменное подтверждение целей владельцем) отсутствует → фаза D закрыта |
| **G3** (push/CI/publish) | **NOT TESTED** | разрешение не запрашивалось и не выдано; предпосылка G2 не закрыта; ничего не публиковалось |
| **G5** (E2E-окно) | **NOT TESTED** | P1 (`E2E_WORKSPACE_ID` unset), P2 (0 воркеров), P9 (окно не согласовано) — красные; dispatch не выполнялся |
| **G7** (GO/NO-GO) | **FAIL → NO-GO** | фактический прогон §7: пп. 4,5,6,7,8,9,13 не выполнены; пп. 1,2,3,10,11,12 выполнены |
| Restore-тест | **READY, NOT RUN** | состав/SHA/читаемость бэкапов подтверждены (9/9 OK), образы `postgres:16`/`redis:7` локально, план изоляции формализован ниже; **запуск требует отдельного разрешения** |
| Прочие | G1/D1/G6/D5/G8 — **PASS/RESOLVED**, G4/D4 — **BLOCKED** | см. §5 |

**Самый короткий путь к cutover:** G4 (+`deploy/.env`) → G2 → G3 → E1–E4 →
(отдельное окно) G5 либо письменный приём риска отложенного E2E → D4 (решение)
→ restore-тест (рекомендуется) → G7.

---

## 1. Базовая проверка (STD-CHECK §2 runbook) — фактически, сегодня

| Проверка | Команда | Результат | Вердикт |
|---|---|---|---|
| Диск | `df -B1 /` | свободно **34 725 228 544** Б (портог `15 000 000 000`; pull-порог `16 600 000 000` — тоже пройден) | OK |
| Lock L1 / L2 | `sha256sum` | `069b62d931c1ff0e…` / `2a221e3ba626326c…` == baseline | OK |
| Контейнеры | `docker ps` | 7 шт., uptime: backend Up 45 h, gpu-hub Up 3 d, proxy Up 5 w, pg/redis Up 6 w (healthy), repro-redis Up 5 d, buildkit Up 3 d — **перезапусков нет** | OK |
| Health | curl `--resolve …127.0.0.1` | `/health`=200, `/gpu/health`=200 | OK |
| Git (5 репо) | `status --porcelain` + `rev-parse` | mono `465453df` (` M frontends/website/index.html`, `?? docker/compose/overlay…` = baseline M3), web `fbc93662` чисто, backend `a7a8c463` (`?? deploy/`, `?? freebuff…`), worker `b3f94f42`, gpu-hub `ecefd0b7`, android `92a56c0d` — **== этапу 26/33** | OK |
| Данные | `du -sb` | `data/output` **63 203 425** Б, `data/books` **1 704 047** Б == этапу 27/33 | OK |
| Redis | `docker exec animastor-redis redis-cli dbsize` | **321** == baseline | OK |
| `.env` / overlay / nginx-conf | `stat` + `sha256sum` | `.env` 2 112 Б mode 600; overlay `eac32cb0…`; `proxy/conf/default.conf` `99f706af…` — не изменялись | OK |
| Rollback-рендер (§7 п.12) | `docker compose -f docker-compose.yml -f docker/compose/overlay… config --quiet` | **exit 0** (секреты не печатались) | OK |
| Site | `curl / \| sha256sum` | **`a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c`** == канону web-репо | OK |
| Ссылки живой страницы | `grep -o` + `curl -IL` | 4 уникальных URL: 2× `…/animastor-web` + 2× `…/animastor-web/tree/main/docs` → **4/4 = 200**; старых `…/animastor/tree/master` → **0 вхождений** | OK |
| Редиректы | curl | `.in` http/https/www → **301 ×3**; `http://animastor.org/` → 301 → https | OK |
| TLS | `openssl s_client … x509 -enddate` | `.in` **Jan 10 09:24:17 2027 GMT**; `.org` **Jan 6 18:29:48 2027 GMT** | OK |
| `nginx -t` | `docker exec animastor-proxy nginx -t` | syntax ok / test successful (без reload) | OK |
| Бэкапы | `sha256sum -c backup-manifest-2026-10-12.sha256` | **9/9 OK** | OK |

Новых расхождений с baseline не обнаружено → **G8 сохраняет PASS** (см. §4.4).

---

## 2. G2 / G3 / G5 / G7 — критерии runbook и фактический результат

### 2.1 G2 — подтверждение целей repin (runbook фаза C, C4)

**Критерий (дословно, §3 фаза C):** C1 (W1) 8/8 `cmp` exit 0; C2 (W2) staging-verify
на пинах — exit 0 «staging verified against artifacts.lock.json», на целях D2 —
exit 1 с названными tool-ом расхождениями; C3 (W3) `update-artifacts-lock.cjs --check`
exit 0 + 4/4 скачанных зипа == `sha256_asset`; **C4: письменное подтверждение
владельца зафиксировано в logbook** (worker → `b3f94f42`, backend → `a7a8c463`).

Выполнено сегодня (всё в `/tmp/stage35`, только чтение + временные клоны):

| Проверка | Команда/действие | Фактический результат |
|---|---|---|
| **C1 / W1** | `curl …/gpu/worker-bundle` → `tar -xzf` → 8 файлов `cmp` с `git show 618f87a6:…` | bundle sha256 `480af146…` == контракту `/gpu/worker-bundle/sha256` (v2.1.1, 17 672 Б); **8/8 cmp OK** |
| **C2 / W2 (пины)** | клоны worker@`618f87a6`, backend@`98c4fbd6` в `/tmp` + копия gpu-hub-репо → `node scripts/stage-artifacts.cjs --worker … --backend …` (без `--write-lock`) | **exit 0**, «staging verified against artifacts.lock.json»: worker-bundle `4bb0408b…`/2.1.1, workflows `0d51107d…`, installer-src `02fad99e…`/0.1.0, install-manifests `46f3c26a…` — **ровно как в критерии runbook** |
| **C2 / W2 (цели D2)** | то же на worker@`b3f94f42`, backend@`a7a8c463` | **exit 1** с точными расхождениями: `worker-bundle 417c0ad4… != 4bb0408b…`, `installer-src ff27e291… != 02fad99e…`, `installer-src version 0.1.1 != 0.1.0` — **ровно как в критерии runbook** |
| **C3 / W3a** | `node packages/animastor-gpu-hub/tools/update-artifacts-lock.cjs --check` | **exit 0** «artifacts.lock.json is in sync with source trees»; lock не изменён (`069b62d9…` до/после) |
| **C3 / W3b** | `curl -fsSL` 4 зипа GitHub Release → `sha256sum` vs `sha256_asset` L1 | **4/4 MATCH**: `4cb6f133…`, `c484e197…`, `ae589c10…`, `1fd9f8ad…` |
| **C4** | письменное подтверждение владельца | **отсутствует** |

**Статус G2 = BLOCKED.** Техническая часть (C1–C3) — PASS и воспроизводима; блокирует
**только** C4: без письменного «да» на worker `b3f94f42` / backend `a7a8c463`
фаза D закрыта. PASS не присваивается.

Дополнительный факт, важный для состава repin (новый, из W2): деревья
`workflows` (`0d51107d…`) и `install-manifests` (`46f3c26a…`) **идентичны**
между пином и целями → repin фактически затронет только **worker-bundle** и
**installer-src** (2 группы из 4).

### 2.2 G3 — разрешение на push / CI / publish (гейт фазы D)

**Критерий:** отдельное письменное разрешение владельца на `git push` (origin/github),
`--write-lock`, запуск CI `gpu-hub-ghcr-release` и публикацию релиз-активов.

Фактически: разрешение не запрашивалось и не выдавалось; `git push` не выполнялся
(проверено: `ls-remote github` только читался, HEAD 4/4 == локальным); lock не менялся;
`gh release`/загрузка ассетов не выполнялись; CI не запускался.

**Статус G3 = NOT TESTED** (предпосылка G2 не закрыта; операция не инициировалась).

### 2.3 G5 — E2E-окно (фаза F, D4; P1–P9 из отчёта 19 §5)

| # | Prerequisite | Факт сегодня | Вердикт |
|---|---|---|---|
| P1 | `E2E_WORKSPACE_ID` | **unset** (и в шелле, и в `docker exec animastor-backend printenv`) | ❌ |
| P2 | запущенный worker на этот workspace | 0 воркеров (`/gpu/health`: `gpus:0`, `running:0`, нет worker-контейнеров) | ❌ |
| P3 | `GPU_HUB_API_KEY` в gpu-hub | присутствует (`wc -c` = 65 с переводом строки) | ✅ |
| P4 | эндпоинт `https://animastor.org/gpu` отвечает | `/gpu/health`=200, контракт `/gpu/worker-bundle/sha256`=200 | ✅ |
| P5 | workflow `tts-qwen-narrator.json` (1 626 Б) | существует | ✅ |
| P6 | доступ к Redis для опроса result-ключа | `docker exec animastor-redis redis-cli` работает | ✅ |
| P7 | тихая очередь `audio=0` | `{"image":8,"audio":0,"video":0}`, ws-канал 252, `running:0` | ✅ |
| P8 | диск ≥ 15 ГБ, health 200/200 | 34,7 ГБ; 200/200 | ✅ |
| P9 | согласованное окно с владельцем | **не согласовано** | ❌ |

**Статус G5 = NOT TESTED.** Dispatch (`node docker/e2e/dispatch-task.cjs`) не выполнялся —
запрещён до G5. Красные P1/P2/P9 делают запуск сейчас бессмысленным (задача повиснет
в очереди до таймаута, эффект +1 в очереди).

### 2.4 G7 — единый GO/NO-GO (runbook §7, 13 пунктов) — фактический прогон

| # | Пункт §7 | Факт | Вердикт |
|---|---|---|---|
| 1 | `df -B1` ≥ 15 млрд (+ запас под pull) | 34 725 228 544 Б; pull-порог 16,6 млрд пройден; образы gpu-hub/backend локально | ✅ |
| 2 | бэкапы `data/` + `pg_dump` + конфига проверены | manifest **9/9 OK** (повторено сегодня), `gzip -t` OK, дамп `PGDMP`, schema 41 `CREATE TABLE` | ✅ |
| 3 | D1 исполнен: живой sha == `a1900f4e…`, ссылки 200 | сегодня: sha совпал, **4/4 → 200**, старых 404 — 0 | ✅ |
| 4 | D2 подтверждён; W1–W4 зелёные; цели зафиксированы | W1–W3 зелёные (**сегодня**); **D2 не подтверждён владельцем** | ❌ |
| 5 | D3: новый digest записан; прод `.env` не менялся; **deploy `.env` содержит новый пин** | repin/CI не выполнялись; **`deploy/.env` отсутствует** | ❌ |
| 6 | D4: republish решён/выполнен или явно отложен (зафиксировано) | решение не принято и не зафиксировано (§4.2) | ❌ |
| 7 | E1–E4: `config` чист, dry-run pg/redis Running, все mount-источники есть | `config` deploy-пары **падает** без `.env` (`GPU_HUB_IMAGE` missing); **E3 dry-run не выполнялся**; E4 — все 10 mount-путей существуют ✅ | ❌ |
| 8 | E6: apk + `.well-known` в web-каталоге (если монтируется web) | web-репо: `downloads/` есть (только `version.json`, apk нет), **`.well-known` отсутствует**; в mono всё есть | ❌ |
| 9 | F: E2E baseline зелёный **или** владелец принял риск отложенного E2E | нет ни того, ни другого | ❌ |
| 10 | G: `.in` не истёк, продление выполнено, 301 ×3 живы | `.in` = **Jan 10 2027** (этап 34), 301 ×3 сегодня | ✅ |
| 11 | STD-CHECK: health 200/200, uptime стабилен, lock/git == baseline | §1 — всё OK | ✅ |
| 12 | Откат-команда проверена `compose config`; mono compose/.env не тронуты | `config --quiet` **exit 0**; `.env` 2 112 Б/600, overlay `eac32cb0…` неизменны | ✅ |
| 13 | Оператор на связи, окно согласовано, logbook открыт | окно не согласовано (этап — только анализ) | ❌ |

**Статус G7 = FAIL (NO-GO).** Выполнено 6/13; не выполнено 7/13. Критерий runbook:
«NO-GO = любой пункт не выполнен» → **допуск к фазе H не дан**. Пункты не «закрыты
задним числом»: 4,5,6,8,9 требуют действий владельца/окон, 7 — E1–E4 в окне с `.env`,
13 — согласования.

---

## 3. Изолированный restore-тест: состав копий, читаемость, план (НЕ выполнялся)

### 3.1 Состав, SHA-256, читаемость — подтверждено сегодня

| Артефакт | Размер | SHA/magic | Проверка чтения |
|---|---|---|---|
| `cutover-pg-2026-10-12.dump` | 441 269 Б | в манифесте OK; заголовок **`PGDMP`** (custom format → `pg_restore`) | читается ✓ |
| `cutover-pg-schema-2026-10-12.sql` | 68 263 Б | OK; **41 `CREATE TABLE`** | читается ✓ |
| `cutover-data-2026-10-12.tgz` | 61 786 941 Б | OK; `gzip -t` OK; **186 записей** (`data/…`) | читается ✓ |
| `cutover-config-2026-10-12.tgz` | 8 067 Б (600) | OK; `gzip -t` OK; 9 записей: `docker-compose.yml`, `docker/compose/*.yml` ×3, **`.env`**, `proxy/conf/{default.conf,.htpasswd}` | читается ✓ (**`.env` не печатать**) |
| `redis-dump-2026-10-12.rdb` | 58 372 973 Б (600) | OK; заголовок **`REDIS0012`** | читается ✓ |
| `git_repos_2026-10-12_06-00-27.tar.gz` | 51 801 578 Б | OK; `gzip -t` OK; **2 786 записей** (bare `repos/*.git`) | читается ✓ |
| `git-worktrees-…tar.gz` | 87 343 374 Б | OK; 4 269 записей | читается ✓ |
| `git-untracked-…tar.gz` | 236 390 Б | OK; 6 записей | читается ✓ |
| `git-refs-status-2026-10-12.txt` | 1 450 Б | OK — эталон HEAD для R5 | читается ✓ |
| **Итого манифест** | — | **`sha256sum -c` → 9/9 OK, exit 0** | ✓ |

Образы для теста **уже локально**: `postgres:16` (642 МБ), `redis:7` (170 МБ) →
pull не нужен. Свободный диск 34,7 ГБ (нужно ~250 МБ на распаковку + том PG).

⚠ Нюанс для R5: `git_repos_…tar.gz` снят **06:00** (до sync-этапа 26), поэтому
bare-refs в архиве соответствуют значениям из `git-refs-status-2026-10-12.txt`
(worker bare `618f87a6`, web `c7fe52ac`, backend `bce64db3`, android `254e2f08`),
а **не** текущим (worker `b3f94f42` и т.д.). Сверять нужно с `git-refs-status`,
как и записано в критерии R5, — иначе ложное расхождение.

### 3.2 Доказательство изоляции (что сделано/проверено без запуска теста)

1. **Имена:** только `restore-test-pg`, `restore-test-redis`; том `restore-test-pgdata`;
   сеть `restore-test-net`; каталоги `/tmp/restore-test-{data,config,git,redis}`.
   Сейчас таких ресурсов **нет** (`docker ps -a` / `docker network ls` — пусто).
2. **Сеть:** `docker network create --internal restore-test-net` — тестовые контейнеры
   **без выхода наружу и без доступа к хосту**, не в `animastor_net`; мосты Docker
   изолированы друг от друга. **Никаких `-p`/`--publish`** — публиковать 5432/6379
   нельзя в принципе: 5432 на хосте **занят production PG** (`0.0.0.0:5432` — проверено
   `docker inspect`), 6379 не публикуется вовсе.
3. **Креды:** тестовый PG поднимается с **собственным** паролем
   (`POSTGRES_PASSWORD=restore-test-only`), production-креды нигде не передаются →
   тест физически не может аутентифицироваться в prod даже при ошибке путей;
   доступ к тесту — только через `docker exec`, не через `127.0.0.1:5432`.
4. **Тома/монты:** используется **новый** том `restore-test-pgdata`; тома
   `animastor_pg-data` / `animastor_redis-data` и каталоги `data/` в тест **не монтируются
   на запись**. RDB монтируется из `/tmp/restore-test-redis/` (копия), не из Redis-контейнера.
5. **Файловая сверка** (`diff -rq`, `sha256sum`, `cmp`) — **только чтение** рабочего
   `data/` и конфигов; запись исключительно в `/tmp/restore-test-*`.
6. **Запреты:** без `docker compose` (никакого риска задеть проект `animastor`),
   без `docker restart/stop/rm` любых рабочих контейнеров, без правок lock/git/DNS/TLS.
7. **Контроль обратно:** после теста — `docker ps -a | grep restore-test` пусто,
   `CreatedAt` рабочих контейнеров не изменился, health 200/200, `dbsize=321`,
   `data/output` 63 203 425 Б / `data/books` 1 704 047 Б, lock `069b62d9…`/`2a221e3b…`.

### 3.3 Точные команды, ожидаемые результаты, очистка

> Статус: **подготовлен, НЕ выполнен** (задача этапа запрещает restore; запуск —
> только после подтверждения изоляции владельцем и отдельного согласованного окна).

```sh
# ── R0. Preflight (read-only) ─────────────────────────────────────────────
df -B1 / | tail -1                                        # ≥ 15000000000 (сейчас 34725228544)
cd /home/animastor/backups && sha256sum -c backup-manifest-2026-10-12.sha256   # 9/9 OK
docker ps --format '{{.Names}}\t{{.Status}}' > /tmp/restore-test-baseline-ps.txt
curl -sSk -o /dev/null -w '%{http_code}\n' --resolve animastor.org:443:127.0.0.1 https://animastor.org/health       # 200
curl -sSk -o /dev/null -w '%{http_code}\n' --resolve animastor.org:443:127.0.0.1 https://animastor.org/gpu/health     # 200

# ── R1. Изолированная сеть + PostgreSQL ───────────────────────────────────
docker network create --internal restore-test-net
docker volume create restore-test-pgdata
docker run -d --name restore-test-pg --network restore-test-net \
  -e POSTGRES_USER=animastor -e POSTGRES_PASSWORD=restore-test-only -e POSTGRES_DB=animastor \
  -v restore-test-pgdata:/var/lib/postgresql/data \
  -v /home/animastor/backups:/backups:ro \
  postgres:16
until docker exec restore-test-pg pg_isready -U animastor -d animastor; do sleep 2; done   # ≤ 30 с
docker exec restore-test-pg pg_restore --exit-on-error -U animastor -d animastor \
  /backups/cutover-pg-2026-10-12.dump                                   # ожидается exit 0
docker exec restore-test-pg psql -U animastor -d animastor -tAc "select count(*) from books"          # 5
docker exec restore-test-pg psql -U animastor -d animastor -tAc "select count(*) from generation_tasks" # 17
docker exec restore-test-pg psql -U animastor -d animastor -tAc "select count(*) from guests"         # 231
docker exec restore-test-pg psql -U animastor -d animastor -tAc "select count(*) from scenes"         # 12
docker exec restore-test-pg psql -U animastor -d animastor -tAc "\dt" | wc -l                        # 42 (41 + шапка)
# контроль prod (read-only):
docker exec animastor-pg psql -U animastor -d animastor -tAc "select count(*) from generation_tasks" # 17
docker inspect animastor-pg --format '{{.Created}}'                   # 2026-07-08T13:37:11.386… (без изменений)
```
Ожидание: `pg_restore` exit 0; счётчики совпадают с prod (снимок 06:00 — по
**статичным** таблицам ожидается точное совпадение; по активным допустимо расхождение,
объясненное изменениями после 06:00 — тогда фиксировать оба значения и объяснять);
prod-pg не пересоздан (Created/StartedAt прежние), здоровье не изменилось.

```sh
# ── R2. data/ ─────────────────────────────────────────────────────────────
mkdir -p /tmp/restore-test-data
tar -xzf /home/animastor/backups/cutover-data-2026-10-12.tgz -C /tmp/restore-test-data
diff -rq /tmp/restore-test-data/data/output /home/animastor/animastor/data/output   # пусто = совпадает
diff -rq /tmp/restore-test-data/data/books  /home/animastor/animastor/data/books    # пусто
tar -tzf /home/animastor/backups/cutover-data-2026-10-12.tgz | wc -l                # 186
du -sb /home/animastor/animastor/data/output /home/animastor/animastor/data/books   # 63203425 / 1704047 (не изменились)
```
Ожидание: `diff` без вывода; размеры рабочего `data/` не изменились (запись шла только в `/tmp`).

```sh
# ── R3. Redis ─────────────────────────────────────────────────────────────
mkdir -p /tmp/restore-test-redis
cp -p /home/animastor/backups/redis-dump-2026-10-12.rdb /tmp/restore-test-redis/dump.rdb
docker run -d --name restore-test-redis --network restore-test-net \
  -v /tmp/restore-test-redis:/data redis:7 \
  redis-server --dir /data --save '' --appendonly no
sleep 3
docker exec restore-test-redis redis-cli dbsize                         # 321
docker exec restore-test-redis redis-cli --scan --pattern 'animastor:*' | head -5   # ключи читаются
docker exec animastor-redis redis-cli dbsize                            # 321 (prod не тронут)
```
Ожидание: `dbsize=321` в тесте и в prod; префиксы `animastor:queue:*`,
`animastor:event-journal:*` читаются; prod-Redis не изменялся (никаких
`flushdb/del/rpop` — даже в тесте не используются).

```sh
# ── R4. config ────────────────────────────────────────────────────────────
mkdir -p /tmp/restore-test-config
tar -xzf /home/animastor/backups/cutover-config-2026-10-12.tgz -C /tmp/restore-test-config
stat -c '%s %a' /tmp/restore-test-config/.env                           # 2112 600 (НЕ читать/НЕ печатать)
cmp -s /tmp/restore-test-config/.env /home/animastor/animastor/.env; echo "env_cmp=$?"   # ожидается 0
sha256sum /tmp/restore-test-config/docker-compose.yml /home/animastor/animastor/docker-compose.yml  # идентичны
docker exec animastor-proxy nginx -t >/dev/null 2>&1; echo "nginx=$?"   # 0
```
Ожидание: пути/размеры/права ок, байты идентичны текущим; содержимое `.env` не выводится
ни в лог, ни в отчёт.

```sh
# ── R5. git ───────────────────────────────────────────────────────────────
mkdir -p /tmp/restore-test-git
tar -xzf /home/animastor/backups/git_repos_2026-10-12_06-00-27.tar.gz -C /tmp/restore-test-git
for d in /tmp/restore-test-git/repos/*.git; do echo "== $d"; git -C "$d" fsck --connectivity-only; done   # exit 0
for d in /tmp/restore-test-git/repos/*.git; do printf '%s ' "$(basename $d)"; git -C "$d" rev-parse refs/heads/main 2>/dev/null || git -C "$d" rev-parse refs/heads/master; done
```
Ожидание: `fsck` без ошибок; HEAD совпадают с `backups/git-refs-status-2026-10-12.txt`
(animator: web `c7fe52ac`, backend `bce64db3`, worker `618f87a6`, android `254e2f08`,
gpu-hub `ecefd0b7`) — **не** с текущими wt (см. §3.1 нюанс).

```sh
# ── R6. Контроль после + очистка ──────────────────────────────────────────
docker ps --format '{{.Names}}\t{{.Status}}\t{{.CreatedAt}}'   # == baseline-файлу
curl -sSk -o /dev/null -w '%{http_code}\n' --resolve animastor.org:443:127.0.0.1 https://animastor.org/health    # 200
docker exec animastor-redis redis-cli dbsize                   # 321
sha256sum /home/animastor/animastor/packages/animastor-gpu-hub/artifacts.lock.json \
          /home/animastor/animastor-gpu-hub/artifacts.lock.json # 069b62d9… / 2a221e3b…
du -sb /home/animastor/animastor/data/output /home/animastor/animastor/data/books   # 63203425 / 1704047
docker rm -f restore-test-pg restore-test-redis
docker volume rm restore-test-pgdata
docker network rm restore-test-net
rm -rf /tmp/restore-test-data /tmp/restore-test-config /tmp/restore-test-git \
       /tmp/restore-test-redis /tmp/restore-test-baseline-ps.txt
docker ps -a --format '{{.Names}}' | grep -c restore-test      # 0
docker volume ls --format '{{.Name}}' | grep -c restore-test    # 0
docker network ls --format '{{.Name}}' | grep -c restore-test   # 0
```

Очистка удаляет **только** ресурсы с префиксом `restore-test` и каталоги
`/tmp/restore-test-*`; рабочие данные, бэкапы, монорепо и lock не затрагиваются.
Ожидаемое время прогона: 5–10 минут (PG-restore ~1–2 мин).

---

## 4. Пересмотр оставшихся решений

### 4.1 G4 — deploy-layout, абсолютные пути, отсутствующий `.env`

Факт сегодня: `/home/animastor/animastor-backend/deploy/` существует
(`docker-compose.yml` 6 513 Б sha `264550e9…`, `overlay-backend-standalone.yml`
2 171 Б sha `9f13d888…`, `README.md` 2 525 Б), **`deploy/.env` отсутствует**.
Рендер deploy-пары: `docker compose … -f deploy/docker-compose.yml -f
deploy/overlay-backend-standalone.yml config --quiet` → **exit 1**
(`services.gpu-hub.image: required variable GPU_HUB_IMAGE is missing`) — то есть
без `.env` E1 невозможен (как и записано в критерии E1). Рендер mono-пары
(откат H-R) → exit 0.

**Минимально необходимое решение владельца (одним решением):**
1) **принять отклонение §3.4 отчёта 27** — в `deploy/overlay-…yml` пути **абсолютные**
   (байт-идентичная копия небезопасна: `./data/output` разрешился бы в пустой
   `deploy/data/…`); рекомендую вариант «(а) принять» — он проверен E2-сверкой;
2) **создать `deploy/.env` (600)** со значениями из mono `.env` — вносит владелец,
   значения не передаются в отчёты/логи;
3) зафиксировать, что `.env` прод остаётся нетронутым до H2.
Это открывает фазу E (E1 → E2 → E3 dry-run) и снимает пп. 5, 7 чек-листа §7.

### 4.2 D4 — какие ZIP действительно требуют замены (проверено по телам)

Скачаны и вскрыты 4 опубликованных актива (read-only, sha == lock, 4/4 MATCH):

| Ассет | Содержит ли 404-URL `github.com/Animastor/animastor.git` (HTTP **404**) | Нужна ли замена |
|---|---|---|
| `installer-src-v1.zip` (`ae589c10…`) | **ДА, функционально**: `setup-contract.js:695` → шаг `docker-build` предлагает `git clone https://github.com/Animastor/animastor.git` (в backend-repo `a7a8c463` исправлено на `…/animastor-worker.git` = 200) | **ДА — обязательно** |
| `animastor-worker-bundle-2.1.1.zip` (`4cb6f133…`) | **ДА, но только metadata**: `package.json` → `repository.url`/`bugs.url` = `github.com/Animastor/animastor[.git|/issues]` (404), `homepage=https://animastor.org`; в живом бандле/pin — `animastor-worker.git`, `animastor-worker/issues`, `homepage=https://animastor.in`; состав 7 файлов (нет `package-lock.json`) против 8 в pin-стейджинге | **Факультативно** (косметика: поле `repository` ничем не используется для клонирования) |
| `hub-workflows-v1.zip` (`c484e197…`) | URL Animastor отсутствует вовсе; дерево `workflows` идентично pin↔target (`0d51107d…`) | **НЕТ** |
| `install-manifests-v1.zip` (`1fd9f8ad…`) | только сторонние репо (ComfyUI и пр.); дерево идентично pin↔target (`46f3c26a…`) | **НЕТ** |

**Последствия сохранения текущих артефактов:** инсталлятор, идущий по шагу
`docker-build`, получает 404 (реальный ущерб пользователям); живой хаб-бандл и
production-образ работают (пины валидны, W1 8/8); workflows/manifests менять не нужно —
repin затронет только 2 группы (§2.1).

**Безопасный порядок выпуска (ничего не выполнялось):**
1) G2 (владелец подтверждает цели) → 2) G3 (разрешение на push/CI/publish);
3) D1 `stage-artifacts.cjs --write-lock` на целевых коммитах → ревью diff (только
worker-bundle/installer-src) → commit **без push**; 4) D2 push origin → github (FF-only);
5) D3 CI `workflow_dispatch` с immutable-тегом → записать digest из run summary;
6) **D4:** упаковка исправленного `installer-src` — источник **backend-repo**
   (mono всё ещё содержит 404 → либо синхронизировать `packages/animastor-installer`
   mono↔backend, либо паковать из backend эквивалентным способом — **выбор владельца**);
   **до** замены — архив старых тел в `backups/release-archives/` (аддитивно);
   тела релизов immutable → публикация в **новый** tag/release (`hub-artifacts-v2`
   и при необходимости `worker-bundle-v2.1.2`) либо перезаливка с архивацией —
   **решение владельца**; 7) обновить `sha256_asset` в L1 tool-ом, повторить
   `--check` + скачивание сверку; 8) публикация — **только** в отдельном окне G3,
   никогда вместе с E2E (G5) или cutover (G7).

### 4.3 TLS — учёт этапа 34 и риск webroot при M2/E6

**G6/D5 — PASS/RESOLVED** (этап 34): dry-run exit 0, реальное продление выполнено,
`animastor.in` → **2027-01-10 09:24:17 GMT** (запас ~90 дней), issuer YR2, SAN 4/4,
`.org` не тронут, `nginx -t` + reload без рестарта. Сегодня подтверждено повторно:
SNI `.in` = Jan 10 2027, `.org` = Jan 6 2027, 301 ×3 живы.

**Зафиксированный риск:** оба renewal-конфига указывают webroot
`/home/animastor/animastor/frontends/website` (mono). При смене website-монта на
web-каталог (E6/H) ACME-вызовы уйдут не туда → продление сломается.
Проверено сегодня: в `animastor-web/frontends/website/` **нет `.well-known`** (и нет
`downloads/animastor-android-latest.apk` — есть только `version.json`), в mono — есть.
→ **порядок обязателен:** до любой смены монта выполнить **M2** (копия `.well-known/`
+ apk в web-каталог) **и** обновить `webroot_path` в обоих renewal-конфигах
(root-действие, отдельное разрешение); либо сначала продлить, потом менять монт.
Ближайшее авто-окно `certbot.timer` для `.in` — ~**2026-12-11**; reload nginx
(ручной) потребуется после любого авто-продления.

### 4.4 G8 — синхронизация Git: статус сохраняется

Проверено сегодня (все операции read-only, `ls-remote` = чтение):

| Репо | bare `refs/heads/main` | worktree HEAD | `ls-remote github` |
|---|---|---|---|
| animastor-web | `fbc93662…` | `fbc93662…` | `fbc93662…` |
| animastor-backend | `a7a8c463…` | `a7a8c463…` | `a7a8c463…` |
| animastor-worker | `b3f94f42…` | `b3f94f42…` | `b3f94f42…` |
| animastor-android | `92a56c0d…` | `92a56c0d…` | `92a56c0d…` |

4/4 **bare == wt == github**, совпадает с пост-sync снимком этапа 26
(`git-refs-post-sync-stage26-2026-10-12.txt`); новых расхождений нет.
**G8 = PASS сохранён.** Push (`J1`) по-прежнему требует отдельного разрешения.

---

## 5. Итоговая таблица гейтов G1–G8 и решений D1–D5

| Код | Статус | Доказательство (сегодня) | Следующий шаг | Необходимый доступ | Риск при бездействии |
|---|---|---|---|---|---|
| **G1** (4 URL) | **PASS** (закрыт 12.10) | M3 выполнен; живой sha `a1900f4e…`, 4/4 → 200, старых 404 — 0 | — | — | нет |
| **G2** (цели repin) | **BLOCKED** | C1 8/8 `cmp`; C2 пины exit 0 / цели exit 1 с `417c0ad4…`, `ff27e291…`, `0.1.1`; C3 `--check` exit 0 + 4/4 зипа MATCH; **C4 нет** | письменное подтверждение владельцем целей worker `b3f94f42` / backend `a7a8c463` и состава republish | владелец (письменно) | фаза D закрыта; H может идти только на текущих пинах |
| **G3** (push/CI/publish) | **NOT TESTED** | ничего не публиковалось; `ls-remote` только читался; lock не изменён | после G2 — отдельное окно: `--write-lock` → push → CI | владелец + GitHub-токен/учётка | репин не доходит до CI/пользователей |
| **G4** (deploy-layout) | **BLOCKED** | `deploy/` есть (3 файла), **`deploy/.env` нет**; `config --quiet` deploy-пары exit 1 (`GPU_HUB_IMAGE` missing) | утвердить отклонение (абсолютные пути) + создать `deploy/.env` (600) | владелец (секреты) | фаза E недоступна → H невозможен |
| **G5** (E2E-окно) | **NOT TESTED** | P1 unset, P2 0 воркеров, P9 окно не согласовано; P3–P8 зелёные; dispatch не выполнялся | согласовать окно, выдать `E2E_WORKSPACE_ID`, поднять worker | владелец (окно + workspace) | нет baseline E2E до изменений (п. 9 §7) |
| **G6/D5** (TLS) | **PASS / RESOLVED** (этап 34) | SNI `.in` Jan 10 2027 (сегодня), `.org` Jan 6 2027, 301 ×3, `nginx -t` ok | контроль до смены website-монта (M2 + правка `webroot_path`) либо автоокно ~11.12.2026 | root/`docker` для ручного reload | после E6 без M2+webroot продление сломается |
| **G7** (GO/NO-GO) | **FAIL → NO-GO** | прогон §7: ✅ пп. 1,2,3,10,11,12; ❌ пп. 4,5,6,7,8,9,13 | закрыть 7 пунктов (см. §6) | владелец (окно, `.env`, решения) | cutover запрещён |
| **G8** (bare-sync) | **PASS** (сохранён) | bare == wt == github 4/4; == пост-sync этапа 26 | push в фазе J1 — только с разрешения | владелец (G8 на push) | расхождение зеркал после будущих push |
| **D1** (канонический index) | **ИСПОЛНЕН** | prod-файл == живое тело == web-репо `a1900f4e…`; откат-каналы: `backups/index.html.pre-m3-276a5fc4.html` + git HEAD-блоб | коммит в mono — отложить до фазы J (решение владельца) | владелец (решение по mono) | потеря отката только при удалении backups (запрещено) |
| **D2** (цели repin) | **BLOCKED** (= G2) | техчасть готова (W1–W3 PASS) | письменное «да» после ревью расхождений | владелец | — |
| **D3** (pg/redis без recreate) | **PASS (решение)** | политика зафиксирована; **проверка E3 ещё не выполнялась** | E3 dry-run в окне (pg/redis должны быть `Running`) | окно с владельцем | случайный recreate → потеря данных |
| **D4** (republish ZIP) | **BLOCKED** | тела 4/4 == lock; 404-шаг только в `installer-src-v1.zip`; `workflows`/`install-manifests` менять не нужно | решение: новый immutable release (рекомендуется) vs перезаливка; источник упаковки: backend-repo | владелец + учётка публикации + G3 | пользователи получают 404 при docker-build шаге |
| **D5** (продление `.in`) | **RESOLVED** (этап 34) | новый срок 2027-01-10 | — | — | — |
| **Restore-тест** | **READY — NOT RUN** | 9/9 SHA OK, артефивы читаются, образы локально, план изоляции §3 | отдельное разрешение → прогон §3.3 | владелец (разрешение на прогон) | «бэкапы есть, но не проверены» |
| Диск | PASS | 34 725 228 544 Б ≥ 15/16,6 млрд | контроль перед каждой фазой | — | ABORT-порог §6 |

---

## 6. Минимальный набор обязательных действий перед допуском к cutover

Порядок = порядок исполнения; без пунктов 1–6 допуск к H не даётся (§7 NO-GO).

1. **G4:** утвердить deploy-layout (в т.ч. абсолютные пути в overlay-копии) и создать
   `deploy/.env` (600) → открывает **E1–E3** (снимает пп. 5, 7).
2. **E-окно:** E1 `config` (нет `build:`, image=digest) → E2 diff → **E3 dry-run**
   (pg/redis `Running`, без Recreate) → E4 (уже зелёный) → E5 по необходимости.
3. **G2 → G3:** письменное подтверждение целей → отдельное окно repin/CI/publish
   (снимает пп. 4, 5-часть); D0-диск уже пройден.
4. **D4:** решение по `installer-src` (новий immutable release vs перезаливка) —
   минимум **явно зафиксированное «отложено»** (снимает п. 6).
5. **G5:** согласованное E2E-окно с P1–P9 **либо** письменное решение владельца
   принять риск отложенного E2E (допускает п. 9).
6. **E6 + M2 + webroot:** если планируется смена website-монта — сначала перенос
   apk и `.well-known` в web-каталог (сейчас их там нет) и правка `webroot_path`;
   иначе монт оставить на mono (допускает п. 8 в режиме «монтируется mono»).
7. **Restore-тест** (§3.3) — рекомендуется до H: закрывает риск «копии не проверены»
   (формально не входит в §7, но это единственная проверка пригодности бэкапов).
8. **Окно H:** оператор на связи, окно согласовано, logbook открыт (п. 13) + повторный
   STD-CHECK и `df -B1` в момент входа.

Дополнительно (не блокирует H, но требует решения): судьба uncommitted-правки mono
(commit сейчас vs фаза J), и ближайший TLS-контроль до смены монта (~11.12.2026).

---

## 7. Что НЕ выполнялось (запреты соблюдены)

Переключение production / смена mounts / `up|stop|restart|down` рабочих контейнеров /
правки Compose, Nginx, DNS, TLS / `certbot renew` и `nginx -s reload` /
**restore (pg_restore, загрузка RDB в рабочий Redis, распаковка в рабочие каталоги)** /
очистка Redis (`flushdb/del/rpop`) / правка `artifacts.lock.json` и любых lock /
`git commit`, `git push`, `--write-lock` / публикация ZIP (`gh release upload`) /
удаление данных, бэкапов, монорепо / `docker image|volume prune` / `journalctl --vacuum`.
Диспатч E2E не выполнялся. Секреты `.env` не читались и не печатались.
Разрешённые и использованные команды: `sha256sum`, `cmp`, `diff`, `tar -tzf`, `gzip -t`,
`git status/rev-parse/show/clone(в /tmp)/ls-remote(read)`, `curl` (GET/HEAD),
`docker ps/inspect/exec(read-only)/images/network ls`, `docker compose config --quiet`,
`node stage-artifacts.cjs`/`update-artifacts-lock.cjs --check` (без `--write-lock`,
всё в `/tmp`), `openssl s_client`, `redis-cli` (read-only), `psql` (read-only `select`),
`unzip`, `stat`, `du`, `df`, `date`.

Scratch-каталог `/tmp/stage35/` (клоны, скачанные зипы, распакованный бандл) удалён
по завершении этапа; в рабочих каталогах ничего не создавалось.

## 8. Резюме для чата

**PASS (этап).** Фактическая картина: **G2 — BLOCKED** (C1–C3/W1–W3 выполнены сегодня
и все PASS: бандл 8/8 == пину `480af146…`, staging на пинах exit 0, на целях exit 1
с теми же расхождениями, `--check` exit 0, 4/4 зипа == lock; нет только письменного
подтверждения целей), **G3 — NOT TESTED** (разрешения нет, ничего не публиковалось),
**G5 — NOT TESTED** (P1/P2/P9 красные, dispatch не выполнялся), **G7 — NO-GO**
(выполнено 6/13 пунктов §7; блокируют пп. 4,5,6,7,8,9,13).
**Restore-тест — готов к запуску, не запущен:** бэкапы 9/9 SHA OK и читаются
(`PGDMP`, `REDIS0012`, 186/9/2786 записей), образы `postgres:16`/`redis:7` локально,
изоляция доказана (сеть `--internal` `restore-test-net`, без публикации портов —
5432 на хосте занят prod-PG, собственный пароль, новый том `restore-test-pgdata`,
запись только в `/tmp/restore-test-*`, сверка с prod только на чтение); команды и
очистка — в §3.3 отчёта; **запуск только после отдельного разрешения**.
Главные оставшиеся блокеры: **G4** (`deploy/.env` нет, абсолютные пути не утверждены →
E-фаза закрыта), **G2/G3** (нужно «да» на цели и окно публикации), **D4**
(замены требует только `installer-src-v1.zip` — функциональный 404 в шаге docker-build;
`workflows`/`install-manifests` менять не нужно; `worker-bundle` — только metadata),
**G5/G7** (E2E-окно + согласованное окно H), **E6/M2** (`.well-known` и apk в web-каталоге
отсутствуют — критично при смене монта из-за TLS-webroot). Удержаны PASS: **G1, D1,
G6/D5 (TLS до 2027-01-10), G8** (bare == wt == github 4/4). Диск 34,7 ГБ, health 200/200,
lock/data/контейнеры без изменений.
Отчёт: `/home/animastor/reorg-2026-10-12/35-remaining-blockers-restore-readiness.md`.
