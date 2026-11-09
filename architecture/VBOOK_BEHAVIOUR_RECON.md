# Разведка: встраивание behaviour.json в пайплайн VBook

Дата: 2026-11-09. Тип: разведка, только чтение кода и данных книги. Изменений в коде, на проде, в PG и Redis нет. Документ фиксирует текущее устройство пайплайна VBook и предлагает варианты встраивания шаблонных поведений героев; ничего не реализует.

## Версии кода

| Репозиторий | Коммит (main) | Дата коммита | Префикс в ссылках |
|---|---|---|---|
| animastor-backend | `8cb3b46` | 2026-11-07 | `backend/...`, `packages/...` |
| animastor-web | `fc1d9bc` | 2026-11-07 | `web:frontends/...`, `web:packages/...` |
| animastor-android | `4632262` | 2026-11-07 | `and:frontends/...` |
| animastor-docs | `56e17bb` | 2026-11-09 | `docs:...` |
| данные книги BA | не в git | файлы 2026-10-30…11-07 | `data:...` = `/home/animastor/data/books/ba_1788172242081` |

Каждая ссылка `файл:строка` указывает на строку в этих коммитах. `gpu-hub`, `worker`, `deploy`, `site`, `tools` не читались: к наполнению JSON книги они отношения не имеют (для полноты grep по ним выполнен — см. §1.3).

## Методика и границы

- Код читался только в `/home/animastor/src/*` (`grep`, `sed`, `git log/show`). Данные книги — только чтение (`find`, `ls`, `stat`, `jq`, `cat`); ничего не копировалось в репозиторий.
- PG и Redis не читались. Прод не трогался, `docker exec` не выполнялся.
- «Писателя нет» ниже означает «поиск по репозиториям не нашёл записи», а не доказательство отсутствия во время выполнения.
- Стоимость в токенах — оценка по фактическим объёмам BA (§8.5), не замер API.
- Ссылки проверены скриптом: файл существует, номер строки не больше длины файла (число ссылок и результат — в §13).

## Сводка

| Вопрос | Ответ | Раздел |
|---|---|---|
| Что лежит на VPS | `data:behavior.json` — **2 байта, `{}`**, mtime 2026-10-30 08:49:08 UTC; поведений в книге нет | 1.1 |
| Один файл или по копии на книгу | По копии на книгу; у второй книги (`import_…`) файла нет вообще | 1.1 |
| Кто создаёт | `create.js` создаёт `{}` на первом окне; наполняют редактор и AI-ассистент (`edit_book`); пайплайн генерации не читает | 1.2–1.3 |
| Чем отличается от соседних JSON | Это единственный «необязательный enrichment», не участвующий в генерации; ключ — `character_id` | 1.4 |
| Где шаблон | Уже в git: `backend/ai/examples/behavior.json` (3 героя, 9 правил, English), но никуда не подставляется | 1.5 |
| Этапов в пайплайне | 14 шагов (LLM/детерминированных) + сохранение; два дублирующих пути (`runPipeline` и `processCachedScenes`) | 2 |
| Слой «vbook» в orch v2 | Не реализован: `layer IN ('audio','image','video')`; задача H — этап 3 | 3.4 |
| Что инвалидирует `part_hash` | `sha256` всего workflow изображения (prompt+negative+шаблон); `unit.behaviour` без правки registry пометит **все** слои | 5 |
| Рекомендация | Вариант C (детерминированный матчинг + seed), формулировка — внутри существующего шага `visuals`; хранение `unit.behaviour[]` + правила в `behavior.json` v2 | 8–9 |
| Оценка на BA | 17 сцен / 32 IU; C — 0 токенов, C+LLM ≈ 10k вход / 1k выход, A ≈ 30k / 3k | 8.5 |

---

## 1. behaviour.json как есть

### 1.1 Файл на VPS

```
$ find /home/animastor/data/books -iname "behavio*.json"
/home/animastor/data/books/ba_1788172242081/behavior.json

$ stat …/behavior.json
Size: 2   Modify: 2026-10-30 08:49:08 UTC   Birth: 2026-10-30 08:49:08 UTC
$ cat …/behavior.json
{}
```

- Это **не общий файл**, а копия внутри каталога книги: `data:behavior.json:1`. Вторая книга `data:../import_1786345731767_1786345734345/` вообще не имеет `behavior.json` (файл создаётся только на первом окне новой книги, §1.2).
- Дата совпадает с импортом BA (2026-10-30) и не менялась после — то есть файл никто не наполнял; `book.json` при этом обновлялся 2026-11-07.
- Итог: **в BA нет ни одного поведения**. Описанный в задаче наполненный файл «смутился → покраснел» — это, судя по содержимому, шаблон-пример из репозитория (§1.5), а не данные книги.

### 1.2 Контракт (schema v2.1)

Контракт зафиксирован комментарием рядом с моделью хранения: `packages/animastor-vbook-runtime/src/index.js:23-42`.

```
behavior.json = { <character_id>: {
  baseline  : string?                — как герой ведёт себя ОБЫЧНО
  quirks    : string[]?              — повторяющиеся привычки, по одной
  reactions : [{trigger, reaction}]? — «если → то»
} }
```

- Объект **schema-toleran**: неизвестные ключи (включая будущие поля) сохраняются при каждом load/save round-trip — `packages/animastor-vbook-runtime/src/index.js:24-26`, `editor-routes.cjs:700-704`.
- `frequency/intensity, priority, extraction, runtime interpretation, state machines` в контракте **сознательно отложены** — `packages/animastor-vbook-runtime/src/index.js:35-36`. Это прямо отвечает на вопрос о «силе/вероятности»: места под них в v2.1 нет, нужна v2.
- Язык полей — английский: AI-facing поля всегда English (`backend/src/services/agent-prompts.js:88-95`, `docs:07-agents-and-generators/LANGUAGE_ARCHITECTURE.md`). Сам пример тоже английский.
- Валидация на диске — только «плоский объект»: `packages/animastor-vbook-runtime/src/bundle-validator.cjs:129-133`, подключение `:271`. Ни `baseline`, ни `reactions` не проверяются по типам.
- Хранение: файл всегда пишется при сохранении бандла (`packages/animastor-vbook-runtime/src/index.js:490-494`), читается в `loadBookFromDir` (`packages/animastor-vbook-runtime/src/index.js:614-620`) и в zip-импорте (`packages/animastor-vbook-runtime/src/index.js:204-211`). В памяти — верхнеуровневый ключ `book.behaviors` (`packages/animastor-vbook-runtime/src/index.js:291`, `packages/animastor-vbook-runtime/src/index.js:645`).

### 1.3 Кто создаёт, пишет и читает

| Роль | Где | Что делает |
|---|---|---|
| Создание `{}` | `packages/animastor-vbook-runtime/src/lazy-book/create.js:366-372`; путь — `packages/animastor-vbook-runtime/src/lazy-book/paths.js:15` | на первом окне новой книги, если файла нет |
| Сохранение | `packages/animastor-vbook-runtime/src/index.js:490-494` | всегда пишет `book.behaviors || {}` (пустой объект не удаляется — в отличие от старого поведения, см. `docs:07-agents-and-generators/BEHAVIOR_JSON_LIFECYCLE.md`, §2/§7) |
| Ручной редактор: добавить | `packages/animastor-editor/src/entity-crud-routes.cjs:297-334` | `POST /book/:id/behaviors`, только для существующего `character_id`; сеет `{baseline}`; 409 на дубль |
| Ручной редактор: правка | `packages/animastor-editor/src/editor-routes.cjs:705-736` | `PATCH /book/:id/behaviors/:characterId`, `setDeep` с passthrough; **dirty-scene propagation нет** — «behavior does not participate in generation/runtime yet» (`:700-703`) |
| Ручной редактор: удаление | `entity-crud-routes.cjs:336-355`, каскад при удалении персонажа `:158-164` | `DELETE` |
| AI-ассистент | `packages/animastor-assistant/src/chat-engine.cjs:41,49-78,292-305` | в edit-режиме описан контракт Behavior и путь `/behaviors/{character_id}`; пишет через `edit_book` → `applyPatchesValidated` → `saveBookBundle` |
| UI web | `web:frontends/app/src/pages/EditPage.tsx:55,64,1318-1350`; схема карточки — `web:packages/animastor-web-editor/src/entityEditor.tsx:95-103` | вкладка «Поведение» (7-я), `baseline` в карточке, `quirks`/`reactions` — построчным текстом |
| UI Android | `and:frontends/android/app/src/main/java/com/example/animastor/ui/EditFragment.kt:78,131-133,751,880-881`; модель — `repository/BookModels.kt` | те же правила, ключи `behaviors` перебираются как карточки |
| Чтение генерацией | — | **ни одного обращения**: grep `behaviors` по `backend/src/image`, `backend/src/video`, `backend/src/audio`, `backend/src/workflows`, `backend/src/orchestration-v2` — 0 совпадений |

История (backend, `git log -S"behavior.json"`):

- `d690e35` (2026-08-31) — фундамент: manual Behavior editor + `behavior.json`, «behavior does not participate in generation/runtime yet».
- `7168a5b` — schema v2 (`baseline/quirks/reactions`).
- `8def086` — v2.1, удалено legacy-поле `instruction`.
- `8ee4976` (2026-09-01) — создание `{}` при создании книги + знание о Behavior в промпте AI-ассистента + `edit_book`.
- `d1a8ec2` — исследовательский отчёт `docs:07-agents-and-generators/BEHAVIOR_JSON_LIFECYCLE.md` (на момент отчёта файл ещё не создавался кодом; с `8ee4976` это устарело).

### 1.4 Чем отличается от остальных JSON рядом

| Файл | Смысл | Кто пишет в пайплайне | Кто читает при генерации |
|---|---|---|---|
| `book.json` | мета, структура глав, `layer_config` | `create.js`, `bootstrap.js:140-150`, `layer-config.js:140-190` | структура, язык, render-настройки |
| `characters.json` | идентичность + `passport` (appearance/clothes/video_tokens) | `packages/animastor-vbook-runtime/src/lazy-book/create.js`, `appendToBook` | `prompt-builder.js:69-122`, `video-workflows.js:106-110` |
| `bible.json` | мир: `country`, `epoch`, `render_rules` | `packages/animastor-vbook-runtime/src/lazy-book/create.js:362-364` | `prompt-builder.js:253-260` (style/lighting), `video-workflows` |
| `locations.json` | локации + `environment` | `packages/animastor-vbook-runtime/src/lazy-book/create.js`, merge в `pipeline-runner.js:520-555` | `prompt-builder.js:280-299` |
| `voices.json` | TTS-инструкция на голос | `packages/animastor-vbook-runtime/src/lazy-book/create.js:350-359` | `backend/src/audio/generation.js:73-75`, `audio/segments.js:57-60` |
| `behavior.json` | **поведение героя текстом** (baseline/quirks/reactions), необязательное обогащение | редактор / AI-ассистент | **никто** |

Ключевое отличие: остальные файлы — creation-time сущности, из которых пайплайн строит промпты; `behavior.json` — enrichment, который существует параллельно и в промпты не попадает.

### 1.5 Где ему жить

Шаблон **уже в git**: `backend/ai/examples/behavior.json` — 3 персонажа, у каждого `baseline`, 3 `quirks`, 3 `reactions` (итого 9 «если → то»), English. Он не загружается ни в один промпт и не копируется в книгу; в книге создаётся пустой `{}`.

Предложение (не реализация):

1. **Шаблон по умолчанию — в репозитории** (`backend/ai/rules/behaviour.md` как правила применения + `backend/ai/examples/behaviour-rules.json` как библиотека правил). Причина: обновляется с кодом, один для всех книг, не дрейфует по копиям.
2. **Правила книги — в `data/books/<id>/behavior.json`** (или v2-файл рядом), потому что поведение героя — авторский контент, оно уже входит в `.vbook`-бандл (`packages/animastor-vbook-runtime/src/index.js:16`, `packages/animastor-vbook-runtime/src/index.js:62`) и уже редактируется в web/Android. Копировать шаблон в каждую книгу не нужно: эффективные правила = дефолты репо, перекрытые правилами книги.
3. Общая библиотека на несколько книг (если появится) — позже в PG, не в этом этапе.

---

## 2. Карта пайплайна VBook

### 2.1 Оболочка: окна

- Точка входа: `bootstrapWithAgent` — `backend/src/services/agent/bootstrap.js:51`; следующее окно — `bootstrapNextWindow` `:333`, внутренняя `_bootstrapNextWindowInner` `:357`.
- Окно текста: `pipeline-runner.getWindowText` — `backend/src/services/agent/pipeline-runner.js:106`; размер окна из `chunk_size` (1–5, дефолт 3) — `backend/src/services/layer-config.js:61,96-100`, `agent-prompts.js:53-58`.
- Один клик пользователя = **одно окно**; после окна сессия `paused`, при исчерпании текста — `completed` (`bootstrap.js:735-760`).
- Дедуп/защита от отката: `bootstrap.js:452-470` (offset), `:636-647` (повторный offset).
- Фоновый цикл окон (альтернативный триггер): `backend/src/services/window-generator.cjs:38-55`.
- Сохранение книги: `lazyBook.createFromAnalysis` / `appendToBook` (`bootstrap.js:230-250`, `bootstrap.js:716-726`) — то есть JSON пишется **после** всех LLM-шагов окна.

### 2.2 Этапы по порядку

Обозначения: «промпт» — файл правил из `backend/ai/`; подстановки — `%…%`; модель — см. §2.3. Все шаги вызываются из `runPipeline` (`pipeline-runner.js:287`); шаги 5–13 продублированы в `processCachedScenes` (`:1016`).

| # | Этап | Модуль / вызов | Вход | Выход (JSON) | Промпт и подстановки | Валидация / ретраи / ошибки |
|---|---|---|---|---|---|---|
| 0 | Структура | `backend/src/services/agent/pipeline-steps.js:194` → `@animastor/ai-analysis` (`tasks/structure-analyzer/index.js:45`) | `source.txt` | `book.json`: title, author, language, parts, segments; карта глав | `rules/structure.md`; `%SOURCE_TEXT%` + кандидаты детерминированного детектора | сначала детерминированный `structure-detector-deterministic`, LLM только merge; sanitize + якорная проверка (коммит `43891c1`); ошибка → падение окна |
| 1 | Персонажи | `stepExtractCharacters:220` (`tasks/character-analyzer/index.js:24`) | текст окна, `language` | `characters[]` → `characters.json`; `mentions` | `rules/characters.md`; `%WINDOW_TEXT%`, `%LANGUAGE%` | `mergeCharacterLists` + фильтр placeholder (`pipeline-runner.js:460-483`); пустой ответ = «нет данных», не «unknown» (`d2cca7e`) |
| 2 | Голоса | `stepGenerateVoices:318` (`character-analyzer/voices.js:39`) | текст окна, персонажи | `characters[i].voice.instruction` → `voices.json` | `rules/voice_generation.md` | пропуск уже озвученных; ошибка не валит окно (`voices.js`), запись — `packages/animastor-vbook-runtime/src/lazy-book/create.js:350-359` |
| 3 | Локации | `stepExtractLocations:243` (`tasks/locations.js:23`) | текст окна, персонажи | `locations.json` (`description`, `environment`) | `rules/locations.md` | `sanitizeEnvironment` (placeholder-поля выкидываются, `pipeline-runner.js:525-545`); ошибка → остаётся прежний набор |
| 4 | Сцены | `stepCreateScenes:266` (`tasks/scenes.js:46`) | текст окна, персонажи, локации, `country/epoch` | сцены: `title/type/location/participants/style/audio.full_text` | `rules/scenes.md`; `%BOOK_DEFAULT%` | coverage-валидация `source-coverage`; 1 ретрай с `repairHint`; затем детерминированный `textUtils.buildFallbackScenes`; пустой ответ → throw (`pipeline-runner.js:617-651`) |
| 5 | IU | `stepCreateUnits:293` (`tasks/units.js:26`) | сцена, персонажи, `mentions` | `units[]`: `text/type/audio{text,speaker}` | `rules/units.md`; `%SCENE_TEXT%`, `%EXISTING_CHARACTERS%` | verbatim-текст, один речевой ход = один IU; ошибка → один fallback-IU (`units.js:onError`) |
| 6 | Длинные IU | `splitLongUnits` (`unit-splitter.js:1-20`) | IU | IU (больше, короче) | `rules/unit_splitter.md` (через `SYSTEM_PROMPTS`) | порог 20 с; 2 ретрая; аварийное дробление по предложению/запятой/символу |
| 7 | Визуалы | `stepCreateVisuals:828` (в `pipeline-steps.js`, не в пакете) | сцена, IU, персонажи (только id+имя), локации, следующая сцена, `mentions` | `unit.image{shot,prompt,style,negative}`, `unit.video.action` | `rules/visuals.md` + skills профилей (`skills/image/*`, `skills/video/*`); `%CONTEXT%`, `%EXAMPLES%`, `%UNITS%` | `normalizeCharacterRefs`; fallback `imageUtils.getFallbackImage` при ошибке; `aiCaller` ретраит 3× |
| 8 | Сверка паспортов | `stepReconcilePassports:401` | все IU окна, персонажи, сцены | правит `image.prompt/shot`, `video.action`; `scene.passport[id].video_tokens` | `rules/passport_reconciliation.md` | пропуск prompt > 2000 симв. (`agent-prompts.js:69`); `applySceneVideoTokens` пишет только отличия (`pipeline-runner.js:80-104`) |
| 9 | Сверка видео | `stepReconcileVideoActions:502` | все IU | `video.action` | `rules/video_action_reconciliation.md` | детерминированный `needsVideoActionReconciliation` (static copy/empty), иначе без вызова |
| 10 | Полировка сториборда | `stepPolishStoryboard:598` | все IU ≥ 2, персонажи, локации | `image.prompt/shot`, `video.action` | `rules/storyboard_polish.md` | пропуск при < 2 IU; out-of-format prompt не трогается |
| 11 | Полировка видео | `stepPolishVideoActions:730` | все IU ≥ 2 | `video.action` | `rules/video_action_polish.md` | то же |
| 12 | Финальный свип | `pipeline-runner.js:963-976` | все IU | `video.action` | тот же шаг 9 | только если остались static copy/empty |
| 13 | Починка fantasy id | `stepRepairFantasyIds:1238` | все IU, персонажи, локации | `image.prompt`, `video.action`, `audio.speaker` | `rules/fantasy_snake_repair.md` | детект `snake-guard` детерминированный, LLM только пересборка; полный revert при неполном ответе |
| 14 | Сохранение | `lazy-book/create.js` / `appendToBook` | результат окна | `chapters/ch-*.json`, `characters.json`, `locations.json`, `voices.json`, `bible.json`, `behavior.json`, `book.json` | — | запись после всех шагов; `manifest.updated_at` |

### 2.3 Модель, провайдер, ретраи

- Транспорт один: `backend/src/services/agent/ai-caller.js:30-53`. Провайдер берётся из `AsyncLocalStorage` (`runWithProvider`, `:20-25`), модель — `provider.model` → `OPENROUTER_MODEL` → `qwen/qwen3.5-122b-a10b` (`:32-37`).
- Ретраи: `STEP_RETRIES = 3` (`agent-prompts.js:21`), линейная пауза 2 с × попытку (`ai-caller.js:39-49`); JSON парсится `aiService.parseJsonResponse` (`:47`).
- Все диалоги пишутся в PG (`agent_conversations` / `agent_messages`, `ai-caller.js:56-77`) — это единственное место, где видно фактический промпт.
- Профили промптов (image/video/audio) — `backend/src/services/prompt-profile-loader.js`, скиллы добавляются в `visuals` (`pipeline-steps.js:897-907`).

### 2.4 Схема потока данных

```
source.txt
   │  getWindowText (окно ≤ chunk_size сцен)
   ▼
structure ──► book.json (title/author/parts/segments)
   ▼
characters ─┬─► characters.json ──► passport ──► final image prompt / video tokens
            └─► mentions
voices ─────► voices.json + characters[].voice ──► TTS instruction
locations ──► locations.json ──► environment ──► image prompt
   ▼
scenes ──► scene{title,type,location,participants,audio.full_text}
   ▼
units ──► unit{text,type,audio{speaker,text}}
   ▼
visuals ──► unit.image{shot,prompt,style,negative} + unit.video.action
   ▼
passport reconcile ──► image.prompt/shot, video.action, scene.passport.video_tokens
   ▼
video reconcile ──► video.action
   ▼
storyboard polish ──► image.prompt/shot + video.action
   ▼
video polish ──► video.action
   ▼
final sweep + fantasy repair ──► image.prompt / video.action / audio.speaker
   ▼
create.js / appendToBook ──► chapters/ch-*.json (+ characters/locations/voices/bible/behavior)
   ▼
buildImagePrompt (prompt-builder) ──► workflow ComfyUI (image) ──► part_hash
video-workflows (LTX) ──► storyboard-строки ──► video job
audio/generation ──► voice.instruction + unit.audio.text ──► TTS job
```

---

## 3. Запуск из фронта

### 3.1 Web

- Кнопки: «Генерировать VBook» / «Генерировать VBook далее» (`web:frontends/app/src/app/i18n.ts:749-751`), секция «Агенты VBook: {N}» (`web:frontends/app/src/app/i18n.ts:745`, `web:frontends/app/src/pages/GeneratePage.tsx:389-404`). Текст кнопки переключается на «далее», если в книге уже есть контент (`web:frontends/app/src/pages/GeneratePage.tsx:306`).
- Домен выбора bootstrap vs next-window: `web:packages/animastor-web-generator-vbook/src/index.ts:341-380` — сначала `GET /book/:id/status` (`ready`), затем `POST /book/:id/bootstrap` (`:375`) или `POST /book/:id/bootstrap-next-window` (`:377`), длинные POST не кэшируются (`web:frontends/app/src/api/client.ts:8,85-86,132`).
- Прогресс: SSE `GET /book/:id/progress-stream` (`web:frontends/app/src/state/generateStore.ts:565-600`) + поллинг `GET /book/:id/agent-status` каждые 1.5 с (`GeneratePage`/`web:frontends/app/src/state/generateStore.ts:513-520`); сообщения стадий — таблица `progress_vbook_stage_*` (`web:frontends/app/src/app/i18n.ts:745-760`), источник — `PROGRESS_STAGES` (`agent-prompts.js:5-18`).

### 3.2 Android

- `startVBookGeneration` — `and:ui/GenerateViewModel.kt:714-785`: `getLazyBookStatus` → `bootstrapBook` или `bootstrapNextWindow`, затем `pollVBookProgress`.
- Эндпоинты — `and:repository/BackendApi.kt:442-455` (`/bootstrap`, `/bootstrap-next-window`, `/agent-status`).
- Прогресс: SSE + поллинг `/agent-status` (`and:ui/GenerateViewModel.kt:793-880`), подписи — `resolveVBookStageLabel` (`and:ui/GenerateFragment.kt:947-965`), строки `progress_vbook_stage_*` в `res/values/strings.xml` и `values-ru`.
- Enum стадий: `VBookStage` (`and:ui/GenerateViewModel.kt:2288-2297`) — 4 значения; детализация идёт через `step_type`/`stage` строки, а не через enum.

### 3.3 Переключатель «Агенты VBook» в layer-config

- Web: `vbookEnabled` — `web:frontends/app/src/state/generateStore.ts:310`; сеттер и PUT — `:343,358`; чтение из ответа — `:372`; тумблер в секции — `web:frontends/app/src/pages/GeneratePage.tsx:389-394`; тип ответа требует `vbook_enabled: boolean` (`web:frontends/app/src/api/models.ts:592-605`).
- Android: `setVBookEnabled` — `and:ui/GenerateViewModel.kt:430-433`, чтение — `and:ui/GenerateViewModel.kt:463-476`, запись — `and:ui/GenerateViewModel.kt:511`; модель `LayerConfig.vbook_enabled` с дефолтом `true` (`and:repository/LayerConfig.kt:8`).
- **Бэкенд это поле не знает**: `GET /layer-config` возвращает только audio/image/video/chunk_size/timeouts/analysis (`backend/src/routes/book/generation-routes.cjs:108-133`), `PUT` принимает тот же набор и молча игнорирует `vbook_enabled` (`:137-145`); в `layer-config.js` поля нет (`normalize`, `:80-104`). В книге `data:book.json` `layer_config` тоже без него.
- Следствие: тумблер «Агенты VBook» — **локальный UI-флаг**, сервером не сохраняется. В web после `loadLayerConfig` поле становится `undefined` (в ответе его нет), в Android — дефолт модели; фактическое поведение после перезагрузки зависит от рантайма и паритетом не гарантировано. Для встраивания поведений это важно: отдельный серверный флаг (например, `behaviour_enabled`) сейчас некуда положить без правки контракта layer-config.

### 3.4 Соотношение с orch v2 (§11, слой vbook, задача H)

- ADR: `docs:architecture/ORCHESTRATION_V2.md:340-362` — целевые эндпоинты `generate/stop/progress/stream`, `layers: audio|image|video`, «на этапе 3 добавляется `vbook` (задача H: VBook-окно как ступень той же команды; `bootstrap`/`bootstrap-next-window` становятся внутренними)».
- Факт в коде: `gen_commands.layers <@ ARRAY['audio','image','video']` (`packages/animastor-orchestration/src/gen/sql/001-gen-core.js:61-62`) и `gen_jobs.layer IN ('audio','image','video')` (`packages/animastor-orchestration/src/gen/sql/002-command-jobs.js:39-40`). Слоя `vbook` нет; VBook по-прежнему живёт на `POST /book/:id/bootstrap*` (`backend/src/routes/book/import-routes.cjs:722,738`).
- Вывод: встраивание поведений сейчас должно проектироваться под **legacy VBook-путь** (`bootstrap` + `pipeline-runner`), а не под команды orch v2; при переносе в слой `vbook` (этап 3) правило матчинга переедет вместе с окном, но хранилище (`behavior.json` + `unit.behaviour`) останется тем же.

---

## 4. Поля, на которые повлияют поведения, и кто их читает

| Поле | Где рождается | Кто читает | Как влияет на GPU |
|---|---|---|---|
| `unit.image.prompt` | шаг 7, правят 8/10/13 | `backend/src/image/prompt-builder.js:300` (секция `directPrompt`, `:272-274`) → `backend/src/image/iu-processor.js:186-204` | входит в workflow изображения → `part_hash` |
| `unit.image.shot` | шаг 7 | `backend/src/image/prompt-builder.js:128-137` | строка «medium shot» в финальном промпте → `part_hash` |
| `unit.image.style` / `negative` | шаг 7 | `resolveVisualStyle:151`, `resolveNegativePrompt:139` | style/negative в workflow → `part_hash` |
| `unit.video.action` | шаги 7, 8, 9, 10, 11, 12, 13 | `backend/src/workflows/video/video-workflows.js:233-296`: строка сториборда, `actionText = unit.video.action`, `anchorGroupRefs` (`:152-184`) | LTX: движение/жесты; **не** входит в image workflow |
| `unit.audio.text/speaker` | шаг 5 | `backend/src/audio/generation.js:58-110`, `audio/segments.js:57-60` | TTS: текст + чей голос |
| `voices[id].instruction` | шаг 2 + редактор | `audio/generation.js:73-75`, `segments.js:57-60` | **единственная** «эмоция» для TTS — глобальная на голос, не на IU |
| `characters[id].passport.appearance/clothes` | шаг 1 + редактор | `backend/src/image/prompt-builder.js:41-52`, `backend/src/image/prompt-builder.js:54-59`, `backend/src/image/prompt-builder.js:69-122` | инжектится блоком персонажа в каждый промпт → `part_hash` всех сцен с героем |
| `characters[id].passport.video_tokens` | шаг 1/8 | `video-workflows.js:75-110` | якоря идентичности в видео |
| `scene.state[id]` | **никто** (только чтение, `prompt-builder.js:61-66`; registry `prompt-dependency-registry.js:143`) | `buildCharacters` → строка состояния героя | свободный слот для per-scene поведения, но см. §5 |

Важно: **отдельного поля эмоции IU нет** ни в image, ни в video, ни в audio. `visuals.md` просит агента писать «new action, gesture, emotion» внутрь `image.prompt` (`backend/ai/rules/visuals.md:42`), `video_action_polish.md` говорит об «emotional progression» (`:16-17,44`), но это текст промпта, а не структура. Поэтому «эмоция» как условие матчинга должна выводиться из текста IU/типа/участников, а не читаться из поля.

---

## 5. Хранение данных книги, версионирование, инвалидация

### 5.1 Что источник правды

- **Контент книги — файлы** `/home/animastor/data/books/<id>/` (`manifest.json`, `book.json`, `chapters/*.json`, `characters.json`, `locations.json`, `voices.json`, `bible.json`, `behavior.json`). Это контракт хранения (`packages/animastor-vbook-runtime/src/index.js:10-22`), запись — `saveBookBundle` (`packages/animastor-vbook-runtime/src/index.js:470-500`), чтение — `loadBookFromDir` (`packages/animastor-vbook-runtime/src/index.js:600-645`).
- **`.vbook` — zip каталога книги**, не отдельный формат: `backend/src/routes/book/export-routes.cjs:52-64`; импорт распаковывает и пишет те же файлы (`import-routes.cjs:264,459`).
- **PG — реестр и производное состояние**, а не источник контента: `books` (`backend/src/storage/postgres/schema.js:139-152`), `scenes` (`:165-182`), `asset_states` (`:184-196`), `scene_assets`, `iu_image_pointers`, `gen_commands/gen_jobs`, `agent_sessions/agent_steps`, `book_snapshots`. Синхронизация «файлы → PG» описана как аудитор/деривация: `backend/src/services/book-sync.js:1-20`.
- Рецепт/настройки генерации: `layer_config` дублируется в `book.json` как durable-копия, Redis — рабочая копия (`backend/src/services/layer-config.js:16-30`). Отдельного «рецепта книги» в data/books нет.

### 5.2 Версионирование

- `manifest.vbook_version = 3.1`, `manifest.build_id`, `created_at/updated_at` (`data:manifest.json`; запись — `create.js`/`updateBookState`).
- `book.json.version = 3.0`, `updated_at`, `layer_config.updated_at`.
- PG: `book_snapshots` (версии снимков, `schema.js:154-163`), `scenes.content_version` (бампается при изменении текста/юнитов, `schema.js:815-821`), `scene_assets.scene_content_version` и эндпоинт расхождений `versions-routes.cjs:31-83`.
- Redis: быстрые ключи состояния сцен/ассетов; не версия контента.
- `part_hash`/`scene_hash` orch v2 — **хеши контента**, не версии: `image-ports.js:19-21`.

### 5.3 part_hash / content_version: что инвалидируется

- `part_hash = 'iu-v2:' + sha256(workflow_json).slice(0,32)` — хешируется **весь JSON workflow изображения** (`image-ports.js:66-70`), то есть финальный промпт (core + passport + shot + style + lighting/env), negative, seed/size/steps/LoRA шаблона. Любое изменение любого слагаемого → новый `part_hash` → IU считается неготовым и перегенерируется.
- `scene_hash = 'image-v2:' + sha256(unit_key:part_hash …)` (`image-ports.js:73-74`); сцена готова, когда все части на месте (`:86-88`).
- Legacy-путь: `content_version` + Prompt Dependency Registry (`packages/animastor-generation/src/dirty-grammar/prompt-dependency-registry.js`). Явные зависимости:
  - `unit.image` изменился → `image` + `video` (видео зависит от картинки), `prompt-dependency-registry.js:375-379`;
  - `unit.video` изменился → только `video`, `:381-384`;
  - `unit.audio` / `unit.type` → только `audio`, `:367-374`;
  - `scene.state`, `scene.passport`, `characters.passport`, `bible.locations`, `book.voices` — соответствующие слои (`:143-155`, `:176-194`, `:217-245`);
  - **неизвестное поле юнита → все три слоя dirty** (`:392-400`). Это прямой риск для нового `unit.behaviour`: без явной записи в registry любой повторный diff пометит image+video+audio.

Практический вывод для поведений:

| Куда писать поведение | Что инвалидируется | Комментарий |
|---|---|---|
| внутрь `image.prompt` | картинка IU + видео (через image) | новый `part_hash`; готовые картинки BA перегенерируются |
| внутрь `video.action` | только видео (legacy), картинки не трогаются | дешевле |
| в `passport.appearance/clothes` | картинки **всех** сцен с героем + видео | самый дорогой вариант |
| в `scene.state[id]` | image+video сцены (registry `:143`) | уже учитывается, но поле пустое |
| в новое `unit.behaviour` | сейчас — **все слои** (catch-all) | нужно добавить поле в registry; иначе массовая инвалидация |

---

## 6. Как добавлялись прошлые этапы (шаблон «новый этап»)

Единого реестра этапов нет; этап — это согласованный набор из 6–8 мест:

1. **Правило промпта**: новый `backend/ai/rules/<stage>.md` + регистрация в списке `RULES` (`agent-prompts.js:77-90`; иначе `SYSTEM_PROMPTS[name]` пуст).
2. **Функция шага**: либо host-адаптер в `backend/src/services/agent/pipeline-steps.js` (визуалы/сверки), либо task-объект в `packages/animastor-ai-analysis/src/tasks/*` с полями `requiredPorts`, `stage`, `stepType`, `buildMessages`, `normalize`, `onError` (пример `packages/animastor-ai-analysis/src/tasks/units.js:22-95`).
3. **Вызов в раннере**: `pipeline-runner.js` — **в двух местах**: `runPipeline` (`:696-993`) и `processCachedScenes` (`:1103-1282`). Пропуск второго места — типичная ошибка (в кэш-пути шаг просто не выполнится).
4. **`step_type` для PG**: добавить в `agent_steps_step_type_check` (`schema.js:887-900`) — иначе INSERT упадёт на CHECK и окно умрёт; это ловит тест `backend/tests/pipeline-step-types.test.js:1-45`.
5. **Прогресс**: строка в `PROGRESS_STAGES` (`agent-prompts.js:5-18`), ключ `progress_vbook_stage_*` в web (`web:i18n.ts:745-760`) и Android (`strings.xml` + `and:ui/GenerateFragment.kt:947-965`). Enum `VBookStage` расширять не обязательно, если используется `step_type`.
6. **Знание ассистента** (если этап меняет схему книги): промпт в `packages/animastor-assistant/src/chat-engine.cjs:41-78`.
7. **Тесты**: unit на функцию шага + регресс на раннер (примеры: `backend/tests/video-action-reconciliation.test.js`, `pipeline-runner-parallel.test.js`, `visuals-duration.test.js`).
8. **Доки/CHANGELOG** в `animastor-docs` (`docs:CHANGELOG.md`).

Примеры коммитов: `e3bd626` (video.action reconciliation — 4 файла: правило, раннер, шаги, тест), `4bf1852` (video_tokens — правило + раннер + шаги + registry + video-workflows + 3 теста + доки). Оба — «аддитивный этап без нового HTTP-контракта».

---

## 7. Предлагаемая схема behaviour.json v2 (сила/вероятность)

Не реализовано; предложение. Совместимо с текущим контрактом «map character_id → объект» и schema-tolerant passthrough.

```json
{
  "schema_version": 2,
  "defaults": {
    "probability": 0.35,
    "cooldown_iu": 4,
    "max_per_unit": 1
  },
  "rules": [
    {
      "id": "embarrassed_blush",
      "scope": "global",                  // global | character
      "character_id": null,               // задан при scope=character
      "when": {
        "emotion": ["embarrassed", "shy"],
        "triggers": ["смутил", "покраснел", "пристыдил"],
        "participants": ["yura", "svetlana"],
        "unit_type": ["dialogue", "action", "perception"]
      },
      "then": {
        "image": "blushes, looks away, ears reddening",
        "action": "turns her head aside, cheeks flushing",
        "audio_emotion": "embarrassed, quieter"
      },
      "strength": 0.7,                    // 0..1 — насколько ЯРКО применять
      "probability": 0.8,                 // 0..1 — шанс срабатывания
      "cooldown_iu": 5,                   // не чаще раза в N IU
      "once_per_scene": true,
      "priority": 10                      // конфликты: больше = важнее
    }
  ],
  "yura": { "baseline": "…", "quirks": ["…"], "reactions": [{"trigger": "…", "reaction": "…"}] },
  "svetlana": { "baseline": "…", "quirks": ["…"], "reactions": [] }
}
```

Семантика полей:

| Поле | Смысл | Ограничения |
|---|---|---|
| `scope` | общее правило или черта конкретного героя | `character` требует существующего `character_id` (как POST /behaviors сегодня) |
| `when.emotion` | эмоция/состояние героя (нормализованный словарь, EN) | выводится матчером из текста/типа, не хранится в IU |
| `when.triggers` | слова/леммы в тексте IU (язык книги) | регистронезависимо, по границам слов |
| `when.participants` | ограничение по участникам сцены | подмножество `scene.participants` |
| `when.unit_type` | типы IU | `dialogue`/`action`/… |
| `then.image` / `then.action` | готовые EN-фразы для промпта/движения | ≤ 120 символов, без passport-деталей |
| `then.audio_emotion` | подсказка для TTS | сейчас некуда положить (нет per-IU поля) — только будущее |
| `strength` 0..1 | интенсивность формулировки и вес при конфликте | 0 = правило выключено |
| `probability` 0..1 | шанс срабатывания | детерминированно через seed (ниже) |
| `cooldown_iu` | минимум IU между срабатываниями правила | считается в пределах книги (или сцены — открытый вопрос) |
| `priority` | разрешение конфликтов «одно поведение на IU» | при равенстве — лексикографически по `id` |

Воспроизводимость:

```
seed01 = sha256(`${book_id}:${rule.id}:${unit.id}`).readUInt32BE(0) / 2**32
fire   = seed01 < rule.probability * rule.strength_scale
```

- Никакого `Math.random`; seed только от стабильных id (book + rule + unit). Повторный прогон на тех же данных даёт тот же набор.
- Cooldown считается одним детерминированным проходом по IU в порядке `(chapter_index, scene_order, unit_order)`; при повторном прогоне результат тот же. Состояние (last fired) не хранится — пересчитывается.
- Порядок применения: `priority` desc → `id` asc; по умолчанию `max_per_unit = 1`.
- Миграция: если в файле нет `schema_version` и нет `rules`, верхнеуровневые ключи трактуются как character-записи v2.1 (текущий формат). Новые ключи `schema_version`/`rules`/`defaults` должны **пропускаться** редактором, который сегодня перебирает все ключи `behaviors` как карточки (`web:pages/EditPage.tsx:1336`, `and:ui/EditFragment.kt:751`) — иначе появятся фальшивые «персонажи».

---

## 8. Варианты встраивания

### 8.1 A — отдельный этап после разбивки на IU

Агент проходит IU сцены, находит совпадения и дописывает поведение в `image.prompt` / `video.action`.

- **Модуль**: новый `stepApplyBehaviours` в `pipeline-steps.js` + правило `behaviour.md` + `step_type` + строка прогресса (полный шаблон §6, включая второй путь `processCachedScenes`).
- **Результат**: сразу в промптах (проще всего для потребителей), либо в `unit.behaviour[]` для трассируемости.
- **Правки автора**: перезапись промпта затрёт ручные правки; нужен lock/override и проверка «промпт не менялся вручную» (аналог `inPromptRange`).
- **Идемпотентность**: LLM стохастичен; при повторном прогоне промпт может отличаться → новый `part_hash` → перегенерация.
- **Инвалидация**: `image.prompt` → image+video; полный прогон BA перерисует все 32 IU.
- **Стоимость**: 17 вызовов (по сцене), ~1.3–1.8k входа на вызов → **≈22–30k входных, ≈2–3k выходных** токенов на BA.
- **Паритет**: новый этап = 3 места прогресса + 2 пути раннера; web/Android правок почти не требуют, кроме строки стадии.

### 8.2 B — правила как контекст в существующем промпте IU

Без нового этапа: в `visuals.md`/`%CONTEXT%` добавляется блок правил, агент применяет сам.

- **Модуль**: только `backend/src/services/agent/pipeline-steps.js:828` (сборка `contextStr`) + правило.
- **Результат**: в промптах; трассируемости нет (нельзя сказать, какое правило сработало).
- **Правки автора**: тот же риск, но перезапись идёт в том же шаге, где промпт и так генерируется; повторный прогон всё равно меняет текст.
- **Идемпотентность**: нет; поведение зависит от стохастики и от того, как агент «понял» правила.
- **Инвалидация**: image+video, но только для новых/перегенерируемых IU.
- **Стоимость**: +~500–700 токенов контекста на каждый вызов visuals (17) → **≈9–12k входа**, 0 дополнительных вызовов/выхода.
- **Паритет**: тривиален. Главный минус — неуправляемость и «однообразие по воле модели».

### 8.3 C — детерминированный матчинг + LLM только для формулировки

Код находит совпадения (эмоция/ситуация/участники) и решает по strength/probability/cooldown; LLM формулирует фразу.

- **Модуль**: чистый матчер (новый модуль в `backend/src/services/agent/` или `@animastor/generation`), вызов из раннера перед visuals; формулировка — либо отдельным батч-вызовом на сцену, либо внутри существующего visuals (транспорт B).
- **Результат**: `unit.behaviour[]` (`rule_id`, `strength`, `seed`) + готовые фразы; в промпт попадают фразы, id правил остаются для аудита.
- **Правки автора**: `unit.behaviour_locked` / `source:"author"` — матчер пропускает IU; lock ставится редактором при ручной правке.
- **Идемпотентность**: да, если seed от id и cooldown пересчитывается; LLM-формулировка может отличаться, поэтому фразы лучше хранить/переиспользовать (skip при совпадении набора правил, как `applySceneVideoTokens`).
- **Инвалидация**: image+video; при хранении только `unit.behaviour` — пока не добавлено в registry, все слои (см. §5.3).
- **Стоимость**: матчинг 0 токенов; формулировка — ~8–10 батч-вызовов (по сценам с совпадениями) → **≈8–12k входа / ≈1k выхода**; при полностью детерминированных фразах из `then.*` — **0**.
- **Паритет**: правила и матчер — серверные; фронты не меняются, кроме отображения поля в редакторе (опционально).

### 8.4 D — поведение как часть passport + общие правила

Индивидуальные привычки героя — в `characters[id].passport`, общие правила — из `behaviour.json`.

- **Модуль**: `characters.md`/`passport_reconciliation.md` (формирование), `prompt-builder` (уже инжектит паспорт) — почти без кода.
- **Результат**: в паспорте (текст), общие правила — в промпте (как B).
- **Правки автора**: паспорт правится в редакторе; перезапись пайплайном — тот же риск, но паспорт уже имеет scene-override механизм (`resolvePassport:41-52`).
- **Идемпотентность**: нет (LLM).
- **Инвалидация**: `characters.passport` → картинки+видео **всех** сцен героя — самый дорогой вариант; на BA это все сцены с yura/svetlana.
- **Стоимость**: 0 дополнительных вызовов, но +30–60 токенов паспорта на каждый промпт; главное — массовая перегенерация.
- **Паритет**: паспорт уже есть в обоих фронтах; менять нечего.

### 8.5 Сводное сравнение и стоимость на BA

Факты BA (`data:chapters/*.json`): **17 сцен** (включая обложку), **32 IU**, 3 736 символов текста IU, 6 150 символов `image.prompt`, 6 071 символ `video.action`, 2 персонажа с паспортом (487 символов appearance), исходник 5 434 символа, `chunk_size = 3`, включён только image (`data:book.json`).

| Критерий | A (этап) | B (контекст) | C (матчинг) | D (passport) |
|---|---|---|---|---|
| Где хранить результат | промпт; опц. `unit.behaviour` | промпт | `unit.behaviour[]` + фразы | passport |
| Трассируемость правила | средняя | нет | **высокая** (rule_id/seed) | низкая |
| Сохранение правок автора | нужен lock | нужен lock | lock по IU | scene-override/lock |
| Идемпотентность повторного прогона | нет | нет | **да** (seed; фразы кэшируются) | нет |
| Инвалидация | image+video всех IU | image+video | image+video (после registry) | image+video всех сцен героя |
| Новые вызовы LLM на BA | 17 | 0 | 0 (или 8–10) | 0 |
| Токены на BA (вход/выход) | ≈22–30k / 2–3k | ≈9–12k / 0 | **0** (или ≈8–12k / 1k) | ≈0 / 0, но перерисовка |
| Правки фронтов | строка стадии | нет | нет (опц. поле в редакторе) | нет |
| Риск «однообразия» | средний | высокий | низкий (cooldown/priority) | высокий (паспорт статичен) |

Токены — оценка: инструкция 900–1200 + контекст сцены ~100 + IU ~200 + правила ~600 на вызов; 4 символа/токен для EN, ~3 для RU. Замер не выполнялся.

---

## 9. Рекомендация

**C как основа + B как транспорт формулировки.** Конкретно:

1. **Матчинг — детерминированный, в коде** (не LLM): правила из `behavior.json` v2, условия по эмоции/триггерам/участникам/типу IU, выбор по `strength → probability` с seed от `book_id:rule_id:unit_id`, cooldown одним проходом по книге.
2. **Формулировка — внутри существующего шага `visuals`**: матчер передаёт в `%CONTEXT%` короткий «behaviour brief» (rule_id + EN-фраза + intensity), агент вписывает её в `image.prompt`/`video.action` естественным языком. Нового этапа, нового `step_type` и новых строк прогресса нет — это снимает половину правок и весь риск расхождения двух путей раннера.
3. **Результат — `unit.behaviour = [{rule_id, strength, seed}]`** (пишет хост, не LLM) + фразы в промптах. Поле нужно добавить в `prompt-dependency-registry` с явными слоями `image`+`video`, иначе catch-all пометит всё.
4. **Правила — `behavior.json` v2** (общие `rules` + per-character `baseline/quirks/reactions`), шаблон по умолчанию — в репозитории (`backend/ai/examples/behaviour-rules.json`), книга только перекрывает.
5. **Авторский lock**: `unit.behaviour_locked` (и/или `source:"author"`), выставляется редактором при ручной правке IU; матчер такие IU пропускает.
6. **Фаза 0 (дешёвый прототип)**: тот же матчер, но фразы берутся только из `then.image`/`then.action` без LLM — 0 токенов и полная воспроизводимость. Это позволяет проверить педагогику правил до того, как платить за формулировку.

Почему не A: новый этап = 2 пути раннера, `step_type`, 3 места строк прогресса, 17 дополнительных вызовов и полная перерисовка BA; выигрыш по качеству сомнителен, потому что формулировка всё равно уходит в тот же visuals.
Почему не B в чистом виде: нет трассируемости, нет управления частотой, результат зависит от модели — ровно то, чего задача просит избежать («не автоматом», сила/вероятность).
Почему не D как основной: паспорт статичен и его изменение перерисовывает все сцены героя; но D остаётся источником индивидуальных черт (per-character `quirks/reactions`), которые матчер использует как правила `scope:"character"`.

---

## 10. Файлы, которые придётся менять

Без реализации; список для планирования.

### backend (`animastor-backend`)

| Файл | Зачем |
|---|---|
| `packages/animastor-vbook-runtime/src/index.js` | контракт v2 (`schema_version`, `rules`), загрузка/сохранение, миграция v2.1 |
| `packages/animastor-vbook-runtime/src/bundle-validator.cjs` | валидация reserved-ключей и `rules[]` (сейчас только «плоский объект») |
| `packages/animastor-vbook-runtime/src/lazy-book/create.js` | сид `{}`/`{schema_version:2}` на первом окне |
| `packages/animastor-editor/src/entity-crud-routes.cjs`, `editor-routes.cjs` | поля `strength/probability/cooldown`, пропуск reserved-ключей, dirty-propagation при правке правил |
| `packages/animastor-assistant/src/chat-engine.cjs` | схема v2 в промпте ассистента и допустимые пути `edit_book` |
| `backend/src/services/agent/pipeline-runner.js` | вызов матчера до visuals в **обоих** путях (`:696`, `:1103`) |
| `backend/src/services/agent/pipeline-steps.js` | передача behaviour brief в `stepCreateVisuals` (`:828`), запись `unit.behaviour` |
| `backend/src/services/agent/behaviour-matcher.js` (новый) | чистый матчер + seeded RNG + cooldown |
| `backend/ai/rules/visuals.md` | правило «как вписать behaviour brief, не ломая composition/video.action» |
| `backend/ai/rules/behaviour.md` (новый, опц.) | семантика strength/probability/cooldown для ассистента/редактора |
| `backend/ai/examples/behaviour-rules.json` (новый) | шаблон правил по умолчанию |
| `packages/animastor-generation/src/dirty-grammar/prompt-dependency-registry.js` | `unit.behaviour` → image+video; `behaviour.rules` → затронутые сцены |
| `backend/src/image/prompt-builder.js` | (фаза 0) детерминированная секция из `unit.behaviour` |
| `backend/src/workflows/video/video-workflows.js` | (фаза 0) та же секция в storyboard-строке |
| `backend/tests/pipeline-step-types.test.js` + новый тест матчера | если появится `step_type`; детерминизм/cooldown/lock |

### web

`web:frontends/app/src/api/models.ts` (v2-поля), `pages/EditPage.tsx` + `packages/animastor-web-editor/src/entityEditor.tsx` (карточки правил, reserved-ключи), `app/i18n.ts` (подписи), при новом этапе — `progress_vbook_stage_*`.

### Android

`and:repository/BookModels.kt`, `and:ui/EditFragment.kt` (карточки/резервные ключи), `res/values/strings.xml` + `values-ru/strings.xml`, при новом этапе — `and:ui/GenerateFragment.kt:947-965`; при серверном флаге поведения — `and:repository/LayerConfig.kt` + `and:ui/GenerateViewModel.kt`.

### docs

`docs:architecture/ORCHESTRATION_V2.md` (§11/этап 3, если слой vbook будет включать поведения), `docs:CHANGELOG.md`, этот документ.

---

## 11. Риски

1. **Инвалидация готовых картинок/видео.** Любая правка `image.prompt`, `image.shot`, `image.style/negative`, паспорта, локации или render_rules меняет `part_hash` (`image-ports.js:66-70`) и перерисовывает IU. На BA включён только image; полная перерисовка 32 IU — прямые GPU-часы. Видео зависит от картинок (ADR §6.5 в `docs:architecture/ORCHESTRATION_V2.md`).
2. **Catch-all в registry.** `unit.behaviour` без явной записи помечает `audio+image+video` при каждом diff (`prompt-dependency-registry.js:392-400`) — скрытая массовая инвалидация.
3. **Однообразие.** Одно правило «покраснел» на все IU героя превращает сцену в набор тиков; нужны `cooldown_iu`, `max_per_unit`, `priority` и лимит на сцену.
4. **Конфликт с `render_rules` и консистентностью персонажей.** `visuals.md` запрещает повторять паспорт (`:52-64`), а поведение может потребовать описания позы/лица; формулировки должны быть про действие, а не про внешность. `video_tokens` — якоря идентичности, их нельзя подменять поведением.
5. **Потолок промпта.** `IMAGE_PROMPT_MAX_CHARS = 2000` (`agent-prompts.js:69`); раздувание core поведениями выкинет IU из polish-проходов (они пропускают out-of-format).
6. **Два пути раннера.** Забытый вызов в `processCachedScenes` даст «в кэш-окне поведений нет» — воспроизводится только на книгах с `cached_scenes`.
7. **Правки автора.** LLM-перезапись промпта затрёт ручной текст; без lock/`source:"author"` и проверки «не менялся» это необратимо.
8. **Схема и фронты.** Редактор перебирает все ключи `behaviors` как карточки (`web:pages/EditPage.tsx:1336`, `and:ui/EditFragment.kt:751`): reserved-ключи (`schema_version`, `rules`, `defaults`) без фильтра станут «персонажами».
9. **Стоимость и стохастика.** Вариант A/B платит токенами за каждую сцену и не гарантирует повторяемость; без seed нельзя ни отладить, ни объяснить автору, почему правило сработало.
10. **Нет слота эмоции.** `audio_emotion` из правила некуда положить: TTS читает только глобальный `voice.instruction` (`audio/generation.js:73-75`). Обещать «эмоцию в озвучке» в этом этапе нельзя.
11. **Тумблер layer-config.** `vbook_enabled` не сохраняется сервером (§3.3); добавлять ещё один флаг слоя без правки контракта — значит повторить ту же проблему.

---

## 12. Открытые вопросы владельцу

1. Правила — **общая библиотека на все книги** или своя на каждую? Предложение: дефолты в репо + перекрытия в книге; общая библиотека в PG — позже.
2. Кто пишет **английские формулировки** правил (`then.image`/`then.action`) — автор, редактор или LLM при первом применении? От этого зависит, нужен ли LLM-этап вообще.
3. Поведение должно влиять **только на видео** (дешевле, не трогает готовые картинки) или и на картинку? Если только на видео — вариант C становится почти бесплатным по инвалидации.
4. **Cooldown** считается в пределах сцены, окна или всей книги? От этого зависит, можно ли пересчитывать состояние без хранения.
5. Нужен ли **lock на уровне IU** в редакторе (и как его снимать), или достаточно флага книги «не применять поведения к книге»?
6. Допустимо ли **перегенерировать готовые картинки BA** при включении поведений, или новые правила применяются только к новым окнам/сценам?
7. Нужен ли **per-IU `audio_emotion`** (и готовы ли менять контракт TTS/воркера), или эмоция остаётся только визуальной?
8. Делать ли **серверный флаг** `behaviour_enabled` (и починить `vbook_enabled` в layer-config) или управлять только наличием правил в книге?
9. Включать ли правила в **`.vbook`-экспорт** как авторский контент (сейчас `behavior.json` уже входит в бандл) — подтвердить, что это желаемое поведение.
10. Связь с **orch v2, задача H**: поведения должны стать частью слоя `vbook` (этап 3) или остаться свойством книги, не зависящим от оркестратора?

---

## 13. Ветка и коммит

- Ветка: `recon/vbook-behaviour` (worktree `/home/animastor/work/docs-recon-behaviour`, от `origin/main` = `56e17bb`).
- Документ: `architecture/VBOOK_BEHAVIOUR_RECON.md`.
- Push: только `origin` (`/home/animastor/repos/animastor-docs.git`); в `main` не вливается, `deploy-docs` не запускается.
- Ссылки проверены временным скриптом: 139 ссылок `файл:строка`, 139 разрешены (файл существует, номер строки в границах), 0 ошибок; скрипт в коммит не входит.
- Фактический `git log -1` и `git ls-remote origin recon/vbook-behaviour` — в отчёте после пуша (значение коммита появляется только после создания коммита).
