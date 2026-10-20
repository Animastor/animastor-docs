# Stage 78 — подготовка и проверка артефактов развёртывания документации

**Дата:** 2026-10-19
**Режим:** подготовка и проверки; production cutover не выполнялся
**Целевой репозиторий:** `Animastor/animastor-docs`
**Зафиксированный SHA:** `bb8106cf0d06829dc2a2c6039df9593f3430f6f6`
**Предыдущий отчёт:** `/home/animastor/reorg-2026-10-19/77-docs-cutover-readiness-audit.md`
**Каталог артефактов:** `/home/animastor/reorg-2026-10-19/78-docs-deploy-preparation/`

## Статус: PASS

Артефакты подготовлены и проверены: экспорт побайтно соответствует целевому
коммиту (298/298 blob), `.git` и файлов окружения нет, изолированный nginx-тест
подтвердил корректную отдачу страниц и ресурсов и отсутствие раскрытия служебных
путей, резервная копия production-compose снята и не содержит секретов,
процедура переключения и отката подготовлены.

**PASS Stage 78 не является разрешением на production cutover.** Переключение
требует отдельного согласования владельца (см. §8).

---

## 1. Исходные условия

| Проверка | Результат |
|---|---|
| `main` в `Animastor/animastor-docs` (remote, HTTPS) | `bb8106cf0d06829dc2a2c6039df9593f3430f6f6` |
| Локальный checkout `/home/animastor/animastor-docs` | `HEAD` = тот же SHA, рабочее дерево чистое (0 изменений) |
| Совпадение с целевым SHA Stage 77 | да, расхождения нет |
| Production-compose | `/home/animastor/animastor-backend/deploy/docker-compose.yml` + `overlay-backend-standalone.yml`, project `animastor`, сервис `nginx` |
| SHA-256 production-compose | `264550e99d8846ee4551588753e969cfc93b5dbd02c3cd955a3fe53c373cfa74` |
| Production-контейнер | `animastor-proxy`, `Up 6 days` (не пересоздавался) |
| Bind mount docs | `/home/animastor/animastor/docs` → `/usr/share/nginx/docs`, `RW=false` (read-only) |
| Nginx config | `/home/animastor/animastor/proxy/conf/default.conf`, sha256 `99f706af…`, nginx/1.31.2, `nginx:alpine` |
| Старый источник | `/home/animastor/animastor/docs`, 297 файлов, без `.git` и `.env` |
| Production-портал | `/docs/`, `/docs/README.md`, `/docs/docs-browser.js` — HTTP 200 |
| Соответствие production → старый источник | sha256 `index.html`, `README.md`, `docs-browser.js`, `08-mobile-web-migration/README.md` совпадают host ↔ контейнер |

Выводы Stage 77 подтверждены: портал статический, сборки и publish-пайплайна нет,
источник — bind mount старого каталога в монорепозитории. `deploy/` не отслеживается
Git (`git ls-files deploy` = 0), поэтому compose неверсионирован и правка требует
резервной копии.

`tools/` не затрагивался; его статус остаётся BLOCKED.

---

## 2. Экспорт документации

Экспорт получен из зафиксированного коммита (git archive точного дерева, без
рабочего дерева и без `.git`) и размещён только в каталоге Stage 78:

```
/home/animastor/reorg-2026-10-19/78-docs-deploy-preparation/export/
```

| Параметр | Значение |
|---|---|
| Исходный SHA | `bb8106cf0d06829dc2a2c6039df9593f3430f6f6` |
| Файлов | 298 |
| Каталогов (включая корень) | 21 |
| Объём | 7 016 942 байт (7.3 MB) |
| `PIN.txt` | содержит полный SHA |
| `export-sha256.txt` | 298 строк, sha256 каждого файла; проверка `sha256sum -c` — OK |
| `target-tree.txt` | `git ls-tree -r` целевого коммита (298 записей) |

Исходный checkout не изменялся (clean), старая production-документация не
изменялась и не удалялась. Ветки, refs и remotes не трогались; commit/push не
выполнялись.

---

## 3. Целостность и служебные файлы

### 3.1 Соответствие Git-дереву

| Проверка | Результат |
|---|---|
| Список файлов export vs `git ls-tree -r <SHA>` | **298/298, полное совпадение** (сравнение с `core.quotepath=false`; первоначальный diff был только из-за экранирования кириллического имени) |
| Blob-хеши: `git hash-object` каждого файла vs blob из дерева | **298 проверено, 0 расхождений** |
| `sha256sum -c export-sha256.txt` | OK (298/298) |
| Манифест покрывает все файлы | да, 298 строк |

### 3.2 Отсутствие `.git` и файлов окружения

| Проверка | Результат |
|---|---|
| Каталог `.git` в export | отсутствует |
| `.git/**` | отсутствует |
| `.env`, `.env.*`, credentials-файлы | отсутствуют |
| Единственные `.git*`-совпадения | `runtime-audits/image-qwen/.gitkeep`, `runtime-audits/video-ltx-2.3/.gitkeep` — штатные файлы дерева коммита (пустые, blob `e3b0c442…`), не служебные данные Git |

### 3.3 Проверка секретов

`secret-scan.txt`: 1 совпадение по шаблонам — в
`architecture/PHASE_10I_EXTERNAL_GPU_HUB_INTEGRATION_READINESS_AUDIT.md:105`
строка документации с примером `redis://:pass@host:6379`. Это **не секрет**, а
пример формата URL; значения credentials нет.

Ограничение: скан основан на шаблонах и не доказывает абсолютное отсутствие
секретов. Дополнительно: в export нет `.env`/`.git`, а содержимое побайтно
совпадает с публичным репозиторием `Animastor/animastor-docs` (public), т.е.
любой секрет уже был бы публичным. При этом полный аудит истории репозитория —
вне рамок Stage 78.

---

## 4. Проверка Nginx в изолированном контейнере

### 4.1 Стенд

Создан одноразовый контейнер `docs-stage78-test` (не production):

- образ `nginx:alpine` (локальный, `--pull never`), тот же, что у production;
- имя уникально, `--rm`, без `restart`;
- порт только `127.0.0.1:18080` (наружу не публиковался);
- сеть `bridge` (не production-сеть);
- монтирования только read-only:
  - `export/` → `/usr/share/nginx/docs`;
  - `probe/` → `/usr/share/nginx/probe` (синтетический негативный контроль);
  - `/home/animastor/animastor/frontends/website` → website root;
  - `nginx-test.conf` → `/etc/nginx/conf.d/default.conf` (минимальный конфиг,
    повторяющий `/docs/`-локации production; без TLS, upstream и proxy_pass).

`nginx -t` — successful.

### 4.2 Результаты запросов

| Ожидание | Код | Путь | Content-Type |
|---|---|---|---|
| 200 | 200 | `/` | text/html |
| 200 | 200 | `/docs/` | text/html |
| 200 | 200 | `/docs/index.html` | text/html |
| 200 | 200 | `/docs/README.md` | text/plain |
| 200 | 200 | `/docs/01-overview/ARCHITECTURE.md` | text/plain |
| 200 | 200 | `/docs/08-mobile-web-migration/README.md` | text/plain |
| 200 | 200 | `/docs/LICENSE` | text/plain |
| 200 | 200 | `/docs/docs-browser.js` | application/javascript |
| 200 | 200 | `/docs/docs-browser.css` | text/css |
| 200 | 200 | `/docs/Animastor_Близкие_горизонты.md` (URL-encoded) | text/plain |
| 404 | 404 | `/docs/architecture/` (нет index) | text/html |
| 404 | 404 | `/docs/.git/config` | text/html |
| 404 | 404 | `/docs/.git/HEAD` | text/html |
| 404 | 404 | `/docs/.git/` | text/html |
| 404 | 404 | `/docs/.env` | text/html |
| 404 | 404 | `/docs/.env.example` | text/html |
| 404 | 404 | `/docs/local.properties` | text/html |

Тела 404 — стандартная страница nginx, содержимое служебных файлов не
раскрывается. В access-логе нет ни одного `200` для `/docs/.git/*` или
`/docs/.env*`. Ошибок/предупреждений nginx в логе нет (39 строк,
`nginx-test-access.log`).

### 4.3 Негативный контроль (важно)

Тот же конфиг над синтетическим каталогом `probe/` (безвредные заглушки):

| Путь | Код |
|---|---|
| `/probe/.git/config` | **200** |
| `/probe/.env` | **200** |

Это доказывает, что в конфиге nginx **нет deny-правил для dotfiles**: защита
обеспечивается исключительно тем, что в экспорте нет `.git`/`.env`. Следствие:
монтировать git-checkout напрямую нельзя — это раскрыло бы `/docs/.git/...`.
Негативный контроль подтверждает корректность выбранного способа (`.git`-free
export).

### 4.4 Чистота после теста

Контейнер остановлен и удалён (`--rm`), residual-контейнеров нет. Production-
контейнеры не пересоздавались, не перезапускались и не перезагружались:
`animastor-backend` (Up 57 минут), `animastor-pg` (Up 7 недель), `animastor-proxy`
(Up 6 дней), `animastor-redis` (Up 7 недель), `gpu-hub` (Up 6 дней) — статусы
соответствуют состоянию до Stage 78. Bind mounts, маршрутизация, DNS и Nginx не
менялись.

---

## 5. Резервная копия и откат

| Параметр | Значение |
|---|---|
| Фактический compose | `/home/animastor/animastor-backend/deploy/docker-compose.yml` |
| Overlay | `/home/animastor/animastor-backend/deploy/overlay-backend-standalone.yml` |
| Копия | `78-docs-deploy-preparation/compose-backup/` |
| sha256 compose (источник = копия) | `264550e99d8846ee4551588753e969cfc93b5dbd02c3cd955a3fe53c373cfa74` |
| sha256 overlay (источник = копия) | `9f13d8887039257f8f029bf2d75ebeb523c7cc7d46000647402e5c48ebf631a6` |
| Контрольные суммы | `compose-backup/SHA256SUMS.txt` |
| `.env` | **не копировался** (mode 600, содержит значения секретов) |

Проверка секретов в копии: все `PASSWORD`/`API_KEY`/`SECRET_KEY`-значения —
ссылки вида `${VAR:?…}` / `${VAR:-}`; литеральных credentials и URL с паролями
нет. Значения в отчёт не выводились.

Независимость отката: старый источник `/home/animastor/animastor/docs` не
удаляется и не изменяется; откат — восстановление одной строки compose из копии
и recreate nginx. Новый каталог и GitHub для отката не нужны.

---

## 6. Различия старого источника и нового экспорта

`old-vs-new-diff.txt`:

- 296 файлов идентичны;
- отличается 1 файл — `08-mobile-web-migration/README.md`;
- добавлен `LICENSE` (в старом источнике отсутствует).

Единственное содержательное изменение:

```diff
-- [`README.md`](../../README.md) — project services (frontends/mobile)
+- [`README.md`](../README.md) — project services (frontends/mobile)
```

Объяснение: в старом каталоге ссылка `../../README.md` вела за пределы каталога
docs (в корень монорепозитория); в отдельном репозитории она исправлена на
корректную `../README.md` (корень `animastor-docs`). `LICENSE` добавлен при
выделении репозитория. Оба отличия ожидаемы и соответствуют Stage 76/77.

---

## 7. Процедура переключения

Полные команды — в `cutover-commands.md` (подготовлены, **не выполнялись**).
Кратко:

1. Гейты: разрешение владельца, SHA `main` не изменился, compose sha256 =
   `264550e9…`, окно низкого трафика.
2. Снимок: `docker inspect` + копия compose в `rollback-<TS>/` + sha256.
3. Новый источник: `test ! -e /home/animastor/animastor-docs-deploy` → создать →
   скопировать проверенный экспорт → `diff -r` → проверить отсутствие `.git`/`.env`
   → `chmod -R a+rX`.
4. Переключение: заменить ровно одну строку 146 compose
   (`/home/animastor/animastor/docs` → `/home/animastor/animastor-docs-deploy`),
   подтвердить диффом, затем
   `docker compose -p animastor -f docker-compose.yml -f overlay-backend-standalone.yml up -d --no-deps nginx`.
   `nginx -s reload` недостаточен — mount меняется только при recreate.
5. Проверки: HTTP-коды страниц/ресурсов/сайта, 404 на служебные пути, mount
   source, sha256 внутри контейнера, логи, статусы контейнеров.
6. Откат: вернуть `docker-compose.yml` из `rollback-<TS>/`, сверить sha256,
   повторить `up -d --no-deps nginx`, проверить 200 и старый mount.

### 7.1 Критерии PASS/FAIL

PASS (все пункты одновременно):

- все проверяемые URL дают ожидаемые коды: `/docs/`, `/docs/index.html`,
  `/docs/README.md`, `/docs/LICENSE`, `/docs/docs-browser.js`,
  `/docs/docs-browser.css`, `/docs/01-overview/ARCHITECTURE.md`,
  `/docs/08-mobile-web-migration/README.md` и кириллический файл — 200;
  `/docs/architecture/` — 404; `/` — 200;
- `/docs/.git/config`, `/docs/.git/HEAD`, `/docs/.env` — 404, содержимое не
  раскрывается;
- bind mount в `animastor-proxy`: source `/home/animastor/animastor-docs-deploy`,
  destination `/usr/share/nginx/docs`, `RW=false`;
- sha256 `/usr/share/nginx/docs/index.html` внутри контейнера совпадает с
  `78-docs-deploy-preparation/export/index.html`;
- в `docker logs animastor-proxy` за окно проверки нет `error/emerg/crit/alert`;
- остальные контейнеры сохранили прежние статусы, `animastor-proxy` пересоздан
  (новый `Created`).

FAIL (любой пункт → немедленный откат):

- любой 5xx или неожиданный 404 на перечисленных страницах/ресурсах;
- 200 на `/docs/.git/...` или `/docs/.env*`;
- пустой или неполный docs-каталог в контейнере (например, 0 файлов);
- ошибки nginx в логах;
- недоступность `/` или других сайтов за прокси.

### 7.2 Условия немедленного отката и точное восстановление bind mount

Откат выполняется немедленно при любом FAIL-пункте, при ошибке nginx, при
недоступности портала или сайта, а также если содержимое в контейнере не
совпадает с экспортом.

```bash
COMPOSE_DIR=/home/animastor/animastor-backend/deploy
ROLLBACK=/home/animastor/reorg-2026-10-19/78-docs-deploy-preparation/rollback-<TS>
cd "$COMPOSE_DIR"
cp -p "$ROLLBACK/docker-compose.yml.bak" docker-compose.yml
sha256sum docker-compose.yml   # 264550e99d8846ee4551588753e969cfc93b5dbd02c3cd955a3fe53c373cfa74
docker compose -p animastor -f docker-compose.yml -f overlay-backend-standalone.yml \
  up -d --no-deps nginx
```

Восстановленная строка 146 должна иметь вид:

```yaml
      - /home/animastor/animastor/docs:/usr/share/nginx/docs:ro
```

Проверка после отката: 200 на `/docs/`, `/docs/README.md`, `/docs/docs-browser.js`,
`/`; mount source снова `/home/animastor/animastor/docs`; sha256 `index.html`
совпадает со старым источником. Старый каталог при cutover не изменялся, поэтому
откат не зависит от нового каталога, экспорта и GitHub.

Полные команды с проверками — в `cutover-commands.md` §4–5.

---

## 8. Что требует отдельного разрешения

1. Правка production-compose (`docker-compose.yml`, строка 146) — production-
   конфигурация, не версионирована.
2. `docker compose up -d --no-deps nginx` — recreate production-контейнера,
   кратковременная недоступность **всех** сайтов за прокси.
3. Создание постоянного каталога `/home/animastor/animastor-docs-deploy`
   (в Stage 78 не создавался; все артефакты — только в каталоге Stage 78).
4. Любая очистка старых артефактов (в подготовленном плане не требуется).

Без пунктов 1–2 cutover не выполняется.

---

## 9. Непроверенное и ограничения

| Пункт | Статус |
|---|---|
| Фактическое время простоя при recreate nginx | **не измерялось**; оценок в секундах не приводим. Recreate затрагивает все сайты за прокси |
| Влияние внешнего мониторинга/алертов | не проверялось |
| Читаемость каталога рабочим процессом nginx под production-пользователем | косвенно проверена в изолированном контейнере того же образа (root master/worker по умолчанию); для нового каталога запланирован `chmod -R a+rX` и проверка sha256 внутри контейнера после cutover |
| Поведение при недоступности GitHub в момент cutover | не влияет: используется локальный экспорт, сеть не требуется; повторный экспорт — только при желании пере-проверить SHA |
| Согласование владельца | отсутствует (обязательный гейт) |
| Абсолютное отсутствие секретов | шаблонный скан + отсутствие `.env`/`.git` + публичность репозитория; не является формальным доказательством |
| Внешние ссылки внутри документации | не проверялись в Stage 78 (вне scope) |
| `tools/` | не затрагивался, статус BLOCKED |

---

## 10. Артефакты Stage 78

```
78-docs-deploy-preparation/
├── PIN.txt                     # зафиксированный SHA
├── export/                     # 298 файлов, .git-free
├── export-sha256.txt           # 298 контрольных сумм
├── target-tree.txt             # git ls-tree целевого коммита
├── old-vs-new-diff.txt         # 1 изменённый файл + LICENSE
├── changed-file-diff.txt       # дифф изменённого файла
├── secret-scan.txt             # 1 ложное срабатывание (пример URL)
├── nginx-test.conf             # изолированный тестовый конфиг
├── nginx-test-access.log       # 39 строк, без ошибок
├── probe/                      # синтетический негативный контроль
├── compose-backup/             # compose + overlay + SHA256SUMS.txt
└── cutover-commands.md         # команды cutover/отката (не выполнялись)
```

Ничего в production-каталогах, активных репозиториях, Git refs, DNS, Nginx и
контейнерах не изменялось. Новые артефакты размещены только в каталоге Stage 78.
