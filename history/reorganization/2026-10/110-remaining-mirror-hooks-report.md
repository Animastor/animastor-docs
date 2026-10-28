# Stage 110 — Audit and safely fix mirror hooks in remaining repositories

**Дата:** 2026-10-21 (UTC)
**Итог:** **PASS × 4** — опасная команда `git push --mirror github` в post-receive hook'ах всех
четырёх оставшихся bare-репозиториев (Android, GPU Hub, Web, Worker) заменена на
протестированный в Stage 107/108 безопасный refspec
`git push github 'refs/heads/*:refs/heads/*'` (без `--mirror`/`--prune`/force).
Backup'ы сохранены; до/после-состояние GitHub refs **идентично** (hook'и не запускались);
независимые GitHub-refs (stray `refs/remotes/github/*` и теги) **сохранены**; backend-hook
Stage 108 не изменялся; push/CI/GHCR/deploy/restart **не выполнялись**.

---

## 1. Pre-flight (до изменения)

### 1.1 Фактические hook'и — все четыре идентичны оригиналу backend (Stage 108)

| Репозиторий | Путь hook'а | mtime | size / mode | SHA-256 (до) |
|---|---|---|---|---|
| Android | `repos/animastor-android.git/hooks/post-receive` | `2026-10-04 01:49:30Z` | 91 / `-rwxr-xr-x` | `6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c` |
| GPU Hub | `repos/animastor-gpu-hub.git/hooks/post-receive` | `2026-09-06 16:10:46Z` | 91 / `-rwxrwxr-x` | `6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c` |
| Web | `repos/animastor-web.git/hooks/post-receive` | `2026-10-04 01:49:30Z` | 91 / `-rwxr-xr-x` | `6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c` |
| Worker | `repos/animastor-worker.git/hooks/post-receive` | `2026-10-04 01:49:30Z` | 91 / `-rwxr-xr-x` | `6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c` |

Содержимое всех четырёх (байт-в-байт = `post-receive.bak-2026-10-21-stage108` backend'а):

```sh
#!/bin/sh

cd "$GIT_DIR" || exit 1

echo "Mirroring to GitHub..."
git push --mirror github
```

SHA-256 совпадает с исходным backend-hook'ом Stage 108 (`6a63cb14…`) — та же
шаблонная конфигурация. Активность: файл `post-receive` (не `.disabled`) во всех
четырёх bare-репо; монорепо `animastor.git` содержит только `post-receive.disabled`
(`6a63cb14…`, не тронут).

### 1.2 Remotes и назначения (соответствуют ожидаемым)

| Репозиторий | Remote `github` (push URL) | Ожидание | Статус |
|---|---|---|---|
| Android | `git@github.com:Animastor/animastor-android.git` | `Animastor/animastor-android` | ✓ |
| GPU Hub | `git@github.com:Animastor/animastor-gpu-hub.git` | `Animastor/animastor-gpu-hub` | ✓ |
| Web | `git@github.com:Animastor/animastor-web.git` | `Animastor/animastor-web` | ✓ |
| Worker | `git@github.com:Animastor/animastor-worker.git` | `Animastor/animastor-worker` | ✓ |

Лишних/неожиданных remote'ов нет — у каждого bare ровно один remote `github`.
Наблюдение (не изменялось, вне scope): в `config` GPU Hub дополнительно присутствует
`mirror = true` в секции remote — влияет только на дефолтный fetch-refspec, на
явный push-refspec `'refs/heads/*:refs/heads/*'` не влияет; конфигурация remotes
по ограничениям этапа **не тронута**.

### 1.3 Снимки refs (до изменения; read-only)

| Репозиторий | Bare origin refs | GitHub (`git ls-remote github`, read-only) | Дивергенция |
|---|---|---|---|
| Android | `refs/heads/main` = `92a56c0d…`<br>`refs/remotes/github/main` = `92a56c0d…` | `HEAD`/`refs/heads/main` = `92a56c0d…`<br>**`refs/remotes/github/main` = `860bd8bd…`** ← независимый (stray) | нет: bare = GitHub = рабочая `92a56c0d…` |
| GPU Hub | `refs/heads/master` = `0f489c7b…`<br>`refs/remotes/github/master` = `0f489c7b…` | `HEAD`/`refs/heads/master` = `0f489c7b…`<br>**`refs/remotes/github/master` = `ecefd0b7…`** ← независимый<br>**`refs/tags/hub-artifacts-v0.1.1` = `0f489c7b…`** ← тег только на GitHub | нет: bare = GitHub = рабочая `0f489c7b…` |
| Web | `refs/heads/main` = `fee40509…`<br>`refs/remotes/github/main` = `fee40509…` | `HEAD`/`refs/heads/main` = `fee40509…`<br>**`refs/remotes/github/main` = `fbc93662…`** ← независимый | нет: bare = GitHub = рабочая `fee40509…` |
| Worker | `refs/heads/main` = `b3f94f42…`<br>`refs/remotes/github/main` = `b3f94f42…` | `HEAD`/`refs/heads/main` = `b3f94f42…`<br>**`refs/remotes/github/main` = `73671b6b…`** ← независимый<br>**`refs/tags/worker-bundle-v2.1.1` = `618f87a6…`** ← тег только на GitHub | нет: bare = GitHub = рабочая `b3f94f42…` |

Риск класса Stage 106/107 подтверждён: `--mirror` при следующем push **удалил бы**
независимые stray-refs на всех четырёх GitHub-репозиториях, а на GPU Hub и Worker —
также теги `hub-artifacts-v0.1.1` и `worker-bundle-v2.1.1` (в bare-репо локальных
тегов нет: `git tag -l` пуст). Ни один из четырёх bare не содержал GitHub-only веток.

### 1.4 Backend (эталон Stage 108) — read-only, не изменялся

`repos/animastor-backend.git/hooks/post-receive` = `6e24ac6f…` (исправленный),
backup `post-receive.bak-2026-10-21-stage108` = `6a63cb14…` — без изменений.

## 2. Изменение

Для каждого из четырёх репозиториев:

1. Backup: `hooks/post-receive.bak-2026-10-21-stage110` (`cp -p`, отдельный inode,
   содержимое = оригинал байт-в-байт, mtime оригинала сохранён).
2. Заменена **только** строка команды синхронизации (и её echo-описание);
   shebang, `cd "$GIT_DIR" || exit 1`, структура и права доступа
   (`-rwxr-xr-x` для Android/Web/Worker; `-rwxrwxr-x` для GPU Hub) сохранены.

**Diff (backup → новый hook; одинаков для всех четырёх, идентичен Stage 108 §2):**

```diff
--- post-receive.bak-2026-10-21-stage110
+++ post-receive
@@ -2,5 +2,5 @@

 cd "$GIT_DIR" || exit 1

-echo "Mirroring to GitHub..."
-git push --mirror github
+echo "Publishing branches to GitHub (non-pruning, fast-forward-only)..."
+git push github 'refs/heads/*:refs/heads/*'
```

Новый hook **побайтово совпадает** с исправленным backend-hook'ом Stage 108
(`cmp` = идентичны) — та же протестированная команда.

| Репозиторий | Изменённая команда | SHA-256 (backup, оригинал) | SHA-256 (новый hook) | mtime/size (после) |
|---|---|---|---|---|
| Android | `git push --mirror github` → `git push github 'refs/heads/*:refs/heads/*'` | `6a63cb14…130c` | `6e24ac6fdbe922faf03cfd8f04361fdb447968b919b6c8b2e32f3081ca01011d` | `2026-10-21 13:47:48Z` / 153 |
| GPU Hub | `git push --mirror github` → `git push github 'refs/heads/*:refs/heads/*'` | `6a63cb14…130c` | `6e24ac6fdbe922faf03cfd8f04361fdb447968b919b6c8b2e32f3081ca01011d` | `2026-10-21 13:47:48Z` / 153 |
| Web | `git push --mirror github` → `git push github 'refs/heads/*:refs/heads/*'` | `6a63cb14…130c` | `6e24ac6fdbe922faf03cfd8f04361fdb447968b919b6c8b2e32f3081ca01011d` | `2026-10-21 13:47:48Z` / 153 |
| Worker | `git push --mirror github` → `git push github 'refs/heads/*:refs/heads/*'` | `6a63cb14…130c` | `6e24ac6fdbe922faf03cfd8f04361fdb447968b919b6c8b2e32f3081ca01011d` | `2026-10-21 13:47:48Z` / 153 |

## 3. Проверки (для каждого из четырёх)

| # | Проверка | Результат |
|---|---|---|
| 1 | Синтаксис `sh -n hooks/post-receive` | **OK** × 4 (POSIX sh) |
| 2 | Diff минимален и только в ожидаемых строках | ✓ × 4 (ровно 2 строки, §2) |
| 3 | Запрещённые токены `--mirror`, `--prune`, `--force`, `-f` в hook'е | **0 совпадений** × 4 (grep пуст) |
| 4 | Новый hook байт-в-байт = исправленному backend-hook'у Stage 108 | ✓ × 4 (`cmp`) |
| 5 | GitHub refs после правки (`git ls-remote github`, read-only) | **набор, SHA и порядок идентичны §1.3** × 4 |
| 6 | Независимые GitHub-refs сохранены | ✓ `860bd8bd…` (android), `ecefd0b7…` + `hub-artifacts-v0.1.1` (gpu-hub), `fbc93662…` (web), `73671b6b…` + `worker-bundle-v2.1.1` (worker) |
| 7 | Refs bare origin после правки | **не изменились** × 4 (набор и SHA идентичны §1.3) |
| 8 | Изменён только hook + его backup + отчёт | ✓ × 4: `find -newermt '2026-10-21 13:40'` по bare-репо находит **ровно** `hooks/post-receive` (backup'и имеют сохранённый `cp -p` mtime оригинала); backend-репо — 0 изменённых файлов |
| 9 | Hook **не вызывался** вручную; push/CI dispatch/GHCR build-push/deploy/restart **не выполнялись** | ✓ ls-remote до/после идентичен (никаких push-побочных-эффектов); рабочие копии: HEAD прежние (`92a56c0d…`, `0f489c7b…`, `fee40509…`, `b3f94f42…`), `git status --porcelain` пуст; контейнеры: `animastor-pg`/`animastor-redis` Up 8 weeks, `gpu-hub` Up 9 days, `animastor-proxy` Up 2 days, `animastor-backend` Up 33 min (cutover Stage 109, 13:15Z — до этапа) — без рестартов |
| 10 | Backup не удалён/не изменён | ✓ sha256 `6a63cb14…` подтверждён после правки × 4 |
| 11 | Backend-hook Stage 108 и его backup не тронуты | ✓ (`6e24ac6f…` / `6a63cb14…`) |
| 12 | Монорепо `post-receive.disabled` не тронут | ✓ (`6a63cb14…`) |

## 4. Границы — соблюдены

| Ограничение | Статус |
|---|---|
| Push / CI dispatch / GHCR build/push / deploy / restart | **не выполнялись** |
| Git refs / теги / remotes / конфигурация (bare и GitHub) | **не изменялись** (bare `config` не трогался, в т.ч. `mirror = true` GPU Hub; GitHub — только read-only `ls-remote`) |
| `.env` / Compose / БД / Redis / данные / код | **не изменялись** |
| Backend-hook (Stage 108) | **не изменялся** |
| Резервные копии | созданы, **не удалялись** |
| Dirty-файлы | рабочие копии четырёх репозиториев чисты (`porcelain` пуст) — нетронуты |
| Единственные записи на диск | `hooks/post-receive` × 4 (правка), `hooks/post-receive.bak-2026-10-21-stage110` × 4 (backup), этот отчёт |

## 5. Что проверять при первом реальном запуске (следующий push в origin, вне Stage 110)

1. В логе hook'а: `Publishing branches to GitHub (non-pruning, fast-forward-only)...`
   и `main -> main` (или `master -> master` для GPU Hub) **без** строк `[deleted]`
   и `forced update`.
2. `git ls-remote github` до/после: изменена **только** `refs/heads/main` (или
   `master`); stray `refs/remotes/github/*` и теги `hub-artifacts-v0.1.1` /
   `worker-bundle-v2.1.1` — на месте.
3. При дивергенции: `! [rejected] … (fetch first)` — ожидаемое fail-closed
   поведение, не force'ить.

## 6. Итог

| Репозиторий | Статус | Backup SHA-256 | Новая команда | Независимые GitHub-refs (сохранены) |
|---|---|---|---|---|
| `animastor-android.git` | **PASS** | `6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c` | `git push github 'refs/heads/*:refs/heads/*'` | `refs/remotes/github/main` = `860bd8bd…` |
| `animastor-gpu-hub.git` | **PASS** | `6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c` | `git push github 'refs/heads/*:refs/heads/*'` | `refs/remotes/github/master` = `ecefd0b7…`; `refs/tags/hub-artifacts-v0.1.1` = `0f489c7b…` |
| `animastor-web.git` | **PASS** | `6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c` | `git push github 'refs/heads/*:refs/heads/*'` | `refs/remotes/github/main` = `fbc93662…` |
| `animastor-worker.git` | **PASS** | `6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c` | `git push github 'refs/heads/*:refs/heads/*'` | `refs/remotes/github/main` = `73671b6b…`; `refs/tags/worker-bundle-v2.1.1` = `618f87a6…` |

SHA-256 новых hook'ов (все четыре, байт-в-байт = backend Stage 108):
`6e24ac6fdbe922faf03cfd8f04361fdb447968b919b6c8b2e32f3081ca01011d`.

GitHub refs: до/после **без изменений** × 4 (read-only `ls-remote` идентичен).
Push / CI dispatch / GHCR / deploy / restart: **не выполнялись**.
