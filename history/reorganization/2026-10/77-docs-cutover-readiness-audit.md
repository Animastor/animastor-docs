# Stage 77 — Аудит готовности production-cutover портала документации (read-only)

**Дата:** 2026-10-19
**Режим:** READ-ONLY. Production не изменялся: конфиги, контейнеры, сервисы, DNS, reverse proxy, файлы активных репозиториев, Git refs/ветки/remotes не трогались. Коммитов, push, deployment, перезапусков не было.
**Цель:** `Animastor/animastor-docs`, ветка `main`, подтверждённый HEAD `bb8106cf0d06829dc2a2c6039df9593f3430f6f6`.
**Статус:** **PASS** — план cutover, риски и откат определены полностью.
**Обязательные гейты перед выполнением:** согласование владельцем правки production-конфига (deploy compose) и создание `.git`-free export-каталога. Это предусловия выполнения, а не технические блокеры.

Обозначения: **[Ф]** — проверенный факт, **[В]** — вывод, **[П]** — предположение (проверяется после cutover).

---

## 1. Фактическая архитектура production-портала

### 1.1 Кто обслуживает портал

| Параметр | Значение |
|---|---|
| Сервис | `nginx:alpine`, контейнер **`animastor-proxy`** (uptime 6 дней) |
| Compose-проект | `animastor` |
| Compose-файлы (работающие) | `/home/animastor/animastor-backend/deploy/docker-compose.yml` + `overlay-backend-standalone.yml` **[Ф]** |
| Env-файл | `/home/animastor/animastor-backend/deploy/.env` (проверялись только имена ключей, значения не печатались) |
| Working dir | `/home/animastor/animastor-backend/deploy` |
| Порты / сеть | `80:80`, `443:443`; `animastor_net`; restart `unless-stopped`; **healthcheck отсутствует** |
| Config hash (running = on-disk) | nginx `d1a9feb297cb2b8387ac0088af8025befc0bce7c6d595e347d5a10e48153549b` **[Ф]** |
| nginx config | `/etc/nginx/conf.d/default.conf` = host `/home/animastor/animastor/proxy/conf/default.conf`, sha256 `99f706aff608…` (host = container) **[Ф]** |
| nginx syntax | `nginx -t` OK (только warnings о deprecated `listen ... http2`) **[Ф]** |

Все пять config-hash compose-сервисов совпадают с label'ами работающих контейнеров (`backend 0f608cbd…`, `gpu-hub 9d8da5c6…`, `nginx d1a9feb2…`, `postgres 633aebb4…`, `redis d77cc2be…`) — файл на диске является ровно работающей production-конфигурацией **[Ф]**.

### 1.2 Источник документов

| Монтирование (ro) | Куда |
|---|---|
| **`/home/animastor/animastor/docs`** | `/usr/share/nginx/docs` |
| `/home/animastor/animastor/proxy/conf/default.conf` | `/etc/nginx/conf.d/default.conf` |
| `/home/animastor/animastor/proxy/conf/.htpasswd` | `/etc/nginx/.htpasswd` |
| `/home/animastor/animastor/frontends/website` | `/usr/share/nginx/frontends/website` |
| `/home/animastor/animastor/frontends/app` | `/usr/share/nginx/frontends/app` |
| `/etc/letsencrypt` | `/etc/letsencrypt` |

- Портал отдаётся напрямую из **рабочего каталога монорепозитория** `/home/animastor/animastor/docs` (абсолютный bind-mount) **[Ф]**.
- Никакой другой контейнер docs не монтирует (backend, gpu-hub — нет) **[Ф]**.
- Docker volume, стадия сборки или publish-пайплайн отсутствуют: nginx отдаёт каталог как есть **[Ф]**.
- Хеши host ↔ container для `README.md`, `index.html`, `docs-browser.js` совпадают **[Ф]** → отдаётся ровно рабочее дерево mono.
- Worktree `docs` в mono чист (HEAD `465453df`, tree `da1f129e…`, 297 файлов) **[Ф]**.
- Портал публичный, на `/docs/` auth не требуется **[Ф]**.

### 1.3 Маршрутизация (факты)

`default.conf`: `/docs/` → SPA `docs/index.html`; отдельные location для `/docs/index.html`, `/docs/docs-browser.js`, `/docs/docs-browser.css`; всё остальное `/docs/<path>` → `try_files $uri/README.md $uri =404`, `autoindex off`; `root /usr/share/nginx` **[Ф]**.

- В nginx **нет** `deny`/правил для dotfiles **[Ф]** → всё, что лежит в корне монтирования, доступно по HTTP, включая `.git/` (см. риск R1).

### 1.4 Текущий baseline (2026-10-19)

| URL | Статус / тип |
|---|---|
| `/docs/` | 200 `text/html`, 2264 B |
| `/docs/index.html` | 200 `text/html`, 2264 B |
| `/docs/README.md` | 200 `text/plain`, 12830 B, sha256 `c6be7a8e…` |
| `/docs/docs-browser.js` | 200 `application/javascript`, 17827 B |
| `/docs/docs-browser.css` | 200 `text/css`, 5498 B |
| `/docs/01-overview/ARCHITECTURE.md` | 200 `text/plain`, 54532 B |
| `/docs/architecture/` | **404** (в каталоге нет `README.md` — так было и раньше) |
| `/docs/LICENSE` | **404** (маркер: в старом источнике файла нет) |
| `/styles.css`, `/site.js`, `/logo.png`, `/favicon-16.png`, `/favicon-32.png` | 200 (отдаются из монта website, cutover их не меняет) |
| `https://animastor.org/` | 200 |
| `https://animastor.org/library` | 200 |
| `https://app.animastor.org/` | 200 |
| `https://admin.animastor.org/` | 302 |
| DNS | `animastor.org` → `66.116.225.136` (этот VPS); AAAA нет, CDN нет (`server: nginx`, кеширующих заголовков нет) **[Ф]** |
| TLS | `CN=animastor.org`, срок 2026-10-08 → **2027-01-06** |

**Файлы-маркеры «старый vs новый» источник** (доказательство cutover):

| Файл | Старый (mono, отдаётся сейчас) | Новый (`animastor-docs`) |
|---|---|---|
| `08-mobile-web-migration/README.md` | sha256 `d290eecfaf1d57bbf2b73259dfcf14c4fda503ba5d234a2b28c926b4753bea73` (`../../README.md`) | sha256 `1442368ca0c3d23cd9916c432a55a899217bd38527bc18d84cd8982a33791e01` (`../README.md`) |
| `LICENSE` | нет (404) | есть (MIT) |

### 1.5 Процесс публикации docs

- **Нет** CI/CD, workflow, скрипта или cron, которые собирают или публикуют docs **[Ф]**. Единственный workflow в активных репозиториях — `backend-ghcr-release.yml` (workflow_dispatch, только backend-образ).
- Обновление docs видно сразу через bind-mount (перезапуск nginx для этого не нужен) **[Ф]**.
- Production-compose для docs **не версионирован**: `deploy/` содержит 0 tracked-файлов; `.env` untracked и содержит секреты **[Ф]**. Любая правка не попадает в Git, пока не сделана резервная копия.

---

## 2. Проверка целевого репозитория

| Проверка | Результат |
|---|---|
| Полный SHA (`refs/heads/main`) | `bb8106cf0d06829dc2a2c6039df9593f3430f6f6` **[Ф]** |
| Видимость / default branch | public / `main` |
| HTTPS-доступ с VPS | `git ls-remote https://github.com/Animastor/animastor-docs.git` → OK, `rc=0` **[Ф]** |
| SSH-доступ с VPS | `git ls-remote git@…` → OK, `rc=0` **[Ф]** |
| Локальный клон для проверок | `/home/animastor/animastor-docs` @ `bb8106c`, clean, `origin` = SSH **[Ф]** |
| Структура корня | каталоги docs + `index.html`, `docs-browser.js/css`, `README.md`, `CHANGELOG.md`, …, плюс `LICENSE` |
| Требования к сборке | нет — нет `package.json`/`Makefile`/`Dockerfile`; nginx отдаёт дерево как есть **[Ф]** |
| Дерево vs старый источник | отличается только `08-mobile-web-migration/README.md` + добавлен `LICENSE`, остальное байт-в-байт **[Ф]** |
| Фиксация версии | по полному SHA (`git archive <sha>`), воспроизводимо **[В]** |

Важно: обычный клон в корне монтирования откроет `.git/` (в клоне он есть, в mono `docs/` его нет) — см. R1. Для cutover нужно монтировать **export без `.git`**, а не сам клон.

---

## 3. Зависимости и риски

| ID | Риск | Обоснование | Уровень | Митигация |
|---|---|---|---|---|
| **R1** | Монтирование клона репозитория откроет `/docs/.git/...` (config, refs, вся история): в nginx нет deny для dotfiles | в корне клона есть `.git`; в `location /docs/` нет deny | Высокий | монтировать `.git`-free export (`git archive`); вторичный вариант — `location ~ ^/docs/\.(git|env)` + `nginx -s reload` |
| **R2** | Production-compose не в Git; `.env` untracked и секретный | `git ls-files deploy` = 0 | Средний | до правки скопировать compose+overlay в rollback-каталог; `.env` в отчёты не копировать |
| **R3** | Смена mount не применяется через `nginx -s reload` — только recreate контейнера | работающий контейнер «пинит» старый source | Средний | `docker compose … up -d --no-deps nginx`; остальные сервисы не трогаются |
| **R4** | Recreate nginx кратко прерывает **все** сайты за ним (animastor.org, app, admin, library) | один nginx на портах 80/443 | Средний | окно низкого трафика; образ `nginx:alpine` уже локально (`54f2a904c251`), pull не нужен; откат — одна команда |
| **R5** | Recreate теряет логи контейнера | лог-драйвер не настроен, nginx пишет в stdout | Низкий | до recreate снять `docker logs animastor-proxy` |
| **R6** | Если новый путь отсутствует/нечитаем, nginx отдаёт пустой `/docs/` (404), а не падает | bind отсутствующего каталога → пустой каталог | Низкий | pre-create+verify export; fail-fast проверки; откат |
| **R7** | Обновления docs после cutover — ручной fetch/re-export; автоматизации нет | нет CI/cron для docs | Низкий | операционный шаг в отчёте; опционально `deploy/DOCS_PIN` + re-export |
| **R8** | Тесты backend зависят от docs-checkout (Stage 76) | `ANIMASTOR_DOCS_ROOT` / sibling-клон | Низкий | сохранить клон `/home/animastor/animastor-docs`; на портал не влияет |
| **R9** | Старый источник обязан сохраниться для отката | `/home/animastor/animastor/docs` цел, tree `da1f129e…` | — | не удалять до/после cutover; откат — только правка compose назад |

Новых зависимостей от docs-путей в скриптах, CI и cron нет: единственная ссылка на `/home/animastor/animastor/docs` вне compose-файла — untracked chat-лог **[Ф]**.

---

## 4. План cutover (команды подготовлены; **в этом этапе не выполнялись**)

### Фаза 0 — Предварительные проверки / go-no-go

```bash
cd /home/animastor/animastor-backend/deploy

# 0.1 согласование владельцем правки production-конфига (обязательно, сейчас отсутствует)
# 0.2 целевой pin актуален
git ls-remote https://github.com/Animastor/animastor-docs.git refs/heads/main
# ожидается bb8106cf0d06829dc2a2c6039df9593f3430f6f6

# 0.3 старый источник цел
git -C /home/animastor/animastor rev-parse 'HEAD:docs'
# ожидается da1f129e79b3aafb416617171043fd72198ff97d

# 0.4 running compose == on-disk (nginx hash должен быть d1a9feb2…)
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml config --hash='*'

# 0.5 нет незавершённых деплоев / место на диске
docker ps --format '{{.Names}}\t{{.Status}}'
df -h /home/animastor      # ожидается несколько GiB свободно (сейчас 22G free)
docker image ls nginx:alpine   # ожидается 54f2a904c251 (pull не нужен)
```

### Фаза 1 — Подготовка нового источника без удаления старого

```bash
PIN=bb8106cf0d06829dc2a2c6039df9593f3430f6f6
CLONE=/home/animastor/animastor-docs
DEPLOY=/home/animastor/animastor-docs-deploy

git -C "$CLONE" fetch --prune origin
git -C "$CLONE" rev-parse --verify "${PIN}^{commit}"

# export без .git (НЕ монтировать сам клон — риск R1)
TMP="${DEPLOY}.tmp.$$"
mkdir -p "$TMP"
git -C "$CLONE" archive "$PIN" | tar -x -C "$TMP"
test ! -e "$TMP/.git"                       # не должно ничего вывести
[ -z "$(find "$TMP" -name .git -prune -print -quit)" ]
test -f "$TMP/index.html" -a -f "$TMP/README.md" -a -f "$TMP/LICENSE"
test "$(find "$TMP" -type f | wc -l)" -eq 298

# замена (предыдущий export, если был, сохраняется для отката)
[ -e "$DEPLOY" ] && mv "$DEPLOY" "${DEPLOY}.prev"
mv "$TMP" "$DEPLOY"
printf '%s\n' "$PIN" > "${DEPLOY}.pin"     # pin фиксируется вне отдаваемого дерева
```

### Фаза 2 — Переключение (окно обслуживания; ожидаемый простой только nginx ~1–3 с)

```bash
cd /home/animastor/animastor-backend/deploy
mkdir -p /home/animastor/reorg-2026-10-19/rollback-77
cp -a docker-compose.yml          /home/animastor/reorg-2026-10-19/rollback-77/docker-compose.yml.before
cp -a overlay-backend-standalone.yml /home/animastor/reorg-2026-10-19/rollback-77/overlay-backend-standalone.yml.before
sha256sum docker-compose.yml overlay-backend-standalone.yml \
  > /home/animastor/reorg-2026-10-19/rollback-77/compose-sha256.before
docker logs animastor-proxy > /home/animastor/reorg-2026-10-19/rollback-77/nginx-logs.before.txt 2>&1

# правится ТОЛЬКО строка 146 docker-compose.yml:
#   - /home/animastor/animastor/docs:/usr/share/nginx/docs:ro
#   + /home/animastor/animastor-docs-deploy:/usr/share/nginx/docs:ro

# валидация: должен измениться только hash nginx
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml config --hash='*'

# recreate только nginx (backend/gpu-hub/pg/redis не трогаются; образ уже локально)
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d --no-deps nginx
```

### Фаза 3 — Проверки после переключения (см. §5)

```bash
docker inspect animastor-proxy --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
docker exec animastor-proxy nginx -t
curl -sS -o /dev/null -w '%{http_code}\n' https://animastor.org/docs/
curl -sS https://animastor.org/docs/08-mobile-web-migration/README.md | sha256sum
curl -sS -o /dev/null -w '%{http_code}\n' https://animastor.org/docs/LICENSE
docker logs --since 5m animastor-proxy 2>&1 | grep -iE 'error|crit|emerg' || echo 'no nginx errors'
```

### Фаза 4 — Будущие обновления docs (перезапуск nginx не нужен)

```bash
PIN=<новый полный sha>
TMP=/home/animastor/animastor-docs-deploy.tmp.$$
mkdir -p "$TMP"
git -C /home/animastor/animastor-docs fetch --prune origin
git -C /home/animastor/animastor-docs archive "$PIN" | tar -x -C "$TMP"
mv /home/animastor/animastor-docs-deploy /home/animastor/animastor-docs-deploy.prev
mv "$TMP" /home/animastor/animastor-docs-deploy
printf '%s\n' "$PIN" > /home/animastor/animastor-docs-deploy.pin
```
(Mount остаётся валидным, меняется только содержимое каталога; есть короткое неатомарное окно — для docs допустимо.)

---

## 5. Критерии PASS / FAIL

Cutover считается **PASS**, только если сразу после Фазы 2 выполнено всё:

| # | Проверка | Ожидание |
|---|---|---|
| 1 | `docker inspect` mount docs | `…/animastor-docs-deploy -> /usr/share/nginx/docs` |
| 2 | `/docs/` и `/docs/index.html` | 200 `text/html`, 2264 B |
| 3 | `/docs/README.md` | 200 (hash `c6be7a8e…`, тот же контент — сам по себе не доказывает cutover) |
| 4 | `/docs/08-mobile-web-migration/README.md` | 200, sha256 **`1442368c…`** (доказывает новый источник) |
| 5 | `/docs/LICENSE` | **200** (доказывает новый источник) |
| 6 | `/docs/docs-browser.js` / `.css` | 200, ожидаемые типы/размеры |
| 7 | `/docs/01-overview/ARCHITECTURE.md` | 200; `/docs/architecture/` по-прежнему 404 (так и было) |
| 8 | Ресурсы сайта `/styles.css`, `/site.js`, `/logo.png`, `/favicon-16.png`, `/favicon-32.png` | 200 |
| 9 | Остальные хосты: `animastor.org/` 200, `/library` 200, `app.animastor.org/` 200, `admin.animastor.org/` 302 | без изменений |
| 10 | `nginx -t` | OK; в `docker logs` с момента recreate нет error/crit/emerg |
| 11 | `docker ps` | все сервисы подняты; перезапущен только nginx (новый uptime) |
| 12 | TLS | действует до 2027-01-06 |

**FAIL**, если нарушено любое из 2–5, есть регресс 8–9, ошибки nginx или рестарт-луп контейнера.

---

## 6. Немедленный откат

Триггеры: любой FAIL из §5; `/docs/` не 200; неверный hash изменённого файла; пропали ресурсы; сломались другие сайты; ошибки/луп nginx.

```bash
cd /home/animastor/animastor-backend/deploy
cp -a /home/animastor/reorg-2026-10-19/rollback-77/docker-compose.yml.before docker-compose.yml
cp -a /home/animastor/reorg-2026-10-19/rollback-77/overlay-backend-standalone.yml.before overlay-backend-standalone.yml
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d --no-deps nginx
```

Проверка после отката (возврат к baseline):
- `docker inspect animastor-proxy`: source docs = `/home/animastor/animastor/docs`;
- `/docs/` 200; `/docs/08-mobile-web-migration/README.md` sha256 = `d290eecf…`;
- `/docs/LICENSE` 404;
- ресурсы и остальные хосты — 200/302 как в §1.4; `nginx -t` OK; в логах ошибок нет.

Откат независим: старый каталог-источник не изменяется и не удаляется; новый export остаётся для повторной попытки. Force-push, перезапись git-истории и правка `.env` не требуются.

**Минимизация простоя:** пересоздаётся только `nginx` (`--no-deps`), образ уже локально, конфиг проверяется `config --hash='*'`, откат — одной командой, окно выбирается в низкий трафик. Ожидаемый простой ≈1–3 с **[П]** (не измерялся; измерение возможно только реальным cutover).

---

## 7. Обязательные шаги и неподтверждённые условия (нельзя проверить в read-only)

1. **Согласование владельцем** правки production-compose (`deploy/docker-compose.yml:146`) и recreate `animastor-proxy`. Сейчас отсутствует → обязательный гейт выполнения, не технический блокер.
2. **Создание и проверка `.git`-free export** (`/home/animastor/animastor-docs-deploy`) — требуется риском R1; в этом read-only этапе не создавался.
3. **Читаемость нового mount рабочим процессом nginx**: проверить без реального mount нельзя. Косвенно: export будет создан пользователем `animastor` с теми же правами 775/664, что и текущий mono-каталог; bind-mount является точкой монтирования, обход родительских каталогов не участвует; текущий mount отдаёт 200. **[П]** подтверждается проверками 2–5 после cutover.
4. **Фактическая длительность простоя и влияние внешних мониторингов** — **[П]** неизвестно; снижается окном обслуживания и мгновенным откатом.
5. **`deploy/` не в Git**: после cutover стоит рассмотреть версионирование production-compose (вне этого этапа) — риск R2.

---

## 8. Индекс доказательств

- Работающий compose/env: `docker inspect animastor-proxy` (labels), `config --hash='*'` (nginx `d1a9feb2…`).
- Монтирования: `docker inspect` (шесть bind ro; source docs `/home/animastor/animastor/docs`).
- Идентичность контента: host/container sha256 для `README.md`, `index.html`, `docs-browser.js`; отдаваемый `/docs/README.md` sha256 `c6be7a8e…`.
- Новый репозиторий: `git ls-remote` (HTTPS+SSH) `bb8106cf…`; diff дерева с mono docs (1 изменённый файл + `LICENSE`); build-файлов нет.
- Сеть/DNS: `dig A` → `66.116.225.136`, AAAA нет; `server: nginx` (CDN нет).
- HTTP baseline: §1.4; маркеры cutover: §1.4.
- Прецеденты/конвенции: `reorg-2026-10-17/rollback-74/`, `reorg-2026-10-12/rollback-53/`, `reorg-2026-10-11/21-production-cutover-runbook.md`.

Во время аудита production не изменялся. Следующий этап может выполнить §4 после согласования правки production-конфига владельцем.
