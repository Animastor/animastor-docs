# Startup-скрипты ноды (установщик 0.2.3)

Готовые команды автозапуска после загрузки/рестарта ноды для двух типов машин,
которые встретились на E2E 30.10.

Исходные факты, из которых сделаны скрипты:

- на ноде сохраняется только `/home`: `~/.bashrc`, `~/.profile` и всё, что
  лежит вне `$HOME` (включая `/usr/local/bin` и apt-пакеты образа),
  сбрасывается;
- `~/.local/bin/animastor` и `~/animastor/**` живут в `/home` и переживают
  рестарт;
- установщик (с 0.2.2) сам восстанавливает PATH-блок при каждом `install` /
  `doctor` / `start`, пересчитывает адрес ComfyUI из cmdline процесса и
  доставляет пропавшие apt-пакеты (root или `sudo -n`).

## Тип A — ComfyUI запускает платформа (TIR, notebook-префикс)

Платформа сама поднимает `python3 ~/ComfyUI/main.py --listen 0.0.0.0 --port
8888 --baseurl /notebook/p-…/n-…` (порт и префикс меняются между загрузками).
Свой ComfyUI установщик в этом режиме НЕ запускает: он берёт адрес из cmdline
процесса, подтверждает `/system_stats` и только потом поднимает воркер.

`~/animastor/boot-type-a.sh`:

```sh
#!/bin/sh
# Animastor — тип A: ComfyUI поднимает платформа (порт/префикс меняются).
# Одна строка итога, exit 0/≠0; без вопросов (--yes, нет TTY).
export PATH="$HOME/.local/bin:$PATH"
exec "$HOME/.local/bin/animastor" doctor --yes --comfy-wait-ms 180000
```

`--comfy-wait-ms` — сколько миллисекунд ждать платформенный ComfyUI (по
умолчанию 180000 мс; альтернатива — `ANIMASTOR_COMFY_WAIT_MS`).

Как ждёт 0.2.3 (запуск раньше платформы — нормальный случай). Если
install-state говорит «ComfyUI принадлежит платформе» (`mode existing`,
`startComfyui=false` или записанный `comfy_owner.owner = foreign`), а
проверенного платформенного процесса ещё нет, `doctor`:

1. ждёт появления процесса `main.py` И ответа `GET /system_stats`, на каждом
   шаге заново беря порт и префикс из cmdline процесса;
2. раз в 30 с пишет в лог прогресс:
   `waiting for the platform's ComfyUI — no ComfyUI main.py process yet (30 s of 180 s)`
   или `… process pid N at http://127.0.0.1:8888/notebook/p-…/n-… does not answer GET /system_stats yet …`;
3. после ответа — `the platform's ComfyUI answers at <url> (pid N, after S s)`,
   пересчитывает `COMFY_URL` / `COMFY_PORT` / `NOTEBOOK_PATH` в `.env`,
   запускает воркер и ждёт «ComfyUI ready» (90 с отсчитываются с момента,
   когда ComfyUI ответил).

Если за `--comfy-wait-ms` ComfyUI так и не поднялся — воркер НЕ запускается
(в том числе со старым адресом из `.env`), итог `FAILED` с кодом 1:

```
animastor doctor: FAILED — 1 problem(s) — mode existing, ComfyUI not reachable, worker not started (/home/jovyan/.local/bin/animastor)
  ✗ ComfyUI API: ComfyUI is started by the platform; it did not come up in 180 s (no ComfyUI main.py process appeared) — fix: run `/home/jovyan/.local/bin/animastor doctor` after the platform's ComfyUI is up
```

Если процесс появился, но не отвечал, в причине — его pid и полный адрес с
префиксом.

## Тип B — чистый Ubuntu, ComfyUI ставит установщик (managed)

Никакой чужой ComfyUI не запущен, корень создан установщиком
(`state.components.comfyui.owned = true`) → режим `managed`, `doctor` сам
поднимает ComfyUI и воркер.

`~/animastor/boot-type-b.sh`:

```sh
#!/bin/sh
# Animastor — тип B: чистый Ubuntu, ComfyUI и воркер ставятся установщиком.
# Ждать чужой ComfyUI не нужно (--comfy-wait-ms 0), всё остальное — как в типе A.
export PATH="$HOME/.local/bin:$PATH"
exec "$HOME/.local/bin/animastor" doctor --yes --comfy-wait-ms 0
```

## Как это подключить

1. Один раз поставить установщиком (или `animastor doctor`) — он создаст
   `~/.local/bin/animastor` и заменит `~/animastor/start-worker.sh` на обёртку
   `exec ~/.local/bin/animastor start "$@"` (старый скрипт → `start-worker.sh.bak`).
2. Положить нужный скрипт как команду загрузки ноды (поле «startup command»
   платформы, `@reboot` в crontab пользователя, systemd-юнит с
   `User=<пользователь>` и `Environment=HOME=<домашний каталог>` — на выбор
   владельца ноды). Запускать от того же пользователя, который делал установку:
   `animastor` блокирует смешивание root и обычного пользователя.
3. Проверить вручную до перезагрузки: `~/animastor/boot-type-a.sh; echo $?` —
   должна быть ровно одна строка `animastor doctor: OK — …` и код 0.

## Что печатает boot-режим

```
animastor doctor: OK — mode existing, ComfyUI http://127.0.0.1:8888/notebook/p-…/n-…, worker pid 4242 (/home/jovyan/.local/bin/animastor)
```

или

```
animastor doctor: FAILED — 2 problem(s) — mode existing, ComfyUI not reachable, worker not started (/home/jovyan/.local/bin/animastor)
  ✗ ComfyUI API: not reachable … — fix: …
  ✗ Hub heartbeat (Online): … — fix: …
```

`FAILED` всегда сопровождается кодом возврата 1 (скрипты платформы видят
неудачу), `OK` — кодом 0.

## Ручные команды на ноде

| Задача | Команда |
|---|---|
| Поднять всё и проверить | `~/.local/bin/animastor start` |
| Перепроверить и починить | `~/.local/bin/animastor doctor` |
| Новый Worker Key (старый отвергнут) | `~/.local/bin/animastor doctor --new-key` |
| Статус (платформенный ComfyUI — `started by the platform (pid …)`) | `~/.local/bin/animastor status` |
| Логи воркера | `~/.local/bin/animastor logs -f` |
| Boot-режим вручную | `~/.local/bin/animastor doctor --yes --comfy-wait-ms 180000` |

PATH-блок установщик дописывает в `~/.bashrc` и `~/.profile` при каждом
запуске, поэтому в интерактивном шелле достаточно `animastor …`; в скриптах
загрузки надёжнее полный путь (он же печатается в итоговой строке).
