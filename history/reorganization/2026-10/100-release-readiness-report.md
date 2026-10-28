# Stage 100 — Verify Published Orchestration & Prepare Backend Release

**Дата:** 2026-10-21 (UTC)
**Итог:** **PASS (verификация и план)** — опубликованный `@animastor/orchestration@0.1.3`
**не содержит** исправлений Stage 96 (ожидаемо: опубликован 13.10, фикс — 21.10);
backend-коммиты Stage 99 проверены; релиз готов к воспроизводимой подготовке.
Production, опубликованные refs, npm registry — **не менялись** (все проверки read-only;
артефакты `npm pack` — в `/tmp/opencode/stage100/`).

---

## 1. npm-пакет `@animastor/orchestration`

| Проверка | Результат |
|---|---|
| Ожидаемая версия (зависимость backend) | `^0.1.3` (`backend/package.json:26`; lockfile-запись та же) |
| Установлена локально | `0.1.3` (`backend/node_modules`, `npm ls` — без конфликтов) |
| Опубликована в registry | версии `[0.1.1, 0.1.2, 0.1.3]`; latest **`0.1.3`**, `time.modified 2026-10-13T19:55:22Z` |
| Удовлетворяет ли диапазону | **да** — `0.1.3 ∈ ^0.1.3`; dep-bump не требуется и не выполнялся |
| Integrity lockfile vs registry-тарболл | **MATCH** (`sha512-IICsR0kI…Uhw==` — байт-в-байт совпал с вычисленной sha512 скачанного `orchestration-0.1.3.tgz`) |
| **Исправление Stage 96 в опубликованном пакете** | **ОТСУТСТВУЕТ** — см. таблицу ниже |
| Расхождение с проверенным локальным исходником | ровно **2 файла src** (+ отсутствует новый тест) |

### 1.1 Содержимое опубликованного `0.1.3` (распакованный тарболл)

| Site Stage 96 | Опубликовано 0.1.3 | Локальное зеркало `packages/animastor-orchestration` @ `e4255524` |
|---|---|---|
| `scene-callbacks.js:281` | литерал `'/data/output'` — **не закрыт** | `artifactRoot()` ✓ |
| `scene-callbacks.js:393` | литерал `` `/data/output/…` `` — **не закрыт** | `artifactRoot()` ✓ |
| `reconciliation-engine.js:124` | литерал — **не закрыт** | `artifactRoot()` ✓ |
| `reconciliation-engine.js:158` | литерал `'/data/output'` — **не закрыт** | `artifactRoot()` ✓ |
| `reconciliation-engine` импорт `hostBinding` | **нет** (только `lazyHostBinding`) | есть (`:23 const artifactRoot = () => hostBinding('artifactRoot')`) ✓ |
| `test/artifact-root-binding.test.js` | **отсутствует** в тарболле | есть ✓ |

Оговорка: шов `artifactRoot` в `scene-callbacks.js:23` и `scene-restoration.js:23`
в 0.1.3 **уже есть** (предыдущие этапы) и используется на других сайтах (`:129`,`:333`) —
Stage 96 закрывал оставшиеся 4 литерала; они в опубликованном пакете остались.

`diff -rq` тарболл-0.1.3 vs локальное зеркало: различаются только
`scene-callbacks.js`, `reconciliation-engine.js` (src) + отсутствие
`artifact-root-binding.test.js` (test). Локальное зеркало — восстановимо-воспроизводимый
**эталон публикации** (коммиты `fae1beed`+`e4255524`).

### 1.2 Линии версий (решение владельца, Stage 98 C6 — не менялось Stage 100)

- `animastor-backend` (нужен этот релиз): зеркало **0.1.3+фикс** → публикация **0.1.4**,
  затем dep-bump `^0.1.4` в backend.
- монорепо: зеркало **0.1.1+фикс** → линия 0.1.2 (для `^0.1.1`-потребителей) — отдельная линия,
  backend не задействует.
- Публикация, dep-bump и lockfile-обновление Stage 100 **не выполнялись** (запрет:
  «не менять версии зависимостей автоматически»).

## 2. Локальные коммиты backend — проверены

| Проверка | Результат |
|---|---|
| Ветка / HEAD | `main` / **`e4255524eed3d54e9fa4c1612cea118275a084ed`**, ahead 2 от `origin/main` |
| Коммит 1 | **`fae1beed61d8350354f7c44535221a8ed1385c8a`** — 9 файлов порта, ровно ожидаемый набор (4 src + 2 tests + 3 orchestration-mirror), 542+/12−; посторонних файлов **нет** |
| Коммит 2 | **`e4255524e`** — 2 файла C3 (`scene-assets-repo.js`, `orphan-books-audit.js`), 4+/3−; посторонних **нет** |
| Автор/дата | `Animastor <…webhostbox.net>`, 2026-10-21 06:32 UTC; линейная история `82c80af → fae1beed → e4255524` |
| Refs | изменился только локальный `refs/heads/main`; `origin/main`= `github/main` = `82c80af` — **не тронуты**; tags/hub-artifacts-v1 не тронут |
| Reflog | только записи `commit:`; push/merge/rebase/reset **не выполнялись** |
| Dirty (7 прежних, не очищались) | `D backend/scripts/audit-orphan-books.js`, `M backend/tests/{ai-endpoint-sharing,ai-shared-inference,architecture/installer-package-boundary,architecture/phase5-runtime-result}.test.js`, `?? deploy/`, `?? freebuff-chat-2026-10-11T…md` — **не в коммиты, не тронуты** |
| Монорепо | HEAD `088f3fa9`, статус прежний — не менялся |

## 3. Состав backend-релиза (точный)

**Входит в релиз (код образа):**
1. `backend/src` коммитов `fae1beed`+`e4255524`: DATA_ROOT-абстракция
   (`runtime-config.js`), снятие фолбэков (`backend.cjs`, `task-handler.cjs`,
   `book-deletion.cjs`), C3-закрытие литералов (`scene-assets-repo.js`,
   `orphan-books-audit.js`). Дефолты `/data/books`,`/data/output` байт-в-байт сохранены.
2. `backend/tests` (2 новых тест-файла) — попадают в контекст/образ (в repo нет
   `backend/.dockerignore`; bind-mount `/app/tests` затеняет их в runtime — как и прежде).
3. **Совместимый orchestration**: в образ ставится из **registry** (`npm install --omit=dev`).
   Сегодня это 0.1.3 **без** фикса → полная поставка фикса требует публикации
   **0.1.4** владельцем и dep-bump `^0.1.4` + `package-lock.json` (отдельный релизный коммит;
   **не выполняется** Stage 100).
4. Lockfile: `backend/package-lock.json` сейчас пинит `0.1.3` + верный integrity;
   после публикации 0.1.4 — обновить через `npm install @animastor/orchestration@^0.1.4`
   (одним коммитом вместе с `package.json`).
5. `packages/animastor-orchestration` (зеркало) — **не входит** в build context (`./backend`)
   и на образ не влияет; остаётся источником для публикации 0.1.4 и локальных тестов.

**Не входит:** `deploy/`, `docker/`, `.github/` (кроме обязательного коммита-одобрения, §4),
прежняя грязь (§2), отчёты этапов.

**Доставка в production:** образ `/app/src` запечён; правки backend/src действуют только
после GHCR-релиза и обновления контейнера (Stage 98 C7). Без публикации 0.1.4 релиз
доставляет backend-половину DATA_ROOT; orchestration-литералы останутся, но в контейнере
дают те же `/data/output/...` пути (поведение не меняется; гибкость DATA_ROOT для
orchestration-путей появится с 0.1.4).

## 4. Механика сборки и проверки будущего образа (воспроизводимый порядок)

Механика подтверждена по `.github/workflows/backend-ghcr-release.yml` (207 строк):

1. **Предусловие (владелец):** публикация `@animastor/orchestration@0.1.4` из зеркала
   `packages/animastor-orchestration` @ `e4255524` (см. §1.2) — либо осознанное решение
   выпустить backend-only (§3 п.3, оговорка).
2. **Релизный коммит:** dep-bump `^0.1.4` + lockfile (если п.1 выполнен).
3. **Коммит-одобрение** по установленному паттерну
   (`ci(backend): approve <sha> backend tree for GHCR release`): обновить
   `APPROVED_COMMIT` в `backend-ghcr-release.yml` на SHA, чей `backend/`-дерево
   байт-идентично релизному (как `82c80af` одобрил `74088d6`). **Не выполнялось** —
   одобрение устареет, если после него изменится `backend/` (например, lockfile).
4. **`workflow_dispatch`** с `commit=<релизный SHA>` и **новым** `image_tag=deploy-<short-sha>`
   (теги иммутабельны; `:latest` запрещён; workflow откажется перезаписывать существующий тег).
5. Встроенный smoke workflow (изолированная сеть, эфемерный redis, **без** production PG/Redis):
   побайтовое равенство `src/backend.cjs`,`package.json`,`package-lock.json`,`Dockerfile`
   в образе vs checkout; OCI-label revision; `/health` → 200 `"status":"ok"`+`"redis":"PONG"`;
   нет FATAL/uncaught; контейнер жив. Дополнительно к smoke рекомендуется (по согласованию):
   `docker run … node -e "…require('@animastor/orchestration/src/runtime/reconciliation-engine')…"`
   или `grep -r "/data/output" /app/node_modules/@animastor/orchestration/src` — ожидание
   **0** после публикации 0.1.4 (сейчас покажет 4 сайта 0.1.3).
6. Push immutable-тегов `deploy-<short-sha>` и `<full-sha>`; запись digest в step summary
   (напоминание зафиксировать digest в cutover-аудите перед потреблением).

**Статическая проверка сборочного контекста (выполнена):**
- build context = `./backend` (**не** корень репо): в CI — чистый checkout, 437 трекируемых
  файлов (~6.2 МБ по `git archive`: src 180, tests 192, ai 54, scripts 6, lock/pkg/Dockerfile);
  `.env` в контексте **нет**; `node_modules` в чистом checkout отсутствует → в образ попадают
  только registry-зависимости из lockfile (воспроизводимо).
- **Опасность локальной сборки из рабочей директории:** `backend/.dockerignore` в
  `animastor-backend` **отсутствует** (в монорепо есть), локальный контекст — **110 МБ**
  с хостовым `node_modules` (103 МБ) и `player-split-guard-*`-мусором; `COPY . .` после
  `npm install` **перезаписал бы** image-зависимости хостовыми (нерепродуктивно, dev-копии
  @animastor). Поэтому образ собирать **только в CI** (как принято) либо из чистого
  checkout/`git archive`; добавление `.dockerignore` — отдельное решение владельца
  (изменит содержимое образа: выпадет `tests/` — сейчас оно в образе осознанно, workflow NOTE :31-33).

## 5. Локальные проверки (выполнены, все зелёные)

| Проверка | Результат |
|---|---|
| Целевые DATA_ROOT (config + grep-гейт) | **22 passing / 0 failing** |
| `backend npm test` (pretest syntax-smoke + mocha) | **935 passing / 24 pending / 0 failing** (базлайн Stage 99 — идентично; предсуществующих отказов нет) |
| `npm run test:syntax` | All production JS/CJS files pass syntax check |
| `packages/animastor-orchestration npm test` | **19 passing / 0 failing** (включая 6 artifact-root-binding) |
| `tests/orphan-books-diagnosis.test.js` (C3-модуль, живой PG) | **6 passing** |
| Lockfile/версии | `npm ls @animastor/orchestration` → 0.1.3, конфликтов нет; integrity lockfile == registry-тарболл (**MATCH**, §1) |
| Статический сборочный контекст | §4: CI-контекст чист и воспроизводим; `.env` не попадает; локальная сборка — hazard задокументирован |
| Pre-existing исключения | top-level `tests/*.test.js` не захватываются глобом `npm test` (121 файл, предсущественно, Stage 99 §5) — **не** регрессия Stage 100 |

## 6. Блокеры и rollback

**Блокеры (решение владельца, ничего не выполнялось Stage 100):**
| # | Блокер |
|---|---|
| BL-1 | Публикация `@animastor/orchestration@0.1.4` из зеркала @ `e4255524` (+ выбор линии 0.1.2 для монорепо, Stage 98 C6) — без неё orchestration-половина DATA_ROOT в production недоступна |
| BL-2 | Dep-bump `^0.1.4` + lockfile-коммит (после BL-1) |
| BL-3 | Коммит-одобрение `APPROVED_COMMIT` + `workflow_dispatch` + push ветки — все запрещены Stage 100 |
| BL-4 | Push `main` (ahead 2) и GHCR-релиз/обновление production-контейнера — запрещены Stage 100 |

**Rollback требуемого релиза (задокументирован заранее):**
- Production-образ сейчас: `ghcr.io/animastor/animastor-backend:deploy-74088d6` @
  `sha256:182b02525b704d531797a3432ffe2adea494dddd69c5a5b69b0d05c08bd37082` (создан 19.10) —
  **откат = redeploy этого digest** (теги иммутабельны, старый digest не удаляется).
- Git: `git revert` релизных коммитов (без reset/history rewrite); lockfile-откат возвращает пин 0.1.3.
- npm: откатить опубликованный dist-tag нельзя (immutable) — при дефекте 0.1.4 поднять 0.1.5
  и перепинить backend.
- Данные/БД/`.env`/Compose релиз не трогает (изменения только код+образ; контейнерные пути
  данных не меняются — тесты §5).

## 7. Границы Stage 100 — подтверждение

- `git push`, npm publish, GHCR-push, deployment, рестарты — **не выполнялись**;
  remote refs `origin/main`/`github/main` = `82c80af` (не тронуты); registry только читался.
- `.env`, Compose, БД, Redis, постоянные данные — не менялись (только чтение
  `docker inspect`/`docker ps`; тесты с БД — READ-ONLY SELECT, как и раньше).
- История не переписывалась; версии/dep-ranges не менялись; грязь не очищалась.
- Единственные артефакты вне репозиториев: этот отчёт и `/tmp/opencode/stage100/`
  (скачанный для верификации тарболл 0.1.3 + распаковка).
