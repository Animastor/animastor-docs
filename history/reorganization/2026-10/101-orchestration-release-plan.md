# Stage 101 — Orchestration Release Reconciliation (план публикации 0.1.4)

**Дата:** 2026-10-21 (UTC)
**Итог:** **PASS (план готов)** — `@animastor/orchestration@0.1.4` подтверждён как
корректная следующая версия; состав пакета определён байт-в-байт; линия публикации —
зеркало в `animastor-backend` @ `e4255524`. **Ничего не опубликовано и не изменено**
(версии, lockfile, refs, Git-история, production — нетронуты; все операции read-only;
`npm pack --dry-run` артефактов не создаёт).

---

## 1. Этап 1 — Сверка линий версий

### 1.1 Опубликованный registry

| Версия | Опубликована (UTC) | Происхождение линии |
|---|---|---|
| 0.1.0 | 2026-0.9-14 02:14 | первая публикация |
| 0.1.1 | 2026-09-14 02:49 | monorepo-линия |
| 0.1.2 | 2026-10-13 07:58 | backend-линия (bump-коммит `706b507` «stage 48») |
| **0.1.3 (latest)** | **2026-10-13 19:55** | backend-линия (bump в `e172075` «stage 50») |
| **0.1.4** | **E404 — не существует** | номер свободен ✓ |

### 1.2 Линия backend — подтверждена как источник публикации

- Метаданные опубликованного 0.1.3: `repository.url = git+https://github.com/Animastor/animastor-backend.git`,
  `repository.directory = packages/animastor-orchestration` → публикации 0.1.2/0.1.3 шли
  из backend-репо, не из монорепо.
- История пакета в backend: `41a5690` (extract) → `038de7d` (0.1.1) → `b89954f` (metadata) →
  `706b507` (**0.1.2**, stage 48) → `e172075` (**0.1.3**, stage 50) → `fae1beed` (Stage 96
  DATA_ROOT-фикс, версия не менялась) → `e4255524` (HEAD).
- Локальное зеркало @ `e4255524`: `package.json` **байт-в-байт идентичен** опубликованному
  0.1.3, кроме поля `version` (остаётся `0.1.3` — **не менялась** Stage 101,.constraint).

### 1.3 Корректность номера 0.1.4

- Линия 0.1.x идёт только patch-бампами (0.1.1→0.1.2→0.1.3); фикс Stage 96 —
  поведение-сохраняющий рефакторинг (закрытие 4 литералов через уже существующий шов
  `artifactRoot`; доказано тестом «байт-в-байт равна прежнему литералу» при корне
  `/data/output`) → **patch 0.1.4** корректен, 0.2.0 не требуется.
- Потребители: `animastor-backend` — `^0.1.3` (0.1.4 войдёт в диапазон → dep-bump
  факультативен для resolver'а, но **рекомендуется пин-обновление** для воспроизводимости
  образа, §4); монорепо — `^0.1.1` (тянет 0.1.2-линию; отдельная публикация 0.1.2+фикс —
  решение владельца, Stage 98 C6, backend не задействует).
- **Решение владельца о линии:** публикация 0.1.4 **именно из backend-зеркала**
  (0.1.1-линия monorepo не обновляется этим релизом).

## 2. Этап 2 — Точный состав пакета 0.1.4

**Источник сборки:** `animastor-backend` @ **`e4255524eed3d54e9fa4c1612cea118275a084ed`**,
каталог `packages/animastor-orchestration` (рабочее дерево каталога **чистое** — все
изменения закоммичены в `fae1beed`; предыдущий пакетный коммит `e172075`).

**Tarball 0.1.4 = 37 файлов** (подтверждено `npm pack --dry-run` из зеркала):

| Изменение vs 0.1.3 | Файл | Дельта |
|---|---|---|
| **modified** | `src/orchestration/scene-callbacks.js` | 2+/2− — сайты `:281`,`:393`: литералы `'/data/output'` → `artifactRoot()` (шов `:23` уже в 0.1.3) |
| **modified** | `src/runtime/reconciliation-engine.js` | 6+/3− — импорт `hostBinding` (`:18`), помощник `artifactRoot` (`:21-23`), `videoPath` (`:124`), `resolveCanonicalSceneImage` (`:158`) |
| **added** | `test/artifact-root-binding.test.js` | 174 строк, 6 поведенческих тестов (сам биндит `artifactRoot` через `wire()`; `test/test-bindings.js` **байт-идентичен** 0.1.3 — не менялся) |
| **bumped** | `package.json` | только `"version": "0.1.3"` → `"0.1.4"` (всё остальное байт-в-байт идентично 0.1.3) |
| **identical** | остальные **34 файла** | побайтово равны 0.1.3 (LICENSE, README.md, 27 src-файлов, 2 прежних теста, test-bindings.js) — сверено `cmp` файл-к-файлу по списку тарболла 0.1.3 |

**Не входит в пакет (по `files`-whitelist `["src/","test/","README.md","LICENSE"]`):**
`package-lock.json` (исключается npm-ом всегда), `node_modules` (есть в рабочей директории
зеркала — npm pack исключает на уровне семантики), **никакие backend-only файлы**
(`backend/src/**`, включая C3-правки Stage 99, в каталог пакета не входят).
`diff -rq` тарболл-0.1.3 vs зеркало: различаются ровно 2 src-файла + отсутствующий в 0.1.3
новый тест — **посторонних изменений orchestration нет** (критерий «не смешивать» соблюдён).

**Тестовый шов пакета:** `"test": "mocha --exit --require test/test-bindings.js test/*.test.js"` —
`artifact-root-binding.test.js` подхватывается автоматически; самобиндинг `wire()` не требует
изменений `test-bindings.js` (Stage 98 §4.2).

## 3. Этап 3 — Release checklist (НЕ выполнялся, порядок для владельца/следующих этапов)

1. **Локальные коммиты и проверки (уже готовы):** `fae1beed` + `e4255524` в `animastor-backend`;
   в зеркале пакета создать bump-коммит по принятому паттерну:
   `chore(orchestration): bump @animastor/orchestration 0.1.3 → 0.1.4 (stage 101)` —
   единственный файл `packages/animastor-orchestration/package.json`. Перед ним/после:
   `npm test` в каталоге пакета (ожидание 19 passing) + `npm pack --dry-run`
   (ожидание: ровно 37 файлов, список §2).
2. **Публикация 0.1.4 владельцем** (npm-auth владельца; в репо токенов нет):
   из чистого checkout @ bump-коммит, каталог `packages/animastor-orchestration`:
   `npm publish --access public` (publishConfig уже public). Push bump-коммита —
   отдельно согласованный (Stage 100 BL-3/BL-4 still active).
3. **Проверка опубликованного tarball:** `npm view @animastor/orchestration@0.1.4 dist.tarball dist.integrity`;
   скачать, распаковать, сверить: (а) integrity с `npm pack` локального кандидата;
   (б) `grep -rn "/data/output\|/data/books" src` → **0**; (в) `grep -n "hostBinding('artifactRoot')" src/runtime/reconciliation-engine.js` → есть; (г) 37 файлов; (д) `cmp` всех 34 неизменённых файлов с 0.1.3.
4. **Обновление backend:** коммит `chore(deps): bump @animastor/orchestration ^0.1.3 → ^0.1.4`
   — `backend/package.json` + `backend/package-lock.json` (через
   `npm install @animastor/orchestration@^0.1.4` в `backend/`; dep-range обновляется
   **только после** подтверждённой публикации — constraint Stage 100/101).
5. **Повтор тестов backend:** целевые DATA_ROOT (22), полный `npm test` (сравнить с базлайном
   935/24/0), syntax-smoke, `npm ls @animastor/orchestration` (нет дублей/конфликтов),
   orphan-books-diagnosis (6) + проверка npm-копии: `grep -rn "/data/output" node_modules/@animastor/orchestration/src` → **0**.
6. **Approval gate перед backend push/GHCR:** коммит-одобрение
   `ci(backend): approve <release-sha> backend tree for GHCR release` (паттерн `82c80afd`):
   `APPROVED_COMMIT` в `.github/workflows/backend-ghcr-release.yml` := SHA, чей `backend/`-дерево
   байт-идентично релизному ( gate: `git diff --quiet $APPROVED_COMMIT HEAD -- backend/` ).
   Затем push `main` и `workflow_dispatch` (`commit`, новый immutable `image_tag=deploy-<short-sha>`;
   встроенный isolated smoke: sha256-сверка 4 файлов, `/health` 200, redis PONG, нет crash-сигнатур).
7. **Deploy отдельным согласованным этапом:** обновление production-контейнера на новый
   digest ( Stage 92 N1-окно ); запись digest в cutover-аудит; rollback-план §6.

## 4. Этап 4 — Безопасность сборки/публикации

| Контур | Контекст | Защита |
|---|---|---|
| **npm publish/pack** | каталог `packages/animastor-orchestration` чистого checkout @ bump-коммит | `files`-whitelist (src/, test/, README.md, LICENSE) + автоматические исключения npm (`node_modules`, `package-lock.json`, `.env` и dotfiles не в whitelist) → в тарболл попадают **только 37 ожидаемых файлов** (подтверждено dry-run). `.npmignore` отсутствует и **не нужен** (whitelist строже). Скан содержимого пакета на секреты: 0 (только runtime redis lease/lock-токены — код, не секреты); `.env`/`.pem`/`.key` под `packages/` отсутствуют |
| **Локальный hazard Stage 100 (хостовый `node_modules` в docker-контексте)** | относится к **docker build**, не к npm publish | задокументирован: образ собирать **только в CI** (workflow `backend-ghcr-release.yml`, контекст `./backend` чистого checkout ≈6.2 МБ, 437 файлов) либо из `git archive`; локальная сборка из рабочей директории (110 МБ, хостовые @animastor-копии) — запрещена практикой. Добавление `backend/.dockerignore` и правки production Dockerfile — **вне** объёма Stage 101 (не выполнялись) |
| **Секреты в git-контексте релиза** | bump-коммит = 1 файл package.json | прежняя грязь репо (`deploy/`, `freebuff-chat-*.md`, 5 тестовых правок) в коммиты не попадает (точечный `git add`); `deploy/.env` **не** в трекинге и не в контексте CI-сборки |

## 5. Тесты и проверки кандидата (выполнены Stage 100/101 read-only)

| Проверка | Результат |
|---|---|
| `npm test` в зеркале пакета | 19 passing / 0 failing (включая 6 новых artifact-root-binding) |
| `npm pack --dry-run` | 37 файлов, 137.1 kB; список = 0.1.3 + новый тест; lockfile/node_modules исключены |
| diff тарболл-0.1.3 vs зеркало | ровно `scene-callbacks.js`, `reconciliation-engine.js` + новый тест |
| 0.1.4 занят? | нет (E404); dist-tags: latest=0.1.3 |
| Backend-базлайн ( Stage 100 ) | 935 passing / 24 pending / 0 failing; целевые 22/0; syntax OK |

## 6. Необходимые решения владельца и rollback

**Решения:**
| # | Решение |
|---|---|
| D1 | Публиковать 0.1.4 **из backend-зеркала** (§1.2–§2) — рекомендуется; линию monorepo 0.1.2+фикс публиковать либо нет (отдельно, для `^0.1.1`-потребителей) |
| D2 | Разрешить bump-коммит + `npm publish` + push (checklist п.1–2) |
| D3 | Dep-bump `^0.1.4` + lockfile (п.4), approval-коммит + workflow_dispatch (п.6) |
| D4 | Окно deploy (п.7, Stage 92 N1) |

**Rollback:**
- **npm:** unpublish запрещён/невозвратен → дефект 0.1.4 лечится **0.1.5** (supersede);
  dist-tag latest перекинется автоматически; потребители на `^0.1.3` возьмут фикс-версию.
- **backend:** `git revert` dep-bump-коммита → возврат пина `^0.1.3`/lockfile 0.1.3
  (поведение = текущее production).
- **образ/production:** теги иммутабельны → откат = redeploy прежнего digest
  `ghcr.io/animastor/animastor-backend@sha256:182b0252…` (`deploy-74088d6`).
- **данные/БД/`.env`/Compose:** релиз не затрагивает (код+образ+registry только).

**Оставшиеся блокеры (все — решение владельца, ничего не выполнялось Stage 101):**
B1 публикация 0.1.4 (D2); B2 dep-bump+lockfile (D3); B3 approval-коммит+push+dispatch (D3);
B4 deploy-окно (D4); B5 параллельное решение по 0.1.2-линии monorepo (D1).

## 7. Границы Stage 101 — подтверждение

- `npm publish`, `git push`, GHCR build/push, deployment, рестарты — **не выполнялись**;
  registry только читался (`npm view`); `npm pack --dry-run` артефактов не создаёт.
- Версии, dep-ranges, lockfile, опубликованные refs, Git-история — **не менялись**
  (зеркало @ `e4255524`, версия в package.json осталась `0.1.3`).
- Dirty-файлы (7 прежних) не очищались и не трогались; production/Compose/`.env`/БД/Redis/данные — без изменений.
- DATA_ROOT-дельта и посторонние изменения orchestration не смешаны: дельта пакета = ровно §2.
- Единственный артефакт вне репозиториев — этот отчёт.
