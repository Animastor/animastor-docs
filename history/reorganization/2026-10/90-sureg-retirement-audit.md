# Stage 90 — Retire Unused Sureg Certbot Domains

Дата: 2026-10-20
Режим: Этапы 1–2 — READ-ONLY аудит и план; Этап 3 (отключение) — выполнен позже по
отдельному письменному подтверждению владельца (см. «Этап 3»).
На этапах 1–2 не менялось: сертификаты, ключи, renewal-файлы, DNS, nginx/compose,
контейнеры; приватные ключи, токены и содержимое секретных файлов в отчёт не выносились.
Отчёты Stage 87/88/89 не изменялись.

---

## Статус

**PASS** — аудит завершён, план подготовлен, **отключение выполнено 2026-10-20 12:35 UTC
по отдельному письменному подтверждению владельца** (Этап 3), все контрольные проверки
пройдены. **BLOCKED-критерии не сработали:** общий (совместный) сертификат не обнаружен;
действующих потребителей `sureg.dev`/`ai.sureg.dev` на хосту не найдено. Внешний вопрос
Q-90-1 **закрыт подтверждением владельца** (2026-10-20): «sureg-домен не был запущен,
пользователей нет» → внешних потребителей нет, отключение безопасно. **Задача закрыта
владельцем 2026-10-20**; проверка лога после автоматического запуска timer (17:34 UTC)
признана необязательной (ручной запуск шёл по тому же ExecStart и дал exit 0).

---

# Этап 1. Аудит

## 1.1 Инвентаризация: все lineage Certbot (ровно 4)

| Renewal-конфиг | archive_dir | authenticator / webroot | mtime |
|---|---|---|---|
| `/etc/letsencrypt/renewal/sureg.dev.conf` | `/etc/letsencrypt/archive/sureg.dev` | webroot → `/home/sureg/sureg-dev/site,` | 2026-08-01 15:36:57, 644 |
| `/etc/letsencrypt/renewal/ai.sureg.dev.conf` | `/etc/letsencrypt/archive/ai.sureg.dev` | webroot → `/home/sureg/animastor/frontends/main` | 2026-08-01 15:36:47, 644 |
| `/etc/letsencrypt/renewal/animastor.org.conf` | `/etc/letsencrypt/archive/animastor.org` | webroot → `/home/animastor/animastor/frontends/website` (pref_challs=http-01, key_type=ecdsa) | 2026-10-08 19:28:54 |
| `/etc/letsencrypt/renewal/animastor.in.conf` | `/etc/letsencrypt/archive/animastor.in` | webroot → `/home/animastor/animastor/frontends/website` (key_type=rsa) | 2026-10-12 10:22:51 |

- `ls /etc/letsencrypt/renewal/` → **ровно эти 4 файла**, других lineage нет.
- Каталоги `live/` и `archive/` — права 700 (чтение сертификатных файлов с диска
  без root недоступно на этом этапе); `renewal-hooks/{pre,deploy,post}` — **0 файлов**;
  `/etc/letsencrypt/cli.ini` — только `max-log-backups=0` и `preconfigured-renewal=True`
  (никаких webroot/доменных настроек).
- Каждый lineage имеет **свой** `archive_dir`/`live` → линейки физически развязаны.

## 1.2 SAN, сроки, объединённые сертификаты

**Animastor (проверено напрямую TLS-handshake, читаемо без root):**

| Сертификат | SAN | notBefore → notAfter | serial |
|---|---|---|---|
| `animastor.org` | `admin.animastor.org, animastor.org, app.animastor.org, www.animastor.org` | 2026-10-08 → **2027-01-06 18:29:48 GMT** | `0629D2023990601157478A0A7F0150A3CE7A` |
| `animastor.in` | `admin.animastor.in, animastor.in, app.animastor.in, www.animastor.in` | 2026-10-12 → **2027-01-10 09:24:17 GMT** | `06F86F4951CEF84BB76CF8B7894115A6DC78` |

**Sureg (сертификаты на диске — 700, без root не читаются; SAN/сроки подтверждены по
публичному CT-логу Certificate Transparency, certspotter):**

| Сертификат (выпуск) | DNS names (SAN) | notBefore → notAfter |
|---|---|---|
| 2026-08-01 14:38:15Z | **`ai.sureg.dev`** | → **2026-10-30 14:38:14Z** |
| 2026-08-01 14:38:25Z | **`sureg.dev, www.sureg.dev`** | → **2026-10-30 14:38:24Z** |

- В CT для `sureg.dev` найдено ровно эти 2 выпуска (для `ai.sureg.dev` — тот один),
  `revoked=false` — это текущие сертификаты двух sureg-lineage.
- **Общих/объединённых сертификатов НЕТ ни в одну сторону:** в SAN animastor-сертификатов
  нет sureg-имён; в SAN sureg-сертификатов нет animastor-имён. → критерий BLOCKED
  «сертификат общий с другими доменами» **не сработал**.
- Срок истечения sureg: **2026-10-30** (≈10 дней), согласуется с Stage 89
  (последний успех 01.08, попытки продления с 09-30 = expiry−30d).

## 1.3 Ссылки на домены в конфигурациях и сервисах

Полный поиск `sureg.dev` (доменное совпадение, не «sureg» как имя пользователя/путь):

| Где проверено | Результат |
|---|---|
| git-tracked: `animastor`, `animastor-backend`, `animastor-web`, `animastor-gpu-hub`, `animastor-android`, `animastor-worker` | **Только** `proxy/conf/default.conf` в mono и backend: **закомментированные** строки 526–545 («sureg.dev server blocks were removed…», `# server_name ai.sureg.dev;`, `# ssl_certificate … /etc/letsencrypt/live/ai.sureg.dev/…`) |
| untracked/ignored части монорепо (`docker/`, `proxy/`, `frontends/`, `*.yml`, `*.sh`) | те же комментарии `default.conf`, больше ничего |
| `animastor-backend/deploy/` (prod compose/env/overlays) | **нет** |
| env-файлы (`*.env`, `.env*`) по всему `~/` | **нет** |
| `/etc/hosts`, `/etc/systemd/system`, `/etc/cron.d`, `/etc/nginx`, `/etc/ssl` | **нет** |
| Работающие контейнеры (`docker inspect` env/args/mounts: proxy, backend, gpu-hub, pg, redis) | **нет** |
| Скрипты в `~/bin`, `~/scripts`, `~/ *.sh` | **нет** |
| Отчёты `reorg-2026-10-12/19` | есть упоминания в отчётах (документация, не потребители) |

Разъяснение «ложных» совпадений по слову `sureg` в коде: это **имя пользователя и
файловые пути** (`/home/sureg/ComfyUI`, `/home/sureg/Android/Sdk`, username `'sureg'`
в тестах) — к TLS-доменам отношения не имеют. Состав `default.conf` в обеих копиях
идентичен (sha256 `99f706aff6087449…`), т.е. deployed-копия = копии в репозиториях.

**Действующих потребителей доменов на хосту не найдено** → критерий BLOCKED
«найден действующий потребитель» **не сработал** (за пределами хоста — см. Q-90-1).

## 1.4 DNS

| Имя | A | MX | TXT | CNAME |
|---|---|---|---|---|
| `sureg.dev` | `66.116.225.136` (этот хост) | — | — | — |
| `www.sureg.dev` | `66.116.225.136` | — | — | — |
| `ai.sureg.dev` | `66.116.225.136` | — | — | — |

DNS-записи существуют и указывают на этот хост; **менять DNS не требуется и не будет**
(ограничение этапа). Проверить внешние системы (webhooks/сторонние сервисы, могущие
вызывать `https://sureg.dev` извне) с этого хоста невозможно — вопрос владельцу Q-90-1.

## 1.5 Какие renewal-конфигурации можно отключить независимо

- **Независимо отключаемы:** `sureg.dev.conf` и `ai.sureg.dev.conf` — у каждого свой
  `archive_dir`/`live`, в `renewal/` других ссылок на них нет, hooks пусты,
  `cli.ini` доменных установок не задаёт, nginx/compose их не читает (только
  закомментированные строки), ни один контейнер/скрипт/cron/systemd юнит на них не ссылается.
- **Не затрагивается при отключении:** `animastor.org.conf`, `animastor.in.conf`
  (отдельные lineage и webroot), nginx (не использует sureg-путей в активной части),
  DNS, сертификаты/ключи (остаются на месте — ничего не удаляется).

## 1.6 Обслуживает ли certbot.service сертификаты Animastor; не скроет ли изменение их ошибки

Доказательства (из Stage 89, журнал/лог 2026-10-20 02:22–02:27):

- Один и тот же запуск `certbot -q renew` (ExecStart юнита, timer 2×/сутки, следующий
  запуск **2026-10-20 12:52:07 UTC**) обрабатывает **все 4 конфига**: в логе присутствуют
  `Processing /etc/letsencrypt/renewal/animastor.in.conf` и `…/animastor.org.conf`
  с результатом «Certificate not yet due for renewal» (02:27:46), а также оба sureg-конфига
  с ошибкой. Последние успешные выпуски animastor (08.10 и 12.10) сделаны этим же сервисом.
- **Текущая маскировка (важно):** из-за sureg сервис **всегда** завершается exit 1 —
  код выхода сейчас уже не позволяет отличить «падает sureg» от «падает animastor».
  После отключения 2 sureg-конфигов код становится информативным: 0 — при «not yet due»,
  **1 — при любом реальном сбое продления animastor**. То есть изменение
  **повышает** наблюдаемость ошибок animastor, а не скрывает их; контрольная проверка
  (сохранность обработки animastor-конфигов) заложена в план (чек 2).

**Вывод по аудиту:** общих сертификатов нет, действующих потребителей sureg-имён на хосту
нет, линейки развязаны → отключение возможно без влияния на `animastor.org`/`animastor.in`.

---

# Этап 2. План изменения (выполнять НЕ на этом этапе)

Рекомендуемый способ — **обратимое отключение renewal-конфигов переименованием**
(certbot загружает только файлы `renewal/*.conf`; сертификаты/ключи/archive/live,
DNS, nginx, compose и контейнеры не трогаются вообще).

## 2.1 Точные файлы и записи

Изменяются **ровно 2 файла** (переименование, содержимое не правится):

| # | Было | Стало |
|---|---|---|
| 1 | `/etc/letsencrypt/renewal/sureg.dev.conf` | `/etc/letsencrypt/renewal/sureg.dev.conf.disabled` |
| 2 | `/etc/letsencrypt/renewal/ai.sureg.dev.conf` | `/etc/letsencrypt/renewal/ai.sureg.dev.conf.disabled` |

Не изменяются: `animastor.org.conf`, `animastor.in.conf`, `/etc/letsencrypt/cli.ini`,
`/etc/cron.d/certbot`, `certbot.timer`/`certbot.service`, `renewal-hooks/*`,
`/etc/letsencrypt/{live,archive,accounts}`, DNS, `proxy/conf/default.conf`,
docker-compose и `.env`, любые контейнеры.

## 2.2 Резервная копия затрагиваемых конфигураций

```
mkdir -p /home/animastor/backups/letsencrypt-renewal-sureg-disable-2026-10-20
cp -p /etc/letsencrypt/renewal/sureg.dev.conf \
      /etc/letsencrypt/renewal/ai.sureg.dev.conf \
      /home/animastor/backups/letsencrypt-renewal-sureg-disable-2026-10-20/
( cd /home/animastor/backups/letsencrypt-renewal-sureg-disable-2026-10-20 && \
  sha256sum *.conf > SHA256SUMS )
ls -la /etc/letsencrypt/renewal/ > /home/animastor/backups/letsencrypt-renewal-sureg-disable-2026-10-20/renewal-dir-before.txt
```

Копия кладётся рядом с уже существующим
`~/backups/letsencrypt-renewal-pre-34-2026-10-12/` (шабрин проверки целостности тот же).
Конфиги не содержат приватных ключей (только пути/настройки lineage) — их копирование
в `~/backups` секретов не раскрывает.

**Снятие baseline ПЕРЕД изменением** (для последующих сверок):
- `ls /etc/letsencrypt/csr | wc -l` → сейчас **457**; новейшая пара `0455/0456` от 2026-10-20 02:27;
- TLS-serials: `animastor.org` `0629D2…CE7A` (до 2027-01-06), `animastor.in` `06F86F…DC78` (до 2027-01-10);
- `systemctl show certbot.service -p Result,ExecMainStatus,ExecMainExitTimestamp`
  (сейчас: exit-code/1/2026-10-20 02:27:50); `systemctl show certbot.timer -p NextElapseUSecRealtime`.

**Доступ:** переименование в `/etc/letsencrypt/renewal/` требует root (sudo).
На этом этапе не выполняется; исполнение — отдельным подтверждением владельца
(самый простой путь — owner запускает две команды `mv` сам).

## 2.3 Чек 1 — Certbot больше не пытается продлевать sureg

1. Сразу после `mv`:
   - `ls /etc/letsencrypt/renewal/*.conf` → должен вернуть **только** `animastor.org.conf` и `animastor.in.conf`;
   - `ls /etc/letsencrypt/renewal/` → два файла вида `*.conf.disabled` присутствуют (отключение, не удаление).
2. После **первого** срабатывания timer (≤12 ч, ближайший 2026-10-20 12:52 UTC):
   - `systemctl status certbot.service` → **Result: success / exit 0** (сейчас — failed/1);
   - журнал: `journalctl -u certbot.service --since -12h` — **нет строк**
     `Processing /etc/letsencrypt/renewal/sureg…` и `Failed to renew certificate sureg…`;
   - `grep -E 'sureg' /var/log/letsencrypt/letsencrypt.log` за период после отключения — пусто
     (кроме возможных строк без «Processing»);
   - **CSR-индикатор:** `ls -lt /etc/letsencrypt/csr | head` — после момента отключения
     **не появляется новых** `*_csr-certbot.pem` (до отключения — по 2 файла на запуск,
     81 файл с 09-30; это самый надёжный read-only сигнал попытки выдачи).
3. Дополнительный негативный контроль: спустя 2 запуска timer убедиться, что
   CSR-счётчик не изменился, а `animastor`-строки в логе присутствуют.

## 2.4 Чек 2 — продление animastor.org / animastor.in сохранилось (отдельно)

1. В том же журнале после каждого запуска timer обязаны присутствовать:
   `Processing /etc/letsencrypt/renewal/animastor.org.conf` и
   `Processing /etc/letsencrypt/renewal/animastor.in.conf`,
   каждая со статусом «Certificate not yet due for renewal» (до декабря) —
   т.е. обе линейки **обрабатываются**, а не пропущены.
2. Состав `renewal/*.conf` после отключения = ровно 2 анимастор-конфига (п.1 чека 1).
3. TLS-контроль (read-only): serial/notAfter `animastor.org` и `animastor.in` через
   handshake **не изменились** (сверка с baseline `0629D2…CE7A` / `06F86F…DC78`).
4. `systemctl status certbot.service` после запусков = success; при появлении **exit 1**
   после отключения это уже будет означать реальную ошибку (например, animastor) —
   сигнал не замаскирован (см. §1.6).
5. Опционально (отдельное утверждение, НЕ в рамках этапа): `certbot renew --dry-run` —
   проверяет реальную HTTP-01-процедуру для оставшихся lineage на staging. Запускать
   только по явному разрешению (network к LE staging; в Stage 90 запрещён).

## 2.5 Rollback

```
mv /etc/letsencrypt/renewal/sureg.dev.conf.disabled     /etc/letsencrypt/renewal/sureg.dev.conf
mv /etc/letsencrypt/renewal/ai.sureg.dev.conf.disabled  /etc/letsencrypt/renewal/ai.sureg.dev.conf
# (или восстановить из ~/backups/letsencrypt-renewal-sureg-disable-2026-10-20/ + sha256sum -c)
```

- Никакие данные не удалялись → rollback полный: `ls renewal/*.conf` снова покажет 4 файла,
  следующий запуск timer снова обработает обе sureg-линейки (и снова будет exit 1 до
  исправления webroot/nginx — см. Q3 Stage 89).
- Побочных эффектов на nginx/DNS/animastor от самого отключения и от rollback не будет
  (sureg-пути в nginx закомментированы и не читаются).

## 2.6 Эффект и ожидаемое поведение после включения плана

- `certbot.service` перестаёт падать ежедневно (2×/сутки); журнал/статус юнита становятся
  значимым индикатором состояния.
- TLS для `animastor.org`/`animastor.in` не меняется (сертификаты и продление не трогаются).
- `sureg.dev`/`ai.sureg.dev` продолжат ровно то, что есть сейчас (на :443 отдаётся
  сертификат animastor.org, дефолтным сервером), а 2026-10-30 их сертификаты истекут
  **без продления** — это и есть цель; активной конфигурации, использующей их, нет.
- Поведение внешних систем (если Q-90-1 выявит потребителя) может быть восстановлено
  rollback-ом без перевыпуска.

---

# Открытые вопросы и блокеры

| ID | Тип | Суть |
|---|---|---|
| **Q-90-1** | решение владельца | **Закрыт 2026-10-20** — владелец подтвердил: «sureg-домен не был запущен, пользователей нет». Внешних потребителей `https://sureg.dev` / `https://ai.sureg.dev` нет → отключение безопасно. |
| **B-90-2** | решение владельца | **Закрыт 2026-10-20 12:35 UTC** — владелец отдельно санкционировал выполнение (см. Этап 3). |
| **B-90-3** | доступ | **Закрыт** — выполнено цепочкой `su sureg` → `sudo -S` (аккаунт `sureg` состоит в группе `sudo`; `animastor` — нет). |
| B-89-1 (из Stage 89) | срочный | **Разрешён** — отключение sureg-линеек выполнено (Этап 3); истечение sureg-сертификатов 2026-10-30 14:38 UTC перестало быть проблемой, renewal больше их не обрабатывает. |
| B-89-7 (из Stage 88) | отложен | GPU Hub — источник истины не выбран; этим этапом не затрагивается. |

# Этап 3. Выполнение (по отдельному подтверждению владельца, 2026-10-20 12:35 UTC)

**Доступ.** Владелец передал пароль от аккаунта `sureg`; `sudo` выполняется этим
пользователем (группа `sudo:x:27:ubuntu,sureg`; у `animastor` прав sudo нет — первая
попытка `sudo` от `animastor` отклонена как неверный пароль, изменений после неё не было).
Выполнено цепочкой `su sureg` → `sudo -S`. **Пароль никуда не сохранён** (скрипты создавались
без пароля, проверено grep-ом по `/tmp/opencode` и `reorg-2026-10-19` — совпадений нет),
в данный отчёт не выносится.

**Бэкап (до любого изменения):**
`~/backups/letsencrypt-renewal-sureg-disable-2026-10-20/`:
- `sureg.dev.conf` (684 B), `ai.sureg.dev.conf` (679 B) — `cp -p`, mtime сохранены (01.08);
- `SHA256SUMS` — обе проверки `sha256sum -c` → **OK**;
- `renewal-dir-before.txt` — снимок `ls -la` renewal-каталога до изменений;
- владелец файлов: `animastor`.

**Изменение (ровно два `mv`, содержимое файлов не правилось):**

```
/etc/letsencrypt/renewal/sureg.dev.conf    → sureg.dev.conf.disabled
/etc/letsencrypt/renewal/ai.sureg.dev.conf → ai.sureg.dev.conf.disabled
```

После: в `renewal/` активны только `animastor.org.conf` и `animastor.in.conf`
(плюс два `*.conf.disabled`). Ни один файл не удалён.

**Контрольный запуск:** `systemctl start certbot.service` (тот же
`ExecStart=/usr/bin/certbot -q renew`, что и у timer), 12:35:47 → **status=0/SUCCESS**
(PID 3406644, CPU 585 ms); журнал: «Starting Certbot» → «Deactivated successfully» →
«Finished Certbot», строк ошибок нет.

**Результаты проверок:**

| Проверка | Ожидание | Факт |
|---|---|---|
| Animastor обрабатывается | `Processing …/animastor.in.conf` и `…/animastor.org.conf` + «not yet due» | ✓ 12:35:48–49, обе линейки |
| Sureg не обрабатывается | нет `Processing …/sureg…` после 12:35 | ✓ 0 строк |
| Ошибки sureg не растут | счётчик `Failed to renew certificate sureg` не меняется | ✓ осталось 5 (последняя 02:27) |
| CSR-индикатор | 457, новейшие `0455/0456` от 02:27 | ✓ без изменений |
| Код выхода сервиса | 0 (до изменения — всегда 1) | ✓ SUCCESS |
| TLS Animastor не тронут | serial/notAfter без изменений | ✓ `animastor.org` `0629D2…CE7A`/2027-01-06; `animastor.in` `06F86F…DC78`/2027-01-10; сайт 200 |
| Контейнеры не перезапускались | — | ✓ Up 30 h |
| Timer активен | — | ✓ следующий **автоматический** запуск 2026-10-20 17:34:45 UTC |

**Замечание:** ручной запуск сервиса сдвинул расписание timer (след. 17:34 вместо 12:52).
Рекомендуется повторить те же read-only проверки после **автоматического** запуска в
17:34 UTC — это подтвердит и штатный путь, а не только ручной.

**Rollback (не выполнялся):**

```
mv /etc/letsencrypt/renewal/sureg.dev.conf.disabled    /etc/letsencrypt/renewal/sureg.dev.conf
mv /etc/letsencrypt/renewal/ai.sureg.dev.conf.disabled /etc/letsencrypt/renewal/ai.sureg.dev.conf
# или: cp -p /home/animastor/backups/letsencrypt-renewal-sureg-disable-2026-10-20/*.conf /etc/letsencrypt/renewal/
#       (cd там же && sha256sum -c SHA256SUMS)
```

# Контроль объёма изменений (этапы 1–3)

- **Этапы 1–2 (аудит и план):** изменений не было — только чтение
  (`/etc/letsencrypt` перечислялся/читался, DNS через `dig`/`getent`, nginx/compose/grep,
  `docker inspect`).
- **Этап 3 (после отдельного подтверждения владельца):** только 2 `mv` renewal-конфигов,
  создание бэкап-каталога в `~/backups` и один контролируемый запуск `certbot.service`.
- **Не менялось вообще:** сертификаты, приватные ключи, `archive/`, `live/`, `accounts/`,
  DNS-записи, `nginx`/docker-compose/`.env`, контейнеры; ничего не удалялось; отчёты
  Stage 87/88/89 не изменялись; пароль владельца не сохранён ни в каком файле.
