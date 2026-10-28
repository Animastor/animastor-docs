# Stage 78 — команды будущего cutover и отката (НЕ ВЫПОЛНЕНЫ)

Все команды ниже подготовлены для отдельного этапа выполнения. В Stage 78 они
**не запускались**. Любая команда, меняющая состояние, требует отдельного
разрешения владельца production-конфигурации.

Обозначения:
- `S78=/home/animastor/reorg-2026-10-19/78-docs-deploy-preparation`
- `DEPLOY=/home/animastor/animastor-docs-deploy` (новый каталог; в Stage 78 не создавался)
- `SHA=bb8106cf0d06829dc2a2c6039df9593f3430f6f6`
- `COMPOSE_DIR=/home/animastor/animastor-backend/deploy`
- production compose SHA-256 (зафиксирован): `264550e99d8846ee4551588753e969cfc93b5dbd02c3cd955a3fe53c373cfa74`

---

## 0. Обязательные гейты (без них не начинать)

1. Письменное разрешение владельца на правку production-compose
   (`$COMPOSE_DIR/docker-compose.yml`, строка 146) и recreate сервиса `nginx`.
2. Подтверждение, что `main` в `Animastor/animastor-docs` всё ещё равен `$SHA`:
   `git ls-remote https://github.com/Animastor/animastor-docs.git refs/heads/main`
   Если SHA изменился — остановиться, не подменять версию.
3. Подтверждение, что текущий compose не менялся с Stage 78:
   `sha256sum $COMPOSE_DIR/docker-compose.yml` → должен быть `264550e9…`.
4. Окно низкого трафика: recreate nginx кратковременно прерывает **все** сайты
   за этим прокси. Фактическая длительность простоя не измерена (см. отчёт).
5. Свободное место: экспорт занимает ~7.3 MB; резервная копия ~9 KB.

---

## 1. Предварительный снимок (только чтение + запись в Stage 78)

```bash
set -euo pipefail
S78=/home/animastor/reorg-2026-10-19/78-docs-deploy-preparation
COMPOSE_DIR=/home/animastor/animastor-backend/deploy
TS=$(date -u +%Y%m%dT%H%M%SZ)
ROLLBACK="$S78/rollback-$TS"
mkdir -m 0755 "$ROLLBACK"

# baseline состояния
docker inspect animastor-proxy > "$ROLLBACK/proxy-inspect-before.json"
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' > "$ROLLBACK/containers-before.txt"
curl -sS -o /dev/null -w '%{http_code}\n' https://animastor.org/docs/ > "$ROLLBACK/http-docs-before.txt"

# резервная копия compose (источник не изменяется)
cp -p "$COMPOSE_DIR/docker-compose.yml" "$ROLLBACK/docker-compose.yml.bak"
cp -p "$COMPOSE_DIR/overlay-backend-standalone.yml" "$ROLLBACK/overlay-backend-standalone.yml.bak"
sha256sum "$COMPOSE_DIR/docker-compose.yml" "$ROLLBACK/docker-compose.yml.bak" \
  | tee "$ROLLBACK/SHA256SUMS.txt"

# .env НЕ копировать: он содержит значения секретов (mode 600)
```

Ожидаемо: обе суммы совпадают и равны `264550e9…`.

---

## 2. Подготовка нового источника (без изменения production)

```bash
set -euo pipefail
S78=/home/animastor/reorg-2026-10-19/78-docs-deploy-preparation
DEPLOY=/home/animastor/animastor-docs-deploy
SHA=bb8106cf0d06829dc2a2c6039df9593f3430f6f6

# каталог не должен существовать (защита от перезаписи)
test ! -e "$DEPLOY"
mkdir -m 0755 "$DEPLOY"

# вариант A: из уже проверенного экспорта Stage 78 (побайтно тот же SHA)
cp -a "$S78/export/." "$DEPLOY/"

# вариант B (эквивалент): напрямую из git по зафиксированному SHA
# git -C /home/animastor/animastor-docs archive --format=tar "$SHA" | tar -x -C "$DEPLOY"

# проверки
diff -r "$S78/export" "$DEPLOY" && echo 'EXPORT COPY: identical'
test -z "$(find "$DEPLOY" -name .git -print -quit)" && echo 'NO .git: ok'
test -z "$(find "$DEPLOY" \( -name '.env' -o -name '.env.*' \) -print -quit)" && echo 'NO env files: ok'
chmod -R a+rX "$DEPLOY"
find "$DEPLOY" -type f | wc -l   # ожидается 298
```

---

## 3. Переключение (ИЗМЕНЯЕТ PRODUCTION — только с разрешения)

```bash
set -euo pipefail
COMPOSE_DIR=/home/animastor/animastor-backend/deploy
ROLLBACK=/home/animastor/reorg-2026-10-19/78-docs-deploy-preparation/rollback-<TS>  # из шага 1
cd "$COMPOSE_DIR"

# 3.1 ровно одна строка должна измениться
grep -n '^      - /home/animastor/animastor/docs:/usr/share/nginx/docs:ro$' docker-compose.yml

# 3.2 замена bind source (старый каталог не трогается)
sed -i 's#^      - /home/animastor/animastor/docs:/usr/share/nginx/docs:ro$#      - /home/animastor/animastor-docs-deploy:/usr/share/nginx/docs:ro#' docker-compose.yml

# 3.3 контроль диффа: ровно 1 строка
diff -u "$ROLLBACK/docker-compose.yml.bak" docker-compose.yml

# 3.4 recreate ТОЛЬКО nginx; зависимости не поднимаются
docker compose -p animastor \
  -f docker-compose.yml -f overlay-backend-standalone.yml \
  up -d --no-deps nginx
```

Примечания:
- `nginx -s reload` **недостаточно**: source bind mount меняется только при
  пересоздании контейнера.
- Если compose не пересоздал контейнер (маловероятно при смене mount source),
  выполнить ту же команду с `--force-recreate`.
- Не запускать `up` без `--no-deps` и без имени сервиса: это может затронуть
  backend/pg/redis.
- `.env` не копировать и не выводить.

---

## 4. Проверки после переключения

```bash
set -uo pipefail
B=https://animastor.org
fail=0
check() { # path expected
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$B$1")
  if [ "$code" = "$2" ]; then printf 'OK   %s %s\n' "$code" "$1";
  else printf 'FAIL %s %s (expected %s)\n' "$code" "$1" "$2"; fail=1; fi
}

# портал и ресурсы
check /docs/ 200
check /docs/index.html 200
check /docs/README.md 200
check /docs/LICENSE 200
check /docs/docs-browser.js 200
check /docs/docs-browser.css 200
check /docs/01-overview/ARCHITECTURE.md 200
check /docs/08-mobile-web-migration/README.md 200
check '/docs/Animastor_%D0%91%D0%BB%D0%B8%D0%B7%D0%BA%D0%B8%D0%B5_%D0%B3%D0%BE%D1%80%D0%B8%D0%B7%D0%BE%D0%BD%D1%82%D1%8B.md' 200
check /docs/architecture/ 404

# служебные пути не должны раскрываться
check /docs/.git/config 404
check /docs/.git/HEAD 404
check /docs/.env 404

# сайт и прочие сервисы за тем же nginx
check / 200

# монтирование и содержимое
docker inspect animastor-proxy --format '{{range .Mounts}}{{.Source}}|{{.Destination}}|RW={{.RW}}{{"\n"}}{{end}}' | grep docs
docker exec animastor-proxy sha256sum /usr/share/nginx/docs/index.html
docker exec animastor-proxy sha256sum /usr/share/nginx/docs/LICENSE
sha256sum /home/animastor/animastor-docs-deploy/index.html

# логи после переключения
docker logs --since 10m animastor-proxy 2>&1 | grep -Ei 'error|emerg|crit|alert' || echo 'no nginx errors'
docker ps --format '{{.Names}}\t{{.Status}}'

exit $fail
```

PASS-критерии:
- все `check` — OK (`fail=0`);
- mount source = `/home/animastor/animastor-docs-deploy`, `RW=false`;
- sha256 `index.html` в контейнере совпадает с `$S78/export/index.html`;
- `LICENSE` отдаётся (200), в старом источнике его не было;
- в логах нет `error/emerg/crit`;
- остальные контейнеры имеют прежний `Status`/uptime.

FAIL-критерии (немедленный откат):
- любой 5xx или 404 на страницах из списка;
- 200 на `/docs/.git/...` или `/docs/.env`;
- пустой/неполный листинг docs (например, 0 файлов);
- ошибки nginx в логах;
- недоступность `/` или других сайтов.

---

## 5. Немедленный откат

```bash
set -euo pipefail
COMPOSE_DIR=/home/animastor/animastor-backend/deploy
ROLLBACK=/home/animastor/reorg-2026-10-19/78-docs-deploy-preparation/rollback-<TS>
cd "$COMPOSE_DIR"

# 5.1 вернуть исходный compose
cp -p "$ROLLBACK/docker-compose.yml.bak" docker-compose.yml
sha256sum docker-compose.yml   # ожидается 264550e99d8846ee4551588753e969cfc93b5dbd02c3cd955a3fe53c373cfa74
grep -n '^      - /home/animastor/animastor/docs:/usr/share/nginx/docs:ro$' docker-compose.yml

# 5.2 recreate только nginx
docker compose -p animastor \
  -f docker-compose.yml -f overlay-backend-standalone.yml \
  up -d --no-deps nginx
```

Проверка после отката:

```bash
for u in /docs/ /docs/README.md /docs/docs-browser.js /; do
  printf '%s %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://animastor.org$u")" "$u"
done
docker inspect animastor-proxy --format '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' | grep docs
docker exec animastor-proxy sha256sum /usr/share/nginx/docs/index.html
```

Ожидаемо: 200 на всех; mount source снова `/home/animastor/animastor/docs`;
хеш `index.html` совпадает со старым источником.

Старый источник `/home/animastor/animastor/docs` при cutover **не удаляется и не
изменяется**, поэтому откат не зависит от нового каталога и GitHub.

---

## 6. Что требует отдельного разрешения владельца

1. Правка `$COMPOSE_DIR/docker-compose.yml` (production-конфиг, не в Git).
2. `docker compose up -d --no-deps nginx` (recreate production-контейнера,
   кратковременный простой всех сайтов).
3. Создание `/home/animastor/animastor-docs-deploy` (постоянный артефакт вне
   Stage 78; в Stage 78 не создавался).
4. Любая очистка/удаление старых артефактов (в этом плане не требуется).
