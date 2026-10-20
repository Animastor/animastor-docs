# Animastor — Этап 31: M3 URL APPROVAL

- Дата: 2026-10-12
- Режим: **только read-only проверка и подготовка списка на утверждение.**
  Запись в production, замена файлов, reload/restart, правки Compose,
  `git commit`/`git push`, действия с другими сервисами — **не выполнялись**.
  Сетевые запросы — только `curl` GET/HEAD (наш сайт и публичные GitHub-страницы/API).
- Источники (прочитаны): `30-m3-cutover-preparation-report.md`;
  значения взяты из реальных файлов — `frontends/website/index.html` mono
  и `git show fbc93662:frontends/website/index.html` в web-репо.
- Итог: **PASS. Проверено 4 ссылки (4/4)** — таблица ниже готова к утверждению
  владельцем (это и есть гейт **G1**). Production не изменён: живой сайт по-прежнему
  отдаёт `276a5fc4…`, health 200/200, контейнеры не перезапускались.

---

## 0. Краткий вывод

Четыре ссылки на живом сайте ведут на несуществующий/закрытый репозиторий
`Animastor/animastor` (404). Целевые URL из канонического web-репо на SHA
`fbc93662` ведут на публичный репозиторий `Animastor/animastor-web` (ветка
`main`) и его каталог `docs` — **проверено не только по коду 200, но и по
содержимому страницы и по GitHub API**. Ресурс = тот, что описывает текст ссылки.
Замена нужного файла — ровно 1 файл; атомарное переключение и откат к
`276a5fc4…` подготовлены (§3).

---

## 1. Таблица четырёх ссылок (на утверждение)

Источник «старый»: `/home/animastor/animastor/frontends/website/index.html`
(sha256 `276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c`,
режим 664, mono HEAD `465453df`, файл не изменён локально).
Источник «новый»: `git -C /home/animastor/animastor-web show
fbc93662035df84c8e103df0d0706800aa96cba1:frontends/website/index.html`
(sha256 `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c`).

| # | Строка в файле / расположение | Назначение ссылки и ожидаемая страница | Старый URL (production, сейчас) | HTTP старого | Новый URL (web @ fbc93662) | HTTP нового | Проверка «что именно за ресурс» (не только 200) |
|---|---|---|---|---|---|---|---|
| 1 | строка **143**, секция «Development» → карточка «GitHub repository →», подпись «The full source code of Animastor: backend, frontend, Android client, workers, and infrastructure» | корень публичного репозитория проекта (страница репо, ветка `main`, список файлов/README) | `https://github.com/Animastor/animastor` | **404** (`<title>Page not found · GitHub · GitHub</title>`) | `https://github.com/Animastor/animastor-web` | **200** | `<title>GitHub - Animastor/animastor-web · GitHub</title>`; на странице найдены `Animastor/animastor-web`, `tree/main`, `frontends`, `docs`, `README`; GitHub API `GET /repos/Animastor/animastor-web` → 200, `full_name=Animastor/animastor-web`, `default_branch=main`, `private=false`; старый `GET /repos/Animastor/animastor` → **404** (репо не существует/не опубликован) |
| 2 | строка **150**, секция «Development» → карточка «Docs folder →», подпись «Technical documentation for developers and LLMs: architecture, technical decisions…» | каталог `docs` репозитория в ветке `main` (список подкаталогов документации) | `https://github.com/Animastor/animastor/tree/master/docs` | **404** (та же страница «Page not found») | `https://github.com/Animastor/animastor-web/tree/main/docs` | **200** | `<title>animastor-web/docs at main · Animastor/animastor-web · GitHub</title>`; на странице найдены все 4 записи каталога: `05-frontend`, `08-mobile-web-migration`, `09-desktop-migration`, `architecture`; GitHub API `GET /repos/Animastor/animastor-web/contents/docs?ref=main` → 200, те же **4 entries**; этот же состав каталогов локально: `/home/animastor/animastor-web/docs/` = 4/4 совпадает; старый `tree/master/docs` → 404 (ветки `master` в публичном `Animastor/animastor` нет) |
| 3 | строка **176**, футер → ссылка «GitHub» | то же, что #1 (корень репозитория) | `https://github.com/Animastor/animastor` | **404** | `https://github.com/Animastor/animastor-web` | **200** | сверено теми же способами, что #1 (title + маркеры страницы + API); URL байт-в-байт идентичен #1 |
| 4 | строка **177**, футер → ссылка «Docs» | то же, что #2 (каталог `docs` в `main`) | `https://github.com/Animastor/animastor/tree/master/docs` | **404** | `https://github.com/Animastor/animastor-web/tree/main/docs` | **200** | сверено теми же способами, что #2 (title + 4 записи каталога + API + локальный `docs/`); URL байт-в-байт идентичен #2 |

Итого: **уникальных URL — 2 пары, позиций в HTML — 4; проверено 4/4.**
Статусы сняты сегодня `curl -sIL` (с redirect-follow и UA); содержимое —
`curl -sL` + проверка `<title>`/маркеров; существование ресурса — публичный
GitHub API без токена.

### 1.1 Почему 200 ≠ правильный ресурс — что дополнительно проверено

| Проверка | Новый URL | Результат |
|---|---|---|
| `<title>` страницы | `…/animastor-web` | `GitHub - Animastor/animastor-web · GitHub` ✓ (не «Page not found», не редирект на другой репо) |
| `<title>` страницы | `…/animastor-web/tree/main/docs` | `animastor-web/docs at main · Animastor/animastor-web · GitHub` ✓ (дерево именно `docs`, ветка именно `main`) |
| Фактические элементы дерева | `docs@main` | ровно 4 записи, совпадают с локальным `animastor-web/docs/` (4/4) ✓ |
| API-подтверждение владения/существования | `GET /repos/Animastor/animastor-web` | 200, `full_name` совпадает, `default_branch=main`, публичное ✓ |
| Контрольный отрицательный тест | `GET /repos/Animastor/animastor` | 404 → старый URL не «временно пуст», а указывает на несуществующий/неопубликованный репо ✓ |
| Нет `[404]`/fallback-контента на странице | оба новых | маркер «Page not found» отсутствует ✓ |

---

## 2. Соответствие контексту ссылок (что обещает текст — что получает пользователь)

| # | Текст/подпись на нашем сайте | Что реально откроется по новому URL |
|---|---|---|
| 1 | «GitHub repository →»: полный исходный код (backend, frontend, Android, workers, infrastructure) | репозиторий `Animastor/animastor-web`, дерево `main` содержит `frontends`, `docs`, README ✓ |
| 2 | «Docs folder →»: техническая документация (architecture, technical decisions, algorithms, workflows, planning notes) | каталог `docs@main`: `architecture`, `05-frontend`, `08-mobile-web-migration`, `09-desktop-migration` ✓ |
| 3/4 | футер «GitHub» / «Docs» | те же страницы, что 1/2 ✓ |

Расхождения между подписью и содержимым целей не найдено.

---

## 3. Подготовка выполнения M3

### 3.1 Достаточен ли один файл — перепроверено сегодня

```
diff -rq mono/frontends/website web/frontends/website
  → Files .../index.html .../index.html differ
  → Only in mono/.../downloads: animastor-android-latest.apk
  → Only in mono/...: .well-known
diff mono/.../index.html web/.../index.html | grep -c '^[<>]'  →  8  (4 пары строк)
```

- Единственное **содержательное** различие в git-трекаемых файлах — `index.html`
  (4 строки = ровно 4 ссылки из §1). Всё остальное в каталоге байт-идентично
  (включая `downloads/version.json` sha `8dbbfe10…`).
- `apk` и `.well-known` — runtime-файлы вне git, есть **только в mono**; M3 их
  не трогает (монтаж остаётся на mono) → **для M3 действительно достаточно 1 файла.**
- Все 9 локальных ресурсов, на которые ссылается новый index, существуют в
  mono-каталоге: `styles.css`, `site.js`, `logo.png`, `favicon-16.png`,
  `favicon-32.png`, `apple-touch-icon.png`, `library/index.html`,
  `downloads/version.json`, `downloads/animastor-android-latest.apk` — 9/9 OK.
  Новая версия страницы после замены ничего не «повесит» на несуществующие пути.

### 3.2 PRE-проверки (в окне, read-only; ABORT при любом отклонении)

```sh
# 1) контрольные суммы
sha256sum /home/animastor/animastor/frontends/website/index.html \
          /home/animastor/animastor-web/frontends/website/index.html
#    -> 276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c
#    -> a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c
# 2) diff ровно 4 пары строк
diff /home/animastor/animastor/frontends/website/index.html \
     /home/animastor/animastor-web/frontends/website/index.html | grep -c '^[<]'   # 4
# 3) web-репо: HEAD == fbc93662, worktree чист
git -C /home/animastor/animastor-web rev-parse HEAD   # fbc93662035df84c8e103df0d0706800aa96cba1
git -C /home/animastor/animastor-web status --porcelain   # пусто
# 4) mono: HEAD не сдвинут, по файлу нет локальных правок (иначе откат git неверен)
git -C /home/animastor/animastor rev-parse HEAD        # 465453df673016a4f3884b7ae25cddeebb052551
git -C /home/animastor/animastor status --porcelain -- frontends/website/index.html   # пусто
# 5) живой сайт ещё старый
curl -sSk --resolve animastor.org:443:127.0.0.1 https://animastor.org/ | sha256sum  # 276a5fc4…
curl -sSk -o /dev/null -w '%{http_code}\n' --resolve animastor.org:443:127.0.0.1 https://animastor.org/health       # 200
curl -sSk -o /dev/null -w '%{http_code}\n' --resolve animastor.org:443:127.0.0.1 https://animastor.org/gpu/health    # 200
# 6) 4 URL: старые 404, новые 200 (повтор в окне)
# 7) контейнеры не перезапускались (CreatedAt == baseline этапа 30)
docker ps --format '{{.Names}} {{.Status}}'
```

### 3.3 Точная команда замены (атомарное переключение)

Условия подтверждены: rename в одной FS; nginx без `open_file_cache`
(chapter 30 §1.2) → без reload; права файла 664 `animastor:animastor`,
каталог 775 `animastor` (write у пользователя есть).

```sh
SRC=/home/animastor/animastor-web/frontends/website/index.html
DST=/home/animastor/animastor/frontends/website/index.html
TMP=/home/animastor/animastor/frontends/website/.index.html.m3tmp

# 0) PRE из §3.2 — все зелёные + G1 получен + окно согласовано
# 1) атомарная подготовка и подмена
cp -p "$SRC" "$TMP"
chmod 664 "$TMP" && chown animastor:animastor "$TMP"    # == правам DST
sha256sum "$TMP"     # обязано == a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c
                     # иначе: rm -f "$TMP"; ABORT
mv -f "$TMP" "$DST"  # атомарный rename → nginx отдаёт новую версию без reload
```

### 3.4 Проверки после замены (POST)

```sh
sha256sum "$DST"                                            # a1900f4e…
curl -sSk --resolve animastor.org:443:127.0.0.1 https://animastor.org/ | sha256sum   # a1900f4e…
# 4 ссылки живой страницы (вырезать из ответа и проверить) -> 4/4 200
# локальные ресурсы 8+1: /styles.css /site.js /logo.png /favicon-16.png /favicon-32.png
#   /apple-touch-icon.png /library/ /downloads/version.json + apk -> 200
curl -sSk -o /dev/null -w '%{http_code}\n' --resolve animastor.org:443:127.0.0.1 https://animastor.org/health     # 200
curl -sSk -o /dev/null -w '%{http_code}\n' --resolve animastor.org:443:127.0.0.1 https://animastor.org/gpu/health  # 200
docker exec animastor-proxy nginx -t                        # syntax ok (без reload)
git -C /home/animastor/animastor status --porcelain -- frontends/website   # " M …/index.html"
test ! -e "$TMP"                                            # tmp удалён (mv)
```

### 3.5 Откат к исходному SHA `276a5fc4…` (в любой момент, секунды)

```sh
git -C /home/animastor/animastor checkout -- frontends/website/index.html
sha256sum /home/animastor/animastor/frontends/website/index.html   # 276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c
curl -sSk --resolve animastor.org:443:127.0.0.1 https://animastor.org/ | sha256sum   # 276a5fc4…
git -C /home/animastor/animastor status --porcelain -- frontends/website/index.html   # пусто
# health 200/200, docker ps без изменений
```

Обоснование корректности отката (проверено сегодня): блоб mono
`HEAD:frontends/website/index.html` байт-идентичен текущему файлу
(`git show HEAD:… | sha256sum` → `276a5fc4…`), worktree по файлу чист →
`git checkout` возвращает ровно то, что отдаётся сейчас. Правка после M3
остаётся **uncommitted** (commit/push запрещены) — это не мешает откату.

### 3.6 Права и окно

- Write: пользователь `animastor` в `/home/animastor/animastor/frontends/website/`
  (владелец, 775/664). Root/sudo — не нужен.
- docker-группа — только для read-only проверок (`ps`, `inspect`, `exec nginx -t`).
- Окно: ≤ 15 мин (PRE → mv → POST); без остановки сервисов.
- Гейт: **G1** (утверждение этих 4 URL владельцем) + согласованное окно B2.
- Не входит в окно (отдельные разрешения): M2 (apk/.well-known), смена монта,
  commit/push, любые правки compose/conf, reload nginx.

---

## 4. Baseline (зафиксирован, ничего не изменено)

- Живой `https://animastor.org/` → sha256 `276a5fc4…` (старая версия, 4×404) ✓
- `/health` = 200, `/gpu/health` = 200 ✓
- Контейнеры 7: backend Up 42h, gpu-hub Up 3d, proxy Up 5w, pg/redis Up 6w
  (healthy), repro-redis Up 5d, buildkit Up 3d — **без перезапусков** ✓
- Git: mono `465453df` (по index.html чисто), web `fbc93662` (worktree чист) ✓
- Изменения на сайте/в репо/в конфигах: **нет** (этап только читал)

---

## 5. Что НЕ выполнялось (запреты соблюдены)

Запись в production, замена файлов, reload/restart, изменение Compose/Nginx,
`git commit`, `git push`, действия с backend/GPU Hub/PostgreSQL/Redis/TLS/DNS —
**ничего из перечисленного не выполнялось**. Исполняемые команды — `git
rev-parse/status/show`, `sha256sum`, `diff`, `ls/sed/grep`, `docker ps`,
`curl` (GET/HEAD), GitHub API (GET).

## 6. Резюме для чата

**PASS. Проверено 4/4 ссылки.** Старые (`…/Animastor/animastor`, `…/tree/master/docs`)
→ 404 «Page not found»; новые (`…/Animastor/animastor-web`,
`…/tree/main/docs`) → 200 с подтверждением ресурса по title, составу каталога
(4/4 == локальному `docs/`) и GitHub API (в т.ч. отрицательный тест старого репо).
Для M3 достаточно 1 файла `frontends/website/index.html`; атомарная команда
(`cp -p` → `mv`) и откат к `276a5fc4…` (`git checkout --`) готовы (§3.3/§3.5).
Жду подтверждения этих четырёх пар адресов (G1) — переключение пойдёт отдельным
заданием в согласованное окно.
Отчёт: `/home/animastor/reorg-2026-10-12/31-m3-url-approval.md`.
