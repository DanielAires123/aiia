import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- .env (sem dependências) ----------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* sem .env */ }

const PORT = Number(process.env.PORT || 3000);
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const INVITE_CODE = process.env.INVITE_CODE || '';
const MAX_QUESTIONS = Math.min(12, Math.max(4, Number(process.env.MAX_QUESTIONS || 7)));

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'responses.json');
const ROSTER_FILE = path.join(DATA_DIR, 'roster.json');

// ---------- armazenamento (JSON em disco, escrita atómica) ----------
let db = { sessions: {}, solutions: {} };

// Com SUPABASE_URL + SUPABASE_SERVICE_KEY as respostas ficam no Supabase (sobrevivem a deploys/reinícios).
// Sem elas, usa-se o ficheiro data/responses.json (desenvolvimento local).
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const useSupabase = Boolean(SB_URL && SB_KEY);
const sbFetch = (p, opts = {}) => fetch(`${SB_URL}/rest/v1/${p}`, {
  ...opts, signal: AbortSignal.timeout(15_000),
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});

const rowFor = {
  sessions: (o) => ({ id: o.id, grp: o.group, name: o.name, status: o.status, data: o, updated_at: o.updatedAt }),
  solutions: (o) => ({ id: o.id, grp: o.grp, data: o, updated_at: o.updatedAt }),
};
const pendingWrites = new Map();   // 'tabela:id' -> { table, id, obj | null (apagar) }
let flushing = null;
async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      if (!useSupabase) {
        await fsp.mkdir(DATA_DIR, { recursive: true });
        const tmp = DB_FILE + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
        await fsp.rename(tmp, DB_FILE);
        pendingWrites.clear();
        return;
      }
      for (const [key, w] of [...pendingWrites]) {
        const res = w.obj
          ? await sbFetch(`${w.table}?on_conflict=id`, {
              method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
              body: JSON.stringify(rowFor[w.table](w.obj)),
            })
          : await sbFetch(`${w.table}?id=eq.${encodeURIComponent(w.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
        if (pendingWrites.get(key) === w) pendingWrites.delete(key);   // só limpa se não houve alteração entretanto
      }
    } catch (e) {
      console.error('Erro a gravar (fica em fila e tenta de novo):', e.message);
    } finally { flushing = null; }
  })();
  return flushing;
}
const queueWrite = (table, id, obj) => { pendingWrites.set(`${table}:${id}`, { table, id, obj }); return flush(); };
const save = (sess) => queueWrite('sessions', sess.id, sess);
const removeSession = (id) => queueWrite('sessions', id, null);
const saveSolution = (sol) => queueWrite('solutions', sol.id, sol);
const removeSolution = (id) => queueWrite('solutions', id, null);
setInterval(() => { if (pendingWrites.size) flush(); }, 15_000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await flush(); process.exit(0); });

// Os dados carregam em segundo plano: o servidor começa a ouvir logo (o Render só encaminha tráfego
// quando a porta responde) e os pedidos que precisam dos dados esperam por dbReady.
const dbReady = (async () => {
  if (useSupabase) {
    const res = await sbFetch('sessions?select=data&limit=5000');
    if (!res.ok) { console.error('Não consegui ler do Supabase:', res.status, await res.text()); process.exit(1); }
    for (const row of await res.json()) db.sessions[row.data.id] = row.data;
    const rs = await sbFetch('solutions?select=data&limit=5000');
    if (rs.ok) for (const row of await rs.json()) db.solutions[row.data.id] = row.data;
    else console.warn('AVISO: tabela "solutions" não encontrada no Supabase — a biblioteca não vai guardar até a criares.');
    console.log(`Supabase: ${Object.keys(db.sessions).length} sessões e ${Object.keys(db.solutions).length} soluções carregadas.`);
  } else {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* novo */ }
    db.sessions ||= {}; db.solutions ||= {};
    console.log('Armazenamento: ficheiro local (define SUPABASE_URL e SUPABASE_SERVICE_KEY para usar o Supabase).');
  }
})();
let dbLoaded = false;
dbReady.then(() => { dbLoaded = true; });
// O roster tem nomes de pessoas: não vai para o repositório. Em produção usa a variável ROSTER_JSON
// (JSON numa linha); em local, o ficheiro data/roster.json (ver data/roster.example.json).
let rosterCache = null;
const readRoster = () => {
  if (!rosterCache) rosterCache = JSON.parse(process.env.ROSTER_JSON || fs.readFileSync(ROSTER_FILE, 'utf8'));
  return structuredClone(rosterCache);
};

// ---------- Groq ----------
// Vários modelos em alternativa: na Groq cada modelo tem o seu próprio limite (pedidos/min e tokens/min),
// por isso quando um fica cheio (429) passamos ao seguinte em vez de falhar.
const MODELS = (process.env.GROQ_MODELS || GROQ_MODEL).split(',').map((m) => m.trim()).filter(Boolean);
const MAX_CONCURRENT = Math.max(1, Number(process.env.GROQ_CONCURRENCY || 4));
const QUEUE_TIMEOUT_MS = Number(process.env.GROQ_QUEUE_TIMEOUT_MS || 60_000);
const blockedUntil = new Map();
let active = 0; const waiters = [];
const acquire = () => (active < MAX_CONCURRENT ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
const release = () => { const next = waiters.shift(); if (next) next(); else active--; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripThink = (t) => String(t).replace(/<think>[\s\S]*?<\/think>/g, '').trim();

async function groq(messages, { temperature = 0.5, max_tokens = 800 } = {}) {
  if (!GROQ_API_KEY) throw new HttpError(500, 'GROQ_API_KEY não configurada no servidor.');
  const deadline = Date.now() + QUEUE_TIMEOUT_MS;
  await acquire();
  try {
    for (;;) {
      const now = Date.now();
      const model = MODELS.find((m) => (blockedUntil.get(m) || 0) <= now);
      if (!model) {
        const wait = Math.min(...MODELS.map((m) => blockedUntil.get(m) || 0)) - now;
        if (now + wait > deadline) throw new HttpError(503, 'Há muita gente a responder neste momento. Tenta novamente dentro de um minuto.');
        await sleep(Math.max(250, wait)); continue;
      }
      let res;
      try {
        res = await fetch(process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST', signal: AbortSignal.timeout(40_000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({ model, messages, temperature, max_tokens, response_format: { type: 'json_object' } }),
        });
      } catch (e) {
        console.error('Groq (rede)', model, e.message);
        blockedUntil.set(model, Date.now() + 5_000);
        if (Date.now() > deadline) throw new HttpError(502, 'O assistente de IA não respondeu a tempo. Tenta novamente.');
        continue;
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after')) || 10;
        blockedUntil.set(model, Date.now() + Math.min(ra, 60) * 1000);
        console.warn(`Groq 429 em ${model}; pausa de ${ra}s`);
        continue;
      }
      if (!res.ok) {
        console.error('Groq', res.status, model, (await res.text()).slice(0, 300));
        // 5xx: 10 s; 400 (ex.: JSON mal gerado): 30 s; 401/403/404 (modelo/chave inválidos): 10 min
        blockedUntil.set(model, Date.now() + (res.status >= 500 ? 10_000 : res.status === 400 ? 30_000 : 600_000));
        if (MODELS.every((m) => (blockedUntil.get(m) || 0) > Date.now() + 5_000) || Date.now() > deadline)
          throw new HttpError(502, 'O assistente de IA não está disponível agora. Tenta novamente daqui a pouco.');
        continue;
      }
      const data = await res.json();
      try { return JSON.parse(stripThink(data.choices[0].message.content)); }
      catch { throw new HttpError(502, 'Resposta inválida da IA. Tenta novamente.'); }
    }
  } finally { release(); }
}

const CONTEXT = `Contexto: ${process.env.COMPANY_NAME ? 'a empresa ' + process.env.COMPANY_NAME : 'uma empresa'} lançou um programa anual de mentoria em IA. Cada pessoa tem um mentor e um objetivo concreto de melhoria no seu próprio trabalho. O objetivo não é "aprender IA por aprender", é reduzir tarefas repetitivas, aumentar produtividade e criar valor, sem automatizar processos mal desenhados. Há pessoas com níveis de maturidade muito diferentes; ninguém deve sentir-se avaliado ou deixado para trás.`;

function transcript(s, { compact = false } = {}) {
  const n = s.turns.length;
  return s.turns.map((t, i) => {
    const recent = !compact || i >= n - 2;   // só as 2 últimas voltas vão por inteiro
    const q = recent ? t.q : t.q.slice(0, 90);
    const a = recent ? t.a : String(t.a).slice(0, 220);
    return `P${i + 1}: ${q}\nR${i + 1}: ${a ?? '(sem resposta)'}`;
  }).join('\n\n');
}

async function nextQuestion(s) {
  const answered = s.turns.length;
  const remaining = MAX_QUESTIONS - answered;
  const stages = [
    'o dia a dia: que tarefas ocupam mais tempo numa semana típica',
    'tarefas repetitivas ou demoradas e como as fazem hoje (processo, ferramentas)',
    'o que já usam de IA (ferramentas, frequência, para quê) — aceita "ainda nada"',
    'o que os trava: dúvidas, falta de tempo, dados sensíveis, não saber por onde começar',
    'um processo concreto que talvez nem devesse existir ou pudesse ser simplificado',
    'o objetivo de melhoria que gostariam de alcançar ao longo do ano',
  ];
  const system = `${CONTEXT}

Estás a conduzir um pequeno questionário de pré-sessão em português de Portugal, tom simpático e direto, sem jargão.
Regras:
- A pergunta tem de ser PESSOAL: trata a pessoa pelo primeiro nome (${s.name.split(' ')[0]}) de vez em quando, e liga-a diretamente ao que ela acabou de dizer, usando as palavras, ferramentas, tarefas e exemplos concretos que ela mencionou (ex.: "Falaste em relatórios mensais de campanhas…"). Nunca faças uma pergunta genérica que serviria a qualquer pessoa.
- Faz UMA pergunta de cada vez, curta (máx. 2 frases), adaptada à área/função e ao contexto dela.
- "reacao": uma frase muito curta (máx. 20 palavras), calorosa e natural, que mostre que percebeste a resposta anterior (sem elogios exagerados nem repetir a resposta palavra por palavra).
- "options": 4 a 6 opções de resposta rápida, ESPECÍFICAS para esta pessoa, derivadas do que ela disse e da sua área (não genéricas). A pessoa pode escolher várias e acrescentar texto livre. Cada opção tem um "emoji" (1 emoji adequado) e um "label" curto (máx. 6 palavras). Inclui sempre, quando fizer sentido, uma opção de saída como "Nenhuma / ainda não".
- Não repitas temas já respondidos. Não peças dados pessoais, dados de clientes ou informação confidencial.
- Faltam ${remaining} pergunta(s) incluindo esta. Percorre, por ordem aproximada, os temas: ${stages.join(' | ')}. Se faltarem poucas perguntas, prioriza o que ainda não foi coberto. Na última pergunta, ajuda a pessoa a definir o seu objetivo do ano com base no que disse.
Responde APENAS com JSON: {"reacao": "...", "question": "...", "options": [{"emoji": "📊", "label": "..."}]}`;
  const out = await groq([
    { role: 'system', content: system },
    { role: 'user', content: `Nome: ${s.name}\n\nConversa até agora:\n${transcript(s, { compact: true })}\n\nEscreve a reação e a próxima pergunta.` },
  ], { temperature: 0.7, max_tokens: 500 });
  const question = String(out.question || '').trim().slice(0, 400);
  if (!question) throw new HttpError(502, 'A IA não devolveu pergunta. Tenta novamente.');
  const options = (Array.isArray(out.options) ? out.options : [])
    .map((o) => (typeof o === 'string' ? { emoji: '', label: o } : { emoji: String(o?.emoji || '').slice(0, 8), label: String(o?.label || '') }))
    .map((o) => ({ emoji: o.emoji.trim(), label: o.label.trim().slice(0, 80) }))
    .filter((o) => o.label).slice(0, 6);
  return { reaction: String(out.reacao || '').trim().slice(0, 200), question, options };
}

async function buildProfile(s) {
  const system = `${CONTEXT}

Com base nas respostas, escreve um perfil útil para o mentor, em português de Portugal. Sê factual: só o que a pessoa disse, sem inventar. Responde APENAS com JSON com estes campos:
{
 "area": "área/função em poucas palavras",
 "resumo_curto": "uma única frase (máx. 140 caracteres) a descrever a pessoa para o mentor ver de relance",
 "resumo": "2-3 frases sobre o que a pessoa faz e como trabalha",
 "dicas_mentor": ["3 a 5 dicas práticas dirigidas ao MENTOR sobre como abordar esta pessoa: tom, ritmo, por onde começar, o que evitar, o que a pode motivar"],
 "quick_win": "uma melhoria rápida e concreta que esta pessoa pode fazer já com IA, com um exemplo de prompt ou ferramenta",
 "perguntas_sessao": ["2 a 3 perguntas que o mentor pode fazer na 1.ª sessão para aprofundar"],
 "tarefas_principais": ["..."],
 "tarefas_repetitivas": ["..."],
 "uso_de_ia": "o que usa hoje e com que frequência",
 "nivel_maturidade": 1 a 5 (1 = nunca usou IA, 3 = usa regularmente em tarefas simples, 5 = cria agentes/automações),
 "bloqueios": ["..."],
 "oportunidades": ["melhorias concretas e realistas, indicando se o processo deve primeiro ser simplificado"],
 "objetivo_sugerido": "uma frase com um objetivo de melhoria concreto e mensurável para o ano",
 "primeiro_passo": "um passo pequeno para a 1.ª sessão"
}`;
  const out = await groq([
    { role: 'system', content: system },
    { role: 'user', content: `Nome: ${s.name} (${s.group})\n\n${transcript(s)}` },
  ], { temperature: 0.3, max_tokens: 1600 });
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 300)).slice(0, 8) : []);
  const lvl = Math.round(Number(out.nivel_maturidade));
  return {
    area: String(out.area || '').slice(0, 120),
    resumo_curto: String(out.resumo_curto || '').slice(0, 200),
    dicas_mentor: list(out.dicas_mentor),
    quick_win: String(out.quick_win || '').slice(0, 500),
    perguntas_sessao: list(out.perguntas_sessao),
    resumo: String(out.resumo || '').slice(0, 800),
    tarefas_principais: list(out.tarefas_principais),
    tarefas_repetitivas: list(out.tarefas_repetitivas),
    uso_de_ia: String(out.uso_de_ia || '').slice(0, 400),
    nivel_maturidade: lvl >= 1 && lvl <= 5 ? lvl : null,
    bloqueios: list(out.bloqueios),
    oportunidades: list(out.oportunidades),
    objetivo_sugerido: String(out.objetivo_sugerido || '').slice(0, 400),
    primeiro_passo: String(out.primeiro_passo || '').slice(0, 400),
  };
}

// ---------- HTTP helpers ----------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 20_000) throw new HttpError(413, 'Pedido demasiado grande.');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'JSON inválido.'); }
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
// Acesso do mentor: palavra-passe do próprio grupo (X-Group = nome do grupo)
// ou a ADMIN_PASSWORD global (X-Group = "*"), que vê todos os grupos.
// "Grupo III" -> ADMIN_PASSWORD_GRUPO_III (no .env); g.adminPassword no roster serve só de alternativa
function groupPassword(g) {
  const key = 'ADMIN_PASSWORD_' + g.name.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, '_');
  return process.env[key] || g.adminPassword || '';
}
const failures = new Map();
function requireAdmin(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= 10) throw new HttpError(429, 'Demasiadas tentativas. Espera alguns minutos.');
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const wanted = String(req.headers['x-group'] || '');
  let groups = null;
  if (token) {
    if (wanted === '*') {
      if (ADMIN_PASSWORD && safeEqual(token, ADMIN_PASSWORD)) groups = readRoster().groups.map((g) => g.name);
    } else {
      const g = readRoster().groups.find((x) => x.name === wanted);
      const pw = g && groupPassword(g);
      if (pw && safeEqual(token, pw)) groups = [g.name];
    }
  }
  if (!groups) {
    recent.push(now); failures.set(ip, recent);
    throw new HttpError(401, 'Grupo ou palavra-passe incorretos.');
  }
  return new Set(groups);
}

// Atrás de um proxy/CDN (Cloudflare, Caddy, Render…) o IP real vem em cabeçalhos; só confiamos neles com TRUST_PROXY=1.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientIp(req) {
  if (TRUST_PROXY) {
    const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (h) return h;
  }
  return req.socket.remoteAddress || '?';
}

// limitação simples de pedidos por IP (protege a quota Groq)
const hits = new Map();
// Um balde por (IP, rota): a atividade do mentor não bloqueia os colaboradores, e vários colegas
// atrás do mesmo IP de escritório (NAT) não esgotam o limite uns dos outros com facilidade.
function rateLimit(req, max = 60, windowMs = 60_000, bucket = 'geral') {
  const key = clientIp(req) + '|' + bucket;
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (arr.length > max) throw new HttpError(429, 'Demasiados pedidos. Espera um minuto.');
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B-\u001F]/g, '').trim().slice(0, max);

// ---------- semana (Europe/Lisbon), maturidade e listas do mentor ----------
const lisbonDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
function isoWeekOf(dateStr) {
  const [y, m, dd] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);          // quinta-feira da semana ISO
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const w = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}
const currentWeek = () => isoWeekOf(lisbonDate());
// segunda a domingo de uma semana ISO, como 'YYYY-MM-DD'
function weekBounds(key) {
  const [y, w] = key.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon = new Date(jan4);
  mon.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (w - 1) * 7);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const f = (d) => d.toISOString().slice(0, 10);
  return { from: f(mon), to: f(sun) };
}
const daysAgo = (n) => lisbonDate(new Date(Date.now() - n * 86_400_000));
const rid = () => crypto.randomBytes(6).toString('hex');
const effMaturity = (s) => s.maturityHistory?.at(-1)?.level ?? s.profile?.nivel_maturidade ?? null;
const rosterGroup = (name) => readRoster().groups.find((g) => g.name === name);
const yesno = (v) => (v === 'sim' || v === 'nao' ? v : '');
const intIn = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
const dateOr = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : lisbonDate());

// listas geridas pelo mentor dentro de cada sessão
const LISTS = {
  notes: { max: 100, make: (b) => { const text = clean(b.text, 1000); return text ? { text } : null; } },
  improvements: { max: 200, make: (b) => { const title = clean(b.title, 160); return title ? { title, process: clean(b.process, 160), minutes: intIn(b.minutes, 0, 10000), date: dateOr(b.date) } : null; } },
  commitments: { max: 200, make: (b) => { const text = clean(b.text, 300); return text ? { text, done: Boolean(b.done) } : null; } },
  processes: { max: 100, make: (b) => { const name = clean(b.name, 160); return name ? { name, exists: yesno(b.exists), simplify: yesno(b.simplify), automate: yesno(b.automate), note: clean(b.note, 300) } : null; } },
};
const TAGS = new Set(['precisa-apoio', 'pode-ajudar', 'atencao']);
const GOAL_STATUS = new Set(['por-comecar', 'em-curso', 'concluido']);
const SOL_KINDS = new Set(['prompt', 'agente', 'skill', 'automacao', 'outro']);

function checkinView(s) {
  const week = currentWeek();
  const open = (s.commitments || []).filter((c) => !c.done).at(-1);   // o mais antigo por fechar
  return {
    name: s.name, first: s.name.split(' ')[0], week, weekNumber: Number(week.split('-W')[1]),
    goal: s.goal || s.profile?.objetivo_sugerido || '',
    commitment: open?.text || '',
    current: (s.checkins || []).find((c) => c.week === week) || null,
    recent: (s.checkins || []).filter((c) => c.week !== week).slice(0, 3).map((c) => ({ week: c.week, did: c.did, next: c.next })),
  };
}

function publicView(s) {
  const pending = s.pending;
  return {
    id: s.id, name: s.name, status: s.status,
    answered: s.turns.filter((t) => t.a != null).length, total: MAX_QUESTIONS,
    reaction: s.status === 'in_progress' ? pending?.reaction || '' : '',
    question: s.status === 'in_progress' ? pending?.question : null,
    options: s.status === 'in_progress' ? pending?.options || [] : [],
    // o participante NÃO recebe as dicas/perguntas dirigidas ao mentor
    profile: s.status === 'done' && s.profile ? {
      resumo: s.profile.resumo, primeiro_passo: s.profile.primeiro_passo,
      quick_win: s.profile.quick_win, objetivo: s.profile.objetivo_sugerido,
    } : null,
    goal: s.goal || '', request: s.request?.text || '',
  };
}

// ---------- rotas ----------
async function handleApi(req, res, url) {
  const { pathname } = url;
  const m = req.method === 'HEAD' ? 'GET' : req.method;   // monitores (UptimeRobot) usam HEAD; o Node omite o corpo

  if (pathname !== '/api/config') await dbReady;   // /api/config não precisa dos dados

  if (m === 'GET' && pathname === '/api/config') {
    return json(res, 200, {
      needsCode: Boolean(INVITE_CODE),
      groups: readRoster().groups.map((g) => ({ name: g.name })),   // só nomes de grupo: pessoas e mentores só via /api/roster (com código)
      adminAll: Boolean(ADMIN_PASSWORD),
      total: MAX_QUESTIONS,
    });
  }

  // Lista de pessoas: só com o código de convite (se estiver definido)
  if (m === 'POST' && pathname === '/api/roster') {
    rateLimit(req, 60, 60_000, 'roster');
    const b = await readBody(req);
    if (INVITE_CODE && !safeEqual(b.code || '', INVITE_CODE)) throw new HttpError(403, 'Código de convite incorreto.');
    const doneNames = (g) => g.members.filter((n) => Object.values(db.sessions).some((x) => x.group === g.name && x.name === n && x.status === 'done'));
    return json(res, 200, { groups: readRoster().groups.map((g) => ({ name: g.name, mentor: g.mentor, members: g.members, done: doneNames(g) })) });
  }

  if (m === 'POST' && pathname === '/api/start') {
    rateLimit(req, 60, 60_000, 'start');
    const b = await readBody(req);
    if (INVITE_CODE && !safeEqual(b.code || '', INVITE_CODE)) throw new HttpError(403, 'Código de convite incorreto.');
    const group = readRoster().groups.find((g) => g.name === b.group);
    const name = clean(b.name, 80);
    if (!group || !group.members.includes(name)) throw new HttpError(400, 'Seleciona o teu grupo e o teu nome.');
    let s = Object.values(db.sessions).find((x) => x.name === name && x.group === group.name);
    if (s && s.status === 'done' && b.id !== s.id) throw new HttpError(409, 'Esta pessoa já respondeu. Se precisares de alterar alguma coisa, fala com o teu mentor.');
    if (!s) {
      s = {
        id: crypto.randomBytes(16).toString('hex'), name, group: group.name, mentor: group.mentor,
        status: 'in_progress', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        turns: [], pending: {
          question: 'Olá, ' + name.split(' ')[0] + '! Para começar: qual é a tua área ou função na empresa, e em que consiste o teu trabalho no dia a dia?',
          reaction: '',
          options: [
            { emoji: '📣', label: 'Marketing' }, { emoji: '🤝', label: 'Comercial / Vendas' },
            { emoji: '💶', label: 'Financeiro / Administrativo' }, { emoji: '🗂️', label: 'Operações / Projetos' },
            { emoji: '💻', label: 'Tecnologia / Desenvolvimento' }, { emoji: '👥', label: 'Pessoas / RH' },
          ],
        }, profile: null,
      };
      db.sessions[s.id] = s;
      await save(s);
    }
    return json(res, 200, publicView(s));
  }

  if (m === 'GET' && pathname === '/api/session') {
    const s = db.sessions[url.searchParams.get('id')];
    if (!s) throw new HttpError(404, 'Sessão não encontrada.');
    return json(res, 200, publicView(s));
  }

  if (m === 'POST' && pathname === '/api/answer') {
    rateLimit(req, 120, 60_000, 'answer');
    const b = await readBody(req);
    const s = db.sessions[b.id];
    if (!s) throw new HttpError(404, 'Sessão não encontrada.');
    if (s.status !== 'in_progress' || !s.pending) return json(res, 200, publicView(s));
    const allowed = new Set((s.pending.options || []).map((o) => (typeof o === 'string' ? o : o.label)));
    const picks = (Array.isArray(b.picks) ? b.picks : []).map((p) => clean(p, 80)).filter((p) => allowed.has(p)).slice(0, 8);
    const extra = clean(b.answer, 1500);
    if (!picks.length && extra.length < 2) throw new HttpError(400, 'Escolhe uma opção ou escreve uma resposta.');
    const answer = [picks.join(', '), extra].filter(Boolean).join(' — ');
    const prev = s.pending;
    s.turns.push({ q: prev.question, a: answer, picks, extra, at: new Date().toISOString() });
    s.pending = null;
    s.updatedAt = new Date().toISOString();
    try {
      if (s.turns.length >= MAX_QUESTIONS) {
        s.profile = await buildProfile(s);
        s.status = 'done';
        s.maturityHistory = s.profile.nivel_maturidade ? [{ level: s.profile.nivel_maturidade, at: new Date().toISOString(), by: 'ia' }] : [];
      } else {
        s.pending = await nextQuestion(s);
      }
    } catch (e) {
      // repõe a pergunta para a pessoa poder tentar de novo, sem perder a resposta
      s.turns.pop();
      s.pending = prev;
      throw e;
    }
    await save(s);
    return json(res, 200, publicView(s));
  }

  if (m === 'POST' && pathname === '/api/followup') {
    rateLimit(req, 60, 60_000, 'followup');
    const b = await readBody(req);
    const s = db.sessions[b.id];
    if (!s) throw new HttpError(404, 'Sessão não encontrada.');
    if (s.status !== 'done') throw new HttpError(400, 'Conclui primeiro o questionário.');
    s.goal = clean(b.goal, 400);
    const text = clean(b.request, 1000);
    if (text !== (s.request?.text || '')) s.request = text ? { text, status: 'novo', at: new Date().toISOString() } : null;
    s.updatedAt = new Date().toISOString();
    await save(s);
    return json(res, 200, publicView(s));
  }

  if (m === 'GET' && pathname === '/api/checkin') {
    const s = db.sessions[url.searchParams.get('id')];
    if (!s) throw new HttpError(404, 'Link inválido. Pede ao teu mentor o teu link pessoal.');
    if (s.status !== 'done') throw new HttpError(400, 'Conclui primeiro o questionário.');
    return json(res, 200, checkinView(s));
  }

  if (m === 'POST' && pathname === '/api/checkin') {
    rateLimit(req, 60, 60_000, 'checkin');
    const b = await readBody(req);
    const s = db.sessions[b.id];
    if (!s) throw new HttpError(404, 'Link inválido. Pede ao teu mentor o teu link pessoal.');
    if (s.status !== 'done') throw new HttpError(400, 'Conclui primeiro o questionário.');
    const did = clean(b.did, 1000), next = clean(b.next, 1000), blocked = clean(b.blocked, 1000);
    if (did.length < 2 && next.length < 2) throw new HttpError(400, 'Escreve pelo menos o que fizeste ou o que queres avançar.');
    const week = currentWeek(), now = new Date().toISOString();
    s.checkins ||= [];
    const cur = s.checkins.find((c) => c.week === week);
    if (cur) Object.assign(cur, { did, next, blocked, updatedAt: now });
    else s.checkins.unshift({ id: rid(), week, did, next, blocked, at: now, updatedAt: now });
    s.checkins = s.checkins.slice(0, 120);
    s.updatedAt = now;
    await save(s);
    return json(res, 200, checkinView(s));
  }

  // ----- mentor -----
  if (pathname.startsWith('/api/admin/')) {
    rateLimit(req, 240, 60_000, 'admin');
    const allowed = requireAdmin(req);

    if (m === 'GET' && pathname === '/api/admin/sessions') {
      const roster = readRoster();
      roster.groups = roster.groups.filter((g) => allowed.has(g.name));
      const sessions = Object.values(db.sessions).filter((s) => allowed.has(s.group))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const missing = [];
      for (const g of roster.groups) for (const n of g.members)
        if (!sessions.some((s) => s.name === n && s.group === g.name)) missing.push({ group: g.name, name: n });
      const solutions = Object.values(db.solutions).filter((x) => allowed.has(x.grp))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return json(res, 200, { total: MAX_QUESTIONS, week: currentWeek(), sessions, missing, solutions,
        members: Object.fromEntries(roster.groups.map((g) => [g.name, g.members])) });
    }

    // --- campos do mentor numa sessão (tags, maturidade, estado do objetivo) ---
    const mm2 = pathname.match(/^\/api\/admin\/sessions\/([a-f0-9]{32})\/(mentor|notes|improvements|commitments|processes)$/);
    if (mm2 && m === 'POST') {
      const s = db.sessions[mm2[1]];
      if (!s || !allowed.has(s.group)) throw new HttpError(404, 'Sessão não encontrada.');
      const b = await readBody(req), now = new Date().toISOString();
      if (mm2[2] === 'mentor') {
        if ('tags' in b) s.tags = [...new Set((Array.isArray(b.tags) ? b.tags : []).filter((t) => TAGS.has(t)))].slice(0, 5);
        if ('goalStatus' in b && GOAL_STATUS.has(b.goalStatus)) s.goalStatus = b.goalStatus;
        if ('goalNote' in b) s.goalNote = clean(b.goalNote, 500);
        if ('maturity' in b) {
          const lvl = Math.round(Number(b.maturity));
          if (!(lvl >= 1 && lvl <= 5)) throw new HttpError(400, 'Nível inválido.');
          s.maturityHistory ||= [];
          if (!s.maturityHistory.length && s.profile?.nivel_maturidade) s.maturityHistory.push({ level: s.profile.nivel_maturidade, at: s.updatedAt || now, by: 'ia' });
          if (effMaturity(s) !== lvl) s.maturityHistory.push({ level: lvl, at: now, by: 'mentor' });
        }
      } else {
        const name = mm2[2], def = LISTS[name];
        s[name] ||= [];
        if (b.op === 'add') {
          const made = def.make(b.item || {});
          if (!made) throw new HttpError(400, 'Campos em falta.');
          if (s[name].length >= def.max) throw new HttpError(400, 'Limite atingido.');
          s[name].unshift({ id: rid(), at: now, ...made, ...(name === 'commitments' ? { doneAt: made.done ? now : null } : {}) });
        } else if (b.op === 'update') {
          const cur = s[name].find((x) => x.id === b.id);
          if (!cur) throw new HttpError(404, 'Item não encontrado.');
          const made = def.make({ ...cur, ...(b.item || {}) });
          if (!made) throw new HttpError(400, 'Campos em falta.');
          Object.assign(cur, made, { updatedAt: now });
          if (name === 'commitments') cur.doneAt = cur.done ? (cur.doneAt || now) : null;
        } else if (b.op === 'remove') {
          s[name] = s[name].filter((x) => x.id !== b.id);
        } else throw new HttpError(400, 'Operação inválida.');
      }
      s.updatedAt = now;
      await save(s);
      return json(res, 200, { session: s });
    }

    // --- biblioteca de soluções (por grupo) ---
    if (m === 'POST' && pathname === '/api/admin/solutions') {
      const b = await readBody(req), now = new Date().toISOString();
      const item = b.item || {};
      const shape = (g, base = {}) => {
        const members = new Set(g.members);
        const title = clean(item.title ?? base.title, 120);
        if (!title) throw new HttpError(400, 'Dá um título à solução.');
        const kind = SOL_KINDS.has(item.kind ?? base.kind) ? (item.kind ?? base.kind) : 'outro';
        const author = members.has(item.author ?? base.author) ? (item.author ?? base.author) : '';
        const uses = [...new Set((Array.isArray(item.uses ?? base.uses) ? (item.uses ?? base.uses) : []).filter((n) => members.has(n)))];
        return { title, kind, description: clean(item.description ?? base.description, 600), author, uses };
      };
      if (b.op === 'add') {
        const g = rosterGroup(item.grp);
        if (!g || !allowed.has(g.name)) throw new HttpError(403, 'Grupo não permitido.');
        const sol = { id: rid(), grp: g.name, at: now, updatedAt: now, ...shape(g) };
        db.solutions[sol.id] = sol; await saveSolution(sol);
        return json(res, 200, { solution: sol });
      }
      const sol = db.solutions[String(b.id || '')];
      if (!sol || !allowed.has(sol.grp)) throw new HttpError(404, 'Solução não encontrada.');
      if (b.op === 'update') {
        Object.assign(sol, shape(rosterGroup(sol.grp), sol), { updatedAt: now });
        await saveSolution(sol);
        return json(res, 200, { solution: sol });
      }
      if (b.op === 'remove') { delete db.solutions[sol.id]; await removeSolution(sol.id); return json(res, 200, { ok: true }); }
      throw new HttpError(400, 'Operação inválida.');
    }

    // --- IA: resumo de 2 linhas para o CEO e guião da sessão de sexta ---
    if (m === 'POST' && (pathname === '/api/admin/summary' || pathname === '/api/admin/prepare')) {
      const b = await readBody(req);
      const g = rosterGroup(String(b.group || ''));
      if (!g || !allowed.has(g.name)) throw new HttpError(403, 'Escolhe um grupo.');
      const wk = b.week == null ? currentWeek() : String(b.week);
      if (!/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(wk)) throw new HttpError(400, 'Semana inválida.');
      if (wk > currentWeek()) throw new HttpError(400, 'Ainda não dá para preparar uma semana futura.');
      const week = wk, { from, to } = weekBounds(wk), cut = (v, n = 220) => String(v || '').slice(0, n);
      const people = Object.values(db.sessions).filter((x) => x.group === g.name && x.status === 'done').map((x) => ({
        nome: x.name,
        objetivo: cut(x.goal || x.profile?.objetivo_sugerido, 200),
        estado_objetivo: x.goalStatus || 'por-comecar',
        maturidade: effMaturity(x),
        checkin_semana: (x.checkins || []).find((c) => c.week === week) ? (({ did, next, blocked }) => ({ fez: cut(did), quer_avancar: cut(next), bloqueios: cut(blocked) }))((x.checkins || []).find((c) => c.week === week)) : null,
        melhorias_da_semana: (x.improvements || []).filter((i) => i.date >= from && i.date <= to).map((i) => ({ titulo: cut(i.title, 120), minutos_por_semana: i.minutes })),
        compromisso_aberto: cut((x.commitments || []).filter((c) => !c.done).at(-1)?.text, 160),
        pedido_por_tratar: x.request?.status === 'novo' ? cut(x.request.text, 160) : '',
        tarefas_repetitivas: (x.profile?.tarefas_repetitivas || []).slice(0, 3).map((t) => cut(t, 120)),
        bloqueios_iniciais: (x.profile?.bloqueios || []).slice(0, 2).map((t) => cut(t, 120)),
        processos_por_rever: (x.processes || []).filter((p) => !p.exists || !p.simplify || !p.automate).slice(0, 2).map((p) => cut(p.name, 100)),
        etiquetas: x.tags || [],
      }));
      if (!people.length) throw new HttpError(400, 'Ainda ninguém concluiu o questionário neste grupo.');
      const list = (v, n) => (Array.isArray(v) ? v.map((t) => cut(t, 300)).filter(Boolean).slice(0, n) : []);

      if (pathname === '/api/admin/summary') {
        const active = people.some((p) => p.checkin_semana || p.melhorias_da_semana.length);
        if (!active) return json(res, 200, { lines: ['Sem check-ins nem melhorias registados nesta semana.'], note: 'Sem dados para resumir.' });
        const out = await groq([
          { role: 'system', content: `${CONTEXT}\n\nÉs o assistente de um mentor. Escreve EXATAMENTE 2 linhas curtas (máx. 200 caracteres cada), em português de Portugal, para o mentor enviar ao CEO após a sessão de sexta: (1) resultados e avanços da semana, (2) bloqueios/necessidades ou próximo passo. Sê factual, só com o que está nos dados, sem inventar números. Responde APENAS com JSON: {"linhas": ["...", "..."]}` },
          { role: 'user', content: `Grupo: ${g.name} (mentor ${g.mentor}). Semana ${week}.\n${JSON.stringify(people)}` },
        ], { temperature: 0.3, max_tokens: 400 });
        const lines = list(out.linhas, 2);
        if (!lines.length) throw new HttpError(502, 'A IA não devolveu o resumo. Tenta novamente.');
        return json(res, 200, { lines });
      }

      const out = await groq([
        { role: 'system', content: `${CONTEXT}\n\nÉs o assistente de um mentor e vais preparar o guião de 1 hora da sessão de sexta, em português de Portugal, com esta estrutura: 10 min resultados da semana; 10 min micro-aprendizagem (dica prática, agente, skill, prompt ou caso de uso); 10 min revisão de processos (perguntas por ordem: deve existir? pode ser simplificado? só depois: pode ser automatizado?); 25 min sprint de execução; 5 min compromisso. Usa apenas os dados fornecidos; sê concreto e curto; não inventes factos. Responde APENAS com JSON:
{"resultados":[{"nome":"","texto":"vitória ou avanço da semana, ou 'sem check-in'"}],
 "micro":{"tema":"","porque":"liga aos bloqueios/tarefas mais comuns do grupo","exemplo":"um prompt ou exemplo pronto a mostrar"},
 "processo":{"pessoa":"","nome":"o processo a rever","perguntas":["Deve existir?","Pode ser simplificado?","Só depois: pode ser automatizado?"],"porque":""},
 "sprint":[{"nome":"","foco":"em que trabalhar nos 25 min e como o mentor ajuda"}],
 "compromissos":[{"nome":"","sugestao":"entrega concreta até à próxima sessão"}]}` },
        { role: 'user', content: `Grupo: ${g.name} (mentor ${g.mentor}). Semana ${week}.\n${JSON.stringify(people)}` },
      ], { temperature: 0.4, max_tokens: 1800 });
      const rows = (v, k1, k2, n = 8) => (Array.isArray(v) ? v.map((r) => ({ [k1]: cut(r?.[k1], 80), [k2]: cut(r?.[k2], 400) })).filter((r) => r[k1] && r[k2]).slice(0, n) : []);
      return json(res, 200, { plan: {
        resultados: rows(out.resultados, 'nome', 'texto'),
        micro: { tema: cut(out.micro?.tema, 160), porque: cut(out.micro?.porque, 400), exemplo: cut(out.micro?.exemplo, 600) },
        processo: { pessoa: cut(out.processo?.pessoa, 80), nome: cut(out.processo?.nome, 200), porque: cut(out.processo?.porque, 400),
          perguntas: list(out.processo?.perguntas, 3).length ? list(out.processo?.perguntas, 3) : ['Deve existir?', 'Pode ser simplificado?', 'Só depois: pode ser automatizado?'] },
        sprint: rows(out.sprint, 'nome', 'foco'),
        compromissos: rows(out.compromissos, 'nome', 'sugestao'),
      }, week });
    }

    const mm = pathname.match(/^\/api\/admin\/sessions\/([a-f0-9]{32})(\/regenerate|\/resolve)?$/);
    if (mm) {
      const s = db.sessions[mm[1]];
      if (!s || !allowed.has(s.group)) throw new HttpError(404, 'Sessão não encontrada.');
      if (m === 'DELETE' && !mm[2]) {
        delete db.sessions[s.id]; await removeSession(s.id);
        return json(res, 200, { ok: true });
      }
      if (m === 'POST' && mm[2] === '/resolve') {
        if (!s.request?.text) throw new HttpError(400, 'Sem pedido.');
        s.request.status = s.request.status === 'resolvido' ? 'novo' : 'resolvido';
        await save(s);
        return json(res, 200, { request: s.request });
      }
      if (m === 'POST' && mm[2] === '/regenerate') {
        if (!s.turns.length) throw new HttpError(400, 'Sem respostas para resumir.');
        s.profile = await buildProfile(s);
        await save(s);
        return json(res, 200, { profile: s.profile });
      }
    }
  }

  throw new HttpError(404, 'Não encontrado.');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // Leve, sem Supabase: para o Health Check do Render e para o UptimeRobot
    if (url.pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      return json(res, 200, { ok: true, dataLoaded: dbLoaded });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/admin.html') return send(res, 301, '', { Location: '/admin' });
    if (rel === '/') rel = '/index.html';
    else if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
    else if (rel === '/checkin' || rel === '/checkin/') rel = '/checkin.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Proibido.');
    let data;
    try { data = await fsp.readFile(file); } catch { throw new HttpError(404, 'Não encontrado.'); }
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    const status = e instanceof HttpError ? e.status : 500;
    json(res, status, { error: e instanceof HttpError ? e.message : 'Erro interno.' });
  }
});

server.listen(PORT, () => {
  console.log(`Servidor em http://localhost:${PORT}`);
  if (!GROQ_API_KEY) console.warn('AVISO: GROQ_API_KEY não definida (copia .env.example para .env).');
  const noPw = readRoster().groups.filter((g) => !groupPassword(g)).map((g) => g.name);
  if (noPw.length) console.warn(`AVISO: sem palavra-passe de mentor (ADMIN_PASSWORD_<GRUPO> no .env) para: ${noPw.join(', ')}.`);
  if (!ADMIN_PASSWORD) console.warn('Nota: ADMIN_PASSWORD (acesso global a todos os grupos) não definida.');
});
