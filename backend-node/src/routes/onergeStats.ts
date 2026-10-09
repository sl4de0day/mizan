import type { FastifyInstance } from 'fastify';
import { MotionEngine, type MotionResult, type MotionStreamEvent } from '../engines/motion.js';
import { DEPUTY_MASTER_LIST } from '../lib/deputies.js';
import { cleanStr, PARTI_MAP, ALLOWED_PARTIES } from '../lib/partyResolve.js';

const motion = new MotionEngine();

interface CabinetEntry {
  id: string;
  label: string;
}

const CABINET_28_STATIC: CabinetEntry[] = [
  { id: 'e3ce1232-4307-435c-b361-4ae5c53ee75a', label: 'TBMM Başkanı Numan KURTULMUŞ' },
  { id: 'BD9FADF2-93BA-4A18-9979-01888F881D3A', label: 'Cumhurbaşkanı Yardımcısı Cevdet YILMAZ' },
  { id: '23CAA63B-EFC8-4E3A-8E8D-019C4D4F68FC', label: 'Adalet Bakanı Akın GÜRLEK' },
  { id: '050B9AA4-255A-4D83-8F36-01888F8AC96B', label: 'Aile Ve Sosyal Hizmetler Bakanı Mahinur ÖZDEMİR GÖKTAŞ' },
  { id: '30113760-2D92-4B49-B6B2-01888F8B7200', label: 'Çalışma Ve Sosyal Güvenlik Bakanı Vedat IŞIKHAN' },
  { id: 'F7C04932-84FF-48C2-A884-01907254761A', label: 'Çevre, Şehircilik Ve İklim Değişikliği Bakanı Murat KURUM' },
  { id: 'B268BD1D-0376-45DA-A9BA-01888F8D2BC0', label: 'Dışişleri Bakanı Hakan FİDAN' },
  { id: '33900F98-4F2F-49CD-8251-01888F8FA87B', label: 'Enerji Ve Tabii Kaynaklar Bakanı Alparslan BAYRAKTAR' },
  { id: '49F139E8-81CF-40FE-8BC6-01888F904AE4', label: 'Gençlik Ve Spor Bakanı Osman Aşkın BAK' },
  { id: '29669C6C-01A1-45D1-A3C5-01888F9110E4', label: 'Hazine Ve Maliye Bakanı Mehmet ŞİMŞEK' },
  { id: 'C37A0947-B190-4037-9D4C-019C4C9236E8', label: 'İçişleri Bakanı Mustafa ÇİFTÇİ' },
  { id: '82C6A9E5-0676-4C44-83E2-01888F92441E', label: 'Kültür Ve Turizm Bakanı Mehmet Nuri ERSOY' },
  { id: '193C5BCE-438F-4771-949A-01888F936251', label: 'Milli Eğitim Bakanı Yusuf TEKİN' },
  { id: '07041329-D38C-49C1-8E84-01888F93CF19', label: 'Milli Savunma Bakanı Yaşar GÜLER' },
  { id: '007A6836-79C8-4ECB-8152-01907343309E', label: 'Sağlık Bakanı Kemal MEMİŞOĞLU' },
  { id: 'E5FDEB55-8CD1-44AD-A06C-01888F952BB1', label: 'Sanayi Ve Teknoloji Bakanı Mehmet Fatih KACIR' },
  { id: 'E0C4FC5E-E037-4B3C-8D5A-01888F971079', label: 'Tarım Ve Orman Bakanı İbrahim YUMAKLI' },
  { id: 'D0AB6F77-A66F-45E2-A0BC-01888F97A58B', label: 'Ticaret Bakanı Ömer BOLAT' },
  { id: 'DF0A4762-181E-4EA4-86D7-01888F9889E4', label: 'Ulaştırma Ve Altyapı Bakanı Abdulkadir URALOĞLU' },
  { id: '9a5beffb-44c8-42f7-a64a-01888f8c99c6', label: 'x Önceki - Çevre, Şehircilik Ve İklim Değişikliği Bakanı Mehmet ÖZHASEKİ' },
  { id: '48addca0-945d-4886-9c2a-01888f94b1c9', label: 'x Önceki - Sağlık Bakanı Fahrettin KOCA' },
  { id: 'f47e3e8e-a4b6-4170-9edf-01888f89ce16', label: 'x Önceki - Adalet Bakanı Yılmaz TUNÇ' },
  { id: '2aa51e07-88d7-4642-bfac-01888f91aca1', label: 'x Önceki - İçişleri Bakanı Ali YERLİKAYA' },
];

const CABINET_27_STATIC: CabinetEntry[] = [
  { id: 'e3ce1232-4307-435c-b361-4ae5c53ee75a', label: 'TBMM Başkanı Mustafa ŞENTOP' },
  { id: 'BD9FADF2-93BA-4A18-9979-01888F881D3A', label: 'Cumhurbaşkanı Yardımcısı Fuat OKTAY' },
  { id: '23CAA63B-EFC8-4E3A-8E8D-019C4D4F68FC', label: 'Adalet Bakanı Bekir BOZDAĞ' },
  { id: '050B9AA4-255A-4D83-8F36-01888F8AC96B', label: 'Aile, Çalışma ve Sosyal Hizmetler Bakanı Zehra Zümrüt SELÇUK' },
  { id: '30113760-2D92-4B49-B6B2-01888F8B7200', label: 'Çevre ve Şehircilik Bakanı Murat KURUM' },
  { id: 'B268BD1D-0376-45DA-A9BA-01888F8D2BC0', label: 'Dışişleri Bakanı Mevlüt ÇAVUŞOĞLU' },
  { id: '33900F98-4F2F-49CD-8251-01888F8FA87B', label: 'Enerji ve Tabii Kaynaklar Bakanı Fatih DÖNMEZ' },
  { id: '49F139E8-81CF-40FE-8BC6-01888F904AE4', label: 'Gençlik ve Spor Bakanı Mehmet Muharrem KASAPOĞLU' },
  { id: '29669C6C-01A1-45D1-A3C5-01888F9110E4', label: 'Hazine ve Maliye Bakanı Lütfi ELVAN' },
  { id: 'C37A0947-B190-4037-9D4C-019C4C9236E8', label: 'İçişleri Bakanı Süleyman SOYLU' },
  { id: '82C6A9E5-0676-4C44-83E2-01888F92441E', label: 'Kültür ve Turizm Bakanı Mehmet Nuri ERSOY' },
  { id: '193C5BCE-438F-4771-949A-01888F936251', label: 'Milli Eğitim Bakanı Mahmut ÖZER' },
  { id: '07041329-D38C-49C1-8E84-01888F93CF19', label: 'Milli Savunma Bakanı Hulusi AKAR' },
  { id: '007A6836-79C8-4ECB-8152-01907343309E', label: 'Sağlık Bakanı Fahrettin KOCA' },
  { id: 'E5FDEB55-8CD1-44AD-A06C-01888F952BB1', label: 'Sanayi ve Teknoloji Bakanı Mustafa VARANK' },
  { id: 'E0C4FC5E-E037-4B3C-8D5A-01888F971079', label: 'Tarım ve Orman Bakanı Bekir PAKDEMİRLİ' },
  { id: 'D0AB6F77-A66F-45E2-A0BC-01888F97A58B', label: 'Ticaret Bakanı Ruhsar PEKCAN' },
  { id: 'DF0A4762-181E-4EA4-86D7-01888F9889E4', label: 'Ulaştırma ve Altyapı Bakanı Adil KARAİSMAİLOĞLU' },
];

const CABINET_26_STATIC: CabinetEntry[] = [
  { id: 'e3ce1232-4307-435c-b361-4ae5c53ee75a', label: 'TBMM Başkanı İsmail KAHRAMAN' },
  { id: 'BD9FADF2-93BA-4A18-9979-01888F881D3A', label: 'Başbakan Binali YILDIRIM' },
  { id: '23CAA63B-EFC8-4E3A-8E8D-019C4D4F68FC', label: 'Adalet Bakanı Abdulhamit GÜL' },
  { id: '050B9AA4-255A-4D83-8F36-01888F8AC96B', label: 'Aile ve Sosyal Politikalar Bakanı Fatma Betül Sayan KAYA' },
  { id: '30113760-2D92-4B49-B6B2-01888F8B7200', label: 'Çalışma ve Sosyal Güvenlik Bakanı Jülide SARIEROĞLU' },
  { id: 'B268BD1D-0376-45DA-A9BA-01888F8D2BC0', label: 'Dışişleri Bakanı Mevlüt ÇAVUŞOĞLU' },
  { id: '33900F98-4F2F-49CD-8251-01888F8FA87B', label: 'Enerji ve Tabii Kaynaklar Bakanı Berat ALBAYRAK' },
  { id: '49F139E8-81CF-40FE-8BC6-01888F904AE4', label: 'Gençlik ve Spor Bakanı Osman Aşkın BAK' },
  { id: '29669C6C-01A1-45D1-A3C5-01888F9110E4', label: 'Maliye Bakanı Naci AĞBAL' },
  { id: 'C37A0947-B190-4037-9D4C-019C4C9236E8', label: 'İçişleri Bakanı Süleyman SOYLU' },
  { id: '82C6A9E5-0676-4C44-83E2-01888F92441E', label: 'Kültür ve Turizm Bakanı Numan KURTULMUŞ' },
  { id: '193C5BCE-438F-4771-949A-01888F936251', label: 'Milli Eğitim Bakanı İsmet YILMAZ' },
  { id: '07041329-D38C-49C1-8E84-01888F93CF19', label: 'Milli Savunma Bakanı Nurettin CANİKLİ' },
  { id: '007A6836-79C8-4ECB-8152-01907343309E', label: 'Sağlık Bakanı Ahmet DEMİRCAN' },
  { id: 'E5FDEB55-8CD1-44AD-A06C-01888F952BB1', label: 'Bilim, Sanayi ve Teknoloji Bakanı Faruk ÖZLÜ' },
  { id: 'E0C4FC5E-E037-4B3C-8D5A-01888F971079', label: 'Gıda, Tarım ve Hayvancılık Bakanı Ahmet Eşref FAKIBABA' },
  { id: 'D0AB6F77-A66F-45E2-A0BC-01888F97A58B', label: 'Gümrük ve Ticaret Bakanı Bülent TÜFENKCİ' },
  { id: 'DF0A4762-181E-4EA4-86D7-01888F9889E4', label: 'Ulaştırma, Denizcilik ve Haberleşme Bakanı Ahmet ARSLAN' },
];

const CABINET_FALLBACK_STATIC: CabinetEntry[] = [
  { id: 'e3ce1232-4307-435c-b361-4ae5c53ee75a', label: 'TBMM Başkanlığı' },
  { id: 'BD9FADF2-93BA-4A18-9979-01888F881D3A', label: 'Başbakanlık / Cumhurbaşkanlığı' },
  { id: '23CAA63B-EFC8-4E3A-8E8D-019C4D4F68FC', label: 'Adalet Bakanlığı' },
  { id: '050B9AA4-255A-4D83-8F36-01888F8AC96B', label: 'Aile ve Sosyal Politikalar Bakanlığı' },
  { id: '30113760-2D92-4B49-B6B2-01888F8B7200', label: 'Çalışma ve Sosyal Güvenlik Bakanlığı' },
  { id: 'B268BD1D-0376-45DA-A9BA-01888F8D2BC0', label: 'Dışişleri Bakanlığı' },
  { id: '33900F98-4F2F-49CD-8251-01888F8FA87B', label: 'Enerji ve Tabii Kaynaklar Bakanlığı' },
  { id: '49F139E8-81CF-40FE-8BC6-01888F904AE4', label: 'Gençlik ve Spor Bakanlığı' },
  { id: '29669C6C-01A1-45D1-A3C5-01888F9110E4', label: 'Maliye / Hazine Bakanlığı' },
  { id: 'C37A0947-B190-4037-9D4C-019C4C9236E8', label: 'İçişleri Bakanlığı' },
  { id: '82C6A9E5-0676-4C44-83E2-01888F92441E', label: 'Kültür ve Turizm Bakanlığı' },
  { id: '193C5BCE-438F-4771-949A-01888F936251', label: 'Milli Eğitim Bakanlığı' },
  { id: '07041329-D38C-49C1-8E84-01888F93CF19', label: 'Milli Savunma Bakanlığı' },
  { id: '007A6836-79C8-4ECB-8152-01907343309E', label: 'Sağlık Bakanlığı' },
  { id: 'E5FDEB55-8CD1-44AD-A06C-01888F952BB1', label: 'Sanayi ve Teknoloji Bakanlığı' },
  { id: 'E0C4FC5E-E037-4B3C-8D5A-01888F971079', label: 'Tarım ve Orman Bakanlığı' },
  { id: 'D0AB6F77-A66F-45E2-A0BC-01888F97A58B', label: 'Ticaret Bakanlığı' },
  { id: 'DF0A4762-181E-4EA4-86D7-01888F9889E4', label: 'Ulaştırma Bakanlığı' },
];

export function muhatapKurumHaritasi(): Map<string, string> {
  const m = new Map<string, string>();
  const kurum = (label: string): string => {
    const t = label.replace(/^x\s*Önceki\s*-\s*/i, '').trim();
    const mm = /^(.*?)\s+(Bakanı|Başkanı|Yardımcısı)(?:\s+.*)?$/.exec(t);
    if (!mm) return t;
    const [, ad, unvan] = mm;
    if (unvan === 'Bakanı') return `${ad} Bakanlığı`;
    return `${ad} ${unvan}`;
  };
  for (const liste of [CABINET_28_STATIC, CABINET_27_STATIC, CABINET_26_STATIC, CABINET_FALLBACK_STATIC]) {
    for (const e of liste) m.set(e.id.toLowerCase(), kurum(e.label));
  }
  return m;
}

function getCabinetListStatic(term: string): CabinetEntry[] {
  if (term === '259b36bd-897d-41a3-b457-0182c6cf153f') return CABINET_27_STATIC;
  if (term === 'e39d73fc-dc0f-48e1-a8ed-019c4d4f68fc') return CABINET_26_STATIC;
  if (term === '00000000-0000-0000-0000-000000000000') return CABINET_28_STATIC;
  return CABINET_FALLBACK_STATIC;
}

function cleanDeputyName(name: string | undefined | null): string {
  if (!name) return 'Bilinmeyen Vekil';
  let n = name.trim();
  for (const prefix of [
    'Milletvekili', 'milletvekili', 'İmza Sahibi', 'imza sahibi',
    'MİLLETVEKİLİ', 'MILLETVEKILI', 'İMZA SAHİBİ', 'IMZA SAHIBI',
  ]) {
    n = n.split(prefix).join('');
  }
  if (n.includes('(')) {
    n = n.split('(')[0];
  }
  return n.split(/\s+/).filter(Boolean).join(' ').trim();
}

function pyRound1(x: number): number {
  const q = x * 4;
  if (Number.isInteger(q) && q % 2 !== 0) {
    const scaled = x * 10;
    const n = Math.floor(scaled);
    return (n % 2 === 0 ? n : n + 1) / 10;
  }
  return Number(x.toFixed(1));
}

function pyFmt1(x: number): string {
  return pyRound1(x).toFixed(1);
}

function pyInt(str: string): number | null {
  const t = str.trim();
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  return null;
}

function argmaxFirst(counts: Record<string, number>): string {
  let bestKey = '';
  let bestVal = 0;
  let first = true;
  for (const [k, v] of Object.entries(counts)) {
    if (first || v > bestVal) {
      bestKey = k;
      bestVal = v;
      first = false;
    }
  }
  return bestKey;
}

async function collectFinishedMotions(gen: AsyncGenerator<MotionStreamEvent>): Promise<MotionResult[]> {
  for await (const ev of gen) {
    if (ev.step === 'finished') {
      return ev.data ?? [];
    }
  }
  return [];
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

interface DeputyStat {
  ad_soyad: string;
  toplam: number;
  cevaplanan: number;
}

interface BakanlikStat {
  toplam: number;
  cevaplanan: number;
  cevaplanmayan: number;
  bakanlik?: string;
}

interface PartyData {
  toplam: number;
  cevaplanan: number;
  gec_cevaplanan: number;
  cevaplanmayan: number;
  surec_devam: number;
  top5_deputies: DeputyStat[];
  bakanlik_stats?: Record<string, BakanlikStat>;
  konular?: BakanlikStat[];
  responsiveness?: {
    ortalama_yanit_suresi: number;
    zamaninda_cevap_orani: number;
    tepkisellik_skoru: number;
  };
}

export function analyzeTimeSeries(
  motions: MotionResult[],
  after: string,
): {
  toplam_onerge: number;
  bakanlik_dagilimi: Record<string, number>;
  en_cok_islenen_konu: string;
  en_cok_islenen_oran: number;
  ozet_metin: string;
} {
  const totalMotions = motions.length;

  let termGuid = '00000000-0000-0000-0000-000000000000';
  if (after) {
    const yr = pyInt(after.split('-')[0] ?? '');
    if (yr !== null && yr < 2023) termGuid = '259b36bd-897d-41a3-b457-0182c6cf153f';
  }
  const cabinetList = getCabinetListStatic(termGuid);
  const muhatapMap = new Map<string, string>();
  for (const m of cabinetList) muhatapMap.set(m.id.toLowerCase(), m.label);

  const bakanlikCounts: Record<string, number> = {};
  for (const motion of motions) {
    const mId = (motion.muhatap_id ?? '') as string;
    const mIdStr = mId ? String(mId).toLowerCase() : '';
    let mLabel: string | undefined = muhatapMap.get(mIdStr);
    if (!mLabel) mLabel = motion.muhatap_text ?? undefined;
    if (!mLabel) mLabel = 'Diğer / Bilinmeyen';

    let cleanLabel = mLabel;
    if (cleanLabel.includes('Bakanı')) {
      cleanLabel = cleanLabel.split('Bakanı')[0].trim() + ' Bakanlığı';
    } else if (cleanLabel.includes('Bakanlığı')) {
    } else if (cleanLabel.includes('Yardımcısı')) {
      cleanLabel = 'Cumhurbaşkanlığı';
    } else if (cleanLabel.includes('Başkanı')) {
      cleanLabel = 'TBMM Başkanlığı';
    }

    bakanlikCounts[cleanLabel] = (bakanlikCounts[cleanLabel] ?? 0) + 1;
  }

  let topBakanlik = 'Hiçbiri';
  let topPercentage = 0.0;
  if (totalMotions > 0 && Object.keys(bakanlikCounts).length > 0) {
    topBakanlik = argmaxFirst(bakanlikCounts);
    topPercentage = pyRound1((bakanlikCounts[topBakanlik] / totalMotions) * 100);
  }

  const textSummary =
    `Seçilen kriterlere uygun toplam ${totalMotions} önerge analiz edilmiştir. ` +
    `En çok önerge sunulan kurum: '${topBakanlik}' (%${pyFmt1(topPercentage)}).`;

  return {
    toplam_onerge: totalMotions,
    bakanlik_dagilimi: bakanlikCounts,
    en_cok_islenen_konu: topBakanlik,
    en_cok_islenen_oran: topPercentage,
    ozet_metin: textSummary,
  };
}

export function motionStatistics(
  motions: MotionResult[],
  term: string,
): {
  parties: Record<string, PartyData>;
  summary: Record<string, unknown>;
} {
  let muhatapMap = new Map<string, string>();
  try {
    const cabinetList = getCabinetListStatic(term);
    muhatapMap = new Map<string, string>();
    for (const m of cabinetList) muhatapMap.set(m.id.toLowerCase(), m.label);
  } catch {
    muhatapMap = new Map<string, string>();
  }

  const deputyList = DEPUTY_MASTER_LIST;

  let termNum = 28;
  if (term === '259b36bd-897d-41a3-b457-0182c6cf153f') termNum = 27;
  else if (term === 'e39d73fc-dc0f-48e1-a8ed-019c4d4f68fc') termNum = 26;
  else if (term === '93b2a2aa-ec4a-4e3f-a631-019c4d4f68fc') termNum = 25;
  else if (term === '673f8205-bcf7-4dc1-ba66-019c4d4f68fc') termNum = 24;
  else if (term === '84d5df65-8b9a-4c28-be99-019c4d4f68fc') termNum = 23;
  else if (term === '59cb36bb-897d-41a3-b457-0182c6cf153f') termNum = 22;
  else if (term === 'a9cb36bb-897d-41a3-b457-0182c6cf153f') termNum = 21;
  else if (term === 'b9cb36bb-897d-41a3-b457-0182c6cf153f') termNum = 20;

  const filteredDeputies = deputyList.filter((d) => String(d.donem) === String(termNum));

  const partyData: Record<string, PartyData> = {};
  const partyDeputies: Record<string, Record<string, DeputyStat>> = {};

  const isActiveTerm = String(term) === '00000000-0000-0000-0000-000000000000';

  for (const motion of motions) {
    const vekilStr = (motion.vekil ?? '') as string;
    const vekilClean = cleanStr(vekilStr);

    let matchedParty = 'DİĞER';
    for (const dep of filteredDeputies) {
      const depNameClean = cleanStr(dep.ad_soyad ?? '');
      if (depNameClean && depNameClean.length > 3 && vekilClean.includes(depNameClean)) {
        const depParty = dep.parti ?? '';
        if (depParty) {
          const depPartyClean = cleanStr(depParty);
          let foundStandard = false;
          for (const [stdKey, aliases] of Object.entries(PARTI_MAP)) {
            if (aliases.some((alias) => depPartyClean.includes(alias))) {
              matchedParty = stdKey.toUpperCase();
              foundStandard = true;
              break;
            }
          }
          if (!foundStandard) matchedParty = depPartyClean;
        }
        break;
      }
    }

    if (matchedParty === 'DİĞER') {
      if (motion.parties && motion.parties.length) {
        const pRaw = cleanStr(motion.parties[0]);
        for (const [stdKey, aliases] of Object.entries(PARTI_MAP)) {
          if (aliases.some((alias) => pRaw.includes(alias))) {
            matchedParty = stdKey.toUpperCase();
            break;
          }
        }
      }
    }

    if (!ALLOWED_PARTIES.includes(matchedParty)) continue;

    let pd = partyData[matchedParty];
    if (!pd) {
      pd = {
        toplam: 0,
        cevaplanan: 0,
        gec_cevaplanan: 0,
        cevaplanmayan: 0,
        surec_devam: 0,
        top5_deputies: [],
        bakanlik_stats: {},
      };
      partyData[matchedParty] = pd;
    }

    pd.toplam += 1;

    const durum = (motion.durum ?? '') as string;
    let isAnswered = false;

    if (durum.includes('Süresi İçinde Cevaplandı') || durum.includes('Süresi içinde cevaplandırılmıştır')) {
      pd.cevaplanan += 1;
      isAnswered = true;
    } else if (
      durum.includes('Süresi Geçtikten Sonra Cevaplandı') ||
      durum.includes('Süresi geçtikten sonra cevaplandırılmıştır')
    ) {
      pd.gec_cevaplanan += 1;
      isAnswered = true;
    } else if (durum.includes('Cevaplandı') || durum.includes('Cevaplandırıldı')) {
      pd.cevaplanan += 1;
      isAnswered = true;
    } else if (
      durum.includes('Cevaplanmadığı Gelen Kağıtlarda İlan Edildi') ||
      durum.includes('Süresi İçinde Cevaplanmadı') ||
      durum.includes('Cevaplanmadı')
    ) {
      pd.cevaplanmayan += 1;
    } else if (
      durum.includes('Cevaplanma Süresi Devam Ediyor') ||
      durum.includes('Süreci Devam Ediyor') ||
      durum.includes('İşlemde')
    ) {
      pd.surec_devam += 1;
    } else {
      if (durum.includes('Gelen Kağıtlar') || durum.includes('İlan Edildi') || durum.includes('Hükümsüz')) {
        pd.cevaplanmayan += 1;
      } else if (isActiveTerm) {
        pd.surec_devam += 1;
      } else {
        pd.cevaplanmayan += 1;
      }
    }

    const muhatapId = String(motion.muhatap_id ?? '').toLowerCase();
    const muhatapText = (motion.muhatap_text ?? '') as string;
    let muhatapLabel = '';
    if (muhatapId && muhatapId !== '00000000-0000-0000-0000-000000000000') {
      muhatapLabel = muhatapMap.get(muhatapId) ?? '';
    }
    if (!muhatapLabel && muhatapText) muhatapLabel = muhatapText;
    if (!muhatapLabel) muhatapLabel = 'Bilinmeyen Bakanlık/Makam';

    muhatapLabel = muhatapLabel.split('x Önceki - ').join('').split('x Önceki ').join('');

    let cleanMuhatap = muhatapLabel.includes(' Bakanı ')
      ? muhatapLabel.split(' Bakanı ')[0] + ' Bakanlığı'
      : muhatapLabel;
    cleanMuhatap = cleanMuhatap.includes(' Başkanı ')
      ? cleanMuhatap.split(' Başkanı ')[0] + ' Başkanlığı'
      : cleanMuhatap;

    const bakanlikStats = pd.bakanlik_stats as Record<string, BakanlikStat>;
    let bStat = bakanlikStats[cleanMuhatap];
    if (!bStat) {
      bStat = { toplam: 0, cevaplanan: 0, cevaplanmayan: 0 };
      bakanlikStats[cleanMuhatap] = bStat;
    }
    bStat.toplam += 1;
    if (isAnswered) {
      bStat.cevaplanan += 1;
    } else if (durum.includes('Cevaplanmayan') || (!isActiveTerm && !isAnswered)) {
      bStat.cevaplanmayan += 1;
    }

    const vekilDisplayName = cleanDeputyName(vekilStr);
    if (vekilDisplayName && vekilDisplayName !== 'Bilinmeyen Vekil') {
      let pDeps = partyDeputies[matchedParty];
      if (!pDeps) {
        pDeps = {};
        partyDeputies[matchedParty] = pDeps;
      }
      let dStat = pDeps[vekilDisplayName];
      if (!dStat) {
        dStat = { ad_soyad: vekilDisplayName, toplam: 0, cevaplanan: 0 };
        pDeps[vekilDisplayName] = dStat;
      }
      dStat.toplam += 1;
      if (isAnswered) dStat.cevaplanan += 1;
    }
  }

  for (const pName of Object.keys(partyData)) {
    const pd = partyData[pName];
    const depDict = partyDeputies[pName] ?? {};
    const sortedDeps = Object.values(depDict).sort((a, b) => b.toplam - a.toplam);
    pd.top5_deputies = sortedDeps.slice(0, 5);

    const bakanlikStats = pd.bakanlik_stats as Record<string, BakanlikStat>;
    const bakanlikArr: BakanlikStat[] = [];
    for (const [bName, bStats] of Object.entries(bakanlikStats)) {
      bStats.bakanlik = bName;
      bakanlikArr.push(bStats);
    }
    bakanlikArr.sort((a, b) => b.toplam - a.toplam);
    pd.konular = bakanlikArr;
    delete pd.bakanlik_stats;

    const toplam = pd.toplam;
    if (toplam > 0) {
      const cevaplanan = pd.cevaplanan;
      const gecCevaplanan = pd.gec_cevaplanan;
      const cevaplanmayan = pd.cevaplanmayan;

      const agirlikliSure = pyRound1(((cevaplanan * 12) + (gecCevaplanan * 45) + (cevaplanmayan * 120)) / toplam);
      const zamanindaOran = pyRound1((cevaplanan / toplam) * 100);
      const skor = pyRound1(Math.max(0, 100 - agirlikliSure));

      pd.responsiveness = {
        ortalama_yanit_suresi: agirlikliSure,
        zamaninda_cevap_orani: zamanindaOran,
        tepkisellik_skoru: skor,
      };
    } else {
      pd.responsiveness = {
        ortalama_yanit_suresi: 0,
        zamaninda_cevap_orani: 0,
        tepkisellik_skoru: 0,
      };
    }
  }

  const parties = Object.values(partyData);
  const totalReceived = parties.reduce((acc, p) => acc + p.toplam, 0);
  const totalAnswered = parties.reduce((acc, p) => acc + p.cevaplanan + p.gec_cevaplanan, 0);
  const totalUnanswered = parties.reduce((acc, p) => acc + p.cevaplanmayan, 0);
  const totalSurecDevam = parties.reduce((acc, p) => acc + p.surec_devam, 0);

  let generalSuccess: number = 0;
  if (totalReceived - totalSurecDevam > 0) {
    const activeTotal = totalReceived - totalSurecDevam;
    generalSuccess = pyRound1((totalAnswered / activeTotal) * 100);
  }

  let worstTreatedParty = 'Bulunmuyor';
  let worstRatio = -1;
  for (const [pName, pStats] of Object.entries(partyData)) {
    if (pStats.toplam > 1) {
      const activePTotal = pStats.toplam - pStats.surec_devam;
      if (activePTotal > 0) {
        const pUnansweredRatio = (pStats.cevaplanmayan / activePTotal) * 100;
        if (pUnansweredRatio > worstRatio) {
          worstRatio = pUnansweredRatio;
          worstTreatedParty = pName;
        }
      }
    }
  }

  let bestTreatedParty = 'Bulunmuyor';
  let bestRatio = -1;
  for (const [pName, pStats] of Object.entries(partyData)) {
    if (pStats.toplam > 1) {
      const activePTotal = pStats.toplam - pStats.surec_devam;
      if (activePTotal > 0) {
        const pAnsweredRatio = ((pStats.cevaplanan + pStats.gec_cevaplanan) / activePTotal) * 100;
        if (pAnsweredRatio > bestRatio) {
          bestRatio = pAnsweredRatio;
          bestTreatedParty = pName;
        }
      }
    }
  }

  const totalPending = totalSurecDevam;

  const summary = {
    'toplam_önerge': totalReceived,
    toplam_cevaplanan: totalAnswered,
    toplam_cevaplanmayan: totalUnanswered,
    toplam_surec_devam: totalPending,
    genel_basari_orani: generalSuccess,
    en_cok_yanitsiz_birakilan_parti: worstTreatedParty,
    en_cok_yanitsiz_orani: worstRatio !== -1 ? pyRound1(worstRatio) : 0,
    en_cok_cevaplanan_parti: bestTreatedParty,
    en_cok_cevaplanan_orani: bestRatio !== -1 ? pyRound1(bestRatio) : 0,
  };

  return { parties: partyData, summary };
}

export function registerOnergeStatsRoutes(app: FastifyInstance): void {
  app.get('/api/analiz/zaman-serisi', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const after = s(q.after);
    const before = s(q.before);
    const party = s(q.party);
    const addressedTo = s(q.addressed_to);

    let lastTerm = 'true';
    if (after) {
      const yr = pyInt(after.split('-')[0] ?? '');
      if (yr !== null && yr < 2023) lastTerm = 'false';
    }

    const motions = await collectFinishedMotions(
      motion.searchMotionsStream({
        after,
        before,
        party,
        addressed_to: addressedTo,
        last_term_only: lastTerm,
      }),
    );

    return { success: true, data: analyzeTimeSeries(motions, after) };
  });

  app.get('/api/onerge/istatistik', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const addressedTo = s(q.addressed_to);
    const term = s(q.term);
    const ping = q.ping ?? 'false';

    if (!addressedTo && !term) {
      return { success: true, data: { parties: {}, summary: {} } };
    }

    const lastTermOnly =
      !term || term === '00000000-0000-0000-0000-000000000000' ? 'true' : 'false';

    const motions = await collectFinishedMotions(
      motion.searchMotionsStream({
        addressed_to: addressedTo,
        term,
        last_term_only: lastTermOnly,
        ping,
      }),
    );

    return { success: true, data: motionStatistics(motions, term) };
  });
}
