# Stage 73 — Self-heal: legacy NULL-дубли не сбрасывают канонические READY-строки

**Вердикт: PASS**

Дата: 2026-10-19 (окно 04:15–04:50 UTC)
Область: правка **только read-путей**, превращающих состояние `scene_assets` в dirty/stale-сигнал,
+ новый регрессионный тест. Запросы диагностики и правило «доказанного дубля» унаследованы из
Stage 72 §B.4 (`72-null-write-verification-and-ready-twin.md`).

**Коммит: `c343eec` → `main` (github.com:Animastor/animastor-backend + локальный bare
`/home/animastor/repos/animastor-backend.git`). Деплой НЕ выполнялся** — контейнер `animastor-backend`
по-прежнему работает на образе Stage 71 (`deploy-a7c5827`), рестартов нет. Генерация не запускалась.
Правки production-данных не выполнялось: md5 всех четырёх таблиц до/после стейджа идентичны.

Рабочие артефакты: `/tmp/opencode/stage73/` (`probe.js`, `snapshot.sh`, `baseline.txt`,
`after-run1.txt`, `final.txt`, `adapter.bak`).

---

## 0. Production baseline (зафиксирован до работ и сверен после)

| Проверка | Значение (до == после) |
|---|---|
| Образ / OCI revision | `ghcr.io/animastor/animastor-backend@sha256:2d552ec02f3ef6b0ec9684a336c821a2562e8717e7452618cffdf4ca44e0b4d0` (тот же, что в Stage 72), tag `deploy-a7c5827` |
| Контейнер | started `2026-10-18T16:00:13Z`, restarts **0**, Up 13 hours |
| health | `GET https://localhost/health` → **200** `{"status":"ok","loop":true,"redis":"PONG"}` |
| `scene_assets` всего / `build_id IS NULL` | **459 / 437** |
| `image_units` / `scenes` / `books` | **58 / 13 / 2** |
| md5 `scene_assets` (row_to_json по id) | `3610d3f6c6a2a90337a54c233d261fc9` |
| md5 `image_units` | `7c0a9861fbdce5659c943c3dc737e3d7` |
| md5 `scenes` | `b976597e13b50a9a3d032985ec6b589b` |
| md5 `books` | `bcfa87c4557c4e8645170e9552aaa612` |
| строка `21338` (канон) | `ready`, `build_id=build_import_1786345731767_1786345734345`, `updated_at=1792339221` |
| строка `48353` (NULL-дубль) | `stale`, `build_id=NULL`, `updated_at=1792339221` |
| тестовые строки (`test73%`) | **0 / 0** |

Сравнение `baseline.txt` ↔ `final.txt` (полные md5 всех таблиц) — **без различий**; разница только в
`updated_at`-поле двух контрольных строк, которое не менялось, и в gap-нумерации identity-последовательностей
(`scene_assets_id_seq` 49293 при `max(id)=48353`; аналогично `image_units_id_seq` — накопленные ранее и
мои тестовые пропуски, данных не затрагивают).

---

## 1. Корневая причина (трассировка запросов) — из Stage 72 §B.4

Цепочка, которая на **каждом старте** переводила канонический артефакт `ready → stale`:

```
runtime-scheduler / reconciliation-engine.rebuildWorkList
  → runtime-persistence-adapter.getDirtyMarkers(book)      # SELECT … FROM scene_assets
      WHERE status IN ('stale','failed','pending')          # ловит NULL-дубли 21484/48348/48351/48353
  → C0 self-heal: staleAssets не пуст → scene-state-ops.markDirtyScene(…, buildId=null)
  → scene-assets-repo.markStale(bookId, ch, sc, assetType)  # UPDATE … WHERE build_id IS NULL OR status='ready'
  → каноническая 21338 (ready) → stale → лишний dispatch-цикл (уже_ready) + шум в журнале
```

| Функция / файл | Роль | Stage 73 |
|---|---|---|
| `adapter.getDirtyMarkers` (`runtime-persistence-adapter.js:101`) | C0: dirty-маркеры ключа | ✅ предикат |
| `adapter.getAudioConfigVersions` (`runtime-persistence-adapter.js:155`) | `runtime-scheduler.detectVersionStale` (одна сцена) | ✅ предикат |
| `adapter.getVersionStalenessRows` (`runtime-persistence-adapter.js:178`) | C2 book-wide version-сигнал | ✅ предикат |
| `repo.getDirtyScenesByVersion` (`scene-assets-repo.js:686`) | C0 staleAssets: version-расхождение | ✅ предикат (только в ветке version-mismatch) |
| `repo.markStale` / `markReady` / `clearDirtyFlag` / `stampSceneVersionsForDispatch` | write-пути | ❌ **не менялись** — их семантика «весь ключ» остаётся прежней |
| `iu-processor.getSceneDuration` (`WHERE build_id=$4`) | строит по конкретному билду | ❌ не влияет (NULL-строки отсекаются самим условием) |

---

## 2. Правило «доказанного NULL-дубля»

**Определение** (`scene-assets-repo.js`, `provenNullDuplicateCondition(alias)`):

строка `sa` считается **доказанным дублем**, когда

* `sa.build_id IS NULL` (legacy-строка), **и**
* существует sibling с тем же ключом `(book_id, chapter_id, scene_id, asset_type)`,
  у которого `build_id IS NOT NULL`, `path IS NOT NULL` **и `twin.path = sa.path` (byte-identical)**.

Именно такую пару доказала Stage 72: `21338` и `48353` — один путь, один файл на диске,
`build_id` versioned-строки == `manifest.build_id`.

Предикат-обёртка `notProvenNullDuplicateCondition(alias)` (`NOT(build_id IS NULL AND EXISTS …)`)
применяется **только в четырёх чтениях-сигналах** из §1. Alias валидируется регэкспом
(защита от инъекции идентификатора). Для LEFT JOIN без строки ассета (`a.* IS NULL`) условие истинно
(`build_id IS NULL` → TRUE, EXISTS по NULL-ключу → FALSE, `NOT(FALSE)` → TRUE) — поведение
«строки без ассета» не меняется (проверено тестом C7 `worklist-rebuild`).

**Что правило сознательно НЕ покрывает** (прежнее поведение сохраняется):

| Категория | Строк в проде | Почему не покрывается |
|---|---|---|
| NULL-строки с `path IS NULL` и versioned-братом | **9** (все `ba_`) | нет доказанной artifact-идентичности (нет пути) — сюда входят и 2 синтетические pending К-5 Stage 70 |
| NULL-строки **без** versioned-брата вообще | **420** | исторические ключи двух сохраняемых книг, не все лишние |
| NULL-строки с другим/пустым путём у брата | 0 в проде | правило построено именно на byte-identity |
| синтетические pending-строки `ensureSyntheticStaleAsset` | 2 | должны оставаться dirty-маркерами (К-5, тест явно это фиксирует) |

437 = 8 (доказанные дубли) + 9 (path-NULL с братом) + 420 (без брата) — ровно как в probe.

---

## 3. Доказательства на production-данных (read-only)

Семья ключа `import_…/ch-1bb5123c/sc-5f18dd0f/audio` (единственный затронутый правилом ключ в проде):

| id | status | build_id | path |
|---|---|---|---|
| **21338** (канон) | `ready` | `build_import_…` | `…/import_…_ch-1bb5123c_sc-5f18dd0f.mp3` |
| 21484 / 48348 / 48351 / 48353 | `stale` | `NULL` | **тот же самый путь** |

| Метрика (raw SQL, без предиката → с предикатом) | до | после |
|---|---|---|
| `getDirtyMarkers` для `import_` | 4 | **3** (выпал только `sc-5f18dd0f/audio`; ни один ключ не добавлен) |
| `getDirtyMarkers` для `ba_` | 8 | **8** (нетронут) |
| `getAudioConfigVersions` для `sc-5f18dd0f` | 6 (4 дубля + канон + image) | **2** (канон audio + image) |
| `getVersionStalenessRows` (book-wide) | 17 | 17 (сцены с `content_version>1` сегодня не содержат доказанных дублей — предикат future-proofing; исключение дублей доказано синтетическим тестом C2) |

Совпадает с результатом probe: `dirty keys import 4→3`, `ba_ 8→8`, ключ не потерян — он
переходит под контроль самой versioned-строки (если `21338` станет stale/failed/pending, ключ снова
станет dirty — это проверено тестом «гейт не теряет работу»).

---

## 4. Тесты

**Новый файл** `backend/tests/null-duplicate-self-heal.test.js` (10/10 ✔, 557 ms):

1. `markDirtyScene не сбрасывает каноническую READY-строку из-за пустого NULL-дубля` — главный регрессионный тест (воспроизводит цепочку Stage 72)
2. `пустой NULL-дубль не даёт dirty-маркер, но versioned-строка того же ключа — даёт (работа не теряется)`
3. `повторный startup/self-heal идемпотентен: вторая итерация не меняет PostgreSQL`
4. `доказанный NULL-дубль не порождает version-сигнал в getDirtyScenesByVersion`
5. `C2 getVersionStalenessRows исключает доказанный NULL-дубль и оставляет versioned-строку`
6. `book-sync.markSceneAssetsStale переводит каноническую READY-строку в stale при наличии доказанного дубля` — **граница правила**: genuine invalidation работает как раньше
7. `markDirtyScene без доказанного эквивалента (другой path) сбрасывает canonical stale — прежнее поведение`
8. `legacy-ключ без versioned-эквивалента сохраняет прежнее поведение (маркер есть, markStale как раньше)`
9. `синтетическая pending-строка с path IS NULL (К-5 Stage 70) остаётся dirty-маркером`
10. `legacy-сцена с version-расхождением продолжает давать сигнал C0/C2`

Тестовая изоляция: строки с `book_id` `test73-versioned`/`test73-legacy` создаются в `scene_assets`+`scenes`
и удаляются в `afterEach`; `after` дополнительно проверяет `0` остаточных строк.

**Доказательство, что тест — настоящая регрессионная сетка**: при временном удалении предиката из
`getDirtyMarkers` тест 1 падает (`доказанный NULL-дубль не должен запускать self-heal` — actual `true`
вместо `false`), файл восстановлен из бэкапа, повторный прогон снова 10/10 ✔.

**Связанные наборы**:

| Прогон | Результат |
|---|---|
| `null-duplicate-self-heal` + `markready-build-id-idempotency` + `book-sync` + `scene-asset-registry` + `worklist-rebuild.integration` (одним запуском, прод-БД, со строгим cleanup) | **63 passing, 0 failing** (2s) |
| `npm run test:arch` | **929 passing, 24 pending, 0 failing** (4s) |
| `npm run test:syntax` (`bash ../scripts/syntax-smoke.sh`) | **All files OK** |

Процессная ошибка, пойманная до коммита: в ходе правки `getAudioConfigVersions` строка SELECT
случайно была исказлена (`a.status as asset_status` → `a.asset_status`), что валит `detectVersionStale`
(проба дала `column a.asset_status does not exist`). Обнаружено при проверке `git diff` против HEAD,
**откачено до коммита**; в коммите строка идентична HEAD, рабочий код совпадает с прод-образом.
Дополнительно восстановлен один символ отступа в комментарии `getVersionStalenessRows`.

---

## 5. Чистота PostgreSQL — PASS

| Проверка | Результат |
|---|---|
| md5 `scene_assets` / `image_units` / `scenes` / `books` до ↔ после всех прогонов | **идентичны** (`3610d3f6…`, `7c0a9861…`, `b976597e…`, `bcfa87c4…`) |
| Счётчики 459 / 58 / 13 / 2, NULL 437 | без изменений |
| Тестовые строки `test73%` (`scene_assets`, `scenes`) | **0 / 0** |
| `21338` / `48353` | `ready` / `stale` — не изменялись, `updated_at` не двигался |
| Изменённые файлы `book.json` / output / assets | 0 |
| Схема БД | не изменялась |

Единственный побочный эффект — gap-нумерация identity-последовательностей (штатно и допустимо).

---

## 6. Коммит и push

```
c343eec fix(runtime): exclude proven legacy NULL duplicates from dirty/stale signals (stage 73)
        backend/src/storage/postgres/repositories/scene-assets-repo.js |  53 ++++ (правило + getDirtyScenesByVersion + exports)
        backend/src/storage/runtime-persistence-adapter.js             |  27 +- (3 read-пути)
        backend/tests/null-duplicate-self-heal.test.js                 | 334 +++++ (новый)
        3 files changed, 412 insertions(+), 2 deletions(-)
```

* `git push origin main` → `github.com:Animastor/animastor-backend` (`e8c0a52..c343eec`) + зеркало
  `/home/animastor/repos/animastor-backend.git`.
* **Деплой / рестарт контейнера / сборка образа — не выполнялись** (по условию стейджа).
* Force-push, правки production-данных, миграции, ручное восстановление READY для `48353`,
  миграция 437 NULL-строк — **не выполнялись**.
* Посторонние изменения рабочего дерева (5 позиций: `D backend/scripts/audit-orphan-books.js`,
  `M` четыре тест-файла Stage 71) и незатрекованные `deploy/`, `freebuff-chat-*.md` — **не включались в коммит**.

---

## 7. Errata для Stage 71 §9б (записана только здесь, отчёты 71/72 не редактировались)

Stage 71 §9б приписывает переход `21338` `ready → stale` функции
`book-sync.markSceneAssetsStale`. Это **неверно**: в данном контейнере она не вызывалась ни разу
(Stage 72 §B.4). Фактический путь — `rebuildWorkList → getDirtyMarkers → C0 self-heal →
scene-state-ops.markDirtyScene(buildId=null) → scene-assets-repo.markStale`, т.е. штатный self-heal,
запускаемый наличием stale NULL-дублей ключа. Stage 73 устраняет триггер для доказанных дублей
(предикат в `getDirtyMarkers`), поэтому после следующего деплоя канонические versioned-строки
больше не будут demote'иться из-за них на старте. `markSceneAssetsStale` остаётся путём
**genuine**-инвалидации и работает без изменений (тест 6).

---

## 8. Итог по чек-листу

| # | Пункт | Результат |
|---|---|---|
| 1 | Трассировка запросов: все места, превращающие NULL-строки в dirty/stale, найдены | ✅ §1 |
| 2 | Правило сформулировано минимально (build_id NULL + byte-identical versioned-брат) | ✅ §2 |
| 3 | Правило применено только к чтениям-сигналам, `markStale`/write-пути не тронуты | ✅ §1/§2 |
| 4 | Влияние на прод-данные измерено (4→3 / 8→8 / 6→2 / 17→17) | ✅ §3 |
| 5 | Регрессионный тест падает без фикса и проходит с ним | ✅ §4 |
| 6 | Связанные наборы: 63 targeted, arch 929, syntax OK | ✅ §4 |
| 7 | Production почищен: md5 всех таблиц == baseline, тестовых строк 0 | ✅ §5 |
| 8 | Коммит только из 3 файлов стейджа, обычный push, без деплоя | ✅ §6, `c343eec` |
| 9 | Отчёт об атрибуции (errata Stage 71 §9б) | ✅ §7 |
| 10 | Остаточные риски задокументированы | ✅ §9 |

**PASS** — все десять пунктов выполнены.

---

## 9. Оставшиеся риски / наблюдения

1. **Фикс не задеплоен.** Работающий контейнер — образ Stage 71 (`deploy-a7c5827`), поведение
   «доказанные дубли больше не дёргают self-heal» включится только при следующем деплое.
   До тех пор `21338` продолжит сбрасываться на старте (как и раньше).
2. **Правило не покрывает 9 `ba_`-строк с `path IS NULL`** и 2 синтетические pending-строки (К-5) —
   у них нет доказанной artifact-идентичности. Для `ba_` это осознанно: их versioned-брат существует,
   но путь legacy-строки неизвестен. Расширение правила (например, по файлу из manifest) — отдельный стейдж.
3. **420 NULL-строк без versioned-брата сохраняют прежнее поведение** — это исторические ключи двух
   сохраняемых книг (часть из них настоящая работа, а не мусор); чистка К-4 Stage 70 не выполнялась.
4. **Сам фикс не убирает строки**: `21484/48348/48351/48353` остаются в БД (`stale/NULL`),
   `GET /versions` по-прежнему покажет по ключу 5 audio-строк — ожидаемо до стейджа чистки.
5. **Правило узкое по построению**: NULL-строка с *другим* путём, чем versioned-брат, остаётся
   dirty-маркером (тест 7 — это сознательная защита от чрезмерного глушения сигналов).
6. **`getVersionStalenessRows` (C2)** сегодня не теряет строк на прод-данных (17 → 17): доказанные
   дубли находятся на сценах с `content_version=1`, уже отсекаемых фильтром `WHERE`.
   Исключение для C2 доказано только синтетическим тестом 5 — при сдвиге версий сцен оно заработает.
7. Побочный эффект тестов — только gap-нумерация последовательностей; контейнер рантайма во время
   стейджа не рестартовался и здоров (`health 200`, restarts 0).
