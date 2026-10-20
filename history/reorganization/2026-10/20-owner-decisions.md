# Animastor — Этап 20: OWNER DECISIONS PREPARATION

- Дата: 2026-10-12
- Режим: **только аудит и подготовка решений. Ничего не внедрялось.**
- Источники: `18-cutover-blockers-audit.md` и `19-cutover-readiness-plan.md`
  (прочитаны целиком), связанные: `13-production-cutover-audit.md`,
  `04-sync-matrix.md`, `05-sync-plan.md`, `07-web-sync-report.md`,
  `10-cross-repo-audit.md`, `12-github-publish-report.md`.
- Запрещённое не выполнялось: production-изменения, рестарты, Compose-switch,
  dispatch, repin, republish, git push, удаление файлов, изменение lock-файлов,
  секретов, DNS/TLS. Файлы не копировались.

---

## 1. INDEX.HTML — сравнение production и web-репозитория

### 1.1 Факты (свежие пробы, 2026-10-12)

| | production (монорепо) | web-репозиторий |
|---|---|---|
| Путь | `/home/animastor/animastor/frontends/website/index.html` | `/home/animastor/animastor-web/frontends/website/index.html` |
| SHA256 | `276a5fc4a4f081239376758a8dab0468b36e70424e0abe32713d367c30f8c12c` | `a1900f4ece7f07f4cdca0c5df7530fffcc415057ee2968a79f213e4a874b356c` |
| Размер | 8998 B (Oct 8) | 9010 B (Oct 11) |
| git | mono HEAD `465453df`, дерево чистое | web HEAD `fbc93662`, дерево чистое |
| Живой ответ | `curl https://animastor.org/` → sha256 = **`276a5fc4…`** (точное совпадение — prod отдаёт монорепо-копию) | не отдаётся в prod |

### 1.2 Содержательные различия (полный diff — ровно 4 строки, 2 хунка)

| # | Строка | production (mono) | web-репо | HTTP-статус |
|---|---|---|---|---|
| 1 | карточка «GitHub repository» (~стр.143) | `github.com/Animastor/animastor` | `github.com/Animastor/animastor-web` | **404** / 200 |
| 2 | карточка «Docs folder» (~стр.150) | `…/animastor/tree/master/docs` | `…/animastor-web/tree/main/docs` | **404** / 200 |
| 3 | футер «GitHub» (~стр.176) | `github.com/Animastor/animastor` | `github.com/Animastor/animastor-web` | **404** / 200 |
| 4 | футер «Docs» (~стр.177) | `…/animastor/tree/master/docs` | `…/animastor-web/tree/main/docs` | **404** / 200 |

**Больше различий нет.** Проверено отдельно:

- **Домены/SEO идентичны:** в обеих версиях `canonical = https://animastor.org/`,
  `og:url = https://animastor.org/`, 3× кнопка `app.animastor.org`,
  2× `support@animastor.org`; строк `animastor.in` — **0** в обеих.
- **Поведение сайта идентично:** остальной каталог website отличается только
  файлом `index.html`; `site.js`, `styles.css`, `library/`, favicon — байт-в-байт;
  отдаётся одна и та же статика, JS/CSS не зависят от этих ссылок (это 4
  статических `<a>`).
- **Влияние 404:** живая страница содержит **4 битые ссылки** (2 цели × 2
  места: карточка + футер). Пользователь, нажав «GitHub repository»/«Docs»,
  попадает на 404 GitHub. Причины: репозиторий `Animastor/animastor` в GitHub
  **не существует** (монорепо опубликован только в локальный bare
  `/home/animastor/repos/animastor.git`; этап 8 публиковал 4 других репо) и
  ветка `master` (в web-репо — `main`).
- Веб-версия ссылается на существующие `Animastor/animastor-web` (200) и
  `tree/main/docs` (200).

### 1.3 Рекомендуемый вариант и безопасный переход

**Рекомендуемый контент — версия web-репозитория** (`a1900f4e…`): это
зафиксированное пост-split решение (отчёты 04:104 и 07 §4/§58), и только её
ссылки живые.

Два способа перехода (выбор — решение владельца; **ни один сейчас не выполнялся**):

| Вариант | Что делается | Когда | Риск | Откат |
|---|---|---|---|---|
| **(а) РЕКОМЕНДУЕТСЯ: точечная синхронизация** | заменить ровно 4 строки в mono `index.html` на web-вариант (файлы станут байт-идентичны) | отдельное согласованное окно (это live-контент — production change, требуется разрешение) | минимальный: статический файл, nginx отдаёт без перезапуска; 404 исчезают сразу | `git -C animastor checkout -- frontends/website/index.html` (файл закоммичен) |
| (б) переключение mount на web-репо | при cutover поднять монт `./frontends/website` из web-каталога; предварительно вне git разместить в web-каталоге `downloads/animastor-android-latest.apk` и `.well-known/` (ACME webroot!) | окно cutover (шаг 5 плана 13) | средний: переезд APK и ACME-webroot (дедлайн серта 19.11) | вернуть прежний mount mono-каталога (копия не удалялась) |

Вариант (а) снимает блокер 404 **и** упрощает будущий (б): два файла станут
идентичны — 3-way для mount-switch больше не нужен. Копирование файлов на этом
этапе не выполнялось.

---

## 2. ARTIFACT REPIN — целевой состав и верификация штатными tool-ами

Все проверки — **только штатными инструментами проекта**; собственные формулы
digest не применялись, `ad20386c…` не использовался, lock/pin/активы не менялись.

### 2.1 Результаты (W1–W4 из плана 19)

| Проверка | Инструмент | Результат |
|---|---|---|
| **W1** served-bundle == pin | `curl /gpu/worker-bundle` + `git show 618f87a6:… \| cmp` (байтовое сравнение, все 8 файлов) | **8/8 OK, 0 DIFF** → живой hub отдаёт ровно пин `618f87a6` |
| **W1b** served vs worker@HEAD | `cmp` (worker.cjs, package.json, .env.example) | 3/3 **DIFF** → контент пина ≠ HEAD (доменная миграция `b3f94f4`) |
| **W2 (пины)** staging-verify | `scripts/stage-artifacts.cjs --worker <pin> --backend <pin>` (копия репо и клоны **в /tmp**, без `--write-lock`) | **exit 0**, «staging verified against artifacts.lock.json»; tool сам вывел: worker-bundle 8/`4bb0408b…`/2.1.1, workflows 9/`0d51107d…`, installer-src 32/`02fad99e…`/0.1.0, install-manifests 3/`46f3c26a…` |
| **W2 (HEAD)** тот же tool | clone worker `b3f94f42` + backend `a7a8c463` | **exit 1** — «STAGING FAILED», tool перечислил: источники != pinned; worker-bundle `staged=417c0ad4… != lock=4bb0408b…`; installer-src `staged=ff27e291… != lock=02fad99e…`; installer-src version **0.1.1 != 0.1.0** |
| **W3** mono lock | `tools/update-artifacts-lock.cjs --check` | **exit 0** «in sync with source trees» |
| **W4** release-активы | скачивание 4 зипов → `sha256sum` == `sha256_asset` (выполнено в этапе 18) | **4/4 MATCH** (тела активов неизменяемы) |

Все значения в этой секции — **собственный вывод tool-ов** (W2), не пересчёт.

### 2.2 Происхождение артефактов (provenance)

- CI (`ghcr-release.yml:50,80`) чекаутит коммиты из lock L2 и гоняет тот же
  `stage-artifacts.cjs` → production-образ `daf510ff` содержит контент пинов.
- Теги GitHub: `worker-bundle-v2.1.1 → 618f87a6` (= пин worker), тег
  `hub-artifacts-v1 → bce64db3` (backend).
- Release-зипы пакует `tools/standalone-fixture.cjs` (монорепо) **из mono-дерева**
  (комментарий tool-а: «packs the SAME list into the release zips»); отсюда:
  - `animastor-worker-bundle-2.1.1.zip` (`.org`-контент) ≠ tar.gz, отдаваемому
    hub'ом (пин, `.in`-контент) — **два разных «2.1.1»**;
  - `installer-src-v1.zip` содержит `git clone …/animastor.git` → **404**,
    тогда как `backend@98c4fbd6` и `@a7a8c463` уже имеют `animastor-worker.git`
    (фикс в репо есть, в опубликованном активе — нет).

### 2.3 Таблица решений (для владельца)

| Артефакт | Текущий pin (L2) | Фактический артефакт сейчас | Источник | Расхождение | Рекомендуемое решение |
|---|---|---|---|---|---|
| **worker-bundle** | worker `618f87a6`, 8 файлов, `4bb0408b…`, 2.1.1 | ① живой hub = **пин** (W1: 8/8 OK, внутри 3× `animastor.in`); ② release-zip = mono/HEAD-контент (`.org`) | ① CI из пина; ② `standalone-fixture` из mono | пин ↔ HEAD: `.env.example`, `package.json`, `worker.cjs` (миграция `b3f94f4`); два разных байта под одной версией 2.1.1 | **repin на worker `b3f94f42` (HEAD)** штатным `stage-artifacts.cjs --write-lock` в согласованное окно; после — CI-релиз и новый `GPU_HUB_IMAGE`. Убрать `.in`-fallback из раздачаемого бандла |
| **installer-src** | backend `98c4fbd6`, 32 файла, `02fad99e…`, **0.1.0** | ① CI-стейдж = пин (0.1.0, URL верный); ② release-zip v0.1.1 = mono-контент с **404 URL**; ③ HEAD `a7a8c463` = 0.1.1, URL верный, tree `ff27e291…` (данные tool-а) | ①/③ — backend-repo; ② — mono | три разных содержимых при двух «0.1.1»; актив с 404 закреплён в L1 | **repin на backend `a7a8c463` (HEAD)** + **republish release-актива** (исправить 404 URL) отдельным разрешением; затем обновить L1 (`--check` сейчас зелёный только для mono-дерева) |
| workflows | backend `98c4fbd6`, `0d51107d…` | == pin и == HEAD (W2: оба совпали) | backend-repo | **нет** | pin не трогать |
| install-manifests | backend `98c4fbd6`, `46f3c26a…` | == pin и == HEAD | backend-repo | **нет** | pin не трогать |

Порядок исполнения (только класс C, отдельное разрешение):
`--write-lock` → CI ghcr-release → новый digest в `.env` → повтор E2E (§4 плана 19).
Откат: вернуть `GPU_HUB_IMAGE=…@sha256:daf510ff8e6d…`.

---

## 3. POSTGRESQL / REDIS — происхождение и политика compose-references

### 3.1 Происхождение (установлено)

| Свидетельство | Значение |
|---|---|
| `docker inspect animastor-pg/redis` → `Created` | **2026-07-08T13:37:11Z** (оба) |
| labels | `config_files=/home/sureg/animastor/docker-compose.yml`, `working_dir=/home/sureg/animastor`, `project=animastor`, `service=postgres/redis`, `version=5.0.2`, `config-hash=633aebb4…/d77cc2be…` |
| Текущий статус | `Up 6 weeks (healthy)` → перезапуск ~31.08 (без пересоздания — Created сохранился) |
| Файл | **MISSING**; `find /home/sureg -name 'docker-compose*.yml'` — пусто; в `/home/sureg/animastor/` остался только `worker/` (mtime Aug 31); mtime каталога `.` = Oct 11 21:52 (активность владельца sureg, внешняя) |
| Связь дат | дата создания контейнеров (08.07) предшествует удалению файла; запись — **остаток от создания проекта из каталога sureg**, после чего файл был удалён |

Вывод: pg/redis **созданы 08.07.2026 через `-f /home/sureg/animastor/docker-compose.yml`**
(Compose v5.0.2); labels — артефакт того запуска; с тех пор контейнеры только
перезапускались, не пересоздавались.

### 3.2 Влияют ли записи на реальные операции управления? (проверено empirically)

| Операция | Влияние stale-записи | Доказательство (сегодня) |
|---|---|---|
| Работа контейнеров, рестарты демона, healthcheck, exec, логи | **нет** — labels инертны | pg/redis healthy 6 недель; `Created` не менялся |
| `docker compose up` (текущий набор -f из mono) | **нет** — **никакого recreate** | `up --dry-run` → все 5: `Container … Running` (включая pg/redis), exit 0 |
| `docker compose up` репо-compose (`animastor-backend/docker-compose.yml`, `--project-name animastor`) | pg/redis **Running** (recreate НЕ планируется); `backend → Recreate` (его конфиг действительно отличается — ожидаемо и планируется) | dry-run exit 1 только из-за отсутствия `animastor-backend:latest` для симуляции; **образы/контейнеры не созданы** (`docker system df`: Images 7/12.92GB, Containers 8 — как до проверки) |
| Явный `-f /home/sureg/animastor/docker-compose.yml` | compose **падает на parse** до каких-либо действий (fail-safe) | `docker compose config` → `open …: no such file or directory`, exit 1 |
| `docker compose ls` | только косметика: показывает MISSING-файл в списке | вывод |
| `docker compose down/stop -p animastor` | сработало бы по `project`-label (коснётся pg/redis) — **обычная семантика compose, не следствие stale-записи** | анализ labels |

**Заключение: записи — чисто исторические метаданные.** Управляющие операции
опираются на `project`-label и `config-hash`, а не на `config_files`; симуляция
показала, что **ни текущий, ни репо-compose не планируют пересоздание pg/redis**.
Практический риск снят; остаётся только косметика `compose ls` и решение по overlay.

### 3.3 Предлагаемая безопасная политика

1. **Ничего не пересоздавать ради labels** — рекреация не требуется (доказано
   dry-run); метаданные безвредны и уйдут сами при любом будущем `up` из нового
   каталога (новый `config_files`).
2. **Обязательный `up --dry-run` перед любым `up` в окне cutover.** Критерий:
   pg/redis = `Running`. Если инструмент покажет `Recreate` для pg/redis —
   **стоп и разбор** (данные в named volumes целы в любом случае, но простой
   должен быть осознанным).
3. **Никогда не восстанавливать команду из `compose ls` со старым `-f`** —
   упадёт на parse (fail-safe); документировать для операторов.
4. **`docker compose down` в проекте animastor — только в окне** (коснётся pg/redis).
5. **Overlay** (`overlay-backend-standalone.yml`, untracked, `eac32cb0…`) —
   решение владельца: перенести копией в `animastor-backend/deploy/` (класс B,
   без применения) либо заменить единым репо-compose; до решения файл не трогать.

---

## 4. Пересмотр критериев C1–C11 (на основании данных этапа 20)

Классификация: ✅ закрыто без production-изменений | ⚙️ требует решения
владельца | ⏰ требует отдельного окна/разрешения.

| Критерий | Статус | Новое за этап 20 | Классификация |
|---|---|---|---|
| **C1** диск ≥15 ГБ | ✅ PASS (15G) | — | ✅ закрыто |
| **C2** index.html | ⚙️ решение | полный diff, 4 битые ссылки, варианты (а)/(б) — §1; **рекомендация (а)** | ⚙️ владелец → ⏰ окно на правку/mount |
| **C3** compose-refs | ⚙️ решение сузилось | **recreate pg/redis НЕ потребуется** (dry-run ×2); осталось: решение по overlay + политика (§3) | ✅ риск снят без prod-изменений; ⚙️ overlay |
| **C4** repin | ⚙️ решение | **W1–W4 выполнены**: pin согласован (exit 0), HEAD расходится (exit 1, состав назван tool-ом); целевой состав определён — §2.3 | ⚙️ владелец (состав) → ⏰ окно (`--write-lock`/CI/`.env`) |
| **C5** E2E dispatch | ❌ NOT RUN | prereq перепроверены: `E2E_WORKSPACE_ID` unset, воркеров 0, `audio=0` | ✅ подготовка (A/B) без prod; ⏰ **dispatch в окне** |
| **C6** бэкапы | ❌ NOT DONE | data=63 МБ, свежего pg-dump нет | ✅ закрывается **без** prod-изменений (класс B: pg_dump read-only, tar) |
| **C7** `.in`-серт до 19.11 | ⏳ ON TRACK | свежий SNI: `notAfter=Nov 19 11:42:10 2026 GMT` | ✅ проверка без prod; ⏰ **продление (root) в окне** |
| **C8** bare-sync | ❌ NOT DONE | wt==github везде; bare: 1/1/1/4 позади (свежий ls-remote) | ✅ проверка (A); ⏰ **push — запрещён, отдельное разрешение** |
| **C9** vite build | ❌ NOT DONE | dist в web-репо отсутствует (свежая проба) | ✅ закрывается без prod (класс B) |
| **C10** теневой стек | ❌ NOT DONE | требует `up` контейнеров | ⏰ разрешение на запуск (окно необязательно; не трогать `pg-data`) |
| **C11** откат-план | ✅ PASS | подтверждён `up --dry-run` (текущий набор: все Running) | ✅ закрыто |

**Итог классификации:**
- **Без production-изменений закрываются сейчас:** C1 ✅, C6 (бэкапы),
  C9 (build), C7-проверка, C8-проверка, C11 ✅ + baseline-части C2/C3/C4/C5
  (все верификации уже выполнены в этапах 18–20).
- **Требуют решения владельца (4):** D1 — вариант index.html (рекомендую (а));
  D2 — состав repin (worker → `b3f94f42`, backend → `a7a8c463` + republish);
  D3 — политика pg/redis/overlay (рекомендую: без recreate, overlay → deploy/);
  D4 — workspace/окно для E2E.
- **Требуют отдельного окна/разрешения:** правка/переключение index.html,
  repin-цепочка, republish, dispatch, продление серта, bare-push, теневой
  стек, сам cutover.
- **GPU Hub dispatch не запускался** (запрет соблюдён).

---

## 5. Неизменность (проверена после всех исследований)

Выполнена отдельной командой контроля перед завершением этапа: SHA обоих
lock-файлов, git-статусы 5 репозиториев, uptime 8 контейнеров, `/health`,
`/gpu/health` — результаты в §6 «Контрольная сверка» настоящего отчёта
(см. вывод ниже; все значения совпали с до-этапными: `069b62d9…` / `2a221e3b…`,
деревья чистые кроме pre-existing overlay, uptime прежний, health 200/200).

## 6. Контрольная сверка (по факту завершения)

```
lock L1 mono   = 069b62d931c1ff0e…   (не изменён)
lock L2 gpu-hub = 2a221e3ba626326c…   (не изменён)
git: mono = 465453df (1 untracked — pre-existing overlay); web fbc93662,
     backend a7a8c463, worker b3f94f42, gpu-hub ecefd0b7 — деревья чистые
uptime: backend 38h, gpu-hub 3d, proxy 5w, pg 6w (healthy), redis 6w (healthy)
        — без перезапусков; docker system df: Images 7 / Containers 8 (без изменений)
/health = 200, /gpu/health = 200
```

**Ограничения этапа:** ничего из запрещённого не выполнялось; dry-run-пробы
были строго read-only (контейнеры/образы не создавались — подтверждено
`docker system df`); результаты §2 получены только штатными tool-ами проекта
в /tmp-песочнице; решения D1–D4 остаются за владельцем.
