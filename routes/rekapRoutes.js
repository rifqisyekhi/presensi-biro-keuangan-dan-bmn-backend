// =========================================================
// REKAP ABSENSI UNTUK PETUGAS
// =========================================================
//
// Tiga endpoint, dipakai bersama oleh aplikasi web dan bot
// WhatsApp SisKA:
//
//   GET    /api/rekap/izin?pemohon=628…            cek hak akses
//   GET    /api/rekap?dari=&sampai=&pemohon=       data JSON
//   GET    /api/rekap/export?dari=&sampai=&pemohon= berkas .xlsx
//   DELETE /api/rekap/:id?pemohon=628…             hapus 1 absensi
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
const mongoose = require("mongoose");

const router = express.Router();

const Absensi = require("../models/Absensi");
const Pegawai = require("../models/Pegawai");

const {
  normalizePhoneNumber,
  normalizeTanggal,
} = require("../utils/format");

const { hapusFotoAbsensi } = require("../utils/simpanFoto");

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
      // Dipakai halaman rekap untuk menghapus satu baris.
      // Pasangan no_wa+tanggal sebenarnya juga unik, tapi _id
      // tidak bisa salah tunjuk kalau kelak aturan itu berubah.
      id: String(a._id),

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
      lemburDisetujui: a.lembur?.disetujui === true,

      // Jabatan ikut diperiksa, bukan hanya penanda di dokumen
      // absensi: absensi yang dibuat SEBELUM fitur ini ada belum
      // punya penandanya, dan baris supir di bulan berjalan tetap
      // harus terbaca benar di rekap.
      bebasJamKerja:
        a.bebasJamKerja === true || jabatanBebasJamKerja(p.jabatan),
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
// HAPUS SATU ABSENSI
// =========================================================
//
// Ada untuk membersihkan sisa data pengujian dan salah absen
// yang tidak bisa diperbaiki pegawainya sendiri — satu orang
// hanya boleh punya satu absensi per tanggal, jadi baris yang
// salah menghalangi absensi yang benar di tanggal itu.
//
// SENGAJA SATU BARIS PER PERMINTAAN.
//
// Tidak ada "hapus semua yang tampil". Rekap dibuka dengan
// filter, dan filter yang salah pasang — rentang tanggal
// terlalu lebar, nama belum dipilih — akan menghapus sebulan
// kehadiran satu biro dalam satu klik. Penghapusannya permanen
// dan tidak ada cadangan di aplikasi ini, sementara sisa data
// pengujian jumlahnya sedikit. Kenyamanannya tidak sepadan.
//
// Setiap penghapusan dicatat ke log (terbaca lewat
// `pm2 logs presensi-backend`): siapa yang menghapus, milik
// siapa, dan tanggal berapa. Itu satu-satunya jejak yang
// tersisa sesudah dokumennya hilang.

router.delete("/:id", async (req, res) => {
  try {
    if (!apakahPetugas(req.query.pemohon)) {
      return tolakBukanPetugas(res);
    }

    const { id } = req.params;

    // Tanpa pemeriksaan ini, id yang bukan ObjectId membuat
    // Mongoose melempar CastError dan pesannya sampai ke
    // petugas sebagai "gagal" tanpa sebab yang jelas.
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "ID absensi tidak valid.",
      });
    }

    const baris = await Absensi.findById(id).lean();

    if (!baris) {
      return res.status(404).json({
        message:
          "Data absensi tidak ditemukan. Mungkin sudah dihapus " +
          "dari perangkat lain — coba tekan Tampilkan lagi.",
      });
    }

    await Absensi.deleteOne({ _id: baris._id });

    // Foto dihapus SESUDAH dokumennya, dan kegagalannya tidak
    // membatalkan apa pun: yang diminta petugas adalah barisnya
    // hilang dari rekap. Berkas yatim yang tertinggal hanya
    // memakan ruang disk, sedangkan membatalkan penghapusan
    // karena satu berkas gagal dibuang akan membuat baris
    // pengujian mustahil dibersihkan.
    let fotoTerhapus = 0;

    for (const foto of [baris.clockInPhoto, baris.clockOutPhoto]) {
      try {
        if (await hapusFotoAbsensi(foto)) fotoTerhapus++;
      } catch (error) {
        console.error(
          `⚠️ Gagal menghapus foto ${foto}:`,
          error.message
        );
      }
    }

    console.warn(
      `🗑️ [HAPUS ABSENSI] petugas ${normalizePhoneNumber(req.query.pemohon)} ` +
        `menghapus ${baris.tanggal} milik ${baris.nama || "-"} ` +
        `(${baris.no_wa}) — masuk ${baris.clockIn || "-"}, ` +
        `pulang ${baris.clockOut || "-"}, ${fotoTerhapus} foto ikut dihapus.`
    );

    return res.json({
      message: `Absensi ${baris.nama || baris.no_wa} tanggal ${baris.tanggal} dihapus.`,
      terhapus: {
        id: String(baris._id),
        nama: baris.nama || "",
        no_wa: baris.no_wa,
        tanggal: baris.tanggal,
        foto: fotoTerhapus,
      },
    });
  } catch (error) {
    console.error("❌ Error hapus absensi:", error);

    return res.status(500).json({
      message: "Gagal menghapus data absensi.",
      error: error.message,
    });
  }
});

// =========================================================
// EXPORT EXCEL
// =========================================================

// =========================================================
// PERHITUNGAN JAM KERJA
// =========================================================

// Dipindah ke utils/jamKerja.js supaya aturan yang sama juga
// bisa dipakai endpoint /today — pesan pengingat jam pulang di
// bot WhatsApp harus memberi angka yang persis sama dengan
// kolom "Jam Harus Checkout" di berkas rekap.

const {
  hitungJamKerja,
  menitDariJam,
  jabatanBebasJamKerja,
} = require("../utils/jamKerja");
// =========================================================
// SUSUNAN KOLOM
// =========================================================
//
// Mengikuti templat "Rekap Presensi Pegawai Biro Keuangan dan
// BMN", dengan tiga perbedaan yang disengaja:
//
//   - Kolom potongan dan lembur dibuang: non-ASN tidak dikenai
//     potongan, dan data lembur ada di koleksi lain.
//   - Kolom Kinerja Harian, Lokasi, dan tautan Foto ditambahkan
//     — foto bercap geotag itulah yang diperiksa petugas, dan
//     templat lembur ASN tidak punya tempat untuknya.
//   - Keterangan Cuti disediakan tapi masih kosong, menunggu
//     fitur cutinya dibuat.

const KOLOM = [
  { header: "No", key: "no", width: 5 },
  { header: "Nama Pegawai", key: "nama", width: 33 },
  { header: "NIP / NIK", key: "nip", width: 20 },
  { header: "Tanggal", key: "tanggal", width: 12 },
  { header: "Hari", key: "hari", width: 9 },
  { header: "Status", key: "jenis", width: 16 },
  { header: "Keterangan Cuti", key: "keteranganCuti", width: 19 },
  { header: "Checkin", key: "jamMasuk", waktu: true, width: 9 },
  { header: "Checkout", key: "jamPulang", waktu: true, width: 9 },
  { header: "Jam Harus Checkout", key: "jamHarusCheckout", waktu: true, width: 11 },
  { header: "Jam Masuk", key: "jamMasukJadwal", waktu: true, width: 11 },
  { header: "Jam Toleransi Masuk", key: "jamToleransiMasuk", waktu: true, width: 11 },
  { header: "Jam Pulang", key: "jamPulangJadwal", waktu: true, width: 11 },
  { header: "Jam Toleransi Pulang", key: "jamToleransiPulang", waktu: true, width: 11 },
  { header: "Terlambat (menit)", key: "terlambat", width: 11 },
  { header: "Menit Kerja", key: "menitKerja", width: 11 },
  { header: "Durasi Lembur", key: "durasiLembur", waktu: true, width: 11 },
  { header: "Pembulatan Lembur", key: "pembulatanLembur", waktu: true, width: 11 },
  { header: "Kinerja Harian", key: "kinerja", width: 45 },
  { header: "Lokasi Masuk", key: "alamatMasuk", width: 45 },
  { header: "Foto Masuk", key: "fotoMasuk", width: 14 },
  { header: "Foto Pulang", key: "fotoPulang", width: 14 },
];

const NAMA_BULAN = [
  "JANUARI",
  "FEBRUARI",
  "MARET",
  "APRIL",
  "MEI",
  "JUNI",
  "JULI",
  "AGUSTUS",
  "SEPTEMBER",
  "OKTOBER",
  "NOVEMBER",
  "DESEMBER",
];

// Judul menyebut bulan hanya kalau rentangnya memang persis
// satu bulan penuh. Berkas contoh menuliskan "BULAN JANUARI"
// di semua sheet termasuk Agustus — kekeliruan yang tidak
// perlu ditiru.
function judulPeriode(dari, sampai) {
  const [tahun, bulan] = dari.split("-");

  const hariTerakhir = new Date(
    Date.UTC(Number(tahun), Number(bulan), 0),
  ).getUTCDate();

  const sebulanPenuh =
    dari === `${tahun}-${bulan}-01` &&
    sampai === `${tahun}-${bulan}-${String(hariTerakhir).padStart(2, "0")}`;

  return sebulanPenuh
    ? `BULAN ${NAMA_BULAN[Number(bulan) - 1]} ${tahun}`
    : `PERIODE ${dari} s.d. ${sampai}`;
}

function isiLembarRekap(sheet, data, dari, sampai) {
  sheet.columns = KOLOM;

  // -------------------------------------------------------
  // JUDUL
  // -------------------------------------------------------

  const kolomTerakhir = String.fromCharCode(64 + KOLOM.length);

  sheet.mergeCells(`A1:${kolomTerakhir}1`);
  sheet.mergeCells(`A2:${kolomTerakhir}2`);

  sheet.getCell("A1").value =
    `REKAPITULASI PRESENSI NON-ASN ${judulPeriode(dari, sampai)}`;
  sheet.getCell("A2").value = "BIRO KEUANGAN DAN BMN";

  for (const sel of ["A1", "A2"]) {
    sheet.getCell(sel).font = { bold: true, size: sel === "A1" ? 13 : 11 };
    sheet.getCell(sel).alignment = { horizontal: "center" };
  }

  // Baris 3 sengaja dikosongkan, mengikuti templat.
  sheet.getRow(3).height = 8;

  // -------------------------------------------------------
  // KEPALA TABEL
  // -------------------------------------------------------

  const kepala = sheet.getRow(4);

  kepala.values = KOLOM.map((k) => k.header);
  kepala.font = { bold: true };
  kepala.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  kepala.height = 32;

  for (let c = 1; c <= KOLOM.length; c++) {
    kepala.getCell(c).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE2E8F0" },
    };

    kepala.getCell(c).border = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    };
  }

  sheet.views = [{ state: "frozen", ySplit: 4 }];

  // Kolom jam ditulis sebagai nilai waktu Excel, bukan teks.
  // Kalau ditulis sebagai teks, Excel menandainya dengan
  // segitiga hijau "angka disimpan sebagai teks" dan jamnya
  // tidak bisa diurutkan atau dihitung.
  for (const kolom of KOLOM) {
    if (kolom.waktu) sheet.getColumn(kolom.key).numFmt = "hh:mm";
  }

  // -------------------------------------------------------
  // ISI
  // -------------------------------------------------------

  let urut = 0;

  for (const baris of data) {
    urut++;

    const isi = {
      ...baris,
      no: urut,
      keteranganCuti: "",
      ...hitungJamKerja(baris),
    };

    // Excel menyimpan jam sebagai pecahan satu hari:
    // 11:53 = 713 menit / 1440 = 0,4951.
    for (const kolom of KOLOM) {
      if (!kolom.waktu) continue;

      const menit = menitDariJam(isi[kolom.key]);

      isi[kolom.key] = menit === null ? null : menit / 1440;
    }

    const row = sheet.addRow(isi);

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

  // Autofilter dipasang di baris kepala tabel (baris 4),
  // bukan baris 1 yang kini berisi judul.
  sheet.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: 4, column: KOLOM.length },
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

    isiLembarRekap(
      workbook.addWorksheet("Rekap"),
      data,
      rentang.dari,
      rentang.sampai,
    );
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
