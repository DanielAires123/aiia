// Rótulos de semana a partir da chave ISO ("2026-W45"): semana de trabalho, segunda a sexta.
(function () {
  const MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  function monday(key) {
    const [y, w] = String(key).split('-W').map(Number);
    const jan4 = new Date(Date.UTC(y, 0, 4));                                   // 4 de janeiro está sempre na semana 1
    const d = new Date(jan4);
    d.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (w - 1) * 7);
    return d;
  }
  const add = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
  const dm = (d) => `${d.getUTCDate()} de ${MES[d.getUTCMonth()]}`;
  window.weekNum = (key) => Number(String(key).split('-W')[1]);
  // "2 a 6 de novembro" ou "30 de novembro a 4 de dezembro"
  window.weekRange = (key) => {
    const a = monday(key), b = add(a, 4);
    return a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()} a ${b.getUTCDate()} de ${MES[b.getUTCMonth()]}` : `${dm(a)} a ${dm(b)}`;
  };
  // "Semana 45 · 2 a 6 de novembro"
  window.weekLabel = (key) => `Semana ${window.weekNum(key)} · ${window.weekRange(key)}`;
  // chave ISO ("2026-W45") de uma data em UTC (meia-noite)
  function keyOf(d) {
    const t = new Date(d);
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
    const w1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const n = 1 + Math.round(((t - w1) / 86400000 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7);
    return `${t.getUTCFullYear()}-W${String(n).padStart(2, '0')}`;
  }
  // semana de uma data/hora (usa o dia local do browser)
  window.weekKeyOf = (iso) => { const d = new Date(iso); return keyOf(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))); };
  // semana seguinte (+1) ou anterior (-1)
  window.weekShift = (key, n) => keyOf(add(monday(key), 7 * n));
  // dia da semana de trabalho: 0 = segunda … 3 = quinta, 4 = sexta -> "5 de novembro"
  window.weekDay = (key, i) => dm(add(monday(key), i));
})();
