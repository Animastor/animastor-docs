# Референсные голоса героев (VOICE_REFERENCES)

Статус: **нормативный**. Принят 2026-11-12 (решения владельца — §2). Разведка:
`reports/2026-11-12/voice-references-recon.md`. Отчёт реализации: `reports/2026-11-12/voice-references.md`.

Содержание: 1 Проблема · 2 Решения · 3 Данные · 4 Поток · 5 Проверка · 6 Озвучка · 7 Контракты воркера ·
8 API · 9 Фронты · 10 Модели и установка · 11 Чего нет

## 1. Проблема

Раньше `Qwen3TTSVoiceDesign` заново «придумывал» тембр на каждый текст чанка (нарратор), а диалог
каждый раз синтезировал образец голоса заново (VoiceDesign → VoiceClonePrompt). Фиксированный seed
при разном тексте не спасает: диктор и герои звучали в каждом чанке немного разным голосом.

## 2. Решения владельца (не пересматривать)

1. Голос героя создаётся **один раз, по явной команде** пользователя, проверяется, сохраняется как WAV
   и дальше **каждый чанк клонируется с этого файла**. Автозапуска нет (`COMMAND_ONLY_GENERATION.md`).
2. Аудио-референсы лежат **только в папке контента** `OUTPUT_DIR/build_<book_id>/voices/<character_id>/`.
   В `.vbook` — только текстовая ссылка и метаданные (vbook — текстовый рецепт).
3. Диктор — такой же герой, id `narrator`.
4. Референс **закрепляется** (`locked`). Если файла нет или sha256 не совпал — референс можно
   перегенерировать, только по явной команде.
5. Проверка Whisper'ом — на облачном аудио-инстансе рядом с ComfyUI; модели в `/home`.
6. **Без совместимости со старыми данными**: нет фолбэка «VoiceDesign на каждый чанк», нет миграций,
   голоса формата «только `instruction`» не читаются. Legacy-оркестрация аудио не делает (§6.3).
7. Сверка транскрипта — **строгая** после нормализации (§5.2). Кандидатов 3, отбраковка допустима.
8. Нарратору референс делается по **полному описанию** (тембр + подача рассказчика, фраза
   повествовательная); героям — нейтрально, по тембру, фраза разговорная нейтральная.
9. Копию 48 кГц не делаем — Qwen работает в 24 кГц.

## 3. Данные

### 3.1 Голос героя — порт `@animastor/vbook-runtime/voice`

Единственная точка доступа к голосу: `getCharacterVoice`, `listVoiceIds`, `setCharacterVoiceReference`,
`setCharacterVoiceDescription`, `narratorVoiceId`, `voiceDesignDescription`, `cleanVoiceDescription`.
Хранение сейчас (формат 3.1) — `voices.json[character_id]`; при переходе на v4
(`VBOOK_FORMAT_V4.md`, файл на героя) меняется только место хранения внутри порта.

```json
"anna": {
  "timbre": "Warm, low female voice, unhurried. Native Russian pronunciation.",
  "manner": "",
  "timbre_source": "cleaned | user | analysis",
  "reference": {
    "file": "voices/anna/c1mh3x9a2b4c1.wav",
    "ref_text": "Здравствуйте, рад вас видеть. …",
    "source": "designed | uploaded",
    "model": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    "seed": 184467440737,
    "sha256": "<64 hex файла как он хранится>",
    "verification": "passed",
    "locked": true,
    "candidate_id": "c1mh3x9a2b4c1",
    "language": "Russian"
  }
}
```

- `timbre` — постоянный тембр; `manner` — постоянная подача (для нарратора — подача рассказчика).
- Текст для VoiceDesign (`voiceDesignDescription`): нарратор — `timbre + manner`, герой — только `timbre`.
- Валидатор бандла и JSON-схема `vbook-bundle-3.1.schema.json` проверяют поля и ссылку
  (`voices/<id>/<cand>.wav`, sha256, source, verification, locked). Аудиофайл в бандл не входит.

### 3.2 Описание из анализа — очистка правилами (без LLM)

Анализ пишет одну строку описания. При создании книги (`lazy-book/create.js`) она проходит
`cleanVoiceDescription` → `timbre`, `timbre_source: "cleaned"`. Удаляются предложения:
- с цитатами («…», “…”, "…", '…' вокруг слова);
- условные: `when / whenever / if / unless / as soon as`, `когда / если / как только`, `wenn / falls / sobald`.

Пользователь видит пометку «очищено автоматически» и правит тембр; правка → `timbre_source: "user"`.
Версия правил — `CLEANUP_RULES_VERSION` (1). Правило анализа (`backend/ai/rules/voice_generation.md`)
просит описывать только постоянный тембр.

### 3.3 Файлы в папке контента

```
build_<book_id>/voices/<character_id>/<candidate_id>.wav    канонический WAV (fmt + data)
build_<book_id>/voices/<character_id>/<candidate_id>.json   метаданные кандидата
build_<book_id>/voices/<character_id>/uploads/<cand>.<ext>  загруженный пользователем образец (исходник)
```

Метаданные кандидата: `candidate_id, character_id, source, status (pending|ready|failed), created_at,
description, description_kind, model, seed, language, phrase_id, phrase_version, ref_text,
comparison_policy_version, file, sha256, bytes, duration_sec, format, asr_transcript, asr_language,
words (word-timestamps Whisper), verification_model, whisper_device, whisper_compute_type,
faster_whisper_version, transcript_match, verification (passed|failed), verification_problems, job_id,
finished_at` (+ `upload`, `ref_text_source` у загруженных).

**Сохранность.** «Очистить кэш» (`routes/book/cache-routes.cjs`) и `cleanup-service` удаляют всё в
`build_<id>/` **кроме `voices/`** (`utils/build-dir.js`). `voices/` удаляется только вместе с книгой
(`book-deletion.cjs`). Загруженные пользователем образцы — тем более.

## 4. Поток

```
[клик «Создать референсы голосов»]
  → POST /voices/references/candidates (client_action.action_id обязателен)
  → gen_commands kind=voice_reference, scope {level:'book', voice:{mode:'design', character_ids, count}}
  → N задач gen_jobs kind=voice_reference (gpu:audio), по одной на кандидата, разные seed
  → воркер: VoiceDesign(описание, фраза-шаблон языка книги, seed) → SaveAudioAnimastorReference
            (ffmpeg → WAV s16le mono 24 кГц; faster-whisper; JSON в RIFF LIST/INFO/ICMT)
  → приём: WAV-валидатор → onArtifactPlaced: JSON из RIFF, LIST вырезается, sha256 хранимого файла,
           строгая сверка транскрипта, метаданные кандидата
[пользователь слушает, «Выбрать и закрепить»]
  → POST /voices/:id/reference {candidate_id} → voices.json[id].reference (locked)
[генерация аудио сцены]
  → планировщик audio: все голоса области должны иметь закреплённый референс (иначе 409, §6.2)
  → чанк: LoadAudio(vref_<sha256[:32]>.wav) → VoiceClonePrompt(ref_text) → клон; файл — input_files задачи
```

- Фразы-шаблоны — `backend/ai/voice-reference-phrases.json` (ru, en, de; `narrative` для нарратора,
  `conversational` для героев; 8–15 с речи; **без цифр** — сверка строгая). Изменение текста → новая `version`.
- Число кандидатов по умолчанию 3 (максимум 5). Seed каждого — случайный, сохраняется в метаданных и в `reference.seed`.
- Загрузка своего образца: `POST /voices/:id/references/upload` (сырое тело `audio/wav|mpeg|ogg|flac`, ≤ 20 МБ)
  → файл в `uploads/`, задача `voice_reference` в режиме `upload`: `LoadAudio(образец)` →
  `SaveAudioAnimastorReference` (та же нормализация + Whisper). `ref_text` = транскрипт Whisper; пользователь
  может поправить его перед закреплением (`ref_text_source: user`).

## 5. Проверка кандидата

### 5.1 Нормализация и длительность

WAV PCM s16le, mono, 24 кГц, bit-exact (без тегов кодировщика). Длительность 4…20 с
(`MIN_DURATION_SEC`/`MAX_DURATION_SEC`); вне границ → `too_short` / `too_long`.

### 5.2 Строгая сверка транскрипта (policy 1)

Обе строки: NFC → casefold (нижний регистр, ß→ss) → ё→е → пунктуация и символы → пробел → схлопнутые
пробелы. Совпадение — **равенство**. Иначе `transcript_mismatch` → `verification: failed`.
Изменение правил → новый `comparison_policy_version`. Whisper запускается **без** подсказки (prompt) —
ASR не должен знать фразу, с которой его сверяют.

### 5.3 sha256

Считает **backend** по файлу ровно в том виде, в котором он хранится и уходит в `LoadAudio`.
Чанк `LIST/INFO` вырезается при сохранении (канонический файл = `RIFF/WAVE` + `fmt ` + `data`): так
`LoadAudio` читает простой PCM, а sha256 зависит только от звука.

## 6. Озвучка

### 6.1 Workflow

| Workflow | Граф | Модель |
|---|---|---|
| `tts-qwen-narrator` | `LoadAudio(ref)` → `VoiceClonePrompt(ref_text)` → `Qwen3TTSVoiceClone(target_text, target_language)` → `SaveAudioMP3` | Base |
| `tts-qwen-dialogue` | слот = `LoadAudio(ref)` → `VoiceClonePrompt`; `RoleBank` → `AdvancedDialogue`; неиспользуемые слоты удаляются из графа | Base |
| `tts-qwen-voice-reference` | `VoiceDesign(описание, фраза, язык, seed)` → `SaveAudioAnimastorReference` | VoiceDesign |
| `tts-qwen-voice-transcribe` | `LoadAudio(образец)` → `SaveAudioAnimastorReference` | — |

Язык книги (`book.language`) → `target_language` нарратора, язык VoiceDesign и ASR, выбор фразы.
`instruct` на Base-клоне `qwen-tts` 0.1.1 игнорирует (kwargs проглатываются) — подачу несёт референс.

### 6.2 Голос говорящего; нет референса — 409

- Нарратив и эпизодические говорящие (метка не является голосом книги) → голос нарратора сцены
  (`narratorVoiceId`: `scene.audio.voice`, иначе `book.defaults.narration_voice`, иначе `narrator`).
- Реплика героя, у которого есть запись голоса → его голос.
- Планировщик собирает **все** голоса области команды; если хоть у одного нет годного закреплённого
  референса — команда **не создаётся**: `409 {code:'voice_reference_required', character_ids, reasons}`
  (`missing | unlocked | not_verified | file_missing | sha_mismatch | malformed`). Фолбэка нет.
- Смена закреплённого референса меняет имя входа `vref_<sha>` → снимок workflow → `scene_hash`:
  сцены считаются неготовыми и перегенерируются следующей командой. Dirty-grammar `book.voices`
  реагирует только на закреплённый референс (sha256 / ref_text), не на правку `timbre`/`manner`.

### 6.3 Legacy-оркестрация

Аудио делает только orchestration v2 (референсы приходят воркеру как `input_files` protocol 3).
`generateSceneAudio` legacy-пути возвращает `{generated:false, reason:'voice_references_require_v2'}` и ничего
не отправляет. API референсов для legacy-книги → `409 book_not_v2`. Перевод книги — `books.orchestration='v2'`
(ADR `ORCHESTRATION_V2.md` §12) или переимпорт текста.

### 6.4 Оркестрация: kind `voice_reference` (`@animastor/orchestration` 1.4.0)

- `gen_jobs.kind = 'voice_reference'`, executor `gpu:audio`, слой `audio` (тип воркера); `chapter_id = '_voices'`,
  `scene_id = character_id`, `unit_key = candidate_id`. Не сценовый ассет: приём не пишет `scene_assets`, переходов нет.
- `gen_commands.kind = 'voice_reference'`, `layers = ['audio']`, `scope = {level:'book', voice:{…}}`;
  layer-config книги не применяется. Планировщик хоста получает `planCtx.kind`.
- Миграция `005-voice-reference` (новые определения CHECK). Таймаут 15 мин. WAV-валидатор: RIFF/WAVE, PCM s16, не тишина.
- Стоп слоя `audio` (cancel-worker / layer-config) снимает и задачи `voice_reference`.

## 7. Контракты воркера

### 7.1 Контракт результата воркера

Задача возвращает **один файл**: первый вывод (`ui.audio[0].filename`) первого узла, чей `class_type`
начинается с `SaveAudio` (`worker.cjs` `findOutputNodes`/`waitResult`, комментарий там же). Своя нода
включается в этот контракт именем класса — `SaveAudioAnimastorReference`. Менять выбор результата — только
вместе с этим документом.

### 7.2 Нода `SaveAudioAnimastorReference`

`animastor-worker/comfyui-nodes/animastor-voice-ref` (MIT). Входы: `audio`, `filename_prefix`, `language`,
`whisper_model` (`small`|`medium`), `device` (`auto`|`cuda`|`cpu`), `compute_type` (`auto`|`float16`|`int8_float16`|`int8`).
`device=auto`: CUDA float16, при ошибке — CPU int8; фактическое устройство пишется в JSON.
JSON (UTF-8, в `LIST/INFO/ICMT` после `data`): `schema`, `node_version`, `duration_sec`, `sample_rate`, `channels`,
`language`, `verification_model`, `faster_whisper_version`, `ctranslate2_version`, `asr_transcript`, `asr_language`,
`asr_language_probability`, `words [{w,start,end,p}]`, `whisper_device`, `compute_type`, `fallback_errors`.
Идея нормализации — LocalText2Voice (MIT), код не заимствован.

### 7.3 Входные файлы

Референсы чанка и загруженный образец — `task.input_files` (protocol 3, worker ≥ 2.5.0): ссылка + токен
задачи, проверка sha256 и размера, файл в `COMFY_INPUT_DIR` под именем `vref_<sha256[:32]>.wav` /
`vupl_<sha256[:32]>.<ext>`, удаляется после задачи. Кэша на воркере нет (файл ~0,5–1 МБ).

## 8. API

Все пути — `/api/v1/book/:bookId/…` (охрана владения книгой как у остальных book-маршрутов):

| Метод | Путь | Что |
|---|---|---|
| GET | `/voices/references` | голоса: `timbre`, `manner`, `timbre_source`, `design_description`, `reference`, `reference_status`, `phrase`, `candidates` |
| POST | `/voices/references/candidates` | `{character_ids?, count?, client_action:{action_id}}`; без ids — все голоса без годного референса; закреплённый → 409 `reference_locked` |
| POST | `/voices/:id/references/upload?action_id=` | сырое аудио → кандидат `uploaded` |
| GET | `/voices/:id/references/candidates/:cand/audio` | прослушать (`audio/wav`) |
| DELETE | `/voices/:id/references/candidates/:cand` | удалить (не закреплённый, не в работе) |
| POST | `/voices/:id/reference` | `{candidate_id, ref_text?}` — выбрать и закрепить |
| DELETE | `/voices/:id/reference` | открепить (файлы кандидатов остаются) |

Без `action_id` → `400 no_user_action`. `PATCH /voices/:id` (редактор) меняет только `timbre`/`manner`.

## 9. Фронты

- **Web** (`features/voices`): блок во вкладке «Голоса» — статус, «Создать референсы голосов», кандидаты с плеером,
  транскрипт, «Выбрать и закрепить», «Загрузить свой файл» (с правкой ref_text), «Открепить», «Удалить»;
  опрос раз в 5 с, пока есть кандидаты в работе. Генератор показывает 409 `voice_reference_required`.
- **Android**: редактирует `timbre`/`manner`; блок референсов — **GAP** (`ANDROID_WEB_PARITY.md`).
- Полная «карточка героя» — отдельная задача.

## 10. Модели и установка (`audio/qwen-tts`, ревизия 2026.11.12-r1)

- Нода `animastor-voice-ref` — из **подкаталога** репозитория (`install.source.subdirectory`, commit-пин);
  установщик 0.2.11 пишет `.animastor-source.json`, проба читает его.
- `faster-whisper==1.2.1`, `ctranslate2==4.6.0` (ветка CUDA 12 / cuDNN 9, как torch cu128 образа).
  Путь CUDA на V100 (sm_70) — проверяется вживую; иначе CPU int8 (`small` на 15 с — приемлемо).
- **V100 (sm_70): torch не выше 2.10 для сборок CUDA 12.8.** Начиная с PyTorch 2.11 бинарники cu128/cu129 больше не
  содержат Volta (compute capability 7.0) — ради cuDNN 9.15.1; V100 остаётся только на cu126. Значит в образе
  `audio/qwen-tts` либо `torch<=2.10` + cu128, либо cu126-сборка (она публикуется до 2.14 включительно — с 2.15
  cu126 больше не выходит). Обновление образа поднимает torch только по этому правилу; проверка вживую —
  `torch.version.cuda` и `torch.cuda.get_device_capability()` на самой ноде. Источник: release notes PyTorch 2.11.0
  (2026-03-23, «Volta (SM 7.0) GPU support removed from CUDA 12.8 and 12.9 binary builds») и анонс 2026-01-15;
  проверено 2026-11-13. Симптом нарушения — `no kernel image is available for execution on the device` на V100.
- Модель `Systran/faster-whisper-small` (4 файла, ревизия и sha256 закреплены) → `ComfyUI/models/whisper/faster-whisper-small`
  (на E2E это `/home` — переживает перезапуск).
- VRAM: каждый workflow грузит одну 1.7B-модель → `gpu_min_vram_gb` 12 → 8 (оценка, не замер).
- `SaveAudioMP3` и `LoadAudio` — ноды ядра ComfyUI.

## 11. Чего нет (сознательно)

- Нет VoiceDesign на каждый чанк и нет фолбэка на него; нет LLM-переписывания описаний.
- Нет копии 48 кГц; нет кэша референсов на воркере.
- Нет аудио на legacy-оркестрации.
- Нет автоматического создания кандидатов (только явная команда).
