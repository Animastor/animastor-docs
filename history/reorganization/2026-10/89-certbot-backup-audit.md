# Stage 89 — Certbot Diagnosis & Backup Coverage Audit

Дата: 2026-10-20
Режим: READ-ONLY диагностика (ничего не переключалось, не удалялось, не изменялось).
Отчёты Stage 87 и Stage 88 не изменялись. Production, контейнеры, Git, конфигурации,
сертификаты и файлы приложения не менялись.

---

## 0. Итоговый статус

**PASS** — обе части этапа выполнены; причина сбоя Certbot установлена и подтверждена
системным журналом + логом certbot; инвентаризация резервных копий проведена с
проверками целостности и пробным восстановлением.

**Срочный блокер выявлен: B-89-1 (TLS `sureg.dev` / `ai.sureg.dev` истекает ≈2026-10-30,
продление падает ежедневно с 2026-09-30).** TLS `animastor.org`/`animastor.in` риск не
касается до ≈2026-12-07/12-11.

Доступ к root-данным (системный журнал, `/var/log/letsencrypt`) получен единственным
доступным способом, согласованным с владельцем в ходе этого этапа: один одноразовый
контейнер `nginx:alpine` с read-only mount'ами `/var/log/journal` и `/var/log/letsencrypt`
в scratch `/tmp/opencode/rootcopy`. Контейнер удалён (`--rm`), временные копии журнала и
логов удалены сразу после извлечения фрагментов. Продакшен-контейнеры не трогались
(проверено после: `animastor-backend`/`animastor-proxy` Up 27h, `gpu-hub` Up 7d,
pg/redis healthy, сайт 200).

Запрещённые на этапе действия **не выполнялись**: `certbot renew`, `--dry-run`,
reload/restart nginx/certbot/контейнеров, изменение конфигураций и сертификатов.

---

## 1. Certbot — причина сбоя 2026-10-20 02:27

### 1.1 Установленные факты (systemd)

| Параметр | Значение |
|---|---|
| `certbot.service` | failed (Result=exit-code), выход `status=1/FAILURE` 2026-10-20 02:27:50 UTC |
| Процесс | `ExecStart=/usr/bin/certbot -q renew`, PID 3240769, старт 02:22:39, CPU 1.161 s |
| `certbot.timer` | enabled, active (waiting) с 2026-08-24 16:29:55; последний запуск 02:22:39; **следующий запуск: 2026-10-20 12:52:07 UTC** (2 раза/сутки) |
| `/etc/cron.d/certbot` | существует (0 */12 * * * root … `certbot -q renew`), но с защитой `-d /run/systemd/system` — под systemd не выполняется; фактический триггер = timer |
| Версия | certbot 1.21.0, плагины: manual/null/standalone/**webroot** |
| Renewal-конфиги | 4 lineage: `animastor.org.conf` (08.10), `animastor.in.conf` (12.10), `sureg.dev.conf`, `ai.sureg.dev.conf` (оба 01.08) |
| Webroot (animastor) | `/home/animastor/animastor/frontends/website` (обе линейки) |
| Webroot (sureg) | `sureg.dev` → `/home/sureg/sureg-dev/site`; `ai.sureg.dev` → `/home/sureg/animastor/frontends/main` (**путь не существует**) |
| ACME | `https://acme-v02.api.letsencrypt.org/directory`; renewal-hooks (pre/deploy/post) **пусты** |
| Сертификаты (проверено по TLS-handshake) | `animastor.org` notAfter **2027-01-06 18:29:48 GMT**; `animastor.in` notAfter **2027-01-10 09:24:17 GMT**; окно продления открывается ≈ **2026-12-07 / 2026-12-11** |

### 1.2 Безопасный фрагмент системного журнала (2026-10-20, system journal)

```
2026-10-20T02:22:39+0000 systemd[1]: Starting Certbot...
2026-10-20T02:27:46+0000 certbot[3240769]: Failed to renew certificate ai.sureg.dev with error: Some challenges have failed.
2026-10-20T02:27:50+0000 certbot[3240769]: Failed to renew certificate sureg.dev with error: Some challenges have failed.
2026-10-20T02:27:50+0000 certbot[3240769]: All renewals failed. The following certificates could not be renewed:
2026-10-20T02:27:50+0000 certbot[3240769]:   /etc/letsencrypt/live/ai.sureg.dev/fullchain.pem (failure)
2026-10-20T02:27:50+0000 certbot[3240769]:   /etc/letsencrypt/live/sureg.dev/fullchain.pem (failure)
2026-10-20T02:27:50+0000 certbot[3240769]: 2 renew failure(s), 0 parse failure(s)
2026-10-20T02:27:50+0000 systemd[1]: certbot.service: Main process exited, code=exited, status=1/FAILURE
2026-10-20T02:27:50+0000 systemd[1]: Failed to start Certbot.
```

### 1.3 Точная причина (подтверждена логом certbot, `/var/log/letsencrypt/letsencrypt.log`)

Ответ ACME-центра (токены в URL заменены на `<token-redacted>`):

```
Type:   unauthorized
Detail: 66.116.225.136: Invalid response from http://ai.sureg.dev/.well-known/acme-challenge/<token-redacted>: 404

Domain: sureg.dev
Type:   unauthorized
Detail: 66.116.225.136: Invalid response from http://sureg.dev/.well-known/acme-challenge/<token-redacted>: 404

Domain: www.sureg.dev
Type:   unauthorized
Detail: 66.116.225.136: Invalid response from http://www.sureg.dev/.well-known/acme-challenge/<token-redacted>: 404

Hint: The Certificate Authority failed to download the temporary challenge files created by Certbot.
      Ensure that the listed domains serve their content from the provided --webroot-path/-w and that
      files created there can be downloaded from the internet.
```

**Цепочка причины (все звенья подтверждены read-only доказательствами):**

1. Certbot (webroot-auth) записывает токены HTTP-01 в `/home/sureg/sureg-dev/site/.well-known/…`
   и `/home/sureg/animastor/frontends/main/.well-known/…` (mtime каталогов `/home/sureg/…`
   обновился ровно в 02:27; `.well-known` после попытки сертификатом убирается — «All challenges cleaned up»).
2. Порты 80/443 на хосте слушает **только** контейнер `animastor-proxy` (nginx:alpine);
   `nginx` как systemd-юнита отсутствует (Unit could not be found).
3. В развёрнутом `proxy/conf/default.conf` **нет ни одного активного `server_name` для sureg**
   (6 упоминаний — все в комментариях; блоки удалены коммитом `f6f0f9aa` от 2026-08-21
   «refactor(deploy): remove legacy host dependencies»). Запросы `Host: sureg.dev`/`ai.sureg.dev`
   попадают в дефолтный сервер animastor (проверка: ответ 301/404 идентичен `Host: animastor.org`).
4. ACME-location любого сервера читает `root /usr/share/nginx/frontends/website`
   (= mount монорепо `frontends/website`), а токен лежит в `/home/sureg/…` → **404**.
5. Для `ai.sureg.dev` второй фактор: webroot-путь `/home/sureg/animastor/frontends/main`
   физически не существует.
6. `animastor.org`/`animastor.in` в этом же запуске обработаны штатно: «Certificate not yet due
   for renewal» (02:27:46) — они **не продлевались и не падали**.

**Итог: сбой `certbot.service` = отказ HTTP-01 валидации для двух sureg-линеек из-за
несоответствия webroot ↔ nginx (nginx не обслуживает эти имена вообще).**

### 1.4 История (по ротированным логам certbot, извлечённых временно и удалённых)

| Лог | Период | «Failed to renew» |
|---|---|---|
| `letsencrypt.log.12.gz` | 2026-07-26 → **2026-08-01 15:36:57** | последний успех: «Congratulations, all renewals succeeded» |
| `letsencrypt.log.5.gz`, `.4.gz` | 2026-09-13 → 2026-09-26 | 0 (sureg ещё не в окне продления) |
| `letsencrypt.log.3.gz` | 2026-09-27 → 2026-10-03 | **7** (первые падения; окно открылось ≈09-30) |
| `letsencrypt.log.2.gz` | 2026-10-04 → 2026-10-10 | 28 (14 — sureg.dev) |
| `letsencrypt.log.1.gz` | 2026-10-11 → 2026-10-17 | 28 (14 — sureg.dev) |
| `letsencrypt.log` | 2026-10-18 → 2026-10-20 02:27:50 | 10 |

Дополнительно: в `/etc/letsencrypt/csr` с 2026-09-30 создано **81** CSR (по 2 на запуск —
`ai.sureg.dev` + `sureg.dev`/`www.sureg.dev`), последний `0455`/`0456` в 02:27 2026-10-20.
То есть: **≈20 дней подряд, 2 запуска в сутки, все попытки продления sureg — неуспешны.**

### 1.5 Риски по TLS (приоритезировано)

- **B-89-1 (СРОЧНЫЙ).** `sureg.dev`/`ai.sureg.dev`: последний успешно выданный сертификат
  2026-08-01 15:36 (90 дней) → **срок ≈ 2026-10-30, ≈10 дней осталось**, продление падает
  с 09-30. Окончательная дата не может быть прочитана напрямую (`/etc/letsencrypt/archive`
  — 700, без root); сходимость трёх признаков: дата выдачи 01.08, первая попытка продления
  09-30 (= expiry−30d), лог успеха 01.08. Дополнительно: эти имена на :443 **уже** отдают
  сертификат `animastor.org` (проверено по SNI; SAN: admin/app/www/animastor.org) — т.е.
  HTTPS для sureg-имён сейчас не обслуживается корректно независимо от исхода.
- **Отсутствует риск для animastor** до ≈2026-12-07 (`animastor.org`) и ≈2026-12-11
  (`animastor.in`): обе линейки «not yet due», webroot animastor монтируется в nginx и
  ACME-location указывает именно на него (последние успешные выпуски 08.10 и 12.10 —
  через этот же путь).
- **Маскирующий эффект:** `certbot -q renew` возвращает exit 1 из-за sureg-линеек при
  ЛЮБОМ состоянии остальных; мониторинг по коду выхода не отличает «sureg падает» от
  «упало продление animastor» — важно к моменту открытия окна в декабре (связано с
  этапом D плана Stage 88).
- Резерв: копии renewal-конфигов 2026-10-12 сохранены в
  `~/backups/letsencrypt-renewal-pre-34-2026-10-12/` (не трогались).

---

## 2. Инвентаризация резервных копий

Проверки выполнялись read-only: `tar -tzf` (полный проход = тест целостности gzip/tar),
`sha256sum -c` по манифесту, stream-хеши (`tar -xzOf | sha256sum`), пробное извлечение
**только** во временный scratch `/tmp/opencode/…` (не поверх действующих каталогов;
scratch удалён после проверок). Значения секретов в отчёт не выносились.

### S1. Bare git-зеркала `~/repos/*.git` (6 шт.)

- **Что покрыто:** все git-tracked файлы 6 репозиториев (`animastor` 40M, `animastor-backend`,
  `animastor-web`, `animastor-gpu-hub`, `animastor-android`, `animastor-worker`).
- **Даты:** android/worker/gpu-hub 12.10, backend 19.10 06:27, web 20.10 05:32,
  animastor 11.10 (packed-refs) + последний push 20.10 05:32:34.
- **Целостность (проверяемые признаки):** ветка `c21.4-…` зеркала = `4574b3b9` = HEAD
  монорепо = remote-tracking в монорепо (синхронно, «ahead/behind» нет); `fsck` восстановленной
  из бэкапа копии зеркала — без ошибок (см. S4-drill).
- **Независимая копия:** `git_repos_2026-10-12_06-00-27.tar.gz` (51 MB, все репозитории
  на 12.10) + `git-worktrees-2026-10-12_06-00-43.tar.gz` (87 MB) — но **тот же диск**.
- **Восстановление подтверждено:** да, выборочно (drill: извлечён `repos/animastor.git`,
  `git fsck` OK, HEAD `64127b9e`, ветка `c21.4` = `465453df` — состояние на 12.10).
- **Риск при потере монорепо:** нет прямой потери (зеркала вне монорепо), НО dirty-состояние
  рабочих копий в зеркала не попадает (см. S6, S7).

### S2. Полные бэкапы `~/backups/backup_animastor_*.tar.gz` (3 шт., ВНЕ монорепо)

- **Файлы:** `2026-09-16` (1 026 232 288 B, 120 690 записей), `2026-10-01`
  (1 039 124 745 B, 123 516 записей), `2026-10-08` (1 088 241 031 B, 124 539 записей).
- **Что покрыто:** весь `~/animastor` (tracked + untracked + gitignored), включая
  `frontends/app/dist` (10 файлов), `proxy/conf/.htpasswd`, 2 APK, `backend/tests`
  (186 записей), `data/books` (53 файла на 08.10), `backups/*.zip` (~95 записей),
  старые версии `index.html` и compose-файлов монорепо.
- **Исключения скрипта `backup_animastor.sh` (подтверждены в содержимом):**
  `*.tar`/`*.tar.gz` (→ 15 legacy-архивов В НЕ СКОПИРОВАНЫ), `animastor/data/output`
  (→ 0 записей в архиве), `models/*`, веса (`*.safetensors/gguf/pt/bin/ckpt`).
- **Целостность:** полный `tar -tzf` — rc=0 у всех трёх; **манифеста sha256 нет** (в
  `backup-manifest-2026-10-12.sha256` не входят) — хеш-подтверждения отсутствуют.
- **Пробное восстановление (drill, scratch):** `frontends/app/dist` → `diff -rq` —
  **байт-в-байт ИДЕНТИЧЕН** текущему; `.htpasswd` — **ИДЕНТИЧЕН**;
  `downloads/animastor-android-latest.apk` — **ИДЕНТИЧЕН** (`0b7a1333…`);
  `backend/tests` — 5 отличий/отсутствий (правки 09–11.10; текущая версия покрыта
  git-зеркалом S1).
- **Независимая копия:** нет (один экземпляр на том же диске).
- **Восстановление подтверждено:** частично (dist/.htpasswd/APK — да; объём ~3.1 GB
  целиком не воспроизводился).
- **Риск при потере монорепо:** низкий (архивы лежат в `~/backups`, не в монорепо);
  риск при потере диска — полный.

### S3. Cutover-набор 2026-10-12 `~/backups/cutover-*` + манифест

- **Что покрыто:** `cutover-data.tgz` (61 786 941 B, 186 записей: `data/books` — 61 файл,
  `data/output` — 95 файлов); `cutover-config.tgz` (9 записей: `docker-compose.yml`
  `ed1b290d…`, `.env` `ee64133e…`, 3 overlay-файла, `proxy/conf/default.conf`,
  `proxy/conf/.htpasswd` `6405f1b7…`); `cutover-pg-2026-10-12.dump` (441 269 B);
  `cutover-pg-schema` (68 263 B); `redis-dump-2026-10-12.rdb` (58 372 973 B).
- **Целостность:** `sha256sum -c backup-manifest-2026-10-12.sha256` — **9/9 OK**
  (проверено в этом этапе); полный `tar -tzf` cutover-data — rc=0.
- **Сверка с текущим состоянием:** `.htpasswd` из архива **байт-идентичен** текущему;
  `.env` из архива = `mono/.env`; `data/output`: 95 в архиве = 95 сейчас, ни одного
  файла новее архива → состав не менялся (байтовая сверка не выполнялась);
  `data/books`: 2 файла изменены ПОСЛЕ 12.10 (см. пробелы).
- **Независимая копия:** нет (тот же диск).
- **Восстановление подтверждено:** да для байтовой идентичности ключевых файлов
  (hash + stream-извлечение); полный restore не выполнялся.
- **Риск при потере монорепо:** низкий; риск при потере диска — полный.

### S4. `git-untracked-2026-10-12_06-17-10.tar.gz` (236 390 B, 6 записей)

- **Покрытие:** только untracked-НЕ-ignored файлы: `untracked-mono/docker/compose/
  overlay-backend-standalone.yml` и `untracked-backend/freebuff-chat-….md`.
- **Целостность:** входит в манифест (sha256 OK), листинг rc=0.
- **Восстановление подтверждено:** да на уровне байтов — overlay из архива
  `eac32cb0…` **идентичен** текущему файлу монорепо.
- **Не покрывает (важно):** всё gitignored — `backups/`, `.htpasswd`, `frontends/app/dist`,
  `downloads/*.apk`, а также `deploy/` репозитория `animastor-backend`.

### S5. Legacy-архивы `~/animastor/backups/` (ВНУТРИ монорепо!)

- **15 tar.gz, суммарно 1 012 MB**, даты 2026-05-27 → 2026-08-11
  (`2026-06-10_BIG_Work`, `2026-06-11_BEGINING/Recovery01-03`, `GPU_GEN_OK`, `Conn-01/02`,
  `Vbook_UP`, `Regen01`, `Subtitle`, `TXT`, `Video01`, `Free_Player`, `gpu-video-…-08-11`).
  Плюс ~90 `.zip`-снапшотов исходников (06.26 → 09.17) и 3 отдельных tar (05–06.2026).
- **Целостность:** полный `tar -tzf` — **rc=0 у всех 15**; drill: `2026-06-10_BIG_Work.tar.gz`
  извлечён целиком (274 файла, 339 записей с каталогами) — без ошибок.
- **Что покрыто:** старые состояния монорепо (пре-сплит), включая данные/веса того периода.
- **Независимая копия:** **НЕТ**. Файлы лежат в монорепо, исключены из git
  (`.gitignore:29 backups/`) и исключены `backup_animastor.sh` (`--exclude='*.tar.gz'`).
  В `git-untracked`-бэкап не попадают (ignored), в бэкап 08.10 не попадают (исключение).
- **Восстановление подтверждено:** частично (1 из 15 drill-извлечён; остальные — только list OK).
- **Риск при потере монорепо:** **полная потеря** (эти архивы — часть монорепо).
  `.zip`-снапшоты, наоборот, покрыты бэкапами S2.

### S6. Снимки деплоя `~/animastor/backups/deploy-{apply,rollback}-20261010` (11 файлов, 108 KB)

- **Что покрыто:** состояние 2026-10-10: `compose-config(-before).yml`,
  `env(-before).backup`/`env-after-rollback.backup`, `containers-inspect(-before).json`,
  `containers-after-rollback.json`, `containers-before.txt`, `images-before.txt`
  (содержимое секретных env-файлов в отчёт не выносилось).
- **Даты:** rollback 10.10 12:07, apply 10.10 12:53–13:00.
- **Целостность:** не в манифесте; файлы читаются, размеры непустые (40K/68K).
- **Независимая копия:** **НЕТ** — untracked + ignored (`backups/`), созданы ПОСЛЕ последнего
  полного бэкапа 08.10 → в S2 не попали, в S4 не попали.
- **Восстановление подтверждено:** нет (не извлекались; не критичны — исторические снимки).
- **Риск при потере монорепо:** потеря этих снимков (совместно с монорепо).

### S7. Prod-файлы деплоя `~/animastor-backend/deploy/` (вне монорепо, untracked в своём репо)

| Файл | sha256 (16) | mtime | Независимая копия? |
|---|---|---|---|
| `docker-compose.yml` | `c955be06dd58bb0d` | 2026-10-19 06:17 | **НЕТ — единственный экземпляр** |
| `.env` (секреты) | `fc70bfeb2248c3b5` | 2026-10-19 06:31 | **НЕТ — единственный экземпляр** (снимки 12.10: `ee64133e…`, `87ea6f42…` — отличаются) |
| `overlay-backend-standalone.yml` | `9f13d8887039257f` | 2026-10-12 07:04 | ЕСТЬ: `reorg-2026-10-19/78-docs-deploy-preparation/compose-backup/…` |
| `README.md` | — | 2026-10-19 11:51 | нет (некритично) |

Проверено: sweep-поиск по `~/` (все `docker-compose*.yml`/`.env`, глубина ≤5) — совпадений
текущих compose/`env`-хешей больше нигде нет; ранние копии: `ed1b290d…` (mono и
`reorg-2026-10-12/rollback-53`), `264550e9…` (stage 78, до cutover-правок 19.10).
Также: `git status animastor-backend`: ` D backend/scripts/audit-orphan-books.js`,
` M` 4 файла `backend/tests/…`, `?? deploy/`, `?? freebuff-chat-….md` — 6 из 7 изменений
не отражены ни в зеркале репозитория, ни в бэкапах.
- **Восстановление подтверждено:** нет для compose/.env (нечего восстанавливать, кроме них самих).
- **Риск:** потеря = невозможность восстановить конфигурацию/секреты работающего стека.

### S8. Прочие наборы

- **`frontends/app/dist`** (10 файлов, newest 03.10): покрыт S2, drill — **идентичен**.
  В git не входит (gitignored).
- **`proxy/conf/.htpasswd`**: покрыт S3 (hash == текущий) и S2 (drill — идентичен).
  В git не входит (gitignored).
- **APK** (2 шт., newest 31.08): покрыты S2; drill — `animastor-android-latest.apk`
  **байт-идентичен** (`0b7a1333…`).
- **`backend/tests`** (181 файл mono, newest 11.10): в S2 — 5 отличий; **текущая версия
  покрыта git-зеркалом S1** (tracked, рабочая копия чистая). В `animastor-backend`:
  190 файлов, 4 изменены (` M`) — эти правки только в рабочей копии (см. S7).
- **`data/output`** (95 файлов, 61 MB, newest 10.10): покрыт S3 (95/95, 0 новых);
  S2 его исключает по построению.
- **`data/books`** (61 файл, 1.9 MB, newest 18.10): покрыт S3 **по состоянию на 12.10**;
  2 файла изменены позже → см. пробелы.
- **PostgreSQL/Redis:** дампы только от 2026-10-12 (S3). Изменения БД после 12.10 не
  дампились; содержимое volume не читалось (root) — непроверяемо на этом этапе.
- **Автоматизация:** `crontab` пользователя animastor — **пусто**; в `/etc/cron.d` только
  `certbot` (защита от запуска под systemd) и `e2scrub_all`; backup-скрипты
  (`backup_animastor.sh` 19.06, `backup_gpu.sh` 03.04, `git_backup.sh`, `src-backup.sh`)
  запускаются **только вручную**; последний полный запуск — 2026-10-08.
  Офсайт/облачное хранилище/`rclone`/`restic`/`borg` — не обнаружены.
- **Диск:** всё на одном `/dev/sda2` (99 G, занято 81 %, свободно 19 G) — «независимая
  копия» в смысле отдельного носителя отсутствует **ни для одного набора**.

---

## 3. Пробелы резервного копирования (по приоритету)

1. **P1 — единственные копии prod-конфигурации:** `animastor-backend/deploy/docker-compose.yml`
   (`c955be06…`, 19.10) и `deploy/.env` (`fc70bfeb…`, 19.10) не имеют ни одной резервной
   копии нигде (S7). Потеря = потеря конфигурации и секретов работающего стека.
2. **P2 — отсутствует любая независимая (отдельный диск/офсайт) копия** всего массива
   (S1–S7 все на `/dev/sda2`); полный бэкап делался вручную 2026-10-08, автоматики нет (S8).
3. **P3 — `~/animastor/backups` (1 012 MB legacy tar.gz + снимки деплоя 10.10) не покрыты
   ничем**, кроме себя: исключены `backup_animastor.sh` (`*.tar.gz`) и git
   (`.gitignore backups/`), лежат внутри монорепо → теряются вместе с ним (S5, S6).
4. **P4 — свежие данные без бэкапа:** 2 файла `data/books` изменены после 12.10
   (`book.json` 279 B от 17.10, `ba_1788172242081.snapshot.json` 60 919 B от 18.10);
   все изменения PostgreSQL/Redis после 12.10 (последний дамп 12.10) (S8).
5. **P5 — dirty-состояния рабочих копий:** `animastor-backend` (6 изменений, включая
   удалённый `audit-orphan-books.js` и 4 теста) и `animastor` (`index.html`,
   `overlay-…yml` — частично покрыты: см. ниже) не отражены в зеркалах.
   Частично закрыто: `index.html` в монорепо **байт-идентичен** закоммиченной версии в
   `animastor-web` (зеркало S1 обновлено сегодня 05:32) → восстановим; mono-`overlay`
   идентичен версии в S4.
6. **P6 — отсутствие хеш-манифеста** для S2 (3 × ~1 GB) и S5 (15 архивов): целостность
   подтверждается только успешным листингом, не криптографически.
7. **P7 — мелочи:** `backup_gpu.sh`/`src-backup.sh` не запускались годами; в `~/backups`
   нет копий 15 legacy-архивов (следствие P3).

---

## 4. Решения владельца (нельзя разрешить автоматически)

- **Q1. Место и способ хранения полной резервной копии.** Отдельный диск/NAS/облако;
  инструмент (tar+sha256/`restic`/`borg`/`rclone`); расписание (автоматизировать ли
  `backup_animastor.sh` через cron/systemd — сейчас автоматики нет); допустимо ли
  хранить секреты (`.env`) в бэкапах и в каком виде (шифрование?). Отдельно: нужен ли
  регулярный дамп PostgreSQL/Redis (последний 12.10).
- **Q2. Порядок сохранения уникальных файлов (до любого шага по выводу монорепо).**
  Куда и как копировать: (а) `animastor-backend/deploy/{docker-compose.yml,.env}` —
  единственные копии; (б) `~/animastor/backups` (15 tar.gz + deploy-снимки 10.10) —
  перенести/скопировать за пределы монорепо; (в) свежие `data/books` (2 файла) и дампы БД.
  Требуется подтверждение механизма хранения секретов.
- **Q3. Срочное решение по Certbot (B-89-1, срок ≈2026-10-30).** Нужен ли сертификат для
  `sureg.dev`/`ai.sureg.dev` вообще (сейчас эти имена и так отдают чужой сертификат)?
  Варианты на выбор владельца (этап ничего не выполняет): (1) вернуть server_name +
  корректный webroot для sureg в nginx; (2) сменить authenticator (dns-01) для этих
  линеек; (3) отключить/удалить линейки, зафиксировав отказ; (4) игнорировать до
  завершения проекта. Дополнительно подтвердить: считать ли exit-1 `certbot.service`
  триггером алерта, чтобы не замаскировать будущий сбой продления animastor (декабрь).
- **Q4. GPU Hub — источник истины** (блокер B5 из Stage 88): `mono/packages/…` ↔
  `animastor-gpu-hub` ↔ GitHub; двусторонние расхождения. **В этом этапе не менялся** —
  ждёт явного решения.
- **Q5. Доступ root для будущих диагностик:** зафиксировать ли штатный способ
  (пароль sudo / выделенный диагностический контейнер), чтобы не повторять
  согласованный здесь разовый контейнер на каждом этапе.

---

## 5. Безопасные следующие шаги (предложения, ничего не выполняется)

1. Закрыть Q2/P1 немедленно: создать проверяемую копию `deploy/docker-compose.yml` и
   `deploy/.env` (с согласованным механизмом хранения секретов) + свежие дампы БД и
   `data/books` — это самые ценные «единственные копии».
2. Реализовать Q1 (офсайт/отдельный носитель + расписание), затем сформировать манифест
   sha256 для S2/S5 и выполнить контрольное восстановление крупного архива.
3. Решить Q3 по sureg-TLS до ≈2026-10-30 (действия только после решения владельца).
4. Перед выводом монорепо (Stage 88, этапы A–C) — перенести `~/animastor/backups`
   (S5/S6) и подтвердить бэкап, затем двигаться к этапу D (TLS webroot) с учётом
   выводов §1.
5. Не изменять GPU Hub до решения Q4.

---

## 6. Блокеры (список)

| ID | Уровень | Суть |
|---|---|---|
| **B-89-1** | **срочный** | `sureg.dev`/`ai.sureg.dev` истекают ≈2026-10-30; продление падает ежедневно с 2026-09-30 (HTTP-01 → 404: nginx не обслуживает эти имена; webroot `ai.sureg.dev` не существует). Требуется решение Q3. |
| **B-89-2** | высокий | `animastor-backend/deploy/docker-compose.yml` (`c955be06…`) и `deploy/.env` (`fc70bfeb…`) — **единственные копии**, без резервного копирования (P1, Q2). |
| **B-89-3** | высокий | Нет независимой (отдельный носитель/офсайт) копии ни одного набора; полный бэкап только ручной от 2026-10-08, автоматики нет (P2, Q1). |
| **B-89-4** | средний | `~/animastor/backups` (1 012 MB legacy tar + снимки деплоя 10.10) не покрыты git/бэкап-скриптом и лежат внутри монорепо — теряются вместе с ним (P3, Q2). |
| **B-89-5** | средний | Свежие данные без бэкапа: 2 файла `data/books` (12–18.10) + все изменения PostgreSQL/Redis после 12.10 (P4). |
| **B-89-6** | низкий | `animastor-backend` содержит 6 несохранённых изменений (deploy/, 4 теста, удалённый скрипт); `certbot.service` ежедневно exit 1 — код выхода маскирует будущие сбои (P5, §1.5). |
| **B-89-7** | отложен | GPU Hub — источник истины не выбран (Stage 88, B5); в Stage 89 не изменялся (Q4). |

---

## 7. Что не менялось (контроль этапа)

- Монорепо, все репозитории, refs/remotes — без изменений; отчёты Stage 87/88 не тронуты
  (mtime 08:01/08:02/08:33 — до начала Stage 89).
- Сертификаты/`/etc/letsencrypt` — только чтение (включая чтение через временный контейнер);
  `renew`/`--dry-run`/reload/restart не запускались.
- Контейнеры production — не перезапускались; единственный созданный контейнер
  (`stage89-readonly`, `--rm`) удалён; scratch `/tmp/opencode/{rootcopy,drill*}` удалён.
- Бэкапы/архивы — только чтение и листинг; извлечения выполнялись исключительно во
  временный scratch и удалены; ничего в `~/backups` и `~/animastor/backups` не создано
  и не удалено.
