# Animastor — Этап 33: POST-M3 VERIFICATION

- Дата: 2026-10-12 (08:45–08:50 UTC / 14:15–14:20 IST)
- Режим: **только read-only проверка и документация.** Production не изменялся:
  без переключений, рестартов, правок Compose/Nginx/TLS/DNS, без очистки Redis,
  без правок lock-файлов, без `git commit`/`git push`, без публикации ZIP,
  без удаления данных.
- Источники (прочитаны): `32-m3-production-execution-report.md`,
  `28-cutover-readiness-audit.md`, `21-production-cutover-runbook.md`.
- Итог: **PASS.** Сайт стабилен после M3: production-файл и живое тело =
  канон `a1900f4e…`, 4/4 ссылки → 200, health 200/200, побочных изменений нет.
  Дополнение к runbook подготовлено (§3, в файл отчёта — сам runbook не правился).
  Блокеры пересмотрены (§4): новых снятий нет; **ближайший дедлайн — TLS `.in`
  до 2026-11-19 11:42 GMT (38 дней)**.

---

## 0. Краткий итог

M3 подтверждён как стабильный: `https://animastor.org/` отдаёт байт-в-байт
каноническую версию web-репо (sha256 `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c`),
старых битых ссылок 0, все 4 новые → 200, редиректы и health живы, контейнеры
не перезапускались (те же CreatedAt, что до M3), mounts/lock/данные целы.
Резервная копия исходника и оба канала отката доступны. Изменение в mono
остаётся uncommitted — зафиксировано точно, автоматический commit не делался.
Главный риск на горизонте — истечение сертификата `animastor.in` (19.11.2026);
способ продления восстановлен, образ ещё не скачан.

---

## 1. Проверка production после M3 — все PASS

### 1.1 Сайт

| # | Проверка | Результат |
|---|---|---|
| 1 | sha256 `/home/animastor/animastor/frontends/website/index.html` | `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c` ✓ |
| 2 | sha256 живого тела `https://animastor.org/` | `a1900f4e…` == файлу == канону web-репо ✓ |
| 3 | `cmp` prod-файла с `/home/animastor/animastor-web/frontends/website/index.html` | IDENTICAL ✓ |
| 4 | ссылки на живой странице | 2× `…/Animastor/animastor-web` + 2× `…/tree/main/docs` (позиции 143/176, 150/177) |
| 5 | HTTP-статус 4 ссылок (уникальные URL) | **4/4 → 200** ✓ |
| 6 | старые битые URL на странице | **0 вхождений** ✓ |
| 7 | главная HTTPS | 200 ✓ |
| 8 | HTTP→HTTPS | `http://animastor.org/` → **301** `https://animastor.org/`; `http://www.animastor.org/` → 301 ✓ |
| 9 | редиректы `.in` ×3 | `https://animastor.in/`, `http://animastor.in/`, `http://www.animastor.in/` → **301** ✓ |
| 10 | `/health`, `/gpu/health` | **200 / 200** ✓ |
| 11 | `/docs/`, `app`, `admin` | 200 / 200 / 302 (baseline) ✓ |
| 12 | `/downloads/…apk`, `/downloads/version.json` | 200 / 200 ✓ (ссылки новой страницы не сломаны) |
| 13 | `nginx -t` (read-only, без reload) | `syntax is ok`, `test is successful` (deprecated-`http2` warnings существовали и до M3) ✓ |

### 1.2 Инфраструктура и сохранность

| # | Проверка | Результат |
|---|---|---|
| 14 | 7 контейнеров | CreatedAt **без изменений** относительно M3: backend 2026-10-10 13:46:30, pg/redis 2026-07-08 13:37:11 (healthy), proxy 2026-08-22 09:11:56, gpu-hub 2026-10-08 16:37:08, repro-redis 2026-10-06, buildkit 2026-10-08 — **перезапусков не было** ✓ |
| 15 | Compose mounts | proxy: 6 ro-bind (website/app/docs/conf/htpasswd/letsencrypt) — источники идентичны baseline; backend: 4 rw-bind data/ai/tests — идентичны ✓ |
| 16 | данные | `data/output` 63 203 425 Б, `data/books` 1 704 047 Б == этапу 27 ✓ |
| 17 | lock-файлы | L1 `069b62d931c1ff0e…`, L2 `2a221e3ba626326c…` == baseline ✓ |
| 18 | overlay / nginx conf / `.env` | `eac32cb0…` / `99f706af…` / 2 112 Б mode 600 — не изменялись ✓ |
| 19 | backups | манифест 9/9 OK; M3-копия на месте ✓ |
| 20 | Redis / PG | `dbsize=321` (baseline), pg healthy ✓ |
| 21 | GPU Hub контракт | `/gpu/worker-bundle/sha256` = `480af146…` v2.1.1 (пин не менялся) ✓ |
| 22 | диск | `35 028 193 280` Б ≥ 15 000 000 000 ✓ |

### 1.3 Резервная копия и возможность отката — подтверждены

| Канал | Объект | Проверка |
|---|---|---|
| Файловая копия | `/home/animastor/backups/index.html.pre-m3-276a5fc4.html` + `.stat.txt` | sha256 `276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c`, 8 998 Б, mode 664 — байт-в-байт исходник до M3 ✓ |
| Git-канал | `git -C mono show HEAD:frontends/website/index.html` | sha256 `276a5fc4…` — HEAD-блоб не изменился (правка uncommitted) → `git checkout -- frontends/website/index.html` восстановит исходник ✓ |

Процедура отката (не понадобилась, задокументирована в отчёте 32 §6):
`cp -p backups/index.html.pre-m3-276a5fc4.html → DST` либо
`git -C /home/animastor/animastor checkout -- frontends/website/index.html`;
контроль: sha == `276a5fc4…`, живое тело == `276a5fc4…`, health 200/200.

### 1.4 Точный статус незакоммиченного изменения в monorepo

```
mono HEAD: 465453df673016a4f3884b7ae25cddeebb052551
git status --porcelain:
   M frontends/website/index.html        <- ожидаемое изменение M3
?? docker/compose/overlay-backend-standalone.yml   <- baseline (не трогали)
git diff --stat: 1 file changed, 4 insertions(+), 4 deletions(-)
```

Diff содержит **ровно 4 утверждённые пары строк** (GitHub repo/docs →
`animastor-web` / `animastor-web/tree/main/docs`), больше ничего.
**Автоматический commit НЕ выполнялся и не требуется** — до отдельного решения
владелеця. Защита от потери при любых git-операциях: файловая копия в backups
(§1.3). Прочие репо: web `fbc93662` чисто; backend `a7a8c463` (`?? deploy/`,
`?? freebuff…` = baseline); worker `b3f94f42`, gpu-hub `ecefd0b7`,
android `92a56c0d` — чисто.

---

## 2. Проверка стабильности (окно наблюдения)

Замер выполнен ~10 минут после окна M3 и повторно на этапе 33 — все параметры
идентичны пост-M3-снимку (§1). Оснований считать замену нестабильной нет.
Рекомендуемый разовый повтор smoke (health, главная, 4 ссылки) позже в тот же
день — необязателен, все контрольные точки уже зелёные.

---

## 3. Дополнение к runbook (подготовлено; сам runbook не изменялся)

Текст ниже — готовая вставка для `21-production-cutover-runbook.md`
(вклеивается владельцем/отдельным разрешением; история этапов не переписывается):

> **Addendum B-completed (2026-10-12):** Фаза B закрыта. G1 получен, окно B2
> открыто (12.10.2026 IST). B2-применение выполнено 12.10.2026 08:36–08:41 UTC:
> атомарная замена (tmp + `mv`, тот же FS) `/home/animastor/animastor/frontends/website/index.html`
> `276a5fc4…` → `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c`
> (= web-репо `fbc93662`). Diff — ровно 4 утверждённые ссылки. Проверки PASS:
> живое тело == `a1900f4e…`; 4/4 GitHub-ссылки → 200; старых 404-ссылок 0;
> HTTP→HTTPS 301; `.in` 301 ×3; health 200/200; `nginx -t` ok; контейнеры и
> mounts без изменений; lock/data целы. Резервная копия исходника:
> `backups/index.html.pre-m3-276a5fc4.html` (`276a5fc4…`) + `stat`-запись.
> Откат: `cp -p` копии обратно либо
> `git -C animastor checkout -- frontends/website/index.html` (HEAD-блоб
> `276a5fc4…`). Изменение в mono **uncommitted** (commit — отдельное решение).
> **Пункт GO/NO-GO №3 («D1 исполнен: живой site sha == `a1900f4e…`, ссылки 200») — ВЫПОЛНЕН.**
> Отчёт: `reorg-2026-10-12/32-m3-production-execution-report.md` (+ `33-…`).

---

## 4. Пересмотр оставшихся блокеров (фактический статус, без присвоения PASS)

| Гейт/решение | Фактический статус сейчас | Основание / что требуется |
|---|---|---|
| **G1** (4 URL) | **PASS — закрыт** (12.10.2026) | утверждены владельцем; M3 выполнен и верифицирован (§1) |
| **D1** (канонический index = web) | **ИСПОЛНЕН** | сайт отдаёт `a1900f4e…` |
| **G2** (цели repin) | **NOT TESTED — не сдвинулся** | нужны C-проверки provenance (W1–W4 из фазы C) и письменное подтверждение целей: worker `b3f94f42`, backend `a7a8c463`; ничего не выполнялось |
| **G3** (push/CI/publish) | **NOT TESTED** | разрешение владельца не выдавалось; GitHub-токен/учётка не задействовались |
| **G4** (deploy-layout) | **BLOCKED — технически готов, ждёт владельца** | файлы `animastor-backend/deploy/` целы (compose 6 513 Б, overlay 2 171 Б, README); `deploy/.env` **по-прежнему отсутствует** (создаёт владелец, 600); утверждение отклонения overlay (абсолютные пути) не зафиксировано |
| **G5** (E2E-окно) | **NOT TESTED** | окно не согласовано, `E2E_WORKSPACE_ID` не выдан, worker не готовился |
| **G6/D5** (TLS `.in`) | **BLOCKED — дедлайн близок** | SNI `animastor.in` **notAfter=Nov 19 11:42:10 2026 GMT** (осталось **38,1 дня**, на 2026-10-12 08:47 UTC); `certbot.timer` **active + enabled**; renewal-конфиги: webroot = mono `frontends/website` (после смены монта E6 потребуется M2 + правка `webroot_path`); **образ `certbot/certbot` НЕ скачан** (`docker images` — нет) → первый запуск потребует pull (~30–50 МБ; диск 35 ГБ — достаточно); сухая процедура проверена в 28 §1.6 (mount `/etc/letsencrypt` rw + webroot под путём конфига; dry-run → renew → `nginx -t` + `nginx -s reload`) |
| **G7** (GO/NO-GO cutover) | **NOT TESTED** | чек-лист §7 runbook не прогонялся; теперь уже пункты: №3 выполнен (D1), остальные по фазам C–G |
| **G8** (bare-sync) | PASS (этап 26) | без изменений |
| **D2** (цели repin) | NOT TESTED | = G2 |
| **D3** (pg/redis без recreate) | PASS (зафиксировано) | dry-run E3 пригодется в фазе E |
| **D4** (republish ZIP) | **BLOCKED** | решение по `installer-src-v1.zip` (внутри 404-клон mono-репо) не принято: новый tag/release (рекомендуется) vs перезаливка с архивацией; публикация — только с G3 |
| **Restore-тест** | **NOT TESTED — план готов** | см. §4.1 |

### 4.1 Restore-тест — безопасная изолированная проверка (предложение)

Принцип: временные ресурсы с префиксом `restore-test`, без контакта с рабочими
PG/Redis/данными; порты не публикуются; `--rm`; диск ≥ 200 МБ (есть 35 ГБ).
Требует отдельного разрешения владельца (распаковка/pg_restore — подготовка
к восстановлению).

| # | Что | Как (изоляция) | Критерий успеха |
|---|---|---|---|
| R1 | pg_dump | временный postgres:16 (`--name restore-test-pg`, volume `restore-test-pgdata`, без публикации портов), `pg_restore --exit-on-error` из `cutover-pg-2026-10-12.dump`, затем `count(*)` по ключевым таблицам vs рабочий `animastor-pg` (read-only) | restore exit 0; счётчики совпадают; рабочий pg healthy/uptime прежние |
| R2 | data/ | `tar -tzf cutover-data-…tgz` + распаковка в `/tmp/restore-test-data/`, `diff -r` выборки против рабочего `data/` | список идентичен; sha256 выборки совпадают; рабочий `data/` не писался |
| R3 | Redis | временный redis:7 с `--dir` на копию RDB во временном каталоге (`--save ''`), `dbsize`/префиксы | `dbsize=321`, префиксы читаются; рабочий redis не тронут |
| R4 | config | `tar -tzf cutover-config-…tgz` во временный каталог, sha compose против текущих; содержимое `.env` **не печатать** | пути/размеры ок; sha совпадают |
| R5 | git | распаковка `git_repos_…tar.gz` во временный каталог → `git fsck` в bare; сверка HEAD с `git-refs-status` | fsck 0; HEAD совпадают |

---

## 5. Рекомендация: кратчайший безопасный путь к завершению переноса

### 5.1 Обязательно (по приоритету; порядок = порядок исполнения)

1. **G6/D5 — TLS `animastor.in` (дедлайн!).** Ближайший жёсткий дедлайн:
   **2026-11-19 11:42:10 GMT** (38 дней). В отдельном разрешённом окне с
   docker-доступом: `docker pull certbot/certbot` → `renew --dry-run`
   (webroot монтируется под путём `/home/animastor/animastor/frontends/website`) →
   при успехе `renew` → `docker exec animastor-proxy nginx -t` → `nginx -s reload`
   → контроль SNI (≥ +60 дней) + 301 ×3. Внимание: даже автопродление
   `certbot.timer` (~с 20.10) требует ручного reload nginx; **после E6** (смены
   website-монта) сначала M2 (`.well-known` в web) + правка `webroot_path` (root),
   иначе продление сломается.
2. **G4 — утвердить deploy-layout** (включая абсолютные пути в overlay-копии) и
   создать владельцем `deploy/.env` (600) → открывает фазу E (E1–E3 dry-run).
3. **D4 — решение по `installer-src`** (рекомендую: новый immutable tag/release
   с исправленным `git clone …/animastor-worker.git`; публикация после G3).
4. **C-проверки (W1–W4) → G2 → G3** — provenance, подтверждение целей repin,
   затем отдельное окно push/CI/publish (не объединять с E2E/H).
5. **Restore-тест** (§4.1) — отдельное разрешение; снимает риск «бэкапы есть,
   но не проверены».
6. **G5 — E2E в отдельном окне** (P1–P9) либо явное решение владельца принять
   риск отложенного E2E.
7. Затем **G7 (GO/NO-GO)** → **фаза H** (M4/M5 + при необходимости E6-переход
   монта website на web-каталог с apk/.well-known из M2) → **I** (smoke +
   наблюдение ≥7 дней) → **J** (bare-sync G8, закрытие).

### 5.2 Можно отложить (не блокирует следующий этап)

- Коммит M3-правки в mono — правка защищена backups-копией и HEAD-блобом;
  рекомендуется отложить до решения о судьбе mono-репо (фаза J), **не терять**
  backups-файл (удаление запрещено без разрешения).
- Повторный smoke позже в день M3 (необязателен — все проверки зелёные).
- MX/доставка `support@animastor.org` (вне скоупа, из отчёта 29).
- Чистка Redis-очередей — по-прежнему только отдельное разрешение; сейчас
  не требуется (active-задач нет, но и без чистки система стабильна).

### 5.3 Требует решения владельца (нельзя двигать без явного «да»)

| # | Решение | Что разблокирует |
|---|---|---|
| 1 | Разрешение окна G6: pull + dry-run + renew + reload | продление `.in` до дедлайна |
| 2 | G4: утвердить deploy-каталог и отклонение overlay; создать `deploy/.env` | фаза E |
| 3 | D4: механизм замены `installer-src` (новый release vs перезаливка) | фаза D-публикации |
| 4 | G2: подтвердить цели repin (worker `b3f94f42`, backend `a7a8c463`) после C-сверок | G3 |
| 5 | G3: разрешение push/CI/publish | repin доходит до пользователей/CI |
| 6 | Restore-тест: разрешение на изолированный прогон | закрытый риск бэкапов |
| 7 | G5: окно E2E + `E2E_WORKSPACE_ID` | E2E-гейт |
| 8 | Судьба uncommitted-правки mono (коммит сейчас vs в фазе J) | гигиена mono; откат-канал остаётся обеим |

### 5.4 Ближайший дедлайн

**2026-11-19 11:42:10 GMT — истечение `animastor.in` сертификата** (сегодня
осталось 38,1 дня). Внутренние вехи: ~2026-10-20 `certbot.timer` начнёт
пытаться продлить сам (проверить результат первого авто-окна); reload nginx
всё равно потребуется вручную. Если до этого момента выполнить E6 (смена
website-монта), продление сломается без M2 + правки `webroot_path` →
**порядок: либо сначала продлить, либо сначала M2+правка webroot.**

### 5.5 Условия допуска к следующему этапу

Следующий логический этап — **окно G6 (TLS)** (самый горящий дедлайн),
параллельно можно готовить G4-решение. Допуск к окну G6:

1. Письменное разрешение владельца: pull `certbot/certbot`, dry-run, renew,
   `nginx -s reload` (docker-группа уже есть; host-sudo не обязателен).
2. Окно согласовано; оператор на связи; logbook открыт.
3. Preflight в окне: SNI `.in` не истёк; `certbot.timer` active; диск ≥ порога;
   health 200/200; website-морт **не менялся** (если менялся — сначала M2 +
   правка webroot_path);
4. Фиксация baseline SNI-дат и sha renewal-конфигов до действий;
5. Критерий успеха: dry-run «all simulated renewals succeeded» → после renew
   `notAfter` ≥ +60 дней, 301 ×3 живы, `nginx -t` ok.

Допуск к фазе E (после G4): утверждён layout + `deploy/.env` (600) создан;
`compose config` с реальными секретами планируется в окне с владельцем.

## 6. Что НЕ выполнялось (запреты соблюдены)

Любые изменения production (файлы/конфиги/рестарты), Compose/Nginx/TLS/DNS,
очистка Redis, правки lock-файлов, `git commit`/`git push`, публикация ZIP,
удаление данных, перезапуск контейнеров — **не выполнялись**. Исполняемые
команды: `sha256sum`, `cmp`, `git rev-parse/status/diff/show`, `curl` (GET/HEAD),
`docker ps/inspect/exec(read-only)`, `du/stat/ls`, `openssl s_client`,
`systemctl is-active/is-enabled`, `redis-cli dbsize`, `date`.

## 7. Резюме для чата

**PASS.** Сайт стабилен: production = канон `a1900f4e…` (файл == живое тело ==
web-репо), 4/4 ссылки → 200, старых 404 — 0, health 200/200, HTTP→HTTPS и `.in`
301, nginx -t ok; контейнеры/mounts/данные/lock без изменений; откат
обеспечен (backups-копия `276a5fc4…` + git-канал). Изменение в mono —
точно ` M frontends/website/index.html` (4+/4−), uncommitted, commit не делался.
Подтверждённые блокеры: **G6/D5** (TLS `.in` до **19.11.2026**, образ certbot не
скачан), **G4** (deploy/.env нет, утверждения нет), **D4** (решение по ZIP),
**G2/G3/G5/G7** — NOT TESTED, restore-тест — NOT TESTED (план в §4.1).
Отчёт: `/home/animastor/reorg-2026-10-12/33-post-m3-verification-report.md`.
