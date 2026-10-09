import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const KOK = join(dirname(fileURLToPath(import.meta.url)), '..');
const TABLO = join(KOK, '..', 'tablo');

function kodSatirlari(src: string): string {
  return src
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, ' ')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

function kayitliGruplar(): string[] {
  const src = kodSatirlari(readFileSync(join(KOK, 'src', 'index.ts'), 'utf8'));
  return [...src.matchAll(/register(\w+)Routes\s*\(\s*app\s*\)/g)].map((m) => m[1]!);
}

function frontendMetni(): string {
  return readdirSync(TABLO).filter((f) => /\.(html|js)$/.test(f))
    .map((f) => readFileSync(join(TABLO, f), 'utf8')).join('\n');
}

test('UY1: eski Python-portu katmanı KAYITLI DEĞİL', () => {
  const ESKI = ['Statistics', 'Gazette', 'Parliament', 'Constitutional', 'Milletvekili',
    'MilletvekiliStats', 'OnergeStats', 'KanunStats', 'TutanakAymStats'];
  const kayitli = kayitliGruplar();
  const geriAcilan = ESKI.filter((g) => kayitli.includes(g));
  assert.deepEqual(
    geriAcilan, [],
    `Eski katman geri açılmış: ${geriAcilan.join(', ')}\n` +
      'Bu gruplar TBMM/AYM/RG\'ye CANLI HTTP atıyor ve kimlik doğrulaması yok — dışarıdan tekrarlı ' +
      'istek WAF banına ve tüm veri hattının durmasına yol açabilir. Ayrıca ürettikleri sayılar ' +
      'DB katmanıyla tutmuyor. Geri açmadan önce DB tabanlı yeniden yazılmalı.',
  );
});

test('UY2: yayımlanan uç sayısı beklenen bantta (sessiz yüzey büyümesi yok)', () => {
  const dir = join(KOK, 'src', 'routes');
  let toplam = 0;
  const kayitli = kayitliGruplar().map((g) => g.charAt(0).toLowerCase() + g.slice(1));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const ad = f.replace('.ts', '');
    if (!kayitli.some((k) => k.toLowerCase() === ad.toLowerCase())) continue;
    toplam += [...kodSatirlari(readFileSync(join(dir, f), 'utf8'))
      .matchAll(/app\.(get|post|put|delete)\s*\(/g)].length;
  }
  assert.ok(toplam >= 30 && toplam <= 60,
    `yayımlanan uç sayısı bandın dışında: ${toplam} (beklenen ~51). Yüzey sessizce büyümüş olabilir.`);
});

test('UY3: sitenin çağırdığı her uç GERÇEKTEN yayımlanıyor', () => {
  const fe = frontendMetni();
  const yollar = new Set([...fe.matchAll(/['"`](\/api\/ozet\/[a-z-]+)/g)].map((m) => m[1]!));
  for (const m of fe.matchAll(/\bapi\(\s*['"`]([a-z-]+)['"`]/g)) yollar.add(`/api/ozet/${m[1]}`);
  assert.ok(yollar.size >= 15, `frontend uç taraması beklenenden az buldu: ${yollar.size}`);

  const ozet = kodSatirlari(readFileSync(join(KOK, 'src', 'routes', 'ozet.ts'), 'utf8'));
  const tanimli = new Set([...ozet.matchAll(/app\.\w+\s*\(\s*['"`](\/api\/ozet\/[a-z-]+)/g)].map((m) => m[1]!));
  const eksik = [...yollar].filter((y) => !tanimli.has(y));
  assert.deepEqual(eksik, [],
    `Sayfa var olmayan uca istek atıyor: ${eksik.join(', ')} — kart sessizce boş kalır.`);
});
