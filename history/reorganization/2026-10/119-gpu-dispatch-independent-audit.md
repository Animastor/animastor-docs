# Stage 119 — Независимый аудит GPU dispatch lifecycle fixes (Stage 118)

**Дата:** 2026-10-22 (окно аудита 07:05Z → 08:40Z)
**Проверяемые коммиты:** `a191984a`, `6a5d429d`, `e2f5bb4c` (локальные, `main` = `e2f5bb4c`)
**Отчёт-источник (заявления):** `reorg-2026-10-19/118-gpu-dispatch-lifecycle-audit-fixes.md`
**Аудируемый baseline:** Stage 117 — код Stage 116 (`ae4e7d49`) + отчёт `117-gpu-dispatch-lifecycle-independent-audit.md` (B1–B5, M1–M7, M8–M12)
**Режим аудита:** read-only по проверяемым коммитам. Код, версии пакетов, lockfiles, refs и конфигурация **не изменялись**. Push / CI / GHCR / deploy / `npm publish` **не выполнялись**. Production **не изменялся и не опрашивался**.
**Итог: BLOCKED** — 2 новых блокера-регрессии, внесённых самим Stage 118 (F1, F2). 5 блокеров и 5 из 7 средних замечаний Stage 117 закрыты корректно; M4 и M7 закрыты лишь формально; M6 закрыт ценой новой блокер-регрессии.

---

## 0. Краткий вердикт

| Дефект Stage 117 | Заявлено в Stage 118 | Фактически (независимая проверка) | Вердикт |
|---|---|---|---|
| **B1** done-маркер невозможно освободить | ref продлевается до TTL маркера | ✅ подтверждено: маркер освобождается scene/book-скоупом, задача снова допускается к enqueue | **CLOSED** |
| **B2** sticky-классификация POST-попыток | каждая попытка классифицируется отдельно | ✅ подтверждено на 11 комбинациях исходов | **CLOSED** |
| **B3** merged (pure-dialogue) аудио без `deferReason` | классификация в одной точке | ✅ подтверждено на реальном `audio/generation.js` | **CLOSED** |
| **B4** release claims до очистки lane | lane → claims во всех 4 путях | ✅ порядок исправлен; **но** появились M-a (ответ `{cleared:true}` при отказе хаба) и M-b (остаточная гонка) | **CLOSED с оговорками** |
| **B5** refresh claim = no-op | `SET … XX EX` | ✅ TTL действительно продлевается, воскрешения нет — **но** фикс ломает 90-минутное окно неоднозначного claim'а → **F2 (BLOCKER)** | **CLOSED с регрессией** |
| **M1** неоднозначность `:` в ключах | percent-encoding | ✅ 1728 комбинаций без коллизий, обратная идентификация работает | **CLOSED** |
| **M2** `force` обходит деферал | backoff действует и в force | ✅ подтверждено; 100 тиков = 1 попытка, журнал не растёт | **CLOSED** |
| **M3** требуется ровно одна причина | все причины должны быть деферабельными | ✅ хост и пакет дают одинаковый вердикт | **CLOSED** |
| **M4** `already_completed` в «capacity» | своя корзина, окно 900 с | ⚠️ таксономия честная, но **цикл всё ещё бесконечен** (период 15 мин), сцена навсегда в active-index, ошибки нет → M-c | **RECLASSIFIED, не закрыт** |
| **M5** неоднозначный исход без `reason` | `reason: 'ambiguous_post'` | ✅ причина доезжает до оркестратора | **CLOSED** |
| **M6** per-dispatch заморозка эпохи | pin intent-эпохи на задачу | ❌ **pin подавляет легитимную стадийную регенерацию** (`markDirtyScene`) для audio/video/image → **F1 (BLOCKER)** | **REGRESSION** |
| **M7** путь после TTL 90 мин | добавлен тест | ❌ тест вакуумный: следующий тик (`duplicate_pending`) продлевает claim до 24 ч → **F2 (BLOCKER)** | **REGRESSION** |

### Новые находки Stage 119

| ID | Severity | Область | Находка | Доказательство |
|---|---|---|---|---|
| **F1** | **BLOCKER** | M6 / epoch pinning | `resolveJobEpoch` **замораживает** intent-эпоху задачи; снять её могут только dirty-IU ветка (image) и error-колбэк. `markDirtyScene` — production-сигнал «эту стадию сгенерировать заново» — поднимает **стадийную** эпоху, но **не сбрасывает pin'ы** ⇒ задача сохраняет старую идентичность ⇒ повторный dispatch подавляется как `already_completed` / `duplicate_pending` ⇒ **регенерация не происходит** (audio, video, image). В Stage 116 — работала. | `proof-p10.js` (3 стадии, Stage 118 vs baseline) + CONTROL (сброс pin'а → отправка проходит) |
| **F2** | **BLOCKER** | B5 / M7 | `refreshClaimTtl` = `SET key 1 XX EX 86400`. Ветка `duplicate_pending` вызывает его **на каждом** повторном dispatch'е. Неоднозначный POST укорачивает claim до 90 мин, а следующий тик (≤60 с, после 60-секундного деферала) продлевает его **до 24 ч** ⇒ 90-минутное окно мертво, задача заблокирована **сутки** вместо 1,5 часов; окно дубля расширено с 90 мин до 24 ч. | `proof-p12.js`: Stage 118 — 3/5, baseline Stage 116 — 5/5 |
| **M-a** | средняя | B4 | `DELETE /book/:id/cache` при отказе хаба **сохраняет** claims (безопасно), но всё равно отвечает `200 {cleared:true}` ⇒ вызывающий believes состояние согласовано, а маркеры/claim'ы живут до 7 сут / 24 ч ⇒ книга не перегенерируется. Путь `cancel-generation` в этом случае честно отдаёт 500. | `proof-p11.js` P11.7 |
| **M-b** | средняя | B4 | Остаточная гонка нового порядка «clear → release»: dispatch, попавший между очисткой lane и release, заново создаёт claim, а release его удаляет ⇒ запись lane живёт без claim'а ⇒ следующий dispatch ставит **вторую копию** (зеркальное отражение старой гонки, которая давала потерю задачи). Release — это SCAN по всему keyspace, окно не пренебрежимо мало. | анализ порядка в 4 путях (`generation-routes.cjs:317`, `cache-routes.cjs:116`, `book-deletion.cjs:200`) |
| **M-c** | средняя | M4 | `already_completed` → деферал 900 с, по истечении окна dispatch повторяется с **тем же** исходом ⇒ бесконечный цикл с периодом 15 мин; retry-бюджет не расходуется, ошибка не фиксируется, сцена навсегда остаётся в active-index. Окно лишь замедлило симптом (5 с → 60 с → 900 с), корневая причина (completion-маркер без артефакта) не устранена. | `proof-p13.js` P13.4/P13.5 |
| **M-d** | низкая | B1 / Redis | Ownership-индекс (ref) теперь живёт **7 суток** (как маркер) и **не вычищается** `cleanBookRedisKeys`; вместе с `job-epoch` (24 ч) число долгоживущих семейств ключей выросло (в Stage 116 ref удалялся при settlement). Рост ограничен TTL'ами, но «чистить некому» стало больше. | `proofs.js` P9.6; `queue-idempotency.cjs` (IDEM_REF_DONE_TTL_S) |
| **M-e** | низкая | B2 | 4xx по-прежнему ретраится 3 раза с паузой 1 с: окончательный отказ стоит 3× времени ответа + 2 с. Побочное замечание Stage 117 §4.3 осталось. | `gpu-dispatcher.js` (цикл попыток) |

---

## 1. Метод, изоляция и безопасность

### 1.1. Что делалось

1. Полное чтение трёх диффов (21 файл) + чтение окружающего кода (`queue-idempotency.cjs`, `gpu-dispatcher.js`, `dispatch-engine.js`, `dispatch-outcomes.js`, `runtime-scheduler.js`, `scene-orchestrator.js`, `audio/generation.js`, `iu-processor.js`, `generation-routes.cjs`, `book/generation-routes.cjs`, `book/cache-routes.cjs`, `book-deletion.cjs`, `scene-state-ops.js`, `reconciliation-engine.js`, `job-protocol-v2.js`).
2. Построение **baseline Stage 117** без изменения репозитория: `rsync` рабочего дерева в `/tmp/opencode/audit119/baseline117`, в нём 17 файлов аудируемых коммитов восстановлены из `ae4e7d49`, 3 новых файла удалены, `backend/node_modules/@animastor/orchestration` пересобран из исходников baseline-пакета. Итог: baseline отличается от Stage 118 **ровно файлами трёх аудируемых коммитов**; чужие dirty-файлы (5 M + 1 D + 2 ??) идентичны в обоих деревьях.
3. **12 независимых доказательств** на настоящих модулях репозитория (in-memory Redis double, заглушки PG, перехват `global.fetch`): `proofs.js` (63 проверки), `proof-p10.js`, `proof-p11.js`, `proof-p12.js`, `proof-p13.js`. Каждое доказательство запущено **на обоих деревьях** (Stage 118 и baseline Stage 116) — это и есть основной инструмент отделения регрессий Stage 118 от поведения Stage 116.
4. Изоляционные копии **каждого** коммита (`git archive <sha>` + зеркало `node_modules`) — отдельные прогоны пакета и целевых backend-тестов.

### 1.2. Изоляция и безопасность (проверено ДО и ПОСЛЕ запусков)

| Объект | Проверка | Результат |
|---|---|---|
| Production PostgreSQL | `ss -lntp` | слушает **`0.0.0.0:5432`** (production PG опубликован) ⇒ любой прогон БД-тестов писал бы в прод |
| Production Redis / хаб | `ss -lntp` | на `6379` и на порту хаба слушателя нет; обращения к `HUB_URL` перехвачены заглушкой `global.fetch` |
| Все БД/Redis-прогоны | `PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1` | 76 из 85 падений полного suite — `ECONNREFUSED 127.0.0.1:1`; остальные 9 — каскад от них. **Ни одного подключения к production.** |
| Новые доказательства | in-memory Redis double / заглушки PG / перехват `global.fetch` | ни одного сетевого обращения, ни одного production-ключа |
| Очередь 457 / 438 дублей / leases / production-данные | — | **не трогались** (к production не подключались вообще) |
| npm | `npm view` / `npm pack @animastor/orchestration@0.1.4` (**только чтение**, в `/tmp`) | `latest = 0.1.4` — публикаций не было |
| Git refs | `git rev-parse HEAD origin/main github/main` | `e2f5bb4c` / `53ce5045` / `53ce5045` — **не изменены**, push не выполнялся |
| Рабочее дерево | `git status --short` | **побайтово то же** состояние, что на входе аудита (5 M + 1 D + 2 ??) |
| Версии пакетов / lockfiles | `package.json`, `backend/package.json`, `backend/package-lock.json` | `0.1.4` / `^0.1.4` / `0.1.4` — **не изменены** |
| Push / CI / GHCR / deploy / `npm publish` | — | не выполнялись |
| `deploy/`, чужие dirty-файлы | — | не тронуты |
| Артефакты аудита | `/tmp/opencode/audit119/*` (копии деревьев, логи, доказательства, скачанный тарбол 0.1.4) | только в `/tmp` |

> Аудит не выполнял ни одного подключения к production Redis/PG/хабу.

---

## 2. Результаты тестов

### 2.1. Сводка (baseline Stage 117 = код Stage 116 `ae4e7d49`)

| Прогон | Baseline Stage 117 | Stage 118 | Δ |
|---|---|---|---|
| `packages/animastor-orchestration` — `npm test` | **30 pass / 0 fail** | **35 pass / 0 fail** | **+5** |
| `backend/tests/gpu-queue-idempotency.test.js` | **29 pass / 0 fail** | **43 pass / 0 fail** | **+14** |
| `backend/tests/gpu-audio-dispatch-deferral.test.js` (новый) | — | **5 pass / 0 fail** | **+5** |
| `backend/tests/gpu-lane-release-order.test.js` (новый) | — | **4 pass / 0 fail** | **+4** |
| три целевых файла вместе | **29 pass / 0 fail** | **52 pass / 0 fail** | **+23** |
| `backend/tests/architecture/*.test.js` | **935 pass / 24 pending / 0 fail** | **935 pass / 24 pending / 0 fail** | **=** |
| Полный backend-suite (`tests/**/*.test.js`) | 2650 тестов: **2619 pass / 28 pending / 85 fail** | 2673 теста: **2642 pass / 28 pending / 85 fail** | **+23 теста, +23 pass, Δfail = 0** |
| `scripts/syntax-smoke.sh backend` | OK | **OK** | = |

### 2.2. Сравнение падений с baseline — наборы **идентичны**

```
$ diff <(baseline117.failures.txt | sort) <(stage118.failures.txt | sort)
(нет вывода)  →  IDENTICAL failure sets (85 == 85)
```

Классификация 85 падений (оба дерева, одинаково):
* **76 ×** `ECONNREFUSED 127.0.0.1:1` — production PG физически недоступен (изоляция);
* **6 ×** `Cannot read properties of undefined (reading 'close')` — каскад `after all`-хуков тех же PG-зависимых сьютов;
* **2 ×** `expected [ Array(1) ] to deeply equal []` — `Layer-config restore through real reconcileCycle` (каскад Redis);
* **1 ×** `Cannot read properties of undefined (reading 'id')` — `Authentication MVP` before-all.

Все падения — **environmental**, к GPU-dispatch отношения не имеют, в обоих деревьях **побайтово одинаковый список**.

### 2.3. Расхождения в числах с отчётом Stage 118 и объяснение

Отчёт Stage 118 §2.1 приводит: baseline **2611 / 28 / 86** → Stage 118 **2642 / 28 / 85**, «−1 fail (флак)», и в §2.2 показывает `diff` с единственной строкой `T6: route/controller does not implement the book deletion cascade`.

Моё **парное** измерение (оба дерева, одинаковое окружение, один и тот же день):

| | отчёт Stage 118 | мой прогон |
|---|---|---|
| baseline | 2611 / 28 / **86** | 2619 / 28 / **85** |
| Stage 118 | 2642 / 28 / **85** | 2642 / 28 / **85** |
| Δ | +31 pass, −1 fail | **+23 pass, 0 fail** |

Объяснение расхождения:

1. **Числа baseline в отчёте Stage 118 не переизмерены** — они взяты из отчёта Stage 117 §2.1 (2611/28/86). Причина расхождения — **известный 2-секундный таймаут** в `tests/architecture/phase4-book-model.test.js` (T6), зафиксированный ещё в Stage 116 §9.8 и Stage 117 §2.2: он попадает то в «красную», то в «зелёную» ветку. Мой парный прогон попал в «зелёную» ветку **на обоих** деревьях, поэтому шаг −1 не проявился. Проверено отдельно: файл проходит **17/17 изолированно три раза подряд на обоих деревьях**; в полном suite тест T6 не появился ни в одном из списков падений.
2. **Δ в +31 pass** в отчёте Stage 118 — арифметика их baseline (2611→2642 = +31) против моего baseline (2619→2642 = **+23**). Согласованная величина — **+23** = 14 (`gpu-queue-idempotency`) + 5 (audio) + 4 (lane-order); это ровно и число новых тестов (2650 → 2673). Расхождение целиком объясняется флаком, а не реальной разницей в покрытии.
3. **Итог:** регрессий по составу падений **нет** — наборы идентичны; расхождение в абсолютных числах — **только** флак T6, как и предполагала сама Stage 118 (§2.2) и Stage 117 (§2.2).

### 2.4. Проверка каждого коммита отдельно

| Коммит | Пакет | Целевые backend-тесты (все существующие на этом коммите) | Комментарий |
|---|---|---|---|
| `a191984a` | 35 / 0 | **29 pass / 0 fail** | на этом коммите ещё нет audio/lane-тестов (mocha пропускает отсутствующие файлы) |
| `6a5d429d` | 35 / 0 | **48 pass / 0 fail** | 43 + 5 (audio) |
| `e2f5bb4c` | 35 / 0 | **52 pass / 0 fail** | 43 + 5 + 4 (lane-order) |

Все три коммита собираются, проходят тесты, регрессий между ними нет. Ни в одном из трёх прогонов (в отличие от §2.4 отчёта Stage 118) падений не возникает.

### 2.5. Независимые доказательства (главный инструмент аудита)

| Скрипт | Что проверяет | Stage 118 | Baseline Stage 116 |
|---|---|---|---|
| `proofs.js` (P1–P9, 63 проверки) | B1, B2 (11 комбинаций POST), B5, M1 (1728 комбинаций ключей), M3/M4 (таксономия хост↔пакет), M2/деферал (100 тиков), M6 (pin эпохи), M7 (TTL 90 мин), статические инварианты | **61 / 63** | **16 / 36** (воспроизведены дефекты Stage 117) |
| `proof-p10.js` | регенерация стадии по сигналу `markDirtyScene` (audio / video / image) + CONTROL | **9 / 12** ⇒ **F1** | 9 / 12 (3 «CONTROL» — no-op в baseline, ожидаемо) |
| `proof-p11.js` | порядок lane→claims во всех 4 путях, отказ хаба, повторная очистка, правдивость ответа | **8 / 8** | — |
| `proof-p12.js` | 90-минутное окно неоднозначного claim'а vs новый refresh | **3 / 5** ⇒ **F2** | **5 / 5** |
| `proof-p13.js` | `already_completed` (900 с) и M9 (тик-суммари) | **7 / 7** | — |

---

## 3. Пункт 1 задания — B1…B5 и M1…M7: точный тест и фактический результат

### B1 — done-маркер освобождается (CLOSED)

| Проверка | Тест | Фактический результат |
|---|---|---|
| Прод-sequence settlement'а (claim → ref → done → release claim → **extend ref**) | `proofs.js` P1.1–P1.5 | `extendTaskRef` → `true`; ref **переживает** settlement; TTL ref = TTL маркера = 604800 с; claim освобождён |
| Scene-скоуп освобождает маркер | P1.6–P1.8 + тест репозитория «B1: a completed task CAN be released by the scene scope» | `released.done = 1`, маркер удалён, `guardEnqueue → allowed=true` ⇒ **задача снова может быть сгенерирована** |
| Book-скоуп освобождает маркер | P1.9–P1.10 + «…by the book scope» | `released.done = 1`, `guardEnqueue → allowed=true` |
| Счётчики отражают реальность (M12) | P1.11 | ref без claim'а и без маркера ⇒ `released=0, done=0` (в Stage 116 было `done=released`) |
| Статически: result-колбэк не забывает ref | P9.1 | в блоке после `markTaskDone` — только `extendTaskRef`, `forgetTaskRef` отсутствует |
| Error-путь (обоснованный retry) | чтение `generation-routes.cjs:611–640` | `releaseTask` + `forgetTaskRef` + `bumpStageEpoch` + `resetJobEpoch` — полный, корректный |

**Вывод B1: закрыт.** Реальная production-последовательность воспроизведена (не искусственное «ref+done одновременно», как в Stage 116).

### B2 — классификация каждой POST-попытки (CLOSED)

Полная матрица (`proofs.js` P2, реальный `gpu-dispatcher.js`, реальный Redis double):

| # | Исходы попыток | `ambiguous` | claim | Проверка |
|---|---|---|---|---|
| C1 | 4xx, 4xx, 4xx | false | **освобождён** | ✔ |
| C9 | 404 ×3 | false | **освобождён** | ✔ |
| C10 | 401 ×3 | false | **освобождён** | ✔ |
| C2 | 4xx → 5xx | **true** | **сохранён** | ✔ |
| C3 | 5xx → 4xx | **true** | **сохранён** | ✔ |
| C4 | timeout → 4xx | **true** | **сохранён** | ✔ |
| C5 | 4xx → timeout | **true** | **сохранён** | ✔ |
| C6 | 5xx ×3 | **true** | **сохранён** | ✔ |
| C7 | timeout ×3 | **true** | **сохранён** | ✔ |
| C8 | ECONNRESET → 4xx | **true** | **сохранён** | ✔ |
| C11 | 503 → 4xx | **true** | **сохранён** | ✔ |
| — | «потерянный ответ после принятия хабом» (fetch бросает исключение после приёма) | **true** | **сохранён** | ✔ (C7) |

`reason`: `ambiguous_post` при неоднозначном исходе, `hub_rejected` при окончательном (M5 ✔).
Вердикт считается один раз в конце (`ambiguous = ambiguousOutcome || !definitiveRejection`) ⇒ **неоднозначная попытка всегда побеждает**, sticky-флага больше нет.

**Вывод B2: закрыт.** (Побочно остаётся M-e: 4xx ретраится 3 раза.)

### B3 — все аудио-пути классифицируются (CLOSED)

Тест репозитория `gpu-audio-dispatch-deferral.test.js` — **не вакуумный**: гоняет **реальный** `backend/src/audio/generation.js` с заглушенным provider'ом и проверяет конкретный `deferReason`.

| Путь | Проверка | Факт |
|---|---|---|
| merged (pure-dialogue) | «B3: the MERGED (pure-dialogue) path reports WHY nothing was enqueued» | `deferReason = 'no_worker_available'` (было `null` → `no_jobs_generated` → 5-секундный цикл) |
| per-segment (mixed) | «B3: the per-segment (mixed) path reports the same classification» | тот же reason |
| неоднозначный POST | «M5: an AMBIGUOUS post outcome travels as its own reason» | `deferReason = 'ambiguous_post'` |
| реальная ошибка | «M3: a REAL failure keeps the historic semantics» | `deferReason = null` ⇒ historic `send_failed`/немедленный повтор (контракт audit-6929ba5 цел) |
| успех | «a successful send carries no deferral reason» | `deferReason = null` |

Ветвление в коде: `isPureDialogue = segList.every(s => s.segment_type === 'dialogue')` (`audio/generation.js:217`) — тест действительно попадает в merged-ветку.

**Вывод B3: закрыт.**

### B4 — порядок «lane → claims» (CLOSED с оговорками M-a, M-b)

Независимая проверка **всех четырёх** путей (`proof-p11.js`; репозиторный тест покрывает только cancel и cache — **путь удаления книги не покрыт**, я закрыл его сам):

| Путь | Проверка | Факт |
|---|---|---|
| `POST /book/:id/cancel-generation` | P11 (репозиторный тест) | `hub-clear → release` ✔; отказ хаба → **claims сохранены**, HTTP 500 ✔ |
| `DELETE /book/:id/cache` | P11.1–P11.8 | `hub-clear → release` ✔; отказ хаба → claims сохранены ✔; **но ответ всё равно `{cleared:true}` ⇒ M-a** |
| `DELETE /book/:id` (удаление книги) | **P11.1–P11.3** (не покрыт репозиторным тестом) | `hub-clear:true → release:del-book → clear-deferrals` ✔; claim удалён ✔; отказ хаба → claims **сохранены**, TTL **ограничен 86 400 с** (не бесконечно) ✔ |
| `POST /book/:id/regenerate` | чтение кода | `resetScenes` (очищает lane) → `releaseClaimsForScene` → `clearDeferralsForScene` — порядок корректный, без изменений |
| Повторная очистка | P11.8 | идемпотентна: 200/200, без двойного освобождения ✔ |

Ошибка очистки **не освобождает claims преждевременно** (проверено на 2 из 3 сетевых путей) и **не оставляет задачу заблокированной навсегда** (claim живёт 24 ч, неоднозначный — 90 мин; после истечения задача допускается снова).

**Вывод B4: закрыт**, остаются M-a (правдивость ответа cache-пути) и M-b (остаточная гонка нового порядка).

### B5 — реальное продление TTL claim'а (CLOSED, но порождает F2)

| Проверка | Тест | Факт |
|---|---|---|
| Refresh не воскрешает освобождённый claim | P3.1, P3.3 + «B5: refreshClaimTtl extends an existing claim and never resurrects a released one» | `SET … XX EX` ⇒ `false`, ключ не создан ✔ |
| TTL реально продлевается (тест Stage 116 был вакуумным) | P3.2 + «a pending claim is refreshed…» | `86400 → 85800 → 86400` (рост, а не `>= before-1`) ✔ |
| **Но**: 90-минутное окно неоднозначного claim'а | **P12.4 / P12.5** | **TTL сброшен на 86 400 с** ⇒ **F2** |

**Вывод B5: механически закрыт, но фикс ломает M7 ⇒ F2 (BLOCKER).**

### M1 — percent-encoding (CLOSED)

| Проверка | Тест | Факт |
|---|---|---|
| Отсутствие коллизий ключей | P4.1 | 12×12×12 = 1728 комбинаций (`:`, `%3A`, пробел, `*`, `?`, `#`, `/`, unicode, `_`) ⇒ **0 коллизий**, 2197 уникальных ключей |
| Обратная идентификация для произвольного `book_id` | P4.2 | `book_id = 'weird:book id*?'` ⇒ ref прочитан обратно, claim освобождён ✔ |
| `book_id` с `:` не достаёт до чужого key space | P4.4 + «M1: a book_id containing ":" cannot reach into another book key space» | `releaseClaimsForBook('a:b')` ⇒ `released=1`, claim книги `a` **цел** ✔ |
| Glob-метасимвол `*` в `book_id` | P4.5 | `encodeURIComponent` не экранирует `*` ⇒ SCAN-шаблон шире, но **повторная проверка `key.startsWith(prefix)`** отсекает ⇒ claim книги `axb` **не тронут** ✔ |
| Пакетный ключ деферала | P7.10 | `deferredStageKey('a:b',…)` ≠ `deferredStageKey('a','b:…',…)`, содержит `a%3Ab` ✔ |
| Симметричность записи/чтения | P4.2 | `idemRefKey` и `readTaskRef` используют одну и ту же схему ⇒ round-trip ✔ |

**Вывод M1: закрыт.**

### M2 — `force` и backoff (CLOSED)

| Проверка | Тест | Факт |
|---|---|---|
| `force=true` не обходит деферал | P7.4 + «M2: force mode does NOT bypass the deferral» | `reason='deferred_capacity'`, executor **не вызван** ✔ |
| Явный интент снимает backoff (книга / сцена) | P7.5 + «M2: an explicit intent clears the backoff of a book / a scene» | `clearDeferralsForBook` → `cleared=1`, деферал снят ✔ |
| 100 тиков = 1 попытка, журнал не растёт | P7.1–P7.3 | executor 1→1, journal 2→2, rollbacks 0→0 ✔ |
| Явная отмена снимает деферал | P7.9 | `cancelActiveDispatch` ⇒ деферал снят ✔ |
| Worker появился после backoff | P7.8 | после истечения окна стадия диспатчится снова ✔ |
| Точки вызова `clearDeferrals` | чтение кода | cancel (`dispatchEngine.clearDeferralsForBook`), cache (`ctx.clearDeferrals.book`), удаление книги (`deps.clearDeferrals.book`), regenerate (`clearDeferralsForScene`) — порт внедрён композиционным корнем, архитектурный guard доволен (935/0) ✔ |

**Вывод M2: закрыт.**

### M3 — несколько причин (CLOSED)

| Проверка | Тест | Факт |
|---|---|---|
| Классификатор пакета | «M3: several deferrable reasons are classified» | `no_worker_available(3) + duplicate_pending(1)` ⇒ `no_worker_available`; `+ send_failed(1)` ⇒ `null` ✔ |
| Классификатор хоста | P6.4/P6.5 | **идентичен** пакетному (одинаковые множества, одинаковый результат) ✔ |
| Исторические исходы не деферабельны | P6.6 | `no_jobs_sent`, `no_jobs_generated`, `send_failed` ⇒ не деферабельны (контракт audit-6929ba5 цел) ✔ |
| Хост ↔ пакет не разъезжаются | P6.1 | `CAPACITY_REASONS` = `CAPACITY_OUTCOMES` = {ambiguous_post, duplicate_pending, no_worker_available} ✔ |

**Вывод M3: закрыт.**

### M4 — `already_completed` (RECLASSIFIED, не закрыт — M-c)

| Проверка | Тест | Факт |
|---|---|---|
| Таксономия | P6.2/P6.3 + «M4: already_completed is NOT a capacity reason but it IS deferrable» | `isCapacityReason=false`, `isDeferrableReason=true`, `isIdempotentOutcome=true` ✔ |
| Своё окно 900 с | P13.2 + «M4: the idempotent suppression gets its OWN window» | `ttl=900` (не 60) ✔ |
| **Цикл** | P13.4/P13.5 | после истечения окна dispatch повторяется с **тем же** исходом `already_completed`; retry-бюджет не тронут; ошибки нет ⇒ **бесконечный цикл с периодом 15 мин**, сцена навсегда в active-index ⇒ **M-c** |

**Вывод M4: таксономия исправлена, но исходная проблема (сцена, которая никогда не завершится) не решена — лишь замедлена в 15 раз.**

### M5 — `reason` доезжает до оркестратора (CLOSED)

| Проверка | Тест | Факт |
|---|---|---|
| Транспорт отдаёт reason | P2 | `ambiguous_post` / `hub_rejected` ✔ |
| Причина доходит до аудио | «M5: an AMBIGUOUS post outcome travels as its own reason» | `deferReason='ambiguous_post'` ✔ |
| Причина классифицируется пакетом | P6.1 | `ambiguous_post` входит в capacity-корзину ⇒ деферабельна ✔ |
| Флаг `ambiguous` больше не единственный носитель | чтение кода | `iu-processor.js` берёт `sendResult.reason`; `audio/generation.js` — через общий классификатор; видео — `classifyNotSentReasons` ✔ |

**Вывод M5: закрыт.**

### M6 — pin intent-эпохи (REGRESSION — F1, BLOCKER)

| Проверка | Тест | Факт |
|---|---|---|
| Pin стабилен при движении стадийной эпохи | P5.2 + «M6: the intent epoch is PINNED per task» | ✔ (задумано правильно) |
| Никогда не отправленный task видит текущую эпоху | P5.3 | ✔ |
| `resetJobEpoch` снимает pin | P5.4 | ✔ |
| Одна задача = одна идентичность внутри dispatch'а | «M6: the same task sent twice inside ONE dispatch keeps ONE identity» | ✔ (1 запись в lane) |
| Pin переживает re-dispatch с новым `dispatch_id` | «M6: the pinned intent epoch survives a re-dispatch with a NEW dispatch_id» | ✔ (`duplicate_pending`, 1 запись) |
| **Легитимная регенерация не подавлена** | **P10.1–P10.3 (audio/video/image)** | ❌ **после `markDirtyScene` повторный dispatch ⇒ `already_completed`** (в Stage 116 — `sent=true`) ⇒ **F1** |
| CONTROL: сброс pin'а | P10.4 | ✔ отправка проходит ⇒ причиной является именно pin |

**Вывод M6: в проверенных сценариях закрыт, но в production-пути «стадия помечена грязной ⇒ перегенерировать» он ломает регенерацию ⇒ F1.**

### M7 — поведение после TTL 90 минут (REGRESSION — F2, BLOCKER)

| Проверка | Тест | Факт |
|---|---|---|
| Claim неоднозначного исхода укорочен до 90 мин | P12.2 | `ttl=5400` ✔ |
| Claim истекает, задача может быть отправлена снова | P12.5 | ❌ **claim живёт** — следующий тик продлил его до 86 400 с ⇒ **F2** |
| 90-минутное окно переживает повторный dispatch | P12.4 | ❌ `ttl=86400` (в Stage 116 — 5395) ⇒ **F2** |

**Вывод M7: не закрыт — хуже, чем до Stage 118.**

---

## 4. Пункт 2 задания — completion / ref / done: все переходы, потеря владения, ложное `already_completed`

| Переход | Кто вызывает | claim | done-маркер | ref (владение) | Корректно? |
|---|---|---|---|---|---|
| отправка | `gpu-dispatcher.sendUnified` | создан (24 ч) | — | создан (24 ч) | ✔ |
| принятый результат | `generation-routes.cjs` result-колбэк | **освобождён** | **создан (7 сут)** | **продлён до 7 сут** | ✔ B1 |
| ошибка задачи | `generation-routes.cjs` error-колбэк | **освобождён** | — | забыт | ✔ (epoch bump + pin reset) |
| окончательный отказ хаба (4xx) | `gpu-dispatcher` | **освобождён** | — | забыт | ✔ |
| неоднозначный исход | `gpu-dispatcher` | **сохранён (90 мин → фактически 24 ч, F2)** | — | сохранён | ⚠️ F2 |
| отмена (cancel) | `POST /cancel-generation` | освобождён (после подтверждения хаба) | **освобождён** | удалён | ✔ |
| очистка кэша | `DELETE /cache` | освобождён (после подтверждения хаба) | **освобождён** | удалён | ✔ (+M-a про ответ) |
| удаление книги | `DELETE /book` | освобождён (после подтверждения хаба) | **освобождён** | удалён | ✔ |
| регенерация | `POST /regenerate` → `resetScenes` | освобождён | **освобождён** | удалён | ✔ |

**Потеря владения:** проверено — ref удаляется только вместе с claim'ом и маркером (`releaseClaimsByPrefix` → `del` claim, `del` done, `del` ref) либо при `forgetTaskRef` в путях, где маркера не существует. Маркер, потерявший ref, возможен только если ref истёк (24 ч) раньше результата (>24 ч после отправки при максимальном таймауте 60 мин) — практически недостижимо (LOW).

**Ложное `already_completed`:** маркер ставится только по **принятому** результату (`markTaskDone` в result-колбэке), ключ маркера — sha256 от (workspace, job, type, build, params, epoch). Коллизий ключей не выявлено (P4.1, 2197 уникальных ключей на 1728 комбинаций). Ложное срабатывание возможно только при «маркер без артефакта» — это и есть корневая причина M-c.

**Потеря задачи на 7 сут / 900 с:** маркер стал освобождаемым (B1) ⇒ потеря на 7 сут устранена по явным интентам. Остаются: (а) 900-секундный цикл M-c для «маркер без артефакта»; (б) 24-часовая блокировка F2.

---

## 5. Пункт 3 задания — POST: итоговая классификация и окно после TTL 90 минут

Итоговая классификация дана в §3 (B2, 11 комбинаций). Правило вердикта:

```
ambiguous = (любая попытка дала 5xx / timeout / ECONNRESET / потерянный ответ)
            || (ни одна попытка не была 4xx)
claim  ⇒  сохраняется при ambiguous, освобождается только если ВСЕ попытки — 4xx
reason ⇒  'ambiguous_post' | 'hub_rejected'
TTL    ⇒  24 ч (обычный) | 90 мин (неоднозначный) | 24 ч (definite → claim снят)
```

**Дубль после TTL 90 минут — да, открыт, и Stage 118 его УСИЛИЛИ:**
* В Stage 116 окно неоднозначности 90 мин выдерживалось (refresh был no-op) ⇒ дубль возможен через 90 мин.
* В Stage 118 следующий тик продлевает claim до **24 ч** (F2) ⇒ дубль возможен через **24 ч**, а задача заблокирована на сутки вместо полутора часов.
* Осознанного «reconciliation с lane хаба» нет ни в Stage 116, ни в Stage 118 (Stage 118 §4.3 это признаёт, но мер не принял) ⇒ это остаётся **не закрытым риском**, а с учётом F2 — **усиленным**.

---

## 6. Пункт 4 задания — hub lane и claims

| Сценарий | Проверка | Факт |
|---|---|---|
| Успех (хаб подтвердил) | P11.1–P11.3, репозиторный тест | lane очищен **до** release; claim'ы и маркеры освобождены ✔ |
| Частичный отказ (хаб недоступен) | P11.4–P11.6, репозиторный тест | claim'ы **сохранены** (безопасное направление) ✔ |
| **Ошибка очистки не освобождает claims преждевременно** | P11.4, P11.6 | подтверждено на 3 из 3 сетевых путей ✔ |
| **Ошибка очистки не оставляет задачу заблокированной бесконечно** | P11.5 | claim живёт 86 400 с (24 ч) — **ограничен**, не бесконечен ✔ |
| Повторная очистка | P11.8 | идемпотентна ✔ |
| Рестарт backend | «restart: the claim survives a backend restart and suppresses the re-dispatch» | claim переживает, дубля нет ✔ |
| Рестарт хаба | анализ | lane в Redis хаба, claim в Redis бэкенда ⇒ переживают оба ✔ |
| Гонка с активным dispatch | анализ порядка | ⚠️ **M-b**: новая гонка даёт **дубль** (старая давала потерю задачи) |
| Правдивость ответа | P11.7 | ⚠️ **M-a**: cache-путь отвечает `{cleared:true}` при отказе хаба |

---

## 7. Пункт 5 задания — deferral: пути, причины, отмена, появление worker, журнал

| Требование | Проверка | Факт |
|---|---|---|
| image-путь | тест пакета + `gpu-audio-dispatch-deferral` (per-segment) | классифицируется ✔ |
| audio per-segment | «B3: the per-segment (mixed) path reports the same classification» | ✔ |
| **audio merged (pure-dialogue)** | «B3: the MERGED (pure-dialogue) path reports WHY nothing was enqueued» | ✔ (было `null`) |
| video-путь | чтение `scene-orchestrator.js:610` (`classifyNotSentReasons(...) \|\| 'send_failed'`) | ✔ |
| несколько причин | P6.4/P6.5, тест пакета | доминирующая причина; реальная ошибка ⇒ `null` ✔ |
| `force` | P7.4 | не обходит ✔ |
| явная отмена | P7.9 | деферал снят ✔ |
| появление worker после backoff | P7.8 | стадия диспатчится после истечения окна (до 60 с ожидания — допустимо) ✔ |
| **нет роста журнала** | P7.2 | journal 2→2 за 100 тиков ✔ |
| **нет цикла dispatch/cancel/rollback** | P7.1, P7.3 | 100 тиков ⇒ 1 executor-call, 0 rollback'ов ✔ |
| деферал не тратит retry-бюджет | тест пакета | ✔ |
| M9 (деферал ≠ ошибка в тик-суммари) | P13.6/P13.7 + чтение `runtime-scheduler.js` | `summary.deferred` отдельно, `summary.errors` пуст ✔ |

**Остаточные риски:** M-c (цикл `already_completed` раз в 15 мин) и — важно — **F1**: если легитимная регенерация подавлена как `already_completed`, деферал вступает в дело и закрепляет подавление на 900 с (то есть F1 усиливается ещё и окном).

---

## 8. Пункт 6 задания — epoch pinning

| Аспект | Проверка | Факт |
|---|---|---|
| Стабильность идентичности задачи | P5.2, P5.4, тесты M6 | pin держит эпоху; `resetJobEpoch` снимает ✔ |
| Корректное изменение при новом intent'е | P5.4; `iu-processor.js:237`; `generation-routes.cjs:636` | dirty-IU и error-колбэк сбрасывают pin ✔ |
| **Отсутствие подавления легитимной регенерации** | **P10** | ❌ **F1** — `markDirtyScene` (стадийный «сгенерируй заново») эпоху двигает, pin'ы не снимает ⇒ audio/video/image задача остаётся с прежней идентичностью ⇒ `already_completed` |
| Взаимодействие с дефералом | P7 + §7 | подавленный `already_completed` ⇒ деферал 900 с ⇒ цикл закрепляется |

**Итог: F1 — BLOCKER.**

### 8.1. Детали F1 (для воспроизведения)

```
markDirtyScene(redis, bookId, chapterId, sceneId, ['audio'], buildId)
  → state/scene-state-ops.js:106  bumpStageEpoch(...)          // стадийная эпоха +1
  → НЕ вызывает resetJobEpoch(...)                             // pin'ы задач остаются

resolveJobEpoch(redis, book, ch, sc, job, 'audio')
  → queue-idempotency.cjs:212     читает pin → возвращает СТАРУЮ эпоху
  → idem_key не меняется → done-маркер совпадает → 'already_completed'
```

Затронутые production-пути (все вызывают `markDirtyScene`, который двигает только стадийную эпоху):
* `packages/animastor-orchestration/src/runtime/reconciliation-engine.js:1250` — починка «застрявшей» сцены (stuck_state);
* `…/reconciliation-engine.js:1319` — `RELEASE_STALE_LEASE` (освобождение просроченного леаса ⇒ сцена передиспатчивается);
* `…/reconciliation-engine.js:2015, 2031` — C1/C1b recovery аудио при старте;
* `…/reconciliation-engine.js:2105, 2119` — C1b recovery видео;
* `packages/animastor-orchestration/src/orchestration/scene-restoration.js:123` — восстановление сцены (image);
* `backend/src/services/placeholder-audio.js:441` — placeholder-аудио;
* `backend/src/services/scene-asset-registry.js:166` — `invalidateSceneAssets` (audio+image+video+storyboard).

**Почему это не поймали новые тесты:** тест «M6: the intent epoch is PINNED per task» проверяет ровно те два случая, которые реализация и удовлетворяет (сдвиг соседней стадии + явный `resetJobEpoch`). Реальный production-сигнал смены intent'а — `markDirtyScene` — в тестах отсутствует.

**Минимальные варианты исправления (на будущее, в этом аудите код не менялся):**
1. `markDirtyScene` должен сбрасывать pin'ы задач затронутой стадии (нужен список job_id'ов стадии — потребует перечисления по (book, ch, sc, stage) ⇒ отдельный индекс), **или**
2. `resolveJobEpoch` должен учитывать стадийную эпоху, если она **строго новее** закреплённой (т.е. «стадия перегенерировалась ⇒ все её задачи получают новую идентичность»), сохраняя при этом стабильность при *соседнем* bump'е — требует различать «bump своей стадии» и «bump соседней единицы» (например, хранить в pin'е пару (эпоха, назначение bump'а)), **или**
3. Ввести явный `resetJobEpochForStage(redis, book, ch, sc, stage)` и вызывать его из `markDirtyScene`.

---

## 9. Пункт 7 задания — percent-encoding

| Требование | Проверка | Факт |
|---|---|---|
| Отсутствие коллизий ключей | P4.1 (1728 комбинаций) | **0 коллизий** ✔ |
| Корректная обратная идентификация для произвольного `book_id` | P4.2 | ✔ (включая `:`, пробел, `*`, `?`) |
| `book_id` c `:` не пересекается с другой книгой | P4.4 | ✔ |
| Glob-метасимволы | P4.5 | ✔ (повторная проверка префикса) |
| Симметричность ключа и чтения | P4.2, `idemRefKey` vs `readTaskRef` | ✔ |
| Пакетный ключ деферала | P7.10 | ✔ |

**Итог: M1 закрыт.**

---

## 10. Пункт 8 задания — публикуемый orchestration-пакет

### 10.1. Что именно попадёт в «0.1.5»

Сверка **опубликованного** тарбола `0.1.4` (скачан read-only в `/tmp/opencode/audit119/registry`) с локальными исходниками кандидата:

| Файл в 0.1.5 | Состояние относительно 0.1.4 | Содержимое изменения |
|---|---|---|
| `src/runtime/dispatch-outcomes.js` | **НОВЫЙ** | общая таксономия исходов: `CAPACITY_OUTCOMES` (no_worker_available / duplicate_pending / ambiguous_post), `IDEMPOTENT_OUTCOMES` (already_completed), `isCapacityOutcome`, `isIdempotentOutcome`, `isDeferrableOutcome`, `classifyNotSentReasons` |
| `src/runtime/dispatch-engine.js` | **ИЗМЕНЁН** | `force` больше не обходит деферал; окно 900 с для идемпотентной корзины; `clearDeferralsForBook/Scene`; percent-encoding ключа деферала; `deferred: true` в результате; импорт таксономии |
| `src/runtime/runtime-scheduler.js` | **ИЗМЕНЁН** | `summary.deferred` отдельно от `summary.errors` (M9) |
| `src/orchestration/scene-orchestrator.js` | **ИЗМЕНЁН** | единый классификатор для image/audio/video; merged-аудио теперь отдаёт `deferReason` (B3 — но сам фикс в хосте) |
| `test/capacity-deferral.test.js` | **НОВЫЙ** (в 0.1.4 отсутствовал) | 35 кейсов пакета (5 новых Stage 118) |
| `package.json` | **изменяется только строка версии** | `"version": "0.1.4"` → `"0.1.5"` |
| остальные 35 файлов (33 `src/`, `test/artifact-root-binding.test.js`, `test/counter-reconciliation.test.js`, `test/mocks/redis-mock.js`, `test/test-bindings.js`, `README.md`, `LICENSE`) | **побайтово идентичны** 0.1.4 | — |

`npm pack --dry-run` в дереве-кандидате: **39 файлов** (37 опубликованных + 2 новых), 145.7 kB / 586.8 kB unpacked.

> **F1 и F2 НЕ входят в пакет** — оба в host-коде (`backend/src/helpers/queue-idempotency.cjs`, `backend/src/runtime/gpu-dispatcher.js`). Пакет можно публиковать независимо, но **гейт деплоя остаётся закрытым** до исправления F1/F2 в бэкенде.

### 10.2. Расхождение «локально зелёное / в сборке не то» — НЕ устранено

`backend/node_modules/@animastor/orchestration` — **ручная синхронизация** с изменёнными исходниками (`diff -rq` → 0 различий), но `package.json` внутри всё ещё говорит `0.1.4`. При этом:
* `backend/Dockerfile:9` → `npm install --omit=dev --ignore-scripts` ⇒ **образ тянет 0.1.4 из registry**;
* `backend/package-lock.json:176` → `version 0.1.4`, `resolved .../orchestration-0.1.4.tgz`, `integrity sha512-WW/Imbc1…`.

⇒ Собранный образ **не содержит** фиксов `a191984a` (M2/M3/M4/M5 в пакете), а локальные тесты идут по синхронизированной копии и этого **не показывают**. Это ровно тот источник ложной уверенности, который зафиксирован в Stage 117 §8.2 и который Stage 118 не закрыл (сознательно — публикация запрещена границами этапа).

### 10.3. Что нужно проверить перед ручной публикацией и bump'ом зависимости

**Шаг 0 (до публикации) — сначала закрыть F1 и F2.** Оба в бэкенде; публикация пакета их не лечит, а деплой без их исправления зафиксирует в production регрессию против Stage 116.

**Шаг 1 — версия пакета (единственный файл):**
```bash
cd /home/animastor/animastor-backend
# packages/animastor-orchestration/package.json : "version": "0.1.4"  →  "0.1.5"
```
(остальное в манифесте не трогать; `publishConfig.access: "public"` уже задан)

**Шаг 2 — контроль состава (read-only):**
```bash
cd /home/animastor/animastor-backend/packages/animastor-orchestration
npm pack --dry-run          # ожидается 39 файлов, включая src/runtime/dispatch-outcomes.js и test/capacity-deferral.test.js
```

**Шаг 3 — публикация (отдельный шаг, только по явному approval владельца):**
```bash
cd /home/animastor/animastor-backend/packages/animastor-orchestration
npm publish --access public
# проверка (только чтение):
npm view @animastor/orchestration@0.1.5 version dist.integrity dist.shasum
npm view @animastor/orchestration dist-tags        # latest должен стать 0.1.5
```

**Шаг 4 — bump зависимости backend'а (2 файла):**
```bash
cd /home/animastor/animastor-backend/backend
# backend/package.json : "@animastor/orchestration": "^0.1.4"  →  "^0.1.5"
npm install --package-lock-only @animastor/orchestration@^0.1.5
npm install
```

**Шаг 5 — верификация ДО коммита:**
```bash
cd /home/animastor/animastor-backend
node -e "console.log(require('./backend/node_modules/@animastor/orchestration/package.json').version)"   # → 0.1.5
diff -rq backend/node_modules/@animastor/orchestration/src packages/animastor-orchestration/src           # → пусто
grep -n "dispatch-outcomes" backend/node_modules/@animastor/orchestration/src/index.js \
  backend/node_modules/@animastor/orchestration/src/runtime/dispatch-engine.js
cd packages/animastor-orchestration && npm test    # ожидается 35 passing / 0 failing
cd ../../backend && npm test                       # полный suite: baseline падений = 85 (env), НОЛЬ новых
```

**Шаг 6 — коммит (только эти 2 файла, как в Stage 103 / `78e8f1ae`):**
```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(backend): update orchestration to 0.1.5"
```

**Не трогать:** `packages/animastor-orchestration/package-lock.json` (в нём предсуществующий дрейф `0.1.2`; в разрешении backend-зависимостей не участвует — Stage 103 §2), `packages/*/package.json` остальных пакетов, `backend/package-lock.json` кроме автоматически обновлённых строк.

**Шаг 7 — только после этого** пересборка образа backend; иначе фиксы `a191984a` в контейнере не появятся.

**Обязательные дополнительные проверки перед деплоем (сверх процедуры Stage 117 §8.3):**
1. Прогнать **новые регрессионные тесты на F1 и F2** (см. §3: `markDirtyScene`-регенерация и 90-минутное окно) — они обязаны стать частью `backend/tests/gpu-queue-idempotency.test.js`.
2. Проверить, что полный backend-suite на **собранном образе** (а не на локальной синхронизированной копии) даёт 35/35 в пакете и 52/52 в целевых тестах.
3. Убедиться, что `backend/package-lock.json` содержит `version 0.1.5` + `resolved .../orchestration-0.1.5.tgz` + новый `integrity`.

---

## 11. Проверка каждого коммита отдельно (детали)

| Коммит | Содержание (по diff) | Мои замечания |
|---|---|---|
| `a191984a` | таксономия исходов, окна деферала, `force` без обхода, `clearDeferrals*`, тик-суммари, percent-encoding ключа деферала | Пакет 35/35, целевые 29/29. Дефектов в самом коммите не найдено; M4 остаётся симптоматическим (M-c) |
| `6a5d429d` | модель ref/done, `extendTaskRef`, `refreshClaimTtl`, per-attempt классификация POST, `reason: 'ambiguous_post'`, pin intent-эпохи, percent-encoding, аудио-пути | Пакет 35/35, целевые 48/48. **F1 (pin) и F2 (refresh × ambiguous TTL) внесены именно здесь** |
| `e2f5bb4c` | порядок lane→claims в 4 путях, порт `clearDeferrals`, guard композиционного корня | Пакет 35/35, целевые 52/52. Порядок исправлен; остаются M-a и M-b |

**Совокупный вердикт по трём коммитам: BLOCKED** — `6a5d429d` вносит две регрессии против Stage 116 (F1, F2), которые не покрыты ни одним новым тестом.

---

## 12. Сводка находок

| # | Severity | Область | Находка | Доказательство |
|---|---|---|---|---|
| **F1** | **BLOCKER** | M6 | pin intent-эпохи подавляет легитимную стадийную регенерацию (`markDirtyScene`): audio/video/image остаются с прежней идентичностью ⇒ `already_completed`; в Stage 116 регенерация проходила. Затронуты recovery-пути reconciliation-engine, scene-restoration, placeholder-audio, invalidateSceneAssets. | `proof-p10.js` (Stage 118 3 FAIL / baseline 3 PASS + CONTROL) |
| **F2** | **BLOCKER** | B5/M7 | `refreshClaimTtl` (24 ч) вызывается на каждом `duplicate_pending` и обнуляет 90-минутное окно неоднозначного claim'а ⇒ задача заблокирована 24 ч вместо 90 мин; окно дубля расширено; тест M7 вакуумный | `proof-p12.js` (Stage 118 2 FAIL / baseline 5 PASS) |
| M-a | средняя | B4 | cache-теardown отвечает `{cleared:true}` при отказе хаба, хотя claims/маркеры сохранены (книга не перегенерируется до 7 сут) | `proof-p11.js` P11.7 |
| M-b | средняя | B4 | остаточная гонка «clear → release»: dispatch между ними оставляет запись lane без claim'а ⇒ дубль | анализ порядка |
| M-c | средняя | M4 | `already_completed` — бесконечный цикл с периодом 15 мин; сцена навсегда в active-index, ошибки нет, бюджет не тратится | `proof-p13.js` P13.4/P13.5 |
| M-d | низкая | B1 | ref живёт 7 сут и не вычищается `cleanBookRedisKeys`; `job-epoch` (24 ч) не вычищается ⇒ рост долгоживущих семейств ключей | `proofs.js` P9.6 |
| M-e | низкая | B2 | 4xx ретраится 3 раза с паузой 1 с (побочное замечание Stage 117 осталось) | чтение `gpu-dispatcher.js` |
| M-f | низкая | B1 | если результат приходит >24 ч после отправки, ref уже истёк ⇒ `extendTaskRef` → false ⇒ маркер осиротеет на 7 сут (недостижимо: макс. таймаут 60 мин) | `queue-idempotency.cjs` `extendTaskRef` |

---

## 13. Рекомендации

### 13.1. До публикации/деплоя (в порядке приоритета)

1. **F1** — снять pin'ы задач при стадийной регенерации. Варианты: (а) `markDirtyScene` вызывает новый `resetJobEpochForStage(redis, book, ch, sc, stage)`; (б) `resolveJobEpoch` сравнивает стадийную эпоху с закреплённой и обновляет pin, если стадийная эпоха выросла **по этой стадии**; (в) отказаться от per-task pin'а в пользу явного «поколения» задачи. **Обязательный регрессионный тест:** `markDirtyScene` → повторный dispatch ⇒ `sent=true` для audio/video/image (мой `proof-p10.js`).
2. **F2** — `refreshClaimTtl` не должен продлевать claim, который был намеренно укорочен. Варианты: (а) `EXPIRE key ttl GT` (продлевать только если новый TTL больше текущего — но здесь нужен обратный смысл: **не** продлевать укороченный); (б) при `shortenClaimTtl` запоминать «потолок» TTL в отдельном ключе и при refresh брать `min(target, ceiling)`; (в) при `duplicate_pending` **не** продлевать claim, если он короче `IDEM_CLAIM_TTL_S` (т.е. он был укорочен). **Обязательный регрессионный тест:** неоднозначный POST → следующий dispatch → TTL claim'а ≤ 90 мин (мой `proof-p12.js`).
3. **M-a** — при отказе хаба в cache-теardown отвечать неуспехом (или добавить поле вроде `hub_cleared:false`), чтобы вызывающий знал о рассогласовании.
4. **M-b** — сузить окно гонки: перенести release **до** сетевого вызова с последующей повторной очисткой lane, либо выполнять release по списку idem_key'ов, снятых снэпшотом до очистки.
5. **M-c** — при `already_completed` без артефакта освобождать completion-маркер (или переводить стадию в ошибочное состояние), а не откладывать на 900 с.

### 13.2. Умеренные и низкие

* M-d: включить `animastor:idempotency:ref:*` и `animastor:idempotency:job-epoch:*` в `cleanBookRedisKeys`.
* M-e: не ретраить 4xx (или ретраить один раз).
* M-f: при settlement при отсутствии ref — не ставить done-маркер «вслепую» (или чинить ref из job_id).

### 13.3. Порядок этапов (с учётом Stage 117 §10.3 и Stage 118 §4)

```
119  независимый аудит Stage 118                      ← ЭТОТ ОТЧЁТ: BLOCKED (F1, F2)
120  исправление F1 (+ F2, M-a, M-b, M-c) в animastor-backend, регрессионные тесты
121  публикация @animastor/orchestration@0.1.5 + bump backend ^0.1.5 (процедура §10.3)
122  push/CI/GHCR/деплой + наблюдение: очередь 457→476 и далее без роста, журнал не растёт
123  очистка 438 дублей (отдельный approval)
124  восстановление workers (Stage 113 §A.5)
```

---

## 14. Приложения

### 14.1. Воспроизведение доказательств

```bash
# 0) подготовка изолированных деревьев (в /tmp, репозиторий не меняется)
cd /home/animastor/animastor-backend
rsync -a --delete --exclude '.git' ./ /tmp/opencode/audit119/stage118/
rsync -a --delete --exclude '.git' ./ /tmp/opencode/audit119/baseline117/
# в baseline117 откатить 3 коммита до ae4e7d49 (17 файлов) и удалить 3 новых файла,
# затем пересобрать backend/node_modules/@animastor/orchestration из baseline-пакета

# 1) тесты пакета и целевые backend-тесты
(cd /tmp/opencode/audit119/stage118/packages/animastor-orchestration && npm test)     # 35 pass
(cd /tmp/opencode/audit119/baseline117/packages/animastor-orchestration && npm test)  # 30 pass
(cd /tmp/opencode/audit119/stage118/backend && PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1 \
   npx mocha --exit tests/gpu-queue-idempotency.test.js tests/gpu-audio-dispatch-deferral.test.js \
                                  tests/gpu-lane-release-order.test.js)                # 52 pass

# 2) архитектурные
(cd /tmp/opencode/audit119/stage118/backend && PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1 \
   npx mocha --exit --reporter min "tests/architecture/*.test.js")                   # 935 pass / 24 pending / 0 fail

# 3) полный suite (изолированные адреса!)
(cd /tmp/opencode/audit119/stage118/backend && ANIMASTOR_DOCS_ROOT=/home/animastor/animastor-docs \
   PG_HOST=127.0.0.1 PG_PORT=1 REDIS_HOST=127.0.0.1 REDIS_PORT=1 \
   npx mocha --exit --reporter json "tests/**/*.test.js" > stage118.full.json)      # 2642/28/85
(cd /tmp/opencode/audit119/baseline117/backend && … )                                 # 2619/28/85
# → наборы падений идентичны (diff пуст)

# 4) независимые доказательства
cd /tmp/opencode/audit119
AUDIT_REPO=/tmp/opencode/audit119/stage118    node proofs.js        # 61/63
AUDIT_REPO=/tmp/opencode/audit119/baseline117 node proofs.js        # 16/36
AUDIT_REPO=/tmp/opencode/audit119/stage118    node proof-p10.js    # 9/12  (F1)
AUDIT_REPO=/tmp/opencode/audit119/baseline117 node proof-p10.js    # 9/12
AUDIT_REPO=/tmp/opencode/audit119/stage118    node proof-p11.js    # 8/8
AUDIT_REPO=/tmp/opencode/audit119/stage118    node proof-p12.js    # 3/5   (F2)
AUDIT_REPO=/tmp/opencode/audit119/baseline117 node proof-p12.js    # 5/5
AUDIT_REPO=/tmp/opencode/audit119/stage118    node proof-p13.js    # 7/7

# 5) пакет (read-only, без публикации)
cd /tmp/opencode/audit119/stage118/packages/animastor-orchestration && npm pack --dry-run   # 39 файлов
cd /tmp/opencode/audit119/registry && npm pack @animastor/orchestration@0.1.4               # 37 файлов (0.1.4)
```

### 14.2. Ключевые строки кода (для ревью-фикса)

| Файл:строка | Что смотреть |
|---|---|
| `backend/src/helpers/queue-idempotency.cjs:212` (`resolveJobEpoch`) | **F1** — pin замораживает эпоху; нет пути, сбрасывающего pin по стадийному «dirty»-сигналу |
| `backend/src/state/scene-state-ops.js:106` (`bumpStageEpoch` в `markDirtyScene`) | **F1** — двигает стадийную эпоху, но не снимает pin'ы задач |
| `backend/src/helpers/queue-idempotency.cjs:590` (`refreshClaimTtl`) + `backend/src/runtime/gpu-dispatcher.js:270` | **F2** — `SET XX EX 86400` на каждом `duplicate_pending` обнуляет укороченный claim |
| `backend/src/helpers/queue-idempotency.cjs:571` (`shortenClaimTtl`) | **F2** — 90-минутный потолок, который затирается refresh'ем |
| `backend/src/runtime/gpu-dispatcher.js:355` (`ambiguous = ambiguousOutcome \|\| !definitiveRejection`) | корректный вердикт B2 |
| `backend/src/routes/generation-routes.cjs:536` (`extendTaskRef`) | модель B1 (ref = индекс владения) |
| `backend/src/helpers/queue-idempotency.cjs:651` (`releaseClaimsByPrefix`) | порядок del claim/done/ref и честные счётчики (M12) |
| `backend/src/routes/book/cache-routes.cjs:116–160` | порядок clear→release; **M-a** (ответ `{cleared:true}` при отказе хаба) |
| `backend/src/services/book-deletion.cjs:200–250` | порядок clear→release; отказ хаба ⇒ claims сохранены |
| `packages/animastor-orchestration/src/runtime/dispatch-engine.js:905` | проверка деферала **до** force-обхода (M2) |
| `packages/animastor-orchestration/src/runtime/dispatch-outcomes.js` | таксономия (M4/M3) — хост и пакет синхронны |
| `packages/animastor-orchestration/src/runtime/runtime-scheduler.js:467, 603` | `summary.deferred` отдельно от `errors` (M9) |
| `backend/src/audio/generation.js:363` (`deferReason` в `generateSceneAudio`) | B3 — классификация в одной точке для всех путей |

### 14.3. Состояние окружения на момент окончания аудита

| Объект | Значение | Изменено аудитом? |
|---|---|---|
| `HEAD` | `e2f5bb4c5f13afe1aaea4c7131a96bc1ad7c0e5e` | нет |
| `origin/main` / `github/main` | `53ce504536c14413c2c5e7b8546d529db8ee2530` | нет |
| Рабочее дерево | 5 M + 1 D + 2 ?? — **как на входе** | нет |
| Версия пакета / зависимость / lockfile | `0.1.4` / `^0.1.4` / `0.1.4` | нет |
| npm `@animastor/orchestration` | `latest = 0.1.4` | нет (только чтение) |
| Production Redis/PG/хаб/очередь (457/438) | не опрашивались и не изменялись | нет |
| Push / CI / GHCR / deploy / `npm publish` | не выполнялись | нет |
| Артефакты аудита | `/tmp/opencode/audit119/*` | только в `/tmp` |

---

**Итог Stage 119: BLOCKED.** B1, B2, B3, B4, M1, M2, M3, M5 закрыты и подтверждены независимыми доказательствами; B5 закрыт механически; M4 лишь переклассифицирован; M6 закрыт в проверенных сценариях, но **вносит блокер-регрессию F1** (подавление легитимной стадийной регенерации `markDirtyScene` для audio/video/image — в Stage 116 регенерация проходила); M7 **не закрыт и ухудшен** блокер-регрессией F2 (refresh claim'а обнуляет 90-минутное окно неоднозначного исхода ⇒ блокировка 24 ч вместо 90 мин). Регрессий по составу падений нет: полный backend-suite 2642/28/85 против baseline 2619/28/85, наборы падений **идентичны**; архитектурные 935/24/0; пакет 35/0; `syntax-smoke.sh backend` — OK. Production, очередь, npm, refs, версии пакетов, lockfiles и чужие dirty-файлы не тронуты. Публикация `@animastor/orchestration@0.1.5` (точно 39 файлов: 4 изменённых + 2 новых + версия) и bump backend'а до `^0.1.5` описаны в §10, но гейт деплоя остаётся **закрытым** до исправления F1 (и желательно F2). Три локальных коммита: `a191984a`, `6a5d429d`, `e2f5bb4c`.
