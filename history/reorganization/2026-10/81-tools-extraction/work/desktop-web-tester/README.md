# Animastor Desktop Tester

Мини-приложение для Android-планшета: «эмулятор десктопа» для веб-версии
Animastor (`frontends/app`). Открывает приложение в WebView на весь экран,
но заставляет страницу думать, что она открыта на широком десктопном мониторе:

- десктопный user-agent;
- ширина CSS viewport принудительно задаётся **1280 / 1366 / 1440 / 1920 px**,
  поэтому включается десктопный шелл (порог >= 1180px);
- весь десктопный интерфейс автоматически уменьшается до размеров экрана
  планшета — «мелко, но видно весь дизайн»; pinch-zoom доступен.

Это **не** браузер и **не** эмуляция конкретного железа — только CSS-эмуляция:
широкий viewport, десктопный user-agent, landscape-ориентация.

## Как это устроено

- Внутри — обычный `WebView` на весь экран (без рамки «телефона»).
- HTML главного фрейма перехватывается (`shouldInterceptRequest`) и в
  `<meta name="viewport" content="width=device-width, ...">` ширина заменяется
  на выбранную (1280/1366/1440/1920). С `useWideViewPort=true` +
  `loadWithOverviewMode=true` страница рендерится при этой ширине и целиком
  умещается на экране планшета.
- Десктопный user-agent подставляется принудительно.

## Возможности

| Элемент | Что делает |
|---|---|
| Кнопки ширины | Переключение CSS viewport: **1280 / 1366 / 1440 / 1920** px (по умолчанию 1366). При переключении страница перезагружается. |
| Строка URL | URL приложения. Сохраняется между запусками. Можно ввести без схемы — добавится `http://`. |
| ⟳ | Перезагрузить текущий URL. **Долгое нажатие** — очистить cookies/кэш и перезагрузить. |
| Pinch-zoom | Доступен (двумя пальцами) — разглядеть детали дизайна, которые мелко. |
| Fullscreen API страницы | **Отключён** (`requestFullscreen` заблокирован инжекцией) — кнопка плеера «во весь экран» ничего не делает, застрять в фуллскрине невозможно. |

Поддерживается JS, localStorage, cookies, touch, скролл, видео-аудио без жеста
пользователя, mixed content (для dev-сервера по http).

**Basic Auth (опционально)**: если целевой хост запросит Basic Auth, тестер
подставит креды из `BuildConfig` (`AUTH_USER` / `AUTH_PASS`). Пароль по умолчанию
пуст и в репозитории не хранится; при необходимости передайте его при сборке:

```bash
./gradlew assembleDebug -PTESTER_AUTH_USER=admin -PTESTER_AUTH_PASS=...
```

Сбросить кэш авторизации — долгое нажатие на ⟳.

## Где лежит

```
desktop-web-tester/
├── app/src/main/java/com/animastor/desktop/MainActivity.kt
├── app/src/main/res/...                (layout, темы, иконка)
├── app/build.gradle.kts                (applicationId com.animastor.desktop)
├── build-apk.sh                        (сборка + копия в net-disk)
├── gradlew                             (официальный Gradle wrapper 8.12)
└── README.md
```

## Сборка APK

```bash
./desktop-web-tester/build-apk.sh
```

Скрипт создаст `local.properties` из переменной окружения `ANDROID_SDK_ROOT`
(или `ANDROID_HOME`), соберёт `app/build/outputs/apk/debug/app-debug.apk` и
скопирует его в `$NET_DISK_DIR/desktop-web-tester.apk`
(`NET_DISK_DIR` по умолчанию `$HOME/net-disk`).

Установка на планшет (как обычно):
`https://animastor.org/net-disk/desktop-web-tester.apk`

### URL по умолчанию

- По умолчанию: `https://app.animastor.org` (продакшен).
- Заменить при сборке:
  ```bash
  cd desktop-web-tester
  ./gradlew assembleDebug -PTESTER_URL=http://192.168.1.50:5174
  ```
- Либо просто поменять URL в самом приложении (поле ввода) — он запоминается.

### Ширина по умолчанию

- По умолчанию: 1366 px.
- Заменить при сборке:
  ```bash
  ./gradlew assembleDebug -PTESTER_WIDTH=1440
  ```

Требования сборки: Android SDK (`ANDROID_SDK_ROOT`, platform android-35,
build-tools 34.0.0), JDK 17; Gradle 8.12 подтягивается автоматически через
`./gradlew`. minSdk 26, targetSdk 34, compileSdk 35.

## Ограничения

1. **Масштаб меньше, чем на реальном десктопе.** Десктопный макет 1366px
   умещается на экран планшета (обычно 800–1280 CSS px), поэтому всё выглядит
   мельче. Это проверка дизайна и вёрстки, а не физического размера; для
   деталей — pinch-zoom.
2. **No hardware emulation.** Тач-события — реальные планшетные; hover-состояния
   не срабатывают (нет мыши), клавиатурные хоткеи (Ctrl+S, стрелки) — только с
   физической клавиатурой. Кнопка «назад» работает как в браузере.
3. **minSdk 26** — для очень старых планшетов (Android ≤ 7) понадобится понизить
   и добавить PNG-иконку.
