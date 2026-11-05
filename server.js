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
let db = { sessions: {} };

// Com SUPABASE_URL + SUPABASE_SERVICE_KEY as respostas ficam no Supabase (sobrevivem a deploys/reinícios).
// Sem elas, usa-se o ficheiro data/responses.json (desenvolvimento local).
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const useSupabase = Boolean(SB_URL && SB_KEY);
const sbFetch = (p, opts = {}) => fetch(`${SB_URL}/rest/v1/${p}`, {
  ...opts, signal: AbortSignal.timeout(15_000),
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});

const pendingWrites = new Map();   // id -> sessão a gravar, ou null para apagar
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
      for (const [id, sess] of [...pendingWrites]) {
        const res = sess
          ? await sbFetch('sessions?on_conflict=id', {
              method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
              body: JSON.stringify({ id, grp: sess.group, name: sess.name, status: sess.status, data: sess, updated_at: sess.updatedAt }),
            })
          : await sbFetch(`sessions?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
        if (pendingWrites.get(id) === sess) pendingWrites.delete(id);   // só limpa se não houve alteração entretanto
      }
    } catch (e) {
      console.error('Erro a gravar (fica em fila e tenta de novo):', e.message);
    } finally { flushing = null; }
  })();
  return flushing;
}
const save = (sess) => { pendingWrites.set(sess.id, sess); return flush(); };
const removeSession = (id) => { pendingWrites.set(id, null); return flush(); };
setInterval(() => { if (pendingWrites.size) flush(); }, 15_000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await flush(); process.exit(0); });

if (useSupabase) {
  const res = await sbFetch('sessions?select=data&limit=5000');
  if (!res.ok) { console.error('Não consegui ler do Supabase:', res.status, await res.text()); process.exit(1); }
  for (const row of await res.json()) db.sessions[row.data.id] = row.data;
  console.log(`Supabase: ${Object.keys(db.sessions).length} sessões carregadas.`);
} else {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* novo */ }
  console.log('Armazenamento: ficheiro local (define SUPABASE_URL e SUPABASE_SERVICE_KEY para usar o Supabase).');
}
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
function rateLimit(req, max = 40, windowMs = 60_000) {
  const ip = clientIp(req);
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(ip, arr);
  if (arr.length > max) throw new HttpError(429, 'Demasiados pedidos. Espera um minuto.');
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B-\u001F]/g, '').trim().slice(0, max);

function publicView(s) {
  const pending = s.pending;
  return {
    id: s.id, name: s.name, status: s.status,
    answered: s.turns.filter((t) => t.a != null).length, total: MAX_QUESTIONS,
    reaction: s.status === 'in_progress' ? pending?.reaction || '' : '',
    question: s.status === 'in_progress' ? pending?.question : null,
    options: s.status === 'in_progress' ? pending?.options || [] : [],
    profile: s.status === 'done' ? s.profile : null,
  };
}

// ---------- rotas ----------
async function handleApi(req, res, url) {
  const { pathname } = url;
  const m = req.method === 'HEAD' ? 'GET' : req.method;   // monitores (UptimeRobot) usam HEAD; o Node omite o corpo

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
    rateLimit(req, 20);
    const b = await readBody(req);
    if (INVITE_CODE && !safeEqual(b.code || '', INVITE_CODE)) throw new HttpError(403, 'Código de convite incorreto.');
    return json(res, 200, { groups: readRoster().groups.map((g) => ({ name: g.name, mentor: g.mentor, members: g.members })) });
  }

  if (m === 'POST' && pathname === '/api/start') {
    rateLimit(req);
    const b = await readBody(req);
    if (INVITE_CODE && !safeEqual(b.code || '', INVITE_CODE)) throw new HttpError(403, 'Código de convite incorreto.');
    const group = readRoster().groups.find((g) => g.name === b.group);
    const name = clean(b.name, 80);
    if (!group || !group.members.includes(name)) throw new HttpError(400, 'Seleciona o teu grupo e o teu nome.');
    let s = Object.values(db.sessions).find((x) => x.name === name && x.group === group.name);
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
    rateLimit(req, 20);
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

  // ----- mentor -----
  if (pathname.startsWith('/api/admin/')) {
    rateLimit(req, 120);
    const allowed = requireAdmin(req);

    if (m === 'GET' && pathname === '/api/admin/sessions') {
      const roster = readRoster();
      roster.groups = roster.groups.filter((g) => allowed.has(g.name));
      const sessions = Object.values(db.sessions).filter((s) => allowed.has(s.group))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const missing = [];
      for (const g of roster.groups) for (const n of g.members)
        if (!sessions.some((s) => s.name === n && s.group === g.name)) missing.push({ group: g.name, name: n });
      return json(res, 200, { total: MAX_QUESTIONS, sessions, missing });
    }

    const mm = pathname.match(/^\/api\/admin\/sessions\/([a-f0-9]{32})(\/regenerate)?$/);
    if (mm) {
      const s = db.sessions[mm[1]];
      if (!s || !allowed.has(s.group)) throw new HttpError(404, 'Sessão não encontrada.');
      if (m === 'DELETE' && !mm[2]) {
        delete db.sessions[s.id]; await removeSession(s.id);
        return json(res, 200, { ok: true });
      }
      if (m === 'POST' && mm[2]) {
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
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
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
