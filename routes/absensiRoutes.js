const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

// =========================================================
// MODEL PEGAWAI
// =========================================================

const pegawaiSchema = new mongoose.Schema(
  {
    no_wa: String,
    kategori_pegawai: String,
    nama: String,
    jabatan: String,
    sub_unit: String,
    email: String,
    foto_profil: String,
  },
  {
    collection: "pegawai",
  }
);

const Pegawai =
  mongoose.models.Pegawai ||
  mongoose.model("Pegawai", pegawaiSchema);

// =========================================================
// MODEL ABSENSI
// =========================================================

const Absensi = require("../models/Absensi");

const {
  simpanFotoAbsensi,
} = require("../utils/simpanFoto");

// =========================================================
// NORMALISASI NOMOR DAN TANGGAL
// =========================================================

// Dipindah ke utils/format.js supaya routes/rekapRoutes.js
// memakai aturan normalisasi yang sama persis — daftar nomor
// petugas dibandingkan dengan nomor pegawai memakai fungsi ini.

const {
  normalizePhoneNumber,
  getToday,
  normalizeTanggal,
  normalizeBulan,
} = require("../utils/format");

const {
  MODE,
  RADIUS_METER,
  cekRadius,
} = require("../utils/lokasi");

const { hitungJamKerja } = require("../utils/jamKerja");

// =========================================================
// BULAN RIWAYAT
// =========================================================

// Riwayat diambil per bulan supaya daftarnya tidak tumbuh
// tanpa batas. Batas baris di bawah hanya jaring pengaman:
// satu pegawai maksimal satu absensi per tanggal, jadi satu
// bulan tidak mungkin lebih dari 31 baris.

const MAX_RIWAYAT = 100;

// =========================================================
// BATAS KINERJA HARIAN
// =========================================================

// Kinerja harian dibaca petugas dalam bentuk rekap, satu baris
// per absensi. Terlalu panjang membuat kolomnya tidak terbaca,
// terlalu pendek tidak berarti apa-apa. Batas ini ditegakkan
// di sini karena backend adalah satu-satunya jalur masuk yang
// dipakai bersama aplikasi web dan bot WhatsApp.

const KINERJA_MIN = 10;
const KINERJA_MAX = 100;

// =========================================================
// CARI PEGAWAI
// =========================================================

async function findPegawai(no_wa) {
  const normalizedPhone = normalizePhoneNumber(no_wa);

  return await Pegawai.findOne({
    no_wa: {
      $in: [
        normalizedPhone,
        String(no_wa || ""),
        String(no_wa || "").replace(/\D/g, ""),
      ],
    },
  });
}

// =========================================================
// GET ABSENSI HARI INI
// =========================================================

router.get("/today/:no_wa", async (req, res) => {
  try {
    const no_wa = normalizePhoneNumber(req.params.no_wa);

    console.log("=================================");
    console.log("📥 GET ABSENSI HARI INI");
    console.log("No WA:", no_wa);
    console.log("=================================");

    if (!no_wa) {
      return res.status(400).json({
        message: "Nomor telepon tidak valid.",
      });
    }

    // Tanggal boleh dikirim client lewat query supaya
    // "hari ini" mengikuti perangkat pegawai, bukan server.
    const tanggal =
      normalizeTanggal(req.query.tanggal) || getToday();

    const absensi = await Absensi.findOne({
      no_wa,
      tanggal,
    });

    if (!absensi) {
      return res.json({
        exists: false,
        data: null,
      });
    }

    // Perhitungan jam kerja disertakan supaya bot WhatsApp
    // tidak perlu menyalin aturannya sendiri. Satu sumber:
    // angka "Jam Harus Checkout" yang diberitahukan ke pegawai
    // harus sama persis dengan yang tercetak di berkas rekap.
    const jamKerja = hitungJamKerja({
      tanggal: absensi.tanggal,
      attendanceType: absensi.attendanceType,
      jamMasuk: absensi.clockIn || "",
      jamPulang: absensi.clockOut || "",
    });

    return res.json({
      exists: true,
      data: absensi,
      jamKerja,
    });
  } catch (error) {
    console.error("❌ Error GET absensi:", error);

    return res.status(500).json({
      message: "Gagal mengambil data absensi.",
      error: error.message,
    });
  }
});

// =========================================================
// BELUM ABSEN PULANG
// =========================================================
//
// Dipakai penjadwal pengingat di bot WhatsApp. Mengembalikan
// pegawai yang sudah absen masuk tapi belum absen pulang pada
// tanggal tertentu, lengkap dengan jam wajib pulangnya.
//
// Tidak dijaga daftar petugas: backend hanya mendengarkan di
// 127.0.0.1, jadi endpoint ini cuma bisa dipanggil dari dalam
// VPS — dan bot memang berjalan di sana.

router.get("/belum-pulang", async (req, res) => {
  try {
    const tanggal =
      normalizeTanggal(req.query.tanggal) || getToday();

    const daftar = await Absensi.find({
      tanggal,
      clockIn: { $nin: [null, ""] },
      $or: [{ clockOut: null }, { clockOut: "" }],
    }).lean();

    return res.json({
      tanggal,
      total: daftar.length,
      data: daftar.map((a) => ({
        no_wa: a.no_wa,
        nama: a.nama || "",
        tanggal: a.tanggal,
        attendanceType: a.attendanceType || "",
        clockIn: a.clockIn || "",
        ...(() => {
          const jk = hitungJamKerja({
            tanggal: a.tanggal,
            attendanceType: a.attendanceType,
            jamMasuk: a.clockIn || "",
            jamPulang: "",
          });

          // Dinas luar tidak punya jamHarusCheckout, tapi tetap
          // butuh acuan kapan mulai diingatkan — kalau tidak,
          // absensinya menggantung tanpa ada yang menegur.
          return {
            jamHarusCheckout: jk.jamHarusCheckout,
            jamPulangJadwal: jk.jamPulangJadwal,
          };
        })(),
      })),
    });
  } catch (error) {
    console.error("❌ Error belum-pulang:", error);

    return res.status(500).json({
      message: "Gagal mengambil daftar yang belum absen pulang.",
      error: error.message,
    });
  }
});

// =========================================================
// CLOCK IN
// =========================================================

router.post("/clock-in", async (req, res) => {
  try {
    const {
      no_wa,
      attendanceType,
      clockIn,
      clockInPhoto,
      clockInLocation,
      clockInAddress,
      tanggal: tanggalDikirim,
    } = req.body;

    console.log("=================================");
    console.log("🟢 CLOCK IN");
    console.log("No WA:", no_wa);
    console.log("Jenis:", attendanceType);
    console.log("Jam:", clockIn);
    console.log("Lokasi:", clockInLocation);
    console.log("=================================");

    const normalizedPhone = normalizePhoneNumber(no_wa);

    if (!normalizedPhone) {
      return res.status(400).json({
        message: "Nomor telepon wajib diisi.",
      });
    }

    if (!attendanceType) {
      return res.status(400).json({
        message: "Jenis kehadiran wajib diisi.",
      });
    }

    if (!["WFH", "WFO", "DINAS"].includes(attendanceType)) {
      return res.status(400).json({
        message: "Jenis kehadiran tidak valid.",
      });
    }

    // =====================================================
    // CARI PEGAWAI
    // =====================================================

    const pegawai = await findPegawai(no_wa);

    if (!pegawai) {
      console.log(
        "❌ PEGAWAI TIDAK DITEMUKAN:",
        normalizedPhone
      );

      return res.status(404).json({
        message:
          "Data pegawai tidak ditemukan berdasarkan nomor telepon.",
      });
    }

    console.log("✅ PEGAWAI DITEMUKAN:", pegawai.nama);

    // =====================================================
    // TANGGAL
    // =====================================================

    const tanggal =
      normalizeTanggal(tanggalDikirim) || getToday();

    // =====================================================
    // CEK ABSENSI HARI INI
    // =====================================================

    const existingAttendance = await Absensi.findOne({
      no_wa: normalizedPhone,
      tanggal,
    });

    if (existingAttendance?.clockIn) {
      return res.status(400).json({
        message: "Anda sudah melakukan Clock In hari ini.",
        data: existingAttendance,
      });
    }

    // =====================================================
    // BATAS RADIUS LOKASI
    // =====================================================

    // Sama seperti validasi kinerja di Clock Out: diperiksa
    // SEBELUM foto ditulis ke disk, supaya permintaan yang
    // ditolak tidak meninggalkan berkas yatim.

    const radius = cekRadius({
      attendanceType,
      lokasi: clockInLocation,
    });

    if (radius.diperiksa) {
      console.log(
        `📍 Jarak dari kantor: ${radius.jarak} m ` +
          `(batas ${RADIUS_METER} m, mode ${MODE})`,
      );

      if (!radius.dalamRadius && MODE === "enforce") {
        return res.status(400).json({
          message: radius.pesan,
          jarak: radius.jarak,
        });
      }

      if (!radius.dalamRadius) {
        console.warn(
          `⚠️  DI LUAR RADIUS: ${pegawai.nama} — ${radius.jarak} m. ` +
            "Tetap diterima karena mode masih 'warn'.",
        );
      }
    }

    // =====================================================
    // SIMPAN FOTO KE DISK
    // =====================================================

    let clockInPhotoPath = null;

    try {
      clockInPhotoPath = await simpanFotoAbsensi({
        dataUrl: clockInPhoto,
        tanggal,
        nama: pegawai.nama,
        no_wa: normalizedPhone,
        jenis: "clock-in",
      });
    } catch (photoError) {
      console.error("❌ Gagal menyimpan foto:", photoError);

      return res.status(400).json({
        message: photoError.message,
      });
    }

    // =====================================================
    // SIMPAN ABSENSI
    // =====================================================

    const absensi = new Absensi({
      no_wa: normalizedPhone,

      nama: pegawai.nama || "",

      tanggal,

      attendanceType,

      clockIn: clockIn || null,

      clockInPhoto: clockInPhotoPath,

      clockInLocation: clockInLocation || null,

      clockInAddress: clockInAddress || null,

      clockOut: null,

      clockOutPhoto: null,

      clockOutLocation: null,

      clockOutAddress: null,

      kinerja_harian: "",
    });

    await absensi.save();

    console.log("✅ CLOCK IN BERHASIL");
    console.log("ID:", absensi._id);
    console.log("No WA:", normalizedPhone);
    console.log("Nama:", pegawai.nama);

    return res.status(201).json({
      message: "Clock In berhasil.",
      data: absensi,
    });
  } catch (error) {
    // Unique index (no_wa, tanggal): dua request Clock In
    // yang masuk bersamaan.
    if (error?.code === 11000) {
      console.log("⚠️ Clock In ganda ditolak oleh index unik.");

      return res.status(400).json({
        message: "Anda sudah melakukan Clock In hari ini.",
      });
    }

    console.error("❌ Error Clock In:", error);

    return res.status(500).json({
      message: "Gagal menyimpan Clock In.",
      error: error.message,
    });
  }
});

// =========================================================
// CLOCK OUT
// =========================================================

router.put("/clock-out", async (req, res) => {
  try {
    const {
      no_wa,
      clockOut,
      clockOutPhoto,
      clockOutLocation,
      clockOutAddress,
      kinerja_harian,

      // Tanggal Clock In-nya, dikirim dari perangkat.
      // Penting untuk Clock Out yang lewat tengah malam.
      tanggal: tanggalDikirim,

      // Dipakai hanya sebagai cadangan kalau dokumen
      // Clock In belum ada di database.
      attendanceType,
      clockIn,
      clockInPhoto,
      clockInLocation,
      clockInAddress,
    } = req.body;

    console.log("=================================");
    console.log("🔴 CLOCK OUT");
    console.log("No WA:", no_wa);
    console.log("Jam:", clockOut);
    console.log("Lokasi:", clockOutLocation);
    console.log("Kinerja:", kinerja_harian);
    console.log("=================================");

    console.log("📦 BODY CLOCK OUT:");
    console.log(req.body);

    const normalizedPhone = normalizePhoneNumber(no_wa);

    if (!normalizedPhone) {
      return res.status(400).json({
        message: "Nomor telepon wajib diisi.",
      });
    }

    // =====================================================
    // PASTIKAN PEGAWAI ADA
    // =====================================================

    const pegawai = await findPegawai(no_wa);

    if (!pegawai) {
      console.log(
        "❌ PEGAWAI TIDAK DITEMUKAN:",
        normalizedPhone
      );

      return res.status(404).json({
        message:
          "Data pegawai tidak ditemukan berdasarkan nomor telepon.",
      });
    }

    // =====================================================
    // TANGGAL
    // =====================================================

    const tanggal =
      normalizeTanggal(tanggalDikirim) || getToday();

    // =====================================================
    // CARI ABSENSI
    // =====================================================

    let absensi = await Absensi.findOne({
      no_wa: normalizedPhone,
      tanggal,
    });

    // =====================================================
    // CADANGAN: BUAT DOKUMEN DARI DATA CLOCK IN
    // Dipakai kalau request Clock In sempat gagal
    // (offline / server mati) sehingga dokumennya
    // tidak pernah tersimpan. Tanpa ini absensi
    // hari itu hilang sama sekali dari riwayat.
    // =====================================================

    if (!absensi) {
      if (!clockIn || !attendanceType) {
        return res.status(404).json({
          message:
            "Data Clock In hari ini tidak ditemukan.",
        });
      }

      if (!["WFH", "WFO", "DINAS"].includes(attendanceType)) {
        return res.status(400).json({
          message: "Jenis kehadiran tidak valid.",
        });
      }

      console.log(
        "⚠️ Dokumen Clock In tidak ada. Dibuat ulang dari payload Clock Out."
      );

      let clockInPhotoPath = null;

      try {
        clockInPhotoPath = await simpanFotoAbsensi({
          dataUrl: clockInPhoto,
          tanggal,
          nama: pegawai.nama,
          no_wa: normalizedPhone,
          jenis: "clock-in",
        });
      } catch (photoError) {
        console.error(
          "❌ Gagal menyimpan foto Clock In:",
          photoError
        );

        return res.status(400).json({
          message: photoError.message,
        });
      }

      absensi = new Absensi({
        no_wa: normalizedPhone,

        nama: pegawai.nama || "",

        tanggal,

        attendanceType,

        clockIn,

        clockInPhoto: clockInPhotoPath,

        clockInLocation: clockInLocation || null,

        clockInAddress: clockInAddress || null,
      });
    }

    if (!absensi.clockIn) {
      return res.status(400).json({
        message:
          "Anda belum melakukan Clock In.",
      });
    }

    if (absensi.clockOut) {
      return res.status(400).json({
        message:
          "Anda sudah melakukan Clock Out hari ini.",
        data: absensi,
      });
    }

    // =====================================================
    // VALIDASI KINERJA HARIAN
    // =====================================================

    // Diperiksa SEBELUM foto ditulis ke disk. Kalau urutannya
    // dibalik, permintaan yang ditolak tetap meninggalkan
    // berkas foto yatim yang tidak dirujuk dokumen mana pun.

    const kinerjaBersih =
      typeof kinerja_harian === "string"
        ? kinerja_harian.trim()
        : "";

    if (kinerjaBersih.length < KINERJA_MIN) {
      return res.status(400).json({
        message:
          `Kinerja harian minimal ${KINERJA_MIN} huruf. ` +
          `Saat ini ${kinerjaBersih.length} huruf.`,
      });
    }

    if (kinerjaBersih.length > KINERJA_MAX) {
      return res.status(400).json({
        message:
          `Kinerja harian maksimal ${KINERJA_MAX} huruf. ` +
          `Saat ini ${kinerjaBersih.length} huruf.`,
      });
    }

    // =====================================================
    // UPDATE CLOCK OUT
    // =====================================================

    let clockOutPhotoPath = null;

    try {
      clockOutPhotoPath = await simpanFotoAbsensi({
        dataUrl: clockOutPhoto,
        tanggal,
        nama: pegawai.nama,
        no_wa: normalizedPhone,
        jenis: "clock-out",
      });
    } catch (photoError) {
      console.error(
        "❌ Gagal menyimpan foto Clock Out:",
        photoError
      );

      return res.status(400).json({
        message: photoError.message,
      });
    }

    absensi.clockOut = clockOut || null;

    absensi.clockOutPhoto = clockOutPhotoPath;

    absensi.clockOutLocation =
      clockOutLocation || null;

    absensi.clockOutAddress =
      clockOutAddress || null;

    absensi.kinerja_harian = kinerjaBersih;

    await absensi.save();

    console.log("=================================");
    console.log("✅ CLOCK OUT BERHASIL");
    console.log("ID:", absensi._id);
    console.log("No WA:", normalizedPhone);
    console.log("Nama:", pegawai.nama);
    console.log(
      "Kinerja:",
      absensi.kinerja_harian
    );
    console.log("=================================");

    return res.json({
      message: "Clock Out berhasil.",
      data: absensi,
    });
  } catch (error) {
    console.error("❌ Error Clock Out:", error);

    return res.status(500).json({
      message: "Gagal menyimpan Clock Out.",
      error: error.message,
    });
  }
});

// =========================================================
// GET RIWAYAT ABSENSI
// =========================================================

router.get("/history/:no_wa", async (req, res) => {
  try {
    const no_wa = normalizePhoneNumber(req.params.no_wa);

    console.log("=================================");
    console.log("📋 GET RIWAYAT ABSENSI");
    console.log("No WA:", no_wa);
    console.log("Bulan:", req.query.bulan || "(default)");
    console.log("=================================");

    if (!no_wa) {
      return res.status(400).json({
        message: "Nomor telepon tidak valid.",
      });
    }

    // Daftar bulan yang punya data, terbaru dulu. Frontend
    // memakai ini untuk mengisi pilihan filter tanpa perlu
    // mengunduh seluruh riwayat lebih dulu.
    const hasilBulan = await Absensi.aggregate([
      { $match: { no_wa } },
      { $group: { _id: { $substr: ["$tanggal", 0, 7] } } },
      { $sort: { _id: -1 } },
    ]);

    const bulanTersedia = hasilBulan
      .map((item) => item._id)
      .filter(Boolean);

    // Riwayat diambil per bulan, bukan seluruhnya, supaya
    // daftarnya tidak tumbuh tanpa batas. Karena satu pegawai
    // hanya bisa punya satu absensi per tanggal, satu bulan
    // paling banyak 31 baris.
    const bulan =
      normalizeBulan(req.query.bulan) ||
      bulanTersedia[0] ||
      "";

    const filter = { no_wa };

    if (bulan) {
      filter.tanggal = {
        $gte: `${bulan}-01`,
        $lte: `${bulan}-31`,
      };
    }

    const data = await Absensi.find(filter)
      .sort({
        tanggal: -1,
        createdAt: -1,
      })
      .limit(MAX_RIWAYAT)
      .lean();

    console.log("📦 Jumlah history:", data.length);

    return res.json({
      data,
      bulan,
      bulanTersedia,
    });
  } catch (error) {
    console.error("❌ Error history:", error);

    return res.status(500).json({
      message: "Gagal mengambil riwayat absensi.",
      error: error.message,
    });
  }
});

module.exports = router;