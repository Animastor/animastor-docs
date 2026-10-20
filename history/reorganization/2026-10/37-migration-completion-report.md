# Animastor — Этап 37: ЗАВЕРШЕНИЕ МИГРАЦИИ

- Дата: 2026-10-12 (окно ~11:35–11:55 UTC)
- Режим: **выполнение переноса по runbook** (этап 21) с правом кодера на
  самостоятельные обратимые технические решения. Изменения: создание
  `deploy/.env` (копия mono), переключение runtime backend+nginx с mono-compose
  на deploy-compose (H2), обновление deploy/README. Не выполнялось: repin/republish,
  `git push`, force-push, удаление данных/монорепо/бэкапов, очистка Redis,
  certbot, E2E-dispatch (нет prerequisites).
- Источники (прочитаны): `21-production-cutover-runbook.md` (полный),
  `35-remaining-blockers-restore-readiness.md`, `36-isolated-restore-test-report.md`,
  `34-tls-renewal-report.md` (учтён через 35 §4.3), фактические файлы deploy/mono/compose.
- **Итог: PARTIAL** — целевая deploy-структура создана, проверена и **фактически
  работает** (runtime переключен, сервисы здоровы, данные/генерация целы).
  Репин/публикация артефактов (G2/C4, D4) и E2E (G5) остаются **блокерами,
  требующими решения владельца** — не выполнены сознательно.

---

## 0. Краткая сводка

| Пункт | Результат |
|---|---|
| **G4** (deploy-layout) | **RESOLVED** — выбран и применён вариант «(а) абсолютные пути»; `deploy/.env` создан (byte-identical к mono); E1–E4 все PASS |
| **Переключение runtime (H2)** | **ВЫПОЛНЕНО** — backend+nginx пересозданы из deploy-конфига (метки → deploy); pg/redis/gpu-hub **не пересозданы** (Running, Created без изменений) |
| Целевые сервисы | **работают**: health 200 / gpu 200 / app 200; site `a1900f4e…`; worker-bundle 2.1.1 `480af146…` (текущий пин); 301×3; nginx -t ok; TLS .in/.org не тронуты |
| Данные / генерация | **сохранены**: `data/` байт-в-байт; PG `generation_tasks=17`; gpu-hub активно обрабатывает image-задачи (очередь ~261, running 0) |
| **G2/C4** (цели repin) | **BLOCKER** — цели верифицированы (worker `b3f94f42`, backend `a7a8c463`, оба = HEAD); список целевых SHA подготовлен (§3); нет письменного «да» владельца → repin/publish закрыты |
| **D4** (installer-src) | **BLOCKER** — дефект подтверждён (404-URL), исправленный источник верифицирован (§4); публикация требует G2+G3 (владелец + GitHub) |
| **G5** (E2E) | **BLOCKER** — `E2E_WORKSPACE_ID` unset, 0 воркеров → dispatch не выполнялся (по правилу задачи) |
| Rollback-канал | **цел** — mono compose/.env не тронуты, `config --quiet` exit 0 |
| Git | **без изменений** — ни одного commit/push; baseline M3 mono + untracked deploy/freebuff сохранены |

---

## 1. G4 — выбор и применение deploy-структуры

**Решение (принято кодером в рамках делегирования):** вариант «(а) — абсолютные
пути» в `/home/animastor/animastor-backend/deploy/`. Причины: каталог уже
подготовлен (этап 27), абсолютные пути указывают на **те же** production-каталоги
mono (монты данных/сайта не меняются → нет риска TLS/apk/данных), `.env` просто
копируется из mono (тот же хост, права 600, обратимо).

### 1.1 Что сделано
- `deploy/.env` создан: `install -m 600 mono/.env deploy/.env` → **byte-identical**
  (sha `ee64133e…`, size 2112, mode 600). Содержимое не печаталось.
- `deploy/docker-compose.yml` (sha `264550e9…`) и `deploy/overlay-backend-standalone.yml`
  (sha `9f13d888…`) — с этапа 27, не менялись.

### 1.2 Проверки E1–E4 — все PASS

| Гейт | Команда | Результат |
|---|---|---|
| **E1** config | `docker compose --project-name animastor --env-file .env -f … -f … config` | **exit 0**; backend image `e8152778…`, gpu-hub image `daf510ff…` (= текущим работающим); **нет `build:`** ни у backend, ни у gpu-hub (overlay сбросил) |
| **E2** 3-way diff | `diff mono-resolved deploy-resolved` | **единственное** отличие (без env-значений) — **удалён `build:` у gpu-hub** в deploy (= улучшение, снимает риск случайной сборки). Тома `animastor_pg-data`/`redis-data`, сеть, healthcheck идентичны |
| **E3** dry-run | `up --dry-run` | **все 5 контейнеров Running** (pg/redis/gpu-hub/backend/proxy) → compose считает конфиг идентичным текущему; **pg/redis Running** (не Recreate) — критерий D3 соблюдён |
| **E4** mount-источники | `test -e` по 10 путям | **10/10 существуют** (data/ai/tests/conf/website/app/docs/htpasswd/letsencrypt) |

**Вывод:** deploy-структура эквивалентна текущей production (кроме убранного
лишнего `build:`) и безопасна для переключения.

---

## 2. Переключение runtime (H2) и post-cutover

### 2.1 Снапшот перед (H1)
7 контейнеров; pg/redis Created `2026-07-08T13:37:11Z`; `.env` `ee64133e…`;
mono compose `ed1b290d…`/`eac32cb0…`; диск 34 718 601 216 Б; health 200/200.

### 2.2 Переключение
```sh
# 1) остановить backend+nginx из mono
cd /home/animastor/animastor && docker compose -f docker-compose.yml \
  -f docker/compose/overlay-backend-standalone.yml stop backend nginx   # exit 0
# 2) поднять из deploy (target)
cd /home/animastor/animastor-backend/deploy && docker compose \
  --project-name animastor --env-file .env -f docker-compose.yml \
  -f overlay-backend-standalone.yml up -d                                # exit 0
# 3) финализация меток: пересоздать backend+nginx из deploy
... up -d --force-recreate backend nginx                                 # exit 0
```
Результат up: **pg/redis/gpu-hub Running** (не тронуты), **backend/proxy
Started → Recreated** (из deploy-конфига). pg/redis Created **без изменений**
(`2026-07-08T13:37:11Z`) — данные не пересоздавались.

### 2.3 Post-cutover smoke — PASS

| Проверка | Результат |
|---|---|
| Контейнеры | 7/7 Up; pg/redis healthy; pg/redis/gpu-hub Created == H1 |
| `/health`, `/gpu/health`, `app.animastor.org` | **200 / 200 / 200** |
| Site sha | **`a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c`** (канон web-репо) |
| `/gpu/worker-bundle/sha256` | v2.1.1 `480af146…` (текущий пин; repin не применялся) |
| backend image / gpu-hub image | `e8152778…` / `daf510ff…` (= `.env` пинам) |
| **метки compose** | backend/proxy `config_files` → **deploy/**; pg/redis/gpu-hub — исторические (косметика; проект `animastor` управляет всеми) |
| `nginx -t` | syntax ok |
| 301 legacy `.in`×3 + http→https | **301 ×3 + 301** (→ `https://animastor.org/`) |
| TLS SNI | `.org` Jan 6 2027, `.in` Jan 10 2027 — **не тронуты** |
| Данные | `data/output` 63 203 425 / `data/books` 1 704 047 — байт-в-байт; PG `generation_tasks=17`; Redis живой |
| Генерация | gpu-hub обрабатывает image-задачи (очередь ws ~261, running 0); backend runtime-loop чист |
| Lock L1/L2 | `069b62d9…` / `2a221e3b…` — **не изменены** |
| Rollback-канал | mono compose+.env `config --quiet` **exit 0** |

**Комментарий по меткам:** compose пересоздал backend/proxy из deploy, их
`config_files` теперь указывает на deploy (единый источник истины). pg/redis/
gpu-hub compose оставил Running — их метки исторические, но проект `animastor`
управляет ими одинаково из любого каталога; при необходимости пересоздадутся
из deploy штатно. Mono-файлы сохранены как rollback (≥7 дней, runbook J3).

---

## 3. G2 / C4 — список целевых SHA и версий для утверждения владельцем

**Статус: BLOCKER (требует письменного «да» владельца — C4).** Техническая
часть верифицирована read-only сегодня; ничего не репинилось и не публиковалось.

### 3.1 Цели (всё ещё = HEAD, проверено сегодня)
| Артефакт | Целевой коммит | tree-sha staged | Версия |
|---|---|---|---|
| **worker** | `b3f94f42612d0a5dd665956908f545c8d94fad95` | worker-bundle `417c0ad4…` | 2.1.1 |
| **backend** | `a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad` | installer-src `ff27e291…` | 0.1.1 |

### 3.2 Не меняются (нет технической необходимости)
| Группа | tree-sha (пин == цель) | Причина |
|---|---|---|
| workflows | `0d51107d…` | дерево идентично пин↔цель |
| install-manifests | `46f3c26a…` | дерево идентично пин↔цель |

### 3.3 Текущие пины (для сравнения)
worker-bundle `4bb0408b…`/2.1.1, installer-src `02fad99e…`/0.1.0 — прод-образ
и живой бандл `480af146…` работают на них (W1 8/8 из этапа 35).

**Запрос к владельцу:** подтвердить (i) цели worker `b3f94f42` / backend `a7a8c463`,
(ii) состав republish (только worker-bundle + installer-src), (iii) открыть окно
G3 для `--write-lock` → push → CI → публикации. Без этого фаза D закрыта;
production продолжает работать на текущих пинах (это безопасно).

---

## 4. D4 — дефект installer-src: подтверждён, исправление подготовлено

**Статус: BLOCKER (публикация требует G2+G3 + GitHub-доступ владельца).**

### 4.1 Дефект подтверждён
`installer-src-v1.zip` (sha `ae589c10…`, release `hub-artifacts-v1`) содержит в
`setup-contract.js:695` шаг `docker-build` с `git clone https://github.com/Animastor/animastor.git`
→ **HTTP 404** (реальный ущерб: инсталлятор не может клонировать). В backend-repo
@a7a8c463 исправлено на `…/animastor-worker.git` (→ 200).

### 4.2 Исправленный источник верифицирован (read-only, staging во /tmp)
- `node scripts/stage-artifacts.cjs --write-lock --worker <target> --backend <target>`
  во **временной копии** gpu-hub-репо → staged `artifacts/installer-src/`:
  `setup-contract.js:695` = `git clone …/animastor-worker.git` (**404 убран**),
  version **0.1.1**, tree-sha **`ff27e291…`**.
- worker-bundle staged — 404-URL не обнаружен (косметика `repository.url` — не трогаем).
- Рабочий `gpu-hub/artifacts.lock.json` **не изменён** (`2a221e3b…`); временная
  копия удалена.

### 4.3 Сопутствующее наблюдение
Release `hub-artifacts-v1` (все 4 зипа) сейчас возвращает **404** (недоступны
публично), тогда как `worker-bundle-v2.1.1` — 200. Это усиливает необходимость
republish, но публикация — только в окне G3 с решением владельца (новый
immutable release vs перезаливка — выбор владельца, runbook D4).

**Запрос к владельцу:** после G2 — разрешить D4: упаковать исправленный
installer-src (источник backend-repo, tree `ff27e291…`/0.1.1), заархивировать
старый актив, опубликовать (новый immutable tag), обновить `sha256_asset` tool-ом,
повторить `--check` + скачивание. worker-bundle/workflows/install-manifests —
**не менять** (нет технической необходимости).

---

## 5. Прочее

- **E2E (G5): не выполнялся.** `E2E_WORKSPACE_ID` unset, воркеров 0
  (`/gpu/health`: gpus 0, running 0) → prerequisites красные. По правилу задачи
  значения не выдумывались, dispatch не запускался. Сам конвейер генерации
  работает (gpu-hub обрабатывает реальные image-задачи). Блокер: владелец
  задаёт workspace + поднимает worker → отдельное окно G5.
- **index.html в mono** — uncommitted-правка M3 (` M frontends/website/index.html`)
  сохранена как есть; commit в mono = фаза J (решение владельца). Живой сайт
  уже равен web-канону (`a1900f4e…`), так что функционально это закрыто.
- **Бэкапы/restore** — этап 36 PASS (все 3 направления), использованы как
  подтверждение отката; сегодня не пересоздавались.

---

## 6. Критерий завершения

| Критерий | Статус |
|---|---|
| Целевая deploy-структура работает | **ДА** — deploy/ активен, runtime переключен, config чист |
| Основные сервисы доступны | **ДА** — site/app/backend/gpu-hub/pg/redis 200/healthy |
| Сайт на актуальной версии | **ДА** — `a1900f4e…` (канон web-репо) |
| Данные и генерация сохранены | **ДА** — data байт-в-байт; PG/Redis целы; image-задачи обрабатываются |
| Git-репо и версии артефактов согласованы | **PARTIAL** — deploy работает на текущих пинах; repin/publish (новые версии) ждут G2/G3 (владелец) |
| Оставшиеся проблемы разделены | **ДА** — см. §7 |

**Миграция deploy-структуры фактически завершена и работает.** Полное «закрытие
миграции» (репин артефактов до целевых коммитов, публикация исправленного
installer-src, E2E) зависит от решений владельца и не объявляется завершённым.

---

## 7. Оставшиеся проблемы

### Блокирующие (требуют владельца)
1. **G2/C4** — письменное подтверждение целей repin (worker `b3f94f42` / backend
   `a7a8c463`) и состава republish (§3). До этого фаза D закрыта.
2. **G3** — окно + разрешение на `--write-lock` → push → CI → публикацию
   (GitHub-доступ). Зависит от G2.
3. **D4** — публикация исправленного installer-src (исходник готов, §4);
   выбор «новый immutable release vs перезаливка» — владелец. Зависит от G2+G3.
4. **G5** — E2E-окно: задать `E2E_WORKSPACE_ID` + запустить worker (сейчас
   prerequisites красные).

### Необязательные (не блокируют работу)
5. **Метки pg/redis/gpu-hub** — исторические (config_files на mono/sureg);
   косметика, проект `animastor` управляет ими корректно. Пересоздать при
   следующем штатном `up` из deploy при желании.
6. **index.html в mono** — uncommitted (commit = фаза J, решение владельца).
7. **Mono-стек** — держать ≥7 дней как rollback (runbook J3); точка невозврата
   (удаление mono/старых образов) — вне скоупа, запрещено без отдельного решения.
8. **Release `hub-artifacts-v1`** недоступен публично (404) — устранится republish (п.3).

---

## 8. Что НЕ выполнялось (запреты соблюдены)

`git push` / `--force` / `update-ref` / `commit` / `--write-lock` в рабочих
репо / публикация релизов (`gh release upload`) / repin / CI / E2E-dispatch /
`certbot renew` / `nginx -s reload` / очистка Redis / `docker image|volume prune`
/ `rm` данных, бэкапов, монорепо / пересоздание pg/redis / правка mono `.env`,
proxy-conf, DNS, lock-файлов. Секреты `.env` не печатались. Все staging-операции
с артефактами D4 выполнялись во **временной копии** `/tmp/stage37-*` (удалена);
рабочие репо/lock не изменялись.

---

## 9. Резюме для чата

**PARTIAL.** Deploy-структура **мигрирована и работает**: каталог
`/home/animastor/animastor-backend/deploy/` утверждён (G4, абсолютные пути +
`.env`-копия), E1–E4 PASS, runtime переключён (H2) — backend+nginx пересозданы
из deploy-конфига, **pg/redis/gpu-hub не тронуты**. Сервисы здоровы: health
200/200/200, site `a1900f4e…`, worker-bundle 2.1.1 `480af146…` (текущий пин),
301×3, TLS не тронуты, данные байт-в-байт, генерация работает (image-задачи
в обработке). Rollback-канал (mono compose/.env) цел.
**Блокеры (требуют владельца, ничего из этого не выполнено сознательно):**
1) **G2/C4** — письменное «да» на цели repin worker `b3f94f42` / backend `a7a8c463`
(список SHA готов в §3 отчёта); 2) **G3** — окно на push/CI/publish; 3) **D4** —
публикация исправленного installer-src (дефект 404 подтверждён, исправленный
источник верифицирован `ff27e291…`/0.1.1, публикация ждёт G2+G3); 4) **G5** —
E2E (нет `E2E_WORKSPACE_ID`/воркеров). Без репина production безопасно работает
на текущих пинах. Mono-стек сохранён как rollback (≥7 дней).
Отчёт: `/home/animastor/reorg-2026-10-12/37-migration-completion-report.md`.
