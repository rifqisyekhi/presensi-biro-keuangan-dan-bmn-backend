#!/usr/bin/env bash
#
# =========================================================
# DEPLOY PRESENSI NON-ASN
# =========================================================
#
# Dijalankan DI SERVER, bukan di laptop:
#   sudo bash /srv/presensi/backend/deploy/deploy.sh
#
# Tata letak yang diasumsikan:
#   /srv/presensi/backend    git clone repo backend (dijalankan systemd)
#   /srv/presensi/frontend   git clone repo frontend (dibuild di sini)
#   /srv/presensi/uploads    UPLOAD_DIR, foto absensi
#   /var/www/presensi        hasil build frontend, root nginx

set -euo pipefail

BACKEND_DIR="${BACKEND_DIR:-/srv/presensi/backend}"
FRONTEND_DIR="${FRONTEND_DIR:-/srv/presensi/frontend}"
WEB_ROOT="${WEB_ROOT:-/var/www/presensi}"
UPLOADS_DIR="${UPLOADS_DIR:-/srv/presensi/uploads}"
SERVICE="${SERVICE:-presensi-backend}"

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }

# ---------------------------------------------------------
# PEMERIKSAAN AWAL
# ---------------------------------------------------------

for dir in "$BACKEND_DIR" "$FRONTEND_DIR"; do
    if [ ! -d "$dir/.git" ]; then
        echo "❌ $dir bukan git repo. Clone dulu repo-nya ke sana." >&2
        exit 1
    fi
done

if [ ! -f "$BACKEND_DIR/.env" ]; then
    echo "❌ $BACKEND_DIR/.env tidak ada. Salin dari deploy/.env.example." >&2
    exit 1
fi

# Foto absensi TIDAK boleh ikut terhapus saat deploy, jadi
# UPLOAD_DIR sengaja berada di luar WEB_ROOT.
mkdir -p "$UPLOADS_DIR"
chown -R www-data:www-data "$UPLOADS_DIR"

# ---------------------------------------------------------
# BACKEND
# ---------------------------------------------------------

info "Menarik perubahan backend"
git -C "$BACKEND_DIR" pull --ff-only

info "Memasang dependensi backend"
npm --prefix "$BACKEND_DIR" ci --omit=dev

# ---------------------------------------------------------
# FRONTEND
# ---------------------------------------------------------

info "Menarik perubahan frontend"
git -C "$FRONTEND_DIR" pull --ff-only

info "Memasang dependensi frontend"
# devDependencies ikut dipasang: vite ada di sana dan dibutuhkan
# untuk build.
npm --prefix "$FRONTEND_DIR" ci

info "Build frontend"
npm --prefix "$FRONTEND_DIR" run build

if [ ! -f "$FRONTEND_DIR/dist/index.html" ]; then
    echo "❌ Build gagal: dist/index.html tidak terbentuk." >&2
    exit 1
fi

info "Menyalin hasil build ke $WEB_ROOT"
mkdir -p "$WEB_ROOT"
# --delete membuang aset build lama; aman karena WEB_ROOT hanya
# berisi hasil build, foto absensi ada di folder terpisah.
rsync -a --delete "$FRONTEND_DIR/dist/" "$WEB_ROOT/"
chown -R www-data:www-data "$WEB_ROOT"

# ---------------------------------------------------------
# RESTART
# ---------------------------------------------------------

info "Menjalankan ulang backend"
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || {
    echo "❌ $SERVICE gagal jalan. Cek: journalctl -u $SERVICE -n 50" >&2
    exit 1
}

info "Menguji ulang konfigurasi nginx"
nginx -t
systemctl reload nginx

# ---------------------------------------------------------
# VERIFIKASI
# ---------------------------------------------------------

info "Verifikasi lewat nginx"

# Backend langsung.
printf '  backend  :5000     -> %s\n' \
    "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/)"

# Halaman SPA.
printf '  frontend /         -> %s\n' \
    "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)"

# Proxy /api. 200 = prefix diteruskan benar.
# 404 = proxy_pass masih memotong /api.
printf '  proxy    /api/...  -> %s (harus 200, BUKAN 404)\n' \
    "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/absensi/today/0000)"

echo
echo "✅ Selesai."
