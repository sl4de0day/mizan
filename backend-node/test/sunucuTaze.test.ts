import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendHazir } from './_canli.js';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const KOK = join(dirname(fileURLToPath(import.meta.url)), '..');
const saglik = (await backendHazir())
  ? await fetch('http://localhost:8000/health', { signal: AbortSignal.timeout(4000) })
      .then((r) => r.json() as Promise<{ basladi?: string }>)
      .catch(() => null)
  : null;

function enYeniKaynak(dir: string): number {
  let en = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) en = Math.max(en, enYeniKaynak(p));
    else if (e.name.endsWith('.ts')) en = Math.max(en, statSync(p).mtimeMs);
  }
  return en;
}

test('S1: canlı sunucu, en son kaynak değişikliğinden SONRA başlamış (bayat süreç değil)', { skip: !saglik && 'backend kapalı' }, () => {
  assert.ok(saglik?.basladi, '/health `basladi` damgası döndürmüyor — tazelik ölçülemiyor');

  const sunucu = new Date(saglik.basladi).getTime();
  const kaynak = enYeniKaynak(join(KOK, 'src'));
  assert.ok(
    sunucu > kaynak,
    `🔴 BAYAT SUNUCU: süreç ${new Date(sunucu).toISOString()}'te başlamış, ama src/ ` +
      `${new Date(kaynak).toISOString()}'te değişmiş. Canlı testler ESKİ KODU sınıyor — ` +
      'sunucuyu yeniden başlat (port gerçekten bağlandı mı diye EADDRINUSE\'a bak).',
  );
});
