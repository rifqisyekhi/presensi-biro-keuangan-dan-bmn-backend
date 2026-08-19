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