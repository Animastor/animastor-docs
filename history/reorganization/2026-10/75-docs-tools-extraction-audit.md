> **Sanitized copy (Stage 82):** все вхождения пароля заменены на `<пароль>`; оригинал отчёта не изменён и сохранён как доказательство.

# 75 — Read-only аудит: выделение `docs/` и `tools/` в отдельные репозитории

**Дата:** 2026-10-19  
**Режим:** read-only. Ни один рабочий репозиторий не изменён, коммитов и push не выполнено, remotes/ветки не менялись.  
**Целевые репозитории:** `Animastor/animastor-docs`, `Animastor/animastor-tools` — уже созданы владельцем, **public**, пустые (`size=0`, 0 refs), default branch `main`.

## 0. Итог

| Направление | Статус | Причина |
|---|---|---|
| `animastor-docs` | **PASS** (план готов) | История и дерево извлекаются без потерь; по проверенным шаблонам секретов в docs не найдено |
| `animastor-tools` | **BLOCKED** | Пароль Basic Auth в коде и истории; сборка зависит от чужого untracked Gradle; абсолютные пути; неясен состав «общих» инструментов |
| Общий статус | **BLOCKED** | Совместная миграция docs+tools в текущем виде небезопасна; docs можно выполнять отдельно |

Проверочные прогоны `git filter-repo` выполнены **только на временных клонах в `/tmp`**:
- docs: 792 коммита, 297 файлов, 3.81 MiB, дерево побайтно совпадает с источником;
- tools: 6 коммитов, 46 файлов, 39 KiB, дерево совпадает; после `--replace-text` строка `<пароль>` в истории отсутствует (7 замен).

---

## 1. Активные репозитории и их состояние

| Репозиторий | Путь | Ветка / HEAD | GitHub | Worktree |
|---|---|---|---|---|
| animastor-backend | `/home/animastor/animastor-backend` | `main` / `9783963a` | `MATCH` (`9783963a`) | **грязный**: `D backend/scripts/audit-orphan-books.js`; `M` 4 теста; `?? deploy/`, `?? freebuff-chat-…md` |
| animastor-web | `/home/animastor/animastor-web` | `main` / `fbc93662` | `MATCH` | clean |
| animastor-android | `/home/animastor/animastor-android` | `main` / `92a56c0d` | `MATCH` | clean |
| animastor-worker | `/home/animastor/animastor-worker` | `main` / `b3f94f42` | `MATCH` | clean |
| animastor-gpu-hub | `/home/animastor/animastor-gpu-hub` | `master` / `0f489c7b` | `MATCH` | clean, **не трогаем** |
| animastor (legacy monorepo) | `/home/animastor/animastor` | `c21.4-physically-extract-analysis-from-backend` / `465453df` | **GitHub remote отсутствует**; `origin` = `/home/animastor/repos/animastor.git` | `M frontends/website/index.html`; `?? docker/compose/overlay-backend-standalone.yml` |

Remotes: у backend/web/android/worker есть `origin` (локальный bare в `/home/animastor/repos/*.git`) и `github` (`git@github.com:Animastor/*.git`). У monorepo — только локальный `origin`.

Важно: `c21.4` — **не main**. Ветка на 36 коммитов впереди `master`, позади 0 (merge-base `64127b9e`). Это фактический источник документации (см. §2.3).

---

## 2. Документация (`docs/`)

### 2.1 Где лежит и кому принадлежит

`docs/` физически существует в четырёх репозиториях и во всех отслеживается Git:

| Репозиторий | Файлов | Коммитов, меняющих docs | Последний docs-коммит | Роль |
|---|---:|---:|---|---|
| `animastor` (mono) | **297** | **792** | `a9d71d81` 2026-10-08 | **канонический superset** |
| `animastor-backend` | 288 | 764 | `f84f43e` 2026-10-11 (только смена домена) | исторический архив/портал; отстаёт |
| `animastor-web` | 31 | 109 | `d197b24` 2026-09-15 | подмножество (05/08/09 + web-architecture) |
| `animastor-worker` | 16 | 20 | `792e1fd` 2026-09-07 | подмножество (worker architecture) |

Объединение путей по всем репозиториям = **297**; backend ⊂ mono, web ⊂ mono, worker ⊂ mono.

### 2.2 Структура и назначение

| Раздел | Файлов | Назначение |
|---|---:|---|
| `01-overview/` | 5 | Архитектура, system map, data flow, структура проекта |
| `02-orchestration/` | 9 | Оркестрация, аудио/видео sync, stabilization |
| `03-audit/` | 26 | Архитектурные и runtime-аудиты, forensic-отчёты |
| `04-planning/` | 26 | Roadmap, installer, LLM sharing, worker sharing |
| `05-frontend/` | 11 | Player state machine, editor, seek, video loading |
| `06-workflows/` | 7 | Workflow/connector architecture, scene pipeline |
| `07-agents-and-generators/` | 15 | Агенты, генераторы, prompt-профили, TTS |
| `08-mobile-web-migration/` | 9 | Миграция Android → mobile web |
| `09-desktop-migration/` | 3 | Desktop web tester/migration |
| `99-archive/` | 25 | Завершённые/устаревшие документы |
| `architecture/` | **135** | Основной массив: extraction-аудиты, контракты, split-отчёты |
| `runtime-audits/` | 9 | Аудиты audio/image/video runtime |
| корень | 17 | `README`, `CHANGELOG`, `VISION`, `DONT_DO`, `index.html`, `docs-browser.js/css`, parser-аудиты |

Типы: 289 `.md`, 2 `.txt`, 2 `.html` (включая портал), 1 `.js`, 1 `.css`, 2 `.gitkeep`. Все blob-режимы `100644`. Крупнейший файл — `architecture/generation-module-extraction-reconnaissance.md` (380 KB). Общий размер дерева — 7.3 MB; Git-упаковка после фильтра — 3.81 MiB.

### 2.3 Источник истины: monorepo `c21.4`, а не backend

- В mono **297** файлов, в backend — 288.
- 288 общих путей; **6 расходятся по содержимому**, и во всех шести версия mono новее (добавлены актуализации после 2026-10-04):
  - `repository-split-execution-readiness.md`
  - `repository-split-final-readiness.md`
  - `repository-split-next-blockers.md`
  - `repository-split-preparation-plan.md`
  - `repository-split-pre-split-fixes.md`
  - `repository-split-reconnaissance-audit.md`
- **9 документов есть только в mono** (созданы после split):
  - `DOMAIN_MIGRATION_2026-10_IN_TO_ORG.md`
  - `post-split-build-deploy-diagnostic.md`
  - `repository-split-execution-pack.md`
  - `repository-split-final-gate.md`
  - `repository-split-final-verification.md`
  - `repository-split-post-split-audit.md`
  - `repository-split-pre-split-go-blockers.md`
  - `repository-split-r3-decision.md`
  - `repository-split-worker-root-layout-diagnostic.md`
- `animastor-web` (31) и `animastor-worker` (16) **побайтно идентичны** соответствующим файлам mono.

Вывод: извлечение из backend потеряет 9 документов и откатит 6. Извлекать нужно из **mono `c21.4`**, это же дерево сейчас реально отдаётся порталом.

### 2.4 История Git

- 792 коммита, первый — `2026-06-11` (`Recovery01: June 9 working state + dedup`), последний docs-коммит — `2026-10-08`.
- `docs/` — обычный каталог, не submodule, не LFS, symlink'ов нет.
- Один не-ASCII путь: `docs/Animastor_Близкие_горизонты.md` (пробелов нет, только кириллица). Фильтрация его сохраняет.
- В backend история короче (764), в web/worker — фрагментарная (109/20), поэтому отдельное извлечение из них даст неполную историю.

### 2.5 Кто использует `docs/` (вне самого каталога)

**Production / runtime (критично):**

| Место | Что делает | Риск при удалении docs |
|---|---|---|
| `/home/animastor/animastor-backend/deploy/docker-compose.yml:146` | `- /home/animastor/animastor/docs:/usr/share/nginx/docs:ro` | **портал `https://animastor.org/docs/` отдаст 404** |
| `/home/animastor/animastor/docker-compose.yml:152` | `- ./docs:/usr/share/nginx/docs:ro` | rollback-compose сломается |
| `/home/animastor/animastor-backend/docker-compose.yml:149` | `- ./docs:/usr/share/nginx/docs:ro` | standalone/dev compose сломается |
| `proxy/conf/default.conf:196–233` | location `/docs/`, SPA + markdown | менять не нужно, если mount указывает на корень нового repo |
| `docs/index.html`, `docs/docs-browser.js:407` | `fetch('/docs/' + path)` | работает без изменений при mount корня docs-repo в `/usr/share/nginx/docs` |

Портал сейчас живой: `GET https://animastor.org/docs/` → **200 text/html**, `GET /docs/README.md` → **200 text/plain**.

**Ссылки в коде и README:**

- `CONTRIBUTING.md:59` (mono и backend) — относительная ссылка на `docs/01-overview/ARCHITECTURE.md`.
- `README.md` mono/backend (строки ~82, 119–136) — таблица ссылок на docs.
- `animastor-web/README.md:37,70` — дерево и ссылка на `docs/`.
- `animastor-worker/README.md:32,61` — ссылки на `docs/architecture/JOB_PROTOCOL_V2.md`.
- `packages/animastor-{url-safety,auth,player,editor}/README.md|CHANGELOG.md` — абсолютные ссылки на `github.com/Animastor/animastor[-backend]/blob/main/docs/...`.
- `frontends/website/index.html:150,177` (mono и web) — `https://github.com/Animastor/animastor-web/tree/main/docs`.
- Комментарии в коде: ~319 строк в mono, 257 в backend, 55 в web, 4 в android, 2 в worker. Это **не runtime-зависимости**; массово переписывать не рекомендуется.
- Внутри docs: 128 относительных markdown-ссылок; 11 уже сломаны в источнике, ещё 1 сломается при переносе (`08-mobile-web-migration/README.md:48` → `../../README.md`).

**CI/CD, package.json, lock-файлы, Docker COPY:**

- CI: docs/tools не упоминаются. В backend единственный workflow — `backend-ghcr-release.yml` (docs не участвуют).
- `package.json` / lock-файлы: ссылок на docs/tools нет.
- Docker: `backend/.dockerignore:12` исключает `docs/`; в образ docs не пекутся.
- Nginx монтирует docs только из рабочего дерева на VPS; отдельного deploy-пайплайна нет.

### 2.6 Способ переноса с сохранением истории

Проверено на клоне в `/tmp` (не на рабочем репозитории):

```bash
git clone --no-local --single-branch \
  --branch c21.4-physically-extract-analysis-from-backend \
  /home/animastor/animastor /tmp/animastor-docs
cd /tmp/animastor-docs
git filter-repo --path docs/ --path-rename docs/:
```

Результат dry-run:

```
commits=792  files=297  size=3.81 MiB
HEAD=dc0ea1b 2026-10-08 docs(domain): record GitHub repo consistency check…
first=f31add9 2026-06-11 Recovery01: June 9 working state + dedup
diff -r /tmp/animastor-docs /home/animastor/animastor/docs  → 0 отличий
```

После фильтра: ветка называется `c21.4-…`; перед push переименовать в `main`. `filter-repo` удаляет `origin`, поэтому remote добавляется заново.

Дополнительно в новый repo до первого push:
1. Добавить `LICENSE` (MIT, из корня mono) — сейчас в docs его нет.
2. Исправить 1 перенос-индуцированную ссылку `08-mobile-web-migration/README.md:48`: `../../README.md` → `../README.md`.
3. (Опционально) перенести `scripts/translate_docs.py` в `animastor-docs/tools/` — это docs-only утилита без внешних зависимостей.

### 2.7 Необходимые изменения в исходных репозиториях

| Репозиторий | Изменение | Обязательность |
|---|---|---|
| `animastor` | удалить `docs/` (297 файлов) после успешного push/проверки; обновить `docker-compose.yml:152`, `README`, `CONTRIBUTING`, `frontends/website/index.html` | да |
| `animastor-backend` | удалить `docs/` (288); обновить `deploy/docker-compose.yml:146`, `docker-compose.yml:149`, `README`, `CONTRIBUTING`, `.dockerignore` | да |
| `animastor-web` | удалить `docs/` (31); обновить `README`, `frontends/website/index.html:150,177` | да |
| `animastor-worker` | удалить `docs/` (16); обновить `README:32,61` | да |
| `animastor-android` | docs нет; только 4 комментария в коде — оставить как исторические | нет |
| все | code comments с `docs/...` **не переписывать**; добавить в новый repo примечание о путях | рекомендация |

Порядок безопасного cutover:
1. Создать/проверить `animastor-docs`, push.
2. Клонировать на VPS в стабильный путь, например `/home/animastor/animastor-docs`.
3. Переключить bind-mount в `deploy/docker-compose.yml` на новый путь; `docker compose up -d nginx` (только nginx).
4. Проверить `/docs/` и `/docs/README.md`.
5. Только после этого удалять `docs/` из исходных репозиториев и обновлять ссылки.
6. Rollback: вернуть mount на `/home/animastor/animastor/docs` (каталог не удалять до истечения окна отката).

### 2.8 Команды проверки docs

```bash
# до push
cd /tmp/animastor-docs
test "$(git rev-list --count HEAD)" -eq 792
test "$(git ls-files | wc -l)" -eq 297
diff -r --exclude=.git . /home/animastor/animastor/docs
git log --oneline -- README.md | tail -1        # первый docs-коммит
rg -n '<пароль>|sk-or-|ghp_|BEGIN .*PRIVATE KEY' . # ожидается пусто

# после push
git ls-remote git@github.com:Animastor/animastor-docs.git refs/heads/main
# SHA должен совпасть с локальным HEAD

# production
curl -sS -o /dev/null -w '%{http_code}\n' https://animastor.org/docs/
curl -sS -o /dev/null -w '%{http_code}\n' https://animastor.org/docs/README.md
```

### 2.9 Риски docs

1. **Источник — legacy monorepo на не-main ветке.** Если `c21.4` потеряется/перепишется, история docs останется только в новом repo. Нужен backup bare `repos/animastor.git` и тег перед фильтрацией.
2. **Живой портал зависит от рабочего дерева mono.** Удаление docs без переключения mount = 404 на публичном сайте.
3. **Расхождение копий.** После создания docs-repo копии в backend/web/worker станут ещё более устаревшими; их нужно удалить, а не поддерживать.
4. **11+1 битых относительных ссылок.** 11 существуют до миграции, 1 появится при flatten (`../../README.md`).
5. **`docs-browser.js` содержит захардкоженный список из ~152 записей при 289 `.md`.** Портал уже показывает не всё дерево; миграция это не ухудшает, но и не исправляет.
6. **Авторство/даты.** `filter-repo` сохраняет author/committer; хеши коммитов изменятся — это нормально, force-push не требуется (репозиторий пустой).

---

## 3. Инструменты (`tools/` и скрипты)

### 3.1 Полный перечень tool-like артефактов

Классификация: **A** — общий для системы; **B** — обслуживает несколько компонентов; **C** — один компонент.

| # | Инструмент | Путь | Назначение | Класс | Зависимости / связь | Рекомендация |
|---|---|---|---|---|---|---|
| 1 | Desktop Web Tester | `tools/desktop-web-tester` (21 файл) | Android WebView «эмулятор десктопа» для `frontends/app` (1280–1920 px) | **C** (web) | Gradle 8.12, Android SDK, JDK 17, `app.animastor.org`, hardcoded Basic Auth | **оставить в web** (или moves only after fixes) |
| 2 | Mobile Web Tester | `tools/mobile-web-tester` (25 файлов) | Android WebView «телефон» 360/390/430 px для mobile web | **C** (web) | то же | **оставить в web** |
| 3 | Runtime audit | `scripts/animastor-runtime-audit.sh` | read-only диагностика GPU/ComfyUI/worker/backend, redaction секретов | **A** | bash, docker, nvidia-smi, redis-cli, psql; абсолютные пути `/home/animastor/animastor/...`; ссылки на `docs/runtime-audits/` | **кандидат в tools** после параметризации путей |
| 4 | Syntax smoke | `scripts/syntax-smoke.sh` | `node --check` по backend/gpu-hub/worker/packages | **B** | layout monorepo (`backend/src`, `packages/*`) | **кандидат в tools** после параметризации root |
| 5 | Split guards G1–G3 + runner | `scripts/split-guards/*` (4 файла) | registry-only, exports-map, Job Protocol parity | **B** (split-specific) | monorepo layout, `packages/animastor-worker/tools/sync-protocol.cjs`, docker для G4/G5 | **архивировать**; не делать «общим» |
| 6 | Artifact check | `scripts/check-artifacts.sh` | проверка bake-in артефактов GPU Hub | **C** (GPU Hub) | `/app/artifacts`, docker | оставить (GPU Hub не трогаем) |
| 7 | Admin HTTPS | `scripts/enable-admin-https.sh` | certbot + reload nginx для admin/app | **C** (deploy/backend) | `frontends/website`, docker `animastor-proxy` | оставить в backend/deploy |
| 8 | Parser golden fixtures | `scripts/generate-parser-golden-fixtures.js` | генерация golden-фикстур парсера | **C** (backend/parser) | `backend/src/services/structure-detector`, `packages/animastor-vbook-runtime` | оставить в backend |
| 9 | O-3 SCC audit | `scripts/o3-scc-audit.cjs` | require-граф/SCC по `backend/src` | **C** (backend) | backend/src | оставить в backend |
| 10 | Docs language audit | `scripts/translate_docs.py` | отчёт по RU/EN в markdown | **C** (docs) | только stdlib; принимает root-каталог | **перенести в animastor-docs** |
| 11 | Backend audit/import scripts | `backend/scripts/*` (6 tracked, 1 удалён в worktree) | orphan books, scenes, video actions, IU import, reencode | **C** (backend) | backend modules, PG/Redis, ffmpeg | оставить в backend |
| 12 | Worker protocol sync | `packages/animastor-worker/tools/sync-protocol.cjs` | генерация/сверка Job Protocol v2 | **C** (worker) | `@animastor/contracts`, worker/package.json scripts | оставить в worker |
| 13 | GPU Hub tools | `packages/animastor-gpu-hub/tools/*` (4 файла) | G4/G5, fixtures, artifacts lock | **C** (GPU Hub) | docker, hub build | оставить, **не трогать** |

Итого в корневом `tools/`: **46 файлов, 2 Gradle-проекта, 6 коммитов**. Оба — web-only harness'ы, не «общие для системы».

### 3.2 Зависимости и связность web-тестеров

- `*/gradlew` — **не настоящий wrapper**, а shell-shim:
  ```bash
  exec "$(dirname "$0")/../../frontends/android/gradle-8.12/bin/gradle" "$@"
  ```
  В `animastor-web` каталога `frontends/android/` **нет вообще**; в mono `frontends/android/gradle-8.12` есть, но **untracked** (145 MB, 0 файлов в Git). То есть в standalone web repo сборка уже не работает, а в новый tools repo она не переедет.
- `build-apk.sh` (оба) хардкодит:
  - `sdk.dir=/home/sureg/Android/Sdk`;
  - копирование APK в `/home/sureg/net-disk/...`.
  На этом VPS `/home/sureg/Android/Sdk` **отсутствует** (net-disk есть), JDK 17 и Gradle 8.12 — есть.
- Hardcoded Basic Auth в `MainActivity.kt` (desktop — строки 414–416, mobile — 408–410):
  ```kotlin
  private const val AUTH_USER = "admin"
  private const val AUTH_PASS = "<пароль>"
  ```
  Встречается в **HEAD и в истории** (7 hits, коммиты `8e65770` от 2026-08-10 и `39c6f97` от 2026-08-12).
- `README.md` обоих тестеров ссылается на `./tools/<name>/...` — после переноса в корень tools repo пути станут `./<name>/...`.
- Внешние зависимости: только Gradle-плагины (`com.android.application 8.7.3`, Kotlin 1.9.22) из google/mavenCentral; сторонних library-зависимостей нет.
- CI/package.json/docker на `tools/` не ссылаются.

### 3.3 Что рекомендовано для `animastor-tools`

**Переносить (A/B, после параметризации):**
- `animastor-runtime-audit.sh` — общий runtime-диагност; заменить абсолютные пути на `$ANIMASTOR_ROOT`/`$HOME`, ссылки на docs — на URL нового repo.
- `syntax-smoke.sh` — общий multi-repo smoke; parametrize `ROOT_DIR` или принимать список repo-путей.
- (опционально) `split-guards/` — только как **архив** завершённого split; G4/G5 тянут GPU Hub и docker, поэтому в «общий» repo их включать не стоит.

**Оставить на местах (C):**
- `desktop-web-tester`, `mobile-web-tester` → `animastor-web`;
- `backend/scripts/*`, `generate-parser-golden-fixtures.js`, `o3-scc-audit.cjs` → `animastor-backend`;
- `sync-protocol.cjs` → `animastor-worker`;
- `check-artifacts.sh`, `packages/animastor-gpu-hub/tools/*` → GPU Hub (не трогать);
- `enable-admin-https.sh` → deploy/backend.

**Перенести в docs:** `translate_docs.py`.

Если владелец всё же хочет видеть web-тестеры в `animastor-tools`, это отдельная фаза с обязательными исправлениями:
1. `--replace-text` для `<пароль>` + удалить хардкод, вынести креды в `BuildConfig`/gradle property (`AUTH_USER`/`AUTH_PASS` из env, не коммитить).
2. Ротировать Basic Auth пароль и обновить `.htpasswd` (пароль уже был опубликован в public `animastor-web` с 2026-08-10).
3. Заменить `gradlew`-shim на официальный Gradle wrapper (`gradle-wrapper.jar` + `gradle-wrapper.properties`) **или** явно требовать `GRADLE_BIN`; иначе repo несамодостаточен.
4. Заменить `/home/sureg/...` на env (`ANDROID_SDK_ROOT`, `NET_DISK_DIR`) с безопасными значениями по умолчанию.
5. Обновить README-пути и добавить `LICENSE`.

### 3.4 Команды проверки tools (после исправлений)

```bash
cd /tmp/animastor-tools
test "$(git ls-files | wc -l)" -eq 46
git log -p --all | rg '<пароль>'          # ожидается пусто
cd desktop-web-tester
./gradlew --version                     # должен работать без внешнего gradle-8.12
ANDROID_SDK_ROOT=/path/to/sdk ./gradlew assembleDebug
./build-apk.sh                          # проверить NET_DISK_DIR
```

Текущее ограничение: полноценная сборка APK на этом VPS **невозможна** — нет Android SDK. Это limitation проверки, не самой миграции.

---

## 4. Спецификация целевых репозиториев

### 4.1 `Animastor/animastor-docs`

| Параметр | Значение |
|---|---|
| Источник | `/home/animastor/animastor`, ветка `c21.4-physically-extract-analysis-from-backend`, HEAD `465453df` |
| Исходный набор | 297 tracked-файлов `docs/**` (манифест: `75-docs-manifest.txt`, tree `da1f129e`) |
| История | `git filter-repo --path docs/ --path-rename docs/:` → **792 коммита**, первый 2026-06-11 |
| Результат | 297 файлов в корне, 3.81 MiB; дерево идентично источнику |
| Доп. файлы | `LICENSE` (MIT), исправление `08-mobile-web-migration/README.md:48`, опционально `tools/translate_docs.py` |
| Ветка | `main` (после фильтра переименовать из `c21.4-…`) |
| Push | `git push -u origin main` в пустой public repo, **без force** |
| Изменения ссылок | deploy mount, README/CONTRIBUTING/website, package READMEs; код-комментарии не трогать |
| Проверка | 792 коммита / 297 файлов / diff=0; `curl /docs/` 200; SHA local==remote |
| Риски | потеря non-main источника; 404 портала при преждевременном удалении; 11+1 битых ссылок |

### 4.2 `Animastor/animastor-tools`

| Параметр | Значение |
|---|---|
| Источник (текущий `tools/`) | `/home/animastor/animastor-web`, `main` `fbc93662` (идентично mono) |
| Исходный набор | 46 tracked-файлов `tools/**` (манифест: `75-tools-manifest.txt`, tree `27130c12`) |
| История | `git filter-repo --path tools/ --path-rename tools/: [--replace-text]` → **6 коммитов**, 39 KiB |
| Рекомендуемый набор | **не** web-тестеры, а A/B-скрипты; либо web-тестеры только после §3.3 |
| Секреты | `<пароль>` в 7 местах истории; обязателен `--replace-text` + ротация |
| Сборка | сломана: `../../frontends/android/gradle-8.12` отсутствует в web; SDK `/home/sureg/...` отсутствует |
| Ветка | `main` |
| Push | в пустой public repo, **без force** |
| Проверка | 0 hits `<пароль>`; `./gradlew --version`; `assembleDebug` при наличии SDK |
| Риски | публикация пароля; несамодостаточная сборка; ложное ощущение «общего» repo |

---

## 5. Блокеры и решения владельца

1. **BLOCKER (security, tools).** Пароль Basic Auth `admin`/`<пароль>` закоммичен в public `animastor-web` с 2026-08-10 и присутствует в 6-коммитной истории tools. Перед любым push в public `animastor-tools` — `--replace-text`, удаление хардкода, **ротация пароля**. `https://app.animastor.org/` сейчас отдаёт 200 без авторизации, т.е. пароль, вероятно, уже неактивен, но это нужно подтвердить у владельца, а не предполагать.
2. **BLOCKER (build, tools).** `gradlew` ссылается на untracked `frontends/android/gradle-8.12` (145 MB), которого нет в web repo. Без официального wrapper или явного `GRADLE_BIN` tools repo не собирается.
3. **BLOCKER (scope, tools).** Единственный `tools/` — это два web-only harness'а (класс C), а не общие инструменты. Общие скрипты разбросаны по `scripts/` и завязаны на monorepo-layout. Нужно решение: (a) tools = только A/B после параметризации, web-тестеры остаются в web; или (b) tools = harness-репозиторий, и тогда §3.3 обязателен.
4. **BLOCKER (docs source-of-truth).** Канон docs — legacy monorepo на ветке `c21.4`, а не один из 5 активных repo; backend отстаёт на 9 файлов и 6 правок. Нужно подтверждение, что источник — mono `c21.4` (рекомендуется), и что ветку не будут переписывать до push.
5. **BLOCKER (production cutover).** `animastor.org/docs/` живёт с bind-mount `/home/animastor/animastor/docs`. Удаление docs до переключения mount даёт 404. Нужен отдельный cutover-этап с rollback.
6. **Не блокер, но учесть:** грязные worktree backend (4 M, 1 D, 2 ??) и mono (1 M, 1 ??). Любые операции с ними — только после отдельного решения; текущий аудит их не трогал.
7. **Не блокер:** целевые repo уже созданы, public, пустые, default `main`; SSH-доступ с VPS работает.

---

## 6. Приложения

- `75-docs-manifest.txt` — 297 строк: `mode blob path` для `animastor:c21.4:docs`.
- `75-tools-manifest.txt` — 46 строк: `mode blob path` для `animastor-web:main:tools`.
- Временные проверочные клоны: `/tmp/audit-docs-extract`, `/tmp/audit-tools-extract`, `/tmp/audit-tools-redact` (вне рабочих репозиториев).

### 6.1 Битые относительные ссылки в извлечённых docs (12: 11 pre-existing + 1 новая)

11 существуют и в исходном дереве; одна (`../../README.md`) появляется из-за flatten:

```
README.md -> 02-orchestration/ORCHESTRATOR_LIFECYCLE.md
README.md -> 02-orchestration/REGENERATION_SYSTEM.md
README.md -> 02-orchestration/ORCHESTRATOR_FACADE_PR.md
README.md -> 02-orchestration/M5_COMPETING_WRITERS.md
README.md -> 02-orchestration/STATE_WRITERS_MAP.md
README.md -> 04-planning/MIGRATION_PLAN.md
08-mobile-web-migration/TODO.md -> 08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md
08-mobile-web-migration/TODO.md -> 08-mobile-web-migration/README.md
08-mobile-web-migration/TODO.md -> 08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md
08-mobile-web-migration/TODO.md -> 08-mobile-web-migration/06-RISKS-AND-ALTERNATIVES.md
08-mobile-web-migration/README.md -> ../../README.md   # новая, из-за flatten
architecture/repository-split-post-split-audit.md -> build-apk.sh
```

### 6.2 Что НЕ делалось

- Не изменялись файлы, индексы, ветки, remotes, права.
- Не выполнялись commit/push/filter-repo на рабочих репозиториях.
- Не удалялись и не переименовывались каталоги.
- GPU Hub не затрагивался.
- Старые backup-копии не использовались как источник.
