# Stage 108 — Safely fix bare-origin post-receive mirror hook

**Дата:** 2026-10-21 (UTC)
**Итог:** **PASS** — опасная команда `git push --mirror github` в post-receive hook bare-origin
`animastor-backend.git` заменена на протестированный в Stage 107 refspec
`git push github 'refs/heads/*:refs/heads/*'` (без `--mirror`/`--prune`/force).
До/после-состояние refs идентично (hook не запускался); backup сохранён;
production и все прочие репозитории не затрагивались.

---

## 1. Перед изменением (pre-flight)

### 1.1 Фактический hook — проверен по реальному пути

Уточнение к формулировке этапа: в `/home/animastor/repos/animastor.git/hooks/`
(монорепо `animastor`) **нет активного** post-receive — только
`post-receive.disabled` (отключён ещё 2026-08-22, тот же исходный текст,
sha256 `6a63cb14…`, remotes у этого bare отсутствуют). Активный опасный hook,
описанный в Stage 107 §A.1 и запустивший инцидент Stage 106, находится в
**`/home/animastor/repos/animastor-backend.git/hooks/post-receive`** — именно он
исправлен в этом этапе (соответствие Stage 107 §A.5, где путь указан явно).

| Параметр | Факт (до изменения) |
|---|---|
| Путь | `/home/animastor/repos/animastor-backend.git/hooks/post-receive` |
| mtime / size / mode | `2026-10-04 01:49:29Z` / 91 байт / `-rwxr-xr-x` (не менялся с Stage 104–107) |
| Содержимое | `#!/bin/sh` / `cd "$GIT_DIR" \|\| exit 1` / `echo "Mirroring to GitHub..."` / **`git push --mirror github`** |
| **SHA-256 (до)** | **`6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c`** |
| Ошибок обработки | `cd "$GIT_DIR" \|\| exit 1` — сохраняется; журналирование (`echo` перед push) — сохраняется |

### 1.2 Резервная копия

| Параметр | Значение |
|---|---|
| Файл | `hooks/post-receive.bak-2026-10-21-stage108` (отдельный inode `962014`, содержимое = оригинал байт-в-байт) |
| **SHA-256 (backup)** | **`6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c`** — идентичен действующему hook'у до правки ✓ |
| Сохранность | подтверждена после правки (`sha256sum` = `6a63cb14…`); **не удалялся и не перезаписывался** |

### 1.3 Снимки refs (до изменения; read-only)

**Bare origin** (`animastor-backend.git`):

```
refs/heads/main            53ce504536c14413c2c5e7b8546d529db8ee2530
refs/remotes/github/main   53ce504536c14413c2c5e7b8546d529db8ee2530   (stray remote-tracking)
```

**GitHub** (`git ls-remote github`, read-only):

```
53ce504536c14413c2c5e7b8546d529db8ee2530  HEAD
49c1de3925990eb85a08ed429de8b229f325ce9e  refs/heads/audit/draft-2026-10   ← сохранена ✓
53ce504536c14413c2c5e7b8546d529db8ee2530  refs/heads/main
82c80afd974a983cdf110e812dc32249f9696ef2  refs/remotes/github/main         (stray-ref)
```

### 1.4 Согласованность main и отсутствие divergence

`bare origin refs/heads/main` == `GitHub refs/heads/main` == **`53ce5045…`** == локальный
`HEAD` рабочей копии → **0/0 ahead/behind, divergence отсутствует**; состояние
**идентично Stage 107 §A.1** (refs не менялись между этапами). Блокеров pre-flight нет →
выполнено изменение.

## 2. Изменение

Заменена **только** строка команды синхронизации (и её echo-описание, отражающее новое
поведение); обработка ошибок `cd "$GIT_DIR" || exit 1`, shebang, структура и права
доступа (`-rwxr-xr-x`) сохранены. Новая команда **побайтово совпадает** с протестированной
в Stage 107 §A.3–A.4 (`git push github 'refs/heads/*:refs/heads/*'`, тесты 2–4 на временных
bare-репо: независимые GitHub-refs сохраняются; divergence → reject/fail-closed).

**Diff (backup → новый hook):**

```diff
--- post-receive.bak-2026-10-21-stage108
+++ post-receive
@@ -2,5 +2,5 @@

 cd "$GIT_DIR" || exit 1

-echo "Mirroring to GitHub..."
-git push --mirror github
+echo "Publishing branches to GitHub (non-pruning, fast-forward-only)..."
+git push github 'refs/heads/*:refs/heads/*'
```

| Параметр | После |
|---|---|
| **Изменённая команда** | `git push --mirror github` → **`git push github 'refs/heads/*:refs/heads/*'`** |
| SHA-256 (новый hook) | **`6e24ac6fdbe922faf03cfd8f04361fdb447968b919b6c8b2e32f3081ca01011d`** |
| mtime / size | `2026-10-21 12:44:47Z` / 153 байт |

## 3. Проверки

| # | Проверка | Результат |
|---|---|---|
| 1 | Синтаксис `sh -n hooks/post-receive` | **OK** (POSIX sh, git 2.34.1 на хосте) |
| 2 | Diff минимален и только в ожидаемых строках | ✓ (2 строки, §2) |
| 3 | Запрещённые токены: `--mirror`, `--prune`, `--force`, `-f` в hook'е | **0 совпадений** (grep пуст) |
| 4 | `audit/draft-2026-10` на GitHub | **`49c1de3925990eb85a08ed429de8b229f325ce9e` — неизменна** ✓ (ls-remote после правки) |
| 5 | Прочие GitHub refs | `HEAD`/`main`=`53ce5045…`, `refs/remotes/github/main`=`82c80afd…` — **не изменились** (набор и SHA идентичны §1.3) |
| 6 | Refs bare origin | `main`=`53ce5045…`, `refs/remotes/github/main`=`53ce5045…` — **не изменились** ✓ |
| 7 | Изменён только hook + его backup + отчёт | ✓ (§4); никаких других записей в bare |
| 8 | Hook **не вызывался** вручную; push/dispatch/build/deploy/restart **не выполнялись** | ✓ (reflog рабочей копии — только `commit:` Stage 105; новых ls-remote-побочных-эффектов нет; контейнеры `Up N days`, StartedAt прежние) |
| 9 | Backup не удалён/не изменён | ✓ (sha256 `6a63cb14…` подтверждён после правки) |
| 10 | 7 dirty-файлов | **нетронуты** (`git status` = тот же список, что в Stage 106–107) |

## 4. Границы — соблюдены

| Ограничение | Статус |
|---|---|
| Push / dispatch / GHCR build/push / deploy / restart | **не выполнялись** |
| Refs / теги / remotes-конфигурация | **не изменялись** (bare: `config` не трогался; GitHub: только read-only `ls-remote`) |
| `.env` / Compose / БД / Redis / данные | **не изменялись** (`deploy/.env` mtime = `2026-10-19 06:31:53Z`; PG/redis healthy Up 8 weeks; контейнеры без рестартов) |
| 7 dirty-файлов | нетронуты |
| Прочие репозитории | **read-only**: монорепо- bare `animastor.git` не тронут (`post-receive.disabled` = `6a63cb14…`, config без remotes); рабочие копии `animastor` (HEAD `088f3fa9`, dirty 2 — прежние), `animastor-web`, `-docs`, `-gpu-hub`, `-tools`, `-worker`, `-android` — HEAD/dirty не менялись |
| Единственные записи на диск | `hooks/post-receive` (правка), `hooks/post-receive.bak-2026-10-21-stage108` (backup), отчёт Stage 108 |

## 5. Наблюдение вне объёма (read-only, для владельца)

Идентичный опасный hook `git push --mirror github` (та же sha256 `6a63cb14…`) **активен**
ещё в четырёх bare-репозиториях:
`animastor-android.git`, `animastor-gpu-hub.git`, `animastor-web.git`, `animastor-worker.git`.
Они **не изменялись** (Stage 108 ограничен backend bare-origin). Риск тот же класс, что и
в Stage 106/107: следующий push в любой из этих bare origins при наличии GitHub-only refs
или дивергенции может удалить/перезаписать их. Рекомендуемый отдельный этап — такая же
замена на `git push github 'refs/heads/*:refs/heads/*'` с тем же шаблоном backup+diff
(одобрение владельца).

## 6. Что проверять при первом реальном запуске (следующий push в origin, вне Stage 108)

1. В логе hook'а: `Publishing branches to GitHub (non-pruning, fast-forward-only)...`
   и `main -> main` **без** строк `[deleted]` и `forced update`.
2. `git ls-remote github` до/после: изменена **только** `refs/heads/main`;
   `refs/heads/audit/draft-2026-10` = `49c1de39…` и `refs/remotes/github/main` = `82c80afd…` на месте.
3. При дивергенции: `! [rejected] … (fetch first)` — ожидаемое fail-closed поведение, не force'ить.

## 7. Итог

| Артефакт | Значение |
|---|---|
| Статус | **PASS** |
| Изменённая команда | `git push --mirror github` → `git push github 'refs/heads/*:refs/heads/*'` |
| SHA-256 backup (оригинал) | `6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c` |
| SHA-256 новый hook | `6e24ac6fdbe922faf03cfd8f04361fdb447968b919b6c8b2e32f3081ca01011d` |
| GitHub refs | без изменений: `main`=`53ce5045…`, `audit/draft-2026-10`=`49c1de39…`, stray `refs/remotes/github/main`=`82c80afd…` |
| Push/deploy/restart | **не выполнялись** |
| Остаточные действия (владелец) | отдельный этап для 4 аналогичных hook'ов (§5); производственный cutover остаётся Stage 107 §C (отдельное окно) |
