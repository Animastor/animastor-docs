# Animastor — Этап 28: CUTOVER READINESS AUDIT

- Дата: 2026-10-12
- Режим: **только аудит (read-only).** Не выполнялось: renew/reload nginx,
  правки файлов/прав/монтирований/конфигурации, публикация артефактов, `git push`,
  очистка Redis, восстановление из бэкапов, production-переключения.
  Единственные запуски контейнеров — одноразовые `docker run --rm` с монтированием
  **read-only** (`nginx:alpine`, уже локальный образ) для проверки доступности
  `/etc/letsencrypt` и webroot изнутри контейнера; права на хосте не менялись,
  приватные ключи не копировались и не читались.
- Источники (прочитаны): `21-production-cutover-runbook.md`,
  `26-git-layout-sync-report.md`, `27-deploy-layout-preparation-report.md`,
  `19-cutover-readiness-plan.md`, `20-owner-decisions.md`,
  `docs/architecture/DOMAIN_MIGRATION_2026-10_IN_TO_ORG.md` (commit `9ae1d7ba`),
  `scripts/enable-admin-https.sh`, renewal-конфиги certbot (644, читаются без root).

---

## 1. TLS — исторический способ продления через Docker

### 1.1 Найденный способ (источник восстановлен)

**Способ подтверждён.** Первичный выпуск/продление сертификатов **2026-10-08**
выполнялось образом **`certbot/certbot`** (официальный Docker-образ), потому что
host-`sudo` под паролем, а контейнер с монтированием `/etc/letsencrypt` пишет
туда напрямую (источник:
`animastor/docs/architecture/DOMAIN_MIGRATION_2026-10_IN_TO_ORG.md`, раздел
«Deployment status (2026-10-08)», commit `9ae1d7ba`):

- `animastor.org` — выпущен (SAN: animastor.org, www, app, admin), до **2027-01-06**;
- `animastor.in` — переиспользован, до **2026-11-19**;
- webroot-пути в renewal-конфигах исправлены на хостовый
  `/home/animastor/animastor/frontends/website`; `certbot renew --dry-run`
  проходил для обоих lineage на тот момент;
- nginx перезагружен через `docker exec animastor-proxy nginx -s reload`
  (тот же reload-механизм зафиксирован в mono-скрипте
  `scripts/enable-admin-https.sh:61`).

### 1.2 Текущая конфигурация (проверено сегодня, read-only)

| Параметр | Значение |
|---|---|
| SNI `animastor.in` | CN=animastor.in, SAN {admin,animastor,app,www}.animastor.in, **notAfter=Nov 19 11:42:10 2026 GMT** (38 дней) |
| SNI `animastor.org` | CN=animastor.org, **notAfter=Jan 6 18:29:48 2027 GMT** |
| renewal `animastor.in.conf` (644) | authenticator=webroot, `webroot_path=/home/animastor/animastor/frontends/website`, webroot_map только `admin.animastor.in`; version=1.21.0 (host-certbot) |
| renewal `animastor.org.conf` (644) | webroot тот же, все 4 SAN в webroot_map; version=5.8.0 (**это версия из Docker-образа 2026-10-08** — прямое следствие исторического способа) |
| `certbot.timer` | **active + enabled**, следующий запуск каждые 12 ч (последний 2026-10-11 21:46) |
| Host certbot | 1.21.0 (`/usr/bin/certbot`), renewal-конфиги читаются только root; `live/`/`archive/` 700 root → **animastor с хоста их не читает** (проверено: `ls /etc/letsencrypt/live/animastor.in/` → Permission denied) |
| ACME webroot | `frontends/website/.well-known/acme-challenge/` существует; в живом nginx location `^~ /.well-known/acme-challenge/` объявлен на **port 80** для обоих семейств (.org и .in) с `root /usr/share/nginx/frontends/website` (проверено в работающем контейнере) |

### 1.3 Проверка доступности из контейнера (read-only) — **PASS**

```sh
docker run --rm -v /etc/letsencrypt:/etc/letsencrypt:ro nginx:alpine \
  sh -c 'ls -la /etc/letsencrypt /etc/letsencrypt/live /etc/letsencrypt/renewal'
```

Результат: `live/`, `archive/`, `renewal/` **полностью читаемы** из контейнера
даже с `:ro` (контейнер root обходит host-DAC на bind-mount; каталоги видны:
`animastor.in`, `animastor.org` + legacy `sureg.dev`, `ai.sureg.dev`;
renewal-конфиги читаются). Приватные ключи **не копировались и не выводились** —
проверялась только доступность каталогов, как и требовалось.

```sh
docker run --rm -v /home/animastor/animastor/frontends/website:/var/www/website:ro nginx:alpine \
  sh -c 'ls -la /var/www/website/.well-known/acme-challenge'
```

Результат: каталог существует и читается из контейнера.

Пользователь `animastor` **не получил** доступ к root-файлам: `/etc/letsencrypt/live`
остаётся 700 root на хосте; доступ существовал только внутри одноразового
контейнера и был read-only.

### 1.4 Безопасное применение к `animastor.in` — анализ

**Метод применим, с условиями:**

1. **Образ `certbot/certbot` сейчас не скачан** (в `docker images` его нет) —
   первый запуск потребует pull (~30–50 МБ, диск свободен: 25,4 ГБ ≥ 15 ГБ).
   Pull — сетевая операция, не production-change; фиксируется как prerequisite.
2. **Путь webroot в контейнере должен совпадать** с `webroot_path` из renewal-конфига
   (`/home/animastor/animastor/frontends/website`) — монтировать webroot нужно **под тем же
   абсолютным путём**, что и на хосте, иначе certbot не найдёт точку записи challenge.
   (Исторически при выпуске `.org` путь в конфиге оказался `/var/www/website` и его
   потом чинили; при renew из контейнера лучше сразу смонтировать под путём конфига.)
3. **`/etc/letsencrypt` для renew нужен rw** (запись новых сертификатов в
   `archive/`/`live/`/`renewal/`) — контейнер пишет как root, права новых файлов
   будут root, как и сейчас; **существующие права не меняются**.
4. **ACME HTTP-01 проверяет port 80** — location `/.well-known/acme-challenge/`
   объявлен в обоих server-блоках `.in` (port 80) и работает; reload nginx
   **не нужен** для самой проверки (файл отдаётся без перезагрузки).
5. **reload nginx нужен только после успешного продления**, чтобы прочитать новый
   сертификат (`docker exec animastor-proxy nginx -s reload`) — запрещён в этом
   этапе; отдельное действие в окне с владельцем.
6. **`certbot.timer` активен** — systemd-юнит будет пытаться продлевать **сам** как root
   дважды в день, начиная с окна <30 дней до истечения (≈ с 2026-10-20 для `.in`).
   Это параллельный путь: если timer успешен, ручной Docker-запуск не обязателен;
   если timer будет падать (например, webroot после переезда mount — см. §1.5),
   Docker-способ остаётся ручным fallback без host-sudo.

### 1.5 Риск после cutover (E6) — webroot переезжает

Renewal-конфиги ссылаются на **mono-путь** `frontends/website`. При переключении
website-mount на `animastor-web` (E6) ACME-файлы будут писаться в mono-каталог,
а nginx отдавать web-каталог → **challenge перестанет отдаваться → продление сломается**.
Mitigation (в runbook уже зафиксирован, D10): до/после E6 скопировать
`.well-known/` в web-репо (шаг **M2**) **и** обновить `webroot_path` в обоих
renewal-конфигах (root-действие, G6) — либо продлить `.in` **до** cutover с запасом.

### 1.6 Подготовленные команды (НЕ выполнялись)

**Проверка (dry-run, без сохранения сертификатов, ничего не пишет в `/etc/letsencrypt`):**

```sh
# 0) одноразовая проверка доступности (уже выполнена в §1.3, :ro)
# 1) pull образа (prerequisite; ~30–50 МБ)
docker pull certbot/certbot
# 2) dry-run renew ОБОИХ lineage (webroot монтируется под путём из конфига!)
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /home/animastor/animastor/frontends/website:/home/animastor/animastor/frontends/website \
  certbot/certbot renew --dry-run --non-interactive
```

**Условие успеха dry-run:** вывод `congratulations, all simulated renewals succeeded`
(или аналог), **exit 0**; в `/etc/letsencrypt` ничего не изменилось
(`stat`/`sha256sum` renewal-конфигов до/после идентичны).

**Продление (только с разрешением G6, отдельное окно):**

```sh
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /home/animastor/animastor/frontends/website:/home/animastor/animastor/frontends/website \
  certbot/certbot renew --non-interactive
# reload nginx (отдельное разрешение, в окне):
docker exec animastor-proxy nginx -s reload
```

**Перечитывание сертификата после продления (read-only, можно сразу):**

```sh
echo | openssl s_client -connect 127.0.0.1:443 -servername animastor.in 2>/dev/null \
  | openssl x509 -noout -subject -dates -ext subjectAltName
# условие: notAfter > текущая дата + 60 дней; SAN = 4 имени .in
# + контроль: curl -s -o /dev/null -w '%{http_code}\n' --resolve animastor.in:443:127.0.0.1 https://animastor.in/  == 301
```

**Итог §2:** способ восстановлен и пригоден; блокер только в отсутствии разрешения
на сам renew/reload (G6/D5) и отсутствии скачанного образа (prerequisite pull).

---

## 2. D1 / G1 — сайт (index.html)

### 2.1 Сравнение трёх источников

| Источник | Путь | sha256 | Ссылки GitHub |
|---|---|---|---|
| mono (сейчас отдаётся в prod) | `/home/animastor/animastor/frontends/website/index.html` | `276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c` | `github.com/Animastor/animastor` → **404**; `…/tree/master/docs` → **404** (4 ссылки: строки 143, 150, 176, 177) |
| web-репо (эталон D1) | `/home/animastor/animastor-web/frontends/website/index.html` | `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c` | `github.com/Animastor/animastor-web` → **200**; `…/tree/main/docs` → **200** |
| deploy-план M3 (этап 27) | источник = web `a1900f4e…` → назначение = mono | — | — |

Живой сайт отдаёт **mono-версию** (`curl https://animastor.org/ | sha256sum` == `276a5fc4…`).
Diff mono↔web = **ровно 4 строки** (подтверждено повторно сегодня): все 4 — ссылки
на GitHub (карточка «GitHub repository», карточка «Docs folder», футер «GitHub»,
футер «Docs»); больше различий нет (canonical/og:url/кнопки/support e-mail идентичны).

### 2.2 Проверка ссылок (сегодня, live)

| URL | Статус |
|---|---|
| `https://github.com/Animastor/animastor-web` | **200** |
| `https://github.com/Animastor/animastor-web/tree/main/docs` | **200** |
| `https://github.com/Animastor/animastor` | **404** |
| `https://github.com/Animastor/animastor/tree/master/docs` | **404** |
| `https://animastor.org/downloads/animastor-android-latest.apk` | 200 |
| `https://animastor.org/downloads/version.json` | 200 |
| `https://animastor.org/library` | 200 |
| `https://animastor.org/admin` | 404 (ожидаемо: admin-роут на app-поддомене) |

### 2.3 Необходимые исправления и источники истины

| # | Что | Источник истины | Назначение | Когда |
|---|---|---|---|---|
| 1 | Заменить ровно 4 строки в mono `index.html` | **web-репо** `frontends/website/index.html` (`a1900f4e…`) | mono `frontends/website/index.html` | окно B2 (после **G1**); откат = `git -C animastor checkout -- frontends/website/index.html` |
| 2 | Скопировать `downloads/animastor-android-latest.apk` (`0b7a1333…`, 12 505 721 Б) и `.well-known/` в web-репо | mono (runtime-файлы, вне git) | `animastor-web/frontends/website/…` | шаг M2/E6 (нужно разрешение на копирование); без этого нельзя переключать website-mount |

Исправления **не выполнялись** (требуется G1 + разрешение на live-правку).

---

## 3. G4 — deploy layout (проверка созданного `animastor-backend/deploy/`)

### 3.1 Состояние каталога — **PASS** (структура цела, секретов нет)

```
/home/animastor/animastor-backend/deploy/          (755, animastor)
  docker-compose.yml                6513 Б  sha256 264550e99d8846ee4551588753e969cfc93b5dbd02c3cd955a3fe53c373cfa74
  overlay-backend-standalone.yml    2171 Б  sha256 9f13d8887039257f8f029bf2d75ebeb523c7cc7d46000647402e5c48ebf631a6
  README.md                         2525 Б  sha256 257d086f5e78fe25d8e50ab92d4065bd28c6b0db481ab7992ad6b4dc270fde88
  .env                              ОТСУТСТВУЕТ (создаёт владелец, chmod 600)
```

### 3.2 Почему overlay/compose используют абсолютные пути и какие риски

**Причина:** относительные `./data/output`, `./backend/ai` и т.п. в compose
разрешаются относительно каталога, где лежит compose-файл. Из `deploy/`
относительный путь создал бы **новые пустые точки монтирования** (`deploy/data/output`
и пр.) — контейнеры стартовали бы с пустым /data и без AI-кодов, «тихо» потеряв
пользовательские данные. Поэтому все bind-mount источники переведены на абсолютные
`/home/animastor/animastor/...` — **те же каталоги, что смонтированы в production
сейчас** (монты не меняются; проверено в этапе 27: mount-источники == `docker inspect`).

**Риски при переносе:**

| Риск | Следствие | Mitigation |
|---|---|---|
| deploy-каталог переносят на другой хост/путь | абсолютные пути не существуют → пустые монты / падение | перед переносом на новый хост перевести пути на новый layout (правка compose в deploy/) |
| после E6 website должен браться из web-репо | deploy-compose всё ещё указывает на mono `frontends/website` | в окне H правка deploy-compose: website-источник → `animastor-web/frontends/website` (M2 уже скопирует runtime-файлы) |
| двойной источник правды (mono compose vs deploy) | расхождение конфигов со временем | deploy — единственная точка старта после H; mono- compose остаётся только для отката H-R |
| `build: ./backend` остался в базовой секции | при отсутствии overlay переключение попытается собрать образ | всегда ОБА `-f` (задокументировано в deploy/README и шапке compose); overlay сбрасывает `build: !reset null` |

### 3.3 Итоговая рекомендуемая структура M1–M5 (из этапа 27, подтверждена)

| Шаг | Источник → назначение | Зависимости | Откат |
|---|---|---|---|
| M1 | mono compose + overlay + backend repo compose → `animastor-backend/deploy/` *(создано)*; `.env` — владелец (600) | **G4** | не использовать каталог |
| M2 | `mono/frontends/website/{downloads/*,.well-known/}` → `animastor-web/frontends/website/…` | решение D1 + разрешение на копирование | монты остаются на mono |
| M3 | web `index.html` (`a1900f4e…`) → mono (заменить 4 строки) | **G1** | `git checkout -- frontends/website/index.html` |
| M4 | stop backend+nginx из mono → `up -d` из deploy/ (`--project-name animastor`) | **G7**, M1, диск ≥ 15 ГБ | H-R: up --force-recreate из mono |
| M5 | новый `GPU_HUB_IMAGE` → **только** `deploy/.env` | **G2/G3** | прод `.env` прежний |

### 3.4 Защита `.env` и сохранность данных — **PASS**

- `deploy/.env` **не существует** (никаких секретов в deploy/ нет; grep по
  deploy-файлам — только ссылки на `${VAR}`).
- Прод `.env` = `/home/animastor/animastor/.env`, **600 animastor:animastor**, 2112 Б —
  не читался и не менялся.
- Пользовательские данные целы: `data/output` 63 203 425 Б, `data/books` 1 704 047 Б
  (совпадают с этапом 27); deploy-compose указывает на **те же** абсолютные каталоги.
- Mono untracked overlay `eac32cb0…` не тронут; backend untracked freebuff-отчёт не тронут.

**Статус G4: BLOCKED** — технически готово и проверено, ждёт утверждения владельца
(включая одобрение отклонения: overlay-копия с абсолютными путями).

---

## 4. D4 — ZIP-артефакты (механизм и SHA-256)

### 4.1 Механизм — подтверждён (read-only сверка через GitHub API)

Публикация = ручная загрузка ассетов на **уже существующие immutable GitHub
Release**; автоматических загрузчиков в mono/packages — 0. Сверка сегодня
(публичный API, без токена): **digest GitHub == sha256_asset в lock — 4/4**:

| Release (repo) | Ассет | Размер | digest GitHub API | `sha256_asset` в L1-lock |
|---|---|---|---|---|
| `Animastor/animastor-backend` `hub-artifacts-v1` | `hub-workflows-v1.zip` | 18 228 | `c484e197…8b3e04` | `c484e197…8b3e04` ✓ |
| то же | `installer-src-v1.zip` | 165 334 | `ae589c10…c7ece` | `ae589c10…c7ece` ✓ |
| то же | `install-manifests-v1.zip` | 16 803 | `1fd9f8ad…383f9` | `1fd9f8ad…383f9` ✓ |
| `Animastor/animastor-worker` `worker-bundle-v2.1.1` | `animastor-worker-bundle-2.1.1.zip` | 20 073 | `4cb6f133…afdae` | `4cb6f133…afdae` ✓ |

Lock-файлы не менялись: L1 `069b62d931c1ff0e…`, L2 `2a221e3ba626326c…` ✓.

### 4.2 Что требует решения о замене и что сломается

| Артефакт | Проблема | Что сломается, если оставить |
|---|---|---|
| **`installer-src-v1.zip`** (единственный!) | внутри `packages/animastor-installer/src/installer/setup-contract.js:695` — инструкция `git clone https://github.com/Animastor/animastor.git` → **404** (моно не опубликован на GitHub). Backend-репо `@a7a8c463` уже содержит исправление (`…/animastor-worker.git`) — фикс есть в репо, но **не в опубликованном активе** | standalone-установщик, скачавший актив с релиза, получает инструкцию с 404-клоном → установка воркера падает |
| `hub-workflows-v1.zip`, `install-manifests-v1.zip` | соответствуют пинам, расхождений нет | ничего (оставить как есть) |
| `animastor-worker-bundle-2.1.1.zip` | тело = `.org`-контент; hub-пин (`480af146…`) отдаёт **tar.gz** `.in`-контента — два разных «2.1.1» (зафиксировано в 20 §2) | юзабельно, но запутывает; замена — только по явному решению |

**Решение D4 (за владельцем):** новый tag/release с исправленным `installer-src`
(рекомендуется: immutable-релизы не перезаписываются) либо перезаливка с
архивацией старого актива. Ничего не загружалось.

---

## 5. Резервные копии и restore-тест

### 5.1 Проверка локальных копий — **PASS**

`sha256sum -c backup-manifest-2026-10-12.sha256` → **9/9 OK** (повторено сегодня):

| Артефакт | Размер |
|---|---|
| `cutover-pg-2026-10-12.dump` | 441 269 |
| `cutover-pg-schema-2026-10-12.sql` | 68 263 |
| `cutover-data-2026-10-12.tgz` | 61 786 941 |
| `cutover-config-2026-10-12.tgz` | 8 067 (600 — секреты) |
| `git_repos_2026-10-12_06-00-27.tar.gz` | 51 801 578 |
| `git-worktrees-2026-10-12_06-00-43.tar.gz` | 87 343 374 |
| `git-untracked-2026-10-12_06-17-10.tar.gz` | 236 390 |
| `git-refs-status-2026-10-12.txt` | 1 450 |
| `redis-dump-2026-10-12.rdb` | 58 372 973 (600) |

### 5.2 Минимальный план restore-теста (НЕ запускать без отдельного разрешения)

Принцип: **изолированные временные ресурсы**, никакого контакта с рабочими
PostgreSQL/Redis/данными; порты со смещением; `--rm`; volume с префиксом `restore-test`.

| # | Что | Как (изоляция) | Критерий успеха |
|---|---|---|---|
| R1 | pg_dump | поднять **временный** postgres:16 (`--name restore-test-pg`, отдельный named volume `restore-test-pgdata`, порт не публиковать), создать БД, `pg_restore --exit-on-error` из dump, затем `SELECT count(*)` по ключевым таблицам + сравнить со `SELECT count(*)` в рабочем `animastor-pg` (read-only docker exec) | restore exit 0; count-ы совпадают; рабочий pg не тронут (uptime/health прежние) |
| R2 | data/ | `tar -tzf cutover-data-…tgz` (инвентаризация без распаковки) + распаковка **во временный каталог** `/tmp/restore-test-data/` (или в отдельную папку backups) и `diff -r` выборки против рабочего `data/` | список файлов идентичен; sha256 выборки совпадает; рабочий `data/` не писался |
| R3 | Redis | поднять **временный** redis:7 с `--dir` на копию RDB во временном каталоге (`--save ''`), `dbsize`/`--scan` префиксов | `dbsize=321` (baseline), префиксы `animastor:*`/`trigger_cooldown` читаются; рабочий redis не тронут |
| R4 | config | `tar -tzf cutover-config-…tgz` + распаковка во временный каталог, сверка `sha256` compose/overlay против текущих; **содержимое `.env` не печатать** | пути архива == ожидаемые; sha compose совпадает с текущими (конфиг не менялся) |
| R5 | git | распаковка `git_repos_…tar.gz` во временный каталог → `git fsck` в каждом bare; сверка HEAD с `git-refs-status` | fsck exit 0; HEAD совпадают |

Пререквизит: отдельное разрешение (любая распаковка/pg_restore — хоть и во
временные ресурсы, это подготовка к восстановлению), ≈200 МБ свободного места
(диск: 25,4 ГБ — достаточно). Restore **не выполнялся**.

---

## 6. STD-CHECK (выполнен в конце этапа)

| Проверка | Значение | Статус |
|---|---|---|
| df -B1 свободно | `25 399 521 280` ≥ 15 000 000 000 | ✓ |
| L1/L2 lock sha256 | `069b62d9…` / `2a221e3b…` (неизменны) | ✓ |
| Контейнеры | 7, uptime без изменений (backend 42h, gpu-hub 3d, proxy 5w, pg/redis 6w healthy) | ✓ |
| health / gpu/health | 200 / 200 | ✓ |
| git baseline | mono `?? overlay`, backend `?? deploy/ ?? freebuff-chat…` (deploy/ — новый, ожидаемый от этапа 27), web/worker/gpu-hub чисто; HEAD: mono `465453df`, web `fbc93662`, backend `a7a8c463`, worker `b3f94f42`, gpu-hub `ecefd0b7` | ✓ |
| G8 bare↔wt↔github | worker/web/android/backend: bare refs == worktree == `github/main` (4/4) | ✓ |
| Redis | `dbsize=321`; `animastor:queue:image`=8; `…:ws:3317e019`=252; `event-journal:*`=10; `used_memory=498.52M` (этап 27: 475.42M — естественный рост journal, TTL=-1; ключи не удалялись) | ✓ |
| TLS | SNI `.in` Nov 19 / `.org` Jan 6; 301×3 живы; certbot.timer active; ничего не менялось | ✓ |
| Backups | манифест 9/9 OK | ✓ |

---

## 7. ФИНАЛЬНАЯ ТАБЛИЦА G1–G8 и D1–D5

| Гейт | Статус | Что осталось | Доступ | Последствия отказа/бездействия |
|---|---|---|---|---|
| **G1** (утвердить 4 URL index.html) | **BLOCKED** | владелец подтверждает замену 4 строк на web-вариант (`a1900f4e…`); затем окно B2 | владелец (решение) + write в mono (окошко) | 4 битые ссылки на GitHub остаются на живом сайте |
| **G2** (подтвердить цели repin: worker `b3f94f42…`, backend `a7a8c463…`) | **NOT TESTED** | подтверждение состава целей после C-проверок provenance | владелец | без цели нельзя согласовать repin |
| **G3** (разрешение push/CI/publish) | **NOT TESTED** | разрешение на `git push` + `workflow_dispatch` + загрузку релизных активов | владелец; GitHub-токен | исправленный installer-src не доедет до пользователей; CI-образ не обновится |
| **G4** (утвердить deploy-layout) | **BLOCKED** | утвердить каталог `deploy/` и отклонение overlay (абсолютные пути) | владелец (решение) | фаза E/H не стартует; cutover-каталог не утверждён |
| **G5** (окно E2E) | **NOT TESTED** | согласованное окно + `E2E_WORKSPACE_ID` + запущенный worker; P1–P9 | владелец; окно | E2E-диспетчеризация не проверена |
| **G6** (root: TLS renew/reload) | **BLOCKED** | pull образа `certbot/certbot` + dry-run (§1.6) + при успехе renew + `nginx -s reload`; при необходимости — правка `webroot_path` после E6 | root/владелец (docker-группа уже есть у animastor; host-sudo не обязателен — способ исторически подтверждён) | `.in` истекает **2026-11-19** (38 дн.); timer может продлить сам ≈ с 20.10, но после переезда webroot (E6) сломается без правки конфига |
| **G7** (GO/NO-GO cutover) | **NOT TESTED** | чек-лист §7 runbook; все предыдущие гейты | владелец; окно | переключение не выполняется |
| **G8** (bare-sync) | **PASS** (этап 26, re-check сегодня) | — | — | — |

| Решение | Статус | Что осталось | Доступ | Последствия |
|---|---|---|---|---|
| **D1** (index.html = web-вариант) | **PASS** (решение принято; diff и ссылки проверены) | исполнение M3 (4 строки) + разрешение на M2 (apk/.well-known) | write mono/web в окне | сайт продолжает отдавать 4×404 |
| **D2** (цели repin подтверждены) | **NOT TESTED** | подтверждение после provenance-сверок (C-фаза) | владелец | repin не согласован |
| **D3** (pg/redis compose-refs — исторические метаданные, без recreate) | **PASS** (зафиксировано; recreate не требуется) | — | — | — |
| **D4** (republish zip) | **BLOCKED** | решить: новый tag/release с исправленным `installer-src` (404-клон в инструкции) vs перезаливка с архивацией; сама публикация — только с G3 | владелец; GitHub-токен | standalone-установщик падает на 404-клоне моно |
| **D5** (TLS root-продление `.in`) | **BLOCKED** | = G6: dry-run → renew → reload (§1.6); deadline 19.11.2026 | root/docker (G6) | потеря валидного сертификата `.in` → 301-редиректы и HTTPS legacy-доменов сломаются |

---

## 8. Что НЕ выполнялось (запреты соблюдены)

- renew/reload nginx, `docker pull certbot/certbot`, правки `/etc/letsencrypt`, прав,
  монтирований, конфигурации — **нет** (только `:ro`-проверки через одноразовые контейнеры).
- Публикация/замена релизных активов, правки `artifacts.lock.json` — **нет**.
- `git push`, prune, E2E-диспетчеризация, очистка Redis, удаление данных/monorepo — **нет**.
- Правки index.html, копирование apk/.well-known — **нет**.
- Restore-тест — **нет** (только план §5.2).
- Прод `.env` не читался; приватные ключи не копировались и не выводились.

## 9. Следующие действия (по приоритету)

1. **G6/D5**: pull `certbot/certbot` → `renew --dry-run` (§1.6) → при успехе
   renew + reload в согласованном окне; **deadline `.in`: 19.11.2026** (timer
   попробует сам ≈ 20.10 — проверить после первого авто-запуска в окне <30 дней).
2. **G1/D1**: утвердить 4 URL → M3 (замена 4 строк) + разрешить M2 (apk/.well-known в web).
3. **G4**: утвердить deploy-layout (абсолютные пути — осознанное отклонение).
4. **D4**: решить механизм замены `installer-src` (рекомендую новый tag/release).
5. **G2/G3**: provenance → repin → CI.
6. Restore-тест (§5.2) по отдельному разрешению.
7. Затем G5 → G7 → H (cutover) → I → J.
