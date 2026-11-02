# Публикация GPU-результата: fence, manifest, recovery

> **Статус:** Current (2026-11-02). Реализация: animastor-backend
> `backend/src/services/result-publication.cjs`, `task-handler.cjs`,
> `helpers/queue-idempotency.cjs`.
> **История решений:** `history/reorganization/2026-10/125-…`, `131-…` (staged
> artifacts & fenced commit), `135-…` (маркер публикации), `137-…`
> (content proof). Этот документ фиксирует действующие правила. История
> лежит в `history/`.
> **Основание правок 2026-11-02:** `reports/2026-11-02/gpu-e2e-installer-025-logs.md`
> §6.2, §8 п.1–2.

## Протокол одного результата

1. **stage**: байты результата пишутся в
   `{OUTPUT_DIR}/{build}/.staging/{job}/{fence}/artifact.<ext>`. Canonical
   при этом не меняется.
2. **commit**: атомарный Lua-вердикт по intent-записи
   (`queue-idempotency.fenceCommitResult`). При `committed` пишется
   **manifest** `animastor:artifact-manifest:<task>` с content proof
   (`sha256`, `bytes`) staged-байтов.
3. **publish**: rename staged → canonical под publication lock. Маркер
   `animastor:fence-publish:<task>` проходит стадии `renaming` →
   `published`, в маркере тот же proof.
4. **resume** (каждый reconcile-цикл, 60 с,
   `resumePendingPublications`): по manifest + done-маркеру доигрывает
   прерванные публикации и решает только по durable-состоянию, а не по
   факту наличия файла.

## Инвариант: canonical меняется только внутри fence

Байты canonical-файла после публикации равны proof из manifest этого fence.
Никакой код после commit не переписывает canonical на месте.

**Trim дополненных TTS-чанков (2026-11-02).** Короткий текст отправляется
на TTS удвоенным (`padShortText`), и половина звука обрезается. Раньше обрезка
шла при merge, **после** fenced commit, и перезаписывала canonical по тому же
пути. Manifest оставался от версии до trim. Теперь:

- `task-handler` обрезает чанк с `padded_text` **до staging**
  (`audio.trimPaddedAudioBuffer`: ffmpeg `-c copy` над приватной temp-копией,
  детерминированно, при сбое возвращает исходные байты). Manifest, staged и
  canonical описывают уже обрезанный файл;
- `audio-orchestrator.completeChunk` больше не обрезает и не переписывает
  чанки, а только склеивает их.

Повторная доставка того же fence даёт те же байты (stream copy), поэтому
`duplicate_same_fence` безопасен.

Ограничение: чанки, закоммиченные до выкатки и ещё не склеенные, склеятся с
повтором (обрезки при merge больше нет). Это касается только сцен, которые
были в полёте в момент выкатки.

## Терминальный исход: fence unrecoverable

Если canonical не совпадает с proof своего fence, а staged-копии нет
(`canonical_content_mismatch`), опубликовать нечего. Раньше resume повторял
такую попытку каждые 60 с бесконечно (22 повтора за 21 мин 02.11).

Теперь:

- при первой встрече resume пишет
  `animastor:fence-unrecoverable:<task>` =
  `{fence, reason:'canonical_content_mismatch', at, job_id, expected_sha256,
  expected_bytes}` (без TTL, как и manifest) и выдаёт **один** warn;
- в следующих циклах этот fence пропускается молча (`unrecoverable` в
  счётчиках resume, не `errors`);
- запись привязана к fence: новый fence той же задачи (новая команда)
  обрабатывается как обычно;
- успешная публикация задачи (в том числе повторная доставка, которая заново
  стейджит тот же fence) удаляет запись;
- canonical, manifest и маркер не удаляются, они остаются как свидетельство.

Ключ зарегистрирован в `backend/tests/architecture/redis-registry.js`.

Разовая чистка fence `3227a8b2c281` (`ba_1788172242081_…_sc-e7ee903c_0001:audio`,
02.11) вручную не делается: по решению владельца после выкатки backend
этот fence помечается автоматически.
