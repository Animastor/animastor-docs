# Animastor — кросс-репозиторный аудит 4 веток синхронизации (этап 6)

- Дата: 2026-10-11 (UTC)
- Режим: **только аудит**. Ни один git-ref, рабочее дерево, bare, GitHub,
  монорепо или контейнер не изменялись. Merge/push/deploy/cutover не выполнялись.
- Итог: **PASS** (все 4 ветки совместимы; один кросс-репо риск §5.1, требующий
  repin при cutover; два известных pre-existing дефекта тестов, не вызванных ветками)

| Ветка | SHA | Компонент | Вердикт |
|---|---|---|---|
| `sync/c21.4-domain-and-fixes` | `a7a8c4639ed40fbc4ba7a1f91cae0e4bdaf5a6ad` | Backend | **PASS** (2 pre-existing failing tests, §6) |
| `sync/c21.4-domain` (web) | `fbc93662035df84c8e103df0d0706800aa96cba1` | Web | **PASS** |
| `sync/c21.4-domain` (android) | `92a56c0ddce1a796d593f4e3a3462ca17ddd2c3f` | Android | **PASS** (2 pre-existing failing tests, §6) |
| `sync/c21.4-domain` (worker) | `b3f94f42612d0a5dd665956908f545c8d94fad95` | Worker | **PASS** |

---

## 1. Целостность веток (подтверждено)

| Репозиторий | HEAD ветки | worktree == ветка | status | main | bare == GitHub == main |
|---|---|---|---|---|---|
| backend | `a7a8c463` | ✓ | 0 строк | `bce64db3` (не тронут) | ✓ |
| web | `fbc93662` | ✓ | 0 строк | `c7fe52ac` (не тронут) | ✓ |
| android | `92a56c0d` | ✓ | 0 строк | `254e2f08` (не тронут) | ✓ |
| worker | `b3f94f42` | ✓ | 0 строк | `618f87a6` (не тронут) | ✓ |

Монорепо `465453df`, gpu-hub `ecefd0b7` (master), bare всех 5 — не изменены.
Свободный диск: 6.3 ГБ (94%).

## 2. Согласованность домена .org между компонентами

| Контракт | Backend | Web | Android | Worker | Согласовано |
|---|---|---|---|---|---|
| Канонический origin | `COOKIE_DOMAIN`/server_name → `animastor.org` (+ app/admin/docs поддомены) | canonical/og → `https://animastor.org/` | `BASE_URL` default `https://app.animastor.org/` | — | ✓ |
| HUB_URL default | `HUB_URL='https://animastor.org/gpu'` (backend/src) | — | — | `worker.cjs`, `start-worker.sh` ×2, `.env.example`, `entrypoint.sh` — все `https://animastor.org/gpu` | ✓ |
| Installer download URL | — | `animastor.org/gpu/installer?…` (workerSetup.test) | `animastor.org/gpu/installer?…` (WorkerSetupHelpersTest) | — | ✓ (web↔android идентично) |
| WebView/library URL | — | `app.animastor.org` (кнопки/ссылки) | `app.animastor.org/library` (LibraryFragment) | — | ✓ |
| Support/прочее | `support@animastor.org` (docs) | `support@animastor.org` | — | — | ✓ |

**Регрессий `.in` нет**: в web/android/worker-ветках ни одна строка с
`animastor.in` не добавлена (0). В backend-ветке 20 добавленных строк с `.in` —
все **намеренные legacy-строки** (§3).

## 3. Legacy `.in` → `.org` (редиректы не сломаны)

Backend-ветка (`proxy/conf/default.conf`):
- `map $host $animastor_canonical_host`: `.in`/`www.in`/`app.in`/`admin.in` → `.org`-соответствия;
- HTTP :80 сервер для `.in`-семейства (включая ACME webroot для продления `.in`-сертификата);
- HTTPS :443 **legacy-сервер**: `server_name` `.in`-семейство, сертификат
  `/etc/letsencrypt/live/animastor.in/*`, 301 → канонический `.org` с сохранением
  path+query (`=$request_uri`);
- `scripts/enable-admin-https.sh`: отдельный legacy-сертификат + self-check
  `SERVED_SAN_LEGACY` (проверка, что `.in`-SAN присутствует).

`animastor.in` остаётся **legacy с 301-редиректом**; основной домен — `.org`
везде. Остатки `.in` в деревьях — только исторические docs, идентичные монорепо.

## 4. Контракты артефактов /gpu/worker-source ↔ /gpu/worker-bundle

- **GPU Hub** (`ecefd0b7`, read-only): `/worker-bundle` + `/worker-bundle/sha256` —
  канонический контракт; `/worker-source` — **deprecated, backward compat**
  (DEPLOYMENT.md, gpu-hub.js:1317-1323). Не изменялся.
- **Backend-ветка**: installer-движок (`packages/animastor-installer/src/.../worker.js`)
  фетчит **только** `/worker-bundle` (+ sha256-verify). `/worker-source` не используется.
- **Worker-ветка**: README/package.json описывают `GET {HUB_URL}/worker-bundle`
  (sha256 отдельно). Совместимо.
- **Android-тесты**: `BetaSettingsHelpersTest`/`WorkerSetupHelpersTest` ожидают
  `…/gpu/worker-source` → **2 pre-existing падения** (§6); production-код
  (хелпер) уже выдаёт `/worker-bundle`. Т.е. deprecated-маршрут пока существует
  в GPU Hub — падения не блокируют, но фикс ожиданий нужен.
- **Pinned-image**: backend-ветка сохранила пост-сплит compose
  (`image: ${GPU_HUB_IMAGE:?…}`, без build из монорепо) + доменные строки.
  Согласовано с линией gpu-hub 06–08.10. ✓

## 5. Кросс-репозиционные пересечения и риски

### 5.1 ⚠️ Основной риск: worker-bundle pin в GPU Hub рассинхронизируется

`gpu-hub/artifacts.lock.json` пинит артефакт `worker-bundle`
(version 2.1.1, `sha256_tree: 4bb0408b…`, 8 файлов из
`packages/animastor-worker/worker`). **Worker-ветка меняет 3 из этих 8 файлов**
(`worker.cjs`, `package.json`, `.env.example`) → после merge worker `sha256_tree`
перестанет совпадать с пином.

- Не блокирует merge (.gpu-hub image строится из закреплённого коммита, CI.gpu-hub упадёт только при попытке repin без обновления lock).
- **Требуется при cutover**: repin через `tools/update-artifacts-lock.cjs` (gpu-hub репо) — отдельное решение, в этой задаче не выполнялось.

### 5.2 Общие файлы между ветками — идентичны ✓

| Файл | Ветки | Блобы |
|---|---|---|
| `docker/worker/docker-run.md` | backend + worker | идентичны (`ccfec8a8`) ✓ |
| `docker/worker/entrypoint.sh` | backend + worker | идентичны (`7030cedf`) ✓ |
| `ANDROID_WEB_PARITY.md` | web + android | идентичны (`d02cbde4`) ✓ |

Git-конфликтов при merge **не будет по построению**: ветки лежат в разных
репозиториях и сливаются в разные `main`; пересечений путей с разным
содержимым между ветками не обнаружено.

### 5.3 Прочие риски

| # | Риск | Влияние |
|---|---|---|
| R1 | §5.1 worker-bundle pin | CI gpu-hub при repin; deferred to cutover |
| R2 | Android-тесты ждут deprecated `/worker-source` | CI android упадёт 2 тестами после merge (pre-existing) |
| R3 | Backend `phase10j` арх-тест (fixture-контракт vs pinned-image) | pre-existing дефект, задокументирован в отчёте 06 (§6 п.4); требует отдельного решения |
| R4 | npm-бампы backend ссылаются на `@animastor/installer@^0.1.1`, `@animastor/gpu-hub@^0.1.2` | проверено read-only: **0.1.1 и 0.1.2 опубликованы в npm** ✓ — `npm ci` воспроизводим |
| R5 | `docs/architecture/*.md` с историческими `.in`/`animastor`-ссылками | косметика; не влияет на рантайм |

## 6. Известные падения тестов и незапущенные проверки

### Падения (все pre-existing, воспроизведены на baseline / в монорепо, НЕ вызваны ветками)

| Компонент | Тест | Причина | Статус |
|---|---|---|---|
| Backend | `installer-package-boundary` IB-G15 | ожидает `"private": true`, в пакете нет (ни до, ни после) | pre-existing (отчёт 06 §5.1) |
| Backend | `phase5-runtime-result` T9 | ENOENT `backend/src/runtime/index.js` — файла нет в репо | pre-existing (отчёт 06 §5.1) |
| Android | `BetaSettingsHelpersTest.worker_setupContract…` | ожидает `/gpu/worker-source`, хелпер выдаёт `/worker-bundle` | pre-existing (воспроизведён на `main`, отчёт 08 §6) |
| Android | `WorkerSetupHelpersTest.legacy_singleFileFlow…` | та же причина | pre-existing |

Итог прогона: backend **927 passing / 2 failing**; web **305 passed** (2 пакета) + typecheck OK;
android **153/155** + `assembleDebug` OK; worker **45/45**.

### Незапущенные проверки (не заявляются как пройденные)

| Что | Этап | Почему |
|---|---|---|
| `vitest` 12 остальных web-пакетов, `vite build` | 07 | диск; файлы не менялись веткой |
| Android `lintDebug`, `assembleRelease`, устройство/эмулятор | 08 | подпись/SDK-объём вне скоупа |
| Браузерная/production-проверка редиректов nginx | 06–07 | требуется живой proxy — **не проверялось** |
| Запуск worker/docker-deploy, e2e GPU Hub | 09 | живой GPU Hub + секреты |
| `sync-protocol.cjs --check` (npm parity) | 09 | требует `npm ci` @animastor/contracts |
| Полный `npm ci` ×12 web-пакетов | 07 | 6.3 ГБ |

## 7. Рекомендуемый порядок merge и критерии допуска

Ветки в разных репозиториях — строгой последовательности git не требует;
рекомендуемый порядок снижает операционный риск:

1. **worker** (`b3f94f42`) — минимальный объём (10 файлов), ноль конфликтов.
2. **web** (`fbc93662`) — 19 файлов, все тесты зелёные.
3. **android** (`92a56c0d`) — 6 файлов; CI будет падать 2 pre-existing тестами (R2).
4. **backend** (`a7a8c463`) — 44 файла, 4 коммита; содержит production-фиксы
   (fix(editor), fix(assistant)) — наибольшая ценность и наибольший объём ревью;
   merge последним позволяет ревьюить на стабильном фоне.

**Критерии допуска каждой ветки в `main`** (выполняются перед merge, сейчас не выполнялись):
1. Ревью diff ветки (особенно 3-way файлы backend: `docker-compose.yml`, `.env.example`, `package.json` ×2, auth README).
2. `git status` чист, HEAD ветки == зафиксированный SHA (§1).
3. Прогон тестов репозитория в ветке — без новых падений относительно §6.
4. Merge только `--ff-only` (все 4 `main` не двигались с baseline — ff возможен).
5. Push bare → проверка bare == worktree → push GitHub — по отдельному разрешению.

## 8. Свободное место и выполнимые дополнительные проверки

- Диск: **6.3 ГБ**. backend `node_modules` остались (103 МБ) — повторный полный
  `npm test` backend выполним (~350 МБ с `npm ci` в packages, если потребуется).
- Выполнимы и дёшевы: повторный `node tests/run-all.cjs` worker (секунды),
  повторные прогоны web/android (кеш `~/.gradle` 957 МБ на месте).
- **Не требовались** — все тесты уже прогнаны на этих же SHA в этапах 2–5,
  ветки с тех пор не менялись (подтверждено §1).
- Невыполнимо без отдельных решений: production nginx/GPU Hub e2e,
  подписанная release-сборка android, repin gpu-hub (§5.1).

## 9. Условия последующего production cutover (отдельное решение)

1. Все 4 merge выполнены; bare == GitHub во всех репозиториях.
2. **Repin GPU Hub** (`artifacts.lock.json` → новый `sha256_tree` worker-bundle,
   пересборка/публикация pinned-образа, обновление `GPU_HUB_IMAGE` в `.env`) — §5.1.
3. Выпуск/продление legacy `.in`-сертификата подтверждено на живом proxy
   (проверка 301 + SAN из `enable-admin-https.sh`) — единственный пункт,
   где legacy-редиректы проверяются фактически.
4. Пересборка backend-образа из репозитория (production по-прежнему из монорепо).
5. Фикс R2 (ожидания android-тестов → `/worker-bundle`) и R3 (phase10j) —
   рекомендуется до/вместе с cutover.
6. Rollback-план: bare-репозитории и монорепо сохранены; cutover — только
   переключением compose/сборки, без изменения git-ref.
