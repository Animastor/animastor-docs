# Stage 140 — Архитектурное решение: публикация GPU-результатов

**Статус: PASS** (аудит и архитектурное исследование; production-код не изменён)

**Рекомендация: вариант A с удалением файлового слоя блокировки («A-min»)** — сохранить
Redis-authority fencing (intent/receipt/ЛюА-commit/manifest/marker/sha-proof/recovery) как
доказанно необходимый минимум, удалить подсистему файлового publication-lock
(owner/claim/reclaim/tomb-GC), заменив её сериализацией в одном процессе с принудительно
обязательным однопроцессорным (single-publisher) инвариантом. Вариант B (неизменяемые пути +
атомарный указатель в PostgreSQL) — правильная долгосрочная цель, но её корректность сейчас
зависит от недоказанных/недоступных предпосылок (см. §7, §12); реализация B отклоняется до
выполнения явных предусловий. Публикация считается закрытой темой по критериям §11.

---

## 0. Метод и границы достоверности

- Источники: локальный git (15 коммитов `8b375dc0..c500b221`), исходники backend и packages,
  тесты backend/tests, docker-compose, прокси-конфиги. Отчёты предыдущих стадий НЕ
  принимались на веру: каждое заявление ниже подтверждено по исходнику (файл:строка) или
  по факту запуска/истории git.
- **Документ contract 126 (и docs/* вообще) в этом репозитории отсутствует**: коммит
  `8a997966 docs: move documentation to the animastor-docs repository` перенёс документацию в
  отдельный репозиторий `animastor-docs`, который локально недоступен. Все ссылки «contract
  126 §x» ниже проверяемы ТОЛЬКО через комментарии в коде и утверждения тестов — сам текст
  контракта воспроизвести здесь нельзя (§12, неопределённость U1).
- Ограничения соблюдены: без изменений production-кода, без push/deploy, посторонние
  незакоммиченные изменения не тронуты.

## 1. Фактическое состояние

### Git

| Проверка | Результат |
|---|---|
| HEAD | `c500b221` (фиксируется: `fix(gpu-publication): claim-gated lock reclaim + deadline-honoring acquire loop (stage 139 …)`) |
| Коммит `c500b221` существует | да (`git cat-file -t` → commit), это Stage 139 поверх `5ea37b91` (Stage 137) |
| Рабочее дерево | те же 10 предсуществующих записей, что и до Stage 139 (` D backend/scripts/audit-orphan-books.js`, 8 ` M`, 2 untracked) — в коммит Stage 139 включён ровно 1 файл |
| Remotes | `origin` = локальный bare `/home/animastor/repos/animastor-backend.git`; `github` = `git@github.com:Animastor/animastor-backend.git`; upstream = `origin/main` |
| Локально vs публичный GitHub | `github/main` = `origin/main` = `53ce5045` («ci(backend): approve 78e8f1ae … (stage 105)»); локальный HEAD **на 15 коммитов впереди, 0 позади** (чистый fast-forward) |
| Содержание расхождения | **весь стек fencing (stages 114–139) существует только локально**: на `github/main` файла `result-publication.cjs` и `publication-lock.cjs` НЕТ (`git cat-file -e` → fatal). 12 из 15 незапушенных коммитов трогают `result-publication.cjs` / `publication-lock.cjs` / `queue-idempotency.cjs` |

Вывод: коммит `c500b221` подтверждён локально и происходит из проверяемой локальной
истории; к публичному GitHub он не относится, и весь публикационный стек локально-эксклюзивен.

### Деплой (важно для выбора архитектуры)

- `docker-compose.yml:45–87`: сервис `backend` — **один контейнер** (`container_name:
  animastor-backend`, без `replicas`), монтирует `./data/output:/data/output` — **единственный**
  потребитель файловой системы артефактов.
- `gpu-hub` (строка ~116) и воркеры монтирования `/data/output` не имеют; воркеры доставляют
  байты результатов только через callback в backend (`docker/worker/*` — ни одной привязки к
  OUTPUT_DIR нет).
- Скрипты/CLI, вызывающие `publishCommittedFence`/`commitFencedResult`/`resumePendingPublications`/
  `handleTaskResult` вне backend-сервиса: **не найдены** (`backend/scripts`, `scripts`, `docker` —
  пусто).
- Следовательно, **процессов-писателей канонического пути ровно один** (backend-контейнер).
  Это — факт текущего деплоя, а не доказательство на все времена; см. §7 enforcement.
- `deploy/` (untracked, посторонний) содержит overlay «backend standalone» — там тоже один
  backend (`deploy/overlay-backend-standalone.yml:36`).

## 2. Текущий поток публикации (вариант A) — схема с точками записи

```
Диспатч:  gpu-dispatcher → qidem.ensureIntentAndReceipt (Redis: intent + неизменный receipt)
          → POST в GPU Hub (bytes уходят воркеру)
Результат: воркер → callback → generation-routes.cjs:560
          → taskHandler.handleTaskResult(job, b64, build, dispatch, {fence})
Коммит:   task-handler.cjs:110–130 — fence ТОЛЬКО из receipt (resolveDispatchFence,
          queue-idempotency.cjs:903) или явного opts.fence; отсутствует/битый → отказ
          (receipt_missing/corrupt), legacy-запись достижима только через
          GPU_FENCING_MODE=off (task-handler.cjs:185–203, contract 126 §6).
          task-handler.cjs:135 → resultPublication.commitFencedResult
          (result-publication.cjs:816):
            1) stageResult (:322): FS `<build>/.staging/{enc(jobId)}/{fence}/artifact.ext`,
               tmp → fsync → rename → fsync dir (атомарно в пределах ФС);
            2) qidem.fenceCommitResult (queue-idempotency.cjs:1740, Lua
               FENCE_COMMIT_SCRIPT :1683): атомарно проверяет intent (KEYS[1]) →
               пишет manifest (`animastor:artifact-manifest:…`, :1586), done-маркер,
               журнал, снимает claim; при несовпадении fence → `stale_intent` и
               удаление СВОИХ staged (никаких других записей);
            3) publishCommittedFence (:466) под cross-process FS-lock
               (publication-lock.cjs: acquirePublicationLock/withPublicationLock):
               §1 перечитывание intent внутри лока → §2 доказательство manifest
               (sha256+bytes) → §3 маркер публикации (`animastor:fence-publish:…`,
               :1617; состояния renaming/published, :1649) + sha-сверка staged →
               §7 backup предыдущего canonical + durable-маркер `renaming` ДО rename →
               §8 lock.verify() → rename staged→canonical (POSIX-атомарный) →
               §9 sha-сверка canonical → §10 повторные чтения intent + verify: при
               supersede/потере лока — откат canonical из backup и отказ
               (stale_intent/publication_lock_lost) → §11 маркер `published`
               (best-effort, ремонт recovery'ом).
Готовность: task-handler.cjs:164–180 — повторная проверка intent (никакой ready-chain для
          устаревшего fence), затем побочные эффекты по типу ассета:
            · audio_chunk → deps.saveChunk (redis-helpers.cjs:24 — метаданные чанка в Redis);
            · iu_image → saveIURegistry, INCR `iu-progress`, SSE publishProgress,
              проверка IU в PG → orchestrator.completeStage;
            · completeStage (packages/animastor-orchestration/src/orchestration/
              orchestrator.js:84): verifyDispatchIdentity → handler → PG version-gate
              (T1.11 fail-closed, :152–186) → sceneAssets.markReady (:193) — PG-строка
              scene_assets (path, status=ready, версии; scene-assets-repo.js) →
              Redis-состояние ассета READY.
Recovery:  runtime-loop.js:158 — resumePendingPublications на каждом цикле реконсиляции
          (решает по manifest+done+intent, вызывает ТО ЖЕ publishCommittedFence);
          runtime-loop.js:166 — collectStaleStaging (24ч, strict Redis reads, abort при
          сбое Redis); audio-recovery.cjs:161 — verifyPublishedFence перед «уже готово»,
          :215 — handleTaskResult только после receipt-гейта.
```

### Источники истины (фактические, по коду)

| Вопрос | Источник истины | Где живёт |
|---|---|---|
| Какое поколение (fence) сейчас актуально | intent-запись | Redis, `animastor:intent:{task}` (queue-idempotency.cjs:820, TTL 14 д) |
| Что было закоммичено (bytes) | done-маркер + manifest (sha256+bytes) + staged-файл | Redis (`:1586`, :389) + FS |
| Что добралось до канонического пути | sha-сверка canonical с manifest + маркер published | FS + Redis (`:1617`) |
| Идентичность диспатча | неизменный receipt (dispatch_id, job_id) → fence | Redis, `animastor:dispatch-intent:…` (:829) |
| Бизнес-готовность сцены | версионная строка scene_assets (path, status) + version-gate | **PostgreSQL** (scene-assets-repo.js), плюс Redis-флаги состояния |
| Метаданные чанков/прогресс | chunk-ключи, iu-progress | Redis (redis-helpers.cjs:24) |

PostgreSQL — источник истины уже СЕЙЧАС для бизнес-состояния (версии сцен, scene_assets,
IU, книги), но НЕ для fence-актуальности: полномочия «какое поколение текущее» закреплены за
Redis-intent кодом и тестами (gpu-intent-fence-receipt.test.js, architecture/redis-registry.js:714,748).

## 3. Обязательные инварианты, их источники и границы обеспечения

| # | Инвариант | Граница обеспечения (механизм) | Файл:функция | Тестовые доказательства |
|---|---|---|---|---|
| I1 | Устаревший fence не заменяет более новый | 4 последовательных рубежа: Lua-сверка intent в момент коммита; перечитывание intent ВНУТРИ лока перед инспекцией состояния; повторное чтение intent ПОСЛЕ rename + откат; повторная проверка в handler перед ready-chain; фильтр superseded в resume | queue-idempotency.cjs:1683 (Lua), result-publication.cjs:486 (§1), :656 (§10), task-handler.cjs:166, :944 (resume) | gpu-result-fencing-commit.test.js; F1/F10a/F11a/F13 (audit-139/f-results.json, 27/27) |
| I2 | Одна задача не выдаёт себя за другую | Fence доказывается ТОЛЬКО неизменным receipt; idem_key не содержит dispatch_id; verifyDispatchIdentity на входе completeStage | queue-idempotency.cjs:903 (:929 «ref не используется как resolver»), task-handler.cjs:110–130, orchestrator.js:104 | gpu-intent-fence-receipt.test.js; L2-PIDREUSE/FOREIGN-HOST (audit-139/l-results.json) |
| I3 | Частично записанный артефакт не публикуется | tmp+fsync+rename при staging; публикуется только полный staged-файл (`.tmp` исключён, :389); sha-сверка staged с manifest перед rename; sha-сверка canonical после rename | result-publication.cjs:322, :386, :596 (§6), :632 (§9) | F9a (tampered staged/canonical), stage-тесты gpu-result-fencing-commit |
| I4 | Повторная доставка и recovery не нарушают корректность | done-маркер в Lua (duplicate_same_fence) идемпотентен; state-machine маркера решает, можно ли доверять canonical; resume идёт через ту же publishCommittedFence | queue-idempotency.cjs:1706, result-publication.cjs:466, :893 | gpu-queue-idempotency.test.js; F4/F5/F7/F8/F12 |
| I5 | Сбой между записью артефакта и обновлением «указателя» → безопасное восстановление | staged-байты fsync-долговечны; manifest+done пишутся ДО rename; маркер `renaming` пишется ДО rename; resume воспроизводит rename; откат через backup | result-publication.cjs:331–345, :607 (§7), :893; runtime-loop.js:158 | F8 (реальный SIGKILL), S4, L3-CRASH-* (audit-139) |
| I6 | Актуальность результата согласована с книгой/сценой | PG version-gate (fail-closed при ошибке PG) + markReady только после публикации + версионные строки scene_assets | orchestrator.js:152–193, scene-assets-repo.js | backend suite (orchestration-тесты через arch-набор), redis-registry.js:748 |
| I7 | Конкурентная публикация завершаема предсказуемо | FS-lock с единым deadline waitMs (Stage 139: нет busy-loop) + атомарный Lua-коммит + fail-closed вердикты | publication-lock.cjs (acquirePublicationLock, :340+), queue-idempotency.cjs:1740 | L1/L5 20×20 раундов + S14a/b 20/20 (audit-139), 01-core 24/24 |

Все семь инвариантов сейчас реализованы; но **механизмы перекрываются**: I1 обеспечивается
и Lua-коммитом, и четырьмя перечитываниями; I7 обеспечивается и локом, и атомарностью rename,
и fail-closed вердиктами. Эта избыточность — плата за отсутствие единой точки сериизации
(см. §5).

## 4. Вариант B — как он должен быть устроен, чтобы быть корректным

Предложение (задача): неизменяемые пути артефактов с fence в имени + атомарное условное
обновление указателя актуальности в PostgreSQL + фоновый GC.

Проверка осуществимости по фактам репозитория:

1. **Неизменяемые пути уже наполовину существуют**: staging-путь
   `<build>/.staging/{enc jobId}/{fence}/artifact.ext` (result-publication.cjs:296) — это
   ровно «путь с fence в имени». Промоушен = сделать такие пути финальными
   (`<build>/artifacts/{job}/{fence}/artifact.ext`).
2. **PG-указатель уже наполовину существует**: `scene_assets` хранит `path`, `status`,
   `scene_content_version`, `scene_audio_config_version` по ключу
   (book, chapter, scene, asset_type) и уже обновляется conditionally (version-gate +
   `markReady`, orchestrator.js:193; advisory-locks в scene-assets-repo.js:37). «Атомарное
   условное обновление в PG» — это буквально существующий `markReady` + UPSERT-семантика.
3. **Что защищать помимо указателя** (обязательный пункт задачи). Побочные эффекты, которые
   сейчас идут после публикации и в варианте B нуждаются в собственной защите:
   - `saveChunk` (Redis, redis-helpers.cjs:24) — идемпотентен (SET-семантика) → безопасен;
   - `sceneAssets.markReady` (PG) — условный (version-gate) → безопасен;
   - `iu-progress` INCR (task-handler.cjs:235) — **НЕ идемпотентен**: повторный проход
     recovery удвоит счётчик → в B требуется перевести на вычисляемый счётчик или
     SET-семантику; сегодня это скрыто тем, что recovery НЕ повторяет ready-chain
     (resume только доводит rename, а ready-chain идёт из callback-доставки);
   - `publishProgress` (SPE) — уведомление, идемпотентно;
   - «ready-chain не выполняется для устаревшего fence» в B требует сверки «мой fence ==
     текущий указатель» прямо перед побочными эффектами (как сегодня §intent-перечитывание
     task-handler.cjs:166) либо outbox-транзакции в PG.
   Вывод: B убирает сложность ФАЙЛОВОЙ фазы, но ПОЛНОСТЬЮ сохраняет фазу согласования
   побочных эффектов — «одним условным обновлением PG» корректность НЕ обеспечивается.
4. **Читатели**: канонический путь читается напрямую —
   `audio/validation.js:50` (isSceneAudioReady — проверка существования файла),
   `export-routes.cjs:41` (createReadStream), конвенция имён артефактов
   (`artifactNaming`). В B каждый читатель обязан резолвить указатель (PG-путь уже пишется
   в scene_assets.markReady, но прямые FS-проверки существования канонического файла этим
   путём не ходят). Объём читателей вне этого репозитория (фронтенд) не подтверждён (U3).

## 5. Сравнение A и B по одинаковым инвариантам

| Критерий | A (текущая) | B (неизменяемые пути + PG-указатель) |
|---|---|---|
| Независимых механизмов синхронизации | 6–7: intent-Lua-CAS, FS-lock (owner/claim/reclaim/tomb), атомарный rename, двухфазный маркер, sha-доказательства, PG version-gate, receipt-lease | 1–2: PG-CAS указателя (+ sha как опциональная проверка целостности; Redis-lease остаётся для диспатча, но перестаёт быть authority публикации) |
| Число состояний/переходов | intent(active/superseded…), done, manifest(v2), marker(renaming/published), lock(owner, claim, tomb .stale-*), staged/canonical/.previous-canonical | pointer(pending→current), неизменяемые файлы, GC-очередь |
| Гонки | главный риск — ровно тот, что дали D1–D5 (гонки конкурентных reclaimer'ов на общей изменяемой точке). Путь rename-на-общий-канонический-путь требует исключения | гонка «два публикатора переворачивают указатель» решается PG-CAS; гонка recovery↔callback — идемпотентный повтор того же UPDATE; гонка GC↔читатель — эврика по возрасту/ссылке |
| Восстановление после SIGKILL | 3 окна крэша вокруг rename, маркер-ремонт, replay rename под локом (сложно, но доказано F8/S4/L3) | 1 мутация: флип указателя. Крэш до флипа → повтор (файл неизменяем); крэш после флипа → повтор ПОБОЧНЫХ эффектов (требует их идемпотентности — см. §4.3) |
| Сбой Redis/PG | Redis-сбой = fail-closed (нельзя доказать актуальность) — уже так. PG-сбой блокирует только READY (version-gate fail-closed) | Redis-сбой перестаёт блокировать публикацию (плюс), но **PG-сбой начинает блокировать публикацию** (минус: доступность = два hard-dependency подряд) |
| Согласование с моделью данных | intent/manifest/marker — Redis-only сущности, которых нет в PG; контракт 126 закрепляет Redis-authority (по комментариям и тестам) | ложится на уже существующие scene_assets (path/status/версии) — модель не ломается, но **authority-контракт меняется** — а его текст живёт в недоступном animastor-docs (U1) |
| Риск потери/подмены | низкий ПОСЛЕ Stage 139 (доказано 27 fencing + 20×20 lock + 42 регрессии), но цена — 6 циклов аудитов (127→139), 12 коммитов из 15 незапушенных | подмена структурно исключена (неизменяемые пути + CAS); риск переехал в GC (удаление ещё читаемого файла) и в читателей (stale-указатель) |
| Эксплуатация/диагностика | 4 семейства Redis-ключей + FS-состояния + lock-каталоги + tomb-GC; расследование = корреляция marker/manifest/intent/lock | 1 PG-строка + неизменяемые файлы; проще, но диагностика требует доступа к PG там, где раньше был Redis |
| Объём тестов и сопровождения | ~3489 тестов suite + внешние harness'ы (400+ проверок concurrency); каждое изменение = тяжёлые concurrency-прогоны | новый, но МЕНЬШИЙ набор: CAS-тесты + идемпотентность побочных эффектов + GC; межпроцессные FS-гонки исчезают из области риска |

**Ключевой вывод сравнения**: сложность A порождена не fencing'ом как таковым (Lua-коммит —
простой и атомарный), а **общей изменяемой точкой — каноническим путём на FS — при
отсутствии атомарного CAS на ФС**. Вся подсистема lock/reclaim/marker-rollback существует,
чтобы сериализовать писателей этой точки. В текущем деплое писатель один (§1).

## 6. Границы упрощения — ответы на вопросы задачи

**Можно ли удалить файловый lock полностью?**
- В варианте B — да: неизменяемые пути не нуждаются в исключении, сериализация переезжает в
  PG-CAS.
- В варианте A без смены authority — **удалить можно только при enforce'ируемом
  single-publisher**. Канонический путь — общий изменяемый ресурс; при втором писателе без
  лока возможен сценарий из аудита 136 (F1: перезапись устаревшими байтами) и, хуже,
  повреждение от roll-back: `_restoreCanonical` (result-publication.cjs:257) при
  одновременном rename двух писателей восстановит backup поверх БОЛЕЕ СВЕЖИХ байтов. Поэтому
  «просто удалить» нельзя — только вместе с обязательным инвариантом «ровно один писатель»
  (§7) или вместе со сменой authority (B).
- Доказательство single-publisher из репозитория: единственный контейнер с монтированием
  /data/output (docker-compose.yml:87, deploy/*), отсутствие CLI-вызовов публикации
  (поиск по scripts/), воркеры без FS-доступа.

**Можно ли удалить publication-marker и reclaim?**
- Reclaim — производная lock'а: удаляется вместе с ним (D1–D5 исчезают как класс).
- Маркер (renaming/published) — производная ОБЩЕЙ изменяемой точки: при неизменяемых путях
  (B) окна rename-флага не существует. В A без lock маркер остаётся обязателен — он закрывает
  окно «rename состоялся, авторитет ещё не подтверждена» (I5) и обеспечивает F8/S4.

**Какие fencing-проверки всё ещё необходимы в любом случае?**
1. Receipt→fence для callback (I2) — воркеры многократны и недоверенны к идентичности;
2. Сверка «текущее поколение» перед публикацией И перед ready-chain (I1) — в B это сравнение
   с PG-указателем вместо Redis-intent;
3. Целостность байтов (sha256) — остаётся как минимум corruption-detection; как authority
   доказательства требуется только при недоверии к писателям ФС (его нет: §1),
4. Идемпотентность повторной доставки (I4) — в B: уникальный PK fence в PG
   (INSERT … ON CONFLICT) вместо done-маркера.

**Можно ли одной условной PG-транзакцией при существующей роли Redis?** Нет. Redis-intent —
authority согласно коду и тестам; перенос authority в PG без переписывания контракта
(текст недоступен, U1) и всех consumers (dispatch admission, resume, reconciliation,
debug-recovery) дал бы ДВЕ authority и новые рассинхроны. Единая PG-транзакция возможна только
как отдельный проект смены контракта (это и есть B).

**Что если файл записан, а транзакция не завершилась?** В B: неизменяемый файл-сирота, без
влияния на корректность; GC по возрасту; повтор того же fence перезаписывает тот же путь
(безопасно). В A: staged-сирота убирается collectStaleStaging (24ч, строгие чтения).

**Что если указатель обновлён, а процесс упал до остальных действий?** Окно существует И
сейчас (после rename, до saveChunk/completeStage — task-handler.cjs:205+): recovery идёт от
доставки/реконсиляции. В B оно сохраняется → требует идемпотентных побочных эффектов;
единственная сегодня неидемпотентная операция — iu-progress INCR (§4.3).

**Как исключить удаление GC ещё используемых файлов?** Ретеншн-правило с единственной
authority: в B — файл текущего PG-указателя никогда не удаляется + возрастной грейс на
случай читателей-стримеров (классическая задача, решается теми же средствами, что сегодняшний
collectStaleStaging: result-publication.cjs:995 — 24ч, строгие чтения, abort при сбое).

**Какие гарантии зависят от одного хоста/общей ФС/числа воркеров?**
- Атомарность rename и «файл виден по пути» — локальная ФС backend-контейнера (без
  распределённого NFS-кейса: только backend монтирует том);
- Число GPU-воркеров НЕ влияет на ФС-инварианты (байты приходят по сети, ФС не трогают);
  оно влияет только на I2 (receipt) — решается в Redis/PG;
- single-publisher — инвариант ДЕПЛОЯ (контейнер), не кода: без enforcement второй инстанс
  backend молча нарушит I1/I7 (см. §7).

## 7. Рекомендация (ADR)

### Решение

**Принять A-min**:
1. Сохранить без изменений: intent/receipt/Lua-коммит/manifest/marker/sha-доказательства/
   rollback/resume/GC/kill-switch — всё, что обеспечивает I1–I6 и доказано тестами
   (§3).
2. **Удалить подсистему файлового publication-lock** (publication-lock.cjs: owner.json,
   claim/reclaim, tomb `.stale-*`, verify/release, waitMs-deadline, collectStaleQuarantine —
   ~430 строк) и заменить вызовы `withPublicationLock` сериализацией в рамках одного
   процесса (async-мьютекс per task). Причина: в деплое ровно один процесс-писатель (§1),
   а вся цена lock-подсистемы — 10 дефектов за 6 циклов аудитов (129→139) — платится за
  исключение гонок между процессами, которых в текущем топологическом факте нет.
3. Сделать однопроцессорность ОБЯЗАТЕЛЬСТВОМ, а не допущением:
   - архитектурный тест: `publication-lock.cjs` удалён, ни один production-модуль не
     требует новых FS-lock примитивов (по образцу tests/architecture/*);
   - startup-guard: backend отказывается стартовать, если OUTPUT_DIR содержит
     `.publication-locks` с ЖИВЫМ владельцем-процессом другого PID (обнаружение второго
     писателя после миграции);
   - документирование инварианта в ARCHITECTURE.md (один backend-инстанс владеет томом
     артефактов).
4. Отклонить B сейчас. B остаётся целью при ВЫПОЛНЕНИИ предусловий (критерии остановки §11):
   a) контракт публикации (наследник contract 126) переиздан с PG как authority — требует
      доступа к animastor-docs (U1);
   b) закрыт пробел идемпотентности iu-progress (SET-семантика);
   c) все читатели канонических путей резолвят указатель (включая внешний фронтенд, U3);
   d) согласована availability-модель «Redis ∧ PG последовательно».

### Почему не «оставить всё как есть» (A-full)

A-full допустим и безопаснее на бумаге, но оставляет главный источник
«бесконечного усложнения» — подсистему FS-lock — в продукте, где её защищаемый сценарий
(второй писатель) противоречит фактическому деплою. A-min уменьшает поверхность дефектов на
самый дефектоёмкий модуль при сохранении ВСЕХ доказанных инвариантов и обратимости (см. §9).

### Почему не B сейчас

Корректность B зависит от предположений, которые в этом репозитории не доказуемы:
текст authority-контракта недоступен (U1), объём внешних читателей неизвестен (U3), а
неидемпотентный iu-progress — реальный, воспроизводимый пробел (§4.3). Предложение
«условное обновление PG решает всё» опровергается §4.3–4.4: оно решает ФАЙЛОВУЮ фазу, но не
фазу побочных эффектов и не доступность.

### Необходимые изменения и удаляемые компоненты (A-min)

| Действие | Объём |
|---|---|
| Удалить | `backend/src/services/publication-lock.cjs` целиком (включая Stage 139 claim/reclaim/GC) |
| Заменить | `withPublicationLock` в result-publication.cjs (:479, :706) → in-process per-task async-мьютекс (тот же API: acquire/release/verify-опционально) |
| Удалить | env/проверки, специфичные для lock-путей, в тестах (gpu-result-fencing-commit mock и т.п.) |
| Добавить | архитектурный тест single-publisher + startup-guard живого чужого lock'а |
| Не трогать | intent/receipt/Lua/manifest/marker/sha/rollback/resume/GC/kill-switch |

### Риски и остаточные ограничения

- R1: второй писатель (будущее масштабирование/операторский CLI) без новой сериизации →
  повреждение I1/I7. Mitigation: enforcement §7.3–7.4; переключатель — вернуть
  publication-lock.cjs из коммита `c500b221` (он остаётся в истории как проверенный fallback).
- R2: ин-процесс-мьютекс не защищает от re-entrancy внутри одного процесса через разные
  code-path'и — покрывается тем же API-контрактом (release в finally) и тестами F1–F13.
- R3: изменение требует повторного прогона всех 25 fencing-сценариев + S14 (межпроцессные
  сценарии L1/L2/L5 становятся неприменимы — их заменяют: (a) негативный тест «второй
  процесс НЕ может получить доступ к ФС-примитивам», (b) сценарии «внешняя замена файла»
  F3/F4 остаются и должны пройти через sha-доказательства).
- R4: остаются действующими все U-неопределённости §12.

### Миграция и откат (если команда принимает A-min)

1. Код одной стадией (не в рамках Stage 140): мьютекс + удаление модуля + тесты.
2. Прогон: полный suite, 25 fencing + S14 (межпроцессные L* заменяются по R3), аудит-харнесс
   Stage 139 (переписанный на in-process сценарии).
3. Откат: `git revert` одного коммита; lock-подсистема возвращается из `c500b221` без потери
   данных (она не пишет ничего, кроме служебных каталогов `.publication-locks`).
4. Никаких данных/форматов Redis/PG не меняется → миграция обратима в обе стороны без
   деградации.

### Конечный набор обязательных тестов (после A-min)

1. Полный backend suite (3489+) — без падений;
2. Все 25 fencing-сценариев (F1–F13, включая SIGKILL F8, tampering F9a/b, resume F12/F13);
3. S14a/b (параллельные публикации разных fence) — на in-process уровне (20 раундов);
4. Новые: single-publisher architecture test; «внешняя замена canonical обнаружена sha»
   (без lock); отсутствие зависаний под постоянными fs-ошибками (бывший D3 — теперь
   деградирует в fail-closed без циклов вообще);
5. GPU_FENCING_MODE=off kill-switch и штатная идемпотентность (gpu-fenced-publication-gates:324,
   gpu-result-fencing-commit:513, gpu-queue-idempotency).

### Критерии приёмки — «публикация закрыта»

Тема считается закрытой, когда выполнено ЛЮБОЕ из:
- **Ветка A-min**: изменения слиты; критерии §7.4 пройдены; два последовательных релиза без
  инцидентов публикации → дальнейшие работы по публикации запрещены до наступления
  триггеров (многие backend-инстансы, появление второго ФС-писателя, или выполнение
  предусловий B §7).
- **Ветка A-full**: команда сознательно отказывается от изменений; фиксируется, что
  `c500b221` — финальная итерация; триггеры те же.

## 8. Что проверено (сводка доказательств)

- Git: HEAD/c500b221/working tree/remotes/ahead-behind — факты §1 (git rev-parse, cat-file,
  rev-list --left-right, ls-tree по github/main).
- Точки записи/публикации — §2, каждое утверждение с файл:строкой (проверено чтением
  исходников в этой сессии).
- Тесты: gpu-result-fencing-commit + gpu-fenced-publication-gates + gpu-publication-consistency
  + gpu-queue-idempotency = 122 passing (запуск в Stage 139); полный suite 3489 passing;
  внешние harness'ы audit-139 (l-results 20/20, f-results 27/27, S14 40/40) и audit-137
  (01:24/24, 10:24/24, 11:15/15, 12:15/15, 13:blocked=false) — как заявления предыдущих
  стадий, они СВЕРЕНЫ с файлами результатов, но воспроизводились в Stage 139, не в Stage 140.
- Деплой: docker-compose.yml, deploy/* — single-publisher факт §1.
- Production: HEAD и рабочее дерево НЕ изменялись (Stage 140 — только чтение); push/deploy — 0.

## 9–12. Неопределённости (явно, без предположений)

- **U1**: текст contract 126 и docs/* недоступен (animastor-docs, коммит 8a997966). Все
  «§»-ссылки проверяемы только кодом/тестами. Решение о смене authority (B) невозможно без
  этого текста.
- **U2**: воспроизводимость тестов Stage 140 не запускалась заново (запуск — Stage 139; в
  Stage 140 код production не менялся, suite-логи audit-139 сохранены).
- **U3**: топология читателей канонических путей за пределами backend (фронтенд/прокси,
  монтирование /data/output) в этом репозитории не подтверждена — для B это критично, для
  A-min нет.
- **U4**: реальное число backend-инстансов «в проде» проверяется только конфигами репозитория
  (один контейнер); факт запущенной инфраструктуры из репозитория недоказуем → отсюда
  требование enforcement §7.3, а не слепое доверие.
- **U5**: аппаратный EIO (из NOT RUN Stage 138C) остаётся невоспроизведённым; на A-min это
  перестаёт быть релевантным (нет файловой координации).
