# Animastor — Этап 19: план cutover readiness (без выполнения cutover)

- Дата: 2026-10-12
- Источники: `13-production-cutover-audit.md` (прочитан целиком, 342 стр.),
  `18-cutover-blockers-audit.md` (прочитан целиком, 324 стр.), а также
  ссылочные документы: `04-sync-matrix.md`, `05-sync-plan.md`,
  `06-backend-sync-report.md`, `07-web-sync-report.md`, `10-cross-repo-audit.md`,
  `11-merge-report.md`, `12-github-publish-report.md`, `15/16/17` (диск/журнал).
- Режим этого этапа: **только план**. Не выполнялось и не будет выполняется в
  рамках этапа: production-изменения, рестарты, Compose-switch, dispatch,
  repin, republish, git push, удаление файлов, изменение lock-файлов и секретов.
- Статусы в таблице §2 перепроверены read-only 2026-10-12 (свежие пробы —
  в колонке «доказательство»).

---

## 1. Сводка готовности

| Критериев | PASS | В работе/решение | Не начато |
|---|---|---|---|
| C1–C11 | **1** (C1, C11) | **4** (C2, C3, C4, C7*) | **6** (C5, C6, C8, C9, C10; *C7 — дедлайн) |

- Готовность к cutover: **НЕ ГОТОВ** — 4 блокера решения владельца (B1–B4 из
  отчёта 18) + 2 отложенных подготовки (бэкапы, dry-run).
- Диск (≥15 ГБ) и откат-план — выполнены; всё остальное — либо решение
  владельца, либо отдельное окно.

---

## 2. Таблица C1–C11

Формат: критерий | статус | доказательство | блокирующее действие | способ
проверки | условие PASS | откат.

### C1. Свободный диск ≥15 ГБ

| Поле | Значение |
|---|---|
| Статус | **PASS** |
| Доказательство | `df -hT /` = `99G/80G/15G 86%`; точно 15 150 026 752 Б (этап 11, `16-disk-cleanup-report.md`) |
| Блокирующее действие | нет |
| Способ проверки | `df -B1 /` перед каждым этапом B/C |
| Условие PASS | avail ≥ 15 000 000 000 Б (рекомендуется ≥18 ГБ после journal vacuum root-командой) |
| Откат | не применимо; при падении ниже порога — остановить этап (вариант A из отчёта 16: кеш/musor уже исчерпан, остался root-only journal vacuum ≈3,4 ГБ) |

### C2. Каноничность `frontends/website/index.html` + сохранность APK/ACME

| Поле | Значение |
|---|---|
| Статус | **BLOCKED (B1)** |
| Доказательство | mono `276a5fc4…` отдаётся в prod и ссылается на `github.com/Animastor/animastor` → **404**; web-репо `a1900f4e…` → 200; diff = ровно 4 строки; в mono есть `downloads/*.apk` и `.well-known/`, в web-репо нет (отчёт 18 §1) |
| Блокирующее действие | **решение владельца**: (а) точечно отsyncить 4 ссылки в mono, или (б) подготовить переключение монта на web-репо с переносом APK + `.well-known` |
| Способ проверки | `sha256sum` обоих файлов; `diff -u`; `curl -sI https://github.com/Animastor/animastor`; после реализации — `curl https://animastor.org/ \| sha256sum` == выбранному образцу; `ls frontends/website/downloads frontends/website/.well-known` в целевом каталоге |
| Условие PASS | отданное тело == утверждённому SHA; все 3 GitHub-ссылки → 200; APK и ACME-webroot присутствуют на новом пути |
| Откат | вернуть прежний mount `./frontends/website` в compose (mono-копия не удалялась) / `git checkout` правок в mono |

### C3. Старые Compose-ссылки (labels pg/redis) и судьба overlay

| Поле | Значение |
|---|---|
| Статус | **BLOCKED (B2)** |
| Доказательство | `docker compose ls` → 3 config-файла, `/home/sureg/animastor/docker-compose.yml` = MISSING; labels pg/redis = этот путь; overlay `eac32cb0…` untracked (отчёт 18 §2) |
| Блокирующее действие | решение: согласиться на **контролируемый recreate pg/redis** в окне (данные в named volumes `pg-data`/`redis-data`) ИЛИ держать прежний способ запуска; решение по overlay (deploy/ в backend-репо vs единый репо-compose) |
| Способ проверки | `docker inspect animastor-pg --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'`; `docker compose config` (read-only) с набором -f нового каталога; после — `docker ps` + `pg_isready` |
| Условие PASS | новый compose конфигурируется без ошибок; решение по recreate задокументировано; pg/redis healthy после (в окне) |
| Откат | прежние `-f docker-compose.yml -f docker/compose/overlay-backend-standalone.yml` из монорепо; тома не трогаются никогда |

### C4. Repin `artifacts.lock.json` / согласованность артефактов

| Поле | Значение |
|---|---|
| Статус | **BLOCKED (B3)** |
| Доказательство | отчёт 18 §3: L2 `2a221e3b…` — 4/4 MATCH на пинах `618f87a6`/`98c4fbd6`, но @HEAD worker-bundle `417c0ad4…`≠`4bb0408b…`, installer-src `ff27e291…`≠`02fad99e…` (0.1.0→0.1.1); release-зип installer-src содержит 404 clone-URL; `ad20386c…` из отчёта 13 **не использовать** (не tool-формула) |
| Блокирующее действие | решение о составе repin + republish installer-src (fix 404 URL) + rebuild GHCR + обновление `GPU_HUB_IMAGE` — **всё запрещено в этом этапе** |
| Способ проверки | метод §3 настоящего плана (byte-compare + штатные tool-и); **никаких самодельных digest-формул** |
| Условие PASS | `stage-artifacts.cjs` (verify) exit 0 на выбранных коммитах; `update-artifacts-lock.cjs --check` exit 0; sha256_asset зипов MATCH; `/gpu/worker-bundle/sha256` нового образа равен ожидаемому из tool-а |
| Откат | `GPU_HUB_IMAGE` в `.env` вернуть на `…@sha256:daf510ff8e6d…`, `up -d gpu-hub`; прежние зипы остаются в release (тела неизменяемы) |

### C5. GPU Hub E2E dispatch зелёный

| Поле | Значение |
|---|---|
| Статус | **NOT RUN (B4)** — prereq сегодня: `E2E_WORKSPACE_ID` не задан, worker-контейнеров 0, `audio=0, image=8, ws:image=252, running=0, gpus=0` (свежая проба `/gpu/health`) |
| Доказательство | отчёт 01:197 «NOT RUN»; отчёт 18 §4.2; скрипт `backend/docker/e2e/dispatch-task.cjs`, дефолтный workflow существует в обоих репо (1626 Б) |
| Блокирующее действие | выбрать workspace + поднять worker + согласовать окно (§5) |
| Способ проверки | `node docker/e2e/dispatch-task.cjs` (только в окне, §5); контрольные пробы до/после |
| Условие PASS | `[dispatch] … → hub` принят; result-ключ `animastor:result:<build>:…:generate` получен ≤ timeout (2400 с); `/health` и `/gpu/health` = 200 до/после; очередь не выросла кроме +1 |
| Откат | задача гаснет сама по `GPU_TIMEOUT` (hub floor); инфраструктурного отката не требуется — ничего не пересоздавалось |

### C6. Бэкапы `data/` (63 МБ) и pg-dump

| Поле | Значение |
|---|---|
| Статус | **NOT DONE** |
| Доказательство | `data/` = 63 МБ; последний полный tar `backups/backup_animastor_2026-10-08_19-46.tar.gz` (1,08 ГБ, Oct 8); отдельного свежего pg-dump нет |
| Блокирующее действие | выполнить (класс B, §4) |
| Способ проверки | `tar -czf backups/data-<date>.tar.gz -C animastor data`; `docker exec animastor-pg pg_dump -U animastor animastor > …sql` (read-only к БД); контроль: размер >0, `gzip -t`, `pg_restore --list` |
| Условие PASS | два свежих артефакта с сегодняшней датой, `gzip -t` ok |
| Откат | бэкап — только добавление файлов; удаление запрещено |

### C7. `.in`-сертификат продлён до 2026-11-19

| Поле | Значение |
|---|---|
| Статус | **ON TRACK / дедлайн** |
| Доказательство | свежий SNI-проб (сегодня): `notAfter=Nov 19 11:42:10 2026 GMT`, CN=animastor.in; cron `certbot` есть; webroot = `frontends/website/.well-known` (**переезжает вместе с mount — см. C2/D10**) |
| Блокирующее действие | решение по C2 (где окажется webroot); продление — root, отдельное разрешение |
| Способ проверки | `openssl s_client -servername animastor.in` → notAfter; после продления — тот же проб + `https://animastor.in/` 301→.org |
| Условие PASS | notAfter > дата cutover + 30 дней, и webroot после переключения mount доступен certbot'у |
| Откат | сертификаты в `/etc/letsencrypt` не трогаются переключением; если webroot потерян — вернуть mount |

### C8. Bare-репо синхронизированы с GitHub

| Поле | Значение |
|---|---|
| Статус | **NOT DONE** (свежая проба сегодня) |
| Доказательство | wt==github у всех 4; bare отстаёт: worker `618f87a6` vs `b3f94f42`, web `c7fe52ac` vs `fbc93662`, android `254e2f08` vs `92a56c0d`, backend `bce64db3` vs `a7a8c463` (1/1/1/4, FF возможны) |
| Блокирующее действие | **git push запрещён в этом этапе** — отложено до отдельного разрешения |
| Способ проверки | `git ls-remote origin main` vs `git rev-parse main` (read-only, всегда) |
| Условие PASS | bare == worktree == github во всех 4 |
| Откат | push в bare — только FF, ничего не теряется; до push ничего не меняется |

### C9. `vite build` web-репо → dist сверен с mono

| Поле | Значение |
|---|---|
| Статус | **NOT DONE** |
| Доказательство | свежая проба сегодня: `web-репо/frontends/app/dist` — отсутствует; mono `frontends/app/dist` есть (apple-touch-icon.png, assets, favicon-16.png) |
| Блокирующее действие | сборка вне production (класс B) |
| Способ проверки | `npm ci && npx vite build` в web-репо → `diff -r` нового dist vs mono-dist (index/assets); открыть локально |
| Условие PASS | dist собран, `index.html` + assets идентичны либо расхождения объяснены; размер >0 |
| Откат | dist — gitignored артефакт, удалять/откатывать нечего; в prod остаётся mono-dist до переключения |

### C10. Теневой стек (фаза B отчёта 13) зелёный

| Поле | Значение |
|---|---|
| Статус | **NOT DONE** |
| Доказательство | отчёт 13 §5.7: `--project-name animastor-cutover-test`, альтернативные порты; требует `up` контейнеров → **запрещено здесь** |
| Блокирующее действие | разрешение на запуск (+ класс B/C, §4) |
| Способ проверки | `docker compose -p animastor-cutover-test … up -d` из нового деплой-каталога; `curl` /health, /gpu/health, /gpu/worker-bundle/sha256 на тест-портах; `nginx -t` в тест-контейнере |
| Условие PASS | все эндпоинты 200; sha256 бандла == ожидаемому (из tool-а, §3); prod-контейнеры не тронуты (`docker ps` uptime без изменений) |
| Откат | `docker compose -p animastor-cutover-test down` — убирает только тест-проект (томы теста не объявлять/не трогать `pg-data`!) |

### C11. Откат-план задокументирован

| Поле | Значение |
|---|---|
| Статус | **PASS** |
| Доказательство | отчёт 13 §5.11–§5.12: критерии отката (health≠200 >60 с, нет 301, TLS, pg-dados, nginx -t fail, crashloop) и команда `cd /home/animastor/animastor && docker compose -f docker-compose.yml -f docker/compose/overlay-backend-standalone.yml up -d --force-recreate`; образы `e8152778…`/`daf510ff…` локально на месте (проверено) |
| Блокирующее действие | нет |
| Способ проверки | чтение + `docker image inspect` обоих digest локально |
| Условие PASS | образы доступны локально, команда воспроизводима (сухой прогон `docker compose config` с этими -f) |
| Откат | это и есть механизм отката |

---

## 3. Безопасная проверка worker-bundle и installer-src относительно текущих pin

Принцип: **никаких собственных формул digest и никакого `ad20386c…`** —
только байтовое равенство и штатные tool-и репозиториев.

### Проверка W1 — живой served-bundle == пин (байтовое сравнение, read-only)

Что доказывает: production hub отдаёт ровно то, что закреплено в L2.

1. `curl -sSk https://animastor.org/gpu/worker-bundle -o /tmp/wb.tgz`
   (плюс `…/worker-bundle/sha256` → записать объявленные `sha256`/`version`/`files`).
2. `tar -xzf /tmp/wb.tgz -C /tmp/wb/`.
3. Для каждого файла: `git -C /home/animastor/animastor-worker show 618f87a6:packages/animastor-worker/worker/<f> | cmp - /tmp/wb/animastor-worker/<f>`.
   - **cmp exit 0 по всем 8 файлам → PASS** (served == пин `618f87a6`).
   - Ранее уже выполнен: 3 ключевых файла (worker.cjs, package.json,
     .env.example) — byte-identical; расхождение с `worker@HEAD` тоже
     зафиксировано (доменная миграция `b3f94f4`).

### Проверка W2 — staging по штатному tool-у (formula — их, не наша)

Что доказывает: lock L2 согласован с выбранными коммитами по тому же коду,
который гоняет CI (`ghcr-release.yml:80`).

1. Временные клоны **только в /tmp** (оригиналы не трогаются):
   `git clone /home/animastor/animastor-worker /tmp/pin-worker && git -C /tmp/pin-worker checkout 618f87a6…`
   (аналогично backend → `98c4fbd6…`; для проверки «на каком коммите
   проходит» — второй набор клонов на HEAD).
2. Копия gpu-hub репо в /tmp; из неё:
   `node scripts/stage-artifacts.cjs --worker /tmp/pin-worker --backend /tmp/pin-backend`
   (без `--write-lock`!). Инструмент сам хеширует staged-байты формулой lock-а
   и выходит 0 («staging verified against artifacts.lock.json») либо 1 с
   перечнем расхождений.
   - exit 0 на пинах → **PASS**; exit 1 на HEAD → ожидаемо и фиксирует drift
     (worker-bundle, installer-src) без каких-либо изменений.
3. Побочно: `git -C /tmp/pin-* diff --stat <pin> <HEAD> -- <группа>` —
   именованный состав изменений (без digest).

### Проверка W3 — mono L1: только штатный `--check`

- `node /home/animastor/animastor/packages/animastor-gpu-hub/tools/update-artifacts-lock.cjs --check`
  → exit 0 «in sync» (сегодня: PASS). Инструмент read-only в режиме check.

### Проверка W4 — release-активы: sha256 файла vs поле лока (не дерево)

- Скачать 4 зипа, `sha256sum` == `sha256_asset` из L1 (сегодня: 4/4 MATCH).
- Содержимое installer-src верифицировать текстовым diff vs `backend@98c4fbd6`
  и `@a7a8c463` (сегодня: в зипе 404 clone-URL — зафиксировано).

### Запрещено (явно)

- Вычислять `sha256_tree` своей реализацией; брать `ad20386c…` из отчёта 13;
  запускать `--write-lock`; править lock-файлы; публиковать зипы.

---

## 4. Действия по классам

### A. Read-only, без влияния на production (можно сейчас)

| # | Действие |
|---|---|
| A1 | W1: byte-compare served-bundle vs pin (§3) |
| A2 | W2: staging verify в /tmp клонами (§3) |
| A3 | W3 `--check`; W4 sha256_asset 4 зипов |
| A4 | Мониторинг: `/health`, `/gpu/health`, `docker ps` uptime, глубина очередей (`audio` должен быть 0) — baseline для E2E |
| A5 | `docker compose config` (read-only) с текущими -f и с черновиками будущих -f — валидация без `up` |
| A6 | Diff-сверки mount-источников: `backend/ai`, `proxy/conf/default.conf`, `docs` mono↔репо (подтверждение D3/D5/D9 перед switch) |
| A7 | SNI-проб `.in`/`.org` сертификатов; `git ls-remote` bare/github (C7/C8) |
| A8 | Инвентаризация `frontends/website/downloads` + `.well-known` (чтобы при C2 ничего не потерялось) |

### B. Подготовка вне production (не трогает работающие контейнеры; часть — с разрешения)

| # | Действие | Примечание |
|---|---|---|
| B1 | Бэкапы: тар `data/` (63 МБ) + `pg_dump` в `backups/` | C6; безопасно, только добавление файлов |
| B2 | Разрешение B1 (index.html): правка 4 строк в mono **или** подготовка web-копии (APK + `.well-known` → каталог web-репо, вне git, до решения о commit) | commit/push — отдельно |
| B3 | `vite build` в web-репо + `diff -r` dist vs mono-dist | C9; node_modules/disk: 15 ГБ ок |
| B4 | Черновик нового deploy-каталога: копия `docker-compose.yml` + overlay + черновик `.env` (секреты оператором вручную) в `animastor-backend/deploy/`; `docker compose config` — валидация | 3-way из отчёта 13, шаг 2; ничего не запускать |
| B5 | Черновик решения C3: что делаем с labels pg/redis (recreate в окне vs сохранение способа запуска); копия overlay в deploy/ | без применения |
| B6 | Подготовка E2E: выбор `E2E_WORKSPACE_ID`, поднятие worker (CPU) в тестовой сети | запуск драйверов — только в C |
| B7 | Теневой стек `animastor-cutover-test` — **только после разрешения** (запуск контейнеров) | C10; не объявлять `pg-data` |

### C. Требует отдельного окна и разрешения (в этом этапе ЗАПРЕЩЕНО)

| # | Действие |
|---|---|
| C-1 | Republish `installer-src` release-актива (fix 404 clone-URL) |
| C-2 | Repin: `stage-artifacts.cjs --write-lock` → CI `ghcr-release.yml` → новый digest → `GPU_HUB_IMAGE` в `.env` |
| C-3 | GPU Hub E2E dispatch (§5) |
| C-4 | Compose-switch: `stop backend nginx` → `up -d` из нового каталога; возможен recreate pg/redis (решение C3) |
| C-5 | Продление `.in`-серта (root, certbot) |
| C-6 | Синхронизация bare (`git push origin main` ×4, FF) |
| C-7 | Переключение website-монта (после B2) + проверка ACME-webroot |

---

## 5. GPU Hub E2E: prerequisites, воздействие, критерии запуска

**Запуск dispatch в этом этапе запрещён и не выполняется.**

### Prerequisites (проверить все до окна)

| # | Prerequisite | Сейчас |
|---|---|---|
| P1 | `E2E_WORKSPACE_ID` — workspace приватного worker'а | ❌ unset |
| P2 | Запущенный worker (CPU допустим, `gpus:0`), берущий именно этот workspace | ❌ 0 воркеров |
| P3 | `GPU_HUB_API_KEY` в контейнере hub (скрипт читает через `docker exec`) | ✅ 65 символов |
| P4 | Эндпоинт `https://animastor.org/gpu` отвечает; 401 без ключа | ✅ проверено |
| P5 | Workflow-файл дефолта существует (`backend/ai/workflows/tts-qwen-narrator.json`, 1626 Б, оба репо) | ✅ |
| P6 | Доступ к Redis для опроса result-ключа (`docker exec animastor-redis`) | ✅ |
| P7 | Тихая очередь: `audio=0`; image-канал (8 / ws 252) не использовать для теста — job_type `audio` | ⚠️ image занят; audio свободен |
| P8 | Диск ≥15 ГБ, `/health`+`/gpu/health`=200 перед стартом | ✅ |
| P9 | Согласованное окно и владелец, знающий, что будет создан 1 реальный job | ❌ не согласовано |

### Воздействие на production (честно)

- Создаёт **реальную задачу** в prod hub и Redis (job/build/dispatch id с
  префиксом `e2e-`), result-ключи остаются в Redis (безвредны).
- Occupies worker до `timeout_ms` (hub floor = `GPU_TIMEOUT`, дефолт 600 с;
  скрипт поллит до 2400 с). При `SHARE_FEATURES_ENABLED=1` возможен
  step-2 borrow из общего пула — тест может подождать/задержать чужую задачу.
- **Не** трогает контейнеры/конфиги/тома; рестартов не происходит.
- Основной риск — узел P7/P2: без idle-worker'а задача просто повисит в
  очереди до таймаута (эффект: +1 в очереди, сама исчезает по timeout).

### Критерии безопасного запуска

1. Все P1–P9 зелёные; `audio=0` в момент старта; зафиксировать snapshot
   `/gpu/health` (queues/running) и `docker ps` uptime.
2. Ровно **один** dispatch, текст короткий, workflow — дефолтный.
3. Во время поллинга: каждые 60 с `/health` и `/gpu/health` — обязаны быть 200;
   abort, если health ≠200 дольше 60 с или очередь выросла больше чем на +1.
4. PASS = result-ключ получен ≤ timeout; после: те же uptime у 8 контейнеров,
   health 200/200, логи gpu-hub/backend без новых ошибок.
5. Откат: не нужен (ничего не пересоздано); задача гаснет по timeout;
   job-идентификаторы `e2e-*` документируются в отчёте.

---

## 6. Порядок решения четырёх конфликтов

Зависимости: C2 (домен/статика) → влияет на mount-switch; C4 (артефакты) →
независим от C2; C3 (compose) → 마지막 (сам switch); E2E (C5) → базовый замер
ДО C4 и повтор ПОСЛЕ.

| Шаг | Что решаем | Класс | Почему в этом порядке |
|---|---|---|---|
| **1** | **B6+C6: бэкапы** (`data/` + pg-dump) | B | дешёвая страховка до любых дальнейших действий |
| **2** | **B1/C2: index.html** — решение владельца ((а) 4 строки в mono, или (б) подготовка web-mount с переносом APK+`.well-known`), затем реализация класса B | B (решение) | независим от артефактов; определяет путь ACME-webroot (C7) и состав website-каталога для switch |
| **3** | **A1–A4 + §3 W1–W4**: фиксация фактического соответствия pin↔served↔release (без формул) | A | даёт измеримый baseline для будущего repin |
| **4** | **B4/C5: E2E baseline** — prereq P1–P9, затем dispatch в окне на **текущих** pin | B, затем C | зелёный baseline до любых изменений артефактов; после repin — повтор для сравнения |
| **5** | **B3/C4: артефакты** — решение состава repin → (C) republish installer-src (404 fix) → (C) `--write-lock` + CI + `GPU_HUB_IMAGE` → повтор E2E | B, затем C | требует, чтобы шаг 3 (baseline) и шаг 4 (E2E) были сделаны; lock правится ТОЛЬКО tool-ом |
| **6** | **B5+C3: compose** — черновик deploy-каталога + 3-way + `config`-валидация → (при разрешении) теневой стек B7/C10 | B, затем C | последним: зависит от выбранного website-mount (шаг 2) и нового `GPU_HUB_IMAGE` (шаг 5) |
| **7** | **C8 bare-sync, C7 продление серта** — отдельные разрешения, до дедлайна 19.11 | C | не блокируют шаги 1–6, но обязательны до/после switch по календарю |
| **8** | Сам cutover (фаза C отчёта 13) + финальный прогон C1–C11 | C | **вне скоупа этапа 19** |

Финальный pre-flight: перепройти таблицу C1–C11 — все 11 в PASS, и только
тогда назначать окно cutover.

---

## 7. Следующий безопасный шаг

Выполнить класс A: W1 (byte-compare served-bundle vs пин), W2 (staging-verify
в /tmp клонами штатным tool-ом), W3/W4 (`--check` + sha256_asset) и оформить
их результаты в отчёт 20; параллельно запросить у владельца три решения —
B1 (index.html), состав repin (B3), политику pg/redis (B2), — и согласовать
окно для E2E (P1–P9). Всё это read-only либо чисто локальная подготовка.

**Ограничения этапа соблюдены:** ничего из запрещённого не выполнялось;
lock-файлы не изменены (`069b62d9…` / `2a221e3b…`); dispatch не запускался;
push/republish/repin не было; production не тронут (uptime/health — без
изменений на момент записи плана).
