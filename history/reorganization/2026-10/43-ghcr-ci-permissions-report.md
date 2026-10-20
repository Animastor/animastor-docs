# Этап 43 — Исправление публикации backend-образов через GitHub Actions (блокер B3)

**Дата:** 2026-10-13 (окно ~03:40–04:05 UTC)
**Итог: PASS** — причина отказа публикации подтверждена и устранена минимальной
правкой workflow + созданием репозиторного секрета `GHCR_IMAGE_PAT` (тот же
шаблон, что у рабочего gpu-hub). Первый в истории **полностью штатный
CI-прогон** backend-пайплайна: сборка → изолированный smoke → login → **push в
GHCR прошёл** (ран `38343763018`, все шаги success). Опубликован и верифицирован
новый **уникальный** образ `deploy-e9d6566` → digest
`sha256:e147fa25…` (OCI revision = исходный коммит `e9d6566…`, содержимое
424/424 файлов байт-в-байт == git). Существующие образы/теги **не
перезаписаны**, production **не тронут** (всё по baseline этапа 42).

---

## 0. Краткая сводка

| Цель этапа | Статус | Факт |
|---|---|---|
| Изучить отчёты 41/42 и workflow | **да** | B3 из §7 отчёта 41: `denied: permission_denied: write_package` при push `GITHUB_TOKEN` |
| Диагноз причины отказа | **да** | пакет GHCR создан ручным push (2026-10-10), не Actions → без Actions-read/write для репо; в репо не было ни секрета, ни PAT-подстановки (§2) |
| Самый простой безопасный фикс | **да** | шаблон gpu-hub: секрет `GHCR_IMAGE_PAT` + login через него с fallback на `GITHUB_TOKEN` (§3) |
| Секрет | **создан** | `PUT …/actions/secrets/GHCR_IMAGE_PAT` → **201**; значение — существующий PAT `animastor-main` (`repo, write:packages`), sealed-box через публичный ключ репо; **значение нигде не выводилось** |
| Минимальная правка workflow | **да** | 1 коммит `e9d6566` (только `.github/workflows/backend-ghcr-release.yml`); verify/build/smoke/digest-шаги сохранены (§3.2) |
| Проверка на новом уникальном commit/tag | **да** | коммит `e9d6566…`, тег `deploy-e9d6566`; ран `38343763018` **success**, все 9 шагов зелёные |
| Публикация из CI | **PASS** | `push` шаг success ×2 тега; ранее 4 рана подряд падали на этом шаге |
| Опубликованный digest доступен из GHCR | **да** | `pull` по тегу и по `@sha256:e147fa25…` exit 0 |
| OCI revision == source commit | **да** | label `revision=e9d6566afa262b2b0de39609663c0f0046284c0b` |
| Smoke | **PASS** | CI: встроенная изолированная проверка; локально повторён: `/health` 200 `{ok,loop,redis:PONG}`, 0 crash-сигнатур, контейнер жив |
| Без перезаписи образов | **да** | все 5 прежних тегов указывают на **прежние** digest'ы; добавлены только 2 новых тега; `:latest` не появился; в workflow добавлен fail-closed guard «отказ пush если тег уже существует» (§3.2, §6) |
| Production не переключать | **да** | `BACKEND_IMAGE`=…`e1fac1d2…` (тот же), `.env` sha `21e3248c…`, контейнеры не пересоздавались, health 200/200 (§7) |
| Ручной шаг владельца | **не требуется** (блокер B3 закрыт) | опциональная гигиена в §8 — не блокирует |

---

## 1. Контекст

Прочитаны: `41-backend-image-build-report.md` (блокер B3, §5–§7),
`42-backend-production-rollout-report.md` (production на `e1fac1d2…`).

Напоминание B3 (этап 41): CI собирал и прогонял smoke успешно, но шаг push
падал:

```
push deploy-a7a8c463 failed: … denied: permission_denied: write_package
```

Тогда публикация была сделана локальным `docker push` (учётка docker-конфига
имеет ghcr-доступ), production переключён (этап 42) на digest
`sha256:e1fac1d2…`. Этап 43 закрывает именно CI-половину.

Worktree `/home/animastor/animastor-backend` — HEAD `a7a8c463` **не двигался**
(L2-pin); работа велась в отдельном clone `/tmp/be43-wt` (паттерн этапа 41).
Bare-remote `origin` по-прежнему не синхронизировался (G8 — вне задачи).

## 2. Диагноз (почему публикация из CI падала)

Проверки через GitHub REST API токеном из `~/.docker/config.json`
(логин `animastor-main`; **значение не выводилось**; `X-OAuth-Scopes:
repo, write:packages` — тот самый токен, которым локально публиковались
`deploy-*`-теги, включая `deploy-a7a8c463` на этапе 41):

| Проверка | Результат |
|---|---|
| Кто владелец пакета | org-пакет `Animastor/animastor-backend`, создан **2026-10-10T12:41Z** — первой ручной публикацией (`deploy-0c55b5a7`), т.е. **не** через Actions |
| Права токена | `animastor-main` — **org admin** + **admin** репозитория `Animastor/animastor-backend` |
| Секреты backend-репо | **не было ни одного** (`GET …/actions/secrets` → `[]`) |
| Секреты gpu-hub-репо | `['GHCR_IMAGE_PAT']` — рабочий шаблон организации |
| Программная линковка пакет↔репо / collaborators через REST | endpoints вернули **404** (для org container-пакетов эти пути недоступны даже админу) → «починить GITHUB_TOKEN через API» нельзя; это web-UI пакета (шаг владельца, §8) |

**Вывод (причина отказа).** `GITHUB_TOKEN` ранов не имеет права записи в
существующий org-пакет `animastor/animastor-backend`, потому что пакет
создавался вне Actions и никогда не был связан с репозиторием/не получал
грант «Actions: read and write». Это ровно тот класс проблемы, который в
gpu-hub обходится секретом `GHCR_IMAGE_PAT`. Никаких проблем с самой сборкой
или smoke нет (4 успешных по этим шагам шага в ранах этапа 41).

## 3. Исправление (минимальное)

### 3.1 Секрет репозитория `GHCR_IMAGE_PAT` (создан, значение не раскрывалось)

- Подходящий токен **уже существовал** локально (docker-конфиг, `ghp_…`,
  scopes `repo, write:packages`, пользователь `animastor-main` — тот же класс
  токена, что в gpu-hub). Новый токен **не создавался** и никуда не передавался
  в открытом виде.
- `GET …/secrets/public-key` → sealed-box (PyNaCl) →
  `PUT /repos/Animastor/animastor-backend/actions/secrets/GHCR_IMAGE_PAT` →
  **201 Created** (2026-10-13T03:44:58Z). Значение секрета нигде не логировалось
  и не печаталось; операции шли только через API-клиент в памяти.
- Проверка после создания: `GET …/secrets` → `['GHCR_IMAGE_PAT']`.

### 3.2 Workflow — коммит `e9d6566` (`github:main`)

Единственный изменённый файл: `.github/workflows/backend-ghcr-release.yml`
(+53/−25). Что изменено и почему — **минимально**, verify/build/smoke/digest
сохранены:

| Правка | Было | Стало | Зачем |
|---|---|---|---|
| Login GHCR | `password: ${{ github.token }}` | `password: ${{ secrets.GHCR_IMAGE_PAT \|\| github.token }}` | фикс B3 тем же паттерном, что gpu-hub; fallback на `GITHUB_TOKEN` — наименьшие привилегии, если владелец позже настроит package-права и уберёт секрет |
| Триггеры | `workflow_dispatch` + `push` (paths: сам workflow) | **только `workflow_dispatch`** | push-триггер при публикации фикса сам бы пересобрал и **пере-поинтил** `deploy-a7a8c463` (overwrite); публикация теперь всегда явное действие оператора с уникальной парой commit+tag (как у gpu-hub) |
| Дефолты inputs | `a7a8c463…` / `deploy-a7a8c463` | убраны (inputs обязательны) | диспатч «по умолчанию» больше не может нацелиться в существующий тег |
| Guard перед push | нет | `docker manifest inspect` каждого целевого тега; **exists → fail** | теги иммутабельны: «никогда не пере-поинтовать существующий тег» зашито в сам workflow |
| Verify source commit | HEAD == inputs.commit (или APPROVED_COMMIT) | то же **+** `backend/` обязан быть байт-в-байт == `backend/` коммита `APPROVED_COMMIT` (`a7a8c463…`); `fetch-depth: 10` | смысл fail-closed гейта сохранён при сборке «более нового» коммита: правки только в `.github/` проходят, любое изменение `backend/` требует owner-апрува пина |
| env | `APPROVED_COMMIT` + `APPROVED_TAG` | только `APPROVED_COMMIT` (пин утверждённого backend-исходника) | `APROVED_TAG` использовался только удалённым push-триггером |

Не менялось: `permissions: contents: read, packages: write` (уже минимальные),
шаги build (OCI labels), изолированного smoke (redis-алиас, non-fatal PG
учтён), teardown, record digest.

Коммит запушен `git push origin HEAD:main` из `/tmp/be43-wt`
(`4e9b7cc → e9d6566`); локальный worktree-`main` не двиган; force-push и
удаление тегов/образов не выполнялись. Важно: push **не создал** ни одного
CI-рана (см. §4) — снятие push-триггера подтверждено фактически (total runs
остался 5).

## 4. CI-прогон (уникальный commit + tag)

Диспатч через API: `commit=e9d6566afa262b2b0de39609663c0f0046284c0b`,
`image_tag=deploy-e9d6566` → **204**.

| Ran | `38343763018` (event `workflow_dispatch`) |
|---|---|
| head_sha | `e9d6566afa262b2b0de39609663c0f0046284c0b` |
| Окно | 2026-10-13T03:52:40Z → 03:54:12Z (~92 с) |
| Итог | **success** (первый зелёный push в истории пайплайна) |
| Шаги | checkout ✓, Verify source commit ✓ (вкл. гейт `backend/ == a7a8c463`), Build ✓, Isolated smoke ✓, Teardown ✓, Log in to GHCR ✓ (PAT), **Push immutable tags ✓ (оба тега; guard подтвердил «tag not present»)**, Record digest ✓ |

Для сравнения: предыдущие 4 рана (`9a11b6c…4e9b7cc`, этап 41) — failure на
шаге push/smoke-скрипта; в шаге build/smoke они были зелёные.

## 5. Верификация опубликованного образа

```
deploy-e9d6566                          → sha256:e147fa2537c2bd0edddc2edb4149c6127fe67ffbe7602065dff69e44e76c7f49
e9d6566afa262b2b0de39609663c0f0046284c0b → sha256:e147fa2537c2bd0edddc2edb4149c6127fe67ffbe7602065dff69e44e76c7f49
```

| Проверка | Факт |
|---|---|
| `docker pull` по тегу и по полному digest из GHCR | OK, тот же digest `e147fa25…` |
| OCI-labels | `revision=e9d6566afa262b2b0de39609663c0f0046284c0b` (= source commit), `version=deploy-e9d6566`, `source=github.com/Animastor/animastor-backend` |
| Содержимое vs git | **424/424** файлов `/app` (без node_modules) sha256 == `git show e9d6566:backend/…`; 0 расхождений, 0 отсутствующих |
| `backend/` == утверждённый исходник | `git diff a7a8c463 e9d6566 -- backend/` — **пусто** (единственная разница коммитов `a7a8c463…e9d6566` — сам workflow-файл) |
| Smoke (CI) | PASS (шаг workflow) |
| Smoke (локально, изолированная сеть `be43smoke`, redis-алиас, без PG, без prod-портов) | **PASS**: `/health` 200 `{"status":"ok","loop":true,"redis":"PONG"}`, crash-сигнатур 0, контейнер жив; версии backend `0.1.0`, installer `0.1.1` |
| `:latest` | **не создавался** |

## 6. Доказательство «ничего не перезаписано»

Все прежние теги указывают на **прежние** digest'ы (сверено
`imagetools inspect` до/после):

| Тег | Digest | Статус |
|---|---|---|
| `deploy-0c55b5a7` | `sha256:be82793a…` | не тронут |
| `rollback-e14d6220` | `sha256:e14d6220…` | не тронут |
| `deploy-e233d64d` | `sha256:e8152778…` (rollback-пин prod) | не тронут |
| `deploy-a7a8c463` | `sha256:e1fac1d2…` (**prod-образ**) | не тронут |
| `a7a8c4639ed40fbc…` | `sha256:e1fac1d2…` | не тронут |
| **`deploy-e9d6566`** | **`sha256:e147fa25…`** | **новый** |
| **`e9d6566afa262b2b…`** | **`sha256:e147fa25…`** | **новый** |

В пакете 9 версий (было 8): +1 новая версия с двумя новыми тегами; 4
untagged-версии — pre-existing хвост ручных/локальных push-ов, не трогались.
Удаление образов/тегов не выполнялось; force-push не было.

## 7. Production: без изменений (STD-check до и после)

| Проверка | Baseline (этап 42 → старт 43) | После 43 |
|---|---|---|
| `BACKEND_IMAGE` | `…@sha256:e1fac1d2…` | **тот же** `e1fac1d2…` |
| `GPU_HUB_IMAGE` | `…@sha256:3611c644…` | **тот же** |
| sha256 `deploy/.env` | `21e3248c…` | **тот же** |
| `animastor-backend` | `91fc2fad…`, Up 13 h | **не пересоздан** |
| `gpu-hub` / `proxy` | `b771d050…` / `09cb6688…` | **не пересозданы** |
| `pg` / `redis` | `49202ac1…` / `fd01e09a…`, 7 нед. healthy | **не пересозданы** |
| `https://animastor.org/health` / `gpu/health` | 200 / 200 | **200 / 200** |
| backend health (interior) | `{ok, loop:true, redis:PONG}` | **тот же** |
| PG `generation_tasks` | 17 | **17** |
| L1 lock (mono `packages/animastor-gpu-hub/…`) | `069b62d9…` | **тот же** |
| L2 lock (`animastor-gpu-hub/…`) | `9b9dd09b…` | **тот же** |
| git worktree backend | HEAD `a7a8c463` + baseline `?? deploy/`, `?? freebuff-…` | **тот же** |
| диск | ~33.3 ГБ | ~32.4 ГБ свободно (расход — pull нового образа для верификации) |

Не выполнялось: смена `deploy/.env`, compose/overlays, locks, TLS, DNS, PG,
Redis, GPU Hub; пересоздание/рестарт контейнеров; prune; удаление образов;
E2E-dispatch. Секреты в отчёт не выгружались.

## 8. Follow-up для владельца (не блокирует; пайплайн уже работает)

1. **Опциональная гигиена package-прав** (web-UI, нельзя через REST — §2):
   в настройках пакета `Animastor/animastor-backend` связать репозиторий
   `Animastor/animastor-backend` и/или выдать ему «Actions: Read and write».
   После этого секрет `GHCR_IMAGE_PAT` из репо можно удалить — workflow сам
   упадёт на fallback `github.token` (безопасно, guard и verify не меняются).
2. **Опциональная гигиена PAT**: текущий `GHCR_IMAGE_PAT` — classic PAT со
   scopes `repo, write:packages` (шире необходимого; так же у gpu-hub).
   Можно заменить в обоих репо на fine-grained PAT, ограниченный только
   Packages: write на org `Animastor` (без `repo`). Замена — правка значения
   секрета, workflow не меняется.
3. Следующий релиз backend: диспатч workflow с commit'ом, содержащим
   **owner-утверждлённый** бамп `APPROVED_COMMIT` (если `backend/` менялся) и
   новым тегом `deploy-<short-sha>` (guard не даст переиспользовать тег).

## 9. Фактические значения (для следующих окон)

| Что | Значение |
|---|---|
| workflow-fix коммит | `e9d6566afa262b2b0de39609663c0f0046284c0b` (github:main; локальный main worktree не двиган) |
| CI-ран | `38343763018` — success, dispatch, ~92 с |
| Новый образ | `ghcr.io/animastor/animastor-backend:deploy-e9d6566` → `sha256:e147fa2537c2bd0edddc2edb4149c6127fe67ffbe7602065dff69e44e76c7f49` (revision `e9d6566…`, content 424/424 == git) |
| prod-образ (не менялся) | `…@sha256:e1fac1d29f7acd9477080e4608be4670ba172d686e0e061fbbf84c322382def4` (tags `deploy-a7a8c463`, full-sha) |
| rollback-пин prod (не менялся) | `…@sha256:e8152778…` (tag `deploy-e233d64d`) |
| Секрет | `GHCR_IMAGE_PAT` в `Animastor/animastor-backend` (создан 2026-10-13T03:44:58Z; значение — существующий PAT `animastor-main`, не раскрывалось) |
| `deploy/.env` | `21e3248c…` (без изменений) |
| L1 / L2 lock | `069b62d9…` / `9b9dd09b…` (без изменений) |

## 10. Резюме для чата

**PASS.** B3 закрыт: причина — `GITHUB_TOKEN` не имел прав записи в
существующий org-пакет GHCR (создан ручным push, без Actions-гранта), и в
backend-репо отсутствовал PAT-секрет, которым работает gpu-hub. Создан секрет
`GHCR_IMAGE_PAT` (существующий токен `animastor-main`, значение не
раскрывалось) и минимально исправлен workflow (коммит `e9d6566`): login через
секрет с fallback на `GITHUB_TOKEN`, только `workflow_dispatch`, guard от
перезаписи тегов, гейт `backend/ == a7a8c463`; сборка/smoke/verify/digest
сохранены. Первый штатный CI-прогон `38343763018` — **success**, публикация
из CI прошла: `deploy-e9d6566` → `sha256:e147fa25…` (OCI revision = source
commit, 424/424 файлов == git, smoke локально PASS). Существующие теги и
prod-образ `e1fac1d2…` не тронуты; production не переключался и не
пересоздавался (health 200/200, `.env`/locks без изменений). Ручной шаг
не требуется; опциональная гигиена владельца (линковка пакета и/или
fine-grained PAT) — §8.

Отчёт: `/home/animastor/reorg-2026-10-12/43-ghcr-ci-permissions-report.md`.
