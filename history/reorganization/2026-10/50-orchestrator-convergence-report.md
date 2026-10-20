# Этап 50 — Orchestrator Convergence: DONE×DIRTY, version staleness, диагностика

**Дата:** 2026-10-13
**Исходный отчёт:** `49-done-dirty-diagnosis.md`
**Статус:** ✅ PASS — фикс + 35 регрессионных тестов, полный набор зелёный относительно базы, пакет опубликован, коммиты запушены; CI-сборка image — блокер по кредам (см. §8); production НЕ переключался.
**Итоговый вердикт:** модель DONE+DIRTY восстановлена: терминальная FSM-запись не переживает явный запрос на регенерацию, DIRTY-ассеты фактически до-dispatchиваются, прежний READY-артефакт сохраняется до успешной замены, повторный reconcile/рестарт идемпотентны, ошибки планировщика больше не маскируются.

---

## 1. Root causes (подтверждены и закрыты)

Stage 49 доказал симптом (2 сцены DONE+DIRTY, 2623 rejected `setScenePending`, `INVALID state=dirty attempted=generating`, зависание без ошибок). На этапе 50 найдена полная причинная цепочка:

1. **DIRTY→PENDING-нормализация не существовала.** Контракт `ensureStageDispatchable` («NEW → PENDING → GENERATING, либо состояние, из которого GENERATING достижим») реализовал только половину: `NEW→PENDING`. При этом `VALID_TRANSITIONS[DIRTY] = [PENDING, PLACEHOLDER]` (`packages/animastor-generation/src/core/scene-state.js:67`) — `DIRTY→GENERATING` запрещён, и любой dirty-ассет (version-stale pre-pass, C1/C1b recovery, RELEASE_STALE_LEASE, markDirtyScene) физически не мог перегенерироваться через планировщик. Комментарий теста `stage-dispatch-lifecycle.test.js` («scheduler's version-stale pre-pass owns DIRTY→PENDING») описывал механизм, которого не было — rejection проглатывался в `attemptDispatch`.
2. **Терминальная запись audio-orch переживает DIRTY.** `VALID_TRANSITIONS[DONE] = []` (`backend/src/services/audio-orchestrator.js:75`), а писатели DIRTY трогали только per-asset FSM (Фаза 4 TODO — «HIGH, 0.5 дня» — 🔴 никогда не реализована).
3. **Версии ассетов не штамповались при генерации.** `scene_assets.scene_content_version/scene_audio_config_version` писались только `book-sync.markSceneAssetsStale` (при stale-marking контента). После перегенерации `completeStage` version gate (fail-closed, T1.11) сравнивал строку с актуальной версией сцены — и при старом штампе навсегда возвращал DIRTY (риск бесконечного re-dispatch после закрытия дедлока №1).
4. **C2 `checkVersionStaleness` маркировал сцену целиком** (`markDirtyScene` со ВСЕМИ ассетами по умолчанию, `unsafeRestoreAssetState` пишет DIRTY поверх GENERATING), при каждом старте — неидемпотентно и опасно для живых генераций.
5. **partial_audio_only — ложное срабатывание на живой генерации:** registry lag (image пишется в registry по завершении) + image=PENDING/GENERATING → каждый цикл PROGRESS_TO_IMAGE → rejected → бесконечный шум (issue №3 stage 49).
6. **Маскировка ошибок tick'а:** `attemptDispatch` возвращал `{dispatched:0, throttled:0, stages}` без причины — tick писал `«undefined for <scene>»`; реальные per-stage отказы (circuit_open, retry budget, lease) исчезали из observability.
7. **Мёртвая и разрушительная рекомендация:** `recommendation: 'run_completeStage'` в invariant-нарушениях никогда не роутилась в `getFixRecommendations` (default → REVIEW_MANUALLY), но если бы роутилась — стёрла бы dirty-маркер, планирующий регенерацию.

**Попутно обнаруженный дефект (вне скоупа, задокументирован):** `scene_assets UNIQUE(book,chapter,scene,asset_type,build_id)` при `build_id IS NULL` не дедуплицируется (Postgres NULLS DISTINCT) — `upsertAsset`/`markReady` с NULL build_id плодят строки: в production **450 из 503** строк scene_assets с NULL build_id; у `ch-37eadabb/sc-5f0068ca` — **427 строк image** с одним `updated_at` (один `markStale` без buildId обновил их одним UPDATE). Требуется отдельная миграция (`NULLS NOT DISTINCT`/COALESCE-индекс) — не делалась сознательно (production PG, отдельный этап).

---

## 2. Fix set (9 правок)

| № | Файл | Правка |
|---|------|--------|
| 1 | `packages/animastor-orchestration/src/orchestration/scene-orchestrator.js` (`ensureStageDispatchable`) | `NEW\|DIRTY → PENDING → GENERATING` — FSM-легальный PENDING-хоп; dirty-ассеты стали dispatchable; PENDING-хоп журналируется (SCENE_PENDING) |
| 2 | там же (`executeAudioDispatch` + экспорт `clearTerminalAudioOrchForDirty`) | ДО lifecycle-guard: phase=DONE ∧ asset=DIRTY → терминальная запись удаляется, dispatch продолжается (no_state-лега → PLACEHOLDER_READY → GENERATING). DONE+всё-остальное — прежний already_done skip |
| 3 | `backend/src/state/scene-state-ops.js` (`markDirtyScene`, Фаза 4) | `clearTerminalFsmForAssets`: audio/video-orch DONE-запись чистится через O-7/O-8 host-адаптеры (прямой require сервисов запрещён guards O7-G10/O8-G10); WAITING_CHUNKS/MERGING/FAILED не трогаются |
| 4 | там же (`setScenePending`, Фаза 5) | PENDING для audio чистит audio-orch ТОЛЬКО в фазе DONE (5.2), WAITING_CHUNKS сохраняется (5.3) |
| 5 | `packages/.../runtime/reconciliation-engine.js` (`checkVersionStaleness`, C2) | Построчная staleness-детекция (audio: content ИЛИ audio_config; image/video: content), маркировка только READY→DIRTY (FSM-легально), явный список ассетов, счётчик — только факты записи. Идемпотентно при повторном старте |
| 6 | там же (`getFixRecommendations`, `checkAudioOrchInvariants`/`checkVideoOrchInvariants`) | `run_completeStage` → `review_manually` в payload; явные кейсы `*_invariant_done`/`*_invariant_failed` → REVIEW_MANUALLY, safeToExecute=false (больше не на default-fallback) |
| 7 | там же (`checkPartialBuilds`) | PENDING/GENERATING отсутствующей стадии ≠ partial build (зеркально для image и video) |
| 8 | `packages/.../runtime/runtime-scheduler.js` (`attemptDispatch`, экспорт `attemptDispatch`) | Сбор per-stage исходов: failures → `{success:false, reason:'audio:circuit_open, …'}`, completed-only → `{completed:true}` — реальный сигнал вместо «undefined for» |
| 9 | `packages/.../runtime/dispatch-engine.js` (шаг 5.5) + `persistence-port.js` + `backend/src/storage/runtime-persistence-adapter.js` + `scene-assets-repo.js` (`stampSceneVersionsForDispatch`) | Штамп версий сцены на строку ассета при СТАРТЕ генерации (UPDATE-first по всем строкам типа; INSERT pending-строки только если строк нет — по образцу book-sync R15+, ON CONFLICT DO NOTHING; книги без строки в scenes → no-op). Best-effort: PG-авария не блокирует dispatch, gate остаётся fail-closed |

**Семантика после фикса:** `scene_assets.versions` = «версия, под которую стартовала генерация» → gate пропускает READY ровно после успешной замены, mid-generation bump по-прежнему ловится; цикл stale→regen→READY сходится.

**Запрещённые действия — соблюдены:** DONE/READY не сбрасываются преждевременно (только при явном DIRTY/PENDING-запросе на регенерацию; проверено тестами «DONE+ready → untouched», «WAITING+dirty → untouched», C1 «terminal record untouched»); файлы и registry не удаляются (прежний READY-ассет остаётся отдаваемым до замены); anti-duplicate сохранён (lease/квоты dispatch-engine; тест «второй dispatch не регенерирует»); параллельных систем не добавлено (только существующие FSM/seams/ports); идемпотентность reconciliation и рестарта доказана тестами.

---

## 3. Регрессионные тесты — 7 групп (35 тестов, `backend/tests/orchestrator-convergence.test.js`)

| Группа (задание) | Тесты | Результат |
|---|---|---|
| 1. DONE+DIRTY завершает цикл либо пере-dispatchится; не висит; не маскируется | heal DONE+dirty / DONE+ready нетронут / WAITING+dirty нетронут; DIRTY→PENDING→GENERATING с журналированием хопа; e2e regen после DONE (запись очищена, jobs отправлены); DONE+PLACEHOLDER → already_done (skip сохранён); anti-duplicate (1 генерация на 2 dispatch); Фаза 4 (audio/video/без-audio/не-DONE); Фаза 5 (5.2/5.3/чужие стадии) | ✅ 15 |
| 2. Version staleness: инициирует обновление, сохраняя прежний READY до успешной замены | C2 маркирует только реально-stale READY ассет (['audio'], не всю сцену); 2-й прогон — 0 записей; GENERATING не трогается; audio_config-staleness отдельно; registry.ready=true и файл сохраняются после READY→DIRTY | ✅ 5 |
| 3. Ремонтная рекомендация не сбрасывает успешную сцену | `*_invariant_done/failed` → REVIEW_MANUALLY/false (явные кейсы); фильтр safeToExecute пуст; payload больше не `run_completeStage` | ✅ 3 |
| 4. Идемпотентность (repeated reconcile, restart, concurrent tick, без дублей) | C1 не трогает терминальные записи; reconcileScene×2 → один и тот же issue, ноль записей; anti-duplicate из группы 1; C2-идемпотентность из группы 2 | ✅ 2 (+2 выше) |
| 5. Нет ложных срабатываний на активных сценах/lease/чанках; реальный прогон 3 issues и ожидаемый результат | partial_audio_only подавлен при image GENERATING/PENDING; остаётся для не-начатой; зеркальный partial_image_video_missing; **production-форма 3 issues**: 2× `audio_orch_invariant_done` (log-only, безопасных фиксов 0) + scene C чистый при живом lease; dispatch закрывает дедлок сцены A | ✅ 5 |
| 6. Полный регрессионный набор + сравнение failure-set | см. §4 | ✅ |
| 7. Публикация patch + CI image + smoke | см. §5–8 | ⚠️ публикация ✅, CI — блокер кредитов |

Обновлены 2 устаревших ожидания в `stage-dispatch-lifecycle.test.js` (DIRTY-abort → DIRTY проходит PENDING-хоп; e2e DIRTY-dispatch больше не упирается в FSM) — контракт комментария «must pass through reset→PENDING first» теперь реально реализован.

---

## 4. Полный набор

```
база stage 49: 3163 passing / 28 pending / 4 failing
этап 50:       3198 passing / 28 pending / 4 failing   (+35 — новые тесты)
```

Failure-set **идентичен базе** (не маскировался, не чинился):
1. `ai-endpoint-sharing.test.js:688` — «no policy row is enabled unless the owner explicitly enabled it»
2. `ai-shared-inference.test.js:806` — «16b. shared snapshot is safe for health checks»
3. `installer-package-boundary.test.js:243` — «IB-G15: package.json pins (main, bin, private)»
4. `phase5-runtime-result.test.js:401` — T9 ENOENT `backend/src/runtime/index.js`

Также прогнаны: целевой `reconciliation-engine.test.js` (84 + новые), `stage-dispatch-lifecycle`, `happy-path`, `video-orchestrator`, `audio-orchestrator`, `asset-state`; `pretest` (`scripts/syntax-smoke.sh`) — OK.

**Инцидент в ходе работы:** первый вариант `clearTerminalFsmForAssets` делал прямой `require('../services/audio-orchestrator'|'video-orchestrator')` — архитектурные guards O7-G10/O8-G10 («frozen host consumer set + adapter bridge») корректно упали. Переведено на санкционированный мост `storage/audio-fsm-adapter` / `storage/video-fsm-adapter` (ленивые резолверы сохраняют require.cache-стабы тестов). Второй инцидент: top-level require сервисов в новом тест-файле pre-загружал video-orchestrator до config-стаба `video-orchestrator.test.js` (6 ложных падений) — imports убраны, комментарий в шапке тест-файла документирует причину.

---

## 5. Публикация @animastor/orchestration 0.1.3

- `packages/animastor-orchestration/package.json` → **0.1.3** (0.1.1/0.1.2 не перезаписывались; npm `dist-tags.latest` = 0.1.3).
- Публикация выполнена оператором вручную (npm 2FA OTP недоступен с этой машины).
- **Проверка содержимого:** tarball `https://registry.npmjs.org/@animastor/orchestration/-/orchestration-0.1.3.tgz` побайтно совпадает с `packages/animastor-orchestration/` по sha256 (index.js, reconciliation-engine.js, dispatch-engine.js, runtime-scheduler.js, scene-orchestrator.js, persistence-port.js, package.json).
- `backend/package.json` → `^0.1.3`, `package-lock.json` → 0.1.3 (`integrity sha512-IICsR0kI+xFeRtmW8Ya/R/DuR057BgWAHW99elEhTlJaS9DHFK9m…`); семантический diff лока — только orchestration-запись (+добросовестная нормализация форматирования npm).
- `backend/node_modules/@animastor/orchestration` = опубликованный 0.1.3, src идентичен packages/ (canonical-copy тест зелёный).

## 6. Коммиты и пуш

```
e172075  fix(orchestration): DONE×DIRTY convergence + per-asset version staleness + dispatch version stamping (stage 50)
4e67cbd  ci(backend): approve e172075 backend tree for GHCR release (stage 50)   ← APPROVED_COMMIT обновлён
```
Запушены в `github` (Animastor/animastor-backend) и `origin` (локальный bare). `deploy/` и `freebuff-chat-*.md` — pre-existing untracked, не тронуты.

## 7. Production — состояние на момент отчёта (read-only, без изменений)

- Контейнер `animastor-backend`: `ghcr.io/animastor/animastor-backend@sha256:ceb8a5f4…` (tag `deploy-706b507`, revision 706b507) — **прошлая версия, не переключался**.
- Active index: 1 сцена — `import_…734345:ch-1bb5123c:sc-45c789c6` (image=generating, **lease живой**, audio=ready).
- Case A `ch-1bb5123c:sc-5f18dd0f`: audio-orch DONE (17/17), assets audio=dirty, image=pending, video=dirty — **вне active index**.
- Case B `ch-37eadabb:sc-5f0068ca`: audio-orch DONE (1/1, fail_reason остатки), assets audio=dirty, image=dirty, video=ready — **вне active index**.

**Ожидаемое поведение после деплоя (без ручных вмешательств):**
1. Сразу: цикл reconcile сканирует по journal — `reconcile:2_issues` вместо 3 (partial_audio_only для sc-45c789c6 исчезает: image GENERATING — не «partial»); 2× `audio_orch_invariant_done` остаются **log-only** (корректная наблюдаемость, не дедлок).
2. Обе DONE×DIRTY сцены вне active index → сами по тику не хилятся; их материализует штатный **C8 `rebuildWorkList` при рестарте** (PG `status='stale'` → needsWork → `setScenePending` → Fix 4 чистит DONE-запись → SADD active) → первый тик диспатчит регенерацию (Fix 1+2), прежние файлы остаются отдаваемыми до успешной замены, gate после штампа пропускает READY.
3. Реальная регенерация аудио Case A/B — ожидаемая GPU-работа (запрошена dirty-маркерами), под lease/бюджетом/квотами.
4. Никаких ручных правок PG/Redis/состояний не требуется.

## 8. CI-сборка backend image — БЛОКЕР (креды), команда оператора

Workflow `backend-ghcr-release` — только `workflow_dispatch` (push не собирает), проверяет `APPROVED_COMMIT == HEAD` и байт-идентичность `backend/` → обновлён на `e17207553a109501cec930078a58d67bca8aa06a`. На машине нет `gh` CLI и GitHub PAT (env/git-cred/netrc — чисто) → dispatch запустить невозможно. Оператору:

```bash
gh workflow run backend-ghcr-release \
  --repo Animastor/animastor-backend \
  --ref main \
  -f commit=e17207553a109501cec930078a58d67bca8aa06a \
  -f image_tag=deploy-e172075
# затем: digest из GitHub Step Summary записать в cutover audit,
# docker pull по digest, проверить OCI revision label = e172075…
```
Smoke в workflow изолированный (ephemeral redis, без production PG/Redis) — критерий: `/health` 200 + `redis PONG`, нет FATAL/uncaught, sha256 `src/backend.cjs`/`package.json`/`package-lock.json` = исходнику.

## 9. Rollout (после сборки image) и rollback

**Rollout (вручную, по шагам):**
1. Собрать image по §8, записать digest в cutover audit. Проверить локально `docker pull` по digest + OCI `revision=e172075…`.
2. Обновить `deploy/.env` (BACKEND_IMAGE=digest-ref), `docker compose up -d backend` (immutable tag/digest, без :latest).
3. Наблюдение 30–60 мин (read-only): логи без FATAL; `reconcile:2_issues` → после рестарта-материализации 2 сцены уходят в регенерацию и счётчик падает до 0; PG `scene_assets` — dispatch-штампы `scene_content_version == scenes.content_version` на новых регенах; ошибки tick'а (если есть) содержат читаемые причины вместо `undefined`.
4. Критерии успеха: 0 invariant-нарушений по двум сценам; READY обеих после регенерации; отсутствие повторной маркировки C2 на следующем рестарте (идемпотентность).

**Rollback:**
- Image: вернуть `BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:ceb8a5f423a6c58c26bf0958eae2c5a4c15daadab46b7a74cdde3a7a3b43e081` (deploy-706b507, текущая) + `up -d`. Прошлые теги в GHCR не перезаписывались.
- npm: pin `@animastor/orchestration` → `^0.1.2` (0.1.2 в реестре не менялся).
- Состояние: новый код не создаёт необратимых состояний — удаляет только терминальные audio/video-orch записи при явном запросе на регенерацию; PG-штамп версий без потери данных (versions = текущим версиям сцен). Возврат на старый образ оставит DONE×DIRTY сцены в прежнем дедлоке (известное, задокументированное).

## 10. Блокеры / перенос

1. **CI workflow_dispatch** — нет GitHub кредов (gh CLI/PAT) на этой машине; всё подготовлено (§8).
2. **Evidence gap из stage 49 остаётся:** точный вызывавший `markDirtyScene` для Case A/B недоказуем (нет journal-события у markDirtyScene, `reconciliation_events` пуста, логи 2026-08-16/18 не сохранены). Ранжирование прежнее; после деплоя новые `markDirtyScene`-путя видны в логах (`[DIRTY-SCENE] … cleared for re-dispatch`), что даст данные при рецидиве.
3. **Новый дефект (вне скоупа):** NULL build_id-дедупликация `scene_assets` (450/503 строк с NULL; 427 дублей image у одной сцены) — миграция отдельным этапом; до тех пор UPDATE-first-штампы и `markStale` без buildId остаются корректными (обновляют все строки типа).
4. **Известная особенность (pre-existing):** executor-результат `already_done` с `completed:true` пропускает `finalizeDispatch` → lease/quota живут до TTL (компенсируется counter-reconciliation); менять семантику не стал (поведение зафиксировано тестом, риск неоправдан).

## 11. Файлы

Код: `packages/animastor-orchestration/src/orchestration/scene-orchestrator.js`, `…/runtime/{reconciliation-engine,runtime-scheduler,dispatch-engine,persistence-port}.js`, `backend/src/state/scene-state-ops.js`, `backend/src/storage/{runtime-persistence-adapter.js, postgres/repositories/scene-assets-repo.js}`.
Тесты: `backend/tests/orchestrator-convergence.test.js` (новый), `backend/tests/stage-dispatch-lifecycle.test.js`, `backend/tests/reconciliation-engine.test.js` (stage-49 блок закоммичен).
Релиз: `packages/animastor-orchestration/package.json` (0.1.3), `backend/package.json` + lock, `.github/workflows/backend-ghcr-release.yml` (APPROVED_COMMIT).
