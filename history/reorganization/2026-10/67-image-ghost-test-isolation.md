# Stage 67 — Stop PostgreSQL pollution from image-ghost test

**Вердикт: PASS**

Дата: 2026-10-18
Область: только тест. **Production-код, схема, деплой — не менялись.** Исторические NULL-строки (437) и данные двух сохранённых книг не тронуты.
Коммит: `aaa95db` (ветка `main`, поверх Stage 66 `0d9b468`), запушен в `github` и `origin` обычным push, без force-push.
Отчёт Stage 66: `66-image-units-build-id-fix.md` (PASS).

---

## 1. Причина загрязнения

`tests/image-ghost-no-jobs-sent.test.js` использует **мок Redis** (`createMockRedis`), но **реальный PostgreSQL**.
Диспатч-путь в тесте идёт через реальный `iu-processor.processSingleIU` → `saveIUMetadata()` →
`iu.upsertImageUnit(buildId, bookId, ...)` → реальный `image_units` INSERT/UPSERT.

Цепочка (все — реальные прод-модули):

```
dispatchEngine.dispatchStage(...)            // wireProductionSeams → реальный executor
  → iuProcessor.processSingleIU(...)
    → saveIUMetadata(...)                    // src/image/iu-processor.js:92
      → iu.upsertImageUnit(buildId, bookId, chapterId, sceneId, unit.id, {...})
        → INSERT INTO image_units ... ON CONFLICT ... DO UPDATE   // реальный PG
```

Каждый прогон «отправляет» 9 IU (`iu-1…iu-9`, `makeBook()`), каждый upsert пишет строку.
`build_id` уникален per-run, но `book_id` был **постоянным** `'ghost_book'` → строки накапливались/обновлялись
и оставались навсегда: teardown-а не было вообще.

**Почему именно 9 строк (а не больше):** ключ дедупликации `image_units` —
`(build_id, book_id, chapter_id, scene_id, unit_id)`. 9 юнитов × повторные прогоны = 9 строк (UPSERT поверх).
Это подтверждено замером: до = 58, после прогона = 67 (ровно +9), после teardown = 58.

---

## 2. Какие таблицы/записи создаются и кто от них зависит

| Что | Кто пишет | Кто читает |
|---|---|---|
| `image_units` (9 строк: `ghost_book` / `build-ghost`, `iu-1…iu-9`) | `saveIUMetadata` → `iu.upsertImageUnit` | **никто** — ни один другой тест, сервис или сущность не читает `ghost_book` |

Проверка зависимостей: `grep -rn "ghost_book\|build-ghost"` по `backend/` и `packages/` (без `node_modules`) —
**единственное** вхождение: сам тестовый файл (строка с константами). Другие тесты/сущности от этих строк **не зависят**.

Другие PG-таблицы тест не трогает (проверено на прогонах): `scene_assets` ghost = 0, `generation_tasks` ghost = 0,
`books` ghost = 0, `scenes` ghost = 0. Загрязнение было **только** `image_units`.

---

## 3. Исправление

В `backend/tests/image-ghost-no-jobs-sent.test.js`:

1. **Уникальные тестовые идентификаторы per-run** (вместо констант `'ghost_book'` / `'build-ghost'`):
   ```js
   const RUN_TOKEN = `${Date.now().toString(36)}-${process.pid}`;
   const B = `ghost_book_${RUN_TOKEN}`, BUILD = `build-ghost-${RUN_TOKEN}`;
   ```
   Идентификатор теперь **не может принадлежать** другому тесту, книге или пользователю (это требование мандата:
   не использовать широкую очистку по `'ghost_book'`). Все ключи Redis/маркеры в тесте строятся от `B`,
   мок Redis изолирован — поведение тестов не изменилось (28 passing, что и до фикса).

2. **Гарантированный teardown** (mocha `after()` — эквивалент `finally`: выполняется и при падении тестов):
   ```js
   async function teardownGhostBookPg() {
       const deleted = await query('DELETE FROM image_units WHERE book_id = $1', [B]);
       const remaining = await query('SELECT count(*)::int AS n FROM image_units WHERE book_id = $1', [B]);
       if (remaining.rows[0].n !== 0) throw new Error(`... left ${n} row(s)`);
       return deleted.rowCount || 0;
   }
   ```
   Удаляются **только** строки с точным уникальным `book_id` этого запуска (без широких `LIKE`/`TRUNCATE`).
   Хук проверяет, что после удаления осталось 0 строк, и падает, если cleanup не сработал —
   изоляция включена в сам тест.

Хук установлен в **обеих** top-level suites файла (они делят `B`); второй хук — идемпотентная no-op.

Транзакционная очистка не применялась: записи идут через реальный репозиторий в рамках production-пути
диспатча (не одна транзакция), совместимой с «настоящим кодом теста» транзакции нет — cleanup в `after()`.

---

## 4. Замеры: число строк до/после повторных запусков

| Прогон | rc | passing | `image_units` до | `image_units` после | ghost-строк после | teardown |
|---|---|---|---|---|---|---|
| 1 | 0 | 28 | 58 | **58** | **0** | удалил 9 |
| 2 | 0 | 28 | 58 | **58** | **0** | удалил 9 |
| 3 | 0 | 28 | 58 | **58** | **0** | удалил 9 |

**Сценарий падения теста** (мандат §5): во временной копии файла инъектировано намеренное падение
(`expect(res.result.reason).to.equal('INTENTIONAL_FAILURE_STAGE67')`), прогон:
`rc=1`, `1 failing`, **teardown всё равно удалил 9 строк**, до=58 / после=58 / ghost=0.
Затем файл восстановлен из резервной копии, прогон снова 28 passing / 58 / 0.

**Полный набор тестов** (combined-run, где раньше загрязнение и оставалось):
`npx mocha --exit "tests/**/*.test.js"` → **3241 passing / 0 failing / 28 pending**, `image_units` **до 58 → после 58**,
ghost-строк **0**.

---

## 5. Связанные тесты и архитектура

| Команда (из `backend/`) | Результат |
|---|---|
| `node --check tests/image-ghost-no-jobs-sent.test.js` | OK |
| `npx mocha --exit tests/dispatch-meta-lease-lifecycle.test.js tests/image-orphan-generating-repair.test.js tests/orchestrator-convergence.test.js tests/orchestration-stabilization.test.js` | **87 passing** |
| `npm run test:arch` | **929 passing**, 24 pending |
| `npx mocha --exit "tests/**/*.test.js"` | **3241 passing**, 0 failing, 28 pending |

---

## 6. Инварианты Stage 66 / production / исторические данные (после всех прогонов)

| Проверка | Значение | Статус |
|---|---|---|
| `scene_assets` всего | 459 (ba_ 26 + import_ 433) | ✅ не изменилось |
| исторические NULL `build_id` в `scene_assets` | 437 | ✅ не тронуты |
| исторические строки 25096/25097/25098/25100 | присутствуют (4) | ✅ не удалялись |
| `image_units` всего / NULL `build_id` | 58 / 0 | ✅ инвариант Stage 66 цел |
| `books` / `scenes` | 2 / 13 | ✅ сохранённые книги нетронуты |
| ghost-строки в `scene_assets` / `generation_tasks` | 0 / 0 | ✅ |
| прод-образ | `sha256:9aac015a…` (rev `7740525`) | ✅ деплой не выполнялся |

Загрязнение, оставшееся от **старого** (до-фиксного) кода Stage 66 (9 строк `ghost_book`/`build-ghost`),
удалено на входе в Stage 67 охранной транзакцией (`DELETE ... WHERE book_id='ghost_book' AND build_id='build-ghost'`,
guard: удалено ровно 9, total = 58). Эти строки принадлежали именно этому тесту (единственный владелец идентификатора,
проверено grep-ом), иных источников не было.

---

## 7. Оставшиеся проблемы (вне скоупа)

- **Прочие тесты** пишут в реальный PG свои ряды? — по полному прогону «сиротские» строки остаются **только** от
  этого файла (до фикса). Остальные suites с PG-побочными эффектами (например, `markready-build-id-idempotency.test.js`)
  уже используют собственные `test-*` идентификаторы + cleanup. Явного аудита всех тестов на PG-побочные эффекты
  в этом стейдже не делалось — при желании это отдельный небольшой стейдж.
- **Крах процесса** (kill -9 во время прогона) оставит строки с уникальным `ghost_book_<ts>-<pid>`:
  они инертны (никто их не читает, идентификатор неповторим) и легко находятся по префиксу `ghost_book_`.
  Полная гарантия от kill требует транзакционного написания всего dispatch-пути — не совместимо с реальным кодом теста.
- Файл по-прежнему использует реальный PG для upsert-ов во время прогона (строки живут доли секунд между
  upsert и teardown). Альтернатива — стаб `iu.upsertImageUnit` через `require.cache` (как в
  `image-orphan-generating-repair.test.js`), но она понижает достоверность теста (реальный путь диспатча)
  и противоречит предпочтению мандата «уникальные идентификаторы + teardown».
