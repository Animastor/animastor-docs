# Stage 69 — Стабилизация flaky- и порядково-зависимых тестов

**Вердикт: PASS**

Дата: 2026-10-18
Область: только 2 тестовых файла. **Production-код, схема БД, деплой — не менялись.**
Посторонние незакоммиченные изменения в рабочем дереве сохранены и не включались в коммит.
Коммит: `1a60858` (ветка `main`, поверх Stage 68 `7b5f8cf`), запушен в `github` и `origin` обычным push, без force-push.
Предыдущие отчёты: `68-test-postgres-side-effects-audit.md` (PASS), `67-image-ghost-test-isolation.md` (PASS).

Изменённые файлы (diff: +15/−1):
- `backend/tests/guest-workspace.test.js` — детерминированная мутация токена в тесте 16;
- `backend/tests/bootstrap-cancel-continue.test.js` — require.cache-заглушка AI-провайдера.

---

## 1. Defect A — flaky `guest-workspace.test.js`, тест 16

### Симптом и воспроизведение

Тест «16. findByToken resolves only the raw token (hash-only storage)» падал с вероятностью ≈6 %:
`AssertionError: expected { …(6) } to equal null` (последняя строка ассерта — `:397`).

Воспроизведено **до** фикса (правки убраны через `git stash`, 50 прогонов файла подряд):

| Код | Прогонов | pass | fail | Состав падений |
|---|---|---|---|---|
| старый (`replace(/.$/, 'x')`) | 50 | 48 | **2** | оба — тест 16 (`old_20.log`, `old_44.log`) |
| новый (фикс) | **100** | **100** | **0** | — |

Плюс независимые доказательства: падение поймано в аудите Stage 68 (`logs/guest-workspace.test.js.log`:
`16 passing, 1 failing`); симуляция старой мутации на 100 000 токенов — **6340 коллизий (6.34 %)**.

### Причина (механизм)

`created.token.replace(/.$/, 'x')` меняет **последний символ** base64url-секрета на `'x'`.
Но `parseToken` (`src/storage/postgres/repositories/guest-repo.js:26-43`) **декодирует** base64url-секрет
в байты и хэширует **байты** (`sha256(secret)`), а не строку токена.

32-байтовый секрет → base64url из 43 символов; последний символ кодирует 4 информационных бита
+ 2 нулевых бита. `'x'` имеет sextet-значение 49 → после сдвига это ровно 4 бита `0xC`.
Если 4 информационных бита последнего байта секрета = `0xC` (вероятность **1/16 ≈ 6.25 %**),
мутация даёт **байт-идентичный** секрет → `sha256` совпадает → `findByToken` законно находит гостя
→ ассерт `expect(wrong).to.equal(null)` падает. Тест ловил не баг, а равенство токенов.

### Исправление (не ослабляет проверяемое поведение)

```js
const parts = created.token.split('.');
const wrongSecret = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
const wrong = await guestRepo.findByToken(`${parts[0]}.${parts[1]}.${wrongSecret}`);
```

Меняется **первый** символ секрета по правилу A↔B: sextet-значение гарантированно отличается →
байт №0 декодированного секрета различен → `sha256` различен **всегда**. Это проверено симуляцией
на 200 000 токенов: **0 коллизий** (для сравнения: старая мутация — 6.34 %).

Проверяемое поведение сохранено полностью и даже ужесточено: формат токена (`gst.` + guestId + секрет)
и сам путь `parseToken` не обходятся; `guest_id` остаётся прежним → строка гостя **находится** по guest_id,
и сравнение доходит именно до проверки `token_hash` в SQL-запросе (`guest-repo.js:104-107`) — то есть
тест по-прежнему доказывает «hash-only storage: неверный сырой токен не матчится».
Слабым вариантом (не применялся) была бы мутация префикса `gst.`→`gxt.`: `parseToken` вернул бы `null`
на валидации формата, и сравнение хэшей вообще не упоминалось бы.

### Верификация

- симуляция нового мутатора: 0/200 000 коллизий;
- **100/100** прогонов `tests/guest-workspace.test.js` подряд без единого падения
  (при истинном p ≈ 6.3 % вероятность 100/100 ≈ 0.16 % — наблюдение статистически исключает старую частоту);
- файл в составе перестановок §3 — всегда 17 passing.

---

## 2. Defect B — порядковая зависимость `bootstrap-cancel-continue.test.js`

### Симптом и воспроизведение

Изолированный прогон (воспроизведено до фикса и в Stage 68, оба раза стабильно):

```
1) clears the tombstone when the user explicitly continues (Continue = new run):
   AssertionError: expected 'AI assistant is not available — canno…' to match /cannot determine next window offset/
```

### Причина (найдена и подтверждена экспериментально)

`bootstrapNextWindow` (`src/services/agent/bootstrap.js:335-349`) сначала резолвит AI-провайдер:
`resolveAIForBook(bookId)` → системный фоллбэк `resolveSystemProvider()` (`system-ai.js:80+`),
который читает **по порядку**: kill-switch `system_ai.enabled` в БД → строку
`system_ai_providers.id='default'` (с `api_key_enc`) → **переменную окружения**
`OPENROUTER_API_KEY`/`AI_API_KEY`. Без ключа `bootstrap.js:348` бросает
«AI assistant is not available — cannot continue generation…» — **до** блока очистки tombstone
(он внутри `_bootstrapNextWindowInner`) и **до** нужного throw «cannot determine next window offset»
(`bootstrap.js:458`), на который настроен ассерт (`:95`).

В полном наборе «спасают» **другие тестовые файлы**: моки env выставляются на этапе загрузки spec-файлов
(mocha загружает все файлы до запуска любых тестов):
`workspace-ai-provider.test.js:28` → `process.env.OPENROUTER_API_KEY = … || 'sk-global-fallback-test'`,
`system-ai.test.js:20` → `'sk-system-env-test'`. Изолированный прогон этих файлов не загружает → env нет → падение.

Подтверждение причинно-следственной связи (до фикса): запуск с `OPENROUTER_API_KEY=sk-stage69-probe` →
**2 passing**; без env → падает. То есть тест зависел от **глобального состояния процесса**, а не от своего кода.

### Что проверено по мандату (§2)

| Вектор | Результат |
|---|---|
| общие моки | `createMockRedis()` создаётся заново в каждом тесте — чисто |
| состояние модулей | `require.cache` для bootstrap/lazy-book файл уже сохранял/восстанавливал; загрязнений не найдено |
| таймеры | в файле и в пройденном пути (`_bootstrapNextWindowInner` до throw) таймеров нет |
| переменные окружения | **НАЙДЕНО: корневая причина** (`OPENROUTER_API_KEY` + кэш runtime-config) |
| незакрытые ресурсы | пул PG процессный (шатдаун по `--exit`), HTTP-сервер не поднимается — чисто |
| скрытая связь с прод-БД | даже фикс «через env» оставался бы зависимым от kill-switch `system_ai.enabled` и строки `system_ai_providers` **в общей прод-БД** — любая админ-конфигурация могла бы снова изменить исход |

### Исправление

Использован существующий в этом же файле паттерн изоляции через `require.cache` (как для `lazy-book`):

- в `modulePaths` добавлен `'../src/services/workspace-ai-provider'` (сохранение/очистка/восстановление);
- в `beforeEach` после заглушки lazy-book ставится заглушка:
  `resolveAIForBook: async () => ({ source:'system', provider:'global', apiKey:'sk-stage69-deterministic', transport:'http', … })`;
- `afterEach` восстанавливает исходный экземпляр модуля из кэша (или удаляет запись, если её не было).

`bootstrap.js` требует модуль **лениво в точке вызова** (`:68`, `:344`), поэтому заглушка детерминированно
перехватывает guard при любом порядке запуска, env и состоянии прод-БД — ни при каких условиях не влияя.

Протестированное поведение **не ослаблено**: очистка tombstone (`UPDATE agent_sessions … cancelled→failed`,
`generationCancelRepo.clear`, `redis.srem`) и throw «cannot determine next window offset» выполняются
на **реальном** коде с реальными репозиториями/PG. Тест по-прежнему падает, если (а) блок очистки tombstone
удалят/сломают, (б) изменится сообщение об ошибке offset, (в) перестанет работать `loadDraftBook`-заглушка.
Искусственно подменён только инцидентный «входной» guard доступности AI, который тест не проверяет.

### Верификация: многократные прогоны и разные порядки

| Прогон | env | rc | passing | delta PG |
|---|---|---|---|---|
| standalone ×10 | UNSET | 0 ×10 | 2 + 2 … | — (все 10 — 2 passing) |
| standalone (env-фоллбэк-режим) | `OPENROUTER_API_KEY=sk-…` | 0 | 2 | CLEAN |
| bootstrap → workspace-ai-provider → system-ai | задаётся при загрузке | 0 | 23 | CLEAN |
| workspace-ai-provider → system-ai → bootstrap | задаётся при загрузке | 0 | 23 | CLEAN |
| ai-shared-stream → bootstrap | UNSET | 0 | 30 | CLEAN |
| guest-workspace → bootstrap | UNSET | 0 | 19 | CLEAN* |
| bootstrap → guest-workspace | UNSET | 0 | 19 | CLEAN |
| txt-import → bootstrap → worker-setup | UNSET | 0 | 51 | CLEAN |
| ws-ai → bootstrap → guest-workspace | задаётся при загрузке | 0 | 31 | CLEAN |
| ai-shared-stream → ws-ai → bootstrap | задаётся при загрузке | 0 | 42 | CLEAN |
| пара (bootstrap + guest-workspace) ×5 | UNSET | 0 ×5 | 19 | CLEAN |

\* В прогоне «guest-workspace первым» дельта составила **−2 гостя / −2 гостевых workspaces** —
см. §4: это существующий purge-тест удалил **истёкшие** временные строки, не остатки из §7 Stage 68.

Оба файла также прошли во всех 100+100 изолированных прогонах (§1) и в полном наборе (§3).

---

## 3. Полный набор, архитектура, инварианты

| Команда (из `backend/`) | rc | Результат | Дельта PG (41 таблица) |
|---|---|---|---|
| `npx mocha --exit "tests/**/*.test.js"` (прогон 1) | 0 | **3241 passing / 0 failing / 28 pending** | **CLEAN** |
| `npx mocha --exit "tests/**/*.test.js"` (прогон 2) | 0 | **3241 passing / 0 failing / 28 pending** | **CLEAN** |
| `npm run test:arch` | 0 | **929 passing** | **CLEAN** |
| `node --check` по обоим изменённым файлам | — | OK | — |
| `bash scripts/syntax-smoke.sh` (`test:syntax`) | 0 | все production-файлы OK | — |

**Инварианты после всех прогонов** (со стороны Stage 66-68 и исторических данных):

| Проверка | Значение | Статус |
|---|---|---|
| исторические NULL `build_id` в `scene_assets` | 437 | ✅ не тронуты |
| исторические строки 25096/25097/25098/25100 | 4 | ✅ |
| сохранённые книги | ba_ 26 / import_ 433, `books`=2, `scenes`=13 | ✅ |
| `image_units` / NULL `build_id` | 58 / 0 | ✅ |
| сироты в `scene_assets` | 0 | ✅ |
| `wspai-*` чат-сессии (Stage 68-остаток) | 337 (всего сессий 346) | ✅ не тронуты |
| `users` | 83 | ✅ не тронуты |
| прод-образ | `9aac015a6990` (rev `7740525`) | ✅ деплой не выполнялся |

---

## 4. Побочный эффект прогонов: purge истёкших временных строк

В перестановке «guest-workspace первым» дельта была `guests 308→306, workspaces 452→450`.
Виновник — **существующий** тест №13 (`guest-workspace.test.js:351-363`), вызывающий
`guestRepo.purgeExpired()` (`guest-repo.js`): он удаляет гостей с истёкшей сессией и временные
workspaces старше TTL + grace (23 дня). К моменту этого прогона 2 гостевых пар достигли порога
истечения (возраст >23 дней) — то есть это был просроченный временный мусор, удаляемый штатным
механизмом очистки, **не** ручная чистка и не защищаемые остатки Stage 68.

Контроль после всех прогонов: оставшиеся **306 гостей — все активны** (0 истёкших),
**350 guest-workspace — 0 истёкших**; защищённые остатки нетронуты (`wspai-*` 337, `users` 83).

*Наблюдение (вне скоупа):* purgeExpired в тесте действует на общей прод-БД и по определению удаляет
просроченные временные строки любой природы. В будущем (отдельный стейдж) тест можно сузить
до собственных строк или запускать purge на выделенной БД.

---

## 5. Бонусная проверка: полный набор в обратном порядке

Мандат требует устойчивости обоих дефектов при смене порядка (покрыто §2, 11 конфигураций).
Дополнительно проверен **весь** набор (179 файлов) в обратном лексикографическом порядке:

| Набор | passing | failing | Дельта PG |
|---|---|---|---|
| обратный порядок, **с** правками Stage 69 | 3202 | 37 | **CLEAN** |
| обратный порядок, **без** правок Stage 69 (`git stash`) | 3202 | **37 (идентично)** | CLEAN |

Состав падений совпал полностью (16 image-ghost, 7 stage-50, 5 orchestrator, 3 layer-config,
3 happy-path, 2 iu-in-flight, 1 VB-T2) — все падают **до** файлов Stage 69 в этом порядке, то есть
регрессии от Stage 69 нет; это предсуществующая хрупкость других suites к обратному порядку
(кандидат на отдельный стейдж стабилизации). Bootstrap и guest-workspace в обратном порядке прошли.

---

## 6. Оставшиеся вопросы (вне скоупа)

- Предсуществующая порядковая хрупкость 37 тестов при обратном порядке (§5) — нужен отдельный стейдж
  (по аналогии с Stage 67/68: сначала аудит причин, затем точечные фиксы).
- `purgeExpired` в тесте №13 действует на общей прод-БД (§4) — рассмотреть изоляцию.
- Исторический остаток Stage 68 (337 `wspai-*` сессий, гости/комнаты/пользователи, 437 NULL) —
  не трогался, остаётся в скоупе будущих стейджей.

---

## 7. Коммит и проверки

- Коммит: `1a60858` `test(stability): deterministic wrong-token mutation in guest-workspace test 16; stub AI-provider gate in bootstrap-cancel-continue (stage 69)`
  — только 2 тестовых файла (+15/−1); посторонние незакоммиченные изменения (ai-endpoint-sharing,
  ai-shared-inference, installer-package-boundary, phase5-runtime-result, удаление
  `backend/scripts/audit-orphan-books.js`, `deploy/`, `freebuff-chat-*.md`) сохранены и не включались.
- Push: `github` (`7b5f8cf..1a60858`) и `origin` (`7b5f8cf..1a60858`), обычным push.
- Артефакты прогонов: `/tmp/opencode/stage69/` (логи old_*.log, new_*.log, bs_*.log, order*, pair_*, full*, arch).
