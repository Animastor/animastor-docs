> **Sanitized copy (Stage 82):** все вхождения пароля заменены на `<пароль>`; оригинал отчёта не изменён и сохранён как доказательство.

# 80 — Аудит блокеров выделения `tools/` в `Animastor/animastor-tools`

**Дата:** 2026-10-19
**Режим:** READ-ONLY. Ни один рабочий репозиторий и production не изменены. Коммитов, push, filter-repo/filter-branch/--replace-text на рабочих репозиториях не выполнялось. Целевой репозиторий не создавался и не изменялся.
**Основания:** `75-docs-tools-extraction-audit.md`, `75-tools-manifest.txt`; отчёты 76–79.

---

## 0. Итог

**Статус: PASS** — причины предыдущего BLOCKED восстановлены полностью, все блокеры локализованы, безопасная стратегия переноса доказана на изолированной копии (проверена в этом аудите заново). Перенос **не выполнялся**.

Три блокера Stage 75 подтверждены и классифицированы:

| # | Блокер | Статус после аудита 80 |
|---|---|---|
| 1 | Пароль Basic Auth в коде и истории | **Подтверждён и уточнён**: пароль живёт в 2 файлах HEAD, в истории web/mono, **и в сообщении коммита `9eac9048`, которое попало в публичный `animastor-backend`**. Вероятно, это ещё и пароль внутреннего логина учётки `developer` (password_hash не NULL) — т.е. **потенциально живая учётка**. Ротация обязательна до push. |
| 2 | Сборка зависит от чужого untracked Gradle | **Подтверждён**: `gradlew` — shim на `../../frontends/android/gradle-8.12`, которого нет в `animastor-web`; SDK `/home/sureg/Android/Sdk` отсутствует на VPS. |
| 3 | Состав «общих» инструментов не определён | **Подтверждён**: все 46 путей манифеста — два web-only harness'а (класс C). Кандидаты A/B (`scripts/*.sh`) лежат в mono `scripts/` и **не входят** в манифест 46 — это отдельная фаза. |

Отдельное наблюдение: «0 совпадений после `--replace-text`» из Stage 75 **подтверждено** на изолированном клоне `/tmp/audit-tools-redact` (0 в blobs **и** в сообщениях коммитов), но это не доказательство чистоты историй рабочих репозиториев — они по-прежнему содержат пароль (см. §2).

---

## 1. Точная причина предыдущего BLOCKED

Из `75-docs-tools-extraction-audit.md` §5, blockers 1–3 (tools-ветка) + результаты собственных проверок 80:

### 1.1 Какие проверки прошли в Stage 75 (tools)

- Манифест `75-tools-manifest.txt`: 46 путей из `animastor-web:main` (`fbc93662`) — **актуален**: дерево HEAD не изменилось (manifest == HEAD, проверено побайтно в 80).
- Извлечение на временном клоне: 6 коммитов, 46 файлов, дерево идентично источнику — **подтверждено в 80** (`/tmp/audit-tools-extract`, 7 hits `<пароль>`; `/tmp/audit-tools-redact`, 0 hits).
- Дерево `tools/` в mono == дерево в `animastor-web` (побайтно, 46/46 blob-хешей совпадают) — **подтверждено в 80**.

### 1.2 Какие проверки не прошли / не выполнялись

| Проверка | Результат |
|---|---|
| Чистота истории от секретов | **Не прошла**: `<пароль>` в HEAD и в истории web и mono; дополнительно в сообщении коммита в публичном backend |
| Сборка APK на VPS | **Не выполнялась и невозможна**: нет Android SDK (`/home/sureg/Android/Sdk` отсутствует), нет Gradle в web-репозитории |
| Ротация пароля | **Не выполнялась** (действие владельца) |
| Push в целевой repo | Не выполнялся (цель аудита) |
| Параметризация абсолютных путей | Не выполнялась |

### 1.3 Является ли `<пароль>` единственным блокером

**Нет.** Блокеров три (см. §0). Даже после полной ротации и замены хардкода остаются: сломанный `gradlew`-shim, отсутствие SDK, абсолютные пути `/home/sureg/...`, неопределённый scope (harness-репозиторий vs общие инструменты), отсутствие LICENSE, устаревшие пути в README.

### 1.4 «0 совпадений» ≠ чистая история

Подтверждено: `--replace-text` из Stage 75 применялся **только** к изолированному клону (сейчас это `/tmp/audit-tools-redact`, 0 hits в blobs и сообщениях). Рабочие репозитории не переписывались и содержат пароль в:

- HEAD `animastor-web` (2 файла) и HEAD mono (2 файла);
- истории web (7 diff-строк в tools-пути + 1 сообщение коммита) и mono (2 +/- строки + 1 сообщение коммита);
- **сообщении коммита в публичном `animastor-backend`** (`4cb917c`, на `main`, удалённо доступен).

Важно о механизме: `filter-repo --replace-text` переписывает **только содержимое blobs**, не сообщения коммитов. Для сообщений нужен `--replace-message`/message-callback. В данном случае сообщение `9eac9048` НЕ затрагивает `tools/` и в извлечённую историю tools-repo не попадает (проверено: 0 message-hits в redact-клоне) — но это надо иметь в виду для будущих операций.

---

## 2. Проверка истории и содержимого (46 путей)

### 2.1 Источник и состояние

| Параметр | Значение |
|---|---|
| Исходный репозиторий | `animastor-web`, `/home/animastor/animastor-web`, ветка `main` |
| HEAD | `fbc93662035df84c8e103df0d0706800aa96cba1` (2026-10-11, domain migration) — совпадает с GitHub `refs/heads/main` (ls-remote) |
| Worktree | **чистый** (`git status --porcelain` пуст), untracked в `tools/` нет |
| Область переноса | `tools/**` = 21 файл `desktop-web-tester/` + 25 файлов `mobile-web-tester/` = **46** |
| Манифест Stage 75 | == текущему HEAD (сверено: `ls-tree -r HEAD -- tools/` побайтно совпадает с `75-tools-manifest.txt`) |
| Коммитов, затрагивающих `tools/` | **6** (`8e65770`, `f2edf8d`, `39c6f97`, `34d92ba`, `d1659ad`, `fbc9366`); авторы: «Sergey Khabarov», «Animastor» |
| Удалённых/переименованных файлов в истории tools | нет — все 46 путей лишь добавлялись/менялись; иного состава в истории не было |

Дубликат: `tools/` в mono (`c21.4`, HEAD `465453df`) **побайтно идентичен** web-версии (все 46 blob-хешей совпадают). Источником для извлечения остаётся `animastor-web` (Stage 75, §4.2) — mono-копия не добавляет истории.

### 2.2 Чувствительные данные: точная инвентаризация

Значение пароля здесь и в чате не воспроизводится; обозначим его `<пароль>`.

**A. В файлах (blobs) — реальный секрет:**

| Место | Что | Оценка |
|---|---|---|
| `tools/desktop-web-tester/.../MainActivity.kt:415–416` | `AUTH_USER = "admin"`, `AUTH_PASS = "<пароль>"` (хардкод, WebView Basic Auth) | **Реальный секрет**, не тестовый пример |
| `tools/mobile-web-tester/.../MainActivity.kt:409–410` | то же | **Реальный секрет** |

**B. В истории Git (diff-строки):**

| Репозиторий | Совпадений | Коммиты |
|---|---|---|
| animastor-web (`log -p --all`, полное дерево) | 8 строк (2 add-строки с паролем, остальные — context-строки последующих диффов) | `8e65770`, `39c6f97` (add), `f2edf8d`, `d1659ad`, `fbc9366` (context) |
| animastor-web (tools-фильтр) | 7 строк — совпадает с цифрой Stage 75 | — |
| animastor (mono) | 2 +/- строки (`^[+-]`) | `ef62ab2e`, `f16ca75c` |
| animastor-backend | **0** в blobs | — |
| animastor-docs | 0 | — |

**C. В сообщениях коммитов (новая находка 80, важна):**

| Репозиторий | Коммит | Содержание | Публичность |
|---|---|---|---|
| animastor-web | `9eac9048` «admin: replace Basic Auth with internal app login» | тело: «Login uses existing user system (developer/`<пароль>`)» | **на `main` публичного repo** |
| animastor (mono) | `eb131cdc` (тот же коммит) | то же | mono не публичен (origin = локальный bare) |
| animastor-backend | `4cb917c` (тот же коммит, cherry-pick/merge) | то же | **на `main` публичного `Animastor/animastor-backend`** (ls-remote: `82c80afd…`) |

Эти вхождения **не входят** в извлечённую историю tools (коммит не трогает `tools/`), но критичны для общей оценки утечки.

**D. Живой статус пароля (read-only диагностика production):**

- `proxy/conf/default.conf`: **нет ни одного `auth_basic`** — nginx Basic Auth **удалён из конфигурации** (в соответствии с `9eac9048`: «replace Basic Auth with internal app login»). Следовательно «те же креды, что в `.htpasswd`» из комментариев тестеров уже неверны: `.htpasswd` смонтирован в контейнер (пользователь `admin` существует), но нигде не подключён.
- Бэкенд: `POST /api/v1/auth/login` сверяет пароль с таблицей `users`; у сидированной учётки `developer` (роль `admin`, `schema.js:1259`) поле `password_hash` **не NULL** (`is_null = f`). Сообщение коммита `9eac9048` прямо связывает `developer` с `<пароль>`.
- **Вывод:** `<пароль>` — скорее всего **действующий пароль внутреннего логина администратора** (не только устаревший Basic Auth). Это усиливает Blocker 1: пароль публичен в GitHub с 2026-08-10 и одновременно может открывать admin-доступ сейчас. **Ротация обязательна независимо от миграции tools.**

**E. Прочее:**

- Секретоподобных паттернов (api_key/token/private-key/AWS/ghp и т.п.) в 46 файлах и в их истории — **не найдено**.
- `.env`, credentials, keystore, `.jks` — **не упоминаются**. `local.properties` только генерируется скриптом (`sdk.dir=…`), в Git не коммитится.
- PII в содержимом файлов (email/телефоны) — **нет**. В метаданных коммитов — обычные авторские имя+email (личный gmail + динамический IP-хостнейм); это стандартная информация Git-истории, переносится как есть (см. §5, п. 3).
- Случайных артефактов (APK, .idea, .DS_Store, логов) в истории tools — **нет** (полный перечень путей истории = ровно 46).

### 2.3 Новые совпадения после предыдущей проверки?

**Нет.** В web/mono не было коммитов после 2026-10-11 (`log --all --since=2026-10-19` пуст); счётчики совпадений не изменились (7 в tools-фильтре, как в Stage 75). HEAD и worktree неизменны.

### 2.4 Безопасная стратегия сохранения истории

Доказана практикой Stage 75 и перепроверена в 80 — **изолированная копия, рабочие репозитории не трогаются**:

```
git clone --no-local /home/animastor/animastor-web /tmp/animastor-tools-redact
cd /tmp/animastor-tools-redact
git filter-repo --path tools/ --path-rename tools/: \
  --replace-text <файл-замен>            # <пароль> → REDACTED (2 blobs)
# проверки: 0 hits в blobs И сообщениях; дерево == манифесту (кроме 2 redact-файлов)
git remote add origin git@github.com:Animastor/animastor-tools.git
git push -u origin main                   # в пустой repo, без force
```

Текущий проверенный прототип: `/tmp/audit-tools-redact` — 6 коммитов, 46 файлов (пути уже на уровне корня), 588 KiB; от источника отличаются **ровно 2 blobs** (оба `MainActivity.kt`, где `AUTH_PASS = "REDACTED"`); 0 совпадений в blobs и сообщениях всех 6 коммитов (проверено rev-list-сканом по каждому коммиту).

Ограничение: `--replace-text` не трогает сообщения коммитов — для tools-истории это неактуально (нет message-совпадений), но при любой будущей фильтрации требуется отдельная проверка `git log --all --format='%s%n%b' | grep …`.

---

## 3. Классификация 46 путей

Классы по Stage 75: **A** — общий инструмент системы; **B** — обслуживает несколько компонентов; **C** — один компонент; **D** — устаревшее/дублирующееся/неиспользуемое (отметить, не удалять).

Все 46 путей принадлежат двум проектам-харнессам для web-фронтендов (`frontends/app`, mobile web). Назначение, зависимости и категория по группам (полный перечень путей — `75-tools-manifest.txt`; группы покрывают все 46):

### 3.1 desktop-web-tester (21 файл) — класс **C** (web-харнесс)

| Группа путей (кол-во) | Назначение | Зависимости | .env / credentials | Абс. пути | Внутри компонента обязательно? | Класс |
|---|---|---|---|---|---|---|
| `README.md` (1) | Инструкция; ссылается на `./tools/desktop-web-tester/...` | — | упоминает хардкод кредов в `MainActivity.kt` | упоминает `/home/sureg/...` | нет — переписать пути после переноса | C (править) |
| `build-apk.sh` (1) | Сборка debug APK + копия в net-disk | JDK 17, gradle, Android SDK | нет | **да**: `sdk.dir=/home/sureg/Android/Sdk`, `cp … /home/sureg/net-disk/…` | нет — параметризовать (`ANDROID_SDK_ROOT`, `NET_DISK_DIR`) | C (править) |
| `gradlew` (1) | **Shim**, не wrapper: `exec ../../frontends/android/gradle-8.12/bin/gradle` | untracked Gradle в mono | нет | нет | **нет — сломан в standalone** | **D** — заменить официальным wrapper'ом (см. §5.6) |
| `gradle.properties`, `build.gradle.kts` (root), `settings.gradle.kts` (3) | Gradle-конфигурация; плагины `com.android.application 8.7.3`, Kotlin 1.9.22 из google/mavenCentral | сеть (репозитории) | нет | нет | да | C |
| `app/build.gradle.kts`, `app/proguard-rules.pro` (2) | Модуль приложения, proguard | то же | нет | нет | да | C |
| `app/src/main/AndroidManifest.xml` (1) | Манифест WebView-приложения | — | нет | нет | да | C |
| `MainActivity.kt` (1) | WebView-эмулятор десктопа (1280–1920px); загружает `https://app.animastor.org` | Android SDK | **да — хардкод Basic Auth (`admin`/`<пароль>`), `onReceivedHttpAuthRequest`** | нет | да (после замены кредов на BuildConfig/env) | C (править) |
| `res/drawable/*` (5), `res/layout/*` (1), `res/mipmap-anydpi-v26/*` (2), `res/values/*` (3) | UI-ресурсы (фоны, иконка, строки, темы) | — | нет | нет | да | C |

### 3.2 mobile-web-tester (25 файлов) — класс **C** (web-харнесс)

| Группа путей (кол-во) | Назначение | Зависимости | .env / credentials | Абс. пути | Внутри компонента обязательно? | Класс |
|---|---|---|---|---|---|---|
| `README.md` (1) | Инструкция; `./tools/mobile-web-tester/...` | — | упоминает хардкод кредов | упоминает `/home/sureg/...` | нет — переписать пути | C (править) |
| `build-apk.sh` (1) | Сборка + копия в net-disk | JDK/gradle/SDK | нет | **да** (`/home/sureg/…`) | нет — параметризовать | C (править) |
| `gradlew` (1) | Shim на внешний Gradle | untracked Gradle | нет | нет | **нет — сломан** | **D** — заменить wrapper'ом |
| `gradle.properties`, `build.gradle.kts` (root), `settings.gradle.kts` (3) | Gradle-конфигурация (`rootProject.name = "MobileWebTester"`) | сеть | нет | нет | да | C |
| `app/build.gradle.kts`, `app/proguard-rules.pro` (2) | Модуль приложения | то же | нет | нет | да | C |
| `AndroidManifest.xml` (1) | Манифест | — | нет | нет | да | C |
| `MainActivity.kt` (1) | WebView с телефонным viewport (360/390/430); `https://app.animastor.org` | Android SDK | **да — хардкод Basic Auth (`admin`/`<пароль>`)** | нет | да (после замены кредов) | C (править) |
| `res/drawable/*` (9), `res/layout/*` (1), `res/mipmap-anydpi-v26/*` (2), `res/values/*` (3) | UI-ресурсы (рамка телефона, батарея, сигнал и т.д.) | — | нет | нет | да | C |

### 3.3 Итоги классификации

- **A (общесистемные): 0** в манифесте. Кандидаты класса A живут в mono `scripts/` (`animastor-runtime-audit.sh`, `syntax-smoke.sh`) — **вне 46 путей**, отдельная фаза (§5.9).
- **B (межкомпонентные): 0** в манифесте.
- **C (компонентные, web-харнесс): 44** — переносятся в `animastor-tools` как содержимое harness-репозитория либо остаются в `animastor-web` (решение владельца, §5.9).
- **D (устаревшее/дублирующееся): 2** — оба `gradlew`-shim'а: не являются Gradle wrapper'ами, дублируют внешнюю установку Gradle, в standalone-репозитории **неработоспособны**. Не удалять молча: заменить официальным wrapper'ом (gradle-wrapper.jar + properties) либо явно требовать `GRADLE_BIN`.

Т.е. Blocker 3 Stage 75 подтверждён количественно: «общих инструментов» в зоне переноса нет вообще; `animastor-tools` в объёме манифеста — это harness-репозиторий, а не «общий tools».

---

## 4. Интеграционные зависимости

| Тип | Результат проверки (read-only, HEAD всех репозиториев) | Что менять после переноса |
|---|---|---|
| CI/CD workflows | Единственный workflow — `animastor-backend/.github/workflows/backend-ghcr-release.yml`; **не ссылается** на `tools/`. У web/worker/android/mono workflow нет | ничего |
| package.json / lock-файлы | Ссылок на `tools/` **нет** (web, worker) | ничего |
| Docker (compose/Dockerfile/.dockerignore) | Ссылок на `tools/` **нет** ни в deploy-compose, ни в mono/backend compose | ничего |
| Shell-скрипты | Внутренние ссылки только в самих `build-apk.sh` (самодостаточны, кроме `/home/sureg`) | параметризация путей |
| README web | `animastor-web/README.md:34–37` — дерево включает `tools/` | **удалить/заменить** строку дерева, добавить ссылку на `Animastor/animastor-tools` |
| README тестеров | `tools/*/README.md`: `./tools/<name>/build-apk.sh`, `cd tools/<name>` — **внутренние** пути | переписать на `./<name>/…` (после flatten) |
| Ссылки из других репозиториев на `tools/<tester>` | backend/worker/android — **0**. mono — только в `docs/*` (см. ниже) | см. docs |
| Ссылки в animastor-docs (уже в production, Stage 79) | `08-mobile-web-migration/07-MOBILE-WEB-TESTER.md`, `08/README.md`, `09-desktop-migration/02-PROGRESS.md`, `CHANGELOG.md` — упоминают `tools/mobile-web-tester`, `tools/desktop-web-tester` | **не блокер**: это историко-описательные ссылки; обновить на URL нового repo отдельным docs-коммитом (необязательно, но рекомендуется) |
| Collision имён `tools/` | `packages/animastor-worker/tools/sync-protocol.cjs` — **свой** tools у worker, не связан; `packages/animastor-web-workers/.../workerSetup.ts:126` — `$HOME/animastor/tools/status.sh` это **runtime-путь на хостах воркеров**, не путь репозитория | ничего не менять |
| Требования к cwd | Тестеры самодостаточны по каталогу проекта; внешняя связь только через shim `gradlew` (Blocker 2) | wrapper или `GRADLE_BIN` |
| Зависимости от структуры монорепозитория | **Единственная**: shim `gradlew` → `../../frontends/android/gradle-8.12` | устраняется wrapper'ом |

Вывод: интеграционная нагрузка переноса **минимальна** — один README (web), пути внутри двух README тестеров, два `build-apk.sh`, два `gradlew`. CI/Docker/deploy не затрагиваются.

---

## 5. Предлагаемый план переноса `Animastor/animastor-tools`

### 5.1 Точный список переносимых файлов

Все 46 путей `75-tools-manifest.txt` (`tools/desktop-web-tester/**` — 21, `tools/mobile-web-tester/**` — 25), на уровне корня нового repo (`desktop-web-tester/`, `mobile-web-tester/`), плюс добавляемые файлы:

1. `LICENSE` (MIT, как в `animastor-docs`);
2. два `gradlew` — **в виде официального wrapper'а** (см. 5.6), либо исходные shim'ы с явным `GRADLE_BIN` (решение владельца);
3. опционально `.gitignore` (build/, local.properties, *.apk).

### 5.2 Файлы, остающиеся в исходных репозиториях

- В `animastor-web`: всё вне `tools/**` (frontends, packages, docs и пр.); после миграции — решение, удалять ли `tools/` из web (Stage 75 рекомендовала оставить до подтверждения владельца; удаление — отдельный этап с отчётом).
- В mono `c21.4`: копия `tools/` (побайтная дубликация) — не трогать (mono заморожен как источник docs).
- `backend/scripts/*`, `packages/*/tools/*`, `scripts/check-artifacts.sh`, `scripts/enable-admin-https.sh`, `scripts/generate-parser-golden-fixtures.js`, `scripts/o3-scc-audit.cjs` — остаются по месту (класс C, Stage 75 §3.3).

### 5.3 Стратегия сохранения Git-истории

Изолированная копия (§2.4): clone → `filter-repo --path tools/ --path-rename tools/: --replace-text` → push в пустой public repo **без force**. История: 6 коммитов, даты/авторы/сообщения сохраняются. Рабочие репозитории, ветки, refs, remotes — **не изменяются**.

### 5.4 План устранения подтверждённых секретов

1. **Обязательная ротация** пароля владельцем: учётка `developer` (admin-роль, internal login) — сменить пароль; после ротации старый `<пароль>` становится мёртвым и его публичность в web/backend-истории перестаёт быть эксплуатируемой.
2. В извлечённой истории: `--replace-text` (2 blobs, маркер `REDACTED`) — уже доказано.
3. В будущем коде: убрать хардкод — читать `AUTH_USER`/`AUTH_PASS` из BuildConfig/gradle-properties/env; комментарии «те же креды, что в `.htpasswd`» переписать (Basic Auth в nginx удалён).
4. Сообщение коммита `9eac9048` с паролем остаётся в публичных web/backend — **не переписывать действующие репозитории**; нейтрализация — только ротацией (п. 1). Владелец должен быть проинформирован, что «0 hits в tools-репозитории» не делает пароль секретным в остальных repo.

### 5.5 Проверки целостности исходной и целевой истории

```
# до push (в изолированной копии)
git rev-list --all --count                        # == 6
git ls-tree -r HEAD --name-only | wc -l           # == 46 (+LICENSE и пр.)
git log -p --all | grep -c '<пароль>'               # == 0  (включая context)
git log --all --format='%s%n%b' | grep -c '<пароль>'# == 0  (сообщения!)
diff <(git ls-tree -r HEAD | grep -v -e MainActivity.kt -e LICENSE) <(grep -v MainActivity 75-tools-manifest.txt | sed 's|\ttools/|\t|')  # == пусто
# после push
git ls-remote git@github.com:Animastor/animastor-tools.git main   # SHA == локальному HEAD
```

### 5.6 Изменения путей и ссылок

- `gradlew`: заменить shim на официальный wrapper (генерация через существующий Gradle 8.12 в mono: `gradle wrapper --gradle-version 8.12`; проверить `./gradlew --version` без внешних путей) — либо документировать `GRADLE_BIN`. Файл класса D не должен попасть в новый repo в нынешнем виде.
- `build-apk.sh` (×2): `/home/sureg/Android/Sdk` → `${ANDROID_SDK_ROOT:?}`; `/home/sureg/net-disk` → `${NET_DISK_DIR:-$HOME/net-disk}`.
- `README.md` тестеров (×2): `./tools/<name>/…` → `./<name>/…`.
- `animastor-web/README.md`: убрать строку `tools/` из дерева, добавить ссылку на `Animastor/animastor-tools`.
- Опционально (docs repo): обновить 4 исторических упоминания `tools/<tester>` на новый repo.

### 5.7 Минимальный набор тестов после переноса

1. Счётчики: 6 коммитов; файлы = 46 + LICENSE (+wrapper/gradle-файлы wrapper'а).
2. `git log -p --all | grep <пароль>` == 0 и message-scan == 0.
3. `./gradlew --version` в каждом проекте — работает **без** mono (`frontends/android` не нужен).
4. `./gradlew assembleDebug` — **только при наличии Android SDK**; на текущем VPS SDK нет → это limitation проверки (зафиксировать в отчёте миграции, не блокер переноса).
5. `./build-apk.sh` с заданными `ANDROID_SDK_ROOT`/`NET_DISK_DIR` — без записи вне `NET_DISK_DIR`.
6. `bash -n` для обоих `build-apk.sh`; `git fsck` в новом repo.

### 5.8 План отката

- До push: откат = удалить изолированную копию; действующие репозитории и production не затронуты (по построению).
- После push в пустой public repo: `git push origin --delete main` (или удалить repo) — безопасно, т.к. ничего от него не зависит (никакие CI/Docker/deploy на `tools/` не ссылаются, §4).
- Пароль: откат ротации невозможна — hence ротация выполняется последней, после финального содержательного одобрения, либо заранее с обновлением harness-кода.

### 5.9 Ключевое решение владельца (scope)

- **Вариант 1 (рекомендованный Stage 75):** `animastor-tools` = общие A/B-инструменты из mono `scripts/` (`animastor-runtime-audit.sh`, `syntax-smoke.sh`, опционально архив `split-guards/`, `translate_docs.py` → docs) **после параметризации путей**; web-тестеры остаются в `animastor-web`. Требует нового манифеста из mono (46-путевой манифест сюда не входит) и отдельного аудита mono-скриптов.
- **Вариант 2:** `animastor-tools` = harness-репозиторий (46 файлов манифеста) — тогда §5.1–5.8 выше выполняются как есть, а обязательные исправления (5.4, 5.6) становятся gate'ом перед push.

Оба варианта технически готовы; различие — только в наборе файлов и параметризации mono-скриптов.

### 5.10 Критерии PASS для будущей миграции (Stage 81+)

1. Ротация пароля `developer` подтверждена владельцем.
2. Выбран вариант scope (5.9).
3. `gradlew` — официальный wrapper (или задокументированный `GRADLE_BIN`).
4. `build-apk.sh` — без абсолютных путей.
5. 0 совпадений секретов в blobs и сообщениях новой истории; SHA после push совпадает с локальным.
6. `./gradlew --version` работает автономно.
7. `LICENSE` присутствует; README-пути актуальны.

---

## 6. Риски и блокеры

| Риск | Серьёзность | Митигация |
|---|---|---|
| Пароль публичен в GitHub (web с 2026-08-10, backend main) и, вероятно, действителен как пароль admin-учётки | **Высокая** | Ротация до любых новых публикаций; хардкод убрать из кода |
| Слова «0 hits» могут создать ложное чувство безопасности | Средняя | В отчёте зафиксировано: чиста только изолированная копия; рабочие истории не переписаны |
| Несамодостаточная сборка (shim-gradlew, нет SDK) | Средняя | Wrapper + `GRADLE_BIN`; assembleDebug отложить до наличия SDK |
| Scope-неопределённость (harness vs общие инструменты) | Средняя | Решение владельца (5.9) |
| PII в метаданных (имя/email авторов) | Низкая | Стандартная практика Git; перенос как есть, владелец предупреждён |
| Дубликат `tools/` в mono | Низкая | Не трогать; источник — web |
| Docs-ссылки на `tools/` станут историческими | Низкая | Опциональный docs-коммит (§4) |

---

## 7. Что НЕ делалось

- Не изменялись файлы, индексы, ветки, remotes, права в рабочих репозиториях.
- Не выполнялись commit/push/filter-repo/filter-branch/--replace-text на рабочих репозиториях (проверки фильтрации — только на существующих временных клонах `/tmp/audit-tools-*`, созданных в Stage 75 и неизменённых в 80).
- Целевой репозиторий `Animastor/animastor-tools` не создавался, не изменялся, не пушится (ls-remote подтвердил: пуст, 0 refs).
- Production (nginx, Compose, контейнеры, документация) не затрагивался; проверки — read-only curl/inspect/exec.
- Резервные копии и рабочие каталоги не удалялись.
- Пароль в отчёт и чат не выводился.

## 8. Диагностические данные (все в `/home/animastor/reorg-2026-10-19/`)

- `75-tools-manifest.txt` — исходный манифест (сверен с HEAD).
- `/tmp/audit-tools-extract` — изолированная копия без редактирования (7 hits, подтверждение).
- `/tmp/audit-tools-redact` — изолированная копия с replace-text (0 hits; прототип целевого repo).
- Ключевые факты §2–§4 воспроизводимы командами из §5.5.
