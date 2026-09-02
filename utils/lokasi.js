// =========================================================
// BATAS RADIUS LOKASI ABSENSI
// =========================================================
//
// Hanya berlaku untuk WFO. WFH dan Dinas Luar memang
// dikerjakan di luar kantor, jadi memeriksanya justru salah.
//
// TIGA MODE (env RADIUS_MODE):
//
//   off     — tidak diperiksa sama sekali (bawaan)
//   warn    — jarak dicatat ke log, absensi tetap diterima
//   enforce — absensi di luar radius ditolak
//
// Mulailah dari "warn" selama satu-dua minggu, jalankan
// scripts/analisa-radius.js untuk melihat sebaran jaraknya,
// baru pindah ke "enforce" dengan angka yang berdasar data.
// Radius yang ditebak terlalu ketat akan menolak pegawai yang
// benar-benar ada di kantor — GPS di dalam gedung beton
// mudah meleset puluhan meter.

const MODE = (process.env.RADIUS_MODE || "off").toLowerCase();

const KANTOR_LAT = Number(process.env.KANTOR_LAT);
const KANTOR_LNG = Number(process.env.KANTOR_LNG);

const RADIUS_METER = Number(process.env.RADIUS_METER || 150);

// Jenis kehadiran yang diperiksa. Sengaja daftar, bukan
// "selain WFH", supaya jenis baru tidak ikut terjaring tanpa
// disadari.
const JENIS_DIPERIKSA = ["WFO"];

// =========================================================
// JARAK DUA KOORDINAT
// =========================================================

// Rumus haversine. Untuk jarak sependek ini (ratusan meter)
// selisihnya dengan perhitungan elipsoid tidak berarti.

function jarakMeter(lat1, lng1, lat2, lng2) {
  const R = 6371000;

  const rad = (d) => (d * Math.PI) / 180;

  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) *
      Math.cos(rad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

function terkonfigurasi() {
  return (
    Number.isFinite(KANTOR_LAT) &&
    Number.isFinite(KANTOR_LNG) &&
    Number.isFinite(RADIUS_METER) &&
    RADIUS_METER > 0
  );
}

// =========================================================
// PEMERIKSAAN
// =========================================================

// Mengembalikan { diperiksa, jarak, dalamRadius, pesan }.
//
// diperiksa=false berarti tidak ada alasan menolak: mode off,
// koordinat kantor belum diisi, jenis kehadiran bukan WFO,
// atau pegawai tidak mengirim lokasi sama sekali. Yang
// terakhir sengaja tidak ditolak — kalau lokasi wajib, itu
// harus jadi aturan tersendiri yang jelas, bukan efek samping
// dari fitur radius.

function cekRadius({ attendanceType, lokasi }) {
  const hasilLolos = {
    diperiksa: false,
    jarak: null,
    dalamRadius: true,
    pesan: "",
  };

  if (MODE === "off") return hasilLolos;

  if (!terkonfigurasi()) {
    console.warn(
      "[RADIUS] RADIUS_MODE aktif tetapi KANTOR_LAT/KANTOR_LNG belum diisi — pemeriksaan dilewati.",
    );

    return hasilLolos;
  }

  if (!JENIS_DIPERIKSA.includes(attendanceType)) return hasilLolos;

  const lat = Number(lokasi?.lat);
  const lng = Number(lokasi?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return hasilLolos;
  }

  const jarak = Math.round(
    jarakMeter(KANTOR_LAT, KANTOR_LNG, lat, lng),
  );

  const dalamRadius = jarak <= RADIUS_METER;

  return {
    diperiksa: true,
    jarak,
    dalamRadius,
    pesan: dalamRadius
      ? ""
      : `Lokasi Anda ${jarak} meter dari kantor, melebihi batas ${RADIUS_METER} meter untuk absensi WFO.`,
  };
}

module.exports = {
  MODE,
  RADIUS_METER,
  KANTOR_LAT,
  KANTOR_LNG,
  JENIS_DIPERIKSA,
  jarakMeter,
  cekRadius,
};
