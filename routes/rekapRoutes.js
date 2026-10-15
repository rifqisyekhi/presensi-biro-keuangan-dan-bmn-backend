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
//   PATCH  /api/rekap/:id/status?pemohon=628…      ubah jenis kehadiran
//   PATCH  /api/rekap/:id/jam?pemohon=628…         ubah jam masuk/pulang
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
  getToday,
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
  WFH: "WFH",
  DINAS: "Dinas Luar",
  CUTI: "Cuti",
  IZIN: "Izin",
  ALPHA: "Alpha",
};

// Sengaja diturunkan dari LABEL_JENIS, bukan ditulis ulang:
// dua daftar yang harus selalu sama isinya pasti berbeda pada
// suatu hari.
const JENIS_SAH = Object.keys(LABEL_JENIS);

// =========================================================
// PERUBAHAN STATUS
// =========================================================

// Perubahan paling akhir, dalam bentuk yang siap ditampilkan.
// Yang lebih lama tetap tersimpan di dokumennya; yang
// ditanyakan orang saat membaca rekap praktis selalu yang
// terakhir — "kenapa baris ini sekarang tertulis begini".
function perubahanTerakhir(riwayat) {
  if (!Array.isArray(riwayat) || !riwayat.length) return null;

  const akhir = riwayat[riwayat.length - 1];

  return {
    dari: String(akhir.dari || ""),
    dariLabel: LABEL_JENIS[akhir.dari] || akhir.dari || "",
    ke: String(akhir.ke || ""),
    oleh: String(akhir.oleh || ""),
    alasan: String(akhir.alasan || ""),
    pada: akhir.pada ? new Date(akhir.pada).toISOString() : "",
    jumlah: riwayat.length,
  };
}

// =========================================================
// JAM
// =========================================================

// Mengembalikan jam dalam bentuk baku "HH.MM", atau null kalau
// tidak masuk akal sebagai jam.
//
// menitDariJam() sengaja tidak dipakai sendirian: ia menerima
// "99.99" dan menjawab 6039 menit tanpa mengeluh. Yang dibaca
// petugas adalah kotak teks bebas, jadi rentangnya harus
// diperiksa di sini.
function jamBaku(nilai) {
  const teks = String(nilai ?? "").trim();

  if (!teks) return null;

  const cocok = /^(\d{1,2})[.:](\d{2})$/.exec(teks);

  if (!cocok) return null;

  const jam = Number(cocok[1]);
  const menit = Number(cocok[2]);

  if (jam > 23 || menit > 59) return null;

  return jamDariMenit(jam * 60 + menit);
}

// Perubahan jam paling akhir, siap ditampilkan.
function perubahanJamTerakhir(riwayat) {
  if (!Array.isArray(riwayat) || !riwayat.length) return null;

  const akhir = riwayat[riwayat.length - 1];

  return {
    dariMasuk: String(akhir.dariMasuk || ""),
    keMasuk: String(akhir.keMasuk || ""),
    dariPulang: String(akhir.dariPulang || ""),
    kePulang: String(akhir.kePulang || ""),
    oleh: String(akhir.oleh || ""),
    alasan: String(akhir.alasan || ""),
    pada: akhir.pada ? new Date(akhir.pada).toISOString() : "",
    jumlah: riwayat.length,
  };
}

// Versi satu sel untuk Excel. Hanya medan yang benar-benar
// berubah yang disebut — menuliskan keduanya setiap kali membuat
// selnya panjang dan yang penting jadi tenggelam.
function ringkasPerubahanJam(p) {
  if (!p) return "";

  const waktu = p.pada
    ? new Date(p.pada).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        dateStyle: "short",
        timeStyle: "short",
      })
    : "";

  const bagian = [];

  const tampil = (v) => v || "(kosong)";

  if (p.dariMasuk !== p.keMasuk) {
    bagian.push(`masuk ${tampil(p.dariMasuk)} → ${tampil(p.keMasuk)}`);
  }

  if (p.dariPulang !== p.kePulang) {
    bagian.push(`pulang ${tampil(p.dariPulang)} → ${tampil(p.kePulang)}`);
  }

  return (
    bagian.join(", ") +
    (p.oleh ? ` oleh ${p.oleh}` : "") +
    (waktu ? `, ${waktu}` : "") +
    (p.alasan ? ` — ${p.alasan}` : "") +
    (p.jumlah > 1 ? ` (${p.jumlah}x diubah)` : "")
  );
}

// Versi satu sel untuk Excel. Berkas itulah yang dikirim ke
// pimpinan, jadi status yang pernah dibetulkan harus terbaca
// di sana juga — bukan cuma di layar petugas.
//
// Zona waktu dikunci ke WIB: servernya boleh berjalan di UTC,
// tapi yang membaca berkasnya duduk di Jakarta.
function ringkasPerubahan(p) {
  if (!p) return "";

  const waktu = p.pada
    ? new Date(p.pada).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        dateStyle: "short",
        timeStyle: "short",
      })
    : "";

  return (
    `Dari ${p.dariLabel || p.dari}` +
    (p.oleh ? ` oleh ${p.oleh}` : "") +
    (waktu ? `, ${waktu}` : "") +
    (p.alasan ? ` — ${p.alasan}` : "") +
    (p.jumlah > 1 ? ` (${p.jumlah}x diubah)` : "")
  );
}

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

  const jenis = JENIS_SAH.includes(jenisMentah) || jenisMentah === "HADIR"
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

// Mengembalikan daftar tanggal "YYYY-MM-DD" antara tglAwal dan tglAkhir (inklusif)
function daftarTanggalAntara(tglAwal, tglAkhir) {
  const hasil = [];
  const [y1, m1, d1] = String(tglAwal).split("-").map(Number);
  const [y2, m2, d2] = String(tglAkhir).split("-").map(Number);
  if (!y1 || !m1 || !d1 || !y2 || !m2 || !d2) return [tglAwal];

  const cur = new Date(Date.UTC(y1, m1 - 1, d1));
  const akhir = new Date(Date.UTC(y2, m2 - 1, d2));

  while (cur <= akhir) {
    hasil.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return hasil;
}

// Menggabungkan dokumen absensi dengan data pegawai. Dokumen
// absensi hanya menyimpan nama dan nomor, sedangkan petugas
// juga membutuhkan NIP, jabatan, dan unit kerja.
//
// Pegawai Non-ASN yang tidak melakukan absen pada hari kerja
// (Senin–Jumat) tetap dimunculkan di rekap dengan keterangan "Alpha".

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

  // Identifikasi seluruh pegawai Non-ASN aktif (mis. PPNPN / bukan ASN)
  const kategoriAsn = (
    process.env.PRESENSI_KATEGORI_ASN || "Internal,ASN,PNS,PPPK"
  )
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const pegawaiNonASN = pegawai.filter((p) => {
    const norm = normalizePhoneNumber(p.no_wa);
    if (!norm) return false;
    const kat = String(p.kategori_pegawai || "").trim().toLowerCase();
    return !kat || !kategoriAsn.includes(kat);
  });

  // Catat kombinasi nomor + tanggal yang sudah memiliki dokumen absensi
  const sudahAdaMap = new Set();
  for (const a of absensi) {
    const norm = normalizePhoneNumber(a.no_wa);
    if (norm && a.tanggal) {
      sudahAdaMap.add(`${norm}_${a.tanggal}`);
    }
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

      // null selama statusnya belum pernah dibetulkan petugas —
      // dan itu keadaan normal untuk hampir semua baris.
      perubahanStatus: perubahanTerakhir(a.riwayatStatus),
      perubahanJam: perubahanJamTerakhir(a.riwayatJam),
      jamMasuk: a.clockIn || "",
      jamPulang: a.clockOut || "",
      lemburDisetujui: a.lembur?.disetujui === true,

      // Jabatan ikut diperiksa, bukan hanya penanda di dokumen
      // absensi: absensi yang dibuat SEBELUM fitur ini ada belum
      // punya penandanya, dan baris supir di bulan berjalan tetap
      // harus terbaca benar di rekap.
      bebasJamKerja:
        a.bebasJamKerja === true || jabatanBebasJamKerja(p.jabatan),

      // Sama alasannya: absensi petugas kebersihan yang dibuat
      // sebelum aturan ini ada belum punya penandanya, tapi
      // lemburnya tetap harus terhitung di rekap bulan berjalan.
      lemburOtomatis:
        a.lemburOtomatis === true || jabatanLemburOtomatis(p.jabatan),
      kinerja: a.kinerja_harian || "",
      kinerjaLembur: a.kinerja_lembur || "",
      alamatMasuk: a.clockInAddress || a.clockInLocation?.address || "",
      koordinatMasuk: koordinat(a.clockInLocation),
      fotoMasuk: a.clockInPhoto || "",
      alamatPulang: a.clockOutAddress || a.clockOutLocation?.address || "",
      koordinatPulang: koordinat(a.clockOutLocation),
      fotoPulang: a.clockOutPhoto || "",
    };
  });

  // Tambahkan baris "Alpha" untuk pegawai Non-ASN yang belum/tidak absen pada hari kerja
  const hariIni = getToday();
  const semuaTanggal = daftarTanggalAntara(dari, sampai);

  for (const tgl of semuaTanggal) {
    // Jangan buat Alpha untuk hari di masa depan
    if (tgl > hariIni) continue;

    // Hari Sabtu dan Minggu bukan hari kerja kantor (tidak ada kewajiban absen)
    const dayOfWeek = new Date(`${tgl}T00:00:00Z`).getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    for (const p of pegawaiNonASN) {
      const norm = normalizePhoneNumber(p.no_wa);
      if (!norm) continue;

      const kunci = `${norm}_${tgl}`;
      if (!sudahAdaMap.has(kunci)) {
        semua.push({
          id: `alpha_${norm}_${tgl}`,
          isVirtual: true,
          tanggal: tgl,
          hari: namaHari(tgl),
          nama: p.nama || norm,
          nip: p.nip || "",
          no_wa: p.no_wa || norm,
          jabatan: p.jabatan || "",
          sub_unit: p.sub_unit || "",
          kategori_pegawai: p.kategori_pegawai || "",
          jenis: "Alpha",
          attendanceType: "ALPHA",
          perubahanStatus: null,
          perubahanJam: null,
          jamMasuk: "-",
          jamPulang: "-",
          lemburDisetujui: false,
          bebasJamKerja: jabatanBebasJamKerja(p.jabatan),
          lemburOtomatis: jabatanLemburOtomatis(p.jabatan),
          kinerja: "-",
          kinerjaLembur: "",
          alamatMasuk: "-",
          koordinatMasuk: "",
          fotoMasuk: "",
          alamatPulang: "-",
          koordinatPulang: "",
          fotoPulang: "",
        });
      }
    }
  }

  // Urutkan berdasarkan tanggal lalu nama pegawai
  semua.sort((a, b) => {
    const tglCmp = a.tanggal.localeCompare(b.tanggal);
    if (tglCmp !== 0) return tglCmp;
    return String(a.nama || "").localeCompare(String(b.nama || ""), "id");
  });

  // Daftar pegawai untuk isi dropdown disusun dari seluruh pegawai Non-ASN dan yang ada di rekap
  const petaNama = new Map();

  for (const p of pegawaiNonASN) {
    const norm = normalizePhoneNumber(p.no_wa);
    if (norm && !petaNama.has(norm)) {
      petaNama.set(norm, p.nama || norm);
    }
  }

  for (const b of semua) {
    const norm = normalizePhoneNumber(b.no_wa);
    if (norm && !petaNama.has(norm)) {
      petaNama.set(norm, b.nama || norm);
    }
  }

  const daftarPegawai = [...petaNama.entries()]
    .map(([no_wa, nama]) => ({ no_wa, nama }))
    .sort((a, b) => String(a.nama).localeCompare(String(b.nama), "id"));

  const data = semua.filter((b) => {
    if (filter.pegawai && normalizePhoneNumber(b.no_wa) !== filter.pegawai) {
      return false;
    }

    if (filter.jenis) {
      if (filter.jenis === "HADIR") {
        if (!["WFO", "WFH", "DINAS"].includes(b.attendanceType)) return false;
      } else if (filter.jenis === "CUTI") {
        if (!["CUTI", "IZIN"].includes(b.attendanceType)) return false;
      } else if (b.attendanceType !== filter.jenis) {
        return false;
      }
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
    const { id } = req.params;

    if (!apakahPetugas(req.query.pemohon)) {
      return tolakBukanPetugas(res);
    }

    if (id.startsWith("alpha_")) {
      return res.status(400).json({
        message: "Baris Alpha otomatis tidak dapat dihapus. Silakan gunakan tombol Ubah Status jika pegawai berstatus Cuti/Izin atau Hadir.",
      });
    }

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
// UBAH JENIS KEHADIRAN
// =========================================================
//
// Jenis kehadiran dipilih pegawai saat absen masuk, padahal
// harinya belum tentu berjalan seperti yang direncanakan:
// berangkat WFO, lalu ditugaskan dinas luar sesudah makan
// siang. Pegawainya tidak bisa membetulkan sendiri — satu
// orang hanya boleh punya satu absensi per tanggal, dan jatah
// hari itu sudah terpakai oleh absen masuk paginya.
//
// YANG IKUT BERUBAH
//
// Status bukan sekadar label. hitungJamKerja() membacanya:
// begitu menjadi DINAS, kolom Jam Harus Checkout, Terlambat,
// Menit Kerja, Durasi Lembur, dan Pembulatan Lembur ikut
// dikosongkan — aturan jam kantor tidak berlaku di tempat
// tugas. Sebaliknya, DINAS yang dikembalikan ke WFO membuat
// kelimanya terisi lagi, termasuk keterlambatan yang tadinya
// tidak muncul.
//
// Perhitungan itu dilakukan saat rekap DIBACA, bukan saat
// disimpan, jadi satu penyimpanan di sini langsung mengubah
// tampilan layar sekaligus isi berkas Excel. Tidak ada yang
// perlu dihitung ulang di endpoint ini.
//
// YANG TIDAK DISENTUH
//
// Jam masuk, jam pulang, foto, titik GPS, dan kinerja harian
// tetap apa adanya. Itu catatan tentang apa yang benar-benar
// terjadi pagi tadi, dan tetap benar meski labelnya dikoreksi.
//
// JEJAK
//
// Setiap perubahan DITAMBAHKAN ke riwayatStatus — bukan
// menimpa yang sebelumnya — dan ikut dicetak ke log. Status
// adalah dasar perhitungan jam kerja; kalau bisa diubah tanpa
// jejak, tidak ada cara menjawab "kenapa baris ini berubah"
// enam bulan lagi.

router.patch("/:id/status", async (req, res) => {
  try {
    if (!apakahPetugas(req.query.pemohon)) {
      return tolakBukanPetugas(res);
    }

    const { id } = req.params;
    const diminta = String(req.body?.attendanceType || "")
      .trim()
      .toUpperCase();

    if (!JENIS_SAH.includes(diminta)) {
      return res.status(400).json({
        message: `Jenis kehadiran tidak dikenali. Pilih salah satu: ${JENIS_SAH.join(", ")}.`,
      });
    }

    // Dipotong, bukan ditolak, kalau kepanjangan. Petugas
    // sedang membetulkan data; menggagalkan penyimpanan karena
    // catatannya dua baris kelewat panjang hanya menghambat
    // tanpa melindungi apa pun.
    const alasan = String(req.body?.alasan || "")
      .trim()
      .slice(0, 300);

    const petugas = normalizePhoneNumber(req.query.pemohon);

    let baris;
    let lama = "ALPHA";

    // Jika baris yang diubah adalah baris Alpha virtual (belum ada dokumen di database)
    if (id.startsWith("alpha_")) {
      const parts = id.split("_");
      const nomor = parts[1];
      const tanggal = parts[2];

      const p = await Pegawai.findOne({
        $or: [
          { no_wa: nomor },
          { no_wa: nomor.startsWith("62") ? `0${nomor.slice(2)}` : nomor },
        ],
      }).lean();

      baris = new Absensi({
        no_wa: nomor,
        nama: p?.nama || "",
        tanggal,
        attendanceType: diminta,
        riwayatStatus: [
          {
            dari: "ALPHA",
            ke: diminta,
            oleh: petugas,
            alasan,
            pada: new Date(),
          },
        ],
      });

      await baris.save();
    } else {
      // Tanpa pemeriksaan ini, id yang bukan ObjectId membuat
      // Mongoose melempar CastError dan pesannya sampai ke
      // petugas sebagai "gagal" tanpa sebab yang jelas.
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          message: "ID absensi tidak valid.",
        });
      }

      baris = await Absensi.findById(id);

      if (!baris) {
        return res.status(404).json({
          message:
            "Data absensi tidak ditemukan. Mungkin sudah dihapus " +
            "dari perangkat lain — coba tekan Tampilkan lagi.",
        });
      }

      lama = String(baris.attendanceType || "").toUpperCase();

      if (lama === diminta) {
        return res.status(400).json({
          message: `Absensi ini memang sudah berstatus ${
            LABEL_JENIS[diminta] || diminta
          }.`,
        });
      }

      baris.attendanceType = diminta;

      baris.riwayatStatus.push({
        dari: lama,
        ke: diminta,
        oleh: petugas,
        alasan,
        pada: new Date(),
      });

      await baris.save();
    }

    console.warn(
      `✏️ [UBAH STATUS] petugas ${petugas} mengubah ${baris.tanggal} ` +
        `milik ${baris.nama || "-"} (${baris.no_wa}) ` +
        `dari ${lama || "-"} menjadi ${diminta}` +
        (alasan ? ` — ${alasan}` : " — tanpa catatan"),
    );

    return res.json({
      message:
        `Status ${baris.nama || baris.no_wa} tanggal ${baris.tanggal} ` +
        `diubah menjadi ${LABEL_JENIS[diminta] || diminta}.`,

      // Dikembalikan lengkap supaya halaman rekap bisa
      // memperbarui satu kartu saja, tanpa memuat ulang seluruh
      // rentang dan melempar posisi gulir petugas kembali ke
      // atas setiap kali.
      absensi: {
        id: String(baris._id),
        attendanceType: diminta,
        jenis: LABEL_JENIS[diminta] || diminta,
        perubahanStatus: perubahanTerakhir(baris.riwayatStatus),
      },
    });
  } catch (error) {
    console.error("❌ Error ubah status absensi:", error);

    return res.status(500).json({
      message: "Gagal mengubah status absensi.",
      error: error.message,
    });
  }
});

// =========================================================
// UBAH JAM MASUK DAN JAM PULANG
// =========================================================
//
// Absensi yang gagal di tengah jalan membuat pegawai rugi, dan
// ruginya tidak kelihatan sebagai kesalahan siapa pun: fotonya
// berkali-kali gagal diunggah sampai jam masuknya tercatat
// terlambat, atau bot mentok sebelum absen pulang sehingga
// kolomnya kosong — padahal orangnya hadir sampai sore. Karena
// tidak semua orang absen lewat cadangan, kerugian itu menempel
// di rekap yang dipakai menilai kinerjanya.
//
// Pegawainya tidak bisa membetulkan sendiri: satu orang hanya
// boleh punya satu absensi per tanggal, dan jatah hari itu sudah
// terpakai.
//
// YANG IKUT BERUBAH
//
// Jam adalah dasar SEMUA hitungan di rekap, jadi dampaknya lebih
// luas daripada mengubah jenis kehadiran:
//
//   jam masuk   → Terlambat, Jam Harus Checkout, Menit Kerja,
//                 dan lewat Jam Harus Checkout juga Lembur
//   jam pulang  → Menit Kerja, Durasi Lembur, Pembulatan Lembur
//
// Semuanya dihitung saat rekap DIBACA, jadi satu penyimpanan di
// sini langsung mengubah layar dan berkas Excel sekaligus.
//
// YANG TIDAK DISENTUH
//
// Foto, titik GPS, dan kinerja harian tetap apa adanya. Foto
// bercap geotag itu bukti kehadiran di lokasi, dan cap waktu di
// dalamnya sengaja TIDAK disesuaikan: menyunting bukti berbeda
// sifatnya dari membetulkan catatan. Kalau jam di rekap berbeda
// dari cap di foto, riwayat perubahannya yang menjelaskan.
//
// JAM PULANG BOLEH DIKOSONGKAN
//
// Kadang yang salah justru sebaliknya — jam pulang terisi padahal
// orangnya belum pulang. Mengosongkannya mengembalikan baris itu
// ke keadaan "belum absen pulang". Jam MASUK tidak boleh kosong:
// dokumen absensinya lahir dari absen masuk, dan tanpa jam itu
// seluruh barisnya kehilangan makna.

router.patch("/:id/jam", async (req, res) => {
  try {
    if (!apakahPetugas(req.query.pemohon)) {
      return tolakBukanPetugas(res);
    }

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "ID absensi tidak valid.",
      });
    }

    const masukBaru = jamBaku(req.body?.clockIn);

    if (!masukBaru) {
      return res.status(400).json({
        message:
          "Jam masuk tidak valid. Tulis dalam bentuk JJ.MM, " +
          "misalnya 07.30. Jam masuk tidak boleh dikosongkan.",
      });
    }

    // Kosong itu SAH untuk jam pulang, dan artinya "belum absen
    // pulang". Karena itu string kosong dibedakan dari isi yang
    // salah tulis — keduanya tidak boleh diperlakukan sama.
    const pulangDiminta = String(req.body?.clockOut ?? "").trim();

    const pulangBaru = pulangDiminta ? jamBaku(pulangDiminta) : "";

    if (pulangDiminta && !pulangBaru) {
      return res.status(400).json({
        message:
          "Jam pulang tidak valid. Tulis dalam bentuk JJ.MM, " +
          "misalnya 16.00 — atau kosongkan kalau memang belum pulang.",
      });
    }

    // Pulang lebih awal dari masuk membuat Menit Kerja jatuh ke
    // nol tanpa penjelasan apa pun di rekap. Ditolak di sini,
    // supaya sebabnya terbaca sekarang dan bukan jadi teka-teki
    // saat rekap dibaca bulan depan.
    if (pulangBaru && menitDariJam(pulangBaru) < menitDariJam(masukBaru)) {
      return res.status(400).json({
        message:
          `Jam pulang (${pulangBaru}) lebih awal daripada jam masuk ` +
          `(${masukBaru}). Periksa lagi — kalau memang lintas hari, ` +
          "absensinya perlu dicatat di tanggal berikutnya.",
      });
    }

    const alasan = String(req.body?.alasan || "")
      .trim()
      .slice(0, 300);

    const petugas = normalizePhoneNumber(req.query.pemohon);
    let baris;
    let masukLama = "";
    let pulangLama = "";

    if (id.startsWith("alpha_")) {
      const match = /^alpha_(\d+)_(\d{4}-\d{2}-\d{2})$/.exec(id);
      if (!match) {
        return res.status(400).json({ message: "Format ID tidak valid." });
      }
      const [, normWa, tgl] = match;
      const dataPegawai = await Pegawai.findOne({
        no_wa: { $regex: new RegExp(normWa + "$") },
      });

      baris = new Absensi({
        no_wa: dataPegawai ? dataPegawai.no_wa : normWa,
        nama: dataPegawai ? dataPegawai.nama : "",
        tanggal: tgl,
        attendanceType: "WFO",
        clockIn: masukBaru,
        clockOut: pulangBaru || null,
        riwayatJam: [
          {
            dariMasuk: "",
            keMasuk: masukBaru,
            dariPulang: "",
            kePulang: pulangBaru || "",
            oleh: petugas,
            alasan: alasan || "Pencatatan jam untuk pegawai Alpha",
            pada: new Date(),
          },
        ],
      });

      await baris.save();
    } else {
      baris = await Absensi.findById(id);

      if (!baris) {
        return res.status(404).json({
          message:
            "Data absensi tidak ditemukan. Mungkin sudah dihapus " +
            "dari perangkat lain — coba tekan Tampilkan lagi.",
        });
      }

      masukLama = String(baris.clockIn || "");
      pulangLama = String(baris.clockOut || "");

      if (masukLama === masukBaru && pulangLama === pulangBaru) {
        return res.status(400).json({
          message: "Jamnya sama dengan yang sekarang, tidak ada yang diubah.",
        });
      }

      baris.clockIn = masukBaru;

      // null, bukan string kosong: itu yang dipakai seluruh kode
      // lain sebagai penanda "belum absen pulang" — termasuk
      // endpoint /belum-pulang yang dipakai pengingat bot.
      baris.clockOut = pulangBaru || null;

      baris.riwayatJam.push({
        dariMasuk: masukLama,
        keMasuk: masukBaru,
        dariPulang: pulangLama,
        kePulang: pulangBaru,
        oleh: petugas,
        alasan,
        pada: new Date(),
      });

      await baris.save();
    }

    const jejak = [];

    if (masukLama !== masukBaru) {
      jejak.push(`masuk ${masukLama || "(kosong)"} → ${masukBaru}`);
    }

    if (pulangLama !== pulangBaru) {
      jejak.push(`pulang ${pulangLama || "(kosong)"} → ${pulangBaru || "(kosong)"}`);
    }

    console.warn(
      `🕑 [UBAH JAM] petugas ${petugas} mengubah ${baris.tanggal} ` +
        `milik ${baris.nama || "-"} (${baris.no_wa}): ${jejak.join(", ")}` +
        (alasan ? ` — ${alasan}` : " — tanpa catatan"),
    );

    return res.json({
      message:
        `Jam ${baris.nama || baris.no_wa} tanggal ${baris.tanggal} ` +
        `diubah: ${jejak.join(", ")}.`,

      absensi: {
        id: String(baris._id),
        jamMasuk: masukBaru,
        jamPulang: pulangBaru,
        perubahanJam: perubahanJamTerakhir(baris.riwayatJam),
      },
    });
  } catch (error) {
    console.error("❌ Error ubah jam absensi:", error);

    return res.status(500).json({
      message: "Gagal mengubah jam absensi.",
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
  jamDariMenit,
  jabatanBebasJamKerja,
  jabatanLemburOtomatis,
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
  { header: "Tanggal", key: "tanggal", width: 14 },
  { header: "Hari", key: "hari", width: 9 },
  { header: "Status", key: "jenis", width: 16 },
  { header: "Keterangan Cuti", key: "keteranganCuti", width: 19 },

  // Kosong untuk hampir semua baris. Terisi hanya kalau petugas
  // kepegawaian pernah membetulkan statusnya — dan justru baris
  // seperti itulah yang paling perlu bisa ditelusuri, karena
  // angka jam kerja di sebelah kanannya ikut berubah karenanya.
  { header: "Perubahan Status", key: "perubahanStatus", width: 38 },

  // Sejajar dengan Perubahan Status, dan alasannya lebih kuat
  // lagi: jam menggerakkan Terlambat, Menit Kerja, dan Lembur
  // sekaligus. Angka yang sudah dibetulkan tidak boleh terlihat
  // seperti angka yang tercatat sendiri.
  { header: "Perubahan Jam", key: "perubahanJam", width: 38 },
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

  // Hanya terisi untuk jabatan yang lemburnya otomatis (petugas
  // kebersihan). Lembur mereka tidak melewati pengajuan dan
  // persetujuan atasan, jadi kolom inilah pertanggungjawabannya.
  { header: "Kinerja Lembur", key: "kinerjaLembur", width: 45 },
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

  // Kolom tanggal & jam ditulis sebagai nilai asli Excel, bukan teks.
  // Kalau ditulis sebagai teks, Excel menandainya dengan
  // segitiga hijau "angka disimpan sebagai teks" dan tanggal/jamnya
  // tidak bisa diurutkan, difilter kalender, atau dihitung.
  sheet.getColumn("tanggal").numFmt = "dd/mm/yyyy";
  sheet.getColumn("tanggal").alignment = { horizontal: "center" };

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

      // Menimpa bentuk objek yang dipakai halaman rekap dengan
      // satu kalimat — sel Excel tidak bisa memuat objek.
      perubahanStatus: ringkasPerubahan(baris.perubahanStatus),
      perubahanJam: ringkasPerubahanJam(baris.perubahanJam),

      ...hitungJamKerja(baris),
    };

    // Tanggal ditulis sebagai tipe Date asli Excel agar berjenis Date di Excel:
    if (isi.tanggal) {
      const [th, bl, hr] = String(isi.tanggal).split("-").map(Number);
      if (th && bl && hr) {
        isi.tanggal = new Date(Date.UTC(th, bl - 1, hr));
      }
    }

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

    // Absensi WFO/WFH yang belum ada jam pulangnya ditandai supaya
    // langsung terlihat saat diperiksa.
    if (!baris.jamPulang && ["WFO", "WFH"].includes(baris.attendanceType)) {
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
    { header: "Total Hari", key: "total", width: 14 },
    { header: "Hadir (Total)", key: "hadir", width: 16 },
    { header: "WFO", key: "wfo", width: 8 },
    { header: "WFH", key: "wfh", width: 8 },
    { header: "Dinas Luar", key: "dinas", width: 12 },
    { header: "Cuti / Izin", key: "cuti", width: 14 },
    { header: "Alpha", key: "alpha", width: 10 },
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
        hadir: 0,
        wfo: 0,
        wfh: 0,
        dinas: 0,
        cuti: 0,
        alpha: 0,
        belumPulang: 0,
      });
    }

    const r = per.get(kunci);

    r.total++;

    if (baris.attendanceType === "WFO") {
      r.wfo++;
      r.hadir++;
    } else if (baris.attendanceType === "WFH") {
      r.wfh++;
      r.hadir++;
    } else if (baris.attendanceType === "DINAS") {
      r.dinas++;
      r.hadir++;
    } else if (baris.attendanceType === "CUTI" || baris.attendanceType === "IZIN") {
      r.cuti++;
    } else if (baris.attendanceType === "ALPHA") {
      r.alpha++;
    }

    if (!baris.jamPulang && ["WFO", "WFH"].includes(baris.attendanceType)) {
      r.belumPulang++;
    }
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
