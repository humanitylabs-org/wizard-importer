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
  view: 'home',            // home | guide | scanning | preview | importing | done | error
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
  if (S.view === 'preview') { go(S.from === 'guide' ? 'guide' : 'home'); if (S.view === 'guide') poll(); else refresh(); return true; }
  if (S.view === 'guide' || S.view === 'error' || S.view === 'done') { S.scan = null; S.links = null; go('home'); refresh(); return true; }
  return false;
}
function finish() {
  // Done leaves the screen (Wizard rule): back to where the owner came from (Setup, Home).
  S.scan = S.result = null; S.view = 'home';
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
    S.sources = sources; S.imports = imports.imports || [];
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
async function startScan(args, source) {
  clearTimeout(pollT); clearTimeout(mailT);
  if (source) S.source = source;
  if (S.view !== 'scanning') S.from = S.view;
  S.error = ''; go('scanning');
  try {
    const scan = await api('api/scan', args);
    S.scan = scan; S.waiting = null; saveWaiting();
    const here = scan.personality && scan.personality.here;
    S.choice = {
      chats: scan.counts.chats > 0 || scan.counts.projects > 0,
      about: (scan.draft_facts || []).length > 0,
      skills: scan.new_skill_count > 0,
      skillNames: new Set((scan.new_skills || []).map(s => s.name)), allSkills: true,
      personality: !!(scan.personality && scan.personality.found) && here !== 'custom',
      facts: (scan.draft_facts || []).join('\n'),
    };
    go('preview');
  } catch (e) { S.error = e.message; go('error'); }
}
async function runImport() {
  const c = S.choice, sc = S.scan;
  const facts = c.about ? c.facts.split('\n').map(x => x.trim()).filter(Boolean) : [];
  const body = {
    import_id: sc.import_id, chats: c.chats, personality: c.personality, skills: !c.skills ? [] : c.allSkills ? 'all' : [...c.skillNames],
    about: facts.length ? { facts, text: '# About me\n\n' + facts.map(f => '- ' + f).join('\n') + `\n\n*From ${sc.source}, approved by you in the Importer.*` } : undefined,
  };
  if (!body.chats && !body.personality && !body.skills.length && !body.about && body.skills !== 'all') { say('Choose at least one thing to bring in.', true); return; }
  go('importing');
  try { S.result = await api('api/import', body); go('done'); }
  catch (e) { S.error = e.message; go('error'); }
}
async function undo(entry) {
  closeSheet();
  say('Undoing…', true);
  try {
    const r = await api('api/undo', { import_id: entry.import_id });
    const parts = [r.removed_files && plural(r.removed_files, 'file'), r.removed_skills && r.removed_skills.length && plural(r.removed_skills.length, 'skill'),
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
  d.replaceChildren(h('div', { class: 'wz-sheet-grip' }), h('button', { class: 'wz-sheet-x', type: 'button', 'aria-label': 'Close', onclick: closeSheet, text: '×' }), ...build());
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
  const body = v === 'home' ? homeView() : v === 'guide' ? guideView()
    : v === 'scanning' ? busyView('Reading your export…', 'Nothing is saved yet. A long history can take a minute.')
    : v === 'preview' ? previewView() : v === 'importing' ? busyView('Bringing it in…', 'Saving your chats and what you approved.')
    : v === 'done' ? doneView() : errorView();
  screen.dataset.view = v;
  const lead = (v === 'preview' || v === 'error') ? [backRow()] : [];
  screen.replaceChildren(...lead.concat(body).filter(Boolean));
  if (v === 'guide') renderUploads();
}
function banner() {
  const st = S.status;
  if (!st) return null;
  if (!st.connected) return h('div', { class: 'wz-card imp-banner' }, h('span', { class: 'wz-pill warn', text: st.reason === 'no_engine' ? 'Update needed' : 'Not connected' }), h('p', { text: st.message || 'Can’t reach your agent.' }));
  if (st.read_only) return h('div', { class: 'wz-card imp-banner' }, h('span', { class: 'wz-pill', text: 'Preview' }), h('p', { text: 'Preview mode: you can see what would come in, but nothing is saved.' }));
  return null;
}
function readyRows(filterKind) {
  const local = (S.sources?.local || []).filter(s => !filterKind || s.kind === filterKind);
  const files = (S.sources?.files || []).filter(f => f.kind && (!filterKind || f.kind === filterKind || (filterKind === 'claude' && f.kind === 'claude-links')));
  const rows = local.map(s => h('li', {}, h('button', { class: 'wz-row', type: 'button', 'data-local': s.kind, onclick: () => startScan({ path: s.path }, s.kind) },
    mark(G[s.kind]), h('span', { class: 'wz-main' }, h('b', { text: s.label }), h('small', { text: 'On this Wizard. One tap, no export needed.' })), h('span', { class: 'wz-chip', text: 'Look inside' }))));
  for (const f of files) {
    const g = G[f.kind === 'claude-links' ? 'claude' : f.kind] || G.other;
    rows.push(h('li', {}, h('button', { class: 'wz-row', type: 'button', onclick: () => {
      if (f.kind === 'claude-links') { S.source = 'claude'; S.links = f; go('guide'); poll(); } else startScan({ path: f.path }, f.kind);
    } }, mark(g), h('span', { class: 'wz-main' }, h('b', { text: f.name }), h('small', { text: `${KIND_NAME[f.kind] || 'Export'} · Files › ${f.path.split('/')[0]} · ${bytes(f.size)}` })),
    h('span', { class: 'wz-chip', text: f.kind === 'claude-links' ? 'Get the files' : 'Use this' }))));
  }
  return rows;
}
function homeView() {
  const out = [h('p', { class: 'imp-lead', text: 'Move your memories, chats, skills and personality into this Wizard. Nothing is saved until you approve it.' }), banner()];
  const rows = readyRows();
  if (rows.length) out.push(h('section', { class: 'wz-sec' }, h('h2', { class: 'wz-sec-h', text: 'Ready to bring in' }), h('ul', { class: 'wz-list' }, rows)));
  if (S.waiting && G[S.waiting.source]) {
    out.push(h('div', { class: 'wz-card imp-waiting' }, h('b', { text: `Waiting for your ${G[S.waiting.source].name} export` }),
      h('p', { class: 'imp-muted', text: 'It carries on by itself when the file lands in Files › Inbox.' }),
      h('div', { class: 'wz-actions' }, h('button', { class: 'wz-button secondary', type: 'button', onclick: () => openGuide(S.waiting.source), text: 'Open the steps' }),
        h('button', { class: 'wz-button secondary', type: 'button', onclick: () => { S.waiting = null; saveWaiting(); render(); }, text: 'Stop waiting' }))));
  }
  out.push(h('section', { class: 'wz-sec' }, h('h2', { class: 'wz-sec-h', text: 'Where is your AI now?' }),
    h('div', { class: 'wz-grid imp-tiles' }, ['chatgpt', 'claude', 'claude-code', 'hermes', 'other'].map(id => {
      const g = G[id];
      return h('button', { class: 'wz-card imp-tile', type: 'button', 'data-source': id, onclick: () => openGuide(id) }, mark(g), h('span', { class: 'imp-tile-t' }, h('b', { text: g.name }), h('small', { text: g.tile })));
    }))));
  const past = S.imports.filter(i => i.archived_at || i.imported_at);
  if (past.length) {
    out.push(h('section', { class: 'wz-sec' }, h('h2', { class: 'wz-sec-h', text: 'Brought in' }), h('ul', { class: 'wz-list' }, past.map(i => h('li', {}, h('div', { class: 'wz-row' },
      mark(G[i.kind] || G.other), h('span', { class: 'wz-main' }, h('b', { text: i.label || KIND_NAME[i.kind] || 'Import' }),
        h('small', { text: [i.archived_chats ? plural(i.archived_chats, 'chat') : '', i.skills_installed ? plural(i.skills_installed, 'skill') : '',
          i.memories_added ? plural(i.memories_added, 'memory', 'memories') : '', i.personality ? 'personality' : '',
          new Date(1000 * (i.imported_at || i.archived_at)).toLocaleDateString()].filter(Boolean).join(' · ') })),
      h('button', { class: 'wz-button secondary imp-small', type: 'button', onclick: () => confirmUndo(i), text: 'Undo' })))))));
  }
  return out;
}
function dropZone() {
  const g = G[S.source] || G.other;
  const zone = h('div', { class: 'imp-drop', tabindex: '0', role: 'button', 'aria-label': `Drop ${g.file} here or choose it` },
    h('b', { text: `Drop ${g.file} here` }), h('small', { text: 'or' }),
    h('button', { class: 'wz-button', type: 'button', onclick: e => { e.stopPropagation(); $('file').click(); }, text: 'Choose the file' }));
  zone.addEventListener('keydown', e => { if (e.target === zone && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('file').click(); } });
  for (const ev of ['dragenter', 'dragover']) zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) zone.addEventListener(ev, () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  return [zone, h('ul', { class: 'wz-list', id: 'uploads' })];
}
function renderUploads() {
  const ul = $('uploads'); if (!ul) return;
  ul.replaceChildren(...S.uploads.map(u => h('li', { class: 'wz-row' }, h('span', { class: 'wz-main' }, h('b', { text: u.name }),
    h('small', { text: u.error || (u.path ? 'In Files › Inbox' : `Uploading… ${u.pct}%`) })),
    h('span', { class: 'wz-meter imp-meter' }, h('i', { style: `width:${u.error ? 0 : u.path ? 100 : u.pct}%` })))));
}
function backRow() {
  return h('div', { class: 'imp-backrow' }, h('button', { class: 'wz-button secondary imp-back', type: 'button', 'data-back': '1', 'aria-label': 'Back to all sources', onclick: () => back(), text: '‹ All sources' }));
}
function guideView() {
  const g = G[S.source] || G.other;
  const out = [backRow(), h('div', { class: 'imp-guide-head' }, mark(g), h('h2', { text: g.name })), h('p', { class: 'imp-lead', text: g.intro }), banner()];
  const rows = readyRows(S.source === 'other' ? '' : S.source);
  if (rows.length) out.push(h('ul', { class: 'wz-list imp-ready' }, rows));
  if (S.links) {
    out.push(h('div', { class: 'wz-card' }, h('b', { text: 'Claude sent a list of download links' }),
      h('p', { class: 'imp-muted', text: 'Open each link once, then drop all the zips here together.' }),
      h('div', { class: 'wz-actions' }, S.links.links.map(l => ext(l.url, 'Download ' + l.part, 'wz-button secondary'))), ...dropZone()));
    return out;
  }
  const more = [g.phone, ...g.expect, ...g.notes].filter(Boolean);
  out.push(h('section', { class: 'wz-sec' }, h('h2', { class: 'wz-sec-h', text: rows.length && g.command ? 'Or from another computer' : 'Get your export' }),
    h('ol', { class: 'imp-steps' }, g.steps.map(s => h('li', { text: s }))),
    g.link ? h('div', { class: 'wz-actions' }, ext(g.link.url, g.link.label, 'wz-button imp-open')) : null,
    g.command ? h('div', { class: 'imp-command' }, h('code', { text: g.command }), h('button', { class: 'wz-button secondary imp-small', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(g.command); say('Copied.', true); } catch (e) { say('Select the line and copy it.', true); } }, text: 'Copy' })) : null,
    g.after ? h('p', { class: 'imp-muted', text: g.after }) : null,
    g.next ? h('p', { class: 'imp-next', text: g.next }) : null,
    more.length || g.help ? h('details', { class: 'wz-more' }, h('summary', { text: 'More help' }), h('ul', { class: 'imp-expect' }, more.map(x => h('li', { text: x }))),
      g.portal ? ext(g.portal.url, g.portal.label) : null, g.help ? h('p', { class: 'imp-muted' }, ext(g.help, g.helpName || `${g.name} help page`)) : null) : null));
  const waits = !!g.mail;
  out.push(h('section', { class: 'wz-sec' }, h('h2', { class: 'wz-sec-h', text: 'Bring it in' }),
    waits ? h('div', { class: 'imp-wait' }, h('span', { class: 'imp-spin', 'aria-hidden': 'true' }),
      h('span', { text: 'Watching Files › Inbox. It carries on by itself when the file lands.' })) : null,
    mailCard(), ...dropZone(), S.source === 'other' ? filesPath() : null));
  return out;
}
function mailCard() {
  const g = G[S.source];
  if (!g || !g.mail || S.mail.state !== 'ready') return null;
  const found = S.mail.hits.filter(x => x.links.length);
  if (found.length) return h('div', { class: 'wz-card imp-mail' }, h('span', { class: 'wz-pill ok', text: 'Email arrived' }), h('b', { text: found[0].subject }),
    h('p', { class: 'imp-muted', text: `Open the link, sign in to ${g.name} if asked, and the download starts. Then drop the file below.` }),
    h('div', { class: 'wz-actions' }, found[0].links.map((u, i) => ext(u, found[0].links.length > 1 ? `Open download link ${i + 1}` : 'Open the download link', 'wz-button'))));
  return h('div', { class: 'wz-card imp-mail' }, h('b', { text: 'Watching your Mail for it' }),
    h('p', { class: 'imp-muted', text: S.mail.looked ? `No ${g.name} export email yet. Checking again every minute.` : `Your Mail is connected, so the Importer can spot ${g.name}’s email and show you its link.` }),
    h('button', { class: 'wz-button secondary', type: 'button', disabled: S.mail.busy || undefined, onclick: () => mailLook(false), text: S.mail.busy ? 'Looking…' : 'Look in Mail now' }));
}
function filesPath() {
  const input = h('input', { class: 'wz-input', placeholder: 'In Files, e.g. Inbox/my-export.zip', 'aria-label': 'File or folder in Files' });
  return h('form', { class: 'imp-path', onsubmit: e => { e.preventDefault(); if (input.value.trim()) startScan({ path: input.value.trim() }); } },
    input, h('button', { class: 'wz-button secondary', type: 'submit', text: 'Look inside' }));
}
function busyView(title, line) {
  return h('div', { class: 'wz-empty imp-busy' }, h('span', { class: 'imp-spin big', 'aria-hidden': 'true' }), h('strong', { text: title }), h('p', { text: line }));
}
function errorView() {
  return h('div', { class: 'wz-empty' }, h('div', { class: 'wz-tile', 'aria-hidden': 'true', text: '!' }), h('strong', { text: 'That didn’t work' }), h('p', { text: S.error }),
    h('div', { class: 'wz-actions imp-center' }, h('button', { class: 'wz-button', type: 'button', onclick: () => back(), text: 'Back' })));
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
    sc.personality && sc.personality.found && 'personality'].filter(Boolean);
  const out = [h('div', { class: 'imp-guide-head' }, mark(G[sc.kind] || G.other), h('h2', { text: `Found in your ${sc.source}` })),
    h('p', { class: 'imp-found', 'data-found': '', text: found.join(' · ') || 'Nothing to bring in.' }),
    sc.date_range && sc.date_range.length ? h('p', { class: 'imp-muted', text: `${sc.date_range[0]} to ${sc.date_range[1]}` }) : null, banner()];
  const opts = [];
  if (n.chats || n.projects) opts.push(option('chats', `Chats${n.projects ? ' and projects' : ''}`,
    `${[n.chats && plural(n.chats, 'chat'), n.projects && plural(n.projects, 'project')].filter(Boolean).join(' and ')} saved as files your Wizard can search (Files › Imported › ${sc.source}).`));
  if ((sc.draft_facts || []).length) opts.push(option('about', 'What I know about you', 'You check it below first. Each line becomes something your Wizard remembers.'));
  if (sc.new_skill_count) opts.push(option('skills', 'Skills', `${c.allSkills ? 'All' : fmt(c.skillNames.size) + ' of'} ${plural(sc.new_skill_count, 'new skill')}${c.allSkills ? '' : ' chosen'}.${sc.skills_already_here ? ` ${fmt(sc.skills_already_here)} it already has are skipped.` : ''}`,
    h('button', { class: 'wz-button secondary imp-small imp-pick', type: 'button', onclick: pickSkills, text: 'Choose' })));
  if (sc.personality && sc.personality.found) opts.push(option('personality', 'Personality', sc.personality.here === 'custom'
    ? 'Replaces this Wizard’s current personality (SOUL.md). The old one is kept, so Undo brings it back.' : `Your ${sc.source} agent’s personality (SOUL.md) becomes this Wizard’s.`));
  out.push(h('section', { class: 'wz-sec' }, h('h2', { class: 'wz-sec-h', text: 'Bring in' }),
    opts.length ? h('ul', { class: 'wz-list imp-options' }, opts) : h('p', { class: 'imp-muted', text: 'This export has nothing the Importer can bring in yet.' })));
  if (c.about) {
    const lines = () => c.facts.split('\n').filter(x => x.trim()).length;
    const area = h('textarea', { class: 'imp-facts', rows: String(Math.min(14, Math.max(4, lines() + 1))), 'aria-label': 'What I know about you, one fact per line', spellcheck: 'true' });
    area.value = c.facts;
    area.addEventListener('input', () => { c.facts = area.value; fit(area); $('fact-count').textContent = plural(lines(), 'fact'); });
    requestAnimationFrame(() => fit(area));
    out.push(h('section', { class: 'wz-sec' }, h('div', { class: 'wz-card imp-card' }, h('h2', { text: 'What I know about you' }),
      h('p', { class: 'imp-muted', text: 'From your export, one fact per line. Fix, add or delete lines: only what is here when you approve is saved, as memories and as About me in your Files.' }),
      area, h('small', { class: 'imp-muted', id: 'fact-count', text: plural(lines(), 'fact') }))));
  }
  const ro = S.status && S.status.read_only;
  out.push(h('div', { class: 'wz-actions imp-go' },
    h('button', { class: 'wz-button', type: 'button', id: 'import', disabled: ro || !opts.length || undefined, onclick: runImport, text: ro ? 'Preview only: nothing is saved' : c.about ? 'Approve and bring in' : 'Bring in' }),
    h('button', { class: 'wz-button secondary', type: 'button', onclick: () => back(), text: 'Not now' })));
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
      h('small', { text: s.description + (s.left_behind && s.left_behind.length ? ` (leaves behind ${plural(s.left_behind.length, 'file')} that look like keys)` : '') })))))),
    sc.more_new_skills ? h('p', { class: 'imp-muted', text: `${fmt(sc.more_new_skills)} more are not listed: they come in only while you leave every skill chosen.` }) : null,
    h('div', { class: 'wz-actions' }, h('button', { class: 'wz-button', type: 'button', onclick: closeSheet, text: 'Done' }))]);
}
function doneView() {
  const r = S.result, d = r.done || {}, sc = S.scan || {};
  const lines = [];
  if (d.chats) lines.push(`${plural(d.chats.chats_written, 'chat')} it can look up, in Files › ${String(d.chats.folder).replace('/', ' › ')}`);
  if (d.about) lines.push(`${plural(d.about.memory_added + d.about.already_known, 'thing')} about you`
    + (d.about.not_added && d.about.not_added.length ? ` (${fmt(d.about.not_added.length)} more are in About me: memory is full)` : '')
    + (d.about.waiting_for_approval ? `, ${fmt(d.about.waiting_for_approval)} waiting for your approval` : ''));
  if (d.skills) lines.push(`${plural(d.skills.installed.length, 'new skill')}${d.skills.installed.length ? ': ' + d.skills.installed.slice(0, 6).map(s => s.name).join(', ') + (d.skills.installed.length > 6 ? '…' : '') : ''}`);
  if (d.personality) lines.push('its personality, from your next chat');
  const errors = Object.entries(r.errors || {});
  return [h('div', { class: 'wz-empty imp-done' }, h('div', { class: 'wz-tile', 'aria-hidden': 'true' }, svg('M5 12.5l4.5 4.5L19 7.5')), h('strong', { text: `Done: your Wizard now knows your ${sc.source || 'data'}` })),
    h('ul', { class: 'imp-expect imp-knows' }, lines.map(x => h('li', { text: x }))),
    errors.length ? h('div', { class: 'wz-card' }, h('span', { class: 'wz-pill warn', text: 'Not everything came in' }), h('ul', { class: 'imp-expect' }, errors.map(([k, v]) => h('li', { text: `${k}: ${v}` })))) : null,
    h('div', { class: 'wz-actions imp-go imp-center' }, h('button', { class: 'wz-button', type: 'button', onclick: finish, text: 'Done' }),
      h('button', { class: 'wz-button secondary', type: 'button', onclick: () => confirmUndo({ import_id: r.import_id, label: sc.source }), text: 'Undo this import' }))];
}

/* ---------------- boot ---------------- */
// Inside the Welcome card (Setup's Bring your AI step) the card already carries the title.
if (new URLSearchParams(location.search).get('embedded') === '1') document.documentElement.dataset.embedded = '1';
$('file').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
if (WA) {
  WA.ready({ name: 'importer', version: '0.1.0' });
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
window.__importer = { S, render, go, startScan, refresh };
