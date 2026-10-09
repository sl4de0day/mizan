export interface Logger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  warn: (msg: string) => void;
}

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export interface LogSatiri { zaman: string; seviye: 'info' | 'warn' | 'error'; kaynak: string; mesaj: string }
const TAMPON_BOYUTU = 500;
const tampon: LogSatiri[] = [];
function tamponaEkle(seviye: LogSatiri['seviye'], kaynak: string, mesaj: string): void {
  tampon.push({ zaman: new Date().toISOString(), seviye, kaynak, mesaj });
  if (tampon.length > TAMPON_BOYUTU) tampon.shift();
}
export function sonLoglar(n = 200): LogSatiri[] {
  return tampon.slice(-n);
}

export function getLogger(name: string): Logger {
  return {
    info: (msg) => { console.log(`${ts()} | ${name} | ${msg}`); tamponaEkle('info', name, msg); },
    error: (msg) => { console.error(`${ts()} | ${name} | ERROR | ${msg}`); tamponaEkle('error', name, msg); },
    warn: (msg) => { console.warn(`${ts()} | ${name} | WARN | ${msg}`); tamponaEkle('warn', name, msg); },
  };
}
