const mongoose = require("mongoose");

// =========================================================
// SATU PERUBAHAN STATUS OLEH PETUGAS
// =========================================================
//
// Dipakai sebagai isi riwayatStatus di bawah. Dibuat sebagai
// skema tersendiri supaya _id otomatis bisa dimatikan: tiap
// entri hanya pernah dibaca berurutan, tidak pernah ditunjuk
// satu-satu, jadi id di dalamnya cuma menambah ukuran dokumen.
const perubahanStatusSchema = new mongoose.Schema(
  {
    dari: { type: String, default: "" },
    ke: { type: String, default: "" },

    // Nomor WhatsApp petugas yang mengubah, sudah dinormalkan.
    oleh: { type: String, default: "" },

    alasan: { type: String, default: "" },
    pada: { type: Date, default: null },
  },
  { _id: false }
);

// =========================================================
// SATU PERUBAHAN JAM OLEH PETUGAS
// =========================================================
//
// Isi riwayatJam di bawah. Jam masuk dan jam pulang dicatat
// bersama dalam satu entri, bukan dua, karena petugas
// membetulkannya dalam satu tindakan — dan yang ingin
// direkonstruksi nanti adalah "baris ini diubah menjadi apa",
// bukan medannya satu per satu.
const perubahanJamSchema = new mongoose.Schema(
  {
    dariMasuk: { type: String, default: "" },
    keMasuk: { type: String, default: "" },
    dariPulang: { type: String, default: "" },
    kePulang: { type: String, default: "" },

    // Nomor WhatsApp petugas yang mengubah, sudah dinormalkan.
    oleh: { type: String, default: "" },

    alasan: { type: String, default: "" },
    pada: { type: Date, default: null },
  },
  { _id: false }
);

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
      enum: ["WFH", "WFO", "DINAS", "CUTI", "IZIN", "ALPHA"],
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

    // Apa yang dikerjakan SELAMA jam lembur, terpisah dari
    // kinerja harian. Hanya terisi untuk yang lemburnya
    // otomatis (petugas kebersihan): karena lembur mereka tidak
    // melewati pengajuan dan persetujuan atasan, catatan inilah
    // satu-satunya keterangan tentang apa yang dikerjakan pada
    // jam-jam itu.
    kinerja_lembur: {
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
    // BEBAS JAM KERJA KANTOR
    // =========================
    //
    // Disalin dari jabatan pegawai saat absen masuk (supir dan
    // sejenisnya). Disimpan di dokumen absensi, bukan dibaca ulang
    // dari data pegawai, karena dua alasan: endpoint yang membaca
    // absensi tidak perlu ikut mencari data pegawai, dan absensi
    // lama tetap memakai aturan yang berlaku saat itu kalau
    // jabatan orangnya berubah di kemudian hari.
    bebasJamKerja: {
      type: Boolean,
      default: false,
    },

    // =========================
    // LEMBUR OTOMATIS
    // =========================
    //
    // Petugas kebersihan lembur hampir setiap hari — ruangan
    // baru bisa dibersihkan setelah pegawai lain pulang — jadi
    // lemburnya diakui tanpa pengajuan dan tanpa persetujuan
    // atasan. Lihat JABATAN_LEMBUR_OTOMATIS di utils/jamKerja.js.
    //
    // Disalin dari jabatan saat absen masuk dengan alasan yang
    // sama seperti bebasJamKerja di atas: absensi lama tetap
    // memakai aturan yang berlaku saat itu kalau jabatan
    // orangnya berubah di kemudian hari.
    lemburOtomatis: {
      type: Boolean,
      default: false,
    },

    // =========================
    // PERUBAHAN STATUS OLEH PETUGAS
    // =========================
    //
    // Jenis kehadiran dipilih pegawai saat absen masuk, dan
    // pilihan itu kadang berubah di tengah hari — berangkat
    // WFO, lalu ditugaskan dinas luar sesudah makan siang.
    // Pegawainya tidak bisa membetulkan sendiri (satu orang
    // hanya boleh punya satu absensi per tanggal), jadi
    // petugas kepegawaian yang mengubahnya lewat rekap.
    //
    // Disimpan sebagai RIWAYAT, bukan satu nilai terakhir.
    // Status inilah dasar perhitungan jam harus checkout,
    // keterlambatan, menit kerja, dan lembur — begitu diubah,
    // tidak ada lagi jejak nilai aslinya di dokumen ini. Log
    // pm2 memang mencatatnya juga, tapi log dirotasi dan
    // akhirnya hilang; catatan di sini ikut umur dokumennya.
    riwayatStatus: {
      type: [perubahanStatusSchema],
      default: [],
    },

    // =========================
    // PERUBAHAN JAM OLEH PETUGAS
    // =========================
    //
    // Absensi yang gagal di tengah jalan membuat pegawai rugi:
    // jam masuknya tercatat terlambat karena fotonya berkali-kali
    // gagal diunggah, atau jam pulangnya kosong sama sekali
    // karena bot mentok — padahal orangnya hadir. Tanpa cara
    // membetulkannya, kerugian itu menempel di rekap yang dipakai
    // menilai kinerjanya.
    //
    // Jam adalah dasar SEMUA hitungan di rekap: keterlambatan,
    // jam harus checkout, menit kerja, dan lembur. Karena itu
    // perubahannya disimpan sebagai riwayat, sama seperti
    // riwayatStatus — dan dengan alasan yang sama: log pm2
    // dirotasi dan hilang, catatan di sini ikut umur dokumennya.
    riwayatJam: {
      type: [perubahanJamSchema],
      default: [],
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