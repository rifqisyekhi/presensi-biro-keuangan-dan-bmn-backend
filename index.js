require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const absensiRoutes = require("./routes/absensiRoutes");

const { UPLOAD_DIR } = require("./utils/simpanFoto");

const app = express();

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(cors());

app.use(
  express.json({
    limit: "50mb",
  }),
);

app.use(
  express.urlencoded({
    limit: "50mb",
    extended: true,
  }),
);

// ==========================================
// FOTO ABSENSI
// ==========================================

// Folder foto di VPS disajikan lewat /uploads,
// mengikuti struktur <bulan-tahun>/<tanggal>/<pegawai>/.
console.log("📁 Folder foto absensi:", UPLOAD_DIR);

app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    fallthrough: false,
    maxAge: "7d",
  }),
);

// ==========================================
// KONEKSI MONGODB
// ==========================================

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI belum diset di file .env");
  process.exit(1);
}

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("✅ Berhasil terhubung ke database MongoDB (db_siska)");
  })
  .catch((error) => {
    console.error("❌ Gagal terhubung ke MongoDB:", error.message);
  });

// ==========================================
// MODEL PEGAWAI
// ==========================================

const pegawaiSchema = new mongoose.Schema(
  {
    nip: String,
    kategori_pegawai: String,
    nama: String,
    no_wa: String,
    jabatan: String,
    sub_unit: String,
    email: String,
    atasan_nip: String,
    foto_profil: String,
  },
  {
    collection: "pegawai",
  },
);

const Pegawai =
  mongoose.models.Pegawai || mongoose.model("Pegawai", pegawaiSchema);

// ==========================================
// HELPER PHONE NUMBER
// ==========================================

const normalizePhoneNumber = (value) => {
  if (value === null || value === undefined) {
    return "";
  }

  const digits = String(value).trim().replace(/\D/g, "");

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
};

const getPhoneCandidates = (value) => {
  if (value === null || value === undefined) {
    return [];
  }

  const rawPhone = String(value).trim().replace(/\D/g, "");

  if (!rawPhone) {
    return [];
  }

  const normalizedPhone = normalizePhoneNumber(rawPhone);

  const candidates = [
    normalizedPhone,
    rawPhone,
    rawPhone.startsWith("0") ? `62${rawPhone.slice(1)}` : rawPhone,
  ];

  return [...new Set(candidates.filter(Boolean))];
};

// ==========================================
// GET PEGAWAI
// ==========================================

app.get("/api/pegawai/:identifier", async (req, res) => {
  try {
    const identifier = req.params.identifier;

    const candidates = getPhoneCandidates(identifier);

    const dataPegawai = await Pegawai.findOne({
      $or: [
        {
          nip: identifier,
        },
        {
          no_wa: {
            $in: candidates,
          },
        },
      ],
    });

    if (!dataPegawai) {
      return res.status(404).json({
        message: "Pegawai tidak ditemukan",
      });
    }

    res.json(dataPegawai);
  } catch (error) {
    console.error("Error get pegawai:", error);

    res.status(500).json({
      message: "Error dari server",
      error: error.message,
    });
  }
});

// ==========================================
// LOGIN
// ==========================================

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const normalizedUsername = normalizePhoneNumber(username);

    const normalizedPassword = normalizePhoneNumber(password);

    if (!normalizedUsername || !normalizedPassword) {
      return res.status(400).json({
        message: "Username dan password nomor telepon wajib diisi.",
      });
    }

    if (normalizedUsername !== normalizedPassword) {
      return res.status(401).json({
        message:
          "Password salah! (Gunakan nomor telepon yang sama sebagai password)",
      });
    }

    const lookupCandidates = getPhoneCandidates(normalizedUsername);

    const dataPegawai = await Pegawai.findOne({
      no_wa: {
        $in: lookupCandidates,
      },
    });

    if (!dataPegawai) {
      return res.status(404).json({
        message: "Nomor telepon tidak terdaftar di sistem.",
      });
    }

    res.json({
      message: "Login berhasil",
      user: dataPegawai,
    });
  } catch (error) {
    console.error("Error login:", error);

    res.status(500).json({
      message: "Error dari server",
      error: error.message,
    });
  }
});

// ==========================================
// ABSENSI ROUTES
// ==========================================

app.use("/api/absensi", absensiRoutes);

// ==========================================
// ROUTE DASAR
// ==========================================

app.get("/", (req, res) => {
  res.send("Server Absensi Backend berjalan dengan baik!");
});

// ==========================================
// SERVER
// ==========================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
