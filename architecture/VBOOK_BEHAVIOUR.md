# Поведения героев в VBook (behaviour) — фаза 0

Статус: **фаза 0 реализована в ветках `feat/behaviour-p0`** (backend, web, Android; 2026-11-10), в main не влита, не выкачена. Пакеты `@animastor/vbook-runtime` 0.3.0, `@animastor/editor` 0.3.0, `@animastor/assistant` 0.2.0, `@animastor/generation` 0.1.2 не опубликованы.

Основа — разведка [`VBOOK_BEHAVIOUR_RECON.md`](VBOOK_BEHAVIOUR_RECON.md) (вариант C, §8.3, §9): детерминированный матчинг правил в коде, без нового вызова LLM. Жизненный цикл файла `behavior.json` — [`../07-agents-and-generators/BEHAVIOR_JSON_LIFECYCLE.md`](../07-agents-and-generators/BEHAVIOR_JSON_LIFECYCLE.md).

## 1. Что делает фаза 0

1. Шаг `visuals` (тот же вызов LLM) дополнительно возвращает **эмоцию каждого героя в IU** — `unit.state`.
2. После всех LLM-шагов окна **матчер** (чистая функция) сопоставляет `unit.state` с правилами и записывает в IU `unit.behaviour` — снимок сработавших правил.
3. При сборке видео-промпта фразы из `unit.behaviour` дописываются к строке сториборда этого IU. `video.action`, `image.prompt` и картинки не меняются.

Новых вызовов LLM, нового `step_type`, новой стадии прогресса нет.

## 2. Схема `behavior.json` v2

| Где | Форма |
|---|---|
| **Диск** (`data/books/<id>/behavior.json`), `.vbook`-экспорт | `{schema_version: 2, rules: [...], characters: {<character_id>: {baseline, quirks, reactions}}}` |
| **Память** (`book.behaviors` после `loadBook` / импорта `.vbook`) | то же, v2 |
| **API** (`GET /book/:id`) | `behaviors` — **плоская карта героев** как в v2.1 (`{<character_id>: {…}}`), `behavior_rules` — массив правил, только чтение |

- **Миграция при загрузке**: файл без `schema_version` (формат v2.1) — все верхнеуровневые ключи становятся `characters`. Сохранение (`saveBookBundle`) всегда пишет v2. Новая книга получает пустой v2-документ (`lazy-book/create.js`). Импорт старого `.vbook` мигрирует так же.
- **Зачем проекция в API**: Android ≤ 0.2.8 разбирает `behaviors` как `Map<String, BehaviorEntry>` (Gson); число `schema_version` и массив `rules` сломали бы разбор всей книги. Решение владельца 2026-11-10: на диске и в памяти — v2, в API — плоская карта + `behavior_rules`.
- **Служебные ключи** v2: `schema_version`, `rules`, `characters`, `defaults` — никогда не являются `character_id`. Прочие неизвестные верхнеуровневые ключи v2-документа сохраняются (passthrough). Запись героя (`characters.<id>`) — контракт Character Behavior v2.1, schema-tolerant.
- **Код**: `packages/animastor-vbook-runtime/src/behavior-schema.cjs` (`normalizeBehaviors`, `ensureBehaviorsV2`, `behaviorCharacters`, `projectBookBehaviorsForApi`, `mergeIncomingBehaviors`), валидатор — `bundle-validator.cjs` (v2: `schema_version === 2`, `rules[]` с уникальным непустым `id`, `characters` — объект; v2.1 принимается).

### 2.1 Правило

```json
{
  "id": "boris_volkov.praised",
  "scope": "character",
  "character_id": "boris_volkov",
  "when": { "emotion": ["proud", "joyful"], "unit_type": ["dialogue"] },
  "then": { "action": "lights up instantly, straightens to his full height and talks twice as fast" },
  "strength": 0.7,
  "probability": 0.6,
  "cooldown_iu": 3,
  "priority": 10,
  "enabled": true
}
```

| Поле | Смысл | Валидация хостом (`behaviour-rules.js`) |
|---|---|---|
| `id` | уникальный ключ; по нему книга перекрывает дефолт | обязателен |
| `scope` | `global` — любой герой; `character` — только `character_id` | `character` без `character_id` — правило отброшено |
| `when.emotion` | эмоции из словаря (§3), при которых правило применимо | значения вне словаря выкидываются; пусто → правило отброшено |
| `when.unit_type` | необязательный фильтр типа IU | — |
| `then.action` | EN-фраза без подлежащего; в сториборд идёт как `<character_id> <action>` | пусто → отброшено; обрезка до 200 символов |
| `strength` 0..1 | интенсивность; **0 = правило выключено**. В фазе 0 на формулировку не влияет, сохраняется в IU | clamp 0..1, по умолчанию 1 |
| `probability` 0..1 | шанс срабатывания (детерминированный, §4) | clamp 0..1, по умолчанию 0.35 |
| `cooldown_iu` | сколько IU после срабатывания правило молчит для этого героя | целое ≥ 0, по умолчанию 4 |
| `priority` | конфликт «одно поведение на героя в IU» | число, по умолчанию 0 |
| `enabled` | `false` — выключено (в книге выключает дефолт) | — |

### 2.2 Эффективные правила

`эффективные = дефолты репозитория (backend/ai/examples/behaviour-rules.json) ⊕ rules книги`:

- правило книги с тем же `id` **поверхностно сливается** с дефолтом (`{...дефолт, ...книга}`) — поэтому запись `{id, enabled:false}` выключает дефолт, а `{id, probability: 1}` меняет только вероятность;
- новые `id` книги добавляются;
- выключенные и невалидные правила отбрасываются до матчера.

Дефолты (`backend/ai/examples/behaviour-rules.json`) — 7 правил `scope: "global"`, EN, только жесты (без внешности и одежды — не конфликтуют с passport и `render_rules`), у всех `strength 0.6`, `probability 0.25`, `cooldown_iu 4`, `priority 0`:

| id | `when.emotion` | `then.action` |
|---|---|---|
| `global.embarrassed_blush` | embarrassed | blushes and looks away |
| `global.thoughtful_head_rub` | thoughtful | rubs the back of the head |
| `global.anxious_fidget` | anxious | fidgets with the hands |
| `global.surprised_freeze` | surprised | raises the eyebrows sharply and freezes for a moment |
| `global.angry_jaw` | angry | clenches the jaw, fists tightening |
| `global.sad_shoulders` | sad | lets the shoulders drop, gaze lowering |
| `global.joyful_smile` | joyful | breaks into a wide smile |

Фразы — глагольные группы без подлежащего: в сториборде перед ними стоит `character_id`. Отдельных «shy»/«nervous» в словаре нет — их покрывают `embarrassed` и `anxious`.

Образец: `backend/ai/examples/behaviour-rules.example.json` — 9 правил `scope: "character"` из реакций примера `behavior.json` (`anna_smirnova`, `boris_volkov`, `dmitry_orekhov`). **Не загружается** ни матчером, ни промптом импорта (`ai-service.loadReferenceExamples` исключает `behaviour-rules*.json`); правила копируются в `rules` книги вручную.

**Частота и лимит на сцену.** `defaults.max_per_scene` дефолтного файла = **2**; книга переопределяет его в своём `behavior.json` (`defaults.max_per_scene`, целое ≥ 0; `0` — поведения во всех сценах книги выключены; невалидное значение игнорируется; если не задано нигде — без лимита). Кроме лимита частоту ограничивают cooldown на пару (правило, герой) и одно поведение на героя в IU. На фикстуре из 4 IU и 2 героев (6 из 8 состояний подпадают под дефолтные правила), 10 000 `book_id`:

| Поведений на сцену | без лимита | `max_per_scene = 2` |
|---|---|---|
| 0 | 23,5% | 23,5% |
| 1 | 30,8% | 30,8% |
| 2 | 24,4% | 45,7% |
| 3–6 | 21,3% | **0%** |

## 3. Эмоции в IU (`unit.state`)

Фиксированный словарь (EN, 15 значений, `backend/src/services/agent/behaviour-emotions.js`; тот же список — в правиле `backend/ai/rules/visuals.md`, раздел «Character emotions (unit.state)», совпадение закреплено тестом):

`neutral, joyful, sad, angry, afraid, surprised, disgusted, embarrassed, anxious, proud, confused, determined, thoughtful, tender, tense`

- `unit.state = {<character_id>: <emotion>}` — только для героев из контекста сцены (по `character_id`), присутствующих в IU.
- Возвращается шагом `visuals` в том же ответе, что `image`/`video` (`stepCreateVisuals`, `pipeline-steps.js`). Новых вызовов нет.
- Валидация хостом (`sanitizeUnitState`): неизвестный `character_id` или эмоция вне словаря — запись отбрасывается; регистр/пробелы нормализуются. Пустой `state` допустим и в IU не пишется.
- `state` — отдельное поле: правило запрещает модели вписывать эмоцию в `image.prompt`/`video.action` из-за него; `IMAGE_PROMPT_MAX_CHARS` и формат промптов не меняются.

## 4. Матчер (`backend/src/services/agent/behaviour-matcher.js`)

Чистая функция без I/O и без `Math.random`.

Вход: `book_id`, сцена, её IU по порядку, эффективные правила, известные `character_id`, лимит `max_per_scene` (`null` — без лимита). Выход по каждому IU: `null` (не трогать) или `unit.behaviour = [{rule_id, character_id, strength, seed, action}]`.

Для каждого IU, для каждого героя из `unit.state` (по алфавиту):

1. **Кандидаты**: правило активно (`enabled !== false`, `strength > 0`, `probability > 0`, есть `then.action`), эмоция героя ∈ `when.emotion`, тип IU подходит, `scope` подходит.
2. **Cooldown** — в пределах сцены, по порядку IU, отдельно для пары (правило, герой): после срабатывания в IU *i* правило заблокировано для этого героя на IU *i+1 … i+cooldown_iu*.
3. **Бросок**: `seed = первые 4 байта sha256("${book_id}:${rule_id}:${unit_id}")` как uint32; срабатывает, если `seed / 2³² < probability`.
4. **Конфликт**: не больше одного поведения на героя в IU — больший `priority`, затем `id` по алфавиту.
5. **Лимит на сцену** (`max_per_scene`): поведения считаются по порядку IU; внутри одного IU победители героев берутся по `priority` (больше — раньше), затем `id` правила, затем `character_id` — пока счётчик сцены меньше лимита. Достигнут лимит — оставшиеся IU сцены пропускаются. `0` — в сцене ничего не применяется.
6. **Снимок**: `action` — копия `then.action` на момент применения; `seed` — uint32 броска.

Идемпотентность: IU с `behaviour_locked: true` или с уже заполненным массивом `behaviour` пропускаются (их записи учитываются в cooldown и в лимите на сцену). Повторный прогон на тех же данных даёт тот же результат; последующая правка правила готовые IU не меняет.

## 5. Где применяется

- **Хук** — `behaviour-apply.js` `applyBehavioursToWindow`, вызывается **один раз на окно в обоих путях раннера** (`runPipeline` и `processCachedScenes`, `pipeline-runner.js` `applyWindowBehaviours`) — после всех LLM-шагов (visuals → сверки → полировки → финальный свип → fantasy repair), перед сохранением. Reconcile/polish не могут стереть результат.
- Только IU текущего окна; готовые сцены книги не пересчитываются.
- Нет эффективных правил → шаг ничего не делает (id не назначаются, IU не меняются). Ошибка хука окно не валит.
- Матчеру нужен `unit.id` (seed), поэтому хук назначает IU окончательные id (`iu-<hex>`) до матчинга; `lazy-book/create.js` сохраняет заранее назначенный id и переносит `state`, `behaviour`, `behaviour_locked`.
- **Видео**: `video-workflows.js` `buildVideoPrompt` — после действия (и строки «speaking with lip movement») к строке сториборда добавляется `. <character_id> <action>[; …]`. `video.action` в JSON не меняется; без `behaviour` (или с пустым массивом) промпт байт-в-байт прежний.
- **Картинки** (`prompt-builder`) не затрагиваются.

### Пример (фикстура отчёта `reports/2026-11-10/behaviour-p0-fix.md`, дефолтные правила, `book_id = ba_example`)

```
state  iu-0000e004 {anna_smirnova: sad, boris_volkov: embarrassed}  → behaviour [global.embarrassed_blush → boris_volkov]
строка 9.0–12.0s: wide shot. slow push-in on the desk. boris_volkov blushes and looks away
```
state  iu-0000e001 {boris_volkov: proud}  → behaviour [boris_volkov.praised]
строка 0.0–3.0s: medium shot. … boris_volkov gestures broadly while reading. boris_volkov speaking with lip movement. boris_volkov lights up instantly, straightens to his full height and talks twice as fast
```

## 6. Инвалидация (`prompt-dependency-registry`)

| Поле IU | Слои dirty | Почему |
|---|---|---|
| `unit.behaviour` | **video** | фразы уходят только в видео-сториборд |
| `unit.state` | — | вход матчера, на GPU не уходит |
| `unit.behaviour_locked` | — | вход матчера |
| иное неизвестное поле | audio + image + video | catch-all сохранён |

Правка правил в `behavior.json` сама по себе ничего не помечает dirty: применённые фразы — снимок в IU. PATCH/POST/DELETE поведений героев тоже без dirty-propagation (записи героев генерацией не читаются).

## 7. Пути записи от клиентов

| Эндпоинт | Что принимает | Что делает с v2 |
|---|---|---|
| `POST /book/:id/behaviors` | `{character_id, baseline?}` | пишет `characters.<id>`; 409 на дубль; служебный ключ не является героем (404) |
| `PATCH /book/:id/behaviors/:characterId` | `{fields}` | `setDeep` в `characters.<id>`; файл v2.1 мигрирует при первой записи |
| `DELETE /book/:id/behaviors/:characterId` | — | удаляет `characters.<id>`; `rules` не трогаются |
| `DELETE /book/:id/characters/:id` (каскад) и удаление героя через `edit_book` | — | удаляет `characters.<id>` **и все правила `scope:"character"` с этим `character_id`**; глобальные правила остаются (`removeCharacterBehaviors`, страж ассистента) |
| `PUT /book/:id` | книга целиком, `behaviors` — плоская карта | карта раскладывается в `characters`, `rules` и `schema_version` сохраняются; без `behaviors` — хранимый документ не меняется (раньше сбрасывался в `{}`); `behavior_rules` в теле игнорируется |
| ассистент `edit_book` | JSON Patch | промпт описывает `/behaviors/characters/{id}`; страж в `applyPatches` переписывает `/behaviors/<id>…` → `/behaviors/characters/<id>…`, плоскую карту в `/behaviors` раскладывает в `characters` с сохранением `rules` |
| импорт `.vbook`, создание книги | файлы бандла | `normalizeBehaviors` при загрузке, v2 при сохранении |

Web и Android рассчитаны на плоскую карту и дополнительно фильтруют служебные ключи (`frontends/app/src/api/behaviors.ts`, `repository/BehaviorEntries.kt`); на Android `BookData.behaviors` — сырой `JsonElement`, поэтому даже сырой v2-документ не ломает разбор книги. Карточек правил в UI в фазе 0 нет. Паритет — [`ANDROID_WEB_PARITY.md`](ANDROID_WEB_PARITY.md), «Открытые GAP», 2026-11-10.

## 8. Что отложено

- **Фаза 1**: `behaviour_locked` при ручной правке IU в редакторе (сейчас поле только читается матчером); UI правил (карточки, правка); правила для картинок (`then.image`, инвалидация image); формулировка фраз LLM внутри `visuals` (вариант C+B разведки); эмоция в TTS (`audio_emotion` — нужен per-IU слот в контракте TTS/воркера).
- Не входит: реестр этапов и слияние двух путей раннера; `vbook_enabled` в layer-config; перерасчёт готовых сцен; orch v2, слой `vbook` (задача H).

## 9. Файлы

| Репозиторий | Файл |
|---|---|
| backend | `backend/ai/examples/behaviour-rules.json`, `backend/ai/examples/behaviour-rules.example.json` (образец), `backend/src/services/ai-service.js` (`loadReferenceExamples`), `backend/ai/rules/visuals.md`, `backend/src/services/agent/{behaviour-emotions,behaviour-matcher,behaviour-rules,behaviour-apply,pipeline-steps,pipeline-runner}.js`, `backend/src/workflows/video/video-workflows.js`, тесты `backend/tests/behaviour-p0.test.js`, `behavior-edit-book.test.js` |
| пакеты | `packages/animastor-vbook-runtime/src/{behavior-schema.cjs,index.js,bundle-validator.cjs,lazy-book/create.js}`, `packages/animastor-editor/src/{editor-routes,entity-crud-routes}.cjs`, `packages/animastor-assistant/src/chat-engine.cjs`, `packages/animastor-generation/src/dirty-grammar/prompt-dependency-registry.js` |
| web | `frontends/app/src/api/{behaviors.ts,behaviors.test.ts,models.ts}`, `frontends/app/src/pages/EditPage.tsx` |
| Android | `repository/{BehaviorEntries.kt,BookModels.kt}`, `ui/EditFragment.kt`, тест `repository/BehaviorEntriesTest.kt` |
