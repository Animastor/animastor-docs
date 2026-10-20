# Этап 51 — Orchestrator Convergence: production rollout

**Дата:** 2026-10-14
**Исходный отчёт:** `50-orchestrator-convergence-report.md` (§8 — CI, §9 — rollout/rollback)
**Статус:** ⚠️ **PARTIAL** — CI-сборка зелёная, production переключён на утверждённый digest, ВСЕ доступные production-проверки зелёные, rollback не потребовался; **PARTIAL** только потому, что два пункта контроля (§9 «READY обеих DONE×DIRTY-сцен после регенерации» и «явный DONE×DIRTY regen в production») наблюдаемы только при запуске генерации, который запрещён заданием (п.8) и/или заблокирован pre-existing пробелом данных (книга Case A/B отсутствует в таблице `scenes` → C8 не может её материализовать). Они закрыты регрессионными тестами и помечены как ограничения (§8).

---

## 1. Проверка актуальности ПЕРЕД rollout (всё ✅)

| Проверка | Результат |
|---|---|
| HEAD репозитория | `4e67cbd` (`ci(backend): approve e172075…`), рабочее дерево чистое (pre-existing untracked `deploy/`, `freebuff-chat-*.md` не тронуты) |
| `APPROVED_COMMIT` в workflow | `e17207553a109501cec930078a58d67bca8aa06a` |
| backend-дерево `e172075..4e67cbd` | пусто (`git diff --quiet … -- backend/` → EMPTY; коммит 4e67cbd менял только `.github/workflows/…`) |
| Pin | `backend/package.json` → `@animastor/orchestration: ^0.1.3` |
| Lock | `backend/package-lock.json` → `0.1.3`, integrity `sha512-IICsR0kI+xFeRtmW8Ya/R/DuR057BgWAHW99elEhTlJaS9DHFK9mpjqQEvpI7clwR9PN8iH0um/NOFRUCFaUhw==` — **пересчитанный sha512 скачанного с registry тарбола совпал байт-в-байт** |
| Содержимое 0.1.3 | `registry.npmjs.org/.../orchestration-0.1.3.tgz` ↔ `packages/animastor-orchestration/` — `diff -r src` + `package.json` идентичны; `backend/node_modules/@animastor/orchestration` ↔ `packages/` — идентичны |
| Тег в registry на момент старта | `deploy-e172075` и full-sha тег **отсутствовали** (сборка не дублировалась, теги не перезаписаны) |

## 2. CI-сборка (§8) — запущена, не имитирована

- **Учётные данные:** `gh` CLI и PAT в окружении отсутствуют (как в stage 50). Найден существующий `ghcr.io` classic PAT в `~/.docker/config.json` (scopes: `repo, write:packages`) — им же опубликованы прошлые образы. Он пригоден и для Actions API. **Действие владельца не потребовалось.** Токен в отчёт/логи не выведен.
- **Диспатч:** `POST /repos/Animastor/animastor-backend/actions/workflows/382231446/dispatches` `ref=main`, `inputs.commit=e17207553a109501cec930078a58d67bca8aa06a`, `inputs.image_tag=deploy-e172075` → **204**.
- **CI run:** `38501918404` — https://github.com/Animastor/animastor-backend/actions/runs/38501918404
  - 2026-10-14T02:36:29Z → 02:38:10Z, **completed / success** (job `build + isolated smoke + push to GHCR` — все шаги success).
  - `Verify source commit (fail-closed)` ✅ (HEAD == requested == APPROVED_COMMIT; backend-дерево == approved).
  - `Build image` ✅.
  - `Isolated smoke` ✅ — `SMOKE OK`, `health: 200 {"status":"ok","redis":"PONG"}`, `crash-signature lines: 0`, sha256 `src/backend.cjs`/`package.json`/`package-lock.json`/`Dockerfile` image == source.
  - `Push immutable tags` ✅ — оба тега «not present, ok to push», затем push.
- **Digest (из push-лога, оба тега одинаковы):**
  `ghcr.io/animastor/animastor-backend@sha256:8440ced71cc28d90759782581c13c15dfd3d9144761383fab67326c62db19f6b`
  (теги: `deploy-e172075`, `e17207553a109501cec930078a58d67bca8aa06a`).
  *Примечание:* строка `Digest: sha256:4fa24486…` в середине лога — это pull-дайджест `redis:7` из шага smoke, не наш образ (проверено по контексту лога `Status: Downloaded newer image for redis:7`).
- **Локальная верификация перед rollout:**
  - `docker pull …@sha256:8440ced7…` ✅ (digest immutable и доступен в registry);
  - `docker buildx imagetools inspect :deploy-e172075` → тот же digest `8440ced7…` ✅;
  - OCI labels: `org.opencontainers.image.revision=e17207553a109501cec930078a58d67bca8aa06a`, `version=deploy-e172075` ✅;
  - внутри образа `node -p require('/app/node_modules/@animastor/orchestration/package.json').version` → **0.1.3** ✅;
  - sha256 `/app/src/backend.cjs`, `/app/package.json`, `/app/package-lock.json` == исходнику репо ✅.

## 3. Rollback-снимок ДО переключения

`/home/animastor/reorg-2026-10-12/rollback-51/`:
- `env-before` (копия `deploy/.env`, chmod 600) — `BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:ceb8a5f423a6c58c26bf0958eae2c5a4c15daadab46b7a74cdde3a7a3b43e081` (deploy-706b507, revision 706b507);
- `container-inspect-before.json` (контейнер `animastor-backend`, до пересоздания);
- `image-inspect-before.json` (образ по digest `ceb8a5f4…`);
- `compose-config-before.yml` (`docker compose config` до правки).

Сохранённый для отката digest (§9): **`sha256:ceb8a5f423a6c58c26bf0958eae2c5a4c15daadab46b7a74cdde3a7a3b43e081`**.

## 4. Rollout (только backend, по §9)

1. `deploy/.env`: `BACKEND_IMAGE` → `ghcr.io/animastor/animastor-backend@sha256:8440ced7…` (единственная правка).
2. Рендер `docker compose config` до/после — **diff ровно одна строка** (image backend'а); gpu-hub/nginx/postgres/redis не затронуты.
3. `docker compose --project-name animastor --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend`.
4. Результат: контейнер `animastor-backend` пересоздан (id `c399448d…`, image `8440ced71cc2`, старт 2026-10-14T02:40:34Z), OCI revision = `e172075…`.
5. **Не пересоздавались** (uptime не изменился): `animastor-pg`/`animastor-redis` (7 weeks, healthy), `gpu-hub` (37h), `animastor-proxy` (39h). Bind-mount'ы, DNS/TLS, тома — без изменений. Схемы PG/Redis не менялись (штатные idempotent-init-миграции при старте приложения — как до rollout). Миграция NULL `build_id` **не выполнялась** (450/503 не тронуты).

**Rollback НЕ выполнялся** — все проверки прошли.

## 5. Production-проверки после rollout

Окно наблюдения: **02:40:34Z → 03:10:28Z (~30 мин, минимум по §9)**; все значения перепроверены многократно (в т.ч. на 14/22/29-й минутах — стабильны).

| # | Проверка | Результат |
|---|---|---|
| 1 | `/health` | ✅ 200 `{"status":"ok","loop":true,"redis":"PONG"}` (через nginx, https://animastor.org/health) |
| 2 | `/gpu/health` | ✅ 200 `{"gpus":0,"queues":{...},"running":0}` |
| 3 | Доступность сайта | ✅ `https://animastor.org/` 200, `https://app.animastor.org/` 200, http→301 |
| 4 | Соединение backend ↔ PostgreSQL | ✅ `[PG] PostgreSQL storage initialized`; `listBooks`/reconcile-запросы к `scenes`/`scene_assets` выполняются каждый цикл без ошибок; прямой `psql`-контроль чтения — ок |
| 5 | Соединение backend ↔ Redis | ✅ `redis:PONG` в /health, `[DRIFT] COUNTER_RECONCILIATION_COMPLETE: 0 corrected, 0 total drift`, lease renewal каждые 30 с |
| 6 | Новые startup/FATAL/TypeError/uncaught | ✅ **0** строк `FATAL|TypeError|uncaught` за весь журнал нового контейнера; **0** `undefined for <scene>` (Fix 8: причины per-stage отображаются) |
| 7 | C2/version-staleness не пишет DIRTY поверх GENERATING | ✅ во всех фазах (включая startup) **нет** `version_stale:N`; **0** событий `DIRTY-SCENE`; строк staleness в PG — только со `status='stale'`, а C2 маркирует исключительно READY→DIRTY → 0 записей; активная image-стадия осталась `generating` |
| 8 | DONE + DIRTY при явном запросе на регенерацию (путь FSM) | ⚠️ **только тестами**: полный прогон — 35 тестов `orchestrator-convergence.test.js` зелёные (NEW\|DIRTY→PENDING→GENERATING, очистка терминальной записи, anti-duplicate, «READY не тронут»). В production **не запускалось** — п.8 запрещает генерацию на пользовательских книгах; см. §8.1 |
| 9 | READY-ассет сохраняется до успешной замены | ✅ до/после идентично: `scene_assets` 503 строк (17 ready / 454 stale), включая Case B `video=ready(1)`, `sc-a740d763 image=ready, video=ready(5)`, `sc-45d38693 …`; ни одна READY-строка не сброшена |
| 10 | Повторный dispatch не создаёт дубликатов | ✅ ровно **1** `DISPATCH_REQUEST` / **1** `ATTEMPT_DISPATCH` за всё время (9 IU-джобов под одним `dispatch-1791945640896-…`); счётчик строк PG не вырос (503 → 503) |
| 11 | Диагностика не выдаёт `partial_audio_only` для активной генерации | ✅ startup `reconcile:3_issues` → steady-state **`reconcile:2_issues`**; обе — ровно `[INVARIANT] … audio-orch violations` по Case A/B (log-only, REVIEW_MANUALLY); `partial_audio_only` отсутствует — активная image-генерация не считается «partial» (ожидание §7.1 подтверждено) |

**Аномалия старта (задокументирована, не регрессия этапа):** в startup-цикле сработал pre-existing `orphan_generating_repair`: активная image-стадия `generating → dirty → pending` + `SCENE_PENDING`, затем **один** dispatch (9 задач) и `generating` снова. Это repair-путь (после рестарта in-flight registry пуст), не C2; после него steady-state стабилен: 2 invariant-issue, 0 ошибок.

**Повторная маркировка C2 на рестарте (идемпотентность):** доказана отсутствием фазы `version_stale` и нулём DIRTY-записей уже на первом startup-цикле; **второй рестарт backend сознательно не выполнялся** — он повторно вызвал бы `orphan_generating_repair` и повторный dispatch 9 задач, что выглядело бы как дубликаты (§8.6).

## 6. Полный набор тестов (безопасный сценарий, без генерации)

```
base stage 49/50: 3198 passing / 28 pending / 4 failing
этап 51 (после rollout): 3198 passing / 28 pending / 4 failing
```
Failure-set **идентичен базе**: `ai-endpoint-sharing.test.js:688`, `ai-shared-inference.test.js:806`, `installer-package-boundary.test.js:243` (IB-G15), `phase5-runtime-result.test.js:401` (T9 ENOENT). `pretest` (`scripts/syntax-smoke.sh`) — OK.

*Инцидент инструментария:* первый запуск `npm test` — shell-глоб `tests/**/*.test.js` развернулся до `tests/*/*.test.js` и прогнал подмножество (927 passing). Авторитетный прогон — `npx mocha --exit "tests/**/*.test.js"` (глоб обрабатывает mocha) → 3198. В stage-50 отчёте использовался, видимо, тот же паттерн; зафиксировано здесь.

## 7. Rollback

**Не выполнялся.** Процедура готова (§9):
1. `deploy/.env`: `BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:ceb8a5f423a6c58c26bf0958eae2c5a4c15daadab46b7a74cdde3a7a3b43e081` (копия — `rollback-51/env-before`);
2. `docker compose --project-name animastor --env-file .env -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend`;
3. npm (если нужно): pin `@animastor/orchestration` → `^0.1.2`.
Состояние обратимо: новый код удаляет только терминальные audio/video-orch записи при явном запросе на регенерацию; PG-штампы версий без потери данных.

## 8. Ограничения / что НЕ удалось наблюдаемо подтвердить

1. **Case A/B (DONE×DIRTY) не материализовались при рестарте — ожидание §7.2 не сбылось.** Причина: фаза C8 `rebuildWorkList` берёт книги из `listBooks` = `SELECT DISTINCT book_id FROM scenes`, а книга `import_1786345731767_1786345734345` (owner Case A `ch-1bb5123c:sc-5f18dd0f` и Case B `ch-37eadabb:sc-5f0068ca`) **не имеет строк в `scenes`** (таблица содержит 3 книги / 12 сцен — этих сцен там нет; в `scene_assets` они есть). Итог: active index = 1 сцена, две invariant-issue остаются log-only, регенерация аудио Case A/B не стартовала → критерий §9.4 «READY обеих после регенерации» **в рамках этапа недостижим**. Это pre-existing пробел данных (той же семьи, что NULL `build_id`), не регрессия stage 50/51; чинить отдельным этапом (не трогал).
2. **`ba_1788172242081` не материализован — корректно:** в layer-config книги `audio_enabled=false, image_enabled=false, video_enabled=false` → C8 пропускает все стадии (0 сцен добавлено, `scenesAdded=0` без ошибок). Не дефект.
3. **GPU-генерация не наблюдаема:** GPU Hub отвечает `gpus:0, running:0`, workspace-очередь image выросла 306 → 315 (приняты 9 задач), потребителя нет. Было так **и до rollout** (baseline `gpus:0`) — pre-existing отсутствие зарегистрированных worker/GPU. Задачи висят в очереди, прогресс/замена READY-ассета image до успешного завершения не наступит.
4. **Явный DONE×DIRTY regen «в лоб» в production не выполнялся** (п.8 запрещает). Путь FSM подтверждён только 35 регрессионными тестами. Для production-подтверждения нужен безопасный тестовый workspace/книга — сейчас недоступен.
5. **Повторный рестарт** не выполнялся (см. §5, идемпотентность C2 доказана иначе).
6. **NULL `build_id` (450/503)** — не трогал, миграция не выполнялась (п.10). Схемы PG/Redis не менялись, books/assets/output не удалялись, DNS/TLS/GPU Hub не менялись.

## 9. Файлы / артефакты

- Rollback-снимок: `reorg-2026-10-12/rollback-51/{env-before,container-inspect-before.json,image-inspect-before.json,compose-config-before.yml}`
- CI-лог job'а: сохранён в `/tmp/opencode/ci-job.log` (run 38501918404); полный прогон тестов: `/tmp/opencode/full-suite-51b.log`
- Изменённые файлы в репо: **нет** (только `deploy/.env` — untracked deploy-каталог, вне git)
- Релиз/код stage 50: без изменений (`e172075`, `4e67cbd`, `@animastor/orchestration@0.1.3`)
