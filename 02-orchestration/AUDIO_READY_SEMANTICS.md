# Готовность аудио: `ready` — это коммит GPU, а не файл

**Статус:** принято 04.11.2026. Backend `2e3bc91` + интеграция `b4c5847` (merge `3ba7862`) +
снятие маркера `c577a22` (merge `6fbb191`),
`@animastor/orchestration` **0.3.4**.
**Основание:** `reports/2026-11-04/audio-placeholder-ready.md` (сцена
`ba_1788172242081` / `ch-5e5a8c76` / `sc-4bb85e02`), интеграция —
`reports/2026-11-04/integration-A-B-C.md`.
**Владелец:** аудио-контур backend (`backend/src/audio`, `backend/src/services/placeholder-audio.js`)
и гейты оркестрации (`@animastor/orchestration`: `scene-orchestrator`, `scene-callbacks`).
Копия в репозитории backend: `docs/audio/ready-semantics.md`.

## Что случилось

Аудио сцены было `ready`, плеер играл 10,85 с тишины, а каждая команда «аудио» отвечала
`already_ready` / `already_done`. GPU-задача не создавалась ни разу:

```
[AUDIO] findExistingSceneChunks: enumerated 0/1 chunks: []
[AUDIO] Audio already ready, no generation needed: …/sc-4bb85e02
[AUDIO-ORCH] … MERGING → DONE
[PLACEHOLDER-AUDIO] Audio in status stale … — updating to ready
[ORCH] [COMPLETE-STAGE] … audio → READY
```

Это был валидный MP3 из тишины, созданный при импорте (87 021 Б, `max_volume -91 dB`).
Проверка готовности спрашивала только «есть ли канонический файл и парсится ли он».

## Инварианты

1. **Заглушка — никогда не настоящее аудио.** Всё, что делает
   `audio/silence.js#generateSilentAudio`, получает sidecar `<canonical>.placeholder.json`
   (`kind: "animastor-placeholder"`). Помеченный файл не бывает `ready`, `already_ready`,
   `already_done` при любом размере, длительности и статусе в БД. Маркер переживает
   расхождение PG/Redis — ровно тот случай, что произошёл.
2. **`ready` требует коммита GPU текущего поколения.** Доказательство — чанки сцены на диске
   (`…_0001.mp3`, …), которые оставляет staged→canonical публикация результата GPU.
   `validation.isSceneAudioCommitted(buildId, bookId, chapterId, sceneId, expected|null)` →
   `{ready, reason, chunks, path}` требует:
   - канонический файл есть, парсится и **не** помечен как заглушка;
   - на диске есть хотя бы один чанк сцены (при известном числе — все 1..N, размер > 0).

   Причины отказа: `placeholder_marker`, `no_canonical`, `canonical_invalid`,
   `no_committed_chunks`, `missing_chunks`, `incomplete_chunks`; успех — `committed`.
   В `generateSceneAudio` дополнительно нужна запись PG: `ready` — обычный fast-path
   (Redis-состояние `pending`/`dirty` его отменяет); `stale` / `pending` / `dirty` при
   подтверждённом коммите — **восстановление без GPU** (`READY_RESTORE`, orchestration 0.3.5,
   см. ниже); нет строки или `placeholder` — отказ (`READY_REJECTED`).
3. **В `ready` поднимает только путь коммита.** `replacePlaceholderWithRealAudio()` требует
   `{ committed: true }` и сразу отказывает помеченной заглушке (запись → `placeholder`).
   Ветка «файл больше 8192 Б ⇒ зарегистрировать как ready» **удалена**.
4. **FSM `DONE` сам по себе не авторитетен** (orchestration 0.3.4). `AUDIO_ALREADY_DONE` и
   safety-net «stale `DONE`» пропускают работу только при подтверждённом коммите; иначе
   лог `AUDIO_ALREADY_DONE rejected …`, состояние удаляется, стадия уходит на GPU. Пробник
   недоступен или упал → «не закоммичено» (fail-closed: лишняя генерация безопасна, пропуск — нет).
5. **Записи чанков следуют за файлами.** Ветка `already_ready` пишет `audio_status:'ready'`
   только чанкам, файлы которых есть на диске.
6. **Один предикат для вопроса «аудио сцены настоящее?»** (интеграция A+B).
   `placeholder-audio#hasRealAudio` — им reconcile (восстановление фактов asset-state),
   scene-window и scene-restoration восстанавливают `ready` — это `status='ready'` **и**
   `isSceneAudioCommitted(...).ready`. Поэтому `ready`-строка над старой заглушкой без sidecar
   (созданной до маркера) и без чанков — тоже не настоящее аудио.

7. **Публикация снимает маркер.** `audio/pipeline#buildSceneAudio` (merge и recovery из чанков)
   и single-chunk fallback в `services/audio-orchestrator` удаляют sidecar, когда настоящее аудио
   пишется по каноническому пути, где лежала заглушка. Без этого любая сцена, чья заглушка
   создана после фикса, навсегда оставалась бы `placeholder_marker` (backend `c577a22`).

> **Зависимость: чанки должны сохраняться.** Инвариант 2 считает доказательством коммита чанки
> сцены на диске. `buildSceneAudio` удаляет чанки после merge, если не задан `KEEP_AUDIO_CHUNKS`
> (по умолчанию в коде — **выключено**). При удалении чанков пробник сразу после merge отвечает
> `no_committed_chunks` и для настоящего аудио. На проде чанки сохраняются (04.11 у всех реальных
> `ready`-сцен они были на диске), но так должно быть в любом окружении с этим backend —
> открытое решение владельца, `reports/2026-11-04/integration-A-B-C.md`.

8. **Закоммиченное аудио текущего поколения не перегенерируется и не понижается**
   (2026-11-05, orchestration 0.3.5, `reports/2026-11-05/reconcile-quota-leak.md`).
   Кнопка «Генерировать аудио → Вся книга» доделывает недостающее, готовое не трогает.
   - `stale`-сцена с коммитом: `generateSceneAudio` → `already_ready` (лог `READY_RESTORE`) →
     `completeStage` под живым dispatch; **version gate** (версии контента и аудио-конфига
     текущего поколения) решает: прошёл — PG `ready` + asset READY без GPU, не прошёл — DIRTY,
     коммит не поднимается. Раньше такая сцена уходила в per-segment путь, где каждый чанк —
     cache hit, и получала `no_jobs_generated` бесконечно (13 сцен BA).
   - FSM `DONE` + коммит (`AUDIO_ALREADY_DONE`) завершает стадию тем же `completeStage`, а не
     просто «пропускает» (иначе asset оставался PENDING и его подхватывал stale-lease recovery).
   - recovery `completeChunk` идёт с живым `dispatchId` (был литерал `stale-recovery` →
     `COMPLETE-STAGE Rejected … stale_dispatch`, чанки `ready`, стадия `stale`).
   - stale-lease recovery не помечает DIRTY стадию с PG `ready` + коммитом
     (`reconciliation-engine.isStageCommittedReady`).

   Предикат готовности остаётся один — `isSceneAudioCommitted` (инвариант 2); задача G
   (доказательство коммита в PG) расширяет его там же.

## Где что лежит

| Что | Файл |
|---|---|
| Маркер (чтение/запись) | `backend/src/audio/placeholder-marker.js` |
| Снятие маркера при публикации | `backend/src/audio/pipeline.js` (`buildSceneAudio`), `backend/src/services/audio-orchestrator.js` |
| Маркер при создании тишины | `backend/src/audio/silence.js` (`generateSilentAudio`) |
| Пробник коммита | `backend/src/audio/validation.js` (`isSceneAudioCommitted`) |
| Решение `already_ready` | `backend/src/audio/generation.js` (`generateSceneAudio`) |
| Подъём в `ready`, создание заглушки, `hasRealAudio` | `backend/src/services/placeholder-audio.js` |
| Пробник после завершения | `packages/animastor-orchestration/src/orchestration/scene-callbacks.js` |
| Гейт `AUDIO_ALREADY_DONE` | `packages/animastor-orchestration/src/orchestration/scene-orchestrator.js` |

Контракт хоста для пакета (обратно совместимо): `media.audio.isSceneAudioCommitted(...)`;
`placeholderAudio.replacePlaceholderWithRealAudio(…, realDuration, options)` с
`options.committed`. Без нового пробника пакет откатывается к file-only проверке.

## Исправление данных

Строки, уже поднятые в `ready` над заглушкой, автоматически **не** переводятся.
`scripts/fix-fake-ready-audio-20261104.sql` (backend) готовит, но не выполняет обратимый
`status → 'stale'` с бэкапом для сцены, найденной 04.11. Запускать **после** выкатки: на
старом коде `stale`-запись всё равно поднималась в `ready`.

## Что закрыто

- тишина любой длины («больше 2-секундной заглушки ⇒ настоящее аудио») — удалено;
- строка PG потеряна или устарела, файл остался — маркер и отсутствие чанков всё равно отказывают;
- прерванный запуск оставил `DONE` без чанков — гейт снова открывает стадию;
- команда «аудио», навсегда заблокированная `already_done`, — тот же гейт;
- reconcile, восстанавливающий `ready` по старой заглушке без маркера, — инвариант 6.
