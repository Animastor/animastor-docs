# Animastor — Этап 22: G1 READINESS AUDIT (только аудит)

- Дата: 2026-10-12
- Режим: **строго read-only.** Не выполнялось: production changes, рестарты,
  Compose switch, dispatch, repin, republish, git push, удаления, очистка
  журналов, изменение lock-файлов/секретов/DNS/TLS; резервное копирование и
  restore не запускались; секреты не читались и не выводились.
- Источники: `21-production-cutover-runbook.md`, `20-owner-decisions.md` +
  аудиты 13/18/19/20; фактические измерения этого этапа (все команды — в тексте).
- Объём G1: допуск к началу исполнения runbook (фазы A–B) по данным, которые
  можно подтвердить сейчас без разрешений/root.

---

## 1. DISK PREFLIGHT

**Измерение (точное, `df -B1`, 2026-10-12):**

| Параметр | Значение |
|---|---|
| Файловая система | `/dev/sda2` на `/`, всего `105496965120` Б |
| Занято | `85842599936` Б (86%) |
| **Свободно** | **`15137263616` Б** |
| Порог runbook (§6) | `15000000000` Б |
| Запас над порогом | `137263616` Б (<1%) |
| Порог под pull нового gpu-hub-образа (D0) | `16600000000` Б — **НЕ выполнен** (дефицит ≈1,46 ГБ) |

**Сравнение со stage-21 (последний замер того этапа: `15138779136` Б):**
свободно уменьшилось на `1515520` Б (~1,5 МБ) — обычная фоновая активность;
новых крупных prod-файлов не выявлено.

**Крупные объекты и логи (проверено `find`/`du`, без очистки):**

| Объект | Размер | Природа | Влияние |
|---|---|---|---|
| `/home/animastor/.local/share/opencode/opencode.db` | 9 571 028 992 Б | БД агентного инструмента (не prod); растёт (2026-10-11: +WAL 77 МБ, лог 58 МБ) | главный потребитель диска; **удаление только с отдельного разрешения** |
| `/var/log/journal` | 3 833 876 480 Б | systemd-журнал (многократно файлы по 75 497 472 Б) | пополняемо root-командой `journalctl --vacuum-size=200M` (по runbook A1/D0 — отдельное разрешение) |
| `/var/log` (всего) | 4 088 274 944 Б | из них journal — 3,83 ГБ; `/var/log/letsencrypt`, `private`, `unattended-upgrades` — без root недоступны | часть метаданных логов скрыта от пользователя |
| `/tmp` | 1 210 855 424 Б | временные/служебные (частично root-only) | можно кешировать в /tmp |
| `/home/animastor/backups/*` | 3 273 840 000+ Б (каталог) | бэкапы (см. §2) | запрещено удалять |
| `libtorch_cpu.so` | 434 184 800 Б | python/ML-зависимости | не трогать |

**Docker-ресурсы (без изменений vs stage-21):** Images 7 / 12,92 GB
(backend 2,47 GB + gpu-hub 1,58 GB + ollama 9,19 GB и др.), Containers 8,
Local Volumes 36 / 3,629 GB (активны 5), Build Cache 0.

**Вывод §1: порог `15000000000` Б СОБЛЮДЁН → PASS.** Одновременно:
запас <1%, а критерий pull-гейта D0 (`16600000000` Б) не выполнен — до
pull нового образа обязателен root-journal-vacuum (3,83 ГБ журнала) или
отложенный pull. Очистка в этом этапе не выполнялась и не разрешается.

---

## 2. BACKUP / RESTORE (что реально существует)

### 2.1 Подтверждённые процедуры и артефакты

| Механизм | Путь | Тип/покрытие | Владелец/права | Объём/артефакты | Зависимости |
|---|---|---|---|---|---|
| Полный тар проекта | `/home/animastor/backups/backup_animastor.sh` | `tar -czf backup_animastor_<дата>.tar.gz -C ~ animastor` с exclude: `*.safetensors/gguf/pt/bin/ckpt`, `models/*`, `checkpoints/*`, `*.tar(.gz)`, **`animastor/data/output`** | animastor:animastor, 775 каталог (`drwxrwxr-x`) | архивы ~1 ГБ: `backup_animastor_2026-09-16_16-23.tar.gz` (1 026 232 288 Б), `…2026-10-01_03-15…` (1 039 124 745 Б), `…2026-10-08_19-46…` (1 088 241 031 Б) | tar/gzip; **не содержит `data/output` и PG-дампа** |
| Исходники (zip) | `/home/animastor/backups/src-backup.sh` (копии также в mono и backend-repo) | python-zip: исходники/текст-конфиги, exclude `.git/node_modules/build/...`; выход в `backups/animastor-src-*.zip` | animastor:animastor | десятки zip ~1,4–2 МБ (июль–октябрь) | python3 |
| GPU | `/home/animastor/backups/backup_gpu.sh` | `tar ./gpu` → `./backup/backup_gpu_*.tar.gz`, авто-удаление старше 30 дней | animastor:animastor | `gpu-video-backup-animastor-2026-08-11.tar.gz` (40 060 942 Б; копия и в mono `backups/`) | cwd с `./gpu` |
| Git (legacy) | `/home/animastor/backups/git_backup.sh` | тарит `$HOME/git` → `$HOME/net-disk` | animastor:animastor | **сломан**: `~/git` и `~/net-disk` не существуют | нерабочие пути |
| VCS-зеркала | `/home/animastor/repos/animastor{,-web,-worker,-backend,-gpu-hub,-android}.git` | bare-репозитории (origin у worktree) | animastor:animastor 775 | 41,9 + 9,2 + 5,1 + 3,2 + 0,9 + 0,4 МБ | **bare отстаёт от GitHub** (см. J1 runbook) |
| Pre-split-снапшот | `/home/animastor/backups/animastor-pre-split-64127b9e.git` | bare-зеркало монорепо до сплита | animastor:animastor | — | — |
| Исторические тары | `/home/animastor/animastor/backups/*.tar.gz` (июнь–август) | точечные снапшоты mono | animastor:animastor | до ~174 МБ каждый | — |

### 2.2 Целостность и восстановление (проверяемость)
- **Целостность — подтверждена read-only:** `gzip -t` последнего полного
  архива `backup_animastor_2026-10-08_19-46.tar.gz` → **OK** (16,8 с).
  Состав верхнего уровня: `animastor/{backend,data,…}`; `animastor/.env`
  **присутствует** (содержимое НЕ читалось); `animastor/data/output` —
  **0 вхождений** (подтверждён exclude скрипта).
- **Способ проверки целостности в будущем:** `gzip -t <архив>` +
  `tar -tzf <архив> | grep -c <ожидаемый путь>` (без распаковки).
- **Restore-дрель:** НЕ выполнялась (запрещено этапом); метод восстановления
  описан только процедурно: распаковка в изолированный каталог + сверка
  ключевых путей + импорт PG-дампа в тестовый контейнер — требует отдельного
  разрешения и окна.

### 2.3 Пробелы (влияют на готовность cutover)
1. **PG-дампов не существует и механизма нет:** `rg 'pg_dump'` по
   `/home/animastor/backups`, mono `*.sh`, `tools` — 0 находок. Данные
   живут только в docker-томе `animastor_pg-data`. → закрывается шагом
   **A3 runbook** (pg_dump из контейнера).
2. **`data/output` исключён из всех полных бэкапов** (проверено grep-ом по
   архиву). → A3 должен архивировать `data/` целиком.
3. **Секреты внутри архивов:** `.env` входит в тар-бэкапы, а права файлов
   бэкапа — `-rw-rw-r--` (664, group-readable). Рекомендация (без действий
   здесь): новые бэкапы A2 хранить `chmod 600`; не читать/не копировать
   содержимое `.env` в отчёты.
4. **`git_backup.sh` нерабочий** (несуществующие пути) — не использовать.

**Вывод §2: процедуры для КОНФИГУРАЦИИ и КОДА существуют и проверяемы
(целостность последнего архива подтверждена) → PASS по факту наличия;
НО для cutover обязательные копии (A2/A3: конфиг-тар, `data/` целиком,
pg_dump) ЕЩЁ НЕ СОЗДАНЫ, PG-механизма не существовало → этот пункт G1
закрывается только выполнением фазы A.**

---

## 3. DEPLOY LAYOUT (факт vs цель runbook)

### 3.1 Реальные mounts prod-контейнеров (docker inspect, read-only)

| Контейнер | Образ (digest) | Mounts (тип | источник | назначение | режим) |
|---|---|---|---|---|
| `animastor-backend` | `ghcr.io/…/animastor-backend@sha256:e8152778…` | bind: `…/backend/ai`→`/app/ai` (rw), `…/backend/tests`→`/app/tests` (rw), `…/data/output`→`/data/output` (rw), `…/data/books`→`/data/books` (rw) |
| `gpu-hub` | `ghcr.io/…/animastor-gpu-hub@sha256:daf510ff…` | **mounts отсутствуют** (baked-in, Phase 10T) ✓ |
| `animastor-proxy` | `nginx:alpine` | bind **ro**: `…/frontends/app`→`/usr/share/nginx/frontends/app`, `…/frontends/website`→`…/website`, `/etc/letsencrypt`→`/etc/letsencrypt`, `…/proxy/conf/.htpasswd`→`/etc/nginx/.htpasswd`, `…/proxy/conf/default.conf`→`/etc/nginx/conf.d/default.conf`, `…/docs`→`/usr/share/nginx/docs` |
| `animastor-pg` | `postgres:16` | volume `animastor_pg-data`→`/var/lib/postgresql/data` |
| `animastor-redis` | `redis:7` | volume `animastor_redis-data`→`/data` |

Все bind-источники существуют, владелец `animastor:animastor`
(`data/output`, `data/books` 755; `backend/ai`, `backend/tests` 775;
`frontends/*`, `docs` 755; `default.conf` 664/17 922 Б, `.htpasswd` 644/44 Б).
SHA: `default.conf` = `99f706aff608744949f50e6ead87e6f3bd55087f13723d4bb2c24b0912e36505`,
`.htpasswd` = `6405f1b770156035cde04e549445e4720f6150a6437790f52b9b6f3e9fd8af75`.

### 3.2 Сопоставление с целевой структурой (runbook §0/фаза E)

| Элемент цели | Статус |
|---|---|
| `data/`, `backend/ai`, `backend/tests`, `proxy/conf`, `frontends/*`, `docs` переезжают в абсолютные пути нового compose | источники существуют и подтверждены ✓ |
| `animastor-backend/deploy/` (новый layout) | **отсутствует** (`ls` → No such file) — создаётся в E1 (⚠ layout утверждается владельцем, G4) |
| `/etc/letsencrypt` для nginx | существует; каталог `live` — `drwx------ root` (700) → **содержимое требует root** (G6) |
| `frontends/website/downloads` (APK) и `.well-known` (ACME) | существуют **только в mono**; web-репо их не содержит → обязательный перенос E6 до смены website-монта |
| Web-dist `frontends/app/dist` (C9) | mono-dist смонтирован и работает; сборка web-репо ещё НЕ выполнялась (E5) |

**Неподтверждённые пути/зависимости (⚠ → prerequisite):** финальный layout
deploy-каталога; абсолютная перезапись путей в новом compose (требует
`docker compose config`-сверки в E2 — команда печатает секреты, потому
выполняется только в окне с владельцем); содержимое `/etc/letsencrypt/live`
(root); renewal-поведение после смены монта webroot (см. §5 — webroot сейчас
указан на mono-путь!); E2E-каталог `docker/e2e/` backend-repo (путь подтверждён
ранее, но workspace/воркер не подтверждены).

**Вывод §3: карта текущих mounts полная и совпадает с runbook §0 → PASS
по «что реально используется»; целевой layout остаётся ⚠ G4 (BLOCKED).**

---

## 4. ARTIFACT PUBLISH (штатный механизм, подтверждение по исходникам)

### 4.1 Публикация ОБРАЗОВ — механизм подтверждён (read-only)
- Источник: `/home/animastor/animastor-gpu-hub/.github/workflows/ghcr-release.yml`
  — **только `workflow_dispatch`**, immutable `image_tag`, пины читает из
  `artifacts.lock.json`, gate: `smoke-artifacts.cjs` + `sha256_tree`
  («any mismatch exits non-zero and the release FAILS»), digest пишет в run
  summary («REMEMBER: Record this digest»).
- Документация: `gpu-hub/DEPLOYMENT.md` §4 «Reproducible release build»
  (строки 93–127) описывает тот же процесс.
- Инструменты (проверено по исходникам): `scripts/stage-artifacts.cjs`
  (usage: `--worker <checkout> --backend <checkout> [--write-lock]`),
  `scripts/smoke-artifacts.cjs`, `scripts/content-hash.cjs`.
- Смоук-проверки живого релиза (sha256_asset 4/4 MATCH, lock `--check` exit 0)
  подтверждены в этапах 20–21.
- **Запуск публикации НЕ требуется для подтверждения** (исходники + документация
  + зелёные прогоны прошлых релизов достаточны) → **PASS**.

### 4.2 Публикация ZIP-АКТИВОВ (worker-bundle/installer-src) — механизм НЕ подтверждён
- `packages/animastor-gpu-hub/tools/standalone-fixture.cjs` — по собственному
  header-комментарию «builds a LOCAL, byte-faithful stand-in for the future
  release flow»; режим `assets-from-release` скачивает **из** release URL и
  верифицирует по `sha256_asset`. Это генератор локальных стенд-инов, **не
  загрузчик**.
- Сторона загрузки: `packages/animastor-gpu-hub/scripts/fetch-pinned-assets.sh`
  (download+verify), `verify-staged-artifacts.sh`, `g5-artifact-integrity.sh` —
  **только чтение/верификация**. Поиск загрузчиков (`releases/download|gh release|upload-release|octokit|createRelease`)
  в `mono/tools` и указанных `packages` — **0 автоматических загрузчиков**.
- Вывод: фактическая публикация 4 zip-активов v2.1.1 выполнялась **вручную**
  (тела релизов immutable; замена актива = новая публикация через GitHub UI/`gh`).
  Точный штатный процесс и учётные права не подтверждены; подтверждение
  потребовало бы запуск публикации/`gh`-токен → **остановлено по условию этапа**.
- **Вывод §4: образы — PASS; zip-активы — BLOCKED** (закрывается решением D4
  владельца: способ упаковки исправленного installer-src + способ загрузки,
  с архивированием старого актива).

---

## 5. TLS (read-only)

### 5.1 Текущие сертификаты (SNI через 127.0.0.1:443)

| Домен | CN/issuer | notBefore | notAfter | SAN |
|---|---|---|---|---|
| `animastor.org` (+`app.`, `www.`) | CN=animastor.org, LE YE2 | 2026-10-08 18:29:49 | **2027-01-06 18:29:48** | admin/app/www/animastor.org (**без .in**) |
| `animastor.in` (+`www.`) | CN=animastor.in, LE YR1 | 2026-08-21 11:42:11 | **2026-11-19 11:42:10** (через 38 дней) | — |

301-редиректы живы: `http://animastor.in/`, `https://animastor.in/`,
`http://www.animastor.in/` → **301 → `https://animastor.org/`** (3/3).

### 5.2 Renewal-инфраструктура
- `/etc/cron.d/certbot` (644, root): `certbot -q renew` каждые 12 ч, **но**
  только если systemd не init; на этом хосте **`certbot.timer` active+enabled**
  → фактический таймер — systemd (проверено `systemctl is-active/is-enabled`).
  Certbot `1.21.0` (`/usr/bin/certbot`).
- `/etc/letsencrypt/renewal/` (755, читаем): конфиги `animastor.org.conf`,
  `animastor.in.conf` (+ чужие `sureg.dev`, `ai.sureg.dev` — вне скоупа):
  `authenticator = webroot`, ACME prod, **`webroot_path = /home/animastor/animastor/frontends/website`** для ОБОИХ animastor-доменов.
  → **критическая зависимость: ACME-челлендж идёт в mono-каталог website**
  (включая `.well-known`) — любая смена website-монта обязана сохранить этот
  webroot (runbook E6/I1), иначе продление сломается.
- `/etc/letsencrypt/live` — `drwx------ root` (700): сертификаты/ключи
  читаются **только root**; `certbot renew`/`certbot certificates` — root.
  **Root-доступ обязателен** для: сверки lineage, `--dry-run`, реального
  продления (D5/G6), любых правок renewal-конфигов. Здесь не выполнялось.

**Вывод §5: состояние и механизм задокументированы read-only → PASS по
аудиту; продление `.in` (до 19.11) остаётся BLOCKED на root (G6/D5) —
отдельное действие владельца.**

---

## 6. G1 DECISION

| # | Пункт | Вердикт | Доказательства (путь/способ) | Необходимое действие | Критерий закрытия |
|---|---|---|---|---|---|
| 1 | Disk preflight | **PASS** (с риском) | `df -B1 /` → свободно `15137263616` ≥ `15000000000`; docker df без изменений; новых крупных prod-файлов нет (журнал 3,83 ГБ — root-only пополнение) | перед D-/H-окнами: root vacuumjournal (разрешение) → ≥ `16600000000` | каждый этап открывается `df -B1` ≥ порога |
| 2 | Backup/restore | **FAIL для cutover** (процедуры есть, обязательных копий нет) | `backups/backup_animastor.sh` + 3 архива (~1 ГБ, `gzip -t` последнего → OK); bare-репозитории; **pg_dump-механизма нет** (0 находок), `data/output` исключён из таров | выполнить runbook **A2/A3** (конфиг-тар 600, `data/` целиком, `pg_dump` из контейнера) в разрешённое окно | архивы A2/A3 существуют, `gzip -t` OK, дамп содержит `CREATE TABLE`; restore-дрель — отдельным разрешением |
| 3 | Deploy layout | **PASS** (факт) / **BLOCKED** (цель ⚠) | docker inspect: все 8 mounts перечислены и существуют, gpu-hub без mounts, pg/redis — named volumes `animastor_pg-data/redis-data`; `deploy/` отсутствует | G4: владелец утверждает layout; E1–E2 создают и сверяют новый compose (`config`-сверка — только в окне) | `config` без `build:`, image=digest; dry-run: pg/redis Running |
| 4 | Artifact publish | **PASS** (образы) / **BLOCKED** (zip-активы) | `ghcr-release.yml` + `DEPLOYMENT.md §4` + `stage-artifacts.cjs` usage + зелёные прогоны 20–21; загрузчик zip не найден (0 автоматических; fixture — стенд-ин) | D4: владелец подтверждает способ упаковки исправленного installer-src и способ загрузки актива (ручной GitHub Release) | новый актив скачан, sha зафиксирован, старый заархивирован |
| 5 | TLS | **PASS** (аудит) / **BLOCKED** (продление `.in` — root) | SNI: `.in` → 2026-11-19, `.org` → 2027-01-06; renewal: webroot на **mono**-путь `frontends/website`; `certbot.timer` active; `live/` 700 root; 301 ×3 живы | G6: root `certbot renew --dry-run` → renew до 19.11; после E6 — проверить webroot | SNI `notAfter` `.in` продлён ≥ 60 дней вперёд; 301 ×3 живы |

### Итоговый вердикт G1: **NO-GO**

Обязательные критерии не подтверждены:
1) обязательные cutover-бэкапы (A2/A3, включая pg_dump и `data/` целиком) не
созданы — без PG-дампа восстановление данных невозможно;
2) механизм republish zip-активов (D4) не подтверждён — остановлен на
границе запуска публикации/секрета;
3) продление `.in`-сертификата (дедлайн 2026-11-19) требует root и ещё не
выполнено; webroot-зависимость от mono-каталога website не устранена;
4) целевой deploy-layout (G4) не утверждён; pull-гейт диска (D0) не выполнен.

**Что НЕ мешало бы GO:** сам disk-порог соблюдён; карта mounts полна;
механизм публикации образов подтверждён; 301-редирект и оба сертификата
живы; lock-файлы и git-деревья в исходном состоянии.

**Путь к GO (закрывающие действия):** A1+A2+A3 (в разрешённое окно) →
решение D4 по zip-активам → root-продление `.in` (D5/G6) → G4-утверждение
layout + vacuum-разрешение под pull → повторный G1-аудит только со сверкой
этих четырёх пунктов.

---

## 7. Что НЕ выполнялось / ограничения этапа

| Действие | Статус |
|---|---|
| Резервное копирование / restore | не выполнялись (запрещено); `gzip -t`/`tar -tzf` — read-only верификация существующего архива |
| Секреты | `.env` не читался (только `stat`-метаданные и имя файла в tar-списке); renewal-конфиги читались только по нечувствительным ключам (authenticator/webroot/domains), email не выводился |
| Очистка/удаления | не выполнялись (журнал/кеш/opencode.db только зафиксированы) |
| root-действия | `/etc/letsencrypt/live`, `journalctl --vacuum`, `certbot renew` — не выполнялись, зафиксирована необходимость root |
| Запуск публикации/`gh` | остановлен (п. 4.2) |
| Compose-`config`-сверка | отложена в E2 (команда печатает секреты → только в окне с владельцем) |
