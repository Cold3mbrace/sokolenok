# v50.15 — iOS cache recovery

## Что изменилось

- Обновлена версия сайта и ассетов до `50.15`.
- Все HTML-страницы теперь подключают `/styles.css?v=50.15` и `/app.js?v=50.15`.
- Service worker регистрируется через `/sw.js?v=50.15` с `updateViaCache: 'none'`.
- Новый service worker чистит старые `sok-*` кеши при активации.
- Сервер отдает `/sw.js` с `no-store, no-cache, must-revalidate`.
- `/app.js`, `/styles.css` и `/manifest.json` теперь требуют проверки свежести через `no-cache, must-revalidate`.

## Зачем

- На новой iOS/Safari сайт мог открывать старую оболочку или старые файлы после обновлений.
- Фикс не требует действий от пользователя: сайт сам подтягивает свежую версию.

## Проверки

- `npm.cmd run check`
