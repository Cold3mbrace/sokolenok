# SOKOLENOK — v44.0.0

Личный кабинет игрока CS2: Steam-логин, инвентарь с реальными ценами,
статистика, новости. Без npm-зависимостей — только Node stdlib.

---

## Что внутри

```
sokolenok-v44/
├── server.js              # HTTP-сервер на http/https + Steam OpenID
├── storage/db.js          # node:sqlite с JSON-фолбэком
├── public/
│   ├── index.html         # Лендинг (Steam-логин + lookup чужого профиля)
│   ├── dashboard.html     # Дашборд
│   ├── inventory.html     # Полный инвентарь
│   ├── lookup.html        # Просмотр чужого профиля
│   ├── settings.html      # Настройки
│   ├── styles.css         # Тёмная тема, зелёный SOKOLENOK-акцент
│   ├── app.js             # Один общий фронтенд, роутер по body[data-page]
│   └── assets/            # Логотипы, иконки оружия/карт
├── package.json           # Никаких зависимостей. Только Node ≥22.5
└── README.md
```

**Все 6800 строк старой версии переписаны в ~2400 чистых.**

---

## Быстрый старт

Нужен **Node.js ≥ 22.5.0** (для встроенного `node:sqlite`).

```bash
cd sokolenok-v44
node server.js
# → http://localhost:4173
```

Зайди на `http://localhost:4173`, нажми «Войти через Steam», подтверди логин — попадёшь на `/dashboard`.

### Переменные окружения

| Переменная | Дефолт | Что делает |
|---|---|---|
| `PORT` | `4173` | Порт сервера |
| `BASE_URL` | `http://localhost:<PORT>` | Полный URL сайта. **На проде обязательно укажи**, иначе Steam OpenID вернёт не туда. |
| `STEAM_API_KEY` | — | Ключ Steam Web API. **Опционально.** Без него работают: профиль (XML), инвентарь, цены, новости. С ним добавляются: GetPlayerSummaries (вместо XML) и GetUserStatsForGame (K/D, HS%, точность и т.д.). |
| `FACEIT_API_KEY` | — | Ключ Faceit Data API v4. **Опционально, но рекомендуется** — даёт реальную CS2-аналитику (per-match K/D, винрейт, ELO, последние матчи, карты). Получить на https://developers.faceit.com → создать App → Server-side API key. |
| `SOKOLENOK_DATA_DIR` | `./.data` | Где хранится SQLite/JSON |

### Получить Steam API Key

1. Открой https://steamcommunity.com/dev/apikey
2. Войди в свой Steam-аккаунт
3. В поле «Domain Name» укажи свой домен (для локалки можно `localhost`)
4. Скопируй ключ в `STEAM_API_KEY`

**Важно:** ключ не нужен для OpenID-логина. OpenID работает без ключа. Ключ нужен только для расширенной статистики через `GetUserStatsForGame`.

### Получить Faceit API Key

1. Открой https://developers.faceit.com и войди через Faceit/Steam
2. Создай новое приложение (My Apps → Create App)
3. В разделе API Keys создай Server-side API key (он же Service token)
4. Скопируй в `FACEIT_API_KEY`

Faceit-данные доступны для любого игрока у кого есть публичный Faceit-профиль с CS2. Привязка к Steam происходит автоматически по SteamID, но юзер может задать свой Faceit-ник в настройках, если связь не нашлась.

### Leetify (опционально)

Leetify-профиль подтягивается автоматически на странице lookup, если игрок зарегистрирован у них и его профиль публичный. API key не требуется — используется публичный endpoint `api.leetify.com/api/profile/id/{steamid}`. Если игрок не зарегистрирован, Leetify-секция просто не рендерится; кнопка-ссылка в блоке «Другие сервисы» остаётся в любом случае.

### Пример продакшен-запуска

```bash
PORT=4173 \
BASE_URL=https://sokolenok.example.com \
STEAM_API_KEY=ABCDEF1234567890... \
FACEIT_API_KEY=XYZ-faceit-server-token... \
SOKOLENOK_DATA_DIR=/var/lib/sokolenok \
node server.js
```

За nginx/Caddy с HTTPS — обязательно. Steam OpenID требует, чтобы `openid.realm` совпадал с реальным адресом возврата. Если за прокси — пробрось `X-Forwarded-Proto: https`.

---

## Что работает в MVP

| Фича | Статус |
|---|---|
| Steam OpenID login (без API-ключа) | ✅ |
| Автовход после первого логина (cookie 30 дней) | ✅ |
| Профиль игрока через Steam XML | ✅ |
| Профиль через GetPlayerSummaries | ✅ если задан `STEAM_API_KEY` |
| Инвентарь CS2 с Steam Market прайсами | ✅ |
| Снапшоты инвентаря в БД (история) | ✅ |
| Цены в RUB / USD / EUR с кэшем 6ч | ✅ |
| Watchlist (добавить/удалить отслеживание) | ✅ |
| Steam UserStats для CS2 (K/D, HS%, точность, оружие, карты) | ✅ если задан `STEAM_API_KEY` и профиль публичный |
| Новости CS2 (Steam News RSS) | ✅ |
| Просмотр чужих профилей (без подмеса своих данных) | ✅ |
| Настройки: валюта, язык, Telegram ID | ✅ |
| Лимит запросов к Steam Market (80 уников за заход, конкурентность 3) | ✅ |
| Честные empty states (нет данных — так и говорим) | ✅ |
| Адаптив под мобилу | ✅ |

## Чего **нет** (и почему)

| Фича | Почему не в MVP |
|---|---|
| История матчей CS2 | Нужен отдельный pipeline: GCPD → sharecode → demo-parser (csdemoparser). На сайте есть честный empty state. |
| Premier-ранг и история ранга | Steam не отдаёт это публично, нужны те же демки. |
| Played with | Извлекается из демок. |
| Реальные советы по игре | Требуют demo-parser для извлечения позиций/таймингов/дуэлей. |
| Прогнозы рынка | Без 30+ дней истории цен это будет гадание. История начнёт копиться с первого запуска. |
| Telegram-бот | Заготовка есть (поле `telegram_id` в настройках), бот пока не подключен. |
| Сравнение по площадкам (Market CSGO / Buff) | Каждая площадка требует своих ключей и rate-limit аккуратности. |

Эти блоки не показываются как фейк — везде честные empty states.

---

## API эндпойнты

Все JSON, кроме `/auth/*`. Сессионная кука `sok_session`, HttpOnly, SameSite=Lax, 30 дней.

| Метод | Путь | Что |
|---|---|---|
| GET | `/api/health` | Статус сервиса, версия, storage backend |
| GET | `/api/me` | Текущая сессия + профиль + настройки |
| GET | `/api/resolve?input=...` | SteamID64 / vanity / URL → SteamID64 |
| GET | `/api/profile/:steamid` | Профиль (XML или GetPlayerSummaries) |
| GET | `/api/inventory/:steamid?currency=RUB&no_prices=0` | Инвентарь CS2 с ценами |
| GET | `/api/inventory/history?steamid=...` | История снапшотов из БД |
| GET | `/api/stats/:steamid` | UserStats CS2 (нужен `STEAM_API_KEY`) |
| GET | `/api/news?count=5` | Steam News для CS2 (appid 730) |
| GET | `/api/prices?names=...&currency=RUB` | Батч цен Steam Market |
| GET | `/api/price-history?name=...` | История цены в БД |
| GET | `/api/watchlist` | Список отслеживания (требует сессию) |
| POST | `/api/watchlist` | Добавить (`{"market_name":"..."}`) |
| DELETE | `/api/watchlist?market_name=...` | Удалить |
| GET | `/api/settings` | Настройки пользователя |
| POST | `/api/settings` | Сохранить (`{currency,language,telegram_id}`) |
| GET | `/auth/steam` | Старт OpenID — редирект на Steam |
| GET | `/auth/steam/callback` | Возврат от Steam, ставит cookie, → `/dashboard` |
| POST | `/auth/logout` | Очистить сессию |

---

## Storage

По умолчанию `node:sqlite` (встроен в Node 22.5+, не требует npm-пакетов).
Если SQLite по какой-то причине недоступен — автоматический фолбэк на
JSON-файл `<DATA_DIR>/sokolenok.json`. Никаких внешних БД ставить не нужно.

Таблицы: `users`, `sessions`, `inventory_snapshots`, `prices`,
`price_history`, `watchlist`, `user_settings`, `events`.

Цены пишутся в `prices` (последняя цена с TTL 6 часов) и параллельно
в `price_history` для построения динамики.

---

## Ограничения Steam Market — важно знать

Steam Market агрессивно режет неавторизованные запросы цен.
Реальный потолок при загрузке инвентаря — около **80 уникальных
предметов за раз**, потом IP начинает получать 429/403.

Что сделано, чтобы это смягчить:

- Кэш цены **6 часов** в БД — повторные запросы за этим окном не идут в Steam.
- Конкурентность ограничена **3 запросами** в момент.
- При первой загрузке инвентаря из 200 уников: 80 получат цену сразу,
  остальные подтянутся при следующих заходах (когда часть кэша протухнет
  и освободятся слоты, и при ручном «↻ Обновить»).
- В UI пишется «Цены загружены для X уник., ещё Y ждут — зайдите через час».

Если хочется ускорить — можно подмешать прайсы с **MarketCSGO** или **csgomarket.fastly.net**
как второй источник. В архитектуре это место помечено — добавить второй провайдер
в `getPriceBatch()` в `server.js`.

---

## Безопасность и приватность

- Пароль Steam **никогда** не попадает в это приложение — это суть OpenID.
- Сессионная кука `HttpOnly` (JS не может её прочитать) и `SameSite=Lax`.
- На проде ставь `Secure` (это произойдёт автоматически, если `BASE_URL` начинается с `https://`).
- При просмотре чужого профиля сервер изолирует данные: ни watchlist, ни настройки, ни история инвентаря НЕ подмешиваются.
- `STEAM_API_KEY` хранится только в env-переменных, не пишется в логи и не отдаётся клиенту.

---

## Деплой

### Рекомендуемый способ — Docker Compose (nginx + SSL)

Полное пошаговое руководство: **[deploy/DEPLOY.md](deploy/DEPLOY.md)**.

Кратко: на VPS с Docker нужно заполнить `.env` (домен + ключи), подставить домен в `deploy/nginx.conf`, выпустить Let's Encrypt сертификат и поднять стек:

```bash
cp .env.example .env && nano .env
sed -i "s/YOUR_DOMAIN/ваш-домен.рф/g" deploy/nginx.conf deploy/nginx-bootstrap.conf
# выпуск сертификата (см. DEPLOY.md шаг 5), затем:
docker compose up -d
```

Поднимаются три контейнера: приложение (Node 22), nginx (reverse proxy + SSL), certbot (автопродление). Данные хранятся в Docker-volume `sokolenok-data` и переживают пересборку.

### Ручной деплой за прокси (без Docker)

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name sokolenok.example.com;
  ssl_certificate     /etc/letsencrypt/live/sokolenok.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sokolenok.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

Затем запускай ноду с `BASE_URL=https://sokolenok.example.com` (требуется Node ≥22.5 для `node:sqlite`).

### systemd unit (пример)

```ini
[Unit]
Description=SOKOLENOK
After=network.target

[Service]
Type=simple
User=sokolenok
WorkingDirectory=/opt/sokolenok-v44
Environment=PORT=4173
Environment=BASE_URL=https://sokolenok.example.com
Environment=STEAM_API_KEY=xxxxx
Environment=COOKIE_SECURE=1
Environment=SOKOLENOK_DATA_DIR=/var/lib/sokolenok
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## Что добавлять дальше (roadmap)

**Этап 2 (pricing core):**
- Второй прайс-источник (MarketCSGO) для перекрёстной проверки
- Job-скрипт раз в сутки: обновлять цены для всех `watchlist` items + топ-100 предметов из инвентарей пользователей
- Алерты при движении цены ±10%

**Этап 3 (match pipeline):**
- Подключение `GameAuthCode` через настройки
- Скачивание sharecode-ов через `Steam.WebUserAuthenticator` / неофициальный protobuf
- Парсер демок (`csdemoparser` или `awpy` на питоне как воркер)
- Сохранение раундов/убийств/смертей в БД

**Этап 4 (advice engine):**
- Простые правила на основе demo-данных:
  «За 10 матчей ты 7 раз умер до 25-й сек. на Mirage T-side» → совет
- Weekly goals
- Сравнение с самим собой неделя к неделе

**Этап 5 (Telegram):**
- Простой long-polling бот в отдельном процессе
- Команды: `/me`, `/inv`, `/watch <item>`
- Алерты watchlist через ту же БД

---

## Лицензия

Внутренний проект. CS2 и Steam — товарные знаки Valve Corporation.
SOKOLENOK не аффилирован с Valve.
