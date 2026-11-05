const $ = (id) => document.getElementById(id);
let token = '';
try { token = sessionStorage.getItem('aiia_admin') || ''; } catch { /* ignore */ }
let groupSel = '';
try { groupSel = sessionStorage.getItem('aiia_admin_group') || ''; } catch { /* ignore */ }
let cfg = { groups: [], adminAll: false };
let data = { sessions: [], missing: [], total: 0 };
let selected = null;
let view = '*';
const vs = () => data.sessions.filter((s) => view === '*' || s.group === view);
const vm = () => data.missing.filter((m) => view === '*' || m.group === view);

async function api(path, method = 'GET') {
  const res = await fetch(path, { method, headers: { Authorization: 'Bearer ' + token, 'X-Group': groupSel } });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(out.error || 'Erro.'); e.status = res.status; throw e; }
  return out;
}

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids.filter((k) => k != null));
  return n;
}
const list = (items) => (items?.length ? el('ul', { className: 'tight' }, ...items.map((i) => el('li', { textContent: i }))) : el('span', { className: 'small', textContent: '—' }));
const dots = (n) => (n ? '●'.repeat(n) + '○'.repeat(5 - n) : '—');

function renderStats() {
  const done = vs().filter((s) => s.status === 'done');
  const lv = done.map((s) => s.profile?.nivel_maturidade).filter(Boolean);
  const avg = lv.length ? (lv.reduce((a, b) => a + b, 0) / lv.length).toFixed(1) : '—';
  const stats = [
    ['Concluídos', `${done.length}`], ['A meio', `${vs().length - done.length}`],
    ['Por começar', `${vm().length}`], ['Maturidade média', avg],
  ];
  $('stats').replaceChildren(...stats.map(([k, v]) => el('div', {}, el('strong', { textContent: v }), el('span', { className: 'small', textContent: k }))));
}

function renderRows() {
  $('rows').replaceChildren(...vs().map((s) => {
    const done = s.status === 'done';
    const tr = el('tr', { className: 'click' },
      el('td', {}, el('b', { textContent: s.name }), el('br'), el('span', { className: 'small', textContent: s.group })),
      el('td', {}, el('b', { textContent: s.profile?.area || '—' }), el('br'), el('span', { className: 'small', textContent: s.profile?.resumo_curto || '' })),
      el('td', {}, el('span', { className: 'badge ' + (done ? 'ok' : 'warn'), textContent: done ? 'Concluído' : `${s.turns.length}/${data.total}` })),
      el('td', { className: 'dots', textContent: dots(s.profile?.nivel_maturidade) }));
    tr.onclick = () => { selected = s.id; renderDetail(); };
    return tr;
  }));
  $('missing').textContent = vm().length ? 'Ainda não começaram: ' + vm().map((m) => m.name).join(', ') : 'Todos já começaram. 🎉';
}

function renderDetail() {
  const s = data.sessions.find((x) => x.id === selected);
  const d = $('detail');
  if (!s) { d.replaceChildren(el('p', { className: 'small', textContent: 'Seleciona uma pessoa.' })); return; }
  const p = s.profile;
  const kids = [el('h2', { textContent: s.name }), el('div', { className: 'small', textContent: `${s.group} · atualizado ${new Date(s.updatedAt).toLocaleString('pt-PT')}` })];
  if (p) {
    kids.push(
      el('div', { className: 'tips' }, el('h3', { textContent: '💡 Dicas para o mentor' }), list(p.dicas_mentor),
        el('h3', { textContent: '⚡ Quick win' }), el('p', { textContent: p.quick_win || '—' }),
        el('h3', { textContent: '🗣️ Perguntas para a sessão' }), list(p.perguntas_sessao)),
      el('h3', { textContent: 'Resumo' }), el('p', { textContent: p.resumo }),
      el('h3', { textContent: 'Maturidade em IA' }), el('div', {}, el('span', { className: 'dots', textContent: dots(p.nivel_maturidade) }), ' ', el('span', { textContent: p.uso_de_ia })),
      el('h3', { textContent: 'Tarefas principais' }), list(p.tarefas_principais),
      el('h3', { textContent: 'Tarefas repetitivas' }), list(p.tarefas_repetitivas),
      el('h3', { textContent: 'Bloqueios' }), list(p.bloqueios),
      el('h3', { textContent: 'Oportunidades' }), list(p.oportunidades),
      el('h3', { textContent: 'Objetivo sugerido' }), el('p', { textContent: p.objetivo_sugerido }),
      el('h3', { textContent: 'Primeiro passo' }), el('p', { textContent: p.primeiro_passo }),
    );
  } else kids.push(el('p', { className: 'small', textContent: 'Perfil ainda não gerado (questionário por concluir).' }));
  kids.push(el('h3', { textContent: 'Respostas' }),
    ...s.turns.map((t) => el('div', { className: 'qa' }, el('b', { textContent: t.q }), el('span', { textContent: t.a }))));
  const regen = el('button', { textContent: 'Regenerar perfil', disabled: !s.turns.length });
  regen.onclick = async () => { regen.disabled = true; regen.textContent = 'A gerar…'; try { await api(`/api/admin/sessions/${s.id}/regenerate`, 'POST'); await load(); } catch (e) { alert(e.message); } };
  const del = el('button', { className: 'danger', textContent: 'Apagar' });
  del.onclick = async () => { if (confirm(`Apagar as respostas de ${s.name}?`)) { await api(`/api/admin/sessions/${s.id}`, 'DELETE'); selected = null; await load(); } };
  kids.push(el('div', { className: 'row', style: 'margin-top:18px' }, regen, del));
  d.replaceChildren(...kids);
}

function renderFilter() {
  const box = $('filter');
  const names = cfg.groups.filter((g) => data.sessions.some((s) => s.group === g.name) || data.missing.some((m) => m.group === g.name)).map((g) => g.name);
  $('who').textContent = groupSel === '*' ? 'Todos os grupos' : `${groupSel} · ${cfg.groups.find((g) => g.name === groupSel)?.mentor || ''}`;
  box.classList.toggle('hidden', names.length < 2);
  box.replaceChildren(...['*', ...names].map((n) => {
    const b = el('button', { type: 'button', className: 'pill', textContent: n === '*' ? 'Todos' : n });
    b.setAttribute('aria-checked', String(n === view)); b.setAttribute('role', 'radio');
    b.onclick = () => { view = n; selected = null; renderFilter(); renderStats(); renderRows(); renderDetail(); };
    return b;
  }));
}

function renderLoginGroups() {
  const opts = [...cfg.groups.map((g) => ({ v: g.name, t: g.name })), ...(cfg.adminAll ? [{ v: '*', t: 'Todos os grupos' }] : [])];
  if (!groupSel && opts.length) groupSel = opts[0].v;
  $('gpick').replaceChildren(...opts.map((o) => {
    const b = el('button', { type: 'button', className: 'pill', textContent: o.t });
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(o.v === groupSel));
    b.onclick = () => { groupSel = o.v; renderLoginGroups(); $('pw').focus(); };
    return b;
  }));
}

async function load() {
  try { data = await api('/api/admin/sessions'); }
  catch (e) {
    if (e.status === 401 || e.status === 503) { token = ''; $('panel').classList.add('hidden'); $('login').classList.remove('hidden'); $('loginErr').textContent = e.message; return false; }
    alert(e.message); return false;
  }
  $('login').classList.add('hidden'); $('panel').classList.remove('hidden');
  renderFilter(); renderStats(); renderRows(); renderDetail();
  return true;
}

$('enter').onclick = async () => {
  token = $('pw').value; $('loginErr').textContent = ''; view = '*';
  if (await load()) { try { sessionStorage.setItem('aiia_admin', token); sessionStorage.setItem('aiia_admin_group', groupSel); } catch { /* ignore */ } }
};
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('enter').click(); });
$('refresh').onclick = load;
$('logout').onclick = () => { try { sessionStorage.removeItem('aiia_admin'); } catch { /* ignore */ } location.reload(); };

$('csv').onclick = () => {
  // prefixo ' evita injeção de fórmulas ao abrir no Excel
  const q = (v) => { let s = String(v ?? '').replace(/\r?\n/g, ' '); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const head = ['Grupo', 'Nome', 'Estado', 'Área', 'Maturidade', 'Uso de IA', 'Tarefas repetitivas', 'Bloqueios', 'Objetivo sugerido'];
  const rows = vs().map((s) => [s.group, s.name, s.status, s.profile?.area, s.profile?.nivel_maturidade, s.profile?.uso_de_ia,
    (s.profile?.tarefas_repetitivas || []).join('; '), (s.profile?.bloqueios || []).join('; '), s.profile?.objetivo_sugerido]);
  const csv = '﻿' + [head, ...rows].map((r) => r.map(q).join(';')).join('\r\n');
  const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), download: 'grupo-ia.csv' });
  a.click(); URL.revokeObjectURL(a.href);
};

(async () => {
  try { cfg = await (await fetch('/api/config')).json(); } catch { /* ignore */ }
  renderLoginGroups();
  if (token && groupSel) load();
})();
