# Stage 62 — Deploy BOOK-RECOVER registry gate + live verification

**Date:** 2026-10-17
**Verdict: PARTIAL** — релиз-цепочка закрыта полностью: npm-публикации владельца
подтверждены integrity-в-байт, CI собрал immutable-образ из `a64199e`
(revision == коммит, оба пакета 0.1.2/0.1.1 с гейтом внутри), backend
переключен на новый digest, health стабилен, обе сохранённые книги исправны,
**все три read-time пути гейта проверены вживую** (skip-логи + ноль PG-записей
для удалённой книги), `image_units` id=250444 не тронут и не размножился.
PARTIAL из-за двух честных пробелов: (1) **новый наход** — startup-путь
`recoverAllBooksFromDisk` (host-side, вне скоупа Stage 59) при перезапуске
воссоздал 5 Redis-ключей удалённой книги (PG не тронул); (2) органических
опросов удалённой книги живым клиентом за окно наблюдения не наблюдалось —
гейт проверен моими безопасными запросами, реплицирующими клиентские GET;
повторное поведение клиента NOT VERIFIED.

---

## 1. npm registry после публикации владельца (подтверждение «опубликовал»)

| Проверка | @animastor/editor | @animastor/player |
|---|---|---|
| versions | `['0.1.0','0.1.1','0.1.2']` ✓ | `['0.1.0','0.1.1']` ✓ |
| dist-tags.latest | `0.1.2` ✓ | `0.1.1` ✓ |
| `dist.integrity` == backend lock (Stage 61) | ✅ `sha512-s5fFW4NVBEgCeLWc5QeYYnfZ+EL+bhb/JfbyBQgxCAWbsSVvxWqItGfa8AUL12wARxPGLKr/l7LsywJWx1efNw==` | ✅ `sha512-eeGuoqfwEwkzKDY3Ux9hGgWOjhHzrdEuoL0rKGBrCGtlwhvOazERmcxJ0HcK2LFPnm/lCwowhGQMaSPcM7ev3w==` |
| Скачанный из registry tarball == локальному pack (sha512) | ✅ байт-в-байт | ✅ байт-в-байт |
| `isBookRegistered` в опубликованном src | ✅ read-recovery(3)+editor-routes(1) | ✅ scene-data(2)+player-routes(2)+player-shared(2) |
| Примечание | первые секунды после «опубликовал» packument ещё кэшировался (0.1.2 отсутствовал) — через ~30 s репликация подтвердила обе версии | то же окно |

## 2. CI-сборка

- **Approval-коммит:** `c4788bd` `ci(backend): approve a64199e backend tree for GHCR release (stage 62)` — только `.github/workflows/backend-ghcr-release.yml` (`APPROVED_COMMIT: c7eaa9c → a64199e1ec29…`), +1/−1. Push origin+github: оба remote = `c4788bd`.
- **Dispatch:** `POST …/workflows/382231446/dispatches` (PAT из docker config) `ref=main`, `commit=a64199e1ec29b7f533dafc4da2e675e0fcdaf9e6`, `image_tag=deploy-a64199e` → **204**.
- **Run [39047106993](https://github.com/Animastor/animastor-backend/actions/runs/39047106993)** (head `c4788bd`): **completed / success** (~60 s). Gate `backend/ tree == approved a64199e` пройден; smoke: /health 200, crash-signatures 0; оба тега запушены (не существовали ранее — перезаписей нет).

## 3. Образ — provenance

| Проверка | Значение |
|---|---|
| Digest (оба тега `deploy-a64199e` + full-sha) | **`ghcr.io/animastor/animastor-backend@sha256:b3f801144dd135e925ff979076be8687e76cdce1765736637de90048098b7c8e`** |
| OCI revision / version | `a64199e1ec29b7f533dafc4da2e675e0fcdaf9e6` / `deploy-a64199e` |
| sha256 `/app/{src/backend.cjs,package.json,package-lock.json,Dockerfile}` == git `a64199e` | ✅ 4/4 байт-в-байт |
| Пакеты в образе | `@animastor/editor@0.1.2`, `@animastor/player@0.1.1` |
| Гейт в образе (`/app/node_modules/…/src`) | ✅ все 5 файлов контуров содержат `isBookRegistered` |

## 4. Rollout (только backend)

- Rollback-снимок: `reorg-2026-10-17/rollback-62/{env-before (sha f10c29df…, BACKEND_IMAGE=…71ab1468…), container-inspect-before.json, image-old-inspect.json}`.
- Единственная правка: `deploy/.env:39` `BACKEND_IMAGE` → `…@sha256:b3f80114…` (diff против env-before — ровно одна строка; рендер compose подтвердил пин).
- `docker compose --project-name animastor --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend` → rc=0; pg/redis только health-checked («Waiting→Healthy»), **не пересоздавались** (7 weeks uptime сохранён); gpu-hub 5 days, proxy 5 days — нетронуты.
- Контейнер: `sha256:b3f80114…`, restarts=**0**, started `2026-10-17T15:59:00Z`.

## 5. Пост-деплойная проверка

### 5.1 Health / логи — PASS
- `GET https://localhost/health` → **200** `{"status":"ok","loop":true,"redis":"PONG"}`.
- С момента старта: **0** FATAL / uncaught / TypeError; `[PG] Schema initialized` (штатный idempotent-init); `[DRIFT] 0 corrected`; steady-state scheduler ticks нормальные.
- Startup reconcile: `reconcile:1_issues` (было 2 до деплоя — один из двух pre-existing `audio-orch` invariant'ов по сценам Мастера закрылся сам в ходе resume; см. §5.4).

### 5.2 Две сохранённые книги — PASS
| Проверка | ba_1788172242081 | import_… (Мастер и Маргарита) |
|---|---|---|
| `GET /api/v1/book/:id` | ✅ 200 | ✅ 200 |
| сцены в PG | ✅ 8 | ✅ 5 |
| `book.json` SHA-256 | ✅ `e50bcc6147d9331a…` (= контроль Stage 56–60) | ✅ `60e6e4b11f77a9a6…` (= контроль) |
| output-dir на диске | ✅ `build_ba_…` (файлы на месте) | ✅ `build_import_…` (68 файлов) |
| READY-assets | 0 ready (как и до: 26 stale/placeholder — не менялось) | 19 ready-строк = 15 прежних + 4 из startup-resume (§5.4); пути build_import разрешаются; 4 pre-existing «мёртвые» `b1/`-дубликаты (Class IV аудита, не трогались) |
| storyboard | — | ✅ 200, 5 IU |
| `books`/`scenes` глобально | 2 / 13 — без изменений | |

`listBooks`/anonymous API: 8 disk-стабов (pre-auth вид, как Stage 56 §6) — штатно.

### 5.3 Гейт вживую — все три пути Stage 59 — PASS

Запросы (percent-encoded Cyrillic id, реплицирующие клиентские GET):
`GET /api/v1/book/новая_книга_1788747351369`, `…/status`,
`GET /api/v1/scene/…/ch-c289a7ac/sc-eebaac15/storyboard`.

| Путь (пакет) | Наблюдение | PG до→после |
|---|---|---|
| placeholder-audio recovery (`@animastor/editor` editor-routes) | лог `[BOOK-RECOVER] … skipped recovery — book not registered`; ответ **200** (чтение отдаётся) | image_units 59→59 |
| Redis chunks (`@animastor/editor` read-recovery) | лог `[BOOK-RECOVER] … skipped — book not registered (no books row)` (внутренний second-check) | ключей новых 0 |
| `image_units` upsert (`@animastor/player` scene-data) | storyboard **200** с вычисленными длительностями (`_start_ms/_end_ms/duration_ms` отданы); PG-write пропущен | image_units 59→59, id=250444 ровно 1 |
| Positive-path (keep books, registered) | `GET /book` ba_/import → 200; storyboard Мастера → 200/5 IU; «skipped»-логов для них **нет** (гейт пропускает registered) | без новых записей от моих запросов |

### 5.4 Наход: startup-путь восстановления НЕ закрыт гейтом (причина PARTIAL №1)

При старте нового контейнера (15:59:01.6Z) host-side
`recoverAllBooksFromDisk()` (`backend/src/helpers/redis-helpers.cjs`, скан
`OUTPUT_DIR`-билдов) восстановил для удалённой книги `manual_1788747351369`:

```
[RECOVERY] Recovering 1 scenes for book новая_книга_1788747351369 in build manual_1788747351369
[STATE] ASSET STATES: … -> {"audio":"ready","image":"ready","video":"ready"}
Recovered chunk: новая_книга_1788747351369_ch-c289a7ac_sc-eebaac15_0001
```

→ 5 Redis-ключей (`chunk:`, `chunks:`, `book-scenes:{next-index,total}`,
`asset-state:`). Это **4-й путь восстановления**, ключующийся на наличие
output-билда на диске; Stage 59 гейтил ровно три read-time пути (по
мандату того этапа), startup-путь не менялся. Ключи **PG не трогали**
(image_units осталось 59) и стабильны (не росли все окно наблюдения).
Предыдущие рестарты (последний — Stage 53, 14.10) не показывали эффект,
потому что на тот момент книга ещё была зарегистрирована; Stage 56–57
книгу вычистили, но рестарта backend после очистки не было — сейчас
первый. **Рекомендация (отдельный этап):** закрыть
`recoverAllBooksFromDisk` тем же портом `isBookRegistered` (fail-closed),
как done для трёх read-time путей. Ключи на месте для расследования;
**не удалялись** (запрет на удаление данных; доказательство предотвращения
ждёт фикса startup-пути).

### 5.5 Прочая активность keep-книги при рестарте (контекст, не регрессия)

Startup-resume pre-existing in-flight генерации Мастера (Stage 51+: leases
image-джобов): `worklist_rebuild:2`, +4 строки `scene_assets` (453→457:
21338/21340→ready, 48346/48348 новые audio-ready, 48344/48349 image-pending),
`generation_tasks` = 17 (без изменений), lease renewals по 2 сценам (GPU
idle, задачи висят pending — как и до деплоя). Поведение FSM-резюме
зарегистрированной книги — штатное (прецедент Stage 51 §5); к BOOK-RECOVER
отношения не имеет.

### 5.6 Окно наблюдения (~12 мин, 15:59→16:11Z)

| Проверка | Результат |
|---|---|
| restarts / health | 0 / 200 |
| FATAL/TypeError/PG/Redis-ошибки | 0 |
| image_units / id=250444 | 59 / ровно 1 — **роста нет** |
| Redis-ключи удалённой книги | ровно те же 5 (startup-созданные), роста нет |
| Органические опросы удалённой книги клиентом | **не наблюдалось** (0 упоминаний за последние 6 мин; все BOOK-RECOVER-строки — мои тесты 16:02) → живой клиент NOT VERIFIED (причина PARTIAL №2) |
| Соседи | pg/redis 7 weeks, gpu-hub/proxy 5 days — uptime не прерывался |

## 6. Запреты — соблюдены

- `image_units` id=250444 **не удалялся** (и не размножился). Файлы
  книг/output/assets/bundles не удалялись. Схемы не менялись.
- Пересоздан только backend; PostgreSQL/Redis/GPU Hub/Worker/nginx не трогались.
- `.env` — одна строка BACKEND_IMAGE; посторонние git-изменения не включались
  (approval-коммит = 1 файл); force-push не выполнялся.
- Органический клиент и «повторное поведение» не имитировались и не
  выдавались за verified.

## 7. Rollback (не потребовался)

`deploy/.env:39` →
`BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:71ab14683267df51463700a00ff0d4084a9ce2ef34661ae44dc9d1ebba4abcd8`
(копия — `rollback-62/env-before`) + `up -d backend`. Образ `deploy-c7eaa9c`
на месте локально и в GHCR.

## 8. Итог

| Пункт | Статус |
|---|---|
| npm integrity == lock, тарболлы байт-идентичны | ✅ |
| CI run 39047106993 success; digest `b3f80114…`; revision `a64199e`; пакеты 0.1.2/0.1.1 + гейт в образе | ✅ |
| Rollout только backend; rollback-снимок | ✅ |
| Health/логи/соседи | ✅ |
| Обе книги: API, сцены, SHA-256, output/READY | ✅ |
| 3 read-time пути гейта вживую (skip + ноль PG-записей; keep-книги без «skipped») | ✅ |
| PG-рост остатков удалённой книги | ✅ нет (id=250444 стабилен) |
| Startup-путь `recoverAllBooksFromDisk` | ❌ **воссоздаёт Redis-ключи** — новый наход, отдельный фикс |
| Живой клиент (органические опросы) | ❌ NOT VERIFIED за окно |

**Production сейчас:** backend `@sha256:b3f80114…` (deploy-a64199e, rev
a64199e, editor 0.1.2 / player 0.1.1), restarts=0, health 200.
