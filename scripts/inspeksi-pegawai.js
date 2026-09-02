// =========================================================
// INSPEKSI KOLEKSI PEGAWAI
// =========================================================
//
// Memotret kondisi data pegawai apa adanya sebelum strukturnya
// dirapikan. Tanpa ini, perancangan skema hanya akan berdiri
// di atas tebakan.
//
// PEMAKAIAN
//
//   node scripts/inspeksi-pegawai.js
//
// Skrip ini HANYA MEMBACA. Tidak ada dokumen yang diubah.
//
// Nomor identitas disamarkan di keluaran (hanya panjang dan
// empat digit terakhir), supaya hasilnya aman ditempel ke
// mana-mana saat berdiskusi.

require("dotenv").config();

const mongoose = require("mongoose");

function samarkan(nilai) {
  const s = String(nilai == null ? "" : nilai).trim();

  if (!s) return "(kosong)";

  if (s.length <= 4) return `${s.length} char: ${s}`;

  return `${s.length} char: …${s.slice(-4)}`;
}

function tabel(judul, peta) {
  console.log(`\n=== ${judul} ===`);

  const baris = [...peta.entries()].sort((a, b) => b[1] - a[1]);

  if (!baris.length) {
    console.log("  (tidak ada)");
    return;
  }

  const lebar = Math.max(...baris.map(([k]) => String(k).length));

  for (const [k, v] of baris) {
    console.log(`  ${String(k).padEnd(lebar)}  ${String(v).padStart(4)}`);
  }
}

function hitung(daftar, ambil) {
  const peta = new Map();

  for (const d of daftar) {
    const k = ambil(d);

    peta.set(k, (peta.get(k) || 0) + 1);
  }

  return peta;
}

async function main() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error("❌ MONGODB_URI belum diset di file .env");
    process.exit(1);
  }

  await mongoose.connect(uri);

  // Dibaca mentah lewat driver, bukan lewat model, supaya
  // field yang tidak ada di skema tetap terlihat.
  const koleksi = mongoose.connection.db.collection("pegawai");

  const semua = await koleksi.find({}).toArray();

  console.log(`Total dokumen pegawai: ${semua.length}`);

  // -------------------------------------------------------
  // 1. FIELD APA SAJA YANG SEBENARNYA ADA
  // -------------------------------------------------------

  const field = new Map();

  for (const d of semua) {
    for (const k of Object.keys(d)) {
      field.set(k, (field.get(k) || 0) + 1);
    }
  }

  tabel("FIELD YANG DIPAKAI (nama field → jumlah dokumen)", field);

  // -------------------------------------------------------
  // 2. KATEGORI
  // -------------------------------------------------------

  tabel(
    "KATEGORI_PEGAWAI",
    hitung(semua, (d) =>
      d.kategori_pegawai === undefined
        ? "(field tidak ada)"
        : String(d.kategori_pegawai || "(kosong)"),
    ),
  );

  // -------------------------------------------------------
  // 2B. UNIT KERJA DAN JABATAN
  // -------------------------------------------------------

  // Nilai yang ditulis bebas gampang bercabang: "TU" dan
  // "TU Biro" akan tampil sebagai dua unit berbeda di rekap
  // dan filter, padahal orangnya satu bagian.
  tabel(
    "SUB_UNIT (perhatikan ejaan yang mirip-mirip)",
    hitung(semua, (d) =>
      d.sub_unit === undefined
        ? "(field tidak ada)"
        : `"${String(d.sub_unit ?? "").trim() || "(kosong)"}"`,
    ),
  );

  // Ejaan yang hanya beda spasi/huruf besar-kecil disorot,
  // karena itu yang paling sering luput saat merapikan manual.
  const petaNormal = new Map();

  for (const d of semua) {
    const asli = String(d.sub_unit ?? "").trim();

    if (!asli) continue;

    const kunci = asli.toLowerCase().replace(/\s+/g, " ");

    if (!petaNormal.has(kunci)) petaNormal.set(kunci, new Set());

    petaNormal.get(kunci).add(asli);
  }

  const ejaanGanda = [...petaNormal.values()].filter((s) => s.size > 1);

  if (ejaanGanda.length) {
    console.log("\n  Ejaan berbeda untuk unit yang sama:");

    for (const s of ejaanGanda) {
      console.log(`    ${[...s].map((v) => `"${v}"`).join("  vs  ")}`);
    }
  }

  tabel(
    "JABATAN",
    hitung(semua, (d) =>
      `"${String(d.jabatan ?? "").trim() || "(kosong)"}"`,
    ),
  );

  // -------------------------------------------------------
  // 3. NOMOR IDENTITAS
  // -------------------------------------------------------

  // NIP ASN 18 digit, NIK 16 digit. Panjangnya saja sudah
  // memberi petunjuk kuat isi field nip sebenarnya apa.
  const panjangNip = hitung(semua, (d) => {
    const v = String(d.nip ?? "").trim();

    if (!v) return "(kosong)";

    const digit = v.replace(/\D/g, "").length;

    let dugaan = "";
    if (digit === 18) dugaan = "  ← panjang NIP ASN";
    else if (digit === 16) dugaan = "  ← panjang NIK";

    return `${v.length} karakter / ${digit} digit${dugaan}`;
  });

  tabel("PANJANG ISI FIELD nip", panjangNip);

  const nipKosong = semua.filter((d) => !String(d.nip ?? "").trim());

  console.log(`\nDokumen dengan nip kosong: ${nipKosong.length}`);

  for (const d of nipKosong.slice(0, 20)) {
    console.log(
      `  - ${d.nama || "(tanpa nama)"} | ${d.kategori_pegawai || "-"} | wa ${d.no_wa || "-"}`,
    );
  }

  // Duplikat nip berbahaya: pencarian atasan dan penanda
  // peminjam kendaraan sama-sama memakai nip sebagai kunci.
  const petaNip = new Map();

  for (const d of semua) {
    const v = String(d.nip ?? "").trim();

    if (!v) continue;

    if (!petaNip.has(v)) petaNip.set(v, []);

    petaNip.get(v).push(d.nama || "(tanpa nama)");
  }

  const duplikat = [...petaNip.entries()].filter(([, n]) => n.length > 1);

  console.log(`\nNilai nip yang dipakai lebih dari satu orang: ${duplikat.length}`);

  for (const [v, nama] of duplikat) {
    console.log(`  - ${samarkan(v)} dipakai oleh: ${nama.join(", ")}`);
  }

  // -------------------------------------------------------
  // 4. TIMGUDANG
  // -------------------------------------------------------

  const gudang = semua.filter((d) => d.kategori_pegawai === "TimGudang");

  console.log(`\n=== ANGGOTA TimGudang: ${gudang.length} ===`);

  for (const d of gudang) {
    const digit = String(d.nip ?? "").replace(/\D/g, "").length;

    const dugaan =
      digit === 18 ? "ASN?" : digit === 16 ? "PPNPN/Magang?" : "tidak jelas";

    console.log(
      `  - ${(d.nama || "(tanpa nama)").padEnd(28)} ` +
        `nip ${samarkan(d.nip).padEnd(20)} dugaan status: ${dugaan}`,
    );
  }

  // -------------------------------------------------------
  // 5. RANTAI ATASAN
  // -------------------------------------------------------

  const semuaNip = new Set(
    semua.map((d) => String(d.nip ?? "").trim()).filter(Boolean),
  );

  const atasanPutus = semua.filter((d) => {
    const a = String(d.atasan_nip ?? "").trim();

    return a && a !== "-" && !semuaNip.has(a);
  });

  const tanpaAtasan = semua.filter((d) => {
    const a = String(d.atasan_nip ?? "").trim();

    return !a || a === "-";
  });

  console.log("\n=== RANTAI ATASAN ===");
  console.log(`  Tanpa atasan_nip           : ${tanpaAtasan.length}`);
  console.log(`  atasan_nip tidak ditemukan : ${atasanPutus.length}`);

  for (const d of atasanPutus.slice(0, 15)) {
    console.log(
      `    - ${d.nama || "(tanpa nama)"} → menunjuk ${samarkan(d.atasan_nip)}`,
    );
  }

  // -------------------------------------------------------
  // 6. NOMOR WHATSAPP
  // -------------------------------------------------------

  // no_wa sudah jadi kunci de-facto: login aplikasi presensi,
  // pencarian pegawai di bot, dan setiap dokumen absensi
  // memakai nomor ini.
  const waKosong = semua.filter((d) => !String(d.no_wa ?? "").trim());

  const petaWa = new Map();

  for (const d of semua) {
    const digit = String(d.no_wa ?? "").replace(/\D/g, "");

    if (!digit) continue;

    const norm = digit.startsWith("0")
      ? `62${digit.slice(1)}`
      : digit.startsWith("62")
        ? digit
        : `62${digit}`;

    if (!petaWa.has(norm)) petaWa.set(norm, []);

    petaWa.get(norm).push(d.nama || "(tanpa nama)");
  }

  const waDuplikat = [...petaWa.entries()].filter(([, n]) => n.length > 1);

  console.log("\n=== NOMOR WHATSAPP ===");
  console.log(`  no_wa kosong  : ${waKosong.length}`);

  for (const d of waKosong.slice(0, 15)) {
    console.log(`    - ${d.nama || "(tanpa nama)"} | ${d.kategori_pegawai || "-"}`);
  }

  console.log(`  no_wa duplikat: ${waDuplikat.length}`);

  for (const [v, nama] of waDuplikat) {
    console.log(`    - …${v.slice(-4)} dipakai oleh: ${nama.join(", ")}`);
  }

  tabel(
    "FORMAT PENULISAN no_wa",
    hitung(semua, (d) => {
      const v = String(d.no_wa ?? "").trim();

      if (!v) return "(kosong)";
      if (/^62\d+$/.test(v)) return "62xxxxxxxxxx";
      if (/^0\d+$/.test(v)) return "08xxxxxxxxxx";
      if (/^\+62/.test(v)) return "+62 …";

      return "format lain";
    }),
  );

  console.log(
    "\nSelesai. Tidak ada dokumen yang diubah oleh skrip ini.",
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("❌ Gagal:", err);

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});
