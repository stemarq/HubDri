// Rotas REAIS sem chave de API: geocodificação Nominatim + roteamento OSRM (dados do OpenStreetMap).
// Sem trânsito em tempo real (o estimador aplica um fator de pico). Respeita a política do Nominatim: 1 consulta/s,
// User-Agent identificado e cache em banco. Se o endereço exato não for achado, cai para rua e depois para o bairro,
// e informa a precisão usada para a Adriana revisar.
import { DB, one, run } from '../db.js';
import { logger } from '../lib/logger.js';
import { NEIGHBORHOODS, norm } from '../agent/nlu.js';
import { RouteError, RouteProvider, RouteResult } from './transport.js';

export type Precision = 'endereço' | 'rua' | 'bairro';
interface Point { lat: number; lon: number; precision: Precision }

const COMPLEMENTO = /\b(ap|apto|apt|apartamento|bl|bloco|cj|conjunto|sala|casa|fundos|torre)\b\.?:?\s*[0-9a-z]*/gi;

/** "rua m.m.d.c 80 ap:910 em casa, Pinheiros" -> consultas do mais preciso ao menos preciso. */
export function addressCandidates(destination: string): { q: string; precision: Precision }[] {
  const limpo = destination.replace(/\bem casa\b/gi, ' ').replace(COMPLEMENTO, ' ').replace(/[ ]{2,}/g, ' ').replace(/[ ,]+$/g, '').trim();
  const bairro = NEIGHBORHOODS.find((n) => norm(destination).includes(norm(n)));
  const cidade = /são paulo|sao paulo/i.test(destination) ? '' : ', São Paulo, SP';
  const out: { q: string; precision: Precision }[] = [];
  if (/[0-9]/.test(limpo) && /^(rua|r\.|avenida|av\.?|alameda|al\.|travessa|estrada|rodovia|pra[cç]a)/i.test(limpo)) {
    out.push({ q: `${limpo}${cidade}, Brasil`, precision: 'endereço' });
    const semNumero = limpo.replace(/[,]?\s*[0-9]+[a-z]?\b.*$/i, '').trim();
    if (semNumero && semNumero !== limpo) out.push({ q: `${semNumero}${bairro ? ', ' + bairro : ''}${cidade || ', São Paulo, SP'}, Brasil`, precision: 'rua' });
  } else if (limpo) out.push({ q: `${limpo}${cidade}, Brasil`, precision: bairro && limpo.length < 25 ? 'bairro' : 'endereço' });
  if (bairro) out.push({ q: `${bairro}, São Paulo, SP, Brasil`, precision: 'bairro' });
  return out;
}

export class OsmRouteProvider implements RouteProvider {
  name = 'osm';
  private lastCall = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private db: DB, private fetchFn: typeof fetch = fetch, private userAgent = process.env.NOMINATIM_USER_AGENT || 'HubDri-agente/1.0 (atendimento de maquiagem a domicilio)') {}

  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(async () => {
      const wait = this.lastCall + 1100 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await fn(); } finally { this.lastCall = Date.now(); }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async geocodeOne(q: string): Promise<{ lat: number; lon: number } | null> {
    const cached = one(this.db, 'SELECT lat, lon FROM geocode_cache WHERE q=?', q);
    if (cached) return cached.lat == null ? null : { lat: cached.lat, lon: cached.lon };
    const res = await this.throttled(() => this.fetchFn(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'json', limit: '1', countrycodes: 'br' })}`,
      { headers: { 'User-Agent': this.userAgent, 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(10_000) }));
    if (!res.ok) throw new RouteError(`Geocodificação respondeu HTTP ${res.status}`);
    const data: any[] = await res.json();
    const hit = data[0] ? { lat: Number(data[0].lat), lon: Number(data[0].lon) } : null;
    run(this.db, 'INSERT OR REPLACE INTO geocode_cache(q,lat,lon,created_at) VALUES(?,?,?,?)', q, hit?.lat ?? null, hit?.lon ?? null, Date.now());
    return hit;
  }

  async geocode(address: string): Promise<Point> {
    for (const c of addressCandidates(address)) {
      let hit;
      try { hit = await this.geocodeOne(c.q); } catch (e) { if (e instanceof RouteError) throw e; throw new RouteError(`Falha de rede na geocodificação: ${(e as Error).message}`); }
      if (hit) return { ...hit, precision: c.precision };
    }
    throw new RouteError(`Endereço não encontrado no mapa: ${address.slice(0, 80)}`);
  }

  async route(origin: string, destination: string): Promise<RouteResult> {
    const [o, d] = [await this.geocode(origin), await this.geocode(destination)];
    let res: Response;
    try {
      res = await this.fetchFn(`https://router.project-osrm.org/route/v1/driving/${o.lon},${o.lat};${d.lon},${d.lat}?overview=false`, { signal: AbortSignal.timeout(10_000) });
    } catch (e) { throw new RouteError(`Falha de rede no cálculo da rota: ${(e as Error).message}`); }
    if (!res.ok) throw new RouteError(`Serviço de rotas respondeu HTTP ${res.status}`);
    const data: any = await res.json();
    const r = data?.routes?.[0];
    if (data?.code !== 'Ok' || !r) throw new RouteError('Rota não encontrada entre os endereços');
    const approx = o.precision === 'bairro' || d.precision === 'bairro';
    logger.info('osm.route', { km: Math.round(r.distance / 100) / 10, origem: o.precision, destino: d.precision });
    return { distanceM: Math.round(r.distance), durationS: Math.round(r.duration), source: `osm (sem trânsito; origem: ${o.precision}, destino: ${d.precision})`, simulated: false, approximate: approx };
  }
}
