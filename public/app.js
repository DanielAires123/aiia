const $ = (id) => document.getElementById(id);
const ARROW_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
let config, sessionId, group = null, person = null, optLabels = [];
const picks = new Set();
try { sessionId = localStorage.getItem('aiia_session'); } catch { /* ignore */ }

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro de comunicação.');
  return data;
}
const show = (id) => {
  for (const s of ['login', 'quiz', 'done']) $(s).classList.toggle('hidden', s !== id);
  $('progress').classList.toggle('hidden', id !== 'quiz');
  $('adminLink').classList.toggle('hidden', id !== 'login');
};
const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/* ---------- Identificação ---------- */
function renderGroups() {
  const box = $('groupPick');
  box.replaceChildren(...config.groups.map((g, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'person'; b.style.animationDelay = `${i * 50}ms`;
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(g.name === group?.name));
    const av = document.createElement('span'); av.className = 'avatar'; av.textContent = g.name.replace(/^Grupo\s*/i, '');
    const tx = document.createElement('span');
    const nm = document.createElement('b'); nm.textContent = g.name;
    const sb = document.createElement('span'); sb.className = 'sub'; sb.textContent = g.mentor ? `Mentor: ${g.mentor}` : '';
    tx.append(nm, sb); b.append(av, tx);
    b.onclick = () => {
      if (group?.name !== g.name) { person = null; $('search').value = ''; }
      group = g; renderGroups(); renderPeople();
      if (!person) $('whoBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    return b;
  }));
}
function renderPeople() {
  $('whoBox').classList.toggle('hidden', !group);
  const q = $('search').value.trim().toLowerCase();
  const members = (group?.members || []).filter((n) => n.toLowerCase().includes(q));
  $('search').classList.toggle('hidden', (group?.members.length || 0) < 8);
  $('people').replaceChildren(...members.map((n, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'person'; b.style.animationDelay = `${i * 40}ms`;
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(n === person));
    const av = document.createElement('span'); av.className = 'avatar'; av.textContent = initials(n);
    const tx = document.createElement('span'); const nm = document.createElement('b'); nm.textContent = n; tx.append(nm);
    b.append(av, tx);
    b.onclick = () => { person = n; renderPeople(); };
    return b;
  }));
  $('go').disabled = !(group && person);
}

/* ---------- Questionário ---------- */
function renderProgress(done, total) {
  const bar = $('progress'); bar.replaceChildren();
  for (let i = 0; i < total; i++) { const d = document.createElement('i'); d.className = i < done ? 'done' : i === done ? 'cur' : ''; bar.append(d); }
  const t = document.createElement('span'); t.textContent = `${done + 1}/${total}`; bar.append(t);
  bar.setAttribute('aria-label', `Pergunta ${done + 1} de ${total}`);
}

function updateSend() {
  $('send').firstChild.textContent = picks.size > 1 ? `Seguinte · ${picks.size} escolhidas ` : 'Seguinte ';
  $('send').disabled = !(picks.size || $('answer').value.trim().length >= 2);
}

function toggleOpt(i) {
  const label = optLabels[i]; const btn = $('opts').children[i];
  if (!btn) return;
  const on = !picks.has(label);
  on ? picks.add(label) : picks.delete(label);
  btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on));
  updateSend();
}

function setExtra(open) {
  $('extraBox').classList.toggle('hidden', !open);
  $('toggleExtra').classList.toggle('hidden', open);
  $('toggleExtra').setAttribute('aria-expanded', String(open));
  if (open) $('answer').focus();
}

function render(s) {
  sessionId = s.id;
  try { localStorage.setItem('aiia_session', s.id); } catch { /* ignore */ }
  $('thinking').classList.add('hidden'); $('stage').classList.remove('hidden');
  if (s.status === 'done') {
    show('done');
    $('doneTitle').textContent = `Obrigado, ${s.name.split(' ')[0]}.`;
    const box = $('mine'); box.replaceChildren();
    const pr = s.profile;
    if (pr?.resumo) {
      const w = document.createElement('div'); w.className = 'summary';
      const h = document.createElement('h3'); h.textContent = 'O que percebemos de ti';
      const p = document.createElement('p'); p.textContent = pr.resumo;
      w.append(h, p); box.append(w);
    }
    $('tryBox').classList.toggle('hidden', !pr?.primeiro_passo);
    $('tryMain').textContent = pr?.primeiro_passo || '';
    $('tryExtra').textContent = pr?.quick_win || '';
    $('goal').value = s.goal || pr?.objetivo || '';
    $('req').value = s.request || '';
    setReq(Boolean(s.request));
    $('followMsg').textContent = s.request || s.goal ? '✓ Guardado' : '';
    return;
  }
  show('quiz');
  picks.clear();
  renderProgress(s.answered, s.total);
  $('reactionText').textContent = s.reaction || '';
  $('reaction').classList.toggle('hidden', !s.reaction);
  $('question').textContent = s.question;
  $('answer').value = '';
  $('quizErr').textContent = '';
  const opts = (s.options || []).map((o) => (typeof o === 'string' ? { emoji: '', label: o } : o));
  optLabels = opts.map((o) => o.label);
  $('hint').classList.toggle('hidden', !opts.length);
  $('kbd').classList.toggle('hidden', !opts.length);
  $('opts').replaceChildren(...opts.map((o, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'opt'; b.setAttribute('aria-pressed', 'false');
    b.style.animationDelay = `${120 + i * 60}ms`;
    const em = document.createElement('span'); em.className = 'em'; em.setAttribute('aria-hidden', 'true'); em.textContent = o.emoji || '•';
    const lb = document.createElement('span'); lb.className = 'lb'; lb.textContent = o.label;
    const key = document.createElement('span'); key.className = 'key'; key.setAttribute('aria-hidden', 'true'); key.textContent = String(i + 1);
    const ck = document.createElement('span'); ck.className = 'ck'; ck.setAttribute('aria-hidden', 'true'); ck.innerHTML = ARROW_OK;
    b.append(em, lb, key, ck);
    b.onclick = () => toggleOpt(i);
    return b;
  }));
  setExtra(!opts.length);
  const sc = $('quiz'); sc.style.animation = 'none'; void sc.offsetWidth; sc.style.animation = '';
  updateSend();
  $('question').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function submit() {
  if ($('send').disabled) return;
  $('send').disabled = true; $('quizErr').textContent = '';
  $('stage').classList.add('hidden'); $('thinking').classList.remove('hidden');
  $('thinkTxt').textContent = 'A preparar a próxima pergunta, só para ti…';
  const slow = setTimeout(() => { $('thinkTxt').textContent = 'Há muita gente a responder ao mesmo tempo — só mais um momento, as tuas respostas estão guardadas.'; }, 8000);
  try { render(await api('/api/answer', { id: sessionId, picks: [...picks], answer: $('answer').value.trim() })); }
  catch (e) {
    $('thinking').classList.add('hidden'); $('stage').classList.remove('hidden');
    $('quizErr').textContent = e.message; updateSend();
  } finally { clearTimeout(slow); }
}

/* ---------- Arranque ---------- */
async function loadRoster(code) {
  const r = await api('/api/roster', { code });
  config.groups = r.groups; group = null; person = null;
  renderGroups(); renderPeople();
}

async function init() {
  try { config = await api('/api/config'); }
  catch (e) { $('loginErr').textContent = e.message; return; }
  if (sessionId) {
    try { return render(await api('/api/session?id=' + encodeURIComponent(sessionId))); } catch { /* sessão antiga */ }
  }
  $('gate').classList.toggle('hidden', !config.needsCode);
  $('picker').classList.toggle('hidden', config.needsCode);
  if (!config.needsCode) {
    try { await loadRoster(''); } catch (e) { $('loginErr').textContent = e.message; }
  }
  show('login');
}

$('gateBtn').onclick = async () => {
  $('gateErr').textContent = ''; $('gateBtn').disabled = true;
  try { await loadRoster($('code').value); $('gate').classList.add('hidden'); $('picker').classList.remove('hidden'); }
  catch (e) { $('gateErr').textContent = e.message; }
  $('gateBtn').disabled = false;
};
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gateBtn').click(); });

$('search').addEventListener('input', renderPeople);
$('go').onclick = async () => {
  $('loginErr').textContent = ''; $('go').disabled = true;
  try { render(await api('/api/start', { group: group.name, name: person, code: $('code').value })); }
  catch (e) { $('loginErr').textContent = e.message; $('go').disabled = false; }
};
$('send').onclick = submit;
$('toggleExtra').onclick = () => setExtra(true);
$('answer').addEventListener('input', updateSend);
document.addEventListener('keydown', (e) => {
  if ($('quiz').classList.contains('hidden')) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return submit();
  const inField = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
  if (!inField && /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) toggleOpt(Number(e.key) - 1);
});

function setReq(open) {
  $('reqBox').classList.toggle('hidden', !open);
  $('reqToggle').classList.toggle('hidden', open);
  $('reqToggle').setAttribute('aria-expanded', String(open));
  if (open && document.activeElement === $('reqToggle')) $('req').focus();
}
$('reqToggle').onclick = () => { setReq(true); $('req').focus(); };

$('follow').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('followErr').textContent = ''; $('followMsg').textContent = ''; $('followBtn').disabled = true;
  try {
    const v = await api('/api/followup', { id: sessionId, goal: $('goal').value.trim(), request: $('req').value.trim() });
    $('followMsg').textContent = v.request ? '✓ Guardado. O teu mentor vai ver o teu pedido.' : '✓ Guardado.';
  } catch (err) { $('followErr').textContent = err.message; }
  $('followBtn').disabled = false;
});

init();
