# Animastor — Этап 8: публикация четырёх main в GitHub (отчёт)

Дата: 2026-10-11. Итог: **PASS** (4/4 репозитория, все push fast-forward, без force).

## 0. Важное уточнение по remote'ам

Во всех четырёх репозиториях `origin` — это **локальный bare-репозиторий**
(`/home/animastor/repos/animastor-*.git`), а GitHub соответствует remote **`github`**
(`git@github.com:Animastor/animastor-*.git`).

Формулировка этапа «`git push origin main`» в буквальном виде конфликтовала бы с
ограничением «не изменять bare Git». Цель этапа — публикация в GitHub, поэтому
push выполнялся на remote **`github`**; bare-репозитории (remote `origin`)
осознанно не тронуты. См. §4.

## 1. Pre-flight (актуальные данные, не из прежних отчётов)

| Репо | Ветка | Локальный main (HEAD) | Дерево | `github/main` до push | Предковость | Ожидалось отставание |
|---|---|---|---|---|---|---|
| animastor-worker | main | `b3f94f42612d0a5dd665956908f545c8d94fad95` | чистое | `618f87a6…` | YES | 1 коммит ✓ |
| animastor-web | main | `fbc93662035df84c8e103df0d0706800aa96cba1` | чистое | `c7fe52ac…` | YES | 1 коммит ✓ |
| animastor-android | main | `92a56c0ddce1a796d593f4e3a3462ca17ddd2c3f` | чистое | `254e2f08…` | YES | 1 коммит ✓ |
| animastor-backend | main | `a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad` | чистое | `bce64db3…` | YES | 4 коммита ✓ |

Все четыре локальных HEAD совпали с ожидаемыми SHA этапа. Удалённый `main`
не изменился после аудита этапов 6–7: значения `github/main` идентичны
зафиксированным в `11-merge-report.md` (отставание 1/1/1/4). Непредвиденных
коммитов нет, merge/rebase не потребовались.

Коммиты, ожидавшиеся к публикации:
- worker/web/android — по одному `feat(domain): migrate canonical domain animastor.in → animastor.org`;
- backend — 4: `f84f43e` (domain), `e045c51` (editor), `8cb02d8` (assistant purge), `a7a8c46` (deps bump 0.1.1/0.1.2).

## 2. Публикация (строго по порядку, каждый push — обычный, без force)

Перед каждым push повторно проверялась предковость
(`git merge-base --is-ancestor github/main main`) — прошла во всех четырёх случаях.

| # | Репо | main до push (origin/bare и github) | Push | `github/main` после | Локальный HEAD после | Дерево после |
|---|---|---|---|---|---|---|
| 1 | animastor-worker | `618f87a67744802b7e7a0b33a0934ce48d414640` | OK (ff: `618f87a..b3f94f4`) | `b3f94f42612d0a5dd665956908f545c8d94fad95` | `b3f94f42…` ✓ | чистое |
| 2 | animastor-web | `c7fe52ac3559456ebb1cc519c30151281941acbc` | OK (ff: `c7fe52a..fbc9366`) | `fbc93662035df84c8e103df0d0706800aa96cba1` | `fbc93662…` ✓ | чистое |
| 3 | animastor-android | `254e2f084342fd69214b4a3a45dfb7b27df84e2f` | OK (ff: `254e2f0..92a56c0`) | `92a56c0ddce1a796d593f4e3a3462ca17ddd2c3f` | `92a56c0d…` ✓ | чистое |
| 4 | animastor-backend | `bce64db3731414b9755e7b5e2f902cb3cf59f772` | OK (ff: `bce64db..a7a8c46`) | `a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad` | `a7a8c463…` ✓ | чистое |

Все push завершились с кодом 0, вывод git подтверждает fast-forward
(`… -> main -> main`, без `+`/force). Ошибок и повторных попыток не было.

## 3. Подтверждение соответствия локального и удалённого HEAD

После каждого push через `git ls-remote github refs/heads/main` получено
точное совпадение с локальным `git rev-parse main` для всех четырёх репозиториев
(см. таблицу выше). Пересчёт отставания: `github/main..main` = 0 коммитов.

## 4. Ограничения соблюдены / изоляция подтверждена

- Опубликованы **только ветки `main`** четырёх репозиториев. Force-push / `--force` /
  `--mirror` / авто-синхронизация всех refs — не применялись.
- Merge / rebase / reset / cherry-pick / правки исходников на этом этапе — не выполнялись.
- Ветки `sync/*`, теги и прочие refs не публиковались (на GitHub backend-remote
  присутствует 4 записи refs — `main` и три служебных; новых refs не создано).
- **Bare Git не изменён**: `/home/animastor/repos/animastor-{worker,web,android,backend}.git`
  остались на исходных `618f87a6` / `c7fe52ac` / `254e2f08` / `bce64db3`.
- **Монорепозиторий не изменён**: HEAD `465453df…` без коммитов; единственная
  строка статуса — untracked `docker/compose/overlay-backend-standalone.yml`
  с mtime 2026-10-10 (pre-existing, существует с до этапа, не создавался здесь).
- **GPU Hub не изменён**: HEAD `ecefd0b7…`, дерево чистое.
- **Работающие контейнеры не изменялись**: без перезапусков —
  animastor-backend (Up 22h), gpu-hub (Up 2d), animastor-proxy / pg / redis и пр.
- Deploy, production cutover, repin `artifacts.lock.json` — не выполнялись.
- Секреты, `.env`, ключи и локальные артефакты не коммитились и не публиковались
  (деревья были чистыми до и после push).

## 5. Ошибки и оставшиеся блокеры

- Ошибок push — 0. Неподтверждённых операций — нет.
- Важно для следующих этапов: **bare-репозитории (remote `origin`) теперь
  отстают от GitHub на 1/1/1/4 коммита** — их синхронизация явно не входила
  в скоуп этапа (ограничение «не изменять bare Git») и остаётся отдельным решением.
- Production cutover — отдельная задача после проверки живых Nginx-редиректов,
  GPU Hub E2E и решения о repin `artifacts.lock.json` (см. границу этапа).
