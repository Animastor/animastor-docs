# Animastor — Этап 32: M3 PRODUCTION EXECUTION (выполнен)

- Дата: 2026-10-12 (окно: с 2026-10-12 ~14:05 IST / 08:35 UTC; исполнение 08:36–08:41 UTC = 14:06–14:11 IST)
- Разрешение владельца (**получено**):
  - **G1**: утверждена замена четырёх ссылок production на
    `https://github.com/Animastor/animastor-web` и
    `https://github.com/Animastor/animastor-web/tree/main/docs`.
  - **B2**: окно открыто с момента выдачи задания (12.10.2026 IST),
    объём — **только** замена `frontends/website/index.html` в production.
- Источники (прочитаны до исполнения): `30-m3-cutover-preparation-report.md`,
  `31-m3-url-approval.md`, `21-production-cutover-runbook.md` (фаза B, §5.4, §9),
  предыдущая версия этого отчёта (заблокированная) — переписана итогом.
- Итог: **PASS.** Замена выполнена атомарно, **откат не потребовался**.
  Все POST-проверки зелёные. Изменён ровно 1 tracked-файл (4 строки).

---

## 0. Краткий итог

Собственными файлами заменено: production `frontends/website/index.html`
`276a5fc4…` → **`a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c`**
(канон web-репо @ `fbc93662`). Живой `https://animastor.org/` отдаёт
`a1900f4e…`; все четыре ссылки на GitHub теперь ведут на
`Animastor/animastor-web` и `…/tree/main/docs` — **4/4 → 200** (2 уникальных URL
× 2 позиции: строки 143/176 и 150/177), старых битых ссылок на странице **0**.
Health 200/200, HTTP→HTTPS 301, контейнеры не перезапускались, mounts/Compose/
Nginx/TLS/DNS/lock/backend/PG/Redis — не тронуты. Git-правка остаётся
**uncommitted** (` M frontends/website/index.html`) — commit/push запрещены.

---

## 1. Preflight (повторный, непосредственно перед заменой) — PASS

| # | Проверка | Результат | Статус |
|---|---|---|---|
| P1 | sha256 production-файла | `276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c` (baseline) | ✓ |
| P2 | sha256 живого тела `https://animastor.org/` | `276a5fc4…` == файлу | ✓ |
| P3 | mono HEAD + статус файла | `465453df673016a4f3884b7ae25cddeebb052551`; по `index.html` чисто (откат git валиден) | ✓ |
| P4 | web HEAD + worktree | `fbc93662035df84c8e103df0d0706800aa96cba1`, чисто | ✓ |
| P5 | diff mono↔web(из git-блока) | ровно **8 строк diff = 4 утверждённые пары**, больше ничего | ✓ |
| P6 | `/health`, `/gpu/health` | 200 / 200 | ✓ |
| P7 | диск | `35 029 057 536` Б ≥ 15 000 000 000 | ✓ |
| P8 | backups manifest | 9/9 OK | ✓ |
| P9 | 7 контейнеров | CreatedAt == baseline этапа 30/31 (backend 2026-10-10 13:46:30, pg/redis 2026-07-08, proxy 2026-08-22, gpu-hub 2026-10-08, …) | ✓ |
| P10 | mounts proxy | 6 bind-mount'ов, все ro, источники == baseline | ✓ |
| P11 | lock L1/L2, overlay, nginx conf | `069b62d9…` / `2a221e3b…` / `eac32cb0…` / `99f706af…` == baseline | ✓ |
| P12 | остатков tmp `.index.html.m3tmp` нет | нет | ✓ |

Расхождений не обнаружено → замена разрешена.

---

## 2. Сохранение исходника и проверка восстановления — PASS

| Параметр | Значение |
|---|---|
| Резервная копия | `/home/animastor/backups/index.html.pre-m3-276a5fc4.html` |
| sha256 копии | `276a5fc4…` (== production-файлу до замены; `cmp` — байт-идентичны) |
| Метаданные (сохранены `cp -p` + `stat`-файл рядом) | size 8998, mode 664, owner animastor:animastor, mtime `2026-10-08 19:15:04 UTC`, inode 659192 |
| Файл метаданных | `/home/animastor/backups/index.html.pre-m3-276a5fc4.stat.txt` |
| Проверка восстановления | копия скопирована во временный каталог, sha == `276a5fc4…`, `cmp` с исходником — идентичны → восстановление **возможно байт-в-байт** |
| Второй канал отката | `git -C mono checkout -- frontends/website/index.html` (блоб HEAD == `276a5fc4…`, правок до M3 не было) |

---

## 3. Источник и проверка diff перед заменой — PASS

Канонический файл извлечён напрямую из git-объекта (не из worktree, чтобы
исключить любое расхождение):

```sh
git -C /home/animastor/animastor-web show \
  fbc93662035df84c8e103df0d0706800aa96cba1:frontends/website/index.html > TMP
sha256sum TMP   # a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c ✓
cmp TMP worktree-file  # идентичны ✓ (worktree чист @ fbc93662)
```

Diff TMP ↔ текущий production — **ровно 4 изменения, все утверждённые:**

| Строка | Было (production) | Стало |
|---|---|---|
| 143 (карточка «GitHub repository →») | `https://github.com/Animastor/animastor` | `https://github.com/Animastor/animastor-web` |
| 150 (карточка «Docs folder →») | `https://github.com/Animastor/animastor/tree/master/docs` | `https://github.com/Animastor/animastor-web/tree/main/docs` |
| 176 (футер «GitHub») | `https://github.com/Animastor/animastor` | `https://github.com/Animastor/animastor-web` |
| 177 (футер «Docs») | `https://github.com/Animastor/animastor/tree/master/docs` | `https://github.com/Animastor/animastor-web/tree/main/docs` |

Посторонних изменений нет (diff показал только эти 4 пары строк; после замены
`git diff --stat` = `1 file changed, 4 insertions(+), 4 deletions(-)`).

---

## 4. Атомарная замена — выполнена

```sh
TMP=/home/animastor/animastor/frontends/website/.index.html.m3tmp   # тот же FS, что DST
DST=/home/animastor/animastor/frontends/website/index.html
chmod 664 "$TMP" && chown animastor:animastor "$TMP"   # == правам DST
sha256sum "$TMP"                                       # a1900f4e… — контроль перед mv
mv -f "$TMP" "$DST"                                    # атомарный rename (same filesystem)
```

Факт: inode DST **659192 → 653381** (файл заменён новым инодом атомарно),
права 664, владелец `animastor:animastor`, size 9010, tmp после `mv`
отсутствует. Nginx не перезапускался и не перечитывал конфиг (не требовалось:
в конфиге нет `open_file_cache` — новая версия отдаётся с первого запроса).

---

## 5. Проверки после замены (POST) — все PASS

| # | Проверка | Результат |
|---|---|---|
| C1 | sha256 production-файла | `a1900f4e…` ✓ |
| C2 | sha256 живого тела `https://animastor.org/` | **`a1900f4e…`** == канону ✓ |
| C3 | `cmp` production-файла с каноническим web-файлом | **IDENTICAL** ✓ |
| C4 | ссылки на живой странице | 2× `…/animastor-web` + 2× `…/animastor-web/tree/main/docs` (позиции 143/176 и 150/177) |
| C5 | HTTP-статус четырёх ссылок | **4/4 → 200** (оба уникальных URL проверены `curl -sIL`) |
| C6 | содержимое целей (из отчёта 31, повторно подтверждено) | repo: title `GitHub - Animastor/animastor-web`, ветка `main`; docs: title `animastor-web/docs at main`, 4 каталога == локальному `docs/`; отрицательный тест старого репо — 404 |
| C7 | старые битые ссылки на живой странице | **0 вхождений** (`grep` по обоим старым URL) |
| C8 | главная HTTP | `http://animastor.org/` → **301** → `https://animastor.org/` ✓ |
| C9 | главная HTTPS | **200**, `<title>Animastor — Animated storytelling from text</title>` ✓ |
| C10 | `/health`, `/gpu/health` | **200 / 200** ✓ |
| C11 | локальные ресурсы | `/styles.css /site.js /logo.png /favicon-16 /favicon-32 /apple-touch-icon /library/ /downloads/version.json /downloads/…apk` → **9/9 = 200**; `/.well-known/acme-challenge/` → 403 (норма, как до) ✓ |
| C12 | 301 legacy `.in` | `https://animastor.in/`, `http://www.animastor.in/` → **301** ✓ |
| C13 | `nginx -t` (read-only) | `syntax is ok` / `test is successful` (предупреждения о deprecated `listen … http2` — существовали и до M3, конфиг не менялся) ✓ |
| C14 | контейнеры | 7/7, CreatedAt/uptime **без изменений** относительно preflight — перезапусков не было ✓ |
| C15 | Compose mounts (proxy) | идентичны preflight/baseline (6 ro-bind, источники те же) ✓ |
| C16 | git-статусы | mono: ` M frontends/website/index.html` (**ожидаемо**) + baseline `?? overlay…`; web: чисто @ `fbc93662`; backend/worker/gpu-hub/android == baseline ✓ |
| C17 | `git diff --stat` (mono, website) | ровно 1 файл, 4+/4− ✓ |
| C18 | каталог mono↔web | различия только вне-git `downloads/…apk` и `.well-known/` (**index.html стал идентичен**) ✓ |
| C19 | lock L1/L2, overlay, nginx conf | не изменились (`069b62d9…`/`2a221e3b…`/`eac32cb0…`/`99f706af…`) ✓ |
| C20 | TLS | SNI `.in` Nov 19 2026 / `.org` Jan 6 2027 — без изменений; ACME webroot не тронут ✓ |
| C21 | backups | резервная копия исходника цела (`276a5fc4…`); манифест 9/9 OK ✓ |

---

## 6. Откат

**Не потребовался** — ни одна POST-проверка не отклонилась, ошибок сайта/HTTP
не было. Готовность отката подтверждена до замены (§2):

```sh
# при необходимости (НЕ понадобилось):
cp -p /home/animastor/backups/index.html.pre-m3-276a5fc4.html \
      /home/animastor/animastor/frontends/website/index.html
# либо: git -C /home/animastor/animastor checkout -- frontends/website/index.html
# контроль отката: sha256 == 276a5fc4… ; живое тело == 276a5fc4… ; health 200/200
```

---

## 7. Запрещённые действия — соблюдены

Не выполнялось и не потребовалось: смена каталогов сайта (mount остался на
mono), правки Compose/Nginx/TLS/DNS, перезапуск/остановка контейнеров, любое
воздействие на backend/GPU Hub/PostgreSQL/Redis, `git commit`, `git push`,
публикация артефактов, удаление данных. Единственные записи на сервере в окне:
(1) замена `frontends/website/index.html` (объём G1/B2), (2) аддитивные
резервные копии в `/home/animastor/backups/` (предписано заданием:
«сохрани исходный файл с метаданными»).

## 8. Наблюдение

Рекомендуется разовый повторный smoke позже в тот же день (health, главная,
4 ссылки) — необязательно: все проверки уже пройдены, состояние стабильно.
Изменение остаётся uncommitted в mono до отдельного решения владельца
(commit запрещён этим окном; блоб HEAD по-прежнему `276a5fc4…` — откат через
`git checkout` продолжает работать).

## 9. Резюме для чата

**PASS.** M3 выполнен в окне B2 с одобрением G1. Файл **изменён**:
`frontends/website/index.html` `276a5fc4…` → `a1900f4e…` (атомарный `mv`,
inode сменился, права/владелец сохранены). Живой сайт отдаёт `a1900f4e…`.
Четыре ссылки: **4/4 → 200** на `Animastor/animastor-web` и
`…/tree/main/docs`; старых битых ссылок на странице 0. Health: **200/200**,
HTTP→HTTPS 301, `.in`-редиректы 301, nginx -t ok, контейнеры/mounts/lock/git
без побочных изменений (изменён 1 файл, 4 строки). **Откат не потребовался**;
исходник сохранён: `/home/animastor/backups/index.html.pre-m3-276a5fc4.html`
(`276a5fc4…`).
Отчёт: `/home/animastor/reorg-2026-10-12/32-m3-production-execution-report.md`.
