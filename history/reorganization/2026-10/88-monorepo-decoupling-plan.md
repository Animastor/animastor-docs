# Stage 88 — Monorepo Decoupling Plan (READ-ONLY)

**Дата:** 2026-10-20 (UTC)
**Область:** план отвязки `/home/animastor/animastor` от production
**Режим:** только чтение и планирование. Миграция, переключение путей, перезапуск сервисов,
архивирование, push/reset/rebase, изменение compose/nginx/certbot/cron/systemd/hooks/backup —
**не выполнялись**. Отчёт Stage 87 (`87-monorepo-retirement-audit.md`) не изменялся.

## Итоговый статус

**PASS** — план подготовлен на основании проверенных в этом этапе фактов.
Одновременно зафиксировано **12 блокеров** (B1–B12, §8), которые обязаны быть закрыты
до соответствующих будущих этапов; **B3** (причина отказа `certbot.service`) и **B5**
(источник истины GPU Hub) на текущих доказательствах остаются **BLOCKED** и требуют
root-диагностики / решения владельца соответственно.

---

## 1. Подтверждённые факты (проверены в Stage 88)

- Монорепо: HEAD `4574b3b9` (ветка `c21.4-physically-extract-analysis-from-backend`),
  dirty: `M frontends/website/index.html`, `?? docker/compose/overlay-backend-standalone.yml`;
  размер 3.8G (2.2G node_modules, 974M+50M вложенные архивы, 263M android build/gradle,
  145M дистрибутив `gradle-8.12`, 63M `data/`, 455M `frontends/`); свободно 19G.
- **8 bind-mount'ов** из монорепо в работающие контейнеры (см. §2), источник —
  активный `animastor-backend/deploy/docker-compose.yml` (+ overlay).
- Прод действительно читает из монорепо: sha256 `frontends/website/index.html` в контейнере
  `a1900f4e…` == в монорепо; `data/output` в контейнере = 95 файлов = хост-каталог.
- `.env`: наборы ключей идентичны; различаются **только** `BACKEND_IMAGE` и `GPU_HUB_IMAGE`;
  значения в `deploy/.env` совпадают с реально работающими образами
  (`182b0252…` backend, `3611c644…` hub), значения в `monorepo/.env` — устаревшие пины.
  (Значения секретов в отчёт не выносились.)
- Рабочие репозитории синхронны с bare и GitHub (Stage 87), в Stage 88 не менялись;
  `git ls-remote` по GitHub в Stage 88 выполнялся только для чтения, `fetch` не выполнялся.
- Cron/systemd/custom git hooks, ссылающихся на монорепо, **нет**; CI-воркфлоу путей
  к монорепо не содержат.

---

## 2. Таблица production-зависимостей (bind mounts)

| # | Контейнер / сервис | Исходный путь (монорепо) | Цель в контейнере | Режим | Текущий потребитель | Соответствие в отдельном хранилище | Сравнение / SHA-256 | Требуемое действие для отвязки |
|---|---|---|---|---|---|---|---|---|
| 1 | `animastor-proxy` (nginx) | `proxy/conf/default.conf` | `/etc/nginx/conf.d/default.conf` | **ro** | nginx (все server-block'и: .org/.in, ACME, `/health`, `/api/`, `/gpu/`, `/docs/`, `/downloads/`) | `animastor-backend/proxy/conf/default.conf` (tracked) | **идентичны**: `99f706aff608744949f50e6ead87e6f3bd55087f13723d4bb2c24b0912e36505` | Переключить mount на `animastor-backend/proxy/conf/default.conf`; затем `nginx -t` и reload |
| 2 | `animastor-proxy` | `proxy/conf/.htpasswd` | `/etc/nginx/.htpasswd` | **ro** | basic-auth (admin.animastor.org) | **нет копии**: gitignored, найден только здесь | `6405f1b770156035cde04e549445e4720f6150a6437790f52b9b6f3e9fd8af75`; покрыт бэкапом 08.10 | Перенести файл в отдельное секретное хранилище (решение владельца: напр. `animastor-backend/deploy/secrets/`, mode 600), смонтировать оттуда; **не трогать в Stage 88** |
| 3 | `animastor-proxy` | `frontends/website/` (10 файлов) | `/usr/share/nginx/frontends/website` | **ro** | сайт `animastor.org` (`root`), ACME webroot, `/downloads/`, `/library/` | `animastor-web/frontends/website/` (9 файлов) | **9/9 байт-идентичны**; в монорепо дополнительно `downloads/animastor-android-latest.apk` (12.5M, `0b7a1333…`) + `downloads/version.json` | (а) подтвердить идентичность `diff -rq` перед переключением; (б) обеспечить дом для APK (см. B8); (в) сменить mount на `animastor-web/frontends/website`; (г) проверить сайт/ACME/`/downloads/` |
| 4 | `animastor-proxy` | `frontends/app/dist/` (8 файлов) | `/usr/share/nginx/frontends/app` (nginx: `…/app/dist`) | **ro** | `app.animastor.org`, `admin.animastor.org` | **нет в `animastor-web`**: `dist/` gitignored и не собран | Дистinctные хеши зафиксированы: `index.html 9a18843d…`, `assets/index-CXKCzHN3.js 7230a70f…`, `assets/index-BSREV5G-.css 098cb5b6…`; покрыты бэкапом 08.10 (mtime 03.10) | Воспроизводимость: собрать `frontends/app` из `animastor-web`, сравнить результат/поведение; затем либо смонтировать новый dist, либо (как переходной вариант) копию dist вне монорепо; до этого mount не менять |
| 5 | `animastor-backend` | `data/books/` (61 файл, 1.9M) | `/data/books` | **RW** | backend: библиотека книг (чтение/запись) | **нет в git**; бэкап `cutover-data-2026-10-12.tgz` (82 пути) | Текущее состояние **== архиву 12.10**: 0 новых, 0 удалённых, 1 файл изменил размер (`book.json` 602→279) | Переместить корень данных на постоянное место вне монорепо (решение владельца: напр. `/home/animastor/data/books`), полная копия + сверка манифеста, затем переключение mount и проверка API библиотеки |
| 6 | `animastor-backend` | `data/output/` (95 файлов, 61M) | `/data/output` | **RW** | backend: результаты генерации | **нет в git**; бэкап `cutover-data-2026-10-12.tgz` (103 пути) | Текущее состояние **== архиву 12.10**: 0 новых/удалённых/изменённых | Как п.5; **переход запрещён, пока нет свежей полной копии** (см. §4) |
| 7 | `animastor-backend` | `backend/ai/` (54 файла) | `/app/ai` | **RW** | backend: AI-конфиги (workflows, connectors, rules, profiles), подключены live | `animastor-backend/backend/ai/` (tracked) | **0 расхождений** (манифесты sha256 идентичны, 54/54) | Переключить mount на `animastor-backend/backend/ai`; проверить загрузку конфигов в логах backend |
| 8 | `animastor-backend` | `backend/tests/` (181 файл) | `/app/tests` | **RW** | тесты внутри образа (хост-дерево перекрывает `/app/tests` образа) | `animastor-backend/backend/tests/` (190 файлов) | **расхождение**: 24 файла изменены, 9 есть только в репо (`book-registry-recovery-gate.test.js`, `book-versions-route.test.js`, `helpers/pg-teardown.js`, `markready-build-id-idempotency.test.js`, `null-duplicate-self-heal.test.js`, `orchestrator-convergence.test.js`, `orphan-books-diagnosis.test.js`, `startup-recovery-registry-gate.test.js`, `synthetic-null-recreation-fix.test.js`), только в монорепо — 0; версии монорепо старее (mtime 04.10–10.10 vs 11.10–14.10) | **Решение владельца**: считать ли репозиторий источником истины. Если да — переключить mount на `animastor-backend/backend/tests`; если монорепо — сначала разобрать 24 расхождения. До решения mount не менять |

**Скрытая/спящая зависимость:** базовый `deploy/docker-compose.yml:110` также монтирует
`/home/animastor/animastor/backend/src:/app/src`, но **активный overlay его отключает**
(`!override`). Сейчас в работающем контейнере `/app/src` **не смонтирован** (проверено:
`docker inspect` не показывает этот mount). При любом отказе overlay путь вернётся —
учитывать в плане.

**Источник bind-mount'ов (как их править в будущем):**
- `/home/animastor/animastor-backend/deploy/docker-compose.yml` — строки 107–111, 142–147;
- `/home/animastor/animastor-backend/deploy/overlay-backend-standalone.yml` — строки 36–39;
- оба файла сейчас **untracked** в `animastor-backend` (см. B7).

**Что НЕ зависит от монорепо:** `animastor-pg`, `animastor-redis`
( compose из `/home/sureg/animastor`), тома `animastor_pg-data`/`animastor_redis-data`
(именованные), `gpu-hub` (GHCR-образ по digest, mount'ов нет),
`/usr/share/nginx/docs` → `animastor-docs-deploy`.

---

## 3. Certbot и TLS

### 3.1 Факты
| Параметр | Значение |
|---|---|
| Версия / планировщик | certbot 1.21.0; `certbot.timer` **дважды в сутки** (последний запуск 2026-10-20 02:22:39 UTC, следующий 12:52:07 UTC); `/etc/cron.d/certbot` — не используется при systemd |
| Состояние службы | **`certbot.service` завершился с exit 1 2026-10-20 02:27:50 UTC** (`Result=exit-code`, `NRestarts=0`). Причина **недоступна без root** (`/var/log/letsencrypt` и journal читаются только root) → **B3 (BLOCKED)** |
| `animastor.org.conf` | authenticator=webroot, `webroot_path=/home/animastor/animastor/frontends/website`, `[[webroot_map]]`: admin/app/www/animastor.org → тот же путь, key_type=ecdsa |
| `animastor.in.conf` | authenticator=webroot, `webroot_path=/home/animastor/animastor/frontends/website`, 4 имени (.in), key_type=rsa |
| Сроки действия сертификатов (сняты `openssl s_client`, без записи) | animastor.org: notBefore 2026-10-08, **notAfter 2027-01-06** (через 78 дней); animastor.in: notBefore 2026-10-12, **notAfter 2027-01-10** (82 дня) |
| Окно продления | LE продлевает при <30 днях → первые попытки ≈ **07.12.2026** (.org) и **11.12.2026** (.in) → ≈48 дней на подготовку |
| nginx ACME | оба HTTP-server-block'а: `location ^~ /.well-known/acme-challenge/ { root /usr/share/nginx/frontends/website; }` → фактический webroot = **mount монорепо**; probe несуществующего токена → 404 (штатно) |
| Сертификаты в nginx | `/etc/letsencrypt/live/animastor.org/fullchain.pem`+key (3 блока), `/etc/letsencrypt/live/animastor.in/fullchain.pem`+key; сам `/etc/letsencrypt` в контейнер смонтирован ro |
| Rollback-материалы | `~/backups/letsencrypt-renewal-pre-34-2026-10-12/{animastor.org.conf,animastor.in.conf}` (08.10, тот же mono-webroot); `~/backups/letsencrypt-renewal-pre-34-2026-10-12/` не трогать |

### 3.2 План изменения webroot (БЕЗ выполнения сейчас)
1. **Подготовка (отдельный будущий этап, root):** выяснить и зафиксировать причину отказа
   `certbot.service` от 20.10 (`journalctl -u certbot.service`, `/var/log/letsencrypt/letsencrypt.log`,
   `certbot renew --dry-run -v`). **Стоп-условие:** причина не устранена → этап TLS не начинать.
2. **Определить новый webroot** (например, каталог из `animastor-web` либо отдельный
   `/var/www/animastor-acme`), который nginx будет отдавать по
   `/.well-known/acme-challenge/` — **путь выбирает владелец** (B2).
3. **До смены:** положить тестовый токен в *текущий* webroot и убедиться, что
   `curl http://animastor.org/.well-known/acme-challenge/<token>` и
   `https://animastor.org/...` возвращают 200 с этим токеном (доказательство, что цепочка
   nginx→mount→ACME работает сейчас).
4. **Переключение (будущий этап):** правка только `[[webroot_map]]`/`webroot_path` в двух
   renewal-конфигах (`cp`-бэкап рядом) + `root` в nginx ACME-location (после `nginx -t`)
   + reload nginx. Никаких `--force-renewal`.
5. **Доказательство успешного продления после переключения (критерий PASS):**
   - `sudo certbot renew --dry-run` → exit 0, в выводе по **обоим** lineage
     «congratulations/ simulated renewal» (dry-run не трогает боевые сертификаты);
   - следующий автоматический запуск `certbot.timer` → `systemctl is-failed certbot.service`
     = `inactive`, journal без ошибок;
   - после реального продления: `notAfter` вырос, серийный номер сменился,
     `curl -vI https://animastor.org/` показывает новую дату истечения, сайт/`/health` = 200;
   - откат при отказе dry-run/реального продления: вернуть прежние `webroot_path`
     из `~/backups/letsencrypt-renewal-pre-34-2026-10-12/`, `nginx -t` + reload.

---

## 4. Резервное копирование и восстановление

### 4.1 `~/backups/backup_animastor.sh` — факты
- `PROJECT_DIR=~/animastor`, `tar -czvf backup_animastor_$DATE.tar.gz -C ~ animastor`
  с исключениями: `*.safetensors *.gguf *.pt *.bin *.ckpt models/* checkpoints/* *.tar *.tar.gz`
  и `animastor/data/output`.
- **Расписание отсутствует**: crontab пуст, systemd-таймеров нет — запуск только вручную
  (11 упоминаний в `.bash_history`; фактические архивы: 16.09, 01.10, **08.10.2026**).
- Реальные сохраняемые пути (проверено по `tar -tzf` архива 08.10, 124 539 записей):
  `.git` (3176 записей, **устарел**: в mono есть коммиты 11.10 и 20.10), `data/books`,
  `backend/ai`, `proxy/conf` (вкл. `.htpasswd`), `frontends/app/dist` (8/8),
  `frontends/website/downloads` (вкл. APK), `app_pictures`, `backups/*.zip` (94/94),
  `.env`, `docker/`, `scripts/`, `packages/`, `node_modules`.
- **Не сохраняется:** `data/output` (исключено явно), **всё, что `*.tar`/`*.tar.gz`**,
  в т.ч. вложенные архивы монорепо.

### 4.2 Полнота покрытия (классификация всех файлов монорепо, без `.git`/`node_modules`)
| Категория | Файлов | Средство восстановления | Свежесть |
|---|---|---|---|
| git-tracked | 1304 | `~/repos/animastor.git` (fsck чистый, HEAD `4574b3b9`) | **20.10 — актуально** |
| `data/books` + `data/output` | 156 | `cutover-data-2026-10-12.tgz` (sha256 в `backup-manifest-2026-10-12.sha256`) | 12.10, расхождение 1 файл (`book.json`) |
| прочее (3527 файлов: `dist`, `.env`, `.htpasswd`, APK, `app_pictures`, 94 zip, `local.properties`, `.freebuff`) | 3527 | `backup_animastor_2026-10-08_19-46.tar.gz` | 08.10 |
| `docker/compose/overlay-backend-standalone.yml` (untracked) | 1 | `git-untracked-2026-10-12_06-17-10.tar.gz` | 12.10 |
| **вложенные `backups/*.tar.gz` монорепо** | **15 (~974M; 14 уникальных)** | **не покрыты ничем** (исключены правилом `*.tar.gz`; `git_repos_*`/`git-worktrees_*` — только repos/worktrees) | **ПРОБЕЛ** |
| **`backups/deploy-apply-20261010/` (7 файлов), `backups/deploy-rollback-20261010/` (5 файлов)** | 12 (108K) | **не покрыты** (созданы 10.10, последний полный бэкап 08.10; содержат compose/inspect/env/images-снимки) | **ПРОБЕЛ** |
| `frontends/android/.gradle`, `app/build/**/*.bin` (кэши Gradle/сборки) | 18 | не покрыты; **воспроизводимы** (`gradle-8.12` 145M, `app/build` 105M) | некритично |
| `node_modules` (2.2G) | — | не покрыты; воспроизводимы (`npm ci`) | некритично |

**Итог:** аккуратной полной резервной копии монорепо «на сейчас» **нет**.
Наиболее ценный непокрытый объём — **15 вложенных архивов (~974M)** и **12 файлов
deploy-снимков 10.10**.

### 4.3 Перечень данных, требующих НОВОЙ полной резервной копии (создавать НЕ сейчас)
1. `backups/*.tar.gz` монорепо — 15 файлов, ~974M (14 уникальны, максимумы 167M/167M/162M).
2. `backups/deploy-apply-20261010/`, `backups/deploy-rollback-20261010/` — 12 файлов.
3. `data/output` + `data/books` — свежая копия (текущая: 12.10, 1 расхождение).
4. `frontends/app/dist/` (8 файлов) — единственный собранный SPA-бандл.
5. `frontends/website/downloads/animastor-android-latest.apk` (12.5M) + `version.json`.
6. `proxy/conf/.htpasswd` (44 Б, секрет, копии нет).
7. `backend/ai`, `backend/tests` (покрыты git, но нужны и в копии данных для автономности).
8. `docker/compose/overlay-backend-standalone.yml` (untracked) + `frontends/website/index.html` (dirty) —
   текущее состояние рабочего дерева, включая незакоммиченное.
9. `.env` (legacy) и выписка диффа к `deploy/.env` (без значений секретов).
10. Полный манифест sha256 всего вышеперечисленного.

### 4.4 Процедура проверки восстановления (будущая, план; сейчас не выполняется)
1. Создать архив **без** исключения `*.tar.gz`/`data/output` (но с исключением
   `node_modules`, `.gradle`, `app/build` как невоспроизводимого-ненужного);
   рядом — `manifest.sha256` (sha256sum всех файлов) и `inventory.txt` (пути+размеры+mtime).
2. `tar -tzf <архив> | wc -l` == числу строк `inventory.txt`; `gzip -t` == 0;
   `sha256sum -c manifest.sha256` == 0 ошибок.
3. **Мок-restore:** распаковать в отдельный scratch-каталог (не в рабочие пути),
   повторить `sha256sum -c` в месте восстановления → 0 ошибок.
4. Проверка git: `git -C <восстановленный> fsck --no-dangling` + `git rev-parse HEAD`
   == `4574b3b9…`; `git status --porcelain` совпадает с исходным (включая `M index.html`).
5. Выборочная проверка данных: сверить размеры/hashes 10 файлов `data/output`
   и всех `data/books` с исходниками.
6. Критерий **PASS:** шаги 2–5 без ошибок. **BLOCKED:** любое расхождение хэшей,
   отсутствие файлов, невосстановимый `.git`.

---

## 5. Источник истины GPU Hub (все расхождения; решение НЕ принимается)

**Сравнение:** `mono/packages/animastor-gpu-hub` ↔ `animastor-gpu-hub/` (рабочая копия, чистая)
↔ **GitHub `master@0f489c7`** (проверено `git ls-remote` + sha256 raw-файлов:
`gpu-hub.js`, `server.js`, `package.json`, `artifacts.lock.json`, `Dockerfile`
**github == локальному репозиторию**). Итого: 4 идентичных, **8 изменённых**,
**7 только в монорепо**, **8 только в репозитории** (19 файлов mono / 20 репо, без node_modules).

### 5.1 Изменённые файлы (mono → repo)
| Файл | Ханков | +/− | Суть расхождения |
|---|---|---|---|
| `gpu-hub.js` | 10 | +134/−105 | **двустороннее**: в mono есть `BAKED-ARTIFACT STARTUP GATE`/`bakedTreeDigest`/`ARTIFACT_DIR_BY_GROUP` (вхождения 1/2/3), которых нет в репо; в репо есть `artifactDirEnvConfig` (3), которого нет в mono |
| `Dockerfile` | 1 | +29/−84 | mono: dual-stage `stager-monorepo`/`stager-release` (сборка из контекста монорепо + fetch pinned assets); репо: репродуцируемый релизный (`FROM node:20@sha256:8f693eaa…`, `npm ci`, `SOURCE_DATE_EPOCH`) |
| `artifacts.lock.json` | 1 | +32/−27 | разные схемы: mono — релизные ассеты (`release_tag`, `asset_filename`, `sha256_asset`, 4 группы: worker-bundle v2.1.1, hub-workflows/installer-src/install-manifests `hub-artifacts-v1`); репо — источники (`sources`: worker `b3f94f4…`, backend `a7a8c463…`) + `sha256_tree` 4 групп |
| `server.js` | 2 | +7/−1 | репо пробрасывает `artifactDirEnvConfig()` (директории артефактов), mono — нет |
| `package.json` | 2 | +4/−9 | mono `0.1.2` + `publishConfig.public` + ссылки на mono-репо + `CHANGELOG.md` в `files`; репо `0.1.0` + ссылки на standalone-репо |
| `package-lock.json` | 1 | +2/−2 | версия пакета 0.1.2 ↔ 0.1.0 |
| `tests/run-all.cjs` | 5 | +72/−46 | mono: «Phase 10T.1», frozen surface **13 routes**, check-7 «artifact bake-in»; репо: «Phase 10D», **14 routes**, check-7 «artifact resolution»; identity-проверка 0.1.2 ↔ 0.1.0 |
| `.dockerignore` | 1 | +1/−1 | различие в одном правиле |

### 5.2 Файлы, есть ТОЛЬКО в монорепо (7)
`CHANGELOG.md` (0.1.2, 10.10), `scripts/fetch-pinned-assets.sh` (B5: скачивание релизных ассетов
по lock), `scripts/verify-staged-artifacts.sh` (B5: integrity-gate стейджинга),
`tools/g4-standalone-build.sh`, `tools/g5-artifact-integrity.sh` (гарды G4/G5),
`tools/standalone-fixture.cjs` (локальная замена релизных ассетов), `tools/update-artifacts-lock.cjs`
(запись lock из исходников монорепо).

### 5.3 Файлы, есть ТОЛЬКО в репозитории (8)
`DEPLOYMENT.md` (контракт mount'ов артефактов), `EXTRACTION.md`,
`.github/workflows/{ci.yml,ghcr-release.yml}`, `.gitignore`,
`scripts/stage-artifacts.cjs` (единственный продьюсер `artifacts/` пост-сплита),
`scripts/smoke-artifacts.cjs` (гейт внутри образа), `scripts/content-hash.cjs`.

### 5.4 Коммиты
- **Только в монорепо** (14 коммитов по пути), последние:
  `0c55b5a7` 10.10 fail-closed baked-artifact gate; `1c37e14a` 10.10 публикация 4 zip и пин `sha256_asset`;
  `ce1fb69c` 10.10 bump 0.1.2/0.1.1; `60f8b9ee` 08.10 миграция домена; `64127b9e`/`63c75362`/`04da33ea` 03.10 гарды G1–G5.
- **Только в репозитории** (с 06.09 по 12.10), последние:
  `0f489c7` 12.10 G3 repin; `ecefd0b`/`d4f9d47`/`2811ce6`/`06e7bd0` 07–08.10 репродуцируемость digest;
  `1bfd119`/`307648b`/`9b42075` 06.10 pinned sources + staging gate; `d1471e1` 06.10 «live mounts beat baked-in».
- Общего предка после сплита нет — это **параллельные линии**, объединение невозможно без ручного разбора.

### 5.5 Runtime-зависимости
- **Прод не использует файлы монорепо для GPU Hub**: контейнер `gpu-hub` работает на
  `ghcr.io/animastor/animastor-gpu-hub@sha256:3611c644…`, без mount'ов (проверено inspect);
  OCI-лейблов с revision у образа нет → **привязка образа к коммиту не доказана** (дополнительный вопрос B5).
- Mono-путь используется только для **локальной dev-сборки**: `mono/docker-compose.yml`
  (`build: context: .`, `dockerfile: packages/animastor-gpu-hub/Dockerfile`) и
  `mono/gpu-hub-rebuild.sh` (overlay `docker/compose/overlay-gpu-hub-local.yml`).
- История buildx содержит `LocalPath=/home/animastor/animastor` (только кэш сборок).

**Вывод:** расхождения **двусторонние и существенные** (режим доставки артефактов, схема lock,
версия пакета, число frozen-роутов, репродуцируемость образа). Источник истины **не выбирается**.
→ **B5: BLOCKED, решение владельца** (см. §8).

---

## 6. Процессы и автоматизация

### 6.1 Процессы (не останавливались)
| PID | Команда | Родитель | cwd | Назначение | Как перезапускать | Влияние отвязки |
|---|---|---|---|---|---|---|
| **4094862** | `-bash`, tty `pts/1`, живёт с 2026-09-10 (40 дней), state `Ss+` | **4094861 = `tmux new -s opencode1`** (дети systemd PID 1) | `/home/animastor/animastor` | интерактивная оболочка в tmux-сессии `opencode1`; fd-файлов из монорепо **нет** (0) | не требует: после `mv` каталога cwd станет недействительным; новая сессия = `tmux new -s opencode1` из любого каталога | низкий: только сломается cd/относительные пути у этой сессии |
| **945866** | `node /tmp/opencode/run-connector.js`, tty `-`, с 2026-09-04 (46 дней) | **PID 1** (осиротевший, `PPid=1`, сессия 945865) | `/home/animastor/animastor` | opencode-коннектор (env-ключи `OPENCODE_*`, `AGENT`); зафиксирован и в отчёте Stage 25; **скрипт `/tmp/opencode/run-connector.js` УЖЕ УДАЛЁН** (inode жив) | **как есть невосстановим**: файла скрипта нет, супервизора/юнита нет → возможен только перезапуск из восстановленного источника (не найден в репозиториях) | низкий: 0 fd/монтирований в монорепо; cwd переживёт `mv`, сломается при `rm` |

Оба процесса владеют только cwd, не файлами монорепо. Ни один не является сервисом.

### 6.2 Автоматизация, указывающая на монорепо (классификация)
| Объект | Тип ссылки | Статус |
|---|---|---|
| `animastor-backend/deploy/docker-compose.yml` (8 mount'ов) | **production** | **B1** |
| `animastor-backend/deploy/overlay-backend-standalone.yml` (4 mount'а) | production | **B1** |
| `/etc/letsencrypt/renewal/{animastor.org,animastor.in}.conf` (`webroot_path`, `webroot_map`) | **TLS** | **B2** |
| nginx ACME `root /usr/share/nginx/frontends/website` (= mount монорепо) | **TLS** | **B2** |
| `~/backups/backup_animastor.sh` (`PROJECT_DIR=~/animastor`) | **backup** | **B11** |
| `animastor-worker/.../start-worker.sh` (`BASE_DIR=~/animastor`), `start-video.sh`, `bootstrap-{light,video}.sh` (`~/animastor/logs`, `~/animastor/worker/`) | worker-автоматизация | **B10**; на этом хосте `~/animastor/worker` и `~/animastor/logs` **не существуют**, локальный worker не запущен — ссылки «спящие» |
| `animastor-backend/scripts/animastor-runtime-audit.sh` (строки 415, 540–544) | диагностический скрипт | не блокирует (кандидат на правку) |
| `animastor-backend/deploy/README.md` (исторические строки; утверждение «`.env` byte-identical» **устарело** — различаются 2 пина) | документация | не блокирует |
| `mono/scripts/*` (сами в себе, относительные пути) | внутренние | уходят вместе с каталогом |
| `mono/*.sh` (`gpu-hub-rebuild.sh`, `apk-build.sh`, `app-web-rebuild.sh`) | локальная сборка | уходят с каталогом |
| CI/CD: `.github/workflows/*` активных репо | — | путей к монорепо **нет** (проверено) |
| cron (`crontab`, `/etc/cron.d`), systemd (system/user) | — | animastor-записей **нет**; есть только `certbot.timer` (см. §3) |
| Git hooks (монорепо + 6 рабочих + 6 bare) | — | кастомных **нет** |
| `.config/manicode/**`, `.local/share/mc/history`, opencode-логи, `~/.docker/buildx/refs/*` | история/кэш инструментов | не блокируют |
| `animastor-docs*/**`, `animastor-worker/docs/**` | исторические упоминания | не блокируют |

---

## 7. План будущего вывода монорепо из эксплуатации

> Все команды ниже — **будущие**. В Stage 88 не выполняется ни одна из них.
> Запрещено на любом этапе: `docker compose down`, `rm -rf`, `--force-renewal`,
> `git push/reset/rebase`, изменение refs/remotes, очистка Docker/каталогов.

### Этап A — Полная резервная копия и проверяемое восстановление
- **Предусловия:** B3 не влияет (TLS не трогаем); достаточно диска (нужно ≈1.5–2G при 19G свободно).
- **Действия:** новая полная копия по §4.3 + манифест sha256; мок-restore в scratch-каталог по §4.4.
- **Проверки:** `gzip -t`, `sha256sum -c` (0 ошибок), `git fsck` + `HEAD==4574b3b9`,
  сверка `data/output`/`data/books` по хэшам, сверка `status --porcelain` (вкл. dirty-правку).
- **Ожидаемый результат:** PASS — копия восстанавливается байт-в-байт.
- **Rollback:** удалить scratch; рабочие пути не изменялись.
- **Стоп-условие (BLOCKED):** несоответствие хэшей, отсутствие файлов, повреждённый `.git`,
  недостаток места → не переходить к B/C.

### Этап B — Разрешение расхождений GPU Hub и прочих уникальных файлов
- **Предусловия:** этап A PASS.
- **Действия (решения владельца, без автокопирования):** выбрать источник истины по §5
  (repo/GitHub ↔ mono), разобрать 8 изменённых файлов вручную; решить судьбу 7 mono-only
  и 8 repo-only файлов; определить дом для `.htpasswd` (B8), APK (B8), `dist` (B4/п.4);
  разобрать 24 расхождения `backend/tests` (B6) и untracked `deploy/` (B7).
- **Проверки:** каждый файл — либо «переносится в репозиторий отдельным коммитом после
  согласования», либо «признаётся устаревшим с фиксацией в отчёте»; после этого
  `diff -rq` mono↔repo по согласованным путям = 0 либо задокументированное исключение;
  `git -C animastor-gpu-hub status` чистый, GitHub == локальному.
- **Ожидаемый результат:** список «источник истины» утверждён по каждому файлу; 0 неразобранных расхождений.
- **Rollback:** ничего не копируется автоматически — откат = отменить решение (файлы не менялись).
- **Стоп-условие (BLOCKED):** владелец не выбрал источник истины → этапы C–G не начинаются.

### Этап C — Перенос/замена production-зависимостей (по одному переключению)
- **Предусловия:** A PASS, B PASS; для п.5–6 дополнительно свежая копия данных; для TLS — этап D.
- **Порядок и проверки (каждое переключение отдельно):**
  1. **`proxy/conf/default.conf` → `animastor-backend/proxy/conf`** (sha уже равны):
     правка одной строки mount в `deploy/docker-compose.yml` → `docker compose … config` (валидация)
     → `docker exec animastor-proxy nginx -t` → `docker compose --project-name animastor up -d --force-recreate nginx`
     (без `down`) → проверки: 200 на `/`, `/health`, `/docs/`, `/gpu/`, `/downloads/`,
     `nginx -T | grep -c mono-путь` = 0.
     **Rollback:** вернуть прежнюю строку mount + `up -d --force-recreate nginx`.
  2. **`.htpasswd` → новое хранилище** (после B8): копия с `sha256sum`-сверкой
     `6405f1b7…`, mode 600, mount → проверка 401/200 на admin-роутах.
     **Rollback:** прежний mount из монорепо (файл не удалялся).
  3. **`frontends/website` → `animastor-web/frontends/website`** (+ дом для APK):
     `diff -rq` = 0 по 9 файлам; `sha256sum index.html` == `a1900f4e…` (то, что отдаётся сейчас);
     переключение → проверки: 200 `/`, `/downloads/animastor-android-latest.apk` 200 и sha не изменился,
     `/library/` 200, ACME-проба-токен 200.
     **Rollback:** прежний mount; сайт мгновенно возвращается.
  4. **`frontends/app/dist` → дом для dist** (после сборки из `animastor-web` и проверки):
     сравнение `index.html`/роутинга/`/health` поведения на `app.animastor.org`;
     **Rollback:** прежний mount (dist в монорепо сохранён).
  5. **`backend/ai` → `animastor-backend/backend/ai`** (0 расхождений):
     переключение → `docker logs animastor-backend --since 2m` без ошибок загрузки AI-конфигов,
     `curl /health` 200, `/api/` 200. **Rollback:** прежний mount.
  6. **`backend/tests` → `animastor-backend/backend/tests`** — только после решения B6.
     **Rollback:** прежний mount.
  7. **`data/books`, `data/output` → постоянный каталог вне монорепо** — только после этапа A
     (свежая копия) и решения владельца о расположении (B12/место).
     Порядок: остановить запись (перевести backend в обслуживание на уровне API, **не** `down`),
     `cp -a`/`rsync -a` с `--checksum`-сверкой, сверка `find -type f | sha256sum` = 0 диффов,
     переключение mount, `up -d --force-recreate backend`, проверки:
     `ls /data/books`, `ls /data/output`, число файлов 61/95, `/health` 200, чтение/запись книги через API.
     **Rollback:** вернуть mount на монорепо (каталоги не удалялись) + `up -d --force-recreate backend`.
- **Ожидаемый результат:** `docker inspect` всех контейнеров не содержит
  `"/home/animastor/animastor/"` как source; все endpoint-проверки 200.
- **Стоп-условие (BLOCKED):** любой 4xx/5xx, ошибка монтирования, потеря данных, 404 на ACME →
  немедленный rollback соответствующего пункта и остановка этапа.

### Этап D — Certbot / TLS
- **Предусловия:** этап C.3 выполнен (nginx ACME от нового источника) либо согласовано
  одновременное переключение; **B3 устранён** (причина отказа 20.10 установлена и устранена).
- **Проверки/доказательства:** по §3.2, п.3 → п.4 → п.5 (dry-run exit 0 по обоим lineage,
  следующий автозапуск таймера без ошибок, после реального продления выросший `notAfter`).
- **Rollback:** восстановление `webroot_path` из
  `~/backups/letsencrypt-renewal-pre-34-2026-10-12/` + `nginx -t` + reload.
- **Стоп-условие (BLOCKED):** dry-run с ошибкой, отказ `certbot.service` после переключения,
  недоступность `/.well-known/acme-challenge/`.

### Этап E — Перевод backup-скрипта и автоматизаций на новые пути
- **Предусловия:** этапы A (новая копия уже по новым путям) и C (пути переключены).
- **Действия:** `backup_animastor.sh` → новая цель (п. B11) **без** исключения
  `data/output` для нового каталога данных; worker-скрипты `animastor-worker`
  (`BASE_DIR=~/animastor`, `~/animastor/logs`, `~/animastor/worker`) → новая схема (B10);
  правка `animastor-runtime-audit.sh` (строки 415/540–544); актуализация `deploy/README.md`
  (утверждение про byte-identical `.env`).
- **Проверки:** сухой прогон `bash -n` + `shellcheck`-замечания; запуск бэкапа **один раз**
  с последующей проверкой `tar -tzf`/`gzip -t` и отсутствием путей монорепо в новом архиве
  (кроме намеренно сохраняемого архива-памятника).
- **Rollback:** вернуть прежнюю версию скрипта (копия в git `~/backups`).
- **Стоп-условие (BLOCKED):** бэкап не проходит проверку целостности.

### Этап F — Проверка сервисов, TLS, данных и восстановления после сбоя
- **Предусловия:** C и D PASS, E выполнен.
- **Проверки:** `https://animastor.org/` 200, `app.animastor.org` 200, `/health` 200,
  `/docs/` 200, `/gpu/` штатный ответ, `openssl s_client` даты валидности,
  `docker ps` все сервисы Up, `systemctl is-failed certbot.service` = inactive,
  число книг/выводов в БД и на диске не изменилось (61/95 + `cutover-pg` сверка),
  `git status` действующих репозиториев без неожиданных изменений,
  **kill-тест восстановления**: разбор архива этапа A в scratch + `sha256sum -c` (0 ошибок).
- **Rollback:** по таблице этапа C/D (каждый mount/конфиг возвращается отдельно).
- **Стоп-условие (BLOCKED):** любая деградация из перечисленного.

### Этап G — Выявление оставшихся обращений к монорепо
- **Предусловия:** E и F PASS.
- **Проверки (только чтение):** повторный полный скан
  `grep -rIl "/home/animastor/animastor/"` и `~/animastor` по `/home /etc /opt /usr/local`
  (исключая исторические доки/логи) → допустимы только документационные упоминания;
  `docker inspect` по всем контейнерам → 0 mount-источников из монорепо;
  `find -xdev -type l -lname '/home/animastor/animastor/*'` → 0;
  `/proc/*/cwd` scan → 0 (кроме признанных интерактивных сессий);
  `certbot renew --dry-run` → 0.
- **Ожидаемый результат:** «рабочих» ссылок 0; список документационных упоминаний приложен.
- **Стоп-условие (BLOCKED):** найдена незадокументированная рабочая ссылка → вернуться к C/D/E.

### Этап H — Архивирование/удаление старого каталога (ТОЛЬКО после PASS A–G)
- **Предусловия:** PASS по A–G; **письменное решение владельца**; подтверждённая полная копия
  (этап A, с проверкой восстановления, не «архив просто существует»).
- **Действие (кандидат):** перемещение в явно обозначенный архив (тот же FS — `mv`, 0 лишних байт),
  напр. вне рабочего пространства; **необратимое удаление — только отдельным решением и позже**.
- **Проверки после:** все проверки этапа F повторяются; архив проходит `tar -tzf`/`git fsck`;
  `ls /home/animastor` не содержит активной рабочей копии монорепо.
- **Rollback:** `mv` обратно на `/home/animastor/animastor` + `up -d --force-recreate nginx backend`
  → сервисы восстанавливаются из прежних mount-путей.
- **Стоп-условие (BLOCKED):** любой сбой сервисов/TLS/данных после перемещения → немедленный rollback.

**График зависимостей:** A → B → C → (D после C.3) → E → F → G → H. D и B10/B11 допускают
параллельную подготовку, но не исполнение.

---

## 8. Блокеры (12) и решения, которые должен принять владелец

| # | Блокер | Что должен решить владелец / что требуется |
|---|---|---|
| **B1** | 8 production bind-mount'ов из монорепо (§2) | утвердить новые источники: `animastor-backend/proxy/conf`, `animastor-web/frontends/*`, `animastor-backend/backend/{ai,tests}` и корень данных |
| **B2** | TLS-webroot в монорепо (2 renewal-конфига + ACME-`root` nginx) | выбрать новый ACME webroot и согласовать порядок D |
| **B3** | **`certbot.service` завершился с exit 1 2026-10-20 02:27:50; причина нечитаема без root** | **BLOCKED:** предоставить root-диагностику (`journalctl`, `/var/log/letsencrypt/`, `certbot renew --dry-run -v`) до этапа D |
| **B4** | Нет свежей полной копии: 15 вложенных `*.tar.gz` (~974M) и 12 файлов `deploy-{apply,rollback}-20261010` не покрыты; `data/output` только на 12.10; последний полный бэкап 08.10 | утвердить состав/место новой полной копии (§4.3) и процедуру её проверки (§4.4) |
| **B5** | **GPU Hub: двустороннее расхождение (8 файлов, 7 mono-only, 8 repo-only, 2 схемы lock, 13↔14 роутов, 0.1.2↔0.1.0, две линии коммитов)** | **BLOCKED:** выбрать источник истины по каждому файлу/блоку; подтвердить, каким коммитом собран работающий GHCR-образ (лейблов revision нет) |
| **B6** | `backend/tests`: 24 изменённых + 9 только-в-репо (смонтирована старая копия) | решить, репозиторий ли — источник истины для тестового mount |
| **B7** | Прод-конфиг (`deploy/`: compose + overlay + `.env`) — **untracked**; `deploy/README.md` утверждает «`.env` byte-identical», но различаются `BACKEND_IMAGE`/`GPU_HUB_IMAGE`; `mono/.env` содержит устаревшие пины | взять prod-deploy под git-контроль (отдельным решением) и актуализировать документацию |
| **B8** | Уникальные файлы без дома в репозиториях: `.htpasswd` (44 Б), `frontends/website/downloads/animastor-android-latest.apk` (12.5M), `frontends/app/dist/` (8 файлов) | назначить хранилища/порядок публикации (секреты — вне git, 600) |
| **B9** | Процессы: 4094862 (tmux-shell, cwd в монорепо) и **945866 (осиротевший node, скрипт удалён — невосстановим как есть)** | решить судьбу 945866 (оставить/восстановить скрипт/завершить — **не выполняется без разрешения**) |
| **B10** | Worker-скрипты `animastor-worker` адресуют `~/animastor` (`BASE_DIR`, `logs`, `worker/`) — на хосте этих каталогов нет («спящие») | согласовывать новую схему установки worker до любых будущих развёртываний |
| **B11** | `~/backups/backup_animastor.sh` → `PROJECT_DIR=~/animastor`, без cron (запуски вручную, последний 08.10) | утвердить новый источник бэкапа и, при желании, расписание |
| **B12** | Смежное: локальный `animastor-tools` пуст (0 коммитов) при GitHub `main@8851479`; `backups/animastor-pre-split-*.git` и `before-split-*-refs` — чтение только | подтвердить, что tools/pre-split не планируется трогать на этом этапе (за рамками Stage 88) |

**Не заблокировано (подтверждено в Stage 88):** bare-репозитории и GitHub-refs согласованы;
`data/*` фактически не менялись с 12.10 (1 файл); `frontends/website` (9 файлов) и
`backend/ai` (54 файла) байт-идентичны своим репозиториям; `default.conf` идентичен копии
в `animastor-backend`; cron/systemd/custom hooks/CI-пути к монорепо отсутствуют;
`gpu-hub` и pg/redis от монорепо не зависят; `/docs/` уже обслуживается из
`animastor-docs-deploy`.

---

## 9. Что НЕ делалось в Stage 88

Не выполнялось: миграция/копирование/переименование чего-либо; изменение compose, nginx,
certbot, cron, systemd, hooks, backup-скриптов; перезапуск/остановка контейнеров и процессов;
`docker compose down`, очистка Docker; push/force-push/reset/rebase, изменение refs/remotes;
создание/удаление резервных копий; `certbot renew` (в т.ч. dry-run — требует root и
является шагом будущего этапа D). Изменения затрагивают только настоящий отчёт.
