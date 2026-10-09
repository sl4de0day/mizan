export function normalizeParty(pName: string): string {
  const p = pName.toUpperCase().replace(/I/g, 'İ').replace(/ı/g, 'İ').replace(/ /g, '').trim();
  if (p.includes('AKPARTİ') || p.includes('AKPARTI')) return 'AK PARTİ';
  if (p.includes('CHP')) return 'CHP';
  if (p.includes('MHP')) return 'MHP';
  if (p.includes('İYİ') || p.includes('IYI')) return 'İYİ PARTİ';
  if (p.includes('DEM')) return 'DEM PARTİ';
  if (p.includes('SAADET')) return 'SAADET PARTİSİ';
  if (p.includes('REFAH')) return 'YENİDEN REFAH';
  if (p.includes('TİP') || p.includes('TIP')) return 'TİP';
  if (p.includes('HÜDAPAR') || p.includes('HUDAPAR')) return 'HÜDA PAR';
  if (p.includes('BAĞIMSIZ') || p.includes('BAGIMSIZ')) return 'BAĞIMSIZ';
  return p;
}
