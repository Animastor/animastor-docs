# Разведка: «залипание» аккаунта между admin.animastor.org и app.animastor.org

**Дата:** 2026-11-06  
**Цель:** Детальный анализ механизма аутентификации без изменений кода и прода.  
**Симптом:** Залогиненный в admin пользователь developer виден в app; logout → «гость»; refresh → снова developer; позже «гость», но видны книги пользователя sureg. Прошло после перезапуска браузера (Opera).

---

## 1. Имя cookie сессии и атрибуты Set-Cookie

### 1.1 Имя cookie

**User session:**
- Имя: `animastor_sid`
- Источник: `packages/animastor-auth/src/cookies.js:22`
  ```javascript
  const SESSION_COOKIE_NAME = 'animastor_sid';
  ```

**Guest session:**
- Имя: `animastor_gid`
- Источник: `packages/animastor-auth/src/cookies.js:23`
  ```javascript
  const GUEST_COOKIE_NAME = 'animastor_gid';
  ```

### 1.2 Атрибуты Set-Cookie при логине

**Функция установки session cookie:**  
`packages/animastor-auth/src/cookies.js:33-39` (`sessionCookieHeader`)

```javascript
function sessionCookieHeader(token, { secure }, cfg = {}) {
    const ttl = cfg.sessionTtlMs != null ? cfg.sessionTtlMs : SESSION_TTL_MS;
    const maxAgeSec = Math.floor(ttl / 1000);
    let v = `${cfg.sessionCookieName || SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${domainSuffix(cfg.cookieDomain)}`;
    if (secure) v += '; Secure';
    return v;
}
```

**Domain suffix:**  
`packages/animastor-auth/src/cookies.js:27-29`
```javascript
function domainSuffix(cookieDomain) {
    return cookieDomain ? `; Domain=${cookieDomain}` : '';
}
```

**Продовая конфигурация:**  
`prod/.env`: `COOKIE_DOMAIN=animastor.org`

**Результирующий заголовок при логине (HTTPS):**
```
Set-Cookie: animastor_sid=<token>; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Domain=animastor.org; Secure
```

**Атрибуты:**
- `Path=/` — cookie доступна на всех путях домена
- `Max-Age=2592000` (30 дней = `SESSION_TTL_MS`, `cookies.js:25`)
- `HttpOnly` — недоступна JavaScript
- `SameSite=Lax` — отправляется при переходе с внешних сайтов (GET), но не при кросс-доменных POST
- **`Domain=animastor.org`** — **cookie SHARED между app.animastor.org и admin.animastor.org**
- `Secure` — только по HTTPS

### 1.3 Атрибуты guest cookie

**Функция установки guest cookie:**  
`packages/animastor-auth/src/cookies.js:49-54` (`guestCookieHeader`)

Атрибуты **идентичны** session cookie:
```
Set-Cookie: animastor_gid=<token>; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Domain=animastor.org; Secure
```

### 1.4 Разница app vs admin при логине

**Логин на app.animastor.org:**  
`POST /api/v1/auth/login` → `backend/src/routes/auth-routes.cjs:48-64`
- Устанавливает `animastor_sid` с `Domain=animastor.org`

**Логин на admin.animastor.org:**  
`POST /api/v1/auth/login` (тот же endpoint, тот же backend)
- Устанавливает `animastor_sid` с `Domain=animastor.org`

**Вывод пункта 1:**  
Cookie с одним именем `animastor_sid` и одним `Domain=animastor.org` **SHARED между обоими поддоменами**. Браузер хранит **одну** cookie `animastor_sid=<token>` для `Domain=animastor.org`, которая отправляется на оба поддомена.

**Гипотеза залипания:**  
При логине в admin браузер устанавливает `animastor_sid` для `.animastor.org`, переход на app читает **ту же cookie** → показывает того же пользователя.

---

## 2. Logout: какие cookie очищаются

### 2.1 Обработка logout в backend

**Endpoint:** `POST /api/v1/auth/logout`  
**Источник:** `backend/src/routes/auth-routes.cjs:67-88`

```javascript
app.post('/api/v1/auth/logout', async (req, res) => {
    try {
        const secure = isSecure(req);
        const cookies = [];
        const sessionToken = authService.readCookie(req, authService.SESSION_COOKIE_NAME);
        if (sessionToken) {
            await authService.logout(sessionToken); // idempotent
            cookies.push(authService.clearSessionCookieHeader({ secure }));
        }
        const guestToken = authService.readCookie(req, authService.GUEST_COOKIE_NAME);
        if (guestToken) {
            await guestRepo.revokeByToken(guestToken).catch(() => {});
            cookies.push(authService.clearGuestCookieHeader({ secure }));
            res.setHeader('Set-Cookie', cookies);
            return res.json({ ok: true, guest: true });
        }
        cookies.push(authService.clearGuestCookieHeader({ secure }));
        res.setHeader('Set-Cookie', cookies);
        res.json({ ok: true });
    } catch (err) { /* ... */ }
});
```

### 2.2 Функция очистки session cookie

**Источник:** `packages/animastor-auth/src/cookies.js:42-46` (`clearSessionCookieHeader`)

```javascript
function clearSessionCookieHeader({ secure } = {}, cfg = {}) {
    let v = `${cfg.sessionCookieName || SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${domainSuffix(cfg.cookieDomain)}`;
    if (secure) v += '; Secure';
    return v;
}
```

**Результирующий заголовок при logout:**
```
Set-Cookie: animastor_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Domain=animastor.org; Secure
Set-Cookie: animastor_gid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Domain=animastor.org; Secure
```

### 2.3 Удаление сессии в PG

**Функция:** `backend/src/storage/postgres/repositories/session-repo.js:92-97` (`revokeByToken`)

```javascript
async function revokeByToken(token) {
    const parsed = parseToken(token);
    if (!parsed) return false;
    await query(`UPDATE sessions SET revoked_at = $1 WHERE session_id = $2 AND revoked_at IS NULL`, [Date.now(), parsed.sessionId]);
    return true;
}
```

**Вывод пункта 2:**  
Logout:
1. Ставит `revoked_at` в таблице `sessions` (PG)
2. Отправляет `Set-Cookie` с `Max-Age=0` для **обеих** cookie (`animastor_sid`, `animastor_gid`)
3. **Атрибуты очищающего заголовка совпадают с установочным** (включая `Domain=animastor.org`)

**Вопрос:** Logout вызванный на `app.animastor.org` очищает cookie с `Domain=animastor.org`, которую **должен видеть и `admin.animastor.org`**. Почему в симптоме после logout на app.animastor.org при refresh снова появляется `developer`?

**Возможные причины:**
- **Несовпадение атрибутов:** Браузер не удаляет cookie, если атрибуты `Set-Cookie: Max-Age=0` не совпадают с атрибутами исходной cookie (RFC 6265). Но код использует **ту же функцию** `domainSuffix(cfg.cookieDomain)` — атрибуты совпадают.
- **Timing race:** Одна вкладка выполняет logout, другая уже имеет cookie в памяти и отправляет запросы до получения `Set-Cookie: Max-Age=0`.
- **Browser cache:** Браузер кэширует ответ `/auth/me` — после logout фронтенд показывает старые данные.

---

## 3. Выбор сессии при нескольких cookie

### 3.1 Как backend читает cookie

**Middleware:** `backend/src/middleware/auth-context.js:52-76` (`authContext`)

**Порядок проверки:**
1. Читает `animastor_sid` из `Cookie:` заголовка
2. Если токен валиден → `resolveSession` → устанавливает `req.user`, `req.workspace`, `req.auth = { kind: 'user' }`
3. Если `animastor_sid` отсутствует/невалидна → читает `animastor_gid`
4. Если guest токен валиден → устанавливает `req.guest`, `req.workspace`, `req.auth = { kind: 'guest' }`

**Код чтения session cookie:**
```javascript
const sessionToken = authService.parseCookieHeader
    ? authService.parseCookieHeader(req.headers && req.headers.cookie, authService.SESSION_COOKIE_NAME)
    : authService.readCookie(req, authService.SESSION_COOKIE_NAME);
if (sessionToken) {
    const resolved = await authService.resolveSession(sessionToken);
    if (resolved) {
        req.user = resolved.user;
        req.workspace = resolved.workspace;
        req.auth = { kind: 'user' };
        return next();
    }
}
```

**Функция парсинга:** `packages/animastor-auth/src/cookies.js:74-84` (`parseCookieHeader`)

```javascript
function parseCookieHeader(header, name) {
    if (!header) return null;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) {
            try { return decodeURIComponent(part.slice(eq + 1).trim()); } 
            catch (_) { return part.slice(eq + 1).trim(); }
        }
    }
    return null;
}
```

**Вывод пункта 3:**  
Backend читает **первую** cookie с именем `animastor_sid` из заголовка `Cookie:`. Если браузер отправляет несколько cookie с одинаковым именем (RFC 6265: браузер может объединить host-only и domain cookie в один заголовок), backend берёт **первую в строке**.

**Гипотеза:** Если браузер держит две cookie `animastor_sid`:
- host-only для `admin.animastor.org` (старый механизм до `COOKIE_DOMAIN`)
- domain `.animastor.org` (новая)

То на запросе к `app.animastor.org` браузер может отправить:
```
Cookie: animastor_sid=<token1>; animastor_sid=<token2>
```
Backend прочитает первую → может быть «старая» сессия другого пользователя.

**Но:** По коду, `COOKIE_DOMAIN=animastor.org` установлен в проде → **все новые логины ставят domain cookie, host-only не создаются**. Симптом мог возникнуть, если:
- До введения `COOKIE_DOMAIN` были host-only cookie
- После введения — domain cookie
- Браузер держит обе до перезапуска

---

## 4. Кэширование на фронтенде

### 4.1 /auth/me

**Endpoint:** `GET /api/v1/auth/me`  
**Источник:** `backend/src/routes/auth-routes.cjs:90-112`

**Заголовки ответа:** Код **не устанавливает** `Cache-Control` или `ETag` → браузер применяет эвристическое кэширование (по умолчанию может кэшировать GET на несколько секунд/минут).

**Фронтенд:** `frontends/app/src/state/authStore.ts:16-25` (`fetchMe`)

```typescript
export async function fetchMe(): Promise<AuthMe> {
  try {
    const me = await getJson<AuthMe>('/auth/me');
    authMe.value = me;
    authError.value = null;
    return me;
  } catch { /* ... */ }
}
```

**API client:** `frontends/app/src/api/client.ts:74-89` (`getJson`)

```typescript
export async function getJson<T>(path: string, init?: Pick<RequestInit, 'cache'>): Promise<T> { 
    return request<T>(path, init); 
}
```

**По умолчанию:** `fetch()` без `cache: 'no-store'` → браузер **может кэшировать** ответ `/auth/me`.

### 4.2 /books

**Endpoint:** `GET /api/v1/books`  
**Источник:** `backend/src/routes/book/recent-books-routes.cjs:207-222`

**Заголовки ответа:** Код **не устанавливает** `Cache-Control` → эвристическое кэширование.

**Вывод пункта 4:**  
- Backend **НЕ отправляет** `Cache-Control: no-store` для `/auth/me` и `/books`
- Фронтенд **НЕ указывает** `cache: 'no-store'` в `fetch()`
- Браузер **может кэшировать** эти ответы на короткое время (эвристика: обычно 10% от `Last-Modified` до now, если заголовок есть)

**Гипотеза залипания:**  
1. Пользователь логинится в admin как `developer` → `fetchMe()` → кэш содержит `{ user: { username: 'developer' } }`
2. Logout → фронтенд вызывает `/auth/logout`, но **не вызывает `fetchMe()` сразу после**
3. Код в `authStore.ts:66-75` (logout):
   ```typescript
   await postJson<unknown>('/auth/logout', {});
   // ...
   authMe.value = { authenticated: false, user: null, workspace: null };
   ```
   **Устанавливает `authMe.value` локально, но НЕ вызывает `fetchMe()` для свежего ответа**
4. Refresh страницы → вызывается `fetchMe()` → браузер **возвращает кэшированный ответ** `/auth/me` с `developer`
5. Позже (кэш истёк) → `fetchMe()` получает свежий ответ → показывает «гость» или другого пользователя

### 4.3 Service Worker

**Проверка:** `grep -r "service.*worker" src/animastor-web/frontends/app/src/**/*.{js,ts}` → **не найдено**.

**Вывод:** Service worker **отсутствует** — кэширование только браузерное (HTTP cache).

### 4.4 localStorage / sessionStorage

**Источник:** `frontends/app/src/state/authStore.ts:1-3`

```typescript
// Authentication state (Account & Workspace MVP).
// Server-side session cookie is the source of truth; localStorage is never
// used for auth. The store only mirrors /auth/me.
```

**Использование localStorage:**
- Хранит `currentBook` session (книга, открытая в данный момент) — `frontends/app/src/state/fileStore.ts:232`
- Хранит preferences (тема) — `frontends/app/src/app/theme.ts:11-16`
- **НЕ хранит** auth state (username, workspace)

**Вывод:** Auth state **не персистится** в localStorage → после logout и refresh фронтенд **должен** вызвать `/auth/me` для получения текущего состояния.

### 4.5 Инициализация auth на фронтенде

**Место вызова `fetchMe()`:**

1. **UserMenu mount:** `frontends/app/src/features/auth/UserMenu.tsx:109`
   ```typescript
   useEffect(() => { void fetchMe(); }, []);
   ```
   UserMenu монтируется в header → `fetchMe()` вызывается при первом рендере приложения.

2. **После логина из анонима:** `frontends/app/src/main.tsx:75-79`
   ```typescript
   useEffect(() => {
     if (authMe.value.authenticated && !bookId.value) {
       void restoreBookSession();
     }
   }, [authMe.value.authenticated]);
   ```
   Но **НЕ вызывает `fetchMe()`** — полагается на то, что `login()` уже установил `authMe.value`.

**Вывод пункта 4 (итого):**  
**ВЕРОЯТНАЯ ПРИЧИНА ЗАЛИПАНИЯ:**
1. **Browser HTTP cache** кэширует `/auth/me` (нет `Cache-Control: no-store` в ответе)
2. Logout очищает cookie server-side, устанавливает `authMe.value = { authenticated: false, ... }` client-side, **но НЕ вызывает `fetchMe()` для инвалидации кэша**
3. Refresh → `UserMenu` mount → `fetchMe()` → браузер возвращает **stale cached response** `/auth/me` с предыдущим пользователем
4. Позже (кэш истёк или инвалидирован) → свежий запрос → показывает реальное состояние

**Дополнительный фактор:** Если пользователь открыл admin и app в **разных вкладках**, то:
- Logout в admin → очищает cookie
- App вкладка не получила событие (cookie change не триггерит события в других вкладках без polling)
- App показывает старое состояние до refresh

---

## 5. Воспроизведение локально (теоретическая последовательность)

### Сценарий 1: Browser cache

1. **Setup:**
   - Два домена `admin.localhost` и `app.localhost` через `/etc/hosts` → `127.0.0.1`
   - nginx config с `proxy_pass` к backend:3000, `COOKIE_DOMAIN=localhost`
   - Backend с `NODE_ENV=development`, `X-Forwarded-Proto: https` (simulate prod)

2. **Шаги:**
   ```bash
   # Логин в admin
   curl -c cookies.txt -X POST http://admin.localhost/api/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"developer","password":"..."}'
   # → Set-Cookie: animastor_sid=<token>; Domain=localhost

   # Проверка auth на app (той же cookie jar)
   curl -b cookies.txt http://app.localhost/api/v1/auth/me
   # → { "authenticated": true, "user": { "username": "developer" } }

   # Logout на app
   curl -b cookies.txt -c cookies.txt -X POST http://app.localhost/api/v1/auth/logout
   # → Set-Cookie: animastor_sid=; Max-Age=0; Domain=localhost

   # Немедленная проверка /auth/me (без кэша)
   curl -b cookies.txt http://app.localhost/api/v1/auth/me
   # → { "authenticated": false, "identity": "none", ... }
   ```

3. **Воспроизведение залипания (с браузером):**
   - Открыть `http://admin.localhost/admin` в браузере
   - Залогиниться как `developer`
   - Открыть **новую вкладку** `http://app.localhost` → видим `developer` (shared cookie)
   - В вкладке app: logout
   - **НЕ закрывать вкладку**, сделать refresh (F5)
   - Ожидаемо: «анонимный»
   - **Если показывает `developer`** → кэш `/auth/me` не инвалидирован

4. **Проверка кэша:**
   - DevTools → Network → запрос к `/api/v1/auth/me` → заголовки:
     - Response: есть ли `Cache-Control: no-store`?
     - Request: `Cache-Control: max-age=0` (force reload) или взят из кэша?

### Сценарий 2: Две cookie (host-only + domain)

**Условие:** Система работала **до** введения `COOKIE_DOMAIN`, затем его добавили.

1. **Старая cookie (host-only):**
   ```
   Set-Cookie: animastor_sid=<old_token>; Path=/; Max-Age=...
   (без Domain → host-only для admin.animastor.org)
   ```

2. **Новая cookie (domain):**
   ```
   Set-Cookie: animastor_sid=<new_token>; Path=/; Max-Age=...; Domain=animastor.org
   ```

3. **Браузер хранит обе** (RFC 6265: host-only и domain cookie с одним именем — разные записи).

4. **Запрос к app.animastor.org:**
   ```
   Cookie: animastor_sid=<old_token>; animastor_sid=<new_token>
   ```
   Backend читает **первую** → если это старая токен другого пользователя → «залипание».

5. **Logout:**
   ```
   Set-Cookie: animastor_sid=; Path=/; Max-Age=0; Domain=animastor.org
   ```
   Очищает **только domain cookie**, host-only остаётся → следующий запрос снова отправляет старую.

6. **Перезапуск браузера:** Очищает обе cookie (если они session, без Max-Age) → симптом пропадает.

**Проверка в проде:**
```bash
# Проверить, есть ли в логах nginx несколько animastor_sid в одном запросе
grep "animastor_sid.*animastor_sid" /var/log/nginx/access.log
```

**Вывод сценария 2:** Возможен, если `COOKIE_DOMAIN` был добавлен **после** того, как пользователи уже логинились без него.

---

## 6. Итоговые выводы

### 6.1 Факты

1. **Cookie name и Domain:**
   - User: `animastor_sid`, Guest: `animastor_gid`
   - `Domain=animastor.org` (prod env `COOKIE_DOMAIN=animastor.org`)
   - **Shared между app.animastor.org и admin.animastor.org**

2. **Атрибуты cookie:**
   - `Path=/; Max-Age=2592000 (30d); HttpOnly; SameSite=Lax; Domain=animastor.org; Secure`
   - Login и logout используют **одинаковые атрибуты** (включая `Domain`)

3. **Logout:**
   - Ставит `revoked_at` в таблице `sessions` (PG)
   - Отправляет `Set-Cookie: Max-Age=0` для **обеих** cookie (`sid`, `gid`)
   - Фронтенд устанавливает `authMe.value = { authenticated: false, ... }` локально, **но НЕ вызывает `fetchMe()`**

4. **Backend читает первую cookie `animastor_sid`** из `Cookie:` заголовка при нескольких с одним именем.

5. **Кэширование:**
   - Backend **НЕ отправляет** `Cache-Control: no-store` для `/auth/me` и `/books`
   - Фронтенд **НЕ указывает** `cache: 'no-store'` в `fetch()`
   - Браузер **может кэшировать** `/auth/me`

6. **localStorage/sessionStorage:** Auth state **НЕ персистится** — только mirrors `/auth/me`.

7. **Service Worker:** Отсутствует.

8. **Guest session (guestId):**
   - Отдельная cookie `animastor_gid`
   - Приоритет: user session (`animastor_sid`) проверяется **первой**, guest — **второй** (fallback)

### 6.2 Вероятные причины симптома

**Причина 1 (наиболее вероятная): Browser HTTP cache**

1. Пользователь логинится в admin → `/auth/me` закэширован с `{ user: 'developer' }`
2. Переходит на app → видит `developer` (shared cookie + кэш)
3. Logout на app → cookie удалена, `authMe.value` установлен в `anonymous` локально
4. **Refresh** → `fetchMe()` → браузер **возвращает stale cached response** `/auth/me`
5. Фронтенд показывает `developer` до истечения кэша
6. Позже (или другой refresh с `Ctrl+Shift+R`) → свежий запрос → «гость»

**Доказательство:** Симптом пропал после **перезапуска браузера** (полная очистка кэша).

**Причина 2 (возможная): Две cookie (host-only + domain)**

1. До введения `COOKIE_DOMAIN` пользователи логинились → host-only `animastor_sid` для `admin.animastor.org`
2. После введения `COOKIE_DOMAIN=animastor.org` → новые логины ставят domain cookie
3. Браузер держит **обе** cookie до перезапуска
4. При запросе к app браузер отправляет обе → backend читает **первую** (старую host-only) → «залипание»
5. Logout с `Domain=animastor.org` очищает только domain cookie → host-only остаётся
6. Следующий refresh → снова отправляет старую host-only → симптом

**Доказательство:** Симптом показал **разных** пользователей (developer → sureg) → может быть несколько старых cookie.

**Причина 3 (менее вероятная): Race condition в multi-tab**

1. Admin и app открыты в **разных вкладках**
2. Logout в одной вкладке → cookie удалена
3. Другая вкладка **не получила событие** (cookie change не синхронизируется между вкладками без polling/BroadcastChannel)
4. Отправляет запрос со старой cookie (ещё в памяти процесса браузера) → показывает старого пользователя
5. Refresh → процесс читает cookie заново → синхронизируется

**Но:** Cookie удаляется на уровне браузера (не процесса вкладки) → при следующем запросе должна быть удалена. Менее вероятно.

### 6.3 Рекомендации (для будущего фикса, не в этой задаче)

1. **Backend: добавить `Cache-Control: no-store, no-cache, must-revalidate` для `/auth/me` и `/books`**
   - Путь: `backend/src/routes/auth-routes.cjs:90`, `book/recent-books-routes.cjs:207`
   - Код:
     ```javascript
     res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
     res.setHeader('Pragma', 'no-cache');
     res.setHeader('Expires', '0');
     ```

2. **Frontend: вызывать `fetchMe()` после logout для инвалидации клиентского состояния**
   - Путь: `frontends/app/src/state/authStore.ts:58-75` (функция `logout`)
   - Код:
     ```typescript
     await postJson<unknown>('/auth/logout', {});
     stashBookSessionForUser(userId);
     await fetchMe(); // ← добавить
     ```

3. **Frontend: использовать `cache: 'no-store'` в `fetchMe()`**
   - Путь: `frontends/app/src/state/authStore.ts:18`
   - Код:
     ```typescript
     const me = await getJson<AuthMe>('/auth/me', { cache: 'no-store' });
     ```

4. **Проверить наличие старых host-only cookie в проде:**
   - Chrome DevTools → Application → Cookies → `admin.animastor.org` и `app.animastor.org`
   - Если есть cookie `animastor_sid` **без Domain** → удалить вручную или дождаться истечения (30 дней от последнего логина до введения `COOKIE_DOMAIN`)

5. **Очистить старые cookie у пользователей (опционально):**
   - Backend: при логине проверять наличие старой host-only cookie (нельзя напрямую из backend) ИЛИ
   - Frontend: добавить миграцию — при старте удалять старые cookie через `document.cookie` (но они `HttpOnly` → нельзя)
   - **Альтернатива:** Дождаться естественного истечения (30 дней) или полагаться на перезапуск браузеров

---

## 7. Точные пути и строки кода

| Утверждение | Путь:строка |
|-------------|-------------|
| Имя session cookie `animastor_sid` | `packages/animastor-auth/src/cookies.js:22` |
| Имя guest cookie `animastor_gid` | `packages/animastor-auth/src/cookies.js:23` |
| Атрибуты Set-Cookie (session) | `packages/animastor-auth/src/cookies.js:33-39` |
| Атрибуты Set-Cookie (guest) | `packages/animastor-auth/src/cookies.js:49-54` |
| Domain suffix (включает `Domain=` атрибут) | `packages/animastor-auth/src/cookies.js:27-29` |
| Функция очистки session cookie | `packages/animastor-auth/src/cookies.js:42-46` |
| Функция очистки guest cookie | `packages/animastor-auth/src/cookies.js:58-62` |
| Logout endpoint | `backend/src/routes/auth-routes.cjs:67-88` |
| Revoke session в PG | `backend/src/storage/postgres/repositories/session-repo.js:92-97` |
| Revoke guest в PG | `backend/src/storage/postgres/repositories/guest-repo.js:136-141` |
| Auth context middleware (чтение cookie) | `backend/src/middleware/auth-context.js:52-76` |
| Парсинг Cookie заголовка | `packages/animastor-auth/src/cookies.js:74-84` |
| Session TTL (30 дней) | `packages/animastor-auth/src/cookies.js:25` |
| Guest TTL (30 дней) | `packages/animastor-auth/src/cookies.js:28` |
| `/auth/me` endpoint | `backend/src/routes/auth-routes.cjs:90-112` |
| `/books` endpoint | `backend/src/routes/book/recent-books-routes.cjs:207-222` |
| Фронтенд `fetchMe()` | `frontends/app/src/state/authStore.ts:16-25` |
| Фронтенд `logout()` | `frontends/app/src/state/authStore.ts:58-75` |
| Фронтенд API client (`getJson`) | `frontends/app/src/api/client.ts:74-89` |
| Инициализация auth (UserMenu mount) | `frontends/app/src/features/auth/UserMenu.tsx:109` |
| Продовая конфигурация `COOKIE_DOMAIN` | `prod/.env:COOKIE_DOMAIN=animastor.org` |
| Нормализация cookie domain | `packages/animastor-auth/src/auth-config.js:68-73` |
| Host wiring (применение `COOKIE_DOMAIN` из env) | `backend/src/auth/index.cjs:36-43` |
| nginx proxy для app.animastor.org | `prod/nginx/default.conf:383-457` |
| nginx proxy для admin.animastor.org | `prod/nginx/default.conf:471-532` |
| localStorage НЕ используется для auth | `frontends/app/src/state/authStore.ts:1-3` (комментарий) |
| Service worker отсутствует | `grep -r "service.*worker" → No matches` |

---

## 8. Следующие шаги (не выполняются в этой задаче)

1. **Проверить в проде:** DevTools → Network → `/auth/me` → Response Headers → есть ли `Cache-Control: no-store`?
2. **Проверить в проде:** DevTools → Application → Cookies → есть ли **несколько** `animastor_sid` с разными Domain?
3. **Воспроизвести локально** (сценарий 1 с кэшем) — подтвердить гипотезу.
4. **Если подтверждено:** Создать задачу на фикс (добавить `Cache-Control` в backend + `fetchMe()` после logout).

---

**Файл создан:** 2026-11-06  
**Автор:** Kiro (claude-sonnet-4.5)  
**Статус:** Разведка завершена, изменений кода и прода не производилось.
