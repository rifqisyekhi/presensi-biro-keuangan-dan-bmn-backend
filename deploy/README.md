# Deploy Presensi Non-ASN

## Kondisi sebenarnya di VPS

Aplikasi ini berjalan di VPS yang sama dengan SisKA, gajihub,
dan meeting-room-display. Nginx membedakan aplikasi kami lewat
nomor port, sedangkan meeting-room-display memakai
`server_name` di port 80:

| Alamat | Aplikasi |
|---|---|
| `192.168.221.44:8001` | **Presensi Non-ASN** (aplikasi ini) |
| `192.168.221.44:8002` | Admin Panel SisKA |
| `192.168.221.44:8003` | gajihub |
| `192.168.221.44` | meeting-room-display — **jangan diutak-atik**, bukan proyek kami |

Aplikasi internal ini belum punya nama domain, jadi pembedanya
nomor port nginx. Blok lama `server_name presensi.rokeubmn.id`
masih ada di konfigurasi server tetapi **nama itu tidak
ter-resolve di DNS mana pun** — sempat membuat aplikasi web
presensi tidak punya jalan masuk sama sekali.

Nomor port Node (5000 presensi, 3000 SisKA, 3002 gajihub)
diikat ke `127.0.0.1` sehingga tidak lagi bisa dijangkau
langsung dari jaringan. Port 3001 milik meeting-room-display
dibiarkan apa adanya.

**Menguji lewat port 80 akan mengenai aplikasi yang salah.**
Ini pernah membuat pemeriksaan awal salah kesimpulan — dikira
proxy `/api` rusak dan `/uploads` tidak menyajikan foto,
padahal yang terbaca adalah SPA milik meeting-room-display.
Selalu sertakan port 8001 saat menguji:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  http://192.168.221.44:8001/api/absensi/today/0000

curl -s http://192.168.221.44:8001/ | grep -o "<title>[^<]*</title>"
```

## Tata letak

```
~/apps/presensi-non-asn/
├─ presensi-biro-keuangan-dan-bmn-backend/    repo, dijalankan pm2
├─ presensi-biro-keuangan-dan-bmn-frontend/
│  └─ dist/                                   root nginx menunjuk ke sini
└─ foto/                                      UPLOAD_DIR, di luar kedua repo
```

`root` nginx menunjuk langsung ke `frontend/dist`, jadi **tidak
ada langkah menyalin berkas**. Build baru langsung tersaji.

## Deploy

```bash
# Backend
cd ~/apps/presensi-non-asn/presensi-biro-keuangan-dan-bmn-backend
git pull origin master
npm install
pm2 restart <nama-proses>

# Frontend
cd ../presensi-biro-keuangan-dan-bmn-frontend
git pull origin master
npm ci
npm run build
```

## Isi .env backend

Lihat `deploy/.env.example`. Yang wajib:

| Variabel | Catatan |
|---|---|
| `MONGODB_URI` | Backend berhenti kalau kosong |
| `PORT` | 5000, harus cocok dengan `proxy_pass` di nginx |
| `UPLOAD_DIR` | `/home/support/apps/presensi-non-asn/foto` — sengaja di luar repo |
| `PETUGAS_ABSENSI` | Nomor petugas rekap, dipisah koma. Kosong = tidak ada yang boleh |
| `PUBLIC_BASE_URL` | Alamat dasar tautan foto di berkas Excel |

## Struktur folder foto

```
foto/Nama_Pegawai/09-2026/2026-09-01_masuk.jpg
                          2026-09-01_pulang.jpg
```

Path lengkapnya tersimpan di setiap dokumen absensi, jadi
struktur ini tidak boleh diubah tanpa migrasi. Skripnya ada di
`scripts/migrasi-struktur-foto.js` (jalan tanpa argumen = uji
coba, `--apply` = sungguhan).

## Rekap dan export untuk petugas

| Endpoint | Guna |
|---|---|
| `GET /api/rekap/izin?pemohon=` | Cek apakah nomor itu petugas |
| `GET /api/rekap?dari=&sampai=&pemohon=` | Data rekap JSON |
| `GET /api/rekap/export?dari=&sampai=&pemohon=` | Berkas `.xlsx` dua lembar |

Dua filter opsional, berlaku untuk JSON maupun Excel:

* `pegawai=` nomor WhatsApp (format `08…` atau `62…`, sama saja)
* `jenis=` `WFO` / `WFH` / `DINAS` — kosong berarti semua

Nilai `jenis` yang tidak dikenali diperlakukan sebagai "semua",
bukan "tidak ada". Filter yang salah ketik tidak boleh
diam-diam mengosongkan rekap dan membuat petugas mengira tidak
ada yang absen.

Rekap memuat **semua** absensi di rentang itu, termasuk yang
baru absen masuk dan belum absen pulang. Itu disengaja —
petugas justru perlu melihat siapa yang lupa absen pulang.
Baris seperti itu ditandai kuning di kolom Jam Pulang, dan
jumlahnya muncul di lembar Ringkasan.

Dipakai bersama oleh halaman Rekap di aplikasi web dan menu 10
di bot SisKA. Butuh `npm install` karena ada dependensi baru
(`exceljs`).

### Batas pengamanannya

Perlu dinyatakan terang-terangan: nomor pemohon dikirim oleh
klien dan bisa dipalsukan siapa pun yang tahu nomor seorang
petugas. Pembatasan ini menutup akses tak sengaja oleh pegawai
biasa yang sudah login — bukan serangan yang disengaja.

Penyebabnya ada di `POST /api/login`: username dan password
sama-sama nomor telepon, tidak ada token maupun peran. Selama
itu belum diganti, jangan mengekspos port 5000 ke luar jaringan
kantor, dan perlakukan berkas rekap sebagai dokumen internal.

## Catatan lain

**Batas ukuran unggahan sudah benar.** Foto absensi dikirim
sebagai data URL base64: backend membatasi 10 MB per foto —
sekitar 13,4 MB setelah base64 — sedangkan `deploy/presensi.conf`
menetapkan `client_max_body_size 20m`. Default nginx hanya 1 MB
dan akan menolak dengan 413, jadi baris itu jangan dihapus.

**HTTPS belum ada.** Seluruh aplikasi di VPS ini dilayani lewat
HTTP biasa, termasuk halaman login dan berkas rekap. Sertifikat
Let's Encrypt tidak bisa dipakai untuk alamat IP privat. Kalau
suatu saat ada nama domain internal, barulah sertifikat internal
atau certbot masuk akal.

**CUPS terbuka.** Port 631 (layanan printer) mendengarkan di
`0.0.0.0` padahal ini server. Menutupnya:

```bash
sudo systemctl disable --now cups cups-browsed
```
