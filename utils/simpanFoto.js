const fs = require("fs/promises");
const path = require("path");

// =========================================================
// PENYIMPANAN FOTO ABSENSI
// =========================================================

// Foto disimpan sebagai berkas di disk, bukan base64 di
// MongoDB. Struktur foldernya:
//
//   <UPLOAD_DIR>/08-2026/18/Nama_Pegawai/clock-in.jpg
//                 ^bulan  ^tgl ^pegawai   ^foto
//
// Folder dibuat otomatis saat foto pertama masuk, jadi tidak
// ada folder kosong untuk pegawai yang tidak absen.

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
  const [year, month, day] = String(tanggal).split("-");

  return {
    // 08-2026
    folderBulan: `${month}-${year}`,

    // 1 sampai 31, tanpa angka nol di depan
    folderTanggal: String(parseInt(day, 10)),
  };
}

// =========================================================
// SIMPAN SATU FOTO
// =========================================================

// Mengembalikan path publik (mis. "/uploads/08-2026/18/Budi/clock-in.jpg").
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

  const { folderBulan, folderTanggal } = pecahTanggal(tanggal);

  const folderPegawai =
    amankanNama(nama) ||
    amankanNama(no_wa) ||
    "tanpa-nama";

  const direktori = path.join(
    UPLOAD_DIR,
    folderBulan,
    folderTanggal,
    folderPegawai
  );

  await fs.mkdir(direktori, { recursive: true });

  // Satu pegawai hanya punya satu absensi per tanggal, jadi
  // nama berkasnya tetap dan tidak perlu penanda unik.
  const namaFile = `${jenis}.${ekstensi}`;

  await fs.writeFile(
    path.join(direktori, namaFile),
    buffer
  );

  return (
    `${PUBLIC_PATH}/${folderBulan}/` +
    `${folderTanggal}/${folderPegawai}/${namaFile}`
  );
}

module.exports = {
  UPLOAD_DIR,
  PUBLIC_PATH,
  simpanFotoAbsensi,
};
