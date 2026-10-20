# Stage 79 — Production Docs Cutover

**Дата:** 2026-10-19
**Итог: PASS**
**Целевой commit:** `bb8106cf0d06829dc2a2c6039df9593f3430f6f6`
**Основание:** Stage 77 (`77-docs-cutover-readiness-audit.md`), Stage 78
(`78-docs-deploy-preparation-report.md`) и артефакты
`78-docs-deploy-preparation/`.
**Разрешение владельца:** правка production Compose и recreate только сервиса
`nginx` — получено. Простой допустим (проект в разработке, пользователей нет).

---

## 1. Итог

Переключение выполнено по плану Stage 77/78. Портал документации теперь
обслуживается из `/home/animastor/animastor-docs-deploy`, содержимое побайтно
соответствует целевому коммиту (298/298 blob). Все post-check пройдены,
откат не потребовался. Старый источник `/home/animastor/animastor/docs`
не изменялся и не удалялся.

| Параметр | Значение |
|---|---|
| Статус | **PASS** |
| Новый источник | `/home/animastor/animastor-docs-deploy` (298 файлов, 7.3 MB) |
| Целевой SHA | `bb8106cf0d06829dc2a2c6039df9593f3430f6f6` |
| Изменённый production-файл | `/home/animastor/animastor-backend/deploy/docker-compose.yml` (1 строка) |
| Compose sha256 до / после | `264550e99d8846ee4551588753e969cfc93b5dbd02c3cd955a3fe53c373cfa74` / `c955be06dd58bb0d7da768d6583bbe22fc2d7dda64b4a99a5fdd834ccb6fc2c7` |
| Пересозданный сервис | только `nginx` (`animastor-proxy`) |
| Простой (измерен) | 1.04 с (6 подряд неуспешных проб, интервал опроса ~0.1–0.25 с) |
| Время выполнения recreate | 2.05 с |
| Откат | не выполнялся |

---

## 2. Проверки перед cutover

Все условия Stage 78 подтверждены непосредственно перед изменением production.

| Проверка | Результат |
|---|---|
| `main` в `Animastor/animastor-docs` (remote) | `bb8106cf0d06829dc2a2c6039df9593f3430f6f6` — совпадает с целевым |
| Экспорт Stage 78, sha256 | `sha256sum -c` — OK (298/298) |
| Список файлов экспорта vs Git-дерево | 298/298, совпадение |
| `.git` / `.env` / `.env.*` в экспорте | 0 / 0 / 0 |
| Production compose sha256 | `264550e9…` — совпадает с зафиксированным в Stage 78 |
| Резервная копия compose (Stage 78) | sha256 `264550e9…`, совпадает с источником |
| `animastor-proxy` | `running`, `RestartCount=0`, создан `2026-10-12T11:45:20Z` |
| Bind mount docs до cutover | `/home/animastor/animastor/docs` → `/usr/share/nginx/docs`, `RW=false` |
| Портал до cutover | `/docs/`, `/docs/index.html`, `/docs/README.md`, `/docs/docs-browser.js`, `/` — HTTP 200 |
| Старый источник | 297 файлов, 7.3 MB, не изменялся |

Диагностика: `79-docs-cutover/preflight/`
(`remote-main.txt`, `compose-sha.txt`, `proxy-before.txt`, `containers-before.txt`,
`http-before.txt`).

---

## 3. Подготовка нового источника

Создан отдельный каталог (не внутри активных репозиториев):

```bash
test ! -e /home/animastor/animastor-docs-deploy
mkdir -m 0755 /home/animastor/animastor-docs-deploy
cp -a /home/animastor/reorg-2026-10-19/78-docs-deploy-preparation/export/. \
      /home/animastor/animastor-docs-deploy/
diff -r .../export /home/animastor/animastor-docs-deploy   # identical
chmod -R a+rX /home/animastor/animastor-docs-deploy
```

Проверки после копирования:

- `diff -r` — полностью идентично экспорту Stage 78;
- `.git` — 0; `.env`/`.env.*` — 0; файлов — 298;
- права: каталог `0755`, файлы доступны на чтение (`a+rX`).

Второй источник не создавался: использован существующий проверенный экспорт,
соответствующий целевому SHA.

---

## 4. Резервная копия и изменение Compose

Резервная копия снята в отдельный каталог вне production:

```
79-docs-cutover/rollback-20261019T061518Z/
├── docker-compose.yml.bak
├── overlay-backend-standalone.yml.bak
├── SHA256SUMS.txt
├── compose.diff
├── compose-config.stderr
└── SHA256SUMS.after-edit.txt
```

`sha256` копии compose = `264550e9…` (совпадает с исходником и Stage 78).
`.env` не копировался.

Изменена ровно одна строка (146), diff — одна пара `+`/`-`:

```diff
-      - /home/animastor/animastor/docs:/usr/share/nginx/docs:ro
+      - /home/animastor/animastor-docs-deploy:/usr/share/nginx/docs:ro
```

Валидация конфигурации:

```bash
docker compose -p animastor -f docker-compose.yml -f overlay-backend-standalone.yml config --quiet
# rc=0, stderr пуст
```

---

## 5. Переключение

Выполнена только команда для сервиса `nginx`, без зависимостей и без pull:

```bash
cd /home/animastor/animastor-backend/deploy
docker compose -p animastor \
  -f docker-compose.yml -f overlay-backend-standalone.yml \
  up -d --no-deps --pull never nginx
```

Вывод: `Recreate → Recreated → Starting → Started`, `rc=0`, 2.05 с.

Факт пересоздания только nginx подтверждён:

- `animastor-proxy`: новый id `2fc60ad520d7…`, `created=2026-10-19T06:18:23Z`,
  `started=2026-10-19T06:18:24Z`, `RestartCount=0`;
- `animastor-backend`, `animastor-pg`, `animastor-redis`, `gpu-hub`,
  `buildx_buildkit_repro0`, `repro-redis` — `CreatedAt` не изменились
  (backend `2026-10-19 05:05:14`, pg/redis `2026-07-08`, gpu-hub `2026-10-12`).

DNS, маршрутизация, TLS, конфиг nginx (`proxy/conf/default.conf`), backend,
`tools/` и остальные сервисы не изменялись.

---

## 6. Проверки после переключения

### 6.1 HTTP (внешний, `https://animastor.org`)

| Код | Путь |
|---|---|
| 200 | `/docs/` |
| 200 | `/docs/index.html` |
| 200 | `/docs/README.md` |
| 200 | `/docs/LICENSE` (новый файл, ранее 404) |
| 200 | `/docs/docs-browser.js` |
| 200 | `/docs/docs-browser.css` |
| 200 | `/docs/01-overview/ARCHITECTURE.md` |
| 200 | `/docs/08-mobile-web-migration/README.md` |
| 200 | `/docs/Animastor_Близкие_горизонты.md` (URL-encoded) |
| 404 | `/docs/architecture/` (нет index) |
| 404 | `/docs/.git/config` |
| 404 | `/docs/.git/HEAD` |
| 404 | `/docs/.env` |
| 404 | `/docs/.env.example` |
| 200 | `/` (сайт за тем же nginx) |

Итого: 15/15 ожидаемых кодов, `matrix_fail=0`.

### 6.2 Источник и содержимое

```
mount: /home/animastor/animastor-docs-deploy|/usr/share/nginx/docs|RW=false
```

- Все 298 файлов нового источника проверены через `git hash-object` против
  blob-хешей целевого коммита: **298 проверено, 0 расхождений**.
- sha256 внутри контейнера совпадает с хостом для `index.html`, `README.md`,
  `LICENSE`, `docs-browser.js`, `docs-browser.css`,
  `08-mobile-web-migration/README.md`.
- В контейнере: 298 файлов, `.git` — 0; чтение всех файлов под uid nginx (101) —
  успешно (`READABLE_ALL`).

### 6.3 Логи и состояние

- `docker logs --since 3m animastor-proxy`: нет `error/emerg/crit/alert`;
- ни одного `200` для `/docs/.git*` или `/docs/.env*` в access-логе;
- `animastor-proxy`: `status=running`, `RestartCount=0` (не в цикле перезапусков);
- остальные контейнеры — прежние `CreatedAt`, статусы healthy/running.

### 6.4 Простой

Непрерывный опрос `https://animastor.org/docs/` с интервалом ~0.1–0.25 с:
130 проб, 124 × 200, 6 подряд `ERR`. Окно недоступности между первой и последней
неуспешной пробой — **1.04 с**; команда recreate заняла 2.05 с (включая
подготовку и проверки compose). Пользователей на момент cutover нет.

---

## 7. Сохранность старого источника

- `/home/animastor/animastor/docs` не удалялся, не перемещался и не изменялся;
- 297 файлов, 7.3 MB — как до cutover;
- старый каталог остаётся рабочим источником для немедленного отката и не
  зависит от нового каталога, экспорта или GitHub.

---

## 8. Отклонения от плана

| Отклонение | Причина / оценка |
|---|---|
| Резервная копия размещена в `79-docs-cutover/rollback-<TS>/`, а не в каталоге Stage 78 | безопасно: оба пути вне активных репозиториев и production-каталогов; Stage 78 остаётся неизменным |
| Добавлен флаг `--pull never` | исключает сетевой pull; образ `nginx:alpine` уже локальный |
| `--force-recreate` не использовался | compose пересоздал контейнер сам из-за смены mount source |
| Добавлен фоновый HTTP-проб для измерения простоя | не влияет на production; дал измеренные 1.04 с вместо оценки |
| `config --quiet` вместо `config` | проверка синтаксиса без вывода значений переменных (секретов) |

Иных отклонений нет. Откат не выполнялся.

---

## 9. Диагностические данные

```
79-docs-cutover/
├── ts.txt
├── preflight/
│   ├── remote-main.txt
│   ├── compose-sha.txt
│   ├── proxy-before.txt
│   ├── containers-before.txt
│   └── http-before.txt
└── rollback-20261019T061518Z/
    ├── docker-compose.yml.bak
    ├── overlay-backend-standalone.yml.bak
    ├── SHA256SUMS.txt
    ├── compose.diff
    ├── compose-config.stderr
    ├── SHA256SUMS.after-edit.txt
    ├── recreate.log
    ├── probe-during-cutover.log
    ├── post-http.txt
    ├── post-mount.txt
    ├── post-hashes.txt
    ├── post-blob-verify.txt
    ├── post-container-read.txt
    ├── post-readability-101.txt
    ├── post-containers.txt
    └── nginx-after.log
```

---

## 10. Откат (подготовлен, не выполнялся)

При возникновении FAIL-условий:

```bash
cd /home/animastor/animastor-backend/deploy
cp -p /home/animastor/reorg-2026-10-19/79-docs-cutover/rollback-20261019T061518Z/docker-compose.yml.bak docker-compose.yml
sha256sum docker-compose.yml   # ожидается 264550e99d8846ee4551588753e969cfc93b5dbd02c3cd955a3fe53c373cfa74
docker compose -p animastor -f docker-compose.yml -f overlay-backend-standalone.yml \
  up -d --no-deps --pull never nginx
```

Затем проверить 200 на `/docs/`, `/docs/README.md`, `/docs/docs-browser.js`, `/`
и mount source `/home/animastor/animastor/docs`. Старый каталог не удалять.

---

## 11. Итоговое состояние

- Портал документации: `https://animastor.org/docs/` — 200, новый источник,
  целевой коммит `bb8106cf…`.
- Production compose: изменена одна строка, sha256 `c955be06…`.
- Nginx: пересоздан однократно, `RestartCount=0`, критических ошибок нет.
- Остальные сервисы: не пересозданы.
- Старый источник: сохранён (297 файлов).
- `.git`/`.env` через портал не раскрываются (404).
