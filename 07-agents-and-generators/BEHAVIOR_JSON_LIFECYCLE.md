# behavior.json — жизненный цикл

Актуально на 2026-11-10 (фаза 0 поведений, ветки `feat/behaviour-p0`, не влиты). Схема, правила, матчер и применение — [`../architecture/VBOOK_BEHAVIOUR.md`](../architecture/VBOOK_BEHAVIOUR.md). Исходный исследовательский отчёт (коммит `d1a8ec2`: файл не создавался, пустой файл удалялся при сохранении) устарел с `8ee4976` (2026-09-01) и заменён этим документом; его выводы — в разделе «История».

## 1. Формат

| Где | Форма |
|---|---|
| диск `data/books/<id>/behavior.json`, `.vbook` | v2: `{schema_version: 2, rules: [...], characters: {<character_id>: {baseline, quirks, reactions}}}` |
| память (`book.behaviors`) | v2 |
| API `GET /book/:id` | `behaviors` — плоская карта героев (форма v2.1), `behavior_rules` — правила, только чтение |

Файл без `schema_version` — формат **v2.1** (плоская карта `character_id → запись`): при загрузке все верхнеуровневые ключи становятся `characters`. Служебные ключи `schema_version`, `rules`, `characters`, `defaults` не являются `character_id`.

Запись героя (контракт Character Behavior v2.1, schema-tolerant — неизвестные ключи сохраняются):

```json
{
  "baseline": "how the character behaves normally",
  "quirks": ["recurring habit"],
  "reactions": [{ "trigger": "situation", "reaction": "observable response" }]
}
```

## 2. Создание

- `createDraftBook()` — файла нет.
- Первое окно новой книги (`lazy-book/create.js`, `isFirstWindow`): если файла нет — пишется пустой v2-документ `{schema_version: 2, rules: [], characters: {}}`.
- Книга без файла (например, старый импорт) читается как пустой v2-документ.

## 3. Загрузка

- `loadBookFromDir()` (диск) и `buildBookFromBundle()` (импорт `.vbook`) → `normalizeBehaviors()` (`@animastor/vbook-runtime/behavior-schema.cjs`): v2.1 → v2, у v2 `rules`/`characters` приводятся к массиву/объекту, прочие верхнеуровневые ключи сохраняются.

## 4. Сохранение

- `saveBookBundle()` **всегда** пишет `behavior.json`, всегда в v2 (`normalizeBehaviors(book.behaviors)`), в том числе пустой документ — ассистент всегда видит файл.
- Валидатор бандла (`bundle-validator.cjs`): v2 — `schema_version === 2`, `rules[]` с уникальным непустым `id`, `characters` — объект; v2.1 — плоский объект (принимается).
- Экспорт `.vbook` — zip каталога книги, то есть формат диска (v2).

## 5. Кто пишет

| Источник | Путь | Что меняется |
|---|---|---|
| Редактор web/Android | `POST/PATCH/DELETE /book/:id/behaviors[/:characterId]` | `characters.<id>`; `rules` не трогаются |
| Удаление героя | `DELETE /book/:id/characters/:id` | каскадно `characters.<id>` |
| Сохранение книги | `PUT /book/:id` | плоская карта из тела раскладывается в `characters`, `rules`/`schema_version` сохраняются; без `behaviors` — без изменений |
| AI-ассистент | `edit_book` | `/behaviors/characters/{id}`; страж переписывает пути v2.1 и плоскую карту |
| Пайплайн VBook | — | `behavior.json` **не пишет**; читает `rules` (через эффективные правила) и пишет результат в IU (`unit.behaviour`) |

Подробно — [`VBOOK_BEHAVIOUR.md` §7](../architecture/VBOOK_BEHAVIOUR.md).

## 6. Кто читает

- Фронты (через проекцию API): карточки поведения героев — только `behaviors` (плоская карта, служебные ключи отфильтрованы). Правила в UI в фазе 0 не показываются.
- Ассистент (in-memory v2 в контексте книги).
- Пайплайн VBook: `rules` книги поверх дефолтов `backend/ai/examples/behaviour-rules.json` → матчер → `unit.behaviour` (снимок) → строка видео-сториборда. Записи героев (`baseline/quirks/reactions`) генерацией пока не читаются.

## 7. Инвалидация

Правка `behavior.json` (и правил, и записей героев) ничего не помечает dirty: применённые фразы — снимок в IU. `unit.behaviour` → только video; `unit.state`, `unit.behaviour_locked` → ни один слой.

## 8. История

- `d690e35` (2026-08-31) — ручной редактор, `behavior.json` (pass 1, поле `instruction`).
- `7168a5b` / `8def086` — запись героя v2 / v2.1 (`baseline/quirks/reactions`, `instruction` удалён).
- `8ee4976` (2026-09-01) — файл `{}` создаётся на первом окне, всегда сохраняется (раньше пустой удалялся — вывод исходного отчёта `d1a8ec2` §2/§7); ассистент знает о Behavior.
- 2026-11-10 — документ v2 (`schema_version`, `rules`, `characters`), проекция в API, правила и матчер (фаза 0).
