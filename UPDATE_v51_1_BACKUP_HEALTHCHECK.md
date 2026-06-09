# v51.1 — backup + healthcheck (Заход 2)

Ежедневный бэкап БД + Telegram-алерты если сервер упал.

## Что добавлено

- `scripts/backup-db.js` — снимок `sokolenok.sqlite` через `VACUUM INTO`, кладёт в `.data/backups/YYYY-MM-DD.sqlite`, хранит 14 дней
- `scripts/healthcheck.js` — пингует `/api/health` каждую минуту, шлёт тебе в Telegram если упал/поднялся

## Установка на сервере (один раз)

### Шаг 1 — получи свой Telegram chat_id

1. Найди своего бота `@sokolenok_login_bot` в Telegram и напиши ему **`/start`** (любое сообщение в личку).
2. На компе/сервере:
   ```bash
   curl "https://api.telegram.org/bot8969626559:AAEFKgp2HqBoLJqk0csreUYHxoaP292XZFk/getUpdates"
   ```
3. В ответе найди `"chat":{"id":123456789,…}` — это твой chat_id. Скопируй число.

### Шаг 2 — добавь в `.env`

```bash
ssh root@5.129.202.50
nano /var/www/sokolenok/.env
```

Допиши в конец:
```
ALERT_TELEGRAM_CHAT=твой_числовой_chat_id
```

(`TELEGRAM_BOT_TOKEN` уже есть.)

### Шаг 3 — проверь скрипты вручную

```bash
cd /var/www/sokolenok
node scripts/backup-db.js
ls -la .data/backups/
```

Должен появиться файл `2026-06-09.sqlite`.

```bash
node scripts/healthcheck.js
```

Если сервер работает — выведет `[health] OK · v51.0.0`, ничего не пришлёт. Если бот настроен и chat_id правильный — после второго провала тебе придёт сообщение в Telegram.

### Шаг 4 — добавь в cron

```bash
crontab -e
```

Допиши в конец:
```
# SOKOLENOK: daily DB backup at 04:00 UTC
0 4 * * * cd /var/www/sokolenok && /usr/bin/node scripts/backup-db.js >> /var/log/sokolenok-backup.log 2>&1

# SOKOLENOK: health check every minute
* * * * * cd /var/www/sokolenok && /usr/bin/node scripts/healthcheck.js >> /var/log/sokolenok-healthcheck.log 2>&1
```

Сохрани (`Ctrl+O` → Enter → `Ctrl+X`). Проверь что добавилось:
```bash
crontab -l
```

### Шаг 5 — тест алерта (опционально)

```bash
pm2 stop sokolenok
# подожди 2 минуты — health-check сработает 2 раза, отправит алерт
pm2 start sokolenok
# ещё минута — придёт алерт "поднялся"
```

## Что увидишь в Telegram

Когда сервер падает (после 2 неудачных пингов подряд):
```
🔴 SOKOLENOK не отвечает
Причина: ECONNREFUSED
Время: 2026-06-09T20:15:00Z
Проверь: pm2 logs sokolenok --lines 50 --nostream
```

Когда поднимается:
```
✅ SOKOLENOK поднялся
Версия: v51.0.0
Лежал с 2026-06-09T20:15:00Z
Длительность: ~3 мин
```

## Расположение

- Бэкапы: `/var/www/sokolenok/.data/backups/`
- Лог бэкапов: `/var/log/sokolenok-backup.log`
- Лог health-check: `/var/log/sokolenok-healthcheck.log`
- State health-check: `/var/www/sokolenok/.data/healthcheck-state.json`

## Восстановление из бэкапа (если что-то пошло не так)

```bash
pm2 stop sokolenok
cp .data/sokolenok.sqlite .data/sokolenok.sqlite.broken
cp .data/backups/2026-06-09.sqlite .data/sokolenok.sqlite
pm2 start sokolenok
```
