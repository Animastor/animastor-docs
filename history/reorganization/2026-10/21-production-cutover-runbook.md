# Animastor — Этап 21: PRODUCTION CUTOVER RUNBOOK

- Дата: 2026-10-12
- Режим: **только подготовка документации.** Ничего не выполнялось: без
  production changes, рестартов, Compose switch, dispatch, repin, republish,
  git push, изменений DNS/TLS, lock-файлов, секретов, удаления файлов.
  Команды отката «для проверки» не запускались.
- Источники (прочитаны): `19-cutover-readiness-plan.md`,
  `20-owner-decisions.md`, `13-production-cutover-audit.md`,
  `18-cutover-blockers-audit.md` + `04/05/07/10/12`.
- Решения владельца, принятые за основу: **D1** (канонический index.html =
  web-репо, со разбором 4 ссылок до внедрения), **D2** (сначала подтверждение
  целей/provenance → потом согласованный repin+republish), **D3** (compose-refs
  pg/redis — исторические метаданные, без recreate ради labels), **D4** (E2E
  только в отдельное окно с критериями остановки/отката), **D5** (TLS —
  отдельное действие с root).

---

## 0. Подтверждённые константы (все пути/SHA проверены в этапах 13–20)

| Константа | Значение |
|---|---|
| Диск (точно, 2026-10-12, последний замер) | `/dev/sda2`: всего `105496965120`, занято `85841084416`, **свободно `15138779136` Б**; порог этапа: **`15000000000` Б** (запас всего `138779136` Б, <1%!) |
| Compose (текущий) | `/home/animastor/animastor/docker-compose.yml` + `/home/animastor/animastor/docker/compose/overlay-backend-standalone.yml` (sha256 `eac32cb0bb7f1f6a806e03b3c64fd052808ac7a569345f8377a1af35579a36a1`, untracked); `.env` = `/home/animastor/animastor/.env` |
| Pinned-образы | `GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:daf510ff8e6d713bf9e2e2caebe11e590f61a896e30cb9aec7e7be79672be2d0` (локально 1,58 ГБ); `BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:e8152778e1f00d09c9436ff295eeada7248fef8f9823f727e728a2c79a35c9f9` (2,47 ГБ) |
| Lock-файлы | L1 mono `packages/animastor-gpu-hub/artifacts.lock.json` sha256 `069b62d931c1ff0e…`; L2 gpu-hub `artifacts.lock.json` sha256 `2a221e3ba626326c…` |
| Пины L2 | worker `618f87a67744802b7e7a0b33a0934ce48d414640`; backend `98c4fbd6823c40420154c69e3fc2e02f273fe3de` |
| Цели D2 | worker `b3f94f42612d0a5dd665956908f545c8d94fad95` (HEAD), backend `a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad` (HEAD) |
| Репозитории | mono `/home/animastor/animastor` (`465453df`, 1 untracked overlay); web `/home/animastor/animastor-web` (`fbc93662`); backend `/home/animastor/animastor-backend` (`a7a8c463`, untracked `freebuff-chat-…`); worker `/home/animastor/animastor-worker` (`b3f94f42`); gpu-hub `/home/animastor/animastor-gpu-hub` (`ecefd0b7`); bare `/home/animastor/repos/animastor-{worker,web,android,backend}.git` (remote `origin` у worktree); GitHub (remote `github`): wt==github, bare отстаёт 1/1/1/4 |
| index.html | prod/mono `276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c` (4 ссылки → 404); web `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c` (ссылки → 200); diff = ровно 4 строки |
| Tool-и | `gpu-hub/scripts/stage-artifacts.cjs` (verify exit 0 на пинах; `--write-lock` — только с разрешением); mono `packages/animastor-gpu-hub/tools/update-artifacts-lock.cjs --check` (exit 0); `tools/standalone-fixture.cjs` (пакует release-зипы из mono-дерева) |
| CI | `.github/workflows/ghcr-release.yml` — **только `workflow_dispatch`** (input `image_tag` — immutable), пины читает из lock, записывает digest в run summary; правила: никогда `:latest`, фиксировать digest до использования |
| Контейнеры (8) | `animastor-backend`, `gpu-hub`, `animastor-proxy`, `animastor-pg`, `animastor-redis` (проект `animastor`) + не-прод: `ollama`, `repro-redis`, `buildx_buildkit_repro0`; тома: named `pg-data`, `redis-data` (никогда не удалять) |
| Bind-mounts prod | backend: `/home/animastor/animastor/data/output`→`/data/output`, `…/data/books`→`/data/books`, `…/backend/ai`→`/app/ai`, `…/backend/tests`→`/app/tests`; proxy: `…/proxy/conf/default.conf`, `…/proxy/conf/.htpasswd` (44 Б), `…/frontends/website`, `…/frontends/app`, `…/docs`, `/etc/letsencrypt` (все ro для proxy) |
| Website runtime | `frontends/website/downloads/{animastor-android-latest.apk,version.json}` и `frontends/website/.well-known` — **только в mono** |
| TLS | `.org` до 2027-01-06; `.in` **`notAfter=Nov 19 11:42:10 2026 GMT`**; 301 `.in→.org` ×3 живы; cron `/etc/cron.d/certbot`; webroot = `frontends/website/.well-known` (ACME) |
| E2E | скрипт `/home/animastor/animastor-backend/docker/e2e/dispatch-task.cjs`; env `E2E_WORKSPACE_ID` (сейчас unset); workflow `…/backend/ai/workflows/tts-qwen-narrator.json` (1626 Б, оба репо); hub `https://animastor.org/gpu`; ключ читается `docker exec gpu-hub printenv GPU_HUB_API_KEY` |
| Живой контракт hub | `GET /gpu/worker-bundle/sha256` → `480af146451ecd9fea4cfa736a96687c3344b7a65749639336991e62273b54e6`, v2.1.1, 8 файлов (контент пина) |
| Откат-команда (подтверждена) | `cd /home/animastor/animastor && docker compose -f docker-compose.yml -f docker/compose/overlay-backend-standalone.yml up -d --force-recreate` |

**Не подтверждено → prerequisite (отмечено ⚠):** layout нового deploy-каталога
и его compose; механизм загрузки release-актива (`standalone-fixture.cjs`
пакует **из mono-дерева**, где setup-contract всё ещё с 404 URL — источник
исправленного zip не определён); renewal-конфиг certbot (читается только root);
`E2E_WORKSPACE_ID` и запущенный worker; содержимое `/etc/letsencrypt` (root).

---

## 1. Карта фаз и точек принятия решений

| Фаза | Содержание | Класс | Ворота перед фазой |
|---|---|---|---|
| **A** | подготовка и резервные копии | B | — |
| **B** | исправление и утверждение index.html | ⏰ окно | **G1**: владелец утверждает 4 целевых URL (D1) |
| **C** | подтверждение происхождения worker-bundle/installer-src | A | — |
| **D** | согласованный repin + republish + CI | ⏰ отдельное разрешение | **G2**: владелец подтверждает цели (D2, после C); **G3**: разрешение на push/CI/publish |
| **E** | проверка Compose, новая структура каталогов | B | G4: утверждённый layout ⚠ |
| **F** | GPU Hub E2E | ⏰ отдельное окно | **G5**: окно + P1–P9 (D4) |
| **G** | TLS и legacy redirect | ⏰ root | **G6**: root-доступ (D5) |
| **H** | production cutover | ⏰ окно | **G7**: единый GO/NO-GO (§7) |
| **I** | post-cutover smoke и наблюдение | после H | — |
| **J** | финальная сверка и закрытие | разрешение на push | **G8**: разрешение bare-sync |

**Правило не-слияния (обязательно):** публикация артефактов (D), E2E (F) и
переключение production (H) — **три разные операции в три разных разрешённых
окна**. Фазы идут не подряд: C независима от B; E можно вести параллельно
C/D; F выполняется на **текущих** артефактах (baseline) либо после H (повтор);
G независима (root); D≠H — новый `GPU_HUB_IMAGE` **записывается в черновик
`.env` (E) и применяется только в H**.

---

## 2. Стандартный блок проверок (STD-CHECK) — выполняется ПОСЛЕ КАЖДОЙ фазы

```bash
df -B1 / | tail -1                                   # свободно >= 15000000000 Б
sha256sum /home/animastor/animastor/packages/animastor-gpu-hub/artifacts.lock.json \
          /home/animastor/animastor-gpu-hub/artifacts.lock.json   # 069b62d9… / 2a221e3b… (меняется ТОЛЬКО в D)
docker ps --format '{{.Names}}\t{{.Status}}'          # uptime без изменений
curl -sSk -o /dev/null -w '%{http_code}\n' --resolve animastor.org:443:127.0.0.1 https://animastor.org/health      # 200
curl -sSk -o /dev/null -w '%{http_code}\n' --resolve animastor.org:443:127.0.0.1 https://animastor.org/gpu/health  # 200
for r in animastor animastor-web animastor-backend animastor-worker animastor-gpu-hub; do
  git -C /home/animastor/$r status --porcelain; done  # baseline: mono — ?? overlay…; backend — ?? freebuff-chat…; прочие — пусто
```

**ABORT STD-CHECK:** свободно < 15 000 000 000 Б; health ≠ 200; контейнер
перезапущен без плана; lock изменён вне фазы D; появилось новое изменение в
git-деревьях.

---

## 3. ФАЗЫ

### Фаза A — подготовка и резервные копии (класс B, без production-изменений)

**A1. Контроль диска (точный)**
- Пререквизиты: нет.
- Команда: `df -B1 / | tail -1` → сравнить свободное с `15000000000`.
- PASS: свободно ≥ `15000000000` (на дату написания: `15138779136`).
- ABORT: меньше порога → этап останавливается; освобождать **только**
  root-journal vacuum (`sudo journalctl --vacuum-size=200M`, отдельное
  разрешение) — **запрещено** удалять Docker images/volumes/backups/монорепо.
- Проверка после: значение записано в журнал выполнения (logbook).
- Откат: не применимо.

**A2. Бэкап конфигурации**
- Пререквизиты: A1 PASS; ⚠ владелец подтвердил место/права (архив содержит
  секреты из `.env` — хранить `chmod 600`, не коммитить, не публиковать).
- Процедура: `tar -czf /home/animastor/backups/cutover-config-$(date +%F).tgz -C /home/animastor/animastor docker-compose.yml docker/compose .env proxy/conf` .
- PASS: артефакт существует, размер > 0, `gzip -t` exit 0.
- ABORT: `gzip -t` ≠ 0 или `.env` недоступен.
- Проверка после: `ls -l backups/cutover-config-*` ; STD-CHECK.
- Откат: не нужен (действие аддитивное); удаление архива запрещено без разрешения.

**A3. Бэкап данных (data/ + PostgreSQL)**
- Пререквизиты: A1 PASS; контейнер `animastor-pg` healthy.
- Команды:
  `tar -czf /home/animastor/backups/cutover-data-$(date +%F).tgz -C /home/animastor/animastor data`
  `docker exec animastor-pg pg_dump -U animastor animastor > /home/animastor/backups/cutover-pg-$(date +%F).sql`
- PASS: тар > 0 и `gzip -t` ok; дамп > 0 и содержит `CREATE TABLE` (`grep -c`).
- ABORT: пустой дамп / ошибка pg_dump → не продолжать фазы B–H.
- Проверка после: `ls -l backups/cutover-*` ; STD-CHECK (pg: uptime не изменился — pg_dump read-only).
- Откат: не нужен (аддитивно).

**A4. Фиксация baseline**
- Процедура: вывод STD-CHECK + `docker system df` (сейчас Images 7 / 12.92GB,
  Containers 8) в logbook cutover.
- PASS: все значения записаны. ABORT: любой параметр вне базовой линии.

---

### Фаза B — исправление и утверждение index.html (⏰ окно; live-контент)

**B1. Разбор четырёх ссылок (до внедрения — по D1)**
- Пререквизиты: владелец инициировал D1.
- Процедура (read-only):
  `diff -u /home/animastor/animastor/frontends/website/index.html /home/animastor/animastor-web/frontends/website/index.html`
  и проверка статусов: `curl -sIL -o /dev/null -w '%{http_code}\n' <url>` для
  кандидатов: `https://github.com/Animastor/animastor`,
  `https://github.com/Animastor/animastor/tree/master/docs`,
  `https://github.com/Animastor/animastor-web`,
  `https://github.com/Animastor/animastor-web/tree/main/docs`.
- PASS: diff ровно 4 строки; целевые URL web-версии → 200; владелец **письменно
  утверждает** эти 4 URL как финальные (это и есть «разобраться с 404»).
- ABORT: diff больше/меньше 4 строк (файл изменился → переаудит); целевые URL
  web-версии не 200 → **не внедрять**, вернуться к владельцу.
- Проверка после: SHA обоих файлов записаны (`276a5fc4…` / `a1900f4e…`).
- Откат: не нужен (read-only).

**B2. Применение (только после G1 и в окне)**
- Пререквизиты: B1 PASS + утверждение владельца; SHA mono == `276a5fc4…`.
- Процедура (применение варианта (а)): привести mono-файл к web-варианту
  так, чтобы `cmp` был пустым:
  `diff -u <mono> <web> > /tmp/idx.patch && patch <mono> < /tmp/idx.patch`
  (равноценна ручной замене ровно 4 строк).
- PASS: `cmp mono web` exit 0; живой `curl https://animastor.org/ | sha256sum`
  == `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c`;
  все 4 ссылок живой страницы → 200.
- ABORT: SHA после применения ≠ `a1900f4e…`; живой ответ ≠ ожидаемому;
  404 сохранился.
- Проверка после: повтор B1-проб по живому URL; STD-CHECK.
- Откат: `git -C /home/animastor/animastor checkout -- frontends/website/index.html`.
- Проверка успешности отката: SHA файла снова `276a5fc4…`; живой ответ снова
  `276a5fc4…`; STD-CHECK.

---

### Фаза C — проверка происхождения worker-bundle/installer-src (класс A, read-only)

**C1. W1 — живой бандл == пин (байтово)**
- Процедура: `curl -sSk --resolve animastor.org:443:127.0.0.1 https://animastor.org/gpu/worker-bundle -o /tmp/wb.tgz && tar -xzf /tmp/wb.tgz -C /tmp/wb`; затем для каждого из 8 файлов
  `git -C /home/animastor/animastor-worker show 618f87a67744802b7e7a0b33a0934ce48d414640:packages/animastor-worker/worker/<f> | cmp - /tmp/wb/animastor-worker/<f>` (включая `.env.example`).
- PASS: 8/8 `cmp` exit 0. ABORT: любой DIFF → переаудит (prod отдаёт не пин).
- Откат: не нужен.

**C2. W2 — штатный staging-verify в /tmp**
- Процедура: клоны в /tmp (`git clone … && git checkout <commit>`), копия
  gpu-hub репо в /tmp; из неё
  `node scripts/stage-artifacts.cjs --worker /tmp/… --backend /tmp/…` (**без** `--write-lock`).
- PASS: на пинах — exit 0 «staging verified against artifacts.lock.json»
  (worker-bundle `4bb0408b…`, installer-src `02fad99e…`/0.1.0); на целях D2 —
  exit 1 с названными tool-ом расхождениями (`417c0ad4…`/`ff27e291…`/0.1.1).
- ABORT: пины не прошли (lock и прод-образ несогласованы) → cutover под
 заппросом, эскалация владельцу; цели прошли на пинах (неожиданно) → переаудит D2.
- Проверка после: STD-CHECK (lock не изменён); `/tmp` очищен.
- Откат: не нужен (всё в /tmp).

**C3. W3 + W4**
- `node /home/animastor/animastor/packages/animastor-gpu-hub/tools/update-artifacts-lock.cjs --check` → exit 0;
  скачать 4 зипа release (`worker-bundle-v2.1.1`, `hub-artifacts-v1`) →
  `sha256sum` == `sha256_asset` L1 (`4cb6f133…`, `c484e197…`, `ae589c10…`, `1fd9f8ad…`).
- PASS: 4/4 MATCH + `--check` exit 0. ABORT: расхождение → стоп, эскалация.

**C4. Гейт G2 — подтверждение целей владельцем**
- На основании C1–C3 и таблицы `20-owner-decisions.md §2.3` владелец
  подтверждает: worker → `b3f94f42`, backend → `a7a8c463`, состав republish.
- PASS: письменное подтверждение зафиксировано в logbook. ABORT: нет — фаза D закрыта.

---

### Фаза D — согласованный repin и republish (⏰ отдельное разрешение G3; НЕ объединять с F и H)

**D0. Диск-гейт под pull нового образа**
- Пререквизиты: G2 + G3; A1 PASS.
- Расчёт: pull нового gpu-hub-образа ≈ 1,6 ГБ (`docker images`: текущий 1,58 ГБ)
  → требуется свободно ≥ `15000000000 + 1600000000 = 16600000000` Б **либо**
  отложить pull на окно H после пополнения (root-journal vacuum даёт ≈3,4 ГБ).
- ABORT: нет ни запаса, ни разрешения на vacuum → фаза D останавливается
  (repin-коммит возможен, pull — нет).

**D1. Repin через штатный tool**
- Пререквизиты: D0 PASS; worktree gpu-hub чист.
- Команды (в `/home/animastor/animastor-gpu-hub`):
  `node scripts/stage-artifacts.cjs --write-lock --worker /tmp/wt-worker --backend /tmp/wt-backend`
  (клоны **на целевых коммитах** D2) → ревью `git diff artifacts.lock.json`.
- PASS: diff содержит только `sources.*.commit` и `artifacts.worker-bundle/installer-src.*` (workflows/install-manifests не тронуты); повторный verify-запуск без `--write-lock` → exit 0; SHA lock изменился (зафиксировать новое значение).
- ABORT: diff затронул иные группы/файлы; tool вышел ≠ 0.
- Проверка после: `git status` (изменён ровно lock) + commit сообщением
  `chore(artifacts): repin worker-bundle/installer-src …` (без push!).
- Откат: `git -C /home/animastor/animastor-gpu-hub checkout -- artifacts.lock.json`
  (до push) → SHA снова `2a221e3b…`; проверка: `sha256sum` + verify exit 0 на пинах.

**D2. Публикация репозитория (push — только с G3)**
- Порядок (конвенция: `origin` = bare, `github` = GitHub):
  `git push origin main` (bare) → `git -C … merge-base --is-ancestor` проверки →
  `git push github main` (FF, без force).
- PASS: `git ls-remote origin refs/heads/main` == `git ls-remote github refs/heads/main` == локальному HEAD.
- ABORT: не-FF (вернуться к D1), любой отказ remote → стоп.
- Откат: `git push github --force-with-lease` **запрещён**; откат = revert-коммит
  с повторным разрешением и повторным verify.

**D3. Сборка нового образа (CI)**
- Процедура: GitHub → workflow `gpu-hub-ghcr-release` → `workflow_dispatch`,
  input `image_tag` = новый immutable тег (напр. `v0.2.0`, ⚠ выбор тега —
  решение владельца); дождаться зелёного прогона; **записать digest из run
  summary** («REMEMBER: Record this digest…»).
- PASS: run зелёный; digest зафиксирован в logbook; локально ничего не создано.
- ABORT: run красный (smoke/artifact gate) → разбор, откат D1/D2.
- Проверка после: `docker pull` НЕ выполняется (см. D0/H); STD-CHECK.

**D4. Republish installer-src (⚠ механизм не подтверждён — prerequisite)**
- Пререквизиты: G3; архив старого актива: `cp`/скачанный в C3 зип
  `ae589c10b47a8bd200daec7f194f5340b8984922bc26e259f11d2095088c7ece`
  → `backups/release-archives/` (аддитивно, без удаления).
- ⚠ Расхождение источника: `standalone-fixture.cjs` пакует из **mono-дерева**,
  а 404-URL исправлен только в backend-repo → владелец выбирает: (i) синхронизировать
  `packages/animastor-installer` mono ↔ backend (правка mono) и паковать штатным
  tool-ом, или (ii) паковать из backend-repo эквивалентным способом (механизм ⚠ не проверен).
- Процедура замены актива — ⚠ не подтверждён (GitHub release upload UI/`gh`):
  выполнить только после письменного подтверждения способа.
- PASS: новый актив скачан, `sha256` зафиксирован, содержимое содержит
  `git clone …/animastor-worker.git` (без 404).
- ABORT: актив не заменяется / старый sha не совпал с закреплённым → стоп.
- Откат: ⚠ тела релизов неизменяемы; откат = публикация ранее заархивированного
  актива (аддитивно) — требует того же разрешения.

**D5. Подготовка новых pin-значений (БЕЗ применения)**
- Процедура: записать `GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:<новый из D3>`
  **только в черновик** `deploy/.env` (фаза E); продакшн `.env` не трогать.
- PASS: `sha256sum /home/animastor/animastor/.env` не изменился; новый digest в logbook.
- ABORT: продакшн `.env` изменён → немедленный откат: восстановить из A2-архива,
  проверка: `grep -E '^(GPU_HUB_IMAGE|BACKEND_IMAGE)=' .env` == прежним значениям.

---

### Фаза E — проверка Compose и новая структура каталогов (класс B, без `up`)

**E1. Создание deploy-каталога (⚠ layout — решение владельца/G4)**
- Пререквизиты: G4 утвердил layout. Предлагаемый (⚠ не подтверждён как
  финальный): `/home/animastor/animastor-backend/deploy/` = `docker-compose.yml`
  (3-way: mono-compose + overlay vs репо-compose) + `overlay-backend-standalone.yml`
  (копия, sha `eac32cb0…`) + `.env` (секреты вносит владелец вручную).
- Процедура: создать каталог, скопировать/свести файлы; bind-mount-источники
  сделать **абсолютными** по таблице констант §0 (data/ai/tests/conf/website/app/docs/letsencrypt).
- PASS: `docker compose --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml config` exit 0; в разрешённом конфиге у backend/gpu-hub — `image: ghcr.io/…@sha256:…` и **нет `build:`** (overlay применился).
- ABORT: `config` падает (секреты/переменные); у backend/gpu-hub есть `build:`
  или `image` без digest (риск запуска stale baked-in) → не продолжать.
- Откат: ⚠ удаление черновика — отдельное разрешение (удаление запрещено);
  практический откат = не использовать каталог.

**E2. 3-way сверка resolved-конфигураций**
- Процедура: `docker compose -f docker-compose.yml -f docker/compose/overlay-backend-standalone.yml config > /tmp/cur.yml`; `docker compose --env-file deploy/.env -f deploy/… config > /tmp/new.yml`; `diff -u /tmp/cur.yml /tmp/new.yml`.
- PASS: различия только в путях deploy и ожидаемых пинах; тома `pg-data`,
  `redis-data`, сеть `animastor_net` объявлены идентично.
- ABORT: исчезает том/сеть/healthcheck; меняются монты данных.

**E3. Dry-run-гейт (read-only)**
- Команда: `docker compose --project-name animastor --env-file deploy/.env -f deploy/… up --dry-run`.
- PASS: `animastor-pg Running`, `animastor-redis Running` (D3: recreate НЕ
  планируется), `animastor-backend Recreate` (ожидаемо), proxy/gpu-hub — по конфигурации.
- ABORT: **pg/redis → Recreate** (стоп: разбор, политика D3) ; любая попытка
  pull/build без согласования (диск).
- Откат: не нужен (dry-run не изменяет; проверено в этапе 20: Images 7/Containers 8).

**E4. Проверка всех mount-источников**
- Процедура: `test -e` для каждого пути из таблицы bind-mounts §0 + `frontends/website/downloads`, `frontends/website/.well-known`, `proxy/conf/.htpasswd`.
- PASS: все существуют. ABORT: любой отсутствует → не переходить к H.

**E5. Сборка web-dist (C9)**
- Процедура: `cd /home/animastor/animastor-web/frontends/app && npm ci && npx vite build` (⚠ требует сети/диска; `npm ci` может добавить ~0,3–1 ГБ — после сборки повторить A1).
- PASS: `dist/` собран; `diff -r` dist vs mono `frontends/app/dist` — расхождения объяснены.
- ABORT: сборка упала; диск < порога после сборки.
- Откат: dist — gitignored, откатывать нечего; в prod остаётся mono-dist.

**E6. Перенос runtime-артефактов website (обязателен для H-переключения монта)**
- Пререквизиты: решение D1 применено; владелец разрешил копирование.
- Процедура: разместить в web-каталоге (вне git): `frontends/website/downloads/{animastor-android-latest.apk,version.json}` и `frontends/website/.well-known/` (копии из mono).
- PASS: пути существуют в web-каталоге; `sha256sum` копий == оригиналам.
- ABORT: любой файл отсутствует/не копируется → H без переключения website-монта (откат к mono-путям).
- Проверка после: STD-CHECK; E4 повторить.

---

### Фаза F — GPU Hub E2E в отдельное окно (⏰ G5/D4; dispatch только здесь)

**F0. Prerequisites (все до старта)**
- `E2E_WORKSPACE_ID` задан владельцем; запущен worker на этот workspace
  (CPU допустим, `gpus:0`); `GPU_HUB_API_KEY` в контейнере (65 символов);
  `audio=0` в `/gpu/health`; диск ≥ порога; health 200/200; окно согласовано.
- PASS: все пункты зелёные. ABORT: любой пункт красный → не начинать.

**F1. Диспатч (ровно одна задача)**
- Снапшот перед: `curl …/gpu/health` (queues/running) + `docker ps` uptime.
- Команда: `cd /home/animastor/animastor-backend && E2E_WORKSPACE_ID=<согласованный> node docker/e2e/dispatch-task.cjs` (дефолтный workflow, короткий текст).
- PASS: `[dispatch] … → hub` принят; result-ключ
  `animastor:result:<build>:e2ebook:e2ech:e2escene:generate` получен ≤ 2400 с.
- **Критерии остановки (D4):** health ≠ 200 дольше 60 с; очередь выросла
  больше чем на +1; отсутствие результата > timeout.
- Проверка после: health 200/200; uptime без изменений; хвост логов gpu-hub без новых ошибок.
- Откат: инфраструктурного нет — задача гаснет по `GPU_TIMEOUT` (hub floor);
  проверка отката: `running=0`, очередь вернулась к снапшоту.

---

### Фаза G — TLS и legacy redirect (⏰ G6/root, D5 — отдельное действие)

**G1. Фиксация текущего состояния (read-only, можно в любой момент)**
- `echo | openssl s_client -servername animastor.in -connect 127.0.0.1:443 | openssl x509 -noout -enddate` → `Nov 19 11:42:10 2026 GMT`; аналогично `animastor.org` → `2027-01-06`;
  301-пробы: `http://animastor.in/`, `https://animastor.in/`, `http://www.animastor.in/` → 301 → `https://animastor.org/`.
- PASS: значения записаны. ABORT: `.in` уже истёк → эскалация (redirect под угрозой).

**G2. Продление (root; отдельное разрешение G6)**
- ⚠ Пререквизит: прочитан renewal-конфиг `/etc/letsencrypt/renewal/*.conf`
  (root) — webroot должен указывать на `frontends/website/.well-known`.
- Процедура: `sudo certbot renew --dry-run` → при успехе `sudo certbot renew`;
  дедлайн: **до 2026-11-19**; если в окне выполняется смена website-монта —
  сначала E6, затем продление (иначе challenge уйдёт не туда).
- PASS: после — SNI `notAfter` сдвинут впереди на ≥ 60 дней; 301 ×3 живы.
- ABORT: dry-run падает (webroot/challenge) → стоп, разбор пути webroot.
- Откат: сертификаты не перезаписываются задним числом; откат = восстановить
  прежний mount webroot (см. H-откат) и повторить.
- **Сохранность redirect:** `proxy/conf/default.conf` (sha-сверка с git) —
  server-block `animastor.in` не удалять; после любой правки conf:
  `docker exec animastor-proxy nginx -t` → PASS «syntax ok» →
  `docker exec animastor-proxy nginx -s reload`; откат = `git checkout` conf + `nginx -t` + reload.

---

### Фаза H — production cutover (⏰ окно; только по GO/NO-GO §7)

**H0. Вход в окно**
- PASS: §7 GO/NO-GO — все пункты ✓ (A–G закрыты, D-решения зафиксированы,
  бэкапы A3 проверены, dry-run E3 чист, диск ≥ `15000000000`, pull-запас
  решён в D0, откат-команда проверена `docker compose config`).
- ABORT: любой пункт ✗ → окно не открывать.

**H1. Снапшот перед**
- `docker ps`, health 200/200, `sha256sum .env docker-compose.yml overlay…`,
  `docker system df`, `df -B1` → в logbook.

**H2. Переключение (минимальный простой)**
- Процедура (из отчёта 13 §5.9, пути подтверждены):
  1) `cd /home/animastor/animastor && docker compose -f docker-compose.yml -f docker/compose/overlay-backend-standalone.yml stop backend nginx`
  2) `cd /home/animastor/animastor-backend/deploy && docker compose --project-name animastor --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml up -d`
- PASS (в пределах 60 с): `docker ps` — 5 контейнеров проекта Up (pg/redis
  не пересоздавались: `docker inspect … .Created` == H1-значениям);
  `/health`=200; `/gpu/health`=200; `docker exec animastor-proxy nginx -t` = ok;
  301 ×3 = ok; `/gpu/worker-bundle/sha256` == зафиксированному (новый digest из
  D3, если D применяется на H; иначе `480af146…`); `docker inspect animastor-backend
  --format '{{.Config.Image}}'` == `BACKEND_IMAGE` из deploy/.env.
- ABORT (любой): health ≠ 200 > 60 с; nginx -t fail; нет 301; pg/redis
  пересозданы; backend crashloop; mount-путь пуст (site ≠ ожидаемому SHA).

**H-R. Откат при частичном отказе (порядок — см. §5.4)**
- Команда (только подтверждённые пути/digest):
  `cd /home/animastor/animastor && docker compose -f docker-compose.yml -f docker/compose/overlay-backend-standalone.yml up -d --force-recreate`
- Проверка успешности отката: 5 контейнеров Up; health 200/200; site sha ==
  `276a5fc4…` (или `a1900f4e…` после B); `/gpu/worker-bundle/sha256` ==
  `480af146…` (прежний пин); `docker inspect` image == `e8152778…`/`daf510ff…`;
  `nginx -t` ok; 301 ×3 ok; pg healthy, данные видны.
- ABORT отката: откат не поднялся → поднимать контейнеры точечно
  (`docker start animastor-pg animastor-redis animastor-backend gpu-hub animastor-proxy`)
  и эскалация; тома в любом случае не трогать.

---

### Фаза I — post-cutover smoke и наблюдение

**I1. Smoke (непосредственно после H, затем через 5 мин)**
- Проверки: STD-CHECK; site `sha256sum` живого тела == утверждённому;
  `GET /health`, `/gpu/health` = 200; `/gpu/worker-bundle/sha256` == записанному;
  `https://app.animastor.org/` 200 (dist); APK
  `https://animastor.org/downloads/animastor-android-latest.apk` 200;
  ACME: `https://animastor.org/.well-known/acme-challenge/` отвечает (не 404 от nginx);
  301 ×3; `nginx -t`; TLS SAN (SNI-проб); логи backend/gpu-hub без ошибок 5 мин;
  PG-счётчики (книги/задачи) == до-окну; очередь `…ws:3317e019…` не растёт.
- ABORT: см. H-ABORT → H-R.

**I2. Повтор E2E (если выбран режим «E2E после repin»)** — только в новом
согласованном окне G5 (D4): условия как F0–F1.

**I3. Наблюдение 24 ч / 7 дней**
- Каждые сутки: `df -B1` (≥ порога), health, uptime, 301, SNI-даты.
- 7 дней без инцидентов = условие J (отчёт 13: старую структуру mono держать
  ≥ 7 дней, ничего не удалять).

---

### Фаза J — финальная сверка и закрытие миграции

**J1. Bare ↔ GitHub (⚠ отдельное разрешение G8 на push)**
- Факт: у всех 4 worktree `origin` = bare (`/home/animastor/repos/animastor-*.git`),
  `github` = GitHub; wt == github; bare отстаёт (worker `618f87a6`, web `c7fe52ac`,
  android `254e2f08`, backend `bce64db3`).
- Процедура (FF-only, из worktree каждого репо): `git push origin main` →
  проверка `git ls-remote origin refs/heads/main` == локальному HEAD == `git ls-remote github refs/heads/main`.
- PASS: 4/4 bare == wt == github. ABORT: не-FF/отказ → стоп (никаких force).
- Откат: референсы bare фиксируются в logbook ДО push (значения выше);
  откат = `git update-ref` в bare на записанный SHA (выполняет владелец,
  отдельное разрешение). Проверка: ls-remote == записанным.

**J2. Прогон C1–C11** — все 11 → PASS (методы: план 19 §2). ABORT: любой не-PASS.

**J3. Закрытие**
- Итоговый отчёт миграции; **переход на новый деплой окончательен** — только
  после ≥7 дней наблюдения (I3) и письтельного решения владельца.
- **Точка невозврата:** удаление/архивация старого mono-стека, его mount-путей
  и pinned-образов `e8152778…`/`daf510ff…` — **запрещено без отдельного
  решения**; до тех пор откат возможен всегда (§5.4).

---

## 4. Специальные разделы

### 5.1 Защита текущего production и старого монорепозитория
- Прод-контейнеры не перезапускаются вне окон H/F; `docker stop/rm/down/restart`
  — запрещены до G7 (кроме точечного stop в H2 по плану).
- `pg-data`/`redis-data` — never touch; `down` в проекте animastor запрещён.
- Mono-репозиторий не изменяется и не удаляется: правки B2 — одна точечная,
  откатываемая `git checkout`; overlay остаётся на месте до J3.
- Прод `.env` не редактируется до H2 (черновик только в deploy/).

### 5.2 Резервирование конфигурации и данных
- A2 (compose+`.env`+proxy-conf, секреты → 600, вне git), A3 (`data/` tar +
  `pg_dump`), архив старого release-актива перед republish (D4), фиксация
  baseline-значений (A4) и референсов bare (J1). Проверка каждого: размер/`gzip -t`/sha.

### 5.3 Точка невозврата
- Жёсткой точки нет: H обратима (H-R), mount обратим, bare-push — FF
  (референсы зафиксированы), republish mitigated архивом актива.
  Фактическая PNR = **удаление mono-структуры/старых образов** (J3) — вне скоупа
  и запрещено без отдельного решения.

### 5.4 Порядок отката при частичном отказе
1. Стоп действий, зафиксировать симптом.
2. Вернуть инфраструктуру: H-R команда из mono (единственный подтверждённый путь).
3. Если менялся index.html (B2) — `git checkout` файла.
4. Если менялся proxy-conf (G2) — `git checkout` + `nginx -t` + reload.
5. Если в H применялся новый `GPU_HUB_IMAGE` — откат вернёт прежний digest
   (прод `.env` из A2-копии, если правился).
6. Проверять после каждого шага: health 200/200 → 301 → `nginx -t` → pg healthy → site sha → worker-bundle sha == `480af146…`.

### 5.5 Как не допустить запуска старых baked-in артефактов
- Только digest-пины в `.env` (никаких `:latest`/moving tags — правило CI);
- всегда включать overlay (сбрасывает `build:`) — иначе `up` может собрать
  backend из mono-дерева; контроль: `config`-вывод E1 (нет `build:`, image = digest);
- `GPU_HUB_IMAGE` обязателен (fallback `animastor-gpu-hub:local` в базовом
  compose — опасен): `up` только с `--env-file .env`;
- CI: `stage-artifacts.cjs` падает на любом несовпадении пина (anti silent-fallback);
- после любого `up`: `docker inspect <c> --format '{{.Config.Image}}'` == digest-ам из `.env`;
- `/gpu/worker-bundle/sha256` сверяется с зафиксированным значением (пин: `480af146…`; после D3 — новый digest); запрещено опираться на `ad20386c…`.

### 5.6 Синхронизация bare ↔ GitHub (J1)
Схема: `worktree --push--> origin(bare)` и `worktree --push--> github`;
контрольные значения до push: bare = `618f87a6`/`c7fe52ac`/`254e2f08`/`bce64db3`,
wt = github = `b3f94f42`/`fbc93662`/`92a56c0d`/`a7a8c463`. Только FF, после
каждого push — сверка трёх указателей. Никаких force; push — с G8.

### 5.7 Сохранение legacy redirect animastor.in → animastor.org
- Server-block `.in` в `proxy/conf/default.conf` (git-контролируемый,
  byte-identical mono↔backend-repo) — не удалять и не править вне G-окна;
- после любых conf-правок: `nginx -t` → reload; проверка 301 ×3 после каждого
  этапа (входит STD-CHECK расширенный: `curl -sIL http://animastor.in/ | head -1`);
- `.in`-серт продлить до 2026-11-19 (G2), т.к. fallback `animastor.in` остаётся
  в старых worker-bundle (`HUB_URL`) до repin-применения.

### 5.8 Продление TLS (G2) с учётом истечения .in
- Дедлайн **2026-11-19 11:42 GMT**; cron уже есть (`/etc/cron.d/certbot`);
  webroot — `frontends/website/.well-known` (переезжает с E6 → проверить
  после любого смены монта); сначала `--dry-run` (root); проверка: SNI-даты +
  301.

### 5.9 Точные проверки после каждого этапа
STD-CHECK (§2) + специфичные проверки фазы (Pass-блок каждой процедуры) +
запись результатов в logbook cutover.

---

## 6. Disk space (точные значения)

| Параметр | Значение |
|---|---|
| Свободно (2026-10-12, последний `df -B1`) | **15 138 779 136 Б** |
| Порог этапа | **15 000 000 000 Б** (запас 138 779 136 Б — <1%) |
| Порог перед pull нового образа | 16 600 000 000 Б (учёт gpu-hub ≈1,6 ГБ) |
| Разрешённые способы пополнения | root `sudo journalctl --vacuum-size=200M` (≈3,4 ГБ, отдельное разрешение); кеш в /tmp |
| **Запрещено без отдельного разрешения** | `docker image prune`/удаление images, `docker volume prune`, удаление `backups/*`, удаление mono-репозитория, `rm` каких-либо рабочих данных |
| Правило | перед **каждой** фазой: `df -B1` ≥ порога; ниже → ABORT фазы |

---

## 7. Единый GO/NO-GO checklist перед фазой H

| # | Пункт | Источник |
|---|---|---|
| 1 | `df -B1` ≥ 15 000 000 000 (+ запас под pull, если образ ещё не локален) | A1/D0 |
| 2 | Бэкапы `data/` + `pg_dump` + конфига сделаны и проверены (`gzip -t`, размер) | A3/A2 |
| 3 | D1 исполнен: живой site sha == `a1900f4e…`, все GitHub-ссылки 200 | B2 |
| 4 | D2 подтверждён; W1–W4 зелёные; целевые коммиты зафиксированы | C1–C4 |
| 5 | D3: новый digest записан; прод `.env` НЕ менялся; deploy `.env` содержит новый пин | D3/D5 |
| 6 | D4: republish решён/выполнен или явно отложен (зафиксировано) | D4 |
| 7 | E1–E4: `config` чист (нет `build:`, image=digest), dry-run: pg/redis Running, все mount-источники существуют | E |
| 8 | E6: apk + `.well-known` в web-каталоге (если монтируется web) | E6 |
| 9 | F: E2E baseline зелёный **или** владелец явно принял риск отложенного E2E | F (D4) |
| 10 | G: `.in` не истёк, продление запланировано/выполнено, 301 ×3 живы | G |
| 11 | STD-CHECK: health 200/200, uptime стабилен, lock/-git == baseline | §2 |
| 12 | Откат-команда проверена `docker compose config` с mono-путями; mono-копии compose/.env не тронуты | H-R |
| 13 | Оператор на связи, окно согласовано, logbook открыт | G7 |

**NO-GO = любой пункт не выполнен.**

---

## 8. Матрица рисков и зависимостей

| Риск | Вероятность | Влияние | Митигация | Зависимость |
|---|---|---|---|---|
| Диск < порога в окне (запас 138 МБ!) | высокая | критично — `up` упадёт/заполнит диск | D0: заранее root-vacuum; запрет prune без разрешения | A1, G6 |
| Pull нового gpu-hub-образа не влезает | средняя | критично в H | порог 16,6 ГБ перед pull; pre-pull после vacuum | D0 |
| Случайный recreate pg/redis | низкая (dry-run чист) | простой, данные целы | E3-гейт «pg/redis должны быть Running»; stop только в окне | D3 |
| Запуск со `build:` из mono (stale baked-in) | средняя | устаревший контент в проде | E1: `config` без `build:`; overlay обязателен; проверка image digest после up | E, H |
| E2E зависает в очереди (воркеров нет) | высокая | тест не пройдён | F0 все P1–P9; abort по health/очереди | D4, G5 |
| `.in` серт истечёт (19.11) | средняя | redirect/fallback сломаются | G2 до дедлайна; webroot после E6 | E6, G6 |
| ACME webroot потерян при смене монта | средняя | продление упадёт | E6 + I1-проверка `.well-known` | E6 |
| Republish без архива старого актива | низкая | невозврат старых байтов | D4: архив до замены | G3 |
| Несогласованный repin (lock ≠ CI) | низкая | CI красный/стale образ | только штатный `--write-lock`; verify exit 0; ревью diff | C, G3 |
| Слияние D/F/H в одну операцию | средняя | невозможно локализовать отказ | правило не-слияния §1; разные G-гейты | все |
| bare/github расхождение после push | низкая | потеря локального зеркала | фиксация референсов до push; FF-only; 3-сторонняя сверка | G8 |
| Секреты в deploy/.env утеряны/неверны | средняя | `config` падает (`:?`) | E1 `config`-гейт; секреты вносит владелец | G4 |

**Критические зависимости:** H ← {E1–E6, G, (D-применение), GO-чеклист};
D ← {C, G2, G3, D0-диск}; F ← {G5, P1–P9}; G2-после-смены-монта ← E6;
J ← {I3 ≥7 дней, G8}; B2 ← G1.

---

## 9. Команды, запрещённые до соответствующего разрешения

| Команда / действие | Запрещено до |
|---|---|
| `git push` (любой remote: origin/github), `--force`, `update-ref` | G8 |
| `stage-artifacts.cjs --write-lock`, правки lock-файлов | G3 |
| Загрузка/замена release-активов, `gh release …` | G3 |
| `docker compose up/stop/restart/down/rm` (все, включая `-p animastor-cutover-test`) | G7 (H2 — только stop/up из плана) |
| Ручной `docker restart/stop/rm` прод-контейнеров; `docker logs -f` в фоне | G7 |
| `node docker/e2e/dispatch-task.cjs` (dispatch) | G5 |
| `certbot renew` (без `--dry-run`), любые правки `/etc/letsencrypt`, `nginx -s reload` | G6 |
| `docker image prune`, `docker volume prune`, `rm` images/volumes/backups/mono | отдельное разрешение (не выдаётся этим runbook) |
| `journalctl --vacuum*` (root) | отдельное разрешение (D5/A1-violation path) |
| `docker compose down` в проекте animastor | G7 |
| Правки `.env`, `proxy/conf/default.conf`, DNS-записей | G7 / отдельное разрешение |
| `sudo …` любые | G6 |

---

## 10. Проверка согласованности плана (выполнена при подготовке)

1. **Откаты используют только подтверждённые пути/digest:** mono-compose +
   overlay (sha `eac32cb0…`), `.env`-копия A2, образы `e8152778…`/`daf510ff…`
   (проверены `docker inspect` в этапах 13/20), site-SHA `276a5fc4…`,
   worker-bundle sha `480af146…`. Неподтверждённые элементы (deploy-layout,
   механизм upload актива, renewal-конфиг) помечены ⚠ как prerequisite и
   **не используются в откат-командах**.
2. **Порядок фаз не противоречит:** D (публикация) ≠ F (E2E) ≠ H (переключение)
   разнесены гейтами G3/G5/G7; F на текущих артефактах валиден и без D
   (D-альтернатива — I2); H не требует D (иначе используется прежний пин —
   зафиксировано в H2-проверке); E6 выполняется до любой смены website-монта
   и до G2-продления после смены.
3. **Диск:** каждый этап открывается `df -B1`-порогом (§6); pull-образа
   обложен отдельным порогом 16,6 ГБ.
4. **Запреты соблюдены:** ни одна команда §3 на дату написания не выполнялась
   (documentation-only); откат-команды «для проверки» не запускались.
