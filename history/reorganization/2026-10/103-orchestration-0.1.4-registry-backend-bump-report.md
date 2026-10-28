# Stage 103 — Verify npm 0.1.4 and prepare backend dependency bump

**Дата:** 2026-10-21 (UTC)
**Итог:** **PASS** — опубликованный `@animastor/orchestration@0.1.4` проверен
(byte-identical локальному кандидату Stage 102); dep-bump в backend подготовлен
локальным коммитом `78e8f1ae`. Push/publish/GHCR/deploy **не выполнялись**.

---

## 1. Проверка npm registry

| Проверка | Результат |
|---|---|
| Версия в registry | **`0.1.4`**, опубликована **2026-10-21T08:09:15Z**, dist-tag **latest = 0.1.4** |
| Tarball URL | `https://registry.npmjs.org/@animastor/orchestration/-/orchestration-0.1.4.tgz` |
| `dist.integrity` | **`sha512-WW/Imbc1IYBAjGtx5exHWcgMJTfHbWvr8HBmyzglBbuXl/WSQj2vl2mff6/MqwwDu/2LFlFcFfNidEu07TyIzw==`** |
| `dist.shasum` (sha1) | `8851876cdd9cfa1ccb774040159bbca7538ffc82` |
| Сравнение с локальным tarball Stage 102 | **BYTE-IDENTICAL** (`cmp` скачанного `/tmp/opencode/stage103/…0.1.4.tgz` и кандидата `/tmp/opencode/stage102/…0.1.4.tgz` — 0 различий; вычисленная sha512 == registry `dist.integrity`). Сравнение **возможно и выполнено напрямую**, без предположений |
| Состав vs манифест Stage 101/Stage 102 | **37 файлов, список идентичен** (`diff` списков: 0 различий) |

### 1.1 Содержимое распакованного registry-пакета

| Проверка | Результат |
|---|---|
| `package.json` version | `0.1.4` |
| Фиксы | `scene-callbacks.js`: `artifactRoot()` ×4 ✓; `reconciliation-engine.js:23` `hostBinding('artifactRoot')` ✓; `test/artifact-root-binding.test.js` присутствует ✓ |
| Литералы `/data/output`,`/data/books` в `src/` | **0** ✓ |
| `node_modules` / `.env` / `package-lock` / `backend/` в тарболле | **0 записей** ✓ |
| Секрет-скан (npm_…, gpm_, private key, BEGIN) | **0** ✓ |
| **Тесты распакованного пакета** (`npm install --include=dev` в /tmp + `npm test`) | **19 passing / 0 failing** ✓ (ожидание выполнено) |

## 2. Подготовка backend

**Состояние до:** `main` @ `0e50e23c` (ahead 3), 7 прежних dirty-записей нетронуты, remotes `origin`/`github` не тронуты.

**Изменения (рабочая копия, до коммита):**
- `backend/package.json:26`: `^0.1.3` → **`^0.1.4`** (единственная строка).
- `backend/package-lock.json`: штатное `npm install` в `backend/` — диф **минимальный, 8 строк**:
  root-range `^0.1.4`; entry `node_modules/@animastor/orchestration`: version `0.1.4`,
  resolved-URL 0.1.4, integrity `sha512-WW/Imbc1…zw==` (**совпадает** с registry и Stage-102-кандидатом). **Ни одна другая зависимость не изменилась.**
- Установленная копия: `backend/node_modules/@animastor/orchestration` = **0.1.4**; npm-копия:
  литералы `/data/*` в `src/` = **0**, `hostBinding('artifactRoot')` на месте.
- **Lockfiles проекта:** реально используемый backend'ом — `backend/package-lock.json` (обновлён).
  Остальные `packages/*/package-lock.json` не участвуют в разрешении backend-зависимостей
  (единственный упоминающий orchestration — собственный lockfile зеркала, предсуществующий
  дрейф `0.1.2`, задокументирован Stage 102 §2) — **не менялись**.

## 3. Тесты (baseline Stage 99/100 — 935/24/0; предсуществующих отказов нет)

| Проверка | Результат |
|---|---|
| Целевые DATA_ROOT (config + grep-гейт) | **22 passing / 0 failing** |
| `backend npm test` (pretest syntax + mocha) | **935 passing / 24 pending / 0 failing** — == baseline, регрессий нет |
| `npm run test:syntax` | All production JS/CJS files pass syntax check |
| `packages/animastor-orchestration npm test` (зеркало) | **19 passing / 0 failing** |
| `tests/orphan-books-diagnosis.test.js` (живой PG) | **6 passing** |
| Grep-гейт в полном прогоне | PASS (единственный владелец — runtime-config; orchestration-src чист) |

## 4. Коммит

| Поле | Значение |
|---|---|
| SHA | **`78e8f1ae4bb581f52b736bc64e5ae603dedab839`** |
| Сообщение | `chore(backend): update orchestration to 0.1.4` |
| Состав | **2 файла, 5+/5−** — только `backend/package.json` + `backend/package-lock.json` |
| Staged-диф перед коммитом | проверен: постороннего нет (dirty-файлы §1 Stage-103-статуса остались unstaged) |
| Родитель | `0e50e23c` — линейная история `82c80af → fae1beed → e4255524 → 0e50e23c → 78e8f1ae`; **ahead 4** от `origin/main` |
| Тег | не создавался |

## 5. Подтверждение отсутствия публикаций и production-изменений

| Проверка | Результат |
|---|---|
| `npm publish` | **не выполнялся** Stage 103 (0.1.4 был опубликован владельцем до Stage 103, 08:09Z; registry только читался) |
| `git push` (bare/GitHub) | **не выполнялся**: reflog — только `commit:`; `origin/main`=`github/main`=`82c80af` — не изменились |
| Workflow / GHCR / deploy | **не выполнялись** |
| Production | `animastor-backend Up 2 days`, pg/redis 8 weeks (healthy) — рестартов нет; `.env`/Compose/БД/Redis/данные — не трогались |
| Dirty-файлы (7 прежних) | сохранены, не очищены/не перезаписаны; в коммит не попали |
| Git-история | не переписывалась (fast-forward коммит) |

## 6. Оставшиеся блокеры (следующие шаги, решение владельца)

1. Push `main` (ahead 4) — запрещён Stage 103.
2. Approval-коммит `ci(backend): approve 78e8f1ae backend tree …` (`APPROVED_COMMIT` в
   `backend-ghcr-release.yml` = `74088d6…` → требует обновления на релизный SHA).
3. `workflow_dispatch` GHCR-релиза (immutable `deploy-<short-sha>`; встроенный isolated smoke).
4. Отдельно согласованный deploy/рестарт production (Stage 92 N1-окно); rollback — redeploy
   `sha256:182b0252…` (`deploy-74088d6`), revert коммита `78e8f1ae` при дефекте пакета
   (npm-дефект лечится supersede-версией 0.1.5).
