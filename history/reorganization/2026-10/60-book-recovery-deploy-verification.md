# Stage 60 — Deploy BOOK-RECOVER registry gate + live verification

**Date:** 2026-10-17
**Verdict: FAIL (pre-flight STOP — deploy NOT performed, zero production impact)**

Pre-flight подтвердил коммит `c40b2da`, rollback-готовность и чистоту данных,
НО обнаружил блокер: фикс Stage 59 наполовину живёт в npm-пакетах
`@animastor/editor` / `@animastor/player`, которых production-образ потребляет
из registry. Опубликованные версии (`editor@0.1.1`, `player@0.1.0`) фикса **не
содержат** (0 вхождений `isBookRegistered`), а агентские npm-креды недоступны
(`npm whoami` → 401, публикация — действие владельца, прецедент Stage 48).
Сборка образа из `c40b2da` через принятую CI-процедуру дала бы образ, где
`backend.cjs` inject'ит порт `isBookRegistered`, но старые пакеты его **не
читают** → BOOK-RECOVER остался бы активным, цель Stage 60 не достигалась бы.
Согласно мандату («Не импровизировать с деплоем» / «остановиться и доложить»)
— CI не dispatch'ился, `.env` не менялся, ни один контейнер не пересоздавался,
ни один коммит не создавался. Production остаётся на `sha256:71ab1468…`,
данные и книги не тронуты.

---

## 1. Pre-flight (шаг 1) — результаты

| # | Проверка | Результат |
|---|---|---|
| 1.1 | `c40b2da` в `github/main` | ✅ `git ls-remote github refs/heads/main` = `c40b2da0f82ea37d094588883081a231b99b3ca1` |
| 1.2 | `c40b2da` в локальном mirror (`origin`) | ✅ `refs/heads/main` и `refs/remotes/github/main` = `c40b2da` |
| 1.3 | Содержимое коммита = фикс Stage 59 | ✅ 9 файлов, +185/−22: `backend/src/backend.cjs` (порт `isBookRegistered`, fail-closed, injection в recoveryCtx/player-routes), 3 файла `packages/animastor-editor/src/`, 3 файла `packages/animastor-player/src/`, 2 тестовых файла — точно как в отчёте Stage 59 |
| 1.4 | Production deployment workflow | ✅ CI `backend-ghcr-release.yml` (workflow id **382231446**, `workflow_dispatch` only), build context `./backend`, теги `deploy-<short>` + full-sha, публикация в `ghcr.io/animastor/animastor-backend`; rollout = pin `BACKEND_IMAGE` в `deploy/.env` + `docker compose --project-name animastor --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend` (паттерн stages 48/51/53) |
| 1.5 | Текущий digest | ✅ `ghcr.io/animastor/animastor-backend@sha256:71ab14683267df51463700a00ff0d4084a9ce2ef34661ae44dc9d1ebba4abcd8` (tag `deploy-c7eaa9c`, OCI revision `c7eaa9cf…`), restarts=0, started 2026-10-14T04:49:58Z, Up 3 days |
| 1.6 | git status/diff — посторонние изменения | ✅ зафиксированы и **не тронуты**: `D backend/scripts/audit-orphan-books.js`, `M` 4 теста, untracked `deploy/`, `freebuff-chat-*.md` (те же, что Stage 58 §4). HEAD не двигался |
| 1.7 | Rollback готов | ✅ прежний digest доступен в GHCR и локально; снимок сохранён в `reorg-2026-10-17/rollback-60/` (`container-inspect-before.json`, `image-inspect-before.json`, `infra-inspect-before.json`, `env-backup` chmod 600, sha `f10c29df…` = текущий `deploy/.env`) |
| 1.8 | Состояние данных ясно | ✅ полный снимок ниже (§2) |

### 1.9 БЛОКЕР: образ из `c40b2da` не содержал бы фикс поведения

`backend/Dockerfile` (context `./backend`) ставит контурные пакеты **из npm
registry**: `npm install --omit=dev` → `@animastor/editor@^0.1.1`,
`@animastor/player@^0.1.0` (lock: `editor-0.1.1.tgz`, `player-0.1.0.tgz`).
Фикс Stage 59 наполовину в этих пакетах:

| Артефакт | `isBookRegistered` ( gate ) |
|---|---|
| `packages/animastor-editor/src/{editor-routes,read-recovery}.cjs` @ `c40b2da` (repo) | ✅ 4 вхождения |
| `packages/animastor-player/src/scene-data.cjs` @ `c40b2da` (repo) | ✅ 2 вхождения |
| **registry `@animastor/editor@0.1.1` (распакованный tarball)** | ❌ **0** |
| **registry `@animastor/player@0.1.0` (распакованный tarball)** | ❌ **0** |
| `backend/src/backend.cjs` @ `c40b2da` (в образ попадает напрямую) | ✅ определение порта + injection |

Т.е. собранный из `c40b2da` образ содержал бы новый `backend.cjs`, который
передаёт `isBookRegistered` в `recoveryCtx`/player-routes, но **исполняемый
код контуров — старый** (установленный npm-тарболл) — порт никогда не
спросит. Проверено на живом production-образе: в `/app/node_modules/`
`editor@0.1.1`, `player@0.1.0`, файлов с `isBookRegistered` = 0 — т.е. гейта
в проде нет и сейчас, и новый образ без публикации пакетов его бы не добавил.

Registry-версии: `editor` = `['0.1.0','0.1.1']` (latest 0.1.1, 2026-09-27),
`player` = `['0.1.0']` (latest 0.1.0, 2026-09-08). Свободные версии под бамп:
`editor 0.1.2`, `player 0.1.1`.

`npm whoami` → **E401 Unauthorized** — агент не может опубликовать; по
проcedуре Stage 48 публикацию выполняет **владелец** (web-auth), а до
публикации dispatch CI запрещён. Несоблюдение этого запрета в Stage 48
объяснялось тем, что образ без фикса «всё равно не соберётся» (там lock
упирался в несуществующую integrity); здесь危险нее: сборка **пройдёт молча**
и даст бесполезный образ, а deploy сломает цель Stage 60, не сломав ничего
видимого (health будет 200). Именно поэтому — STOP, а не «задеплоить и
надеяться».

Вариант «обхода» (bind-mount `packages/` в контейнер, правка Dockerfile/CI,
vendoring) — это изменение принятой deployment-процедуры и как раз
«импровизация с деплоем», запрещённая мандатом. Не применялся.

## 2. Снимок состояния до (зафиксирован, production не менялся)

**Backend:** `sha256:71ab1468…` (deploy-c7eaa9c, rev `c7eaa9cf`), restarts=0, Up 3 days.
`GET https://localhost/health` → **200** `{"status":"ok","loop":true,"redis":"PONG"}`;
`GET /api/v1/books` → 200 (анонимный pre-auth вид: 2 keep + disk-стабы — ожидаемо).
Логи за 30 мин: **0** FATAL / TypeError / uncaught; steady-state `reconcile:2_issues`
(те же 2 pre-existing `audio-orch violations` по сценам Мастера, что stages 51/53/58).

**Сохранённые книги (контроль Stage 56–58):**

| Проверка | ba_1788172242081 | import_1786345731767_1786345734345 (Мастер) |
|---|---|---|
| `books`-строка, workspace | ✅ `3317e019…` | ✅ `3317e019…` |
| сцены в PG | ✅ 8 | ✅ 5 |
| scene_assets | ✅ 26 (0 ready — как в Stage 58: 9 placeholder + 17 stale) | 427; **READY = 15** (ids 21336…32312), все 15 путей существуют на диске |
| `book.json` SHA-256 | ✅ `e50bcc6147d9331af6409947ef84ff93c5f5ee20bef2d7af69b681c1ae295ae2` = контрольный `e50bcc61…` | ✅ `60e6e4b11f77a9a650b709b525f4643fab0d6e81a311155933927abb4a0a26ea` = контрольный `60e6e4b1…` |

**Остатки удалённой книги `новая_книга_1788747351369`:**
- PG: ровно **1** строка `image_units` id=**250444** (`build=manual_1788747351369`,
  created 2026-10-17T13:30:14Z); в `books`/`scenes`/`scene_assets`/
  `generation_tasks` — **0** строк; `book.json` на диске =
  `b4d264b9…` (контроль Stage 57 после правки). Не удалялась (п.9 мандата).
- Redis: ключей с этим book_id = **0**; `layer-config` только `{ba_, import}`;
  keep-ключи 99 (ba_=34, Мастер=65); dbsize=280.
- Глобальные счётчики: `books=2`, `scenes=13`, `scene_assets=453`,
  `image_units=59`, `generation_tasks=17` — совпадают с Stage 58.
- Соседи не тронуты: pg/redis 7 weeks (healthy), gpu-hub 5 days, proxy 5 days.

## 3. Что НЕ делалось (соблюдение запретов)

- ❌ CI `backend-ghcr-release` **не dispatch'ился**; тег `deploy-c40b2da` в
  GHCR отсутствует (проверено `docker manifest inspect` → manifest unknown).
- ❌ `deploy/.env` не изменён (sha `f10c29df…` до/после идентичен), backend
  не пересоздавался; PostgreSQL, Redis, GPU Hub, Worker, nginx — не трогались.
- ❌ Коммитов не создано (в т.ч. approval-коммит `ci(backend): approve …`
  — без публикации пакетов он открыл бы дорогу бессмысленной сборке);
  push/force-push не выполнялись; рабочее дерево не тронуто.
- ❌ Схема БД, данные, файлы книг/output/assets/bundles не менялись;
  `image_units` id=250444 не удалялась; генерация не запускалась.
- ✅ READ-ONLY операции + запись снимков в `rollback-60/` и `/tmp/opencode/stage60/`.

## 4. Проверки живого поведения (шаг 3) — не проводились

Все пункты послепроверки (digest revision, обе книги «после», BOOK-RECOVER на
удалённой книге, три self-heal-пути, живой клиент, окно наблюдения PG/Redis)
**NOT VERIFIED** — некорректно верифицировать «поведение фикса» на образе, где
фикса нет, и нельзя верифицировать деплой, которого не было. Имитация не
выполнялась. Статус-кво production полностью сохранён: поведение идентично
Stage 58 (клиентский опрос удалённой disk-книги по-прежнему воссоздал бы
Redis-chunks/image_units — причина, по которой Stage 59 и затеял гейт).

## 5. Что нужно владельцу, чтобы разблокировать (процедура Stage 48, паттерн 48/51/53)

1. **Бамп пакетов** (агент подготовить не может без нарушения «no new commits»
   мандата; при согласии владельца это делается одним chore-коммитом):
   - `packages/animastor-editor/package.json` `0.1.1 → 0.1.2` (+ его lock root);
   - `packages/animastor-player/package.json` `0.1.0 → 0.1.1` (+ его lock root);
   - `backend/package.json`: `@animastor/editor ^0.1.2`, `@animastor/player ^0.1.1`;
   - `backend/package-lock.json`: entries `0.1.2`/`0.1.1` с `resolved`-URL и
     integrity **тех tarball'ов**, которые будут опубликованы (см. п.2).
2. **Публикация владельцем** (agent: 401):
   ```bash
   npm whoami   # web-auth, затем:
   cd packages/animastor-editor && npm publish   # → 0.1.2
   cd ../animastor-player && npm publish         # → 0.1.1
   # проверка: npm view @animastor/editor dist-tags   # latest=0.1.2
   #           npm view @animastor/player dist-tags   # latest=0.1.1
   #           dist.integrity == integrity в backend/package-lock.json
   #           в tarball'ах присутствует isBookRegistered (grep ≥1)
   ```
3. **Коммит бампа** (`chore(editor,player): bump … для registry-гейта stage 60`)
   + push `origin` + `github` (обычный push, без force).
4. **Approval-коммит** `ci(backend): approve <sha> backend tree for GHCR release (stage 60)`:
   `APPROVED_COMMIT` → новый sha (паттерн `4f6c779`/`82d2f54`).
5. **CI dispatch** (PAT из `~/.docker/config.json`, как stages 51/53):
   `POST /repos/Animastor/animastor-backend/actions/workflows/382231446/dispatches`
   `ref=main`, `inputs.commit=<sha>`, `inputs.image_tag=deploy-<short>` → ждать run success.
6. **Верификация образа**: digest OCI revision == коммит; внутри образа
   `@animastor/editor@0.1.2` / `@animastor/player@0.1.1`, grep `isBookRegistered` ≥1.
7. **Rollout только backend**: pin `deploy/.env:BACKEND_IMAGE` → новый
   `@sha256:…` (бэкап `rollback-60/env-backup`), затем `up -d backend` по
   команде из deploy/README.md; rollback — вернуть
   `sha256:71ab14683267df51463700a00ff0d4084a9ce2ef34661ae44dc9d1ebba4abcd8`.
8. И только затем — проверки Stage 60 §3 (обе книги, гейт на
   `новая_книга_1788747351369`, три self-heal-пути на изолированной книге,
   живой клиент, окно наблюдения; `image_units` id=250444 удалять только после
   доказательства, что гейт предотвращает повторное создание).

## 6. Артефакты

- Снимок до: `reorg-2026-10-17/rollback-60/{container-inspect-before.json, image-inspect-before.json, infra-inspect-before.json, env-backup (600, sha f10c29df…)}`
- Проверка npm-тарболлов: `/tmp/opencode/stage60/npmchk/{editor-0.1.1.tgz, player-0.1.0.tgz, editor/, player/}`
- API-снимки: `/tmp/opencode/stage60/{health-before.json, books-before.json}`
- Git: без изменений (HEAD `c40b2da`, рабочее дерево = дофайловое состояние Stage 58)
