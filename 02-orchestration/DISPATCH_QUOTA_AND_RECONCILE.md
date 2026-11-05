# Квота диспатча, lease и reconcile

Состояние на `@animastor/orchestration` 0.3.5 (2026-11-05). Основание — инцидент BA
`ba_1788172242081`: `reports/2026-11-05/live-check-A-B-C.md` §6, §10,
`reports/2026-11-05/reconcile-quota-leak.md`.

## Модель

Один диспатч стадии сцены (`dispatch-engine.dispatchStage`) владеет тремя ключами Redis:

| Ключ | Что | Кто создаёт |
|---|---|---|
| `animastor:runtime:active-<stage>` | счётчик занятых слотов (без TTL), лимит `MAX_ACTIVE_<STAGE>` (audio 8, image 4, video 2) | `acquireQuota` (Lua: check + INCR) |
| `animastor:dispatch-lease:<book>:<ch>:<sc>:<stage>` | lease с токеном, TTL = lease TTL стадии (audio 1860 с) | `acquireStageLease` |
| `animastor:dispatch-meta:<book>:<ch>:<sc>:<stage>` | `dispatch_id`, `lease_token`, `quota_owned`, `status`, `started_at`, `jobs_enqueued` (0.3.5) | `setDispatchMetadata` |

Снимаются все три **только** через `finalizeDispatch` — один Lua-claim (meta совпадает,
lease у владельца, маркер завершения NX, DEL meta, DEL lease, DECR квоты если
`quota_owned`). Повторная финализация идемпотентна (`already_finalized` /
`no_active_dispatch`).

## Инвариант: каждый исход диспатча финализируется

| Исход executor'а | Финализация |
|---|---|
| `dispatched: true` (jobs ушли в хаб) | по результату: completion callback → `completeStage` (success) / `failStage` (failure); meta получает `jobs_enqueued: true` |
| `completed: true` без jobs — `already_done`, `recovered_via_completeChunk`, `cache_hit`, `scene_not_found`, `already_ready`, `no_segments` | **сразу** `finalizeDispatch(success, completed_without_jobs:<reason>)` (0.3.5; раньше — никогда, слот висел до stale-lease recovery) |
| без jobs и не `completed` — `no_jobs_generated`, capacity (`no_worker_available`, `duplicate_pending`, …), `already_done_rejected:*` | `finalizeDispatch(cancelled)` (+ ограниченная отсрочка для capacity) |
| исключение executor'а | rollback стадии → `finalizeDispatch(cancelled)` |
| backpressure (`acquireQuota` отказал) | ничего не захвачено — финализировать нечего |

Почему слот берётся **до** проверки `already_done`: проверка и завершение стадии
(`completeStage`) требуют живой identity диспатча (`verifyDispatchIdentity` по meta),
иначе поздний/параллельный результат мог бы записать READY мимо фенсинга. Слот держится
только внутри одного синхронного вызова `dispatchStage` (миллисекунды) и в нём же
освобождается — на следующую сцену того же тика он уже свободен.

## Stale-lease recovery (`reconciliation-engine`, действие `RELEASE_STALE_LEASE`)

Раз в минуту reconcile ищет lease старше порога и, если стадия под активной командой:

1. `cancelActiveDispatch(..., 'stale_lease_recovery')` — канонический путь (квота
   освобождается, если meta её владела; `CANCEL_ORPHAN_LEASE` — lease без meta);
2. уборка копий в хабе по `dispatch_id`;
3. стадии в `GENERATING`/`PENDING` → `markDirtyScene` (DIRTY, bump эпохи, PG `stale`) —
   **кроме** стадии с подтверждённым коммитом текущего поколения: PG `ready` +
   `isSceneAudioCommitted(...).ready` (`isStageCommittedReady`, audio). Такая стадия только
   переутверждается READY в Redis (лог `STALE_LEASE_COMMITTED_KEEP`). До 0.3.5 recovery
   понижал её — на BA так в `stale` ушли 13 сцен с настоящим аудио.

## Сверка счётчика (`counter-reconciliation`, каждый тик)

1. **Фантомные диспатчи** (0.3.5): lease + meta с тем же токеном, **без** `jobs_enqueued`,
   **без** job этого `dispatch_id` в хабе (`animastor:running`, любые `animastor:queue:*`),
   старше 2 мин. Кандидат помечается (`animastor:dispatch-phantom-suspect:<id>`, 15 мин) и
   на **следующем** прогоне отменяется `cancelActiveDispatch(..., 'phantom_dispatch')` —
   лог `PHANTOM_DISPATCH_CANCELLED`. Lease без meta не трогается (владение неизвестно).
2. Счётчик приводится к числу оставшихся lease (`COUNTER_DRIFT` / `COUNTER_RECONCILED`).

До 0.3.5 был только шаг 2: утёкший счётчик совпадал с числом утёкших lease (8 = 8) —
«0 drift» при нуле работающих задач.

## Планировщик: задача без движения

- backpressure, а живых heartbeat воркеров типа нет ни в одном scope
  (`worker-health.getAnyAliveCount = 0`) → `blockStageNoWorker` (задача `blocked`
  `no_worker:<type>`);
- исход не `dispatched`, не `completed`, не backpressure/throttled и не capacity →
  `noteNoProgress` (`animastor:dispatch-noprogress:<book>:<ch>:<sc>:<stage>`, TTL 1 ч);
  ≥ 3 попыток и ≥ 5 мин с первой → `failStageNoProgress` (задача `failed`,
  `error_class=no_progress`). Любой реальный dispatch или завершение сбрасывает окно.

Статусы и отображение — `architecture/COMMAND_ONLY_GENERATION.md` §«Задача не висит и не
исчезает молча».

## Логи для разбора

```
[DISPATCH] LEASE_ACQUIRED / DISPATCH_SKIPPED … - <reason> / FINALIZE_SUCCESS … (completed_without_jobs:<reason>)
[DISPATCH] BACKPRESSURE_DELAY: … (active=N/M)
[RECONCILE] STALE_LEASE_COMMITTED_KEEP: … audio — committed + PG ready, not demoted
[DRIFT] ⚠️ PHANTOM_DISPATCH_CANCELLED: … (no jobs, no hub job, quota_owned=…, quotaReleased=…)
[DRIFT] COUNTER_RECONCILIATION_COMPLETE: N corrected, D total drift[, K phantom dispatch(es) cancelled]
[COMMAND-GATE] BLOCKED … — нет воркера audio / FAILED_NO_PROGRESS … reason=…
[AUDIO] READY_RESTORE: … scene_assets.status=stale with committed chunks [..] — finishing without GPU, version gate decides
```

## Восстановление прод-состояния

`scripts/recover-reconcile-quota-leak.sh` (backend): `--dry-run` (по умолчанию, только
чтение), `--apply` (только при orchestration ≥ 0.3.5 в контейнере; бэкап ключей Redis и
строк PG в `backups/rql-<UTC>/`; удаляет фантомные meta/lease книги, выставляет счётчик по
живым диспатчам; PG не пишет), `--rollback <dir>`. С исправленным кодом фантомы снимает и
сама сверка счётчика (шаг 1) — скрипт нужен для проверки и ускорения.
