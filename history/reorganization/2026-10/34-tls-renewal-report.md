# Animastor — Этап 34: TLS RENEWAL ДЛЯ ANIMASTOR.IN (выполнен)

- Дата: 2026-10-12, окно ~10:14–10:25 UTC (15:44–15:55 IST)
- Разрешение владельца (задание этапа 34): официальный Docker-образ Certbot,
  dry-run → при успехе реальное продление `animastor.in` → `nginx -t` +
  `nginx -s reload` → проверки. Без изменения хостовой конфигурации, без
  рестартов/пересоздания контейнеров, без удаления сертификатов, без правок
  DNS/Compose/webroot/renewal-конфигов (кроме штатного обновления конфига
  линейки `.in` самим certbot), без касания lock/git/ZIP/данных.
- Источники (прочитаны): `33-post-m3-verification-report.md`,
  `28-cutover-readiness-audit.md` (§1 — способ, §1.6 — команды),
  `docs/architecture/DOMAIN_MIGRATION_2026-10_IN_TO_ORG.md`
  («Deployment status (2026-10-08)» — исторический Docker-способ подтверждён).
- Итог: **PASS.** Dry-run **успешен** (exit 0, «all simulated renewals
  succeeded»), затем реальное продление выполнено. **Новый срок
  `animastor.in`: 2027-01-10 09:24:17 GMT** (было 2026-11-19). SAN не менялись
  (4/4), `.org` не тронут. Reload прошёл, все проверки зелёные.

---

## 0. Краткий итог

| Этап | Результат |
|---|---|
| Preflight | PASS — расхождений в путях/правах/сертификатах не найдено; образ не скачан → скачан |
| Dry-run | **PASS** — exit 0, `/etc/letsencrypt` не изменился (sha конфигов идентичны, SNI прежний) |
| Реальное продление | **PASS** — линейка `animastor.in` обновлена; новый cert `notAfter=Jan 10 09:24:17 2027 GMT`, issuer Let's Encrypt `YR2`, SAN 4/4 без изменений |
| Reload | `nginx -t` ok (до/после), `nginx -s reload` exit 0 — **без перезапуска контейнера** |
| Проверки | SNI `.in` = новый сертификат, verify 0; SNI `.org` = прежний (Jan 6 2027); 301 ×3; HTTP→HTTPS 301; главная 200 (`a1900f4e…` — M3 цел); health 200/200; реальный DNS без `--resolve`: verify=0; контейнеры/mounts/данные/lock — без изменений |
| Дедлайн | **G6/D5 закрыт**: угроза истечения 19.11.2026 снята (запас ~89 дней) |

---

## 1. Preflight (read-only) — PASS

### 1.1 Сертификаты до продления (фактически отдаваемые nginx по SNI)

| SNI | subject | issuer | notBefore | notAfter | SAN |
|---|---|---|---|---|---|
| `animastor.in` | CN=animastor.in | Let's Encrypt **YR1** | Aug 21 11:42:11 2026 | **Nov 19 11:42:10 2026 GMT** (38,1 дн.) | admin, animastor, app, www `.animastor.in` (4/4) |
| `animastor.org` | CN=animastor.org | Let's Encrypt YE2 | Oct 8 18:29:49 2026 | Jan 6 18:29:48 2027 GMT | 4/4 `.animastor.org` |

### 1.2 Renewal-конфиги и mount-пути

| Параметр | `animastor.in.conf` | `animastor.org.conf` |
|---|---|---|
| authenticator | webroot | webroot |
| server | ACME v02 | ACME v02 |
| webroot_path | `/home/animastor/animastor/frontends/website` | тот же |
| webroot_map | только `admin.animastor.in` (остальные 3 имени — через webroot_path) | все 4 имени явно |
| версия | 1.21.0 (host-certbot 2026-10-08) | 5.8.0 (Docker 2026-10-08) |

Важно: в `/etc/letsencrypt/renewal/` присутствуют **legacy-линейки**
`sureg.dev.conf` и `ai.sureg.dev.conf` с несуществующими webroot
`/home/sureg/...` — при обычном `renew` они дали бы ошибку. Поэтому все
запуски выполнялись строго с `--cert-name animastor.in` (линейка `.in` и
ничего больше); legacy-конфиги не тронуты (sha до/после идентичны).

### 1.3 Webroot и ACME-раздача через текущий nginx

- Каталог `frontends/website/.well-known/acme-challenge/` существует (775,
  запись при renew делает root внутри контейнера).
- Пробы `http://<name>/.well-known/acme-challenge/` для **всех 8 имён**
  (.in ×4 и .org ×4) → **403** = location `^~ /.well-known/acme-challenge/`
  совпадает, каталог отдаётся (не 301/404) → HTTP-01 путь работает.

### 1.4 Docker-образ

- `docker images certbot/certbot` — **пусто** (образ не скачан, как и было
  зафиксировано в 28 §1.4) → выполнен `docker pull certbot/certbot`:
  `certbot/certbot:latest`, ID `f70ad0adbb7e`, digest
  `sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20`,
  293 МБ (диск до: 35,0 ГБ — достаточно). Версия в образе: **certbot 5.8.0**
  (та же линия, что выпускала `.org` 2026-10-08).

### 1.5 Контрольные копии и baseline (до любых действий)

- Renewal-конфиги скопированы (аддитивно, без приватных ключей):
  `/home/animastor/backups/letsencrypt-renewal-pre-34-2026-10-12/`
  (`animastor.in.conf` sha `de631da4…`, `animastor.org.conf` sha `54a590d1…`).
- Baseline: 7 контейнеров (CreatedAt: proxy 2026-08-22 09:11:56 и т.д.),
  health 200/200, mounts proxy (6 ro-bind), 301 ×3, site sha `a1900f4e…`,
  lock `069b62d9…`/`2a221e3b…`, `certbot.timer` active+enabled,
  диск `35 025 756 160` Б.

Расхождений в путях/правах/сертификатах **не обнаружено** → блокеров нет,
переход к dry-run.

---

## 2. Dry-run — PASS

Команда (процедура 28 §1.6, webroot смонтирован **под тем же абсолютным
путём**, что в renewal-конфиге):

```sh
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /home/animastor/animastor/frontends/website:/home/animastor/animastor/frontends/website \
  certbot/certbot renew --cert-name animastor.in --force-renewal --dry-run --non-interactive
```

Результат: **exit 0**, вывод:
`Congratulations, all simulated renewals succeeded: /etc/letsencrypt/live/animastor.in/fullchain.pem (success)`
— «Simulating renewal of an existing certificate for animastor.in and 3 more».

Почему `--force-renewal`: сертификат на момент запуска истекал через 38 дней,
т.е. ещё **вне** стандартного 30-дневного окна автообновления — без force
`renew` закономерно пропустил бы линейку («not due for renewal»). `--dry-run`
с force не пишет сертификаты и не меняет `/etc/letsencrypt`.

Контроль после dry-run (ничего не изменилось):
- sha256 `animastor.in.conf` = `de631da4…`, `animastor.org.conf` = `54a590d1…` — **идентичны до**;
- mtime конфигов не изменился (Oct 8);
- SNI `.in` по-прежнему `notAfter=Nov 19 11:42:10 2026 GMT`.

Обходных режимов не использовалось: TLS-проверки не отключались, ACME v02,
webroot-аутентификация, `--dry-run` штатный.

---

## 3. Реальное продление — PASS

```sh
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /home/animastor/animastor/frontends/website:/home/animastor/animastor/frontends/website \
  certbot/certbot renew --cert-name animastor.in --force-renewal --non-interactive
```

Результат: **exit 0**, `Congratulations, all renewals succeeded: …/live/animastor.in/fullchain.pem (success)`
— «Renewing an existing certificate for animastor.in and 3 more».
Новый сертификат **не запрашивался с нуля** — выполнено штатное продление
существующей линейки; состав доменов **не менялся**.

### 3.1 Новый сертификат (прочитан на диске ДО reload, из контейнера `:ro`)

| Поле | Значение |
|---|---|
| subject | CN=animastor.in |
| issuer | Let's Encrypt **YR2** (новый intermediate; старый был YR1) |
| notBefore | Oct 12 09:24:18 2026 GMT (LE штатно бэкдатит ~1 ч) |
| **notAfter** | **Jan 10 09:24:17 2027 GMT** (+90 дней; бывший срок Nov 19 2026) |
| SAN | admin/animastor/app/www `.animastor.in` — **4/4, без изменений** |
| `.org`-сертификат | `notAfter=Jan 6 18:29:48 2027 GMT` — **не изменён** |

### 3.2 Что изменилось в renewal-конфигах (штатное поведение certbot)

| Файл | До | После |
|---|---|---|
| `animastor.in.conf` | sha `de631da4…`, 642 Б, version 1.21.0, webroot_map: 1 имя | sha `1df6ee93…`, 841 Б, **version 5.8.0**, `key_type=rsa`, webroot_map: все 4 имени (все → тот же webroot), account/ACME/webroot_path **без изменений** |
| `animastor.org.conf` | sha `54a590d1…` | **sha `54a590d1…` — не тронут** |
| `sureg.dev.conf` / `ai.sureg.dev.conf` | — | **не тронуты** (sha/size/mtime прежние) |

Содержательно параметры `.in`-линейки не менялись: тот же ACME-сервер, тот же
аккаунт, тот же webroot, тот же набор доменов, key_type rsa (как и было
фактически). Приватные ключи не копировались и не выводились.

---

## 4. Reload и проверки после — все PASS

### 4.1 Reload (без перезапуска контейнера)

1. `docker exec animastor-proxy nginx -t` до reload → `syntax is ok` /
   `test is successful`.
2. `docker exec animastor-proxy nginx -s reload` → exit 0, worker-процессы
   перечитали сертификаты (master не перезапускался).
3. `nginx -t` после → снова ok.

(Предупреждения о deprecated `listen … http2` — существовали и до этапа;
конфигурация не менялась.)

### 4.2 Сертификаты, реально отдаваемые по HTTPS (после reload)

| SNI | subject | issuer | notAfter | SAN | Verify |
|---|---|---|---|---|---|
| `animastor.in` | CN=animastor.in | **YR2** | **Jan 10 09:24:17 2027 GMT** | 4/4 `.in` | **0 (ok)** |
| `animastor.org` | CN=animastor.org | YE2 | Jan 6 18:29:48 2027 GMT | 4/4 `.org` | 0 (ok) |

Проверка **без `--resolve`** (реальный DNS, реальная цепочка):
`curl https://animastor.org/` → 200, `ssl_verify_result=0`;
`curl https://animastor.in/` → 301, `ssl_verify_result=0`.

### 4.3 Поведение сайта

| Проверка | Результат |
|---|---|
| `http://animastor.in/`, `https://animastor.in/`, `http://www.animastor.in/` | **301** ×3 → canonical ✓ |
| `http://animastor.org/` | **301** → `https://animastor.org/` ✓ |
| главная HTTPS | **200**, тело sha256 `a1900f4e…` (M3-версия цела) ✓ |
| `/health`, `/gpu/health` | **200 / 200** ✓ |
| ACME-раздача | location работает (пробы 403×8 до продления; после — сломано быть не могло: conf не менялся) ✓ |

### 4.4 Отсутствие побочных изменений

| Проверка | Результат |
|---|---|
| Контейнеры | 7/7, CreatedAt **без изменений** (proxy: Created 2026-08-22 09:11:56, Up 5 weeks — reload, не restart) ✓ |
| Compose mounts | идентичны baseline (6 ro-bind, вкл. `/etc/letsencrypt`) ✓ |
| Данные | `data/output` 63 203 425 Б, `data/books` 1 704 047 Б — без изменений ✓ |
| lock-файлы | `069b62d9…` / `2a221e3b…` — без изменений ✓ |
| Git | mono: только baseline-состояние после M3 (` M index.html`, `?? overlay…`) — **ничего не коммитилось** ✓ |
| DNS/Compose/webroot/.deploy | не изменялись ✓ |
| `certbot.timer` | active (следующие авто-окна будут пропускать `.in` до ~Dec 11, затем продлят сами) ✓ |

---

## 5. Откат и устойчивость

Откат **не потребовался** и не понадобится: сертификат валиден, сайт работает.
Замечания по устойчивости:

- Старый сертификат `.in` **остался** в `/etc/letsencrypt/archive/animastor.in/`
  (certbot сохраняет историю линейки; ничего не удалялось) — техническая
  возможность вернуть симлинк `live/` на прежний файл существует, но требует
  root и **не выполнялась** (не требуется).
- Renewal-конфиги `.in` (до-версия) и `.org` сохранены в
  `backups/letsencrypt-renewal-pre-34-2026-10-12/` (sha зафиксированы §1.5).
- Если бы reload не прошёл: nginx-мастер продолжал бы работать со старыми
  worker-процессами и старым сертификатом в памяти (graceful reload) —
  деградации HTTPS в любой сценарий не закладывалась. Ничего не удалялось.

---

## 6. Итог по гейтам

| Гейт | До этапа 34 | После |
|---|---|---|
| **G6** (root/docker: TLS renew/reload) | BLOCKED | **PASS — закрыт** (docker-способ выполнен; host-sudo не потребовался) |
| **D5** (продление `.in` до 19.11.2026) | BLOCKED, дедлайн 19.11.2026 | **RESOLVED** — новый срок **Jan 10 2027** |
| Прочие гейты | без изменений | G2/G3/G5/G7 — NOT TESTED; G4 — BLOCKED; D4 — BLOCKED; D1/G1/G8 — PASS (см. 33 §4) |

**Оставшийся TLS-риск (для будущих этапов):** renewal-конфиги указывают на
mono-webroot `/home/animastor/animastor/frontends/website`. При будущем
переключении website-монта на web-репо (фаза H/E6) ACME-вызовы уйдут не туда →
продление сломается. Mitigation (из 28 §1.5, без изменений): до смены монта
выполнить **M2** (скопировать `.well-known/` в web-каталог) **и** обновить
`webroot_path` в обоих renewal-конфигах (root-действие, отдельное разрешение) —
либо продлить `.in` снова до смены монта. Ближайшее авто-окно таймера для
`.in`: ~**2026-12-11** (за 30 дней до Jan 10); до этого момента монт можно
менять только вместе с M2+правкой webroot.

## 7. Что НЕ выполнялось (запреты соблюдены)

DNS не менялся; Compose, webroot, deploy-layout, nginx-conf — не правились;
контейнеры не перезапускались и не пересоздавались (`reload` — сигнал master-у,
без пересоздания); сертификаты/ключи/бэкапы/данные не удалялись; приватные ключи
не копировались и не выводились; `artifacts.lock.json`, Git-репозитории, ZIP —
не трогались; никаких действий по переносу production (M2/M4/E6/H) не выполнялось.

## 8. Резюме для чата

**PASS.** Dry-run — **успешен** (exit 0, «all simulated renewals succeeded»,
`/etc/letsencrypt` не изменился). Реальное продление выполнено: **сертификат
`animastor.in` продлён**, новый срок **2027-01-10 09:24:17 GMT** (было
19.11.2026), issuer YR2, SAN 4/4 без изменений, `.org` не тронут
(Jan 6 2027). Reload: `nginx -t` ok → `nginx -s reload` exit 0 (без рестарта
контейнера). Проверки: SNI `.in`/`.org` отдают верные сертификаты
(verify 0, в т.ч. по реальному DNS), 301 ×3, HTTP→HTTPS, главная 200
(`a1900f4e…`), health 200/200; контейнеры/mounts/данные/lock/git — без
изменений. Дедлайн 19.11.2026 снят (G6/D5 закрыты); следующий TLS-контроль —
до смены website-монта (M2 + правка webroot) либо автоокно ~11.12.2026.
Отчёт: `/home/animastor/reorg-2026-10-12/34-tls-renewal-report.md`.
