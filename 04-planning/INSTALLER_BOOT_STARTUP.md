# Startup-скрипты ноды (установщик 0.2.2)

Готовые команды автозапуска после загрузки/рестарта ноды для двух типов машин,
которые встретились на E2E 30.10.

Исходные факты, из которых сделаны скрипты:

- на ноде сохраняется только `/home`: `~/.bashrc`, `~/.profile` и всё, что
  лежит вне `$HOME` (включая `/usr/local/bin` и apt-пакеты образа),
  сбрасывается;
- `~/.local/bin/animastor` и `~/animastor/**` живут в `/home` и переживают
  рестарт;
- установщик 0.2.2 сам восстанавливает PATH-блок при каждом `install` /
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

`--comfy-wait-ms` — сколько секунд ждать платформенный ComfyUI (по умолчанию
180000 мс; альтернатива — `ANIMASTOR_COMFY_WAIT_MS`). Если процесс так и не
появился, `doctor` завершится с ненулевым кодом и одной строкой причины —
воркер без ComfyUI не стартует.

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
| Статус | `~/.local/bin/animastor status` |
| Логи воркера | `~/.local/bin/animastor logs -f` |
| Boot-режим вручную | `~/.local/bin/animastor doctor --yes --comfy-wait-ms 180000` |

PATH-блок установщик дописывает в `~/.bashrc` и `~/.profile` при каждом
запуске, поэтому в интерактивном шелле достаточно `animastor …`; в скриптах
загрузки надёжнее полный путь (он же печатается в итоговой строке).
