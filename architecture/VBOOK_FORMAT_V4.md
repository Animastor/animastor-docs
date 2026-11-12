# VBook v4 — «файл на героя» (ADR)

Статус: **решение принято, код backend не начат** (2026-11-12). §12 — задания кодерам по репозиториям с критериями
приёмки. Карточка героя — [`../05-frontend/HERO_CARD.md`](../05-frontend/HERO_CARD.md).

База: ветки `feat/behaviour-p0` (поведения, [`VBOOK_BEHAVIOUR.md`](VBOOK_BEHAVIOUR.md)) — в main на 12.11 не влиты.
Ссылки на код — по этим веткам (`@animastor/vbook-runtime` 0.3.0, `@animastor/editor` 0.3.0).

Схема героя: [`schemas/animastor.character-1.schema.json`](schemas/animastor.character-1.schema.json), примеры —
[`yura`](schemas/examples/yura.json), [`narrator`](schemas/examples/narrator.json),
[`shop_women`](schemas/examples/shop_women.json).

---

## 1. Решения владельца (не пересматриваются)

1. Один JSON на героя: `characters/<id>.json` внутри `.vbook`. В нём всё про героя: паспорт, голос, поведение, алиасы,
   ссылки на референсы.
2. Диктор — тоже герой (`role: narrator`).
3. Бинарники (wav, png) в `.vbook` не кладутся. Референсы лежат в контенте: `build_<book_id>/voices/<id>/…`, позже
   `build_<book_id>/refs/images/<id>/…`. В файле героя — текстовая ссылка + sha256 + `locked`. Нет файла или не совпал
   хэш → референс можно перегенерировать по явной команде.
4. **Миграции 3.1 → 4 нет** (уточнение 12.11): клиентских книг нет, всё будет перегенерировано. Импорт TXT сразу
   создаёт v4. Открытие или импорт книги 3.1 — понятная ошибка.
5. **Совместимой API-проекции нет**: API, web и Android меняются вместе, одним релизом.
6. `manifest.vbook_version = 4`.
7. Поле `voice.reference` общее с задачей «референсные голоса» (§5.2).

## 2. Суть

v4 — единственный формат. Герой — один объект на всех уровнях: файл `characters/<id>.json` на диске и в архиве,
элемент `book.heroes[]` в памяти, элемент `heroes[]` в API. Карты `characters` / `voices` / `behaviors` и файл
`mentions.json` исчезают как самостоятельные данные.

---

## 3. Раскладка архива и каталога книги

```
manifest.json            vbook_version: 4
book.json                structure.chapters_order + structure.characters_order (подсказка порядка)
bible.json               необязателен
locations.json           необязателен
behaviour.json           глобальное поведение: defaults + глобальные правила (§6.3)
characters/
  narrator.json          диктор — создаётся всегда
  yura.json              один файл на героя
chapters/
  ch-XXXXXXXX.json  chapter.looks, scene.looks, scene.look_patch — назначение обликов (§4a)
source.txt               необязателен (исходный текст для продолжения анализа)
```

- **Единый корень.** Писатель кладёт файлы в корень zip — без `import_<ts>/` и любого другого префикса. Читатель
  принимает только такой архив: `manifest.json` обязан лежать в корне, иначе отказ `manifest_not_in_root`.
- **Точные пути.** Поиск «по окончанию имени» (`keys.find(k => k.endsWith(name))` в `index.js`
  `buildBookFromBundle`) удаляется: он принимает `notebook.json` за `book.json`, а в v4 принял бы
  `characters/book.json` за метаданные книги.
- **Версия.** `manifest.vbook_version` — целое `4` (ключ существующий, его читает `book-model.cjs`
  `getBookIdentity`). Читатель принимает `4`, `"4"`, `"4.x"`. Всё остальное — §9. Поле `book.json.version` не
  используется и новыми книгами не пишется.
- **Одно написание — `behaviour`**: файл, ключи, модули, API, документы. `behavior` / `behaviors` / `behavior_rules`
  из кода и API удаляются (§12).
- **Белый список.** В архив и из архива идут только перечисленные имена. Экспорт перестаёт архивировать каталог
  книги целиком (`export-routes.cjs` `addDirToZip(zip, bookDir, '')`); импорт перестаёт писать на диск произвольные
  записи архива и сохраняет книгу только объектным путём (`saveBookBundle(book)`); режим «raw files»
  (`saveBookBundle(book, files)`) удаляется.
- **Порядок героев.** Источник истины о составе — каталог `characters/`. Порядок показа —
  `book.json.structure.characters_order` (массив id), это подсказка: сначала id из списка, у которых есть файл, затем
  остальные по алфавиту; диктор всегда первый. Лишние и отсутствующие id в списке — не ошибка. Поэтому добавление
  героя — запись одного файла, а рассинхронизация списка лечится следующим сохранением книги.

---

## 4. Файл героя — `animastor.character/1`

```json
{
  "schema": "animastor.character/1",
  "id": "yura", "name": "Юра", "role": "protagonist",
  "aliases": ["Юрий"],
  "passport": { "appearance": "…", "clothes": "…", "video_tokens": ["man"] },
  "voice": {
    "timbre": "…", "manner": "…",
    "reference": { "file": "voices/yura/ref_02.wav", "sha256": "…", "ref_text": "…", "source": "designed",
                   "model": "…", "seed": 0, "verification": "passed", "locked": true }
  },
  "behaviour": { "profile": { "baseline": "…", "quirks": [], "reactions": [] }, "rules": [] },
  "image_refs": [ { "file": "refs/images/yura/portrait_01.png", "sha256": "…", "kind": "portrait", "locked": true } ],
  "notes": ""
}
```

| Поле | Обяз. | Смысл | Идёт в генерацию |
|---|---|---|---|
| `schema` | да | ровно `animastor.character/1` | — |
| `id` | да | на него ссылаются `scene.participants`, метки говорящих, PG, артефакты | да |
| `name` | нет | имя для людей | нет |
| `role` | нет | свободный текст; `narrator` зарезервировано за диктором | нет |
| `aliases` | нет | как автор называет героя в тексте (бывший `mentions.json`, §7) | анализ (сопоставление героев) |
| `passport` | нет | базовая внешность: `appearance`, `clothes`, `video_tokens` (массив 1–4) | картинки, видео |
| `looks` | нет | именованные облики — перекрытия паспорта (§4a) | картинки, видео |
| `voice` | нет | `timbre`, `manner`, `reference` (§5) | аудио |
| `behaviour.profile` | нет | характер: `baseline`, `quirks`, `reactions` | нет (ассистент) |
| `behaviour.rules` | нет | правила героя (§6.2) | видео (через `unit.behaviour`) |
| `image_refs` | нет | референс-картинки (§5.3) | пока нет |
| `notes` | нет | заметки человека | **никогда** |

Герой может иметь любую комбинацию блоков: только голос (диктор, эпизодический говорящий), только паспорт
(молчаливый персонаж), всё сразу. «Настоящий персонаж сцены» = герой с `passport`; только такие входят в реестр
персонажей анализа (`snake-guard`, слияние между окнами, сборка промптов картинок и видео).

**Id и имя файла.** Id — канонический snake_case `^[a-z0-9]+(?:_[a-z0-9]+)*$`, до 64 символов (`CANONICAL_ID_RE`,
сейчас `packages/animastor-editor/src/entity-id.js`; переезжает в `vbook-runtime`). Имя файла — ровно `<id>.json`;
несовпадение имени и внутреннего `id` — файл битый (§10.3). Зарезервированы и не могут быть id героя: `manifest`,
`book`, `bible`, `locations`, `voices`, `characters`, `behavior`, `behaviour`, `mentions`, `index`. Файлы и каталоги в
`characters/`, начинающиеся с точки, — служебные.

**Диктор.** Id фиксирован — `narrator`; `role: "narrator"` обязателен у него и запрещён у остальных. Файл создаётся
импортом TXT и созданием пустой книги. Удалить диктора нельзя (409 `narrator_required`). Резервное чтение
`bible.narrator.voice.instruction` (`audio/segments.js`) удаляется.

**Неизвестные ключи** сохраняются при чтении и записи, валидатор сообщает о них предупреждением `unknown_key`
(опечатка в ручной правке видна, новая версия формата не ломает старый сервер).

---

## 4a. Облики героя (перекрытия паспорта)

По умолчанию действует базовый паспорт. По ходу книги внешность меняется (одежда, борода, ранение) — для этого в
файле героя лежат **именованные облики**, а главы и сцены на них ссылаются.

### 4a.1 Что было (разведка)

Три места хранения:

| Место | Кто пишет | Кто читает |
|---|---|---|
| `chapter.character[id]` | **никто** (ни пайплайн, ни редактор, ни фронты) | `prompt-builder.js` `resolvePassport` |
| `scene.visual.character[id]` | **никто** | `prompt-builder.js` `resolvePassport` |
| `scene.passport[id]` (`appearance`, `clothes`, `video_tokens`) | редактор сцены на web и Android (`PATCH /scene … passport.<id>.<поле>`, `scene-patch-utils.cjs`); шаг `passport_reconciliation` — автоматически, только `video_tokens` (`pipeline-runner.js` `applySceneVideoTokens`) | все четыре резолвера ниже |

Четыре резолвера с разными правилами:

| Резолвер | Поля | Порядок |
|---|---|---|
| `backend/src/image/prompt-builder.js` `resolvePassport` | `appearance`, `clothes` | `scene.passport` → `scene.visual.character` → `chapter.character` → паспорт; пустая строка в первом источнике **останавливает** поиск (`??`), в остальных — нет |
| `backend/src/workflows/video/video-workflows.js` `buildCharLines` | `video_tokens` | `scene.passport` → паспорт; главу и `scene.visual` не видит; при совпадении набора токенов у двух участников — откат к базовым |
| `backend/src/services/agent/pipeline-steps.js` (текущие токены для промпта сверки) | `video_tokens` | `scene.passport` → `passport.video_tokens` → плоское `video_tokens` героя окна |
| `backend/src/services/agent/pipeline-runner.js` `applySceneVideoTokens` (сравнение перед записью) | `video_tokens` | то же |

У `@animastor/editor` своего резолвера нет: его тест `scene-passport-patch.test.js` вызывает `resolvePassport` из
`prompt-builder.js`. Реестр инвалидации следит только за `scene.passport` и `characters.passport` — перекрытия главы
и `scene.visual.character` не дали бы dirty, даже если бы их кто-то писал.

### 4a.2 Облик

```json
"looks": [
  { "id": "beard", "label": "С бородой",
    "fields": { "appearance": "…", "clothes": "…", "video_tokens": ["…"] },
    "image_ref": null, "notes": "" }
]
```

| Поле | Обяз. | Смысл |
|---|---|---|
| `id` | да | snake_case, уникален внутри героя; `base` зарезервирован за базовым паспортом |
| `label` | да | название для людей |
| `fields` | да, хотя бы одно поле | `appearance`, `clothes`, `video_tokens` — каждое **целиком заменяет** поле базового паспорта; отсутствующее берётся из базового |
| `image_ref` | нет | референс-картинка облика (форма `image_refs[]`); генерация — будущая задача |
| `notes` | нет | заметки человека, в промпты не идут |
| `evidence` | нет | цитата-основание (§4a.6) |

Решения:

- **Замена поля, не склейка.** Облик «в пальто» несёт полный текст `clothes`. Дописывание к базовому тексту даёт
  противоречия («кожаная куртка» + «пальто») — ровно то, от чего страдают картинки.
- **Пустых значений нет** (минимум один символ, минимум один токен). «Без одежды» пишется словами. Так уходит
  нынешняя двусмысленность пустой строки.
- **Облики — только у героя с `passport`.**
- **Облик не наследует другой облик.** Нужны «борода» и «пальто» одновременно — третий облик. Цепочки сделали бы
  итог непредсказуемым для человека и для инвалидации.

### 4a.3 Назначение

```
chapter.looks = { "<hero_id>": "<look_id>" }          глава
scene.looks   = { "<hero_id>": "<look_id>" | "base" } сцена; "base" — базовый паспорт вопреки главе
```

Сцена важнее главы; без ссылок — базовый паспорт. Назначение хранится в главе и сцене, а не в файле героя: сцена
остаётся самодостаточной для сборки промпта и для инвалидации, а карточка строит «где действует» обходом глав.

Рассмотрено и отклонено: «облик действует с этой сцены и до следующей смены». Это потребовало бы порядка сцен в
резолвере, а правка одного назначения делала бы грязными все сцены до конца книги. Назначение на диапазон глав —
действие интерфейса (несколько ссылок за одну операцию), а не свойство формата.

Ссылка на несуществующий облик не ломает книгу: резолвер идёт дальше по порядку и возвращает предупреждение
`unknown_look`. Удаление облика через API снимает все ссылки на него (сначала главы, потом файл героя — обрыв
между ними оставляет безвредные висячие ссылки).

### 4a.4 Разовая правка в сцене

```
scene.look_patch = { "<hero_id>": { "appearance"?, "clothes"?, "video_tokens"? } }
```

Заменяет поля поверх выбранного облика, только в этой сцене. Оставлена, потому что у неё два действующих
пользователя:

1. шаг `passport_reconciliation` разводит `video_tokens` участников **одной сцены** («у обоих галстук») — это не
   облик героя, а подгонка под состав кадра;
2. человек правит мелочь в одной сцене (снял шляпу) в редакторе сцены — блоки «паспорт в сцене» на web и Android.

Правила значений — как у `fields` облика. `scene.passport`, `chapter.character`, `scene.visual.character`
**удаляются**; совместимости нет.

### 4a.5 Один резолвер

`@animastor/vbook-runtime`, `src/looks.cjs`, чистая функция:

```
resolveHeroLook(book, chapter, scene, heroId) → {
  hero_id, look_id,                 // id облика или "base"
  source,                           // "scene" | "chapter" | "base" — откуда взят облик
  appearance, clothes, video_tokens,// итог: паспорт ← fields облика ← look_patch сцены
  base: { appearance, clothes, video_tokens },
  changed: [...],                   // поля, отличные от базового паспорта
  patched: [...],                   // поля, пришедшие из look_patch
  image_ref,                        // референс облика, иначе null
  warnings: [...]                   // unknown_look
} | null                            // героя нет или у него нет passport
```

Порядок: `scene.looks[id]` → `chapter.looks[id]` → `base`; затем `fields` облика поверх паспорта; затем
`scene.look_patch[id]` поверх результата.

На него переходят все четыре резолвера §4a.1 и карточка (её клиентская копия — `resolveLook` в `heroModel.ts`, те же
фикстуры). Остаётся у потребителей, потому что это не разрешение облика:

- `prompt-builder.js` — отбрасывание текстов-заглушек (`helpers.isPlaceholder`) и склейка описания;
- `video-workflows.js` — защита от одинаковых наборов токенов у двух участников; запасной вариант берётся из
  `base.video_tokens` результата.

`resolveState` (`scene.state[id]` / `chapter.state[id]` в `prompt-builder.js`) — не внешность, не трогается.

**Инвалидация** (`prompt-dependency-registry.js`). Ключи `characters.passport` и `scene.passport` заменяются одним
**производным ключом сцены** `scene.resolved_looks` → слои **image и video**, аудио не затрагивается:

```
extract(scene, { book, chapter }) = участники сцены с passport →
    { [hero_id]: { appearance, clothes, video_tokens } }   // из resolveHeroLook
```

Сравнивается итог, а не источники, поэтому грязными становятся ровно те сцены, где итоговая внешность участника
изменилась: правка полей облика — сцены, где он действует; назначение на главу — сцены главы без собственной ссылки;
правка базового поля — только сцены, где его не перекрывает облик (сегодня правка паспорта помечает все сцены
героя). `label`, `notes`, `image_ref`, `evidence` и облик, который нигде не назначен, dirty не дают. Реестру для
этого нужен контекст книги и главы в `extract` (сейчас — только сцена).

### 4a.6 Будущее: облики из текста (не реализуется сейчас)

Идея из LocalText2Voice (`storyboard_character_changes.py`, разбор — `reports/2026-11-12/localtext2voice-recon.md`
§«Изменения внешности»): LLM ищет в тексте только **явные** изменения внешности (одежда, волосы, возраст,
физические) и обязан привести **точную цитату**; хост проверяет, что цитата дословно и единственным образом
находится в исходном тексте, и привязывает её к IU. Невизуальное (характер, отношения) отбрасывается.

Место в формате уже есть — `look.evidence = {quote, chapter_id, scene_id, unit_id, basis: "explicit" | "inferred",
status: "suggested" | "accepted"}`:

- предложенный облик — обычный облик со `status: "suggested"`, никуда не назначенный, поэтому на генерацию не
  влияет;
- карточка показывает его с цитатой; «Принять» ставит `accepted` и назначает на главы и сцены от места цитаты;
  «Отклонить» удаляет;
- запуск поиска — явная команда пользователя, отдельным шагом анализа, после стабилизации v4.

---

## 5. Голос

### 5.1 `timbre` и `manner`

Сегодня одно поле `voices[id].instruction` смешивает «кто звучит» и «как говорит»
(`backend/ai/rules/voice_generation.md`). Оно целиком уходит в VoiceDesign, и голос заново «придумывается» на каждой
сцене (`audio/generation.js` `buildMergedDialogueWorkflow`).

| Поле | Смысл | Потребитель |
|---|---|---|
| `timbre` | кто звучит: пол, возраст, тембр, акцент, «Native … pronunciation» | создание референса (VoiceDesign) |
| `manner` | как говорит обычно: темп, интонация, речевые привычки | VoiceDesign, пока у героя нет референса; при синтезе с референсом — **никто** (см. ниже) |

Факт из разведки референсных голосов (`reports/2026-11-12/voice-references-recon.md` §3): на Base-клоне Qwen3-TTS
параметр `instruct` молча игнорируется (`qwen-tts` 0.1.1), клон копирует подачу референса. Поэтому:

- референс создаётся **только из `timbre`** и должен звучать нейтрально;
- после закрепления референса `manner` на звук не влияет. Поле остаётся в формате: оно нужно синтезу без референса,
  человеку в карточке и модели TTS, которая начнёт исполнять instruct. Карточка об этом говорит прямо (подсказка у
  поля «манера» при закреплённом референсе — `HERO_CARD.md` §3).

- **`instruction` в v4 нет.** Шаг анализа `voice_generation` возвращает `{timbre, manner}` на героя (правка
  `voice_generation.md` и `character-analyzer/voices.js`); диктор получает те же два поля.
- Единственное место сборки текста для TTS — `voiceInstruct(hero)` в `vbook-runtime`:
  `[timbre, manner].filter(Boolean).join(' ')`. Пока синтез идёт без референса, в VoiceDesign уходит этот текст. Три
  копии выбора голоса (`audio/segments.js`, два места в `audio/generation.js`) и их мёртвая ветка
  `characters[i].voice.instruction` заменяются одним вызовом.
- Говорящий, который не является героем или не имеет `voice`, озвучивается голосом диктора — как сегодня.
- Инвалидация: `timbre`, `manner`, `reference.sha256` → слой audio (§12, шаг 3).

### 5.2 `voice.reference` — согласование с задачей «референсные голоса»

Задача референсных голосов на 12.11 — на этапе разведки (`reports/2026-11-12/voice-references-recon.md`, коммитов
нет). Она задумана для формата 3.1 («голос в `voices.json`, порт в `vbook-runtime`») — после решения §1.4 текущим
форматом становится v4. Ниже контракт сведён с её планом; расхождения — в §13, В2.

- **Место** — только `characters/<id>.json` → `voice.reference`. В `voices.json` поле не добавляется.
- **Один порт** в `vbook-runtime` — имена из плана той задачи: `getCharacterVoice(book, id) → {timbre, manner,
  reference}` и `setCharacterVoiceReference(book, id, ref | null)`; плюс `resolveReferenceFile(buildDir, ref)` и
  `referenceState(buildDir, ref)`. Через `getCharacterVoice` читают голос все три нынешних места
  (`audio/segments.js`, два в `audio/generation.js`). Порт заводит та задача; v4 его не дублирует, `voiceInstruct`
  (§5.1) — его часть.
- **Поля**: `file` и `sha256` обязательны; `ref_text`, `source` (`designed` | `uploaded`), `model`, `seed`,
  `verification`, `locked` — необязательны; неизвестные ключи сохраняются.
- **`file`** — путь относительно `build_<book_id>/`, только вида `voices/<id героя>/<имя>.<wav|flac|mp3|ogg>`.
  Абсолютные пути, `..`, обратные слэши — ошибка валидации. Порт перед чтением проверяет, что разрешённый путь лежит
  внутри `build_<book_id>/voices/<id>/`.
- **Состояние** вычисляется, в файл не пишется: `ok` (файл есть, sha256 совпал) / `missing` / `mismatch`. API отдаёт
  его как `voice.reference_state`.
- **Кандидаты** (`ref_01.wav`, `ref_02.wav`, …) — контент: лежат в `build_<book_id>/voices/<id>/`, в `.vbook` не
  попадают. В файле героя — только закреплённый.
- **`locked: true`** — автоматическая замена запрещена. Замена, перегенерация, снятие — только явной командой.
- **Дополнительные поля той задачи** (`timbre_source` у голоса, длительность и транскрипт у референса) проходят как
  неизвестные ключи — схема их не запрещает.
- **Сохранность файлов.** Сегодня «Очистить кэш» (`routes/book/cache-routes.cjs`) и `cleanup-service.cjs` удаляют
  `build_<book_id>` целиком — вместе с закреплёнными референсами. Требование формата: `build_<book_id>/voices/` и
  `build_<book_id>/refs/` очисткой кэша не удаляются, только удалением книги. Иначе после каждой очистки все
  герои получают состояние `missing`.
- **UI** — блок референса в карточке героя (`HERO_CARD.md` §6); отдельный блок во вкладке «Голоса» той задаче
  делать не нужно — вкладки больше нет.

### 5.3 `image_refs`

Те же правила: `file` относительно `build_<book_id>/`, вида `refs/images/<id героя>/<имя>.<png|jpg|jpeg|webp>`;
`sha256` обязателен; `kind` — `portrait` | `full_body` | `other`; `source` — `generated` | `uploaded`; `locked`.
Портрет карточки — первый элемент с `kind: "portrait"`, иначе первый элемент. В генерацию картинок `image_refs` пока
не идут; v4 фиксирует только место хранения.

---

## 6. Поведение

### 6.1 `behaviour.profile`

Характер героя — `baseline`, `quirks`, `reactions` (то, что в `behavior.json` v2 лежало в `characters.<id>`).
Отдельный объект, а не поля прямо в `behaviour`: запись терпит неизвестные ключи, и ни один из них не должен
столкнуться с `rules`.

### 6.2 `behaviour.rules`

Правила героя лежат в его файле. `scope` и `character_id` в файле **не пишутся** — следуют из места хранения;
присутствие любого из них — ошибка валидации. Остальные поля правила — `VBOOK_BEHAVIOUR.md` §2.1.

Уникальность `id` правила — по всей книге; дубль между героями или с глобальным правилом — предупреждение
`duplicate_rule_id`, правило из более позднего по порядку источника не применяется.

### 6.3 Глобальный `behaviour.json`

```json
{ "schema": "animastor.behaviour-globals/1", "defaults": { "max_per_scene": 2 }, "rules": [ /* только глобальные */ ] }
```

Правило в этом файле всегда глобальное; `scope` и `character_id` здесь тоже не пишутся. Файл создаётся вместе с
книгой. На уровне книги остаются: дефолты и глобальные правила поведения, `bible.json`, `locations.json`.

Эффективные правила матчера (`behaviour-rules.js`): дефолты репозитория ⊕ `behaviour.json` `rules` (как
`scope: "global"`) ⊕ правила всех героев (как `scope: "character"`, `character_id` = id героя). Слияние по `id`,
лимит `max_per_scene`, матчер, снимок в `unit.behaviour` — без изменений (`VBOOK_BEHAVIOUR.md` §2.2, §4).

---

## 7. `mentions.json`, голоса без героя, дубликаты id

**`mentions.json` в v4 нет — алиасы живут в файле героя.** Факты разведки: канонический загрузчик файл не читает,
объектное сохранение не пишет; его пишет `lazy-book/create.js` и читают только `loadDraftBook` и счётчик в
`lazy-book/status.js`; между окнами анализа упоминания идут через PG (`windowData.all_mentions`, `bootstrap.js`).

- `create.js` после своего «барьера химер» дописывает алиас герою-цели: написание сохраняется, дубли внутри героя
  снимаются по `normalizeForMatch` (`character-identity.js`), алиас, равный `name`, не пишется.
- Упоминание, чья цель не герой («естественное обозначение»), в книгу не пишется; оно остаётся в PG.
- Карта «алиас → id» для промпта `units.js` и черновых потоков строится на лету из `aliases`
  (`buildAliasIndex(heroes)`); алиас, заявленный двумя героями, в карту не попадает и даёт предупреждение
  `ambiguous_alias`.
- `character-identity.js` `allIdentityTexts` уже читает `character.aliases` — слияние героев между окнами начнёт
  учитывать алиасы. Это желаемое поведение, но оно меняет результат анализа: нужен тест (§12, критерий 2.6).
- PG-таблица `character_mentions` (с `source_start` / `source_end`) и остальные таблицы анализа не трогаются.

**Голос без героя** (сегодня: `shop_women` в `voices.json` «Мастера и Маргариты» без записи в `characters.json`)
в v4 невозможен: голос — блок героя. Эпизодический говорящий с собственным голосом — герой без `passport`.
Анализатор таких не создаёт (правило `voice_generation.md` уже запрещает); человек может создать в карточке.

**Дубликаты id** возможны только при ручной правке архива: имя файла однозначно определяет id, а несовпадение имени
и внутреннего `id` делает файл битым. Создание героя с занятым id — 409. При слиянии героев между окнами анализа
дубли снимает `mergeCharacterLists`, как сегодня.

---

## 8. Модель в памяти и API

### 8.1 Память

```
book = { manifest, book, bible, locations, behaviour, heroes[], hero_issues[], chapters[] }
```

- `heroes[]` — файлы героев как есть, в порядке показа. `behaviour` — содержимое `behaviour.json`.
  `hero_issues[]` — проблемы загрузки (§10.3), на диск не пишется.
- `book.characters`, `book.voices`, `book.behaviors`, `book.mentions` **удаляются**.
- Доступ читателей — через хелперы `vbook-runtime` (`heroes.cjs`), а не обходом массива по месту:
  `findHero(book, id)`, `resolveHeroLook(book, chapter, scene, id)` (§4a.5), `passportHeroes(book)` (герои с `passport` — замена прежнего `book.characters`),
  `voiceInstruct(hero)`, `narrator(book)`, `buildAliasIndex(heroes)`, `heroRules(book)`.

Читателей прежних карт немного, и все они — простые выборки по id (полный список — §11).

### 8.2 API

`GET /api/v1/book/:id` → `{manifest, book, bible, locations, behaviour, heroes, hero_issues, chapters, scene_list}`.
Полей `characters`, `voices`, `behaviors`, `behavior_rules` нет.

Вычисляемые поля героя в ответе (в файл не пишутся, во входящих телах игнорируются): `rev` — первые 16 hex sha256
канонической сериализации героя; `voice.reference_state`, `image_refs[].state` — `ok` | `missing` | `mismatch`.

| Маршрут (`@animastor/editor`) | Назначение |
|---|---|
| `POST /book/:id/heroes` | создать: `{id?, name, role?, passport?, voice?}`; id из имени — существующий `resolveId`; 409 `hero_exists`, 400 `reserved_id` |
| `PATCH /book/:id/heroes/:heroId` | `{fields, if_rev?}`; пути по белому списку: `name`, `role`, `aliases`, `notes`, `passport.appearance`, `passport.clothes`, `passport.video_tokens`, `voice.timbre`, `voice.manner`, `behaviour.profile.baseline`, `behaviour.profile.quirks`, `behaviour.profile.reactions`; `passport: null` / `voice: null` снимают блок; 409 `rev_conflict` |
| `DELETE /book/:id/heroes/:heroId` | удалить файл героя; 409 `narrator_required`; `?broken=1` — удалить битый файл |
| `POST /book/:id/heroes/:heroId/rules` · `PATCH …/rules/:ruleId` · `DELETE …/rules/:ruleId` | правила героя; `PATCH {enabled}` — выключатель в карточке |
| `POST /book/:id/heroes/:heroId/looks` · `PATCH …/looks/:lookId` · `DELETE …/looks/:lookId` | облики: создать `{id?, label, fields}`; править `{fields: {label, notes, "fields.appearance", "fields.clothes", "fields.video_tokens"}}` (`null` убирает поле из облика; последнее поле убрать нельзя — 400 `look_empty`); удалить — снимает все ссылки, в ответе `unassigned` |
| `POST /book/:id/looks/assign` | назначить: `{hero_id, look_id, chapters: [chapter_id], scenes: [{chapter_id, scene_id}]}`; `look_id: "base"` для сцены — базовый вопреки главе; `look_id: null` — снять ссылку. Одна операция на любой набор глав и сцен; в ответе `dirty_scenes` |
| `PATCH /book/:id/scene/:chapterId/:sceneId` (существующий) | поля `looks.<hero_id>` и `look_patch.<hero_id>.<поле>` вместо `passport.<hero_id>.<поле>` |
| `GET /book/:id/behaviour` · `PATCH /book/:id/behaviour` | глобальные дефолты и правила |
| референс голоса и кандидаты | заводит задача референсных голосов; что ждёт карточка — `HERO_CARD.md` §6 |
| `POST /book/:id/heroes/:heroId/image-refs` (multipart) · `PATCH …/:index` · `DELETE …/:index` | референс-картинки |

Удаляются: `POST/PATCH/DELETE /characters`, `/voices`, `/behaviors`.

Dirty: внешность — по производному ключу `scene.resolved_looks` (§4a.5): `passport.*`, поля обликов, назначения и
`look_patch` → image + video тех сцен, где изменился итог; `voice.timbre`, `voice.manner`, `voice.reference.sha256` → audio; `name`, `role`,
`aliases`, `notes`, `image_refs`, `behaviour.*` — ни один слой (сработавшие правила — снимок в IU).

`PUT /book/:id`: тело без `heroes` не меняет героев; пустой массив `heroes` при непустом каталоге — 400 (защита от
затирания устаревшим ответом, сегодня такая же стоит для `characters`).

Ассистент (`edit_book`): пути `/heroes/<id>/…` — сегмент после `/heroes/` это **id героя**, не индекс массива (страж
путей в `chat-engine.cjs` переводит в индекс перед применением). Пути `/characters`, `/voices`, `/behaviors`
отклоняются с подсказкой.

---

## 9. Книги 3.1

Миграции нет. Версия проверяется в одной функции `assertSupportedVbookVersion(manifest)` (`vbook-runtime`), её
вызывают загрузчик, черновой загрузчик и импорт.

| Ситуация | Поведение |
|---|---|
| Импорт `.vbook` 3.1 (или без `vbook_version`) | 422 `{error: "unsupported_vbook_version", vbook_version: "3.1", supported: 4, message}`; диск не меняется |
| `GET /book/:id` книги 3.1, лежащей на сервере | 409 с тем же телом; файлы книги не меняются |
| Список книг | книга показывается с `unsupported: true` и названием из манифеста; доступно только удаление |
| Генерация, анализ, редактор, ассистент для такой книги | 409 `unsupported_vbook_version` |
| Версия больше 4 | то же, `message` — «книга создана более новой версией Animastor» |

Текст `message` (ru / en по языку запроса, те же строки в i18n фронтов):

> Книга сохранена в формате VBook 3.1, который больше не поддерживается. Импортируйте исходный текст заново — книга
> будет создана в формате 4.

Фронты показывают эту ошибку отдельным состоянием экрана, а не общим «не удалось загрузить» (`HERO_CARD.md` §7).

`loadBook` сегодня при любой ошибке возвращает `null`, и маршруты отвечают 404. Для версии вводится типизированная
ошибка `BookModelError('UNSUPPORTED_VBOOK_VERSION')` (класс уже есть в `book-model.cjs`): фасад её пробрасывает,
маршруты переводят в 409. `null` остаётся только для «книги нет».

На проде сейчас две книги 3.1 (`ba_1788172242081`, `import_1786345731767_1786345734345`). После релиза v4 они
перестанут открываться; их удаление — действие владельца (§13, В4). Снимки `<book_id>.snapshot.json` формата 3.1
восстановлению не подлежат; `task-handler.cjs` при восстановлении проверяет версию той же функцией.

---

## 10. Запись, валидация, битый файл

### 10.1 Атомарная запись

Файл героя: `characters/.<id>.json.tmp-<pid>-<случайное>` → `fsync` → `rename` поверх целевого → `fsync` каталога
(best-effort). Так же пишутся `manifest.json` и `behaviour.json`. Временные файлы старше часа удаляются при
следующей записи книги.

Две операции записи:

- `characterStore.update(bookId, heroId, mutator)` — точечная: чтение файла → изменение → проверка → атомарная
  запись, синхронно, без `await` между чтением и записью. Ею пользуются маршруты героя и `create.js`. Правки
  **разных** героев (редактор и окно анализа) не затирают друг друга — сегодня оба переписывают `characters.json`
  целиком.
- `saveBookBundle(book)` — книга целиком: пишет файл героя, только если сериализация отличается от диска; удаляет
  файл героя, только если он **успешно читается**, а его id в `book.heroes` нет; перед первой записью проверяет все
  файлы (`assertBundleFilesWritable`) — ошибка любого отменяет сохранение целиком.

Предпосылка: один процесс backend на каталог книг (как в текущем compose).

### 10.2 Валидация

- Нормативная схема — в документации; копия в пакете — `schemas/character-1.schema.json` (тест сверяет байты).
- Рабочий валидатор — ручной `validateCharacterFile(doc, {filename})` в `bundle-validator.cjs` (зависимость от
  валидатора схем пакету не добавляется). Тест прогоняет общие фикстуры «валидные / невалидные» через схему (`ajv`
  — devDependency) и через ручной валидатор и требует одинакового вердикта.
- Сверх схемы: имя файла равно `<id>.json`; каталог в `voice.reference.file` и `image_refs[].file` равен id героя;
  алиасы уникальны после `normalizeForMatch`; `rules[].id` уникальны внутри файла.
- Смысловая проверка правил (словарь эмоций, clamp) остаётся в `behaviour-rules.js` и на загрузку не влияет.

### 10.3 Битый файл одного героя

Битый = не читается, не JSON, не проходит `validateCharacterFile`, имя не равно `<id>.json`.

- **Книга загружается.** Битого героя нет в `heroes`; в `hero_issues` — `{file, hero_id?, code, message,
  blocking: true}`, коды `unreadable`, `invalid_json`, `schema`, `filename_mismatch`. Предупреждения
  (`blocking: false`): `unknown_key`, `duplicate_rule_id`, `ambiguous_alias`. Строка в журнале backend.
- **Файл не трогается**: не удаляется, не перезаписывается, не «чинится».
- **Запись в этот id отклоняется**: создание героя с id битого файла и `PATCH` — 409 `hero_file_broken`. Выходы:
  `DELETE /heroes/:id?broken=1` или исправление файла вручную.
- **Сцены** сохраняют id в `participants`. Сборка промптов уже терпит неизвестный id; говорящий без голоса
  озвучивается диктором. Команды генерации возвращают предупреждение `hero_issues` в ответе, не отказ.
- **Экспорт** книги с битым героем — 409 `hero_file_broken` со списком; `?skip_broken=1` экспортирует без них.
- **Импорт** архива с битым файлом героя — отказ 422 со списком, диск не меняется: импорт — явное действие с файлом,
  который можно исправить.
- **Битый или отсутствующий `narrator.json`** — книга загружается, диктор озвучивает пустой инструкцией по умолчанию
  (`resolveAudioAssembly().defaults.defaultInstruct`), в `hero_issues` — `narrator_missing` (`blocking: true`);
  создать диктора заново — `POST /heroes {id: "narrator", role: "narrator"}`.

Битые `manifest.json` / `book.json` — книга не загружается, как сегодня.

---

## 11. Разведка

### 11.1 Кто читает и пишет данные героя

| Репозиторий | Файл | Что делает | Шаг |
|---|---|---|---|
| backend, `vbook-runtime` | `src/index.js` | `buildBookFromBundle`, `saveBookBundle` (объектный и raw-режим), `loadBookFromDir`, `assertBundleFilesWritable` — все четыре файла кроме `mentions.json` | 1 |
| | `src/bundle-validator.cjs` | `validateVoices`, `validateBehaviors`, `validateCharacters` | 1 |
| | `src/behavior-schema.cjs` | v2-документ, проекция API, каскад удаления | 1 (удаляется) |
| | `src/character-identity.js` | слияние героев; читает `alias`, `aliases`, `description`, `appearance`, `traits`, `voice` | 2 |
| | `src/snake-guard.js` | реестр id из `characters.json` | 2 |
| | `src/lazy-book/create.js` | пишет `characters.json`, `voices.json`, `mentions.json`, `behavior.json` напрямую | 1 |
| | `src/lazy-book/create.js` (сцена) | переносит `aiScene.passport` в `scene.passport` | 1 |
| | `src/lazy-book/{draft,status,paths}.js` | черновая загрузка всех файлов, счётчик упоминаний, пути | 1 |
| | `schemas/vbook-bundle-3.1.schema.json` | `behaviors` описан как произвольная карта — отстал от v2 | 1 (заменяется) |
| backend, `editor` | `src/editor-routes.cjs` | `GET /book` (проекция поведений), `PUT /book` (слияние паспортов), `PATCH /characters`, `/voices`, `/behaviors` | 4 |
| | `src/entity-crud-routes.cjs` | `POST/DELETE /characters`, `/voices`, `/behaviors`; каскад удаления героя | 4 |
| | `src/entity-id.js`, `scene-patch-utils.cjs` | грамматика id; нормализация `video_tokens`, в т. ч. в `passport.<id>.video_tokens` сцены | 1, 4 |
| backend, `assistant` | `src/chat-engine.cjs` | промпт о `behaviors.characters`, список героев в контексте, страж путей `edit_book`, каскад | 4 |
| | `src/assistant-routes.cjs` | проверка бандла после патчей | 4 |
| backend, `ai-analysis` | `tasks/character-analyzer/{index,voices}.js` | извлечение героев и упоминаний; голоса в `characters[i].voice` | 2 |
| | `tasks/{units,scenes,locations}.js` | контекст героев и упоминаний в промптах | 2 |
| backend, `generation` | `dirty-grammar/prompt-dependency-registry.js` | ключи `characters.passport`, `characters.voice`, `book.voices` | 3 |
| | `prompt-profiles/character-utils.js` | `normalizeCharacterRefs`, `buildSafeAliasIndex` (PG) | 3 |
| backend | `services/agent/{bootstrap,pipeline-runner,pipeline-steps,parallel-analysis-orchestrator}.js` | герои и упоминания между окнами (PG `all_mentions`), голос диктора | 2 |
| | `services/agent/{behaviour-rules,behaviour-apply}.js` | эффективные правила из `behavior.json` | 3 |
| | `audio/{segments,generation}.js` | три копии выбора `voices[id].instruction` с резервом `characters[i].voice` | 3 |
| | `image/prompt-builder.js`, `workflows/video/video-workflows.js` | паспорт по id и перекрытия (§4a.1) | 3 |
| | `services/agent/pipeline-steps.js`, `pipeline-runner.js` (`applySceneVideoTokens`), `ai/rules/passport_reconciliation.md` | шаг сверки читает и пишет `scene.passport[id].video_tokens` | 2 |
| | `services/assistant-ports.cjs` | третий прямой писатель файлов книги («zero-chapter fallback»), `behavior.json` в его списке нет | 4 |
| | `services/txt-importer.js`, `ai-service.js` | удаление частичного `characters.json`; примеры `ai/examples/*` для промпта импорта | 2 |
| | `routes/book/{import,export}-routes.cjs`, `routes/generation-routes.cjs` | импорт (два дублирующих маршрута + третий), экспорт каталога целиком | 1 |
| | `services/task-handler.cjs` | снимки `<book_id>.snapshot.json` — сериализованная модель | 1 |
| | `scripts/audit-video-actions.js` | аудит `mentions.json` и `characters.json` | 3 |
| | `ai/rules/{characters,voice_generation,visuals}.md`, `ai/examples/*` | правила и примеры для LLM | 2 |
| web | `frontends/app/src/pages/EditPage.tsx` | вкладки «Персонажи», «Голоса», «Поведение»; блоки «паспорт в сцене» (`scene.passport`) во вкладке «Сцена» | 5 |
| | `api/{models,behaviors}.ts`, `packages/animastor-web-editor` | типы, фильтр служебных ключей, диалоги сущностей | 5 |
| Android | `repository/{BookModels,BehaviorEntries,BackendApi,Repository}.kt`, `ui/EditFragment.kt` | модели Gson (`Scene.passport`), те же три вкладки и блоки паспорта сцены, `PUT /book` | 6 |
| worker, gpu-hub | — | данных героя не читают | — |
| PG | `character_mentions`, `character_window_candidates`, `sentence_resolutions` | рабочие таблицы анализа | не трогаются |

### 11.2 Несогласованности формата

| № | Что | Где | Решение |
|---|---|---|---|
| Н1 | Данные героя в четырёх файлах с тремя разными ключами | `characters.json`, `voices.json`, `behavior.json`, `mentions.json` | **v4** |
| Н2 | `behavior` / `behaviour` / `behaviors`: файл, ключ памяти, поле IU `unit.behaviour`, модули `behaviour-*.js` и `behavior-schema.cjs` | backend, пакеты, фронты, docs | **v4**: везде `behaviour` |
| Н3 | Архив с папкой-префиксом формально читается, но определение формата требует `manifest.json` в корне — такой архив уходит в импорт как TXT | `import-routes.cjs` `detectFileFormat` | **v4**: только корень, иначе явная ошибка |
| Н4 | Поиск файлов бандла по окончанию имени | `index.js` `findFile` | **v4**: точные пути |
| Н5 | Экспорт архивирует каталог книги целиком | `export-routes.cjs` | **v4**: белый список |
| Н6 | Импорт пишет записи архива без белого списка; `manifest.book_id` из архива становится именем каталога без проверки грамматики | `index.js` raw-режим, `import-routes.cjs` | **до v4, срочно** — §12, шаг 0 |
| Н7 | `mentions.json` пишется, но каноническим путём не читается | `create.js`, `draft.js` | **v4**: файла нет |
| Н8 | Две «версии»: `manifest.vbook_version` и `book.json.version` | бандл | **v4**: только первая |
| Н9 | `voices.narrator` есть всегда, но диктор не герой; резерв — `bible.narrator.voice.instruction` | `create.js`, `audio/segments.js` | **v4**: диктор-герой, резерв удаляется |
| Н10 | Три копии выбора голоса с мёртвой веткой `characters[i].voice.instruction` | `audio/segments.js`, `audio/generation.js` | **v4**: `voiceInstruct` |
| Н11 | Запись файлов книги не атомарна; `characters.json` целиком переписывают и редактор, и пайплайн | `index.js`, `create.js` | **v4** для героев, манифеста, `behaviour.json`; главы — позже |
| Н12 | Три прямых писателя файлов книги: `saveBookBundle`, `create.js`, `assistant-ports.cjs` | — | **v4**: герои — только через `characterStore` |
| Н13 | `video_tokens` — строка или массив | паспорт | **v4**: только массив |
| Н14 | Плоские поля героя `description`, `appearance`, `traits`, `alias`, `voice` живут в окне анализа и читаются `character-identity.js`, в файл попадают не все | анализ | **v4**: в файл идут только поля схемы; рабочие поля анализа остаются в PG / памяти окна |
| Н15 | Два дублирующих маршрута импорта `.vbook` (`/book/import`, `/book/load-vbook`) и третий в `generation-routes.cjs` — ~70 одинаковых строк в каждом | backend | **v4**, шаг 1: одна функция |
| Н16 | `loadBook` возвращает `null` и при «книги нет», и при любой ошибке чтения | `index.js`, `book-model.cjs` | **v4** — для версии (§9); остальные ошибки — позже |
| Н17 | `book.json.defaults.narration_voice` — ещё одно место «голоса диктора», никем не читается | `book.json` | позже (проверить и удалить) |
| Н18 | Каталог книги на проде принадлежит то `root`, то `animastor` | `data/books` | эксплуатация, вне формата |
| Н20 | Перекрытия паспорта в трёх местах, из них два (`chapter.character`, `scene.visual.character`) никто не пишет | `prompt-builder.js` | **v4** (§4a) |
| Н21 | Четыре резолвера внешности с разными правилами: картинки не видят `video_tokens`, видео не видит главу, пустая строка где-то останавливает поиск, где-то нет | `prompt-builder.js`, `video-workflows.js`, `pipeline-steps.js`, `pipeline-runner.js` | **v4**: `resolveHeroLook` |
| Н22 | Реестр инвалидации не следит за перекрытиями главы и `scene.visual.character`; правка базового паспорта помечает все сцены героя, даже перекрытые | `prompt-dependency-registry.js` | **v4**: `scene.resolved_looks` |
| Н23 | `scene.passport[id].video_tokens` пишет и человек, и шаг сверки — одно поле на «облик» и на «подгонку под кадр» | `pipeline-runner.js`, редактор сцены | **v4**: облик / `look_patch` |
| Н19 | Очистка кэша удаляет `build_<book_id>` целиком — вместе с референсами | `cache-routes.cjs`, `cleanup-service.cjs` | **v4** (§5.2), задача референсных голосов |

---

## 12. План работ

Порядок жёсткий: шаг вливается и проходит тесты до начала следующего. Ветки — от main после влития
`feat/behaviour-p0`. Тесты — только `./scripts/test-backend.sh`. Шаги 1–6 выкатываются **одним релизом**
(backend + web + APK): промежуточные состояния main несовместимы с выкаченными фронтами.

### Шаг 0 — проверка входа импорта (срочно, отдельно от v4, на текущем формате)

Репозиторий: `animastor-backend` (`packages/animastor-vbook-runtime`, `routes/book/import-routes.cjs`,
`routes/generation-routes.cjs`). Подробности — у владельца (отчёт 2026-11-12, в документацию не выносится).

- `manifest.book_id` из архива проверяется по грамматике id книги до любого обращения к диску; имена записей — по
  белому списку; запись вне каталога книги невозможна.
- Приёмка: тесты на отказ для недопустимых `book_id` и имён записей; существующие тесты зелёные; импорт `MiM.vbook`
  работает как раньше.
- Публикация: `@animastor/vbook-runtime` 0.3.1 → backend.

### Шаг 1 — `vbook-runtime` 0.4.0: формат

- `src/looks.cjs` — `resolveHeroLook` (§4a.5), проверка обликов и ссылок.
- `src/heroes.cjs` (хелперы §8.1, `CANONICAL_ID_RE`, `RESERVED_HERO_IDS`), `src/character-store.cjs` (чтение
  каталога, атомарная запись, `update`, `remove`), `src/bundle-validator.cjs` (`validateCharacterFile`,
  `validateBehaviourGlobals`), `assertSupportedVbookVersion`, `BookModelError('UNSUPPORTED_VBOOK_VERSION')`.
- `src/index.js`: загрузка и сохранение v4, точные пути, белый список, удаление raw-режима и поиска по окончанию;
  `lazy-book/*` — герои через `characterStore`, манифест `vbook_version: 4`, `narrator.json` и `behaviour.json` при
  создании книги; `behavior-schema.cjs` удаляется.
- `schemas/character-1.schema.json`, `schemas/vbook-bundle-4.schema.json`; `vbook-bundle-3.1.schema.json` удаляется.
- backend в том же шаге: одна функция импорта вместо трёх копий, экспорт по белому списку, версия в снимках.
- Приёмка:
  - 1.1 импорт TXT (тестовый стек) → на диске раскладка §3, `vbook_version: 4`, есть `narrator.json`,
    `behaviour.json`; файлов `characters.json`, `voices.json`, `behavior.json`, `mentions.json` нет;
  - 1.2 экспорт → импорт → экспорт: состав и содержимое файлов второго архива равны первому;
  - 1.3 `.vbook` 3.1 (`MiM.vbook`) и архив без версии: импорт 422 `unsupported_vbook_version`, диск не изменился;
    каталог книги 3.1 на диске: `GET /book` 409 с тем же телом, ни один файл не изменился;
  - 1.4 архив с префиксом-папкой — `manifest_not_in_root`; записи вне белого списка не попадают на диск;
  - 1.5 схема и ручной валидатор дают одинаковый вердикт на общих фикстурах; три примера из docs валидны;
  - 1.6 битый файл героя: книга открывается, `hero_issues`, запись 409, файл не изменился, экспорт 409 и
    `skip_broken`;
  - 1.8 `resolveHeroLook`: таблица случаев — база; облик главы; облик сцены важнее главы; `"base"` в сцене вопреки
    главе; `look_patch` поверх облика; неизвестный облик → следующий источник + `unknown_look`; герой без паспорта →
    `null`; вход не мутируется;
  - 1.7 одновременная точечная запись героя A и героя B — обе сохранены; обрыв записи (исключение между записью
    временного файла и `rename`) оставляет прежний файл целым.

### Шаг 2 — анализ пишет героев

`ai-analysis` → **0.2.0**, backend (`services/agent/*`, `ai/rules/*`, `ai/examples/*`, `txt-importer.js`).

- `voice_generation.md` и `character-analyzer/voices.js` — `{timbre, manner}`; диктор — те же поля.
- `create.js` получает героев окна и пишет файлы; алиасы — из упоминаний (§7).
- Шаг `passport_reconciliation` читает текущие токены через `resolveHeroLook` и пишет результат в
  `scene.look_patch[id].video_tokens` (только при отличии от итога, как сегодня).
- Примеры `ai/examples/` — в форме v4 (`characters/*.json`, `behaviour.json`).
- Приёмка:
  - 2.1–2.5 существующие тесты анализа, переведённые на героев, зелёные;
  - 2.6 два окна «Мастера и Маргариты» на тестовом стеке: набор героев с паспортом не хуже эталона до изменения
    (алиасы не порождают ложных слияний), у говорящих героев заполнены `timbre` и `manner`.

### Шаг 3 — генерация читает героев

backend (`audio/*`, `image/prompt-builder.js`, `workflows/video/video-workflows.js`,
`services/agent/behaviour-*.js`, `scripts/audit-video-actions.js`), `generation` → **0.2.0**.

- Читатели — через хелперы §8.1; внешность — только через `resolveHeroLook`; `resolvePassport` и выбор токенов в
  `buildCharLines` удаляются. Реестр инвалидации — ключи §8.2 и производный `scene.resolved_looks` (§4a.5;
  `extract` получает книгу и главу).
- Приёмка: для книги-фикстуры в форме v4 промпты image и video совпадают с эталоном 3.1 той же книги; текст для
  TTS равен `join(timbre, manner)`; тест реестра на каждое поле героя; облики: правка поля облика помечает image + video только сцен, где он действует,
  назначение на главу — сцены главы без своей ссылки, правка перекрытого базового поля — ничего, `label` / `notes` —
  ничего, audio не помечается ни в одном случае; `behaviour-p0.test.js` зелёный на v4.

### Шаг 4 — `editor` 0.4.0, `assistant` 0.3.0: API героя

- Маршруты §8.2 (включая облики и `looks/assign`), удаление старых; `GET`/`PUT /book`; страж путей и промпт ассистента; `assistant-ports.cjs` через
  `characterStore`.
- Приёмка: контрактные тесты каждого маршрута и кода ошибки из §8.2, §9, §10.3; `rev_conflict`; диктора нельзя
  удалить; `edit_book` по `/heroes/<id>/…`; отказ по старым путям.

### Шаг 5 — web

Ветка `feat/hero-card` (карточка на контракте §8.2) — см. `HERO_CARD.md` §9: что сделано и что остаётся.

### Шаг 6 — Android

`animastor-android`: модели и экран героев по `HERO_CARD.md` §8; версия APK и `version.json` — в общем релизе.
APK ≤ 0.2.9 с новым backend не работает (нет `characters` / `voices`): релиз включает обязательное обновление.

### Шаг 7 — после релиза

Облики из текста по цитате (§4a.6) — отдельная задача. Референс-картинки (маршруты `image-refs`, раздача файла с проверкой доступа); использование `image_refs` в генерации
— отдельная задача.

### Порядок публикации пакетов (владелец)

| № | Пакет | Версия | После шага | Зависит от |
|---|---|---|---|---|
| 0 | `@animastor/vbook-runtime` | 0.3.1 | 0 | — |
| 1 | `@animastor/vbook-runtime` | 0.4.0 | 1 | `@animastor/parser` |
| 2 | `@animastor/ai-analysis` | 0.2.0 | 2 | `vbook-runtime` ^0.4.0 |
| 3 | `@animastor/generation` | 0.2.0 | 3 | — |
| 4 | `@animastor/orchestration` | патч-версия с `generation` ^0.2.0 | 3 | `generation` |
| 5 | `@animastor/editor` | 0.4.0 | 4 | `vbook-runtime` ^0.4.0 |
| 6 | `@animastor/assistant` | 0.3.0 | 4 | `vbook-runtime` ^0.4.0 |
| 7 | `@animastor/player` | патч-версия с `vbook-runtime` ^0.4.0 | 4 | `vbook-runtime` |
| 8 | `@animastor/web-editor` | 0.2.0 | 5 | — |

Сейчас у `ai-analysis` и `player` вложенная `vbook-runtime` 0.1.0 — после v4 в дереве backend должна остаться одна
версия (`npm ls @animastor/vbook-runtime` без вложенных копий). После каждой публикации backend переводится с `file:`
на версию из реестра со сверкой tarball'ов, как в `reports/2026-11-12/behaviour-p0-npm.md`.

---

## 13. Открытые вопросы владельцу

| № | Вопрос | Предложение |
|---|---|---|
| В1 | Синтез, когда закреплённого референса нет или его файл пропал / изменён | принять вариант задачи референсных голосов (её В4): 409 `voice_reference_required` + список `character_id` для диктора и говорящих героев с голосом; `missing` / `mismatch` приравнять к «нет референса». Молча откатываться к VoiceDesign нельзя — другой голос посреди книги |
| В2 | Задача референсных голосов спланирована под 3.1: поле в `voices.json`, блок во вкладке «Голоса», очистка `instruction` правилами в `timbre` | переставить её после шага 1 и на §5.2: место — файл героя, UI — карточка, `timbre` приходит из анализа (правка `voice_generation.md`, шаг 2), очистка правилами не нужна |
| В3 | `source.txt` остаётся в `.vbook` | оставить: без него нельзя продолжить анализ импортированной книги |
| В4 | Две прод-книги 3.1 после релиза не откроются | удалить их штатным удалением книги перед релизом или сразу после |
| В5 | Старые APK (≤ 0.2.9) после релиза не работают | обязательное обновление через `version.json` в том же релизе |
