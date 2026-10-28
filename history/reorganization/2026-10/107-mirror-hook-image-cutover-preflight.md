# Stage 107 — Mirror-hook safety and production cutover preflight

**Дата:** 2026-10-21 (UTC)
**Итог:** **PASS (аудит, read-only)** — причина удаления GitHub-ветки установлена точно
и воспроизведена на временных репозиториях; безопасный вариант синхронизации выбран и
протестирован (3 положительных теста + 2 отрицательных контроля); digest образа
`deploy-78e8f1a` подтверждён непосредственно из GHCR и связан с CI run `39590195580`,
release-коммитом `78e8f1ae` и backend tree `3ecfa69a` **через SLSA-provenance**;
production сверена read-only и готова к отдельному cutover по плану §C.
**Ни hook, ни refs, ни production в этом этапе не изменялись** (за исключением
erratum-правки в отчёте Stage 106, §B.3).

---

## A. Аудит mirror-hook

### A.1 Фактическое состояние (прочитано, не менялось)

**Bare origin** `/home/animastor/repos/animastor-backend.git`:

| Объект | Значение |
|---|---|
| `hooks/post-receive` (единственный не-sample hook, mtime `2026-10-04 01:49`, до Stage 106) | `#!/bin/sh` / `cd "$GIT_DIR"` / `echo "Mirroring to GitHub..."` / **`git push --mirror github`** |
| Прочие hook-файлы | только `*.sample` (15 шт., неактивны); `core.hooksPath` не задан |
| `config` | `bare=true`; `[remote "github"] url = git@github.com:Animastor/animastor-backend.git`, `fetch = +refs/heads/*:refs/remotes/github/*`; других remotes нет |
| Refs bare origin | `refs/heads/main` = `53ce504536c14413c2c5e7b8546d529db8ee2530`; `refs/remotes/github/main` = `53ce5045…` (stray remote-tracking ref); **ветки `audit/*` в bare — нет**; tags: 0; `packed-refs` пуст |

**GitHub** (`git ls-remote github`, read-only):

| Ref | SHA |
|---|---|
| `HEAD` / `refs/heads/main` | `53ce504536c14413c2c5e7b8546d529db8ee2530` |
| `refs/heads/audit/draft-2026-10` | **`49c1de3925990eb85a08ed429de8b229f325ce9e` — сохранена** ✓ |
| `refs/remotes/github/main` | `82c80afd974a983cdf110e812dc32249f9696ef2` (stray-ref, существует только на GitHub) |

**Рабочая копия** `animastor-backend`: `refs/remotes/github/audit/draft-2026-10` =
`49c1de39…` (восстановленный в Stage 106 объект доступен локально); 7 dirty-файлов
нетронуты; локальный tip `53ce5045…` == bare == GitHub `main`.

### A.2 Точная причина удаления (воспроизведена)

`git push --mirror github` = «push **всех** refs bare origin» + **`--prune`**: любая
GitHub-ref, не имеющая одноимённой пары в bare origin, **удаляется**. Bare содержит только
`refs/heads/main` и `refs/remotes/github/main` → ветка GitHub
`refs/heads/audit/draft-2026-10` не имеет пары → удалена. Плюс побочный эффект:
stray-ref `refs/remotes/github/main` самого bare «утёк» на GitHub как настоящая ref
и был force-обновлён (в Stage 106 в логе: `74088d6..82c80af github/main -> github/main`).

**Репродукция на временных bare-репозиториях** (`/tmp/opencode/s107-mirror-test`,
layout зеркалит production: bare origin {main, refs/remotes/github/main} → «GitHub»
{main, audit/draft-2026-10, stray refs/remotes/github/main}):

```
$ git -C gh.git push --mirror github
 - [deleted]         audit/draft-2026-10            ← независимая GitHub-ветка удалена
   72a8240..72b9aa6  main -> main                  ← желаемая публикация
 + dfab6b4...72a8240 github/main -> github/main (forced update)  ← leak stray-ref
```

Поведение **1:1 совпадает** с логом Stage 106 → причина установлена достоверно, не предположение.

### A.3 Безопасный вариант синхронизации — варианты и выбор

| Вариант | Публикация main | Независимые GitHub-ветки | Stray-refs на GitHub | Расхождение (divergence) |
|---|---|---|---|---|
| `git push --mirror github` (текущий) | ✓ | **УДАЛЯЕТ** | force-обновляет (leak) | молча перезаписывает |
| `git push --prune github 'refs/heads/*:refs/heads/*'` | ✓ | **УДАЛЯЕТ** (`--prune` + refspec без пары) | не трогает | отвергает |
| **`git push github 'refs/heads/*:refs/heads/*'`** (выбран) | ✓ (fast-forward) | **СОХРАНЯЕТ** | **не трогает** | **fail-closed: reject, exit 1** |

Выбран третий вариант: без `--mirror`, без `--prune`, без force — публикуются только
ветки, существующие в bare; всё чужое сохраняется; не-FF расхождение явно фейлит
hook (push в bare уже принят, но зеркало не уходит — оператор видит ошибку).

### A.4 Тест на временных локальных bare-репозиториях (выполнен; production hook не менялся)

| # | Сценарий | Результат |
|---|---|---|
| 1 | Текущая команда `--mirror` против layout с независимой веткой | **Воспроизведено удаление** `audit/draft-2026-10` + leak stray-ref (§A.2) ✓ причина подтверждена |
| 2 | Кандидат `git push github 'refs/heads/*:refs/heads/*'` после восстановления layout | `72b9aa6..c09ce4d main -> main`; `audit/draft-2026-10` **на месте** (`dfab6b4`); stray `refs/remotes/github/main` **не тронут** ✓ |
| 3 | Дивергенция: прямой коммит в «GitHub» main → команда-кандидат | `! [rejected] main -> main (fetch first)`, exit 1; GitHub main **не перезаписан** (`3136652` сохранился); независимая ветка на месте ✓ fail-closed |
| 4 | Контроль: `--prune` + тот же heads-refspec | `audit/draft-2026-10` **удалена** → вариант отклонён как небезопасный ✓ |

(Тестовые репозитории: `/tmp/opencode/s107-mirror-test/{gh.git,github.git,work,clone-gh}` —
временные, вне production.)

### A.5 Минимальный план исправления (ПОДГОТОВЛЕН, НЕ ПРИМЕНЁН)

1. Backup: `cp hooks/post-receive hooks/post-receive.bak-<date>`.
2. Содержимое `hooks/post-receive` заменить на:

```sh
#!/bin/sh

cd "$GIT_DIR" || exit 1

echo "Publishing branches to GitHub (non-pruning, fast-forward-only)..."
git push github 'refs/heads/*:refs/heads/*'
```

3. Canary-проверка первого запуска: `git ls-remote github` до/после — измениться должна
   **только** `refs/heads/main`; `refs/heads/audit/draft-2026-10` и stray-refs остаться.
4. Отдельные решения владельца (не входят в минимальный fix): (а) опционально добавить
   `'+refs/tags/*:refs/tags/*'`, если теги когда-нибудь появятся в bare (сейчас 0);
   (б) удалить stray `refs/remotes/github/main` с GitHub (сейчас инертен; следующий
   `--mirror`-push больше не будет его обновлять/создавать).

**Остаточный риск до применения fix:** любой `git push origin main` снова удалит
`audit/draft-2026-10` на GitHub (Stage 106 восстановил её; hook с тех пор не менялся).
До fix: либо не пушить в bare origin, либо пушить GitHub-side напрямую из рабочей
копии (как в Stage 106), либо принять повторное восстановление ветки.

---

## B. Проверка образа (непосредственно GHCR)

### B.1 Manifest и digest из GHCR

| Проверка | Результат (анонимный доступ к публичному пакету) |
|---|---|
| `imagetools inspect :deploy-78e8f1a` | **Digest = `sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd`**, mediaType `application/vnd.oci.image.index.v1+json` |
| Состав индекса | `sha256:9ac1fd23799311fa68e96b966bfdc7a57495cb6b01df3a3ba7eca03f5c47cab1` — `linux/amd64` image manifest; `sha256:ae4b201f37c72205b0ddc9c9a4a0cb63cfe704239fe1b05e6c39451a5c777186` — attestation manifest (аннотация `vnd.docker.reference.digest` → `9ac1fd23…`) |
| `imagetools inspect :78e8f1ae4bb581f52b736bc64e5ae603dedab839` | тот же digest `sha256:f6aefe57…` — оба тега указывают на один OCI index |
| **Соответствие ожиданию Stage 106** | **тег разрешается ровно в `sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd`** ✓ |
| Локальный pull (из Stage 106) | `RepoDigests=["ghcr.io/…@sha256:f6aefe57…"]`, labels `revision=78e8f1ae…`, `version=deploy-78e8f1a` |

### B.2 С чем НЕ является digest `sha256:44960b31…` — разбор расхождения Stage 106

Утверждение Stage 106 «step summary записал Digest `sha256:44960b31…`» — **ошибочная
интерпретация лога** (erratum внесён в отчёт 106). Факты, проверенные без выводов по
префиксу:

| Объект | Что это на самом деле | Доказательство |
|---|---|---|
| `sha256:44960b3100c48159a66d28c18b0588c193492e25f7551d60e51dd464fc3eca5b` | **OCI image index образа `docker.io/library/redis:7`** (smoke-зависимость), **не** backend-образа | (а) в логе run'а строка `Digest: sha256:44960b31…` стоит сразу после `Status: Downloaded newer image for redis:7` (шаг «Isolated smoke», pull ephemeral redis, 11:13:32 — **до** push'а backend в 11:13:41); (б) `docker buildx imagetools inspect redis:7` → тот же digest, mediaType OCI index; (в) `imagetools inspect ghcr.io/…@sha256:44960b31…` → **not found** в GHCR |
| amd64-манифест redis (локальный RepoDigest) | `redis@sha256:b2b95679e3b46…` — дочерний манифест того же index (разные объекты: index vs platform manifest) | `docker image inspect redis:7` |
| Что реально писал шаг «Record digest» (step 9) | `DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' …:deploy-78e8f1a)` → `ghcr.io/…@sha256:f6aefe57…` | RepoDigests[0] backend-образа локально = `ghcr.io/…@sha256:f6aefe57…` (повторено в этом этапе); пуш-лог: `deploy-78e8f1a: digest: sha256:f6aefe57… size: 856` |

**Вывод:** расхождения digest у backend-образа **не существовало**; единственный
канонический digest = `sha256:f6aefe57…` (index). `44960b31…` — digest чужого
(даже не GHCR-, а Docker Hub) образа, попавший в лог смок-шага.

### B.3 Связь образ ↔ CI run ↔ release commit ↔ backend tree (подтверждена, включая SLSA provenance)

| Звено | Доказательство |
|---|---|
| Образ ↔ **CI run 39590195580** | пуш-лог того же run'а: `deploy-78e8f1a: digest: sha256:f6aefe57…` (11:13:46Z); provenance `startedOn=2026-10-21T11:12:22Z`, `finishedOn=11:13:22Z` — внутри окна run'а (11:12:13–11:13:50Z) |
| Образ ↔ **release commit `78e8f1ae4bb581f52b736bc64e5ae603dedab839`** | (а) OCI-label `org.opencontainers.image.revision=78e8f1ae…`; (б) **SLSA-provenance** (in-toto v0.1, `https://slsa.dev/provenance/v1`, blob `sha256:6dbc93a5…` из attestation-манифеста `ae4b201f…`): `runDetails.metadata.buildkit_metadata.vcs.revision = 78e8f1ae4bb581f52b736bc64e5ae603dedab839`, `vcs.source = https://github.com/Animastor/animastor-backend`, `vcs.localdir:context = backend`; subject-ы `pkg:docker/ghcr.io/animastor/animastor-backend@deploy-78e8f1a?platform=linux/amd64` и `@78e8f1ae…?platform=linux/amd64` → оба `sha256:9ac1fd23…`; base image `node@20-bookworm@sha256:8f693eaa…` |
| Образ ↔ **backend tree `3ecfa69a…`** | `git rev-parse 78e8f1ae:backend` = `3ecfa69a44b64cc64c41e88e9426d2c8fe57f0ae`; `git rev-parse 53ce5045:backend` = то же (approval-коммит backend-дерева не менял); содержимое `/app` образа побайтово == `git archive 78e8f1ae:backend` (Stage 106: `diff -r` пусто, 437/437 файлов); gate CI «backend/ tree == approved» прошёл |
| Approval-цепочка | `78e8f1ae` — ancestor `53ce5045` (проверено `merge-base --is-ancestor`); workflow `APPROVED_COMMIT=78e8f1ae…` |

---

## C. План production-cutover (ПОДГОТОВЛЕН, НЕ ВЫПОЛНЯЕТСЯ)

### C.1 Текущее состояние production (только чтение; ничего не менялось)

| Параметр | Факт |
|---|---|
| Контейнер | `animastor-backend`: `running`, `StartedAt=2026-10-19T06:32:08Z`, `RestartCount=0`, `Up 2 days` |
| Образ контейнера | `ghcr.io/animastor/animastor-backend@sha256:182b02525b704d531797a3432ffe2adea494dddd69c5a5b69b0d05c08bd37082` (= ImageID), labels `revision=74088d60…`, `version=deploy-74088d6` |
| `BACKEND_IMAGE` в `deploy/.env` (строка 39) | **`ghcr.io/animastor/animastor-backend@sha256:182b02525b704d531797a3432ffe2adea494dddd69c5a5b69b0d05c08bd37082`** — **консистентен** с запущенным контейнером; mtime `.env` = `2026-10-19 06:31:53Z` (не менялся в Stage 106/107) |
| Compose | проект `animastor`, config-files `deploy/docker-compose.yml` + `deploy/overlay-backend-standalone.yml`, env-file `deploy/.env`; overlay пинит `image: ${BACKEND_IMAGE:?…}`; `depends_on: postgres/redis (service_healthy)`; `restart: unless-stopped`; healthcheck у backend не задан (см. §C.2 п.5) |
| Bind-монты (пользовательские данные **вне** образа) | `/home/animastor/animastor/data/output → /data/output` (RW, 61M), `/home/animastor/animastor/data/books → /data/books` (RW, 1.9M); код-шадоу: `backend/ai → /app/ai`, `backend/tests → /app/tests` |
| Data-path env | `.env` и контейнер **не задают** `DATA_ROOT`/`OUTPUT_DIR`/`BOOKS_DIR` → новый код (Stage 96 порт) даст те же дефолты `/data/books`, `/data/output` (байт-в-байт, как до; см. комментарий `runtime-config.js`) — **дополнительная переменная для cutover не требуется** |
| Health baseline (read-only exec `/health`) | `200 {"status":"ok","loop":true,"redis":"PONG",…}` |
| Соседи | `animastor-proxy` (80/443), `animastor-pg`/`animastor-redis` (healthy, Up 8 weeks), `gpu-hub` — не перезывались |
| Rollback-образ | `sha256:182b0252…`: локально присутствует (RepoTags `deploy-74088d6`); GHCR manifest читается анонимно → **rollback доступен** |

### C.2 Пошаговый план переключения (отдельное окно, Stage 92 N1; оператор)

0. **Preconditions:** CI run `39590195580` = success; digest `sha256:f6aefe57…` резолвится
   в GHCR (§B.1); текущий пин `sha256:182b0252…` записан как rollback; согласованное
   окно; (mirror-hook fix не нужен для cutover — git-публикация уже завершена).
1. **Backup:** `mkdir -p deploy/rollback-107 && cp deploy/.env deploy/rollback-107/env-backup`
   (+ `sha256sum deploy/.env` в журнал); записать `docker inspect animastor-backend`
   (image digest, labels, StartedAt) в аудит.
2. **Pin:** в `deploy/.env` строка 39 →
   `BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd`.
3. **Pre-pull:** `docker pull "$BACKEND_IMAGE"` — fail-fast по доступности registry/digest.
4. **Пересоздать только backend:**
   `cd deploy && docker compose -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend`
   (compose пересоздаст контейнер при смене image; `postgres`/`redis`/`nginx`/`gpu-hub` **не** трогаются).
5. **Smoke/health (по шагам, с таймаутом):**
   - `docker ps` — `animastor-backend` Up, image = новый digest;
   - `/health` → `200` + `"status":"ok"` + `"redis":"PONG"` (в т.ч. через nginx-роут);
   - `docker logs animastor-backend` — нет `FATAL`/`Uncaught`; PG-строки только ожидаемые;
   - `docker inspect` labels: `revision=78e8f1ae4bb581f52b736bc64e5ae603dedab839`,
     `version=deploy-78e8f1a`;
   - монты: 4 bind-mount'а на тех же host-путях; `du -sh data/books data/output` и
     счётчики файлов **до = после** (п.1);
   - функциональный смоук: список книг/сцена/health-эндпоинты API — без 5xx.
6. **Зафиксировать в cutover-аудите:** новый digest, run `39590195580`, время, результаты.

### C.3 Условия остановки (при любом — немедленный rollback §C.4)

- `docker compose up -d backend` завершился ошибкой; контейнер exited/restart-loop >2 мин;
- `/health` не `200`/нет `redis":"PONG"` в течение ~60 с после старта;
- `FATAL`/`Uncaught` в логах; потеря PG/Redis-связности сверх ожидаемых non-fatal строк;
- label `revision` ≠ `78e8f1ae…`; образ ≠ `sha256:f6aefe57…`;
- bind-монты сменились/пропали; данные books/output изменились/недоступны;
- ошибки API/книжного функционала (5xx, пустые списки, сломанные страницы);
- любое отклонение плана (чужие файлы в `.env`-diff и т.п.).
**Не пытаться обходить gate; не перезапускать вслепую; не перезаписывать GHCR-теги.**

### C.4 Команды отката (rollback на `sha256:182b0252…`)

```bash
cd /home/animastor/animastor-backend/deploy
cp rollback-107/env-backup .env      # либо точечно: BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:182b02525b704d531797a3432ffe2adea494dddd69c5a5b69b0d05c08bd37082
docker compose -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend
# затем тот же smoke: /health 200, labels revision=74088d60…, данные books/output целы
```
Rollback-образ доступен локально мгновенно и из GHCR (§C.1).

### C.5 Сохранность данных

- Пользовательские данные (`data/books` 1.9M, `data/output` 61M) и БД/Redis лежат **вне**
  образа (bind-mount + отдельные контейнеры/тома); `up -d backend` их не трогает;
- новый образ `.env`/книжного контента/output-данных не содержит (Stage 106 §5);
- сравнение data-dir'ов до/после — обязательный шаг п.5; откат не требует миграций
  (изменения коммитов `fae1beed`/`e4255524`/`78e8f1ae` — код+путь-конфиг без смены
  контейнерных дефолтов; проверено в §C.1 data-path env).

---

## D. Границы этапа — соблюдены

| Ограничение | Статус |
|---|---|
| Hook/refs/ветки/теги/git-config | **не изменялись** (mtime hook `2026-10-04 01:49` прежний; refs bare/GitHub как в §A.1) |
| Push / dispatch / build / публикация | **не выполнялись** (только `ls-remote`/`manifest inspect`/`imagetools inspect` — read-only) |
| `.env` / Compose / production / БД / Redis / данные | **read-only** (`docker inspect/ps`, `compose config` (рендер), один exec `/health` GET; mtime `.env` = `2026-10-19 06:31:53Z` без изменений) |
| Deploy / restart / rollback | **не выполнялись** (контейнеры: StartedAt прежние; `RestartCount=0`) |
| 7 dirty-файлов и прочие репозитории | **нетронуты** (`git status` идентичен Stage 106) |
| Единственная запись на диск | отчёт Stage 107 + erratum-абзац в отчёте Stage 106 (коррекция фактической ошибки интерпретации лога, §B.2) |

## E. Итог и оставшиеся блокеры

**PASS.** Подтверждено: причина инцидента (mirror-hook `--mirror` + отсутствие ветки в
bare) воспроизведена; безопасная команда `git push github 'refs/heads/*:refs/heads/*'`
протестирована (сохраняет независимые GitHub-refs, fail-closed на divergence); образ
`deploy-78e8f1a` = `sha256:f6aefe57…` связан provenance-цепочкой с run `39590195580`,
`78e8f1ae` и tree `3ecfa69a`; production готова к cutover по §C.

Оставшиеся блокеры (решения владельца, вне Stage 107):
1. **Применить fix hook'а** (§A.5) — до этого любой push в bare origin повторно удалит
   `audit/draft-2026-10` на GitHub;
2. **Окно production-cutover** (§C) — отдельный этап, явно не выполняемый здесь.
