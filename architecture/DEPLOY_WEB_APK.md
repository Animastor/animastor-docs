# Выкладка web-фронтенда, Android APK и зеркала документации

**Date:** 2026-11-01 (обновлено 2026-11-02 — раздел deploy-docs.sh)
**Status:** ACTIVE — регламент и инструменты выкладки фронтов и docs

---

## Общие правила

- Выкладка web-фронтенда (`www/app`) и Android APK (`data/downloads` +
  `version.json`) — **только** скриптами из `animastor-deploy`:
  - `scripts/deploy-web.sh <commit> [--dry-run]`
  - `scripts/deploy-apk.sh <apk> [--dry-run]`
- Ручной `rsync`/`cp` в `www/app` и `data/downloads` запрещён.
- Зеркало документации (`www/docs`, `animastor.org/docs`) — **только**
  скриптом `scripts/deploy-docs.sh [--dry-run]`; ручной `rsync`/`cp` в
  `www/docs` запрещён (секция «Выкладка docs» в `prod/agents/AGENTS.md`).
- `version.json` выкладывается только коммитом в `animastor-site`
  (из worktree в `work/`) с последующим `git -C www/site pull --ff-only`;
  `rsync`/`cp` в `www/site` запрещён.
- Коммиты в `animastor-deploy` делаются из worktrees в `work/`, не из `src/`.
- Все три скрипта: `set -euo pipefail`; любая ошибка — стоп до выкладки;
  в конце печатаются итог и команда отката.
- Режим `--dry-run` прогоняет все проверки без выкладки. В `deploy-apk.sh`
  dry-run накапливает ошибки всех проверок (а не падает на первой) и
  возвращает ненулевой код, если хотя бы одна не пройдена; `git pull` в
  `www/site` при этом не выполняется (это уже выкладка) — только `fetch`
  и сравнение `HEAD` с `origin/main`.

## deploy-web.sh <commit>

Выкладывает web-фронтенд (`app.animastor.org`) из чистого клона
`src/animastor-web` с HEAD = `<commit>`.

1. Проверка `src/animastor-web`: `git status --porcelain` пуст, HEAD = `<commit>`
   (иначе стоп — не совпадает запрошенный коммит).
2. Сборка: `app-web-rebuild.sh` (npm ci, typecheck, vite build → `dist/`).
3. Бэкап: `cp -a www/app backups/www-app-pre-<commit7>-<UTC>/`
   (UTC — `YYYYmmddHHMMSS`).
4. rsync в три шага, каталог `www/app` **не подменяется** (nginx держит
   bind-mount):
   ```bash
   rsync -a --exclude index.html dist/ www/app/
   rsync -a dist/index.html www/app/index.html
   rsync -a --delete dist/ www/app/
   ```
   Порядок гарантирует, что старые ассеты доступны, пока новый `index.html`
   ещё ссылается на старый бандл, и наоборот.
5. Проверки:
   - `diff -r dist www/app` пуст;
   - `docker exec animastor-proxy sha256sum …/dist/index.html` = sha256
     локального `dist/index.html`;
   - `https://app.animastor.org/` → 200;
   - JS-бандл, извлечённый из `index.html` (`assets/*.js`), → 200.

**Откат:**
```bash
rsync -a --delete /home/animastor/backups/www-app-pre-<commit7>-<UTC>/ \
      /home/animastor/www/app/
```

## deploy-apk.sh <apk>

Выкладывает Android APK (`https://animastor.org/downloads/animastor-android-latest.apk`).

Порядок подготовки (скриптом не выполняется, делается заранее):
1. `apk-build.sh release` в `animastor-android` (обязательно: `lintVital`
   ловит ошибки разметки; выкладка debug APK запрещена).
2. Коммит `version.json` (version = versionName нового APK, releaseDate,
   notes) в `animastor-site` из worktree в `work/`, push origin.
3. Запуск `deploy-apk.sh <apk>` — скрипт делает `git -C www/site pull --ff-only`.

Проверки и действия:
1. `apksigner verify --print-certs`: SHA-256 сертификата подписи =
   `aa65465afd300876493037735ce47288f526c588609902bcf93059bcb1fefd0b`
   (ключ Animastor; чужой ключ — стоп).
2. `aapt2 dump badging`: versionCode нового APK **строго больше** versionCode
   APK, лежащего в `data/downloads` (то, что реально получают пользователи).
3. `www/site`: чистый, `git pull --ff-only`; `downloads/version.json`
   (version) = versionName нового APK — иначе стоп (bump делается коммитом
   в `animastor-site` заранее).
4. Бэкап: `cp -a data/downloads/animastor-android-latest.apk
   backups/apk-pre-<versionName>-<UTC>/`.
5. Атомарная замена: копия во временный файл в `data/downloads` + `mv`.
6. Проверка отдачи: `curl https://animastor.org/downloads/animastor-android-latest.apk`
   → 200, sha256 и размер = исходному APK.

**Откат APK:**
```bash
cp -a /home/animastor/backups/apk-pre-<versionName>-<UTC>/animastor-android-latest.apk \
      /home/animastor/data/downloads/.animastor-android-latest.apk.rollback
mv -f /home/animastor/data/downloads/.animastor-android-latest.apk.rollback \
      /home/animastor/data/downloads/animastor-android-latest.apk
```
**Откат version.json:** revert коммита в `animastor-site`, затем
`git -C www/site pull --ff-only`.

## deploy-docs.sh [--dry-run]

Выкладывает зеркало документации `www/docs`
(`https://animastor.org/docs/` — nginx location `/docs/`, `root
/usr/share/nginx` → bind-mount `/home/animastor/www/docs:/usr/share/nginx/docs:ro`)
из чистого клона `src/animastor-docs`. Каталог `www/docs` скрипт не
подменяет и не пересоздаёт — его держит nginx.

1. Проверки (до любых изменений): `git fetch` в `src/animastor-docs`,
   `git status --porcelain` пуст, ветка `main`, `HEAD = origin/main`;
   контейнер `animastor-proxy` запущен. Печатается коммит.
2. `--dry-run`: печатается
   `rsync -ain --delete --exclude .git --exclude history src/animastor-docs/
   www/docs/` и его вывод, разбитый на **список изменений** и отдельно
   **список удалений**; ничего не меняется.
   Важно: `rsync -a -n` без `-v`/`-i` не печатает НИЧЕГО даже при
   различающихся файлах и «pending deletions» — пустой dry-run не
   означает «различий нет».
3. Без флага: бэкап `cp -a www/docs backups/www-docs-pre-<commit7>-<UTC>/`,
   затем `rsync -a --delete --exclude .git --exclude history
   /home/animastor/src/animastor-docs/ /home/animastor/www/docs/`.
   Исключения: `.git` (внутренности клона), `history/` (отчёты
   реорганизации — зеркало по спецификации «копия репо без `.git` и
   `history`», `INVENTORY_REPORT_PHASE2A.md`; в зеркале их никогда не
   было, docs-browser их не индексирует).
4. Проверки после выкладки: `diff -rq -x .git -x history src www/docs`
   пуст; `sha256 CHANGELOG.md` в контейнере `animastor-proxy` = хосту;
   `https://animastor.org/docs/` и `https://animastor.org/docs/CHANGELOG.md`
   → 200.
5. В конце печатается команда отката; любая ошибка — стоп, после провала
   проверок дальнейшие шаги не выполняются (при обрыве после бэкапа
   trap печатает откат).

**Откат:**
```bash
rsync -a --delete /home/animastor/backups/www-docs-pre-<commit7>-<UTC>/ \
      /home/animastor/www/docs/
```

## Инфраструктура

- nginx (`animastor-proxy`) раздаёт `www/app`, `www/site` и зеркало
  документации `www/docs` через bind-mount —
  перезапуск контейнера при выкладке не нужен.
- APK отдаётся из `data/downloads` по точному location
   `/downloads/animastor-android-latest.apk`.
- `version.json` отдаётся из `www/site` (git-клон `animastor-site`).

## Проверено (2026-11-01, dry-run на текущих версиях)

- `deploy-web.sh 5c595e6 --dry-run` — все проверки пройдены (exit 0);
  выкладка не выполнялась.
- `deploy-apk.sh <app-release.apk 0.2.3/versionCode 5> --dry-run` —
  подпись OK, version.json OK, но versionCode 5 не > 5 (уже на сайте) →
  exit 1, «выкладка запрещена». Ожидаемое срабатывание защиты.
