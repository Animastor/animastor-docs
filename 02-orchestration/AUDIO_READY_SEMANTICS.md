# Готовность аудио: `ready` — это коммит GPU, а не файл

**Статус:** принято 04.11.2026. Backend `2e3bc91` + интеграция `b4c5847` (merge `3ba7862`),
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
   В `generateSceneAudio` дополнительно нужна запись PG `status='ready'`, а Redis-состояние
   `pending`/`dirty` отменяет fast-path.
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

## Где что лежит

| Что | Файл |
|---|---|
| Маркер (чтение/запись) | `backend/src/audio/placeholder-marker.js` |
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
