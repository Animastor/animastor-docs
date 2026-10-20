# Stage 74 — Deploy NULL-duplicate self-heal fix and verify production

**Вердикт: PASS**

Дата: 2026-10-19 (окно 04:55–05:15 UTC)
Область: деплой коммита Stage 73 (`c343eec`) штатным CI/релизным процессом + read-only верификация
в проде. Чистка/миграция `scene_assets` **не выполнялась**.

**Деплойнутый образ:** `ghcr.io/animastor/animastor-backend@sha256:02049cc2e26ce26e761af4ad0fddcbb857471adb47a9979e91f607d690b4cde6`
(теги `deploy-c343eec` и полный sha), OCI revision **`c343eec45d373e528aa180ec229ebfe65b185c67`**.
Контейнер: started `2026-10-19T05:05:15Z`, restarts **0**, health **200**.

Рабочие артефакты: `/tmp/opencode/stage74/` (`c343eec.diff`, `baseline.json`, `dispatch74.json`,
`compose-up.log`, `logs-startup.txt`, `logs-full.txt`, `T0-after-start.json`, `T1-after-start.json`,
`T2-after-start.json`, `versions-*.json`); rollback: `reorg-2026-10-17/rollback-74/`
(`env-before`, `container-image-before.json`, `pre-deploy-state.txt`).

---

## 0. Pre-flight — все preconditions выполнены, расхождений нет

### 0.1 Коммит на remote/branch + точный diff

| Проверка | Результат |
|---|---|
| `origin` (локальный bare) `main` | **`c343eec45d373e528aa180ec229ebfe65b185c67`** ✅ |
| `github` `refs/heads/main` | **`c343eec45d373e528aa180ec229ebfe65b185c67`** ✅ |
| Содержимое diff (`git show c343eec`) | 3 файла, +412/−2: `scene-assets-repo.js` (+53), `runtime-persistence-adapter.js` (+27/−2), `tests/null-duplicate-self-heal.test.js` (новый, 334) — сохранено в `c343eec.diff` (506 строк) |

### 0.2 CI / релизные гейты (без обходов)

| Гейт | Состояние |
|---|---|
| Branch protection `main` | отсутствует (`protected=false`) |
| GitHub environments / required reviewers | **0** |
| Actions permissions | enabled, allowed_actions=all |
| Workflow `backend-ghcr-release` (id 382231446) | active; последний успех — Stage 71 run 39142624677 |
| **Fail-closed provenance pin `APPROVED_COMMIT`** | был `a7c5827…` → для `c343eec` CI обязан упасть; штатный процесс одобрения (прецедент Stage 71) = коммит-одобрение, поднимающий пин |

Дополнительных требований (тестовые гейты репо) — Stage 73 уже прогнал: targeted 10/10 + 63,
`npm run test:arch` 929, `npm run test:syntax` OK.

### 0.3 Production до деплоя — Stage 71, без изменений

| Проверка | Значение |
|---|---|
| Образ / RepoDigest | `sha256:2d552ec02f3ef6b0ec9684a336c821a2562e8717e7452618cffdf4ca44e0b4d0` |
| labels | revision `a7c58279f149c9361882b42efffa84fa69c7535f`, version `deploy-a7c5827` |
| Контейнер | started `2026-10-18T16:00:13Z`, restarts **0**, running |
| health | **200** `{"status":"ok","loop":true,"redis":"PONG"}` |
| `deploy/.env` пин | `BACKEND_IMAGE=…@sha256:2d552ec0…` (строка 39) |

### 0.4 Read-only baseline (05:00:06 UTC, `/tmp/opencode/stage74/baseline.json`)

| Проверка | `ba_1788172242081` | `import_…4345` | Всего |
|---|---|---|---|
| сцены / assets / NULL-строк | 8 / 26 / 9 | 5 / 433 / 428 | 13 / **459 / 437** |
| статусы assets | placeholder 9, stale 17 | pending 2, ready 18, stale 413 | — |
| dirty-маркеры (сырой SQL без предиката = поведение старого кода) | **8** | **4** (`sc-45c789c6/image`, `sc-5f18dd0f/audio`, `sc-5f18dd0f/image`, `sc-5f0068ca/image`) | 12 |
| то же с предикатом Stage 73 (= поведение нового кода) | **8** (не меняется) | **3** (выпадает только `sc-5f18dd0f/audio`) | 11 |

| Контроль | Значение (baseline) |
|---|---|
| строка `21338` | `ready`, `build_id=build_import_…`, `updated_at=1792339221`, путь `…sc-5f18dd0f.mp3` |
| строка `48353` | `stale`, `build_id=NULL`, `updated_at=1792339221`, **тот же путь** |
| семья audio `sc-5f18dd0f` | 5 строк: `21338` ready + `21484/48348/48351/48353` stale/NULL, все с одним и тем же `path` |
| SHA-256 `book.json` | `ba_` `e50bcc6147d9331af6409947ef84ff93c5f5ee20bef2d7af69b681c1ae295ae2`; `import_` `60e6e4b11f77a9a650b709b525f4643fab0d6e81a311155933927abb4a0a26ea` (контрольные значения Stage 70–73) ✅ |
| md5 таблиц | `scene_assets` `3610d3f6…`, `image_units` `7c0a9861…`, `scenes` `b976597e…`, `books` `bcfa87c4…` (== Stage 73 final) |
| тестовые строки (`test%`/`ghost%`) | **0 / 0** |
| `max_id` / `max(updated_at)` | `48353` / `1792339221` |

Все preconditions совпали с ожидаемым состоянием → **расхождений нет, деплой разрешён**.

---

## 1. Одобрение и CI — PASS

### Коммит-одобрение (штатный гейт Stage 71, без обхода)

```
9783963 ci(backend): approve c343eec backend tree for GHCR release (stage 74)
        → .github/workflows/backend-ghcr-release.yml: APPROVED_COMMIT a7c58279… → c343eec45… (1/1)
```

Закоммичен и запушен обычным `git push origin main` (зеркалирование в GitHub подтверждено:
`c343eec..9783963 main -> main`); пять посторонних изменений рабочего дерева **не включались**.

### Dispatch и run

| Шаг | Результат |
|---|---|
| Теги `deploy-c343eec` / полный sha в registry | **не существовали** (mutable-гейт не задет) |
| Пин на remote `main` | `APPROVED_COMMIT: c343eec45d373e528aa180ec229ebfe65b185c67` ✅ |
| `POST …/workflows/382231446/dispatches` (`ref=main`, `commit=c343eec…`, `image_tag=deploy-c343eec`) | **204** |
| Run **[39202375727](https://github.com/Animastor/animastor-backend/actions/runs/39202375727)** (head `9783963`) | **completed / success** (05:02:55 UTC, ~105 s) |
| Шаги job | Verify source commit (fail-closed) ✅, Build ✅, Isolated smoke ✅, Push immutable tags ✅, Record digest ✅ (+ все Post-* ✅) |

### Образ проверен до деплоя

| Проверка | Результат |
|---|---|
| RepoDigest | **`sha256:02049cc2e26ce26e761af4ad0fddcbb857471adb47a9979e91f607d690b4cde6`** |
| labels | revision `c343eec45d373e528aa180ec229ebfe65b185c67`, version `deploy-c343eec` ✅ |
| sha256 файлов образ == `git c343eec` | **7/7 OK**: `src/backend.cjs`, `package.json`, `package-lock.json`, `Dockerfile`, **`src/storage/postgres/repositories/scene-assets-repo.js`**, **`src/storage/runtime-persistence-adapter.js`**, **`tests/null-duplicate-self-heal.test.js`** |
| Правило в образе | `notProvenNullDuplicateCondition` присутствует в обоих файлах (3+3 вхождения) |
| Обе immutable-теги | `deploy-c343eec` и полный sha указывают на один RepoDigest, image ID `02049cc2e26c` |

---

## 2. Deploy — PASS (только backend)

Rollback-артефакты сняты **до** правки: `rollback-74/env-before` (копия `deploy/.env`, chmod 600),
`rollback-74/container-image-before.json`, `rollback-74/pre-deploy-state.txt`.

Единственная правка конфига — строка 39 `deploy/.env`:

```
< BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:2d552ec0…   (deploy-a7c5827)
> BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:02049cc2…   (deploy-c343eec)
```

`diff rollback-74/env-before deploy/.env` — **ровно одна строка** (39c39); остальной файл байт-в-байт
идентичен. Другие настройки окружения/Redis/proxy **не менялись**.

```
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d backend   → rc=0
```

Хронология: `animastor-backend Recreate → Recreated → Started`; `animastor-pg`/`animastor-redis` только
`Waiting → Healthy` (**без пересоздания**, restarts 0, started 2026-08-24); `gpu-hub`/`animastor-proxy`
не вызывались (Up 6 days, restarts 0). Схема БД не менялась.

---

## 3. Проверка после деплоя — PASS

### 3.1 Контейнер и health

| Проверка | Результат |
|---|---|
| digest / revision / version | **`sha256:02049cc2…`**, `c343eec45…`, `deploy-c343eec` ✅ |
| started / restarts / status | `2026-10-19T05:05:15Z` / **0** / running ✅ |
| health (`https://localhost/health`, T0/T1/T2) | **200** `{"status":"ok","loop":true,"redis":"PONG"}` ✅ |
| FATAL / TypeError / Uncaught в логах с момента старта (1051 строка) | **0** ✅ |

### 3.2 Startup/self-heal логи — главное доказательство

Прямое сопоставление стартовых логов **того же прод-хоста** под старым и новым образом:

| Сигнал стартового self-heal | Старый образ Stage 71 (старт `2026-10-18T16:00`) | Новый образ Stage 74 (старт `2026-10-19T05:05`) |
|---|---|---|
| `[STATE] ASSET STATE: … sc-5f18dd0f audio: -> …` | **4** (dirty → pending → generating → ready) | **0** |
| `[WORKLIST] … sc-5f18dd0f audio: ready → DIRTY → PENDING` | **1** | **0** |
| `DISPATCH_REQUEST …:audio` | **1** | **0** |
| `[PG-AUDIO-READY]` (завершение лишнего audio-диспатча) | **1** | **0** |

То есть на старте **доказанные NULL-дубли больше не порождают dirty-маркет audio-ключа**, и
каноническая versioned-строка `21338` не demote'ится и не пере-dispatch'ится — ровно эффект,
ожидаемый от предиката Stage 73 в четырёх чтениях-сигналах.

Остальное поведение старта — штатное и не изменилось:
- `[RECOVERY]` — 7 build'ов, у обеих сохранённых книг «Chunks already exist in Redis … skipping»,
  5 skip-сообщений для незарегистрированных, **0 chunks recovered** (как в Stage 71);
- легитимная activity image-стадии: 3 ключа `image` прошли `dirty → pending → generating`,
  2 `DISPATCH_REQUEST` (image), журнал `SCENE_PENDING`/`AUTO_RECOVER`, `[ROLLBACK] orphan_generating_repair`
  (восстановление образов, прерванных рестартом);
- 8 reconcile-циклов; стартовый — `reconcile:2_issues` (те самые image-ключи), далее все
  циклы **`reconcile:0_issues`** — повторные перестройки worklist ничего не перекрашивают.

### 3.3 База данных: baseline → T0 (05:05:57) → T1 (05:12:11) → T2 (05:14:54)

| Проверка | baseline | T0 | T1 | T2 |
|---|---|---|---|---|
| books / scenes | 2 / 13 | 2 / 13 | 2 / 13 | 2 / 13 |
| `scene_assets` / `build_id IS NULL` | 459 / **437** | 459 / **437** | 459 / **437** | 459 / **437** |
| `image_units` (всего / NULL) | 58 / 0 | 58 / 0 | 58 / 0 | 58 / 0 |
| статусы `import_` (pending/ready/stale) | 2 / 18 / 413 | 2 / 18 / 413 | 2 / 18 / 413 | 2 / 18 / 413 |
| статусы `ba_` (placeholder/stale) | 9 / 17 | 9 / 17 | 9 / 17 | 9 / 17 |
| строка `21338` | ready @ `1792339221` | ready @ **`1792339221`** | ready @ **`1792339221`** | ready @ **`1792339221`** |
| строка `48353` | stale @ `1792339221` | stale @ `1792339221` | stale @ `1792339221` | stale @ `1792339221` |
| md5 `image_units`/`scenes`/`books` | `7c0a9861…`/`b976597e…`/`bcfa87c4…` | — | **без изменений** | **без изменений** |
| md5 `scene_assets` | `3610d3f6…` | `238ee1c2…` | `238ee1c2…` | `238ee1c2…` |
| `max_id` `scene_assets` | 48353 | **48353** | **48353** | **48353** |
| тестовые строки | 0 | 0 | 0 | 0 |
| SHA-256 `book.json` (обе) | `e50bcc61…` / `60e6e4b1…` | **без изменений** | **без изменений** | **без изменений** |

**Строки, изменённые относительно baseline — ровно 2**, обе объяснены штатной активностью:

| id | ключ | статус | `updated_at` | объяснение |
|---|---|---|---|---|
| `48344` | `sc-45c789c6` / image | `pending` | `1792386322` (05:05:22) | стартовый self-heal image-ключа (строка `path IS NULL`, правило Stage 73 её сознательно не покрывает) |
| `48349` | `sc-5f18dd0f` / image | `pending` | `1792386322` (05:05:22) | то же |

Эти 2 строки и есть единственная причина сдвига md5 `scene_assets`. Ни одна audio-строка
(`21338`, `48353`, `21484/48348/48351`) не тронута; новых NULL-строк нет (`max_id` не сдвинулся);
`build_id IS NULL` — по-прежнему **437**. Окно T1→T2 (≈2,5 мин) — **без единого изменения**
(`T1 vs T2 diffs: []`); health/restarts стабильны.

### 3.4 HTTP-эндпоинты (те же, что в Stage 71)

| Запрос | Результат |
|---|---|
| `GET /api/v1/book/ba_…/versions` | **200** — scenes 8, assets 26, mismatches **0** |
| `GET /api/v1/book/import_…/versions` | **200** — scenes 5, assets 433, mismatches **0** |
| `GET /api/v1/book/<обе>` | **200** |
| `GET /health` | **200** (T0/T1/T2) |

---

## 4. Пункты верификации стейджа

| # | Требование | Результат |
|---|---|---|
| 1 | Доказанные NULL-дубли больше не создают dirty-маркеры через четыре исправленных чтения | ✅ логи старта: `audio: -> …` **0** (было **4**), `WORKLIST audio ready→DIRTY` **0** (было 1), `DISPATCH audio` **0** (было 1); счёт `sc-5f18dd0f/audio` выпал из набора маркеров (4→3) ещё на baseline-расчёте, и старте это подтверждено отсутствием строк |
| 2 | Канонические versioned-артефакты остаются READY | ✅ `21338` = `ready` на T0/T1/T2, `updated_at` **не сдвинулся** с `1792339221` (старый образ на старте переписывал его: все 5 audio-строк получали `1792339221` на `16:00:20`) |
| 3 | Легитимные изменения сцен по-прежнему переводят canonical в stale | ✅ доказано в проде на пишущем пути: image-строки `48344/48349` прошли `dirty → pending` с записью в PG (05:05:22) и диспатчем; сценарий «genuine-инвалидация canonical READY-строки при наличии доказанного дубля» закрыт регрессионным тестом Stage 73 №6, прогнанным **на этой же БД** до деплоя (10/10). Принудительный edit сцены в проде не выполнялся (запрет на изменение данных) |
| 4 | Новых NULL-дубликатов / необъяснимых переходов статусов нет | ✅ NULL `437 → 437`, `max_id` `48353 → 48353`, изменены только 2 объяснённые image-строки; by_status обеих книг без изменений |
| 5 | Обе книги и их файлы целы | ✅ сцены/assets/статусы как в baseline; SHA-256 обоих `book.json` идентичны контрольным; output/assets не трогались мной (идёт лишь штатная image-генерация рантаймом) |
| 6 | Нет тестовых строк, непреднамеренных записей в БД и утечки тест-окружения | ✅ `test%`/`ghost%` = 0 на всех срезах; smoke CI выполнялся в изолированной сети (`be-smoke`, эфемерный redis, PG недоступен) и был демонтирован; прод-БД не использовалась CI |

### Итог: PASS по всем шести пунктам.

---

## 5. Запреты — соблюдены

- Ни одна строка `scene_assets` не удалялась, не перепривязывалась и не обновлялась массово;
  единственными изменениями данных стали 2 штатных image-перехода рантаймом (§3.3).
- `48353` **не** восстанавливалась в READY вручную (осталась `stale`, как и была).
- 437 исторических NULL-строк **не** мигрировались (`build_id IS NULL` на всех срезах).
- Файлы книг, `book.json`, output, assets, конфигурация Redis и прочие переменные окружения
  **не изменялись**; единственная правка конфига — строка `BACKEND_IMAGE` в `deploy/.env` (пин деплоя,
  диф = 1 строка, rollback сохранён).
- Пять посторонних изменений рабочего дерева (`D backend/scripts/audit-orphan-books.js`; `M` 4 теста)
  не тронуты и в коммиты не включались; untracked `deploy/`, `freebuff-chat-*.md` оставлены как были.
- Force-push не применялся; деплой шёл через workflow c fail-closed provenance-гейтом (без обходов);
  непредвиденного rollback/ремонта данных не выполнялось.

---

## 6. Оставшиеся риски / наблюдения

1. **Роллбек-канал готов**: `reorg-2026-10-17/rollback-74/env-before` + `container-image-before.json`
   (старый пин `sha256:2d552ec0…`); процедура — вернуть строку `BACKEND_IMAGE` и
   `up -d backend` (как в Stage 71 §10). Старый образ локально сохранён.
2. **Исторические NULL-строки не убраны**: `21484/48348/48351/48353` остаются `stale/NULL`;
   `GET /versions` по-прежнему покажет по ключу 5 audio-строк. Чистка К-4 Stage 70 — отдельный стейдж.
3. **Правило не покрывает 9 `ba_`-строк с `path IS NULL`** и синтетические pending-строки (К-5) —
   `ba_` на старте по-прежнему даёт 8 dirty-маркеров (8 → 8, наблюдения Stage 73/74).
4. **В проде идёт image-генерация** (`sc-45c789c6`, `sc-5f18dd0f` — image `generating`, lease продлён):
   в окне наблюдения (до 05:15) записи в `image_units` не было (58, md5 без изменений), но
   результаты GPU-задач могут дописать строки `image_units`/output позже — это нормальная
   активность рантайма, не связанная со Stage 74.
5. **Синтетическая демонстрация demote canonical в проде не выполнялась** — потребовалась бы правка
   данных сцены; эквивалент закрыт тестом Stage 73 №6 на той же БД (§4 п.3).
6. Коммит-одобрение `9783963` запушен в оба remote (штатный процесс); рабочее дерево по-прежнему
   содержит 5 посторонних изменений и untracked-каталоги — не тронуты.
7. `scene_assets_id_seq` продолжает накапливать gap-нумерацию (штатно, данных не затрагивает).
