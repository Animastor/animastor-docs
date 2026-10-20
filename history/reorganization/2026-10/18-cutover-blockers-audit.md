# Animastor — Этап 18: read-only аудит оставшихся блокеров cutover

- Дата: 2026-10-12
- Режим: **только чтение**. Не менялись production, контейнеры, Compose, pin-ы,
  git-refs; ничего не удалялось; `git push` не выполнялся.
- Исходные отчёты: `15-disk-usage-report.md`, `16-disk-cleanup-report.md`,
  `17-journal-cleanup-report.md`, `13-production-cutover-audit.md`.
- Итог: **PASS** (все 5 пунктов разобраны; найдены 4 блокера, требующих
  решения владельца — §6; ни одно изменение не выполнено).

Подтверждение неизменности после аудита: `df /` = 15G свободно; контейнеры с
тем же uptime (backend 37h, gpu-hub 3d, proxy 5w, pg/redis 6w healthy);
`/health` = 200, `/gpu/health` = 200; `git status` всех 5 репо без изменений
(единственный untracked монорепо — pre-existing overlay, §2).

---

## 1. Канонический `frontends/website/index.html`

### 1.1 Факты

| Путь | SHA256 (файла) | git blob @ HEAD | Размер/mtime | GitHub-ссылки внутри |
|---|---|---|---|---|
| `/home/animastor/animastor/frontends/website/index.html` (монорепо, HEAD `465453df`) | `276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c` | `55164ac837c7b4e62f19f0918dc853100eade3aa` | 8998 B, Oct 8 | `github.com/Animastor/animastor` (×3), `…/animastor/tree/master/docs` |
| `/home/animastor/animastor-web/frontends/website/index.html` (web-репо, HEAD `fbc93662`) | `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c` | `90c82ec515adea67e9fe8352f7b0b46446cb3a32` | 9010 B, Oct 11 | `github.com/Animastor/animastor-web` (×3), `…/animastor-web/tree/main/docs` |

- **Diff ровно в 4 строках** (2 хунка, строки ~140–180): ссылки GitHub-репо и
  Docs-folder в карточке и футере. Всё остальное — байт-в-байт (canonical/og
  `.org`, кнопки `app.animastor.org`, `support@.org` — идентичны).
- Оба файла чисты в git (нет незакоммиченных правок); коммиты доменной миграции:
  монорепо `60f8b9ee`, web-репо `fbc93662`.
- **Живой production отдаёт монорепо-версию**: `curl https://animastor.org/`
  → sha256 тела = `276a5fc4…` (точное совпадение с монорепо-файлом).
- **Проверка ссылок (живая):** `github.com/Animastor/animastor` → **HTTP 404**;
  `github.com/Animastor/animastor-web` → **HTTP 200**. Монорепо никогда не
  публиковался в GitHub (remote только локальный bare `/home/animastor/repos/animastor.git`;
  этап 8 публиковал 4 репо — web среди них).
- Остальная разница каталогов (diff -rq): в монорепо есть
  `downloads/animastor-android-latest.apk` и `.well-known/` (runtime/ACME) —
  их в web-репо нет; остальные файлы сайта (site.js, styles.css, library,
  favicon) идентичны.

### 1.2 Вывод

**Каноническая = версия web-репозитория** (`a1900f4e…`):
1. Пост-split решение зафиксировано в отчётах 04 (строка 104) и 07 (§4, §58):
   «ссылки GitHub → `Animastor/animastor-web` — сохранены»; веб-каталог после
   миграции смонтируется из web-репо (отчёт 13, D7).
2. Ссылки монорепо-версии ведут в **404** (несуществующий репозиторий).

**Блокер (B1):** production сейчас отдаёт монорепо-версию с мёртвыми ссылками.
Переключение website-монта на web-репо устраняет их, но требует 3-way:
перенести `downloads/animastor-android-latest.apk` и `.well-known/`
(ACME webroot сертификата `.in`, продление до 2026-11-19!) в web-каталог —
либо точечно отsyncить 4 строки в монорепо (решение владельца; здесь не менялось).

---

## 2. Устаревшая запись Compose `/home/sureg/animastor/docker-compose.yml` и overlay

### 2.1 Факты (все прямые, read-only)

`docker compose ls`:

```
animastor  running(5)  /home/animastor/animastor/docker-compose.yml,
                       /home/animastor/animastor/docker/compose/overlay-backend-standalone.yml,
                       /home/sureg/animastor/docker-compose.yml
```

Существование файлов:

```
EXISTS  /home/animastor/animastor/docker-compose.yml
EXISTS  /home/animastor/animastor/docker/compose/overlay-backend-standalone.yml
MISSING /home/sureg/animastor/docker-compose.yml
```

**Откуда берётся запись — источник найден в labels контейнеров**
(`com.docker.compose.project.config_files`):

| Контейнер | config_files (label) |
|---|---|
| animastor-pg | `/home/sureg/animastor/docker-compose.yml` |
| animastor-redis | `/home/sureg/animastor/docker-compose.yml` |
| animastor-backend | mono `docker-compose.yml` + `overlay-backend-standalone.yml` |
| gpu-hub | mono `docker-compose.yml` |
| animastor-proxy | mono `docker-compose.yml` |

Т.е. `compose ls` — это объединение labels; **pg/redis были созданы ~6 недель
назад через `-f /home/sureg/animastor/docker-compose.yml`** (тогда файл
существовал), после чего удалён: в `/home/sureg/animastor/` остался только
каталог `worker/` (владелец sureg, mtime Aug 31), не смонтированный ни в один
контейнер. Остальные 5 контейнеров проекта — из монорепо-путей.

Overlay `overlay-backend-standalone.yml`:

- SHA256: `eac32cb0bb7f1f6a806e03b3c64fd052808ac7a569345f8377a1af35579a36a1`,
  1418 B, mtime **2026-10-10 13:46:08**, статус git монорепо — **untracked (`??`)**.
- Содержимое (прочитано): `image: ${BACKEND_IMAGE:?…}`, `build: !reset null`,
  `volumes: !override` (убран bind-mount `./backend/src`; оставлены
  data/output, data/books, backend/ai, backend/tests) — это та самая
  «pinned-image» конфигурация, на которой работает backend (`BACKEND_IMAGE=
  …@sha256:e8152778…`, тот же digest в labels `com.docker.compose.image`).

### 2.2 Вывод и риск

- Работающий production от этих записей **не зависит** (контейнеры уже
  созданы; labels — исторические метаданные). Ничего не удалено/не изменено.
- **Блокер (B2):** при любом `docker compose up` с новым набором -f/новым
  каталогом compose сопоставит labels и **захочет пересоздать pg/redis**
  (config_files/config-hash не совпадут), а часть контейнеров не видит
  overlay. Пересоздание pg/redis безопасно для данных (тома `pg-data`/`redis-data`
  named volumes), но даёт простой и должно быть явно запланировано.
  Требуется решение: (а) согласиться на контролируемый recreate pg/redis в
  окне cutover, либо (б) сохранить прежние пути/mode запуска. Запись с
  `/home/sureg/...` — только в labels; в новых запусках её не будет.
- Overlay остаётся **untracked и только в монорепо** — судьба (закоммитить в
  backend-репо `deploy/` или заменить единым репо-compose) — открытое решение
  (отчёт 13, §6.4).

---

## 3. `artifacts.lock.json` — сверка с текущими артефактами

### 3.1 Существует ДВА разных lock-файла (это не дубликаты)

| # | Путь | SHA256 файла | Формат | Последний коммит |
|---|---|---|---|---|
| L1 | `/home/animastor/animastor/packages/animastor-gpu-hub/artifacts.lock.json` | `069b62d931c1ff0e139cd870b287972db3ac66d166cf1906f45f13b87fba6cde` | release-ориентированный: `sha256_asset` 4 зипов + `sha256_tree` (worker-bundle **без** package-lock.json, 7 файлов) | mono `1c37e14a` |
| L2 | `/home/animastor/animastor-gpu-hub/artifacts.lock.json` | `2a221e3ba626326c432c542c5417ab3cdc38af67d294e404bf69586b480b7684` | source-pinned: `sources.{worker,backend}.commit` + `sha256_tree` (worker-bundle **с** package-lock, 8 файлов) | gpu-hub `9b42075` (HEAD `ecefd0b7`) |

L2 используется CI (`ghcr-release.yml:50,80` — checkout pinned commits →
`stage-artifacts.cjs`), L1 — mono Dockerfile (`fetch-pinned-assets.sh` +
`verify-staged-artifacts.sh`). Формула у обоих: sha256 над строками
`"<sha256(file)>  <relpath>\n"`, сортировка **по relpath** (проверено по коду:
`files.sort()` в обоих tool-ах).

### 3.2 Сверка L2 (gpu-hub, CI) — пересчёт независимым скриптом

Пины L2: `worker@618f87a67744…`, `backend@98c4fbd6823c…` (оба — предки текущих HEAD:
worker `b3f94f42612d`, backend `a7a8c4639ed4`).

| Группа | Лок (files/tree/ver) | @pinned commit | @ текущий HEAD |
|---|---|---|---|
| worker-bundle | 8 / `4bb0408b5d0fcfb5…` / 2.1.1 | **MATCH** ✓ | 8 / `417c0ad489badd77…` → **DIFF** ✗ |
| workflows | 9 / `0d51107d58f9774f…` / — | **MATCH** ✓ | **MATCH** ✓ (не менялся) |
| installer-src | 32 / `02fad99eab61638a…` / 0.1.0 | **MATCH** ✓ | 32 / `ff27e2912f59cef7…`, ver **0.1.1** → **DIFF** ✗ |
| install-manifests | 3 / `46f3c26a4fd73ae0…` / — | **MATCH** ✓ | **MATCH** ✓ |

Изменения, выводящие из-под пина (git diff pinned→HEAD): worker-bundle —
`.env.example`, `package.json`, `worker.cjs` (доменная миграция `b3f94f4`);
installer-src — `package.json` (0.1.0→0.1.1), `cli.js`, `engine/engine.js` +
тесты (коммит `a7a8c46` и др.).

**Вывод: пины L2 внутренне согласованы (все 4 группы сходятся на закреплённых
коммитах), но устарели относительно HEAD** → repin обязателен, если нужен
актуальный контент; сам repin здесь НЕ выполнялся.

### 3.3 Сверка L1 (mono, release-активы)

- `node tools/update-artifacts-lock.cjs --check` → **«artifacts.lock.json is in
  sync with source trees» (exit 0)** — деревья L1 сходятся с mono-worktree.
- **Все 4 release-зипа скачаны с GitHub и sha256 СОВПАЛИ с `sha256_asset`:**
  `animastor-worker-bundle-2.1.1.zip` = `4cb6f133ad79…` ✓,
  `hub-workflows-v1.zip` = `c484e197a4c8…` ✓, `installer-src-v1.zip` =
  `ae589c10b47a…` ✓, `install-manifests-v1.zip` = `1fd9f8adf2e9…` ✓.
- Пересчёт tree-формулой по распакованным зипам: worker-bundle 7/`c59dab5d…`
  ✓ == L1, installer-src 32/`777e4aded069…` ✓ == L1, workflows 9/`0d51107d…` ✓,
  manifests 3/`46f3c26a…` ✓.

### 3.4 Расхождения, найденные при сверке (не трогали pin)

**(a) Живой hub отдаёт контент ПИНА L2, а release-зип — другой байты.**

- `GET /gpu/worker-bundle/sha256` → `sha256=480af146451e…`, version 2.1.1,
  8 файлов (включая package-lock.json); скачанный tar.gz байт-в-байт даёт:
  `worker.cjs ac172dc086a71000` == `worker@618f87a6` (pin), НЕ == `worker@HEAD`
  (`0f8350b3…`); `package.json 95e8d96c…` == pin; `.env.example 9ae19196…` == pin.
- Release-зип: `worker.cjs = 0f8350b30cc415b6` == **worker@HEAD** (.org).
- То есть существуют **два разных «worker-bundle 2.1.1»**: запечённый в
  production-образе `daf510ff` (контент пина, .in) и опубликованный GitHub-зип
  (.org). Форматы тоже разные (tar.gz 8 файлов vs zip 7 файлов) — прямое
  сравнение sha256 возможно только внутри формата.
- **Содержимое живого бандла (pin) содержит устаревший домен:**
  `worker.cjs:28` → `HUB_URL … || "https://animastor.in/gpu"`,
  `.env.example:7` → `HUB_URL=https://animastor.in/gpu`,
  `package.json` → `"homepage": "https://animastor.in"` (3 вхождения `.in`;
  в worker@HEAD их **0**). Работает через 301-редирект, но `.in`-сертификат
  истекает **2026-11-19** — если `HUB_URL` когда-либо придёт из fallback-а,
  редирект должен жить до тех пор.

**(b) `installer-src` release-зип (закреплён в L1) содержит clone-URL в 404.**

- `installer-src-v1.zip` (sha256_asset ✓, ver 0.1.1) → `setup-contract.js:695`:
  `git clone https://github.com/Animastor/animastor.git` → **HTTP 404**.
- `backend@98c4fbd6` (pin L2) и `backend@a7a8c463` (HEAD): тот же файл с
  `git clone https://github.com/Animastor/animastor-worker.git` (корректно).
- Т.е. моно-лок и его release-актив содержат более старый `setup-contract`,
  чем backend-репо при той же версии 0.1.1. Кто fetch-ит этот актив — получает
  мёртвый URL в установочном контракте. **Требует republish/repin (решение).**

**(c) Число «нового дерева» из отчёта 13 не воспроизводится tool-ой формулой.**

- `13-production-cutover-audit.md:168` заявляет новый worker-bundle
  `sha256_tree = ad20386cb0f1…`. Пересчёт показал: `ad20386c…` получается только
  при сортировке строк **по хешу** (sort полных строк); оба реальных tool-а
  сортируют **по relpath** (`files.sort()`). По формулам tool-ов дерево
  worker@HEAD: L2-формула (8 файлов) = `417c0ad489badd77…`,
  L1-формула (7 файлов, без package-lock) = `f31d43f9066f31cb…`.
- **Вывод: перед repin пересчитать digest ЗАПУСКОМ реального tool-а
  (`stage-artifacts.cjs --write-lock` / `update-artifacts-lock.cjs`), а не по
  числу из отчёта 13. Pin не обновлялся.**

### 3.5 Сводка по lock

| Проверка | Результат |
|---|---|
| L2 на закреплённых коммитах (4 группы) | **MATCH** ✓ |
| L1 `--check` + sha256_asset 4 зипов + tree зипов | **MATCH** ✓ |
| L2 @ текущие HEAD (worker-bundle, installer-src) | **DIFF — repin нужен** (не выполнялся) |
| release-зип installer-src vs backend-repo (0.1.1) | **DIFF — 404 clone-URL в зипе** |
| живой served-bundle vs release-зип | **DIFF — два разных 2.1.1** (.in-pin vs .org-zip) |
| число `ad20386c…` из отчёта 13 | **не воспроизводится tool-формулой** |

---

## 4. Оставшиеся E2E-проверки GPU Hub и условия безопасного cutover

### 4.1 Что уже подтверждено read-only (зелёное)

| Проверка | Статус/доказательство |
|---|---|
| `/health`, `/gpu/health` | 200 / 200 (https, SNI animastor.org) |
| Контракт worker-bundle | `GET /gpu/worker-bundle/sha256` → v2.1.1, sha `480af146…`, 8 файлов; скачивание идёт, sha256 тела совпадает с полем |
| Auth на `/task` | POST без ключа → **401** (защита живёт) |
| Backend → Hub внутренне | `docker exec animastor-backend wget http://gpu-hub:5000/health` → JSON с очередями |
| Ключ | `GPU_HUB_API_KEY` присутствует в env gpu-hub (65 символов; значение не раскрывается) |
| Nginx/TLS/редиректы `.in→.org` | из отчёта 13 §3.3 — 301×3, `nginx -t` ok, SAN ok |
| Диск (критерий входа ≥15 ГБ) | **15,15 ГБ** свободно (§этап 11) |

### 4.2 Что НЕ сделано — полный список оставшихся E2E

Главный недостающий тест — **реальный dispatch** (отчёт 01:197 «NOT RUN»;
отчёт 10 §6: «живой GPU Hub + секреты»). Скрипт
`/home/animastor/animastor-backend/docker/e2e/dispatch-task.cjs` (и
`install-driver.cjs`) существует. Текущие предпосылки проверены:

1. **`E2E_WORKSPACE_ID` не задан** (env пуст) — требуется workspace приватного
   worker'а; скрипт без него выходит с кодом 1. → нужен выбор workspace (решение).
2. **На хосте НЕТ запущенного worker-процесса/контейнера**
   (`docker ps` — нет; `pgrep worker.cjs` — нет) → dispatch сейчас зависнет в
   очереди: `queues.image=8`, workspace-очередь `…ws:3317e019… = 252` в ожидании,
   `running=0`, `gpus=0`. → E2E требует поднятого воркера (CPU-генерация допустима,
   timeout в скрипте 2400 с).
3. Прогнать `node docker/e2e/dispatch-task.cjs <workflow.json>`: ожидаемо
   `[dispatch] … → hub: …`, затем опрос `animastor:result:<build>:<book>:<ch>:<scene>:generate`
   в Redis до ответа воркера (контракт end-to-end: backend→hub→worker→Redis).
4. **После repin** (если решение будет «да»): `sha256` у
   `/gpu/worker-bundle/sha256` обязан смениться на новый; installer, fetch-ящий
   бандл, должен принять его sha256-verify; прогнать E2E повторно.
5. Мониторинг очереди: 252 pending в workspace-очереди — убедиться в дренаже
   после cutover (в рамках окна).
6. Граница: прогон E2E — уже **живое воздействие** (создаёт реальные задачи) —
   выполняется отдельным решением, не в read-only этапе.

### 4.3 Условия безопасного cutover (критерии «не начинать», из отчёта 13 §5 + текущий аудит)

| # | Условие | Статус сейчас |
|---|---|---|
| C1 | Свободный диск ≥15 ГБ | ✅ 15,15 ГБ |
| C2 | Решение по каноничности `index.html` (B1) и перенос APK + `.well-known` | ❌ открыто (§1) |
| C3 | Решение по stale compose-записи/pg-redis recreate (B2) и по overlay | ❌ открыто (§2) |
| C4 | Решение по repin `artifacts.lock.json` (+ republish installer-src с fix 404 URL) (B3) | ❌ открыто (§3); **пин не тронут** |
| C5 | GPU Hub E2E dispatch прогнан зелёно (§4.2) | ❌ не выполнен (нужны workspace + worker) |
| C6 | `data/` (63 МБ) + pg-dump бэкап перед переключением | ❌ не выполнены |
| C7 | `.in`-сертификат продлён до **2026-11-19** (certbot, webroot в `.well-known`) | ⏳ срок жив, продление не проверялось (root) |
| C8 | Bare-репо синхронизированы с GitHub (1/1/1/4 позади) | ❌ отложено (запрет на изменение refs) |
| C9 | `vite build` web-репо → dist сверен с mono (D8) | ❌ не выполнялся |
| C10 | Теневой стек (фаза B отчёта 13) поднят и зелёный | ❌ не выполнялся (требует `up`) |
| C11 | Откат-план: `docker compose -f docker-compose.yml -f docker/compose/overlay-backend-standalone.yml up -d --force-recreate` из монорепо; образы `e8152778…`/`daf510ff…` локально на месте | ✅ задокументировано (отчёт 13 §5.12) |

---

## 5. Индекс доказательств (пути и SHA)

- SHA256 index.html: mono `276a5fc4a4f08123…`, web `a1900f4ece7f07f4…`;
  git blob `55164ac8…` / `90c82ec5…`; живой ответ `https://animastor.org/` = `276a5fc4…`.
- HTTP: `github.com/Animastor/animastor` = 404; `github.com/Animastor/animastor-web` = 200.
- `docker compose ls` — 3 config-файла; labels pg/redis =
  `/home/sureg/animastor/docker-compose.yml` (MISSING); `/home/sureg/animastor/` = только `worker/`.
- Overlay: SHA256 `eac32cb0bb7f1f6a…`, 1418 B, mtime 2026-10-10 13:46:08, `??` в git.
- Lock L1 mono: SHA256 `069b62d931c1ff0e…`, коммит `1c37e14a`;
  L2 gpu-hub: SHA256 `2a221e3ba626326c…`, коммит `9b42075`, HEAD `ecefd0b7`.
- Пины L2: worker `618f87a67744802b7e7a0b33a0934ce48d414640` (= тег
  `worker-bundle-v2.1.1`), backend `98c4fbd6823c40420154c69e3fc2e02f273fe3de`;
  HEAD: worker `b3f94f42612d0a5dd665956908f545c8d94fad95`, backend `a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad`.
- Деревья (пересчёт): pin-MATCH — `4bb0408b…`(8) / `0d51107d…`(9) / `02fad99e…`(32) / `46f3c26a…`(3);
  @HEAD DIFF — worker-bundle `417c0ad489badd77…`(8), installer-src `ff27e2912f59cef7…`(32, 0.1.1);
  L1-формула worker@HEAD = `f31d43f9066f31cb…`(7); заявленное в отчёте 13
  `ad20386cb0f1…` = только при sort-по-хешу (не tool-формула).
- Release-зипы: `4cb6f133ad7984cd…`, `c484e197a4c8f7cb…`, `ae589c10b47a8bd2…`,
  `1fd9f8adf2e9400a…` — все sha256 MATCH скачанного.
- Served bundle: `/gpu/worker-bundle/sha256` → `480af146451ecd9fea4cfa736a96687c3344b7a65749639336991e62273b54e6`,
  worker.cjs = `ac172dc086a71000…` (= pin), 3× `.in` в контенте.
- E2E: `backend/docker/e2e/dispatch-task.cjs` (env `E2E_WORKSPACE_ID` — не задан),
  `POST /gpu/task` без ключа → 401, очередь `animastor:queue:image:ws:3317e019…` = 252, running 0.
- `.env` (публичные пины): `GPU_HUB_IMAGE=…@sha256:daf510ff8e6d…`,
  `BACKEND_IMAGE=…@sha256:e8152778e1f0…`, `COOKIE_DOMAIN=animastor.org`.
- Git-статусы (без изменений): mono `465453df` (1 untracked overlay),
  web `fbc93662`, backend `a7a8c463`, worker `b3f94f42`, gpu-hub `ecefd0b7` — деревья чистые.

## 6. Блокеры, требующие решения владельца

| ID | Блокер | Решение нужно |
|---|---|---|
| **B1** | production отдаёт mono `index.html` со ссылками в несуществующий GitHub (404); канонический — web-репо `a1900f4e…` | переключить mount на web-репо (+перенести APK и `.well-known`) ИЛИ точечно отsyncить 4 строки в mono |
| **B2** | labels pg/redis ссылаются на удалённый `/home/sureg/animastor/docker-compose.yml`; overlay untracked | план recreate pg/redis в окне cutover; судьба overlay (deploy/ в backend-репо) |
| **B3** | repin `artifacts.lock.json` не согласован с HEAD (worker-bundle, installer-src); release-зип installer-src содержит 404 clone-URL; число `ad20386c…` из отчёта 13 неверно для tool-формулы | решить состав repin; пересчитать запуском tool-а; republish installer-src; обновить `GPU_HUB_IMAGE` |
| **B4** | GPU Hub E2E dispatch никогда не выполнялся; нет запущенного worker'а, `E2E_WORKSPACE_ID` не задан, 252 задачи в очереди | выделить workspace/воркер и окно для прогона до cutover (критерий C5) |

**Ограничения соблюдены:** ничего не изменено, не удалено, не перезапущено;
pin не обновлялся; push не выполнялся; все выводы подтверждены указанными
путями, SHA и живыми read-only проверками.
