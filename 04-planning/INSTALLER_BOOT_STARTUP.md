# Startup-скрипты ноды (установщик 0.2.4)

С 0.2.4 startup-скрипт ноды — **одна строка на обоих типах машин**:

```sh
export PATH="$HOME/.local/bin:$PATH"; ~/.local/bin/animastor boot
```

Готовую строку (с полным путём к `animastor` этой установки) печатает итог
установки и `animastor doctor`: `Node startup script (one line): …`.

Исходные факты:

- на ноде сохраняется только `/home`: `~/.bashrc`, `~/.profile` и всё, что
  лежит вне `$HOME` (включая `/usr/local/bin`, apt-пакеты образа и
  site-packages системного/conda Python), сбрасывается;
- `~/.local/bin/animastor` и `~/animastor/**` живут в `/home` и переживают
  рестарт;
- установщик сам восстанавливает PATH-блок при каждом `install` / `doctor` /
  `start` / `boot`, пересчитывает адрес ComfyUI из cmdline процесса и
  доставляет пропавшие apt-пакеты (root или `sudo -n`).

## Что делает `animastor boot`

1. Сразу отделяется в фон: отдельная сессия (setsid), stdin — `/dev/null`,
   stdout/stderr дописываются в `~/animastor/logs/bootstrap.log` под
   заголовком

   ```
   ===== animastor boot 2026-10-31T05:19:00.000Z (system boot 2026-10-31T05:17:42.000Z) =====
   animastor boot: doctor --yes detached (pid 4242): doctor --yes --state … --comfy-wait-ms 600000
   ```

2. Печатает одну строку и **мгновенно** возвращает код 0:
   `animastor boot: started in the background (pid 4242), log /home/jovyan/animastor/logs/bootstrap.log`.
3. В фоне — `animastor doctor --yes` с ожиданием `--comfy-wait-ms 600000`
   (600 с; своё значение — `animastor boot --comfy-wait-ms N` или
   `ANIMASTOR_COMFY_WAIT_MS`). Итог фонового прогона (одна строка
   `animastor doctor: OK — …` / `FAILED — …`) — в том же логе.

## Тип A — ComfyUI запускает платформа (TIR, notebook-префикс)

Платформа сама поднимает `python3 ~/ComfyUI/main.py --listen 0.0.0.0 --port
8888 --baseurl /notebook/p-…/n-…` (порт и префикс меняются между загрузками).
Свой ComfyUI установщик в этом режиме не запускает никогда.

**Почему в скрипте нельзя `exec … doctor` и любое ожидание.** TIR запускает
платформенный ComfyUI только ПОСЛЕ завершения startup-скрипта. Скрипт, который
ждёт ComfyUI, ждёт сам себя: на живом прогоне 31.10 doctor сдался в 05:19:06,
`main.py` стартовал в 05:19:35 — сразу после выхода скрипта. Поэтому скрипт
должен завершиться сразу, а ждать — отделённый процесс. Это и делает `boot`.

Что делает фоновый `doctor --yes` на типе A:

1. Ждёт платформенный ComfyUI (как в 0.2.3): процесс `main.py` И ответ
   `GET /system_stats`, порт и префикс — из cmdline процесса на каждом шаге,
   прогресс в лог раз в 30 с.
2. **Зависимости кастом-нод.** Для каждой обязательной ноды профиля
   (`qwen3-tts` и т. п.) проверяет `requirements.txt` в Python **того**
   процесса `main.py` (интерпретатор — из `/proc/<pid>`). Пакеты пропадают
   при рестарте ноды вместе с образом — не удовлетворены → `pip install -r`
   в этот Python (torch платформы закреплён constraint'ом, не заменяется).
3. **Перезапуск платформенного ComfyUI** — только если он разрешён (в `boot`
   на типе A — по умолчанию да): останавливается ровно тот `main.py`, который
   проверялся (точный pid из `/proc`), и `doctor` ждёт, пока платформа
   поднимет новый: другой pid + `/system_stats` + классы нод в `/object_info`.
   В логе: `the platform started ComfyUI again: pid 900 → 901 at … node classes present`.
4. Пересчитывает `COMFY_URL` / `COMFY_PORT` / `NOTEBOOK_PATH`, запускает
   воркер и ждёт «ComfyUI ready». Если классы нод появляются не сразу
   (зависимости только что ставились или pid ComfyUI сменился) — проверка
   повторяется до конца окна ожидания, а не FAILED сразу.

Опция перезапуска чужого ComfyUI:

| Как | Значение |
|---|---|
| `--restart-platform-comfy` / `--no-restart-platform-comfy` | явно, на этот прогон (и записывается) |
| `install-state.json` → `installer_options.restartPlatformComfy` | ответ, данный при первой интерактивной установке/`doctor` (вопрос задаётся один раз) |
| `boot` на типе A без записи | да |
| интерактивно без записи | один вопрос |

Неудачи (код 1, воркер не запускается, причина — в логе одной строкой
`animastor doctor: FAILED — …`):

- ComfyUI не поднялся за окно: `ComfyUI is started by the platform; it did not come up in N s …`;
- перезапуск выключен: `custom-node dependencies were installed, but the platform's ComfyUI (pid N) … was not restarted` —
  fix: перезапустить ComfyUI из консоли платформы или `animastor doctor --restart-platform-comfy`;
- платформа не подняла ComfyUI после остановки: `the platform did not start ComfyUI again within N s after it was stopped (old pid P) — start it from the platform console`;
- ComfyUI поднялся, но без классов: `… but it answers, node classes missing: … after N s`;
- `pip` не смог поставить зависимости — его хвост stderr.

Самописные фоновые блоки (`( until pgrep …; pip install …; pkill …; doctor … ) & disown`)
больше не нужны — заменить их строкой `animastor boot`.

## Тип B — чистый Ubuntu, ComfyUI ставит установщик (managed)

Никакой чужой ComfyUI не запущен, корень создан установщиком
(`state.components.comfyui.owned = true`) → режим `managed`. Startup-скрипт
тот же: `~/.local/bin/animastor boot`. Фоновый `doctor --yes` платформенный
ComfyUI не ждёт (окно 600 с к типу B не применяется), зависимости нод
проверяет в Python своего ComfyUI (процесс, иначе `~/ComfyUI/venv`),
доустанавливает их и перезапускает свой ComfyUI, затем поднимает воркер.

## Как это подключить

1. Один раз поставить установщиком (или `animastor doctor`) — он создаст
   `~/.local/bin/animastor` и заменит `~/animastor/start-worker.sh` на обёртку
   `exec ~/.local/bin/animastor start "$@"` (старый скрипт → `start-worker.sh.bak`).
   На типе A интерактивный прогон один раз спросит, можно ли при загрузке
   перезапускать платформенный ComfyUI.
2. Вписать строку `export PATH="$HOME/.local/bin:$PATH"; ~/.local/bin/animastor boot`
   в поле «startup command» платформы (или `@reboot` в crontab пользователя,
   systemd-юнит с `User=<пользователь>` и `Environment=HOME=<домашний каталог>`).
   Запускать от того же пользователя, который делал установку: `animastor`
   блокирует смешивание root и обычного пользователя.
3. Проверить вручную до перезагрузки: `~/.local/bin/animastor boot; echo $?` —
   одна строка и код 0 сразу; затем `tail -f ~/animastor/logs/bootstrap.log`
   до строки `animastor doctor: OK — …`.

## Ручные команды на ноде

| Задача | Команда |
|---|---|
| Startup-скрипт (оба типа) | `~/.local/bin/animastor boot` |
| Лог загрузки | `tail -f ~/animastor/logs/bootstrap.log` |
| Поднять всё и проверить | `~/.local/bin/animastor start` |
| Перепроверить и починить | `~/.local/bin/animastor doctor` |
| Разрешить/запретить перезапуск платформенного ComfyUI | `~/.local/bin/animastor doctor --restart-platform-comfy` / `--no-restart-platform-comfy` |
| Новый Worker Key (старый отвергнут) | `~/.local/bin/animastor doctor --new-key` |
| Статус (платформенный ComfyUI — `started by the platform (pid …)`) | `~/.local/bin/animastor status` |
| Логи воркера | `~/.local/bin/animastor logs -f` |
| Boot-прогон на переднем плане (отладка, НЕ для startup-скрипта) | `~/.local/bin/animastor doctor --yes --comfy-wait-ms 600000` |
