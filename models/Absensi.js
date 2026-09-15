const mongoose = require("mongoose");

const absensiSchema = new mongoose.Schema(
  {
    no_wa: {
      type: String,
      required: true,
    },

    nama: {
      type: String,
      default: "",
    },

    tanggal: {
      type: String,
      required: true,
    },

    attendanceType: {
      type: String,
      enum: ["WFH", "WFO", "DINAS"],
      required: true,
    },

    clockIn: {
      type: String,
      default: null,
    },

    clockOut: {
      type: String,
      default: null,
    },

    // =========================
    // KINERJA HARIAN
    // =========================

    kinerja_harian: {
      type: String,
      default: "",
    },

    // =========================
    // FOTO
    // =========================

    clockInPhoto: {
      type: String,
      default: null,
    },

    clockOutPhoto: {
      type: String,
      default: null,
    },

    // =========================
    // LOKASI
    // =========================

    clockInLocation: {
      lat: Number,
      lng: Number,
      accuracy: Number,
      address: String,
    },

    clockOutLocation: {
      lat: Number,
      lng: Number,
      accuracy: Number,
      address: String,
    },

    clockInAddress: {
      type: String,
      default: null,
    },

    clockOutAddress: {
      type: String,
      default: null,
    },

    // =========================
    // LEMBUR
    // =========================
    //
    // Lembur non-ASN tidak punya jam sendiri: mulainya jam harus
    // checkout, selesainya jam absen pulang. Yang perlu dicatat
    // hanya BAHWA atasan sudah menyetujuinya — dan di rekap,
    // lembur baru dihitung kalau ini terisi.
    //
    // Ditulis oleh bot SisKA langsung ke koleksi ini saat atasan
    // membalas "1", bukan lewat API: endpoint tulis di sini bisa
    // dijangkau lewat nginx dari jaringan kantor, dan pegawai
    // tidak boleh bisa menyetujui lemburnya sendiri dengan curl.
    lembur: {
      disetujui: { type: Boolean, default: false },
      alasan: { type: String, default: "" },
      atasan: { type: String, default: "" },
      disetujuiPada: { type: Date, default: null },
    },
  },
  {
    collection: "absensi",
    timestamps: true,
  }
);

// =========================
// INDEX
// =========================

// Satu pegawai hanya boleh punya satu dokumen
// absensi per tanggal. Sekaligus mempercepat
// query "absensi hari ini" dan riwayat per pegawai.
absensiSchema.index(
  {
    no_wa: 1,
    tanggal: 1,
  },
  {
    unique: true,
  }
);

const Absensi =
  mongoose.models.Absensi ||
  mongoose.model("Absensi", absensiSchema);

module.exports = Absensi;