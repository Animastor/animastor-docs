# Stage 87 — Legacy Monorepo Retirement — Итоговый отчёт

**Дата:** 2026-10-20 (UTC)
**Итог:** **BLOCKED** (на Этапе 1, READ-ONLY аудит)
**Подробности:** `reorg-2026-10-19/87-monorepo-retirement-audit.md`

## 1. Фактическое действие с монорепозиторием

**Никакого.** `/home/animastor/animastor` не удалялся, не перемещался, не переименовывался,
не архивировался. Изменений в git (refs, remotes, история), в Docker, в `~/repos`, `~/backups`,
`~/data`, `.env` и в действующих репозиториях — **не вносилось**. Выполнялось только чтение
и создание двух отчётов Stage 87.

## 2. Путь к архиву и результаты проверки восстановления

Архив **не создавался** (этапы 2–3 не запускались). Существующие средства восстановления
(проверены на чтение, без изменений):

| Средство | Что покрывает | Свежесть | Ограничение |
|---|---|---|---|
| `~/repos/animastor.git` (bare, 40M) | все tracked-файлы монорепо, 3 ветки, HEAD `4574b3b9` (`fsck` чистый) | 2026-10-20 | только git-история, без ignored-данных |
| `~/backups/animastor-pre-split-64127b9e.git` + `before-split-64127b9e-refs/` | история до сплита | 04.10 | старее HEAD |
| `~/backups/backup_animastor_2026-10-08_19-46.tar.gz` (1.08G) | `.git`, `data/books`, `backend/ai`, `proxy/conf`, `frontends/app/dist`, `.env`, `backups/*.zip` | 08.10 | нет `data/output`, нет `backups/*.tar.gz`, устарел на 12 дней |
| `~/backups/cutover-data-2026-10-12.tgz` (61M) | `data/books` + `data/output` | 12.10 | только данные на 12.10 |
| `~/backups/git_repos_2026-10-12_06-00-27.tar.gz` | bare-хранилище | 12.10 | — |

**Вывод:** сквозное восстановление монорепо «как есть на 20.10» подтвердить **нельзя**
(нет актуальной полной копии: `data/output` и 52 уникальных архива `monorepo/backups/` ~1023M
покрыты только частично/не покрыты).

## 3. Уникальные данные и их судьба

| Данные | Объём | Судьба |
|---|---|---|
| `data/books`, `data/output` | 1.9M / 61M | не тронуты; **смонтированы в production** (RW) |
| `backend/ai`, `backend/tests` | — | не тронуты; **смонтированы в production** |
| `frontends/app/dist`, `frontends/website`, `proxy/conf/*` | 455M (frontends) | не тронуты; **смонтированы в production** |
| `monorepo/backups/` (52 уникальных файла) | ~1023M | не тронуты; отдельной копии нет |
| `packages/animastor-gpu-hub/*` (19 файлов) | — | не тронуты; **расхождение с репозиторием в обе стороны**, источник истины не определён |
| `backend/.dockerignore`, `gpu-hub-rebuild.sh` | — | не тронуты; есть в git-истории монорепо |
| `frontends/website/index.html` (M) | — | не тронут; байт-в-байт идентичен `animastor-web` (правка уникальных изменений не содержит) |
| `docker/compose/overlay-backend-standalone.yml` (??) | — | не тронут; в git-истории монорепо отсутствует (untracked), копия-«драфт» есть в `animastor-backend/deploy/` |

Ни одно из перечисленных не переносилось и не удалялось.

## 4. Сохранность хранилищ (подтверждение)

- `~/repos/*.git` — 6 bare-репо: содержимое, refs, mtime не изменялись (проверка только на чтение).
- `~/backups/` — 3.5G, файлы и скрипты не изменялись.
- `~/data/` — каталога не существует (данные живут в `monorepo/data`), ничего не создавалось.
- `.env` — `monorepo/.env` и `animastor-backend/deploy/.env` не читались целиком в отчёты,
  не изменялись, не копировались в отчёт (секреты не выводились).
- Активные репозитории `animastor-backend`, `animastor-web`, `animastor-android`,
  `animastor-worker`, `animastor-gpu-hub`, `animastor-docs`, `animastor-docs-deploy`,
  `animastor-tools` — не изменялись.
- `docker compose down`, очистка Docker, массовые удаления — **не выполнялись**.

## 5. Состояние сервисов (до и после аудита — без изменений)

| Сервис | Состояние |
|---|---|
| `https://animastor.org/` | **200** |
| `https://app.animastor.org/` | **200** |
| `https://animastor.org/health` | **200** |
| `https://animastor.org/docs/` | **200** |
| `https://animastor.org/gpu/` | 404 (штатно для этого location без запроса) |
| Контейнеры | `animastor-backend` Up 25h, `animastor-proxy` Up 26h, `gpu-hub` Up 7d, `animastor-pg`/`animastor-redis` healthy 8 нед. |
| Git-синхронизация рабочих копей с bare и GitHub | совпадает по всем действующим репо (HEAD == bare == `refs/heads/*` GitHub) |

## 6. Оставшиеся зависимости и риски

1. **Production bind-mounts из монорепо** — nginx (сайт, app, `default.conf`, `.htpasswd`) и
   backend (`data/books`, `data/output`, `backend/ai`, `backend/tests`, все RW кроме nginx);
   источник — `animastor-backend/deploy/docker-compose.yml:107-111,142-147`.
2. **Certbot**: `webroot_path = /home/animastor/animastor/frontends/website` для
   `animastor.org.conf` и `animastor.in.conf` → продление TLS сломается.
3. **Бэкапы**: `~/backups/backup_animastor.sh` архивирует `~/animastor`.
4. **Уникальные/непокрытые данные**: `data/output` (последний бэкап 12.10), 52 архива
   `monorepo/backups/` (~1023M), `frontends/app/dist` (единственная собранная копия SPA).
5. **Неясный источник истины** по `packages/animastor-gpu-hub` (двустороннее расхождение
   mono↔repo: baked-artifact gate + v0.1.2 + dual-stage Dockerfile в mono;
   `artifactDirEnvConfig` в репо).
6. **Активные процессы с cwd в монорепо**: PID 4094862 (`-bash`, с 10.09),
   PID 945866 (`node /tmp/opencode/run-connector.js`, с 04.09).
7. Сопутствующее: локальный `animastor-tools` пуст (0 коммитов) при GitHub `main@8851479`;
   `animastor-backend/deploy/` (прод-compose + env) — untracked; GitHub-репо `Animastor/animastor`
   не существует (история монорепо только локально); `buildx`-кэш указывает на пути монорепо.

## 7. Условия снятия BLOCKED (для следующих этапов)

- Перевести nginx/backend на mount-пути вне монорепо (или на содержимое `animastor-web`
  + `animastor-backend`) и пере-deploy'ить без `compose down` для данных;
- обновить `webroot_path` certbot + ACME webroot;
- актуализировать `backup_animastor.sh` на новый путь;
- свежая полная резервная копия монорепо (включая `data/output` и `monorepo/backups/`);
- решение владельца об источнике истины `packages/animastor-gpu-hub`;
- завершить/перенести процессы, работающие из каталога.

**Статус: BLOCKED. Этапы 2–4 (подготовка, вывод из эксплуатации, пост-проверки) не выполнялись.**
