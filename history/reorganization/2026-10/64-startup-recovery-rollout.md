# Stage 64 — Rollout startup-recovery registry gate + verify

**Вердикт: PASS**

Дата: 2026-10-18
Развёрнут: backend `ghcr.io/animastor/animastor-backend@sha256:9aac015a6990a4134b5a5f482367a9bdc41b251fff8a7a96b45e0eda13bd9560` (OCI revision `774052504caed92d3af22941cb04052b415e2add`, тег `deploy-7740525`)
Был: `sha256:b3f801144dd135e925ff979076be8687e76cdce1765736637de90048098b7c8e` (deploy-a64199e, rev a64199e)
Rollback: **не потребовался** (ресурсы сохранены, см. §9).

---

## 1. Pre-flight — PASS

- `github/main` = `774052504caed92d3af22941cb04052b415e2add` (Stage 63 fix), оба remote синхронны; рабочее дерево — только pre-existing посторонние изменения (см. §8), они **не включались** ни в один коммит.
- CI (workflow `backend-ghcr-release`, id 382231446): последний запуск `39047106993` (c4788bd) — completed/success; `APPROVED_COMMIT` в workflow стоял на `a64199e` — требовался approval-пин (сделан в §2).
- Текущий контейнер: `sha256:b3f80114…`, restarts=0, Up 11 hours; health `GET https://localhost/health` → 200 `{"status":"ok","loop":true,"redis":"PONG"}`.
- Состав образа Stage 62 подтверждён: `@animastor/editor@0.1.2`, `@animastor/player@0.1.1`, sha256 `{backend.cjs, package.json, package-lock.json, Dockerfile}` = git-источнику 4/4.
- **Rollback-снапшот**: `reorg-2026-10-17/rollback-64/` = `env-before` (копия deploy/.env со старым пином) + `container-image-before.json` (образ контейнера `b3f80114…`). Старый образ `deploy-a64199e`/`a64199e` в GHCR остаётся доступным.

## 2. Approval-коммит + CI — PASS

- **`8a083f6`** `ci(backend): approve 7740525 backend tree for GHCR release (stage 64)` — единственная правка: `.github/workflows/backend-ghcr-release.yml` `APPROVED_COMMIT: a64199e… → 774052504caed92d3af22941cb04052b415e2add` (+1/−1). Push origin+github: оба remote = `8a083f6`.
- **Dispatch** `POST …/workflows/382231446/dispatches`, `ref=main`, `commit=7740525…`, `image_tag=deploy-7740525` → **204**.
- **Run [39092569140](https://github.com/Animastor/animastor-backend/actions/runs/39092569140)** (head `8a083f6c`): **completed / success** (~90 s).
  - Provenance: checkout = `7740525…`; `backend/ tree == approved 774052504caed92d…` ✅.
  - Smoke: sha256 4/4 файлов image==source ✅; OCI label `revision=7740525…` ✅; изолированный boot → `health: 200 {"status":"ok","loop":true,"redis":"PONG"}` ✅; `crash-signature lines: 0` ✅.
  - Push: оба тега → **digest `sha256:9aac015a6990a4134b5a5f482367a9bdc41b251fff8a7a96b45e0eda13bd9560`** (размер 3055).

## 3. Проверка образа — PASS (fix внутри)

Локальный `docker pull` по тегу `deploy-7740525`, RepoDigest = `sha256:9aac015a…`:
- `org.opencontainers.image.revision = 774052504caed92d3af22941cb04052b415e2add`, `version = deploy-7740525` ✅
- `/app/src/helpers/redis-helpers.cjs` sha256 `c4be0664a58d…` **байт-в-байт == git `7740525`** ✅; содержит `isBookRegistered` (5×), `book not registered`, `registry check failed`, `no isBookRegistered gate injected` ✅
- `/app/src/backend.cjs`, `package.json`, `package-lock.json`, `Dockerfile` — sha256 == исходнику 4/4 ✅ (в т.ч. инъекция `redis-helpers.cjs")(redis, { isBookRegistered })` и комментарий `stage 63`)
- Внутри образа: `@animastor/editor` **0.1.2**, `@animastor/player` **0.1.1** ✅; `node --check` обоих изменённых файлов → OK ✅

## 4. Deploy — PASS (только backend)

Единственная правка конфига: `deploy/.env:39` `BACKEND_IMAGE` → `…@sha256:9aac015a…` (diff против `rollback-64/env-before` — ровно одна строка).

```
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend   → rc=0
```

Хронология: `animastor-backend Recreate → Recreated → Started`; pg/redis только `Waiting → Healthy` (**без пересоздания**). `gpu-hub`/`animastor-proxy` — не вызывались вовсе.

Контейнер: образ `sha256:9aac015a…`, started `2026-10-18T03:17:41Z` (перезапуск для финального репро, §6), status running.

## 5. Health / логи startup Phase C0 — PASS

- `GET https://localhost/health` → **200** `{"status":"ok","loop":true,"redis":"PONG"}` (после deploy и после финального restart).
- С момента старта: **0** FATAL / uncaught / TypeError.
- `restarts = 0`.
- Startup Phase C0 (первый boot, ключи удалённой книги ещё существовали):

```
[RECOVERY] Scanning build: build_ba_1788172242081
[RECOVERY] Chunks already exist in Redis for ba_1788172242081, skipping
[RECOVERY] Scanning build: build_import_1786345731767_1786345734345
[RECOVERY] Chunks already exist in Redis for import_1786345731767_1786345734345, skipping
[RECOVERY] Scanning build: manual_1788747351369
[RECOVERY] Skipping recovery for новая_книга_1788747351369 — book not registered   ← контрольное сообщение
… (ещё 4 дисковые незарегистрированные книги —同样的 skip)
[RECOVERY] Complete: 0 chunks recovered across 7 build(s)
[STARTUP] Reconcile cycle: … chunk_recovery:ok …
```

Сообщение о пропуске незарегистрированной книги — **5 вхождений** (по числу дисковых мёртвых книг), `registry check failed (fail-closed)` — 0 (PG доступна, штатно). Всего восстановлено **0** чанков.

## 6. Ключи удалённой книги + репро старого бага — PASS

**До старта/удаления** — ровно 5 подтверждённых ключей (скан `animastor:*1788747351369*`, типы string/set/hash/string/string; имена сверены со списком Stage 63):
```
animastor:chunk:новая_книга_1788747351369_ch-c289a7ac_sc-eebaac15_0001   (string)
animastor:chunks:новая_книга_1788747351369                                (set)
animastor:asset-state:новая_книга_1788747351369:ch-c289a7ac:sc-eebaac15   (hash)
animastor:book-scenes:новая_книга_1788747351369:total                     (string)
animastor:book-scenes:новая_книга_1788747351369:next-index                (string)
```

1. **После старта**: diff «до/после» → идентичны, ровно 5 (не воссоздавались/не размножились) ✅
2. **Удаление**: каждый ключ удалён **по точному имени** (5× `DEL <exact>` → каждый `1`); широкие шаблоны не использовались ✅
3. **После удаления** (спан ≥1 reconcile-цикла 60 с): скан по паттерну → **0**, `EXISTS` каждого из 5 → **0** ✅
4. **Финальный репро** (сам баг Stage 62 — рестарт при отсутствующих ключах): `docker restart animastor-backend` → в логах снова `Skipping recovery for новая_книга_1788747351369 — book not registered`, `Complete: 0 chunks recovered`, после старта скан → **0 ключей** ✅ (со старым кодом тут бы снова родились 5 ключей).

`image_units id=250444`: до = **1**, после всех операций = **1** ✅ (не размножилась).

## 7. Две сохранённые книги — PASS

| Проверка | ba_1788172242081 | import_1786345731767_1786345734345 (Мастер и Маргарита) |
|---|---|---|
| `GET /api/v1/book/:id` | ✅ 200 | ✅ 200 (+ `/status` ✅ 200) |
| сцены в PG | ✅ **8** | ✅ **5** |
| `book.json` SHA-256 | ✅ `e50bcc6147d9331af6409947ef84ff93c5f5ee20bef2d7af69b681c1ae295ae2` (контроль Stage 56–60) | ✅ `60e6e4b11f77a9a650b709b525f4643fab0d6e81a311155933927abb4a0a26ea` (контроль) |
| READY-assets | 26 строк (9 placeholder + 17 stale — как и до, 0 ready) | **15/15 READY-путей существуют** ✅: 13 абсолютных + 2 относительных IU-png резолвятся под `build_import_…/`; рядом 4 pre-existing «мёртвые» `b1/`-дубликаты (Class IV аудит, не трогались) → 19 строк в сумме, как в Stage 62 |
| output-dir на диске | ✅ `build_ba_…` — 21 файл | ✅ `build_import_…` — 68 файлов |
| Redis chunk-сет | ✅ exists=1 | ✅ exists=1 |
| `books` / `scenes` глобально | 2 / 13 — без изменений ✅ | |

## 8. PG / диск не тронуты — PASS

- `books` = 2, `scenes` = 13, `image_units id=250444` = 1 — как до деплоя.
- Каталоги `/data/books/{ba_…, import_…}` и output-каталоги на месте; файлы не удалялись (архивных удалений не выполнялось вообще — только 5 Redis-ключей, §6).
- Инфраструктура: `animastor-pg`/`animastor-redis` started `2026-08-24` (Up 7 weeks, healthy), `gpu-hub`/`animastor-proxy` Up 5 days — **diff «до/после» пуст, restarts=0** ✅ (PG, Redis, GPU Hub, proxy не перезапускались).

## 9. Rollback — не потребовался

Ресурсы на месте: `rollback-64/env-before` (старый пин `b3f80114…`), `rollback-64/container-image-before.json`, GHCR-образы `deploy-a64199e`/`a64199e`/`c4788bd` не удалены. Процедура отката (из Stage 62): восстановить строку `BACKEND_IMAGE` из `env-before` → `up -d backend`. Все проверки PASS, откат не выполнялся.

## 10. Git / состав изменений

```
8a083f6 ci(backend): approve 7740525 backend tree for GHCR release (stage 64)   ← только .github/workflows/… (+1/−1)
7740525 fix(backend): gate startup disk recovery on book registry (stage 63)    ← развёрнут
```
Оба remote = `8a083f6`, обычный push.

**Посторонние изменения НЕ включались** и остались как были: `D backend/scripts/audit-orphan-books.js`; `M` 4 теста (ai-endpoint-sharing, ai-shared-inference, installer-package-boundary, phase5-runtime-result); untracked `deploy/` (кроме намеренно изменённой строки `BACKEND_IMAGE` в `.env` — пин деплоя), `freebuff-chat-2026-10-11T07-41-12.445Z.md`.

## 11. Итог по чек-листу

| # | Пункт | Результат |
|---|---|---|
| 1 | Pre-flight: 7740525, CI, состав, digest, rollback | ✅ |
| 2 | Образ rev `7740525`, digest подтверждён, fix внутри | ✅ `9aac015a…` |
| 3 | Только backend; pg/redis/hub/proxy не перезапускались | ✅ |
| 4 | health/restarts + Phase C0 + skip-сообщение | ✅ 200 / 0 / 5×skip |
| 5 | ba_: 8 сцен, 26 assets; import_: 5 сцен, 15/15 READY; SHA-256 | ✅ |
| 6 | 5 ключей не восстановились; id=250444 = 1 | ✅ |
| 7 | Удалены ровно 5 точных ключей, повторно не появились | ✅ |
| 8 | Диск/output/assets/`250444` не тронуты | ✅ |
| 9 | Rollback-путь задокументирован (не понадобился) | ✅ |
