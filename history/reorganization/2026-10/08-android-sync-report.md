# Animastor — синхронизация Android с монорепо c21.4 (отчёт)

- Дата: 2026-10-11 (UTC); редакция после запуска Gradle-проверок (уточнение пути SDK)
- Рабочее дерево: `/home/animastor/animastor-android`
- База: `254e2f084342fd69214b4a3a45dfb7b27df84e2f` (= bare = GitHub, подтверждено)
- Итог: ветка `sync/c21.4-domain` = **`92a56c0ddce1a796d593f4e3a3462ca17ddd2c3f`**
- Результат: **PASS**
- `main` не тронут (`254e2f0`), bare/GitHub не тронуты, push/merge/deploy не выполнялись.

---

## 1. Pre-flight

| Проверка | Значение |
|---|---|
| HEAD == baseline (03-baseline-2026-10-11.txt) | `254e2f08` ✓ |
| Ветка / status | `main`, 0 строк ✓ |
| remotes | `origin` → локальный bare `/home/animastor/repos/animastor-android.git`, `github` → GitHub ✓ |
| bare `main` == worktree == GitHub (`ls-remote`) | `254e2f08` во всех трёх ✓ |
| Ветка Backend `sync/c21.4-domain-and-fixes` | сохранена в worktree backend = `a7a8c46`; backend `main` = `bce64db3` не изменён ✓ |
| Ветка Web `sync/c21.4-domain` | сохранена в worktree web = `fbc9366`; web `main` = `c7fe52ac` не изменён ✓ |
| Монорепо | `465453df`, HEAD/status без изменений ✓ |
| Свободный диск | 6.4 ГБ (94%) — учтён: ресурсоёмкие операции не запускались (см. §7) |

Расхождений с ожидаемым состоянием нет.

## 2. Созданный коммит (1)

| SHA | Тема | Объём | Источник (монорепо c21.4) |
|---|---|---|---|
| `92a56c0` | feat(domain): migrate canonical domain animastor.in → animastor.org | 6 файлов, +11/−11 | `60f8b9ee` (2026-10-08) |

В `master..HEAD` монорепо у android-путей присутствует **только** доменная тема
(те же 4 коммита backend-этапа — npm-бампы/fix(editor)/fix(assistant) — android
не касаются).

## 3. Метод (трёхстороннее сравнение)

Три стороны: монорепо c21.4 (`master=64127b9e` → `HEAD=465453df`), split-base
(`master` монорепо), актуальный Android (`main=254e2f08`).

Пересечение изменённых в `master..HEAD` путей с деревом android = **7 кандидатов**:

| Класс | Файлов | Обработка |
|---|---|---|
| Только монорепо новее (android-блоп == split-base) | 6 | взяты из `465453df` (git archive из монорепо поимённо, как в web-этапе; объекты монорепо в android-репо отсутствуют из-за filter-repo). Дифф каждого проверен заранее: **все изменения только доменные**, один коммит `60f8b9ee` |
| Изменён с обеих сторон | 1 (`README.md`) | **не изменён** — репозиторионный README новее (post-split `860bd8b`); доменных строк в нём нет (grep `animastor.in|org` = 0), применять нечего |

## 4. Перенесённые доменные изменения

| Файл | Что изменено |
|---|---|
| `frontends/android/app/build.gradle.kts` | дефолт `baseUrl` → `https://app.animastor.org/` (переопределяемый `-PBASE_URL`, как и раньше) |
| `frontends/android/app/src/main/java/com/example/animastor/ui/LibraryFragment.kt` | WebView loadUrl → `https://app.animastor.org/library` |
| `frontends/android/apk-build-in.sh` | echo download-URL → `https://animastor.org/net-disk/app-debug.apk` |
| `.../ui/BetaSettingsHelpersTest.kt` | ожидания worker-setup контракта: `hubUrl`/`sourceUrl`/`downloadCommand`/`HUB_URL=…org/gpu` (5 строк) |
| `.../ui/WorkerSetupHelpersTest.kt` | ожидания `installerDownloadUrl` → `animastor.org/gpu/installer?…` (2 строки) |
| `ANDROID_WEB_PARITY.md` | строка parity: WebView loading `app.animastor.org/library` |

Поведение приложения и API-контракты не меняются за пределами канонического
хоста: изменения — только значения URL/строк; структура контрактов
(`buildSetupContract`, `SetupInstructions`) не тронута.

## 5. Сохранённые post-split / Android-специфичные изменения

- `README.md` репозитория (logo, `Animastor Android`, ссылки) — не заменён;
- `.gitignore` — репозиторионный, не тронут;
- **подписной конфиг** `build.gradle.kts` сохранён пост-сплит-вариантом
  (`bb8c457`, security fix): `storePassword/keyAlias/keyPassword` читаются через
  `project.findProperty(...)`, хардкода секретов нет — монорепо-версия блоба
  идентична, ничего не откатилось;
- `gradle.properties`, `settings.gradle.kts`, `gradlew` — не тронуты;
- `repository`-метаданные / ссылка issue → `animastor-android` (`254e2f0`) — не тронуты;
- ключи подписи/`release-key.jks`/`local.properties`/артефакты — не существуют
  в дереве и не создавались.

## 6. Проверки

| Проверка | Результат |
|---|---|
| `git status` после коммита | чисто (0 строк) ✓ |
| `git log main..sync/c21.4-domain` | ровно 1 ожидаемый коммит ✓ |
| `git diff main..HEAD --stat` | 6 файлов = 6 mono-only + 0 ✓ |
| Блобы 6 файлов vs монорепо `465453df` | 6/6 байт-идентичны ✓ |
| Остатки `animastor.in` в дереве | **0 файлов** ✓ |
| Ссылки на старый monorepo | 0 ✓ |
| Секреты в diff | 0 добавленных строк с password/secret/token/keystore ✓ |
| `bash -n frontends/android/apk-build-in.sh` | OK ✓ |
| `bash -n frontends/android/gradlew` | OK ✓ |
| Итоговые значения URL (build.gradle.kts, LibraryFragment) | `.org` на месте ✓ |

### Gradle-сборка и тесты (ЗАПУСКАЛИСЬ — редакция отчёта)

Первоначальная оценка «SDK не найден» была неверна: SDK расположен
в **`/home/animastor/Android/Sdk`** (platforms android-34/35, build-tools
34.0.0, 600 МБ). Указано пользователем; проверено и использовано.

| Условие | Статус |
|---|---|
| Android SDK | `/home/animastor/Android/Sdk` — platforms 34/35, build-tools 34.0.0 ✓ |
| Gradle | дистрибутив 8.12 из монорепо (`/home/animastor/animastor/frontends/android/gradle-8.12`, совместим с AGP 8.7.3); `gradle/wrapper/*` в репо отсутствует (pre-existing) — wrapper не использовался |
| Зависимости | `~/.gradle/caches` (957 МБ) уже содержит AGP/dependencies — без сети-загрузок |
| Диск | 6.4 ГБ; артефакты сборки (~150 МБ) удалены после проверок |

| Проверка на ветке `sync/c21.4-domain` | Результат |
|---|---|
| `gradle testDebugUnitTest` (весь модуль app) | **155 tests: 153 passed, 2 FAILED** — оба pre-existing (см. ниже) |
| `gradle assembleDebug` | **BUILD SUCCESSFUL** (31s) — `app-debug.apk` 12.7 МБ собран ✓ |
| Содержимое APK (`classes*.dex`, grep байтов) | `https://app.animastor.org/` ×4; остатков `animastor.in` — **0** ✓ |

Два падающих теста — **pre-existing, не вызваны синхронизацией** (воспроизведены
на baseline `main`: те же 2 теста, та же причина — `worker-source` vs
`worker-bundle`, ожидание `.in`/`.org` совпадает корректно в обеих версиях):
- `BetaSettingsHelpersTest.worker_setupContract_matchesWorkerCjsEnv`
- `WorkerSetupHelpersTest.legacy_singleFileFlowStillWorksAsFallback`

Причина: тесты ждут `…/gpu/worker-source`, а production-хелпер
`BetaSettingsHelpers.kt:150` выдаёт `…/gpu/worker-bundle` — несогласованность
**внутри самого монорепо c21.4** (mono-тест и mono-хелпер расходятся так же).
Появилась с `c6fcd1e` (Phase 10T: bake-in, удаление `/worker-source`) — тесты
не обновили. **Требует отдельного решения** (привести ожидания тестов к
worker-bundle); в рамках доменной синхронизации не правится.

## 7. Что НЕ запускалось / ограничения

| Что | Почему |
|---|---|
| Линт (`lintDebug`), `assembleRelease` (подписанный релиз) | релизная подпись/`release-key.jks` и цепочка подписи вне скоупа («процесс подписи APK не изменять») |
| Gradle wrapper `gradlew` напрямую | в репо нет `gradle/wrapper/*` (pre-existing); использован Gradle 8.12 из монорепо-каталога |
| Проверка на устройстве/эмуляторе | не выполнялась |
| Тесты worker/backend/web | вне скоупа android-этапа |

## 8. Осознанно НЕ перенесено

| # | Что | Почему |
|---|---|---|
| 1 | `README.md`, `.gitignore` монорепо | репозиторионные версии новее (post-split `860bd8b`) |
| 2 | `docs/architecture/repository-split-*`, `post-split-*`, `DOMAIN_MIGRATION_2026-10_IN_TO_ORG.md` | split-журналы ведутся в монорепо |
| 3 | Backend-изменения (nginx/installer/auth/npm/fix(editor)/fix(assistant)) | не относятся к Android (уже в backend-ветке `a7a8c46`) |
| 4 | Web-изменения | уже в web-ветке `fbc9366` |
| 5 | `ANDROID_WEB_PARITY.md` | изменение принадлежит и web, и android — правка идентична применённой в web-ветке (`app.animastor.org/library`), расхождений нет |

## 9. Rollback

Единственное изменение — ветка `sync/c21.4-domain` (1 коммит поверх `main`).
Откат: `git checkout main && git branch -D sync/c21.4-domain`.
Bare/GitHub/монорепо/backend/web/worker/gpu-hub/инфраструктура не тронуты
(проверено после завершения: bare android `main=254e2f08`, GitHub `main=254e2f08`,
web sync-ветка `fbc9366` на месте, backend sync-ветка `a7a8c46` на месте,
монорепо `465453df`).

## 10. Следующие шаги (отдельные решения, НЕ выполнены)

1. Ревью ветки → merge в `main` → push bare → GitHub.
2. Синхронизация worker (`05-sync-plan.md` §2.4) — последний из 4 репозиториев.
3. Решение по 2 pre-existing падающим тестам (`worker-source` ↔ `worker-bundle`, §6).
4. Cutover: переключение сборки/подписи APK на репозиторий (production — из монорепо).
