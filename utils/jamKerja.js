// =========================================================
// PERHITUNGAN JAM KERJA
// =========================================================
//
// Ketentuan hari dan jam kerja: 7,5 jam sehari, hadir pukul
// 07.30, pulang 16.00 pada Senin–Kamis dengan istirahat 1 jam
// (12.00–13.00), dan pulang 16.30 pada Jumat dengan istirahat
// 1,5 jam (11.30–13.00). Toleransi 60 menit.
//
// Non-ASN tidak dikenai potongan, jadi kolom Persentase
// Potongan dan turunannya sengaja tidak ada di rekap ini.

const JAM_MASUK = "07.30";
const TOLERANSI_MENIT = 60;

const MENIT_KERJA_WAJIB = 450; // 7,5 jam

const ISTIRAHAT = { biasa: 60, jumat: 90 };

function menitDariJam(nilai) {
  const cocok = /^(\d{1,2})[.:](\d{2})$/.exec(String(nilai || "").trim());

  if (!cocok) return null;

  return Number(cocok[1]) * 60 + Number(cocok[2]);
}

function jamDariMenit(menit) {
  if (menit === null || !Number.isFinite(menit)) return "";

  const m = ((Math.round(menit) % 1440) + 1440) % 1440;

  return (
    `${String(Math.floor(m / 60)).padStart(2, "0")}.` +
    `${String(m % 60).padStart(2, "0")}`
  );
}

function hariJumat(tanggal) {
  const waktu = Date.parse(`${tanggal}T00:00:00Z`);

  return !Number.isNaN(waktu) && new Date(waktu).getUTCDay() === 5;
}

// Jenis kehadiran yang tidak terikat jam pulang kantor.
// Dinas luar mengikuti jadwal kegiatan di tempat tujuan, jadi
// "Jam Harus Checkout" tidak berlaku — dan karena lembur
// dihitung dari selisih terhadap jam itu, lemburnya ikut tidak
// terdefinisi. Dikosongkan, bukan diisi nol: nol berarti
// "tidak lembur", kosong berarti "tidak berlaku".
const TANPA_JAM_PULANG = ["DINAS"];

// Menghitung kolom-kolom jam kerja untuk satu baris absensi.
function hitungJamKerja(baris) {
  const jumat = hariJumat(baris.tanggal);

  const istirahat = jumat ? ISTIRAHAT.jumat : ISTIRAHAT.biasa;

  const masuk = menitDariJam(JAM_MASUK);
  const toleransiMasuk = masuk + TOLERANSI_MENIT;

  // 7,5 jam kerja + istirahat. Senin–Kamis 07.30 + 8,5 jam =
  // 16.00; Jumat 07.30 + 9 jam = 16.30.
  const pulang = masuk + MENIT_KERJA_WAJIB + istirahat;

  const checkin = menitDariJam(baris.jamMasuk);
  const checkout = menitDariJam(baris.jamPulang);

  // Datang lebih awal tidak memajukan jam pulang: hitungannya
  // mulai dari jam masuk resmi.
  const harusCheckout =
    checkin === null
      ? null
      : Math.max(checkin, masuk) + MENIT_KERJA_WAJIB + istirahat;

  const terlambat =
    checkin === null ? null : Math.max(0, checkin - toleransiMasuk);

  const menitKerja =
    checkin === null || checkout === null
      ? null
      : Math.max(0, checkout - checkin - istirahat);

  // Lembur dihitung dari kelebihan waktu terhadap Jam Harus
  // Checkout, bukan dari pengajuan lembur di menu bot. Rumus
  // ini disalin dari berkas rekap yang dipakai Biro dan sudah
  // dicocokkan dengan isinya baris per baris.
  const durasiLembur =
    checkout === null || harusCheckout === null
      ? null
      : Math.max(0, checkout - harusCheckout);

  // Dibulatkan ke bawah per satu jam penuh: 3 jam 37 menit
  // dihitung 3 jam, 35 menit dihitung nol.
  const pembulatanLembur =
    durasiLembur === null ? null : Math.floor(durasiLembur / 60) * 60;

  const tanpaJamPulang = TANPA_JAM_PULANG.includes(
    String(baris.attendanceType || "").toUpperCase(),
  );

  return {
    jamHarusCheckout: tanpaJamPulang ? "" : jamDariMenit(harusCheckout),
    jamMasukJadwal: JAM_MASUK,
    jamToleransiMasuk: jamDariMenit(toleransiMasuk),

    // Jadwal pulang kantor tetap dikembalikan meski jenisnya
    // dinas luar: penjadwal pengingat memakainya sebagai acuan
    // kapan mulai menegur, supaya absensi dinas luar tidak
    // diam-diam menggantung sampai lewat tengah malam.
    jamPulangJadwal: jamDariMenit(pulang),
    jamToleransiPulang: jamDariMenit(pulang + TOLERANSI_MENIT),

    // Ikut dikosongkan untuk dinas luar: "terlambat" mengukur
    // keterlambatan datang ke kantor, dan "menit kerja"
    // mengandaikan jam istirahat kantor — keduanya tidak
    // bermakna bagi orang yang memang bertugas di luar.
    terlambat: tanpaJamPulang || terlambat === null ? "" : terlambat,
    menitKerja: tanpaJamPulang || menitKerja === null ? "" : menitKerja,

    durasiLembur:
      tanpaJamPulang || durasiLembur === null
        ? ""
        : jamDariMenit(durasiLembur),
    pembulatanLembur:
      tanpaJamPulang || pembulatanLembur === null
        ? ""
        : jamDariMenit(pembulatanLembur),
  };
}


module.exports = {
  JAM_MASUK,
  TANPA_JAM_PULANG,
  TOLERANSI_MENIT,
  MENIT_KERJA_WAJIB,
  ISTIRAHAT,
  menitDariJam,
  jamDariMenit,
  hariJumat,
  hitungJamKerja,
};
