// =========================================================
// MIGRASI STRUKTUR FOLDER FOTO ABSENSI
// =========================================================
//
// Struktur lama:
//   <UPLOAD_DIR>/08-2026/18/Nama_Pegawai/clock-in.jpg
//
// Struktur baru:
//   <UPLOAD_DIR>/Nama_Pegawai/08-2026/2026-08-18_masuk.jpg
//
// Skrip ini memindahkan berkasnya DAN memperbarui path yang
// tersimpan di dokumen absensi. Keduanya harus berubah
// bersamaan: MongoDB hanya menyimpan path, jadi memindahkan
// berkas tanpa memperbarui dokumen akan membuat foto lama
// tidak bisa dibuka di aplikasi.
//
// PEMAKAIAN
//
//   node scripts/migrasi-struktur-foto.js           (uji coba)
//   node scripts/migrasi-struktur-foto.js --apply   (jalankan)
//
// Tanpa --apply skrip hanya menampilkan rencananya dan tidak
// menyentuh apa pun. Backup dulu sebelum memakai --apply:
//
//   tar czf ~/foto-absensi-backup.tar.gz -C <UPLOAD_DIR> .

require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const mongoose = require("mongoose");

const Absensi = require("../models/Absensi");
const { UPLOAD_DIR, PUBLIC_PATH } = require("../utils/simpanFoto");

const APPLY = process.argv.includes("--apply");

const LABEL = {
  "clock-in": "masuk",
  "clock-out": "pulang",
};

// Path lama: /uploads/<MM-YYYY>/<tanggal>/<Nama>/<jenis>.<ext>
const POLA_LAMA =
  /^\/uploads\/(\d{2}-\d{4})\/(\d{1,2})\/([^/]+)\/(clock-in|clock-out)\.(\w+)$/;

function hitungPathBaru(pathLama, tanggalDokumen) {
  const cocok = POLA_LAMA.exec(pathLama);

  if (!cocok) return null;

  const [, folderBulan, , namaPegawai, jenis, ekstensi] = cocok;

  // Tanggal diambil dari dokumen, bukan dari nama folder:
  // folder lama hanya menyimpan tanggal tanpa bulan dan tahun.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tanggalDokumen || ""))) {
    return null;
  }

  const namaFile = `${tanggalDokumen}_${LABEL[jenis]}.${ekstensi}`;

  return `${PUBLIC_PATH}/${namaPegawai}/${folderBulan}/${namaFile}`;
}

// Path publik ("/uploads/...") menjadi path berkas di disk.
function keDisk(pathPublik) {
  const relatif = pathPublik.slice(PUBLIC_PATH.length + 1);

  return path.join(UPLOAD_DIR, ...relatif.split("/"));
}

async function ada(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error("❌ MONGODB_URI belum diset di file .env");
    process.exit(1);
  }

  await mongoose.connect(uri);

  console.log("UPLOAD_DIR :", UPLOAD_DIR);
  console.log("Mode       :", APPLY ? "JALANKAN (--apply)" : "UJI COBA");
  console.log("");

  const dokumen = await Absensi.find({
    $or: [
      { clockInPhoto: { $regex: "^/uploads/\\d{2}-\\d{4}/" } },
      { clockOutPhoto: { $regex: "^/uploads/\\d{2}-\\d{4}/" } },
    ],
  });

  console.log(`Dokumen berstruktur lama: ${dokumen.length}\n`);

  const hitung = {
    dipindah: 0,
    dilewati: 0,
    hilang: 0,
    gagal: 0,
  };

  for (const doc of dokumen) {
    const perubahan = {};

    for (const field of ["clockInPhoto", "clockOutPhoto"]) {
      const lama = doc[field];

      if (!lama || !POLA_LAMA.test(lama)) continue;

      const baru = hitungPathBaru(lama, doc.tanggal);

      if (!baru) {
        console.log(`  ⚠️  ${doc.nama || doc.no_wa}: tidak bisa dihitung — ${lama}`);
        hitung.gagal++;
        continue;
      }

      const diskLama = keDisk(lama);
      const diskBaru = keDisk(baru);

      if (!(await ada(diskLama))) {
        // Berkasnya sudah tidak ada. Path di dokumen tetap
        // dibiarkan apa adanya supaya tidak menunjuk ke berkas
        // yang juga tidak ada.
        console.log(`  ⚠️  berkas hilang, dilewati — ${lama}`);
        hitung.hilang++;
        continue;
      }

      if (await ada(diskBaru)) {
        console.log(`  ⚠️  tujuan sudah terisi, dilewati — ${baru}`);
        hitung.dilewati++;
        continue;
      }

      console.log(`  ${lama}\n    → ${baru}`);

      if (APPLY) {
        await fs.mkdir(path.dirname(diskBaru), { recursive: true });
        await fs.rename(diskLama, diskBaru);
      }

      perubahan[field] = baru;
      hitung.dipindah++;
    }

    if (APPLY && Object.keys(perubahan).length) {
      await Absensi.updateOne({ _id: doc._id }, { $set: perubahan });
    }
  }

  console.log("");
  console.log("Ringkasan");
  console.log("  Dipindah      :", hitung.dipindah);
  console.log("  Tujuan terisi :", hitung.dilewati);
  console.log("  Berkas hilang :", hitung.hilang);
  console.log("  Gagal dihitung:", hitung.gagal);

  if (!APPLY) {
    console.log("");
    console.log("Ini baru uji coba — tidak ada berkas atau dokumen yang berubah.");
    console.log("Jalankan ulang dengan --apply setelah membuat backup.");
  } else {
    console.log("");
    console.log("Selesai. Folder lama yang sudah kosong bisa dibersihkan dengan:");
    console.log(`  find "${UPLOAD_DIR}" -type d -empty -delete`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("❌ Migrasi gagal:", err);

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});
