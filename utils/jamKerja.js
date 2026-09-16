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

// Jabatan yang jam kerjanya mengikuti tugas, bukan jam kantor.
//
// Supir mengantar pejabat: berangkat pukul 09.00 dan baru selesai
// pukul 20.00 kalau memang begitu jadwal antarnya. Menerapkan jam
// masuk, jam harus pulang, keterlambatan, dan lembur kantor
// kepadanya sama saja menghukum orang karena mengikuti perintah.
//
// Berbeda dari dinas luar, ini melekat pada ORANGNYA, bukan pada
// jenis kehadiran yang dipilih hari itu.
const JABATAN_BEBAS_JAM_KERJA = (
  process.env.JABATAN_BEBAS_JAM_KERJA || "supir,sopir,pengemudi,driver"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function jabatanBebasJamKerja(jabatan) {
  return JABATAN_BEBAS_JAM_KERJA.includes(
    String(jabatan || "").trim().toLowerCase(),
  );
}

// Jabatan yang lemburnya otomatis, tanpa pengajuan dan tanpa
// persetujuan atasan.
//
// Petugas kebersihan selalu pulang paling akhir: ruangan baru
// bisa dibersihkan setelah pegawai lain pergi. Lemburnya bukan
// kejadian luar biasa yang perlu diajukan dan disetujui satu per
// satu, melainkan bentuk pekerjaannya sehari-hari. Menyuruh
// mereka mengajukan izin tiap malam untuk sesuatu yang memang
// jadi tugasnya hanya menambah pekerjaan administrasi bagi orang
// yang paling tidak punya waktu untuk itu.
//
// Yang tetap dicatat adalah KINERJA LEMBUR-nya — apa yang
// dikerjakan selama jam itu — supaya lembur ini tetap bisa
// dipertanggungjawabkan meski tidak melewati persetujuan.
//
// Berbeda dari supir: jam kantornya tetap berlaku bagi petugas
// kebersihan (ada jam masuk, ada jam harus checkout, ada
// keterlambatan). Yang berubah hanya cara lemburnya diakui.
const JABATAN_LEMBUR_OTOMATIS = (
  process.env.JABATAN_LEMBUR_OTOMATIS || "petugas kebersihan"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function jabatanLemburOtomatis(jabatan) {
  return JABATAN_LEMBUR_OTOMATIS.includes(
    String(jabatan || "").trim().toLowerCase(),
  );
}

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

  const dinasLuar = TANPA_JAM_PULANG.includes(
    String(baris.attendanceType || "").toUpperCase(),
  );

  // Dua jalan menuju "tidak terikat jam kantor": jenis kehadiran
  // hari itu (dinas luar) atau jabatannya (supir). Bedanya cuma
  // pada Menit Kerja — lihat catatan di bawah.
  const bebasJadwal = dinasLuar || baris.bebasJamKerja === true;

  // Lembur baru dihitung kalau atasan sudah menyetujuinya. Pulang
  // lewat dari jam harus checkout tanpa persetujuan tercatat
  // "00.00" — bukan kosong: kosong berarti aturannya tidak
  // berlaku (dinas luar), nol berarti tidak ada lembur. Jam pulang
  // aslinya tetap terlihat di kolom Checkout.
  // Dua jalan menuju lembur yang diakui: disetujui atasan lewat
  // bot, atau melekat pada jabatannya (petugas kebersihan).
  const lemburBerlaku =
    baris.lemburDisetujui === true || baris.lemburOtomatis === true;

  return {
    jamHarusCheckout: bebasJadwal ? "" : jamDariMenit(harusCheckout),
    jamMasukJadwal: JAM_MASUK,
    jamToleransiMasuk: jamDariMenit(toleransiMasuk),

    // Jadwal pulang kantor tetap dikembalikan meski jenisnya
    // dinas luar: penjadwal pengingat memakainya sebagai acuan
    // kapan mulai menegur, supaya absensi dinas luar tidak
    // diam-diam menggantung sampai lewat tengah malam.
    jamPulangJadwal: jamDariMenit(pulang),
    jamToleransiPulang: jamDariMenit(pulang + TOLERANSI_MENIT),

    // "Terlambat" mengukur keterlambatan datang ke kantor —
    // tidak bermakna bagi yang jamnya mengikuti tugas.
    terlambat: bebasJadwal || terlambat === null ? "" : terlambat,

    // Menit Kerja hanya dikosongkan untuk DINAS LUAR, karena
    // rumusnya memotong jam istirahat kantor yang tidak dijalani
    // di tempat tugas. Untuk supir tetap dihitung: berapa lama ia
    // bertugas hari itu justru angka yang paling berguna, dan
    // istirahatnya tetap ada di sela mengantar.
    menitKerja: dinasLuar || menitKerja === null ? "" : menitKerja,

    durasiLembur:
      bebasJadwal || durasiLembur === null
        ? ""
        : jamDariMenit(lemburBerlaku ? durasiLembur : 0),
    pembulatanLembur:
      bebasJadwal || pembulatanLembur === null
        ? ""
        : jamDariMenit(lemburBerlaku ? pembulatanLembur : 0),
  };
}


module.exports = {
  JAM_MASUK,
  TANPA_JAM_PULANG,
  JABATAN_BEBAS_JAM_KERJA,
  jabatanBebasJamKerja,
  JABATAN_LEMBUR_OTOMATIS,
  jabatanLemburOtomatis,
  TOLERANSI_MENIT,
  MENIT_KERJA_WAJIB,
  ISTIRAHAT,
  menitDariJam,
  jamDariMenit,
  hariJumat,
  hitungJamKerja,
};
