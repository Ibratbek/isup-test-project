# Hikvision ISUP 5.0 Integration

Hikvision Face ID qurilmalarini ISUP 5.0 protokoli orqali boshqarish uchun to'liq tizim.

## Arxitektura

```
[Hikvision Face ID] ◄──ISUP/TCP──► [C++ Bridge] ◄──Redis──► [Node.js Backend] ◄──HTTP/WS──► [Frontend/Postman]
                        port 7660                                port 3000
```

| Komponent | Texnologiya | Vazifasi |
|-----------|-------------|----------|
| C++ Bridge | C++17 + Hikvision SDK | Qurilma bilan ISUP protokoli orqali muloqot |
| Node.js Backend | Express.js + SQLite | REST API, biznes logika |
| Redis | Redis 7 | Ikki process o'rtasida xabar almashish |
| SQLite | better-sqlite3 | Ma'lumotlar saqlash |

---

## Talablar

- Ubuntu 22.04 LTS (yoki boshqa Linux)
- Hikvision ISUP 5.0 SDK (Linux x86_64)
- Node.js 20+
- Redis 7+
- CMake 3.16+, GCC 11+
- libhiredis-dev, nlohmann-json3-dev

---

## O'rnatish

### 1. Hikvision SDK ni joylash

Hikvision rasmiy saytidan yoki distribyutordan SDK olining:

```bash
sudo mkdir -p /opt/hikvision-sdk/{include,lib}

# Header fayllarni joylang
sudo cp -r SDK/include/*  /opt/hikvision-sdk/include/
sudo cp -r SDK/lib/*      /opt/hikvision-sdk/lib/

# LD cache yangilash
echo "/opt/hikvision-sdk/lib" | sudo tee /etc/ld.so.conf.d/hikvision-sdk.conf
sudo ldconfig
```

SDK tarkibida bo'lishi kerak:
- `/opt/hikvision-sdk/include/HCNetSDK.h`
- `/opt/hikvision-sdk/include/HCNetSDKCom/` (papka)
- `/opt/hikvision-sdk/lib/libHCNetSDK.so`

### 2. Avtomatik o'rnatish (tavsiya etiladi)

```bash
git clone <repo-url> hikvision-isup
cd hikvision-isup
sudo bash install.sh
```

Bu skript quyidagilarni amalga oshiradi:
- System paketlarini o'rnatadi (build-essential, cmake, redis, hiredis, nlohmann-json)
- Node.js 20 ni o'rnatadi
- C++ bridge ni build qiladi
- Node.js dependencies o'rnatadi
- Systemd service'larini o'rnatadi
- Papka va foydalanuvchilarni yaratadi

### 3. Qo'lda o'rnatish

#### 3.1 System dependencies

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake redis-server \
    libhiredis-dev nlohmann-json3-dev libssl-dev libcurl4-openssl-dev
```

#### 3.2 Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
```

#### 3.3 C++ Bridge build

```bash
cd isup-bridge
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DHIK_SDK_ROOT=/opt/hikvision-sdk
cmake --build . --parallel $(nproc)
sudo cmake --install .
```

Binary `/usr/local/bin/isup-bridge` ga o'rnatiladi.

#### 3.4 Node.js Backend

```bash
cd backend
npm install
cp .env.example .env
# .env faylini tahrirlang
nano .env
```

---

## Konfiguratsiya

### C++ Bridge (`isup-bridge/config.json`)

```json
{
  "isup": {
    "listen_ip": "0.0.0.0",
    "listen_port": 7660,
    "max_devices": 100
  },
  "redis": {
    "host": "127.0.0.1",
    "port": 6379
  },
  "sdk": {
    "log_level": 3,
    "log_path": "/var/log/hikvision-isup/"
  },
  "log_level": "info"
}
```

### Node.js Backend (`backend/.env`)

```env
PORT=3000
NODE_ENV=production
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
DB_PATH=./data/hikvision.db
AUTH_METHOD=apikey
API_KEY=your-strong-api-key
LOG_LEVEL=info
COMMAND_TIMEOUT_MS=10000
```

---

## Qurilmani sozlash (Hikvision Face ID)

Qurilmaning web interfeysiga kiring (IP manzilini brauzerda oching):

1. **Configuration → Network → Advanced → Platform Access** bo'limiga o'ting
2. **Enable** — yoqing
3. **Platform Access Mode** — `ISUP` tanlang
4. **Server Address** — server IP manzilingiz (masalan, `192.168.1.100`)
5. **Port** — `7660`
6. **Device ID** — noyob ID bering (masalan, `DS-K1T671MF-001`)
7. **Verify Code** — bo'sh qoldiring yoki config.json da belgilangan kodni yozing
8. **Save** tugmasini bosing

Qurilma ulanganini logs'dan tekshiring:
```bash
sudo journalctl -u isup-bridge -f
```

---

## Ishga tushirish

### Docker Compose (Redis uchun)

```bash
docker-compose up -d
```

### Systemd orqali

```bash
# C++ Bridge
sudo systemctl start isup-bridge
sudo systemctl status isup-bridge

# Node.js Backend
sudo systemctl start hikvision-backend
sudo systemctl status hikvision-backend
```

### Qo'lda (test uchun)

```bash
# Avval Redis
sudo systemctl start redis-server

# C++ Bridge
cd isup-bridge/build
./isup-bridge ../config.json

# Node.js (boshqa terminaldo)
cd backend
npm start
```

---

## API Ishlatish

Barcha so'rovlarda header kerak:
```
X-API-Key: your-api-key
```

### Health check

```bash
curl http://localhost:3000/health
```

### Qurilmalar

```bash
# Barcha qurilmalar ro'yxati
curl -H "X-API-Key: your-key" http://localhost:3000/api/devices

# Qurilma holati
curl -H "X-API-Key: your-key" http://localhost:3000/api/devices/DS-K1T671MF-001/status

# Eshik ochish
curl -X POST -H "X-API-Key: your-key" \
     -H "Content-Type: application/json" \
     -d '{"doorIndex":1}' \
     http://localhost:3000/api/devices/DS-K1T671MF-001/open-door

# Vaqtni sinxronlash
curl -X POST -H "X-API-Key: your-key" \
     http://localhost:3000/api/devices/DS-K1T671MF-001/sync-time

# Qurilmani qayta yuklash
curl -X POST -H "X-API-Key: your-key" \
     http://localhost:3000/api/devices/DS-K1T671MF-001/reboot
```

### Foydalanuvchilar

```bash
# Yangi foydalanuvchi qo'shish
curl -X POST -H "X-API-Key: your-key" \
     -H "Content-Type: application/json" \
     -d '{
       "employee_id": "EMP001",
       "full_name": "Alisher Umarov",
       "card_number": "1234567890",
       "department": "IT"
     }' \
     http://localhost:3000/api/users

# Yuz rasmi bilan (base64)
curl -X POST -H "X-API-Key: your-key" \
     -H "Content-Type: application/json" \
     -d '{
       "employee_id": "EMP002",
       "full_name": "Mohira Karimova",
       "faceImageBase64": "/9j/4AAQSkZJRgAB..."
     }' \
     http://localhost:3000/api/users

# Qurilmaga sinxronlash
curl -X POST -H "X-API-Key: your-key" \
     http://localhost:3000/api/users/EMP001/sync/DS-K1T671MF-001

# Barcha online qurilmalarga sinxronlash
curl -X POST -H "X-API-Key: your-key" \
     -H "Content-Type: application/json" \
     -d '{"userId":"EMP001"}' \
     http://localhost:3000/api/users/bulk-sync
```

### Hodisalar

```bash
# Barcha hodisalar
curl -H "X-API-Key: your-key" \
     "http://localhost:3000/api/events?limit=50"

# Qurilma bo'yicha filter
curl -H "X-API-Key: your-key" \
     "http://localhost:3000/api/events?deviceId=DS-K1T671MF-001&type=face_recognition"

# Sana bo'yicha filter
curl -H "X-API-Key: your-key" \
     "http://localhost:3000/api/events?dateFrom=2025-05-01&dateTo=2025-05-31"

# Davomat hisoboti
curl -H "X-API-Key: your-key" \
     "http://localhost:3000/api/events/attendance?dateFrom=2025-05-25"
```

### WebSocket (real-time hodisalar)

```bash
# wscat bilan
npm install -g wscat
wscat -c "ws://localhost:3000/ws/events?apiKey=your-key"

# Yoki Postman → New → WebSocket Request
# URL: ws://localhost:3000/ws/events?apiKey=your-key
```

WebSocket xabar formati:
```json
{"type":"face_recognition","deviceId":"DS-K1T671MF-001","employeeId":"EMP001","timestamp":"2025-05-25T10:30:00.000Z","similarity":95}
{"type":"access_control","deviceId":"DS-K1T671MF-001","employeeId":"EMP001","doorId":"1","direction":"entry","timestamp":"..."}
{"type":"device_online","deviceId":"DS-K1T671MF-001","ip":"192.168.1.50","timestamp":"..."}
```

---

## Redis kanallari

| Kanal | Yo'nalish | Maqsad |
|-------|-----------|--------|
| `hikvision:events` | C++ → Node.js | Qurilmadan kelgan hodisalar |
| `hikvision:commands` | Node.js → C++ | Komandalar |
| `hikvision:responses:{id}` | C++ → Node.js | Komanda javobi |

Komanda formati:
```json
{
  "commandId": "uuid",
  "command": "open_door",
  "deviceId": "DS-K1T671MF-001",
  "params": {"doorIndex": 1}
}
```

---

## Loglarni kuzatish

```bash
# C++ Bridge loglari
sudo journalctl -u isup-bridge -f

# Node.js loglari
sudo journalctl -u hikvision-backend -f

# SDK loglari
ls /var/log/hikvision-isup/

# Redis monitoring
redis-cli monitor
```

---

## Troubleshooting

### C++ bridge ishga tushmayapti

```bash
# SDK topilmayapti
ldd /usr/local/bin/isup-bridge | grep "not found"
# Hal qilish:
sudo ldconfig
export LD_LIBRARY_PATH=/opt/hikvision-sdk/lib:$LD_LIBRARY_PATH

# Port band
sudo ss -tlnp | grep 7660
# Hal qilish: config.json da portni o'zgartiring
```

### Qurilma ulanmayapti

1. Server firewall 7660 portini ochganini tekshiring: `sudo ufw allow 7660/tcp`
2. Qurilma Platform Access sozlamalarini tekshiring
3. Qurilma va server bir tarmoqda ekanligini tekshiring: `ping <qurilma-ip>`
4. SDK logs: `/var/log/hikvision-isup/`

### Redis ulanish xatosi

```bash
redis-cli ping        # PONG bo'lishi kerak
sudo systemctl status redis-server
```

### Node.js xatolar

```bash
# Portni tekshirish
sudo ss -tlnp | grep 3000

# .env faylini tekshirish
cat backend/.env
```

### Eshik ochish komandasiga javob kelmayapti

- Qurilma online ekanligini tekshiring: `GET /api/devices/:id/status`
- Redis ulanishini tekshiring
- `COMMAND_TIMEOUT_MS` qiymatini oshirib ko'ring

---

## Loyiha tuzilishi

```
hikvision-isup/
├── README.md
├── docker-compose.yml        # Redis uchun
├── install.sh                # O'rnatish skripti
├── requests.http             # API test fayllar (VS Code REST Client)
│
├── isup-bridge/              # C++ qism
│   ├── CMakeLists.txt
│   ├── config.json
│   └── src/
│       ├── main.cpp          # Entry point, signal handling
│       ├── isup_server.cpp   # SDK init, ISUP listener, komandalar
│       ├── event_handler.cpp # Hodisalarni Redis ga publish qilish
│       ├── command_handler.cpp # Redis dan komandalar qabul qilish
│       ├── redis_client.cpp  # hiredis wrapper (pub/sub, reconnect)
│       └── logger.cpp        # JSON structured logging
│
├── backend/                  # Node.js qism
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.js          # Express + WebSocket server
│       ├── config.js
│       ├── db/
│       │   ├── database.js   # SQLite init + migrations
│       │   └── migrations.js # Schema versioning
│       ├── services/
│       │   ├── redis.service.js   # Redis pub/sub + sendCommand()
│       │   ├── device.service.js
│       │   ├── user.service.js
│       │   └── event.service.js
│       ├── routes/
│       │   ├── devices.routes.js
│       │   ├── users.routes.js
│       │   └── events.routes.js
│       ├── middleware/
│       │   ├── auth.js        # API key / JWT
│       │   └── errorHandler.js
│       └── utils/
│           └── logger.js      # Winston JSON logger
│
└── systemd/
    ├── isup-bridge.service
    └── hikvision-backend.service
```

---

## Litsenziya

Bu loyiha MIT litsenziyasi ostida tarqatiladi.
