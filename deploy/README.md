# Deploy Presensi Non-ASN

Berkas di folder ini menyiapkan server agar bisa melayani versi
frontend yang sekarang — yang memanggil backend lewat path
relatif (`/api`, `/uploads`), bukan alamat absolut.

## Kondisi server saat ini (192.168.221.44)

Dicek lewat HTTP pada 1 September 2026:

| Hal | Temuan |
|---|---|
| nginx 1.24 (Ubuntu) :80 | jalan, menyajikan build Vite lama (20 Juli 2026, `<title>frontend</title>`) |
| Express :5000 | jalan, balas `Server Absensi Backend berjalan dengan baik!` |
| `/api/...` lewat :80 | **404** — padahal langsung ke :5000 balas 200 |
| `/uploads/` lewat :80 | mengembalikan `index.html`, bukan foto |

Dua baris terakhir itu yang harus dibetulkan sebelum kode
terbaru dipasang. Kalau tidak, aplikasi tidak akan bisa absen
sama sekali dan semua foto gagal tampil.

## Langkah 0 — periksa dulu apa yang sudah ada

Jangan langsung menimpa. Di server:

```bash
# Konfigurasi nginx mana yang aktif, dan di mana root-nya
ls -l /etc/nginx/sites-enabled/
grep -rn "root\|proxy_pass\|server_name" /etc/nginx/sites-enabled/

# Backend dijalankan oleh apa — pm2, systemd, atau screen?
pm2 list 2>/dev/null
systemctl list-units --type=service | grep -i "presensi\|absensi\|node"
ps aux | grep "[n]ode"

# Di mana repo dan folder foto sekarang
sudo lsof -p "$(pgrep -f 'node index.js' | head -1)" 2>/dev/null | grep -i cwd
```

Sesuaikan path di `presensi.conf`, `presensi-backend.service`,
dan `deploy.sh` dengan hasil pemeriksaan itu. **Foto absensi
yang sudah ada jangan sampai kena `rsync --delete`** — pastikan
`UPLOAD_DIR` berada di luar root nginx.

## Langkah 1 — tata letak folder

```
/srv/presensi/backend    clone repo backend  (dijalankan systemd)
/srv/presensi/frontend   clone repo frontend (dibuild di sini)
/srv/presensi/uploads    UPLOAD_DIR, foto absensi
/var/www/presensi        hasil build, root nginx
```

```bash
sudo mkdir -p /srv/presensi /var/www/presensi
cd /srv/presensi
sudo git clone https://github.com/rifqisyekhi/presensi-biro-keuangan-dan-bmn-backend.git backend
sudo git clone https://github.com/rifqisyekhi/presensi-biro-keuangan-dan-bmn-frontend.git frontend
sudo mkdir -p /srv/presensi/uploads
```

Kalau folder foto lama ada di tempat lain, pindahkan isinya ke
`/srv/presensi/uploads` dengan struktur yang sama
(`<pegawai>/<bulan-tahun>/<tanggal>_masuk.jpg`) — path itu
tersimpan di MongoDB, jadi tidak boleh berubah.

## Langkah 2 — environment backend

```bash
sudo cp /srv/presensi/backend/deploy/.env.example /srv/presensi/backend/.env
sudo nano /srv/presensi/backend/.env          # isi MONGODB_URI
sudo chown www-data:www-data /srv/presensi/backend/.env
sudo chmod 600 /srv/presensi/backend/.env
```

## Langkah 3 — service backend

Lewati kalau backend sudah dikelola pm2 dan mau tetap begitu.

```bash
sudo cp /srv/presensi/backend/deploy/presensi-backend.service \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now presensi-backend
sudo systemctl status presensi-backend
```

Pastikan proses lama tidak ikut jalan di port 5000
(`sudo pm2 delete all` atau matikan service lamanya), kalau
tidak akan bentrok `EADDRINUSE`.

## Langkah 4 — nginx

```bash
sudo cp /srv/presensi/backend/deploy/presensi.conf \
        /etc/nginx/sites-available/presensi.conf
sudo ln -sf /etc/nginx/sites-available/presensi.conf \
            /etc/nginx/sites-enabled/presensi.conf

# Nonaktifkan site lama yang menyajikan build 20 Juli
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t && sudo systemctl reload nginx
```

## Langkah 5 — deploy

```bash
sudo bash /srv/presensi/backend/deploy/deploy.sh
```

Skrip itu: `git pull` kedua repo, `npm ci`, build frontend,
salin `dist/` ke `/var/www/presensi`, restart backend, reload
nginx, lalu memverifikasi tiga endpoint.

## Verifikasi manual

Dari laptop:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.221.44/
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.221.44/api/absensi/today/0000
```

Yang kedua **harus 200**. Kalau masih 404, `proxy_pass` masih
memakai trailing slash di suatu tempat dan prefix `/api`
terpotong sebelum sampai ke Express.

Buka `http://192.168.221.44/` — judul tab harus
"Absensi Non-ASN Biro Keuangan dan BMN". Kalau masih tertulis
"frontend", browser masih memuat build lama dari cache atau
site nginx lama masih aktif.

## Catatan

**Foto lewat nginx langsung.** `/uploads/` sekarang diteruskan
ke Express. Kalau nanti terasa berat, ganti blok itu jadi:

```nginx
location /uploads/ {
    alias /srv/presensi/uploads/;
    expires 7d;
    add_header Cache-Control "public";
    try_files $uri =404;
}
```

Trailing slash pada `alias` wajib ada.

**Batas ukuran unggahan.** `client_max_body_size 50m` di
`presensi.conf` mengikuti limit body parser di
`index.js`. Kalau salah satu diubah, ubah keduanya — kalau
tidak, absen dengan foto besar gagal dengan 413 dari nginx
sebelum kodenya sempat jalan.

**HTTPS.** Server ini beralamat IP privat, jadi Let's Encrypt
tidak bisa dipakai. Kalau nanti dikasih domain, jalankan
`sudo certbot --nginx -d domain.go.id` — certbot akan
menambahkan blok 443 sendiri ke `presensi.conf`.
