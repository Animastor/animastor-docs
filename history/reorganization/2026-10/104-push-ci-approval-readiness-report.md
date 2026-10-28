# Stage 104 — Read-only push & CI approval readiness audit

**Дата:** 2026-10-21 (UTC)
**Итог:** **PASS (аудит)** — публикация 4 локальных коммитов подготовлена; approval-gate
**требует** нового коммита-одобрения (текущий `APPROVED_COMMIT` устарел — ожидаемо).
Аудит строго read-only: коммитов, push, dispatch, изменений `.env`/Compose/БД/данных,
смены рабочих деревьев **не выполнялось**.

---

## 1. Состояние репозитория (зафиксировано)

| Параметр | Значение |
|---|---|
| Репозиторий / ветка | `animastor-backend` / `main` |
| HEAD | **`78e8f1ae4bb581f52b736bc64e5ae603dedab839`** |
| Upstream | `origin/main` = **`82c80afd`** → **ahead 4**; `github/main` = `82c80afd` → те же 4 коммита отсутствуют и в GitHub |
| Remotes | `origin = /home/animastor/repos/animastor-backend.git` (bare, локальный), `github = git@github.com:Animastor/animastor-backend.git` |
| Worktree (7 прежних, нетронуты) | `D backend/scripts/audit-orphan-books.js`; `M backend/tests/{ai-endpoint-sharing, ai-shared-inference, architecture/installer-package-boundary, architecture/phase5-runtime-result}.test.js`; `?? deploy/`; `?? freebuff-chat-2026-10-11T07-41-12.445Z.md` |
| Refs | `refs/heads/main=78e8f1ae`, `sync/c21.4-domain-and-fixes=a7a8c463`, remotes `82c80afd`, tag `hub-artifacts-v1=bce64db3` — **не менялись** |

## 2. Четыре локальных коммита — порядок и содержимое

Линейная цепочка `82c80afd → fae1beed → e4255524 → 0e50e23c → 78e8f1ae` (каждый предыдущий — parent):

| # | SHA | Сообщение | Состав (файлы) | Ожидание |
|---|---|---|---|---|
| 1 | **`fae1beed61d8350354f7c44535221a8ed1385c8a`** | `feat(config): port DATA_ROOT abstraction (Stage 96 -> backend)` | 9 файлов: 4 backend/src + 2 backend/tests + 3 orchestration-mirror | перенос DATA_ROOT ✓ |
| 2 | **`e4255524eed3d54e9fa4c1612cea118275a084ed`** | `refactor(config): close backend-only data-path literals … (Stage 98 C3)` | 2 файла: `scene-assets-repo.js`, `orphan-books-audit.js` | адаптация backend-only путей ✓ |
| 3 | **`0e50e23c93e1beef3c601c09dc363cce0323ab4e`** | `chore(orchestration): bump @animastor/orchestration 0.1.3 → 0.1.4 (stage 102)` | 1 файл: пакетный `package.json` (version) | bump пакета ✓ |
| 4 | **`78e8f1ae4bb581f52b736bc64e5ae603dedab839`** | `chore(backend): update orchestration to 0.1.4` | 2 файла: `backend/package.json` + `backend/package-lock.json` | bump зависимости ✓ |

**Посторонние dirty-файлы в коммитах: 0** (сверено `diff-tree` по каждому коммиту — только
перечисленные выше пути; `deploy/`, `freebuff-chat-*.md`, 5 тестовых правок — не включались).
Автор коммитов — `Animastor <…webhostbox.net>`; git config не менялся; тегов нет.

## 3. CI workflow — фактическое состояние (файл читался, не предполагалось)

Файл: `.github/workflows/backend-ghcr-release.yml` (207 строк; последняя правка —
`82c80afd`, stage 76; **с тех пор не менялся**, worktree по `.github/` чист).

| Параметр | Факт |
|---|---|
| Триггеры | **`workflow_dispatch` ONLY** (push-trigger отсутствует — коммит в workflow сам по себе ничего не запускает) |
| Входы dispatch | `commit` (immutable source SHA, required) + `image_tag` (immutable, **не должен уже существовать**; пример формы `deploy-<short-sha>`) |
| `APPROVED_COMMIT` (env, строка 56) | **`74088d60d58bb7dec587effa6e85d2400f572f2c`** → backend/-дерево `443544f0…` |
| Способ передачи approval | **коммит в этот же workflow-файл**, меняющий строку env (история: 8 коммитов `ci(backend): approve <sha> backend tree …`, от `82d2f547` до `82c80afd`) |
| Gate-логика (fail-closed) | (а) checkout HEAD == запрошенный commit; (б) `APPROVED_COMMIT` присутствует в fetch-истории (**fetch-depth: 10** — одобрение должно быть ≤10 коммитов от dispatch-SHA); (в) `git diff --quiet $APPROVED_COMMIT HEAD -- backend/` — **байт-равенство backend/-дерева** |
| Условия build/push | `docker build ./backend` (контекст = `./backend`, без build-args/секретов) → isolated smoke (эфемерный redis, **без** production PG/Redis): sha256-равенство 4 файлов образа vs checkout (`src/backend.cjs`,`package.json`,`package-lock.json`,`Dockerfile`), OCI-label revision, `/health` 200 + redis PONG, нет FATAL/uncaught, контейнер жив → login (`GHCR_IMAGE_PAT`, fallback `github.token`) → **отказ перезаписи существующих тегов** → push `deploy-<short-sha>` + full-SHA-тег → digest в step summary |

**Вывод по gate:** для релиза approval **обязателен** и **устарел**: backend/-дерево `78e8f1ae`
= **`3ecfa69a44b64cc64c41e88e9426d2c8fe57f0ae`** ≠ одобренное `443544f0…` → текущий
dispatch упал бы на PROVENANCE FAIL (правильно, fail-closed). Эволюция backend/-дерева
за коммиты: `443544f0` (74088d6/82c80af) → `a5424c3f` (fae1beed) → `0d435edb` (e4255524,
0e50e23c — пакетный bump вне backend/) → **`3ecfa69a` (78e8f1ae — финал)**.

## 4. Build context и .dockerignore

| Проверка | Результат |
|---|---|
| Контекст сборки | `./backend` (Dockerfile `backend/Dockerfile`: `COPY package.json package-lock.json*` → `npm install --omit=dev --ignore-scripts` → `COPY . .`) |
| `.dockerignore` контекста | **`backend/.dockerignore` отсутствует** (подтверждено `git ls-files`; корневой `.dockerignore` — для gpu-hub/корневого контекста, на `./backend` **не действует**). В CI это безопасно: контекст = чистый checkout |
| `node_modules` | gitignored; в чистом CI-checkout отсутствует → в образ попадают **только** registry-зависимости из lockfile (сейчас 0.1.4). Хостовый `node_modules` (103 МБ) попадает только при **локальной** сборке из рабочей директории — **запрещено практикой; образы собирать только в CI** (hazard Stage 100, не устранён — добавление `backend/.dockerignore` вне объёма) |
| `.env` / секреты | реальных `.env` в tracked-файлах **нет** (только `.env.example`-шаблон вне backend/); `.env` gitignored → в CI-контекст не попадает. Workflow: build без build-args/секретов; PAT только на шаге push |
| Данные книг/output | `data/books`, `data/output` **вне** `backend/` и untracked → в контекст/образ не попадают (production — bind-mount) |
| Состав tracked-контекста | `src/` (180), `tests/` (192 — в образ попадает, **осознанно**: bind-mount `/app/tests` затеняет в runtime; workflow NOTE :31-33), `ai/` (54), `scripts/` (6), `package.json`, `package-lock.json`, `Dockerfile`, `.mocharc.json`, `test_cover.js` ≈ 6.2 МБ |

## 5. Rollback-образ — доступность и digest

| Параметр | Значение |
|---|---|
| Текущий production | контейнер `animastor-backend` **Up 2 days**, labels: revision=`74088d60…`, version=`deploy-74088d6` |
| Digest | **`ghcr.io/animastor/animastor-backend@sha256:182b02525b704d531797a3432ffe2adea494dddd69c5a5b69b0d05c08bd37082`** (создан 2026-10-19T06:29Z) |
| Доступность | локально присутствуют **обе** теговые формы (`:deploy-74088d6` и digest); `docker manifest inspect :deploy-74088d6` — читается анонимно (пакет публичный) → rollback доступен **локально мгновенно** и из GHCR |
| Rollback-история | в локальном docker доступны и прежние deploy-образы (`deploy-c343eec`, `deploy-a7c5827`, …) |
| Механика отката production | `deploy/overlay-backend-standalone.yml` пинит backend через `${BACKEND_IMAGE:?…}` (значение `.env` не читалось и не менялось); откат = вернуть прежний digest-ref в согласованное окно |

## 6. План будущих действий (подготовлен; НЕ выполнялось)

Публикация кода и выкладка в production — **разные этапы**:

**Этап A — approval (локально, отдельный коммит):**
1. Изменить в `.github/workflows/backend-ghcr-release.yml` строку 56:
   `APPROVED_COMMIT: 78e8f1ae4bb581f52b736bc64e5ae603dedab839`.
2. Сообщение по паттерну: `ci(backend): approve 78e8f1ae backend tree for GHCR release (stage 105)`.
3. Локальная верификация gate: `git diff --quiet 78e8f1ae <approval-SHA> -- backend/` → пусто
   (approval-коммит меняет только `.github/` → backend/-дерево идентично).

**Этап B — push кода (владелец):** `git push origin main` (+ github) → `main` = approval-SHA;
проверить `git ls-remote` обе цели == SHA. **Это публикует код, но ничего не собирает и не деплоит** (триггера push нет).

**Этап C — GHCR build (workflow_dispatch, оператор):**
- `commit=` approval-SHA (или `78e8f1ae` — backend/-дерево идентично), `image_tag=deploy-78e8f1a`
  (свободность тега проверена анонимным manifest-inspect — тега нет; workflow перепроверит fail-closed).
- Ожидание: все gate-шаги зелёные; зафиксировать digest из step summary в cutover-аудите.
- **Условия остановки:** любой PROVENANCE FAIL / SMOKE FAIL / «tag already exists» →
  остановиться, не перезапускать с force/overwrite, разобраться; теги никогда не перезаписывать;
  дефект опубликованного пакета лечится supersede-версией (0.1.5), не unpublish.

**Этап D — production cutover (отдельное окно, Stage 92 N1; запрещено в A–C):**
обновить `BACKEND_IMAGE` в `deploy/.env` на новый digest-ref → `docker compose -f
docker-compose.yml -f overlay-backend-standalone.yml up -d backend` в согласованное окно →
smoke `/health` + PG/Redis-связки → запись в аудит. Откат: вернуть
`sha256:182b0252…`/`deploy-74088d6` (§5).

## 7. Dirty-файлы и другие репозитории — не затронуты

| Объект | Состояние (до = после аудита) |
|---|---|
| `animastor-backend` worktree | 7 прежних записей (§1) — не чистились, не переключались |
| монорепо `animastor` | HEAD `088f3fa9`; dirty: `M frontends/website/index.html`, `?? docker/compose/overlay…` — прежние |
| `animastor-gpu-hub` | HEAD `0f489c7`, статус чист |
| Production | backend Up 2 days, proxy Up 2 days, pg/redis 8 weeks (healthy), gpu-hub 8 days — **без рестартов**; `.env`/Compose/БД/Redis/данные — read-only (`docker inspect/ps`, `grep` compose) |
| Git/publish | коммитов, push, dispatch, GHCR, npm publish — **не выполнялось**; refs идентичны §1 |

## 8. Блокеры и риски (без изменений требуют решения владельца)

| # | Блокер/риск | Природа |
|---|---|---|
| B1 | Approval-коммит (Этап A) — без него dispatch падает PROVENANCE FAIL | решение владельца; Stage 104 запрещал создание |
| B2 | Push `main` (ahead 4) в bare origin + GitHub | решение владельца (Этап B) |
| B3 | Production-cutover-окно (Этап D): `.env`-пин `BACKEND_IMAGE`, рестарт | Stage 92 N1; отдельно от публикации кода |
| R1 | `backend/.dockerignore` отсутствует — локальная сборка из рабочей директории небезопасна (§4); CI — безопасен | практика «только CI»; добавление dockerignore — отдельное решение (изменит содержимое образа: выпадет tests/) |
| R2 | fetch-depth 10 — approval-коммит должен быть ≤10 коммитов от dispatch-SHA (при плане §6 — 1) | соблюдено планом |

## 9. Команды верификации (воспроизводимо, read-only)

```bash
git -C /home/animastor/animastor-backend log --oneline origin/main..main   # 4 коммита
git -C /home/animastor/animastor-backend rev-parse 78e8f1ae:backend        # 3ecfa69a… (кандидат на одобрение)
grep -n APPROVED_COMMIT /home/animastor/animastor-backend/.github/workflows/backend-ghcr-release.yml
docker image inspect sha256:182b02525b704d531797a3432ffe2adea494dddd69c5a5b69b0d05c08bd37082 --format '{{.RepoTags}}'
docker manifest inspect ghcr.io/animastor/animastor-backend:deploy-78e8f1a  # отсутствует → тег свободен
```
