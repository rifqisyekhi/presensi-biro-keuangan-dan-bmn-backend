// =========================================================
// ANALISA RADIUS ABSENSI
// =========================================================
//
// Menjawab pertanyaan "radiusnya berapa meter?" dengan data,
// bukan tebakan.
//
// Cara kerjanya: mengambil semua koordinat Clock In WFO yang
// sudah tersimpan, mencari titik tengahnya (median — tahan
// terhadap satu-dua data nyasar), lalu melihat sebaran jarak
// setiap absensi dari titik itu.
//
// PEMAKAIAN
//
//   node scripts/analisa-radius.js
//   node scripts/analisa-radius.js --jenis WFO,DINAS
//   node scripts/analisa-radius.js --dari 2026-09-01
//   node scripts/analisa-radius.js --pusat -6.236990,106.830554 --radius 500
//
// Titik pusatnya diambil dari --pusat, kalau tidak ada dari
// KANTOR_LAT/KANTOR_LNG di .env, kalau tidak ada juga baru
// dari median koordinat absensi. Radiusnya dari --radius atau
// RADIUS_METER.
//
// Berguna untuk uji coba sebelum menyalakan RADIUS_MODE:
// berapa absensi yang sudah terjadi ternyata akan ditolak
// kalau aturannya diberlakukan.
//
// Skrip ini hanya membaca. Tidak ada yang diubah.

require("dotenv").config();

const mongoose = require("mongoose");

const Absensi = require("../models/Absensi");
const { jarakMeter } = require("../utils/lokasi");

function argumen(nama, bawaan) {
  const i = process.argv.indexOf(`--${nama}`);

  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : bawaan;
}

const JENIS = argumen("jenis", "WFO")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const DARI = argumen("dari", null);

function median(angka) {
  const urut = [...angka].sort((a, b) => a - b);
  const t = Math.floor(urut.length / 2);

  return urut.length % 2 ? urut[t] : (urut[t - 1] + urut[t]) / 2;
}

function persentil(angka, p) {
  if (!angka.length) return 0;

  const urut = [...angka].sort((a, b) => a - b);
  const i = Math.min(
    urut.length - 1,
    Math.ceil((p / 100) * urut.length) - 1,
  );

  return urut[Math.max(0, i)];
}

function batang(nilai, maks, lebar = 30) {
  const n = maks > 0 ? Math.round((nilai / maks) * lebar) : 0;

  return "█".repeat(n) || "▏";
}

async function main() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error("❌ MONGODB_URI belum diset di file .env");
    process.exit(1);
  }

  await mongoose.connect(uri);

  const filter = {
    attendanceType: { $in: JENIS },
    "clockInLocation.lat": { $ne: null },
  };

  if (DARI) filter.tanggal = { $gte: DARI };

  const semua = await Absensi.find(filter).lean();

  const titik = semua
    .map((a) => ({
      nama: a.nama,
      tanggal: a.tanggal,
      lat: Number(a.clockInLocation?.lat),
      lng: Number(a.clockInLocation?.lng),
    }))
    .filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lng));

  console.log(`Jenis kehadiran : ${JENIS.join(", ")}`);
  console.log(`Sejak tanggal   : ${DARI || "(semua)"}`);
  console.log(`Absensi berkoordinat : ${titik.length}\n`);

  if (titik.length < 3) {
    console.log(
      "Data terlalu sedikit untuk menyimpulkan apa pun.\n\n" +
        "Jalankan backend dengan RADIUS_MODE=warn selama satu-dua\n" +
        "minggu supaya jaraknya tercatat di log, lalu ulangi skrip\n" +
        "ini setelah datanya cukup.",
    );

    await mongoose.disconnect();
    return;
  }

  // Median dipakai, bukan rata-rata: satu absensi dari luar
  // kota akan menggeser rata-rata cukup jauh, median tidak.
  const medianLat = median(titik.map((t) => t.lat));
  const medianLng = median(titik.map((t) => t.lng));

  // Titik pusat: argumen > .env > median data.
  const argPusat = argumen("pusat", null);

  let pusatLat = medianLat;
  let pusatLng = medianLng;
  let asalPusat = "median koordinat absensi";

  if (argPusat) {
    const [a, b] = argPusat.split(",").map((s) => Number(s.trim()));

    if (Number.isFinite(a) && Number.isFinite(b)) {
      pusatLat = a;
      pusatLng = b;
      asalPusat = "argumen --pusat";
    } else {
      console.error("⚠️  --pusat tidak terbaca, dipakai median data.\n");
    }
  } else if (
    Number.isFinite(Number(process.env.KANTOR_LAT)) &&
    Number.isFinite(Number(process.env.KANTOR_LNG)) &&
    process.env.KANTOR_LAT !== "" &&
    process.env.KANTOR_LNG !== ""
  ) {
    pusatLat = Number(process.env.KANTOR_LAT);
    pusatLng = Number(process.env.KANTOR_LNG);
    asalPusat = "KANTOR_LAT/KANTOR_LNG di .env";
  }

  // Kalau titik yang dipakai bukan median, jarak keduanya
  // patut diperiksa: selisih yang besar berarti selama ini
  // banyak absensi terjadi jauh dari koordinat kantor.
  const selisihMedian = Math.round(
    jarakMeter(pusatLat, pusatLng, medianLat, medianLng),
  );

  const jarak = titik
    .map((t) => ({
      ...t,
      jarak: Math.round(jarakMeter(pusatLat, pusatLng, t.lat, t.lng)),
    }))
    .sort((a, b) => a.jarak - b.jarak);

  const angka = jarak.map((j) => j.jarak);

  console.log(`=== TITIK PUSAT (${asalPusat}) ===`);
  console.log(`KANTOR_LAT=${pusatLat.toFixed(6)}`);
  console.log(`KANTOR_LNG=${pusatLng.toFixed(6)}`);
  console.log(
    `Peta: https://www.openstreetmap.org/?mlat=${pusatLat.toFixed(6)}&mlon=${pusatLng.toFixed(6)}#map=18/${pusatLat.toFixed(6)}/${pusatLng.toFixed(6)}`,
  );

  if (asalPusat !== "median koordinat absensi") {
    console.log(
      `\nMedian koordinat absensi: ${medianLat.toFixed(6)}, ${medianLng.toFixed(6)}\n` +
        `Selisih dari titik pusat : ${selisihMedian} m` +
        (selisihMedian > 300
          ? "  ← jauh, periksa apakah koordinat kantornya benar"
          : ""),
    );
  }

  console.log("\n=== SEBARAN JARAK DARI TITIK PUSAT ===");
  for (const p of [50, 75, 90, 95, 100]) {
    const nilai = persentil(angka, p);
    const label = p === 100 ? "maks" : `p${p} `;

    console.log(
      `  ${label}  ${String(nilai).padStart(5)} m  ${batang(nilai, angka[angka.length - 1])}`,
    );
  }

  console.log("\n=== LIMA TERJAUH ===");
  for (const j of jarak.slice(-5).reverse()) {
    console.log(
      `  ${String(j.jarak).padStart(6)} m  ${j.tanggal}  ${j.nama || "-"}`,
    );
  }

  // Radius yang mau diuji: argumen > .env > usulan dari data.
  //
  // Usulan diambil dari p95 lalu dibulatkan ke atas per 50 m,
  // dengan lantai 100 m. Lantai itu penting: GPS ponsel di
  // dalam gedung beton biasa meleset 20–50 m, jadi radius yang
  // lebih ketat akan menolak orang yang benar-benar duduk di
  // mejanya.
  const usul = Math.max(100, Math.ceil(persentil(angka, 95) / 50) * 50);

  const argRadius = Number(
    argumen("radius", process.env.RADIUS_METER || ""),
  );

  const radiusUji =
    Number.isFinite(argRadius) && argRadius > 0 ? argRadius : usul;

  const masuk = angka.filter((a) => a <= radiusUji).length;
  const tertolak = angka.length - masuk;

  console.log(`\n=== UJI COBA RADIUS ${radiusUji} m ===`);
  console.log(
    `  Diterima : ${masuk} dari ${angka.length} ` +
      `(${Math.round((masuk / angka.length) * 100)}%)`,
  );
  console.log(`  Ditolak  : ${tertolak}`);

  if (tertolak) {
    console.log("\n  Yang akan ditolak:");

    for (const j of jarak.filter((x) => x.jarak > radiusUji)) {
      console.log(
        `    ${String(j.jarak).padStart(6)} m  ${j.tanggal}  ${j.nama || "-"}`,
      );
    }

    console.log(
      "\n  Periksa dulu satu per satu sebelum memakai mode enforce —\n" +
        "  kalau ternyata mereka memang di kantor, radiusnya yang\n" +
        "  terlalu ketat, bukan absensinya yang salah.",
    );
  }

  if (radiusUji !== usul) {
    console.log(`\n  Usulan dari sebaran data: RADIUS_METER=${usul}`);
  }

  if (titik.length < 30) {
    console.log(
      `\n⚠️  Baru ${titik.length} data. Angka di atas masih rapuh —\n` +
        "    pakai dulu dengan RADIUS_MODE=warn, jangan langsung enforce.",
    );
  }

  console.log(
    "\nCatatan: titik tengah di atas berasal dari absensi yang sudah\n" +
      "terjadi, jadi kalau selama ini ada yang absen dari luar kantor,\n" +
      "titiknya ikut tergeser. Bandingkan dengan lokasi kantor yang\n" +
      "sebenarnya di peta sebelum dipakai.",
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
