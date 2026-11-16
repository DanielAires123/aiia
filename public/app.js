const $ = (id) => document.getElementById(id);
const ARROW_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
let config, sessionId, group = null, person = null, optLabels = [];
const picks = new Set();
try { sessionId = localStorage.getItem('aiia_session'); } catch { /* ignore */ }

const I18N = {
  pt: {
    title: 'Pré-sessão de IA',
    brand: 'Mentoria em IA <em>· pré-sessão</em>',
    exit: 'Sair',
    admin: 'Painel de controlo',
    eyebrow: 'Antes da primeira sessão',
    hero: 'Vamos conhecer o <em>teu dia a dia.</em>',
    lede: 'Cerca de cinco minutos de conversa para o teu mentor preparar uma sessão feita à tua medida. Não há respostas certas ou erradas.',
    doneNotice: '✓ As tuas respostas já estão guardadas. Obrigado! Se precisares de alterar alguma coisa, fala com o teu mentor.',
    inviteLabel: 'Código de convite',
    invitePh: 'Fornecido pelo teu mentor',
    continue: 'Continuar',
    groupLabel: '<span class="num">1</span> Qual é o teu grupo?',
    groupAria: 'Grupo',
    whoLabel: '<span class="num">2</span> Quem és tu?',
    searchPh: 'Procurar o teu nome…',
    doneHint: 'Os nomes marcados com ✓ já responderam. Se precisares de alterar algo, fala com o teu mentor.',
    start: 'Começar',
    privacy: 'Só o teu mentor vê as respostas.',
    hint: 'Escolhe todas as que se aplicam.',
    optsAria: 'Opções de resposta',
    toggleExtra: '+ Acrescentar com as minhas palavras',
    answerPh: 'Escreve aqui, como se estivesses a falar com o teu mentor…',
    answerAria: 'A tua resposta',
    thinking: 'A preparar a próxima pergunta, só para ti…',
    thinkingSlow: 'Há muita gente a responder ao mesmo tempo — só mais um momento, as tuas respostas estão guardadas.',
    connecting: 'A ligar ao servidor… (pode demorar um minuto)',
    kbd: 'Dica: usa as teclas 1–6 para escolher',
    next: 'Seguinte',
    nextN: (n) => `Seguinte · ${n} escolhidas`,
    thanks: 'Obrigado.',
    thanksName: (name) => `Obrigado, ${name}.`,
    doneLede: 'As tuas respostas ficaram guardadas. O teu mentor vai usá-las para preparar a sessão contigo.',
    summaryTitle: 'O que percebemos de ti',
    tryTitle: 'Para experimentar esta semana',
    goalLabel: 'O teu objetivo para o ano',
    reqToggle: '+ Tenho um pedido para o meu mentor',
    reqLabel: 'O que precisas?',
    reqPh: 'Uma dúvida, acesso a uma ferramenta, um processo que queres analisar…',
    save: 'Guardar',
    saveChanges: 'Guardar alterações',
    saving: 'A guardar…',
    edit: 'Editar',
    cancel: 'Cancelar',
    saved: '✓ Guardado',
    savedReq: '✓ Guardado · O teu mentor já pode ver o teu pedido.',
    mentor: (name) => `Mentor: ${name}`,
    alreadyDone: '✓ Já respondeu',
    progress: (a, b) => `Pergunta ${a} de ${b}`,
  },
  en: {
    title: 'AI pre-session',
    brand: 'AI Mentoring <em>· pre-session</em>',
    exit: 'Exit',
    admin: 'Control panel',
    eyebrow: 'Before the first session',
    hero: "Let's get to know <em>your day-to-day.</em>",
    lede: 'About five minutes of conversation so your mentor can prepare a session tailored to you. There are no right or wrong answers.',
    doneNotice: '✓ Your answers are already saved. Thank you! If you need to change anything, talk to your mentor.',
    inviteLabel: 'Invite code',
    invitePh: 'Provided by your mentor',
    continue: 'Continue',
    groupLabel: '<span class="num">1</span> Which is your group?',
    groupAria: 'Group',
    whoLabel: '<span class="num">2</span> Who are you?',
    searchPh: 'Search for your name…',
    doneHint: 'Names marked with ✓ have already answered. If you need to change anything, talk to your mentor.',
    start: 'Start',
    privacy: 'Only your mentor sees the answers.',
    hint: 'Select all that apply.',
    optsAria: 'Answer options',
    toggleExtra: '+ Add in my own words',
    answerPh: 'Write here, as if you were talking to your mentor…',
    answerAria: 'Your answer',
    thinking: 'Preparing the next question, just for you…',
    thinkingSlow: 'Lots of people answering at once — one more moment, your answers are saved.',
    connecting: 'Connecting to the server… (may take a minute)',
    kbd: 'Tip: use keys 1–6 to choose',
    next: 'Next',
    nextN: (n) => `Next · ${n} selected`,
    thanks: 'Thank you.',
    thanksName: (name) => `Thank you, ${name}.`,
    doneLede: 'Your answers have been saved. Your mentor will use them to prepare the session with you.',
    summaryTitle: 'What we gathered about you',
    tryTitle: 'To try this week',
    goalLabel: 'Your goal for the year',
    reqToggle: '+ I have a request for my mentor',
    reqLabel: 'What do you need?',
    reqPh: 'A question, tool access, a process you want to review…',
    save: 'Save',
    saveChanges: 'Save changes',
    saving: 'Saving…',
    edit: 'Edit',
    cancel: 'Cancel',
    saved: '✓ Saved',
    savedReq: '✓ Saved · Your mentor can already see your request.',
    mentor: (name) => `Mentor: ${name}`,
    alreadyDone: '✓ Already answered',
    progress: (a, b) => `Question ${a} of ${b}`,
  },
};

let lang = 'pt';
let doneFirst = '';
try {
  const saved = localStorage.getItem('aiia_lang');
  if (saved === 'en' || saved === 'pt') lang = saved;
} catch { /* ignore */ }

const t = (key, ...args) => {
  const v = I18N[lang][key] ?? I18N.pt[key] ?? key;
  return typeof v === 'function' ? v(...args) : v;
};

function applyUi() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'pt-PT';
  document.title = t('title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const btn of document.querySelectorAll('[data-set-lang]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.setLang === lang));
  }
  if (doneFirst) $('doneTitle').textContent = t('thanksName', doneFirst);
  else $('doneTitle').textContent = t('thanks');
  if (group) { renderGroups(); renderPeople(); }
  if (!$('quiz').classList.contains('hidden')) updateSend();
  if (!$('done').classList.contains('hidden')) {
    const summaryH = document.querySelector('#mine .summary h3');
    if (summaryH) summaryH.textContent = t('summaryTitle');
    syncFollow();
  }
}

function setLang(next) {
  if (next !== 'en' && next !== 'pt') return;
  if (next === lang) return;
  lang = next;
  try { localStorage.setItem('aiia_lang', lang); } catch { /* ignore */ }
  applyUi();
}

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
  $('exitBtn').classList.toggle('hidden', id !== 'done');
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
    const sb = document.createElement('span'); sb.className = 'sub'; sb.textContent = g.mentor ? t('mentor', g.mentor) : '';
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
    const isDone = group.done?.includes(n);
    if (isDone) {
      b.disabled = true; b.classList.add('is-done'); b.setAttribute('aria-checked', 'false');
      const sb = document.createElement('span'); sb.className = 'sub'; sb.textContent = t('alreadyDone'); tx.append(sb);
    }
    b.onclick = () => { person = n; renderPeople(); };
    return b;
  }));
  $('doneHint').classList.toggle('hidden', !(group?.done?.length));
  $('go').disabled = !(group && person);
}

/* ---------- Questionário ---------- */
function renderProgress(done, total) {
  const bar = $('progress'); bar.replaceChildren();
  for (let i = 0; i < total; i++) { const d = document.createElement('i'); d.className = i < done ? 'done' : i === done ? 'cur' : ''; bar.append(d); }
  const tEl = document.createElement('span'); tEl.textContent = `${done + 1}/${total}`; bar.append(tEl);
  bar.setAttribute('aria-label', t('progress', done + 1, total));
}

function updateSend() {
  const span = $('send').querySelector('[data-i18n="next"]');
  if (span) span.textContent = picks.size > 1 ? t('nextN', picks.size) : t('next');
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
    doneFirst = s.name.split(' ')[0];
    $('doneTitle').textContent = t('thanksName', doneFirst);
    const box = $('mine'); box.replaceChildren();
    const pr = s.profile;
    if (pr?.resumo) {
      const w = document.createElement('div'); w.className = 'summary';
      const h = document.createElement('h3'); h.textContent = t('summaryTitle');
      const p = document.createElement('p'); p.textContent = pr.resumo;
      w.append(h, p); box.append(w);
    }
    $('tryBox').classList.toggle('hidden', !pr?.primeiro_passo);
    $('tryMain').textContent = pr?.primeiro_passo || '';
    $('tryExtra').textContent = pr?.quick_win || '';
    $('goal').value = s.goal || pr?.objetivo || '';
    $('req').value = s.request || '';
    setReq(Boolean(s.request));
    saved = { goal: s.goal || '', req: s.request || '' };
    hasSaved = Boolean(s.goal || s.request);
    editing = false;
    syncFollow();
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
  $('thinkTxt').textContent = t('thinking');
  const slow = setTimeout(() => { $('thinkTxt').textContent = t('thinkingSlow'); }, 8000);
  try { render(await api('/api/answer', { id: sessionId, picks: [...picks], answer: $('answer').value.trim(), lang })); }
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
  applyUi();
  // O Render (plano grátis) reinicia a instância de vez em quando: durante ~1–3 min devolve 502.
  // Em vez de mostrar erro, tenta de novo.
  for (let i = 0; ; i++) {
    try { config = await api('/api/config'); break; }
    catch (e) {
      if (i >= 12) { $('loginErr').textContent = e.message; return; }
      $('loginErr').textContent = t('connecting');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  $('loginErr').textContent = '';
  if (sessionId) {
    try { return render(await api('/api/session?id=' + encodeURIComponent(sessionId))); } catch { /* sessão antiga */ }
  }
  try { if (sessionStorage.getItem('aiia_notice')) { $('doneNotice').classList.remove('hidden'); sessionStorage.removeItem('aiia_notice'); } } catch { /* ignore */ }
  $('gate').classList.toggle('hidden', !config.needsCode);
  $('picker').classList.toggle('hidden', config.needsCode);
  if (!config.needsCode) {
    try { await loadRoster(''); } catch (e) { $('loginErr').textContent = e.message; }
  }
  show('login');
}

document.querySelectorAll('[data-set-lang]').forEach((btn) => {
  btn.onclick = () => setLang(btn.dataset.setLang);
});

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
  try { render(await api('/api/start', { group: group.name, name: person, code: $('code').value, id: sessionId, lang })); }
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

let saved = { goal: '', req: '' }, hasSaved = false, editing = false;
function syncFollow() {
  const locked = hasSaved && !editing;
  const dirty = $('goal').value.trim() !== saved.goal || $('req').value.trim() !== saved.req;
  const btn = $('followBtn');
  $('goal').disabled = locked; $('req').disabled = locked; $('reqToggle').disabled = locked;
  $('follow').classList.toggle('locked', locked);
  btn.classList.toggle('ghost', locked);
  btn.type = locked ? 'button' : 'submit';
  btn.disabled = !locked && hasSaved && !dirty;
  btn.textContent = locked ? t('edit') : hasSaved ? t('saveChanges') : t('save');
  $('cancelEdit').classList.toggle('hidden', !(hasSaved && editing));
  $('followMsg').textContent = locked ? (saved.req ? t('savedReq') : t('saved')) : '';
}
$('goal').addEventListener('input', syncFollow);
$('req').addEventListener('input', syncFollow);
$('followBtn').addEventListener('click', () => {
  if (hasSaved && !editing) { editing = true; syncFollow(); $('goal').focus(); }
});
$('cancelEdit').onclick = () => { $('goal').value = saved.goal; $('req').value = saved.req; setReq(Boolean(saved.req)); editing = false; syncFollow(); };

$('follow').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('followErr').textContent = ''; $('followBtn').disabled = true; $('followBtn').textContent = t('saving');
  try {
    const v = await api('/api/followup', { id: sessionId, goal: $('goal').value.trim(), request: $('req').value.trim() });
    saved = { goal: v.goal || '', req: v.request || '' };
    hasSaved = true; editing = false;
  } catch (err) { $('followErr').textContent = err.message; }
  syncFollow();
});

$('exitBtn').onclick = () => {
  try { localStorage.removeItem('aiia_session'); sessionStorage.setItem('aiia_notice', '1'); } catch { /* ignore */ }
  location.reload();
};

init();
