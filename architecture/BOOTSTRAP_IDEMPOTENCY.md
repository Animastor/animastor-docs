# Bootstrap idempotency — один прогон окна на книгу

> **Статус:** Current (2026-11-26), выкачено: backend `deploy-ee1a331`, web `368b27f`, Android 0.3.4 (17);
> `@animastor/vbook-runtime` 0.6.0, `@animastor/web-generator-vbook` 0.2.0. В backend `overrides`
> держит одну копию vbook-runtime для `editor` / `player` / `ai-analysis`.
> **Повод:** книга `ba_1795695606197` — два файла «Пролог» с `chapter_index` 0
> (разведка `reports/2026-11-26/ba-1795695606197-prologue-dup-recon.md`).

## Что было

Два параллельных `POST /api/v1/book/:bookId/bootstrap` шли двумя независимыми прогонами
первого окна. Проверка «книга уже BOOTSTRAPPED» стояла только на входе, `createFromAnalysis`
всегда создавал новую главу 0 со случайным `chapter_id`, а `structure.chapters_order`
собирался из всех файлов на диске — обе главы попали в книгу. Чистка partial-глав
одного прогона могла удалить файлы другого.

## Правило

**Один прогон окна (первого или следующего) на книгу в каждый момент.** Повторный
запрос при идущем прогоне — `409`, повторный bootstrap готовой книги — no-op.

### Lock на книгу (backend `services/bootstrap-lock.js`)

- Ключ Redis `animastor:bootstrap-lock:<bookId>`, значение — случайный token прогона:
  `SET key token NX EX 900`.
- Освобождение — в `finally`, только своим token (Lua compare-and-del): чужой lock
  (после истечения TTL его мог взять другой прогон) не удаляется.
- Heartbeat: каждые 300 с TTL продлевается до 900 с (Lua compare-and-expire), пока прогон
  жив — окно дольше 15 минут lock не теряет. Потеря lock'а пишется в лог.
- Нет Redis — ошибка (fail-closed): прогон без lock'а не запускается.
- Под lock'ом идут все пути к `txtImporter.bootstrapImportedText` / `bootstrapNextWindow`
  (а значит к `lazyBook.createFromAnalysis` / `appendToBook`):
  `POST /bootstrap` (прогон **и** его постобработка — строка окна 0 в PG, чанки, placeholder-аудио),
  `POST /bootstrap-next-window`, `POST /resume-bootstrap`, фоновый прогон
  `trigger-next-window`, `window-generator` (`runBackgroundWindowGeneration`).
- Семейство ключей зарегистрировано в `backend/tests/architecture/redis-registry.js`
  (owner backend, не cross-module).

### Ответы API

| Ситуация | Ответ |
|---|---|
| Lock занят другим прогоном | **409** `{ error: 'bootstrap_in_progress', book_id, session_id }` (`session_id` — активная `agent_session`, если есть, иначе `null`) — для `/bootstrap`, `/bootstrap-next-window`, `/resume-bootstrap` |
| Книга уже `BOOTSTRAPPED`/`ACTIVE` и файлы глав есть (проверка — **после** захвата lock'а, книга перечитывается) | **200** no-op: `already_bootstrapped: true`, текущие `state`, `title`, `scenes`, `chapters[]` (по главам без обложки); нового прогона, строки окна в PG и чанков нет |
| Обычный прогон | **200** как раньше + `already_bootstrapped: false` |
| `trigger-next-window` при занятом lock'е | `200 { triggered: false, queued: true, reason: 'bootstrap_in_progress' }`, фоновый прогон не запускается |
| `window-generator`, lock занят | сессия окна возвращается в `queued` (не `failed`) |

`chapters[]` ответа `/bootstrap`: поле `chapter_id` — каноническое; поле `chapter`
оставлено для старых клиентов и теперь равно `chapter_id` (раньше было `undefined`:
код читал несуществующее `result.chapter.chapter`, отсюда `*_undefined_*` в именах чанков
и placeholder-аудио). Клиенты: web тело ответа не читает; в Android модель
`BootstrapResponse.chapters[].chapter_id` (результат вызова в UI не используется).

### Глава по `chapter_index` (`@animastor/vbook-runtime` 0.6.0)

- `createOrAppendScenes` (`createFromAnalysis` / `appendToBook`) ищет существующую главу
  по `chapter_index` **и для первого окна**; найденная глава переиспользуется
  (тот же `chapter_id`).
- Первое окно всегда начинает главу 0 с начала: его сцены **заменяют** сцены прошлого
  прогона (типографская сцена `chapter_intro` сохраняется). Следующие окна той же главы
  по-прежнему дописывают сцены.
- Инвариант: два файла глав с одним `chapter_index` (кроме обложки) →
  `DuplicateChapterIndexError` (`code: 'duplicate_chapter_index'`, в тексте — оба файла).
  Проверяется до любой записи окна и при сборке `structure.chapters_order` (`create.js`,
  оба места `parse.js`). Тихого дубля больше нет; книга с уже существующим дублем
  (`ba_1795695606197`) при следующем окне получит эту ошибку — её чинят отдельно
  (удалить лишний файл).

### `book_generation_sessions`, окно 0

`markFirstWindowCompleted(bookId, sceneCount, sourceRange)` пишет
`source_offset_start/end` (диапазон окна из `bootstrapWithAgent`:
`windowStartOffset` … `sceneConsumedOffset`; запасной вариант — min/max `source_start/end`
сцен). Раньше оба поля всегда были 0.

### Клиенты

- **Web** (`@animastor/web-generator-vbook` 0.2.0, `startVBookGeneration`): POST
  `/bootstrap` | `/bootstrap-next-window` отправляется один раз — ни пакет, ни
  `api/client.ts` `postJsonLong` его не повторяют (таймаут 15 мин, без `retryWithBackoff`);
  повторный старт, пока POST в полёте, игнорируется (`poll.isBootstrapInFlight` /
  `setBootstrapInFlight`, состояние — `VBookPollState.bootstrapInFlight` хоста, привязка
  в `generateStore`; закрытие книги `stopGenerationSession` флаг сбрасывает); 409 `bootstrap_in_progress` →
  слежение за прогрессом (`pollVBookProgress`), не ошибка.
- **Android** (`GenerateViewModel.startVBookGeneration`): то же правило; bootstrap-вызовы
  идут через `RetrofitClient.bootstrapApi` (`retryOnConnectionFailure(false)` — OkHttp не
  пересылает POST после обрыва соединения); `BootstrapInProgressException` для 409.
  Паритет — `ANDROID_WEB_PARITY.md`, строка 2026-11-26.

## Тесты

- backend `tests/bootstrap-idempotency.test.js` (тестовый Redis): lock (NX, чужой token,
  heartbeat, finally, fail-closed), txt-importer под lock'ом, два параллельных
  `/bootstrap` → один прогон + 409, повторный `/bootstrap` → no-op с теми же файлами,
  `chapter_id` в чанках, детектор на копии `source.txt` книги (`ANIMASTOR_BA_SOURCE_TXT`,
  текст пользователя в репозиторий не кладётся — без переменной тест пропускается).
- `packages/animastor-vbook-runtime/test/bootstrap-idempotency.test.js`: два
  `createFromAnalysis` → один файл главы 0; дубль `chapter_index` → ошибка.
- web `packages/animastor-web-generator-vbook/test/bootstrap-idempotency.test.ts`;
  Android `BootstrapIdempotencyTest.kt`.
