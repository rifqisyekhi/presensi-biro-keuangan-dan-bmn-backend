const mongoose = require("mongoose");

// Model ini juga didaftarkan secara inline di
// routes/absensiRoutes.js. Penjaga mongoose.models di bawah
// memastikan keduanya memakai model yang sama, siapa pun yang
// dimuat lebih dulu.

const pegawaiSchema = new mongoose.Schema(
  {
    no_wa: String,
    nip: String,
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

module.exports = Pegawai;
