#!/usr/bin/env bash
# Hikvision ISUP 5.0 Integration — Ubuntu 22.04 o'rnatish skripti
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || err "Root yoki sudo kerak: sudo bash install.sh"

INSTALL_DIR="/opt/hikvision-isup"
SDK_DIR="/opt/hikvision-sdk"

# ---------------------------------------------------------------------------
# 1. System dependencies
# ---------------------------------------------------------------------------
log "System pakitlarini yangilash..."
apt-get update -qq

log "Kerakli paketlarni o'rnatish..."
apt-get install -y -qq \
    build-essential \
    cmake \
    git \
    curl \
    redis-server \
    libhiredis-dev \
    nlohmann-json3-dev \
    libssl-dev \
    libcurl4-openssl-dev \
    ca-certificates \
    gnupg

# ---------------------------------------------------------------------------
# 2. Node.js 20
# ---------------------------------------------------------------------------
if ! command -v node &>/dev/null || [[ $(node -e "process.exit(parseInt(process.version.slice(1)) < 20 ? 1 : 0)" 2>&1; echo $?) == "1" ]]; then
    log "Node.js 20 o'rnatilmoqda..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    log "Node.js $(node -v) mavjud"
fi

# ---------------------------------------------------------------------------
# 3. Hikvision SDK tekshiruvi
# ---------------------------------------------------------------------------
if [[ ! -d "$SDK_DIR" ]]; then
    warn "Hikvision SDK topilmadi: $SDK_DIR"
    warn "SDK'ni qo'lda o'rnating:"
    warn "  1. https://www.hikvision.com/en/support/download/ dan yuklab oling"
    warn "  2. sudo mkdir -p $SDK_DIR/{include,lib}"
    warn "  3. Header'larni $SDK_DIR/include/ ga ko'chiring"
    warn "  4. .so fayllarni $SDK_DIR/lib/ ga ko'chiring"
    warn "Keyinchalik: sudo bash install.sh --skip-sdk-check"
    [[ "${1:-}" == "--skip-sdk-check" ]] || exit 1
else
    log "Hikvision SDK topildi: $SDK_DIR"
fi

# ---------------------------------------------------------------------------
# 4. Foydalanuvchi va papkalar
# ---------------------------------------------------------------------------
log "hikvision foydalanuvchi yaratilmoqda..."
if ! id hikvision &>/dev/null; then
    useradd -r -s /bin/false -d "$INSTALL_DIR" hikvision
fi

log "Papkalar yaratilmoqda..."
mkdir -p "$INSTALL_DIR"/{isup-bridge,backend/{data/{uploads,faces/snapshots}}}
mkdir -p /var/log/hikvision-isup
mkdir -p /etc/hikvision-isup

# ---------------------------------------------------------------------------
# 5. Fayllarni ko'chirish
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log "Loyiha fayllari ko'chirilmoqda..."
cp -r "$SCRIPT_DIR/isup-bridge" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/backend"     "$INSTALL_DIR/"

# SDK SDK lib symlink
mkdir -p "$INSTALL_DIR/isup-bridge/lib"
ln -sfn "$SDK_DIR/lib" "$INSTALL_DIR/isup-bridge/lib/hikvision"

# ---------------------------------------------------------------------------
# 6. C++ build
# ---------------------------------------------------------------------------
log "C++ bridge build qilinmoqda..."
BUILD_DIR="$INSTALL_DIR/isup-bridge/build"
mkdir -p "$BUILD_DIR"
cmake -S "$INSTALL_DIR/isup-bridge" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DHIK_SDK_ROOT="$SDK_DIR" \
    -DCMAKE_INSTALL_PREFIX=/usr/local
cmake --build "$BUILD_DIR" --parallel "$(nproc)"
cmake --install "$BUILD_DIR"
log "C++ bridge build muvaffaqiyatli!"

# ---------------------------------------------------------------------------
# 7. Node.js dependencies
# ---------------------------------------------------------------------------
log "Node.js dependencies o'rnatilmoqda..."
cd "$INSTALL_DIR/backend"
npm install --production

# ---------------------------------------------------------------------------
# 8. Konfiguratsiya
# ---------------------------------------------------------------------------
log "Konfiguratsiya fayllari tayyorlanmoqda..."

if [[ ! -f /etc/hikvision-isup/config.json ]]; then
    cp "$INSTALL_DIR/isup-bridge/config.json" /etc/hikvision-isup/config.json
    log "C++ config: /etc/hikvision-isup/config.json"
fi

if [[ ! -f "$INSTALL_DIR/backend/.env" ]]; then
    cp "$INSTALL_DIR/backend/.env.example" "$INSTALL_DIR/backend/.env"
    warn ".env fayli yaratildi. Tahrirlang: nano $INSTALL_DIR/backend/.env"
fi

# ---------------------------------------------------------------------------
# 9. Redis
# ---------------------------------------------------------------------------
log "Redis xizmati yoqilmoqda..."
systemctl enable redis-server
systemctl start  redis-server

# ---------------------------------------------------------------------------
# 10. Systemd services
# ---------------------------------------------------------------------------
log "Systemd service'lari o'rnatilmoqda..."
cp "$SCRIPT_DIR/systemd/isup-bridge.service"      /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/hikvision-backend.service" /etc/systemd/system/

systemctl daemon-reload
systemctl enable isup-bridge hikvision-backend

# ---------------------------------------------------------------------------
# 11. Ruxsatlar
# ---------------------------------------------------------------------------
chown -R hikvision:hikvision "$INSTALL_DIR"
chown -R hikvision:hikvision /var/log/hikvision-isup
chmod 640 "$INSTALL_DIR/backend/.env"

# ---------------------------------------------------------------------------
# 12. SDK shared library LD cache
# ---------------------------------------------------------------------------
echo "$SDK_DIR/lib" > /etc/ld.so.conf.d/hikvision-sdk.conf
ldconfig

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
log "=============================="
log " O'rnatish muvaffaqiyatli!"
log "=============================="
echo ""
echo "Keyingi qadamlar:"
echo "  1. Backend konfiguratsiyasini to'ldiring:"
echo "       sudo nano $INSTALL_DIR/backend/.env"
echo "  2. C++ bridge konfiguratsiyasini tekshiring:"
echo "       sudo nano /etc/hikvision-isup/config.json"
echo "  3. Xizmatlarni ishga tushiring:"
echo "       sudo systemctl start isup-bridge"
echo "       sudo systemctl start hikvision-backend"
echo "  4. Loglarni kuzating:"
echo "       sudo journalctl -u isup-bridge -f"
echo "       sudo journalctl -u hikvision-backend -f"
echo ""
