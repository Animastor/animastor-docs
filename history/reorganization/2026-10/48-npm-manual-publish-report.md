# Этап 48 — новая версия npm-пакета и выкат (ручная публикация + CI + rollout)

**Дата:** 2026-10-13 (Часть A: ~07:15–08:10 UTC; Часть B: ~08:45–08:55 UTC)
**Итог: PASS** — **Часть A:** пакет `@animastor/orchestration` поднят
`0.1.1 → 0.1.2`, состав tarball'а проверен (фикс этапа 47 внутри, diff против
опубликованного `0.1.1` — ровно 2 файла), pin/lock в `backend/` переведены на
`0.1.2` с integrity того tarball'а, который публикуется; тесты без регрессий;
коммит `706b507`. **Часть B (после подтверждения владельца «опубликовал»):**
registry подтверждает `0.1.2` с точно совпадающим integrity, approval-коммит
`82d2f54`, CI-ран **38371657466 success** → образ
`deploy-706b507` (`sha256:ceb8a5f4…`), rollout только `animastor-backend`
выполнен, **`reconcile:6_issues → 3_issues`, 3 ложных invariant-записи
исчезли**, данные и соседние контейнеры не тронуты, прежний digest сохранён
для отката.

---

## 0. Краткая сводка

| Пункт | Статус | Факт |
|---|---|---|
| 1. Точное имя пакета | **да** | `@animastor/orchestration` — `packages/animastor-orchestration/package.json:name`, единственный потребитель `backend/package.json` (`^0.1.1` → `^0.1.2`), lock `resolved` = `registry.npmjs.org/@animastor/orchestration/-/orchestration-<ver>.tgz`, установленная копия `backend/node_modules/@animastor/orchestration` |
| 2. Patch-версия | **0.1.1 → 0.1.2** | в `packages/…/package.json` действительно была `0.1.1`; в registry только `0.1.1` (`dist-tags.latest=0.1.1`), `…/0.1.2` → **404** — версия свободна, расхождений версий в дереве нет |
| 3. Пакет содержит фикс `691bfa1` | **да** | §3: `reconciliation-engine.js` в tarball байт-в-байт == git-дереву, обе ветки `expected: 'FAILED, PENDING or DIRTY'`, маркеры `Stage 47`; `npm publish --dry-run` видит тот же shasum/integrity |
| 4. Внутренние зависимости и lock | **да** | 4 файла: `packages/animastor-orchestration/{package.json,package-lock.json}` → `0.1.2`; `backend/{package.json,package-lock.json}` → `^0.1.2` + entry `0.1.2` с integrity; локальная `node_modules`-копия и её hidden-lock синхронизированы |
| 5. Не публиковать / не трогать credentials | **да** | `npm publish` **не вызывался** (только `--dry-run`, без auth и без загрузки); `~/.npmrc` не менялся; попыток обхода авторизации нет |
| 6. Package contents / тесты / diff | **PASS** | §5: 36 файлов, 131.9 kB; пакетные тесты 13/0; targeted 122/0; полный **3158 passing / 28 pending / 4 failing** (failure-set идентичен базе stage 47); syntax OK; diff — 4 файла, 8+/8−, только версии/integrity |
| 7. Production / rollout (Часть A) | **не трогали** | образ `deploy-c8837f0` (пин `0.1.1`), контейнер не пересоздавался, данные только читались |
| B1. Публикация в registry | **PASS** | владелец выполнил `npm publish` (npm-лог: `PUT 202`, `exit 0`, shasum `076c71ee…`, integrity `sha512-tWwaQvki…`); `npm view …/0.1.2` → `200`, `dist-tags.latest=0.1.2`, integrity **точно равен** полю `integrity` в `backend/package-lock.json` |
| B2. Pin/lock доведены | **PASS** | изменений не потребовалось — lock уже указывал на этот tarball; коммит `706b507` запушен (`691bfa1..706b507`) |
| B3. CI-сборка immutable-образа | **PASS** | approval `82d2f54` (`APPROVED_COMMIT=706b507…`), dispatch 204 → ран **38371657466 success** (все 10 шагов), gate `backend/ tree == approved 706b507…` |
| B4. Digest / OCI / содержимое / smoke | **PASS** | `sha256:ceb8a5f423a6c58c26bf0958eae2c5a4c15daadab46b7a74cdde3a7a3b43e081`, `revision=706b507…`, `version=deploy-706b507`, sha256 4 файлов == git, в образе `@animastor/orchestration@0.1.2` + фикс (grep=2), smoke `/health` 200, 0 crash-сигнатур |
| B5. Rollout только backend | **PASS** | `.env:39` → новый digest (бэкап `/tmp/opencode/stage48-env.bak`), dry-run «только backend Recreate», `up -d` rc=0; контейнер `f81cb47a464a`, gpu-hub/proxy/pg/redis не тронуты |
| B6. Пост-проверки | **PASS** | §10: health 200/200/200, `reconcile:3_issues` (было 6), `[INVARIANT]` только 2 pre-existing `DONE+dirty`, 0 `Invalid transition`/`TypeError`/`FATAL`, PG/Redis/июльские ключи без изменений |
| B7. Отказов не было | **да** | все проверки зелёные; обходов не применялось |

---

## 1. Имя пакета и каталог

| Поле | Значение |
|---|---|
| npm-имя | **`@animastor/orchestration`** |
| Каталог пакета | **`/home/animastor/animastor-backend/packages/animastor-orchestration/`** |
| Версия | **`0.1.2`** (была `0.1.1`) |
| Точка входа | `main: src/index.js`, `exports: {".": "./src/index.js"}` |
| `publishConfig` | `{ "access": "public" }` — флаг `--access` не нужен |
| Содержимое (files) | `src/`, `test/`, `README.md`, `LICENSE` (+ обязательные `package.json`) |
| Потребитель | `backend/package.json` → `@animastor/orchestration` (единственный в дереве) |
| Registry | публичный (анонимный `npm view`/`curl` работают), версии: `['0.1.1']`, `latest=0.1.1` |

Проверка «не угадываю»: имя взято из `package.json` пакета, подтверждено
единственной зависимостью `backend/package.json` и `resolved`-URL'ом в
`backend/package-lock.json`, а также фактическим содержимым
`backend/node_modules/@animastor/orchestration` (там же лежит правленный
`src/runtime/reconciliation-engine.js`).

---

## 2. Выбор версии

- Текущая версия исправляемого пакета = **`0.1.1`** (package.json + оба
  lock-файла + registry) → следующий свободный patch = **`0.1.2`**.
- `https://registry.npmjs.org/@animastor/orchestration/0.1.2` → **404**
  (версия не занята).
- Другие пакеты монорепо (`contracts`, `generation`, `parser`, `editor`,
  `installer` — все `0.1.1`) не изменялись → их диапазоны в `backend`
  остаются `^0.1.1`. Единственная пересобираемая зависимость —
  `@animastor/orchestration`.
- Подняты: `packages/animastor-orchestration/package.json` (`version`),
  корневые записи `packages/animastor-orchestration/package-lock.json`
  (`version` и `packages[""].version` — записи `../animastor-contracts`,
  `../animastor-generation` не трогались: это соседи, не эта версия).

---

## 3. Публикуемый пакет содержит фикс `691bfa1`

1. `npm pack --pack-destination /tmp/opencode` →
   `animastor-orchestration-0.1.2.tgz`; **повторный pack байт-в-байт
   идентичен** (sha256 `7f97343d5283136e…` дважды) — тарболл
   воспроизводим, поэтому integrity в lock не «съедет».
2. Распаковка tarball'а:
   - `package.json` → `name=@animastor/orchestration`, `version=0.1.2`;
   - `src/runtime/reconciliation-engine.js` → `diff -q` с git-деревом
     **без различий** (те же байты, что закоммичены в `691bfa1`);
   - `grep -c "FAILED, PENDING or DIRTY"` = **2** (audio + video ветки),
     маркеры `// Stage 47` на строках 613/653/721.
3. Дельта против **опубликованного** `0.1.1`
   (`registry.npmjs.org/…/orchestration-0.1.1.tgz`, integrity
   `sha512-Jd97Ge1H…` — совпал с metadata) — ровно 2 файла:
   - `src/runtime/reconciliation-engine.js` → фикс invariant;
   - `package.json` → `version 0.1.2` + URL репозитория
     (`animastor` → `animastor-backend`, обновление метаданных,
     сделано в дереве раньше, публикуется вместе с версией).
4. `npm publish --dry-run` (без auth, без загрузки) печатает тот же
   `shasum: 076c71ee6e8ff51f5b759041ccbc1a84e76b97ec` и
   `integrity: sha512-tWwaQvki+4O03O/6is0hS6ZKlz8eWV4Y9tgLFrJOZ9Hcz4A2TsmpxRACWsqqbcCduXMDdG4KzOaHnAQgwIn9Xw==`,
   `total files: 36`, `Publishing to https://registry.npmjs.org/ with tag
   latest and public access (dry-run)`.

---

## 4. Изменённые файлы (все — только версии/integrity, 0 строк логики)

| Файл | Изменение |
|---|---|
| `packages/animastor-orchestration/package.json` | `version: 0.1.1 → 0.1.2` |
| `packages/animastor-orchestration/package-lock.json` | корневые `version` (2 места) → `0.1.2` |
| `backend/package.json` | `@animastor/orchestration: ^0.1.1 → ^0.1.2` |
| `backend/package-lock.json` | корневая зависимость `^0.1.2`; entry `node_modules/@animastor/orchestration`: `version 0.1.2`, `resolved …/orchestration-0.1.2.tgz`, `integrity sha512-tWwaQvki+4O03O/6is0hS6ZKlz8eWV4Y9tgLFrJOZ9Hcz4A2TsmpxRACWsqqbcCduXMDdG4KzOaHnAQgwIn9Xw==` |
| `backend/node_modules/@animastor/orchestration/{package.json,src/runtime/reconciliation-engine.js}` | локальная копия синхронизирована (git-ignored, в репозиторий/CI не попадает) |
| `backend/node_modules/.package-lock.json` | hidden-lock обновлён на `0.1.2` (производное, git-ignored) |

**Важно:** lock переведён на integrity **конкретного** tarball'а, который
загрузит публикация, поэтому публиковать нужно либо из каталога пакета
(при том же npm/тех же файлах — pack воспроизводим), либо готовый
`/tmp/opencode/animastor-orchestration-0.1.2.tgz`. Если в итоге integrity
в registry окажется другим — перед CI обновить
`backend/package-lock.json` (см. §6, шаг 4 проверки).

---

## 5. Package contents, тесты, diff

| Проверка | Результат |
|---|---|
| Состав пакета | **36 файлов**, unpacked 535.3 kB, package size 131.9 kB; `src/` + `test/` + README + LICENSE; `node_modules` в tarball не попал |
| `npm publish --dry-run` | name `@animastor/orchestration`, version `0.1.2`, shasum/integrity как в lock (§3.4) |
| Тесты самого пакета (`npm test` в `packages/animastor-orchestration`) | **13 passing / 0 failing** |
| Backend targeted (`reconciliation-engine` + `audio-orchestrator` + `stage-dispatch-lifecycle`) | **122 passing / 0 failing** |
| Полный набор `npx mocha 'tests/**/*.test.js' --exit` | **3158 passing / 28 pending / 4 failing** |
| Failure-set vs база stage 47 | **идентичен** (те же 4 pre-existing: LLM Sharing ×2, `IB-G15`, `phase5 T9`) — регрессий нет |
| `scripts/syntax-smoke.sh` | все production JS/CJS проходят |
| `npm ls @animastor/orchestration` (в `backend/`) | `@animastor/orchestration@0.1.2` без замечаний |
| `git diff` (коммит `706b507`) | 4 файла, **8 insertions / 8 deletions** — только версии, URL tarball'а и integrity |

Логи: `/tmp/opencode/stage48-fullsuite.log`, `/tmp/opencode/stage48-syntax.log`.

---

## 6. Команда публикации (выполняет владелец)

Сначала — авторизация (сейчас возвращается `401`, токен в `~/.npmrc`
устарел; **я его не менял**):

```bash
npm whoami        # должен напечатать логин; сейчас: 401 Unauthorized
```

Публикация (из каталога пакета, никаких доп. флагов не требуется —
`publishConfig.access: public` уже в `package.json`):

```bash
cd /home/animastor/animastor-backend/packages/animastor-orchestration
npm publish
# эквивалентно (гарантированно байт-в-байт тот же tarball, что в lock):
npm publish /tmp/opencode/animastor-orchestration-0.1.2.tgz
```

**Проверка успешной публикации:**

```bash
# 1) версия появилась в registry
npm view @animastor/orchestration versions          # ожидается ['0.1.1','0.1.2']
npm view @animastor/orchestration dist-tags         # latest → 0.1.2

# 2) integrity совпадает с backend/package-lock.json (иначе npm ci/install упадёт)
npm view @animastor/orchestration@0.1.2 dist.integrity
# ожидается:
# sha512-tWwaQvki+4O03O/6is0hS6ZKlz8eWV4Y9tgLFrJOZ9Hcz4A2TsmpxRACWsqqbcCduXMDdG4KzOaHnAQgwIn9Xw==

# 3) в опубликованном tarball действительно фикс
cd /tmp/opencode && curl -sL -o chk.tgz \
  https://registry.npmjs.org/@animastor/orchestration/-/orchestration-0.1.2.tgz
tar -xzf chk.tgz && grep -c 'FAILED, PENDING or DIRTY' package/src/runtime/reconciliation-engine.js   # ожидается 2
```

Если шаг 2 дал другой integrity — обновить `backend/package-lock.json`
(поле `integrity` у `node_modules/@animastor/orchestration`) и закоммитить
**до** запуска CI.

**Запрет до публикации:** не запускать
`.github/workflows/backend-ghcr-release.yml` (`workflow_dispatch`) — сборка
упадёт на `npm install` с `EINTEGRITY`/`404` (это безопасный отказ: образ
без фикса всё равно не соберётся).

---

## 7. Production в Части A (не изменялся)

До подтверждения публикации и до Части B:

| Проверка | Значение |
|---|---|
| контейнер / образ | `be739e49ecbf` / `deploy-c8837f0` — не пересоздавались |
| установленный в образ пакет | `@animastor/orchestration@0.1.1` (фикс в образ не попал) |
| invariant-логи | по-прежнему 3 ложных `[INVARIANT] … audio-orch violations` (июльские сцены `FAILED + dirty`) + 2 pre-existing `DONE+dirty` |
| данные | только чтение: `GET/HGET/HGETALL/KEYS/SCARD/SISMEMBER`; PG не писался; книги/assets/output/ключи не удалялись |

Состояние после Части B — §8.5 (rollout) и §8.6 (пост-проверки).

---

## 8. Часть B — выполнено (после подтверждения владельца)

Подтверждение владельца: «опубликовал» → далее строго по шагам.

### B1. Публикация в registry и соответствие фиксу — **PASS**

- npm-лог публикации (запуск владельца): `PUT 401` → web-auth →
  `PUT 202 …/@animastor%2forchestration`, `exit 0`, `info ok`, предупреждение
  «being processed…»; `shasum: 076c71ee6e8ff51f5b759041ccbc1a84e76b97ec`,
  `integrity: sha512-tWwaQvki+4O03O/…` — совпадает с tarball'ом из §5.
- Через ~3 мин репликации: `GET …/@animastor%2Forchestration/0.1.2` → 200,
  `dist-tags.latest = 0.1.2`,
  `dist.integrity = sha512-tWwaQvki+4O03O/6is0hS6ZKlz8eWV4Y9tgLFrJOZ9Hcz4A2TsmpxRACWsqqbcCduXMDdG4KzOaHnAQgwIn9Xw==`,
  `dist.shasum = 076c71ee6e8ff51f5b759041ccbc1a84e76b97ec` — **без расхождений
  с `backend/package-lock.json`**.
- Скачанный из registry tarball: `name/version = @animastor/orchestration
  0.1.2`, `reconciliation-engine.js` **байт-в-байт == git-дереву**
  (`sha256 16d53aa7…`), `grep -c 'FAILED, PENDING or DIRTY'` = **2**.

### B2. Pin/lock — **PASS (изменений не потребовалось)**

`backend/package.json` (`^0.1.2`) и `backend/package-lock.json` (entry
`0.1.2` + integrity) уже были закоммичены в `706b507` и запушены; совпадение
integrity подтверждено → дополнительных коммитов не делалось.

### B3. Approval + CI — **PASS**

- `82d2f54` `ci(backend): approve 706b507 backend tree` — `APPROVED_COMMIT`
  → `706b50761e4157a27350ddf61c2b5c2379fba4d2`; `git diff --quiet 706b507 --
  backend/` — дерево идентично; push `706b507..82d2f54`.
- Dispatch через API (токен владельца, scope `repo, write:packages`):
  `POST …/actions/workflows/backend-ghcr-release.yml/dispatches`
  `{ref: main, inputs: {commit: 706b507…, image_tag: deploy-706b507}}` → **204**.
- Ран **38371657466** (run #8, head `82d2f54`), 08:47:11Z → 08:48:37Z (~86 с),
  **conclusion: success**, все шаги: Verify ✓ (`backend/ tree == approved
  706b507…`) → Build ✓ → Isolated smoke ✓ (health 200, crash-signature 0) →
  Teardown ✓ → Login (PAT) ✓ → Push immutable tags ✓ → Record digest ✓.

### B4. Digest / OCI / содержимое / smoke — **PASS**

| Проверка | Значение |
|---|---|
| Дайджест обоих тегов | `sha256:ceb8a5f423a6c58c26bf0958eae2c5a4c15daadab46b7a74cdde3a7a3b43e081` (`deploy-706b507` и тег полного SHA) |
| Прежние теги | не перезаписаны (`deploy-c8837f0`/`b2fb472`/`e9d6566` на месте) |
| OCI labels | `revision=706b50761e4157a27350ddf61c2b5c2379fba4d2`, `version=deploy-706b507` |
| Содержимое vs git | sha256 `src/backend.cjs`, `package.json`, `package-lock.json`, `Dockerfile` — совпали и в CI, и локально после `docker pull` |
| Пакет внутри образа | `@animastor/orchestration@0.1.2`, фикс на месте (`grep` = 2), `reconciliation-engine.js` sha256 `16d53aa7…` == git |
| Smoke в CI | `/health` 200 `{status:ok, loop:true, redis:PONG}`, `crash-signature lines: 0` |

### B5. Rollout только backend — **PASS**

- Бэкап: `/tmp/opencode/stage48-env.bak` (sha `d9d1a813…`), изменена
  **ровно одна строка** `deploy/.env:39` → `BACKEND_IMAGE=…@sha256:ceb8a5f4…`
  (новый sha файла `06d597aa…`).
- Dry-run: только `animastor-backend Recreate`, остальные `Running`.
- `docker compose --project-name animastor --env-file .env -f
  docker-compose.yml -f overlay-backend-standalone.yml up -d` → **rc=0**;
  контейнер `be739e49ecbf` → **`f81cb47a464a`** (image `ceb8a5f423a6`, Up).
- Соседи не тронуты: `gpu-hub` (19 h), `animastor-proxy` (21 h),
  `animastor-pg` / `animastor-redis` / `repro-redis` (7 weeks / 6 days).

### B6. Пост-проверки — **PASS**

| Проверка | До | После |
|---|---|---|
| `https://animastor.org/health`, `gpu/health`, `app` | 200/200/200 | **200/200/200** |
| `reconcile` | `reconcile:6_issues` | **`reconcile:3_issues`** |
| `[INVARIANT]` июльских сцен (`import_1783656905372`, `FAILED+dirty`) | 3 ложных | **0** |
| `[INVARIANT]` остальные | 2 × `audio_orch_invariant_done` (`sc-5f18dd0f`, `sc-5f0068ca`) | **те же 2** (pre-existing, вне скоупа) |
| Пакет в контейнере | `0.1.1` | **`0.1.2`** |
| `Invalid transition` / `TypeError` / `FATAL` с момента старта | — | **0 / 0 / 0** |
| PG: `books` / `generation_tasks` / `scene_assets` / `scenes` | 5 / 17 / 503 / 12 | **5 / 17 / 503 / 12** |
| Redis: audio-orch / video-orch / asset-state / event-journal / active | 8 / 3 / 18 / 10 / 1 | **8 / 3 / 18 / 10 / 1** |
| Ключи июльских сцен | `FAILED` + `dirty` | **без изменений** (не чистились, не удалялись) |

### B7. Откат (не потребовался)

Если потребуется вернуть прежнее: `deploy/.env:39` →
`BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:8a05f2e6024dad41407533f37be521c4526a3f3ac6cc1e35d061af72d6a707b4`
(копия — `/tmp/opencode/stage48-env.bak`) и `up -d`; образ `deploy-c8837f0`
(`8a05f2e6024d`) локально присутствует.


---

## 9. Артефакты

**Часть A**
- Коммиты: `691bfa1` (фикс invariant, этап 47) и `706b507`
  (`chore(orchestration): bump … 0.1.1 → 0.1.2`), push `691bfa1..706b507`.
- Tarball: `/tmp/opencode/animastor-orchestration-0.1.2.tgz`
  (sha256 `7f97343d5283136e389c3e425778a7a444c155b0955abcc6cf148aa2159a25a5`,
  shasum1 `076c71ee6e8ff51f5b759041ccbc1a84e76b97ec`, 36 файлов).
- Сравнения: `/tmp/opencode/{a,c}/package` — registry `0.1.1` vs `0.1.2`.
- Логи: `/tmp/opencode/stage48-fullsuite.log`, `/tmp/opencode/stage48-syntax.log`.
- Окружение: npm `10.9.8`, node `v22.22.3` (для воспроизводимости tarball'а).

**Часть B**
- Approval-коммит: `82d2f54` (`APPROVED_COMMIT=706b507…`), push `706b507..82d2f54`.
- CI: ран **38371657466** (run #8, success), лог job —
  `/tmp/opencode/job.log` (дубликат из API), дайджест
  `sha256:ceb8a5f423a6c58c26bf0958eae2c5a4c15daadab46b7a74cdde3a7a3b43e081`.
- Образ: `ghcr.io/animastor/animastor-backend:deploy-706b507`
  (`ceb8a5f423a6`), локально сохранён; прежний `deploy-c8837f0` (`8a05f2e6024d`)
  — ресурс отката.
- `.env`: бэкап `/tmp/opencode/stage48-env.bak` (sha `d9d1a813…` →
  `06d597aa…`), изменена строка 39.
- Контейнер: `f81cb47a464a` (заменён `be739e49ecbf`).


