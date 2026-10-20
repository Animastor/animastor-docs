# Этап 39 — G3+D4 публикация утверждённых артефактов (репин, CI, новый release installer-src)

**Дата:** 2026-10-12
**Итог:** PASS
**Окно:** G3+D4 (публикация утверждённых артефактов; production НЕ применялся)

---

## 1. Scope

По решению владельца (этап 38, `/home/animastor/reorg-2026-10-12/38-g2-owner-approval.md`)
опубликованы 6 утверждённых целей через repin gpu-hub lock + CI + новый immutable
release для исправленного installer-src. Новые образы/артефакты к production **не применялись**.

### Утверждённые цели (SHA)

| Артефакт | Утверждённый SHA | Статус |
|---|---|---|
| worker commit | `b3f94f42612d0a5dd665956908f545c8d94fad95` | пин в L2 |
| backend commit | `a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad` | пин в L2 |
| worker-bundle tree | `417c0ad489badd77c64d5ca5cad06f5d75d56c50407fab1ce2b62f03620a3584` | пин в L2 |
| installer-src tree | `ff27e2912f59cef7d9aa13dc8ded4239a66f95aa841f1bb6b61a617bf6b452d4` (v0.1.1) | пин в L2 + новый release |
| workflows tree | `0d51107d58f9774fb761fca7319bdeb637b02a18c0f8f92dfec713c97beca738` | без изменений (verified) |
| install-manifests tree | `46f3c26a4fd73ae0b70c7f4eb46bff74efb3ef1ba60d2becbe3a7d0393f1f3e3` | без изменений (verified) |

---

## 2. G3 — Repin L2 + push + CI

### 2.1 Preflight

Staging на целевых коммитах (`stage-artifacts.cjs` без write-lock) даёт ровно
утверждённые значения и падает только на расхождении со старым lock (ожидаемо
до repin):

```
worker-bundle:  files=8 version=2.1.1 sha256_tree=417c0ad4…  (lock: 4bb0408b…)
workflows:      files=9 sha256_tree=0d51107d…                (совпадает)
installer-src:  files=32 version=0.1.1 sha256_tree=ff27e291… (lock: 02fad99e…, v0.1.0)
install-manifests: files=3 sha256_tree=46f3c26a…             (совпадает)
```

worker/backend уже на целевых коммитах и синхронизированы (local == bare == github):
push для них **не выполнялся**.

### 2.2 Repin L2 (`stage-artifacts.cjs --write-lock`)

Выполнен в `/home/animastor/animastor-gpu-hub`. Diff lock — ровно по целям:

- `sources.worker.commit` `618f87a6…` → `b3f94f42…`
- `sources.backend.commit` `98c4fbd6…` → `a7a8c463…`
- `artifacts.worker-bundle.sha256_tree` `4bb0408b…` → `417c0ad4…`
- `artifacts.installer-src.sha256_tree` `02fad99e…` → `ff27e291…`, `version` `0.1.0` → `0.1.1`
- workflows / install-manifests: **без изменений**

Повторный verify (без write-lock) — exit 0, `staging verified against artifacts.lock.json`.

### 2.3 Commit + push

- Commit `0f489c7bff3bb563aba45cf34410c3a9022b3950` (без force, история не переписана).
- push → bare (`/home/animastor/repos/animastor-gpu-hub.git`) → github
  (`git@github.com:Animastor/animastor-gpu-hub.git`).
- local == bare == github == `0f489c7bff3bb563aba45cf34410c3a9022b3950`.

### 2.4 CI

- `gpu-hub-ci` (run 38248178267, push на `0f489c7b`): **completed / success**.
  Jobs: `package tests + pack surface` success, `docker build + smoke + protocol parity` success.
- `gpu-hub-ghcr-release` (run 38248387442, workflow_dispatch `image_tag=v0.2.0`):
  **completed / success**. Stage+verify against lock, build (BuildKit v0.27.1),
  smoke (health/auth/protocol/artifact gates), push — всё success.

### 2.5 Новый образ (для будущего применения; к прод НЕ применён)

```
ghcr.io/animastor/animastor-gpu-hub:v0.2.0
  manifest digest: sha256:3611c64461049489c048a4d200836ff36fbd5e083a96a3c3c3b752c12eb793c0
  content digest (files + sha256 of /app): 836  fb14aae5ecd4c65f161ec287d6bfba5f802dc8bd30d3811ffed097b9d1b89493
  commit tag: 0f489c7bff3bb563aba45cf34410c3a9022b3950
```

Digest записан; применение к production — отдельное окно (фаза H/I2).

---

## 3. D4 — Новый immutable release исправленного installer-src

### 3.1 Упаковка

Из backend@a7a8c463 (staged tree `ff27e291…`) упакован zip в той же раскладке,
что у tool-а (`packages/animastor-installer/src/installer` → корень + `package.json`):

```
installer-src-v0.1.1.zip
  sha256:  78cc1bde760238b4b91c198669c579dfb1a1651fb4b69beac9eb70fc96f10ae6
  entries: 32
  contents tree sha256: ff27e2912f59cef7d9aa13dc8ded4239a66f95aa841f1bb6b61a617bf6b452d4  (== цель)
  fix: setup-contract.js:695 → git clone https://github.com/Animastor/animastor-worker.git  (было 404 …/animastor.git)
  version: 0.1.1
```

### 3.2 Публикация

Создан **новый** immutable release (старый `hub-artifacts-v1` НЕ перезаписан;
на GitHub его релизов/тегов не было — `hub-artifacts-v1` отдавал 404):

```
release: hub-artifacts-v0.1.1  (id 410577846)
asset:   installer-src-v0.1.1.zip  (id 633726043, size 165339)
```

### 3.3 Верификация после публикации

- Скачанный asset sha256 == локально упакованный: `78cc1bde…` — **MATCH**.
- Contents tree скачанного zip == `ff27e291…` — **MATCH**.
- Fix присутствует в скачанном zip (line 695 → `animastor-worker.git`) — **PASS**.

---

## 4. Lock-файлы

### 4.1 L2 (gpu-hub, CI-consumed) — ОБНОВЛЁН

`/home/animastor/animastor-gpu-hub/artifacts.lock.json` — repin через
`stage-artifacts.cjs --write-lock` (существующая процедура), закоммичен и запушен
(commit `0f489c7…`). Это authoritативный post-split lock, который потребляет
CI/ghcr-release и который зашит в новый образ.

### 4.2 L1 (mono, pre-split legacy) — БЕЗ ИЗМЕНЕНИЙ (no-op, обоснованно)

`/home/animastor/animastor/packages/animastor-gpu-hub/artifacts.lock.json`:

- `update-artifacts-lock.cjs --check` → exit 0 (в синке с mono-деревом).
- write-mode → **no-op** (sha до/после: `069b62d9…`, не изменился).
- Mono-дерево `packages/animastor-installer/src/installer/setup-contract.js:695`
  всё ещё содержит **баг** (`…/animastor.git`); исправление живёт только в
  backend@a7a8c463 и в новом релизе.
- Tool жёстко привязан к `release_tag=hub-artifacts-v1` / `asset_filename=installer-src-v1.zip`
  и recomputes tree из mono-источников — он **не может** выразить новый релиз
  без правки GROUPS (code change, вне scope «существующей процедуры»).

Вывод: L1 — legacy pre-split lock, замороженный вместе с mono-деревом; его
обновление не требуется для post-split публикации. Активный/потребляемый lock — L2.

### 4.3 Старый багованный релис

`hub-artifacts-v1` (со старым `installer-src-v1.zip`, sha `ae589c10…`) на GitHub
отсутствовал (404). Новый релиз создан аддитивно; существующие ассеты не
перезаписывались. На GitHub сейчас только `hub-artifacts-v0.1.1`.

---

## 5. Production — НЕ ИЗМЕНЁН (финальная проверка)

| Проверка | Значение | Статус |
|---|---|---|
| backend image | `sha256:e8152778…` (как до) |不变 |
| gpu-hub image | `sha256:daf510ff…` (как до) |不变 |
| deploy/.env пины | `e8152778…` / `daf510ff…` (не тронуты) |不变 |
| health (site) | `https://animastor.org/health` → 200 | PASS |
| health (backend) | `127.0.0.1:3000/health` → 200 | PASS |
| health (gpu-hub) | `gpu-hub:5000/health` → 200 | PASS |
| site index sha | `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c` |不变 |
| nginx -t | ok | PASS |
| generation_tasks | 17 |不变 |
| TLS (.org) | notAfter Jan 6 2027 |不变 |
| контейнеры | 7 шт., backend/proxy Up 48 min, pg/redis/hub — старые |不变 |
| PG/Redis | data не тронуты |不变 |

Rollback-пины для отката: backend `e8152778…`, gpu-hub `daf510ff…` — в deploy/.env.

---

## 6. Запреты — соблюдены

- Новые образы/артефакты к production **не применялись** (`docker compose up` не выполнялся).
- Контейнеры не пересоздавались (backend/proxy Up 48 min — из этапа 37).
- E2E-dispatch не выполнялся.
- DNS/TLS не менялись.
- PostgreSQL/Redis/данные не тронуты.
- `workflows` / `install-manifests` не изменялись (verified, tree совпадают).
- Без force-push / переписывания истории.
- Старый релиз `hub-artifacts-v1` не перезаписывался.

---

## 7. Артефакты / где что лежит

| Что | Значение |
|---|---|
| gpu-hub repin commit | `0f489c7bff3bb563aba45cf34410c3a9022b3950` |
| CI run (push) | 38248178267 (gpu-hub-ci) — success |
| Release run | 38248387442 (gpu-hub-ghcr-release, v0.2.0) — success |
| Новый image digest | `sha256:3611c64461049489c048a4d200836ff36fbd5e083a96a3c3c3b752c12eb793c0` |
| installer-src release | `hub-artifacts-v0.1.1` (id 410577846) |
| installer-src asset | `installer-src-v0.1.1.zip` sha `78cc1bde760238b4b91c198669c579dfb1a1651fb4b69beac9eb70fc96f10ae6` |

---

## 8. Следующий шаг (отдельное окно, НЕ в этом этапе)

Применить новый gpu-hub image `sha256:3611c644…` к production — фаза H/I2:
записать digest в `deploy/.env` (черновик), `docker compose up` для gpu-hub,
health 200/200/200, при необходимости откат на `daf510ff…`. Backend image
`e8152778…` не менялся в этом окне (backend-цель — код/lock, не образ).
