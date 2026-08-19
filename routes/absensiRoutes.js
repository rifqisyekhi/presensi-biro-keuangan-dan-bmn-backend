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
// NORMALIZE NOMOR TELEPON
// =========================================================

function normalizePhoneNumber(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const digits = String(value)
    .trim()
    .replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.startsWith("0")) {
    return `62${digits.slice(1)}`;
  }

  if (!digits.startsWith("62")) {
    return `62${digits}`;
  }

  return digits;
}

// =========================================================
// TANGGAL HARI INI
// =========================================================

function getToday() {
  const now = new Date();

  return (
    `${now.getFullYear()}-` +
    `${String(now.getMonth() + 1).padStart(2, "0")}-` +
    `${String(now.getDate()).padStart(2, "0")}`
  );
}

// =========================================================
// TANGGAL DARI CLIENT
// =========================================================

// Tanggal absensi ditentukan oleh perangkat pegawai, bukan
// oleh jam server. Ini mencegah dua masalah: server dengan
// timezone berbeda (mis. UTC) mencatat tanggal yang meleset,
// dan Clock Out yang melewati tengah malam terpisah dari
// Clock In-nya. Kalau client tidak mengirim tanggal yang
// valid, baru jatuh ke tanggal server.

function normalizeTanggal(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return "";
  }

  return trimmed;
}

// =========================================================
// BULAN RIWAYAT
// =========================================================

// Riwayat diambil per bulan supaya daftarnya tidak tumbuh
// tanpa batas. Batas baris di bawah hanya jaring pengaman:
// satu pegawai maksimal satu absensi per tanggal, jadi satu
// bulan tidak mungkin lebih dari 31 baris.

const MAX_RIWAYAT = 100;

function normalizeBulan(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();

  if (!/^\d{4}-\d{2}$/.test(trimmed)) {
    return "";
  }

  return trimmed;
}

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

    return res.json({
      exists: true,
      data: absensi,
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

    absensi.kinerja_harian =
      typeof kinerja_harian === "string"
        ? kinerja_harian.trim()
        : "";

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