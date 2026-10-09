import { getDb, partiDagilimiSnapshot, dagilimDiff, partiDagilimiOku } from '../lib/db.js';

const pf = (v: number, d = 2): string => v.toFixed(d).replace('.', ',');
const nf = (n: number): string => n.toLocaleString('tr-TR');

function liste(): void {
  const rows = getDb()
    .prepare(
      `SELECT olcum_zamani, not_metni, COUNT(*) satir, SUM(n) toplam
         FROM parti_dagilim_gecmis GROUP BY olcum_zamani ORDER BY olcum_zamani`,
    )
    .all() as unknown as { olcum_zamani: string; not_metni: string; satir: number; toplam: number }[];
  if (!rows.length) return console.log('Snapshot yok.');
  for (const r of rows)
    console.log(`${r.olcum_zamani}  ${String(r.satir).padStart(4)} satır  ${String(nf(r.toplam)).padStart(9)} kayıt  — ${r.not_metni ?? ''}`);
}

function canliDiff(oncekiDamga: string): void {
  const db = getDb();
  const onceki = db
    .prepare('SELECT kaynak,donem,parti,n FROM parti_dagilim_gecmis WHERE olcum_zamani=?')
    .all(oncekiDamga) as unknown as { kaynak: string; donem: number; parti: string; n: number }[];
  if (!onceki.length) { console.error(`Damga bulunamadı: ${oncekiDamga}`); process.exit(1); }

  const gecici = partiDagilimiSnapshot(`__gecici-diff (${oncekiDamga} karşılaştırması)`);
  try {
    yazdir(dagilimDiff(oncekiDamga, gecici), oncekiDamga, 'CANLI');
  } finally {
    db.prepare('DELETE FROM parti_dagilim_gecmis WHERE olcum_zamani=?').run(gecici);
  }
}

function yazdir(diff: ReturnType<typeof dagilimDiff>, a: string, b: string): void {
  console.log(`\n${a}\n  → ${b}\n`);
  if (!diff.length) return console.log('  Fark yok — parti dağılımı BİREBİR aynı.\n');

  const grupDeltaN = new Map<string, number>();
  for (const d of diff) grupDeltaN.set(`${d.kaynak}|${d.donem}`, (grupDeltaN.get(`${d.kaynak}|${d.donem}`) ?? 0) + d.deltaN);

  console.log('  kaynak/dönem  parti                Δn        pay: önce → sonra   Δpuan');
  console.log('  ' + '─'.repeat(74));
  for (const d of diff) {
    const isaret = d.deltaN > 0 ? '+' : '';
    console.log(
      `  ${(d.kaynak + '/' + d.donem).padEnd(13)} ${d.parti.padEnd(18)} ${(isaret + nf(d.deltaN)).padStart(8)}   ` +
      `${(pf(d.oncekiPay) + '%').padStart(7)} → ${(pf(d.simdikiPay) + '%').padStart(7)}  ${(d.deltaPay > 0 ? '+' : '') + pf(d.deltaPay)}`,
    );
  }

  const TASIMA_TABANI = 10;
  console.log();
  let alarm = 0;
  for (const [grup, dn] of grupDeltaN) {
    const grupDiff = diff.filter((d) => `${d.kaynak}|${d.donem}` === grup);
    const maxPay = Math.max(...grupDiff.map((d) => Math.abs(d.deltaPay)));
    const tasinan = grupDiff.reduce((s, d) => s + Math.abs(d.deltaN), 0) / 2;
    if (tasinan >= TASIMA_TABANI && Math.abs(dn) < tasinan * 0.5) {
      alarm++;
      console.log(
        `  🔴 YAPISAL YENİDEN ETİKETLEME — ${grup}: ~${nf(Math.round(tasinan))} satır el değiştirdi, ` +
        `net Δn=${dn > 0 ? '+' : ''}${dn} (~sabit) → yeni veri gelmedi, mevcut kayıtlar başka partiye yazıldı. ` +
        `En büyük pay kayması ${pf(maxPay)} puan. İNSAN ONAYI GEREKİR.`,
      );
    }
  }
  if (!alarm) console.log('  ✓ Yapısal yeniden etiketleme imzası yok (değişimler satır sayısıyla tutarlı).');
  console.log();
}

const [alt, ...arg] = process.argv.slice(2);
switch (alt) {
  case 'snapshot': {
    const not = arg.join(' ') || 'elle';
    const damga = partiDagilimiSnapshot(not);
    console.log(`Snapshot alındı: ${damga}\n  ${partiDagilimiOku().length} satır — "${not}"`);
    break;
  }
  case 'liste':
    liste();
    break;
  case 'diff': {
    if (!arg[0]) { console.error('Kullanım: dagilim diff <oncekiDamga> [simdikiDamga]'); process.exit(1); }
    if (arg[1]) yazdir(dagilimDiff(arg[0], arg[1]), arg[0], arg[1]);
    else canliDiff(arg[0]);
    break;
  }
  default:
    console.log('Alt komutlar: snapshot [not] · liste · diff <oncekiDamga> [simdikiDamga]');
}
