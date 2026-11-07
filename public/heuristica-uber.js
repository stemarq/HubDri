// Heurística de precificação de corrida (estimativa, não é o algoritmo da Uber).
// Funciona no navegador (global HubDriHeuristica) e no Node (require).
(function (root) {
  const PARAMS_PADRAO = {
    base: 3.0,            // R$ por corrida
    porKm: 1.6,           // R$ por km
    porMin: 0.35,         // R$ por minuto
    minima: 8.0,          // tarifa mínima
    congestionamentoPico: 1.3, // multiplica a duração do OSRM no pico
    surgePico: 1.3,       // 7-9h e 17-20h em dia útil
    surgeChuva: 1.25,     // chuva prevista
    surgeNoite: 1.15,     // 22h-5h ou sexta/sábado à noite
    surgeEvento: 1.3,     // evento/aglomeração informado
    surgeMax: 2.5,        // teto do multiplicador
    extras: 0,            // pedágio / taxa de aeroporto
    arredondarPara: 10    // preço cobrado sobe para o próximo múltiplo (0 = não arredonda)
  };

  function arredondar(valor, passo) {
    if (!(passo > 0)) return Math.round(valor * 100) / 100;
    return Math.ceil(valor / passo - 1e-9) * passo; // 62 -> 70, 65 -> 70, 70 -> 70
  }

  function contexto(dataHora, chuva, evento) {
    const d = new Date(dataHora);
    const h = d.getHours();
    const dia = d.getDay(); // 0 dom ... 6 sab
    const util = dia >= 1 && dia <= 5;
    return {
      pico: util && ((h >= 7 && h < 9) || (h >= 17 && h < 20)),
      noite: h >= 22 || h < 5 || ((dia === 5 || dia === 6) && h >= 20),
      chuva: chuva === true ? 1 : Math.min(1, Math.max(0, Number(chuva) || 0)), // 0 sem, 0.5 pode chover, 1 chovendo
      evento: !!evento
    };
  }

  function surge(ctx, p) {
    let s = 1;
    if (ctx.pico) s *= p.surgePico;
    if (ctx.chuva) s *= 1 + (p.surgeChuva - 1) * ctx.chuva;
    if (ctx.noite) s *= p.surgeNoite;
    if (ctx.evento) s *= p.surgeEvento;
    return Math.min(s, p.surgeMax);
  }

  function estimar(entrada, params) {
    const p = Object.assign({}, PARAMS_PADRAO, params || {});
    const km = Number(entrada.km), minBase = Number(entrada.min);
    if (!(km > 0) || !(minBase > 0)) throw new Error('Informe km e minutos maiores que zero');
    const ctx = contexto(entrada.dataHora, entrada.chuva, entrada.evento);
    const min = ctx.pico ? minBase * p.congestionamentoPico : minBase;
    const bruto = p.base + km * p.porKm + min * p.porMin;
    const s = surge(ctx, p);
    const sub = Math.max(p.minima, bruto) * s;
    const total = sub + Number(entrada.extras != null ? entrada.extras : p.extras);
    const r = (x) => Math.round(x * 100) / 100;
    return {
      total: r(total), cobrar: arredondar(total, p.arredondarPara), faixa: [r(total * 0.88), r(total * 1.12)],
      detalhe: { bruto: r(bruto), minutosUsados: r(min), surge: r(s), contexto: ctx, usouMinima: bruto < p.minima }
    };
  }

  // MAPE (%) das observações {km,min,dataHora,chuva,evento,extras,preco}
  function erro(obs, params) {
    if (!obs.length) return null;
    const e = obs.map((o) => Math.abs(estimar(o, params).total - o.preco) / o.preco);
    return Math.round((e.reduce((a, b) => a + b, 0) / e.length) * 1000) / 10;
  }

  function resolver3(A, b) {
    const M = A.map((l, i) => l.concat(b[i]));
    for (let i = 0; i < 3; i++) {
      let m = i;
      for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[m][i])) m = r;
      [M[i], M[m]] = [M[m], M[i]];
      if (Math.abs(M[i][i]) < 1e-9) return null;
      for (let r = 0; r < 3; r++) if (r !== i) {
        const f = M[r][i] / M[i][i];
        for (let c = i; c < 4; c++) M[r][c] -= f * M[i][c];
      }
    }
    return M.map((l, i) => l[3] / l[i]);
  }

  // Ajusta base, porKm, porMin por mínimos quadrados em (preço - extras) / surge.
  function calibrar(obs, params) {
    if (obs.length < 4) throw new Error('Registre ao menos 4 cotações reais para calibrar');
    const p = Object.assign({}, PARAMS_PADRAO, params || {});
    const X = [], y = [];
    obs.forEach((o) => {
      const ctx = contexto(o.dataHora, o.chuva, o.evento);
      const s = surge(ctx, p);
      const min = ctx.pico ? o.min * p.congestionamentoPico : o.min;
      X.push([1, o.km, min]);
      y.push((o.preco - (o.extras || 0)) / s);
    });
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    X.forEach((x, k) => { for (let i = 0; i < 3; i++) { b[i] += x[i] * y[k]; for (let j = 0; j < 3; j++) A[i][j] += x[i] * x[j]; } });
    for (let i = 0; i < 3; i++) A[i][i] += 1e-3; // estabiliza com poucos pontos
    const sol = resolver3(A, b);
    if (!sol) throw new Error('Dados insuficientes para ajustar (varie km e minutos)');
    const [base, porKm, porMin] = sol.map((v) => Math.max(0, Math.round(v * 100) / 100));
    return Object.assign({}, p, { base, porKm, porMin });
  }

  const api = { PARAMS_PADRAO, arredondar, contexto, surge, estimar, erro, calibrar };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HubDriHeuristica = api;
})(typeof window !== 'undefined' ? window : globalThis);
