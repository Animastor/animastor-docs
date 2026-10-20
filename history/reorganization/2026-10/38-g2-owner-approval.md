# Animastor — Этап 38: G2/C4 — ФИНАЛЬНОЕ СОГЛАСОВАНИЕ ВЕРСИЙ

- Дата: 2026-10-12 (окно ~12:00 UTC)
- Режим: **только подготовка решения для владельца + короткая read-only сверка.**
  Ничего не публиковалось, не репинилось, не коммитилось/пушилось, lock-файлы не
  менялись, runtime не трогался, E2E не запускался.
- Источники (прочитаны): отчёт этапа 37 (§3, §4); значения tree-sha/staging —
  из проверок этапов 35 (C1–C3) и 37 (staging во /tmp); lock-файлы читались read-only.
- **Итог: таблица решений готова (§2). 4 цели меняются, 2 остаются.**
  Ничего не утверждается автоматически — ждёт «да» владельца (C4).

---

## 0. Краткий итог

- **Число целей для утверждения: 6** (4 меняются + 2 подтверждаются «без изменений»).
  Ядро решения — 2 коммита-источника: worker `b3f94f42` / backend `a7a8c463`.
- Текущий production **не менялся** и работает на действующих пинах
  (backend `e8152778…`, gpu-hub `daf510ff…`, worker-bundle 2.1.1 `480af146…`).
- Rollback через monorepo **цел** (`config --quiet` exit 0).
- После утверждения: одним окном G3 закрывается repin→push→CI→publish и D4
  (исходник исправленного installer-src готов). Runtime при этом не трогается —
  новый gpu-hub-образ применяется только отдельным действием (фаза H/I2), не в G3.

---

## 1. Read-only сверка исходного состояния (сегодня, короткая)

| Проверка | Результат |
|---|---|
| Deploy-runtime (7 контейнеров) | backend/proxy Up (пересозданы этапом 37), pg/redis healthy (Created 2026-07-08, не тронуты), gpu-hub Up 3 d |
| Health | `/health`=200, `/gpu/health`=200, `app`=200 |
| Текущие production-пины | backend `…@sha256:e8152778…`, gpu-hub `…@sha256:daf510ff…` — **не изменились** |
| Живой worker-bundle | v2.1.1 `480af146451ecd9fea4cfa736a96687c3344b7a65749639336991e62273b54e6` |
| Lock L1 / L2 | `069b62d931c1ff0e…` / `2a221e3ba626326c…` — **не изменены** |
| Lock-пины источников | worker `618f87a6…`, backend `98c4fbd6…` (действующие) |
| Целевые коммиты | worker HEAD `b3f94f42…`, backend HEAD `a7a8c463…` — **всё ещё = HEAD** |
| Rollback monorepo | `docker compose -f mono -f overlay --env-file mono/.env config --quiet` → **exit 0**; `.env` `ee64133e…` == `deploy/.env` |
| Git | без commit/push; mono baseline M3 + overlay untracked; backend `deploy/`+`freebuff` untracked; gpu-hub чист |
| Диск | 34 956 034 048 Б свободно (≥ порогов 15/16,6 млрд) |

**Вывод:** исходное состояние стабильно, отклонений нет → можно переходить к решению.

---

## 2. ТАБЛИЦА РЕШЕНИЙ (для утверждения владельцем)

> Полные SHA. `tree-sha` = каноническая формула tool-а (sha256 по отсортированным
> строкам `"<sha256(file)>  <relpath>\n"`). Все значения взяты из уже выполненных
> проверок (этап 35 C1–C3; этап 37 staging во /tmp); ничего не угадывалось.

### 2.1 Источники (коммиты репозиториев) — ЯДРО РЕШЕНИЯ

| # | Компонент | GitHub-репо | Текущий production (lock-пин) | Целевой SHA | Проверки уже выполнены | Что изменится после «да» | Риск при сохранении текущей |
|---|---|---|---|---|---|---|---|
| 1 | **worker** (источник worker-bundle) | `Animastor/animastor-worker` | `618f87a67744802b7e7a0b33a0934ce48d414640` | **`b3f94f42612d0a5dd665956908f545c8d94fad95`** (= HEAD) | W1: живой бандл 8/8 == пину; W2: staging на целях даёт worker-bundle `417c0ad4…` (расхождение названо tool-ом) | `sources.worker.commit` в L2-lock → `b3f94f42…`; staged worker-bundle становится `417c0ad4…` | Остаётся старый worker-bundle `4bb0408b…`; живой бандл и образ работают, но **отстаёт от актуального кода worker** (в т.ч. фиксы после `618f87a6`) |
| 2 | **backend** (источник installer-src/workflows/manifests) | `Animastor/animastor-backend` | `98c4fbd6823c40420154c69e3fc2e02f273fe3de` | **`a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad`** (= HEAD) | W2: staging на целях даёт installer-src `ff27e291…`/0.1.1 (расхождение названо); в `a7a8c463` 404-URL **исправлен** | `sources.backend.commit` → `a7a8c463…`; staged installer-src становится `ff27e291…`/0.1.1 | **Остаётся функциональный 404** в installer-src (шаг docker-build инсталлятора клонирует `…/animastor.git` → 404). Это реальный ущерб пользователям |

### 2.2 Артефакты (деревья) — что реально меняется / не меняется

| # | Артефакт | Текущий tree-sha (пин) | Целевой tree-sha | Версия (пин → цель) | Проверки | Что изменится | Риск при сохранении |
|---|---|---|---|---|---|---|---|
| 3 | **worker-bundle** | `4bb0408b5d0fcfb5d838d9406a47fed2cec6e7aee606bffd9ee65622f972bfd3` | **`417c0ad489badd77c64d5ca5cad06f5d75d56c50407fab1ce2b62f03620a3584`** | 2.1.1 → **2.1.1** (версия не меняется, меняются байты) | W1 (текущий бандл 8/8 == пину); W2 (цель даёт `417c0ad4…`) | `artifacts.worker-bundle.sha256_tree` → `417c0ad4…`; после CI новый gpu-hub-образ отдаёт бандл `417c0ad4…` | Живой бандл остаётся `4bb0408b…`/`480af146…`; косметика `repository.url` в zip не используется для клонирования (по этапу 35 — не критично) |
| 4 | **installer-src** | `02fad99eab61638aeb85e6f3b8be8139e61ebd18cfabd2e5e31ae80b463f1caa` | **`ff27e2912f59cef7d9aa13dc8ded4239a66f95aa841f1bb6b61a617bf6b452d4`** | 0.1.0 → **0.1.1** | Подтверждён дефект 404 (`setup-contract.js:695`); staging из backend@a7a8c463 даёт `ff27e291…`, URL исправлен на `…/animastor-worker.git` | `artifacts.installer-src.sha256_tree` → `ff27e291…`, version → 0.1.1; **D4**: публикация исправленного зипа (§4) | Опубликованный `installer-src-v1.zip` (`ae589c10…`) содержит **404-шаг** → инсталлятор не может клонировать worker. Плюс release `hub-artifacts-v1` сейчас **недоступен (404)** |
| 5 | **workflows** | `0d51107d58f9774fb761fca7319bdeb637b02a18c0f8f92dfec713c97beca738` | `0d51107d58f9774fb761fca7319bdeb637b02a18c0f8f92dfec713c97beca738` (**без изменений**) | — (tree идентичен) | W2: дерево пин == дерево цели | ничего | — (менять не нужно) |
| 6 | **install-manifests** | `46f3c26a4fd73ae0b70c7f4eb46bff74efb3ef1ba60d2becbe3a7d0393f1f3e3` | `46f3c26a4fd73ae0b70c7f4eb46bff74efb3ef1ba60d2becbe3a7d0393f1f3e3` (**без изменений**) | — (tree идентичен) | W2: дерево пин == дерево цели | ничего | — (менять не нужно) |

### 2.3 Прод-образы (ghcr) — когда применятся

| # | Образ | Текущий production digest | После CI (цель) | Когда применится |
|---|---|---|---|---|
| 7 | `ghcr.io/animastor/animastor-backend` | `e8152778e1f00d09c9436ff295eeada7248fef8f9823f727e728a2c79a35c9f9` | новый digest (записывается из run summary CI) | **не в G3** — отдельным действием (фаза H/I2) с обновлением `BACKEND_IMAGE` в `deploy/.env` |
| 8 | `ghcr.io/animastor/animastor-gpu-hub` | `daf510ff8e6d713bf9e2e2caebe11e590f61a896e30cb9aec7e7be79672be2d0` | новый digest (записывается из run summary CI) | **не в G3** — отдельным действием с обновлением `GPU_HUB_IMAGE` в `deploy/.env` |

> **Важно (разделение G3 ≠ применения):** публикация в G3 только создаёт новые
> immutable-теги/образы и обновляет lock. **Рабочие контейнеры НЕ трогаются.**
> Смена `*_IMAGE`-пинов в `deploy/.env` и `up` — отдельное, согласованное окно
> (фаза H/I2 по runbook), с откатом на текущие digest `e8152778…`/`daf510ff…`.

---

## 3. Что утвердить для G2/C4 (гейт «да» владельца)

Одним решением подтвердить:

1. **Цели-источники:** worker → `b3f94f42…`, backend → `a7a8c463…` (§2.1 №1–2).
2. **Состав republish (меняется):** worker-bundle (`417c0ad4…`) + installer-src
   (`ff27e291…`/0.1.1) — §2.2 №3–4.
3. **Состав «без изменений» (подтвердить, не трогать):** workflows + install-manifests — §2.2 №5–6.
4. Что открыть окно **G3** для: `--write-lock` → push (bare+github, FF-only) →
   CI `workflow_dispatch` → запись новых digest → публикация (D4).

**Это и есть закрытие C4.** Без пунктов 1–3 фаза D/публикация закрыта.
Без пункта 4 — «да» на цели есть, но окно исполнения нет.

---

## 4. Что после «да» требует окна G3 (push, CI, публикация)

Порядок (runbook §3 фаза D, не объединять с E2E и cutover):

1. **D1 repin:** `node scripts/stage-artifacts.cjs --write-lock --worker <b3f94f42> --backend <a7a8c463>` (в gpu-hub-репо) → ревью diff (только `sources.*` + `worker-bundle`/`installer-src`) → verify exit 0 → commit **без push**.
2. **D2 push:** `git push origin main` (bare) → проверки → `git push github main` (FF-only). Референсы bare зафиксировать ДО push.
3. **D3 CI:** GitHub → `gpu-hub-ghcr-release` → `workflow_dispatch` с immutable-тегом (выбор тега — владелец, напр. `v0.2.0`) → записать digest из run summary.
4. **D4 публикация** исправленного installer-src (см. §5).
5. **D5:** новые digest — **только в `deploy/.env`** (черновик), прод-пины не трогать.

**Не входит в G3:** смена работающих контейнеров, `up`, E2E, certbot.

---

## 5. Что относится только к D4 (выпуск исправленного installer-src)

- **Источник упаковки:** backend-repo @ `a7a8c463` (404 уже исправлен) — verified (§2.2 №4).
- **Исправляемый актив:** только `installer-src-v1.zip` (tree `ff27e291…`/0.1.1).
  `worker-bundle`/`workflows`/`install-manifests` **не публиковать заново** (нет технической необходимости).
- **Механика (выбор владельца):** (i) новый immutable release/tag (рекомендуется, т.к. тела релизов immutable) или (ii) перезаливка; **до** замены — архив старого актива (`ae589c10…`) в `backups/release-archives/` (аддитивно).
- **После публикации:** обновить `sha256_asset` в L1 tool-ом, повторить `--check` + скачивание (4/4 MATCH).
- **Замечание:** release `hub-artifacts-v1` сейчас отдаёт 404 публично → republish дополнительно восстанавливает доступность, а не только чинит 404-URL.

---

## 6. Что можно отложить, не нарушая работу текущего production

| Что | Почему можно отложить |
|---|---|
| Применение новых прод-образов (смена `*_IMAGE` в `deploy/.env` + `up`) | G3 только публикует; текущие digest `e8152778…`/`daf510ff…` работоспособны. Применение — отдельное окно (H/I2) с откатом |
| E2E (G5) | `E2E_WORKSPACE_ID` unset, 0 воркеров → prerequisites красные; конвейер генерации работает на текущих пинах. Отдельное окно владельца |
| Commit mono `index.html` (M3) | Живой сайт уже == web-канону (`a1900f4e…`); commit = фаза J (решение владельца) |
| Commit `deploy/` в backend-repo | Рабочие файлы на месте и функционируют; коммит — гигиена git, не влияет на runtime |
| Метки pg/redis/gpu-hub (исторические config_files) | Косметика; проект `animastor` управляет корректно |
| Удаление mono-стека / старых образов | Точка невозврата; держать ≥7 дней как rollback (runbook J3) — запрещено без отдельного решения |

---

## 7. Запреты (соблюдены на этом этапе)

Не выполнялось: `git commit`/`push`/`--force`/`update-ref`; `--write-lock` в
рабочих репо; публикация релизов; запуск CI; repin; смена lock-файлов; любые
изменения runtime/`up`/`stop`; E2E-dispatch; certbot; правка `.env`/proxy/DNS.
Все значения получены read-only (lock-файлы, `git rev-parse`, staging — из уже
выполненных проверок этапов 35/37, сегодня не пересчитывались заново).

---

## 8. Резюме для чата

**Готово к решению.** Таблица целей — в §2 отчёта. **6 целей для утверждения:**
2 коммита-источника (**worker `b3f94f42…`, backend `a7a8c463…`**) + 2 меняющихся
артефакта (**worker-bundle `417c0ad4…`, installer-src `ff27e291…`/0.1.1**) +
2 подтверждения «без изменений» (**workflows `0d51107d…`, install-manifests `46f3c26a…`**).
Текущий production не изменился (пины `e8152778…`/`daf510ff…`, живой бандл
`480af146…`, lock `069b62d9…`/`2a221e3b…`), deploy-runtime здоров (200/200/200),
rollback через monorepo цел. **Блокеры:** G2/C4 (это «да» на список выше) → G3
(окно push/CI/publish) → D4 (выпуск исправленного installer-src; выбор «новый
immutable release vs перезаливка» — владелец); отдельно G5 (E2E, нет workspace/воркеров).
Применение новых образов в production и E2E — **не** в G3, отдельные окна.
После «да» — одним согласованным окном G3+D4 закрываются repin/публикация, не трогая работающий runtime.
Отчёт: `/home/animastor/reorg-2026-10-12/38-g2-owner-approval.md`.
