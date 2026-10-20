# Animastor — ревью и слияние четырёх веток в main (этап 7)

- Дата: 2026-10-11 (UTC)
- Результат: **PASS** — все 4 ветки слиты fast-forward в локальные `main`
- Push на bare/GitHub **не выполнялся** (требуется отдельное подтверждение);
  локальные `main` теперь опережают `origin/main` на 1 / 4 коммита.
- Production cutover, перезапуск сервисов, npm publish, repin GPU Hub — **не выполнялись**.
- Снапшот исходных SHA для отката: `11a-premerge-main-snapshot.txt` (в этой папке).

## 1. Pre-flight (до изменений)

| Проверка | Результат |
|---|---|
| HEAD веток == заявленным SHA | worker `b3f94f42`, web `fbc93662`, android `92a56c0d`, backend `a7a8c463` ✓ |
| Рабочие деревья | чистые (0 строк) во всех 4 ✓ |
| `main` предок ветки (`merge-base --is-ancestor`) | FF возможен во всех 4 ✓ |
| remotes/upstream | `origin` (bare) + `github`, upstream `origin/main` везде ✓ |
| Свободный диск | 6.3 ГБ — merge (только refs) ресурсов не требует ✓ |

## 2. Сводная таблица merge

| Репозиторий | main до | main после (итог) | Merge | Дерево | Commits origin..main |
|---|---|---|---|---|---|
| animastor-worker | `618f87a6` | **`b3f94f42612d0a5dd665956908f545c8d94fad95`** | `--ff-only` ✓ | чисто | 1 (push не делали) |
| animastor-web | `c7fe52ac` | **`fbc93662035df84c8e103df0d0706800aa96cba1`** | `--ff-only` ✓ | чисто | 1 |
| animastor-android | `254e2f08` | **`92a56c0ddce1a796d593f4e3a3462ca17ddd2c3f`** | `--ff-only` ✓ | чисто | 1 |
| animastor-backend | `bce64db3` | **`a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad`** | `--ff-only` ✓ | чисто | 4 |

Итоговые `main` байт-идентичны протестированным веткам этапов 2–5
(ff-merge не создаёт новых коммитов — SHA веток и есть итоговые SHA).

## 3. Ревью перед merge (на каждое репозиторий)

| Репо | Diff | Посторонние файлы | Секреты (grep по добавленным строкам) |
|---|---|---|---|
| worker | 10 файлов, +13/−13 — домен `.org` + 3-way homepage | нет ✓ | нет ✓ |
| web | 19 файлов, +37/−32 — домен `.org` + 3-way (license/GitHub-ссылки сохранены) | нет ✓ | нет ✓ |
| android | 6 файлов, +11/−11 — домен `.org` | нет ✓ | нет ✓ (подписной конфиг property-based) |
| backend | 44 файла, +823/−206 — домен + fix(editor) + fix(assistant) + npm-бампы | нет ✓ (split-журналы/gpu-hub-фикстура исключены) | нет ✓ (только `findProperty`/env-шаблоны) |

## 4. Проверки после merge

| Проверка | Результат |
|---|---|
| worker: `node tests/run-all.cjs` | **45 pass / 0 fail** ✓ |
| worker: `node --check worker.cjs` | OK ✓ |
| web: SHA == `fbc93662` (дерево идентично протестированному на этапе 3) | vitest 104+201 passed, typecheck OK — на этом же дереве ✓; остатки `.in` — только 9 исторических docs ✓ |
| android: `gradle testDebugUnitTest` (повтор на слитом main) | **155 tests, ровно 2 failed** — идентично этапу 4: те же 2 pre-existing (`worker_setupContract…`, `legacy_singleFileFlow…`, причина worker-source↔worker-bundle) ✓ |
| backend: целевой mocha-прогон (2 новых теста + 2 arch-теста) | **40 passing / 1 failing** — failing = известный **IB-G15** (pre-existing, отчёт 06 §5.1) ✓ |
| backend: `git log main..origin/main` | main опережает bare на ожидаемые 4 коммита (f84f43e, e045c51, 8cb02d8, a7a8c46) ✓ |
| Secrets в diff каждого репо | отсутствуют ✓ |

Примечание: полный `npm test` backend (927/2) прогнан на этапе 2 на том же
самом дереве (`a7a8c463`); после ff-merge дерево байт-идентично, поэтому
повтор полного прогона не требовался — выполнен целевой, затрагивающий
изменённые/новые тесты.

## 5. Изоляция (подтверждена после merge)

| Что | Статус |
|---|---|
| bare-репозитории (все 5) | **не изменены** (refs == pre-merge main) — push не выполнялся ✓ |
| GitHub | не тронут (`ls-remote` до merge == bare) ✓ |
| Монорепо | `465453df`, без изменений ✓ |
| GPU Hub | `ecefd0b7`, `artifacts.lock.json` не изменён, repin не выполнялся ✓ |
| Pinned GPU Hub image | compose-конфигурация слитой ветки сохраняет `${GPU_HUB_IMAGE:?…}` (pinned, без build) ✓ |
| Контейнеры | без перезапусков (backend Up 20h, gpu-hub Up 2d, proxy Up 5w) ✓ |
| Контракт `/gpu/worker-bundle` + sha256 | не менялся; deprecated `/worker-source` присутствует в GPU Hub для back-compat ✓ |

## 6. Известные проблемы (pre-existing, НЕ вызваны merge)

| Компонент | Проблема | Статус |
|---|---|---|
| backend | `installer-package-boundary` IB-G15 (нет `"private": true`) | pre-existing (отчёт 06); воспроизведён после merge |
| backend | `phase5-runtime-result` T9 (ENOENT `runtime/index.js`) | pre-existing (отчёт 06); в целевом прогоне не покрыт |
| android | 2 теста ждут deprecated `/gpu/worker-source` | pre-existing (отчёт 08); воспроизведён после merge |
| worker↔gpu-hub | пин `sha256_tree` worker-bundle в gpu-hub рассинхронизирован с новым main worker | **deferred to cutover** (репин не выполнялся, §5 аудита) |

## 7. Незапущенные проверки (не объявляются пройденными)

- Полный `npm test` backend на слитом main (дерево идентично протестированному — §4).
- `vitest` 12 web-пакетов, `vite build`, tester-APK, `lintDebug`/`assembleRelease` android.
- Production Nginx-редиректы, GPU Hub E2E, docker-deploy worker — живые проверки.

## 8. Откат

Все 4 слияния — только перемещение ref `main` (ff). Точный откат:
`git update-ref refs/heads/main <SHA из 11a-premerge-main-snapshot.txt>`
в каждом worktree. Никакие другие refs/файлы не изменялись.

## 9. Следующие шаги (отдельные решения)

1. Push `main` всех 4 репозиториев в bare → GitHub (по подтверждению).
2. Production cutover (§9 аудита): repin gpu-hub worker-bundle, пересборка
   backend-образа из репозитория, живая проверка legacy 301.
3. Фиксы pre-existing тестов (IB-G15, worker-source↔worker-bundle, phase10j).
