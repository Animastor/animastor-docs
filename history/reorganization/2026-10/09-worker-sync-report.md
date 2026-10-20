# Animastor — синхронизация Worker с монорепо c21.4 (отчёт)

- Дата: 2026-10-11 (UTC)
- Рабочее дерево: `/home/animastor/animastor-worker`
- База: `618f87a67744802b7e7a0b33a0934ce48d414640` (= bare = GitHub, подтверждено)
- Итог: ветка `sync/c21.4-domain` = **`b3f94f42612d0a5dd665956908f545c8d94fad95`**
- Результат: **PASS**
- `main` не тронут (`618f87a`), bare/GitHub не тронуты, push/merge/deploy не выполнялись.

---

## 1. Pre-flight

| Проверка | Значение |
|---|---|
| HEAD == baseline (03-baseline-2026-10-11.txt) | `618f87a6` ✓ |
| Ветка / status | `main`, 0 строк ✓ |
| remotes | `origin` → локальный bare `/home/animastor/repos/animastor-worker.git`, `github` → GitHub ✓ |
| bare `main` == worktree == GitHub (`ls-remote`) | `618f87a6` во всех трёх ✓ |
| Ветки Backend/Web/Android | сохранены: `a7a8c46` / `fbc9366` / `92a56c0`; их `main` не изменены ✓ |
| Монорепо | `465453df`, без изменений ✓ |
| Свободный диск | 6.3 ГБ (94%) — учтён: ресурсоёмкие операции не требовались (тесты zero-dependency) |

Расхождений с ожидаемым состоянием нет.

## 2. Созданный коммит (1)

| SHA | Тема | Объём | Источник (монорепо c21.4) |
|---|---|---|---|
| `b3f94f4` | feat(domain): migrate canonical domain animastor.in → animastor.org | 10 файлов, +13/−13 | `60f8b9ee` (2026-10-08) |

Как и у Web/Android, в `master..HEAD` монорепо у worker-путей присутствует
**только** доменная тема (npm-бампы/fix(editor)/fix(assistant) — backend-скоуп).

## 3. Метод (трёхстороннее сравнение)

Три стороны: монорепо c21.4 (`master=64127b9e` → `HEAD=465453df`), split-base
(`master` монорепо), актуальный Worker (`main=618f87a6`).

Пересечение изменённых в `master..HEAD` путей с деревом worker = **11 кандидатов**:

| Класс | Файлов | Обработка |
|---|---|---|
| Только монорепо новее (worker-блоп == split-base) | 9 | взяты из `465453df` (git archive из монорепо поимённо — объектов монорепо в worker-репо нет из-за filter-repo). Дифф каждого проверен заранее: **все изменения только доменные**, один коммит `60f8b9ee` |
| Изменены с обеих сторон | 2 | ручное 3-way (§4) |

## 4. Решения по файлам «изменён с обеих сторон» (3-way)

| Файл | В репозитории (post-split) | В монорепо | Решение |
|---|---|---|---|
| `packages/animastor-worker/worker/package.json` | `repository`/`bugs` → `animastor-worker` (618f87a) | `homepage` → `https://animastor.org` | объединено: сохранены repo-метаданные, перенесён только `homepage: https://animastor.org` |
| `README.md` | новый README репозитория (618f87a) | старый корневой README монорепо + `.org` | репозиторионный **сохранён**; доменных строк (`animastor.in|org`) в нём нет — применять нечего |

## 5. Перенесённые доменные изменения

| Файл | Что изменено |
|---|---|
| `packages/animastor-worker/worker/worker.cjs` | дефолт `HUB_URL` → `https://animastor.org/gpu` |
| `packages/animastor-worker/start-worker.sh` | дефолт `HUB_URL` (с env-overridable семантикой) → `.org` |
| `packages/animastor-worker/new/start-worker.sh` | `export HUB_URL` → `.org` |
| `packages/animastor-worker/worker/.env.example` | `HUB_URL=https://animastor.org/gpu` |
| `packages/animastor-worker/tests/worker-env.test.cjs` | ожидания `.env`-лоадера: `HUB_URL=https://animastor.org/gpu` (2 строки) |
| `docker/worker/entrypoint.sh` | `HUB_URL="${ANIMASTOR_HUB_URL:-https://animastor.org/gpu}"` |
| `docker/worker/docker-run.md` | пример запуска: `-e ANIMASTOR_HUB_URL=https://animastor.org/gpu` |
| `packages/animastor-worker/new/MEMORY.md`, `new/SYSTEM.md` | ops-заметки: URL подключения worker → `.org` (3 строки) |

Поведение Worker и GPU Hub не меняется за пределами канонического хоста:
переменные окружения с той же приоритетной семантикой (env > default),
`ANIMASTOR_HUB_URL`/`HUB_URL` по-прежнему переопределяют дефолт.

## 6. Сохранённые post-split изменения

- `README.md` и `.gitignore` репозитория — не тронуты;
- `worker/package.json`: `repository`/`bugs` → `Animastor/animastor-worker` сохранены,
  `homepage` → `.org`; версия/`license: MIT` не менялись;
- контракты артефактов (`worker/` zero-dependency bundle, GitHub Release zip+sha256)
  — не тронуты;
- pinned-image конфигурации и compose-переработки backend (§3 матрицы) — не в скоупе.

## 7. Проверки

| Проверка | Результат |
|---|---|
| `git status` после коммита | чисто (0 строк) ✓ |
| `git log main..sync/c21.4-domain` | ровно 1 ожидаемый коммит ✓ |
| `git diff main..HEAD --stat` | 10 файлов = 9 mono-only + 1 three-way ✓ |
| Блобы 9 mono-only файлов vs монорепо `465453df` | 9/9 байт-идентичны ✓ |
| Контроль 3-way (`worker/package.json`) | repo `repository`/`bugs` сохранены + `homepage` `.org` ✓ |
| Остатки `animastor.in` в дереве | 7 файлов — все `docs/architecture/*.md` (исторические аудиты), **байт-идентичны монорепо**, в diff ветки не входят ✓ |
| Ссылки на старый monorepo | только в историческом `docs/architecture/PHASE_9E_NPM_PUBLIC_RELEASE_AUDIT.md` (не менялся) ✓ |
| `node --check` (worker.cjs, worker-env.test.cjs) | OK ✓ |
| `bash -n` (entrypoint.sh, 2× start-worker.sh) | OK ✓ |
| **`node tests/run-all.cjs` (пакет animastor-worker)** | **45 pass / 0 fail** (включая изменённый `worker-env.test.cjs`); 2 пропуска — parity/manifest-проверки, требующие монорепо (standalone checkout), не связаны с синхронизацией ✓ |
| Secrets в diff | нет ✓ |
| Ветка изолирована от `main` | `main` = `618f87a6` = bare = GitHub ✓ |
| Прочие репозитории | backend `a7a8c46`/`bce64db3`, web `fbc9366`/`c7fe52ac`, android `92a56c0`/`254e2f08`, монорепо `465453df` — без изменений ✓ |

Тесты worker-пакета zero-dependency — `npm ci` не требовался, диск не расходовался.

## 8. Что НЕ запускалось / ограничения

| Что | Почему |
|---|---|
| `tools/sync-protocol.cjs --check` (npm parity канонического Job Protocol) | требует `@animastor/contracts` из node_modules (`npm ci`) — parity-пропуск воспроизводит standalone-checkout поведение тестов; контракт не менялся синхронизацией |
| Запуск worker-процесса / docker-деплой `docker/worker/*` | production-поведение **не проверялось** (нет живого GPU Hub в скоупе задачи) |
| Тесты backend/web/android | вне скоупа worker-этапа |
| `npm publish` / Release zip | вне скоупа |

## 9. Осознанно НЕ перенесено

| # | Что | Почему |
|---|---|---|
| 1 | `README.md`, `.gitignore` монорепо | репозиторионные версии новее (post-split `618f87a`) |
| 2 | `docs/architecture/repository-split-*`, `post-split-*`, `DOMAIN_MIGRATION_2026-10_IN_TO_ORG.md` | split-журналы ведутся в монорепо |
| 3 | `docs/architecture/*.md` с историческими `.in` | исторические аудиты, монорепо их не менял |
| 4 | Backend-изменения (nginx/installer/auth/npm/fix(editor)/fix(assistant)) | backend-скоуп (ветка `a7a8c46`) |
| 5 | GPU Hub-фикстура `packages/animastor-gpu-hub/**` | канон — репозиторий animastor-gpu-hub (§5.1 матрицы) |

## 10. Rollback

Единственное изменение — ветка `sync/c21.4-domain` (1 коммит поверх `main`).
Откат: `git checkout main && git branch -D sync/c21.4-domain`.
Bare/GitHub/монорепо/backend/web/android/gpu-hub/инфраструктура не тронуты
(проверено после завершения, см. §7).

## 11. Следующие шаги (отдельные решения, НЕ выполнены)

1. Ревью всех 4 веток (`backend a7a8c46`, `web fbc9366`, `android 92a56c0`,
   `worker b3f94f4`) → merge в `main` → push bare → GitHub.
2. Решение по 2 pre-existing падающим тестам android (`worker-source` ↔
   `worker-bundle`, §6 отчёта 08).
3. Cutover: переключение сборки/деплоя с монорепо на репозитории.
