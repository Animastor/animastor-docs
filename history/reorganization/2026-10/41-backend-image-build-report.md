# Этап 41 — Сборка и публикация backend-образа из утверждённого коммита `a7a8c463`

**Дата:** 2026-10-12 (окно ~14:05–14:55 UTC)
**Итог: PARTIAL** — целевой образ собран и **опубликован в GHCR**
(`deploy-a7a8c463` + full-sha тег, digest `e1fac1d2…`), происхождение доказано
(424/424 файла байт-в-байт == `git a7a8c463:backend/...`, SLSA-provenance в
образе), изолированный smoke — PASS. **Production не переключался и не менялся**
(см. §8). PARTIAL ровно из-за одного ограничения: штатный CI-push в GHCR
заблокирован правами пакета (`denied: permission_denied: write_package`) —
публикацию выполнили локальным `docker push` теми же тегами; фикс CI подготовлен
(§7).

---

## 0. Краткая сводка

| Цель этапа 41 | Статус | Факт |
|---|---|---|
| Сборка из `a7a8c463` по штатному `backend/Dockerfile`, контекст `./backend`, без build-args/secrets | **да** | локальная сборка из чистого `git archive a7a8c463 backend` |
| Доказательство, что образ содержит утверждённый исходник | **да** | 424/424 файла (без node_modules) байт-в-байт == `git show a7a8c463:backend/<path>`, 0 расхождений, 0 отсутствующих |
| Проvenance образа | **да** | OCI-labels `revision=a7a8c463…`, `source=github.com/Animastor/animastor-backend`, `version=deploy-a7a8c463` + вшитый SLSA v0.2 attestation (BuildKit) |
| Публикация в существующий registry `ghcr.io/animastor/animastor-backend` | **да** (локальным push) | теги `deploy-a7a8c463` и `a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad` → digest `sha256:e1fac1d2…`; прежние 3 тега не тронуты |
| Штатный CI (workflow) — build+smoke | **PASS в CI** | раны `38263584766`, `38264006823`, `38264467493`: checkout/verify/build/smoke/login — success |
| Штатный CI — push тегов | **FAIL (блокер B3)** | `denied: permission_denied: write_package` → публикация выполнена локально |
| Изолированный smoke (без prod PG/Redis) | **PASS** | `/health` 200 `{ok,loop:true,redis:PONG}`, 0 crash-сигнатур, контейнер жив |
| Production не трогать | **да** | `BACKEND_IMAGE`/`GPU_HUB_IMAGE`/`.env`/lock-файлы/health — без изменений (§8) |

Отчёт-закрытие блокера **B1 из этапа 40** («нет backend-образа из a7a8c463») —
артефакт создан. Само **переключение backend-сервиса на новый образ — этап 42**
и требует явного решения владельца (не выполнялось).

---

## 1. Контекст и ограничения

Прочитаны: `40-production-rollout-report.md` (блокер B1), `39-g3-d4-publish-report.md`,
`21-production-cutover-runbook.md`.

Жёсткие ограничения этапа: не менять `deploy/.env`, compose-mounts, lock-файлы;
не переключать production; не пересоздавать рабочие контейнеры; не трогать
PG/Redis/TLS/DNS; без force-push; без удаления старых образов/тегов.

Проверено до работы:
- Рабочий worktree `/home/animastor/animastor-backend` — HEAD `a7a8c463`
  (L2-lock verify требует `HEAD == pinned` → **worktree не двигали**, работали
  в отдельном clone `/tmp/be41-wt`).
- Remote: `github` = публичный `git@github.com:Animastor/animastor-backend.git`;
  `origin` = локальный bare `/home/animastor/repos/animastor-backend.git`
  (отстаёт на `a7a8c463`; **G8 (bare-pool) не давался**, в bare не пушим).
- Backend CI до этапа отсутствовал (`total_count 0`), `gh` CLI отсутствует,
  создать секреты/настройки пакета через API без токена — нельзя.

---

## 2. Preflight

- `git show a7a8c463:backend/Dockerfile` == рабочему дереву (sha256
  `4ecb2dd7…`) — штатный Dockerfile: `FROM node:20-bookworm`, apt `ffmpeg`,
  `npm install --omit=dev --ignore-scripts`, `COPY . .`, `CMD node src/backend.cjs`.
- `git show a7a8c463:backend/package.json` версия `0.1.0`, зависимости
  `@animastor/installer ^0.1.1` (именно этот бамп делает коммит `a7a8c463`).
- Registry GHCR: теги `deploy-0c55b5a7`, `rollback-e14d6220`, `deploy-e233d64d`;
  **тег `deploy-a7a8c463` свободен** — конвенция `deploy-<short-sha>` + full-sha
  соблюдена, перезаписи нет.
- Текущий прод-образ `e8152778` собран из mono@`e233d64d` (image package.json
  sha `57954894…` == mono, ≠ `19c0577b…` у a7a8c463) — подтверждено ранее и
  повторно на этом этапе: **прод действительно не из a7a8c463**.
- Замечание: в backend-repo **нет** `backend/.dockerignore` (он есть только в
  mono, добавлен монокоммитом `0c55b5a7`) → собираемый контекст включает
  `tests/`, `.mocharc.json`, `test_cover.js`. Оставлено как есть (минимальные
  изменения), задокументировано в §7 follow-up.

---

## 3. Сборка

Контекст: чистая копия дерева из git (работа из `/tmp/build41/backend`,
созданного через `git archive a7a8c463 backend` — ни один файл из рабочего
worktree/локальных настроек в образ не попадает).

```
docker build --label org.opencontainers.image.revision=a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad \
  --label org.opencontainers.image.source=https://github.com/Animastor/animastor-backend \
  --label org.opencontainers.image.version=deploy-a7a8c463 \
  -t ghcr.io/animastor/animastor-backend:deploy-a7a8c463 \
  -t ghcr.io/animastor/animastor-backend:a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad \
  backend/
```

- Без build-args и секретов; зависимости — только из `registry.npmjs.org`
  (включая scoped `@animastor/*` из package-lock).
- Результат: OCI index `sha256:e1fac1d2…` (image manifest
  `sha256:ccd49d7f…` linux/amd64 + attestation manifest `sha256:82d7d5e6…`,
  BuildKit provenance; локальный контейнерный store pushнул index целиком).
- Сборка локально ~3 с на кэше (первичная пробная сборка из того же контекста —
  1m31s, exit 0).

---

## 4. Изолированный smoke (локальный, до публикации и после pull-by-digest)

Схема: сеть `be41smoke` (docker-bridge), контейнер `redis` **c алиасом `redis`**
(backend жёстко хостит `new Redis({host:'redis',port:6379})`, `backend.cjs:286`),
PG отсутствует, без volume/mount на prod-данные, без внешних портов.

Результат (одинаков для локального тега и для `pull` по digest из registry):

| Проверка | Факт |
|---|---|
| `GET /health` | **200** `{"status":"ok","loop":true,"redis":"PONG","ts":…}` |
| crash-сигнатуры (`FATAL\|uncaught`) | **0** |
| `non-fatal` строки PG | **2** (ожидаемо: нет PG; в prod их нет) |
| Версии | backend `0.1.0`; installed `@animastor/installer` **0.1.1** |
| Жизнеспособность | контейнер `Up`, runtime loop жив после проверок |
| Изоляция | сеть только `be41smoke`; prod-контейнеры не участвуют |

В CI та же изолированная проверка выполняется шагом «Isolated smoke» и прошла
во всех ранах, кроме первого (там упала первая версия assert-скрипта — см. §5).

---

## 5. Штатный CI (workflow) — что добавили и что показали раны

Добавлен `.github/workflows/backend-ghcr-release.yml` (всего 4 коммита в
`github:main`; **локальный `main` не двигался** — push шёл из detached-clone):

| Коммит | Содержание |
|---|---|
| `9a11b6c` | workflow: `workflow_dispatch` (inputs commit/image_tag) + push-триггер; env `APPROVED_COMMIT`/`APPROVED_TAG`; шаги checkout@ref → fail-closed verify HEAD == commit → build (OCI labels) → изолированный smoke + sha-сверка содержимого vs git → login `github.token` → push 2 тегов → digest в summary |
| `8c6c773` | фикс smoke-assert: `grep -cE 'FATAL\|[Uu]ncaught' \|\| true` (в CI нет PG → 2 строки `non-fatal` не должны валить ран) + проверка «container still running» |
| `9ddcdbf` | `::error::`-диагностика отказа push |
| `4e9b7cc` | схлопывание многострочного вывода docker push в одну annotation-строку |

Результаты ранов:

| Run | Коммит | Итог | Детали |
|---|---|---|---|
| `38263007075` | `9a11b6c` | failure | smoke-assert глючил на строках `non-fatal` (баг фикс-а, не образа) |
| `38263584766` | `8c6c773` | failure | build **PASS**, smoke **PASS**, login PASS, **push FAIL** |
| `38264006823` | `9ddcdbf` | failure | то же; annotation обрезана на первом переносе строки |
| `38264467493` | `4e9b7cc` | failure | build+smoke PASS; в annotation получена полная ошибка push |

Полный текст отказа (annotation рана `38264467493`):

```
push deploy-a7a8c463 failed: The push refers to repository [ghcr.io/animastor/animastor-backend]
… Preparing/Waiting … denied: permission_denied: write_package
```

То есть CI **собирает и проверяет образ корректно**, но `GITHUB_TOKEN` не имеет
права записи в существующий org-пакет `animastor/animastor-backend`
(см. §7, блокер B3). Частичных/наполовину залитых тегов раны не оставили —
проверено: до нашей локальной публикации в registry было ровно 3 прежних тега.

---

## 6. Публикация и верификация опубликованного образа

Публикация выполнена локальным `docker push` (исторически это и был штатный путь
публикации `deploy-*` для backend; учётка docker-конфига уже имеет ghcr-доступ),
теми же двумя тегами:

```
deploy-a7a8c463                              → sha256:e1fac1d29f7acd9477080e4608be4670ba172d686e0e061fbbf84c322382def4
a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad     → sha256:e1fac1d29f7acd9477080e4608be4670ba172d686e0e061fbbf84c322382def4
```

Registry после публикации: `deploy-0c55b5a7`, `rollback-e14d6220`,
`deploy-e233d64d`, **`deploy-a7a8c463`**, **`a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad`**
(5 тегов; прежние не перезаписаны).

Верификация (всё по pull-by-digest `ghcr.io/animastor/animastor-backend@sha256:e1fac1d2…`):

| Проверка | Факт |
|---|---|
| `docker pull` по digest | OK, тот же digest |
| OCI-labels | `revision=a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad`, `source=https://github.com/Animastor/animastor-backend`, `version=deploy-a7a8c463` |
| Содержимое vs git | **424/424 файла** (всё под `/app` без node_modules) sha256-совпадают с `git show a7a8c463:backend/<path>`; ни одного файла из git не отсутствует в образе |
| Provenance (вшит) | SLSA v0.2, `buildType=mobyproject.org/buildkit@v1`, entryPoint `Dockerfile`, materials: `node@20-bookworm` digest `8f693eaa…`, `buildStartedOn 2026-10-12T14:39:04Z`, invocation id `er4y2v2fy4d83y1d76tc0dze5` |
| Smoke из registry-образа | PASS (§4) |
| Версия backend | `0.1.0`, installer **0.1.1** (бамп коммита a7a8c463) |

Примечание по provenance: buildType/materials подтверждают сборку из
`node:20-bookworm` по `Dockerfile`; URI git-источника в materials нет (контекст —
локальная директория из git-archive), поэтому ревизия подтверждается
(а) OCI-label `revision`, (б) побайтовой сверкой 424 файлов с
`git a7a8c463:backend`, (в) fail-closed verify шагом CI.

---

## 7. Блокеры и follow-up

**B3 (блокер CI-publish, требует владельца):** `GITHUB_TOKEN` ранов не может
записать в существующий GHCR-пакет `animastor/animastor-backend` —
`denied: permission_denied: write_package`. Пакет создан не через Actions
(ранние `deploy-*` публиковались вручную), и его права/линковка настроены не на
запись для токена репозитория. Варианты фикса (любой достаточен):

1. В настройках пакета GHCR (или org-настройках Packages) разрешить
   `Actions: Read and write` для репозитория `Animastor/animastor-backend`;
   и/или связать пакет с репозиторием (link repository).
2. Создать секрет репозитория `GHCR_IMAGE_PAT` (PAT с `write:packages`) и в
   workflow использовать его для login — **ровно так устроен рабочий
   gpu-hub** (`.github/workflows/ghcr-release.yml`, `secrets.GHCR_IMAGE_PAT`).
   Этап 41 не мог создать секрет: нет `gh`-CLI и нет API-токена — действия
   владельца.

Workflow оставлен в репозитории в рабочем виде: build+smoke уже PASS; после
одного из фиксов выше push заработает без изменений в шагах сборки.

Прочие замечания (не блокируют, задокументированы):
- В backend-repo нет `backend/.dockerignore` (есть только в mono) → в образ
  попадают `tests/`, `.mocharc.json`, `test_cover.js`. В проде `/app/tests` и
  `/app/ai` перекрываются bind-mount'ами. Follow-up: перенести
  `.dockerignore` в backend-repo (или добавить в Dockerfile-историю) и
  пересобрать тег при следующем деплое.
- Без PG в изолированном smoke логируются ровно 2 строки `(non-fatal)` —
  smoke-assert это уже учитывает.
- Bare-remote `origin` отстаёт (остался на `a7a8c463`) — сознательно, чтобы не
  нарушать L2-pin-проверки; sync bare = отдельная задача владельца.

---

## 8. Production: без изменений (STD-check в конце этапа)

| Проверка | Было (baseline этапа 41) | Стало |
|---|---|---|
| `BACKEND_IMAGE` в `deploy/.env` | `…@sha256:e8152778…` | **тот же** `e8152778e1f00d09…` |
| `GPU_HUB_IMAGE` | `…@sha256:3611c644…` | **тот же** |
| sha256 `deploy/.env` | `87ea6f42…` | **тот же** |
| lock L1 `packages/animastor-gpu-hub/artifacts.lock.json` | `069b62d9…` | **тот же** |
| lock L2 `animastor-gpu-hub/artifacts.lock.json` | `9b9dd09b…` | **тот же** |
| `https://animastor.org/health` / `gpu/health` | 200 / 200 | **200 / 200** |
| корневая страница (sha256) | `a1900f4e…` | **тот же** |
| контейнеры | backend/proxy Up 3h, pg/redis healthy 6w | **без пересозданий**, uptime тот же |
| PG `generation_tasks` / redis | 17 / PONG | **17 / PONG** |
| диск | ~34.9 ГБ свободно | ~33.3 ГБ свободно (68%; расход — скачивание base-слоёв при сборке) |

Новых/пересозданных prod-контейнеров нет, prod-сеть не трогалась, smoke
выполнялся только в изолированной сети. Изменений в git-статусах рабочих
worktree'ев не появилось (backend по-прежнему `a7a8c463`; только ранее
известные незакоммиченные `deploy/`, `freebuff-…md`).

---

## 9. Что дальше (не выполнялось на этапе 41)

1. **Этап 42 — решение владельца:** переключать ли `animastor-backend` на
   `ghcr.io/animastor/animastor-backend@sha256:e1fac1d2…` (требует явного
   согласия; инструкция и rollback-пины — `40-production-rollout-report.md`).
2. Фикс B3 в GitHub (пакет-права или секрет `GHCR_IMAGE_PAT`) — после этого
   CI будет сам публиковать `deploy-<short-sha>` + full-sha теги.
3. Follow-up: `.dockerignore` в backend-repo; sync bare-remote.

**Итог этапа 41: PARTIAL** (образ собран, доказан и опубликован; переключение
production не входило в этап; штатный CI-push заблокирован правами пакета —
фиксы требуют действий владельца).
