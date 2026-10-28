# Stage 105 — Prepare and verify backend approval commit

**Дата:** 2026-10-21 (UTC)
**Итог:** **PASS** — approval-коммит `53ce5045` создан строго по проектному шаблону
(8 предыдущих `approve`-коммитов); provenance-gate **подтверждён локальной симуляцией**
по фактической логике workflow. Push/dispatch/deploy **не выполнялись**.

---

## 1. Входные данные (перечитаны перед работой)

- Отчёт Stage 104 и фактический `.github/workflows/backend-ghcr-release.yml` (207 строк,
  последняя правка `82c80afd`): строка 56 `APPROVED_COMMIT`, gate-логика строк 71–91
  (`HEAD == requested` → `APPROVED_COMMIT` в fetch-истории [depth 10] →
  `git diff --quiet $APPROVED_COMMIT HEAD -- backend/`), триггер `workflow_dispatch` only.
- Шаблон 8 предыдущих approve-коммитов (`82d2f547`…`82c80afd`): **каждый — ровно 1 файл,
  1+/1−** (только строка env), сообщение `ci(backend): approve <short> backend tree for
  GHCR release (stage N)`, утверждается **предыдущий** код-коммит.
- Состояние до: `main` @ `78e8f1ae`, ahead 4; 7 прежних dirty-записей; тега `deploy-78e8f1a`
  нет ни локально, ни в origin (0 remote tags).

## 2. Release commit и backend tree — вычислены git-командами (не предположения)

| Параметр | Команда | Значение |
|---|---|---|
| Release commit (tip, содержит все 4 коммита) | `git rev-parse main` | **`78e8f1ae4bb581f52b736bc64e5ae603dedab839`** |
| Коммиты в релизе | `git log origin/main..main` | `fae1beed6…`, `e4255524e…`, `0e50e23c9…`, `78e8f1ae4…` (4, линейно) |
| **Backend tree SHA** (будет проверяться gate'ом) | `git rev-parse main:backend` | **`3ecfa69a44b64cc64c41e88e9426d2c8fe57f0ae`** |
| Вклад 4 коммитов в `backend/` | `git diff --stat 82c80afd main -- backend/` | 10 файлов, 369+/15− (6 порт + 2 C3 + package.json/lockfile) |

## 3. Approval-коммит

| Поле | Значение |
|---|---|
| SHA | **`53ce504536c14413c2c5e7b8546d529db8ee2530`** |
| Сообщение | `ci(backend): approve 78e8f1ae backend tree for GHCR release (stage 105)` — 1:1 шаблон (short-SHA = git-аббревиатура `78e8f1ae`, как её показывает `git log --oneline`) |
| Родитель | **`78e8f1ae`** (релизный tip) — цепочка линейна, история не переписывалась |
| Diff | `.github/workflows/backend-ghcr-release.yml`: **1 файл, 1+/1−** — только `APPROVED_COMMIT: 74088d60…` → **`78e8f1ae4bb581f52b736bc64e5ae603dedab839`** (40-hex, формат идентичен 8 предыдущим правкам) |
| Staged-состав | проверен до коммита: только workflow-файл; 4 релизных коммита, dep-manifest, lockfile, `.env`, production-конфиг — **не менялись**; 7 dirty-файлов остались unstaged |
| Автор | `Animastor <…webhostbox.net>` (разовые `-c`) |
| Теги | `deploy-78e8f1a` **не создавался и не перемещался** (локальных и remote tags: только прежний `hub-artifacts-v1`) |

## 4. Верификация approval-коммита

| Проверка | Результат |
|---|---|
| Содержимое/родитель/SHA/tree | §2–§3 ✓ |
| Формат workflow | YAML валиден (`yaml.safe_load`); триггер по-прежнему `workflow_dispatch` only; `env.APPROVED_COMMIT` = релизный SHA ✓ |
| Отсутствие постороннего | `git show --stat`: 1 файл ✓; worktree: только 7 прежних dirty-записей ✓ |
| Соответствие шаблону | 1 файл/1 строка/env-only/сообщение `ci(backend): approve … (stage N)` — как все 8 предыдущих ✓ |

## 5. Симуляция provenance-gate (локальная копия фактической логики workflow)

`APPROVED_COMMIT` взят **из файла workflow** (`grep -oP`), не из предположений:

| Gate workflow | Симуляция | Результат |
|---|---|---|
| (а) `git cat-file -e "${APPROVED_COMMIT}^{commit}"` | коммит существует в истории | **OK** |
| (б) APPROVED_COMMIT в fetch-истории (depth 10) | `git merge-base --is-ancestor 78e8f1ae HEAD` — depth **1** при dispatch на approval-SHA | **OK** |
| (в) `git diff --quiet "${APPROVED_COMMIT}" HEAD -- backend/` | пусто: `3ecfa69a` (78e8f1ae) == дерево HEAD `53ce5045` | **OK** |
| (1) checkout HEAD == запрошенный commit | dispatch `commit=53ce5045…` → HEAD будет равен | **OK** |
| Доп. сценарий dispatch `commit=78e8f1ae` | diff backend/ пуст; APPROVED_COMMIT == checkout | **OK** |

**Provenance-gate примет одобренный релизный tree — подтверждено локально** (PASS, не предположение).
Единственные оставшиеся внешние условия — фактический push и dispatch (Этапы B–C Stage 104),
которые зависят от registry/tag-состояния на момент запуска и перепроверяются fail-closed самим workflow.

## 6. Git-состояние после (push не выполнялся)

| Проверка | Результат |
|---|---|
| Ветка / HEAD | `main` / `53ce5045`, **ahead 5** от `origin/main` (`82c80afd`) |
| Remote refs | `origin/main`=`github/main`=`82c80afd` — **не изменились** |
| Reflog | только `commit:` — push/merge/reset не выполнялись |
| Bare origin / GitHub | не отправлялось (`git ls-remote --tags origin` = 0) |
| Workflow в «удалённом environment» | APPROVED_COMMIT изменён **только в локальном коммите**; до push/dispatch ничего действующего не изменилось |
| Dirty-файлы (7) | сохранены, не очищены/не переключены |
| Production / `.env` / Compose / БД / данные / другие репо | не затрагивались (Stage 105 — только workflow-строка в локальном git) |

## 7. Следующие шаги (Stage 104 §6, решение владельца — НЕ выполнялись)

1. **Этап B:** `git push origin main` (+ github) → tip = `53ce5045`.
2. **Этап C:** `workflow_dispatch`: `commit=53ce504536c14413c2c5e7b8546d529db8ee2530`
   (или `78e8f1ae…`), `image_tag=deploy-78e8f1a` (тег свободен; workflow перепроверит).
   Остановка при любом PROVENANCE/SMOKE FAIL или «tag exists».
3. **Этап D (отдельное окно):** production-cutover через пин `BACKEND_IMAGE` + rollback
   `sha256:182b0252…` (Stage 104 §5).
