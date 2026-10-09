const B = 'http://localhost:8000/api/ozet';

export async function backendHazir(deneme = 6, araMs = 700): Promise<boolean> {
  for (let i = 0; i < deneme; i++) {
    try {
      const r = await fetch(`${B}/meta`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) return true;
    } catch {  }
    if (i < deneme - 1) await new Promise((r) => setTimeout(r, araMs));
  }
  return false;
}
