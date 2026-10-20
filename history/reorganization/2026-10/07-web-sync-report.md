# Animastor — синхронизация Web с монорепо c21.4 (отчёт)

- Дата: 2026-10-11 (UTC)
- Рабочее дерево: `/home/animastor/animastor-web`
- База: `c7fe52ac3559456ebb1cc519c30151281941acbc` (= bare = GitHub, подтверждено)
- Итог: ветка `sync/c21.4-domain` = **`fbc93662035df84c8e103df0d0706800aa96cba1`**
- Результат: **PASS**
- `main` не тронут (`c7fe52a`), bare/GitHub не тронуты, push/merge/deploy не выполнялись.

---

## 1. Pre-flight

| Проверка | Значение |
|---|---|
| HEAD == baseline (03-baseline-2026-10-11.txt) | `c7fe52ac` ✓ |
| Ветка / status | `main`, 0 строк ✓ |
| remotes | `origin` → локальный bare `/home/animastor/repos/animastor-web.git`, `github` → GitHub ✓ |
| bare `main` == worktree == GitHub (`ls-remote`) | `c7fe52ac` во всех трёх ✓ |
| Backend-ветка `sync/c21.4-domain-and-fixes` | сохранена в worktree backend = `a7a8c46` (push в bare не выполнялся — как и в этапе backend), не изменялась ✓ |
| Монорепо | `465453df`, HEAD/status не менялись (1 pre-existing untracked — как в baseline) ✓ |
| Свободный диск | 6.4 ГБ (94%) — учтён: `npm ci` только для 2 затронутых пакетов, удалены после проверок |

Расхождений с ожидаемым состоянием нет.

## 2. Созданный коммит (1)

| SHA | Тема | Объём | Источник (монорепо c21.4) |
|---|---|---|---|
| `fbc9366` | feat(domain): migrate canonical domain animastor.in → animastor.org | 19 файлов, +37/−32 | `60f8b9ee` (2026-10-08) |

В отличие от backend (4 коммита), у Web в монорепо `master..HEAD` присутствует
**только** доменная тема — npm-бампы, fix(editor), fix(assistant) относятся к
backend и не переносились. Все 19 web-кандидатов изменены одним коммитом `60f8b9ee`.

## 3. Метод (трёхстороннее сравнение)

Три стороны: монорепо c21.4 (`master=64127b9e` → `HEAD=465453df`), split-base
(`master` монорепо — дерево-источник split), актуальный Web (`main=c7fe52a`).
Истории репозиториев переписаны filter-repo, объекты монорепо в web-репо
отсутствуют, поэтому вместо `git checkout 465453df -- <path>` (прямая ссылка
недоступна) использован `git archive 465453df -- <имена 16 файлов>` из монорепо
с поимённой выкладкой — по сути эквивалент, объём строго ограничен списком.

Классификация 19 web-кандидатов (пересечение изменённых в `master..HEAD`
монорепо с деревом web):

| Класс | Файлов | Обработка |
|---|---|---|
| Только монорепо новее (web-блоп == split-base) | 16 | взяты из `465453df`; до transfer дифф каждого проверен — **все изменения только доменные** (.in → .org), ничего постороннего |
| Изменены с обеих сторон | 3 | ручное 3-way (§4) |

## 4. Решения по файлам «изменён с обеих сторон» (3-way)

| Файл | В репозитории (post-split) | В монорепо | Решение |
|---|---|---|---|
| `frontends/app/package.json` | `+license: MIT` (c7fe52a) | `description` → `app.animastor.org` | объединено: сохранён `license: MIT`, перенесено описание `.org` |
| `frontends/website/index.html` | ссылки GitHub → `Animastor/animastor-web` (c7fe52a) | canonical/og-теги `.org`, кнопки `app.animastor.org`, support@ `.org` | объединено: сохранены ссылки GitHub на `animastor-web`, добавлены canonical/og + доменные правки |
| `README.md` | новый README репозитория (logo, структура web) | старый корневой README монорепо + `.org` | репозиторионный **сохранён**; домен применён точечно: одна строка `(animastor.in)` → `(animastor.org)` |

## 5. Перенесённые доменные изменения (по категориям)

- **Канонический домен**: canonical/og-теги `https://animastor.org/` в
  `frontends/website/index.html`; canonical `/library` в `library/index.html`.
- **Ссылки и кнопки**: `app.animastor.in` → `app.animastor.org` (website
  index.html ×3, site.js CTA, AdminPage/LibraryPage хост-дефолты).
- **Support-адрес**: `support@animastor.org`.
- **Runtime/тестовые ожидания**: `workerSetup.test.ts` — `download_url`
  `https://animastor.org/gpu/installer?...`.
- **Tester-инструменты** (8 файлов `tools/{desktop,mobile}-web-tester/**`):
  APK download URLs `animastor.org/net-disk/*.apk`, Basic-Auth-комментарии,
  дефолтный URL `app.animastor.org`, gradle/kt-хосты.
- **Скрипты/доки**: `app-web-rebuild.sh` (Served at `.org`),
  `ANDROID_WEB_PARITY.md` (WebView URL `.org`), комментарии website-стилей/скриптов.

## 6. Сохранённые post-split изменения Web

- `README.md` репозитория — не заменён (logo/структура/clone-инструкции репо);
- `.gitignore` — репозиторионный, не тронут;
- ссылки GitHub `Animastor/animastor-web` в `website/index.html` — сохранены;
- `license: MIT` в `frontends/app/package.json` — сохранён;
- `repository`/`homepage`/`bugs` → `animastor-web` в пакетах — не тронуты.

## 7. Проверки

| Проверка | Результат |
|---|---|
| `git status` после коммита | чисто (0 строк) ✓ |
| `git log main..sync/c21.4-domain` | ровно 1 ожидаемый коммит ✓ |
| `git diff main..HEAD --stat` | 19 файлов = 16 mono-only + 3 three-way ✓ |
| Блобы 16 mono-only файлов vs монорепо `465453df` | 16/16 байт-идентичны ✓ |
| Контроль 3-way-файлов | обе части в диффе присутствуют (§4), ничего не потеряно ✓ |
| Остатки `animastor.in` в дереве | 9 файлов — все `docs/**` (08-mobile-web-migration, 09-desktop-migration, ANDROID_WEB_PARITY), **байт-идентичны монорепо** — исторические документы, монорепо тоже их не менял; ни в одном рабочем файле остатков нет ✓ |
| Новые ссылки на старый monorepo | 0 ✓ |
| `bash -n` изменённых `.sh` (3) | OK ✓ |
| `node --check frontends/website/site.js` | OK ✓ |
| **`npm ci` + `vitest run` в `packages/animastor-web-workers`** | **5 файлов / 104 tests passed** (включая изменённый `workerSetup.test.ts`) ✓ |
| **`npm ci` + `tsc --noEmit` в `frontends/app`** | **typecheck OK** ✓ |
| **`vitest run` в `frontends/app`** | **15 файлов / 201 tests passed** ✓ |
| Secrets в diff | нет (изменённых `.env`/ключей нет) ✓ |
| Ветка изолирована от `main` | `main` = `c7fe52a` = bare = GitHub, push не выполнялся ✓ |

Условия: `npm ci` выполнялся только в 2 затронутых пакетах
(`frontends/app`, `packages/animastor-web-workers`; ~290 МБ, gitignored,
после проверок **удалены**, диск вернулся к 6.4 ГБ). `git status` оставался чистым.

### Legacy `.in` → `.org`

- В web-репозитории **нет** nginx/proxy-конфигов (редиректы живут в
  `proxy/conf/default.conf` backend-репо — перенесены в backend-ветке `f84f43e`),
  поэтому проверка «`.in` остаётся legacy с перенаправлением» к web неприменима:
  web-репо не содержит точек редиректа и не меняет основной домен.
- Основной домен в web-репо теперь `.org` (canonical/og/ссылки); `animastor.in`
  остался только в исторических docs, идентичных монорепо.
- **Не проверялось** (вне моей доступности): браузерное поведение и
  production-редиректы на живом nginx.

## 8. Что НЕ запускалось / ограничения

| Что | Почему |
|---|---|
| `vitest` остальных 12 пакетов `packages/animastor-web-*` | их файлы синхронизацией не затрагивались; полный прогон требует `npm ci` ×12 (диск 6.4 ГБ) |
| `vite build` (`frontends/app`) | продакшен-сборка; оставлена отдельному этапу (диск) |
| Тесты `tools/*-web-tester` (gradle/Android) | требуют Android SDK; поведение tester-APK не проверялось |
| Браузерная проверка website (canonical/og/редиректы) | требует запущенного сервера/браузера — **не выполнялась** |
| TypeScript typecheck самого `workerSetup.test.ts` в изоляции | vitest транспилирует его на лету; отдельный `tsc` пакета не запускался (входил бы в prepublishOnly) |

## 9. Осознанно НЕ перенесено

| # | Что | Почему |
|---|---|---|
| 1 | `README.md`, `.gitignore` монорепо | репозиторионные версии новее (post-split c7fe52a) |
| 2 | Монорепо-версии `website/index.html`, `app/package.json` целиком | затёрли бы post-split правки; применены точечно (§4) |
| 3 | Ссылки GitHub `Animastor/animastor` из монорепо-версии index.html | post-split заменены на `Animastor/animastor-web` |
| 4 | Backend-изменения (nginx/installer/auth/npm-bumps/fix(editor)/fix(assistant)) | не относятся к Web; перенесены в backend-ветку `a7a8c46` |
| 5 | `docs/architecture/repository-split-*`, `post-split-*`, `DOMAIN_MIGRATION_2026-10_IN_TO_ORG.md` | split-журналы ведутся в монорепо |
| 6 | Исторические `docs/08-mobile-web-migration/*`, `docs/09-desktop-migration/02-PROGRESS.md` с `.in` | монорепо их не менял; не в скоупе доменного коммита |

## 10. Rollback

Единственное изменение — ветка `sync/c21.4-domain` (1 коммит поверх `main`).
Откат: `git checkout main && git branch -D sync/c21.4-domain`.
Bare/GitHub/монорепо/backend/android/worker/gpu-hub/инфраструктура не тронуты
(проверено после завершения: bare web `main=c7fe52a`, GitHub `main=c7fe52a`,
bare backend refs без изменений, монорепо `465453df`).

## 11. Следующие шаги (отдельные решения, НЕ выполнены)

1. Ревью ветки → merge в `main` → push bare → GitHub.
2. Синхронизация android (`05-sync-plan.md` §2.3) и worker (§2.4).
3. Отложенная верификация: полный `vitest`/`build`, tester-APK.
4. Cutover деплоя website на репозиторий (production-сборка — из монорепо).
