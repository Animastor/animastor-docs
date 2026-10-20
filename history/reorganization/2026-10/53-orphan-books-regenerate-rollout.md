# Этап 53 — фикс /regenerate (materialize-before-reset) + production rollout

**Дата:** 2026-10-14
**Вердикт:** **PASS** — все 12 пунктов закрыты; rollout выполнен; аудит до/после идентичен (23 issues, дрейф 0); безопасный probe `/regenerate` подтвердил materialize-before-reset и идемпотентность на реальном production PG.

---

## 1. Что делал этот этап

Задача этапа 53 — довести до продакшна фикс этапа 52 (`ensureSceneRow` до `resetScenes` в `/regenerate`): проверить diff и семантику, дополнить тесты, прогнать полный набор, закоммитить, собрать immutable backend image через CI, выполнить rollout **только backend-сервиса**, после rollout — health/логи/read-only аудит orphan-books до/после, безопасную проверку `/regenerate` без реальной генерации. Без автовосстановления 13 невидимых книг, без изменений схемы/данных.

## 2. Ревью diff и семантики фикса (п.1–3)

Diff stage 52 (не закоммиченный) проверен по всем трём пунктам:

| Требование | Реализация | Статус |
|---|---|---|
| Создаёт **только реальные необходимые** строки сцен из данных книги | `ensureSceneRow` вызывается строго для сцен `filteredDirty` — все они происходят из `book.collectScenes(loadedBook)` (реальные сцены book.json) или из PG-флага dirty (`getFlaggedDirtyScenes`); синтетических/догадочных строк нет | ✅ |
| Корректно обрабатывает пустую/повреждённую книгу | Отсутствующая книга → `loadBook` null → **404 до любого прикосновения** (новый тест); пустой список сцен → цикл ensure — no-op, `resetScenes([])` marked=0 (новый тест); сломанная строка (ensure падает) → per-scene fail-open + warn | ✅ |
| Безопасно повторяется, нет дубликатов | `INSERT … ON CONFLICT DO NOTHING` (PK `scenes`), повторный вызов `/regenerate` — повторный ensure той же строки без дубликата (route-тест + DB-тест); lock освобождается в `finally` → повторный sequential-вызов принимается, не 429 | ✅ |
| Не сбрасывает состояние до успешной материализации | Все попытки ensure **завершаются до** первого вызова `resetScenes` (порядок проверен DB-уровнем в production-probe: на момент reset строка `scenes` уже существует) | ✅ |
| Не скрывает ошибки за fail-open | **Усилено на этом этапе:** per-scene warn + сводный warn `materialization FAILED for N/M scene(s): <id…>` со списком неудавшихся сцен; успешный случай логируется как `materialized scenes rows for N scene(s)` (observability для post-rollout проверки) | ✅ |
| Не запускает генерацию автоматически | Фикс только материализует строки; dispatch/task-создание не изменялись; probe подтвердил: 0 новых `generation_tasks`, 0 dispatch | ✅ |

Изменение stage 53 в `generation-routes.cjs`: счётчик `scenesRowsFailed`, сводный warn + success-log (+15 строк, семантика fail-open не менялась).

## 3. Тесты (п.3–4)

Добавлено **6 тестов** (итого по фиксу 12):

**`generation-routes.test.js` (+4, файл 20 passing):**
1. ensureSceneRow для каждой dirty-сцены до reset (stage 52) — сохранён
2. fail-open при отказе ensureSceneRow — сохранён
3. **повторный `/regenerate`** — оба вызова 200, lock не течёт, ensure пере-вызывается (дедупликация — ответственность repo, ON CONFLICT)
4. **частичная ошибка** (2-я сцена падает) — обе попытки до reset, reset увидел обе сцены, per-scene warn + сводный warn со списком
5. **пустая книга** (collectScenes → []) — 0 ensure, reset с 0 сценами, marked=0, dirty_scenes=[]
6. **отсутствующая книга** — 404 до ensure/reset/задач

**`orphan-books-diagnosis.test.js` (DB-level, 6 passing):** Class I/II/III/IV, recovery+идемпотентность, **сохранность READY-строк `scene_assets`** после ensureSceneRow (новая ассерция: строка ассета не тронута), SELECT-only инвариант.

**Прогон:**
- `npm run pretest` — OK
- Таргетированный: **22 passing** (generation-routes + orphan-books-diagnosis + sql-boundary)
- Полный: **3210 passing / 28 pending / 4 failing** — прирост ровно +4, failure-set идентичен базе stage 52 (pre-existing: `ai-endpoint-sharing`, `ai-shared-inference`, `installer-package-boundary`, `phase5-runtime-result`). SQL-boundary: без изменений (новый код не импортирует `postgres/database` вне storage).

## 4. Коммит и сборка (п.5–6)

- `c7eaa9c` — `fix(regenerate): materialize scenes rows before reset + orphan-books read-only audit (stages 52–53)` (5 файлов, +984)
- `4f6c779` — `ci(backend): approve c7eaa9c backend tree for GHCR release (stage 53)` (APPROVED_COMMIT)
- Push origin + github: OK
- **npm:** публикация не потребовалась — изменения только в `backend/` (не-published пакет), `@animastor/orchestration`/прочие пакеты не тронуты.
- **CI:** dispatch `POST …/workflows/382231446/dispatches` (PAT из docker config, как stage 51) → 204; run **[38512846612](https://github.com/Animastor/animastor-backend/actions/runs/38512846612)** — **success** (build + isolated smoke + push).
- **Image:** `ghcr.io/animastor/animastor-backend@sha256:71ab14683267df51463700a00ff0d4084a9ce2ef34661ae44dc9d1ebba4abcd8` (tag `deploy-c7eaa9c`, revision `c7eaa9cf…`)
- **Provenance:** OCI revision == c7eaa9c; `generation-routes.cjs` в образе sha256 == исходник (byte-for-byte).

## 5. Rollback-подготовка (п.7)

Сохранено в `/home/animastor/reorg-2026-10-12/rollback-53/`:
- `container-inspect-before.json` / `env-before` — текущий прод: image `sha256:8440ced71cc2…` (deploy-e172075, revision e172075)
- `image-inspect-before.json`, `infra-inspect-before.json` (pg/redis/gpu-hub), `compose-config-before.yml`, `docker-compose-before.yml`
- `env-after` / `container-inspect-after.json` — после rollout

**Откат (только backend):** в `deploy/.env` вернуть `BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:8440ced71cc28d90759782581c13c15dfd3d9144761383fab67326c62db19f6b` и выполнить `docker compose --project-name animastor --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend`. Следующий кандидат отката (stage 48): `ceb8a5f4…`.

## 6. Rollout (п.7–8)

Единственная правка: `deploy/.env` `BACKEND_IMAGE` → `sha256:71ab1468…`. Затем `up -d backend` (только backend-сервис; `build: !reset null`, src из образа, data/ai/tests-монтирования сохранены).

**После rollout:**
- Контейнер: running, image `71ab1468…`, revision `c7eaa9c`, старт 04:49:58Z
- `/health` → `200 {"status":"ok","loop":true,"redis":"PONG"}`
- Логи: **0 FATAL / 0 uncaught / 0 ERROR**; startup-reconcile: `reconcile:3_issues` (2 counter-log-only ghost-book + 1 audio-orch invariant — тот же профиль, что stage 51), steady-state осел на **2_issues**; один `orphan_generating_repair` (pre-existing repair-путь на живом lease import-книги — штатно, как stage 51)
- PG: `scene_assets=503, scenes=12, books=5` — счётчики **не изменились**; Redis PONG
- Соседи нетронуты: gpu-hub 39h, proxy 41h, pg/redis 7 weeks

## 7. Аудит orphan-books до/после (п.8)

Read-only CLI (`BOOKS_DIR=… node scripts/audit-orphan-books.js`):

| | до rollout | после rollout + probe |
|---|---|---|
| issues | **23** | **23** |
| Class I (невидимые) | 13 | 13 |
| Class II (ghost-scenes) | 2 | 2 |
| Class III (disk-only bundle) | 1 | 1 |
| Class IV (NULL build_id) | 7 keys / 427 redundant | идентично |

`diff` полных отчётов — пустой: **AUDIT IDENTICAL BEFORE/AFTER** (логи: `/tmp/opencode/audit-before-53.log`, `audit-after-53.log`). 13 невидимых книг **не тронуты** (никакого автовосстановления).

## 8. Безопасный probe `/regenerate` (п.9)

HTTP-путь `/regenerate` в проде закрыт `requireBookAccess` (workspace-membership): анонимный запрос получает 403 до handler'а (заодно проверено: посторонний не может триггерить regenerate). Полноценный member-сценарий (guest scratch-book) отклонён как непропорциональный: не создавая book через API нет способа потом чисто удалить его (DELETE-book route отсутствует) — оставил бы residue в аудите.

Применён **in-container probe** (`/tmp/stage53-probe.js`, запущен в production-контейнере, после — удалён): реальный `scene-assets-repo` + реальный PG + реальный Redis-lock; синтетическая книга `__stage53_probe__` (никогда не пользовательская); `resetScenes`/`createTasks` — заглушки (0 генерации); probe-строки удаляются после проверки.

Результат (2 последовательных вызова `rebuild_all`, `worker_types:['audio']`):

| Проверка | Результат |
|---|---|
| call1 / call2 | 200 / 200, dirty=1, marked=1 |
| **materialize-before-reset** | на момент каждого `resetScenes` строка `scenes` уже существовала (`rows_at_reset=1` ×2) |
| **идемпотентность** | 2 вызова → ровно **1** строка в `scenes` |
| сброс cleanup | probe-строки удалены: `scenes WHERE book_id LIKE '%probe%'` = 0 |
| **побочные эффекты** | `scene_assets=503` (=baseline), `generation_tasks=17` (=baseline), redis-ключи probe отсутствуют, лог backend без PROBE/ERROR-следов |

## 9. Запреты — соблюдены

Не восстанавливались 13 невидимых книг; ничего не удалялось (assets/output/bundles/ghost-scenes/NULL-build-записи); схема БД не менялась (те же idempotent startup-ALTER, что и раньше); пересоздавались только backend-контейнер (pg/redis/gpu-hub/proxy — uptime не прерывался); npm-версии не публиковались и не бампались; реальная генерация пользовательских книг не запускалась.

## 10. Итог

| Пункт | Статус |
|---|---|
| 1–3. Ревью семантики + усиление (summary warn) | ✅ |
| 4. Тесты: целевые 22 + полный 3210 pass, failure-set = база | ✅ |
| 5. Коммит `c7eaa9c` (+approve `4f6c779`), push | ✅ |
| 6. CI run 38512846612 success; digest `sha256:71ab1468…`, provenance OK | ✅ |
| 7. Rollback-снимок `rollback-53/`; откат по инструкции | ✅ |
| 8. Rollout только backend; health/logs/PG/Redis OK | ✅ |
| 9. Аудит до/после: 23 → 23, diff пустой | ✅ |
| 10. Безопасный probe: before-reset ✓, идемпотентность ✓, 0 эффектов | ✅ |
| 11. Без автовосстановления/удалений/schema-изменений | ✅ |
| 12. Отчёт + краткий итог | ✅ |

**Production сейчас:** backend `ghcr.io/animastor/animastor-backend@sha256:71ab1468…` (deploy-c7eaa9c, revision c7eaa9c), steady-state reconcile 2_issues, аудит 23 issues (как до этапа — ожидаемо: фикс предотвращает будущие Class I через `/regenerate`, существующие 13 книг восстанавливаются только отдельным этапом с явным решением владельца).
