# Animastor — Этап 30: M3 CUTOVER PREPARATION

- Дата: 2026-10-12
- Режим: **только проверка (read-only) и подготовка плана.** Не выполнялось:
  переключение/замена файлов production, копирование в production, правки Compose
  или Nginx, рестарты контейнеров, изменения DNS/TLS, публикация артефактов,
  `git commit`/`git push`, удаление файлов/данных. Единственные сетевые запросы —
  read-only `curl` (health, статические файлы, внешние GitHub-URL).
- Источники (прочитаны): `29-website-links-repair-report.md`,
  `28-cutover-readiness-audit.md`, `27-deploy-layout-preparation-report.md`,
  `/home/animastor/reorg-2026-10-11/21-production-cutover-runbook.md` (§0, фазы B/E/H, §5.x, §7).
- Итог: **PASS** — неожиданных расхождений не обнаружено; M3 подготовлен,
  **не выполнен**. Блокер до исполнения: **G1** (письменное утверждение владельца
  4 URL) + согласованное окно.

---

## 0. Краткий вывод

Все фактические значения совпали с отчётами 27/28/29 и runbook 21:
nginx обслуживает сайт из mono-каталога, production-версия = `276a5fc4…`
(4 битые ссылки), каноническая web-версия на `fbc93662` = `a1900f4e…`
(4/4 → 200, подтверждено сегодня), полный diff каталогов = ровно 3 позиции
(index.html + 2 runtime-файла вне git). Минимальный набор M3 — **1 файл**.
Атомарное переключение доступно (rename в одном FS, nginx без `open_file_cache`).
Откат — одна git-команда, восстанавливающая байт-в-байт `276a5fc4…`.

---

## 1. Реальная конфигурация: откуда nginx обслуживает сайт

### 1.1 Mount-пути живого контейнера (`docker inspect animastor-proxy`)

| Источник (хост) | Контейнер | RW |
|---|---|---|
| `/home/animastor/animastor/frontends/website` | `/usr/share/nginx/frontends/website` | **false (ro)** |
| `/home/animastor/animastor/frontends/app` | `/usr/share/nginx/frontends/app` | false |
| `/home/animastor/animastor/docs` | `/usr/share/nginx/docs` | false |
| `/home/animastor/animastor/proxy/conf/default.conf` | `/etc/nginx/conf.d/default.conf` | false |
| `/home/animastor/animastor/proxy/conf/.htpasswd` | `/etc/nginx/.htpasswd` | false |
| `/etc/letsencrypt` | `/etc/letsencrypt` | false |

Compose (`/home/animastor/animastor/docker-compose.yml:146–153`) объявляет те же
пути относительно каталога compose (`./frontends/website…`) → разрешаются в
перечисленные абсолютные; **mount-источники совпадают с `docker inspect`** ✓.
Deploy-compose (`animastor-backend/deploy/docker-compose.yml:144`) тоже указывает
на **mono**-каталог website (не меняется M3).

### 1.2 Server-блоки и root (из работающего контейнера)

| Блок | server_name | root | Что отдаёт index.html |
|---|---|---|---|
| :80 | animastor.org www/app/admin.animastor.org | `/usr/share/nginx/frontends/website` (ACME) + redirect | только ACME, `/` → 301 |
| :80 | animastor.in семейство | то же (ACME) | `/` → 301 |
| :443 | animastor.org, www | `/usr/share/nginx/frontends/website` | **да — живой сайт** |
| :443 | app / admin | `/usr/share/nginx/frontends/app/dist` | нет |
| :443 | animastor.in семейство | `/usr/share/nginx/frontends/website` (ACME) | `/` → 301 |

В `default.conf` (sha256 `99f706aff608744949f50e6ead87e6f3bd55087f13723d4bb2c24b0912e36505`)
**нет** `open_file_cache`, `proxy_cache`, `expires` для HTML → nginx читает файл
на каждый запрос; замена файла применяется **без reload** контейнера.

### 1.3 Другие потребители каталога website

- **certbot**: `webroot_path=/home/animastor/animastor/frontends/website`
  (оба renewal-конфига) → пишет только в `.well-known/acme-challenge/`.
  M3 этот каталог не трогает → ACME не затрагивается.
- **backend/gpu-hub/pg/redis**: монтов website **не имеют** (backend — 4 монта
  data/ai/tests; gpu-hub — 0; pg/redis — только named volumes) ✓.

---

## 2. Сравнение production с канонической версией web-репо @ `fbc93662`

### 2.1 Git-состояние (зафиксировано сегодня, до любых изменений)

| Репо | HEAD | worktree |
|---|---|---|
| mono `/home/animastor/animastor` | `465453df673016a4f3884b7ae25cddeebb052551` | `?? docker/compose/overlay-backend-standalone.yml` (baseline) |
| web `/home/animastor/animastor-web` | **`fbc93662035df84c8e103df0d0706800aa96cba1`** | **чисто** |
| backend | `a7a8c463…` | `?? deploy/ ?? freebuff-chat-…` (baseline) |
| worker / gpu-hub / android | `b3f94f42…` / `ecefd0b7…` / `92a56c0d…` | чисто |

HEAD web == целевой SHA `fbc93662` ✓; worktree чист ✓ → рабочие файлы
web-репо байт-идентичны каноническому дереву.

### 2.2 index.html — три источника

| Источник | Путь | sha256 | размер | GitHub-ссылки |
|---|---|---|---|---|
| **живой prod** (curl) | `https://animastor.org/` | `276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c` | — | 404 ×2 семейства |
| **mono (на диске)** | `/home/animastor/animastor/frontends/website/index.html` | `276a5fc4…` (то же) | 8 998 Б | 404 |
| **web @ fbc93662** | `/home/animastor/animastor-web/frontends/website/index.html` | `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c` | 9 010 Б | 200 |

- Живое тело == mono-файлу == блою `HEAD:frontends/website/index.html` mono
  (`git show HEAD:… | sha256sum` → `276a5fc4…`) → **откат git-командой
  восстанавливает ровно то, что отдаётся сейчас** ✓.
- `git status -- frontends/website/index.html` в mono пуст → файл не изменён
  локально, откат корректен ✓.

### 2.3 Diff mono ↔ web: ровно 4 строки (8 строк diff)

| Строка | mono / prod (404) | web @ fbc93662 (200) | Проверено сегодня |
|---|---|---|---|
| 143 | `…/github.com/Animastor/animastor` | `…/github.com/Animastor/animastor-web` | **200** |
| 150 | `…/animastor/tree/master/docs` | `…/animastor-web/tree/main/docs` | **200** |
| 176 | `…/github.com/Animastor/animastor` | `…/github.com/Animastor/animastor-web` | **200** |
| 177 | `…/animastor/tree/master/docs` | `…/animastor-web/tree/main/docs` | **200** |

Обратная проверка (сегодня): `github.com/Animastor/animastor` → **404**,
`…/tree/master/docs` → **404**; `…/animastor-web` и `…/tree/main/docs` → **200**.
Исправление присутствует **именно в блое на SHA `fbc93662`**
(`git show fbc93662:frontends/website/index.html | sha256sum` == `a1900f4e…`,
grep по блоку показывает 4 строки `animastor-web`) ✓. Ссылок `animastor.in` — 0
в обеих версиях; canonical/og:url/support e-mail идентичны.

### 2.4 Полный diff каталогов `mono/frontends/website` ↔ `web/frontends/website`

`diff -rq` → ровно **3** позиции:

| # | Позиция | Статус | Влияние на M3 |
|---|---|---|---|
| 1 | `index.html` | различается (4 строки) | **это и есть M3** |
| 2 | `downloads/animastor-android-latest.apk` (12 505 721 Б, sha `0b7a1333…`) | только в mono (`.gitignore:109`) | M3 не трогает; нужен M2/E6 только при смене монта |
| 3 | `.well-known/acme-challenge/` (каталог, файлов нет) | только в mono | M3 не трогает; ACME webroot остаётся в mono |

Всё остальное **байт-идентично**, включая `downloads/version.json`
(sha256 `8dbbfe10…` в обоих), `library/index.html`, `styles.css`, `site.js`,
`logo.png`, фавиконы, `apple-touch-icon.png`.

### 2.5 Зависимости от файлов, отсутствующих в web-репо — найдены (не блокируют M3)

| Файл/каталог | Есть в mono (prod) | Есть в web-репо | Кто зависит | Когда станет проблемой |
|---|---|---|---|---|
| `downloads/animastor-android-latest.apk` | ✓ (200) | **нет** | ссылка `href="/downloads/…apk"` в index.html | только при переключении website-монта (E6); **M3 не затрагивает** (монт остаётся на mono) |
| `.well-known/acme-challenge/` | ✓ | **нет** | certbot ACME webroot (оба домена) | при смене монта без M2 + правки `webroot_path` (G6) |
| `frontends/app/dist`, `docs/`, `proxy/conf/` | ✓ | вне веб-каталога (отдельные монты) | app/admin/docs, nginx conf | вне скоупа M3 |

**Вывод:** M3 (замена одного `index.html` в mono) **не зависит ни от одного
файла, отсутствующего в web-репо** — все ссылки целевого index.html разрешаются
в mono-каталоге (проверено `test -e` для 9 локальных ресурсов: 9/9 OK).

**Статус целевой версии:** содержательно безопасна для M3 (diff закрыт, ссылки
200, локальные ресурсы на месте). Полная безопасность web-каталога как
**единственного** источника (для E6/смены монта) — **НЕ подтверждена**: apk и
`.well-known` отсутствуют (требуется M2). Это зафиксировано и не является
блокером M3.

---

## 3. План M3

### 3.1 Точные пути

| Роль | Путь | Значение |
|---|---|---|
| **Источник** | `/home/animastor/animastor-web/frontends/website/index.html` | sha256 `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c`, 9 010 Б, SHA репо `fbc93662` |
| **Назначение** | `/home/animastor/animastor/frontends/website/index.html` | sha256 `276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c`, 8 998 Б, mode 664, animastor:animastor |
| Временный файл (атомарная смена) | `/home/animastor/animastor/frontends/website/.index.html.m3tmp` | тот же filesystem, тот же владелец/права |

**Минимальный набор файлов для переноса: 1 файл** (`index.html`).
Ничего больше не копируется (apk/.well-known = M2, отдельное разрешение).

### 3.2 Предварительные проверки (PRE — read-only, выполнить в окне)

| # | Проверка | Ожидание | Сейчас (baseline) |
|---|---|---|---|
| P1 | `df -B1 /` | ≥ `15000000000` | `35031687168` ✓ |
| P2 | `git -C mono rev-parse HEAD` + `status --porcelain -- frontends/website/index.html` | HEAD `465453df…`; по файлу пусто | ✓ (как baseline) |
| P3 | `git -C web rev-parse HEAD` + `status --porcelain` | `fbc93662…`; чисто | ✓ |
| P4 | `sha256sum` обоих файлов | mono `276a5fc4…`, web `a1900f4e…` | ✓ |
| P5 | `diff mono web \| grep -c '^[<>]'` | ровно **8** (4 пары) | ✓ |
| P6 | `curl https://animastor.org/ \| sha256sum` | `276a5fc4…` (т.е. ничего не изменилось сbaseline) | ✓ |
| P7 | 4 URL: `curl -sIL -w'%{http_code}'` | web-варианты **200**, mono-варианты 404 | ✓ (сегодня) |
| P8 | `/health`, `/gpu/health` | 200 / 200 | ✓ |
| P9 | `docker ps` CreatedAt/uptime | без изменений (см. §6) | ✓ |
| P10 | `sha256sum -c backups/backup-manifest-2026-10-12.sha256` | 9/9 OK | ✓ |
| P11 | **G1** — письменное утверждение владельца 4 URL | получено | **BLOCKED** |
| P12 | локальные ресурсы web-index в mono: `test -e` ×9 | 9/9 | ✓ |

**ABORT PRE:** любой пункт ≠ ожиданию; P5 ≠ 8 (файл изменился → переаудит);
P6 ≠ `276a5fc4…` (prod уже менялся → стоп, разбор); P11 отсутствует.

### 3.3 Контрольные суммы (до / ожидаемые после)

| Объект | До | После M3 |
|---|---|---|
| mono `frontends/website/index.html` | `276a5fc4…` | **`a1900f4e…`** |
| живое тело `https://animastor.org/` | `276a5fc4…` | **`a1900f4e…`** |
| web-репо (HEAD/worktree) | `fbc93662`, чисто | **без изменений** |
| mono git status по файлу | пусто | ` M frontends/website/index.html` (ожидаемо, uncommitted) |
| `proxy/conf/default.conf` | `99f706af…` | без изменений |
| `overlay-backend-standalone.yml` | `eac32cb0…` | без изменений |
| lock L1 / L2 | `069b62d9…` / `2a221e3b…` | без изменений |

### 3.4 Атомарное переключение (предпочтительный вариант — конфигурация поддерживает)

Условия выполнены: rename в **одной** файловой системе; nginx без
`open_file_cache`; монт ro только внутри контейнера (запись с хоста видна).

```sh
SRC=/home/animastor/animastor-web/frontends/website/index.html
DST=/home/animastor/animastor/frontends/website/index.html
TMP=/home/animastor/animastor/frontends/website/.index.html.m3tmp

# 1) PRE P1–P12 (см. 3.2) — все зелёные
cp -p "$SRC" "$TMP"                       # копия в тот же каталог (same FS)
chmod 664 "$TMP" && chown animastor:animastor "$TMP"   # == правам DST (664)
sha256sum "$TMP"                          # обязано == a1900f4e…  (иначе ABORT, rm TMP)
mv -f "$TMP" "$DST"                       # атомарный rename; окно ≈ 0
# 2) POST (3.5) немедленно
```

Почему `mv`, а не `cp >`: `cp`/`cat >` усекают существующий inode (окно, в
которое nginx может отдать усечённую страницу); `mv` меняет inode атомарно.

**Запрещено в окне M3:** reload/restart nginx, правки compose/conf, `git commit`.

### 3.5 Проверки после переключения (POST)

| # | Проверка | Критерий успеха |
|---|---|---|
| C1 | `sha256sum $DST` | `a1900f4e…` |
| C2 | `curl -sSk https://animastor.org/ \| sha256sum` | `a1900f4e…` |
| C3 | 4 GitHub-ссылки живой страницы (`curl -sIL`) | **4/4 → 200** |
| C4 | локальные ресурсы: `/styles.css /site.js /logo.png /favicon-16.png /favicon-32.png /apple-touch-icon.png /library/ /downloads/version.json` | 8/8 → 200 |
| C5 | `/downloads/animastor-android-latest.apk` | 200 (ссылка из новой страницы не сломана) |
| C6 | `/.well-known/acme-challenge/` | 403 (как до; не 404/500) |
| C7 | `/health`, `/gpu/health` | 200 / 200 |
| C8 | 301 ×3 (`http(s)://animastor[.in]/`, `http://www.animastor.in/`) | 301 → `https://animastor.org/` |
| C9 | `docker exec animastor-proxy nginx -t` | `syntax is ok` (read-only, без reload) |
| C10 | `docker ps` | CreatedAt/uptime без изменений (см. §6) |
| C11 | `git -C mono status --porcelain -- frontends/website` | ровно ` M frontends/website/index.html`; apk/.well-known не появились в status (gitignored) |
| C12 | `git -C web status --porcelain` | пусто; HEAD `fbc93662` |
| C13 | SNI `.in`/`.org` enddate | Nov 19 2026 / Jan 6 2027 (без изменений) |
| C14 | tmp-файл `.index.html.m3tmp` | отсутствует |

**Успех M3 = C1–C14 все зелёные.** Любой красный → §3.6.

### 3.6 Точный откат

```sh
git -C /home/animastor/animastor checkout -- frontends/website/index.html
```

Проверка успешности отката:
1. `sha256sum` файла == `276a5fc4…` (байт-в-байт == блок `HEAD`, == до-состояние);
2. `curl https://animastor.org/ | sha256sum` == `276a5fc4…`;
3. `git status --porcelain -- frontends/website/index.html` пусто;
4. `/health`, `/gpu/health` = 200/200; `docker ps` без изменений;
5. C8/C13 — 301 и даты сертов без изменений.

Откат доступен **в любой момент** (файл tracked, worktree до M3 чист, mono-стек
и mounts не меняются). Время отката — секунды, без рестартов.

### 3.7 Окно работ и права

| Параметр | Значение |
|---|---|
| Окно | короткое (единственный статический файл, без рестартов); рекомендуемая длительность ≤ 15 мин с учётом PRE/POST |
| Права | пользователь `animastor` (владелец каталога назначения, 664/775) — **write в `/home/animastor/animastor/frontends/website/`**; чтение web-репо; docker-группа — только для read-only проверок (`docker ps/inspect/exec nginx -t`) |
| Root/sudo | **не требуется** |
| DNS/TLS/Compose/Nginx-conf | **не изменяются** |
| git commit/push | **не выполняется** (правка остаётся uncommitted до отдельного решения) |
| Гейт | **G1** (утверждение 4 URL владельцем) + согласованное окно B2 |

---

## 4. Побочные эффекты — проверено

| Область | Влияние M3 | Проверка |
|---|---|---|
| backend (`animastor-backend`) | нет: монтов website не имеет | `docker inspect` — 4 монта data/ai/tests ✓ |
| GPU Hub | нет: монтов нет | inspect — 0 mounts ✓ |
| PostgreSQL / Redis | нет: только named volumes | inspect — `pg-data`/`redis-data` ✓ |
| Генерация (data/output, data/books) | нет: не монтируются в proxy | ✓ |
| TLS / certbot | нет: трогается только `index.html`, webroot `.well-known` не затронут; `certbot.timer` active, даты Nov 19 / Jan 6 | ✓ |
| Другие домены (app/admin/docs) | нет: свои root (`frontends/app/dist`, `/usr/share/nginx`), свои файлы | app 200, admin 302 (baseline) ✓ |
| legacy `.in` 301 ×3 | нет: server-block в `default.conf` не меняется | 301/301/301 ✓ |
| nginx conf / compose | нет правок; conf sha `99f706af…` не менялась | ✓ |
| dockerignore/плагины/CI | нет (без commit/push/build) | ✓ |
| Зависимости от файлов вне web-репо | M3 не создаёт: все 9 локальных ресурсов нового index есть в mono; apk и `.well-known` остаются в mono | `test -e` 9/9 ✓ |
| Redis/PG-данные, backups | нет: касаний (backup manifest 9/9 OK, dbsize=321 — baseline) | ✓ |

Неожиданных/необъяснённых расхождений **не найдено** → блокеров сверх
известных (G1, окно) нет.

---

## 5. Финальная проверка — baseline зафиксирован ДО любых изменений

### 5.1 Git SHA

mono `465453df…` (`?? overlay`), web **`fbc93662035df84c8e103df0d0706800aa96cba1`**
(чисто), backend `a7a8c463…` (`?? deploy/ ?? freebuff…`), worker `b3f94f42…`,
gpu-hub `ecefd0b7…`, android `92a56c0d…`.

### 5.2 Контейнеры (7)

| Контейнер | Status | CreatedAt |
|---|---|---|
| animastor-backend | Up 42 hours | 2026-10-10 13:46:30 UTC |
| gpu-hub | Up 3 days | 2026-10-08 16:37:08 UTC |
| animastor-proxy | Up 5 weeks | 2026-08-22 09:11:56 UTC |
| animastor-pg | Up 6 weeks (healthy) | 2026-07-08 13:37:11 UTC |
| animastor-redis | Up 6 weeks (healthy) | 2026-07-08 13:37:11 UTC |
| repro-redis | Up 5 days | 2026-10-06 17:02:07 UTC |
| buildx_buildkit_repro0 | Up 3 days | 2026-10-08 15:48:51 UTC |

### 5.3 Compose mounts (живые, == compose)

proxy: `/etc/letsencrypt` (ro), `proxy/conf/.htpasswd` (ro),
`proxy/conf/default.conf` (ro), `frontends/website`→`/usr/share/nginx/frontends/website` (ro),
`frontends/app` (ro), `docs` (ro);
backend: `data/output`, `data/books`, `backend/ai`, `backend/tests`;
pg/redis: named volumes `pg-data`/`redis-data`; gpu-hub: нет mounts.

### 5.4 HTTP-ответы (до изменений)

```
GET /                              200   sha256=276a5fc4… (mono-версия)
GET /health                        200
GET /gpu/health                    200
GET /styles.css /site.js /logo.png /favicon-16 /favicon-32 /apple-touch-icon  200 ×6
GET /library/                      200
GET /downloads/version.json        200   sha256=8dbbfe10… (идентичен web)
GET /downloads/…latest.apk         200   sha256=0b7a1333… (только mono)
GET /.well-known/acme-challenge/   403   (норма: dir listing запрещён)
GET /docs/                         200
GET https://app.animastor.org/     200
GET https://admin.animastor.org/   302
301 ×3 (animastor.in / https / www) 301 → https://animastor.org/
GitHub: animastor → 404, …/tree/master/docs → 404, animastor-web → 200, …/tree/main/docs → 200
SNI: .in notAfter=Nov 19 11:42:10 2026 GMT; .org notAfter=Jan 6 18:29:48 2027 GMT
Диск: 35 031 687 168 Б свободно (≥ 15 000 000 000)
Lock L1/L2: 069b62d9… / 2a221e3b…; overlay: eac32cb0…; conf: 99f706af…
Backups: manifest 9/9 OK; Redis dbsize=321
```

### 5.5 Обязательные условия допуска к M3 (чек-лист)

1. **G1**: владелец письменно утвердил 4 целевых URL
   (`animastor-web`, `animastor-web/tree/main/docs`) — сейчас **BLOCKED**.
2. Согласованное окно B2 (оператор на связи, logbook открыт).
3. PRE P1–P12 в окне — все зелёные (особенно P4/P5/P6: sha и diff == baseline).
4. Окно ограничено M3: **только** `index.html` mono; M2 (apk/.well-known) —
   отдельное разрешение; смена монта/compose — вне окна.
5. Откат-команда под рукой и проверена на знании (§3.6); mono HEAD не сдвинут
   (иначе `git checkout` восстановит не тот blob → ABORT до старта).
6. Диск ≥ 15 000 000 000 Б; health 200/200; контейнеры не перезапускались
   с baseline (сверка CreatedAt §5.2).
7. Запреты окна: без reload nginx, compose/conf-правок, commit/push, DNS/TLS,
   удалений.

**NO-GO = любой пункт не выполнен.**

---

## 6. Что НЕ выполнялось (запреты соблюдены)

Замена/копирование файлов production, правки Compose/Nginx, `up/stop/restart`,
DNS/TLS, публикация артефактов, `git commit`/`git push`, удаление файлов и
данных, очистка Redis, restore — **ничего из перечисленного не выполнялось**.
Все команды этапа — read-only (`git status/log/show/rev-parse`, `sha256sum`,
`diff`, `ls/find/stat/du`, `docker ps/inspect`, `docker exec … read-only`,
`curl` GET/HEAD, `openssl s_client` read-only).

## 7. Резюме для чата

**PASS.** M3 подготовлен, не выполнен. Реальная конфигурация подтверждена
(nginx → mono `frontends/website`, ro-mount, без file-cache), prod = `276a5fc4…`
(4×404), канон на `fbc93662` = `a1900f4e…` (4/4→200), полный diff каталогов =
3 позиции, минимум переноса = 1 файл, атомарное `mv` + мгновенный откат
`git checkout --` готовы. Основной блокер: **G1** (+ окно); M2 (apk/.well-known)
для M3 не требуется, но остаётся обязательным для смены монта (E6).
Отчёт: `/home/animastor/reorg-2026-10-12/30-m3-cutover-preparation-report.md`.
