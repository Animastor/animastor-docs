# 84 — Перепроверка новых репозиториев и удаление старых docs/tools

**Дата:** 2026-10-20
**Основания:** указание владельца («перепроверь новые репозитории с docs и tools; аккуратно удали старые docs и tools»); Stages 76–79 (docs), 80–83 (tools).

**Итог: PASS.** Оба новых репозитория перепроверены свежими клонами с GitHub — соответствуют манифестам, секретов нет. Старые копии `docs/` и `tools/` удалены из `animastor-web` (запушено в GitHub) и из mono-снапшота (запушено в локальный bare) обычными коммитами, без перезаписи истории. Production не пострадал: все эндпоинты отвечают 200, mount'ы nginx не изменялись.

---

## 1. Перепроверка новых репозиториев (свежие shallow-клоны с GitHub)

| Проверка | `Animastor/animastor-tools` | `Animastor/animastor-docs` |
|---|---|---|
| Tip `main` | `88514792092f317a88e47e5f83fa0bd428b81426` | `bb8106cf0d06829dc2a2c6039df9593f3430f6f6` |
| Файлов | 54 | 298 |
| Манифест | **46/46** (`75-tools-manifest.txt`, flatten) | **297/297** (`75-docs-manifest.txt`, flatten) + `LICENSE` |
| Секреты (blobs + сообщения коммитов всего дерева) | 0 (старый и новый админ-пароль), 0 generic-паттернов | 0 (оба пароля), 0 generic-паттернов (`ghp_`/`AKIA`/private-keys) |
| `git fsck --strict` | чисто | чисто |
| Соответствие локальному клону/bundle | tip == опубликованному кандидату Stage 83 | tip == локальному `animastor-docs` и Stage 79 |

**Доказательство полноты (ничего не теряется при удалении старых копий):**

- web `docs/` (31 файл) — **побайтно идентичен** файлам mono `docs/` (31/31 совпали по blob-хешу);
- mono `docs/` (297 файлов) — 295/297 побайтно идентичны `animastor-docs`; 2 расхождения объяснены: `08-mobile-web-migration/README.md` — исправление относительной ссылки при извлечении (коммит `bb8106c`), и файл с не-ASCII именем (совпадает; расхождение — квотирование git при сверке, проверено `core.quotepath=false`);
- в `animastor-docs` добавлен только `LICENSE` (MIT).
- web `tools/` (46) — побайтно идентичны mono `tools/` (0 diff), уже опубликованы в `animastor-tools`.

Вывод: все содержимое старых `docs/` и `tools/` сохранено в новых репозиториях.

**Третья старая копия (решение владельца — оставить):** `animastor-worker/docs/` — 16 файлов, побайтно идентичных `animastor-docs/architecture/…`. Директория **сохранена**: worker — самостоятельный публичный репозиторий, protocol-документы (`job-protocol-v2.cjs`: «NORMATIVE, FROZEN») и README ссылаются на них относительными путями намеренно; дубликат (428K) безвреден. Проверено, что других старых копий `docs/`/`tools/` в репозиториях нет (backend/worker/android/gpu-hub и т.д.).

## 2. Предварительные проверки перед удалением («аккуратно»)

| Проверка | Результат |
|---|---|
| Функциональные ссылки на `docs/`/`tools/` в `animastor-web` | **нет** — только README-дерево/ссылки и **комментарии** в исходниках (`// docs/architecture/…`); ни одного импорта, build- или runtime-зависимости |
| Ссылки в mono вне этих каталогов | только тексты в README/ARCHITECTURE/CONTRIBUTING, комментарии `.env.example`/`.dockerignore`, сообщения в `scripts/animastor-runtime-audit.sh`/`syntax-smoke.sh`; `packages/*/tools/*` — **собственные** tools пакетов, не корневые; mono-корневые скрипты — без ссылок |
| Production mount'ы nginx | `/home/animastor/animastor/frontends/app`, `/frontends/website`, `/proxy/conf/*` (mono) и `/home/animastor/animastor-docs-deploy` — **`docs/` и `tools/` не монтируются**; compose-файлы не изменялись |
| CI/CD, Docker, deploy других репозиториев | ссылок на web/mono `docs/`/`tools/` нет (проверено Stage 80 §4, повторно) |
| Состояние репозиториев перед правкой | web: main `fbc9366`, worktree чист; mono: ветка `c21.4-…` @ `465453df` == tip локального bare-origin (fast-forward возможен) |

## 3. Удаление старых копий

### 3.1 `animastor-web` (публичный репозиторий)

| Параметр | Значение |
|---|---|
| Коммит | **`fee405094d9b189a946ad32eda298e833126bbf9`** «chore: remove migrated docs/ and tools/» |
| Содержимое | 77 удалений (`docs/` 31 + `tools/` 46) + обновлённый `README.md` (дерево без docs/tools; в «Related repositories» добавлены ссылки на `animastor-docs` и `animastor-tools`; раздел Documentation указывает на новый репозиторий и `animastor.org/docs/`) |
| Push | `fbc9366..fee4050` → **GitHub** (`github/main`) и локальный bare-миррор `origin`; **без force**; tips локально/GitHub/origin совпадают |
| Worktree после | чист; `git fsck --strict` — чисто |

### 3.2 mono-снапшот `/home/animastor/animastor` (исторический монорепозиторий)

| Параметр | Значение |
|---|---|
| Коммит | **`4574b3b96a86a2caa3e94df5b133f6e2970dfcd3`** «chore: remove migrated docs/ and tools/» (ветка `c21.4-physically-extract-analysis-from-backend`) |
| Содержимое | 343 удаления (`docs/` 297 + `tools/` 46) |
| Push | в локальный bare `origin` (`/home/animastor/repos/animastor.git`), fast-forward `465453df..4574b3b9`; **без force** |
| Незакоммиченное «чужое» | предсуществующие записи (`frontends/website/index.html`, untracked overlay-compose) **остались нетронутыми** и не попали в коммит |
| Примечание | mono остаётся историческим снапшотом: его README/ARCHITECTURE сохраняют исторические упоминания путей `docs/`/`tools/` (архивная документация, не функциональные ссылки) |

История ни одного репозитория **не переписывалась** — только обычные коммиты удаления; старые файлы доступны в истории и в ранее созданных архивах (`76-animastor-docs.bundle`, `81-animastor-tools.bundle`, `backups/`).

## 4. Проверки после удаления

| Проверка | Результат |
|---|---|
| Директории удалены | `animastor-web/{docs,tools}` и `animastor/{docs,tools}` — отсутствуют в worktree и в HEAD |
| Production: `/docs/` (портал) | **200** (`/docs/` и `/docs/index.html`) — обслуживается из `animastor-docs-deploy`, не тронут |
| Production: web-приложение `/` (app.animastor.org) | **200** |
| Production: сайт `/` (animastor.org) | **200** |
| Production: API `/health` | **200** |
| Mount'ы `animastor-proxy` | без изменений (docs-deploy, mono frontends/proxy, letsencrypt) |
| Git integrity | web и mono: `git fsck --strict` — чисто (в web 2 dangling-коммита — предсуществующие, безвредные) |
| Незатронутые репозитории | backend `82c80af`, android `92a56c0`, worker `b3f94f4`, docs `bb8106c`, gpu-hub `0f489c7`, `animastor-docs-deploy` (каталог production) — не изменялись |
| Секреты | в новых коммитах/удалениях нет; админ-пароль (старый — мёртв с Stage 83) отсутствует в опубликованных репозиториях |

## 5. Остаточные рекомендации и принятые решения

1. **`/tmp`-артефакты со старым (мёртвым) паролем — удалены (2026-10-20, по решению владельца):** `/tmp/audit-tools-extract`, `/tmp/websync/extract`, `/tmp/redact.txt`, `/tmp/s80_tools_patches.txt`, `/tmp/tools-head-secret.txt`. Повторный sweep `/tmp` (только имена файлов): **0 файлов** содержит мёртвый пароль.
2. **Известный локальный остаток:** оригиналы `75-docs-tools-extraction-audit.md` и `80-tools-extraction-blocker-audit.md` в `reorg-2026-10-19/` по-прежнему содержат мёртвый пароль (локально, никогда не публиковались; безопасные копии — `82-tools-publish/sanitized/`). Удаление/замена — по отдельному решению владельца.
3. **`animastor-worker/docs/` — оставлен** (решение владельца, §1).
4. Исторические комментарии в исходниках `animastor-web` ссылаются на старые пути `docs/architecture/…` — это текстовые пометки; при желании можно указать репозиторий `animastor-docs` отдельным коммитом (необязательно).
5. Админ-пароль: рекомендация сменить на длину ≥ 8 символов (политика приложения) — Stage 83 §1.3.

## 6. Артефакты

- `84-docs-tools-cleanup-report.md` — этот отчёт.
- Опубликованные репозитории: `Animastor/animastor-tools` @ `88514792…`, `Animastor/animastor-docs` @ `bb8106c…`, `Animastor/animastor-web` @ `fee4050…` (main).
- mono-снапшот: `c21.4-physically-extract-analysis-from-backend` @ `4574b3b9…` (локальный bare-origin обновлён).
- Временные клоны проверки `/tmp/84-verify-{tools,docs}` — удалены.
