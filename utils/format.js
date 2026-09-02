// =========================================================
// NORMALISASI NOMOR DAN TANGGAL
// =========================================================
//
// Dipakai bersama oleh routes/absensiRoutes.js dan
// routes/rekapRoutes.js. Sengaja satu sumber: daftar nomor
// petugas yang boleh mengunduh rekap dibandingkan dengan
// nomor pegawai memakai fungsi yang sama persis, jadi kalau
// aturan normalisasinya berubah, tidak ada satu sisi pun yang
// tertinggal.

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
// BULAN (YYYY-MM)
// =========================================================

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

module.exports = {
  normalizePhoneNumber,
  getToday,
  normalizeTanggal,
  normalizeBulan,
};
