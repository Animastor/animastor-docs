# Animastor — Этап 26: GIT SYNC AND DEPLOY LAYOUT PREPARATION

Дата: 2026-10-12 (UTC, окно 06:26–06:55). Итог: **PASS** (G8-синхронизация 4/4;
deploy-layout подготовлен как план — содержимое `deploy/` НЕ создавалось, т.к. G4
не утверждён; Redis/TLS — только read-only).

Что выполнено: preflight-сверка резервных копий этапа 25 и refs → G8-синхронизация
четырёх bare-репозиториев с опубликованным `main` (без `git push`, без force) →
подготовка целевой структуры каталогов и плана перемещений → read-only исследование
Redis-ключей `queue:image` / `event-journal` → фиксация TLS-статуса и механизма
republish → верификация.

Что НЕ выполнялось: production cutover, Compose switch, рестарты, dispatch,
repin/republish, `git push`, удаления данных, удаление/правка монорепозитория,
изменения lock-файлов/DNS/TLS/секретов, FLUSH, `docker system prune`.

---

## 1. PREFLIGHT (до любых изменений)

### 1.1 Диск (точный замер, `df -B1 /`)

| Момент | Всего | Занято | Свободно |
|---|---|---|---|
| Вход в этап (06:26) | `105496965120` | `75572342784` | **`25407520768`** |
| После sync (финал, §6) | `105496965120` | `75576414208` | **`25403449344`** |

Порог этапа `15000000000` Б выполнен с запасом ≈10,4e9 Б.

### 1.2 Целостность резервных копий этапа 25 (все проверки — read-only)

| Проверка | Результат |
|---|---|
| `sha256sum -c backups/backup-manifest-2026-10-12.sha256` | **9/9 OK** (pg dump, pg schema, data.tgz, config.tgz, git_repos, git-worktrees, git-untracked, git-refs-status, redis.rdb) |
| `gzip -t` для 5 архивов (data/config/repos/worktrees/untracked) | **5/5 OK** |
| `cutover-pg-2026-10-12.dump` | магия `PGDMP`, TOC-строк `278` (через `pg_restore --list` в контейнере) |
| PG-счётчики | таблиц `41`, `users=83`, `workspaces=393` == baseline |
| Старый монорепозиторий в backup | в `git_repos_*.tar.gz` присутствует `repos/animastor.git/HEAD` ✓ |
| Незатреканные файлы в backup | в `git-untracked_*.tar.gz`: `overlay-backend-standalone.yml` и `freebuff-chat-2026-10-11T07-41-12.445Z.md` ✓ |
| refs-файл `git-refs-status-2026-10-12.txt` == текущим refs | совпадение по всем 6 bare и worktree-HEAD ✓ |

### 1.3 Снимок refs/SHA до изменений (зафиксирован в backup)

Файл: `/home/animastor/backups/git-refs-pre-sync-stage26-2026-10-12.txt`
(4 254 Б, sha256 `b2eaeaa7cb86c2596e6cd55b0eff7f3dbc3f2f31e74a4b27596f4d0300795728`).

| Репо | bare `refs/heads/main` | bare `refs/remotes/github/main` | wt HEAD | wt `origin/main` | GitHub `main` (live ls-remote) | Отставание bare |
|---|---|---|---|---|---|---|
| backend | `bce64db3731414b9755e7b5e2f902cb3cf59f772` | `bce64db3…` | `a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad` | `bce64db3…` | `a7a8c463…` | **4** |
| web | `c7fe52ac3559456ebb1cc519c30151281941acbc` | `c7fe52ac…` | `fbc93662035df84c8e103df0d0706800aa96cba1` | `c7fe52ac…` | `fbc93662…` | **1** |
| android | `254e2f084342fd69214b4a3a45dfb7b27df84e2f` | `254e2f08…` | `92a56c0ddce1a796d593f4e3a3462ca17ddd2c3f` | `254e2f08…` | `92a56c0d…` | **1** |
| worker | `618f87a67744802b7e7a0b33a0934ce48d414640` | `618f87a6…` | `b3f94f42612d0a5dd665956908f545c8d94fad95` | `618f87a6…` | `b3f94f42…` | **1** |

Прочие refs (вне целевой группы, зафиксированы и не менялись):
- mono bare: `c21.4-physically-extract-analysis-from-backend=465453df`, `master=64127b9e`, `tmp/parser-audit-backup=db5ff61f`;
- gpu-hub bare: `master=ecefd0b7`, `refs/remotes/github/master=ecefd0b7` (wt == bare == GitHub).

Dirty/untracked до изменений (== baseline этапов 24–25):
- mono: `?? docker/compose/overlay-backend-standalone.yml` (sha256 `eac32cb0bb7f1f6a806e03b3c64fd052808ac7a569345f8377a1af35579a36a1`);
- backend: `?? freebuff-chat-2026-10-11T07-41-12.445Z.md` (sha256 `2134973a625895c461838018d5c54b1c947c79f328906d5ad1353050d2106727`);
- web / android / worker / gpu-hub: чистые.

**Предковость (ancestry): `merge-base --is-ancestor origin/main github/main` — YES ×4**
(берётся из worktree, где присутствуют оба указателя и объекты). GitHub-ветки:
`refs/heads/main` — единственная ветка во всех четырёх репо (теги GitHub:
`backend: hub-artifacts-v1 → bce64db3`, `worker: worker-bundle-v2.1.1 → 618f87a6` —
в bare отсутствуют, см. §2.5).

**Вывод preflight: несоответствий с baseline нет → изменений разрешены.**

---

## 2. G8-SYNC

### 2.1 Схема (учтена)

- `origin` у worktree → локальный bare (`/home/animastor/repos/animastor-*.git`);
- `github` у worktree → GitHub (`git@github.com:Animastor/animastor-*.git`);
- bare сам содержит remote `github` (fetch-refspec `+refs/heads/*:refs/remotes/github/*`);
- до этапа: `wt == github`, bare отставал на 1/1/1/4, tracking-refs в bare и в
  worktree (`refs/remotes/github/main`, `refs/remotes/origin/main`) отставали так же.

### 2.2 Безопасная последовательность и выбор метода

Задача запрещает `git push` (любой remote) → синхронизация выполнена **без единого
push**, через `fetch` с явными refspec:

1. `git -C <bare> fetch --no-tags github refs/heads/main:refs/heads/main refs/heads/main:refs/remotes/github/main`
   — обновляет `refs/heads/main` bare и его tracking-oref; **без `+` в refspec →
   git сам отклоняет не-fast-forward** (встроенный контроль ancestry, force невозможен);
2. `git -C <worktree> fetch --no-tags origin refs/heads/main:refs/remotes/origin/main`
   — обновляет tracking-oref worktree до нового bare-`main`;
3. трёхсторонняя сверка: bare `main` == wt `HEAD` == `ls-remote github main`;
4. `git status` worktree — чистота/сохранность untracked.

`--no-tags` гарантирует, что создаются ровно два записанных ref на репо (никаких
автосозданий тегов). Предварительная проверка ancestry (§1.3) + FF-only семантика
fetch = «не перезаписывать refs без проверки ancestry» выполнены; порядок:
preflight → сохранение исходных refs в backup → синхронизация.

### 2.3 Ход синхронизации (по одному репо, все четыре одинаково)

Пример backend (полный вывод аналогичен для web/android/worker):

```
From github.com:Animastor/animastor-backend
   bce64db..a7a8c46  main       -> main
   bce64db..a7a8c46  main       -> github/main
From /home/animastor/repos/animastor-backend
   bce64db..a7a8c46  main       -> origin/main
```

Все 12 fetch-обновлений — fast-forward (`a..b`, без `+`, exit 0). Ошибок, повторных
попыток и force-вариантов не было.

### 2.4 Результат после синхронизации (4/4 PASS)

| Репо | bare `main` | bare `github/main` (tracking) | wt HEAD | wt `origin/main` | GitHub live | Статус-дерева |
|---|---|---|---|---|---|---|
| backend | `a7a8c463…` | `a7a8c463…` | `a7a8c463…` | `a7a8c463…` | `a7a8c463…` | только pre-existing `?? freebuff-chat-…` |
| web | `fbc93662…` | `fbc93662…` | `fbc93662…` | `fbc93662…` | `fbc93662…` | чисто |
| android | `92a56c0d…` | `92a56c0d…` | `92a56c0d…` | `92a56c0d…` | `92a56c0d…` | чисто |
| worker | `b3f94f42…` | `b3f94f42…` | `b3f94f42…` | `b3f94f42…` | `b3f94f42…` | чисто |

Дополнительные проверки отсутствия потерь:
- старые SHA (`bce64db3`/`c7fe52ac`/`254e2f08`/`618f87a6`) после sync: `cat-file -e` → **существуют**; `merge-base --is-ancestor <старый> main` → **YES ×4** (ничего не перезаписано, история только пополнилась);
- `git fsck --no-progress` во всех четырёх bare → **rc=0, без повреждений**;
- количество refs во всех 6 bare: **до 13 → после 13** (никакие refs не потеряны; изменены только 8 = 4 `main` + 4 tracking);
- mono не тронут (3 ветки, HEAD `465453df`), gpu-hub не тронут (2 ref, `ecefd0b7`) — GPU Hub **не синхронизировался** (не входит в согласованный список backend/web/android/worker; его bare и так == GitHub);
- post-sync снимок: `/home/animastor/backups/git-refs-post-sync-stage26-2026-10-12.txt` (sha256 `3bc02c8e51541c7a16ebfa87d71bb88bec5f068c2138675a01264f9544f20f2b`).

### 2.5 Откат (задокументирован, не выполнялся)

Исходные значения зафиксированы в двух местах: `backups/git-refs-status-2026-10-12.txt`
(этап 25) и `backups/git-refs-pre-sync-stage26-2026-10-12.txt` (этап 26).
Команда отката (выполняет владелец, отдельное разрешение):

```
git -C /home/animastor/repos/animastor-backend.git update-ref refs/heads/main bce64db3731414b9755e7b5e2f902cb3cf59f772
# … аналогично web c7fe52ac…, android 254e2f08…, worker 618f87a6…
```

При отказе fetch на не-FF последовательность останавливается (ничего не записано).

### 2.6 Замечания / вне скоупа

- GitHub-теги (`hub-artifacts-v1`, `worker-bundle-v2.1.1`) в bare отсутствуют и **не
  создавались**: согласованная цель этапа — `refs/heads/main` (веток на GitHub,
  кроме `main`, нет). При желании — `git -C <bare> fetch --no-tags github 'refs/tags/*:refs/tags/*'` (additive, отдельное решение).
- Монорепозиторий не удалялся, не переписывался, не публиковался (на GitHub его нет — `Animastor/animastor` → Repository not found, как и раньше).
- Метод отличается от runbook J1 (`git push origin main` из worktree): push запрещён
  инструкцией этапа, поэтому выбран эквивалентный по результату `fetch`-путь;
  PASS-критерий J1 (4/4 bare == wt == github) выполнен.

---

## 3. DEPLOY LAYOUT

### 3.1 Целевая структура (по runbook E1/E6/H2; создание содержимого — не выполнялось)

```
/home/animastor/animastor-backend/deploy/        ← G4 (НЕ утверждён — см. 3.2)
├── docker-compose.yml            (3-way: mono-compose + overlay vs репо-compose,
│                                  bind-mount-источники — абсолютные, §0 runbook)
├── overlay-backend-standalone.yml (копия, sha256 eac32cb0…)
└── .env                          (секреты вносит владелец вручную)
```

Существующие рабочие деревья (используются как есть, без переклонирования):
`animastor-backend` (`a7a8c463`), `animastor-web` (`fbc93662`), `animastor-android`
(`92a56c0d`), `animastor-worker` (`b3f94f42`), `animastor-gpu-hub` (`ecefd0b7`),
монорепо `animastor` (`465453df` — остаётся на месте).

### 3.2 Почему содержимое `deploy/` НЕ создавалось

`deploy/` отсутствует (`ls` → No such file); по runbook E1 создание deploy-каталога
отнесено к «layout — решение владельца/G4», а по аудиту 22 (§6, п.3) **G4 не
утверждён** (BLOCKED). Инструкция этапа предписывает при неоднозначности
остановиться и зафиксировать причину → содержимое каталога готовится только после G4;
здесь зафиксирована целевая структура, состав файлов, все перемещения и способы
отката. Ничего не клонировалось, не перемещалось, mounts/Compose не менялись,
сервисы не переключались.

### 3.3 План будущих перемещений (источник → назначение → зависимости → откат)

| # | Что | Источник | Назначение | Зависимости (гейты) | Откат |
|---|---|---|---|---|---|
| M1 | Создание `deploy/` + свод compose | `animastor/docker-compose.yml`, `animastor/docker/compose/overlay-backend-standalone.yml` (`eac32cb0…`), `animastor-backend/docker-compose.yml` | `animastor-backend/deploy/{docker-compose.yml, overlay-backend-standalone.yml, .env}` | **G4** (утверждённый layout); `.env` вносит владелец; абсолютные bind-пути §0; PASS E1: `compose config` exit 0, без `build:`, image=digest | практический откат = не использовать каталог (удаление — отдельное разрешение) |
| M2 | Website runtime-артефакты (E6) | mono `frontends/website/downloads/animastor-android-latest.apk` (`0b7a1333…`, 12 505 721 Б) и `version.json` (`8dbbfe10…`, 238 Б); mono `frontends/website/.well-known/` (acme-challenge) | `animastor-web/frontends/website/downloads/…` и `…/.well-known/` (вне git) | решение D1; разрешение владельца на копирование; PASS: `sha256sum` копий == оригиналам | не переключать website-монт → остаются mono-пути (H без M2) |
| M3 | index.html (B2) | web `frontends/website/index.html` (`a1900f4e…`) | mono `frontends/website/index.html` (живой контент; `276a5fc4…` с 4 битыми ссылками) | **G1**: владелец утверждает 4 целевых URL; окно | `git -C animastor checkout -- frontends/website/index.html` |
| M4 | Переключение production (H2) | `cd animastor && compose stop backend nginx` → `cd animastor-backend/deploy && compose --project-name animastor --env-file .env up -d` | тот же проект `animastor` | G7 (GO/NO-GO §7), E1–E5 PASS, диск ≥ порога | H-R из mono: `compose -f docker-compose.yml -f docker/compose/overlay-backend-standalone.yml up -d --force-recreate` |
| M5 | `.env`-черновик под новый `GPU_HUB_IMAGE` | значения D2/D3 | **только** `deploy/.env` (прод-`.env` не правится до H2) | G2/G3 (repin), окно D | прод-`.env` остаётся прежним → H-R возвращает прежний digest |

Не выполнялось и не планировалось на этом этапе: перенос/клонирование репозиториев,
правка текущего production compose, любые `up`.

### 3.4 Готовность mount-источников (read-only сверка, аналог E4)

Все источники из таблицы bind-mounts §0 существуют: `data/output`, `data/books`,
`backend/ai`, `backend/tests`, `proxy/conf/default.conf`, `proxy/conf/.htpasswd`,
`frontends/website`, `frontends/app`, `docs`, `/etc/letsencrypt`, mono
`downloads/{apk,version.json}`, mono `.well-known` — **13/13 EXISTS**.

Фактический набор mounts живых контейнеров == runbook §0 (backend 4 rw, proxy 5 ro
+ letsencrypt ro), не менялся.

Пробелы web-worktree для будущего M2 (зафиксированы, не копировались):
- `animastor-web/frontends/website/downloads/version.json` — уже существует и
  байт-идентичен mono (`8dbbfe10…`);
- `animastor-web/frontends/website/downloads/animastor-android-latest.apk` — **отсутствует**;
- `animastor-web/frontends/website/.well-known/` — **отсутствует**.

### 3.5 Статус pre-existing файлов (сохранить — подтверждено)

| Файл | Где | Статус | Контроль |
|---|---|---|---|
| `docker/compose/overlay-backend-standalone.yml` | mono, **untracked** | **сохранить** (нужен до J3 как часть откат-команды H-R; войдёт в `deploy/` копией по M1) | sha256 `eac32cb0bb7f1f6a806e03b3c64fd052808ac7a569345f8377a1af35579a36a1` == baseline; в backup `git-untracked-*.tar.gz` |
| `freebuff-chat-2026-10-11T07-41-12.445Z.md` | animastor-backend, **untracked** | **сохранить** (pre-existing; не коммитить и не удалять без решения владельца) | sha256 `2134973a625895c461838018d5c54b1c947c79f328906d5ad1353050d2106727`; в backup `git-untracked-*.tar.gz` |

Оба файла присутствуют до и после этапа (см. §6, dirty-статус).

---

## 4. REDIS DATA (read-only; ключи не удалялись, FLUSH не выполнялся, конфиг не менялся)

### 4.1 `animastor:queue:image` — что это

- **Тип/содержимое:** `list` из payload-ов image-джобов (ComfyUI workflow JSON с
  `job_id` вида `import_<ts>_<ts>_ch-…_sc-…_iu-…:iu_image`); `LLEN=8`, `TTL=-1`
  (не истекает). Второй ключ: `animastor:queue:image:ws:3317e019-879d-4dfb-a9f8-edc9b72da7f4`
  — приоритетная workspace-очередь (`LLEN=252`).
- **Назначение по коду:** producer — backend (`gpu-dispatcher`/`worker-routes`
  маршрутизуют в `queue:{type}` / `queue:{type}:ws:{id}` / `queue:{type}:policy:{id}`);
  consumer — gpu-hub (pop по приоритетам ws → system/policy); глубина system-пула
  публикуется в `/gpu/health` (`image: await redis.llen("animastor:queue:image")`).
- **Возраст элементов:** `job_id`-метки = **2026-07-11 и 2026-07-12** (все 8 штук) —
  давние невостребованные задачи; workspace-очередь — 252 элемента.

### 4.2 `animastor:event-journal:*` — что это

- **Тип/содержимое:** 10 `list`-ключей `animastor:event-journal:<book>:<ch>:<sc>`
  (append-only журнал событий жизненного цикла сцен: `SCENE_*/IMAGE_*/AUDIO_*/
  VIDEO_*/RECOVERY_*`, запись `RPUSH` в `backend/src/state/event-journal.js`);
  длины от 9 740 до 515 139 событий; отдельный служебный ключ
  `animastor:event-journal:_system:_recovery:_cycle` (249 914 событий,
  последняя запись **2026-10-12 06:52** — пишется прямо сейчас).
- **TTL:** в коде заявлен «7 дней» (возвращается поле `ttl: 604800`), однако
  `EXPIRE` не вызывается — **фактически TTL = -1 у всех ключей** (бессрочное хранение).

### 4.3 Классификация (по требуемым категориям)

| Данные | Пересоздать? | Диагностика? | Влияние на незавершённые задачи |
|---|---|---|---|
| `queue:image` (8) + `queue:image:ws:…` (252) | **Нет** (payload есть только в Redis, не в PG) | да — показывает зависшие/исторические задачи | **Да**: при запуске worker эти job-и будут извлечены в работу (старые задачи от 11–12.07 могут уйти в dispatch). Оставлять как есть; любое очищение — отдельное решение владельца |
| `event-journal:*` сценн (9 ключей) | **Нет** (append-only история, не восстанавливается из PG) | **основная ценность** — трассировка событий сцен | **Косвенно да**: recovery/reconciliation сканирует journal (`journalPattern animastor:event-journal:*`) для обнаружения сцен; удаление меняет поведение восстановления. Не трогать |
| `event-journal:_system:_recovery:_cycle` | нет | да (лог циклов recovery) | пишется каждым recovery-циклом (актуален) — не трогать |

Рекомендация (не выполнялась): ротация старых journal-ключей и drain июльских
очередей — только отдельным разрешением владельца; отмечено расхождение
«заявленный 7-дневный TTL vs фактический -1».

---

## 5. TLS / REPUBLISH

### 5.1 Текущий статус сертификатов (SNI через 127.0.0.1:443, без root)

| Домен | notAfter | SAN | До истечения |
|---|---|---|---|
| `animastor.org` | **Jan 6 18:29:48 2027 GMT** | admin/app/www/animastor.org | ≈86 дней |
| `animastor.in` (+www) | **Nov 19 11:42:10 2026 GMT** | admin/animastor/app/www.animastor.in | **38 дней** (дедлайн G2/G6) |

### 5.2 Renewal-инфраструктура (прочитано без root; ключи/`live/` не читались)

- `/etc/letsencrypt/renewal/animastor.in.conf` (644): `authenticator = webroot`,
  `server = acme-v02`, `account = dcae1002…`, **`webroot_path = /home/animastor/animastor/frontends/website`**
  (mono-путь!); `webroot_map` содержит только `admin.animastor.in` → остальные домены
  берут `webroot_path`.
- `/etc/letsencrypt/live` — `drwx------ root` (ключи только root).
- Фактический планировщик: **`certbot.timer` = active** (следующий запуск
  2026-10-12 07:42 UTC, интервал 12 ч); `/etc/cron.d/certbot` — cron отключён при
  systemd («NOT be executed if systemd» → действует таймер). Бинарь `/usr/bin/certbot`.

**Точные prerequisites для renewal `.in` (G6/D5, root — здесь не выполнялось):**
1. root-доступ (запись в `/etc/letsencrypt/{live,archive,renewal}`);
2. webroot `frontends/website/.well-known/acme-challenge` отвечает по HTTP от nginx
   для `animastor.in`/`www.`/`app.`/`admin.` (сейчас webroot = mono-каталог — после
   любого website-переезда E6 сначала сохранить путь/webroot, затем продлевать);
3. сначала `certbot renew --dry-run` (проверка ACME-челленджа без записи);
4. затем `certbot renew` / `certbot renew --cert-name animastor.in` до **2026-11-19 11:42 GMT**;
5. после: SNI-проба `notAfter` + 301 ×3 + `nginx -t`.
Ничего из этого (DNS/TLS/конфиги) на этапе не менялось.

### 5.3 Оставшийся механизм republish ZIP (без запуска, без токенов)

По аудиту 22 §4.2 (подтверждено повторным осмотром):
- `packages/animastor-gpu-hub/tools/standalone-fixture.cjs` — **генератор
  локального стенд-ина** (режим `assets-from-release` качает **из** release URL и
  сверяет `sha256_asset`), не загрузчик;
- загрузчики/верификаторы (`fetch-pinned-assets.sh`, `verify-staged-artifacts.sh`,
  `g5-artifact-integrity.sh`) — только чтение; автоматических загрузчиков
  (`gh release upload`/octokit/…) в mono/tools и packages — **0**;
- фактическая публикация 4 zip v2.1.1 выполнялась **вручную** (GitHub UI/`gh`);
  тела релизов immutable → замена актива = новая публикация = **решение D4** (способ
  упаковки исправленного installer-src + способ загрузки + архив старого актива).
Републикация на этапе **не выполнялась** (нет токенов, нет публикаций, артефакты
не трогались).

---

## 6. VERIFICATION (после изменений)

| Проверка | Результат |
|---|---|
| bare `main` == wt HEAD == GitHub `main` | **4/4 EQUAL** (значения в §2.4) |
| GitHub refs не менялись (нет push) | `ls-remote` после sync == до sync; новых refs/веток нет ✓ |
| Потерянные коммиты | старые SHA существуют в bare, являются предками новых (`cat-file -e` + `merge-base --is-ancestor` → YES ×4); `fsck` rc=0 ×4 ✓ |
| Потерянные/untracked-файлы | все refs на месте (13→13); untracked: mono `?? overlay…`, backend `?? freebuff-chat…` — **сохранены** (как baseline), новых нет ✓ |
| Репозитории вне списка | mono и gpu-hub bare/worktree не изменены ✓ |
| Lock-файлы | L1 `069b62d931c1ff0e…`, L2 `2a221e3ba626326c…` == baseline ✓ |
| Production-контейнеры | 7 шт., uptime/StartedAt без изменений (backend Up 41h, gpu-hub Up 3d, proxy Up 5w, pg/redis Up 6w healthy) — **ни один не перезапускался** ✓ |
| `/health`, `/gpu/health` | **200 / 200** ✓ |
| Compose mounts | backend 4 rw + proxy 6 ro == runbook §0, не менялись ✓ |
| Свободное место | **`25403449344` Б ≥ `15000000000`** (порог) ✓ |
| Redis | ключи `queue:image`/`event-journal` на месте, FLUSH не выполнялся ✓ |
| DNS/TLS/секреты | не менялись; SNI-даты §5.1 ✓ |

Артефакты этапа: `backups/git-refs-pre-sync-stage26-2026-10-12.txt`,
`backups/git-refs-post-sync-stage26-2026-10-12.txt` (additive, ничего не удалено).

---

## 7. Ограничения (что не выполнялось)

| Действие | Статус |
|---|---|
| `git push` (origin/github), force, `+`-refspec, `update-ref` | **не выполнялись** (синхронизация — через FF-fetch) |
| production cutover, Compose switch, `up/down/restart/stop` | не выполнялись |
| dispatch / E2E / repin / republish / публикации | не выполнялись |
| удаление данных/репозиториев/монорепо, `prune` | не выполнялись |
| Redis: DEL/FLUSH/правка конфига/перезапуск | не выполнялись (только TYPE/LLEN/LRANGE/TTL/SCAN) |
| DNS/TLS/секреты, renewal-конфиги | не менялись (чтение 644-конфигов — без секретов) |
| создание `deploy/`, клонирование репо, перенос mono | не выполнялись (G4, см. §3.2) |
| touch `artifacts.lock.json` | не выполнялся |

---

## 8. Блокеры и следующие шаги

1. **G4** — утвердить deploy-layout → выполнить M1 (создание `deploy/` + `compose config`-сверка в окне).
2. **D4** — механизм republish zip-активов (секреты/загрузка) → после этого D2/D3/G3.
3. **G6/D5** — root-продление `.in` до **2026-11-19 11:42 GMT** (`--dry-run` → renew → SNI + 301); после любого website-переезда проверить webroot.
4. Опционально: перенести GitHub-теги в bare (additive fetch, отдельное решение); owner-решение по июльским очередям и ротации journal (7-дневный TTL не применяется фактически).
5. Вне этапа: off-host перенос копий (блокер B1), restore-тест (окно), мониторинг диска.
