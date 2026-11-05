const $ = (id) => document.getElementById(id);
let token = '', groupSel = '';
try { token = sessionStorage.getItem('aiia_admin') || ''; groupSel = sessionStorage.getItem('aiia_admin_group') || ''; } catch { /* ignore */ }
let cfg = { groups: [], adminAll: false };
let data = { sessions: [], missing: [], solutions: [], total: 0, week: '', members: {} };
let view = '*', tab = 'team', selected = null, dtab = 'resumo';
const plan = { lines: null, plan: null, busy: '', err: '' };

const vs = () => data.sessions.filter((s) => view === '*' || s.group === view);
const vm = () => data.missing.filter((m) => view === '*' || m.group === view);
const vsol = () => data.solutions.filter((x) => view === '*' || x.grp === view);
const groups = () => Object.keys(data.members);
const curGroup = () => (view !== '*' ? view : groups().length === 1 ? groups()[0] : null);

/* ---------- utilitários ---------- */
async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: 'Bearer ' + token, 'X-Group': groupSel, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(out.error || 'Erro.'); e.status = res.status; throw e; }
  return out;
}
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'attrs') for (const [a, b] of Object.entries(v)) n.setAttribute(a, b);
    else n[k] = v;
  }
  n.append(...kids.filter((k) => k != null && k !== false));
  return n;
}
const T = (tag, className, text) => el(tag, { className, textContent: text });
let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('bad', bad); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('pt-PT') : '');
const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const dots = (n) => (n ? '●'.repeat(n) + '○'.repeat(5 - n) : '—');
const eff = (s) => s.maturityHistory?.at(-1)?.level ?? s.profile?.nivel_maturidade ?? null;
const first = (s) => s.maturityHistory?.[0]?.level ?? s.profile?.nivel_maturidade ?? null;
const hasCheckin = (s) => (s.checkins || []).some((c) => c.week === data.week);
const goalOf = (s) => s.goal || s.profile?.objetivo_sugerido || '';
const GOAL = { 'por-comecar': 'Por começar', 'em-curso': 'Em curso', concluido: 'Concluído' };
const TAGS = { 'precisa-apoio': 'Precisa de apoio', 'pode-ajudar': 'Pode ajudar outros', atencao: 'Atenção' };
const KINDS = { prompt: 'Prompt', agente: 'Agente', skill: 'Skill', automacao: 'Automação', outro: 'Outro' };

function list(items) {
  return items?.length ? el('ul', { className: 'tight' }, ...items.map((i) => el('li', { textContent: i }))) : T('span', 'small', '—');
}
function seg(options, value, onPick, label, disabled = false) {
  const box = el('div', { className: 'seg', attrs: { role: 'radiogroup', 'aria-label': label } });
  for (const [v, t] of options) {
    const b = el('button', { type: 'button', textContent: t, disabled, attrs: { role: 'radio', 'aria-checked': String(v === value) } });
    b.onclick = () => onPick(v);
    box.append(b);
  }
  return box;
}
function tabsBar(container, items, current, onPick, label) {
  container.setAttribute('aria-label', label);
  container.replaceChildren(...items.map(([id, text, count]) => {
    const b = el('button', { type: 'button', attrs: { role: 'tab', 'aria-selected': String(id === current), tabindex: id === current ? '0' : '-1' } },
      text, count ? T('span', 'cnt', String(count)) : null);
    b.onclick = () => onPick(id);
    b.onkeydown = (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const ids = items.map((x) => x[0]); const i = ids.indexOf(id);
      onPick(ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length]);
      setTimeout(() => container.querySelector('[aria-selected="true"]')?.focus(), 0);
    };
    return b;
  }));
}

// bloco com título + frase a explicar para que serve
function section(title, desc, ...kids) {
  return el('section', { className: 'psec' }, T('h3', '', title), desc ? T('p', 'desc', desc) : null, ...kids);
}
// campo com etiqueta visível (nunca só placeholder) e ajuda opcional
let fid = 0;
function field(label, control, hint, cls = '') {
  const id = 'f' + (++fid);
  const group = control.getAttribute?.('role') === 'radiogroup';
  const lab = group ? el('span', { className: 'flabel', id: id + 'l', textContent: label }) : el('label', { className: 'flabel', htmlFor: (control.id = control.id || id), textContent: label });
  if (group) control.setAttribute('aria-labelledby', id + 'l');
  return el('div', { className: 'fld ' + cls }, lab, control, hint ? T('small', 'fhint', hint) : null);
}

/* ---------- semana escolhida (partilhada pelo separador Semana e pela Sessão de sexta) ---------- */
let weekSel = null;
const selWeek = () => weekSel || data.week;
function earliestWeek() {
  const ws = [data.week];
  for (const s of data.sessions) { if (s.startedAt) ws.push(weekKeyOf(s.startedAt)); for (const c of s.checkins || []) ws.push(c.week); }
  return ws.sort()[0];
}
function setWeek(k) {
  weekSel = k === data.week ? null : k;
  plan.lines = plan.plan = null; plan.err = '';
  renderAll();
}
function weekNav(showFriday = false) {
  const w = selWeek(), cur = data.week, early = earliestWeek();
  const prev = el('button', { type: 'button', className: 'wbtn', textContent: '‹', title: 'Semana anterior', disabled: w <= early, attrs: { 'aria-label': 'Semana anterior' } });
  const next = el('button', { type: 'button', className: 'wbtn', textContent: '›', title: 'Semana seguinte', disabled: w >= cur, attrs: { 'aria-label': 'Semana seguinte' } });
  prev.onclick = () => setWeek(weekShift(w, -1));
  next.onclick = () => setWeek(weekShift(w, 1));
  const label = el('div', { className: 'wlabel', attrs: { 'aria-live': 'polite' } },
    el('b', {}, `Semana ${weekNum(w)}`, w === cur ? T('span', 'chip ok', 'esta semana') : null),
    T('span', '', weekRange(w) + (showFriday ? ` · sessão de sexta, ${weekDay(w, 4)}` : '')));
  const now = w !== cur ? el('button', { type: 'button', className: 'linkbtn', textContent: 'Ir para esta semana' }) : null;
  if (now) now.onclick = () => setWeek(cur);
  return el('div', { className: 'wnav', attrs: { role: 'group', 'aria-label': 'Escolher a semana' } }, prev, label, next, now);
}
// histórico: uma pastilha por semana, com ✓ se a pessoa fez o check-in
function weekStrip(s) {
  const cur = data.week, early = earliestWeek();
  const weeks = []; for (let k = cur, i = 0; i < 12 && k >= early; i++, k = weekShift(k, -1)) weeks.unshift(k);
  const box = el('div', { className: 'wstrip', attrs: { role: 'group', 'aria-label': 'Histórico de check-ins' } });
  for (const k of weeks) {
    const has = (s.checkins || []).some((c) => c.week === k);
    const b = el('button', { type: 'button', className: 'wchip ' + (has ? 'has' : 'none'), textContent: `${weekNum(k)}${has ? ' ✓' : ''}`, title: `${weekLabel(k)}${has ? ' · com check-in' : ' · sem check-in'}`, attrs: { 'aria-pressed': String(k === selWeek()), 'aria-label': `${weekLabel(k)}${has ? ', com check-in' : ', sem check-in'}` } });
    b.onclick = () => setWeek(k);
    box.append(b);
  }
  return box;
}

/* ---------- ações (servidor → estado → render) ---------- */
function upsert(session) { const i = data.sessions.findIndex((x) => x.id === session.id); if (i >= 0) data.sessions[i] = session; }
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (r?.session) upsert(r.session);
    if (r?.solution) { const i = data.solutions.findIndex((x) => x.id === r.solution.id); if (i >= 0) data.solutions[i] = r.solution; else data.solutions.unshift(r.solution); }
    renderAll(); if (okMsg) toast(okMsg);
    return r;
  } catch (e) { toast(e.message, true); }
}
const sessPost = (s, what, body, msg) => act(() => api(`/api/admin/sessions/${s.id}/${what}`, 'POST', body), msg);
const solPost = (body, msg) => act(() => api('/api/admin/solutions', 'POST', body), msg);

/* ---------- filtro de grupo, vistas, métricas ---------- */
function renderFilter() {
  const names = groups();
  $('who').textContent = groupSel === '*' ? 'Todos os grupos' : `${groupSel}${data.sessions[0]?.mentor ? ' · ' + data.sessions[0].mentor : ''}`;
  const box = $('filter'); $('filterBar').classList.toggle('hidden', names.length < 2);
  box.replaceChildren(...['*', ...names].map((n) => {
    const b = el('button', { type: 'button', className: 'pill', textContent: n === '*' ? 'Todos' : n, attrs: { role: 'radio', 'aria-checked': String(n === view) } });
    b.onclick = () => { view = n; selected = null; plan.lines = plan.plan = null; plan.err = ''; renderAll(); };
    return b;
  }));
}
function renderViews() {
  const pending = vs().filter((s) => s.request?.status === 'novo').length;
  tabsBar($('mainTabs'), [['team', 'Equipa', pending], ['lib', 'Biblioteca', vsol().length], ['session', 'Sessão de sexta']], tab, (id) => { tab = id; renderAll(); }, 'Vistas do painel');
  $('vTeam').classList.toggle('hidden', tab !== 'team');
  $('vLib').classList.toggle('hidden', tab !== 'lib');
  $('vSession').classList.toggle('hidden', tab !== 'session');
}
function metric(value, label, sub, cls = '') {
  return el('div', { className: 'metric ' + cls }, T('strong', '', value), T('span', 'lbl', label), sub ? (typeof sub === 'string' ? T('span', 'sub', sub) : sub) : null);
}
function renderMetrics() {
  $('kpiWeek').textContent = data.week ? '· ' + weekLabel(data.week) : '';
  const done = vs().filter((s) => s.status === 'done');
  const imps = vs().flatMap((s) => s.improvements || []);
  const mins = imps.reduce((a, i) => a + (i.minutes || 0), 0);
  const regular = done.filter((s) => (eff(s) || 0) >= 3).length;
  const sols = vsol(), reused = sols.filter((x) => (x.uses || []).some((u) => u !== x.author)).length;
  const lv = done.map(eff).filter(Boolean);
  const avg = lv.length ? (lv.reduce((a, b) => a + b, 0) / lv.length) : null;
  const deltas = done.map((s) => (eff(s) && first(s) ? eff(s) - first(s) : null)).filter((x) => x != null);
  const delta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const trend = el('span', { className: 'sub ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : '') }, delta ? `${delta > 0 ? '↑ +' : '↓ '}${delta.toFixed(1)} desde o início` : 'sem evolução ainda');
  const ck = done.filter(hasCheckin).length, pend = vs().filter((s) => s.request?.status === 'novo').length;
  $('metrics').replaceChildren(
    metric(String(imps.length), 'Melhorias implementadas', mins ? `${mins} min/semana poupados` : 'ainda sem registos'),
    metric(done.length ? `${regular}/${done.length}` : '—', 'Usam IA regularmente', done.length ? `${Math.round((regular / done.length) * 100)}% (nível 3 ou mais)` : ''),
    metric(String(reused), 'Soluções reutilizadas', `de ${sols.length} na biblioteca`),
    metric(avg ? avg.toFixed(1) : '—', 'Maturidade média', trend),
    metric(done.length ? `${ck}/${done.length}` : '—', 'Check-ins desta semana', data.week ? weekLabel(data.week) : ''),
    metric(String(pend), 'Pedidos por tratar', pend ? 'responde na sessão' : 'tudo em dia', pend ? 'warn' : ''),
  );
}

/* ---------- lista de pessoas ---------- */
function attention(s) {
  const why = []; let n = 0;
  if (s.request?.status === 'novo') { n += 3; why.push(['Pedido novo', 'hot']); }
  if (s.status === 'done' && !hasCheckin(s)) { n += 2; why.push(['Sem check-in', 'mute']); }
  if ((s.tags || []).includes('precisa-apoio')) { n += 2; why.push(['Precisa de apoio', 'hot']); }
  if ((s.commitments || []).some((c) => !c.done)) { n += 1; why.push(['Compromisso aberto', '']); }
  return { n, why };
}
function card(s) {
  const a = attention(s), lvl = eff(s), f = first(s), d = lvl && f ? lvl - f : 0;
  const chips = el('span', { className: 'chips' });
  if (s.status !== 'done') chips.append(T('span', 'chip mute', `A meio · ${s.turns.length}/${data.total}`));
  else {
    chips.append(T('span', 'chip', GOAL[s.goalStatus || 'por-comecar']));
    for (const [t, c] of a.why) chips.append(T('span', 'chip ' + c, t));
    if (hasCheckin(s)) chips.append(T('span', 'chip ok', '✓ Check-in'));
    for (const t of s.tags || []) if (t !== 'precisa-apoio') chips.append(T('span', 'chip', TAGS[t]));
  }
  const b = el('button', { type: 'button', className: 'pcard' + (selected === s.id ? ' sel' : ''), attrs: { 'aria-pressed': String(selected === s.id) } },
    T('span', 'avatar', initials(s.name)),
    el('span', {}, el('span', { className: 'pc-name' }, s.name, groups().length > 1 ? T('span', 'small', '  ' + s.group) : null),
      T('span', 'pc-sub', s.profile?.resumo_curto || s.profile?.area || ''), chips),
    el('span', { className: 'pc-lvl' }, T('span', 'dots', dots(lvl)), d ? T('span', d > 0 ? 'up' : 'down', `  ${d > 0 ? '↑' : '↓'}${Math.abs(d)}`) : null));
  b.onclick = () => { selected = s.id; renderList(); renderDetail(); const top = $('detail').getBoundingClientRect().top; if (innerWidth < 1000 || top < 0) window.scrollTo({ top: Math.max(0, top + window.scrollY - 12), behavior: 'auto' }); };
  return b;
}
function renderList() {
  const people = vs();
  const done = people.filter((s) => s.status === 'done').sort((a, b) => attention(b).n - attention(a).n || a.name.localeCompare(b.name));
  const half = people.filter((s) => s.status !== 'done');
  const L = $('list'); L.replaceChildren();
  if (done.length) L.append(T('h3', '', 'Por ordem de atenção'), ...done.map(card));
  if (half.length) L.append(T('h3', '', 'A meio'), ...half.map(card));
  const miss = vm();
  if (miss.length) {
    L.append(T('h3', '', 'Ainda não começaram'));
    for (const m of miss) L.append(el('div', { className: 'pcard ghosted' }, T('span', 'avatar', initials(m.name)), el('span', {}, T('span', 'pc-name', m.name), groups().length > 1 ? T('span', 'pc-sub', m.group) : null), T('span', '', '')));
  }
  if (!people.length && !miss.length) L.append(T('p', 'empty', 'Sem pessoas neste grupo.'));
}

/* ---------- detalhe: separadores ---------- */
function renderDetail() {
  const s = data.sessions.find((x) => x.id === selected), d = $('detail');
  if (!s) { d.replaceChildren(T('p', 'small', 'Seleciona uma pessoa.')); return; }
  const link = el('button', { type: 'button', textContent: 'Copiar link de check-in' });
  link.onclick = async () => {
    const url = `${location.origin}/checkin?t=${s.id}`;
    try { await navigator.clipboard.writeText(url); toast('Link pessoal copiado'); } catch { prompt('Copia o link:', url); }
  };
  const head = el('div', { className: 'dhead' }, el('div', {}, T('h2', '', s.name), T('div', 'small', `${s.group}${s.profile?.area ? ' · ' + s.profile.area : ''} · atualizado ${fmtDate(s.updatedAt)}`)), s.status === 'done' ? link : null);
  const tb = el('div', { className: 'dtabs', attrs: { role: 'tablist' } });
  const n = (k) => (s[k] || []).length;
  tabsBar(tb, [['resumo', 'Resumo'], ['progresso', 'Progresso', n('improvements')], ['semana', 'Semana', n('checkins')], ['processos', 'Processos', n('processes')], ['notas', 'Notas', n('notes')], ['respostas', 'Respostas']],
    dtab, (id) => { dtab = id; renderDetail(); }, 'Secções da pessoa');
  const pane = el('div', { className: 'pane', attrs: { role: 'tabpanel' } });
  ({ resumo: paneResumo, progresso: paneProgresso, semana: paneSemana, processos: paneProcessos, notas: paneNotas, respostas: paneRespostas }[dtab])(pane, s);
  d.replaceChildren(head, tb, pane);
}

function paneResumo(pane, s) {
  const p = s.profile;
  if (s.request?.text) {
    const done = s.request.status === 'resolvido';
    const btn = el('button', { type: 'button', textContent: done ? 'Reabrir' : 'Marcar como resolvido' });
    btn.onclick = () => act(async () => { const r = await api(`/api/admin/sessions/${s.id}/resolve`, 'POST'); s.request = r.request; return {}; });
    pane.append(el('div', { className: 'reqbox' + (done ? ' done' : '') }, T('h3', '', (done ? '✅ Pedido resolvido' : '📨 Pedido para ti') + ' · ' + fmtDate(s.request.at)), T('p', '', s.request.text), btn));
  }
  if (!p) { pane.append(T('p', 'empty', 'Questionário por concluir.')); return; }
  const lvl = eff(s);
  pane.append(T('h3', '', 'Maturidade em IA'));
  const box = el('div', { className: 'lvl', attrs: { role: 'radiogroup', 'aria-label': 'Nível de maturidade' } });
  for (let i = 1; i <= 5; i++) {
    const b = el('button', { type: 'button', textContent: String(i), title: `Nível ${i}`, attrs: { role: 'radio', 'aria-checked': String(i === lvl), 'aria-label': `Nível ${i}` } });
    b.onclick = () => i !== lvl && sessPost(s, 'mentor', { maturity: i }, 'Maturidade atualizada');
    box.append(b);
  }
  pane.append(box, T('p', 'hint', `1 = nunca usou · 3 = usa regularmente · 5 = cria agentes/automações. ${p.uso_de_ia || ''}`));
  if ((s.maturityHistory || []).length > 1) pane.append(T('p', 'hist', 'Evolução: ' + s.maturityHistory.map((h) => `${h.level} (${h.by === 'ia' ? 'IA' : 'mentor'}, ${fmtDate(h.at)})`).join(' → ')));

  pane.append(T('h3', '', 'Etiquetas'));
  const tg = el('div', { className: 'tagbtns' });
  for (const [k, t] of Object.entries(TAGS)) {
    const on = (s.tags || []).includes(k);
    const b = el('button', { type: 'button', textContent: t, attrs: { 'aria-pressed': String(on) } });
    b.onclick = () => sessPost(s, 'mentor', { tags: on ? s.tags.filter((x) => x !== k) : [...(s.tags || []), k] });
    tg.append(b);
  }
  pane.append(tg);

  pane.append(el('details', { className: 'tips', open: true }, T('summary', '', '💡 Dicas para o mentor'), list(p.dicas_mentor),
    T('h3', '', '⚡ Quick win'), T('p', '', p.quick_win || '—'), T('h3', '', '🗣️ Perguntas para a sessão'), list(p.perguntas_sessao)));
  pane.append(T('h3', '', 'O que percebemos'), T('p', '', p.resumo));
  pane.append(el('div', { className: 'two' }, el('div', {}, T('h3', '', 'Tarefas principais'), list(p.tarefas_principais)), el('div', {}, T('h3', '', 'Tarefas repetitivas'), list(p.tarefas_repetitivas)),
    el('div', {}, T('h3', '', 'Bloqueios'), list(p.bloqueios)), el('div', {}, T('h3', '', 'Oportunidades'), list(p.oportunidades))));
  pane.append(T('h3', '', 'Primeiro passo'), T('p', '', p.primeiro_passo || '—'));
}

function paneProgresso(pane, s) {
  if (s.status !== 'done') { pane.append(T('p', 'empty', 'Disponível depois de a pessoa concluir o questionário.')); return; }
  const st = s.goalStatus || 'por-comecar';

  // 1) Objetivo do ano
  const note = el('textarea', { value: s.goalNote || '', maxLength: 500, placeholder: 'Ex.: já tem o prompt a funcionar; falta ligá-lo aos dados.' });
  const save = el('button', { type: 'button', textContent: 'Guardar nota', disabled: true });
  note.oninput = () => { save.disabled = note.value.trim() === (s.goalNote || ''); };
  save.onclick = () => sessPost(s, 'mentor', { goalNote: note.value }, 'Nota guardada');
  pane.append(section('Objetivo do ano', 'O que esta pessoa quer melhorar no trabalho dela este ano. Vai atualizando o ponto em que está.',
    el('div', { className: 'goalbox' }, T('p', '', goalOf(s) || 'Ainda sem objetivo definido.'), s.goal ? null : T('span', 'chip', 'Sugerido pela IA · a pessoa ainda não o confirmou')),
    field('Em que ponto está?', seg(Object.entries(GOAL), st, (v) => sessPost(s, 'mentor', { goalStatus: v }), 'Em que ponto está o objetivo')),
    field('Nota de progresso', note, 'Privada: só tu a vês. O que já mudou ou qual é o próximo marco.'),
    el('div', { className: 'row' }, save)));

  // 2) Melhorias implementadas
  const imps = s.improvements || [], mins = imps.reduce((a, i) => a + (i.minutes || 0), 0);
  const f = {
    title: el('input', { maxLength: 160, placeholder: 'Ex.: Relatório mensal passou de 3 h para 30 min' }),
    proc: el('input', { maxLength: 160, placeholder: 'Ex.: Relatório mensal' }),
    min: el('input', { type: 'number', min: 0, max: 10000, placeholder: 'Ex.: 150' }),
    date: el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }),
  };
  const add = el('button', { type: 'button', className: 'primary', textContent: 'Registar melhoria' });
  add.onclick = () => f.title.value.trim() ? sessPost(s, 'improvements', { op: 'add', item: { title: f.title.value, process: f.proc.value, minutes: f.min.value, date: f.date.value } }, 'Melhoria registada') : (f.title.focus(), toast('Descreve o que mudou', true));
  const form = el('div', { className: 'addbox' },
    T('h4', '', 'Registar uma melhoria'),
    el('div', { className: 'form' },
      field('O que mudou *', f.title, null, 'full'),
      field('Processo (opcional)', f.proc),
      field('Minutos poupados por semana', f.min, 'Uma estimativa. Soma para o impacto do grupo.'),
      field('Data', f.date),
      el('div', { className: 'fld btncell' }, add)));
  const items = imps.map((i) => {
    const rm = el('button', { type: 'button', className: 'iconbtn', textContent: '✕', title: 'Remover', attrs: { 'aria-label': 'Remover melhoria' } });
    rm.onclick = () => confirm('Remover esta melhoria?') && sessPost(s, 'improvements', { op: 'remove', id: i.id });
    return el('div', { className: 'item' }, el('div', { className: 'grow' }, T('b', '', i.title),
      el('div', { className: 'chips' }, i.minutes ? T('span', 'chip ok', `−${i.minutes} min/semana`) : null, i.process ? T('span', 'chip', i.process) : null, T('span', 'chip mute', fmtDate(i.date)))), rm);
  });
  pane.append(section('Melhorias implementadas', 'Cada mudança concreta que a pessoa já pôs em prática no trabalho. Conta para a métrica «Melhorias implementadas» do topo.',
    imps.length ? el('p', { className: 'totals' }, T('b', '', String(imps.length)), imps.length === 1 ? ' melhoria' : ' melhorias', mins ? ' · ' : '', mins ? T('b', '', `${mins} min/semana`) : null, mins ? ' poupados' : '') : null,
    form,
    ...(items.length ? items : [T('p', 'empty', 'Ainda sem melhorias. Quando a pessoa mudar algo concreto no trabalho dela, regista-o aqui.')])));
}

function paneSemana(pane, s) {
  if (s.status !== 'done') { pane.append(T('p', 'empty', 'Disponível depois de a pessoa concluir o questionário.')); return; }
  const wk = selWeek(), cks = s.checkins || [], cur = cks.find((c) => c.week === wk);
  pane.append(T('p', 'desc', 'O que a pessoa preparou para a sessão (check-in até quinta às 17h). Usa as setas para comparar semana a semana.'));
  pane.append(weekNav(), weekStrip(s));
  pane.append(T('h3', '', `Check-in · ${weekLabel(wk)}`));
  const ckBox = (c) => el('dl', { className: 'checkin' }, T('dt', '', 'O que fez'), T('dd', '', c.did || '—'), T('dt', '', 'Quer avançar'), T('dd', '', c.next || '—'), T('dt', '', 'Bloqueios'), T('dd', '', c.blocked || '—'));
  pane.append(cur ? ckBox(cur) : T('p', 'empty', wk === data.week ? 'Ainda não fez o check-in desta semana. Envia-lhe o link pessoal (botão no topo).' : 'Sem check-in nesta semana.'));
  if (cur) pane.append(T('p', 'hint', `Entregue a ${fmtDate(cur.updatedAt || cur.at)}.`));

  const cm = s.commitments || [], open = cm.filter((c) => !c.done), closed = cm.filter((c) => c.done);
  pane.append(T('h3', '', 'Compromissos (até à próxima sessão)'));
  pane.append(T('p', 'desc', 'O que a pessoa se compromete a entregar até à próxima sessão. Marca quando estiver feito.'));
  const inp = el('input', { placeholder: 'O que fica combinado para entregar…', maxLength: 300, attrs: { 'aria-label': 'Novo compromisso' } });
  const add = el('button', { type: 'button', className: 'primary', textContent: 'Adicionar' });
  const go = () => inp.value.trim() ? sessPost(s, 'commitments', { op: 'add', item: { text: inp.value } }) : toast('Escreve o compromisso', true);
  add.onclick = go; inp.onkeydown = (e) => e.key === 'Enter' && go();
  pane.append(el('div', { className: 'addrow' }, inp, add));
  if (!cm.length) pane.append(T('p', 'empty', 'Sem compromissos. No fim de cada sessão regista aqui o que a pessoa se compromete a entregar.'));
  for (const c of [...open, ...closed]) {
    const cb = el('input', { type: 'checkbox', checked: c.done, attrs: { 'aria-label': 'Concluído' } });
    cb.onchange = () => sessPost(s, 'commitments', { op: 'update', id: c.id, item: { done: cb.checked } });
    const rm = el('button', { type: 'button', className: 'iconbtn', textContent: '✕', title: 'Remover', attrs: { 'aria-label': 'Remover compromisso' } });
    rm.onclick = () => sessPost(s, 'commitments', { op: 'remove', id: c.id });
    pane.append(el('div', { className: 'item' + (c.done ? ' done' : '') }, el('label', { className: 'checkrow grow', style: 'font-weight:400;margin:0' }, cb, el('span', {}, T('span', 't', c.text), T('div', 'meta', c.done ? `Concluído ${fmtDate(c.doneAt)}` : `Combinado ${fmtDate(c.at)}`))), rm));
  }
}

function verdict(p) {
  if (p.exists === 'nao') return ['Eliminar', 'hot', 'Se não deve existir, elimina-o em vez de o automatizar.'];
  if (!p.exists || !p.simplify) return ['Por rever', 'mute', 'Responde às perguntas para chegar a um veredito.'];
  if (p.simplify === 'sim') return ['Simplificar primeiro', '', 'Simplifica o processo antes de pensar em automatizar.'];
  if (p.automate === 'sim') return ['Pode automatizar', 'ok', 'Já faz sentido e está simples: é candidato a automação.'];
  if (p.automate === 'nao') return ['Manter como está', 'mute', 'Fica como está por agora.'];
  return ['Falta decidir a automação', 'mute', 'Responde à pergunta 3.'];
}
const STEPS = [
  ['exists', 'Deve existir?', 'Se já não faz falta, elimina-o.'],
  ['simplify', 'Pode ser simplificado?', 'Menos passos, menos aprovações, menos ferramentas.'],
  ['automate', 'Só depois: pode ser automatizado?', 'Só faz sentido automatizar o que já é simples.'],
];
function paneProcessos(pane, s) {
  if (s.status !== 'done') { pane.append(T('p', 'empty', 'Disponível depois de a pessoa concluir o questionário.')); return; }
  const yn = [['sim', 'Sim'], ['nao', 'Não']];
  const total = (s.profile?.tarefas_repetitivas || []).length;
  const have = new Set((s.processes || []).map((p) => p.name.toLowerCase()));
  const todo = (s.profile?.tarefas_repetitivas || []).filter((t) => !have.has(String(t).slice(0, 160).toLowerCase()));

  // explicação + fluxo das 3 perguntas
  pane.append(section('Revisão de processos', 'Antes de automatizar, confirma que o processo faz sentido. Responde às 3 perguntas por ordem e o veredito aparece sozinho.',
    el('ol', { className: 'flow' }, ...STEPS.map(([, q], i) => el('li', {}, T('span', 'stepnum', String(i + 1)), q)), el('li', { className: 'end' }, '→ Veredito'))));

  // como adicionar processos
  const imp = el('button', { type: 'button', className: todo.length ? 'primary' : '', textContent: todo.length ? `Importar ${todo.length} ${todo.length === 1 ? 'tarefa' : 'tarefas'}` : 'Tudo importado', disabled: !todo.length });
  imp.onclick = async () => { for (const t of todo) await api(`/api/admin/sessions/${s.id}/processes`, 'POST', { op: 'add', item: { name: t } }).then((r) => upsert(r.session)).catch((e) => toast(e.message, true)); renderAll(); toast('Tarefas importadas'); };
  const inp = el('input', { maxLength: 160, placeholder: 'Ex.: Follow-up de propostas' });
  const add = el('button', { type: 'button', className: 'primary', textContent: 'Adicionar' });
  const go = () => inp.value.trim() ? sessPost(s, 'processes', { op: 'add', item: { name: inp.value } }) : (inp.focus(), toast('Escreve o nome do processo', true));
  add.onclick = go; inp.onkeydown = (e) => e.key === 'Enter' && go();
  pane.append(section('Adicionar processos', null, el('div', { className: 'acards' },
    el('div', { className: 'acard' }, T('h4', '', 'Das respostas da pessoa'),
      T('p', 'desc', total ? `A IA encontrou ${total} ${total === 1 ? 'tarefa repetitiva' : 'tarefas repetitivas'} no questionário. Importa-as para as reveres uma a uma.` : 'A IA não encontrou tarefas repetitivas no questionário.'), el('div', { className: 'row' }, imp)),
    el('div', { className: 'acard' }, T('h4', '', 'Escrever à mão'),
      T('p', 'desc', 'Um processo que a pessoa faz com frequência e que queiram rever.'), field('Nome do processo', inp), el('div', { className: 'row' }, add)))));

  // lista
  const procs = (s.processes || []).map((p) => {
    const upd = (item) => sessPost(s, 'processes', { op: 'update', id: p.id, item });
    const [vt, vc, vx] = verdict(p);
    const rm = el('button', { type: 'button', className: 'iconbtn', textContent: '✕', title: 'Remover', attrs: { 'aria-label': 'Remover processo' } });
    rm.onclick = () => sessPost(s, 'processes', { op: 'remove', id: p.id });
    const note = el('input', { value: p.note || '', maxLength: 300, placeholder: 'Ex.: depende da aprovação da direção' });
    note.onchange = () => upd({ note: note.value });
    const steps = el('ol', { className: 'steps' }, ...STEPS.map(([k, q, help], i) => {
      const locked = (k === 'simplify' && p.exists === 'nao') || (k === 'automate' && (p.exists !== 'sim' || !p.simplify));
      const why = locked ? (p.exists === 'nao' ? 'Não se aplica: vai ser eliminado.' : 'Responde primeiro à pergunta anterior.') : help;
      return el('li', { className: 'step' + (locked ? ' locked' : '') }, T('span', 'stepnum', String(i + 1)),
        el('div', { className: 'sq' }, T('b', '', q), T('small', 'fhint', why)), seg(yn, p[k], (v) => upd({ [k]: v }), q, locked));
    }));
    return el('div', { className: 'proc' },
      el('div', { className: 'item', style: 'border:0;padding:0' }, el('div', { className: 'grow' }, T('b', '', p.name)), rm),
      steps,
      el('div', { className: 'verdict v-' + (vc || 'plain') }, T('span', 'vlabel', 'Veredito'), T('b', '', vt), T('span', '', vx)),
      field('Nota (opcional)', note));
  });
  pane.append(section(`Processos desta pessoa${procs.length ? ` · ${procs.length}` : ''}`, null,
    ...(procs.length ? procs : [T('p', 'empty', 'Ainda sem processos. Importa as tarefas repetitivas ou adiciona um processo acima.')])));
}

function paneNotas(pane, s) {
  pane.append(T('p', 'hint', 'Notas privadas: só tu (e quem tem a palavra-passe do grupo) as vê.'));
  const ta = el('textarea', { maxLength: 1000, placeholder: 'O que combinaram, o que reparaste, o que fazer a seguir…', attrs: { 'aria-label': 'Nova nota' } });
  const add = el('button', { type: 'button', className: 'primary', textContent: 'Adicionar nota' });
  add.onclick = () => ta.value.trim() ? sessPost(s, 'notes', { op: 'add', item: { text: ta.value } }, 'Nota guardada') : toast('Escreve a nota', true);
  pane.append(ta, el('div', { className: 'row', style: 'margin-top:8px' }, add));
  if (!(s.notes || []).length) pane.append(T('p', 'empty', 'Sem notas ainda.'));
  for (const n of s.notes || []) {
    const rm = el('button', { type: 'button', className: 'iconbtn', textContent: '✕', title: 'Remover', attrs: { 'aria-label': 'Remover nota' } });
    rm.onclick = () => confirm('Remover esta nota?') && sessPost(s, 'notes', { op: 'remove', id: n.id });
    pane.append(el('div', { className: 'item' }, el('div', { className: 'grow' }, T('div', 'meta', fmtDate(n.at)), el('span', { style: 'white-space:pre-wrap' }, n.text)), rm));
  }
}

function paneRespostas(pane, s) {
  if (!s.turns.length) pane.append(T('p', 'empty', 'Sem respostas ainda.'));
  for (const t of s.turns) pane.append(el('div', { className: 'qa' }, T('b', '', t.q), T('span', '', t.a)));
  const regen = el('button', { type: 'button', textContent: 'Regenerar perfil', disabled: !s.turns.length });
  regen.onclick = async () => { regen.disabled = true; regen.textContent = 'A gerar…'; await act(async () => { const r = await api(`/api/admin/sessions/${s.id}/regenerate`, 'POST'); s.profile = r.profile; return {}; }, 'Perfil regenerado'); };
  const del = el('button', { type: 'button', className: 'danger', textContent: 'Apagar pessoa' });
  del.onclick = async () => { if (confirm(`Apagar TODOS os dados de ${s.name}? Esta ação não se pode desfazer.`)) { await api(`/api/admin/sessions/${s.id}`, 'DELETE'); data.sessions = data.sessions.filter((x) => x.id !== s.id); selected = null; renderAll(); } };
  pane.append(el('div', { className: 'row', style: 'margin-top:18px' }, regen, del));
}

/* ---------- biblioteca ---------- */
const libUI = { open: false, editId: null, kind: 'all' };
function openLib(editId = null) { libUI.open = true; libUI.editId = editId; renderLib(); $('vLib').querySelector('.libform input')?.focus(); }
function closeLib() { libUI.open = false; libUI.editId = null; renderLib(); }

function libForm() {
  const editing = libUI.editId ? data.solutions.find((x) => x.id === libUI.editId) : null;
  let kind = editing?.kind || 'prompt';
  const multi = !editing && !curGroup();
  const grpSel = multi ? el('select', {}, ...groups().map((n) => el('option', { value: n, textContent: n }))) : null;
  const grp = () => editing?.grp || curGroup() || grpSel?.value;

  const title = el('input', { value: editing?.title || '', maxLength: 120, placeholder: 'Ex.: Prompt para resumir métricas de campanha' });
  const author = el('select', {});
  const fillAuthors = (selected = '') => {
    author.replaceChildren(el('option', { value: '', textContent: 'Sem autor' }), ...(data.members[grp()] || []).map((n) => el('option', { value: n, textContent: n })));
    author.value = selected;
  };
  fillAuthors(editing?.author || '');
  if (grpSel) grpSel.onchange = () => fillAuthors('');
  const desc = el('textarea', { value: editing?.description || '', maxLength: 600, placeholder: 'Ex.: Recebe uma tabela de métricas e devolve 5 insights e 2 recomendações.' });

  const kindBox = el('div', { className: 'seg wrapseg', attrs: { role: 'radiogroup', 'aria-label': 'Tipo' } });
  const paint = () => [...kindBox.children].forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === kind)));
  for (const [v, t] of Object.entries(KINDS)) {
    const b = el('button', { type: 'button', textContent: t, attrs: { role: 'radio' } });
    b.dataset.v = v; b.onclick = () => { kind = v; paint(); };
    kindBox.append(b);
  }
  paint();

  const save = el('button', { type: 'button', className: 'primary', textContent: editing ? 'Guardar alterações' : 'Guardar solução' });
  const cancel = el('button', { type: 'button', textContent: 'Cancelar' });
  cancel.onclick = closeLib;
  save.onclick = async () => {
    if (!title.value.trim()) { title.focus(); return toast('Dá um nome à solução', true); }
    const item = { title: title.value, kind, author: author.value, description: desc.value };
    save.disabled = true;
    const r = await solPost(editing ? { op: 'update', id: editing.id, item } : { op: 'add', item: { ...item, grp: grp() } }, editing ? 'Solução atualizada' : 'Solução adicionada');
    if (r) closeLib(); else save.disabled = false;
  };
  title.onkeydown = (e) => { if (e.key === 'Enter') save.click(); };
  return el('div', { className: 'card libform' },
    T('h3', '', editing ? 'Editar solução' : 'Nova solução'),
    el('div', { className: 'form' },
      grpSel ? field('Grupo', grpSel, null, 'full') : null,
      field('Nome da solução *', title, null, 'full'),
      field('Tipo', kindBox, null, 'full'),
      field('Quem criou (opcional)', author, null, 'full'),
      field('Descrição', desc, 'O que faz e quando usar. Podes colar o próprio prompt ou um link.', 'full')),
    el('div', { className: 'row' }, save, cancel));
}

function solCard(x) {
  const people = data.members[x.grp] || [];
  const reused = (x.uses || []).filter((u) => u !== x.author).length;
  const who = el('div', { className: 'who', attrs: { role: 'group', 'aria-label': 'Quem já usou' } });
  for (const n of people) {
    const on = (x.uses || []).includes(n);
    const b = el('button', { type: 'button', textContent: (on ? '✓ ' : '') + n, attrs: { 'aria-pressed': String(on) } });
    b.onclick = () => solPost({ op: 'update', id: x.id, item: { uses: on ? x.uses.filter((u) => u !== n) : [...(x.uses || []), n] } });
    who.append(b);
  }
  const act2 = el('div', { className: 'sol-actions' });
  if (x.description) {
    const cp = el('button', { type: 'button', className: 'iconbtn', textContent: '⧉', title: 'Copiar o texto', attrs: { 'aria-label': 'Copiar o texto da solução' } });
    cp.onclick = () => copy(x.description, 'Texto copiado');
    act2.append(cp);
  }
  const ed = el('button', { type: 'button', className: 'iconbtn', textContent: '✎', title: 'Editar', attrs: { 'aria-label': 'Editar solução' } });
  ed.onclick = () => { openLib(x.id); window.scrollTo({ top: 0, behavior: 'auto' }); };
  const rm = el('button', { type: 'button', className: 'iconbtn danger', textContent: '✕', title: 'Remover', attrs: { 'aria-label': 'Remover solução' } });
  rm.onclick = () => confirm(`Remover "${x.title}"?`) && act(async () => { await api('/api/admin/solutions', 'POST', { op: 'remove', id: x.id }); data.solutions = data.solutions.filter((y) => y.id !== x.id); return {}; });
  act2.append(ed, rm);
  return el('article', { className: 'sol' },
    el('div', { className: 'sol-top' }, el('div', { className: 'chips', style: 'margin:0' }, T('span', 'chip', KINDS[x.kind] || 'Outro'), groups().length > 1 ? T('span', 'chip mute', x.grp) : null), act2),
    T('h4', '', x.title),
    x.description ? T('p', 'sol-desc', x.description) : T('p', 'sol-desc muted', 'Sem descrição.'),
    el('div', { className: 'sol-meta' },
      x.author ? el('span', { className: 'by' }, T('span', 'avatar sm', initials(x.author)), x.author) : T('span', 'by muted', 'Sem autor'),
      T('span', 'reuse' + (reused ? ' on' : ''), reused ? `↻ Reutilizada por ${reused}` : 'Ainda sem reutilização')),
    el('div', { className: 'sol-who' }, T('span', 'flabel', 'Quem já usou · clica para marcar'), who));
}

function renderLib() {
  const box = $('vLib'); box.replaceChildren();
  const all = vsol();
  const reusedCount = all.filter((x) => (x.uses || []).some((u) => u !== x.author)).length;
  const addBtn = el('button', { type: 'button', className: 'primary', textContent: '+ Nova solução', disabled: libUI.open });
  addBtn.onclick = () => openLib();
  box.append(el('div', { className: 'libhead' },
    el('div', {}, T('h2', '', 'Biblioteca de soluções'),
      T('p', 'desc', 'Prompts, agentes e skills que já funcionaram na equipa. Marca quem os já usou: é assim que se mede a reutilização.'),
      all.length ? el('p', { className: 'libstats' }, T('b', '', String(all.length)), all.length === 1 ? ' solução' : ' soluções', ' · ', T('b', '', String(reusedCount)), reusedCount === 1 ? ' reutilizada' : ' reutilizadas') : null),
    addBtn));

  if (libUI.open) box.append(libForm());

  if (!all.length) {
    if (!libUI.open) {
      box.append(el('div', { className: 'emptycard' },
        T('h3', '', 'Ainda não há soluções partilhadas'),
        T('p', 'desc', 'Quando alguém criar um prompt, agente ou skill que poupe tempo, guarda-o aqui para os colegas poderem usar. Usa o botão «+ Nova solução» para guardar a primeira.'),
        T('p', 'desc', 'Exemplos do que guardar:'),
        el('div', { className: 'chips ex' }, T('span', 'chip', 'Prompt para resumir métricas'), T('span', 'chip', 'Checklist de PR com Copilot'), T('span', 'chip', 'Agente de follow-up de propostas'))));
    }
    return;
  }

  // filtro por tipo (só os tipos que existem)
  const counts = {}; for (const x of all) counts[x.kind] = (counts[x.kind] || 0) + 1;
  const kinds = Object.keys(KINDS).filter((k) => counts[k]);
  if (libUI.kind !== 'all' && !counts[libUI.kind]) libUI.kind = 'all';
  if (kinds.length > 1) {
    const bar = el('div', { className: 'libfilter', attrs: { role: 'group', 'aria-label': 'Filtrar por tipo' } });
    for (const [k, t] of [['all', 'Todas'], ...kinds.map((k) => [k, KINDS[k]])]) {
      const b = el('button', { type: 'button', className: 'wchip', textContent: `${t} · ${k === 'all' ? all.length : counts[k]}`, attrs: { 'aria-pressed': String(libUI.kind === k) } });
      b.onclick = () => { libUI.kind = k; renderLib(); };
      bar.append(b);
    }
    box.append(bar);
  }
  const shown = all.filter((x) => libUI.kind === 'all' || x.kind === libUI.kind)
    .sort((a, b) => (b.uses || []).filter((u) => u !== b.author).length - (a.uses || []).filter((u) => u !== a.author).length || b.updatedAt.localeCompare(a.updatedAt));
  box.append(el('div', { className: 'grid3' }, ...shown.map(solCard)));
}

/* ---------- sessão de sexta: resumo CEO e guião ---------- */
async function gen(kind) {
  const g = curGroup(); if (!g) return;
  plan.busy = kind; plan.err = ''; renderSession();
  try {
    const r = await api(`/api/admin/${kind === 'ceo' ? 'summary' : 'prepare'}`, 'POST', { group: g, week: selWeek() });
    if (kind === 'ceo') plan.lines = r.lines; else plan.plan = r.plan;
  } catch (e) { plan.err = e.message; }
  plan.busy = ''; renderSession();
}
const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt('Copia:', text); } };
function planText(P) {
  const L = [];
  L.push('SESSÃO DE SEXTA', '', '10 min · Resultados da semana', ...P.resultados.map((r) => `- ${r.nome}: ${r.texto}`));
  L.push('', `10 min · Micro-aprendizagem: ${P.micro.tema}`, P.micro.porque, P.micro.exemplo);
  L.push('', `10 min · Revisão de processos: ${P.processo.nome}${P.processo.pessoa ? ' (' + P.processo.pessoa + ')' : ''}`, ...P.processo.perguntas.map((q) => '- ' + q));
  L.push('', '25 min · Sprint de execução', ...P.sprint.map((r) => `- ${r.nome}: ${r.foco}`));
  L.push('', '5 min · Compromisso', ...P.compromissos.map((r) => `- ${r.nome}: ${r.sugestao}`));
  return L.join('\n');
}
function renderSession() {
  const box = $('vSession'); box.replaceChildren();
  const g = curGroup();
  if (!g) { box.append(T('p', 'hint', 'Escolhe um grupo no filtro acima para preparar a sessão.')); return; }
  box.append(weekNav(true));
  const busy = plan.busy;
  const gb = el('button', { type: 'button', className: 'primary', textContent: busy === 'ceo' ? 'A gerar…' : 'Gerar resumo', disabled: Boolean(busy) });
  gb.onclick = () => gen('ceo');
  const ceo = el('div', { className: 'card' }, T('h2', '', 'Resumo para o CEO'), T('p', 'hint', `Duas linhas sobre a semana ${weekNum(selWeek())} (${weekRange(selWeek())}) de ${g}, a partir dos check-ins e das melhorias registadas.`), el('div', { className: 'row', style: 'margin:12px 0' }, gb));
  if (plan.lines) {
    ceo.append(el('div', { className: 'lines' }, ...plan.lines.map((l) => T('p', '', l))));
    const cp = el('button', { type: 'button', textContent: 'Copiar' }); cp.onclick = () => copy(plan.lines.join('\n'), 'Resumo copiado');
    ceo.append(cp);
  }
  const pb = el('button', { type: 'button', className: 'primary', textContent: busy === 'plan' ? 'A preparar…' : 'Preparar sessão', disabled: Boolean(busy) });
  pb.onclick = () => gen('plan');
  const pc = el('div', { className: 'card plan' }, T('h2', '', 'Guião da sessão (1 hora)'), T('p', 'hint', `Para a sessão de sexta, ${weekDay(selWeek(), 4)}. Estrutura 10 · 10 · 10 · 25 · 5, com base nos check-ins, bloqueios e processos por rever.`), el('div', { className: 'row', style: 'margin:12px 0' }, pb));
  const P = plan.plan;
  if (P) {
    const blk = (mins, title, ...kids) => el('div', { className: 'blockp' }, el('h4', {}, T('span', 'mins', mins), title), ...kids);
    pc.append(
      blk('10 min', 'Resultados da semana', P.resultados.length ? el('ul', {}, ...P.resultados.map((r) => el('li', {}, T('b', '', r.nome + ': '), r.texto))) : T('p', 'empty', 'Sem dados esta semana.')),
      blk('10 min', `Micro-aprendizagem${P.micro.tema ? ': ' + P.micro.tema : ''}`, T('p', '', P.micro.porque), P.micro.exemplo ? el('p', { style: 'white-space:pre-wrap' }, T('b', '', 'Exemplo: '), P.micro.exemplo) : null),
      blk('10 min', `Revisão de processos${P.processo.nome ? ': ' + P.processo.nome : ''}${P.processo.pessoa ? ' (' + P.processo.pessoa + ')' : ''}`, P.processo.porque ? T('p', '', P.processo.porque) : null, el('ul', {}, ...P.processo.perguntas.map((q) => el('li', { textContent: q })))),
      blk('25 min', 'Sprint de execução', el('ul', {}, ...P.sprint.map((r) => el('li', {}, T('b', '', r.nome + ': '), r.foco)))),
      blk('5 min', 'Compromisso', el('ul', {}, ...P.compromissos.map((r) => el('li', {}, T('b', '', r.nome + ': '), r.sugestao)))));
    const cp = el('button', { type: 'button', textContent: 'Copiar guião' }); cp.onclick = () => copy(planText(P), 'Guião copiado');
    pc.append(el('div', { className: 'row' }, cp));
  }
  if (plan.err) box.append(el('p', { className: 'err', attrs: { role: 'alert' } }, plan.err));
  box.append(el('div', { className: 'two-cards' }, ceo, pc));
}

/* ---------- render geral, carregar, login ---------- */
function renderAll() {
  renderFilter(); renderViews();
  if (tab === 'team') { renderMetrics(); renderList(); renderDetail(); }
  else if (tab === 'lib') renderLib();
  else renderSession();
}
async function load() {
  try { const r = await api('/api/admin/sessions'); data = { ...data, ...r }; }
  catch (e) {
    if (e.status === 401 || e.status === 503 || e.status === 429) { token = ''; $('panel').classList.add('hidden'); $('actions').classList.add('hidden'); document.querySelector('main').classList.remove('in'); $('login').classList.remove('hidden'); $('loginErr').textContent = e.message; return false; }
    toast(e.message, true); return false;
  }
  if (weekSel && weekSel > data.week) weekSel = null;
  if (view !== '*' && !groups().includes(view)) view = '*';
  if (groupSel !== '*' && groups().length === 1) view = groups()[0];
  $('login').classList.add('hidden'); $('panel').classList.remove('hidden');
  $('actions').classList.remove('hidden'); document.querySelector('main').classList.add('in');   // cabeçalho compacto
  renderAll();
  return true;
}
function renderLoginGroups() {
  const opts = [...cfg.groups.map((g) => ({ v: g.name, t: g.name })), ...(cfg.adminAll ? [{ v: '*', t: 'Todos os grupos' }] : [])];
  if (!groupSel && opts.length) groupSel = opts[0].v;
  $('gpick').replaceChildren(...opts.map((o) => {
    const b = el('button', { type: 'button', className: 'pill', textContent: o.t, attrs: { role: 'radio', 'aria-checked': String(o.v === groupSel) } });
    b.onclick = () => { groupSel = o.v; renderLoginGroups(); $('pw').focus(); };
    return b;
  }));
}
$('enter').onclick = async () => {
  token = $('pw').value; $('loginErr').textContent = ''; view = '*';
  if (await load()) { try { sessionStorage.setItem('aiia_admin', token); sessionStorage.setItem('aiia_admin_group', groupSel); } catch { /* ignore */ } }
};
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('enter').click(); });
$('refresh').onclick = async () => { if (await load()) toast('Atualizado'); };
$('logout').onclick = () => { try { sessionStorage.removeItem('aiia_admin'); } catch { /* ignore */ } location.reload(); };

$('csv').onclick = () => {
  // prefixo ' evita injeção de fórmulas ao abrir no Excel
  const q = (v) => { let s = String(v ?? '').replace(/\r?\n/g, ' '); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const head = ['Grupo', 'Nome', 'Estado', 'Área', 'Maturidade', 'Objetivo', 'Estado do objetivo', 'Melhorias', 'Min/semana poupados', 'Check-in esta semana', 'Pedido por tratar', 'Etiquetas', 'Uso de IA', 'Bloqueios'];
  const rows = vs().map((s) => [s.group, s.name, s.status, s.profile?.area, eff(s), goalOf(s), GOAL[s.goalStatus || 'por-comecar'], (s.improvements || []).length,
    (s.improvements || []).reduce((a, i) => a + (i.minutes || 0), 0), hasCheckin(s) ? 'sim' : 'não', s.request?.status === 'novo' ? 'sim' : 'não',
    (s.tags || []).map((t) => TAGS[t]).join('; '), s.profile?.uso_de_ia, (s.profile?.bloqueios || []).join('; ')]);
  const csv = '﻿' + [head, ...rows].map((r) => r.map(q).join(';')).join('\r\n');
  const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), download: 'grupo-ia.csv' });
  a.click(); URL.revokeObjectURL(a.href);
};

// indicadores: recolhidos por defeito em ecrãs pequenos (o foco é escolher a pessoa); a escolha do mentor prevalece
try { const pref = localStorage.getItem('aiia_kpis'); if (pref === '0' || (pref === null && innerWidth < 700)) $('kpis').open = false; } catch { /* ignore */ }
$('kpis').addEventListener('toggle', () => { try { localStorage.setItem('aiia_kpis', $('kpis').open ? '1' : '0'); } catch { /* ignore */ } });

(async () => {
  try { cfg = await (await fetch('/api/config')).json(); } catch { /* ignore */ }
  renderLoginGroups();
  if (token && groupSel) load();
})();
