const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// Só se entra pelo link pessoal que o mentor envia (/checkin?t=...)
const token = params.get('t');

let saved = { did: '', next: '', blocked: '' }, hasSaved = false, editing = false;

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro de comunicação.');
  return data;
}
const vals = () => ({ did: $('did').value.trim(), next: $('next').value.trim(), blocked: $('blocked').value.trim() });

function sync() {
  const locked = hasSaved && !editing;
  const v = vals();
  const dirty = v.did !== saved.did || v.next !== saved.next || v.blocked !== saved.blocked;
  const btn = $('ckBtn');
  for (const id of ['did', 'next', 'blocked']) $(id).disabled = locked;
  btn.classList.toggle('ghost', locked);
  btn.type = locked ? 'button' : 'submit';
  btn.disabled = !locked && hasSaved && !dirty;
  btn.textContent = locked ? 'Editar' : hasSaved ? 'Guardar alterações' : 'Guardar';
  $('ckCancel').classList.toggle('hidden', !(hasSaved && editing));
  $('ckMsg').textContent = locked ? '✓ Guardado · o teu mentor já pode ver' : '';
}

function render(v) {
  $('ckError').classList.add('hidden'); $('ck').classList.remove('hidden');
  $('ckWeek').textContent = `Check-in · ${weekLabel(v.week)}`;
  $('ckLede').textContent = `Três linhas bastam. Preenche até quinta, ${weekDay(v.week, 3)}, às 17h, para o teu mentor preparar a sessão de sexta, ${weekDay(v.week, 4)}.`;
  $('ckTitle').textContent = `Olá, ${v.first}.`;
  $('ckGoalBox').classList.toggle('hidden', !v.goal);
  $('ckGoal').textContent = v.goal;
  $('ckCommit').classList.toggle('hidden', !v.commitment);
  $('ckCommitText').textContent = v.commitment;
  const rec = $('ckRecent'); rec.replaceChildren();
  for (const r of v.recent || []) {
    const li = document.createElement('li');
    li.textContent = `${weekLabel(r.week)}: ${(r.did || r.next || '').slice(0, 90)}`;
    rec.append(li);
  }
  $('ckRecentBox').classList.toggle('hidden', !(v.recent || []).length);
  const c = v.current;
  $('did').value = c?.did || ''; $('next').value = c?.next || ''; $('blocked').value = c?.blocked || '';
  saved = c ? { did: c.did, next: c.next, blocked: c.blocked } : { did: '', next: '', blocked: '' };
  hasSaved = Boolean(c); editing = false;
  sync();
}

function fail(msg) {
  $('ck').classList.add('hidden'); $('ckError').classList.remove('hidden');
  $('ckErrorText').textContent = msg;
}

for (const id of ['did', 'next', 'blocked']) $(id).addEventListener('input', sync);
$('ckBtn').addEventListener('click', () => { if (hasSaved && !editing) { editing = true; sync(); $('did').focus(); } });
$('ckCancel').onclick = () => { $('did').value = saved.did; $('next').value = saved.next; $('blocked').value = saved.blocked; editing = false; sync(); };
$('ckForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('ckErr').textContent = ''; $('ckBtn').disabled = true; $('ckBtn').textContent = 'A guardar…';
  try { render(await api('/api/checkin', { id: token, ...vals() })); }
  catch (err) { $('ckErr').textContent = err.message; sync(); }
});

(async () => {
  if (!token) return fail('Abre o link pessoal de check-in que o teu mentor te enviou.');
  try { render(await api('/api/checkin?id=' + encodeURIComponent(token))); }
  catch (e) { fail(e.message); }
})();
