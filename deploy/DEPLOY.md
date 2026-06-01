# Деплой SOKOLENOK на VPS

Полное руководство: от пустого сервера до работающего сайта по HTTPS.
Стек: Docker + Docker Compose + nginx + Let's Encrypt. Приложение — на чистом Node 22 (без npm-зависимостей), хранилище — SQLite в Docker-volume.

---

## 0. Что нужно заранее

1. **VPS** с Ubuntu 22.04/24.04 (подойдёт самый дешёвый — 1 vCPU / 1 GB RAM).
2. **Домен**, направленный A-записью на IP сервера. Например `sokolenok.pro` и `www.sokolenok.pro` → IP вашего VPS. Проверить: `dig +short YOUR_DOMAIN` должен вернуть IP сервера.
3. **Steam Web API key** — https://steamcommunity.com/dev/apikey (в поле Domain укажите ваш домен).
4. **Faceit API key** — https://developers.faceit.com (Server-side key).

---

## 1. Подготовка сервера

Подключитесь по SSH и установите Docker:

```bash
# обновление
sudo apt update && sudo apt upgrade -y

# Docker + compose plugin (официальный скрипт)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# перелогиньтесь, чтобы группа применилась
exit
```

Зайдите снова и проверьте:

```bash
docker --version
docker compose version
```

---

## 2. Загрузка проекта на сервер

Скопируйте папку проекта на сервер (например через `scp` или git):

```bash
# вариант через scp с локальной машины:
scp -r sokolenok-v44 user@SERVER_IP:~/

# на сервере
cd ~/sokolenok-v44
```

---

## 3. Настройка переменных окружения

```bash
cp .env.example .env
nano .env
```

Заполните:

```
BASE_URL=https://YOUR_DOMAIN
STEAM_API_KEY=ваш_ключ
FACEIT_API_KEY=ваш_ключ
COOKIE_SECURE=1
```

---

## 4. Подставьте домен в конфиги nginx

Замените `YOUR_DOMAIN` на ваш реальный домен в обоих файлах:

```bash
sed -i "s/YOUR_DOMAIN/sokolenok.pro/g" deploy/nginx.conf
sed -i "s/YOUR_DOMAIN/sokolenok.pro/g" deploy/nginx-bootstrap.conf
```

(подставьте свой домен вместо `sokolenok.pro`)

---

## 5. Первый запуск + получение SSL-сертификата

SSL-сертификата ещё нет, поэтому финальный `nginx.conf` (он ссылается на сертификат) пока не запустится. Делаем в два шага.

### 5.1 Запуск в bootstrap-режиме (только HTTP)

Временно подменяем nginx-конфиг на HTTP-only:

```bash
mkdir -p deploy/certbot/www deploy/certbot/conf

# временно используем bootstrap-конфиг
cp deploy/nginx.conf deploy/nginx.conf.bak
cp deploy/nginx-bootstrap.conf deploy/nginx.conf

# поднимаем app + nginx
docker compose up -d --build app nginx
```

Проверьте, что сайт открывается по http://YOUR_DOMAIN (должен отдать страницу).

### 5.2 Выпуск сертификата

```bash
docker compose run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d YOUR_DOMAIN -d www.YOUR_DOMAIN \
  --email you@example.com \
  --agree-tos --no-eff-email
```

При успехе сертификат окажется в `deploy/certbot/conf/live/YOUR_DOMAIN/`.

### 5.3 Возврат к HTTPS-конфигу

```bash
# возвращаем полный конфиг с SSL
cp deploy/nginx.conf.bak deploy/nginx.conf

# перезапускаем nginx
docker compose up -d nginx
docker compose restart nginx
```

Откройте https://YOUR_DOMAIN — должен работать HTTPS с зелёным замком, а http автоматически редиректить на https.

---

## 6. Запуск всего стека

```bash
docker compose up -d
docker compose ps
```

Должны быть запущены три контейнера: `sokolenok-app`, `sokolenok-nginx`, `sokolenok-certbot` (последний автопродлевает сертификат каждые 12 ч).

Логи приложения:

```bash
docker compose logs -f app
```

В логах должно быть `Steam API key: configured` и `Faceit API key: configured`.

---

## 7. Проверка

- https://YOUR_DOMAIN — лендинг
- Вход через Steam → должно вернуть на ваш домен и залогинить
- https://YOUR_DOMAIN/api/health — JSON со статусом

---

## Обслуживание

### Обновление кода

```bash
cd ~/sokolenok-v44
# залейте новую версию файлов, затем:
docker compose up -d --build app
```

Данные (SQLite) лежат в Docker-volume `sokolenok-data` и переживают пересборку.

### Бэкап данных

```bash
docker run --rm -v sokolenok-v44_sokolenok-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/sokolenok-backup-$(date +%F).tar.gz -C /data .
```

### Восстановление

```bash
docker run --rm -v sokolenok-v44_sokolenok-data:/data -v $(pwd):/backup alpine \
  sh -c "cd /data && tar xzf /backup/sokolenok-backup-YYYY-MM-DD.tar.gz"
docker compose restart app
```

### Продление сертификата

Контейнер `certbot` продлевает автоматически. Принудительно:

```bash
docker compose run --rm certbot renew
docker compose restart nginx
```

---

## Траблшутинг

**Steam-логин уводит не туда / ошибка возврата**
→ Проверьте, что `BASE_URL` в `.env` точно совпадает с доменом (https, без слэша в конце), и что в Steam API key указан правильный домен.

**`node:sqlite` ошибка / приложение падает при старте**
→ Образ собран на Node 22 (требуется ≥22.5). Не меняйте базовый образ на более старый Node.

**Сертификат не выпускается**
→ Убедитесь, что A-запись домена указывает на IP сервера и порт 80 открыт (firewall). `dig +short YOUR_DOMAIN`.

**Инвентарь долго грузится в первый раз**
→ Это нормально: первый запрос тянет цены из Steam Market. Дальше работает кэш (10 мин свежесть, до 24 ч отдаётся из кэша с фоновым обновлением).

**Открыть порт в firewall (если включён ufw)**
```bash
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow OpenSSH
sudo ufw enable
```
