import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getGlobalDispatcher } from 'undici';
import { applyProxyConfig, httpFetch, proxyUrlForKaynak, setKaynakProxyUrlleri } from '../src/lib/http.js';

test('applyProxyConfig: proxy verilince dispatcher GERÇEKTEN değişir, kaldırılınca eski hâline döner', () => {
  const varsayilan = getGlobalDispatcher();

  applyProxyConfig('http://127.0.0.1:1');
  const proxyli = getGlobalDispatcher();
  assert.notEqual(proxyli, varsayilan, 'proxy verildiğinde dispatcher değişmedi — özellik yine sessizce hiçbir şey yapmıyor olabilir');
  assert.equal(proxyli.constructor.name, 'ProxyAgent', 'undici ProxyAgent değil');

  applyProxyConfig(undefined);
  const geriDonus = getGlobalDispatcher();
  assert.equal(geriDonus, varsayilan, 'proxy kaldırıldığında ORİJİNAL varsayılana dönmedi — eski kod bu durumu hiç temizlemiyordu (bkz. adminOps.ts proxyUygula notu), bu regresyonun aynısı geri gelmiş olabilir');
});

test('proxyUrlForKaynak: tanımsız kaynak undefined döner, setKaynakProxyUrlleri anında günceller', () => {
  assert.equal(proxyUrlForKaynak('tuik'), undefined);
  setKaynakProxyUrlleri({ tuik: 'http://127.0.0.1:9', aym: 'http://127.0.0.1:8' });
  assert.equal(proxyUrlForKaynak('tuik'), 'http://127.0.0.1:9');
  assert.equal(proxyUrlForKaynak('aym'), 'http://127.0.0.1:8');
  assert.equal(proxyUrlForKaynak('ysk'), undefined, 'atanmamış kaynak hâlâ undefined olmalı');
  setKaynakProxyUrlleri({});
  assert.equal(proxyUrlForKaynak('tuik'), undefined, 'boş harita ile çağrılınca ESKİ atamalar temizlenmeli');
});

function sahteProxy(isim: string): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on('connect', (_req, clientSocket) => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      clientSocket.once('data', () => {
        const govde = `BEN ${isim}`;
        clientSocket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${govde.length}\r\nConnection: close\r\n\r\n${govde}`);
        clientSocket.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function proxyUrlOf(s: Server): string {
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

test('httpFetch per-call proxyUrl: eşzamanlı farklı proxy\'ler ÇAPRAZ BULAŞMADAN doğru yönlendirilir, global dispatcher DOKUNULMAZ', async () => {
  const [proxyA, proxyB] = await Promise.all([sahteProxy('A'), sahteProxy('B')]);
  try {
    const dispatcherOnce = getGlobalDispatcher();

    const [rA, rB] = await Promise.all([
      httpFetch('http://ornek-hedef-A.invalid/yol-a', { proxyUrl: proxyUrlOf(proxyA) }),
      httpFetch('http://ornek-hedef-B.invalid/yol-b', { proxyUrl: proxyUrlOf(proxyB) }),
    ]);
    assert.equal(await rA.text(), 'BEN A');
    assert.equal(await rB.text(), 'BEN B');
    assert.equal(getGlobalDispatcher(), dispatcherOnce, 'per-call proxy GLOBAL dispatcher\'a dokunmamalı — dokunursa Faz 3\'ün reddettiği yarış-durumu riski geri gelmiş olabilir');
  } finally {
    proxyA.close(); proxyB.close();
  }
});

test('httpFetch per-call proxyUrl: 10 eşzamanlı karışık A/B çağrısının hepsi doğru proxy\'ye gider', async () => {
  const [proxyA, proxyB] = await Promise.all([sahteProxy('A'), sahteProxy('B')]);
  try {
    const urlA = proxyUrlOf(proxyA), urlB = proxyUrlOf(proxyB);
    const sonuclar = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const proxyUrl = i % 2 === 0 ? urlA : urlB;
        const beklenen = i % 2 === 0 ? 'BEN A' : 'BEN B';
        return httpFetch(`http://ornek-hedef-${i}.invalid/yol`, { proxyUrl }).then((r) => r.text()).then((t) => t === beklenen);
      }),
    );
    assert.ok(sonuclar.every(Boolean), `çapraz bulaşma tespit edildi: ${JSON.stringify(sonuclar)}`);
  } finally {
    proxyA.close(); proxyB.close();
  }
});

test('httpFetch per-call proxyUrl: çalışan proxy başarılı, kapalı port ECONNREFUSED ile başarısız — eşzamanlı, birbirini etkilemeden', async () => {
  const proxyA = await sahteProxy('A');
  try {
    const sonuclar = await Promise.allSettled([
      httpFetch('http://ornek-hedef-A2.invalid/yol-a', { proxyUrl: proxyUrlOf(proxyA) }),
      httpFetch('http://ornek-hedef-C.invalid/yol-c', { proxyUrl: 'http://127.0.0.1:1', timeoutMs: 3000 }),
    ]);
    assert.equal(sonuclar[0].status, 'fulfilled', 'çalışan proxy başarısız oldu — kapalı-port isteğinden etkilenmiş olabilir');
    assert.equal(sonuclar[1].status, 'rejected', 'kapalı port isteği başarılı döndü — ECONNREFUSED bekleniyordu');
  } finally {
    proxyA.close();
  }
});
