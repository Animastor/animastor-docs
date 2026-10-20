# Animastor — Этап 29: WEBSITE LINKS REPAIR

- Дата: 2026-10-12
- Режим: **только проверка и (при необходимости) правка канонического
  web-репозитория.** Деплой/переключение production, изменение monorepo,
  `git commit`/`git push`, Compose, рестарты, публикация ZIP, TLS/DNS,
  удаление данных — **не выполнялись**.
- Источники (прочитаны): `28-cutover-readiness-audit.md` (§2),
  `27-deploy-layout-preparation-report.md` (§M2–M3),
  `docs/architecture/DOMAIN_MIGRATION_2026-10_IN_TO_ORG.md`.

---

## 0. Краткий вывод (главная находка этапа)

**Изменения в web-репозитории НЕ ПОТРЕБОВАЛИСЬ.** Все четыре ссылки в
каноническом `index.html` **уже указывают на правильные URL** и были исправлены
ранее — коммитом `fbc9366` («feat(domain): migrate canonical domain
animastor.in → animastor.org», 2026-10-11). Это подтверждено повторной
проверкой сегодня: все 4 цели отвечают **200**, worktree чист, файл отслеживается,
внекоммитных правок нет.

Битые **404-ссылки существуют ТОЛЬКО в monorepo / живом production**
(`frontends/website/index.html`, sha256 `276a5fc4…`, отдаётся nginx прямо сейчас).
Их устранение = шаг **M3** плана (замена mono-файла web-версией), который на этом
этапе **запрещён** (правка monorepo/production; требует гейта **G1** и
согласованного окна). Этап 29 задачу «переноса» не выполняет — только готовит.

Итог: **PASS** (проверки пройдены; 0 правок в web-репо — нечего менять;
4 исправленные ссылки подтверждены в каноническом источнике и готовы к M3).

---

## 1. Контекст: где какие ссылки

| Источник | Путь | sha256 | Ссылки GitHub |
|---|---|---|---|
| **mono / живой prod** (НЕ трогали) | `/home/animastor/animastor/frontends/website/index.html` | `276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c` | `…/Animastor/animastor` → **404**; `…/tree/master/docs` → **404** (строки 143, 150, 176, 177) |
| **web-репо (канонический, D1)** | `/home/animastor/animastor-web/frontends/website/index.html` | `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c` | `…/Animastor/animastor-web` → **200**; `…/tree/main/docs` → **200** |

Diff mono↔web = **ровно 4 строки** (8 строк diff = 4 пары `<`/`>`), все 4 —
ссылки на GitHub. Больше различий между файлами нет.

Git-состояние web-репо **до этапа**: HEAD `fbc93662035df84c8e103df0d0706800aa96cba1`,
worktree чист (`git status --porcelain` пуст), файл `frontends/website/index.html`
tracked, `git diff` по нему пуст.

---

## 2. Таблица «URL до → URL после → результат»

Канонический источник (web-репо) уже содержит «после»-вариант. «До» = состояние
в mono/production (то, что устраняется переносом M3).

| # | Строка | URL до (mono / prod, 404) | URL после (web-репо, канон) | Результат проверки |
|---|---|---|---|---|
| 1 | 143 (карточка «GitHub repository») | `https://github.com/Animastor/animastor` | `https://github.com/Animastor/animastor-web` | **200** ✓ |
| 2 | 150 (карточка «Docs folder») | `https://github.com/Animastor/animastor/tree/master/docs` | `https://github.com/Animastor/animastor-web/tree/main/docs` | **200** ✓ |
| 3 | 176 (футер «GitHub») | `https://github.com/Animastor/animastor` | `https://github.com/Animastor/animastor-web` | **200** ✓ |
| 4 | 177 (футер «Docs») | `https://github.com/Animastor/animastor/tree/master/docs` | `https://github.com/Animastor/animastor-web/tree/main/docs` | **200** ✓ |

Правильность целей подтверждена не «угадыванием», а: (а) зафиксированным решением
D1 (канонический index.html = web-репо; отчёты 04:104, 07 §4/§58, 20 §1.3);
(б) существующими страницами — оба URL отдают 200 сегодня; (в) ветка `main`
(web-репо) существует, `master` у моно-репо на GitHub отсутствует (репо не
опубликован → 404).

**Изменённые файлы: нет.** SHA web-репо до = после = `fbc9366…`; worktree чист.

---

## 3. Проверка остальных ссылок web-index.html — PASS

Полный аудит всех URL и локальных путей канонического файла:

| Ссылка | Тип | Результат |
|---|---|---|
| `https://animastor.org/` (canonical/og:url) | внешняя | 200 |
| `https://app.animastor.org/` (3× кнопка) | внешняя | 200 |
| `https://github.com/Animastor/animastor-web` (2×) | внешняя | 200 |
| `https://github.com/Animastor/animastor-web/tree/main/docs` (2×) | внешняя | 200 |
| `mailto:support@animastor.org` | почта | не проверяется curl (MX-проверка вне скоупа) |
| `/styles.css`, `/site.js`, `/logo.png`, `/favicon-16.png`, `/favicon-32.png`, `/apple-touch-icon.png` | локальные | существуют в web-репо; отдаются 200 локальным статик-сервером |
| `/downloads/version.json` | локальный | существует; 200 |
| `/downloads/animastor-android-latest.apk` | локальный | в web-репо **отсутствует** (см. §4) |
| якоря `#android`, `#development`, `#how-to-use` | внутр. | `id="…"` присутствуют в файле ✓ |

### 3.1 Локальные проверки сайта (read-only)

Локальная отдача web-каталога одним процессом (не production, порт 8931,
`python3 -m http.server`, остановлен сразу после проверки):

```
/ 200 | /styles.css 200 | /site.js 200 | /logo.png 200
/favicon-16.png 200 | /favicon-32.png 200 | /apple-touch-icon.png 200
/library/ 200 | /downloads/version.json 200
```

### 3.2 Diff-контроль

`diff mono web` — ровно 4 строки (только GitHub-ссылки); посторонних правок,
секретов, изменений canonical/og/SEO — нет (canonical/og:url/app-кнопка/support
идентичны в обеих версиях; строк `animastor.in` — 0 в обеих).

---

## 4. Оставшиеся проблемы / что НЕ сделано (и почему)

| # | Проблема | Статус | Следующий шаг |
|---|---|---|---|
| 1 | Живой сайт (mono) продолжает отдавать 4 битые 404-ссылки | ожидаемо | **M3**: заменить mono `index.html` на web-версию (`a1900f4e…`) — только в согласованном окне с гейтом **G1**; откат = `git -C animastor checkout -- frontends/website/index.html` |
| 2 | В web-репо нет `downloads/animastor-android-latest.apk` (12 505 721 Б) и `.well-known/` | ожидаемо (runtime-файлы вне git, живут в mono) | **M2**: копирование mono → web перед переключением website-mount (разрешение на копирование); без этого ссылка `/downloads/…apk` в web-версии станет 404 после E6 |
| 3 | `mailto:support@animastor.org` не проверен (нет MX-проверки) | вне скоупа | при желании — проверка MX/доставки почты отдельно |
| 4 | Правки не закоммичены | не применимо | коммитов не было — изменений нет; после M3 (если потребуется отдельный коммит в web) — с разрешения G3 |

---

## 5. Git-итог

| Параметр | До | После |
|---|---|---|
| web-репо HEAD | `fbc93662035df84c8e103df0d0706800aa96cba1` | `fbc93662035df84c8e103df0d0706800aa96cba1` (не изменился) |
| worktree web | чист | чист |
| mono HEAD | `465453df…` | не трогали |
| mono index.html sha256 | `276a5fc4…` | не трогали (production отдаёт его и сейчас) |

## 6. Запрещённые действия — соблюдены

Деплой/переключение production, изменение monorepo, `git commit`/`git push`,
Compose, рестарты контейнеров, публикация ZIP, TLS/DNS, удаление данных —
**не выполнялись**. Единственный дополнительный запуск — локальный статик-сервер
на 127.0.0.1:8931 для чтения файлов web-репо, остановлен сразу; production
не затронут (health 200/200 до и после, контейнеры не перезапускались).

## 7. Резюме для чата

**PASS.** Исправлено в web-репо: **0 правок** — все 4 ссылки уже были правильными
(закоммичено в `fbc9366`), проверены: 4/4 → 200; остальные ссылки и локальные
проверки чистые. Битые 404 остаются только в mono/production → переносятся
шагом M3 (G1 + окно). Отчёт: `/home/animastor/reorg-2026-10-12/29-website-links-repair-report.md`.
