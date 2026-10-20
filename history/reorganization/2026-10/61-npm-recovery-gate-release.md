# Stage 61 — npm-релиз BOOK-RECOVER registry gate (подготовка к публикации)

**Date:** 2026-10-17
**Verdict: PASS — READY FOR MANUAL NPM PUBLISH** — оба пакета содержат фикс
Stage 59, новая patch-версия каждому, locks/pins согласованы с
воспроизводимыми tarball'ами, архивы проверены (состав, gate-маркеры, чистая
установка, импорт/API, отсутствие секретов), целевые и архитектурные тесты
зелёные, коммит `a64199e` запушен в `origin` и `github` обычным push.
Публикация **не выполнялась** (мандат: только владелец; агентские npm-креды —
401). Production, `.env`, контейнеры, данные — не тронуты.

---

## 1. Исходные данные (шаг 1)

- Отчёты Stage 59 (`59-stop-client-book-recovery.md`) и Stage 60
  (`60-book-recovery-deploy-verification.md`, блокер §1.9) изучены.
- `git status` (animastor-backend, HEAD `c40b2da` до работы): посторонние
  изменения **зафиксированы и не тронуты** — `D backend/scripts/audit-orphan-books.js`,
  `M` 4 теста (`ai-endpoint-sharing`, `ai-shared-inference`,
  `installer-package-boundary`, `phase5-runtime-result`), untracked `deploy/`,
  `freebuff-chat-*.md` (те же, что Stage 58 §4 / Stage 60 §1.6). Mono-каталог
  `/home/animastor/animastor` (свои незакоммиченные изменения) — не трогался:
  production-сборка идёт только из `animastor-backend` (CI context `./backend`),
  mono не является потребителем этих версий.
- Registry на момент подготовки: `@animastor/editor` = `['0.1.0','0.1.1']`,
  `@animastor/player` = `['0.1.0']` — версии `0.1.2`/`0.1.1` свободны
  (`npm view …/0.1.2` и `…/0.1.1` → 404/отсутствуют).

## 2. Распределение фикса c40b2da по пакетам (шаг 2) — оба обязательны

Дельта `published tarball ↔ repo@c40b2da` (diff -r распакованных Stage 60
тарболлов против `packages/*/src`) — ровно файлы Stage 59, ничего лишнего:

| Пакет | Файл | Содержание гейта | Обязателен к публикации |
|---|---|---|---|
| **@animastor/editor** | `src/editor-routes.cjs` | `GET /book/:id`: placeholder-audio recovery выполняется только при `recoveryCtx.isBookRegistered(bookId)`; иначе лог `[BOOK-RECOVER] … skipped recovery — book not registered` | ✅ |
| **@animastor/editor** | `src/read-recovery.cjs` | `recoverMissingRedisChunks`: early-return + лог `skipped — book not registered (no books row)` до создания чанков | ✅ |
| **@animastor/player** | `src/player-routes.cjs` | приём и протаскивание `deps.isBookRegistered` в shared-контур | ✅ |
| **@animastor/player** | `src/player-shared.cjs` | деструктуризация + геттер `isBookRegistered` в экспорте контура | ✅ |
| **@animastor/player** | `src/scene-data.cjs` | storyboard: цикл `iuRepo.upsertImageUnit` (PG self-heal) выполняется только при `ctx.isBookRegistered(bookId)`; длительности по-прежнему считаются и возвращаются | ✅ |

Без публикации обоих пакетов образ из `a64199e`/`c40b2da` несёт новый
`backend.cjs` (injection порта), но исполняет **старые** контуры из registry —
гейт молчит ( Stage 60 §1.9). Оба пакета содержат требуемый код → обе версии
повышаются. Остальные пакеты монорепо (`vbook-runtime` и др.) не изменялись.

## 3. Подготовленные версии, locks, pins (шаг 3)

| Файл | Изменение |
|---|---|
| `packages/animastor-editor/package.json` | `version: 0.1.1 → 0.1.2` |
| `packages/animastor-editor/package-lock.json` | root `version` + `packages[""].version` → `0.1.2` |
| `packages/animastor-editor/CHANGELOG.md` | запись `0.1.2 (2026-10-17)`: гейт, additive-порт, fail-open при отсутствии порта |
| `packages/animastor-player/package.json` | `version: 0.1.0 → 0.1.1` |
| `packages/animastor-player/package-lock.json` | root `version` + `packages[""].version` → `0.1.1` |
| `packages/animastor-player/CHANGELOG.md` | запись `0.1.1 (2026-10-17)`: гейт storyboard-upsert, additive-порт |
| `backend/package.json` | `@animastor/editor: ^0.1.1 → ^0.1.2`; `@animastor/player: ^0.1.0 → ^0.1.1` |
| `backend/package-lock.json` | root-диапазоны; entries `node_modules/@animastor/{editor,player}`: version/resolved/integrity **конкретных** tarball'ов (см. §4) |

- **Внутренние зависимости:** оба пакета зависят только от
  `@animastor/vbook-runtime@^0.1.0` (registry, 0.1.0 опубликован, не менялся).
  **Editor ↔ player зависимости нет** (проверено по `dependencies`/
  `peerDependencies` обоих package.json) → порядок публикации свободный.
- **Публичный API не менялся:** root exports идентичны предыдущим версиям
  (editor: `createEditorModel, createEditorPorts, createEditorRoutes,
  createEntityCrudRoutes`; player: `createPlayerModel, createPlayerRoutes`);
  гейт — additive необязательный порт с fail-open (legacy-поведение без порта
  сохранено, см. §4 clean-env).
- **CI/build-конфигурация:** `backend-ghcr-release.yml` фиксированных версий
  пакетов не содержит (только `APPROVED_COMMIT`); образ npm-install'ит из
  `backend/package-lock.json` → правка workflow на этом этапе не требуется.
  Локальные `backend/node_modules/@animastor/{editor,player}` (+ hidden-lock)
  синхронизированы на новые версии (git-ignored, как в Stage 48);
  `npm ls` чистый: `editor@0.1.2`, `player@0.1.1`.

## 4. Проверка архивов (шаг 4)

Окружение: npm **10.9.8**, node **v22.22.3** — идентично Stage 48
(воспроизводимость tarball'ов).

| Проверка | @animastor/editor@0.1.2 | @animastor/player@0.1.1 |
|---|---|---|
| `npm pack` (реальный) | ✅ `/tmp/opencode/stage61/packs/animastor-editor-0.1.2.tgz` | ✅ `…/animastor-player-0.1.1.tgz` |
| Воспроизводимость (двойной pack, sha256) | ✅ идентичен | ✅ идентичен |
| sha256 | `3c26fe8bdc35f9b4…` | `ea8722a18cc43f4a…` |
| sha512 integrity (= в backend lock) | `sha512-s5fFW4NVBEgCeLWc5QeYYnfZ+EL+bhb/JfbyBQgxCAWbsSVvxWqItGfa8AUL12wARxPGLKr/l7LsywJWx1efNw==` | `sha512-eeGuoqfwEwkzKDY3Ux9hGgWOjhHzrdEuoL0rKGBrCGtlwhvOazERmcxJ0HcK2LFPnm/lCwowhGQMaSPcM7ev3w==` |
| Состав tarball | ✅ 13 файлов: `src/` (8) + package.json/README/LICENSE/CHANGELOG; без test/, lock, node_modules | ✅ 13 файлов: `src/` (9) + те же 4 метаданных |
| `version` в tarball | ✅ 0.1.2 | ✅ 0.1.1 |
| `isBookRegistered` в tarball | ✅ `read-recovery.cjs` (гейт-выражение + лог), `editor-routes.cjs` (2 вхождения) | ✅ `scene-data.cjs` (гейт), `player-routes.cjs` (2), `player-shared.cjs` (2) |
| Секреты / локальные данные | ✅ скан `api_key|password|secret|token|ghp_|postgres://|BEGIN RSA/OPENSSH` — только ложные срабатывания на book-поле `video_tokens` (контент книги, не credential) | ✅ чисто |
| **Чистая установка** (`npm install *.tgz` в свежий temp-проект) | ✅ установился, root-импорт работает | ✅ то же |
| Импорт/API в чистом окружении | ✅ exports = 4 функции (как 0.1.1); deep-import заблокирован картой `exports` (`ERR_PACKAGE_PATH_NOT_EXPORTED` — штатный guard PB1–PB4) | ✅ exports = 2 функции (как 0.1.0) |
| Гейт в установленном из tarball | ✅ все4 файла с портом | ✅ все3 файла с портом |

**Тесты:**

| Набор | Результат |
|---|---|
| `packages/animastor-player`: `npm test` | ✅ **17 passing / 0 failing** |
| `packages/animastor-editor`: `npm test` | 74 passing, **1 failing — pre-existing** (см. ниже) |
| Pre-existing editor fail | `entity-crud-routes.test.js` «DELETE unit purges image_units row…» — воспроизводится **идентично** на нетронутом дереве `c40b2da` (проверено через `git stash`), файл `entity-crud-routes.cjs` не менялся ни в Stage 59, ни здесь (он же в published 0.1.1) → не регрессия релиза, вне скоупа Stage 61 |
| Backend целевые (gate + контракты + сплит-гарды): `book-registry-recovery-gate`, `editor-extraction-readiness`, `assistant-purge-wiring`, `editor-route-split`, `player-route-split`, `phase6-editor-player`, `editor-package-boundary` | ✅ **101 passing / 0 failing** (гейт-тест грузит реальные src пакетов по относительному пути — проверяет ровно то, что упаковано) |
| Полный `tests/architecture/*.test.js` | ✅ **929 passing / 24 pending / 0 failing** (= 933 Stage 59 − 4 gate-теста, living в `tests/` вне каталога architecture и прогнанные отдельно выше) |
| `node --check` всех `src/*.cjs` обоих пакетов + `backend.cjs` | ✅ без ошибок |

## 5. Коммит и push (шаг 6)

- **Коммит:** `a64199e` `chore(editor,player): bump to 0.1.2/0.1.1 for BOOK-RECOVER registry gate (stage 61)` — ровно **8 файлов** (6 пакетных + backend/package.json + backend/package-lock.json), +65/−16. Автор/коммиттер идентичны истории репо.
- **Не включено** (проверено `git status` до/после add): удаление `audit-orphan-books.js`, 4 посторонних теста, untracked `deploy/`, `freebuff-chat-*.md`.
- **Push:** обычный (без force) — `origin` (mirror) и `github` оба подтверждены на `a64199e1ec29b7f533dafc4da2e675e0fcdaf9e6` (`git ls-remote`). История не переписывалась.
- Mono-каталог `/home/animastor/animastor` — коммитов не получал (не каноничен для этой линии релиза).

## 6. Инструкция владельцу (шаг 7) — публикация вручную

Порядок **не важен** (пакеты не зависят друг от друга); обе публикации должны
завершиться **до** запуска CI-сборки (lock в `backend/` требует обе версии;
npm install упадёт fail-closed — безопасно).

```bash
# 0) авторизация (агенту недоступна: npm whoami -> 401; web-auth на npmjs.com)
npm whoami        # должен напечатать логин

# 1) @animastor/editor 0.1.2
cd /home/animastor/animastor-backend/packages/animastor-editor
npm publish
# эквивалентно (tarball уже упакован и сверен):
#   npm publish /tmp/opencode/stage61/packs/animastor-editor-0.1.2.tgz

# 2) @animastor/player 0.1.1
cd /home/animastor/animastor-backend/packages/animastor-player
npm publish
#   npm publish /tmp/opencode/stage61/packs/animastor-player-0.1.1.tgz
```

**Проверка результата в registry:**

```bash
npm view @animastor/editor versions       # ожидается ['0.1.0','0.1.1','0.1.2']
npm view @animastor/editor dist-tags      # latest -> 0.1.2
npm view @animastor/editor@0.1.2 dist.integrity
# ДОЛЖНО БЫТЬ (иначе остановиться и обновить backend/package-lock.json):
# sha512-s5fFW4NVBEgCeLWc5QeYYnfZ+EL+bhb/JfbyBQgxCAWbsSVvxWqItGfa8AUL12wARxPGLKr/l7LsywJWx1efNw==

npm view @animastor/player versions       # ожидается ['0.1.0','0.1.1']
npm view @animastor/player dist-tags      # latest -> 0.1.1
npm view @animastor/player@0.1.1 dist.integrity
# ДОЛЖНО БЫТЬ:
# sha512-eeGuoqfwEwkzKDY3Ux9hGgWOjhHzrdEuoL0rKGBrCGtlwhvOazERmcxJ0HcK2LFPnm/lCwowhGQMaSPcM7ev3w==

# содержимое опубликованных tarball'ов (gate на месте):
cd /tmp && curl -sL -o e.tgz https://registry.npmjs.org/@animastor/editor/-/editor-0.1.2.tgz \
  && rm -rf package && tar -xzf e.tgz \
  && grep -c isBookRegistered package/src/read-recovery.cjs package/src/editor-routes.cjs   # >=1 в каждом
curl -sL -o p.tgz https://registry.npmjs.org/@animastor/player/-/player-0.1.1.tgz \
  && rm -rf package && tar -xzf p.tgz \
  && grep -c isBookRegistered package/src/scene-data.cjs                                    # >=1
```

Если `dist.integrity` в registry оказался **другим** (иная npm-версия/файлы
при публикации) — перед CI переписать `integrity` в
`backend/package-lock.json` на фактический и закоммитить; иначе `npm install`
упадёт на EINTEGRITY (fail-closed, образ не соберётся — безопасно).

**Подтверждения, требуемые перед CI и деплоем (Stage 62+):**

1. Владелец подтверждает: `npm publish` обоих пакетов завершён exit 0.
2. `npm view`-проверки выше зелёные (версии, latest, integrity == lock).
3. Gate-маркеры присутствуют в опубликованных tarball'ах.
4. Только затем — approval-коммит `ci(backend): approve a64199e backend tree for GHCR release (stage 62)` (`APPROVED_COMMIT` → `a64199e…`), dispatch
   `backend-ghcr-release` с `commit=a64199e…`, `image_tag=deploy-a64199e`,
   верификация образа (revision + `@animastor/editor@0.1.2` /
   `@animastor/player@0.1.1` внутри + grep gate) и rollout **только backend**
   (pin `deploy/.env:BACKEND_IMAGE`, откат-ресурс — `sha256:71ab1468…`,
   снимок `rollback-60/`). Проверки живого поведения — по плану Stage 60 §3/§5
   (включая удаление `image_units` id=250444 только после доказательства
   гейта).

## 7. Запреты — соблюдены

- `npm publish` не выполнялся (только `npm pack`, локально).
- Production не менялся: контейнеры не пересоздавались, `.env` не тронут
  (sha `f10c29df…`), digest backend'а `sha256:71ab1468…`, restarts=0.
- `image_units` id=250444 и прочие данные не удалялись; схемы не менялись.
- В коммит не включены посторонние изменения; force-push не выполнялся.
- Ничего не утверждается о публикации/production-поведении как о свершившемся.

## 8. Артефакты

- Tarball'ы (финальные, воспроизводимые): `/tmp/opencode/stage61/packs/animastor-editor-0.1.2.tgz`, `…/animastor-player-0.1.1.tgz` (+ sha256-логи `sha256.first`/`sha256.second`)
- Распаковки для инспекции: `/tmp/opencode/stage61/x/{editor,player}/package/`
- Чистый install-тест: `/tmp/opencode/stage61/clean/`
- Коммит: `a64199e` (push: origin + github = `a64199e1ec29b7f533dafc4da2e675e0fcdaf9e6`)
