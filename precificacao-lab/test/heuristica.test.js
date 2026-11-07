const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../heuristica.js');

const seg10h = '2026-11-09T10:00:00'; // segunda, fora do pico
const seg8h = '2026-11-09T08:00:00';  // segunda, pico

test('corrida normal usa base + km + min', () => {
  const r = H.estimar({ km: 10, min: 20, dataHora: seg10h });
  assert.equal(r.total, 3 + 16 + 7);
  assert.equal(r.detalhe.surge, 1);
});

test('tarifa mínima vale para corrida curta', () => {
  const r = H.estimar({ km: 0.5, min: 2, dataHora: seg10h });
  assert.equal(r.total, 8);
  assert.ok(r.detalhe.usouMinima);
});

test('pico e chuva aumentam o preço e o teto limita', () => {
  const normal = H.estimar({ km: 10, min: 20, dataHora: seg10h }).total;
  const pico = H.estimar({ km: 10, min: 20, dataHora: seg8h }).total;
  const chuva = H.estimar({ km: 10, min: 20, dataHora: seg10h, chuva: true }).total;
  assert.ok(pico > normal && chuva > normal);
  const teto = H.estimar({ km: 10, min: 20, dataHora: seg8h, chuva: true, evento: true }, { surgeMax: 1.5 });
  assert.equal(teto.detalhe.surge, 1.5);
});

test('extras são somados fora do multiplicador', () => {
  const a = H.estimar({ km: 10, min: 20, dataHora: seg8h, extras: 0 }).total;
  const b = H.estimar({ km: 10, min: 20, dataHora: seg8h, extras: 12 }).total;
  assert.equal(Math.round((b - a) * 100) / 100, 12);
});

test('entrada inválida lança erro', () => {
  assert.throws(() => H.estimar({ km: 0, min: 10, dataHora: seg10h }));
});

test('calibrar recupera parâmetros de dados sintéticos', () => {
  const real = { base: 4, porKm: 2, porMin: 0.5 };
  const pontos = [[3, 10], [8, 18], [12, 30], [5, 25], [20, 40], [15, 22]];
  const obs = pontos.map(([km, min]) => ({
    km, min, dataHora: seg10h,
    preco: H.estimar({ km, min, dataHora: seg10h }, { ...real, minima: 0 }).total
  }));
  const p = H.calibrar(obs, { minima: 0 });
  assert.ok(Math.abs(p.porKm - 2) < 0.05 && Math.abs(p.porMin - 0.5) < 0.05);
  assert.ok(H.erro(obs, p) < 1);
});

test('calibrar exige 4 observações', () => {
  assert.throws(() => H.calibrar([]));
});

test('arredonda para cima de 10 em 10', () => {
  assert.equal(H.arredondar(62, 10), 70);
  assert.equal(H.arredondar(65, 10), 70);
  assert.equal(H.arredondar(70, 10), 70);
  assert.equal(H.arredondar(70.01, 10), 80);
  assert.equal(H.arredondar(62.347, 0), 62.35);
});

test('chuva possível pesa menos que chuva confirmada', () => {
  const e = (c) => H.estimar({ km: 10, min: 20, dataHora: seg10h, chuva: c }).detalhe.surge;
  assert.ok(e(0) < e(0.5) && e(0.5) < e(1));
});
