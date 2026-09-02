const fs = require("fs/promises");
const path = require("path");

// =========================================================
// PENYIMPANAN FOTO ABSENSI
// =========================================================

// Foto disimpan sebagai berkas di disk, bukan base64 di
// MongoDB. Struktur foldernya:
//
//   <UPLOAD_DIR>/Nama_Pegawai/08-2026/2026-08-18_masuk.jpg
//                 ^pegawai     ^bulan  ^tanggal    ^jenis
//
// Satu folder per pegawai, di dalamnya satu folder per bulan.
// Nama berkas memakai tanggal YYYY-MM-DD supaya isi folder
// urut secara kronologis saat diurutkan berdasarkan nama, dan
// tetap terbaca jelas ketika satu foto diunduh terpisah dari
// foldernya.
//
// Folder dibuat otomatis saat foto pertama masuk, jadi tidak
// ada folder kosong untuk pegawai yang tidak absen.
//
// CATATAN MIGRASI: struktur lama adalah
// <UPLOAD_DIR>/08-2026/18/Nama_Pegawai/clock-in.jpg. Path
// lengkap setiap foto tersimpan di dokumen absensi, jadi foto
// lama tetap bisa dibuka selama berkasnya tidak dihapus —
// yang berubah hanya foto yang masuk setelah ini.

const UPLOAD_DIR =
  process.env.UPLOAD_DIR ||
  path.join(__dirname, "..", "uploads");

// Prefix URL yang disajikan express.static di index.js.
const PUBLIC_PATH = "/uploads";

const MAX_UKURAN_FOTO = 10 * 1024 * 1024;

const EKSTENSI_DIIZINKAN = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
};

// =========================================================
// NAMA FOLDER YANG AMAN
// =========================================================

// Nama pegawai berasal dari database, tapi tetap dibersihkan:
// karakter path (/ \ ..) tidak boleh lolos ke nama folder, dan
// hasilnya harus aman dipakai langsung di URL.

function amankanNama(value) {
  const bersih = String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .slice(0, 80);

  return bersih;
}

function pecahTanggal(tanggal) {
  const [year, month] = String(tanggal).split("-");

  return {
    // 08-2026
    folderBulan: `${month}-${year}`,
  };
}

// Nama jenis foto yang dipakai di nama berkas. Petugas yang
// memeriksa foto membaca "masuk"/"pulang", bukan istilah
// teknis yang dipakai di kode dan database.
const LABEL_JENIS_FILE = {
  "clock-in": "masuk",
  "clock-out": "pulang",
};

// =========================================================
// SIMPAN SATU FOTO
// =========================================================

// Mengembalikan path publik
// (mis. "/uploads/Budi/08-2026/2026-08-18_masuk.jpg").
// Kalau nilainya bukan data URL — misalnya sudah berupa path
// dari penyimpanan sebelumnya, atau kosong — dikembalikan apa
// adanya tanpa menulis berkas apa pun.

async function simpanFotoAbsensi({
  dataUrl,
  tanggal,
  nama,
  no_wa,
  jenis,
}) {
  if (typeof dataUrl !== "string" || !dataUrl) {
    return null;
  }

  if (!dataUrl.startsWith("data:")) {
    return dataUrl;
  }

  // Tanggal ikut menyusun nama berkas, jadi bentuknya
  // dipastikan di sini juga — jangan bergantung pada pemanggil
  // untuk memvalidasinya.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tanggal))) {
    throw new Error("Format tanggal absensi tidak valid.");
  }

  const cocok = /^data:([\w/+.-]+);base64,(.*)$/s.exec(dataUrl);

  if (!cocok) {
    throw new Error("Format foto tidak dikenali.");
  }

  const mime = cocok[1].toLowerCase();

  const ekstensi = EKSTENSI_DIIZINKAN[mime];

  if (!ekstensi) {
    throw new Error("Foto harus berformat JPEG atau PNG.");
  }

  const buffer = Buffer.from(cocok[2], "base64");

  if (!buffer.length) {
    throw new Error("Data foto kosong.");
  }

  if (buffer.length > MAX_UKURAN_FOTO) {
    throw new Error(
      "Ukuran foto melebihi batas 10 MB."
    );
  }

  const { folderBulan } = pecahTanggal(tanggal);

  const folderPegawai =
    amankanNama(nama) ||
    amankanNama(no_wa) ||
    "tanpa-nama";

  const direktori = path.join(
    UPLOAD_DIR,
    folderPegawai,
    folderBulan
  );

  await fs.mkdir(direktori, { recursive: true });

  // Satu pegawai hanya punya satu absensi per tanggal, jadi
  // nama berkasnya tetap dan tidak perlu penanda unik. Absen
  // ulang di tanggal yang sama menimpa berkas lamanya, bukan
  // menumpuk berkas baru.
  const labelJenis = LABEL_JENIS_FILE[jenis] || amankanNama(jenis);

  const namaFile = `${tanggal}_${labelJenis}.${ekstensi}`;

  await fs.writeFile(
    path.join(direktori, namaFile),
    buffer
  );

  return (
    `${PUBLIC_PATH}/${folderPegawai}/` +
    `${folderBulan}/${namaFile}`
  );
}

module.exports = {
  UPLOAD_DIR,
  PUBLIC_PATH,
  simpanFotoAbsensi,
};
