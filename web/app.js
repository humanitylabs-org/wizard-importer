'use strict';
/* Importer screen: pick a source → guide + wait → preview → "What I know about you" → import → done; undo per import.
 * Every action goes to this app's own API (app/server.py), which relays to the agent's bring-data engine.
 * Owner and export text is always set with textContent. */
const G = window.ImporterGuides;
const $ = id => document.getElementById(id);
const screen = $('screen');
const WA = window.WizardApp && window.WizardApp.version === 1 ? window.WizardApp : null;
const WAIT_KEY = 'importer.waiting.v1';
const POLL_MS = 5000, MAIL_MS = 60000;

const S = {
  view: 'home',            // home | guide | into | scanning | preview | importing | done | error
  dest: '',                // '' = the agent this app is connected to, else an agent id from sources.into
  scanArgs: null, lastBody: null,
  status: null, sources: null, imports: [],
  source: null,            // guide id
  waiting: null,           // {source, since}
  scan: null, choice: null, result: null, error: '', links: null,
  uploads: [],             // [{name, pct, path, error}]
  mail: { state: 'unknown', hits: [] },
  seen: new Set(),         // Files entries already there (only a new arrival continues by itself)
};

/* ---------------- small DOM helpers ---------------- */
function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false && kid !== '' && kid !== 0) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}
function svg(d) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); return s;
}
const say = (text, visible = false) => { const s = $('status'); s.classList.toggle('wz-sr', !visible); s.textContent = text; };
const fmt = n => Number(n || 0).toLocaleString();
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : (many || one + 's')}`;
const bytes = n => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
const mark = g => g && g.mark
  ? h('span', { class: 'wz-tile imp-mark' + (g.mono ? ' mono' : ''), 'aria-hidden': 'true' }, h('img', { src: g.mark, alt: '' }), g.glyph ? h('i', { text: g.glyph }) : null)
  : h('span', { class: 'wz-tile imp-mark', 'aria-hidden': 'true', text: (g && g.glyph) || '•' });
const check = () => h('span', { class: 'wz-check', 'aria-hidden': 'true' }, h('i', {}, svg('M5 12.5l4.5 4.5L19 7.5')));
const KIND_NAME = { chatgpt: 'ChatGPT', claude: 'Claude', 'claude-code': 'Claude Code', hermes: 'Hermes', 'claude-links': 'Claude download links' };
/* Owner-facing reason: never a raw errno or host path (older engines sent them through as-is). */
function plainError(text) {
  const t = String(text || '');
  if (/Errno 13|Permission denied/i.test(t)) return /\/Imported|media/.test(t)
    ? 'Your agent isn’t allowed to write in Files › Imported. Fix: in Files, create the folder Imported at the top level, then tap Try again.'
    : 'Your agent isn’t allowed to write there. Ask your Wizard to fix the folder’s permissions, then tap Try again.';
  if (/\[Errno \d+\]/.test(t)) return 'Saving failed (the disk may be full or busy). Tap Try again.';
  return t;
}
const PART_NAME = { chats: 'Chats', skills: 'Skills', about: 'What I know about you', personality: 'Personality', facts: 'Fact store' };
const intoList = () => S.sources?.into || [];
const destLabel = id => !id || id === 'here' ? (S.sources?.here || 'this agent') : (intoList().find(d => d.id === id)?.label || id);
/* A Hermes source row says plainly which agent it is. */
function localTitle(s) {
  if (s.kind !== 'hermes') return s.label || KIND_NAME[s.kind];
  if (s.self) return 'Move into Wizard OS';
  const m = String(s.path || '').match(/\/profiles\/([^/]+)\/?$/);
  if (m) return `Hermes profile ${m[1]}`;
  return /^Hermes on this box$/.test(s.label || '') ? 'This box’s main agent' : (s.label || 'Hermes');
}
const ext = (url, text, cls) => h('a', { class: cls, href: url, target: '_blank', rel: 'noopener noreferrer', text });

/* ---------------- API ---------------- */
async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wizard-Request': 'importer' }, body: JSON.stringify(body) };
  const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  let data = {};
  try { data = await r.json(); } catch (e) { /* empty body */ }
  if (!r.ok) throw Object.assign(new Error(data.error || 'That didn’t work. Try again.'), { reason: data.reason });
  return data;
}
function upload(file, onPct) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', 'api/upload?name=' + encodeURIComponent(file.name));
    x.setRequestHeader('X-Wizard-Request', 'importer');
    x.upload.onprogress = e => { if (e.lengthComputable) onPct(Math.round(100 * e.loaded / e.total)); };
    x.onload = () => {
      let d = {}; try { d = JSON.parse(x.responseText); } catch (e) { /* empty body */ }
      if (x.status === 200 && d.path) resolve(d); else reject(new Error(d.error || 'The upload didn’t finish. Try again.'));
    };
    x.onerror = () => reject(new Error('The upload didn’t finish. Check your connection and try again.'));
    x.send(file);
  });
}

/* ---------------- navigation + Back ---------------- */
let hold = null;
function go(view) {
  if (view !== S.view && view !== 'scanning') say('');
  S.view = view;
  // An unfinished choice or a running import holds a shell update (it never reloads under the owner).
  const busy = view === 'preview' || view === 'importing';
  if (busy && !hold && WA) hold = WA.update.hold('Import not finished');
  if (!busy && hold) { hold.release(); hold = null; }
  render(); screen.scrollTop = 0;
}
function fit(area) { area.style.height = 'auto'; area.style.height = (area.scrollHeight + 2) + 'px'; }
function back() {
  if (S.view === 'importing' || S.view === 'scanning') return true; // stays until the step answers
  if (S.view === 'preview') { const to = S.from === 'guide' ? 'guide' : S.from === 'into' ? 'into' : 'home'; if (to === 'home') { S.dest = ''; S.selfPath = null; } go(to); if (S.view === 'guide') poll(); else refresh(); return true; }
  if (S.view === 'guide') { S.waiting = null; saveWaiting(); clearTimeout(pollT); clearTimeout(mailT); } // leaving the guide cancels the wait
  if (S.view === 'guide' || S.view === 'error' || S.view === 'done' || S.view === 'into') { S.scan = null; S.links = null; S.dest = ''; S.selfPath = null; go('home'); refresh(); return true; }
  return false;
}
function finish() {
  // Done leaves the screen (Wizard rule): back to where the owner came from (Setup, Home).
  S.scan = S.result = null; S.view = 'home'; S.dest = ''; S.selfPath = null;
  const left = !!(WA && WA.nav && typeof WA.nav.back === 'function' && WA.nav.back());
  if (!left) render();
  refresh();
}

/* ---------------- data ---------------- */
const key = f => f.path + '|' + f.modified;
async function refresh() {
  try {
    const [sources, imports] = await Promise.all([api('api/sources'), api('api/imports')]);
    if (!S.sources) for (const f of sources.files || []) S.seen.add(key(f));
    const elsewhere = await Promise.all((sources.into || []).map(d => api('api/imports?dest=' + encodeURIComponent(d.id))
      .then(r => (r.imports || []).map(i => ({ ...i, dest: d.id, into: d.label }))).catch(() => [])));
    S.sources = sources; S.imports = [...(imports.imports || []), ...elsewhere.flat()];
    S.status = { connected: true, read_only: !!sources.read_only };
  } catch (e) {
    S.status = { connected: false, message: e.message, reason: e.reason };
  }
  if (S.view === 'home' || S.view === 'guide') render();
}
function saveWaiting() {
  try { if (S.waiting) localStorage.setItem(WAIT_KEY, JSON.stringify(S.waiting)); else localStorage.removeItem(WAIT_KEY); } catch (e) { /* storage off */ }
}
function loadWaiting() { try { return JSON.parse(localStorage.getItem(WAIT_KEY) || 'null'); } catch (e) { return null; } }

/* A new export landed in Files while we wait: carry on by itself. */
let pollT = 0, mailT = 0;
async function poll() {
  clearTimeout(pollT);
  if (S.view !== 'guide') return;
  if (!document.hidden) {
    await refresh();
    const want = S.source;
    const fresh = (S.sources?.files || []).filter(f => !S.seen.has(key(f))
      && (f.kind === want || (want === 'claude' && f.kind === 'claude-links') || (want === 'other' && f.kind)));
    for (const f of fresh) S.seen.add(key(f));
    if (fresh.length && S.view === 'guide') {
      const f = fresh[0];
      if (f.kind === 'claude-links') { S.links = f; render(); }
      else { say(`${f.name} arrived. Reading it…`, true); startScan({ path: f.path }); return; }
    }
  }
  pollT = setTimeout(poll, POLL_MS);
}

/* ---------------- Mail: spot the export email (only when the Mail app is connected) ---------------- */
const MAIL = '/wizard-mail/';
async function mailFetch(path) {
  const r = await fetch(MAIL + path, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Wizard-Request': 'mail' } });
  if (!r.ok) throw new Error('mail ' + r.status);
  return r.json();
}
async function mailProbe() {
  if (S.mail.state !== 'unknown') return;
  try { const a = await mailFetch('api/accounts'); S.mail.state = (Array.isArray(a) ? a : a.accounts || []).length ? 'ready' : 'none'; }
  catch (e) { S.mail.state = 'none'; }
  if (S.view === 'guide') render();
}
async function mailLook(auto) {
  const g = G[S.source];
  clearTimeout(mailT);
  if (!g || !g.mail || S.mail.state !== 'ready' || S.mail.busy || S.view !== 'guide') return;
  S.mail.busy = true; if (!auto) render();
  try {
    const list = await mailFetch('api/messages?folder=inbox&q=' + encodeURIComponent('data export'));
    const rows = (list.messages || []).filter(m => g.mail.test(`${m.from || ''} ${m.from_name || ''} ${m.subject || ''}`)).slice(0, 3);
    const hits = [];
    for (const m of rows) {
      let links = [];
      try {
        const full = await mailFetch(`api/message?account=${encodeURIComponent(m.account)}&id=${encodeURIComponent(m.id)}`);
        const text = `${full.html || ''} ${full.message?.body_text || full.message?.text || full.message?.body || ''}`;
        links = [...new Set((text.match(/https:\/\/[^\s"'<>)]+/g) || []).map(u => u.replace(/&amp;/g, '&')))]
          .filter(u => /download|export/i.test(u) && /openai|chatgpt|anthropic|claude/i.test(u)).slice(0, 4);
      } catch (e) { /* the subject alone still tells the owner it came */ }
      hits.push({ subject: m.subject || 'Export email', links });
    }
    S.mail.hits = hits;
  } catch (e) { S.mail.hits = []; }
  S.mail.looked = true; S.mail.busy = false;
  if (S.view === 'guide') render();
  if (S.view === 'guide' && !S.mail.hits.some(x => x.links.length)) mailT = setTimeout(() => mailLook(true), MAIL_MS);
}

/* ---------------- actions ---------------- */
function openGuide(id) {
  S.source = id; S.links = null; S.uploads = []; S.mail.hits = []; S.mail.looked = false;
  if (!['claude-code', 'hermes', 'other'].includes(id)) { S.waiting = { source: id, since: Date.now() }; saveWaiting(); }
  go('guide'); poll(); mailProbe().then(() => mailLook(true));
}
function startSelf(s) {
  // Move this agent into Wizard OS: the destination is another agent (one tap when there is only one).
  const into = intoList();
  if (!into.length) return;
  S.selfPath = s.path;
  if (into.length === 1) { S.dest = into[0].id; startScan({ path: s.path }, 'hermes'); return; }
  S.from = 'home'; go('into');
}
async function startScan(args, source) {
  clearTimeout(pollT); clearTimeout(mailT);
  if (source) S.source = source;
  if (S.view !== 'scanning' && S.view !== 'preview') S.from = S.view;
  S.error = ''; S.scanArgs = args; go('scanning');
  try {
    const scan = await api('api/scan', S.dest ? { ...args, dest: S.dest } : args);
    S.scan = scan; S.waiting = null; saveWaiting();
    const here = scan.personality && scan.personality.here;
    const blocked = scan.blocked || {};
    S.choice = {
      chats: (scan.counts.chats > 0 || scan.counts.projects > 0) && !blocked.chats,
      about: (scan.draft_facts || []).length > 0 && !blocked.about,
      store: (scan.counts.facts || 0) > 0,
      skills: scan.new_skill_count > 0,
      skillNames: new Set((scan.new_skills || []).map(s => s.name)), allSkills: true,
      personality: !!(scan.personality && scan.personality.found) && here !== 'custom',
      facts: (scan.draft_facts || []).flatMap(f => String(f).split(/\n+/)).map(x => x.replace(/^[-*•]\s*/, '').trim()).filter(Boolean).map(text => ({ text, on: true })),
    };
    go('preview');
  } catch (e) { S.error = plainError(e.message); go('error'); }
}
async function runImport() {
  const c = S.choice, sc = S.scan;
  const facts = c.about ? c.facts.filter(f => f.on).map(f => f.text.replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
  const body = {
    import_id: sc.import_id, chats: c.chats, personality: c.personality, skills: !c.skills ? [] : c.allSkills ? 'all' : [...c.skillNames],
    facts: !!c.store || undefined,
    about: facts.length ? { facts, text: '# About me\n\n' + facts.map(f => '- ' + f).join('\n') + `\n\n*From ${sc.source}, approved by you in the Importer.*` } : undefined,
  };
  if (S.dest) body.dest = S.dest;
  if (!body.chats && !body.personality && !body.skills.length && !body.about && !body.facts && body.skills !== 'all') { say('Choose at least one thing to bring in.', true); return; }
  await sendImport(body);
}
async function sendImport(body) {
  S.lastBody = body;
  go('importing');
  try { S.result = await api('api/import', body); go('done'); }
  catch (e) { S.error = plainError(e.message); go('error'); }
}
function retryFailed() {
  // Again with only the parts that failed: chats overwrite the same files, skills and memories already in are skipped.
  const failed = Object.keys(S.result?.errors || {}), b = S.lastBody || {};
  const body = { import_id: b.import_id, chats: failed.includes('chats') && b.chats, personality: failed.includes('personality') && b.personality,
    skills: failed.includes('skills') ? b.skills : [], facts: (failed.includes('facts') && b.facts) || undefined, about: failed.includes('about') ? b.about : undefined };
  if (b.dest) body.dest = b.dest;
  sendImport(body);
}
function pickDest() {
  const rows = [{ id: '', label: S.sources?.here || 'This agent', where: 'The agent this Importer is connected to' }, ...intoList()]
    .filter(d => !(S.scanArgs && S.selfPath && S.scanArgs.path === S.selfPath && !d.id));
  openSheet(() => [h('h2', { id: 'sheet-h', text: 'Bring into' }), h('ul', { class: 'wz-list' }, rows.map(d => h('li', {}, h('button', { class: 'wz-row', type: 'button',
    'aria-pressed': String((S.dest || '') === d.id), onclick: () => { closeSheet(); if ((S.dest || '') !== d.id) { S.dest = d.id; startScan(S.scanArgs); } } },
    check(), h('span', { class: 'wz-main' }, h('b', { text: d.label }), h('small', { text: d.where || '' }))))))]);
}
async function undo(entry) {
  closeSheet();
  say('Undoing…', true);
  try {
    const r = await api('api/undo', entry.dest ? { import_id: entry.import_id, dest: entry.dest } : { import_id: entry.import_id });
    const parts = [r.removed_files && plural(r.removed_files, 'file'), r.removed_skills && r.removed_skills.length && plural(r.removed_skills.length, 'skill'),
      r.removed_facts && plural(r.removed_facts, 'fact'),
      r.removed_memories && plural(r.removed_memories, 'memory', 'memories'), r.personality && 'personality ' + r.personality].filter(Boolean);
    say(`Undone: ${parts.join(', ') || 'nothing was left to remove'}.`, true);
    if (S.view === 'done') { S.result = null; go('home'); }
  } catch (e) { say(e.message, true); }
  refresh();
}
async function addFiles(files) {
  const list = [...files].filter(f => /\.(zip|json)$/i.test(f.name));
  if (!list.length) { say('Use the export .zip exactly as you downloaded it.', true); return; }
  S.uploads = list.map(f => ({ name: f.name, pct: 0 })); renderUploads();
  const paths = [];
  for (let i = 0; i < list.length; i++) {
    try {
      const r = await upload(list[i], pct => { S.uploads[i].pct = pct; renderUploads(); });
      S.uploads[i].path = r.path; paths.push(r.path); renderUploads();
    } catch (e) { S.uploads[i].error = e.message; renderUploads(); }
  }
  if (!paths.length) return;
  await refresh();
  for (const f of S.sources?.files || []) if (paths.includes(f.path)) S.seen.add(key(f));
  const zips = paths.filter(p => /\.zip$/i.test(p)), json = paths.find(p => /\.json$/i.test(p));
  if (json && !zips.length) {
    S.links = (S.sources?.files || []).find(f => f.path === json) || null;
    if (!S.links) say('That .json has no download links. Drop the export .zip instead.', true);
    render(); return;
  }
  startScan(zips.length === 1 ? { path: zips[0] } : { paths: zips });
}

/* ---------------- sheet (kit WzSheet; Back closes it) ---------------- */
let sheetBack = null;
function openSheet(build) {
  const d = $('sheet');
  d.replaceChildren(h('div', { class: 'wz-sheet-grip' }), h('button', { class: 'wz-sheet-x', type: 'button', 'aria-label': 'Close', onclick: closeSheet, text: '×' }), ...build().filter(Boolean));
  window.WzSheet.open(d);
  if (WA && !sheetBack) sheetBack = WA.back.push(() => { closeSheet(); return true; });
}
function closeSheet() { const d = $('sheet'); if (d.open) window.WzSheet.close(d); }
$('sheet').addEventListener('close', () => { if (sheetBack) { sheetBack.release(); sheetBack = null; } if (S.view === 'preview') render(); });
function confirmUndo(entry) {
  openSheet(() => [
    h('h2', { id: 'sheet-h', text: `Undo the ${entry.label || 'last'} import?` }),
    h('p', { class: 'imp-muted', text: 'Removes the chats, skills, memories and personality this import added. Anything you changed since stays as you left it.' }),
    h('div', { class: 'wz-actions' },
      h('button', { class: 'wz-button destructive', type: 'button', onclick: () => undo(entry), text: 'Undo import' }),
      h('button', { class: 'wz-button secondary', type: 'button', onclick: closeSheet, text: 'Keep it' })),
  ]);
}

/* ---------------- render ---------------- */
function render() {
  const v = S.view;
  const body = v === 'home' ? homeView() : v === 'guide' ? guideView() : v === 'into' ? intoView()
    : v === 'scanning' ? busyView('Reading your export…', 'Nothing is saved yet.')
    : v === 'preview' ? previewView() : v === 'importing' ? busyView('Bringing it in…', 'This takes a moment.')
    : v === 'done' ? doneView() : errorView();
  screen.dataset.view = v;
  const step = { home: 1, guide: 2, into: 2, scanning: 2, preview: 3, importing: 3, done: 4 }[v] || 0;
  const canBack = ['guide', 'into', 'preview', 'error'].includes(v);
  const top = h('div', { class: 'imp-top' },
    canBack ? h('button', { class: 'imp-back', type: 'button', 'data-back': '1', 'aria-label': 'Back', onclick: () => back() }, svg('M15 5l-7 7 7 7')) : h('span', { class: 'imp-back-sp' }),
    step ? h('div', { class: 'imp-dots', 'aria-label': `Step ${step} of 4` }, [1, 2, 3, 4].map(i => h('i', { class: i === step ? 'on' : i < step ? 'past' : '' }))) : h('span'),
    h('span', { class: 'imp-back-sp' }));
  screen.replaceChildren(h('div', { class: 'imp-stage' }, top, ...[].concat(body).filter(Boolean)));
  if (v === 'guide') renderUploads();
}
function banner() {
  const st = S.status;
  if (!st) return null;
  if (!st.connected) return h('div', { class: 'wz-card imp-banner' }, h('span', { class: 'wz-pill warn', text: st.reason === 'no_engine' ? 'Update needed' : 'Not connected' }), h('p', { text: st.message || 'Can’t reach your agent.' }));
  if (st.read_only) return h('div', { class: 'wz-card imp-banner' }, h('span', { class: 'wz-pill', text: 'Preview' }), h('p', { text: 'Preview mode: you can see what would come in, but nothing is saved.' }));
  return null;
}
/* An import that already came from this source (newest), so its row reads "Brought in" and sits last. */
function broughtIn(path, self) {
  const hits = S.imports.filter(i => (i.archived_at || i.imported_at) && typeof i.source === 'string'
    && (i.source === path || i.source.endsWith('/' + path)) && (!self || i.dest));
  return hits.sort((a, b) => (b.imported_at || b.archived_at) - (a.imported_at || a.archived_at))[0] || null;
}
function whenText(ts) {
  const d = new Date(1000 * ts), days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : 'on ' + d.toLocaleDateString();
}
const doneSub = (hit, rest) => `Brought in ${whenText(hit.imported_at || hit.archived_at)}${hit.into ? ' to ' + hit.into : ''} · tap to bring in again`;
function readyRows(filterKind) {
  const byDone = list => list.map(x => ({ x, hit: broughtIn(x.path, x.self) })).sort((a, b) => (a.hit ? 1 : 0) - (b.hit ? 1 : 0));
  const local = byDone((S.sources?.local || []).filter(s => !filterKind || s.kind === filterKind));
  const files = byDone((S.sources?.files || []).filter(f => f.kind && (!filterKind || f.kind === filterKind || (filterKind === 'claude' && f.kind === 'claude-links'))));
  const row = (g, title, sub, on, attrs) => h('button', { class: 'imp-src', type: 'button', onclick: on, ...attrs }, mark(g),
    h('span', { class: 'imp-src-t' }, h('b', { text: title }), sub ? h('small', { text: sub }) : null), h('span', { class: 'imp-chev', 'aria-hidden': 'true' }, svg('M9 5l7 7-7 7')));
  return [
    ...local.filter(({ x: s }) => !s.self || intoList().length).map(({ x: s, hit }) => s.self
      ? row(G.hermes, localTitle(s), hit ? doneSub(hit) : `${s.label} · its memories, facts, skills and chats go into an agent inside Wizard OS`, () => startSelf(s), { 'data-local': 'self', 'data-done': hit ? '1' : undefined })
      : row(G[s.kind] || G.other, localTitle(s), hit ? doneSub(hit) : s.kind === 'hermes' ? 'Another agent on this box · no export needed' : 'On this Wizard · no export needed',
        () => { S.dest = ''; S.selfPath = null; startScan({ path: s.path }, s.kind); }, { 'data-local': s.kind, 'data-done': hit ? '1' : undefined })),
    ...files.map(({ x: f, hit }) => row(G[f.kind === 'claude-links' ? 'claude' : f.kind] || G.other, f.name, hit ? doneSub(hit) : `In your Files · ${bytes(f.size || 0)}`, () => { S.selfPath = null; S.dest = ''; startScan({ path: f.path }, f.kind); }, { 'data-file': f.path, 'data-done': hit ? '1' : undefined })),
  ];
}
function homeView() {
  const out = [h('h1', { class: 'imp-h1', text: 'Bring your AI' }),
    h('p', { class: 'imp-sub', text: 'Where have you been using AI?' }), banner()];
  if (S.waiting && G[S.waiting.source]) out.push(h('div', { class: 'imp-pending-row' },
    h('button', { class: 'imp-pending', type: 'button', onclick: () => openGuide(S.waiting.source) },
      h('span', { class: 'imp-spin', 'aria-hidden': 'true' }), h('span', { text: `Waiting for your ${G[S.waiting.source].name} file` }), h('b', { text: 'Open' })),
    h('button', { class: 'imp-pending-x', type: 'button', 'data-cancel-wait': '1', 'aria-label': 'Stop waiting', onclick: () => { S.waiting = null; saveWaiting(); say('Stopped waiting.', true); render(); } },
      svg('M6 6l12 12M18 6L6 18'), h('span', { text: 'Cancel' }))));
  const rows = readyRows();
  const tiles = ['chatgpt', 'claude', 'claude-code', 'hermes'].filter(id => !(S.sources?.local || []).some(s => s.kind === id && !s.self))
    .map(id => h('button', { class: 'imp-src', type: 'button', 'data-source': id, onclick: () => openGuide(id) }, mark(G[id]),
      h('span', { class: 'imp-src-t' }, h('b', { text: G[id].name })), h('span', { class: 'imp-chev', 'aria-hidden': 'true' }, svg('M9 5l7 7-7 7'))));
  out.push(h('div', { class: 'imp-list' }, ...rows, ...tiles));
  out.push(h('button', { class: 'imp-link', type: 'button', 'data-source': 'other', onclick: () => openGuide('other'), text: 'Something else' }));
  out.push(h('p', { class: 'imp-fine', text: 'Nothing is saved until you approve it.' }));
  const past = S.imports.filter(i => i.archived_at || i.imported_at);
  if (past.length) out.push(h('button', { class: 'imp-link imp-past', type: 'button', onclick: pastSheet, text: `Already brought in (${past.length})` }));
  return out;
}
function pastSheet() {
  const past = S.imports.filter(i => i.archived_at || i.imported_at);
  openSheet(() => [h('h2', { id: 'sheet-h', text: 'Brought in' }), h('ul', { class: 'wz-list' }, past.map(i => h('li', {}, h('div', { class: 'wz-row' },
    mark(G[i.kind] || G.other), h('span', { class: 'wz-main' }, h('b', { text: (i.label || KIND_NAME[i.kind] || 'Import') + (i.into ? ` → ${i.into}` : '') }),
      h('small', { text: [i.archived_chats ? plural(i.archived_chats, 'chat') : '', i.skills_installed ? plural(i.skills_installed, 'skill') : '',
        i.memories_added ? plural(i.memories_added, 'memory', 'memories') : '', new Date(1000 * (i.imported_at || i.archived_at)).toLocaleDateString()].filter(Boolean).join(' · ') })),
    h('button', { class: 'wz-button secondary imp-small', type: 'button', onclick: () => { closeSheet(); confirmUndo(i); }, text: 'Undo' })))))]);
}
function dropZone() {
  // The whole screen accepts a dropped file; this is the tap way in.
  return [h('button', { class: 'imp-link', type: 'button', 'data-choose': '1', onclick: () => $('file').click(), text: 'I already have the file' }), h('ul', { class: 'wz-list', id: 'uploads' })];
}
function renderUploads() {
  const ul = $('uploads'); if (!ul) return;
  ul.replaceChildren(...S.uploads.map(u => h('li', { class: 'wz-row' }, h('span', { class: 'wz-main' }, h('b', { text: u.name }),
    h('small', { text: u.error || (u.path ? 'In Files › Inbox' : `Uploading… ${u.pct}%`) })),
    h('span', { class: 'wz-meter imp-meter' }, h('i', { style: `width:${u.error ? 0 : u.path ? 100 : u.pct}%` })))));
}
function backRow() { return null; }
function guideView() {
  const g = G[S.source] || G.other;
  const out = [h('div', { class: 'imp-hero' }, mark(g)), h('h1', { class: 'imp-h1', text: S.source === 'other' ? 'Bring a file' : `From ${g.name}` }), banner()];
  const rows = readyRows(S.source === 'other' ? '' : S.source);
  if (S.links) {
    out.push(h('p', { class: 'imp-sub', text: 'Claude split your export. Open each link once, then add the files.' }),
      h('div', { class: 'imp-stack' }, S.links.links.map(l => ext(l.url, 'Download ' + l.part, 'wz-button secondary imp-wide'))), ...dropZone());
    return out;
  }
  if (rows.length) out.push(h('p', { class: 'imp-sub', text: 'Found on this Wizard. Tap to bring it in.' }), h('div', { class: 'imp-list' }, rows));
  out.push(h('ol', { class: 'imp-num' }, g.steps.map(s => h('li', { text: s }))));
  if (g.command) out.push(h('div', { class: 'imp-command' }, h('code', { text: g.command }), h('button', { class: 'wz-button secondary imp-small', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(g.command); say('Copied.', true); } catch (e) { say('Select the line and copy it.', true); } }, text: 'Copy' })));
  if (g.link) out.push(ext(g.link.url, g.link.label, 'wz-button imp-primary imp-open'));
  const mail = mailCard();
  if (g.mail) out.push(mail || h('div', { class: 'imp-waitline' }, h('span', { class: 'imp-spin', 'aria-hidden': 'true' }), h('span', { text: g.next || 'Waiting for your file. We’ll continue when it arrives.' })));
  else if (S.source === 'other') out.push(filesPath());
  out.push(...dropZone());
  const more = [g.after, g.phone, ...g.expect, ...g.notes].filter(Boolean);
  if (more.length || g.help) out.push(h('details', { class: 'imp-help' }, h('summary', { text: 'Need help?' }), h('ul', { class: 'imp-expect' }, more.map(x => h('li', { text: x }))),
    g.portal ? ext(g.portal.url, g.portal.label) : null, g.help ? h('p', { class: 'imp-muted' }, ext(g.help, g.helpName || `${g.name} help page`)) : null));
  return out;
}
function mailCard() {
  const g = G[S.source];
  if (!g || !g.mail || S.mail.state !== 'ready') return null;
  const found = S.mail.hits.filter(x => x.links.length);
  if (found.length) return h('div', { class: 'imp-arrived' }, h('span', { class: 'wz-pill ok', text: 'Your email arrived' }),
    ...found[0].links.map((u, i) => ext(u, found[0].links.length > 1 ? `Download part ${i + 1}` : 'Download it', 'wz-button imp-primary')));
  return h('div', { class: 'imp-waitline' }, h('span', { class: 'imp-spin', 'aria-hidden': 'true' }), h('span', { text: `Watching your Mail for ${g.name}’s email…` }));
}
function filesPath() {
  const input = h('input', { class: 'wz-input', placeholder: 'In Files, e.g. Inbox/my-export.zip', 'aria-label': 'File or folder in Files' });
  return h('form', { class: 'imp-path', onsubmit: e => { e.preventDefault(); if (input.value.trim()) startScan({ path: input.value.trim() }); } },
    input, h('button', { class: 'wz-button secondary', type: 'submit', text: 'Look inside' }));
}
function intoView() {
  // Move this agent into Wizard OS: one screen, one choice.
  const pick = d => { S.dest = d.id; startScan({ path: S.selfPath }, 'hermes'); };
  return [h('div', { class: 'imp-hero' }, mark(G.hermes)), h('h1', { class: 'imp-h1', text: 'Move into which agent?' }),
    h('p', { class: 'imp-sub', text: `${S.sources?.here || 'This agent'}: its memories, facts, skills, personality and chats are copied. Sign-ins and keys stay here.` }),
    h('div', { class: 'imp-list' }, intoList().map(d => h('button', { class: 'imp-src', type: 'button', 'data-dest': d.id, onclick: () => pick(d) }, mark(G.hermes),
      h('span', { class: 'imp-src-t' }, h('b', { text: d.label }), h('small', { text: d.where || '' })), h('span', { class: 'imp-chev', 'aria-hidden': 'true' }, svg('M9 5l7 7-7 7')))))];
}
function busyView(title, line) {
  return h('div', { class: 'imp-center-col' }, h('span', { class: 'imp-spin big', 'aria-hidden': 'true' }), h('h1', { class: 'imp-h1', text: title }), h('p', { class: 'imp-sub', text: line }));
}
function errorView() {
  return h('div', { class: 'imp-center-col' }, h('div', { class: 'imp-badge warn', 'aria-hidden': 'true', text: '!' }), h('h1', { class: 'imp-h1', text: 'That didn’t work' }), h('p', { class: 'imp-sub', text: S.error }),
    h('button', { class: 'wz-button imp-primary', type: 'button', onclick: () => back(), text: 'Try again' }));
}
function option(name, title, line, extra) {
  const c = S.choice;
  return h('li', { class: 'imp-option' }, h('button', { class: 'wz-row', type: 'button', 'aria-pressed': String(!!c[name]), 'data-choice': name, onclick: () => { c[name] = !c[name]; render(); } },
    check(), h('span', { class: 'wz-main' }, h('b', { text: title }), h('small', { text: line }))), extra || null);
}
function previewView() {
  const sc = S.scan, c = S.choice, n = sc.counts;
  const found = [n.chats && plural(n.chats, 'chat'), n.memories && plural(n.memories, 'memory', 'memories'), n.projects && plural(n.projects, 'project'),
    n.skills && plural(n.skills, 'skill'), n.custom_instructions && (sc.kind === 'chatgpt' ? 'custom instructions' : plural(n.custom_instructions, 'instruction file')),
    n.facts && plural(n.facts, 'fact'), sc.personality && sc.personality.found && 'personality'].filter(Boolean);
  const out = [h('h1', { class: 'imp-h1', text: 'Here’s what we found' }),
    h('p', { class: 'imp-sub', 'data-found': '', text: found.join(' · ') || 'Nothing to bring in.' }), banner()];
  if (intoList().length) out.push(h('button', { class: 'imp-src imp-into', type: 'button', 'data-into': S.dest || 'here', onclick: pickDest }, mark(G.hermes),
    h('span', { class: 'imp-src-t' }, h('small', { text: 'Bring into' }), h('b', { text: sc.into || destLabel(S.dest) })), h('span', { class: 'imp-chev', 'aria-hidden': 'true' }, svg('M9 5l7 7-7 7'))));
  const blocked = sc.blocked || {};
  const block = Object.values(blocked)[0];
  if (block) out.push(h('div', { class: 'wz-card imp-banner imp-blocked' }, h('span', { class: 'wz-pill warn', text: 'Files is locked' }), h('p', { text: block })));
  const opts = [];
  if (n.chats || n.projects) opts.push(option('chats', `Chats${n.projects ? ' and projects' : ''}`,
    'Saved as files your Wizard can search.'));
  if (sc.new_skill_count) opts.push(option('skills', 'Skills', `${c.allSkills ? 'All' : fmt(c.skillNames.size) + ' of'} ${plural(sc.new_skill_count, 'new skill')}${c.allSkills ? '' : ' chosen'}.${sc.skills_already_here ? ` ${fmt(sc.skills_already_here)} it already has are skipped.` : ''}`,
    h('button', { class: 'wz-button secondary imp-small imp-pick', type: 'button', onclick: pickSkills, text: 'Choose' })));
  if (c.facts.length) opts.push(option('about', 'What I know about you', `${fmt(c.facts.filter(f => f.on).length)} of ${plural(c.facts.length, 'fact')} chosen. Review them below.`));
  if (n.facts) opts.push(option('store', 'Fact store', `${plural(n.facts, 'fact')} from its long-term memory`
    + (sc.fact_store && sc.fact_store.here ? `, added to the ${fmt(sc.fact_store.here)} already here.` : '.')));
  if (sc.personality && sc.personality.found) opts.push(option('personality', 'Personality', sc.personality.here === 'custom'
    ? 'Replaces the current one. Undo brings it back.' : `Your ${sc.source} agent’s way of talking.`));
  out.push(opts.length ? h('ul', { class: 'wz-list imp-options' }, opts) : h('p', { class: 'imp-muted', text: 'This export has nothing the Importer can bring in yet.' }));
  if (c.about) {
    const cards = c.facts.map((f, i) => {
      const box = h('textarea', { class: 'imp-fact-t', rows: '1', 'aria-label': `Fact ${i + 1}`, spellcheck: 'true' });
      box.value = f.text;
      box.addEventListener('input', () => { f.text = box.value; fit(box); });
      requestAnimationFrame(() => fit(box));
      return h('li', { class: 'imp-fact' + (f.on ? '' : ' off') },
        h('button', { class: 'imp-fact-c', type: 'button', 'aria-pressed': String(f.on), 'aria-label': f.on ? 'Keep (tap to leave out)' : 'Left out (tap to keep)', onclick: () => { f.on = !f.on; render(); } }, check()),
        box,
        h('button', { class: 'imp-fact-x', type: 'button', 'aria-label': 'Delete this fact', onclick: () => { c.facts.splice(i, 1); render(); } }, svg('M6 6l12 12M18 6L6 18')));
    });
    out.push(h('div', { class: 'imp-card' }, h('h2', { text: 'What I know about you' }),
      h('p', { class: 'imp-muted', text: 'Untick or edit anything. Only ticked facts are saved.' }),
      h('ul', { class: 'imp-facts-list' }, cards),
      h('button', { class: 'imp-link', type: 'button', onclick: () => { c.facts.push({ text: '', on: true }); render(); requestAnimationFrame(() => { const t = screen.querySelectorAll('.imp-fact-t'); t[t.length - 1]?.focus(); }); }, text: '+ Add a fact' })));
  }
  const ro = S.status && S.status.read_only;
  out.push(h('button', { class: 'wz-button imp-primary', type: 'button', id: 'import', disabled: ro || !opts.length || undefined, onclick: runImport, text: ro ? 'Preview only: nothing is saved' : 'Bring it in' }));
  return out;
}
function pickSkills() {
  const sc = S.scan, c = S.choice;
  openSheet(() => [h('h2', { id: 'sheet-h', text: 'Skills to bring in' }),
    h('ul', { class: 'wz-list' }, sc.new_skills.map(s => h('li', {}, h('button', { class: 'wz-row', type: 'button', 'aria-pressed': String(c.skillNames.has(s.name)), onclick: e => {
      c.allSkills = false;
      if (c.skillNames.has(s.name)) c.skillNames.delete(s.name); else c.skillNames.add(s.name);
      e.currentTarget.setAttribute('aria-pressed', String(c.skillNames.has(s.name))); c.skills = c.skillNames.size > 0;
    } }, check(), h('span', { class: 'wz-main' }, h('b', { text: s.name }),
      h('small', { text: (s.description || 'No description') + (s.left_behind && s.left_behind.length ? ` (leaves behind ${plural(s.left_behind.length, 'file')} that look like keys)` : '') })))))),
    sc.more_new_skills ? h('p', { class: 'imp-muted', text: `${fmt(sc.more_new_skills)} more are not listed: they come in only while you leave every skill chosen.` }) : null,
    h('div', { class: 'wz-actions' }, h('button', { class: 'wz-button', type: 'button', onclick: closeSheet, text: 'Done' }))]);
}
function doneView() {
  const r = S.result, d = r.done || {}, sc = S.scan || {};
  const lines = [];
  if (d.facts) lines.push(`${plural(d.facts.facts_added, 'fact')} in its fact store`);
  if (d.chats) lines.push(`${plural(d.chats.chats_written, 'chat')} it can look up, in Files › ${String(d.chats.folder).replace('/', ' › ')}`);
  if (d.about) lines.push(`${plural(d.about.memory_added + d.about.already_known, 'thing')} about you`
    + (d.about.not_added && d.about.not_added.length ? ` (${fmt(d.about.not_added.length)} more are in About me: memory is full)` : '')
    + (d.about.waiting_for_approval ? `, ${fmt(d.about.waiting_for_approval)} waiting for your approval` : ''));
  if (d.skills) lines.push(`${plural(d.skills.installed.length, 'new skill')}${d.skills.installed.length ? ': ' + d.skills.installed.slice(0, 6).map(s => s.name).join(', ') + (d.skills.installed.length > 6 ? '…' : '') : ''}`);
  if (d.personality) lines.push('its personality, from your next chat');
  const errors = Object.entries(r.errors || {});
  const who = S.dest ? (sc.into || destLabel(S.dest)) : 'Your Wizard';
  const head = errors.length
    ? [h('div', { class: 'imp-badge warn', 'aria-hidden': 'true', text: '!' }), h('h1', { class: 'imp-h1', text: 'Some of it didn’t come in' }),
      h('p', { class: 'imp-sub', text: lines.length ? 'The rest is in. Fix the part below, then try again: what already came in is skipped.' : 'Fix the part below, then try again.' })]
    : [h('div', { class: 'imp-badge ok', 'aria-hidden': 'true' }, svg('M5 12.5l4.5 4.5L19 7.5')), h('h1', { class: 'imp-h1', text: 'All set' }),
      h('p', { class: 'imp-sub', text: `${who} now knows your ${sc.source || 'history'}.` })];
  return [h('div', { class: 'imp-center-col' }, ...head),
    lines.length ? h('ul', { class: 'imp-expect imp-knows' }, lines.map(x => h('li', { text: x }))) : null,
    errors.length ? h('div', { class: 'wz-card imp-failed' }, h('ul', { class: 'imp-expect' }, errors.map(([k, v]) => h('li', {}, h('b', { text: `${PART_NAME[k] || k}: ` }), plainError(v))))) : null,
    errors.length ? h('button', { class: 'wz-button imp-primary', type: 'button', 'data-retry': '1', onclick: retryFailed, text: 'Try again' })
      : h('button', { class: 'wz-button imp-primary', type: 'button', onclick: finish, text: 'Done' }),
    errors.length ? h('button', { class: 'imp-link', type: 'button', onclick: finish, text: 'Done for now' }) : null,
    h('button', { class: 'imp-link', type: 'button', onclick: () => confirmUndo({ import_id: r.import_id, label: sc.source, dest: S.dest || undefined }), text: 'Undo' })];
}

/* ---------------- boot ---------------- */
// Inside the Welcome card (Setup's Bring your AI step) the card already carries the title.
if (new URLSearchParams(location.search).get('embedded') === '1') document.documentElement.dataset.embedded = '1';
for (const ev of ['dragover', 'drop']) document.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files.length) { if (S.view !== 'guide') { S.source = S.source || 'other'; go('guide'); } addFiles(e.dataTransfer.files); } });
$('file').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
if (WA) {
  WA.ready({ name: 'importer', version: '0.1.6' });
  WA.back.register({ canGoBack: () => S.view !== 'home', back });
} else say('Wizard system functions are unavailable. Open the Importer through Wizard.', true);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.view === 'guide') poll(); });
S.waiting = loadWaiting();
if (S.waiting && Date.now() - S.waiting.since > 8 * 24 * 3600 * 1000) { S.waiting = null; saveWaiting(); }
render();
refresh().then(() => {
  // Came back while waiting for an export: straight to that guide, still watching.
  if (S.waiting && G[S.waiting.source] && S.view === 'home') { S.source = S.waiting.source; go('guide'); poll(); mailProbe().then(() => mailLook(true)); }
});
window.__importer = { S, render, go, startScan, refresh, plainError, localTitle };
