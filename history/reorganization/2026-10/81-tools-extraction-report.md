# 81 — Выделение `tools/`, проверка SDK и очистка секрета

**Дата:** 2026-10-20
**Основания:** `80-tools-extraction-blocker-audit.md`, `75-tools-manifest.txt`, отчёты 76–79.
**Исходный репозиторий:** `animastor-web` @ `fbc93662` (worktree чистый, HEAD не менялся).
**Целевой репозиторий:** `Animastor/animastor-tools` — **пуст (0 refs), push НЕ выполнялся**.

---

## 0. Итог

**Статус: BLOCKED (публикация).** Всё техническое preparation выполнено и проверено; push запрещён двумя незакрытыми обязательными гейтами:

| # | Гейт (Stage 81 §5) | Статус | Причина |
|---|---|---|---|
| 1 | Состав файлов согласован | **OPEN** | Все 46 путей манифеста — класс C (web-харнесса `desktop-web-tester`/`mobile-web-tester`); классов A/B в манифесте нет. Минимальный обоснованный набор «общих инструментов» = ∅. Нужно решение владельца: Вариант 1 (тестеры остаются в `animastor-web`) или Вариант 2 (явно утвердить `animastor-tools` как harness-репозиторий). |
| 2 | Потенциально действующий пароль заменён владельцем | **OPEN** | Пароль админ-учётки `developer` (роль admin, `password_hash` NOT NULL) публичен в GitHub с 2026-08-10 и, вероятно, действителен. Ротация не подтверждена; менять учётные данные без владельца запрещено. |
| 3 | Извлечённая история проверена | PASS | 6 коммитов извлечённой истории + 1 коммит подготовки; 0 совпадений секрета в blobs **и** в сообщениях; `git fsck` чист. |
| 4 | Секрет удалён из извлекаемой истории | PASS | `--replace-text` + `--replace-message` на изолированной копии; проверено рев-лист сканом по каждому коммиту. |
| 5 | Целевой репозиторий проверен | PASS | `ls-remote` → 0 refs (пуст); локальный кандидат удалён от origin (filter-repo снял remote — push только после явного добавления). |
| 6 | Тесты и доступные проверки | PASS | Оба APK собраны (`BUILD SUCCESSFUL`), `./gradlew --version` автономно, `bash -n`, fsck, сканы. |

**Push не выполнен.** Кандидат подготовлен локально и сохранён вместе с bundle'ом (см. §9).

---

## 1. Android SDK: проверка и точная причина прежней ошибки

### 1.1 Результат проверки (пользователь `animastor` — тот же, от имени которого идёт сборка)

| Компонент | Путь / значение | Статус |
|---|---|---|
| Android SDK | `/home/animastor/Android/Sdk` (владелец `animastor`, rwx) | **есть, полный** |
| `platform-tools` | `platform-tools/adb` 37.0.0-14910828 | есть |
| `platforms` | `android-34`, **`android-35`** (нужен для compileSdk 35) | есть |
| `build-tools` | `34.0.0` (нужен AGP 8.7.3 / targetSdk 34) | есть |
| `cmdline-tools` | `cmdline-tools/latest` (sdkmanager 12.0) | есть |
| `licenses` | `android-sdk-license` принят | есть |
| `java` / `javac` | OpenJDK 17.0.20.1 (`/usr/bin`) | есть |
| `adb` (на PATH) | **нет** (только внутри SDK) | не обязателен для assembleDebug |
| `sdkmanager` (на PATH) | **нет** (только внутри SDK) | не обязателен |
| `gradle` (системный) | `/usr/bin/gradle` **4.4.1** — слишком стар для AGP 8.7.3 (нужен ≥ 8.9) | непригоден |
| Gradle 8.12 | mono `frontends/android/gradle-8.12` (untracked) **и** скачан wrapper'ом в `~/.gradle/wrapper/dists` | есть |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | **не заданы** | требуется миним. фикс (см. 1.3) |

### 1.2 Точная причина прежнего сообщения «SDK not found»

Ранее (Stage 75/80) сообщение трактовалось как «на VPS нет Android SDK». Фактическая цепочка:

1. `build-apk.sh` при отсутствии `local.properties` записывает **`sdk.dir=/home/sureg/Android/Sdk`** — путь другой учётки/машины.
2. На этом хосте `/home/sureg` существует, но **`/home/sureg/Android/Sdk` отсутствует** (`net-disk` там есть) → AGP падает с «SDK location not found / invalid».
3. Fallback-переменные `ANDROID_HOME`/`ANDROID_SDK_ROOT` не заданы → авто-определения не происходит.
4. Раньше SDK-проверки: `./gradlew` — shim на `../../frontends/android/gradle-8.12`, которого нет в `animastor-web` (Gradle-каталог untracked и живёт только в mono) → `./gradlew` в standalone-копии падает с «No such file or directory».

Т.е. SDK **установлен** (`/home/animastor/Android/Sdk`, проверен под пользователем сборки), но оба штатных механизма его найти не могли: захардкоженный чужой путь + отсутствие переменных окружения. Stage 78 независимо подтвердила работоспособность того же SDK (создан gitignored `local.properties` → `BUILD SUCCESSFUL` для mono-фронта).

### 1.3 Минимальное исправление для тестового окружения (глобальная конфигурация НЕ менялась)

Достаточно задать переменные в сессии/скрипте сборки:

```bash
export ANDROID_SDK_ROOT=/home/animastor/Android/Sdk   # или ANDROID_HOME
export NET_DISK_DIR=$HOME/net-disk                    # опционально
./build-apk.sh
```

Глобальные `~/.profile`, `/etc/environment`, systemd-окружение production — **не изменялись**. В извлечённой копии `build-apk.sh` теперь параметризован (см. §5), захардкоженного `/home/sureg/...` там нет.

### 1.4 Сборка APK (после подтверждения компонентов)

| Проект | Команда | Результат |
|---|---|---|
| desktop-web-tester | `ANDROID_SDK_ROOT=… NET_DISK_DIR=/tmp/stage81-netdisk ./build-apk.sh` | **BUILD SUCCESSFUL** (1m24s), `app-debug.apk` 815 216 B, sha256 `705a6b1e…080891` |
| mobile-web-tester | то же | **BUILD SUCCESSFUL**, `app-debug.apk` 817 647 B, sha256 `d712d5a8…61f12c07` |
| автономность wrapper | `./gradlew --version` (без mono, без `frontends/android`) | **Gradle 8.12**, JDK 17 — работает |

Записи вне изолированной копии: только `~/.gradle` (кэш дистрибутива/зависимостей) и `/tmp/stage81-netdisk/` (тестовый `NET_DISK_DIR`). `/home/sureg/net-disk` **не** использовался.

---

## 2. Секрет: инвентаризация, очистка, статус

Значение пароля здесь и в отчёте не воспроизводится (даже в виде маркера для grep); обозначим его `<пароль>`.

### 2.1 Точные затронутые файлы и коммиты (read-only, рабочие репозитории не изменялись)

**Файлы (blobs):**

| Репозиторий | Файл | Строка |
|---|---|---|
| animastor-web @ `fbc93662` | `tools/desktop-web-tester/app/src/main/java/com/animastor/desktop/MainActivity.kt` | `AUTH_PASS = "<пароль>"` |
| animastor-web @ `fbc93662` | `tools/mobile-web-tester/app/src/main/java/com/animastor/tester/MainActivity.kt` | `AUTH_PASS = "<пароль>"` |
| animastor (mono) @ `465453df` | те же 2 пути `tools/…/MainActivity.kt` | то же (побайбный дубликат) |

**Diff-строки в истории:** web — 8 (7 в tools-пути; добавлены в `8e65770`, `39c6f97`, контекст в `f2edf8d`, `d1659ad`, `fbc9366`); mono — 2 (`ef62ab2e`, `f16ca75c`).

**Сообщения коммитов (содержат `<пароль>` в теле):**

| Репозиторий | Коммит | Публичность |
|---|---|---|
| animastor-web | `9eac9048` «admin: replace Basic Auth with internal app login» | на `main` публичного repo |
| animastor (mono) | `eb131cdc` (тот же коммит) | mono приватен (origin — локальный bare) |
| animastor-backend | `4cb917c` (cherry-pick/merge) | **на `main` публичного `Animastor/animastor-backend`** |

animastor-backend blobs: 0 совпадений. animastor-docs: 0. Прочие секретоподобные паттерны (api_key/token/private-key/AWS/ghp_/keystore/`.env`) в 46 файлах и их истории — не найдены.

### 2.2 Что удалено из файлов и извлекаемой истории

- Из **извлекаемой истории**: `git filter-repo --path tools/ --path-rename tools/: --replace-text … --replace-message …` на свежем изолированном клоне → 2 blobs заменены (`REDACTED`), сообщения коммитов очищены на входе (проверка показала, что сообщений с паролем в tools-истории и так нет: коммит `9eac9048` не трогает `tools/` и в кандидат не попал).
- Из **текущего кода кандидата**: хардкод убран полностью — `AUTH_USER`/`AUTH_PASS` берутся из `BuildConfig` (gradle-свойства `TESTER_AUTH_USER`/`TESTER_AUTH_PASS`, пароль по умолчанию пуст); README-раздел про зашитые креды переписан.
- Рабочие репозитории (`animastor-web`, mono, backend) **не переписывались**: `filter-repo`/`filter-branch`/`--replace-text` на них не запускались, истории и ветки не тронуты.

### 2.3 Проверка после очистки (не «простая замена текста»)

Выполнен отдельный рев-лист скан, а не только grep по working tree:

- `git log -p --all | grep -c <маркер>` — **0** (каждый коммит из 7);
- `git log --all --format='%H%n%s%n%b' | grep -c <маркер>` — **0** (сообщения коммитов);
- `grep -rIl` по working tree кандидата — **0**;
- `git ls-files` — нет `.env`/credential/keystore/`local.properties`/`*.apk`;
- сверка blobs с манифестом: **36/46 идентичны побайтно**, 10 отличий объясняены (2 redact+правки кода, 2 README, 2 build-apk.sh, 2 gradlew→wrapper, 2 app/build.gradle.kts);
- `git fsck --strict` — чисто.

### 2.4 Статус «живости» пароля — ротация обязательна

Только чтение (никаких попыток входа/смены пароля не выполнялось):

- nginx: в `proxy/conf/default.conf` **нет ни одного `auth_basic`** — Basic Auth из конфигурации удалён (в соответствии с `9eac9048`);
- бэкенд: `POST /api/v1/auth/login` сверяет пароль с таблицей `users`; у сидированной учётки `developer` (роль `admin`) поле `password_hash` **не NULL**; сообщение `9eac9048` прямо связывает `developer` с `<пароль>`.

**Вывод:** достоверно установлено, что пароль **не является** «мёртвым» секретом, — напротив, есть основания считать его действующим паролем admin-входа. Доказательство обратного (неактивен) не получено и без разрешения владельца не может быть получено. → Гейт ротации **OPEN**; публикация до ротации запрещена (Stage 80 §5.4, Stage 81 §5). Ротация = смена пароля учётки `developer` владельцем; после неё `<пароль>` в публичных web/backend-историях перестаёт быть эксплуатируемым (историю backend/web переписывать нельзя и не нужно).

**Остаточные копии, содержащие `<пароль>` (не мой след, созданы в Stage 75/80):**
`/tmp/audit-tools-extract` (клон web без очистки), а также сами истории `animastor-web` и mono. Рекомендуется удалить `/tmp/audit-tools-extract` после ротации; рабочие истории не трогать.

**Важное наблюдение Stage 81 (усиливает Blocker 1):** «скан-токен», который Stage 80 публиковал в отчёте и чате как маркер для grep, по длине и содержанию **совпадает с паролем целиком** (он оказался шестисимвольным). Следовательно, сам аудиторский след Stage 80 — отчёт `80-tools-extraction-blocker-audit.md` и его цитаты в чате/диагностике — содержит реальный пароль, а не обезличенный маркер. В Stage 81 этот маркер в отчёт и чат не выносится; после ротации владельцу следует решить, редактировать ли цитаты в аудиторских файлах (сейчас они не изменялись, чтобы не искажать след).

---

## 3. Классификация 46 путей (сверка с `75-tools-manifest.txt`)

Сверены **все 46 путей** манифеста (побайтно с HEAD `fbc93662` web): извлечённое дерево = манифест, путей 46 → **21 desktop + 25 mobile** (подтверждено счётчиками).

| Класс | Кол-во | Содержимое |
|---|---|---|
| A (общесистемные) | **0** | в манифесте отсутствуют |
| B (межкомпонентные) | **0** | в манифесте отсутствуют |
| C (компонентные, web-харнесс) | **44** | два WebView-тестера `frontends/app`; назначение и зависимости — компонентные |
| D (устаревшее/дублирующееся) | **2** | оба `gradlew` — shim'ы на untracked `../../frontends/android/gradle-8.12`; в standalone не работоспособны |

**Обоснованный минимальный набор для `animastor-tools`: ∅.** Общесистемных (A/B) инструментов в зоне переноса нет; 44 файлов C по определению остаются рядом со своим компонентом (в `animastor-web`), если нет отдельного решения сделать из них standalone harness-репозиторий. Искусственное наполнение репозитория ради факта «репозиторий существует» не выполнялось.

**Варианты решения (нужен владелец, Stage 80 §5.9):**

- **Вариант 1 (рекомендованный):** `animastor-tools` не публиковать в объёме манифеста; тестеры оставить в `animastor-web` (с отдельным этапом удаления `tools/` из web после подтверждения). Кандидат из §4 остаётся в архиве до решения.
- **Вариант 2:** явно утвердить `animastor-tools` как harness-репозиторий (46 файлов + LICENSE/wrapper/.gitignore, как подготовлено); тогда открытыми остаются только гейты ротации и формальное «состав согласован».

Кандидат Stage 81 подготовлен по Варианту 2 (иначе §4–§6 невыполнимы технически), но **не опубликован**.

---

## 4. Подготовка извлечения (изолированная копия)

Рабочие репозитории и их история **не изменялись**. Все операции — только в новом каталоге.

```
/home/animastor/reorg-2026-10-19/81-tools-extraction/
├── work/                          # изолированный клон: clone --no-local → filter-repo → commit подготовки
└── 81-animastor-tools.bundle      # полная история кандидата (84K, redacted)
```

Этапы:

1. `git clone --no-local /home/animastor/animastor-web …/work` (свежий клон, без remote после filter-repo).
2. `git filter-repo --path tools/ --path-rename tools/: --replace-text … --replace-message …` → 6 коммитов, 46 файлов на уровне корня, даты/авторы/сообщения сохранены.
3. Коммит подготовки `8851479` (см. §5) поверх извлечённой истории → 7 коммитов.
4. `git bundle create … --all` — проверен `git bundle verify` («records a complete history»).

Итоговая история `main` (SHA):

| SHA | Дата | Автор | Сообщение |
|---|---|---|---|
| `88514792092f317a88e47e5f83fa0bd428b81426` | 2026-10-20 | Animastor | chore: standalone build fixes for extraction into animastor-tools |
| `bcf9fe654488b9bbded5a6b6ee3ebbd81da15952` | 2026-10-11 | Animastor | feat(domain): migrate canonical domain animastor.in → animastor.org |
| `05a9c762dab90885c96922953a4ee581ca795983` | 2026-08-12 | Sergey Khabarov | feat(infra): domain architecture … |
| `17ae28aa1a84b54b154b3de44dddb25f2415a725` | 2026-08-12 | Sergey Khabarov | feat(tools): desktop-web-tester — monitor launcher icon … |
| `e9d25bac525c2ef58863383a5cf158df2aaa9f8e` | 2026-08-12 | Sergey Khabarov | feat(tools): desktop-web-tester — fullscreen desktop emulator … |
| `0a03e49729057bd13db7d7e0e3e12ca52fa6c118` | 2026-08-10 | Sergey Khabarov | fix(tools): mobile-web-tester — disable page fullscreen … |
| `81b818ddcef51d2ec81be7dc730551939996007e` | 2026-08-10 | Sergey Khabarov | feat(tools): Mobile Web Tester … |

Примечание: в клоне сохранилась ветка `sync/c21.4-domain` (укороченная история web); при публикации пушить только `main`.

Чего в кандидате **нет** (по построению): `.env`, credentials, keystore, `local.properties`, `*.apk`, `.idea`, временных артефактов; `local.properties` и `build/` игнорируются `.gitignore` (проверено: после сборки `git status` чист).

---

## 5. Изменения содержимого кандидата (коммит `8851479`)

Все — обязательные исправления Stage 80 §5.6/§5.4; ни одно не затрагивает рабочие репозитории.

| Файл | Изменение |
|---|---|
| `desktop-web-tester/gradlew`, `mobile-web-tester/gradlew` | shim заменён **официальным Gradle wrapper 8.12** (+ `gradlew.bat`, `gradle/wrapper/gradle-wrapper.{jar,properties}`); `./gradlew --version` работает автономно |
| `*/build-apk.sh` | `sdk.dir=/home/sureg/Android/Sdk` → `${ANDROID_SDK_ROOT:-${ANDROID_HOME:?…}}` (ошибка с понятным сообщением, если не задано); `/home/sureg/net-disk` → `${NET_DISK_DIR:-$HOME/net-disk}`; `bash -n` OK |
| `*/app/build.gradle.kts` | `AUTH_USER`/`AUTH_PASS` → `buildConfigField` из `TESTER_AUTH_USER`/`TESTER_AUTH_PASS` (пароль по умолчанию пуст) — хардкода больше нет |
| `*/…/MainActivity.kt` | константы переведены на `BuildConfig`; убраны ссылки на `proxy/conf/.htpasswd` (Basic Auth в nginx удалён) |
| `*/README.md` | пути `./tools/<name>/…` → `./<name>/…`, `cd tools/…` → `cd …`; раздел Basic Auth переписан; требования сборки без `/home/sureg` и mono-Gradle |
| `LICENSE` (новый) | MIT, как в `animastor-docs` |
| `.gitignore` (новый) | `.gradle/`, `build/`, `local.properties`, `*.apk`, `.idea/`, `captures/`, `.DS_Store` |

Дерево кандидата: **54 пути** = 46 манифестных + `LICENSE` + `.gitignore` + `gradlew.bat`×2 + `gradle/wrapper/{gradle-wrapper.jar,gradle-wrapper.properties}`×2.
Побайтно с манифестом: **36/46** blobs идентичны; 10 изменений — только перечисленные выше (включая 2 redact-файла).

---

## 6. Проверки после переноса (на изолированной копии)

| Проверка | Результат |
|---|---|
| Дерево == манифест (46 путей, flatten) | **PASS** — путей ровно 46 + 8 ожидаемых добавлений; расхождений нет |
| Отсутствие секретов в файлах | **PASS** — 0 файлов с маркером; нет `.env`/credential/keystore/`local.properties`/`*.apk` в индексе |
| Отсутствие секретов в истории | **PASS** — 0 в blobs **и** 0 в сообщениях коммитов (7/7 коммитов) |
| Корректность путей и инструкций | **PASS** — README-пути переписаны под flatten; `bash -n` обоих скриптов; `/home/sureg` в кандидате не упоминается |
| Работоспособность инструментов | **PASS** — `./gradlew --version` автономно (Gradle 8.12, JDK 17) |
| Сборка APK | **PASS** — оба `assembleDebug` BUILD SUCCESSFUL (§1.4); сборка выполнялась из красактированной копии, т.е. доказывает и компилируемость очищенного кода |
| Git integrity | **PASS** — `git fsck --strict` чист; `git status` чист после сборок; bundle verify OK |
| Production и несвязанные репозитории | **PASS** — HEAD'ы не изменились: web `fbc9366`, mono `465453df`, backend `82c80af`, android `92a56c0`, worker `b3f94f4`, docs `bb8106c`, gpu-hub `0f489c7`. Замечание: в mono и backend есть **предсуществующие** грязные записи (website index/overlay yml; backend-тесты, `deploy/`, случайный `freebuff-chat-*.md`) — они были до Stage 81 и не связаны с этой работой |
| Целевой репозиторий | **PASS** — `Animastor/animastor-tools` пуст (ls-remote: 0 refs); push не выполнялся |
| CI/CD, Docker, deploy | **не затронуты** — на `tools/` не ссылается ни один workflow/compose (проверено Stage 80 §4, повторно: ничего не менялось) |

Ошибок сборки не было; все замечания выше — не относятся к самому переносу.

---

## 7. Что НЕ делалось

- Не выполнялся `push` (гейты 1 и 2 открыты); целевой репозиторий не изменён.
- Не изменялись рабочие репозитории: ни файлы, ни индексы, ни ветки, ни remotes; `filter-repo`/`filter-branch`/`--replace-text` на них не запускались.
- Не переписывалась история `animastor-backend` (включая публичный коммит `4cb917c` с паролем) и `animastor-web` (включая `9eac9048`).
- Не выполнялись попытки входа, смены или иной манипуляции с учётными данными; пароль в отчёт/чат/логи не выводился (временные файлы-заменители удалены).
- Не скачивались SDK-компоненты (SDK полон); не выполнялись разрушительные операции; глобальная конфигурация не менялась; `/home/sureg` не трогался.
- Устаревшие файлы (класс D: shim-`gradlew`) не удалялись молча — заменены официальным wrapper'ом с сохранением пути `gradlew`.
- `tools/` из `animastor-web` **не удалялся** (решение владельца, отдельный этап); mono-копия `tools/` не тронута; docs-ссылки не обновлялись.
- `/tmp/audit-tools-extract` (содержит `<пароль>`) не удалялся — оставлен как след до ротации.

---

## 8. Оставшиеся блокеры (что нужно от владельца)

1. **Ротация пароля** учётки `developer` (admin-роль) — обязательно до любой публикации; после ротации старый `<пароль>` в публичных web/backend-историях перестаёт быть эксплуатируемым.
2. **Решение по scope**: Вариант 1 (не публиковать 46 путей как «общие инструменты») или Вариант 2 (утвердить harness-репозиторий `animastor-tools` в подготовленном виде).
3. После 1+2: push из `81-tools-extraction/work` (добавить remote и пушить только `main`) и опционально — обновление ссылок `tools/…` в `animastor-web/README.md` и `animastor-docs` отдельными коммитами.

---

## 9. Артефакты (все в `/home/animastor/reorg-2026-10-19/`)

- `81-tools-extraction-report.md` — этот отчёт.
- `81-tools-extraction/work/` — изолированный кандидат (клон web → filter-repo → коммит `8851479`).
- `81-tools-extraction/81-animastor-tools.bundle` — полная redacted-история кандидата (проверен `git bundle verify`).
- Эфемерные логи (`/tmp`): `81-desktop-version.log`, `81-desktop-build.log`, `81-mobile-build.log`, `wrap-desktop.log`, `wrap-mobile.log`; тестовые APK — `/tmp/stage81-netdisk/{desktop,mobile}-web-tester.apk`.
