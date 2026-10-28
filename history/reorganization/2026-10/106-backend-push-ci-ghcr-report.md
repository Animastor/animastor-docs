# Stage 106 — Publish approved backend commits and run CI release

**Дата:** 2026-10-21 (UTC)
**Итог:** **PASS** — 5 проверенных коммитов опубликованы fast-forward push'ем в bare origin
и GitHub; `workflow_dispatch` завершился **success** (все шаги job зелёные: provenance,
build, isolated smoke, GHCR push); новый образ `deploy-78e8f1a` verified в GHCR.
Production **не изменялась**. Инцидент с зеркальным hook'ом (удаление/восстановление
ветки GitHub) — §6.

---

## 1. Pre-flight (выполнен до push)

| Проверка | Ожидание | Факт | Итог |
|---|---|---|---|
| Локальный `main` tip | `53ce504536c14413c2c5e7b8546d529db8ee2530` | совпадает | ✓ |
| Состав | 4 релизных + approval-коммит | `fae1beed6…`, `e4255524e…`, `0e50e23c9…`, `78e8f1ae4…`, `53ce50453…` (линейно) | ✓ |
| Родитель approval-коммита | `78e8f1ae4bb581f52b736bc64e5ae603dedab839` | `git rev-parse 53ce5045^` = `78e8f1ae4…` | ✓ |
| Удалённые refs (до push) | `82c80afd974a983cdf110e812dc32249f9696ef2` | `origin/main` = `github/main` = `82c80afd…` — push будет **strict fast-forward** | ✓ |
| Состав 5 коммитов | без посторонних изменений | `git show --stat` по каждому: только ожидаемые пути (9+2+1+2+1 файл(а)); worktree-файлы (`deploy/`, `freebuff-chat-*.md`, 5 тестовых правок) — **не включались** | ✓ |
| Dirty-файлы (7) | сохранены | ` D backend/scripts/audit-orphan-books.js`; ` M` 4 теста; `?? deploy/`; `?? freebuff-chat-2026-10-11T07-41-12.445Z.md` — до = после | ✓ |
| Workflow | 207 строк, `workflow_dispatch` only, `APPROVED_COMMIT: 78e8f1ae4…` (строка 56) | прочитан фактически, совпал с Stage 105 | ✓ |
| Backend tree approval | `git diff --quiet 78e8f1ae 53ce5045 -- backend/` пусто | `main:backend` = `3ecfa69a44b64cc64c41e88e9426d2c8fe57f0ae` | ✓ |
| Теги `deploy-78e8f1a` / full-SHA | свободны (0 remote tags) | `docker manifest inspect` — отсутствуют в GHCR | ✓ |
| Remotes | `origin = /home/animastor/repos/animastor-backend.git` (bare), `github = git@github.com:Animastor/animastor-backend.git` | подтверждено `git remote -v` | ✓ |

Блокеров не обнаружено → выполнен push.

## 2. Push (быстрый, fast-forward)

```
git push origin main   # 82c80afd..53ce5045  (bare origin)
git push github main   # зеркало origin уже синхронизировало GitHub; "Everything up-to-date"
```

| Remotes-цель | Ref | До | После |
|---|---|---|---|
| bare origin | `refs/heads/main` | `82c80afd` | **`53ce504536c14413c2c5e7b8546d529db8ee2530`** |
| GitHub | `refs/heads/main` | `82c80afd` | **`53ce504536c14413c2c5e7b8546d529db8ee2530`** |

Пост-push верификация: `git ls-remote` обе цели = `53ce5045…`; локальный `main`,
`origin/main`, `github/main` идентичны; `ahead/behind = 0/0`; история GitHub == локальной
(цепочка `82c80afd → fae1beed → e4255524 → 0e50e23c → 78e8f1ae → 53ce5045`).
Push **не перезаписал чужие коммиты** (strict fast-forward; отвергнутых/non-FF обновлений нет).

## 3. CI workflow_dispatch

| Параметр | Значение |
|---|---|
| Workflow | `backend-ghcr-release` (id `382231446`), запуск стандартным API-dispatch'ем (`POST …/actions/workflows/382231446/dispatches`), как в stages 51/53/60 — `gh` CLI в среде отсутствует; авторизация — существующий PAT из `~/.docker/config.json` (тот же, что в prior stages) |
| `ref` | `main` (= `53ce5045…`) |
| `inputs.commit` | **`78e8f1ae4bb581f52b736bc64e5ae603dedab839`** (одобренный релизный commit, как требует этап) |
| `inputs.image_tag` | **`deploy-78e8f1a`** (свободность тега перепроверена до dispatch) |
| HTTP-ответ dispatch | `204` |
| Run | **[39590195580](https://github.com/Animastor/animastor-backend/actions/runs/39590195580)**, head `53ce5045…`, started `2026-10-21T11:12:13Z`, completed `2026-10-21T11:13:50Z` (~97 s) |

### Jobs / шаги (все `completed / success`)

Job `build + isolated smoke + push to GHCR` — **conclusion: success**:

| # | Step | Result |
|---|---|---|
| 1–2 | Set up job / `actions/checkout@v4` (ref=`78e8f1ae`, depth 10) | success |
| 3 | Verify source commit (fail-closed) | success — `backend/ tree == approved 78e8f1ae4…` |
| 4 | Build image (context `./backend`, no build args, no secrets) | success |
| 5 | Isolated smoke (ephemeral redis) | success — sha256-равенство 4 файлов образа vs checkout ✓; OCI revision-label ✓; `/health` = `200 {"status":"ok","loop":true,"redis":"PONG",…}`; crash-signatures `0`; контейнер жив → **SMOKE OK** |
| 6 | Teardown smoke | success |
| 7 | Log in to GHCR (`GHCR_IMAGE_PAT`) | success |
| 8 | Push immutable tags (refuse overwrite) | success — оба тега: `not present, ok to push` → `deploy-78e8f1a` и `78e8f1ae4…` запушены, **без перезаписи** |
| 9 | Record digest | success |

PROVENANCE FAIL / SMOKE FAIL / «tag already exists» — **не срабатывали**; повторных
запусков не было.

## 4. Опубликованный образ (GHCR)

| Параметр | Значение (проверено `docker buildx imagetools inspect` / `docker pull` против GHCR) |
|---|---|
| Теги | `ghcr.io/animastor/animastor-backend:deploy-78e8f1a` и `:78e8f1ae4bb581f52b736bc64e5ae603dedab839` — оба указывают на **один и тот же** артефакт |
| **Digest (индекс, авторитетный)** | **`ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd`** (OCI image index) |
| amd64-манифест | `sha256:9ac1fd23799311fa68e96b966bfdc7a57495cb6b01df3a3ba7eca03f5c47cab1` |
| Attestation-манифест | `sha256:ae4b201f37c72205b0ddc9c9a4a0cb63cfe704239fe1b05e6c39451a5c777186` (BuildKit provenance, unknown/unknown) |
| OCI labels | `revision=78e8f1ae4bb581f52b736bc64e5ae603dedab839`, `version=deploy-78e8f1a` |
| Тег был свободен до push | ✓ (проверено дважды: до dispatch и workflow-шагом 8) |
| Теги-предшественники | не тронуты (`deploy-74088d6` и прежние на месте); новый тег **не** перезаписывал существующий |

**Расхождение step-summary (ERRATUM Stage 107):** исходная формулировка была ошибочной
интерпретацией лога CI — строка `Digest: sha256:44960b31…` в логе run'а (строка 1287)
принадлежит **pull'у `redis:7`** шага isolated-smoke, а не backend-образу и не step
summary (Stage 107 §B.2, доказательство: `docker buildx imagetools inspect redis:7` →
digest `sha256:44960b3100c48159…` = docker.io/library/redis index). Фактический step-9
summary писал `RepoDigests[0]` backend-образа = **`sha256:f6aefe57…`** (канонический
digest, подтверждён GHCR). Ниже — текст оригинала Stage 106.

**Расхождение step-summary (оригинал 106):** step 9 записал в summary `Digest: sha256:44960b3100c481…`
(`RepoDigests[0]` раннерской локальной сборки) — этот digest **не резолвится в GHCR**
(`imagetools inspect @sha256:44960b31…` → not found). Пуш-лог и последующий `docker pull`
дают консистентный **`sha256:f6aefe57…`** — именно он является каноническим digest'ом
изделия; для cutover-пина использовать его.

### Содержимое образа (верифицировано локально по pull'у)

| Проверка | Результат |
|---|---|
| Целевой backend tree | `/app` (без `node_modules`) **побайтово идентичен** `git archive 78e8f1ae:backend` — `diff -r` пусто, 437 файлов = 437 файлов |
| 4 файла gate'а | sha256 совпадают с checkout (шаг 5 CI) и с локальной сверкой |
| Зависимости | `node_modules` (2565 файлов) — только registry-зависимости из lockfile; `@animastor/orchestration` = **0.1.4** ✓ |
| `.env` / `.env*` | **0** (в `/app` и в образе в целом) |
| `node_modules` в контексте сборки | в образ попадают только production-зависимости из lockfile (контекст = чистый CI-checkout; `backend/.dockerignore` отсутствует, хостовый `node_modules` в CI не попадает — Stage 104 §4) |
| Пользовательские книги / output | `data/`, `books/`, `output/` — **0**; маркеры `freebuff`/книжный контент — не найдены; production по-прежнему bind-mount'ит данные снаружи |
| Секреты/`.env` в слоях | не обнаружены |

## 5. Git-состояние после

| Проверка | Результат |
|---|---|
| `main` / remotes | `53ce5045…` везде (локально, bare origin, GitHub `refs/heads/main`) |
| Аhead/behind | `0/0` |
| Теги git | локально только прежний `hub-artifacts-v1`; remote git tags = 0 (теги OCI — в GHCR, не в git) |
| Reflog | только `commit:` (Stage 105) + push-записи; reset/rebase/force — нет |
| 5 коммитов | изменений после публикации не появилось (`git log`/`diff --stat` идентичны §1) |
| **Dirty-файлы (7)** | **сохранены полностью**, не очищены, не staged, не переключены: ` D backend/scripts/audit-orphan-books.js`, ` M backend/tests/{ai-endpoint-sharing, ai-shared-inference, architecture/installer-package-boundary, architecture/phase5-runtime-result}.test.js`, `?? deploy/`, `?? freebuff-chat-2026-10-11T07-41-12.445Z.md` |

## 6. Инцидент: mirror-hook удалил GitHub-ветку (восстановлена)

`git push origin main` сработал **штатный** post-receive hook bare-origin
(`hooks/post-receive`: `git push --mirror github`). `--mirror` синхронизирует GitHub с
содержимым bare-origin, поэтому существовавшая **только на GitHub** ветка
`refs/heads/audit/draft-2026-10` (`49c1de3925990eb85a08ed429de8b229f325ce9e`, отсутствовавшая
в bare-origin) была удалена на GitHub как «лишняя». Коммитов не перезаписывалось; `main`
и все остальные refs пострадали только в пределах задуманного fast-forward.

Восстановление (сделано немедленно, до dispatch CI):

1. `git fetch github 49c1de39…` — объект коммита успешно восстановлен из GitHub (до GC);
2. `git push github 49c1de39…:refs/heads/audit/draft-2026-10` — ветка восстановлена **на
   том же SHA** (`[new branch]`).

После восстановления набор GitHub-refs идентичен до-push'евому, плюс штатное обновление
`main` → `53ce5045…`:

```
53ce5045…  HEAD
49c1de39…  refs/heads/audit/draft-2026-10   (восстановлена)
53ce5045…  refs/heads/main
82c80afd…  refs/remotes/github/main         (прежний stray-ref, не трогался)
```

**Остаточный риск (для владельца, вне объёма Stage 106):** следующий `git push origin`
снова выполнит `--mirror` и снова удалит `audit/draft-2026-10` на GitHub, пока ветка не
будет также закоммичена/запушена в bare-origin (или hook не скорректирован). В Stage 106
hook и bare-origin **не изменялись**.

## 7. Границы безопасности — соблюдены

| Ограничение | Статус |
|---|---|
| Production-cutover | **не выполнялся** |
| `BACKEND_IMAGE` в `.env` | **не изменён** (mtime `deploy/.env` = `2026-10-19 06:31:53Z`, до Stage 106; значение не читалось/не редактировалось) |
| Deploy / restart / production-данные | **не выполнялись**: контейнер `animastor-backend` `Up 2 days`, image `182b02525b70`, labels `revision=74088d60…` / `version=deploy-74088d6`, started `2026-10-19T06:32:08Z`; pg/redis/proxy/gpu-hub — без рестартов; БД/Redis/книжные данные не тронуты |
| Доп. коммиты / изменения кода | **нет** (ни локально, ни в CI-запуске; CI собирал существующий коммит) |
| Force/overwrite тегов | **нет** (оба тега были свободны; штатный refuse-guard пройден) |
| Повторный слепой запуск CI | **нет** — один dispatch, один run, success |
| Dirty-файлы | сохранены (§5) |

## 8. Итоговые артефакты Stage 106

| Артефакт | Значение |
|---|---|
| Опубликованные SHA | `fae1beed61d8…`, `e4255524eed3…`, `0e50e23c93e1…`, `78e8f1ae4bb5…`, `53ce504536c1…` (tip) |
| CI run | `39590195580` — completed / **success** (1 job, все steps success) |
| Image | `ghcr.io/animastor/animastor-backend:deploy-78e8f1a` = `:78e8f1ae4bb581f52b736bc64e5ae603dedab839` |
| **Digest** | **`sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd`** (amd64-манифест: `sha256:9ac1fd23799311fa68e96b966bfdc7a57495cb6b01df3a3ba7eca03f5c47cab1`) |
| Production | не изменена; rollback-пин остаётся `sha256:182b0252…` / `deploy-74088d6` |

Следующий этап (Stage 104 §6, Этап D — отдельное окно, вне Stage 106): production-cutover
через пин `BACKEND_IMAGE` на новый digest + smoke и rollback-план.
