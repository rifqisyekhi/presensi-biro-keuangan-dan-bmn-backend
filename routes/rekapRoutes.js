// =========================================================
// REKAP ABSENSI UNTUK PETUGAS
// =========================================================
//
// Tiga endpoint, dipakai bersama oleh aplikasi web dan bot
// WhatsApp SisKA:
//
//   GET /api/rekap/izin?pemohon=628…            cek hak akses
//   GET /api/rekap?dari=&sampai=&pemohon=       data JSON
//   GET /api/rekap/export?dari=&sampai=&pemohon= berkas .xlsx
//
// HAK AKSES
//
// Login aplikasi memakai nomor telepon sebagai username
// sekaligus password, jadi setiap pegawai bisa masuk. Rekap
// membuka data SATU BIRO sekaligus — kehadiran, titik GPS,
// dan foto semua orang — sehingga tidak boleh ikut terbuka
// untuk semua yang bisa login.
//
// Karena itu endpoint di sini dibatasi ke daftar nomor
// petugas di PETUGAS_ABSENSI. Perlu jujur soal kekuatannya:
// nomor pemohon dikirim oleh klien dan bisa dipalsukan siapa
// pun yang tahu nomor seorang petugas. Ini menutup akses tak
// sengaja oleh pegawai biasa, bukan serangan yang disengaja.
// Perlindungan yang sebenarnya baru ada setelah login diganti
// dengan kata sandi dan token.

const express = require("express");

const router = express.Router();

const Absensi = require("../models/Absensi");
const Pegawai = require("../models/Pegawai");

const {
  normalizePhoneNumber,
  normalizeTanggal,
} = require("../utils/format");

// =========================================================
// KONFIGURASI
// =========================================================

// Alamat dasar untuk tautan foto di dalam berkas Excel.
// Tanpa ini kolom foto hanya berisi path relatif yang tidak
// bisa diklik dari Excel.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(
  /\/+$/,
  ""
);

// Rentang maksimal satu permintaan. Menjaga agar satu klik
// tidak menarik seluruh isi koleksi ke memori.
const MAX_HARI = 366;

const NAMA_HARI = [
  "Minggu",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
];

const LABEL_JENIS = {
  WFO: "WFO",
  WFH: "WFH (Dari Rumah)",
  DINAS: "Dinas Luar",
};

// =========================================================
// DAFTAR PETUGAS
// =========================================================

function daftarPetugas() {
  return String(process.env.PETUGAS_ABSENSI || "")
    .split(",")
    .map((s) => normalizePhoneNumber(s))
    .filter(Boolean);
}

function apakahPetugas(nomor) {
  const petugas = daftarPetugas();

  // Daftar kosong berarti belum ada yang ditunjuk. Menolak
  // semua orang jauh lebih aman daripada menganggapnya
  // "semua boleh" — salah tafsir seperti itu akan membuka
  // data satu biro tanpa ada yang menyadarinya.
  if (!petugas.length) return false;

  const pemohon = normalizePhoneNumber(nomor);

  if (!pemohon) return false;

  return petugas.includes(pemohon);
}

function tolakBukanPetugas(res) {
  return res.status(403).json({
    message:
      "Nomor Anda tidak terdaftar sebagai petugas rekap absensi.",
  });
}

// =========================================================
// RENTANG TANGGAL
// =========================================================

function bacaRentang(req) {
  const dari = normalizeTanggal(req.query.dari);
  const sampai = normalizeTanggal(req.query.sampai);

  if (!dari || !sampai) {
    return {
      error: "Parameter dari dan sampai wajib diisi (YYYY-MM-DD).",
    };
  }

  if (dari > sampai) {
    return {
      error: "Tanggal awal melebihi tanggal akhir.",
    };
  }

  const selisihHari =
    (Date.parse(`${sampai}T00:00:00Z`) -
      Date.parse(`${dari}T00:00:00Z`)) /
      86400000 +
    1;

  if (selisihHari > MAX_HARI) {
    return {
      error: `Rentang maksimal ${MAX_HARI} hari.`,
    };
  }

  return { dari, sampai };
}

// =========================================================
// FILTER
// =========================================================

// Kosong berarti "semua". Nilai yang tidak dikenali juga
// diperlakukan sebagai "semua" — filter yang salah ketik tidak
// boleh diam-diam mengosongkan rekap dan membuat petugas
// mengira tidak ada yang absen.

function bacaFilter(req) {
  const pegawai = normalizePhoneNumber(req.query.pegawai || "");

  const jenisMentah = String(req.query.jenis || "")
    .trim()
    .toUpperCase();

  const jenis = ["WFO", "WFH", "DINAS"].includes(jenisMentah)
    ? jenisMentah
    : "";

  return { pegawai, jenis };
}

function namaHari(tanggal) {
  const waktu = Date.parse(`${tanggal}T00:00:00Z`);

  if (Number.isNaN(waktu)) return "";

  return NAMA_HARI[new Date(waktu).getUTCDay()];
}

function koordinat(lokasi) {
  if (!lokasi || lokasi.lat == null || lokasi.lng == null) {
    return "";
  }

  return `${Number(lokasi.lat).toFixed(6)}, ${Number(lokasi.lng).toFixed(6)}`;
}

// Path foto dikembalikan apa adanya di JSON — aplikasi web
// disajikan dari origin yang sama dengan fotonya, jadi path
// relatif selalu benar tanpa perlu tahu alamat servernya.
//
// PUBLIC_BASE_URL hanya dipakai untuk berkas Excel, karena
// tautan di dalamnya dibuka dari luar browser dan wajib
// absolut. Memakainya juga untuk JSON pernah membuat tautan
// foto di halaman rekap menunjuk ke port 80 — yang di VPS ini
// milik aplikasi lain.
function tautanFotoAbsolut(path) {
  if (!path) return "";

  if (/^https?:\/\//i.test(path)) return path;

  return `${PUBLIC_BASE_URL}${path}`;
}

// =========================================================
// AMBIL DATA
// =========================================================

// Menggabungkan dokumen absensi dengan data pegawai. Dokumen
// absensi hanya menyimpan nama dan nomor, sedangkan petugas
// juga membutuhkan NIP, jabatan, dan unit kerja.

async function ambilRekap(dari, sampai, filter = {}) {
  const [absensi, pegawai] = await Promise.all([
    Absensi.find({
      tanggal: { $gte: dari, $lte: sampai },
    })
      .sort({ tanggal: 1, nama: 1 })
      .lean(),

    Pegawai.find({}).lean(),
  ]);

  const petaPegawai = new Map();

  for (const p of pegawai) {
    const kunci = normalizePhoneNumber(p.no_wa);

    if (kunci) petaPegawai.set(kunci, p);
  }

  const semua = absensi.map((a) => {
    const p = petaPegawai.get(normalizePhoneNumber(a.no_wa)) || {};

    return {
      tanggal: a.tanggal,
      hari: namaHari(a.tanggal),
      nama: a.nama || p.nama || "",
      nip: p.nip || "",
      no_wa: a.no_wa,
      jabatan: p.jabatan || "",
      sub_unit: p.sub_unit || "",
      kategori_pegawai: p.kategori_pegawai || "",
      jenis: LABEL_JENIS[a.attendanceType] || a.attendanceType || "",
      attendanceType: a.attendanceType || "",
      jamMasuk: a.clockIn || "",
      jamPulang: a.clockOut || "",
      kinerja: a.kinerja_harian || "",
      alamatMasuk: a.clockInAddress || a.clockInLocation?.address || "",
      koordinatMasuk: koordinat(a.clockInLocation),
      fotoMasuk: a.clockInPhoto || "",
      alamatPulang: a.clockOutAddress || a.clockOutLocation?.address || "",
      koordinatPulang: koordinat(a.clockOutLocation),
      fotoPulang: a.clockOutPhoto || "",
    };
  });

  // Daftar pegawai untuk isi dropdown disusun SEBELUM filter
  // nama diterapkan. Kalau disusun sesudahnya, begitu petugas
  // memilih satu nama, isi dropdown-nya menyusut jadi satu
  // orang dan dia tidak bisa berpindah ke nama lain.
  const petaNama = new Map();

  for (const b of semua) {
    if (b.no_wa && !petaNama.has(b.no_wa)) {
      petaNama.set(b.no_wa, b.nama || b.no_wa);
    }
  }

  const daftarPegawai = [...petaNama.entries()]
    .map(([no_wa, nama]) => ({ no_wa, nama }))
    .sort((a, b) => String(a.nama).localeCompare(String(b.nama), "id"));

  const data = semua.filter((b) => {
    if (filter.pegawai && normalizePhoneNumber(b.no_wa) !== filter.pegawai) {
      return false;
    }

    if (filter.jenis && b.attendanceType !== filter.jenis) {
      return false;
    }

    return true;
  });

  return { data, daftarPegawai };
}

// =========================================================
// CEK HAK AKSES
// =========================================================

// Dipakai antarmuka untuk memutuskan apakah menu rekap perlu
// ditampilkan. Bukan pengaman — pengamannya ada di setiap
// endpoint di bawah.

router.get("/izin", (req, res) => {
  return res.json({
    petugas: apakahPetugas(req.query.pemohon),
  });
});

// =========================================================
// REKAP JSON
// =========================================================

router.get("/", async (req, res) => {
  try {
    if (!apakahPetugas(req.query.pemohon)) {
      return tolakBukanPetugas(res);
    }

    const rentang = bacaRentang(req);

    if (rentang.error) {
      return res.status(400).json({ message: rentang.error });
    }

    const filter = bacaFilter(req);

    const { data, daftarPegawai } = await ambilRekap(
      rentang.dari,
      rentang.sampai,
      filter,
    );

    return res.json({
      dari: rentang.dari,
      sampai: rentang.sampai,
      filter,
      total: data.length,
      daftarPegawai,
      data,
    });
  } catch (error) {
    console.error("❌ Error rekap:", error);

    return res.status(500).json({
      message: "Gagal mengambil rekap absensi.",
      error: error.message,
    });
  }
});

// =========================================================
// EXPORT EXCEL
// =========================================================

const KOLOM = [
  { header: "Tanggal", key: "tanggal", width: 12 },
  { header: "Hari", key: "hari", width: 10 },
  { header: "Nama", key: "nama", width: 28 },
  { header: "NIP", key: "nip", width: 22 },
  { header: "No WhatsApp", key: "no_wa", width: 16 },
  { header: "Jabatan", key: "jabatan", width: 24 },
  { header: "Unit Kerja", key: "sub_unit", width: 22 },
  { header: "Kategori", key: "kategori_pegawai", width: 14 },
  { header: "Jenis Kehadiran", key: "jenis", width: 18 },
  { header: "Jam Masuk", key: "jamMasuk", width: 11 },
  { header: "Jam Pulang", key: "jamPulang", width: 11 },
  { header: "Kinerja Harian", key: "kinerja", width: 45 },
  { header: "Alamat Masuk", key: "alamatMasuk", width: 45 },
  { header: "Koordinat Masuk", key: "koordinatMasuk", width: 22 },
  { header: "Foto Masuk", key: "fotoMasuk", width: 16 },
  { header: "Alamat Pulang", key: "alamatPulang", width: 45 },
  { header: "Koordinat Pulang", key: "koordinatPulang", width: 22 },
  { header: "Foto Pulang", key: "fotoPulang", width: 16 },
];

function isiLembarRekap(sheet, data) {
  sheet.columns = KOLOM;

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const baris of data) {
    const row = sheet.addRow(baris);

    // Kolom foto ditulis sebagai tautan yang bisa diklik
    // langsung dari Excel, bukan URL panjang yang memenuhi
    // sel. Petugas memeriksa cap geotag lewat sini.
    for (const [kunci, label] of [
      ["fotoMasuk", "Lihat foto"],
      ["fotoPulang", "Lihat foto"],
    ]) {
      // Excel dibuka di luar browser, jadi tautannya harus
      // absolut lengkap dengan alamat server dan portnya.
      const nilai = tautanFotoAbsolut(baris[kunci]);

      if (!nilai) continue;

      const sel = row.getCell(kunci);

      sel.value = { text: label, hyperlink: nilai };
      sel.font = { color: { argb: "FF1D4ED8" }, underline: true };
    }

    // Absensi yang belum ada jam pulangnya ditandai supaya
    // langsung terlihat saat diperiksa.
    if (!baris.jamPulang) {
      row.getCell("jamPulang").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFDE68A" },
      };
    }
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: KOLOM.length },
  };
}

function isiLembarRingkasan(sheet, data) {
  sheet.columns = [
    { header: "Nama", key: "nama", width: 28 },
    { header: "NIP", key: "nip", width: 22 },
    { header: "Unit Kerja", key: "sub_unit", width: 22 },
    { header: "Jumlah Hari Absen", key: "total", width: 18 },
    { header: "WFO", key: "wfo", width: 8 },
    { header: "WFH", key: "wfh", width: 8 },
    { header: "Dinas Luar", key: "dinas", width: 12 },
    { header: "Belum Absen Pulang", key: "belumPulang", width: 20 },
  ];

  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const per = new Map();

  for (const baris of data) {
    const kunci = baris.no_wa || baris.nama;

    if (!per.has(kunci)) {
      per.set(kunci, {
        nama: baris.nama,
        nip: baris.nip,
        sub_unit: baris.sub_unit,
        total: 0,
        wfo: 0,
        wfh: 0,
        dinas: 0,
        belumPulang: 0,
      });
    }

    const r = per.get(kunci);

    r.total++;

    if (baris.attendanceType === "WFO") r.wfo++;
    if (baris.attendanceType === "WFH") r.wfh++;
    if (baris.attendanceType === "DINAS") r.dinas++;

    if (!baris.jamPulang) r.belumPulang++;
  }

  const urut = [...per.values()].sort((a, b) =>
    String(a.nama).localeCompare(String(b.nama), "id")
  );

  for (const r of urut) sheet.addRow(r);
}

router.get("/export", async (req, res) => {
  try {
    if (!apakahPetugas(req.query.pemohon)) {
      return tolakBukanPetugas(res);
    }

    const rentang = bacaRentang(req);

    if (rentang.error) {
      return res.status(400).json({ message: rentang.error });
    }

    const filter = bacaFilter(req);

    const { data } = await ambilRekap(
      rentang.dari,
      rentang.sampai,
      filter,
    );

    // exceljs baru dimuat di sini supaya kegagalan memuatnya
    // tidak ikut menjatuhkan endpoint absensi saat server
    // dinyalakan.
    const ExcelJS = require("exceljs");

    const workbook = new ExcelJS.Workbook();

    workbook.creator = "Presensi Non-ASN Biro Keuangan dan BMN";
    workbook.created = new Date();

    isiLembarRekap(workbook.addWorksheet("Rekap"), data);
    isiLembarRingkasan(workbook.addWorksheet("Ringkasan"), data);

    // Nama berkas ikut menyebut filternya, supaya beberapa
    // unduhan dengan rentang sama tidak jadi berkas kembar
    // yang tak terbedakan di folder Unduhan petugas.
    const penanda = [];

    if (filter.jenis) penanda.push(filter.jenis);

    if (filter.pegawai) {
      const orang = data[0]?.nama;

      penanda.push(
        (orang || filter.pegawai).replace(/[^A-Za-z0-9]+/g, "_"),
      );
    }

    const namaBerkas =
      `Rekap-Absensi-${rentang.dari}-sd-${rentang.sampai}` +
      `${penanda.length ? "-" + penanda.join("-") : ""}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${namaBerkas}"`
    );

    await workbook.xlsx.write(res);

    return res.end();
  } catch (error) {
    console.error("❌ Error export rekap:", error);

    // Header belum tentu sudah terkirim saat error terjadi.
    if (res.headersSent) return res.end();

    return res.status(500).json({
      message: "Gagal membuat berkas rekap.",
      error: error.message,
    });
  }
});

module.exports = router;
