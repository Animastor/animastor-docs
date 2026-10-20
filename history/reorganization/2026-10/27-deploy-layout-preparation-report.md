# Animastor — Этап 27: DEPLOY LAYOUT PREPARATION

Дата: 2026-10-12 (UTC, окно 07:00–07:10). Итог: **PASS** (с оговоркой G4 — см. §3.4).

Прочитано перед работой: `21-production-cutover-runbook.md` (§0, фазы E/H/J, §5.x),
`26-git-layout-sync-report.md`, `25-disk-backup-report.md`, отчёты 18–24 (точечно).

Цель достигнута: целевой deploy-каталог подготовлен и проверен **без переключения
production**. Ничего не перезапускалось, не публиковалось, не удалялось; mounts,
compose работающих контейнеров, lock-файлы, DNS/TLS/секреты не менялись.

---

## 1. PREFLIGHT — **PASS**

| Проверка | Команда | Результат |
|---|---|---|
| Свободное место | `df -B1 /` | вход: `25402982400` Б; финал: **`25401716736` Б** ≥ порога `15000000000` ✓ |
| Резервные копии этапа 25 | `sha256sum -c backups/backup-manifest-2026-10-12.sha256` | **9/9 OK** (повторно и в финале этапа) ✓ |
| refs-копии этапа 26 | `ls backups/git-refs-{pre,post}-sync-stage26-*.txt` | существуют (4 254 / 3 683 Б) ✓ |
| Git-репозитории | `git rev-parse HEAD` ×6 + `status --porcelain` | mono `465453df` (`?? overlay…`), backend `a7a8c463` (`?? freebuff…`), web `fbc93662`, android `92a56c0d`, worker `b3f94f42`, gpu-hub `ecefd0b7` — == этапу 26 ✓ |
| Контейнеры | `docker ps` | 7 шт., CreatedAt/uptime без изменений (backend 2026-10-10, gpu-hub 2026-10-08, proxy 2026-08-22, pg/redis 2026-07-08) ✓ |
| Health | `curl …/health`, `…/gpu/health` | **200 / 200** ✓ |
| Lock-файлы | `sha256sum` L1/L2 | `069b62d931c1ff0e…`, `2a221e3ba626326c…` == baseline ✓ |

Исходное состояние зафиксировано; несоответствий нет → изменения разрешены.

---

## 2. ИСХОДНЫЕ ДАННЫЕ ДЛЯ LAYOUT (что изучено)

- **Mono compose** `/home/animastor/animastor/docker-compose.yml` (6 284 Б, 644) —
  gpu-hub с `build:`, bind-mount'ы **относительные** `./…`.
- **Repo compose** `/home/animastor/animastor-backend/docker-compose.yml` (6 162 Б) —
  от mono отличается **только** секцией gpu-hub (без `build:`, `image: ${GPU_HUB_IMAGE:?…}`).
- **Overlay mono** `docker/compose/overlay-backend-standalone.yml` (1 418 Б,
  sha256 `eac32cb0bb7f1f6a806e03b3c64fd052808ac7a569345f8377a1af35579a36a1`,
  untracked) — `image: ${BACKEND_IMAGE:?…}`, `build: !reset null`,
  `volumes: !override` (4 монта, относительные пути).
- **Overlay gpu-hub** mono == repo (byte-identical) — `build: !reset null`.
- **Live-конфигурация:** backend `image=…@sha256:e8152778…`, gpu-hub `image=…@sha256:daf510ff…`,
  4 + 6 bind-mount'ов, тома `animastor_pg-data` / `animastor_redis-data`.
- **`.env`** (600, 2 112 Б) — прочитаны **только имена ключей** (14 шт.), значения не открывались.

---

## 3. DEPLOY-КАТАЛОГ — **PASS** (структура создана; содержимое — черновик под G4)

### 3.1 Созданная структура (фактические пути, владелец/права)

```
/home/animastor/animastor-backend/deploy/     drwxr-xr-x animastor:animastor (755)
├── docker-compose.yml              6 513 Б  644  (3-way merge, абсолютные пути)
├── overlay-backend-standalone.yml  2 171 Б  644  (копия overlay, абсолютные пути)
└── README.md                       2 525 Б  644  (инструкция, ключи .env по именам)
```

`.env` **НЕ создан** — секреты вносит владелец (`chmod 600`) (runbook E1).

### 3.2 Источники → назначения

| Назначение | Источник | Что сделано |
|---|---|---|
| `deploy/docker-compose.yml` | 3-way: mono `docker-compose.yml` + `overlay-backend-standalone.yml` vs repo `docker-compose.yml` | объединено; (1) все bind-mount → **абсолютные** (E1), указывают на текущие production-каталоги mono; (2) gpu-hub — repo-версия (без `build:`); (3) `AI_API_BASE_URL`/`OPENROUTER_MODEL` оставлены жёстко как в mono (поведение == production) |
| `deploy/overlay-backend-standalone.yml` | mono `docker/compose/overlay-backend-standalone.yml` | копия; **единственное** отличие — 4 пути сделаны абсолютными (см. 3.4). Оригинал не тронут (sha `eac32cb0…` перепроверен) |
| `deploy/.env` | не копировался | действия владельца |

### 3.3 Проверки (команда → результат)

**E1-подобный рендер (read-only, без секретов):**
```sh
env POSTGRES_PASSWORD=dummy WORKSPACE_SECRET_KEY=dummy \
    BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:e8152778… \
    GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:daf510ff… GPU_HUB_API_KEY=dummy \
docker compose --project-name animastor --env-file /dev/null \
  -f deploy/docker-compose.yml -f deploy/overlay-backend-standalone.yml config
```
- exit **0** (для deploy-пары и для текущей mono-пары);
- `--env-file /dev/null` + только фиктивные значения → **секреты не подгружались и не печатались** (вывод рендера не содержит реальных значений);
- в resolved-конфиге deploy **нет ключа `build:` вообще** (критерий E1 PASS);
- `image` backend = `…@sha256:e8152778…`, gpu-hub = `…@sha256:daf510ff…` (digest-пины);
- тома: `animastor_pg-data`, `animastor_redis-data` (корректные имена при `--project-name animastor`).

**E2-сверка (текущий resolved vs новый resolved):**
```sh
diff /tmp/e27-cur.yml /tmp/e27-new.yml
```
→ ровно одна разница: **удалён блок `build:`/`context`/`dockerfile` у gpu-hub**
(желаемое по E1 PASS). Ни один mount, том, port, healthcheck и env не отличается.

**Сверка mount-путей с живыми контейнерами:** источники нового конфига ==
`docker inspect` animastor-backend (4) + animastor-proxy (6, вкл. `/etc/letsencrypt`) ✓.

**Не выполнялось:** `up`, `--dry-run up` (E3 — фаза E с владельцем), чтение `.env`.

### 3.4 Отклонение от формулировки runbook E1 (⚠ на утверждение G4)

Runbook E1 требует «`overlay-backend-standalone.yml` (копия, sha `eac32cb0…`)».
**Байт-идентичная копия в `deploy/` небезопасна:** относительные `./data/output`…
в overlay разрешаются относительно каталога compose-файлов (= `deploy/`) и
смонтировали бы **пустые** `deploy/data/…` каталоги. Поэтому копия с
**абсолютными** путями (sha отличается; содержательно те же каталоги mono).
Оригинал в mono не изменён. Варианты решения владельца: (а) принять абсолютную
копию (рекомендуется, проверено E2-сверкой), (б) symlink-структура в deploy/
(не рекомендуется), (в) иной layout.

---

## 4. ПОДГОТОВКА ПЕРЕНОСА — M1–M5 (**PASS**: перечни составлены, ничего не перезаписано)

| Шаг | Файлы/конфиги (источник → назначение) | Зависимости | Порядок копирования | Проверки целостности | Откат |
|---|---|---|---|---|---|
| **M1** deploy-каталог | mono compose + overlay + repo compose → `animastor-backend/deploy/` *(создано)*; `.env` — владелец | **G4**; окно E1–E2 | 1) overlay-копия 2) compose-merge 3) `.env` (600) владельцем | `sha256sum` копий; `compose config` exit 0; нет `build:`; image=digest; diff с текущим (E2) | не использовать каталог; удаление — отдельное разрешение |
| **M2** website runtime (E6) | `mono/frontends/website/downloads/animastor-android-latest.apk` (`0b7a1333…`, 12 505 721 Б), `version.json` (`8dbbfe10…`, 238 Б), `mono/frontends/website/.well-known/` → `animastor-web/frontends/website/…` | решение **D1**; разрешение владельца на копирование | 1) `downloads/` (в web уже есть идентичный `version.json`, apk отсутствует) 2) `.well-known/` (в web отсутствует) | `sha256sum` копий == оригиналам; `test -e` всех трёх путей | не переключать website-монт → монты остаются на mono (H без M2) |
| **M3** index.html (B2) | web `frontends/website/index.html` (`a1900f4e…`) → mono (сейчас `276a5fc4…`, 4 битые ссылки) | **G1** (утверждение 4 URL) | cp → sha256 → `diff` (ровно 4 строки) → проверка 4 ссылок | sha == `a1900f4e…`; ссылки → 200 | `git -C /home/animastor/animastor checkout -- frontends/website/index.html` |
| **M4** cutover (H2) | `cd mono && compose stop backend nginx` → `cd animastor-backend/deploy && compose --project-name animastor --env-file .env -f … up -d` | **G7** GO/NO-GO; M1 PASS; диск ≥ порога | только в окне H | `docker ps` 5×Up; pg/redis Created == до; health 200/200; nginx -t; 301 ×3; image == digest | H-R из mono: `compose -f docker-compose.yml -f docker/compose/overlay-backend-standalone.yml up -d --force-recreate` |
| **M5** `.env`-черновик (новый `GPU_HUB_IMAGE`) | значения D2/D3 → **только** `deploy/.env`; прод `.env` не правится до H2 | **G2/G3** (repin) | запись в deploy-`.env` владельцем | `stage-artifacts.cjs` verify exit 0; lock `--check` exit 0 | прод-`.env` прежний → H-R возвращает прежний digest |

Правило: **ни один существующий файл не перезаписывался** — все материалы этапа
создавались в новом каталоге `deploy/`.

---

## 5. СОХРАННОСТЬ ДАННЫХ — **PASS**

| Объект | Проверка | Результат |
|---|---|---|
| `data/output` | `du -sb` | 63 203 425 Б, на месте ✓ |
| `data/books` (тестовые книги) | `du -sb` | 1 704 047 Б, на месте ✓ |
| Результаты генерации / PG | backup-этапа 25 (`cutover-data-*.tgz`, `cutover-pg-*.dump`) | sha256 9/9 OK, `gzip -t` OK (этап 26) ✓ |
| Конфигурации | `cutover-config-*.tgz` (600) | sha256 OK ✓ |
| Git-репозитории | HEAD 6/6 == этапу 26; refs не трогались (без push/удаления) | ✓ |
| `overlay-backend-standalone.yml` | sha256 | `eac32cb0…` == baseline ✓ (untracked, сохранён) |
| `freebuff-chat-2026-10-11T07-41-12.445Z.md` | sha256 | `2134973a…` == baseline ✓ (untracked, сохранён) |
| Старый monorepo | существует, не трогался | `465453df`, 1 untracked ✓ |
| Redis | `dbsize=321` | без изменений ✓ |

Новый untracked `?? deploy/` в backend-worktree — **единственное** git-изменение
этапа (осознанное, не закоммичено; в `.gitignore` правила нет — не добавлялся,
чтобы не менять трек-файлы).

---

## 6. ZIP-АРТЕФАКТЫ (D4) — **PASS** (механизм найден и описан; ничего не публиковалось)

**Фактический ручной механизм:** публикация 4 zip — загрузка ассетов на
**уже существующие immutable GitHub Release** (GitHub UI или `gh`);
автоматических загрузчиков в mono/packages — 0 (аудит 22 §4.2, подтверждено
повторным поиском). Ассеты в Git-Release уже опубликованы (проверено публичным
GitHub API, без токена):

| Release | Ассет | Размер | `sha256_asset` из lock |
|---|---|---|---|
| `Animastor/animastor-backend` `hub-artifacts-v1` | `hub-workflows-v1.zip` | 18 228 | `c484e197a4c8f7cb03bf5a39a971b1ea8b837d6bce3e4e2bf2dab376028b3e04` |
| то же | `installer-src-v1.zip` | 165 334 | `ae589c10b47a8bd200daec7f194f5340b8984922bc26e259f11d2095088c7ece` |
| то же | `install-manifests-v1.zip` | 16 803 | `1fd9f8adf2e9400a2489dbb0bebbd416331d6401254f8dba4088e8e21a0383f9` |
| `Animastor/animastor-worker` `worker-bundle-v2.1.1` | `animastor-worker-bundle-2.1.1.zip` | 20 073 | `4cb6f133ad7984cd491d5f4f5c77e12009c3871ffc912246888e41871d8afdae` |

**Необходимые команды (НЕ выполнялись):**
```sh
# 1) упаковка (если тело меняется): byte-faithful стенд-ин/фактический генератор
node packages/animastor-gpu-hub/tools/standalone-fixture.cjs make /tmp/zips
# 2) проверка тел перед публикацией
sha256sum /tmp/zips/*.zip   # сверить с sha256_asset в artifacts.lock.json (таблица выше)
# 3) публикация (ручная; токен/учётка — действие владельца; НЕ ВЫПОЛНЕНО)
gh release upload hub-artifacts-v1 hub-workflows-v1.zip installer-src-v1.zip install-manifests-v1.zip --repo Animastor/animastor-backend
gh release upload worker-bundle-v2.1.1 animastor-worker-bundle-2.1.1.zip --repo Animastor/animastor-worker
# 4) проверки после публикации
curl -fsSL -o /tmp/a.zip https://github.com/Animastor/animastor-backend/releases/download/hub-artifacts-v1/<asset> && sha256sum /tmp/a.zip   # == pin
node packages/animastor-gpu-hub/tools/standalone-fixture.cjs assets-from-release <dir> https://github.com   # верификация по sha256_asset
sh packages/animastor-gpu-hub/scripts/fetch-pinned-assets.sh <lock> <staging> https://github.com
node scripts/update-artifacts-lock.cjs --check    # exit 0
node scripts/stage-artifacts.cjs … && node scripts/smoke-artifacts.cjs   # в CI/окне D
```
Важно: тела релизов immutable → **замена** исправленного `installer-src` =
решение D4 (новый tag/release либо перезаливка с архивацией старого актива).

**`artifacts.lock.json` не менялся:** L1 sha256 `069b62d931c1ff0e…` до/после ✓.

---

## 7. TLS (G6/D5) — **PASS** (проверено read-only; продление НЕ запускалось)

| Проверка | Команда | Результат |
|---|---|---|
| Сертификат `.in` | `openssl s_client -servername animastor.in -connect 127.0.0.1:443 \| x509 -noout -enddate` | **Nov 19 11:42:10 2026 GMT** (38 дней; дедлайн не пропущен) |
| Сертификат `.org` | то же | Jan 6 18:29:48 2027 GMT ✓ |
| 301-редиректы ×3 | `curl -k --resolve … http(s)://animastor[.in]/, www` | все → `301 https://animastor.org/` ✓ |
| Certbot | `certbot --version`, `systemctl is-active/enabled certbot.timer` | 1.21.0; **active + enabled** (след. запуск ~каждые 12 ч) |
| Renewal-конфиг | `grep` `/etc/letsencrypt/renewal/animastor.in.conf` | `authenticator=webroot`, ACME v02, `webroot_path=/home/animastor/animastor/frontends/website` (mono), `webroot_map` содержит только `admin.animastor.in` (остальные домены берут `webroot_path`) |
| Webroot | `ls -ld …/frontends/website/.well-known/acme-challenge` | существует, 775, запись при renew делает root ✓ |
| Права | `stat /etc/letsencrypt/{live,archive}` | `drwx------ root` → **renewal только root** |

**Точная процедура продления `.in` (G6/D5, до 2026-11-19 11:42 GMT) — НЕ ВЫПОЛНЯЛАСЬ:**
1. root-доступ; окно (сервисы не рестартуются, но нужен reload nginx — см. п.4).
2. `certbot renew --dry-run` — проверка ACME http-01 по webroot mono (до любых
   website-переездов E6; после E6 — сначала сохранить webroot, иначе продление сломается).
3. `certbot renew --cert-name animastor.in` (или `certbot renew`).
4. **Перезагрузка nginx для подхвата нового серта:** `docker exec animastor-proxy nginx -t`
   затем `nginx -s reload` (это НЕ рестарт контейнера, но это действие в prod-окне —
   согласовать; без reload остаётся старый серт до перезапуска proxy).
5. Контроль: SNI `notAfter` `.in` ≥ +60 дней; 301 ×3; `nginx -t`.
Автопродление таймером сработает с ~2026-10-20 (окно 30 дней) — но **reload
nginx всё равно потребуется** → подтвердить владельцу.
DNS не менялся; `live/`/`archive` не читались/не правились.

---

## 8. REDIS — **PASS** (только чтение; ничего не удалялось/не менялось)

Снимок (команды: `redis-cli dbsize/llen/type/ttl/--scan/info memory`):

| Ключ | Тип | Длина | TTL | Наблюдение |
|---|---|---|---|---|
| `animastor:queue:image` | list | **8** | -1 | job-и от **11–12.07.2026** (ComfyUI payload) |
| `animastor:queue:image:ws:3317e019-…` | list | **252** | -1 | workspace-очередь (WS-lane) |
| `animastor:event-journal:*` (10 ключей) | list | 9 740 … 515 139 | -1 | плюс `_system:_recovery:_cycle` (249 934, **пишется сегодня**) |
| Итого | — | `dbsize=321` | — | `used_memory=475.42M`, `maxmemory=0` (без лимита) |

Классификация (подтверждение этапа 26): очереди — пересоздать нельзя, влияют на
незавершённые задачи (при запуске worker старые job-и будут извлечены); журнал —
append-only диагностика + читается recovery/reconciliation → влияет на
восстановление. Заявленный в коде 7-дневный TTL фактически не применяется.

**Предлагаемая (НЕ выполненная) безопасная процедура проверки/очистки:**
1. Проверка (read-only): `redis-cli llen <key>`, `ttl`, `lindex <key> 0`,
   `--scan --pattern 'animastor:event-journal:*'`, `info memory`;
   сверка с PG: `select count(*) from generation_tasks where status='active'` (=0).
2. Страховка: свежий `redis-cli --rdb /tmp/pre-clean.rdb` ИЛИ ссылка на уже
   существующий `backups/redis-dump-2026-10-12.rdb` (sha256 OK).
3. Очистка **только с письменного разрешения владельца** и только при active=0:
   - очереди: поштучно `rpop`/`lpop` (не FLUSHALL/DEL пакетом), после — повторный `llen`=0;
   - журнал: сначала выгрузка `lrange 0 -1 > file.json` (диагностика), затем
     либо `expire <key> 604800` (включить заявленный 7-дневный TTL и дать
     Redis вычистить естественно — рекомендуется), либо `del` старых ключей
     (кроме `_system:_recovery:_cycle`, который активен).
4. Запрещено на этом этапе и не выполнялось: `flushdb/flushall`, любые `del/rpop`.

---

## 9. ФИНАЛЬНАЛЬНАЯ ПРОВЕРКА — **PASS**

| Пункт | Результат |
|---|---|
| Контейнеры не перезапускались | 7/7: CreatedAt и uptime идентичны preflight (backend Up 41h, gpu-hub Up 3d, proxy Up 5w, pg/redis Up 6w healthy) ✓ |
| Compose mounts не изменились | `docker inspect` backend (4) / proxy (6) / pg+redis (2 тома) / gpu-hub (0) == runbook §0 ✓ |
| Git-состояние сохранено | HEAD 6/6 == этап 26; новые untracked только `?? deploy/` (намеренный); pre-existing untracked overlay+freebuff на месте (sha == baseline) ✓ |
| Контрольные суммы | backups manifest **9/9 OK**; lock L1/L2 == baseline; overlay `eac32cb0…`; freebuff `2134973a…` ✓ |
| Health | `/health`=200, `/gpu/health`=200 ✓ |
| Свободное место | `25401716736` Б ≥ `15000000000` ✓ |
| TLS | SNI-даты без изменений; 301 ×3 живы ✓ |
| Redis | `dbsize=321`, queue 8/252, journal 10 — без изменений ✓ |
| E2-сверка конфигов | diff = только удаление gpu-hub `build:` (желаемо) ✓ |

---

## 10. БЛОКЕРЫ (этап остановлен на них, ничего не выполнено из заблокированного)

1. **G4** — утвердить deploy-layout, включая отклонение §3.4 (абсолютные пути в
   overlay-копии). Без G4 каталог — черновик, `up` запрещён.
2. **`.env`** — создаёт владелец (600) со значениями из mono `.env`; без него
   `compose config` с реальными секретами невозможен (E1/E2 в окне с владельцем).
3. **D4** — решение по исправленному `installer-src` (новий tag/release vs
   перезаливка) + способ/учётка загрузки; публикация не выполнялась.
4. **G6/D5 (root)** — продление `.in` до 19.11 + reload nginx в окне; webroot
   зависит от mono-каталога website (учесть при E6).
5. **D1/G1** — index.html (M2/M3 требуют разрешений: копирование контента, правка mono-файла).
6. Вне этапа: off-host перенос копий (B1), restore-тест (окно), E3 dry-run (с владельцем).

## 11. ТОЧНЫЕ СЛЕДУЮЩИЕ ДЕЙСТВИЯ

1. Владелец: утвердить G4 (в т.ч. абсолютные пути) → владелец создаёт `deploy/.env` (600).
2. В окне с владельцем: E1-проверка `compose config` с реальными секретами → E2-сверка → E3 dry-run (`up --dry-run`, pg/redis должны быть `Running`, без `Recreate`).
3. D4: решить механику замены zip → выполнить публикацию → `sha256` сверка с lock.
4. Root/G6: `certbot renew --dry-run` → renew `.in` → `nginx -t` + reload → SNI/301.
5. D1/G1 → M3 (index.html) и разрешение на M2 (копирование apk/.well-known).
6. Далее по runbook: C-проверки → G3 (repin) → G5 (E2E) → G7 (GO/NO-GO) → H.

## 12. ЧТО НЕ ВЫПОЛНЯЛОСЬ (запреты соблюдены)

Переключение production / смена mounts / `up` и рестарты контейнеров / E2E-dispatch /
`git push`, force, удаление refs / публикация артефактов, правки `artifacts.lock.json`,
DNS/TLS/секретов / удаление данных, Redis-очистка, удаление monorepo, `prune` /
любые действия с неясными последствиями (остановлены и описаны как блокеры).
