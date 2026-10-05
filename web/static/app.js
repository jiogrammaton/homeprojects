/* Home Projects: the whole browser client (no framework, no build step).

   How it works: every page is the same server-rendered shell (web/templates/base.html). <body data-view="home|board|
   cal|stats|settings" data-tab="…"> says which page this is. load() fetches GET /api/tasks (T) and /api/settings
   (ST), then draw() builds the page into <main id="m"> with template strings. Writes go through api() (adds the
   CSRF header, handles 401/403). Always escape user text with esc().

   Contents (search for the "/* ---- <name>" markers; they run in this order):
     globals & helpers · api() · ask() dialogs · palettes · Repeat frequencies · rooms · Outside · room shapes ·
     load()/draw() · FLIP animation helpers · board · collapsing projects · card drag (mouse) · cards · moveTask ·
     projects: add task shortcut + delete · settings (Projects, Tasks, Labels tabs) · settings: miscellaneous ·
     stats · form (task/project dialog) · themed date picker · quick entry · save · CSV import wizard · calendar ·
     home (ranking LEVELS/tierOf, room moods, labels that fit, plan, side panel) · map editor · keyboard in
     dialogs · keyboard: "/" filter · touch drag & drop · click outside

   Detailed notes on every part: web/static/CLAUDE.md. */

// Each section is its own page; the server tells us which one (and which settings tab) via <body data-*>
let T = [], ST = { colors: {}, labels: [], projects: {}, pcolors: {}, projectNames: [], rooms: {}, porder: [] }, V = document.body.dataset.view || 'board', SV = document.body.dataset.tab || 'projects', cur = 0, SEL = new Set(), LB = [], PJ = [];
let MODE = 'task';             // what the "+ New" form is creating: 'task' or 'project'
let lastIds = null;            // card ids from the previous board render (used for enter animations)
let firstLoad = true;
const JUST_DONE = new Set();   // cards that were just completed (get a "landed" glow)
const S = ['backlog', 'doing', 'done'], SL = { backlog: 'ToDo', doing: 'Doing', done: 'Done' };
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let NEW_LABEL = null;          // label that was just created (gets an entrance animation)
let DROP_BEFORE = null;        // project the dragged row will be dropped in front of (null = end of the group)
let DRAG_PROJ = null;          // index (into PJ) of the project row being dragged in Settings > Projects
let MOVED_PROJ = null;         // project whose priority just changed (its row flashes in Settings > Projects)

// All server calls: send the CSRF token, and go to the sign-in page if the session has ended
function csrfToken() {
  const m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.content : '';
}

// opts.timeout (ms): give up on a request that hangs (e.g. a phone on a flaky Wi-Fi link) instead of waiting forever
async function api(url, opts = {}) {
  const { timeout, ...o } = opts;
  const ctl = timeout ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...o, ...(ctl ? { signal: ctl.signal } : {}), headers: { 'X-CSRFToken': csrfToken(), ...(o.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    location.href = '/login/?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('Signed out');
  }
  if (res.status === 403) {
    await ask({ title: 'Please reload', message: 'Your session changed (for example, you signed in on another tab). The page will reload so you can continue.', ok: 'Reload', info: true, icon: '🔄' });
    location.reload();
    throw new Error('CSRF token expired');
  }
  return res;
}

// Branded replacement for confirm()/alert(). Resolves true (confirmed) or false (cancelled / dismissed).
function ask({ title = 'Are you sure?', message = '', ok = 'Confirm', danger = false, info = false, icon = '⚠️' } = {}) {
  return new Promise(resolve => {
    const d = $('cd'), okB = $('cd-ok'), noB = $('cd-no');
    $('cd-i').textContent = icon;
    $('cd-i').className = 'cdicon' + (danger ? ' danger' : '');
    $('cd-t').textContent = title;
    $('cd-m').textContent = message;
    okB.textContent = ok;
    okB.className = danger ? 'red' : 'p';
    noB.hidden = info;
    let answer = false;
    okB.onclick = () => { answer = true; d.close(); };
    noB.onclick = () => d.close();
    d.onclose = () => resolve(answer);   // also fires on Esc / click outside
    d.showModal();
    (danger ? noB : okB).focus();
  });
}

// Label colors and a separate, clearly distinct palette for projects
const PAL = ['#3e9a78', '#3d85c6', '#8e5ea2', '#e0872a', '#d64550', '#2a9d8f', '#5c6bc0', '#c9a227'];
const PROJ_PAL = ['#d1495b', '#3d85c6', '#edae49', '#6a994e', '#8e5ea2', '#e07a5f', '#2a9d8f', '#b56576', '#c9a227', '#5c6bc0', '#7f9e3e', '#00798c'];
const FREQ = [['One-off', 0], ['Monthly', 1], ['Quarterly', 3], ['Twice a year', 6], ['Annually', 12], ['Every 2 years', 24], ['Every 5 years', 60]];
const PR = [[1, 'Highest'], [2, 'High'], [3, 'Medium'], [4, 'Low']];

function popts(v) {
  return PR.map(p => `<option value="${p[0]}" ${p[0] == v ? 'selected' : ''}>${p[1]}</option>`).join('');
}

/* ---- Repeat frequencies ----
   A frequency is a label that says how often a task repeats ("Monthly", "weekly", "Every 3 weeks").
   Giving a task that label sets its repeat (task.interval + task.interval_unit: 'd' days, 'w' weeks, 'm' months),
   and the Repeat dropdown lists exactly the frequency labels. A label's frequency comes from ST.freqs (set in
   Settings › Labels; 0 = "not a frequency"), else the built-ins (FREQ), else its name (parseFreq). */
const UNIT_NAMES = { d: ['day', 'days'], w: ['week', 'weeks'], m: ['month', 'months'] };
const FREQ_WORDS = {
  'daily': [1, 'd'], 'every day': [1, 'd'],
  'weekly': [1, 'w'], 'every week': [1, 'w'], 'once a week': [1, 'w'],
  'biweekly': [2, 'w'], 'bi-weekly': [2, 'w'], 'fortnightly': [2, 'w'], 'every other week': [2, 'w'],
  'monthly': [1, 'm'], 'every month': [1, 'm'], 'once a month': [1, 'm'],
  'bimonthly': [2, 'm'], 'bi-monthly': [2, 'm'], 'every other month': [2, 'm'],
  'quarterly': [3, 'm'], 'twice a year': [6, 'm'], 'semiannually': [6, 'm'], 'semi-annually': [6, 'm'], 'biannually': [6, 'm'],
  'annually': [12, 'm'], 'yearly': [12, 'm'], 'every year': [12, 'm'], 'once a year': [12, 'm'],
};

// "Weekly" -> {n: 1, u: 'w'}, "Every 2-5 years" -> {n: 42, u: 'm'}; null if the name isn't a frequency (same as repeat.py)
function parseFreq(g) {
  const t = String(g).toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  if (FREQ_WORDS[t]) return { n: FREQ_WORDS[t][0], u: FREQ_WORDS[t][1] };
  const m = t.match(/^(?:every\s+)?(\d+)(?:\s*-\s*(\d+))?\s*(day|week|month|year)s?$/);
  if (!m) return null;
  const n = Math.round((m[2] ? (+m[1] + +m[2]) / 2 : +m[1]) * (m[3] == 'year' ? 12 : 1));
  return n > 0 ? { n, u: m[3] == 'day' ? 'd' : m[3] == 'week' ? 'w' : 'm' } : null;
}

// How often label g repeats, or null if it's a plain label
function freqOf(g) {
  const own = (ST.freqs || {})[g];
  if (own !== undefined && own !== null) {
    if (typeof own == 'number') return own > 0 ? { n: own, u: 'm' } : null;       // older settings: months
    return +own.n > 0 && UNIT_NAMES[own.u] ? { n: +own.n, u: own.u } : null;
  }
  const b = FREQ.find(f => f[0] == g);
  if (b) return b[1] ? { n: b[1], u: 'm' } : null;
  return parseFreq(g);
}
const isFreq = g => !!freqOf(g);
const ivDays = f => (f ? f.n * { d: 1, w: 7, m: 30.44 }[f.u] : 0);
const ivOfTask = t => (t.interval ? { n: +t.interval, u: t.interval_unit || 'm' } : null);
const sameIv = (a, b) => (!a && !b) || (!!a && !!b && a.n == b.n && a.u == b.u);

// "Every 18 months" / "Every 3 weeks" / "Weekly" for n days|weeks|months|years; months holds the result
function freqName(n, unit) {
  n = clampN(Math.round(+n || 0), 1, 600);
  const f = unit == 'years' ? { n: n * 12, u: 'm' } : { n, u: unit == 'days' ? 'd' : unit == 'weeks' ? 'w' : 'm' };
  return { name: repeatName(f), ...f };
}

// Display name for an interval {n, u}: a built-in or word name, else "Every 4 years" / "Every 3 weeks"
function repeatName(f) {
  if (!f || !f.n) return 'One-off';
  if (f.u == 'd') return f.n == 1 ? 'Daily' : `Every ${f.n} days`;
  if (f.u == 'w') return f.n == 1 ? 'Weekly' : `Every ${f.n} weeks`;
  const b = FREQ.find(x => x[1] == f.n);
  if (b) return b[0];
  return f.n % 12 == 0 ? `Every ${f.n / 12} years` : `Every ${f.n} months`;
}

// Repeat choices: One-off + every frequency label, shortest first
function freqOpts() {
  const opts = allLabels().filter(isFreq).map(g => [g, freqOf(g)]);
  return [['One-off', null], ...opts.sort((a, b) => ivDays(a[1]) - ivDays(b[1]) || a[0].localeCompare(b[0]))];
}

// The option a task is on: its frequency label, else one with the same interval. null = no match.
function curFreq(t, opts = freqOpts()) {
  const tag = lbls(t).find(g => opts.some(f => f[0] == g));
  if (tag) return tag;
  const iv = ivOfTask(t);
  if (!iv) return 'One-off';
  const m = opts.find(f => sameIv(f[1], iv));
  return m ? m[0] : null;
}

// <option>s for a Repeat dropdown (value = label name; data-n/data-u = interval).
// A task whose interval matches no label gets a "custom" entry.
function freqOptionsHTML(t, opts = freqOpts()) {
  const c = curFreq(t, opts), iv = ivOfTask(t);
  const o = ([g, f]) => `<option value="${esc(g)}" data-n="${f ? f.n : 0}" data-u="${f ? f.u : 'm'}" ${g == c ? 'selected' : ''}>${esc(g)}</option>`;
  return opts.map(o).join('') +
    (c ? '' : `<option value="__custom" data-n="${iv.n}" data-u="${iv.u}" selected>${esc(repeatName(iv))}</option>`);
}

// Tags with the frequency label swapped for g (none for One-off / custom)
function withFreq(tags, g) {
  const a = tags.filter(x => !isFreq(x));
  if (g && g != 'One-off' && g != '__custom' && g != '__new') a.push(g);
  return a;
}

// A task's repeat after its labels change: its frequency label's interval, else one-off
function syncTaskIv(t) {
  const g = lbls(t).find(isFreq), f = g ? freqOf(g) : null;
  t.interval = f ? f.n : 0;
  t.interval_unit = f ? f.u : 'm';
}

function prio(p) {
  return (ST.projects || {})[p] || 3;
}

function hashStr(g) {
  return Array.from(g).reduce((a, c) => a + c.charCodeAt(0), 0);
}

function col(g) {
  if (!g) return PAL[0];
  return (ST.colors || {})[g] || PAL[hashStr(g) % PAL.length];
}

// Each project gets its own stored color (assigned once, editable in Settings)
function projCol(p) {
  return (ST.pcolors || {})[p] || PROJ_PAL[hashStr(p || '') % PROJ_PAL.length];
}

function nextFreeColor() {
  const used = new Set(Object.values(ST.pcolors || {}));
  return PROJ_PAL.find(c => !used.has(c)) || PROJ_PAL[Object.keys(ST.pcolors || {}).length % PROJ_PAL.length];
}

function ensureProjColors() {
  if (!ST.pcolors) ST.pcolors = {};
  let changed = false;
  for (const p of projs(T, true)) {
    if (ST.pcolors[p]) continue;
    ST.pcolors[p] = nextFreeColor();
    changed = true;
  }
  return changed;
}

// readable text color for a given background color
function ink(c) {
  const h = String(c).replace('#', '');
  if (h.length !== 6) return '#fff';
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#1e2a38' : '#fff';
}

function chip(g, attrs = '', extraStyle = '') {
  const c = col(g);
  return `<span class="tag" ${attrs} style="background:${c};color:${ink(c)};border:1px solid ${c};${extraStyle}">${esc(g)}</span>`;
}

function lbls(t) {
  return (t.tags || '').split(',').filter(Boolean);
}

function allLabels() {
  const taskLabels = T.flatMap(lbls);
  const freqLabels = FREQ.slice(1).map(f => f[0]);
  const storedLabels = ST.labels || [];
  return Array.from(new Set([...storedLabels, ...freqLabels, ...taskLabels])).sort();
}

// Position in the hand-arranged order (Settings > Projects); projects never moved go last
function porder(p) {
  const i = (ST.porder || []).indexOf(p);
  return i < 0 ? Infinity : i;
}

// Project names in Board order: priority, then hand-arranged order, then A–Z.
// withEmpty = also include projects that have no tasks yet.
function projs(L, withEmpty = false) {
  const names = new Set(L.map(t => t.project));
  if (withEmpty) (ST.projectNames || []).forEach(p => names.add(p));
  return Array.from(names).sort((a, b) => prio(a) - prio(b) || (porder(a) - porder(b)) || a.localeCompare(b));
}

/* ---- rooms: each project belongs to a room of the house (Home map), default: the whole house.
   A task can override its project's room (task.room); '' means "same as the project".
   Rooms are drawn by the user in the Home map editor and saved in ST.map; until then the starter
   layout from the server (web/rooms.py DEFAULT_MAP, passed as json_script "map-default") is used. ---- */
let BUILTIN_ROOMS = [['house', 'Whole house', '🏠', null], ['yard', 'Yard & exterior', '🌳', null]];   // yard's name/icon: MAP.yard
const DEFAULT_MAP = (() => {
  try { return JSON.parse(document.getElementById('map-default').textContent); }
  catch (e) { return { floors: [{ id: 'main', name: 'Main floor' }], ground: 'main', rooms: [] }; }
})();
let MAP = DEFAULT_MAP;          // the map in use (ST.map once saved)
let ROOMS = BUILTIN_ROOMS;      // [id, name, emoji, floor id] for the built-ins + every room on the map

const clone = o => JSON.parse(JSON.stringify(o));

function validMap(m) {
  return m && Array.isArray(m.floors) && m.floors.length && Array.isArray(m.rooms) ? m : null;
}

// Rebuild ROOMS from the saved map (called whenever settings load or the map is saved)
// Stairs live in MAP.rooms with kind 'stairs': they sit on one floor and lead `to` another.
// They're drawn on both floors but aren't rooms (no tasks, not in room pickers).
const isStairs = r => r && r.kind === 'stairs';
// Blocked-off areas: inside the walls but not a room or a hallway (over the garage, open to below…)
const isBlocked = r => r && r.kind === 'blocked';
// Outside: trees (not rooms) and structures like a shed (rooms: they hold tasks)
const isTree = r => r && r.kind === 'tree';
const isStructure = r => r && r.kind === 'structure';
// Map items that aren't rooms: no tasks, not in room pickers or counts
const isFeature = r => isStairs(r) || isBlocked(r) || isTree(r);
const floorIdx = (id, floors = MAP.floors) => floors.findIndex(f => f.id == id);
// the floor above if there is one, else the one below (never Outside)
function adjacentFloor(fid, floors = MAP.floors) {
  const fl = floors.filter(f => !isOutside(f.id)), i = floorIdx(fid, fl);
  return (fl[i + 1] || fl[i - 1] || fl[i] || fl[0]).id;
}

/* ---- Outside: the property around the house ----
   A floor with id 'outside' (shown as its own tab). Its canvas is OUT_W × OUT_H plan units centred on the
   house, which sits in the middle at its real size, hatched, and can't be edited or covered there.
   Everything else is yard: areas (rooms, e.g. Back yard), structures (rooms, e.g. a shed) and trees.
   Items of different kinds may overlap there (a shed in the back yard, a tree over it).
   map.lot = {t, r, b, l} grows the property past that on each side (Yard size in the editor). */
const OUT = 'outside', OUT_W = 1400, OUT_H = 940, OUT_HEAD = 200, HOME_HEAD = 30, LOT_STEP = 100, LOT_MAX = 2000;
const LOT_SIDES = [['t', 'Above (back)'], ['b', 'Below (front)'], ['l', 'Left'], ['r', 'Right']];
const isOutside = fid => fid === OUT;
function lotOf(map = MAP) {
  const l = map.lot || {};
  return Object.fromEntries(LOT_SIDES.map(([k]) => [k, clampN(snap(+l[k] || 0), 0, LOT_MAX)]));
}
// In the editor there's always OUT_HEAD of open yard above the highest item, so the back yard can keep
// growing upward: drag its top edge up, let go, and the canvas grows (the editor freezes the view mid-drag).
// Home passes HOME_HEAD instead, so a tall back yard doesn't leave a big empty strip above it.
function outBounds(map = MAP, head = OUT_HEAD) {
  const o = houseOutline(map), l = lotOf(map);
  const cx = o ? o.x + o.w / 2 : PLAN_W / 2, cy = o ? o.y + o.h / 2 : PLAN_H / 2;
  const top = snap(cy - OUT_H / 2) - l.t, bottom = snap(cy - OUT_H / 2) + OUT_H + l.b;
  const high = Math.min(...map.rooms.filter(r => isOutside(r.floor)).map(r => r.y));
  const y = Math.min(top, snap(high) - head);     // no items: Math.min() is Infinity, so just `top`
  return { x: snap(cx - OUT_W / 2) - l.l, y, w: OUT_W + l.l + l.r, h: bottom - y };
}
// what a floor's map shows, in plan units
const viewOf = (fid, map = MAP) => (isOutside(fid) ? outBounds(map) : { x: 0, y: 0, w: PLAN_W, h: PLAN_H });
const layerOf = r => (isTree(r) ? 'tree' : isStructure(r) ? 'structure' : isStairs(r) ? 'stairs' : 'room');
// pairs that may overlap: stacked flights, trees, and different kinds of things outside
const coexist = (a, b) => (isStairs(a) && isStairs(b)) || (isTree(a) && isTree(b)) || (isOutside(a.floor) && layerOf(a) != layerOf(b));
// Outside, nothing may cover the house
function hitsHouse(r, map) {
  const h = isOutside(r.floor) && houseOutline(map);
  return !!h && overlaps(r, { ...h, floor: r.floor, id: '__house' });
}

// Maps saved before Outside existed get the tab, with a back and a front yard to start from
function withOutside(m) {
  if (m.floors.some(f => isOutside(f.id))) return m;
  m.floors.push({ id: OUT, name: 'Outside' });
  const o = houseOutline(m);
  if (!o) return m;
  const ob = outBounds(m), ids = new Set(m.rooms.map(r => r.id)), names = new Set(m.rooms.map(r => (r.name || '').toLowerCase()));
  const x = Math.max(ob.x + 10, o.x - 200), w = Math.min(ob.x + ob.w - 10, o.x + o.w + 200) - x;
  const backY = Math.max(ob.y + 10, o.y - 260), frontY = o.y + o.h + 20;
  [['backyard', 'Back yard', '🌻', backY, o.y - 20 - backY], ['frontyard', 'Front yard', '🌱', frontY, Math.min(240, ob.y + ob.h - 10 - frontY)]]
    .forEach(([id, name, emoji, y, h]) => {
      if (names.has(name.toLowerCase()) || h < MIN_ROOM) return;
      m.rooms.push({ id: ids.has(id) ? newMapId() : id, name, emoji, floor: OUT, x, y, w, h });
    });
  return m;
}

// The house's outer walls: the box around everything on the ground floor (the floor with the yard).
// Every floor draws these same walls, so floors line up; rooms on other floors stay inside them.
// (No ground-floor rooms yet: the box around everything on the map.)
function houseOutline(map = MAP) {
  return footprint(map.rooms.filter(r => r.floor == map.ground)) || footprint(map.rooms.filter(r => !isOutside(r.floor)));
}

// The area a room may occupy: inside the walls on other floors, the whole plan on the ground floor,
// the whole property Outside
function roomBounds(r, map) {
  if (isOutside(r.floor)) return outBounds(map);
  const o = r.floor != map.ground && houseOutline(map);
  return o || { x: 0, y: 0, w: PLAN_W, h: PLAN_H };
}

// Pull rooms and stairs on the other floors inside the walls: trim what sticks out, or slide the room
// in if trimming would leave it smaller than MIN_ROOM. Returns how many changed.
/* ---- room shapes ----
   A room (or blocked-off area) is a rectangle (x, y, w, h) or, once reshaped, an outline `pts`: its corners
   [[x, y], …] in order, every wall horizontal or vertical and on the grid. x/y/w/h always hold the box
   around the outline, so anything that only needs a box keeps working. */
const ptsOf = r => r.pts || [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
const samePt = (a, b) => a[0] == b[0] && a[1] == b[1];

function boxOf(pts) {
  const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Drop repeated corners and corners in the middle of a straight wall
function cleanPts(pts) {
  const out = pts.map(q => [q[0], q[1]]);
  for (let changed = true; changed && out.length > 3;) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
      if (samePt(b, c) || (a[0] == b[0] && b[0] == c[0]) || (a[1] == b[1] && b[1] == c[1])) { out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}

// A usable outline: walls all straight up/down or across, never crossing or touching each other
function simplePts(pts) {
  const n = pts.length;
  if (n < 4) return false;
  const seg = i => [pts[i], pts[(i + 1) % n]];
  for (let i = 0; i < n; i++) {
    const [a, b] = seg(i);
    if (a[0] != b[0] && a[1] != b[1]) return false;
    for (let j = i + 2; j < n; j++) {
      if (i == 0 && j == n - 1) continue;                       // neighbours share a corner
      const [c, d] = seg(j);
      if (Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) &&
          Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))) return false;
    }
  }
  return true;
}

function pointIn(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The grid cells a room covers ("x,y" of each cell's top-left), for exact overlap tests on shaped rooms
function cellsOf(r) {
  const pts = ptsOf(r), set = new Set();
  for (let y = r.y; y < r.y + r.h; y += GRID) {
    for (let x = r.x; x < r.x + r.w; x += GRID) if (pointIn(pts, x + GRID / 2, y + GRID / 2)) set.add(x + ',' + y);
  }
  return set;
}

// The biggest rectangle inside a shaped room (where its label goes), from its grid cells
function labelBox(r) {
  if (!r.pts) return { x: r.x, y: r.y, w: r.w, h: r.h };
  const cells = cellsOf(r), cols = Math.round(r.w / GRID), heights = new Array(cols).fill(0);
  let best = { x: r.x, y: r.y, w: r.w, h: r.h, a: 0 };
  for (let row = 0; row < Math.round(r.h / GRID); row++) {
    const y = r.y + row * GRID;
    for (let c = 0; c < cols; c++) heights[c] = cells.has((r.x + c * GRID) + ',' + y) ? heights[c] + 1 : 0;
    for (let c = 0; c < cols; c++) {                          // widest run at each height (small grids: fine)
      let minH = Infinity;
      for (let e = c; e < cols && heights[e]; e++) {
        minH = Math.min(minH, heights[e]);
        const a = minH * (e - c + 1);
        if (a > best.a) best = { x: r.x + c * GRID, y: y - (minH - 1) * GRID, w: (e - c + 1) * GRID, h: minH * GRID, a };
      }
    }
  }
  return best;
}

// The shape element itself: <rect> for plain rooms, <polygon> for reshaped ones
const shapeSVG = r => r.pts
  ? `<polygon points="${r.pts.map(q => q.join(',')).join(' ')}"/>`
  : `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`;

// After an edit: tidy the outline, and go back to a plain rectangle when that's what it is
function settleShape(r) {
  if (!r.pts) return;
  const c = cleanPts(r.pts);
  Object.assign(r, boxOf(c));
  if (c.length == 4) delete r.pts; else r.pts = c;
}

function fitToOutline(map) {
  const o = houseOutline(map);
  if (!o) return 0;
  let n = 0;
  map.rooms.filter(r => r.floor != map.ground && !isOutside(r.floor)).forEach(r => {
    if (r.pts) {
      const c = cleanPts(r.pts.map(([x, y]) => [clampN(x, o.x, o.x + o.w), clampN(y, o.y, o.y + o.h)]));
      const bx = boxOf(c);
      if (JSON.stringify(c) != JSON.stringify(r.pts) && simplePts(c) && bx.w >= MIN_ROOM && bx.h >= MIN_ROOM) {
        r.pts = c; settleShape(r); n++;
      }
      return;
    }
    const before = `${r.x},${r.y},${r.w},${r.h}`;
    const x1 = Math.max(r.x, o.x), x2 = Math.min(r.x + r.w, o.x + o.w);
    const y1 = Math.max(r.y, o.y), y2 = Math.min(r.y + r.h, o.y + o.h);
    if (x2 - x1 >= MIN_ROOM) { r.x = x1; r.w = x2 - x1; }
    else { r.w = Math.min(r.w, o.w); r.x = clampN(r.x, o.x, o.x + o.w - r.w); }
    if (y2 - y1 >= MIN_ROOM) { r.y = y1; r.h = y2 - y1; }
    else { r.h = Math.min(r.h, o.h); r.y = clampN(r.y, o.y, o.y + o.h - r.h); }
    if (`${r.x},${r.y},${r.w},${r.h}` != before) n++;
  });
  return n;
}

function rebuildRooms() {
  MAP = withOutside(clone(validMap(ST.map) || DEFAULT_MAP));
  const floorIds = MAP.floors.map(f => f.id), inside = floorIds.filter(f => !isOutside(f));
  if (!inside.includes(MAP.ground)) MAP.ground = inside[Math.min(1, inside.length - 1)];
  MAP.rooms.forEach(r => {
    if (!floorIds.includes(r.floor)) r.floor = MAP.ground;
    if (isStairs(r) && (!inside.includes(r.to) || r.to == r.floor)) r.to = adjacentFloor(r.floor);
  });
  fitToOutline(MAP);     // older maps may have rooms past the walls; shown fitted, saved fitted on the next map save
  const y = MAP.yard || {};
  BUILTIN_ROOMS = [BUILTIN_ROOMS[0], ['yard', (y.name || '').trim() || 'Yard & exterior', y.emoji || '🌳', null]];
  ROOMS = [...BUILTIN_ROOMS, ...MAP.rooms.filter(r => !isFeature(r)).map(r => [r.id, r.name, r.emoji || '🚪', r.floor])];
}

const isRoom = r => ROOMS.some(x => x[0] == r);
const floorName = id => (MAP.floors.find(f => f.id == id) || { name: '' }).name;
const LEGACY_ROOMS = { laundry: 'basement' };    // rooms that were renamed

// Best guess from the project name until you pick a room yourself
const ROOM_GUESS = [
  ['kitchen', /kitchen|pantry/i],
  ['garage', /garage|workshop/i],
  ['basement', /basement|cellar|crawl ?space|sump|laundry|washer|dryer/i],
  ['bath', /bath|shower|toilet/i],
  ['bedroom', /bed ?room|nursery|guest room/i],
  ['dining', /dining/i],
  ['office', /office|study/i],
  ['living', /living|family room|fireplace|\bden\b/i],
  ['yard', /exterior|outdoor|outside|yard|lawn|garden|landscap|roof|gutter|deck|patio|porch|fence|pool|siding|driveway/i]
];

// A project named after a room on the map goes there ("Kitchen remodel" → Kitchen); otherwise
// keyword hints; otherwise the whole house
function guessRoom(p) {
  const name = (p || '').toLowerCase();
  const byName = MAP.rooms.find(r => !isFeature(r) && r.name && name.includes(r.name.toLowerCase().replace(/s$/, '')));
  if (byName) return byName.id;
  const m = ROOM_GUESS.find(([, re]) => re.test(p || ''));
  return m && isRoom(m[0]) ? m[0] : 'house';
}

function roomFor(p) {
  const stored = (ST.rooms || {})[p];
  const r = LEGACY_ROOMS[stored] || stored;
  return isRoom(r) ? r : guessRoom(p);
}

// The room a task counts toward: its own, if set, else its project's
function taskRoom(t) {
  const r = LEGACY_ROOMS[t.room] || t.room;
  return r && isRoom(r) ? r : roomFor(t.project);
}

function roomInfo(r) {
  return ROOMS.find(x => x[0] == r) || ROOMS[0];
}

// <option>s for a room picker: the built-ins, then one group per floor
function roomOpts(sel) {
  const opt = ([k, n, e]) => `<option value="${esc(k)}" ${k == sel ? 'selected' : ''}>${e} ${esc(n)}</option>`;
  return BUILTIN_ROOMS.map(opt).join('') + MAP.floors.map(f => {
    const rs = ROOMS.filter(r => r[3] == f.id);
    return rs.length ? `<optgroup label="${esc(f.name)}">${rs.map(opt).join('')}</optgroup>` : '';
  }).join('');
}

// ?room=kitchen on the Board shows only that room's projects (links from the Home map).
// Checked against the map once settings have loaded.
const ROOM_PARAM = new URLSearchParams(location.search).get('room');
const roomQ = () => (ROOM_PARAM && isRoom(ROOM_PARAM) ? ROOM_PARAM : null);
// ?project=kitchen and ?label=quarterly (links from Settings) show just that project / label; capitals don't matter
const PROJECT_PARAM = (new URLSearchParams(location.search).get('project') || '').trim().toLowerCase();
const LABEL_PARAM = (new URLSearchParams(location.search).get('label') || '').trim().toLowerCase();
// ?rank=perfect|thriving|livable|neutral|slacking|neglected (from the Home rank bar): tasks in rooms of that rank
const RANK_PARAM = (k => ['perfect', 'thriving', 'livable', 'neutral', 'slacking', 'neglected'].includes(k) ? k : '')((new URLSearchParams(location.search).get('rank') || '').trim().toLowerCase());
// Board status filter (click a column heading): null = all three columns. Kept in the URL as ?status=
let STATUS_Q = (p => S.includes(p) ? p : null)(new URLSearchParams(location.search).get('status'));
let STATUS_SEEN = new Set();   // projects shown under this status filter: they stay put when their last card moves out
let FLIP_ONLY = null;          // while a card moves: only that project's cards slide (other projects never animate)

function setStatusQ(s) {
  STATUS_Q = STATUS_Q === s || !S.includes(s) ? null : s;
  STATUS_SEEN = new Set();
  const u = new URL(location.href);
  STATUS_Q ? u.searchParams.set('status', STATUS_Q) : u.searchParams.delete('status');
  history.replaceState(null, '', u);
  draw();
}
const projectLink = p => `/board/?project=${encodeURIComponent(p.toLowerCase())}`;
const labelLink = g => `/board/?label=${encodeURIComponent(g.toLowerCase())}`;

// Settings > Miscellaneous values (with defaults)
function spawnDays() { return Number.isFinite(+ST.spawnDays) ? +ST.spawnDays : 7; }
function dueWarn() {
  return { y: Number.isFinite(+ST.dueYellow) ? +ST.dueYellow : 14, o: Number.isFinite(+ST.dueOrange) ? +ST.dueOrange : 7 };
}

function allProjectNames() {
  return projs(T, true);
}

function byPr(a, b) {
  return a.priority - b.priority || a.due.localeCompare(b.due);
}

// local date (not UTC) as YYYY-MM-DD
function today() {
  return new Date().toLocaleDateString('en-CA');
}

function addM(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}

// The next occurrence of a repeating task after date d
function addIv(d, t) {
  const u = t.interval_unit || 'm';
  return u == 'm' ? addM(d, t.interval) : new Date(d.getFullYear(), d.getMonth(), d.getDate() + t.interval * (u == 'w' ? 7 : 1));
}

function fmtDate(iso) {
  return new Date(iso + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

async function saveST(timeout) {
  return api('/api/settings/put', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ST),
    timeout
  });
}

async function load() {
  try {
    const [tRes, sRes] = await Promise.all([api('/api/tasks'), api('/api/settings')]);
    const newT = await tRes.json();
    const newST = Object.assign({ colors: {}, labels: [], projects: {}, pcolors: {}, projectNames: [], rooms: {}, porder: [] }, await sRes.json());
    const before = JSON.stringify([T, ST]);
    T = newT;
    ST = newST;
    rebuildRooms();
    // a map saved before the Outside tab existed: save it with the tab (and its starter yards) once
    if (validMap(ST.map) && !ST.map.floors.some(f => isOutside(f.id))) {
      ST.map = clone(MAP);
      await saveST();
    }
    const added = ensureProjColors();
    if (added) await saveST();

    const ppEl = $('pp'), tpEl = $('tp');
    // fill the priority pickers, keeping whatever is selected (the form may be open, e.g. "Save & add another")
    if (ppEl) ppEl.innerHTML = popts(ppEl.value || 3);
    if (tpEl) tpEl.innerHTML = popts(tpEl.value || 3);

    // Nothing changed (e.g. after an optimistic drag) -> don't rebuild the DOM mid-animation
    if (!firstLoad && !added && before === JSON.stringify([T, ST])) return;
    firstLoad = false;
    draw();
  } catch (err) {
    console.error("Failed to load app data:", err);
    showLoadError(err);
  }
}

// If loading or drawing fails, say so on the page (with the reason) instead of leaving it blank
function showLoadError(err) {
  const m = $('m');
  if (!m || (err && err.message === 'Signed out')) return;
  const why = err && err.message ? `${err.name || 'Error'}: ${err.message}` : String(err);
  m.innerHTML = `<div class="loaderr"><b>This page couldn’t load.</b>
    <p>Try reloading. If it keeps happening, this is the reason to pass along:</p>
    <code>${esc(why)}</code>
    <button class="p" onclick="location.reload()">Reload</button></div>`;
}

// Settings sub-tabs swap in place but update the URL, so a refresh stays on the same tab
function setSV(k) {
  SV = k;
  history.replaceState(null, '', `/settings/${k}/`);
  draw();
}

// The header filter applies everywhere except Settings > Miscellaneous, where there is nothing to filter
function filterable() {
  return !(V === 'settings' && SV === 'misc');
}

function filterQ() {
  const qEl = $('q');
  return qEl && filterable() ? qEl.value.trim().toLowerCase() : '';
}

function draw() {
  const qEl = $('q');
  if (qEl) {
    qEl.disabled = !filterable();
    const box = qEl.closest('.search');
    box.classList.toggle('off', !filterable());
    box.title = filterable() ? 'Filter by title, label or project (press /)' : 'Nothing to filter on this page';
  }
  const q = filterQ();
  let L = T.filter(t => !q || (t.title + t.tags + t.project).toLowerCase().includes(q));
  if (V === 'board' && roomQ()) L = L.filter(t => taskRoom(t) === roomQ());
  if (V === 'board' && PROJECT_PARAM) L = L.filter(t => t.project.toLowerCase() === PROJECT_PARAM);
  if (V === 'board' && LABEL_PARAM) L = L.filter(t => lbls(t).some(g => g.toLowerCase() === LABEL_PARAM));
  if (V === 'board' && RANK_PARAM) { const rs = roomStats(T, ''); L = L.filter(t => roomLevel(rs[taskRoom(t)]) === RANK_PARAM); }

  if (V === 'home') home(L, q);
  else if (V === 'board') board(L, !q);
  else if (V === 'cal') cal(L);
  else if (V === 'stats') stats(L, q);
  else if (V === 'settings') settings(L, q);
}

/* ---- FLIP animation helpers: smoothly slide elements (cards, project rows) from old to new position ---- */
const flipKey = el => el.dataset.key || el.id;

function snapshot(sel = '.card') {
  const pos = {};
  document.querySelectorAll(sel).forEach(el => { pos[flipKey(el)] = el.getBoundingClientRect(); });
  return pos;
}

function flip(prev, sel = '.card', only = null) {
  if (reduceMotion()) return;
  document.querySelectorAll(sel).forEach(el => {
    if (only && !only(el)) return;
    const p = prev[flipKey(el)];
    if (!p) return;
    const n = el.getBoundingClientRect();
    const dx = p.left - n.left, dy = p.top - n.top;
    if (!dx && !dy) return;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 420, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    );
  });
}

/* ---- board ---- */
function board(L, showEmpty = true) {
  const prev = snapshot();
  PJ = projs(L, showEmpty);
  if (roomQ()) PJ = PJ.filter(p => roomFor(p) === roomQ() || L.some(t => t.project === p));
  if (PROJECT_PARAM) PJ = PJ.filter(p => p.toLowerCase() === PROJECT_PARAM);
  if (LABEL_PARAM || RANK_PARAM) PJ = PJ.filter(p => L.some(t => t.project === p));

  // Column headings with a colored divider and a task count; clicking one shows only that column
  let h = '<div class="head" role="group" aria-label="Show tasks by status">' + S.map(s =>
    `<button type="button" class="hd hd-${s}${STATUS_Q && STATUS_Q != s ? ' off' : ''}" aria-pressed="${STATUS_Q == s}" onclick="setStatusQ('${s}')" ` +
    `title="${STATUS_Q == s ? 'Show all columns' : `Show only ${SL[s]} tasks`}">${SL[s]}<span>${L.filter(t => t.status == s).length}</span></button>`
  ).join('') + '</div>';
  if (STATUS_Q) {
    PJ = PJ.filter(p => STATUS_SEEN.has(p) || L.some(t => t.project == p && t.status == STATUS_Q));
    PJ.forEach(p => STATUS_SEEN.add(p));
    h = `<div class="roombar">Showing only <b>${SL[STATUS_Q]}</b> tasks<a href="#" onclick="event.preventDefault();setStatusQ(null)">Show all columns</a></div>` + h;
  }

  if (roomQ()) {
    const [, n, e] = roomInfo(roomQ());
    h = `<div class="roombar">Showing projects in <b>${e} ${n}</b><a href="/board/">Show all rooms</a></div>` + h;
  }
  if (PROJECT_PARAM) {
    const name = allProjectNames().find(p => p.toLowerCase() === PROJECT_PARAM) || PROJECT_PARAM;
    h = `<div class="roombar">Showing the <b>${esc(name)}</b> project<a href="/board/">Show all projects</a></div>` + h;
  }
  if (LABEL_PARAM) {
    const name = allLabels().find(g => g.toLowerCase() === LABEL_PARAM) || LABEL_PARAM;
    h = `<div class="roombar">Showing tasks labelled ${chip(name)}<a href="/board/">Show all tasks</a></div>` + h;
  }
  if (RANK_PARAM) {
    const [, name, c, range] = levelInfo(RANK_PARAM);
    h = `<div class="roombar">Showing tasks in rooms ranked <b class="rankchip" style="--rc:${c}">${name}</b> (${range.toLowerCase()})<a href="/board/">Show all tasks</a></div>` + h;
  }
  if (!PJ.length && STATUS_Q) h += `<p style="text-align:center;color:var(--mut);padding:30px;">No ${SL[STATUS_Q]} tasks here.</p>`;
  else if (!PJ.length) h += '<p style="text-align:center;color:var(--mut);padding:30px;">Nothing here yet. Click “New” to create a project or task, or “Import” to load a CSV.</p>';

  const filtered = !showEmpty || !!(STATUS_Q || roomQ() || PROJECT_PARAM || LABEL_PARAM || RANK_PARAM);
  pjDefaults(filtered);
  PJ.forEach((p, i) => {
    const pt = L.filter(t => t.project == p);
    const pColor = projCol(p);
    const prData = PR.find(x => x[0] == prio(p)) || [3, 'Medium'];
    const doneCount = pt.filter(t => t.status == 'done').length;
    const openN = pt.filter(t => t.status != 'done').length;
    const open = pjIsOpen(p, filtered);

    // header: name + priority, then the task counts, then the buttons (three lines on a phone, one on a wide screen)
    h += `<section class="pj${open ? '' : ' shut'}" data-p="${esc(p)}" style="--proj-color:${pColor};"><div class="proj">` +
      `<button type="button" class="pjt" aria-expanded="${open}" onclick="togglePj(${i})" title="${open ? 'Collapse' : 'Expand'} this project">` +
      `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>` +
      `<span class="pname"><span class="pn">${esc(p)}</span> <small class="pprio">${prData[1]} priority</small></span>` +
      `<small class="pstats">${openN} open · ${doneCount}/${pt.length} done</small></button>` +
      `<span class="pact"><button type="button" class="pbtn" onclick="addTask(${i})" title="Add a task to this project">${PLUS_SVG}<span>Task</span></button>` +
      `<button type="button" class="pbtn del" data-drop="del" onclick="delProj(${i})" title="Delete this project (or drop a card here to delete the task)" aria-label="Delete project ${esc(p)}">${TRASH_SVG}<span class="dl">Delete</span></button></span></div><div class="lane${STATUS_Q ? ' one' : ''}">`;
    // filtered to one status: the other columns are still there (hidden), and open while a card is held
    for (const s of S) {
      const alt = STATUS_Q && s != STATUS_Q;
      h += `<div class="col hd-${s}${alt ? ' alt' : ''}" data-s="${SL[s]}" data-i="${COL_ICON[s]}" data-st="${s}">` +
        pt.filter(t => t.status == s).sort(byPr).map(card).join('') + '</div>';
    }
    h += '</div></section>';
  });
  const heights = {};
  document.querySelectorAll('.pj').forEach(x => { heights[x.dataset.p] = x.offsetHeight; });
  const m = $('m');
  if (m) m.innerHTML = h;
  lastIds = new Set(L.map(t => t.id));
  markLanding();
  // a moved card glides in by itself (flyTo); while a card moves, only its own project animates
  flip(prev, '.card', el => el.id !== 'card-' + FLYING &&
    (!FLIP_ONLY || (el.closest('.pj') || {}).dataset?.p === FLIP_ONLY));
  if (FLIP_ONLY && heights[FLIP_ONLY]) pjHeight(pjOf(FLIP_ONLY), heights[FLIP_ONLY]);
}

/* ---- collapsing projects ----
   On an unfiltered Board the first two projects (Settings › Projects order) that have open tasks start expanded;
   every other project starts collapsed. Those defaults are decided once per browser tab session (so moving the
   last card out of a project doesn't snap it shut), and the user's own toggles are kept in sessionStorage.
   Filtered views (search, ?room=, ?project=, ?label=, ?rank=, a status column) start with everything expanded.
   Clicking a project's chevron, name, or any empty part of its panel toggles it. */
const OPEN_FIRST = 2;
let PJ_OPEN = (() => { try { return JSON.parse(sessionStorage.getItem('boardOpen2')) || {}; } catch (e) { return {}; } })();
let PJ_OPEN_F = {};          // toggles made while the board is filtered (this page only)
let FIRST_OPEN = (() => { try { return JSON.parse(sessionStorage.getItem('boardFirst')); } catch (e) { return null; } })();
function savePjOpen() {
  try { sessionStorage.setItem('boardOpen2', JSON.stringify(PJ_OPEN)); sessionStorage.setItem('boardFirst', JSON.stringify(FIRST_OPEN)); } catch (e) { /* private browsing */ }
}
function pjDefaults(filtered) {
  if (filtered || !T.length) return;
  const all = projs(T, true);
  if (!Array.isArray(FIRST_OPEN)) FIRST_OPEN = all.filter(p => T.some(t => t.project == p && t.status != 'done')).slice(0, OPEN_FIRST);
  let changed = false;
  all.forEach(p => { if (!(p in PJ_OPEN)) { PJ_OPEN[p] = FIRST_OPEN.includes(p); changed = true; } });
  if (changed) savePjOpen();
}
const pjIsOpen = (p, filtered) => (filtered ? PJ_OPEN_F[p] !== false : !!PJ_OPEN[p]);
const boardFiltered = () => !!(filterQ() || STATUS_Q || roomQ() || PROJECT_PARAM || LABEL_PARAM || RANK_PARAM);

function setPjOpen(p, open) {
  if (boardFiltered()) PJ_OPEN_F[p] = open;
  else { PJ_OPEN[p] = open; savePjOpen(); }
}
function togglePj(i) {
  const p = PJ[i], pj = pjOf(p);
  if (!pj) return;
  const open = pj.classList.contains('shut');
  setPjOpen(p, open);
  resizePj(pj, () => {
    pj.classList.toggle('shut', !open);
    const b = pj.querySelector('.pjt');
    b.setAttribute('aria-expanded', open);
    b.title = (open ? 'Collapse' : 'Expand') + ' this project';
  });
}

// a click on an empty part of a project panel (not a card, button or link) toggles it too
document.addEventListener('click', e => {
  if (V !== 'board' || e.defaultPrevented) return;
  const pj = e.target.closest('#m .pj');
  if (!pj || e.target.closest('.card, button, a, input, select, textarea') || getSelection().toString()) return;
  const i = PJ.indexOf(pj.dataset.p);
  if (i >= 0) togglePj(i);
});



const COL_ICON = { backlog: '🗄️', doing: '🏃‍♂️', done: '✅' };

const SLIDE = { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
const pjOf = p => [...document.querySelectorAll('.pj')].find(x => x.dataset.p === p);

// A project panel whose height changes (a card moved, columns opened or closed) grows or shrinks smoothly
// from h0, and the panels below move along with it instead of jumping
function pjHeight(pj, h0) {
  if (!pj) return;
  pj.getAnimations().forEach(a => { if (a.id === 'pj-h') a.cancel(); });
  const h1 = pj.offsetHeight;
  if (reduceMotion() || Math.abs(h1 - h0) < 2) return;
  pj.style.overflow = 'hidden';
  const a = pj.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], SLIDE);
  a.id = 'pj-h';
  a.onfinish = () => { pj.style.overflow = ''; };
}
function resizePj(pj, change) {
  const h0 = pj.offsetHeight;
  change();
  pjHeight(pj, h0);
}

// Holding a card (mouse or touch) opens its project's three columns, each labelled with its icon
function holdOn(el) {
  const pj = el && el.closest('.pj');
  if (!pj || pj.classList.contains('holding')) return;
  const h0 = pj.offsetHeight;
  endLanding(LANDING && LANDING.p === pj.dataset.p);
  holdOff(pj);
  pj.classList.add('holding');
  pjHeight(pj, h0);
}
function holdOff(except) {
  document.querySelectorAll('.pj.holding').forEach(pj => { if (pj !== except) resizePj(pj, () => pj.classList.remove('holding')); });
}

// After a drop the columns stay labelled for a moment and the one the card landed in shines
let LANDING = null;   // { p: project, s: status, timer }
function land(p, s) {
  endLanding(true);
  LANDING = { p, s, timer: setTimeout(() => endLanding(), 2600) };
}
function markLanding() {           // board() calls this after each render
  const pj = LANDING && pjOf(LANDING.p);
  if (!pj) return;
  pj.classList.add('landing');
  const col = pj.querySelector(`.col[data-st="${LANDING.s}"]`);
  if (col) col.classList.add('shine');
}
function endLanding(now = false) {
  if (!LANDING) return;
  clearTimeout(LANDING.timer);
  const pj = pjOf(LANDING.p);
  LANDING = null;
  if (!pj) return;
  const off = () => { pj.classList.remove('landing'); pj.querySelectorAll('.col.shine').forEach(c => c.classList.remove('shine')); };
  if (now) off(); else resizePj(pj, off);
}

// The lifted copy of a card glides into the card's (new) place, then the real card shows again.
// FLYING keeps that card hidden meanwhile, even if the board is redrawn.
let FLYING = null;
function flyTo(ghost, id) {
  FLYING = +id;
  const el = $('card-' + id);
  const done = () => {
    ghost.remove();
    if (FLYING === +id) FLYING = null;
    const c = $('card-' + id);
    if (!c) return;
    c.classList.remove('flying', 'moving');
    if (JUST_DONE.has(+id)) { c.classList.remove('landed'); void c.offsetWidth; c.classList.add('landed'); }   // glow as it lands
  };
  if (!el || reduceMotion()) return done();
  el.classList.add('flying');
  const r = el.getBoundingClientRect();
  ghost.getAnimations().forEach(a => a.cancel());
  const a = ghost.animate([
    { transform: ghost.style.transform, width: ghost.style.width, scale: ghost.style.scale || 1, rotate: ghost.style.rotate || '0deg' },
    { transform: `translate(${r.left}px, ${r.top}px)`, width: r.width + 'px', scale: 1, rotate: '0deg', boxShadow: '0 2px 6px rgba(0, 0, 0, 0.2)' }
  ], { duration: 340, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' });
  a.onfinish = done;
  a.oncancel = done;
}

// Mouse (and pen): press a card and move it (or keep still for a moment) to lift it. It is carried the same way
// a finger carries it: one drag for every device, so the columns, the glide and the landing all look the same.
let MOUSE_HOLD = null;
document.addEventListener('pointerdown', e => {
  if (e.pointerType == 'touch' || e.button || TD) return;
  const el = e.target.closest('.pj .card');
  if (!el || e.target.closest('a, button')) return;
  e.preventDefault();                       // no text selection while dragging (the click still opens the task)
  el.classList.add('pressing');
  MOUSE_HOLD = { el, x: e.clientX, y: e.clientY, timer: setTimeout(() => mouseLift(), HOLD_MS) };
});
function mouseLift(x, y) {
  const { el, x: x0, y: y0, timer } = MOUSE_HOLD;
  clearTimeout(timer);
  MOUSE_HOLD = null;
  TD = { el, kind: 'card', id: el.id.slice(5), x: x0, y: y0, active: false, mouse: true, dr: el.draggable };
  touchBegin();
  if (x !== undefined) touchMoveTo(x, y);
}
document.addEventListener('pointermove', e => {
  if (e.pointerType == 'touch') return;
  if (TD && TD.mouse && TD.active) touchMoveTo(e.clientX, e.clientY);
  else if (MOUSE_HOLD && Math.hypot(e.clientX - MOUSE_HOLD.x, e.clientY - MOUSE_HOLD.y) > 4) mouseLift(e.clientX, e.clientY);
});
document.addEventListener('pointerup', e => {
  if (e.pointerType == 'touch') return;
  if (MOUSE_HOLD) { clearTimeout(MOUSE_HOLD.timer); MOUSE_HOLD.el.classList.remove('pressing'); MOUSE_HOLD = null; }
  if (TD && TD.mouse && TD.active) touchDrop();   // also blocks the click, so letting go doesn't open the task
});
document.addEventListener('keydown', e => {      // Esc while carrying a card: it goes back
  if (e.key == 'Escape' && TD && TD.active && TD.kind == 'card') { TD.target = null; touchDrop(); }
});

function card(t) {
  const sub = (t.notes.match(/^\s*- \[[ xX]\]/gm) || []);
  const dn = sub.filter(x => /[xX]/.test(x)).length;
  const tdStr = today();
  let dueClass = 'due-normal';

  // red: due today or overdue; orange / yellow: within the day counts set in Settings > Miscellaneous
  if (t.status != 'done' && t.due) {
    const diffDays = Math.round((new Date(t.due + 'T00:00') - new Date(tdStr + 'T00:00')) / 86400000);
    const w = dueWarn();
    if (diffDays <= 0) dueClass = 'due-red';
    else if (diffDays <= w.o) dueClass = 'due-orange';
    else if (diffDays <= w.y) dueClass = 'due-yellow';
  }
  const prObj = PR.find(x => x[0] == t.priority) || [3, 'Medium'];
  const isNew = !lastIds || !lastIds.has(t.id);
  const state = JUST_DONE.has(t.id) ? ' landed' : (isNew ? ' enter' : '');

  return `<div class="card${state}${FLYING === t.id ? ' flying' : ''}" id="card-${t.id}" onclick="edit(${t.id})"><span class="pr pr${t.priority}">${prObj[1]}</span><b>${esc(t.title)}</b>` +
    lbls(t).map(g => chip(g)).join('') +
    `<div class="meta"><span class="${dueClass}">Due: 📅 ${t.due}</span>${sub.length ? `<span>☑ ${dn}/${sub.length}</span>` : ''}${t.interval && !lbls(t).some(isFreq) ? `<span class="rpt" title="Repeats after it's done">↻ ${esc(repeatName(ivOfTask(t)))}</span>` : ''}${roomBadge(t)}${t.url ? `<a href="${esc(t.url)}" target="_blank" onclick="event.stopPropagation()">tutorial</a>` : ''}</div></div>`;
}

function roomBadge(t) {
  const r = taskRoom(t);
  if (!t.room || r === roomFor(t.project)) return '';
  const [, n, e] = roomInfo(r);
  return `<span class="rbadge" title="Room">${e} ${esc(n)}</span>`;
}

// Move a card to another status column. ghost = the lifted copy, which glides into the card's new place.
async function moveTask(id, s, ghost = null) {
  const t = T.find(x => x.id == id);
  if (!t || t.status == s) { if (ghost) flyTo(ghost, id); return; }

  if (s == 'done') {
    JUST_DONE.add(t.id);             // green glow as it lands
    setTimeout(() => JUST_DONE.delete(t.id), 1500);
    t.done_at = today();
  } else {
    t.done_at = null;
  }

  t.status = s;
  FLIP_ONLY = t.project;  // only this project's cards slide; the rest of the board stays still
  if (ghost) FLYING = t.id;
  land(t.project, s);
  try {
    draw();               // optimistic redraw -> cards glide to the new column
    if (ghost) flyTo(ghost, t.id);
    await put(t, false);
    await load();         // sync with server (picks up any auto-spawned recurring card)
  } finally {
    FLIP_ONLY = null;
  }
}

async function put(t, r = true) {
  const res = await api('/api/tasks/' + t.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t)
  });
  if (res.status === 409) {        // rename would duplicate an open task: explain, then restore server state
    await dupNotice(res);
    load();
    return false;
  }
  if (r) load();
  return res.ok;
}

// The server refuses a second open task with the same project + title (409)
async function dupNotice(res) {
  const body = await res.json().catch(() => ({}));
  await ask({ title: 'Task already exists', message: body.error || 'An open task with that name already exists in this project.', ok: 'OK', info: true, icon: '📋' });
}

/* ---- projects: add task shortcut + delete ---- */
function addTask(i) {
  const pj = pjOf(PJ[i]);
  if (pj && pj.classList.contains('shut')) togglePj(i);   // so the new card shows up
  edit(0, PJ[i]);
}

// A card dropped on a project's trash can: ask first (like deleting a project), then delete just that task
async function dropDelete(id) {
  const t = T.find(x => x.id == id);
  if (!t) return;
  if (!await ask({ title: 'Delete task?', message: `“${t.title}” will be permanently deleted. This can't be undone.`, ok: 'Delete task', danger: true, icon: '🗑️' })) return;
  const r = await api('/api/tasks/' + t.id + '/del', { method: 'DELETE' });
  if (!r.ok) {
    await ask({ title: 'Delete failed', message: `“${t.title}” could not be deleted. Please try again.`, ok: 'OK', info: true });
    return;
  }
  const el = $('card-' + t.id);
  if (el && !reduceMotion()) await el.animate([{ opacity: 1, scale: 1 }, { opacity: 0, scale: 0.85 }], { duration: 220, easing: 'ease-in' }).finished.catch(() => {});
  load();
}

async function delProj(i) {
  const p = PJ[i];
  const mine = T.filter(t => t.project == p);
  const message = mine.length
    ? `“${p}” and its ${mine.length} task${mine.length > 1 ? 's' : ''} will be permanently deleted. This can't be undone.`
    : `“${p}” will be permanently deleted. This can't be undone.`;
  if (!await ask({ title: 'Delete project?', message, ok: 'Delete project', danger: true, icon: '🗑️' })) return;
  // One request: the server deletes the tasks and the project's settings together
  const r = await api('/api/projects/del', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: p })
  });
  if (!r.ok) {
    await ask({ title: 'Delete failed', message: `“${p}” could not be deleted. Please try again.`, ok: 'OK', info: true });
    return;
  }
  load();
}

/* ---- settings ---- */
function settings(L, q) {
  const m = $('m');
  if (!m) return;
  // Tabs sit directly on top of the section and share its color
  const tabsHTML = [['projects', 'Projects', 'Projects'], ['tasks', 'Tasks', 'Tasks'], ['labels', 'Labels', 'Labels'], ['misc', 'Miscellaneous', 'Misc']]
    .map(([k, n, short]) => `<button class="stab ${SV == k ? 'on' : ''}" onclick="setSV('${k}')"><span class="long">${n}</span><span class="short">${short}</span></button>`).join('');

  let content = '';
  if (SV == 'labels') content = labelsUI(q);
  else if (SV == 'projects') content = projUI(L, q);
  else if (SV == 'misc') content = miscUI();
  else content = sched(L);

  m.innerHTML = `<div class="stabs">${tabsHTML}</div>${content}`;
}

// Same row style as Settings > Projects: a tinted row with a left stripe in the label's color
const LOCK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

function labelsUI(q = '') {
  LB = allLabels();
  const uses = g => T.filter(t => lbls(t).includes(g)).length;
  const count = g => taskCountLink(uses(g), labelLink(g), `Open tasks labelled ${g} on the Board`);
  const swatch = (g, i) => `<input type="color" class="swatch" value="${col(g)}" onchange="colL(${i},this.value)" title="Change color">`;
  const enter = `onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"`;

  // swatch · name · repeats every [n] [unit] (blank = a plain label) · usage · action
  const row = (g, i) => {
    const builtin = FREQ.some(f => f[0] == g), f = freqOf(g);
    const years = f && f.u == 'm' && f.n % 12 == 0, n = f ? (years ? f.n / 12 : f.n) : '', unit = !f ? 'w' : years ? 'y' : f.u;
    const name = builtin
      ? `<span class="lname">${esc(g)}</span>`
      : `<input class="lname" value="${esc(g)}" title="Click to rename" ${enter} onchange="renL(${i},this.value.trim())">`;
    const act = builtin
      ? `<span class="lock" title="Built-in label">${LOCK_SVG}</span>`
      : `<button class="xbtn" onclick="delL(${i})" title="Delete label" aria-label="Delete label">✕</button>`;
    const rep = `<span class="fcell${f ? ' on' : ''}" title="How often tasks with this label repeat. Leave it blank for a label that doesn't repeat.">↻
      <input type="number" class="fmon" id="fq-${i}" min="1" max="600" value="${n}" placeholder="—" aria-label="${esc(g)} repeats every how many" ${enter} onchange="setFreqOf(${i})">
      <select class="funit" id="fu-${i}" aria-label="${esc(g)} repeat unit" onchange="setFreqOf(${i})">${[['d', 'days'], ['w', 'weeks'], ['m', 'months'], ['y', 'years']]
        .map(([k, l]) => `<option value="${k}" ${k == unit ? 'selected' : ''}>${l}</option>`).join('')}</select></span>`;
    return `<div class="prow lrow${g === NEW_LABEL ? ' fresh' : ''}" style="--proj-color:${col(g)}">${swatch(g, i)}${name}${rep}${count(g)}${act}</div>`;
  };

  const all = LB.map((g, i) => [g, i]);
  const shown = all.filter(([g]) => !q || g.toLowerCase().includes(q));
  const none = q ? '<small class="note">No matching labels.</small>' : '<small class="note">No labels yet. Add one above.</small>';
  const nextColor = PAL[all.length % PAL.length];

  return `<div class="settings-section">
    <p class="note">Labels are colored tags on task cards. A label with a repeat (↻) is a frequency: it shows up in every task's <b>Repeat</b> list, and giving a task that label makes it repeat that often. Change a frequency's number to reschedule every task that uses it; clear it to make the label plain. Names like “Weekly”, “Daily” or “Every 3 weeks” get their repeat automatically.</p>
    <div class="ladd"><input type="color" class="swatch" id="nc" value="${nextColor}" title="Label color"><input id="nl" placeholder="New label name (e.g. Spring, Weekly)" onkeydown="if(event.key==='Enter')addL()"><button class="p" onclick="addL()">+ Add label</button></div>
    <div class="pgroup">Labels <small>${shown.length} · ${shown.filter(([g]) => isFreq(g)).length} repeat</small></div>
    <div class="lgrid">${shown.map(([g, i]) => row(g, i)).join('') || none}</div>
  </div>`;
}

async function addL() {
  const nlEl = $('nl'), ncEl = $('nc');
  const n = nlEl ? nlEl.value.trim() : '';
  if (!n || allLabels().includes(n)) return;
  ST.labels.push(n);
  ST.colors[n] = ncEl ? ncEl.value : '#3e9a78';
  NEW_LABEL = n;
  await saveST();
  draw();
  // bring the new row into view and let the next input start fresh
  const row = document.querySelector('.lrow.fresh');
  if (row) row.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
  const nl = $('nl');
  if (nl) nl.focus();
  setTimeout(() => { NEW_LABEL = null; }, 1500);
}

// Settings › Labels: set (or clear) how often label i repeats. Every task with that label follows
// (a task has one frequency, so any other frequency label it had is dropped); asks first if tasks change.
async function setFreqOf(i) {
  const g = LB[i], v = $('fq-' + i).value.trim(), unit = $('fu-' + i).value;
  const n = clampN(Math.round(+v || 0), 0, 600), f = n > 0 ? (unit == 'y' ? { n: n * 12, u: 'm' } : { n, u: unit }) : null;
  if (sameIv(f, freqOf(g))) return;
  const mine = T.filter(t => lbls(t).includes(g) && t.status != 'done');
  if (mine.length && !await ask({
    title: f ? 'Change how often it repeats?' : 'Stop repeating?',
    message: f
      ? `${mine.length} open task${mine.length > 1 ? 's' : ''} labelled “${g}” will repeat ${repeatName(f).toLowerCase()} (every ${f.n} ${UNIT_NAMES[f.u][f.n > 1 ? 1 : 0]}). Any other frequency label on them is removed.`
      : `${mine.length} open task${mine.length > 1 ? 's' : ''} labelled “${g}” will become one-off.`,
    ok: f ? 'Change' : 'Make one-off', icon: '↻'
  })) { draw(); return; }
  ST.freqs = ST.freqs || {};
  ST.freqs[g] = f ? { n: f.n, u: f.u } : 0;
  if (!FREQ.some(x => x[0] == g) && !(ST.labels || []).includes(g)) ST.labels.push(g);
  await saveST();
  for (const t of T) {
    if (!lbls(t).includes(g)) continue;
    const before = [t.tags, t.interval, t.interval_unit].join('|');
    t.tags = (f ? withFreq(lbls(t), g) : lbls(t)).join(',');
    syncTaskIv(t);
    if ([t.tags, t.interval, t.interval_unit].join('|') != before) await put(t, false);
  }
  draw();
}

async function colL(i, v) {
  ST.colors[LB[i]] = v;
  await saveST();
  draw();
}

async function renL(i, n) {
  const o = LB[i];
  if (!n || n == o || LB.includes(n)) { draw(); return; }
  for (const t of T) {
    if (lbls(t).includes(o)) {
      t.tags = lbls(t).map(g => g == o ? n : g).join(',');
      await put(t, false);
    }
  }
  ST.labels = Array.from(new Set([...ST.labels.filter(g => g != o), n]));
  ST.colors[n] = col(o);
  delete ST.colors[o];
  if (ST.freqs && o in ST.freqs) { ST.freqs[n] = ST.freqs[o]; delete ST.freqs[o]; }
  await saveST();
  draw();
}

async function delL(i) {
  const o = LB[i];
  const message = `“${o}” will be removed from every task that uses it.` + (isFreq(o) ? ' Those tasks will stop repeating.' : '');
  if (!await ask({ title: 'Delete label?', message, ok: 'Delete label', danger: true, icon: '🏷️' })) return;
  const freq = isFreq(o);
  for (const t of T) {
    if (lbls(t).includes(o)) {
      t.tags = lbls(t).filter(g => g != o).join(',');
      if (freq) syncTaskIv(t);
      await put(t, false);
    }
  }
  ST.labels = ST.labels.filter(g => g != o);
  delete ST.colors[o];
  if (ST.freqs) delete ST.freqs[o];
  await saveST();
  draw();
}

// Board order, grouped into one drop zone per priority and numbered.
// Drag a row to any spot: within its group to reorder, or into another group to change its priority too.
function projUI(L, q = '') {
  PJ = projs(T, true);
  const shown = q ? new Set([...projs(L), ...PJ.filter(p => p.toLowerCase().includes(q))]) : null;
  const groups = PR.map(([n, label]) => {
    const rows = PJ.map((p, i) => [p, i]).filter(([p]) => prio(p) == n && (!shown || shown.has(p)));
    const body = rows.map(([p, i]) => projRow(p, i)).join('') ||
      `<div class="pempty">${q ? 'No matching projects' : 'Drag a project here'}</div>`;
    return `<div class="pzone" data-pr="${n}" ondragover="pzOver(event,this)" ondragleave="pzLeave(event,this)" ondrop="pzDrop(event,${n})">` +
      `<div class="pgroup">${label} priority <small>${rows.length}</small></div>${body}</div>`;
  }).join('');
  return `<div class="settings-section"><p class="note">Projects appear on the Board in exactly this order. Drag a project up or down, or into another priority group. Click a name to rename it. The room sets where it shows on the Home map.</p>` +
    `<div class="plist">${groups}</div></div>`;
}

const GRIP_SVG = '<svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/><circle cx="3" cy="8" r="1.5"/><circle cx="9" cy="8" r="1.5"/><circle cx="3" cy="13" r="1.5"/><circle cx="9" cy="13" r="1.5"/></svg>';

// "3 tasks" / "1 task" linking to those tasks on the Board ("No tasks" isn't a link)
function taskCountLink(n, href, title) {
  if (!n) return '<small class="prmeta">No tasks</small>';
  return `<a class="prmeta tasklink" href="${href}" title="${esc(title)}" draggable="false">${n} task${n == 1 ? '' : 's'}</a>`;
}

function projRow(p, i) {
  const c = projCol(p), mine = T.filter(t => t.project == p);
  const open = mine.filter(t => t.status != 'done').length;
  return `<div class="prow${p === MOVED_PROJ ? ' moved' : ''}" id="prow-${i}" data-key="p:${esc(p)}" draggable="true" ondragstart="pdStart(event,${i})" ondragend="pdEnd()" style="--proj-color:${c}" title="Drag to reorder">` +
    `<span class="grip">${GRIP_SVG}</span>` +
    `<span class="prank">${i + 1}</span>` +
    `<input type="color" class="swatch" value="${c}" onchange="colProj(${i},this.value)" title="Change color">` +
    `<input class="lname prname" value="${esc(p)}" title="Click to rename" aria-label="Project name" ` +
    `onfocus="this.closest('.prow').draggable=false" onblur="this.closest('.prow').draggable=true" ` +
    `onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()};if(event.key==='Escape'){this.value=PJ[${i}];this.blur()}" onchange="renP(${i},this.value)">` +
    taskCountLink(open, projectLink(p), `Open ${p}'s tasks on the Board`) +
    `<select class="prroom" onchange="setRoom(${i},this.value)" title="Room on the Home map">${roomOpts(roomFor(p))}</select>` +
    `<button class="xbtn" onclick="delProj(${i})" title="Delete project" aria-label="Delete project">✕</button></div>`;
}

function pdStart(e, i) {
  DRAG_PROJ = i;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', PJ[i]);
  const list = document.querySelector('.plist');
  if (list) list.classList.add('dragging');
  setTimeout(() => { const el = $('prow-' + i); if (el) el.classList.add('moving'); }, 10);
}

function pdEnd() {
  DRAG_PROJ = null;
  document.querySelectorAll('.prow.moving, .prow.ins-before').forEach(el => el.classList.remove('moving', 'ins-before'));
  document.querySelectorAll('.pzone.over, .pzone.ins-end').forEach(el => el.classList.remove('over', 'ins-end'));
  const list = document.querySelector('.plist');
  if (list) list.classList.remove('dragging');
}

// While dragging: highlight the group and show a line where the project will land
function pzOver(e, zone) {
  if (DRAG_PROJ === null) return;   // ignore anything that isn't a project row
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  pzMark(zone, e.clientY);
}

// Highlight the group under the pointer and show the line where the project will land
function pzMark(zone, y) {
  document.querySelectorAll('.pzone.over').forEach(z => { if (z !== zone) z.classList.remove('over', 'ins-end'); });
  zone.classList.add('over');
  const rows = Array.from(zone.querySelectorAll('.prow')).filter(r => r.id !== 'prow-' + DRAG_PROJ);
  const next = rows.find(r => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
  DROP_BEFORE = next ? next.dataset.key.slice(2) : null;
  document.querySelectorAll('.prow.ins-before').forEach(r => { if (r !== next) r.classList.remove('ins-before'); });
  if (next) next.classList.add('ins-before');
  zone.classList.toggle('ins-end', !next && rows.length > 0);
}

function pzLeave(e, zone) {
  if (!zone.contains(e.relatedTarget)) zone.classList.remove('over', 'ins-end');
}

function pzDrop(e, n) {
  e.preventDefault();
  const i = DRAG_PROJ, before = DROP_BEFORE;
  pdEnd();
  if (i === null) return;
  moveProj(PJ[i], n, before);
}

async function colProj(i, v) {
  ST.pcolors[PJ[i]] = v;
  await saveST();
  draw();
}

// Rename a project everywhere (its tasks + its color, priority, room and order) in one server call
async function renP(i, value) {
  const old = PJ[i], name = value.trim().replace(/\s+/g, ' ');
  if (!name || name === old) { draw(); return; }
  const clash = allProjectNames().find(p => p !== old && p.toLowerCase() === name.toLowerCase());
  if (clash) {
    await ask({ title: 'Project already exists', message: `“${clash}” is already a project. Pick a different name.`, ok: 'OK', info: true, icon: '📁' });
    draw();
    return;
  }
  const r = await api('/api/projects/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old, new: name }) });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    await ask({ title: 'Couldn’t rename project', message: body.error || 'Nothing was changed. Please try again.', ok: 'OK', info: true });
  }
  MOVED_PROJ = r.ok ? name : null;              // brief glow on the renamed row
  setTimeout(() => { MOVED_PROJ = null; }, 1500);
  await load();
  draw();
}

async function setRoom(i, r) {
  ST.rooms = ST.rooms || {};
  ST.rooms[PJ[i]] = r;
  await saveST();
}

// Put project p into priority group n, in front of `before` (or at the end of the group)
function moveProj(p, n, before) {
  const was = PJ.join('\n') + prio(p);
  const order = PJ.filter(x => x !== p);
  ST.projects[p] = n;
  let at = before ? order.indexOf(before) : -1;
  if (at < 0) {
    at = order.findIndex(x => prio(x) > n);
    if (at < 0) at = order.length;
  }
  order.splice(at, 0, p);
  if (order.join('\n') + n === was) return;    // dropped where it already was
  ST.porder = order;
  MOVED_PROJ = p;
  const prev = snapshot('.prow');
  draw();                       // optimistic: the row glides into its new spot
  flip(prev, '.prow');
  saveST();
  setTimeout(() => { MOVED_PROJ = null; }, 1500);
}

/* ---- settings: miscellaneous ---- */
function miscUI() {
  const nT = T.length, nP = projs(T, true).length, w = dueWarn();
  const user = document.body.dataset.user || '';
  const row = (title, note, actions, cls = '') =>
    `<div class="mrow${cls}"><div><b>${title}</b><p class="note">${note}</p></div><div class="mact">${actions}</div></div>`;
  const num = (key, v, min, max) =>
    `<input type="number" class="num" min="${min}" max="${max}" value="${v}" onchange="setNum('${key}',this,${min},${max})">`;

  return `<div class="settings-section">
    <div class="pgroup">Account</div>
    ${row(`Signed in as ${esc(user)}`, 'You stay signed in for two weeks on each device. Sign out on devices other people use.',
      `<a class="btn" href="/password/">Change password</a>
       <form method="post" action="/logout/"><input type="hidden" name="csrfmiddlewaretoken" value="${esc(csrfToken())}"><button type="submit">Sign out</button></form>`)}

    <div class="pgroup">Recurring tasks</div>
    ${row('When the next copy appears', 'After you finish a recurring task, its next ToDo card is added this many days before it is due.',
      `${num('spawnDays', spawnDays(), 0, 90)}<span>days before</span>`)}

    <div class="pgroup">Due date colors</div>
    ${row('Card warning colors', 'Cards that are due today or overdue are always red.',
      `<span class="dot dy"></span>${num('dueYellow', w.y, 1, 90)}<span>days</span><span class="dot do"></span>${num('dueOrange', w.o, 1, 90)}<span>days</span>`)}

    <div class="pgroup">Backup &amp; restore</div>
    ${row('Download a backup', 'One file with every task (including completed history) and all settings. Keep a copy before big changes.',
      '<a class="btn" href="/api/backup">Download backup</a>')}
    ${row('Restore from a backup', 'Replaces all tasks and settings with the contents of a backup file.',
      `<button onclick="$('rf').click()">Restore…</button><input type="file" id="rf" accept=".json,application/json" hidden onchange="restoreBackup(this)">`)}

    <div class="pgroup">Completed history</div>
    ${row('Clear old history', `Deletes completed tasks finished before the cutoff. Recurring tasks keep repeating, and Stats only count what's left. <span id="hn">${histNote(365)}</span>`,
      `<select id="hd" onchange="$('hn').textContent = histNote(+this.value)">
         <option value="182">Older than 6 months</option><option value="365" selected>Older than 1 year</option><option value="730">Older than 2 years</option>
       </select><button onclick="clearHistory()">Clear history</button>`)}

    <div class="pgroup">Danger zone</div>
    ${row('Delete all tasks and projects',
      `Removes ${nT} task${nT == 1 ? '' : 's'} (including completed history, so Stats start over) and ${nP} project${nP == 1 ? '' : 's'}. Labels and their colors are kept. This can't be undone, so download a backup first.`,
      `<button class="red" onclick="resetAll()" ${nT || nP ? '' : 'disabled'}>Delete everything</button>`, ' danger-row')}
  </div>`;
}

// Completed tasks the server would clear: finished before the cutoff, and not a recurring
// task still waiting to create its next copy (same rule as views.clear_history)
function oldHistory(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const cutoff = d.toLocaleDateString('en-CA');
  return T.filter(t => t.status == 'done' && t.done_at && t.done_at < cutoff && (!t.interval || t.spawned));
}

function histNote(days) {
  const n = oldHistory(days).length;
  return n ? `${n} task${n == 1 ? '' : 's'} would be cleared.` : 'Nothing that old right now.';
}

async function clearHistory() {
  const days = +$('hd').value, n = oldHistory(days).length;
  if (!n) {
    await ask({ title: 'Nothing to clear', message: 'No completed tasks are older than that.', ok: 'OK', info: true, icon: '✅' });
    return;
  }
  const label = $('hd').selectedOptions[0].textContent.toLowerCase();
  if (!await ask({ title: 'Clear old history?', message: `${n} completed task${n == 1 ? '' : 's'} ${label} will be permanently deleted. Stats will no longer count them.`, ok: 'Clear history', danger: true, icon: '🧹' })) return;
  const r = await api('/api/history/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) });
  const body = await r.json().catch(() => ({}));
  await ask(r.ok
    ? { title: 'History cleared', message: `${body.deleted} completed task${body.deleted == 1 ? '' : 's'} removed.`, ok: 'OK', info: true, icon: '✅' }
    : { title: 'Couldn’t clear history', message: 'Nothing was deleted. Please try again.', ok: 'OK', info: true });
  load();
}

// Number settings: clamp, keep orange <= yellow, save, then reload (the server uses spawnDays)
async function setNum(key, el, min, max) {
  let v = Math.round(+el.value);
  if (!Number.isFinite(v)) v = min;
  v = Math.min(max, Math.max(min, v));
  ST[key] = v;
  const w = dueWarn();
  if (w.o > w.y) { if (key === 'dueOrange') ST.dueYellow = w.o; else ST.dueOrange = w.y; }
  await saveST();
  load();
  draw();
}

async function restoreBackup(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  const ok = await ask({
    title: 'Restore this backup?',
    message: `Everything currently in the app will be replaced with the contents of “${file.name}”. This can't be undone.`,
    ok: 'Replace everything', danger: true, icon: '♻️'
  });
  if (!ok) return;
  const fd = new FormData();
  fd.append('file', file);
  const r = await api('/api/restore', { method: 'POST', body: fd });
  const body = await r.json().catch(() => ({}));
  await ask(r.ok
    ? { title: 'Backup restored', message: `${body.restored} tasks and all settings were restored.`, ok: 'OK', info: true, icon: '✅' }
    : { title: 'Restore failed', message: body.error || 'Nothing was changed.', ok: 'OK', info: true });
  load();
}

async function resetAll() {
  const nT = T.length, nP = projs(T, true).length;
  const ok = await ask({
    title: 'Delete all tasks and projects?',
    message: `All ${nT} tasks and ${nP} projects will be permanently deleted, including completed history. Labels are kept. This can't be undone.`,
    ok: 'Delete everything', danger: true, icon: '🧹'
  });
  if (!ok) return;
  const r = await api('/api/reset', { method: 'DELETE' });
  await ask(r.ok
    ? { title: 'All clear', message: 'Every task and project was removed. Click “New” or “Import” to start again.', ok: 'OK', info: true, icon: '✅' }
    : { title: 'Delete failed', message: 'Nothing was deleted. Please try again.', ok: 'OK', info: true });
  load();
}

// Repeat dropdown: every frequency label
function fsel(t) {
  return `<select onchange="setFreq(${t.id},this.value)">${freqOptionsHTML(t)}</select>`;
}

function setFreq(id, g) {
  const t = T.find(x => x.id == id);
  if (g == '__custom') return;
  t.tags = withFreq(lbls(t), g).join(',');
  syncTaskIv(t);
  put(t, false);
}

function fld(id, k, v) {
  const t = T.find(x => x.id == id);
  t[k] = v;
  put(t, false);
}

// Board project buttons: the same stroke icons as the top bar
const PLUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>';
const PENCIL_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

function taskRoomOpts(t) {
  const [, n, e] = roomInfo(roomFor(t.project));
  return `<option value="">Project's (${e} ${esc(n)})</option>` + roomOpts(isRoom(t.room) ? t.room : null);
}

function sched(L) {
  const sections = projs(L).map(p => {
    const pColor = projCol(p);
    const taskRows = L.filter(t => t.project == p).sort(byPr).map(t =>
      `<tr><td class="tcell-title"><input value="${esc(t.title)}" aria-label="Task name" onchange="fld(${t.id},'title',this.value)"></td>
       <td data-label="Priority"><select aria-label="Priority" onchange="fld(${t.id},'priority',+this.value)">${popts(t.priority)}</select></td>
       <td data-label="Repeat">${fsel(t)}</td>
       <td data-label="Room"><select aria-label="Room" onchange="fld(${t.id},'room',this.value)">${taskRoomOpts(t)}</select></td>
       <td class="tcell-edit"><button class="ebtn" onclick="edit(${t.id})" aria-label="Edit task" title="Edit task">${PENCIL_SVG}</button></td></tr>`
    ).join('');

    return `<section class="pj" style="--proj-color:${pColor};"><div class="proj"><span class="pname">${esc(p)}</span></div><table class="tasktable"><tr><th style="width:38%">Task</th><th>Priority</th><th>Repeat</th><th>Room</th><th></th></tr>${taskRows}</table></section>`;
  }).join('');

  return `<div class="settings-section">${sections || '<small>No tasks yet.</small>'}</div>`;
}

/* ---- stats ---- */
// Stats follow the header filter, e.g. "Plumbing" shows stats for Plumbing tasks only
function stats(L = T, q = '') {
  const D = L.filter(t => t.done_at), now = new Date(), f = d => d.toLocaleDateString('en-CA');
  const cnt = (a, fn) => a.reduce((m, t) => { const k = fn(t); m[k] = (m[k] || 0) + 1; return m; }, {});
  const best = m => Object.entries(m).sort((a, b) => b[1] - a[1])[0] || ['–', 0];
  const wk = s => { const d = new Date(s + 'T00:00'); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return f(d); };
  const mo = cnt(D, t => t.done_at.slice(0, 7)), we = cnt(D, t => wk(t.done_at)), pr = cnt(D, t => t.project), td = f(now);
  const first = D.map(t => t.done_at).sort()[0] || td;
  const months = (now.getFullYear() - +first.slice(0, 4)) * 12 + now.getMonth() - (+first.slice(5, 7) - 1) + 1;
  const bm = best(mo), bw = best(we), open = L.filter(t => t.status != 'done');
  const mname = k => k == '–' ? k : new Date(k + '-01T00:00').toLocaleString('default', { month: 'long', year: 'numeric' });

  const twelveMonths = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = f(d).slice(0, 7);
    twelveMonths.push({ key, label: d.toLocaleString('default', { month: 'short' }), full: d.toLocaleString('default', { month: 'long', year: 'numeric' }), count: mo[key] || 0 });
  }
  const max12 = Math.max(...twelveMonths.map(x => x.count), 1);

  const box = (n, v, s = '') => `<div class="stats-card"><small>${n}</small><div class="big">${v}</div><small>${s}</small></div>`;
  const top = Object.entries(pr).sort((a, b) => b[1] - a[1]).slice(0, 8), mx = top[0] ? top[0][1] : 1;

  const m = $('m');
  if (m) {
    const trendHTML = twelveMonths.map(tm =>
      `<div class="tcol" title="${tm.full}: ${tm.count}"><small>${tm.count}</small><div class="bar" style="width:100%;height:${Math.max((tm.count / max12) * 100, 4)}px;"></div><small class="tlab">${tm.label}</small></div>`
    ).join('');

    const completedByProjHTML = top.map(([p, n]) =>
      `<div style="margin-bottom:8px;">${esc(p)} <small style="float:right;">${n}</small><div class="bar" style="width:${n / mx * 100}%;background:${projCol(p)};"></div></div>`
    ).join('') || '<small>Nothing completed yet.</small>';

    const recentCompletionsHTML = D.sort((a, b) => b.done_at.localeCompare(a.done_at)).slice(0, 10).map(t =>
      `<div class="ci"><span>${esc(t.title)} <i>· ${esc(t.project)} · ${t.done_at}</i></span></div>`
    ).join('') || '<small>Nothing completed yet.</small>';

    const filterNote = q ? `<p class="fnote">Showing stats for tasks matching “${esc(q)}”.</p>` : '';
    m.innerHTML = filterNote + '<div class="stats">' + box('Total completed', D.length) + box('This week', we[wk(td)] || 0) + box('This month', mo[td.slice(0, 7)] || 0) +
      box('This year', D.filter(t => t.done_at.slice(0, 4) == td.slice(0, 4)).length) + box('Average per month', (D.length / months).toFixed(1)) +
      box('Record month', bm[1], mname(bm[0])) + box('Record week', bw[1], bw[0] == '–' ? '' : 'week of ' + bw[0]) +
      box('Open tasks', open.length, open.filter(t => t.due < td).length + ' overdue') + '</div>' +

      `<div class="stats-card" style="margin-top:20px"><h3>12-Month Completion Trend</h3><div class="trend">${trendHTML}</div></div>` +
      `<div class="stats" style="margin-top:16px"><div class="stats-card"><h3>Completed by project</h3>${completedByProjHTML}</div>` +
      `<div class="stats-card"><h3>Recent completions</h3>${recentCompletionsHTML}</div></div>`;
  }
}

/* ---- form ---- */
let LB_FOCUS = 0;     // which label chip holds the group's single Tab stop

function lbl(focusAfter = false) {
  LB = allLabels();
  const lbEl = $('lb');
  if (lbEl) {
    LB_FOCUS = Math.min(LB_FOCUS, Math.max(LB.length - 1, 0));
    lbEl.innerHTML = LB.map((g, i) => chip(g,
      `role="checkbox" aria-checked="${SEL.has(g)}" tabindex="${i == LB_FOCUS ? 0 : -1}" data-i="${i}" onclick="LB_FOCUS=${i};togL(${i}, true)"`,
      `cursor:pointer;opacity:${SEL.has(g) ? 1 : .35};`)).join('') || '<small>No labels yet</small>';
    if (focusAfter) lbFocus(LB_FOCUS);
  }
}

function lbFocus(i) {
  const chips = $('lb').querySelectorAll('[data-i]');
  if (!chips.length) return;
  LB_FOCUS = (i + chips.length) % chips.length;
  chips.forEach(c => { c.tabIndex = +c.dataset.i === LB_FOCUS ? 0 : -1; });
  chips[LB_FOCUS].focus();
}

// Keyboard for the label chips: arrows move, Home/End jump, Space or Enter toggles
function lbKey(e) {
  const i = +(e.target.dataset && e.target.dataset.i);
  if (Number.isNaN(i)) return;
  const moves = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (e.key in moves) { e.preventDefault(); lbFocus(i + moves[e.key]); }
  else if (e.key === 'Home') { e.preventDefault(); lbFocus(0); }
  else if (e.key === 'End') { e.preventDefault(); lbFocus(-1); }
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); LB_FOCUS = i; togL(i, true); }
}

function togL(i, keepFocus = false) {
  const g = LB[i];
  if (SEL.has(g)) SEL.delete(g);
  else SEL = new Set(isFreq(g) ? withFreq(Array.from(SEL), g) : [...SEL, g]);   // one frequency label per task
  lbl(keepFocus);
}

// "What am I creating?" toggle: Task or Project
function setMode(m) {
  MODE = m;
  $('mt').classList.toggle('on', m === 'task');
  $('mp').classList.toggle('on', m === 'project');
  $('tf').hidden = m !== 'task';
  $('pf').hidden = m !== 'project';
  $('dt').textContent = cur ? 'Edit task' : (m === 'task' ? 'New task' : 'New project');
  $('x').style.display = (cur && m === 'task') ? '' : 'none';
}

// The task's repeat comes from its frequency label (set up in Settings › Labels). An edited task whose repeat
// has no label (FORM_IV) keeps it until a frequency label is picked.
let FORM_IV = null;
function formIv() {
  const g = Array.from(SEL).find(isFreq);
  return g ? freqOf(g) : FORM_IV;
}

/* ---- themed date picker (replaces the browser's default calendar) ---- */
let DPV = { y: 0, m: 0 };

function setDue(iso) {
  const u = $('u');
  u.dataset.iso = iso;
  u.value = fmtDate(iso);
}

function toggleDP(focusDay = false) {
  const dp = $('dp');
  if (!dp.hidden) { dp.hidden = true; return; }
  const iso = $('u').dataset.iso || today();
  const d = new Date(iso + 'T00:00');
  DPV = { y: d.getFullYear(), m: d.getMonth() };
  renderDP(iso);
  dp.hidden = false;
  if (focusDay) dpFocus(iso);
}

// Keyboard on the due-date field: Enter, Space or ↓ opens the calendar
function dueKey(e) {
  if (['Enter', ' ', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    if ($('dp').hidden) toggleDP(true); else dpFocus($('u').dataset.iso || today());
  }
}

const isoAdd = (iso, days) => { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + days); return d.toLocaleDateString('en-CA'); };
const isoAddM = (iso, n) => addM(new Date(iso + 'T00:00'), n).toLocaleDateString('en-CA');

// Move keyboard focus to a day, switching months when needed
function dpFocus(iso) {
  const d = new Date(iso + 'T00:00');
  if (d.getFullYear() !== DPV.y || d.getMonth() !== DPV.m) {
    DPV = { y: d.getFullYear(), m: d.getMonth() };
  }
  renderDP(iso);
  const btn = $('dp').querySelector(`[data-iso="${iso}"]`);
  if (btn) btn.focus();
}

// Calendar keys: arrows = day / week, PageUp/PageDown = month, Esc = close (back to the field)
function dpKey(e) {
  const iso = e.target.dataset && e.target.dataset.iso;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('dp').hidden = true; $('u').focus(); return; }
  if (!iso) return;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  if (step) { e.preventDefault(); dpFocus(isoAdd(iso, step)); }
  else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); dpFocus(isoAddM(iso, e.key === 'PageUp' ? -1 : 1)); }
  else if (e.key === 'Enter') { e.stopPropagation(); }   // let the button pick the day; don't jump to the next field
}

function dpNav(n) {
  const d = new Date(DPV.y, DPV.m + n, 1);
  DPV = { y: d.getFullYear(), m: d.getMonth() };
  renderDP();
}

function dpPick(iso) {
  setDue(iso);
  $('dp').hidden = true;
  $('u').focus();
}

// focusIso: the one day button that is in the Tab order (selected day, else today)
function renderDP(focusIso) {
  const { y, m } = DPV;
  const lead = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const sel = $('u').dataset.iso, td = today();
  const pad = n => String(n).padStart(2, '0');

  let h = `<div class="dph"><button type="button" onclick="dpNav(-1)">‹</button><b>${new Date(y, m, 1).toLocaleString('default', { month: 'long', year: 'numeric' })}</b><button type="button" onclick="dpNav(1)">›</button></div><div class="dpg">`;
  h += ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(x => `<span class="dpl">${x}</span>`).join('');
  for (let i = 0; i < lead; i++) h += '<span></span>';
  for (let d = 1; d <= days; d++) {
    const iso = `${y}-${pad(m + 1)}-${pad(d)}`;
    const stop = iso == (focusIso || sel || td);
    h += `<button type="button" class="dpd${iso == sel ? ' sel' : ''}${iso == td ? ' today' : ''}" data-iso="${iso}" tabindex="${stop ? 0 : -1}" aria-label="${fmtDate(iso)}" onclick="dpPick('${iso}')">${d}</button>`;
  }
  h += `</div><div class="dpf"><button type="button" onclick="dpPick('${td}')">Today</button><button type="button" onclick="$('dp').hidden=true;$('u').focus()">Close</button></div>`;
  $('dp').innerHTML = h;
}

/* ---- quick entry: new tasks/projects start from the choices of the last one you created (for as long
   as this browser tab is open), "Save & add another" keeps the form open, and after that Tab on the
   title jumps straight to that button: type, Tab, Enter, repeat. ---- */
let QUICK = false;              // true after "Save & add another" until the form closes
let ADDED = 0;                  // how many were added in this run of the form
let SAVING = false;             // a save from the form is on its way: extra taps are ignored
let SAVE_KEY = newSaveKey();    // sent with each new task; a retry of the same save reuses it, so the server won't add it twice

function newSaveKey() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);   // crypto.randomUUID needs HTTPS
}

// Show that the form is saving: the tapped button says "Saving…" and every form button waits
function formBusy(on, btn) {
  document.querySelectorAll('#d .formbtns button').forEach(b => {
    b.disabled = on;
    if (on && b === btn) { b.dataset.label = b.textContent; b.textContent = 'Saving…'; b.classList.add('busy'); }
    else if (!on && b.dataset.label) { b.textContent = b.dataset.label; delete b.dataset.label; b.classList.remove('busy'); }
  });
  $('d').setAttribute('aria-busy', on);
}

async function cantReach() {
  await ask({ title: 'No answer from the server', message: 'The save didn’t get through in time. Check the Wi-Fi connection and try again; it won’t be added twice.', ok: 'OK', info: true, icon: '📶' });
}

function lastChoices(kind) {
  try { return JSON.parse(sessionStorage.getItem('last-' + kind) || 'null'); } catch (e) { return null; }
}

function rememberChoices(kind, v) {
  try { sessionStorage.setItem('last-' + kind, JSON.stringify(v)); } catch (e) { /* private browsing */ }
}

// A colour for a new project: a random palette colour no project uses yet, else any random colour
function randomProjColor() {
  const used = new Set(Object.values(ST.pcolors || {}).map(c => c.toLowerCase()));
  const free = PROJ_PAL.filter(c => !used.has(c.toLowerCase()));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  const h = Math.floor(Math.random() * 360), sat = 0.55, l = 0.55;
  const f = n => { const k = (n + h / 30) % 12, a = sat * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function edit(id, proj) {
  cur = id || 0;
  QUICK = false;
  ADDED = 0;
  SAVE_KEY = newSaveKey();
  $('qa-msg').hidden = true;
  // a new task starts from the last one created (title, link and notes always start empty)
  const last = lastChoices('task') || {};
  const lastProject = allProjectNames().includes(last.project) ? last.project : '';
  const t = T.find(x => x.id == id) || {
    project: proj || lastProject || '', title: '', status: last.status || 'backlog', tags: last.tags || '',
    due: last.due || today(), interval: last.interval || 0, interval_unit: last.interval_unit || 'm', url: '', notes: '', priority: last.priority || 3,
    room: proj && proj !== last.project ? '' : (last.room || '')
  };

  // task form: project is picked from existing projects
  const names = allProjectNames();
  const opts = names.length ? names.slice() : ['General'];
  if (t.project && !opts.includes(t.project)) opts.push(t.project);
  const pSel = $('p');
  pSel.innerHTML = opts.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  pSel.value = t.project || opts[0];
  fillTaskRoom(t.room || '');

  $('tp').value = t.priority;
  $('t').value = t.title;
  $('s').value = t.status;
  setDue(t.due);
  $('dp').hidden = true;
  FORM_IV = cur && !lbls(t).some(isFreq) ? ivOfTask(t) : null;
  $('l').value = t.url;
  $('n').value = t.notes;
  SEL = new Set(lbls(t));
  lbl();

  // project form: last project's priority and room, a fresh random colour
  const lp = lastChoices('project') || {};
  $('pn').value = '';
  $('pp').value = lp.priority || 3;
  $('pc').value = randomProjColor();
  const pr = $('pr');
  pr.innerHTML = roomOpts(isRoom(lp.room) ? lp.room : 'house');
  delete pr.dataset.touched;
  if (lp.room) pr.dataset.touched = '1';           // keep the remembered room instead of guessing from the name
  pr.onchange = () => { pr.dataset.touched = '1'; };
  $('pn').oninput = () => { if (!pr.dataset.touched) pr.value = guessRoom($('pn').value); };

  $('modewrap').hidden = !!cur;                       // can't switch type when editing a task
  $('addmore').hidden = !!cur;                        // "Save & add another" is for new items only
  setMode(cur || names.length ? 'task' : 'project');  // no projects yet -> start with "Project"

  const dEl = $('d');
  if (dEl && typeof dEl.showModal === 'function') dEl.showModal();
  // new item: straight to its name. Focusing inside the click (no await before it) is what lets phones open the keyboard.
  if (!cur) focusName();
}

function focusName() {
  const el = $(MODE === 'project' ? 'pn' : 't');
  el.focus({ preventScroll: true });
  el.select();
  keepInView(el);
}

/* Phones: the open keyboard covers the bottom of the screen. The dialog is pinned to the part that's still
   visible (--vvt/--vvh from visualViewport), and the field being typed in is scrolled into view inside it. */
if (window.visualViewport) {
  const vv = visualViewport, root = document.documentElement.style;
  const fit = () => { root.setProperty('--vvh', vv.height + 'px'); root.setProperty('--vvt', vv.offsetTop + 'px'); };
  vv.addEventListener('resize', () => { fit(); const a = document.activeElement; if (a && a.closest && a.closest('dialog')) keepInView(a); });
  vv.addEventListener('scroll', fit);
  fit();
}
function keepInView(el) {
  const d = el.closest('dialog');
  if (!d) return;
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect(), b = d.getBoundingClientRect();
    const label = el.previousElementSibling && el.previousElementSibling.tagName === 'LABEL' ? el.previousElementSibling.getBoundingClientRect().height + 6 : 0;
    const bottomBar = (d.querySelector('.formbtns') || { offsetHeight: 0 }).offsetHeight;
    if (r.top - label < b.top) d.scrollTop -= b.top - (r.top - label) + 8;
    else if (r.bottom > b.bottom - bottomBar) d.scrollTop += r.bottom - (b.bottom - bottomBar) + 8;
  });
}
document.addEventListener('focusin', e => { if (e.target.matches && e.target.matches('dialog input:not([type=color]), dialog textarea')) keepInView(e.target); });

// Room picker in the task form: "same as project" (shows which room that is) or a specific room
function fillTaskRoom(sel) {
  const el = $('tr');
  const keep = sel !== undefined ? sel : el.value;
  const [, n, e] = roomInfo(roomFor($('p').value));
  el.innerHTML = `<option value="">Same as project (${e} ${esc(n)})</option>` + roomOpts(null);
  el.value = isRoom(keep) ? keep : '';
}

// After "Save & add another": say what was added, clear what's specific to that item, back to the title
function readyForNext(what) {
  ADDED++;
  QUICK = true;
  const msg = $('qa-msg');
  msg.textContent = `Added “${what}”${ADDED > 1 ? ` (${ADDED} so far)` : ''}. Ready for the next one.`;
  msg.hidden = false;
  if (MODE === 'project') {
    $('pn').value = '';
    $('pc').value = randomProjColor();
    $('pn').focus();
  } else {
    $('t').value = '';
    $('l').value = '';
    $('n').value = '';
    $('t').focus();
  }
}

function saveAndNew() {
  return sv(true);
}

// Saves from the form run one at a time: on a slow phone connection, tapping Save again does nothing
// until the first save has answered (it used to send the task again and get "already exists")
async function sv(another = false) {
  if (SAVING) return;
  const btn = another ? $('addmore') : document.querySelector('#d .formbtns .p');
  SAVING = true;
  formBusy(true, btn);
  if (document.activeElement && $('d').contains(document.activeElement)) document.activeElement.blur();   // closes the phone keyboard
  try {
    await (MODE === 'project' ? svProject(another) : svTask(another));
  } catch (err) {
    if (err.name === 'AbortError' || err instanceof TypeError) await cantReach();   // timed out, or no network
    else if (err.message !== 'Signed out' && err.message !== 'CSRF token expired') {
      console.error(err);
      await ask({ title: 'Couldn’t save', message: err.message, ok: 'OK', info: true });
    }
  } finally {
    SAVING = false;
    formBusy(false);
  }
}

async function svTask(another) {
  const titleEl = $('t');
  if (!titleEl || !titleEl.value.trim()) { if (titleEl) titleEl.focus(); return; }
  const iv = formIv();
  const t = {
    project: $('p').value || 'General',
    title: titleEl.value.trim(),
    status: $('s').value,
    tags: Array.from(SEL).join(','),
    due: $('u').dataset.iso || today(),
    interval: iv ? iv.n : 0,
    interval_unit: iv ? iv.u : 'm',
    room: $('tr').value,
    url: $('l').value,
    notes: $('n').value,
    priority: +$('tp').value
  };
  if (!cur) t.save_key = SAVE_KEY;

  // completing from the form also gets the "landed" glow
  const before = T.find(x => x.id == cur);
  if (cur && t.status == 'done' && before && before.status != 'done') {
    const id = cur;
    JUST_DONE.add(id);
    setTimeout(() => JUST_DONE.delete(id), 1500);
  }

  const res = await api(cur ? '/api/tasks/' + cur : '/api/tasks/new', {
    method: cur ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
    timeout: 15000
  });
  if (res.status === 409) {        // same title already open in this project: keep the form open to fix it
    JUST_DONE.delete(cur);
    await dupNotice(res);
    titleEl.focus();
    return;
  }
  if (!res.ok) { await ask({ title: 'Couldn’t save', message: (await res.text()).slice(0, 200) || `The server answered ${res.status}.`, ok: 'OK', info: true }); return; }
  SAVE_KEY = newSaveKey();         // saved: the next task is a new one
  if (!cur) setPjOpen(t.project, true);   // the new card is on show, even in a collapsed project
  if (!cur) rememberChoices('task', { project: t.project, room: t.room, priority: t.priority, status: t.status,
                                      tags: t.tags, due: t.due, interval: t.interval, interval_unit: t.interval_unit });
  load();
  if (another && !cur) readyForNext(t.title);
  else $('d').close();
}

async function svProject(another) {
  const name = $('pn').value.trim().replace(/\s+/g, ' ');
  if (!name) { $('pn').focus(); return; }
  const existing = allProjectNames().find(p => p.toLowerCase() === name.toLowerCase());
  if (existing) {
    await ask({ title: 'Project already exists', message: `“${existing}” is already a project. Choose a different name, or use “+ Task” on its board panel to add to it.`, ok: 'OK', info: true, icon: '📁' });
    $('pn').focus();
    return;
  }
  const was = clone(ST);           // put settings back if the save doesn't get through, so trying again works
  if (!ST.projectNames) ST.projectNames = [];
  if (!ST.projectNames.includes(name)) ST.projectNames.push(name);
  ST.projects[name] = +$('pp').value;
  ST.pcolors[name] = $('pc').value;
  ST.rooms = ST.rooms || {};
  ST.rooms[name] = $('pr').value;
  try {
    const res = await saveST(15000);
    if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  } catch (err) {
    ST = was;
    throw err;
  }
  rememberChoices('project', { priority: +$('pp').value, room: $('pr').value });
  draw();
  if (another) readyForNext(name);
  else $('d').close();
}

async function rm() {
  if (await ask({ title: 'Delete task?', message: 'This task will be permanently deleted.', ok: 'Delete task', danger: true, icon: '🗑️' })) {
    await api('/api/tasks/' + cur + '/del', { method: 'DELETE' });
    const dEl = $('d');
    if (dEl) dEl.close();
    load();
  }
}

/* ---- CSV import wizard: 1 Review → 2 Fix → 3 Done.
   The server reads the file and lists what's missing (nothing is saved); you fix rows one at a time
   or many at once, then the reviewed rows are imported. ---- */
let IW = null;     // { file, rows, missing, step, show: 'attention'|'all', visible: [line…], sel: Set(line) }

const FIELD_NAMES = { title: 'task name', project: 'area / project', room: 'room', interval: 'repeat', due: 'due date' };

async function imp() {
  const fEl = $('f');
  if (!fEl || !fEl.files[0]) return;
  const file = fEl.files[0];
  fEl.value = '';
  const fd = new FormData();
  fd.append('file', file);
  const r = await api('/api/import/preview', { method: 'POST', body: fd });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    await ask({ title: 'Can’t read this file', message: body.error || 'Check that it’s a CSV file and try again.', ok: 'OK', info: true });
    return;
  }
  if (!body.rows.length) {
    await ask({ title: 'No tasks in this file', message: 'The file has headers but no rows to import.', ok: 'OK', info: true });
    return;
  }
  IW = {
    file: body.file, missing: body.columns_missing, step: 1, show: 'attention', sel: new Set(),
    rows: body.rows.map(row => ({ ...row, fixed: new Set(), include: !row.duplicate }))
  };
  setShow(rowsNeeding().length ? 'attention' : 'all');
  renderIW();
  $('iw').showModal();
}

// What a row still needs, given its current values. Errors block that row; warnings import with the default shown.
function rowProblems(r) {
  const out = [];
  if (!r.title.trim()) out.push({ field: 'title', level: 'error', msg: 'Add a task name' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.due || '')) out.push({ field: 'due', level: 'error', msg: 'Pick a due date' });
  for (const i of r.issues) {
    if (i.level == 'warn' && !r.fixed.has(i.field) && !out.some(o => o.field == i.field)) out.push(i);
  }
  return out;
}

function rowState(r) {
  if (r.duplicate) return 'dup';
  if (!r.include) return 'skip';
  const p = rowProblems(r);
  return p.some(i => i.level == 'error') ? 'error' : p.length ? 'warn' : 'ok';
}

const rowsNeeding = () => IW.rows.filter(r => ['error', 'warn'].includes(rowState(r)));
const importable = () => IW.rows.filter(r => ['ok', 'warn'].includes(rowState(r)));

// Which rows step 2 lists; fixed rows stay put until the filter changes, so nothing jumps while you type
function setShow(show) {
  IW.show = show;
  IW.visible = (show == 'attention' ? rowsNeeding() : IW.rows.filter(r => !r.duplicate)).map(r => r.line);
  IW.sel = new Set(Array.from(IW.sel).filter(l => IW.visible.includes(l)));
}

function iwRow(line) {
  return IW.rows.find(r => r.line == line);
}

function renderIW() {
  const body = $('iw-body');
  if (!body || !IW) return;
  const steps = ['Review', 'Fix', 'Import'].map((n, i) =>
    `<li class="${IW.step == i + 1 ? 'on' : IW.step > i + 1 ? 'done' : ''}"><span>${i + 1}</span>${n}</li>`).join('');
  const main = IW.step == 1 ? iwReview() : IW.step == 2 ? iwFix() : iwDone();
  body.innerHTML = `<header class="wiz-head">
      <ol class="wiz-steps" aria-label="Import steps">${steps}</ol>
      <h2 id="iw-title">Import “${esc(IW.file)}”</h2>
      <button type="button" class="wiz-x xbtn" onclick="closeIW()" aria-label="Close">✕</button>
    </header>
    <div class="wiz-main">${main}</div>
    <footer class="wiz-foot">${iwFooter()}</footer>`;
}

function iwReview() {
  const count = st => IW.rows.filter(r => rowState(r) == st).length;
  const tile = (st, n, label, note) =>
    `<div class="wtile ${st}"><b>${n}</b><span>${label}</span><small>${note}</small></div>`;

  // group what's missing by field, e.g. "31 rows: no due date, so it's due today"
  const groups = {};
  IW.rows.filter(r => !r.duplicate).forEach(r => rowProblems(r).forEach(i => {
    const k = i.field + i.level;
    groups[k] = groups[k] || { ...i, n: 0 };
    groups[k].n++;
  }));
  const list = Object.values(groups).sort((a, b) => (a.level == 'error' ? -1 : 1) - (b.level == 'error' ? -1 : 1) || b.n - a.n)
    .map(g => {
      const one = g.n == 1, what = FIELD_NAMES[g.field] || g.field;
      const verb = g.level == 'error' ? `${one ? 'needs' : 'need'} a ${what}` : `${one ? 'has' : 'have'} no ${what}`;
      return `<li class="${g.level}"><b>${g.n} row${one ? '' : 's'}</b> ${verb}<small>${esc(g.msg)}</small></li>`;
    }).join('');
  const optional = IW.missing.filter(c => c != 'Task');
  const cols = IW.missing.includes('Task')
    ? '<p class="wnote error">This file has no <b>Task</b> column, so every row needs a name. Add them in the next step, or fix the file and import it again.</p>'
    : optional.length
      ? `<p class="wnote">Not in this file: ${optional.map(c => `<b>${esc(c)}</b>`).join(', ')}. That’s fine. Only <b>Task</b> is required, and you can fill in anything else in the next step.</p>`
      : '';

  return `<div class="wtiles">
      ${tile('ok', count('ok'), 'Ready', 'Nothing missing')}
      ${tile('warn', count('warn'), 'Use a default', 'Imports as shown unless you change it')}
      ${tile('error', count('error'), 'Need a fix', 'Skipped unless fixed')}
      ${tile('dup', count('dup'), 'Already in the app', 'Skipped, same task name')}
    </div>
    ${cols}
    ${list ? `<h3 class="wsub">What’s missing</h3><ul class="wmissing">${list}</ul>` : '<p class="wnote ok">Every row has what it needs.</p>'}`;
}

function iwFix() {
  const rows = IW.visible.map(iwRow);
  const projects = Array.from(new Set([...allProjectNames(), ...IW.rows.map(r => r.project).filter(Boolean)])).sort();
  const n = rowsNeeding().length, all = IW.rows.filter(r => !r.duplicate).length;
  const allSel = rows.length && rows.every(r => IW.sel.has(r.line));

  const bulk = `<div class="wbulk">
      <label class="wcheck"><input type="checkbox" ${allSel ? 'checked' : ''} onchange="iwSelAll(this.checked)"><span>${IW.sel.size ? `${IW.sel.size} selected` : 'Select all'}</span></label>
      <div class="wbulk-fields" ${IW.sel.size ? '' : 'hidden'}>
        <input id="wb-project" list="wproj" placeholder="Area / project" aria-label="Set area / project">
        <select id="wb-room" aria-label="Set room"><option value="-">Room…</option><option value="">Project’s room</option>${roomOpts(null)}</select>
        <select id="wb-iv" aria-label="Set repeat"><option value="-">Repeat…</option>${freqOpts().map(([g]) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}</select>
        <input id="wb-due" type="date" aria-label="Set due date">
        <button type="button" class="p" onclick="iwBulk()">Apply to ${IW.sel.size}</button>
        <button type="button" onclick="iwInclude(false)">Skip</button>
        <button type="button" onclick="iwInclude(true)">Include</button>
      </div>
    </div>`;

  const filters = `<div class="wfilter" role="tablist">
      <button type="button" role="tab" class="${IW.show == 'attention' ? 'on' : ''}" onclick="setShow('attention');renderIW()">Needs attention <span>${n}</span></button>
      <button type="button" role="tab" class="${IW.show == 'all' ? 'on' : ''}" onclick="setShow('all');renderIW()">All rows <span>${all}</span></button>
    </div>`;

  const body = rows.map(r => iwRowHTML(r)).join('') ||
    `<p class="wnote ok">${IW.show == 'attention' ? 'Nothing needs attention. Import when you’re ready.' : 'No rows.'}</p>`;
  return `${filters}${bulk}<datalist id="wproj">${projects.map(p => `<option value="${esc(p)}">`).join('')}</datalist><div class="wrows">${body}</div>`;
}

function iwRowHTML(r) {
  const st = rowState(r), probs = rowProblems(r), bad = f => probs.find(i => i.field == f);
  const cls = f => { const i = bad(f); return i ? ` class="${i.level}"` : ''; };
  const ivOpts = freqOptionsHTML(r);
  return `<div class="wrow ${st}" id="wr-${r.line}">
      <label class="wcheck"><input type="checkbox" ${IW.sel.has(r.line) ? 'checked' : ''} onchange="iwSel(${r.line}, this.checked)" aria-label="Select row ${r.line}"></label>
      <span class="wline" title="Row in the file">${r.line}</span>
      <input${cls('title')} value="${esc(r.title)}" placeholder="Task name" aria-label="Task name" oninput="iwSet(${r.line},'title',this.value)">
      <input${cls('project')} value="${esc(r.project)}" placeholder="General" list="wproj" aria-label="Area / project" oninput="iwSet(${r.line},'project',this.value)">
      <select${cls('room')} aria-label="Room" onchange="iwSet(${r.line},'room',this.value)"><option value="">Project’s room</option>${roomOpts(r.room || null)}</select>
      <select${cls('interval')} aria-label="Repeat" onchange="iwSet(${r.line},'interval',this.value)">${ivOpts}</select>
      <input${cls('due')} type="date" value="${esc(r.due)}" aria-label="Due date" onchange="iwSet(${r.line},'due',this.value)">
      <button type="button" class="wskip" onclick="iwToggle(${r.line})">${r.include ? 'Skip' : 'Include'}</button>
      <p class="wissue">${iwIssueText(r)}</p>
    </div>`;
}

function iwIssueText(r) {
  if (!r.include) return 'Skipped. It won’t be imported.';
  return rowProblems(r).map(i => esc(i.msg)).join(' · ');
}

// Typing updates just that row (no full redraw, so the field keeps focus)
function iwSet(line, field, value) {
  const r = iwRow(line);
  if (field == 'interval') {                        // value = a frequency label: it sets the repeat and the label
    if (value == '__custom') return;
    const f = freqOf(value);
    r.tags = withFreq((r.tags || '').split(',').filter(Boolean), value).join(',');
    r.interval = f ? f.n : 0;
    r.interval_unit = f ? f.u : 'm';
    r.fixed.add(field);
    iwRefresh(r);
    return;
  }
  r[field] = value;
  r.fixed.add(field);
  iwRefresh(r);
}

function iwRefresh(r) {
  const el = $('wr-' + r.line);
  if (el) {
    el.className = `wrow ${rowState(r)}`;
    const probs = rowProblems(r);
    el.querySelectorAll('input:not([type=checkbox]), select').forEach(inp => {
      const f = { 'Task name': 'title', 'Area / project': 'project', 'Room': 'room', 'Repeat': 'interval', 'Due date': 'due' }[inp.getAttribute('aria-label')];
      const i = probs.find(p => p.field == f);
      inp.className = i ? i.level : '';
    });
    el.querySelector('.wissue').textContent = r.include ? probs.map(i => i.msg).join(' · ') : 'Skipped. It won’t be imported.';
    el.querySelector('.wskip').textContent = r.include ? 'Skip' : 'Include';
  }
  const foot = document.querySelector('.wiz-foot');
  if (foot) foot.innerHTML = iwFooter();
  const tabs = document.querySelectorAll('.wfilter span');
  if (tabs.length) tabs[0].textContent = rowsNeeding().length;
}

function iwToggle(line) {
  const r = iwRow(line);
  r.include = !r.include;
  iwRefresh(r);
}

function iwSel(line, on) {
  on ? IW.sel.add(line) : IW.sel.delete(line);
  iwBulkBar();
}

function iwSelAll(on) {
  IW.visible.forEach(l => on ? IW.sel.add(l) : IW.sel.delete(l));
  document.querySelectorAll('.wrow .wcheck input').forEach(c => { c.checked = on; });
  iwBulkBar();
}

function iwBulkBar() {
  const f = document.querySelector('.wbulk-fields'), lbl = document.querySelector('.wbulk > .wcheck span');
  if (f) f.hidden = !IW.sel.size;
  if (lbl) lbl.textContent = IW.sel.size ? `${IW.sel.size} selected` : 'Select all';
  const b = document.querySelector('.wbulk-fields .p');
  if (b) b.textContent = `Apply to ${IW.sel.size}`;
}

// Apply whichever bulk fields were filled in to every selected row
function iwBulk() {
  const project = $('wb-project').value.trim(), room = $('wb-room').value, iv = $('wb-iv').value, due = $('wb-due').value;
  if (!project && room == '-' && iv == '-' && !due) {
    $('wb-project').focus();
    return;
  }
  IW.sel.forEach(line => {
    const r = iwRow(line);
    if (project) iwSet(line, 'project', project);
    if (room != '-') iwSet(line, 'room', room);
    if (iv != '-') iwSet(line, 'interval', iv);
    if (due) iwSet(line, 'due', due);
    r.include = true;
  });
  renderIW();
}

function iwInclude(on) {
  IW.sel.forEach(line => { iwRow(line).include = on; });
  renderIW();
}

function iwFooter() {
  if (IW.step == 3) return `<span></span><div class="wbtns"><a class="btn" href="/board/">Open the Board</a><button type="button" class="p" onclick="closeIW(true)">Done</button></div>`;
  const n = importable().length, fix = IW.rows.filter(r => rowState(r) == 'error').length;
  const note = fix ? `<span class="wfoot-note error">${fix} row${fix == 1 ? '' : 's'} still need${fix == 1 ? 's' : ''} a fix and will be skipped</span>` : `<span class="wfoot-note">${n} task${n == 1 ? '' : 's'} ready to import</span>`;
  const back = IW.step == 2 ? '<button type="button" onclick="IW.step=1;renderIW()">Back</button>' : '<button type="button" onclick="closeIW()">Cancel</button>';
  const next = IW.step == 1 && rowsNeeding().length
    ? `<button type="button" onclick="iwCommit()" ${n ? '' : 'disabled'}>Import ${n} now</button><button type="button" class="p" onclick="IW.step=2;setShow(IW.show);renderIW()">Review and fix</button>`
    : `<button type="button" class="p" onclick="iwCommit()" ${n ? '' : 'disabled'}>Import ${n} task${n == 1 ? '' : 's'}</button>`;
  return `${note}<div class="wbtns">${back}${next}</div>`;
}

async function iwCommit() {
  const rows = importable().map(({ title, project, room, tags, interval, interval_unit, notes, url, due }) => ({ title, project, room, tags, interval, interval_unit, notes, url, due }));
  const r = await api('/api/import/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: IW.file, rows }) });
  const body = await r.json().catch(() => ({}));
  IW.result = r.ok ? body : { imported: 0, skipped: [], error: 'The import didn’t go through. Nothing was saved. Please try again.' };
  IW.result.left = IW.rows.length - rows.length;
  IW.step = 3;
  renderIW();
  load();
}

function iwDone() {
  const res = IW.result;
  if (res.error) return `<p class="wnote error">${esc(res.error)}</p>`;
  const skipped = res.skipped.map(s => `<li>${esc(s.title || '(no name)')}<small>${esc(s.reason)}</small></li>`).join('');
  return `<div class="wdone"><span class="cdicon">✅</span>
      <h3>Imported ${res.imported} task${res.imported == 1 ? '' : 's'}</h3>
      <p class="note">${res.left ? `${res.left} row${res.left == 1 ? ' was' : 's were'} left out (already in the app, skipped, or still missing a task name or due date).` : 'Every row was imported.'} You can edit any task from the Board or Settings › Task Scheduling.</p>
      ${skipped ? `<ul class="wmissing">${skipped}</ul>` : ''}</div>`;
}

async function closeIW(force) {
  const d = $('iw');
  if (!force && IW && IW.step < 3 && !await ask({ title: 'Cancel this import?', message: 'Nothing has been imported yet. Any fixes you made will be lost.', ok: 'Cancel import', danger: true, icon: '📄' })) return;
  d.close();
  IW = null;
}

/* ---- calendar ---- */
const expandedMonths = new Set();
function toggleMonthExpand(monthKey) {
  if (expandedMonths.has(monthKey)) expandedMonths.delete(monthKey);
  else expandedMonths.add(monthKey);
  draw();
}

function cal(L) {
  const now = new Date(), M = [];
  for (let k = 0; k < 12; k++) {
    M.push({ key: `${now.getFullYear()}_${k}`, d: new Date(now.getFullYear(), now.getMonth() + k, 1), items: [] });
  }
  const end = new Date(now.getFullYear(), now.getMonth() + 12, 1);
  const mk = d => M.find(m => m.d.getFullYear() == d.getFullYear() && m.d.getMonth() == d.getMonth());

  for (const t of L) {
    const open = t.status != 'done';
    let d = new Date(t.due + 'T00:00');
    if (!open) { if (!t.interval) continue; d = addIv(d, t); }
    for (let n = 0; n < 400 && d < end; n++) {
      let m = mk(d);
      if (!m && n == 0 && open && d < M[0].d) m = M[0];
      if (m) m.items.push({ t, d: new Date(d), actual: open && n == 0 });
      if (!t.interval) break;
      d = addIv(d, t);
    }
  }

  // Each season has its own emoji and color theme (cls drives the CSS color)
  // A winter spans Dec–Feb, so it is named by the year it starts (e.g. Winter 2026–27)
  const getSeason = monthDate => {
    const mo = monthDate.getMonth();
    const yr = monthDate.getFullYear();
    if (mo === 11 || mo <= 1) {
      const sy = mo === 11 ? yr : yr - 1;
      return { name: `❄ Winter ${sy}–${String(sy + 1).slice(2)}`, cls: 'season-winter' };
    }
    if (mo <= 4) return { name: `🌱 Spring ${yr}`, cls: 'season-spring' };
    if (mo <= 7) return { name: `☀️ Summer ${yr}`, cls: 'season-summer' };
    return { name: `🍂 Fall ${yr}`, cls: 'season-fall' };
  };

  // M is already chronological (starting with the current month), so insertion order = display order
  const seasonMap = {};
  M.forEach(m => {
    m.items.sort((a, b) => a.d - b.d);
    const s = getSeason(m.d);
    if (!seasonMap[s.name]) seasonMap[s.name] = { name: s.name, cls: s.cls, months: [] };
    seasonMap[s.name].months.push(m);
  });
  const seasonsList = Object.values(seasonMap);

  const m = $('m');
  if (m) {
    m.innerHTML = seasonsList.map(season => `
      <div class="season-group ${season.cls}">
        <h2 class="season-title">${season.name}</h2>
        <div class="cal">
          ${season.months.map(m => {
            const isExpanded = expandedMonths.has(m.key);
            const visibleItems = isExpanded ? m.items : m.items.slice(0, 5);
            const hiddenCount = m.items.length - 5;
            const itemsHTML = visibleItems.map(({ t, d }) => `<div class="ci"><span>${esc(t.title)} <i>· ${esc(t.project)} · ${d.toLocaleDateString('default', { month: 'short', day: 'numeric' })}</i></span></div>`).join('');
            const expandBtn = m.items.length > 5 ? `<button onclick="toggleMonthExpand('${m.key}')" style="margin-top:10px;width:100%;font-size:12px;">${isExpanded ? 'Collapse' : `+ ${hiddenCount} more (Show All)`}</button>` : '';
            return `<div class="mon">
              <h3>${m.d.toLocaleString('default', { month: 'long', year: 'numeric' })} <small>(${m.items.length})</small></h3>
              ${itemsHTML}${expandBtn}
            </div>`;
          }).join('')}
        </div>
      </div>
    `).join('');
  }
}

/* ---- home: a bird's-eye floor plan, each room colored by how many ToDo tasks it holds ---- */
// How many ToDo tasks a room holds, ranked. Mirrors web/ranking.py (GET /api/ranking has the same numbers).
// [key, name, color, range, what it means]; an empty room is the goal, not a blank
const LEVELS = [
  ['perfect', 'Perfect', '#2fbf71', 'No tasks', 'Nothing to do: the goal'],
  ['thriving', 'Thriving', '#3e9a78', '1–3 to do', 'Well on top of it'],
  ['livable', 'Livable', '#9ccc65', '4–6 to do', 'Fine for now'],
  ['neutral', 'Neutral', '#e9c46a', '7–10 to do', 'Starting to pile up'],
  ['slacking', 'Slacking', '#e0782a', '11–20 to do', 'Falling behind'],
  ['neglected', 'Neglected', '#d64550', '21+ to do', 'Needs attention'],
];
const TIER_MAX = [0, 3, 6, 10, 20];      // the highest count in each tier but the last
const tierOf = n => {
  const i = TIER_MAX.findIndex(m => n <= m);
  return LEVELS[i < 0 ? LEVELS.length - 1 : i][0];
};

/* ---- room moods: how a room feels at its rank ----
   Perfect and Thriving: a sunny glow and twinkling sparkles (the reward). Livable and Neutral: a lamp's warm,
   gently flickering light (cozy). Slacking: heat and rising bubbles. Neglected: a rolling boil, with faster,
   bigger bubbles, steam and a pulsing edge (see MOODS). Everything is clipped to the room's outline, sits under
   its label, and stands still with prefers-reduced-motion (style.css). */
const MOOD_DEF = `<radialGradient id="mood-lamp"><stop offset="0" stop-color="#ffd27a" stop-opacity=".55"/><stop offset=".55" stop-color="#ffc35a" stop-opacity=".18"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>
  <radialGradient id="mood-sun"><stop offset="0" stop-color="#fff3c4" stop-opacity=".5"/><stop offset=".6" stop-color="#c8f5d8" stop-opacity=".14"/><stop offset="1" stop-color="#c8f5d8" stop-opacity="0"/></radialGradient>
  <radialGradient id="mood-hot" cy="1" r="1"><stop offset="0" stop-color="#ff8a3d" stop-opacity=".5"/><stop offset="1" stop-color="#ff8a3d" stop-opacity="0"/></radialGradient>
  <radialGradient id="mood-boil" cy="1" r="1.1"><stop offset="0" stop-color="#ff3b4a" stop-opacity=".6"/><stop offset=".7" stop-color="#ff6a3d" stop-opacity=".18"/><stop offset="1" stop-color="#ff6a3d" stop-opacity="0"/></radialGradient>`;
// the same room always gets the same sparkles and bubbles, so a redraw doesn't reshuffle them
function seeded(str) {
  let h = 2166136261;
  for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
const r1 = v => Math.round(v * 10) / 10;
let MOOD_N = 0;
// What each rank draws in a room: [glow ('sun' | 'lamp' | ''), sparkles, motes, heat ('' | 'hot' | 'boil')]
const MOODS = {
  perfect: ['sun', 4, 0, ''],      // the reward: bright glow, sparkles
  thriving: ['sun', 2, 0, ''],
  livable: ['lamp', 0, 2, ''],     // cozy lamplight with drifting motes
  neutral: ['lamp', 0, 0, ''],
  slacking: ['', 0, 0, 'hot'],     // heat and rising bubbles
  neglected: ['', 0, 0, 'boil'],   // a rolling boil, steam, a pulsing edge
};
function moodSVG(r, key) {
  const [glow, sparks, motes, heat] = MOODS[key] || MOODS.neutral;
  const rnd = seeded(r.id + key), b = { x: r.x, y: r.y, w: r.w, h: r.h }, k = TS, m = Math.min(b.w, b.h);
  const id = 'mc' + (MOOD_N++), at = (fx, fy) => [r1(b.x + fx * b.w), r1(b.y + fy * b.h)];
  let fx = '';
  if (glow) {
    // a light in one corner (the sunny reward glow fills more of the room)
    const [cx, cy] = at(rnd() < 0.5 ? 0.12 : 0.88, rnd() < 0.5 ? 0.15 : 0.85);
    fx += `<circle class="lamp${glow == 'sun' ? ' sun' : ''}" cx="${cx}" cy="${cy}" r="${r1(m * (glow == 'sun' ? 0.95 : 0.75))}" fill="url(#mood-${glow})" style="--dl:${r1(-rnd() * 6)}s"/>`;
  }
  // sparkles near the walls, clear of the label in the middle
  const nSparks = m < 90 * k ? Math.min(sparks, 2) : sparks;
  for (let i = 0; i < nSparks; i++) {
    const side = i % 4, t = 0.12 + rnd() * 0.76, e = 0.08 + rnd() * 0.08;
    const [x, y] = at(side == 0 ? t : side == 2 ? 1 - t : side == 1 ? 1 - e : e, side == 0 ? e : side == 2 ? 1 - e : side == 1 ? t : 1 - t);
    const z = r1((5 + rnd() * 4) * k);
    fx += `<path class="spark" d="M${x} ${r1(y - z)}Q${x} ${y} ${r1(x + z)} ${y}Q${x} ${y} ${x} ${r1(y + z)}Q${x} ${y} ${r1(x - z)} ${y}Q${x} ${y} ${x} ${r1(y - z)}Z" style="--d:${r1(2.4 + rnd() * 2)}s;--dl:${r1(-rnd() * 4)}s"/>`;
  }
  // warm motes drifting in the lamplight
  for (let i = 0; i < motes; i++) {
    const [x, y] = at(0.15 + rnd() * 0.7, 0.55 + rnd() * 0.35);
    fx += `<circle class="mote" cx="${x}" cy="${y}" r="${r1((1.6 + rnd()) * k)}" style="--d:${r1(7 + rnd() * 5)}s;--dl:${r1(-rnd() * 10)}s;--rise:${r1(-b.h * 0.35)}px"/>`;
  }
  if (heat) {
    const boil = heat == 'boil';
    fx += `<rect class="heat${boil ? ' boil' : ''}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="url(#mood-${heat})"/>`;
    const n = Math.max(3, Math.min(boil ? 14 : 7, Math.round(b.w / (boil ? 22 : 38) / k)));
    for (let i = 0; i < n; i++) {
      const x = r1(b.x + b.w * (i + 0.2 + rnd() * 0.6) / n), rr = r1((boil ? 3 + rnd() * 5 : 2.5 + rnd() * 3) * k);
      const d = boil ? 1.2 + rnd() * 1.1 : 2.6 + rnd() * 1.6;
      fx += `<circle class="bub" cx="${x}" cy="${r1(b.y + b.h - rr - 2)}" r="${rr}" style="--d:${r1(d)}s;--dl:${r1(-rnd() * d)}s;--rise:${r1(-(b.h * (0.55 + rnd() * 0.35)))}px;--sx:${r1((rnd() - 0.5) * 10 * k)}px"/>`;
    }
    if (boil) {
      // steam curling off the top, and the walls pulse
      for (let i = 0; i < 3; i++) {
        const x = r1(b.x + b.w * (0.25 + i * 0.25) + (rnd() - 0.5) * 10), y = r1(b.y + Math.min(b.h * 0.45, 46 * k)), q = r1(7 * k), hh = r1(Math.min(b.h * 0.35, 34 * k));
        fx += `<path class="steam" d="M${x} ${y}q${-q} ${r1(-hh / 3)} 0 ${r1(-hh * 2 / 3)}t0 ${r1(-hh / 3)}" style="--dl:${r1(-i * 0.9 - rnd())}s"/>`;
      }
      fx += shapeSVG(r).replace(/^<(rect|polygon)/, '<$1 class="edge"');
    }
  }
  return `<g class="mood mood-${key}" aria-hidden="true"><clipPath id="${id}">${shapeSVG(r)}</clipPath><g clip-path="url(#${id})">${fx}</g></g>`;
}

// The plan is an 800 × 540 canvas; rooms are rectangles on it. Space inside the house that no room
// covers is drawn as hallway. The ground floor also shows the yard around the house.
const PLAN_W = 800, PLAN_H = 540;
let HOME = {};             // per-room counts for the tooltip
let FLOOR = (() => { try { return localStorage.getItem('homeFloor'); } catch (e) { return null; } })();
let ED = null;             // the map editor's state while it's open (see openEditor)
let TAPPED_ROOM = null;    // touch: the room whose details a tap opened; tapping the details (or the room again) opens it on the Board

const roomLevel = s => tierOf(s.backlog);
const levelInfo = k => LEVELS.find(l => l[0] == k);

function roomStats(L, q) {
  const out = {}, td = today();
  ROOMS.forEach(([k]) => { out[k] = { backlog: 0, doing: 0, done: 0, overdue: 0, projects: new Set() }; });
  projs(L, !q).forEach(p => out[roomFor(p)].projects.add(p));
  L.forEach(t => {
    const s = out[taskRoom(t)];
    s.projects.add(t.project);
    s[t.status] = (s[t.status] || 0) + 1;
    if (t.status != 'done' && t.due < td) s.overdue++;
  });
  return out;
}

// Which floor the Home map shows (remembered on this device)
function curFloor() {
  return MAP.floors.some(f => f.id == FLOOR) ? FLOOR : MAP.ground;
}

function setFloor(id) {
  FLOOR = id;
  try { localStorage.setItem('homeFloor', id); } catch (e) { /* private browsing: just don't remember */ }
  draw();
}

// The house outline on a floor: the box around all its rooms (gaps inside it are hallway)
function footprint(rooms) {
  if (!rooms.length) return null;
  const x = Math.min(...rooms.map(r => r.x)), y = Math.min(...rooms.map(r => r.y));
  const x2 = Math.max(...rooms.map(r => r.x + r.w)), y2 = Math.max(...rooms.map(r => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

// Plants in the yard (ground floor): three small clusters (a stand of trees, shrubs, a flower bed).
// Each goes in the first spot on its list that's clear of the house, the yard label and the other clusters.
// Cluster parts are [dx, dy, emoji, size] around the spot.
const GARDEN = [
  { parts: [[0, 0, '🌳', 30], [22, 6, '🌲', 26], [-18, 10, '🌳', 24]],                        // a stand of trees
    spots: [[38, 30], [762, 30], [38, 505], [400, 30], [762, 300], [230, 30]] },
  { parts: [[0, 0, '🌿', 22], [18, 4, '🪴', 20], [-16, 6, '🌿', 18]],                         // shrubs
    spots: [[762, 420], [38, 250], [600, 30], [38, 420], [120, 510]] },
  { parts: [[0, 0, '🌷', 18], [16, -4, '🌸', 16], [30, 2, '🌼', 16], [-14, 4, '🌷', 16]],      // a flower bed
    spots: [[250, 510], [120, 510], [38, 160], [762, 150], [560, 30]] },
];

function gardenSVG(fp, cls = 'garden') {
  const clear = 18;                                         // keep plants this far from the house walls
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const taken = [{ x: 470, y: 495, w: 330, h: 45 }];        // the yard's label, bottom-right
  if (fp) taken.push({ x: fp.x - clear, y: fp.y - clear, w: fp.w + 2 * clear, h: fp.h + 2 * clear });
  let out = '';
  GARDEN.forEach(c => {
    const pad = Math.max(...c.parts.map(q => q[3])) / 2 + 2;
    const xs = c.parts.map(q => q[0]), ys = c.parts.map(q => q[1]);
    for (const [sx, sy] of c.spots) {
      const box = { x: sx + Math.min(...xs) - pad, y: sy + Math.min(...ys) - pad,
                    w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad };
      if (box.x < 0 || box.y < 0 || box.x + box.w > PLAN_W || box.y + box.h > PLAN_H || taken.some(t => hit(box, t))) continue;
      taken.push(box);
      // draw back-to-front (higher on the plan first) so the cluster overlaps naturally
      out += [...c.parts].sort((a, b) => a[1] - b[1]).map(([dx, dy, e, sz]) =>
        `<text x="${sx + dx}" y="${sy + dy}" font-size="${sz}">${e}</text>`).join('');
      break;
    }
  });
  return `<g class="${cls}" aria-hidden="true">${out}</g>`;
}

/* ---- labels that fit: names wrap by word inside the room, with padding from the walls ---- */
const _measure = document.createElement('canvas').getContext('2d');
const LABEL_FONT = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';

function textWidth(str, size, weight = 700) {
  _measure.font = `${weight} ${size}px ${LABEL_FONT}`;
  return _measure.measureText(str).width;
}

// Greedy word wrap; null if a single word is wider than maxW
function wrapWords(str, maxW, size) {
  const lines = [];
  for (const word of str.split(/\s+/).filter(Boolean)) {
    if (textWidth(word, size) > maxW) return null;
    const last = lines[lines.length - 1];
    if (last !== undefined && textWidth(`${last} ${word}`, size) <= maxW) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

// The biggest size (14 → 9px) at which the text wraps into the box; failing that, the smallest size,
// as many lines as fit, and "…" on the last one
function fitText(str, maxW, maxH, sizes = [14, 13, 12, 11, 10, 9]) {
  for (const size of sizes) {
    const lh = Math.round(size * 1.2), lines = wrapWords(str, maxW, size);
    if (lines && lines.length * lh <= maxH) return { size, lh, lines };
  }
  const size = sizes[sizes.length - 1], lh = Math.round(size * 1.2);
  const maxLines = Math.max(1, Math.floor(maxH / lh)), lines = [];
  let rest = str.trim();
  while (rest && lines.length < maxLines) {
    let n = rest.length;
    while (n > 1 && textWidth(rest.slice(0, n), size) > maxW) n--;
    const sp = rest.slice(0, n).lastIndexOf(' ');
    if (n < rest.length && sp > 0) n = sp;                  // break at a space when one is close by
    lines.push(rest.slice(0, n).trim());
    rest = rest.slice(n).trim();
  }
  if (rest) {
    let last = lines.pop() || '';
    while (last && textWidth(last + '…', size) > maxW) last = last.slice(0, -1);
    lines.push(last + '…');
  }
  return { size, lh, lines };
}

// Icon, name (wrapped) and, on the Home page, the to-do line — stacked and centred in the room.
// Parts are dropped in this order when the room is too small: icon, then to-do line.
// Text scale: the Outside canvas is bigger than a floor's, so its labels are drawn bigger to look the same
let TS = 1;
const tsStyle = px => (TS == 1 ? '' : ` style="font-size:${Math.round(px * TS)}px"`);
function roomLabelSVG(r, sub, num) {
  const pad = 8 * TS, maxW = r.w - 2 * pad, availH = r.h - 2 * pad, iconH = 32 * TS, subH = sub ? 16 * TS : 0;
  const one = Math.round(14 * TS * 1.2);
  const showIcon = availH >= iconH + one + subH;
  const showSub = sub && availH >= (showIcon ? iconH : 0) + one + subH;
  const fit = fitText(r.name || 'Unnamed', maxW, availH - (showIcon ? iconH : 0) - (showSub ? subH : 0),
    [14, 13, 12, 11, 10, 9].map(v => Math.round(v * TS)));
  const total = (showIcon ? iconH : 0) + fit.lines.length * fit.lh + (showSub ? subH : 0);
  const cx = r.x + r.w / 2;
  let y = r.y + (r.h - total) / 2, out = '';
  if (showIcon) { out += `<text class="re" x="${cx}" y="${y + iconH / 2}"${tsStyle(26)}>${r.emoji || '🚪'}</text>`; y += iconH; }
  out += `<text class="rn" x="${cx}" style="font-size:${fit.size}px">${fit.lines.map((ln, i) =>
    `<tspan x="${cx}" y="${y + fit.lh * (i + 0.5)}">${esc(ln)}</tspan>`).join('')}</text>`;
  y += fit.lines.length * fit.lh;
  if (showSub) out += `<text class="rc" x="${cx}" y="${y + subH / 2}"${tsStyle(12)}>${sub}</text>`;
  // phones show a big number instead of the name and to-do line (CSS swaps them)
  if (num !== undefined && r.h >= 70 * TS) {
    const ny = showIcon ? r.y + (r.h - total) / 2 + iconH + 22 * TS : r.y + r.h / 2;
    out += `<text class="rnum" x="${cx}" y="${Math.min(ny, r.y + r.h - 22 * TS)}"${tsStyle(40)}>${num}</text>`;
  }
  return out;
}

// A tree: its canopy (the box it covers, drawn round), a tree in the middle, and an optional name
function treeSVG(t, attrs = '') {
  const cx = t.x + t.w / 2, cy = t.y + t.h / 2, s = Math.min(t.w, t.h);
  const nm = t.name ? fitText(t.name, t.w - 8, 40, [Math.round(12 * TS), Math.round(10 * TS)]).lines[0] : '';
  return `<g class="tree" ${attrs}><ellipse cx="${cx}" cy="${cy}" rx="${t.w / 2}" ry="${t.h / 2}"/>` +
    `<text class="te" x="${cx}" y="${nm ? cy - s * 0.1 : cy}" style="font-size:${Math.round(s * (nm ? 0.45 : 0.55))}px">🌳</text>` +
    (nm ? `<text class="tn" x="${cx}" y="${cy + s * 0.3}" style="font-size:${Math.round(12 * TS)}px">${esc(nm)}</text>` : '') + '</g>';
}

// The house seen from Outside: hatched (you can't put anything on it), labelled, and on Home it opens
// "Whole house" like its card does
function houseBlockSVG(hb, attrs = '', sub, num, cls = '') {
  const [, hn, he] = roomInfo('house');
  return `<g class="housebox${cls}" ${attrs}><rect class="hb" x="${hb.x}" y="${hb.y}" width="${hb.w}" height="${hb.h}"/>` +
    roomLabelSVG({ name: hn, emoji: he, ...hb }, sub, num) + '</g>';
}

// A flight of stairs: solid on its own floor, a see-through outline on the floor it leads to
// What a flight's label says on the floor being viewed: "Up to Upstairs" on its own floor,
// "Down to Main floor" seen from the floor it leads to (floorName2: the editor's unsaved floor names)
function stairsText(st, ghost) {
  const up = floorIdx(st.to) > floorIdx(st.floor);
  return `${(ghost ? !up : up) ? 'Up' : 'Down'} to ${floorName2(ghost ? st.floor : st.to)}`;
}

const boxesTouch = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Group flights that overlap each other on this floor (stacked up/down flights in one stairwell).
// items: [{ st, ghost }] → array of groups
function stairsGroups(items) {
  const groups = [];
  items.forEach(it => {
    const hits = groups.filter(g => g.some(o => boxesTouch(o.st, it.st)));
    const merged = [it, ...hits.flat()];
    hits.forEach(h => groups.splice(groups.indexOf(h), 1));
    groups.push(merged);
  });
  return groups;
}

// One label for a group of overlapping flights: a line per different destination, centred on the
// group and run along it when the stairwell is tall and narrow
function stairsGroupLabel(group) {
  const lines = [...new Set(group.map(({ st, ghost }) => stairsText(st, ghost)))];
  const box = footprint(group.map(g => g.st));
  const vertical = box.h >= box.w, len = vertical ? box.h : box.w, across = vertical ? box.w : box.h;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let size = 12;
  while (size > 8 && (lines.some(l => textWidth(l, size) > len - 12) || lines.length * size * 1.2 > across - 6)) size--;
  const lh = Math.round(size * 1.2);
  const fitted = lines.map(l => fitText(l, len - 12, lh, [size]).lines[0]);
  const turn = vertical ? ` transform="rotate(-90 ${cx} ${cy})"` : '';
  return `<text class="stl stg" x="${cx}" y="${cy}" style="font-size:${size}px"${turn}>${fitted.map((l, i) =>
    `<tspan x="${cx}" y="${cy + (i - (fitted.length - 1) / 2) * lh}">${esc(l)}</tspan>`).join('')}</text>`;
}

// All the flights on a floor: each drawn as usual, except that flights overlapping other flights leave
// out their own label and the group gets one combined label drawn on top. attrsFor(item) adds editor attributes.
function stairsLayerSVG(items, attrsFor = () => '') {
  const groups = stairsGroups(items), shared = new Set();
  groups.filter(g => g.length > 1).forEach(g => g.forEach(it => shared.add(it.st.id)));
  return items.map(it => stairsSVG(it.st, it.ghost, attrsFor(it), !shared.has(it.st.id))).join('') +
    `<g class="stairs-labels" aria-hidden="true">${groups.filter(g => g.length > 1).map(stairsGroupLabel).join('')}</g>`;
}

function stairsSVG(st, ghost, attrs = '', withLabel = true) {
  const vertical = st.h >= st.w, len = vertical ? st.h : st.w, n = Math.max(3, Math.floor(len / 14));
  let steps = '';
  for (let k = 1; k < n; k++) {
    steps += vertical ? `M${st.x} ${st.y + k * st.h / n}h${st.w}` : `M${st.x + k * st.w / n} ${st.y}v${st.h}`;
  }
  const label = stairsText(st, ghost);
  const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
  const turn = vertical ? ` transform="rotate(-90 ${cx} ${cy})"` : '';      // run the label along tall, narrow stairs
  const across = vertical ? st.w : st.h;
  const fit = fitText(label, len - 12, Math.max(across - 6, 10), [12, 11, 10, 9]);
  const text = fit.lines.length == 1 ? fit.lines[0] : fitText(label, len - 12, fit.lh, [9]).lines[0];   // stairs keep one line
  return `<g class="stairs${ghost ? ' ghost' : ''}" ${attrs}><rect x="${st.x}" y="${st.y}" width="${st.w}" height="${st.h}"/>` +
    `<path d="${steps}"/>${withLabel ? `<text class="stl" x="${cx}" y="${cy}" style="font-size:${fit.size}px"${turn}>${esc(text)}</text>` : ''}</g>`;
}

// Diagonal hatching for blocked-off areas (each map <svg> carries its own copy in <defs>)
const HATCH_DEF = `<pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
  <rect width="10" height="10" class="hatchbg"/><line x1="0" y1="0" x2="0" y2="10" class="hatchline"/></pattern>`;

function blockedSVG(b, attrs = '') {
  const lb = labelBox(b);
  if (!(b.name || '').trim()) return `<g class="blocked" ${attrs}>${shapeSVG(b)}</g>`;    // unnamed: no label
  const fit = fitText(b.name, lb.w - 16, Math.max(lb.h - 12, 12), [12, 11, 10, 9]);
  const cx = lb.x + lb.w / 2, cy = lb.y + lb.h / 2;
  return `<g class="blocked" ${attrs}>${shapeSVG(b)}` +
    `<text class="bkl" x="${cx}" style="font-size:${fit.size}px">${fit.lines.map((ln, i) =>
      `<tspan x="${cx}" y="${cy + (i - (fit.lines.length - 1) / 2) * fit.lh}">${esc(ln)}</tspan>`).join('')}</text></g>`;
}

// floor tabs look like the top bar's section nav: a pill track, the current floor a raised segment with a green icon
const FLOOR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>';
const OUTSIDE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a5 5 0 0 0-4.6 7A4 4 0 0 0 9 17h6a4 4 0 0 0 1.6-7A5 5 0 0 0 12 3z"/><path d="M12 12v9"/></svg>';
function floorTabs(active, onPick, counts) {
  return `<div class="floortabs" role="tablist" aria-label="Floors">${MAP.floors.map(f => {
    const on = f.id == active, n = counts ? counts[f.id] : 0;
    return `<button type="button" role="tab" aria-selected="${on}" class="${on ? 'on' : ''}" onclick="${onPick}('${esc(f.id)}')">` +
      `${isOutside(f.id) ? OUTSIDE_SVG : FLOOR_SVG}<span class="fname">${esc(f.name)}</span>${n ? `<span class="ftn" style="--rc:${levelInfo(tierOf(n))[2]}" title="${n} to do">${n}</span>` : ''}</button>`;
  }).join('')}</div>`;
}

// Phones: the plan is cropped to the house, and on a phone held upright it turns a quarter (clockwise), so a
// wide house fills the tall screen (about twice as big). Display only: the saved map and the editor stay upright.
const isPhone = () => innerWidth <= 600;
// the top bar's height (one row or two), so pages can size themselves to what's left of the window
(() => {
  const bar = document.querySelector('.topbar');
  if (!bar || !window.ResizeObserver) return;
  new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px')).observe(bar);
})();
const phoneUpright = () => isPhone() && (screen.height || innerHeight) > (screen.width || innerWidth);
let ROT = false, MAP_UP = null;    // ROT: Home is drawing a turned copy of MAP; MAP_UP: the real one meanwhile
const rotBox = b => ({ x: PLAN_H - b.y - b.h, y: b.x, w: b.h, h: b.w });
function rotItem(r) {
  const o = { ...r, ...rotBox(r) };
  if (r.pts) o.pts = r.pts.map(([x, y]) => [PLAN_H - y, x]);
  return o;
}
let HOME_ROT = null;               // the layout Home was last drawn for (redraw when the phone turns)
addEventListener('resize', () => {
  if (V === 'home' && !ED && HOME_ROT !== null && HOME_ROT !== `${isPhone()}${phoneUpright()}`) draw();
});

function home(L, q) {
  if (ED) return renderEditor();
  HOME_ROT = `${isPhone()}${phoneUpright()}`;
  ROT = phoneUpright();
  MAP_UP = MAP;
  if (ROT) MAP = { ...MAP, rooms: MAP.rooms.map(rotItem) };
  try { homePlan(L, q); } finally { MAP = MAP_UP; ROT = false; }
}

function homePlan(L, q) {
  HOME = roomStats(L, q);
  MOOD_N = 0;
  const fid = curFloor(), ground = fid == MAP.ground, phone = isPhone();
  const [PW, PH] = ROT ? [PLAN_H, PLAN_W] : [PLAN_W, PLAN_H];
  const color = r => levelInfo(roomLevel(HOME[r]))[2];
  const todo = r => HOME[r].backlog ? `${HOME[r].backlog} to do` : 'All clear';
  const aria = r => { const s = HOME[r]; return `${roomInfo(r)[1]}: ${levelInfo(roomLevel(s))[1]}, ${s.backlog} to do, ${s.doing} doing, ${s.overdue} overdue`; };
  const attrs = r => `class="room" data-room="${esc(r)}" data-tier="${roomLevel(HOME[r])}" tabindex="0" role="link" aria-label="${esc(aria(r))}" style="--rc:${color(r)}"`;

  // to-do count per floor for the tabs (the yard counts toward the ground floor)
  const counts = {};
  MAP.floors.forEach(f => { counts[f.id] = MAP.rooms.filter(r => r.floor == f.id && !isFeature(r)).reduce((n, r) => n + HOME[r.id].backlog, 0); });
  const yardFloor = MAP.floors.some(f => isOutside(f.id)) ? OUT : MAP.ground;
  counts[yardFloor] = (counts[yardFloor] || 0) + HOME.yard.backlog;

  const onFloor = MAP.rooms.filter(r => r.floor == fid && !isFeature(r));
  const blockedHere = MAP.rooms.filter(r => isBlocked(r) && r.floor == fid);
  const stairsHere = MAP.rooms.filter(r => isStairs(r) && r.floor == fid);
  const stairsGhost = MAP.rooms.filter(r => isStairs(r) && r.to == fid);
  const fp = houseOutline();             // the same outer walls on every floor, so floors line up
  const rooms = onFloor.map(r => {
    return `<g ${attrs(r.id)}>${shapeSVG(r)}${moodSVG(r, roomLevel(HOME[r.id]))}` +
      roomLabelSVG({ ...r, ...labelBox(r) }, todo(r.id), HOME[r.id].backlog || '✓') + '</g>';
  }).join('');

  const crop = phone && fp;              // phones: just the house, as big as it can be
  const [, yn, ye] = roomInfo('yard');
  const background = ground
    ? `<g ${attrs('yard')}><rect class="yard" x="0" y="0" width="${PW}" height="${PH}" rx="18"/>` +
      (crop ? '' : `<text class="rn" x="785" y="520" text-anchor="end" style="text-anchor:end">${ye} ${esc(yn)} · ${todo('yard')}</text>
        <text class="rnum" x="700" y="522">${ye} ${HOME.yard.backlog || '✓'}</text>`) + `</g>
       ${crop ? '' : gardenSVG(fp)}`
    : `<rect class="lot" x="0" y="0" width="${PW}" height="${PH}" rx="18"/>`;
  const treesHere = MAP.rooms.filter(r => isTree(r) && r.floor == fid);
  if (isOutside(fid)) return homeOutside(L, q, { fid, counts, onFloor, treesHere, attrs, todo, color });
  const empty = onFloor.length || stairsHere.length || blockedHere.length ? ''
    : `<text class="planempty" x="${fp ? fp.x + fp.w / 2 : PW / 2}" y="${fp ? fp.y + fp.h / 2 : PH / 2}">No rooms on this floor yet. Use Edit map to add some.</text>`;
  const house = (fp
    ? `<rect class="floor" x="${fp.x}" y="${fp.y}" width="${fp.w}" height="${fp.h}"/>${rooms}` +
      blockedHere.map(bk => blockedSVG(bk)).join('') +
      stairsLayerSVG([...stairsGhost.map(st => ({ st, ghost: true })), ...stairsHere.map(st => ({ st, ghost: false }))]) +
      `<rect class="walls" x="${fp.x}" y="${fp.y}" width="${fp.w}" height="${fp.h}"/>`
    : '') + empty;
  const vb = crop ? `${fp.x - 14} ${fp.y - 14} ${fp.w + 28} ${fp.h + 28}` : `0 0 ${PW} ${PH}`;
  const svg = `<svg class="plan${ROT ? ' turned' : ''}" viewBox="${vb}" role="img" aria-label="${esc(floorName(fid))} map${ROT ? ' (turned to fit the screen)' : ''}"><defs>${HATCH_DEF}${MOOD_DEF}</defs>${background}${house}</svg>`;
  homePage(svg, fid, counts, q, color, todo);
}

// The Outside tab on Home: the yard (everything not in an area), areas, structures, the house, trees
function homeOutside(L, q, { fid, counts, onFloor, treesHere, attrs, todo, color }) {
  const ob = ROT ? rotBox(outBounds(MAP_UP, HOME_HEAD)) : outBounds(MAP, HOME_HEAD), hb = houseOutline(), [, yn, ye] = roomInfo('yard');
  TS = 1.6;
  const item = r => `<g ${attrs(r.id).replace('class="room"', `class="room ${isStructure(r) ? 'structure' : 'area'}"`)}>${shapeSVG(r)}` +
    moodSVG(r, roomLevel(HOME[r.id])) + roomLabelSVG({ ...r, ...labelBox(r) }, todo(r.id), HOME[r.id].backlog || '✓') + '</g>';
  const areas = onFloor.filter(r => !isStructure(r)).map(item).join(''), sheds = onFloor.filter(isStructure).map(item).join('');
  const house = hb ? houseBlockSVG(hb, attrs('house').replace('class="room" ', ''), todo('house'), HOME.house.backlog || '✓', ' room') : '';
  const yard = `<g ${attrs('yard')}><rect class="yard" x="${ob.x}" y="${ob.y}" width="${ob.w}" height="${ob.h}" rx="28"/></g>`;
  // the yard's label goes on top of everything (areas may reach the corner it sits in)
  const ytext = `${ye} ${yn} · ${todo('yard')}`, ls = yardLabelSpot(ob, [...onFloor, ...(hb ? [hb] : [])], textWidth(ytext, 20) + 16, 32);
  const ylabel = `<text class="rn ylbl" x="${ls.x + ls.w - 8}" y="${ls.y + ls.h / 2}" style="font-size:20px">${esc(ytext)}</text>`;
  const empty = onFloor.length || treesHere.length ? ''
    : `<text class="planempty" x="${ob.x + ob.w / 2}" y="${ob.y + 60}" style="font-size:26px">Nothing outside yet. Use Edit map to add yard areas, a shed, or trees.</text>`;
  const svg = `<svg class="plan outside${ROT ? ' turned' : ''}" viewBox="${ob.x} ${ob.y} ${ob.w} ${ob.h}" role="img" aria-label="${esc(floorName(fid))} map"><defs>${HATCH_DEF}${MOOD_DEF}</defs>` +
    `${yard}${areas}${house}${sheds}<g class="trees" aria-hidden="true">${treesHere.map(t => treeSVG(t)).join('')}</g>${ylabel}${empty}</svg>`;
  TS = 1;
  homePage(svg, fid, counts, q, color, todo);
}

// Where the yard's own label goes: the bottom-right corner if it's open, else another corner or edge,
// else the first open patch of yard (scanning up from the bottom), so it never sits on an area or the house
function yardLabelSpot(ob, items, w, h) {
  const m = 20, free = c => c.x >= ob.x && c.y >= ob.y && c.x + c.w <= ob.x + ob.w && c.y + c.h <= ob.y + ob.h &&
    !items.some(r => c.x < r.x + r.w + 10 && r.x - 10 < c.x + c.w && c.y < r.y + r.h + 10 && r.y - 10 < c.y + c.h);
  const xs = [ob.x + ob.w - m - w, ob.x + m, ob.x + (ob.w - w) / 2], ys = [ob.y + ob.h - m - h, ob.y + m];
  for (const y of ys) for (const x of xs) if (free({ x, y, w, h })) return { x, y, w, h };
  for (let y = ob.y + ob.h - m - h; y >= ob.y + m; y -= 10)
    for (let x = ob.x + ob.w - m - w; x >= ob.x + m; x -= 10) if (free({ x, y, w, h })) return { x, y, w, h };
  return { x: ob.x + ob.w - m - w, y: ob.y + ob.h - m - h, w, h };
}

// Rooms panel filters: [key, label, which rooms]. "Slacking or worse" = 11+ to do (Slacking and Neglected).
const ROOM_FILTERS = [
  ['all', 'All rooms', () => true],
  ['tasks', 'With tasks', r => HOME[r].backlog > 0],
  ['behind', 'Slacking or worse', r => HOME[r].backlog > 10],
  ['floor', 'This floor', r => { const f = roomInfo(r)[3]; return f ? f == curFloor() : (r == 'yard') == isOutside(curFloor()); }],
];
let ROOM_FILTER = (() => { try { return localStorage.getItem('homeRooms') || 'all'; } catch (e) { return 'all'; } })();
let LEGEND_OPEN = false;   // collapsed until opened (kept while the page is open)

function setRoomFilter(k) {
  ROOM_FILTER = k;
  try { localStorage.setItem('homeRooms', k); } catch (e) { /* private browsing */ }
  const box = $('hrooms');
  if (!box) return;
  box.innerHTML = roomsListHTML();
  bindRooms(box);
  const sel = $('rfilt');
  if (sel) sel.innerHTML = roomFilterOpts();
}

// the filter is one compact menu next to the Rooms heading, so the list keeps the panel's height
function roomFilterOpts() {
  const all = ROOMS.map(([r]) => r).filter(r => HOME[r]);
  const cur = (ROOM_FILTERS.find(f => f[0] == ROOM_FILTER) || ROOM_FILTERS[0])[0];
  return ROOM_FILTERS.map(([k, label, f]) => `<option value="${k}"${k == cur ? ' selected' : ''}>${label} (${all.filter(f).length})</option>`).join('');
}

function roomsListHTML() {
  const all = ROOMS.map(([r]) => r).filter(r => HOME[r]);
  const filt = ROOM_FILTERS.find(f => f[0] == ROOM_FILTER) || ROOM_FILTERS[0];
  const shown = all.filter(filt[2]).sort((a, b) => HOME[b].backlog - HOME[a].backlog || HOME[b].overdue - HOME[a].overdue ||
    roomInfo(a)[1].localeCompare(roomInfo(b)[1]));
  // how the rooms rank, as one bar (each segment = rooms in that tier)
  const tiers = LEVELS.map(([k, name, c]) => [k, name, c, all.filter(r => roomLevel(HOME[r]) == k).length]);
  // each segment opens the Board with the tasks in rooms of that rank
  const bar = `<nav class="tierbar" aria-label="Rooms by rank">` +
    tiers.filter(t => t[3]).map(([k, name, c, n]) => `<a href="/board/?rank=${k}" style="--rc:${c};flex:${n}" title="${n} ${name} room${n > 1 ? 's' : ''}: show their tasks on the Board" aria-label="${n} ${name}: show on the Board"></a>`).join('') + '</nav>';
  const rows = shown.map(r => {
    const [, n, e, f] = roomInfo(r), lv = levelInfo(roomLevel(HOME[r]));
    return `<a class="hrow" href="/board/?room=${encodeURIComponent(r)}" data-room="${esc(r)}" data-tier="${lv[0]}" style="--rc:${lv[2]}"><span class="sw"></span>` +
      `<span class="hname">${e} ${esc(n)}${f && MAP.floors.length > 1 ? `<small class="hfloor">${esc(floorName(f))}</small>` : ''}</span>` +
      `<span class="htier">${lv[1]}</span><b>${HOME[r].backlog || '✓'}</b></a>`;
  }).join('') || `<p class="note hnone">${filt[0] == 'behind' ? 'No room is slacking right now. 🎉' : 'No rooms here.'}</p>`;
  return bar + `<div class="hlist">${rows}</div>`;
}

function homePage(svg, fid, counts, q, color, todo) {
  const legend = LEVELS.map(([, label, c, range, mood]) => `<li title="${mood}"><span class="sw" style="--rc:${c}"></span><b>${label}</b><small>${range}</small></li>`).join('') +
    '<li><span class="sw hallsw"></span>Hallway<small>Between rooms</small></li>' +
    '<li><span class="sw blocksw"></span>Blocked off<small>Not a room</small></li>';
  // Whole house: the overall rank, from every ToDo task in the home (all rooms, the yard and the house itself)
  const [, hn, he] = roomInfo('house'), total = ROOMS.reduce((n, [r]) => n + (HOME[r] ? HOME[r].backlog : 0), 0);
  const hl = levelInfo(tierOf(total)), own = HOME.house.backlog;
  const legendOpen = LEGEND_OPEN;

  const m = $('m');
  if (!m) return;
  m.innerHTML = `<div class="home">
    <div class="mapwrap">
      <div class="maphead">${floorTabs(fid, 'setFloor', counts)}
        <button type="button" class="mapedit" onclick="openEditor()" title="Edit map">${PENCIL_SVG}<span>Edit map</span></button>
      </div>
      ${svg}<div id="tip" class="tip" hidden onclick="tipTap()"></div>
    </div>
    <aside class="hside">
      <a class="hcard" href="/board/" data-tier="${hl[0]}" style="--rc:${hl[2]}" title="Overall rank: ${hl[1]} (${hl[3].toLowerCase()}). Open the Board">
        <span class="hc-e">${he}</span>
        <span><b>${hn}</b> <span class="hrank">${hl[1]}</span><small>${total} to do across the home${own ? ` · ${own} not tied to one room` : ''}</small></span>
        <span class="hc-n">${total}<small>to do</small></span>
      </a>
      <details class="stats-card legendbox"${legendOpen ? ' open' : ''} ontoggle="LEGEND_OPEN = this.open">
        <summary><h3>Legend</h3><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
        <ul class="legend">${legend}</ul>
        <p class="note">Colors rank each room's <b>ToDo</b> tasks${q ? ` matching “${esc(q)}”` : ''}. ${matchMedia('(hover: none)').matches ? 'Tap a room for details; tap it again to open its tasks on the Board.' : 'Hover a room for details; click it to open its tasks on the Board.'} Set a project's room in <a href="/settings/projects/">Settings › Projects</a>, or a single task's room when you edit it.</p>
      </details>
      <div class="stats-card roomsbox"><div class="rhead"><h3>Rooms</h3><select id="rfilt" class="rfilt" aria-label="Show rooms" onchange="setRoomFilter(this.value)">${roomFilterOpts()}</select></div><div id="hrooms">${roomsListHTML()}</div></div>
    </aside>
  </div>`;
  bindRooms();
}

/* ---- map editor: draw your own rooms on each floor ----
   Opened with the ✎ on the Home map. Works on a copy (ED.map) until "Save map".
   Drag a room to move it; drag its corners/edges to resize; arrows move the selected room,
   Shift+arrows resize it. Everything snaps to a GRID-unit grid. */
const GRID = 10, MIN_ROOM = 40;
// [icon, what it's for] — the name shows on hover and is read by screen readers.
// (There's no washing-machine emoji in Unicode; 🫧 and 🧼 stand in for laundry.)
const ROOM_ICONS = [
  ['🛋️', 'Living room'], ['🍳', 'Kitchen'], ['🍽️', 'Dining'], ['🛏️', 'Bedroom'], ['🛁', 'Bathtub'], ['🚿', 'Shower'],
  ['💻', 'Office'], ['📚', 'Library'], ['🎮', 'Games'], ['🧸', 'Kids'], ['🏋️', 'Gym'], ['🪴', 'Plants'],
  ['🎵', 'Music'], ['🎸', 'Guitar'], ['🎹', 'Piano'], ['🍷', 'Wine'], ['🔥', 'Fireplace / furnace'], ['🧊', 'Freezer'],
  ['🫧', 'Washing machine / laundry'], ['🧼', 'Laundry / soap'], ['🧺', 'Laundry basket'], ['🥾', 'Boots / mudroom'], ['👢', 'Boots / entry'], ['🚪', 'Door / closet'],
  ['🛠️', 'Maintenance / workshop'], ['🔧', 'Wrench / repairs'], ['🪛', 'Screwdriver / tools'], ['🪚', 'Saw / woodworking'], ['🧰', 'Toolbox'], ['🧹', 'Cleaning supplies'],
  ['🪣', 'Bucket / utility'], ['🔌', 'Electrical'], ['⚙️', 'Mechanical room'], ['🪜', 'Ladder / basement'], ['🚗', 'Garage'],
];
// Outdoor icons (offered first on the Outside tab)
const OUT_ICONS = [
  ['🌳', 'Trees / yard'], ['🌱', 'Lawn'], ['🌻', 'Garden'], ['🌷', 'Flower bed'], ['🥕', 'Vegetable garden'], ['🛖', 'Shed'],
  ['🏡', 'Front of the house'], ['🚘', 'Driveway'], ['🏊', 'Pool'], ['⛲', 'Fountain / pond'], ['🔥', 'Fire pit'], ['🪵', 'Woodpile'],
  ['🐕', 'Dog run'], ['🐔', 'Chicken coop'], ['🪑', 'Patio / deck'], ['🍖', 'Grill'], ['♻️', 'Bins / compost'], ['🚧', 'Fence'],
];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const snap = v => Math.round(v / GRID) * GRID;
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function openEditor() {
  hideTip();
  ED = { map: withOutside(clone(MAP)), floor: curFloor(), sel: null, drag: null, dirty: false };
  draw();
}

const edRooms = () => ED.map.rooms.filter(r => r.floor == ED.floor);
const edRoom = id => ED.map.rooms.find(r => r.id == id);
function overlaps(a, b) {
  if (a === b || a.floor != b.floor || !(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)) return false;
  if (!a.pts && !b.pts) return true;
  const cb = cellsOf(b);
  for (const c of cellsOf(a)) if (cb.has(c)) return true;
  return false;
}
// Stairs may overlap other stairs (an up flight and a down flight in one stairwell); anything else overlapping is flagged
const edOverlapping = r => ED.map.rooms.some(o => overlaps(r, o) && !coexist(r, o)) || hitsHouse(r, ED.map);

function edFloor(id) {
  ED.floor = id;
  ED.sel = null;
  renderEditor();
}

function renderEditor() {
  const m = $('m');
  if (!m || !ED) return;
  const f = ED.map.floors.find(x => x.id == ED.floor), out = isOutside(ED.floor), vb = viewOf(ED.floor, ED.map);
  const addBtns = out
    ? `<button type="button" class="p edadd" onclick="edAdd()" title="Part of the yard, like the back yard or a garden bed">+ Add yard area</button>
       <button type="button" class="edstructbtn" onclick="edAdd('structure')" title="A building outside the house, like a shed. It can hold tasks.">🛖 + Add structure</button>
       <button type="button" class="edtreebtn" onclick="edAddTree()" title="A large tree: drawn over the yard, but not a place for tasks">🌳 + Add tree</button>`
    : `<button type="button" class="p edadd" onclick="edAdd()">+ Add room to ${esc(f.name)}</button>
       <button type="button" class="edstairsbtn" onclick="edAddStairs()" title="Stairs show solid on this floor and see-through on the floor they lead to">🪜 + Add stairs</button>
       <button type="button" class="edblockbtn" onclick="edAddBlocked()" title="Space inside the walls that isn't a room or a hallway, e.g. over the garage">▨ + Block off an area</button>`;
  m.innerHTML = `<div class="home editing">
    <div class="mapwrap">
      <div class="maphead">${floorTabs(ED.floor, 'edFloor')}<span class="edbadge">Editing</span></div>
      <svg id="edsvg" class="plan edplan${out ? ' outside' : ''}" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" role="application" aria-label="Map editor for ${esc(f.name)}" tabindex="-1"></svg>
      <p class="edhint">${out
        ? 'The house stays in the middle at its real size (edit it on the other tabs). Drag areas, structures and trees to move them; select one, then drag its corners ■ or walls ▬ to resize it. Click the open yard to rename it.'
        : 'Drag a room to move it. Select it, then drag its corners ■ or walls ▬ to reshape it; ⊕ splits a wall so you can move just part of it. Space between rooms shows as hallway.'}
        <span class="kbdhint">Keyboard: Tab to ${out ? 'an item' : 'a room'}, arrows move it, Shift + arrows resize it, Delete removes it.</span></p>
    </div>
    <aside class="hside">
      <div class="stats-card edpanel">
        <h3>Edit map</h3>
        <label for="ed-fname">Floor name</label>
        <input id="ed-fname" value="${esc(f.name)}" maxlength="30" oninput="edFloorName(this.value)">
        <div class="edaddrow">${addBtns}</div>
        ${out ? edLotHTML() : ''}
        <div id="ed-room"></div>
        <details class="edmore"><summary>More options</summary>
          <button type="button" onclick="edClearFloor()">Remove everything on this ${out ? 'tab' : 'floor'}</button>
          <button type="button" onclick="edReset()">Start over with the starter layout</button>
        </details>
        <div class="edactions"><button type="button" onclick="edCancel()">Cancel</button><button type="button" class="p" onclick="edSave()">Save map</button></div>
      </div>
    </aside>
  </div>`;
  edDrawSvg();
  edDrawPanel();
  const svg = $('edsvg');
  svg.addEventListener('pointerdown', edDown);
  svg.addEventListener('pointermove', edMove);
  svg.addEventListener('pointerup', edUp);
  svg.addEventListener('pointercancel', edUp);
  svg.addEventListener('keydown', edKey);
}

// Only the SVG's contents are redrawn while dragging, so the pointer capture on the <svg> survives
function edDrawSvg(focus) {
  const svg = $('edsvg');
  if (!svg) return;
  // the view is fixed during a drag (it can grow Outside), so the pointer keeps mapping to the same spot
  const rooms = edRooms(), ground = ED.floor == ED.map.ground, out = isOutside(ED.floor), vb = ED.drag ? ED.drag.view : viewOf(ED.floor, ED.map);
  if (!ED.drag) svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const ghosts = ED.map.rooms.filter(r => isStairs(r) && r.to == ED.floor);    // stairs coming up/down from another floor
  const fp = houseOutline(ED.map);       // the ground floor's walls, shown on every floor
  // handles stay a usable size on screen however small the map is drawn (bigger for fingers)
  const scale = (svg.getBoundingClientRect().width || vb.w) / vb.w;
  const hs = clampN((matchMedia('(pointer: coarse)').matches ? 22 : 11) / scale, 10, 60);
  const handles = r => HANDLES.map(h => {
    const x = r.x + (h.includes('w') ? 0 : h.includes('e') ? r.w : r.w / 2) - hs / 2;
    const y = r.y + (h.includes('n') ? 0 : h.includes('s') ? r.h : r.h / 2) - hs / 2;
    return `<rect class="handle h-${h}" data-h="${h}" data-rid="${esc(r.id)}" x="${x}" y="${y}" width="${hs}" height="${hs}" rx="3"/>`;
  }).join('');
  // Rooms and blocked-off areas: a handle on every corner (■) and wall (▬), and a ⊕ just outside each
  // longer wall that splits it so one part can be pulled out or in
  const shapeHandles = r => {
    const P = ptsOf(r), n = P.length, rid = esc(r.id);
    let walls = '', splits = '', corners = '';
    P.forEach((a, i) => {
      const b = P[(i + 1) % n];
      if (samePt(a, b)) return;                                 // a fresh split point: nothing to grab yet
      const across = a[1] == b[1], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const side = across ? (my == r.y ? 'n' : my == r.y + r.h ? 's' : '') : (mx == r.x ? 'w' : mx == r.x + r.w ? 'e' : '');
      const w = across ? hs * 1.8 : hs * 0.8, h = across ? hs * 0.8 : hs * 1.8;
      walls += `<rect class="handle wall ${across ? 'hz' : 'vt'}${side ? ' h-' + side : ''}" data-h="e:${i}" data-rid="${rid}" x="${mx - w / 2}" y="${my - h / 2}" width="${w}" height="${h}" rx="${hs * 0.4}"><title>Drag this wall</title></rect>`;
      if (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) >= 4 * GRID) {
        let nx = across ? 0 : 1, ny = across ? 1 : 0;           // point the ⊕ away from the room
        if (pointIn(P, mx + nx * GRID / 2, my + ny * GRID / 2)) { nx = -nx; ny = -ny; }
        const sx = mx + nx * hs * 1.5, sy = my + ny * hs * 1.5, k = hs * 0.25;
        splits += `<g class="handle split" data-h="s:${i}" data-rid="${rid}"><title>Split this wall to reshape part of it</title>` +
          `<circle cx="${sx}" cy="${sy}" r="${hs * 0.5}"/><path d="M${sx - k} ${sy}h${2 * k}M${sx} ${sy - k}v${2 * k}"/></g>`;
      }
    });
    P.forEach((c, k) => {
      if (samePt(c, P[(k + n - 1) % n]) || samePt(c, P[(k + 1) % n])) return;
      const v = (c[1] == r.y ? 'n' : c[1] == r.y + r.h ? 's' : '') + (c[0] == r.x ? 'w' : c[0] == r.x + r.w ? 'e' : '');
      corners += `<rect class="handle corner${v.length == 2 ? ' h-' + v : ''}" data-h="v:${k}" data-rid="${rid}" x="${c[0] - hs / 2}" y="${c[1] - hs / 2}" width="${hs}" height="${hs}" rx="2"><title>Drag this corner</title></rect>`;
    });
    return splits + walls + corners;
  };
  TS = out ? 1.6 : 1;
  // Outside: areas, then structures, then trees on top; the house in the middle can't be selected
  const order = r => (isStructure(r) ? 1 : 0);
  const treeG = t => {
    const sel = t.id == ED.sel;
    return treeSVG(t, `data-rid="${esc(t.id)}" tabindex="0" role="button" aria-label="Tree${t.name ? ': ' + esc(t.name) : ''}, ${t.w} by ${t.h}${sel ? ', selected' : ''}"`)
      .replace('<g class="tree"', `<g class="edroom edtree${sel ? ' sel' : ''}${edOverlapping(t) ? ' overlap' : ''} tree"`);
  };
  svg.innerHTML = `<defs><pattern id="edgrid" width="${GRID * 2}" height="${GRID * 2}" patternUnits="userSpaceOnUse">
      <path d="M ${GRID * 2} 0 L 0 0 0 ${GRID * 2}" fill="none" class="gridline"/></pattern>${HATCH_DEF}</defs>
    <rect class="${ground || out ? 'yard edyard' : 'lot'}" x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" rx="${out ? 28 : 18}"/>
    <rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="url(#edgrid)" pointer-events="none"/>
    ${ground ? gardenSVG(fp, 'garden edgarden') : ''}
    ${fp && !out ? `<rect class="floor" x="${fp.x}" y="${fp.y}" width="${fp.w}" height="${fp.h}" pointer-events="none"/>` : ''}
    ${rooms.filter(isBlocked).map(bk => {
      const sel = bk.id == ED.sel;
      return blockedSVG(bk, `data-rid="${esc(bk.id)}" tabindex="0" role="button" aria-label="Blocked-off area${bk.name ? ': ' + esc(bk.name) : ''}, ${bk.w} by ${bk.h}${sel ? ', selected' : ''}"`)
        .replace('<g class="blocked"', `<g class="edroom edblocked${sel ? ' sel' : ''}${edOverlapping(bk) ? ' overlap' : ''} blocked"`);
    }).join('')}
    ${rooms.filter(r => !isFeature(r)).sort((a, b) => order(a) - order(b)).map(r => {
      const sel = r.id == ED.sel, kind = out ? (isStructure(r) ? ' structure' : ' area') : '';
      return `<g class="edroom${kind}${sel ? ' sel' : ''}${edOverlapping(r) ? ' overlap' : ''}" data-rid="${esc(r.id)}" tabindex="0" role="button"
          aria-label="${esc(r.name || 'Unnamed room')}, ${r.w} by ${r.h}${sel ? ', selected' : ''}">
        ${shapeSVG(r)}${roomLabelSVG({ ...r, ...labelBox(r) })}</g>`;
    }).join('')}
    ${out && fp ? houseBlockSVG(fp, 'pointer-events="none"') : ''}
    ${rooms.filter(isTree).map(treeG).join('')}
    ${edStairsLayer(rooms.filter(isStairs), ghosts)}
    ${fp && !out ? `<rect class="walls" x="${fp.x}" y="${fp.y}" width="${fp.w}" height="${fp.h}" pointer-events="none"/>` : ''}
    ${ED.sel && edRoom(ED.sel) && (edRoom(ED.sel).floor == ED.floor || (isStairs(edRoom(ED.sel)) && edRoom(ED.sel).to == ED.floor))
      ? (isStairs(edRoom(ED.sel)) || isTree(edRoom(ED.sel)) ? handles(edRoom(ED.sel)) : shapeHandles(edRoom(ED.sel))) : ''}
    ${rooms.length ? '' : `<text class="planempty" x="${vb.x + vb.w / 2}" y="${out ? vb.y + 50 : vb.y + vb.h / 2}"${tsStyle(18)}>${out ? 'Nothing outside yet. Add a yard area, a structure, or a tree.' : 'Empty floor. Use “+ Add room” to start.'}</text>`}`;
  TS = 1;
  if (focus) {
    const g = svg.querySelector(`.edroom[data-rid="${CSS.escape(focus)}"]`);
    if (g) g.focus();
  }
}

// Stairs in the editor: flights on this floor plus see-through flights from another floor (which can be
// picked and moved from here too: same spot on both floors). The selected flight is drawn last so it's on top.
function edStairsLayer(own, ghosts) {
  const items = [...ghosts.map(st => ({ st, ghost: true })), ...own.map(st => ({ st, ghost: false }))];
  items.sort((a, b) => (a.st.id == ED.sel) - (b.st.id == ED.sel));
  const layer = stairsLayerSVG(items, ({ st, ghost }) => {
    const sel = st.id == ED.sel;
    const what = ghost ? `Stairs from ${floorName2(st.floor)}` : `Stairs to ${floorName2(st.to)}, ${st.w} by ${st.h}`;
    return `data-rid="${esc(st.id)}" data-cls="edroom edstairs${sel ? ' sel' : ''}${!ghost && edOverlapping(st) ? ' overlap' : ''}" tabindex="0" role="button" aria-label="${esc(what)}${sel ? ', selected' : ''}"`;
  });
  // move the editor classes onto each flight's <g class="stairs…">
  return layer.replace(/<g class="stairs( ghost)?" data-rid="([^"]*)" data-cls="([^"]*)"/g, '<g class="$3 stairs$1" data-rid="$2"');
}

// The side panel: details of the selected room
// Yard size (Outside tab): grow or shrink the property on each side, LOT_STEP units at a time
function edLotHTML() {
  const l = lotOf(ED.map);
  return `<div class="edlot"><p class="edstitle">Yard size</p>` + LOT_SIDES.map(([k, n]) =>
    `<div class="edlotrow"><span>${n}</span><small>${l[k] ? '+' + l[k] : ''}</small>` +
    `<button type="button" class="sm" onclick="edLot('${k}',-1)" ${l[k] ? '' : 'disabled'} aria-label="Less yard ${n.toLowerCase()}" title="Less yard">−</button>` +
    `<button type="button" class="sm" onclick="edLot('${k}',1)" ${l[k] < LOT_MAX ? '' : 'disabled'} aria-label="More yard ${n.toLowerCase()}" title="More yard">+</button></div>`).join('') +
    `<p class="note" id="ed-lotwarn" hidden></p></div>`;
}

function edLot(k, d) {
  const before = lotOf(ED.map), lot = { ...before, [k]: clampN(before[k] + d * LOT_STEP, 0, LOT_MAX) };
  const ob = outBounds({ ...ED.map, lot });
  const cut = ED.map.rooms.filter(r => isOutside(r.floor) && (r.x < ob.x || r.y < ob.y || r.x + r.w > ob.x + ob.w || r.y + r.h > ob.y + ob.h));
  if (cut.length) {
    const w = $('ed-lotwarn');
    w.textContent = `Move or shrink ${cut.map(r => r.name || 'the tree').join(', ')} first: ${cut.length > 1 ? 'they' : 'it'} would be cut off.`;
    w.hidden = false;
    return;
  }
  ED.map.lot = lot;
  ED.dirty = true;
  renderEditor();
  const b = document.querySelector(`.edlot button[onclick="edLot('${k}',${d})"]`);
  if (b && !b.disabled) b.focus();
}

function edDrawPanel() {
  const box = $('ed-room');
  if (!box) return;
  const r = ED.sel && edRoom(ED.sel);
  const warn = edRooms().some(edOverlapping) ? `<p class="note edwarn">Some ${isOutside(ED.floor) ? 'items overlap each other or the house' : 'rooms overlap'} (outlined in red). Drag them apart before saving.</p>` : '';
  if (!r && isOutside(ED.floor)) {             // the open yard: everything outside the house that isn't in an area
    const y = ED.map.yard || {}, cur = y.emoji || '🌳';
    box.innerHTML = `<div class="edsel">
      <p class="edstitle">The rest of the yard</p>
      <label for="ed-yname">Name</label>
      <input id="ed-yname" value="${esc(y.name || 'Yard & exterior')}" maxlength="40" oninput="edYardName(this.value)">
      <p class="note edwarn" id="ed-namewarn" hidden></p>
      <label>Icon</label>
      ${iconGrid(cur, 'edYardIcon')}
      <p class="note">Tasks for anywhere outside (gutters, siding, the whole lot) go here. Select an area, structure, or tree to change it.</p>
    </div>${warn}`;
    return;
  }
  if (!r) {
    box.innerHTML = '<p class="note">Select a room, stairs, or blocked-off area to change or delete it.</p>' + warn;
    return;
  }
  if (isTree(r)) {
    box.innerHTML = `<div class="edsel">
      <p class="edstitle">🌳 Tree</p>
      <label for="ed-bname">Name (optional)</label>
      <input id="ed-bname" value="${esc(r.name || '')}" placeholder="e.g. Oak" maxlength="40" oninput="edBlockName(this.value)">
      <p class="note">Drag its edges to match the canopy. Trees aren't a place for tasks; use the yard area they stand in.</p>
      <p class="note" id="ed-size">${r.w} × ${r.h}${edOverlapping(r) ? ' · <span class="edwarn">overlaps the house</span>' : ''}</p>
      <button type="button" class="red" onclick="edDelete('${esc(r.id)}')">Delete tree</button>
    </div>`;
    return;
  }
  if (isBlocked(r)) {
    box.innerHTML = `<div class="edsel">
      <p class="edstitle">▨ Blocked-off area</p>
      <label for="ed-bname">Label (optional)</label>
      <input id="ed-bname" value="${esc(r.name || '')}" placeholder="e.g. Open to below" maxlength="40" oninput="edBlockName(this.value)">
      <p class="note">Part of the house's outline but not a room or a hallway (for example over the garage, or open to the floor below). It's drawn hatched, and tasks can't be placed here.</p>
      <p class="note" id="ed-size">${r.w} × ${r.h}${edOverlapping(r) ? ' · <span class="edwarn">overlaps a room</span>' : ''}</p>
      ${shapeHint(r)}
      <button type="button" class="red" onclick="edDelete('${esc(r.id)}')">Delete area</button>
    </div>`;
    return;
  }
  if (isStairs(r)) {
    const others = ED.map.floors.filter(f => f.id != r.floor && !isOutside(f.id));
    box.innerHTML = `<div class="edsel">
      <p class="edstitle">🪜 Stairs</p>
      <label for="ed-to">Lead to</label>
      <select id="ed-to" onchange="edStairsTo(this.value)">${others.map(f =>
        `<option value="${esc(f.id)}" ${f.id == r.to ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      <p class="note">Solid on ${esc(floorName2(r.floor))}, and a see-through outline in the same spot on ${esc(floorName2(r.to))}.</p>
      <p class="note" id="ed-size">${r.w} × ${r.h}${edOverlapping(r) ? ' · <span class="edwarn">overlaps a room</span>' : ''}</p>
      ${stairsStacked(r) ? '<p class="note">These stairs share a stairwell with another flight. Click them again (or press Tab) to select the flight underneath.</p>' : ''}
      <div class="edbtnrow">
        <button type="button" onclick="edRotate()" title="Turn the stairs 90° (keyboard: R)">↻ Rotate</button>
        <button type="button" class="red" onclick="edDelete('${esc(r.id)}')">Delete stairs</button>
      </div>
    </div>`;
    return;
  }
  const what = isStructure(r) ? 'Structure' : isOutside(r.floor) ? 'Area' : 'Room';
  box.innerHTML = `<div class="edsel">
      ${isOutside(r.floor) ? `<p class="edstitle">${isStructure(r) ? '🛖 Structure' : '🌱 Yard area'}</p>` : ''}
      <label for="ed-name">${what} name</label>
      <input id="ed-name" value="${esc(r.name)}" maxlength="40" oninput="edRename(this.value)">
      <p class="note edwarn" id="ed-namewarn" hidden></p>
      <label>Icon</label>
      ${iconGrid(r.emoji, 'edIcon')}
      <p class="note" id="ed-size">${r.w} × ${r.h}${edOverlapping(r) ? ` · <span class="edwarn">overlaps ${hitsHouse(r, ED.map) ? 'the house' : 'another ' + what.toLowerCase()}</span>` : ''}</p>
      ${shapeHint(r)}
      <button type="button" class="red" onclick="edDelete('${esc(r.id)}')">Delete ${what.toLowerCase()}</button>
    </div>`;
}

// The icon picker: indoor icons inside, outdoor ones first on the Outside tab
function iconGrid(cur, fn) {
  const icons = isOutside(ED.floor) ? [...OUT_ICONS, ...ROOM_ICONS] : ROOM_ICONS;
  return `<div class="emogrid" role="radiogroup" aria-label="Icon">${icons.map(([e, what]) =>
    `<button type="button" role="radio" aria-checked="${e == cur}" aria-label="${what}" title="${what}" class="${e == cur ? 'on' : ''}" onclick="${fn}('${e}')">${e}</button>`).join('')}</div>`;
}

function edYardName(v) {
  ED.map.yard = { ...(ED.map.yard || {}), name: v };
  ED.dirty = true;
  const warn = $('ed-namewarn');
  const msg = !v.trim() ? 'Give the yard a name.' : nameTaken(v, 'yard') ? 'A room already has this name.' : '';
  warn.textContent = msg;
  warn.hidden = !msg;
}

function edYardIcon(e) {
  ED.map.yard = { ...(ED.map.yard || {}), emoji: e };
  ED.dirty = true;
  edDrawPanel();
}

// Other flights in the same spot (on this floor, or see-through from the floor the stairs lead to)
const stairsStacked = r => ED.map.rooms.some(o => o !== r && isStairs(o) && boxesTouch(o, r) &&
  [o.floor, o.to].some(f => f == r.floor || f == r.to));

function edPoint(e) {
  const svg = $('edsvg'), pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function edDown(e) {
  const h = e.target.closest('[data-h]'), g = e.target.closest('.edroom');
  if (!h && !g) {                                  // empty space: deselect
    ED.sel = null;
    edDrawSvg();
    edDrawPanel();
    return;
  }
  const r = edRoom((h || g).dataset.rid);
  const wasSel = ED.sel === r.id;
  ED.sel = r.id;
  const hk = h ? h.dataset.h : '';
  if (hk.startsWith('s:')) {                       // ⊕: split that wall at its middle (two corners in one spot)
    const P = ptsOf(r).map(q => [...q]), i = +hk.slice(2), a = P[i], b = P[(i + 1) % P.length];
    const m = a[1] == b[1] ? [snap((a[0] + b[0]) / 2), a[1]] : [a[0], snap((a[1] + b[1]) / 2)];
    P.splice(i + 1, 0, [...m], [...m]);
    r.pts = P;
    ED.dirty = true;
    edDrawSvg();
    edDrawPanel();
    return;
  }
  ED.drag = { kind: h ? h.dataset.h : 'move', start: edPoint(e), orig: { ...r }, id: e.pointerId, others: edSnapshot(r),
              bounds: roomBounds(r, ED.map), view: viewOf(ED.floor, ED.map), wasSel, at: [e.clientX, e.clientY], moved: false,
              last: { x: r.x, y: r.y, w: r.w, h: r.h } };      // last spot clear of the house (Outside)
  if (/^[ev]:/.test(hk)) {                          // a wall or corner of a room's outline
    const P = ptsOf(r).map(q => [...q]);
    let idx = +hk.slice(2);
    if (hk[0] == 'e') {                             // a wall next to a straight continuation gets its own corner, so it can move alone
      const n = P.length, a = P[idx], b = P[(idx + 1) % n], prev = P[(idx + n - 1) % n], next = P[(idx + 2) % n];
      const across = a[1] == b[1];
      if (!samePt(next, b) && (across ? next[1] == b[1] : next[0] == b[0])) P.splice(idx + 1, 0, [...b]);
      if (!samePt(prev, a) && (across ? prev[1] == a[1] : prev[0] == a[0])) { P.splice(idx, 0, [...a]); idx++; }
    }
    Object.assign(ED.drag, { kind: hk[0] == 'e' ? 'wall' : 'corner', idx, pts: P });
  }
  $('edsvg').setPointerCapture(e.pointerId);
  e.preventDefault();
  edDrawSvg();
  edDrawPanel();
}

function edMove(e) {
  if (!ED || !ED.drag || e.pointerId !== ED.drag.id) return;
  const p = edPoint(e), d = ED.drag, o = d.orig, r = edRoom(ED.sel);
  const dx = snap(p.x - d.start.x), dy = snap(p.y - d.start.y);
  const b = d.bounds;
  if (d.kind == 'wall' || d.kind == 'corner') {
    if (edReshape(r, d, dx, dy)) d.moved = ED.dirty = true;
    edDrawSvg();
    const size = $('ed-size');
    if (size) size.textContent = `${r.w} × ${r.h}`;
    return;
  }
  if (d.kind == 'move') {
    const at = (x, y) => {
      r.x = x; r.y = y;
      if (o.pts) r.pts = o.pts.map(([px, py]) => [px + x - o.x, py + y - o.y]);
      return !hitsHouse(r, ED.map);
    };
    const nx = clampN(o.x + dx, b.x, b.x + b.w - o.w), ny = clampN(o.y + dy, b.y, b.y + b.h - o.h);
    // blocked by the house: slide along it, else stay at the last clear spot
    if (!at(nx, ny) && !at(nx, d.last.y) && !at(d.last.x, ny)) at(d.last.x, d.last.y);
  } else {
    if (d.kind.includes('e')) r.w = clampN(o.w + dx, MIN_ROOM, b.x + b.w - o.x);
    if (d.kind.includes('s')) r.h = clampN(o.h + dy, MIN_ROOM, b.y + b.h - o.y);
    if (d.kind.includes('w')) { const nx = clampN(o.x + dx, b.x, o.x + o.w - MIN_ROOM); r.w = o.x + o.w - nx; r.x = nx; }
    if (d.kind.includes('n')) { const ny = clampN(o.y + dy, b.y, o.y + o.h - MIN_ROOM); r.h = o.y + o.h - ny; r.y = ny; }
    if (hitsHouse(r, ED.map)) Object.assign(r, { x: d.last.x, y: d.last.y, w: d.last.w, h: d.last.h });
  }
  d.last = { x: r.x, y: r.y, w: r.w, h: r.h };
  edPush(r, d.others);
  if (r.x != o.x || r.y != o.y || r.w != o.w || r.h != o.h) { ED.dirty = true; d.moved = true; }
  edDrawSvg();
  const size = $('ed-size');
  if (size) size.textContent = `${r.w} × ${r.h}`;
}

// Move a wall or a corner of the outline by (dx, dy) from where the drag started. The new outline is used
// only if it's still a proper room (walls don't cross, at least MIN_ROOM across); otherwise the room
// stays at its last good shape. A room that's still a plain rectangle pushes its neighbours as usual.
function edReshape(r, d, dx, dy) {
  const O = d.pts, P = O.map(q => [...q]), n = P.length, b = d.bounds, i = d.idx;
  const X = v => clampN(v, b.x, b.x + b.w), Y = v => clampN(v, b.y, b.y + b.h);
  if (d.kind == 'wall') {
    const j = (i + 1) % n;
    if (O[i][1] == O[j][1]) P[i][1] = P[j][1] = Y(O[i][1] + dy);
    else P[i][0] = P[j][0] = X(O[i][0] + dx);
  } else {
    const a = (i + n - 1) % n, c = (i + 1) % n, nx = X(O[i][0] + dx), ny = Y(O[i][1] + dy);
    if (O[a][1] == O[i][1]) P[a][1] = ny; else P[a][0] = nx;     // the walls on either side follow the corner
    if (O[c][1] == O[i][1]) P[c][1] = ny; else P[c][0] = nx;
    P[i] = [nx, ny];
  }
  const C = cleanPts(P), bx = boxOf(C);
  if (C.length < 4 || !simplePts(C) || bx.w < MIN_ROOM || bx.h < MIN_ROOM) return false;
  if (hitsHouse({ ...bx, floor: r.floor, pts: C.length == 4 ? undefined : C }, ED.map)) return false;
  if (C.length == 4) { delete r.pts; Object.assign(r, bx); edPush(r, d.others); }
  else { r.pts = P; Object.assign(r, bx); edPush(r, d.others); }     // edPush leaves shaped rooms' neighbours alone
  return true;
}

// Positions of the other rooms on this floor when a move/resize starts
function edSnapshot(r) {
  return ED.map.rooms.filter(o => o.floor == r.floor && o.id !== r.id).map(o => ({ ...o }));
}

// Rooms the moved/resized room now covers give way: each is trimmed back to the side that keeps the most
// of it, always starting from where it was when the drag began (so sweeping across a room doesn't leave it
// shrunk). A room that can't give way without getting smaller than MIN_ROOM stays put and shows red.
function edPush(r, before) {
  before.forEach(b => {
    const o = edRoom(b.id);
    if (!o) return;
    Object.assign(o, { x: b.x, y: b.y, w: b.w, h: b.h });
    if (b.pts) o.pts = b.pts;
    // stacked flights are fine; shaped rooms are never trimmed automatically (that would undo the shape)
    if (r.pts || o.pts || !overlaps(r, o) || coexist(r, o)) return;
    const keep = [
      { x: o.x, y: o.y, w: r.x - o.x, h: o.h },                        // the part left of the moved room
      { x: r.x + r.w, y: o.y, w: o.x + o.w - (r.x + r.w), h: o.h },     // right of it
      { x: o.x, y: o.y, w: o.w, h: r.y - o.y },                        // above it
      { x: o.x, y: r.y + r.h, w: o.w, h: o.y + o.h - (r.y + r.h) },     // below it
    ].filter(c => c.w >= MIN_ROOM && c.h >= MIN_ROOM);
    if (keep.length) Object.assign(o, keep.reduce((a, c) => (c.w * c.h > a.w * a.h ? c : a)));
  });
}

function edUp(e) {
  if (!ED || !ED.drag) return;
  const d = ED.drag;
  try { $('edsvg').releasePointerCapture(d.id); } catch (err) { /* already released */ }
  ED.drag = null;
  const er = edRoom(ED.sel);
  if (er && er.pts) settleShape(er);              // tidy the outline (and drop unused split points)
  // a plain click on flights that are already selected picks the next flight stacked underneath
  if (!d.moved && d.wasSel && d.kind == 'move' && isStairs(edRoom(ED.sel))) {
    const under = [...new Set(document.elementsFromPoint(...d.at)
      .map(el => el.closest && el.closest('.edstairs')).filter(Boolean).map(el => el.dataset.rid))];
    if (under.length > 1) ED.sel = under[(under.indexOf(ED.sel) + 1) % under.length];
  }
  edDrawSvg();
  edDrawPanel();
}

// Keyboard: arrows move the focused room a grid step, Shift+arrows resize it, Delete removes it
function edKey(e) {
  const g = e.target.closest && e.target.closest('.edroom');
  if (!g) return;
  const r = edRoom(g.dataset.rid);
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ED.sel = r.id; edDrawSvg(r.id); edDrawPanel(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); edDelete(r.id); return; }
  if ((e.key === 'r' || e.key === 'R') && isStairs(r)) { e.preventDefault(); ED.sel = r.id; edRotate(true); return; }
  const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!step) return;
  e.preventDefault();
  ED.sel = r.id;
  const before = edSnapshot(r), b = roomBounds(r, ED.map);
  if (r.pts) {
    const P = e.shiftKey
      ? r.pts.map(([x, y]) => [x == r.x + r.w ? x + step[0] * GRID : x, y == r.y + r.h ? y + step[1] * GRID : y])
      : r.pts.map(([x, y]) => [x + step[0] * GRID, y + step[1] * GRID]);
    const C = cleanPts(P), bx = boxOf(C);
    if (simplePts(C) && bx.w >= MIN_ROOM && bx.h >= MIN_ROOM && bx.x >= b.x && bx.y >= b.y && bx.x + bx.w <= b.x + b.w && bx.y + bx.h <= b.y + b.h &&
        !hitsHouse({ ...bx, floor: r.floor, pts: C }, ED.map)) {
      r.pts = C;
      settleShape(r);
      ED.dirty = true;
    }
    edDrawSvg(r.id);
    edDrawPanel();
    return;
  }
  const was = { x: r.x, y: r.y, w: r.w, h: r.h };
  if (e.shiftKey) {
    r.w = clampN(r.w + step[0] * GRID, MIN_ROOM, b.x + b.w - r.x);
    r.h = clampN(r.h + step[1] * GRID, MIN_ROOM, b.y + b.h - r.y);
  } else {
    r.x = clampN(r.x + step[0] * GRID, b.x, b.x + b.w - r.w);
    r.y = clampN(r.y + step[1] * GRID, b.y, b.y + b.h - r.h);
  }
  if (hitsHouse(r, ED.map)) Object.assign(r, was);         // Outside: the house is in the way
  edPush(r, before);
  ED.dirty = true;
  edDrawSvg(r.id);
  edDrawPanel();
}

function edFloorName(v) {
  ED.map.floors.find(f => f.id == ED.floor).name = v.trim() || 'Floor';
  ED.dirty = true;
  document.querySelectorAll('.floortabs button.on').forEach(b => { b.textContent = v.trim() || 'Floor'; });
  const add = document.querySelector('button.edadd');
  if (add && !isOutside(ED.floor)) add.textContent = `+ Add room to ${v.trim() || 'Floor'}`;
}

const floorName2 = id => (ED ? ED.map : MAP).floors.find(f => f.id == id)?.name || '';
const nameTaken = (name, exceptId) => [{ id: 'house', name: BUILTIN_ROOMS[0][1] }, { id: 'yard', name: (ED.map.yard || {}).name || 'Yard & exterior' },
  ...ED.map.rooms.filter(r => !isFeature(r))]
  .some(r => r.id !== exceptId && r.name.trim().toLowerCase() === name.trim().toLowerCase());

function edRename(v) {
  const r = edRoom(ED.sel);
  r.name = v;
  ED.dirty = true;
  const warn = $('ed-namewarn');
  const msg = !v.trim() ? 'Give this room a name.' : nameTaken(v, r.id) ? 'Another room already has this name.' : '';
  warn.textContent = msg;
  warn.hidden = !msg;
  edDrawSvg();
}

function edIcon(e) {
  edRoom(ED.sel).emoji = e;
  ED.dirty = true;
  edDrawSvg();
  edDrawPanel();
}

// New rooms go in the first free spot (scanning the house area), named "New room", "New room 2", …
// Outside: yard areas ("New area") and structures ("Shed")
function edAdd(kind) {
  const out = isOutside(ED.floor), struct = kind == 'structure';
  const proto = struct ? { kind: 'structure' } : {};
  const at = edPlace(struct ? [[80, 60], [60, 60], [40, 40]] : out ? [[240, 160], [160, 120], [100, 80], [60, 40]] : [[120, 100], [100, 80], [80, 60], [60, 40]], proto);
  const base = struct ? 'Shed' : out ? 'New area' : 'New room';
  let name = base, n = 2;
  while (nameTaken(name)) name = `${base} ${n++}`;
  const id = newMapId();
  ED.map.rooms.push({ id, name, emoji: struct ? '🛖' : out ? '🌱' : '🚪', floor: ED.floor, ...proto, ...at });
  ED.sel = id;
  ED.dirty = true;
  edDrawSvg();
  edDrawPanel();
  const inp = $('ed-name');
  if (inp) { inp.focus(); inp.select(); }
}

// A free spot on this floor for a w × h box: inside the house first (a gap or hallway), then anywhere
// on the plan, else null
function edFreeSpot(w, h, proto = {}) {
  const rooms = edRooms(), fp = houseOutline(ED.map), ground = ED.floor == ED.map.ground;
  if (isOutside(ED.floor)) {                     // anywhere on the property clear of the house and things of the same kind
    const a = outBounds(ED.map);
    for (let y = a.y + GRID * 2; y + h <= a.y + a.h; y += GRID) {
      for (let x = a.x + GRID * 2; x + w <= a.x + a.w; x += GRID) {
        const c = { x, y, w, h, floor: ED.floor, ...proto };
        if (!hitsHouse(c, ED.map) && !rooms.some(o => overlaps(c, o) && !coexist(c, o))) return { x, y };
      }
    }
    return null;
  }
  // inside the walls first; only the ground floor may spill out onto the rest of the plan
  const areas = [fp, ground || !fp ? { x: 90, y: 80, w: PLAN_W - 110, h: PLAN_H - 100 } : null].filter(Boolean);
  for (const a of areas) {
    for (let y = a.y; y + h <= a.y + a.h; y += GRID) {
      for (let x = a.x; x + w <= a.x + a.w; x += GRID) {
        const c = { x, y, w, h, floor: ED.floor };
        if (!rooms.some(o => overlaps(c, o))) return { x, y };
      }
    }
  }
  return null;
}

// Place a new box: the preferred size if it fits anywhere, else smaller sizes, else the top-left corner
function edPlace(sizes, proto) {
  for (const [w, h] of sizes) {
    const spot = edFreeSpot(w, h, proto);
    if (spot) return { ...spot, w, h };
  }
  if (isOutside(ED.floor)) { const a = outBounds(ED.map), [w, h] = sizes[sizes.length - 1]; return { x: a.x + 20, y: a.y + 20, w, h }; }
  const [w, h] = sizes[0], o = ED.floor != ED.map.ground && houseOutline(ED.map);
  return o ? { x: o.x, y: o.y, w: Math.min(w, o.w), h: Math.min(h, o.h) } : { x: 90, y: 80, w, h };
}

const newMapId = () => 'r' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 4);

// Stairs start out leading to the floor above (or below, from the top floor)
function edAddStairs() {
  const at = edPlace([[60, 120], [120, 60], [40, 80], [80, 40]]), id = newMapId();
  ED.map.rooms.push({ id, kind: 'stairs', name: 'Stairs', emoji: '🪜', floor: ED.floor, to: adjacentFloor(ED.floor, ED.map.floors), ...at });
  ED.sel = id;
  ED.dirty = true;
  edDrawSvg();
  edDrawPanel();
}

// Turn the selected stairs 90° around their centre (kept on the plan and on the grid)
function edRotate(keepFocus) {
  const r = edRoom(ED.sel), before = edSnapshot(r), b = roomBounds(r, ED.map);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  [r.w, r.h] = [Math.min(r.h, b.w), Math.min(r.w, b.h)];
  r.x = clampN(snap(cx - r.w / 2), b.x, b.x + b.w - r.w);
  r.y = clampN(snap(cy - r.h / 2), b.y, b.y + b.h - r.h);
  edPush(r, before);
  ED.dirty = true;
  edDrawSvg(keepFocus ? r.id : undefined);
  edDrawPanel();
}

// Panel help for reshaping, plus a way back to a plain rectangle
function shapeHint(r) {
  return `<p class="note shapehint">Reshape: drag a corner ■ or a wall ▬. Click ⊕ beside a wall to split it, then drag just that part out or in.</p>` +
    (r.pts ? `<button type="button" class="edreset" onclick="edResetShape()">▭ Reset to rectangle</button>` : '');
}

function edResetShape() {
  const r = edRoom(ED.sel);
  delete r.pts;                          // keeps the box around the old outline
  ED.dirty = true;
  edDrawSvg();
  edDrawPanel();
}

// A blocked-off area starts big enough to cover something like the space over a garage
function edAddBlocked() {
  const at = edPlace([[150, 150], [120, 120], [100, 80], [60, 60]]), id = newMapId();
  ED.map.rooms.push({ id, kind: 'blocked', name: '', floor: ED.floor, ...at });
  ED.sel = id;
  ED.dirty = true;
  edDrawSvg();
  edDrawPanel();
}

// A large tree: a round canopy over the yard (not a place for tasks)
function edAddTree() {
  const at = edPlace([[80, 80], [60, 60], [40, 40]], { kind: 'tree' }), id = newMapId();
  ED.map.rooms.push({ id, kind: 'tree', name: '', floor: ED.floor, ...at });
  ED.sel = id;
  ED.dirty = true;
  edDrawSvg();
  edDrawPanel();
}

function edBlockName(v) {
  edRoom(ED.sel).name = v.trim() ? v : '';
  ED.dirty = true;
  edDrawSvg();
}

function edStairsTo(fid) {
  edRoom(ED.sel).to = fid;
  ED.dirty = true;
  edDrawSvg();
  edDrawPanel();
}

// Tasks and projects placed in a room (deleting it moves them to "Whole house")
function roomUse(id) {
  const projects = projs(T, true).filter(p => roomFor(p) == id).length;
  const tasks = T.filter(t => t.room == id).length;
  return { projects, tasks };
}

async function edDelete(id) {
  const r = edRoom(id);
  if (isBlocked(r) || isTree(r)) {
    if (!await ask(isTree(r)
      ? { title: 'Delete this tree?', message: 'It’s removed from the map when you save.', ok: 'Delete tree', danger: true, icon: '🌳' }
      : { title: 'Delete this blocked-off area?', message: 'The space becomes hallway again when you save.', ok: 'Delete area', danger: true, icon: '▨' })) return;
    ED.map.rooms = ED.map.rooms.filter(x => x.id !== id);
    ED.sel = null;
    ED.dirty = true;
    edDrawSvg();
    edDrawPanel();
    return;
  }
  if (isStairs(r)) {
    if (!await ask({ title: 'Delete these stairs?', message: 'They’re removed from both floors when you save.', ok: 'Delete stairs', danger: true, icon: '🪜' })) return;
    ED.map.rooms = ED.map.rooms.filter(x => x.id !== id);
    ED.sel = null;
    ED.dirty = true;
    edDrawSvg();
    edDrawPanel();
    return;
  }
  const u = roomUse(id);
  const used = u.projects || u.tasks
    ? ` ${[u.projects && `${u.projects} project${u.projects == 1 ? '' : 's'}`, u.tasks && `${u.tasks} task${u.tasks == 1 ? '' : 's'}`].filter(Boolean).join(' and ')} use this room and will count toward Whole house instead.`
    : '';
  const what = isStructure(r) ? 'structure' : isOutside(r.floor) ? 'area' : 'room';
  if (!await ask({ title: `Delete “${r.name || 'this ' + what}”?`, message: `It's removed from the map when you save.${used.replace('this room', 'it')}`, ok: `Delete ${what}`, danger: true, icon: '🗑️' })) return;
  ED.map.rooms = ED.map.rooms.filter(x => x.id !== id);
  ED.sel = null;
  ED.dirty = true;
  edDrawSvg();
  edDrawPanel();
}

async function edClearFloor() {
  const n = edRooms().length;
  if (!n || !await ask({ title: 'Remove all rooms on this floor?', message: `${n} room${n == 1 ? '' : 's'} will be removed when you save.`, ok: 'Remove rooms', danger: true, icon: '🧹' })) return;
  ED.map.rooms = ED.map.rooms.filter(r => r.floor != ED.floor);
  ED.sel = null;
  ED.dirty = true;
  renderEditor();
}

async function edReset() {
  if (!await ask({ title: 'Start over?', message: 'Every floor goes back to the starter layout when you save.', ok: 'Use starter layout', danger: true, icon: '↩️' })) return;
  ED.map = withOutside(clone(DEFAULT_MAP));
  ED.floor = ED.map.ground;
  ED.sel = null;
  ED.dirty = true;
  renderEditor();
}

async function edCancel() {
  if (ED.dirty && !await ask({ title: 'Discard map changes?', message: 'Your changes to the map haven’t been saved.', ok: 'Discard', danger: true, icon: '✏️' })) return;
  ED = null;
  draw();
}

async function edSave() {
  const unnamed = ED.map.rooms.find(r => !isFeature(r) && !r.name.trim());
  // for a duplicate name, point at the copy that's new (not on the saved map), not the original room
  const saved = new Set(MAP.rooms.map(r => r.id));
  const dups = ED.map.rooms.filter(r => !isFeature(r) && nameTaken(r.name, r.id));
  const dup = dups.find(r => !saved.has(r.id)) || dups[dups.length - 1];
  const fix = unnamed || dup;
  const y = ED.map.yard;
  if (y && y.name !== undefined && (!y.name.trim() || nameTaken(y.name, 'yard'))) {
    ED.floor = OUT;
    ED.sel = null;
    renderEditor();
    await ask({ title: 'Check the yard’s name', message: y.name.trim() ? `A room is already called “${y.name.trim()}”. Give the yard its own name.` : 'The yard needs a name.', ok: 'OK', info: true });
    return;
  }
  if (fix) {
    ED.floor = fix.floor;
    ED.sel = fix.id;
    renderEditor();
    await ask({ title: 'Check the room names', message: unnamed ? 'Every room needs a name.' : `Two rooms are called “${dup.name}”. Give each room its own name.`, ok: 'OK', info: true });
    return;
  }
  if (ED.map.rooms.some(edOverlapping) &&
      !await ask({ title: 'Some rooms overlap', message: 'Overlapping rooms are outlined in red. Save anyway?', ok: 'Save anyway', icon: '⚠️' })) return;
  ED.map.rooms.forEach(r => { r.name = (r.name || '').trim(); settleShape(r); });
  if (y && y.name) y.name = y.name.trim();
  fitToOutline(ED.map);       // if the ground floor's walls moved, keep the other floors inside them
  ST.map = ED.map;
  // projects placed in rooms that no longer exist go back to their best guess
  const ids = new Set(ED.map.rooms.map(r => r.id));
  Object.keys(ST.rooms || {}).forEach(p => { const r = ST.rooms[p]; if (!BUILTIN_ROOMS.some(b => b[0] == r) && !ids.has(r)) delete ST.rooms[p]; });
  ED = null;
  rebuildRooms();
  await saveST();
  draw();
}

window.addEventListener('beforeunload', e => { if (ED && ED.dirty) { e.preventDefault(); e.returnValue = ''; } });

function tipHTML(r) {
  const [, name, emoji] = roomInfo(r), s = HOME[r], lv = levelInfo(roomLevel(s));
  const projects = Array.from(s.projects);
  return `<b class="tt">${emoji} ${name}</b><span class="tl" style="--rc:${lv[2]}">${lv[1]}</span>` +
    `<div class="tg"><span>To do</span><b>${s.backlog}</b><span>Doing</span><b>${s.doing}</b><span>Done</span><b>${s.done}</b>` +
    `<span>Overdue</span><b class="${s.overdue ? 'od' : ''}">${s.overdue}</b></div>` +
    `<small>${projects.length ? 'Projects: ' + projects.map(esc).join(', ') : 'No projects in this room yet'}</small>` +
    `<small class="tiphint">${TAPPED_ROOM === r ? 'Tap here to open on the Board ›' : 'Click to open on the Board'}</small>`;
}

function showTip(r, e, anchor) {
  const tip = $('tip');
  if (!tip || !HOME[r]) return;
  tip.innerHTML = tipHTML(r);
  tip.hidden = false;
  tip.classList.toggle('tap', TAPPED_ROOM === r);
  if (TAPPED_ROOM === r && anchor) placeTip(anchor.getBoundingClientRect(), e);
  else if (e && e.clientX !== undefined) moveTip(e);
  else if (anchor) {
    const b = anchor.getBoundingClientRect();
    moveTip({ clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 });
  }
}

// Touch: put the details next to the tapped room (below, above, or beside it) so the room stays visible
function placeTip(b, e) {
  const tip = $('tip'), w = tip.offsetWidth, h = tip.offsetHeight, gap = 10, W = innerWidth, H = innerHeight;
  const cx = Math.min(Math.max(8, (e && e.clientX !== undefined ? e.clientX : b.left + b.width / 2) - w / 2), W - w - 8);
  const spots = [[cx, b.bottom + gap], [cx, b.top - h - gap], [b.right + gap, b.top], [b.left - w - gap, b.top]];
  const fits = ([x, y]) => x >= 8 && y >= 8 && x + w <= W - 8 && y + h <= H - 8;
  // a room bigger than the screen: near the finger, on the side with more room
  const [x, y] = spots.find(fits) || [cx, e && e.clientY > H / 2 ? 8 : H - h - 8];
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, Math.min(y, H - h - 8)) + 'px';
}

// Fixed-position tooltip that follows the pointer and stays on screen
function moveTip(e) {
  const tip = $('tip');
  if (!tip || tip.hidden) return;
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}

function hideTip() {
  const tip = $('tip');
  if (tip) tip.hidden = true;
  TAPPED_ROOM = null;
}

// Touch: tapping the details opens that room on the Board
function tipTap() {
  const r = TAPPED_ROOM;
  if (r) location.href = '/board/?room=' + encodeURIComponent(r);
}

function bindRooms(root = document) {
  root.querySelectorAll('.home [data-room], #hrooms [data-room]').forEach(el => {
    const r = el.dataset.room, url = '/board/?room=' + r;
    // hover details are for a mouse or pen; a finger taps instead (below)
    el.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch' && !TAPPED_ROOM) showTip(r, e); });
    el.addEventListener('pointermove', e => { if (e.pointerType !== 'touch' && !TAPPED_ROOM) moveTip(e); });
    el.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && !TAPPED_ROOM) hideTip(); });
    el.addEventListener('focus', () => { if (LAST_POINTER !== 'touch') showTip(r, null, el); });
    el.addEventListener('blur', () => { if (!TAPPED_ROOM) hideTip(); });
    el.addEventListener('click', e => {
      if ((e.pointerType || LAST_POINTER) === 'touch' && TAPPED_ROOM !== r) {   // touch: first tap = details, then tap them (or the room) to open
        e.preventDefault();
        TAPPED_ROOM = r;
        showTip(r, e, el);
        return;
      }
      e.preventDefault();
      location.href = url;
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.href = url; }
    });
  });
}

/* ---- keyboard in dialogs ----
   Tab / Shift+Tab cycle through the open dialog's fields (they don't escape to the page or get stuck),
   and Enter in a one-line field moves to the next field, which is also the "Next" key on phone keyboards. */
function topDialog() {
  const open = Array.from(document.querySelectorAll('dialog[open]'));
  return open.find(d => d.id === 'cd') || open[open.length - 1] || null;   // the confirm box sits on top
}

function focusables(root) {
  return Array.from(root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]'))
    .filter(el => el.tabIndex >= 0 && !el.disabled && el.type !== 'hidden' && el.getClientRects().length);
}

document.addEventListener('keydown', e => {
  const dlg = topDialog();
  if (!dlg) return;
  if (e.key === 'Tab') {
    const f = focusables(dlg);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1], at = document.activeElement;
    if (e.shiftKey && (at === first || !dlg.contains(at))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (at === last || !dlg.contains(at))) { e.preventDefault(); first.focus(); }
  } else if (e.key === 'Enter' && !e.isComposing && e.target.tagName === 'INPUT' &&
             !['checkbox', 'radio', 'button', 'submit', 'color', 'file'].includes(e.target.type) && dlg.contains(e.target)) {
    e.preventDefault();
    const f = focusables(dlg), i = f.indexOf(e.target);
    if (i >= 0 && i < f.length - 1) f[i + 1].focus();
  }
});

/* ---- keyboard: "/" focuses the filter, Esc clears it ---- */
window.addEventListener('keydown', e => {
  const q = $('q');
  if (!q) return;
  if (e.key === '/' && !q.disabled && !e.target.closest('input, textarea, select') && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    q.focus();
  } else if (e.key === 'Escape' && e.target === q) {
    q.value = '';
    q.blur();
    draw();
  }
});

/* ---- touch drag & drop (phones/tablets) ----
   HTML5 drag-and-drop only works with a mouse. On touch: press and hold a card (or a project row in
   Settings › Projects) for a moment, then drag it. A quick swipe still scrolls the page as usual. */
const HOLD_MS = 180;            // long enough to tell a hold from a swipe, short enough to feel instant
let TD = null;              // { el, kind: 'card'|'proj', id, x, y, timer, active, ghost, dx, dy, target, lastY }
let TD_CLICK_BLOCK = 0;     // swallow the click a browser may fire right after a touch drop

document.addEventListener('touchstart', e => {
  if (e.touches.length > 1) return touchCancel();
  const el = e.target.closest('.card, .plist .prow');
  if (!el || e.target.closest('input, select, button, a, textarea')) return;
  const t = e.touches[0];
  const dr = el.draggable;
  el.draggable = false;          // iOS would start its own drag on a long press (no card lifts, only the column lights up)
  TD = {
    el, kind: el.classList.contains('card') ? 'card' : 'proj',
    id: el.classList.contains('card') ? el.id.slice(5) : +el.id.slice(5),
    x: t.clientX, y: t.clientY, active: false, dr
  };
  el.classList.add('pressing');  // gives way under the finger right away, so the hold doesn't feel dead
  TD.timer = setTimeout(touchBegin, HOLD_MS);
}, { passive: true });

document.addEventListener('touchmove', e => {
  if (!TD) return;
  const t = e.touches[0];
  if (!TD.active) {                                 // moved before the hold finished: it's a scroll
    if (Math.hypot(t.clientX - TD.x, t.clientY - TD.y) > 10) touchCancel();
    return;
  }
  e.preventDefault();                               // dragging: don't scroll the page
  touchMoveTo(t.clientX, t.clientY);
}, { passive: false });

document.addEventListener('touchend', () => { if (TD && TD.active) touchDrop(); else touchCancel(); });
document.addEventListener('touchcancel', touchCancel);
document.addEventListener('contextmenu', e => { if (TD) e.preventDefault(); });   // no long-press menu mid-drag
document.addEventListener('click', e => {
  if (Date.now() < TD_CLICK_BLOCK) { e.preventDefault(); e.stopPropagation(); }
}, true);

function touchBegin() {
  if (!TD) return;
  const b = TD.el.getBoundingClientRect();
  const g = TD.el.cloneNode(true);
  g.removeAttribute('id');
  // a card that just appeared still has its slide-in class; that animation would pin the copy to the top-left corner
  g.classList.remove('enter', 'landed', 'completing', 'moving', 'moved', 'pressing', 'flying');
  g.classList.add('touch-ghost');
  g.style.width = b.width + 'px';
  document.body.appendChild(g);
  TD.el.classList.remove('pressing');
  if (!reduceMotion()) {         // lifts off the board
    g.style.scale = '1.04';
    g.style.rotate = TD.kind == 'card' ? '1.5deg' : '0deg';
    g.animate([{ scale: 1, rotate: '0deg' }, { scale: 1.04, rotate: g.style.rotate }], { duration: 160, easing: 'ease-out' });
  }
  Object.assign(TD, { active: true, ghost: g, dx: TD.x - b.left, dy: TD.y - b.top });
  TD.el.classList.add('moving');
  if (TD.kind == 'proj') {
    DRAG_PROJ = TD.id;
    const list = document.querySelector('.plist');
    if (list) list.classList.add('dragging');
  }
  if (TD.kind == 'card') holdOn(TD.el);
  if (TD.mouse) { document.getSelection().removeAllRanges(); document.body.classList.add('lifting'); }
  if (navigator.vibrate) navigator.vibrate(12);
  touchMoveTo(TD.x, TD.y);
  if (TD.kind == 'card') {      // the columns just opened under the finger: nothing is a drop target until it moves
    TD.target = null;
    document.querySelectorAll('.col.over, [data-drop].over').forEach(c => c.classList.remove('over'));
  }
  touchAutoScroll();
}

function touchMoveTo(x, y) {
  TD.lastY = y;
  TD.ghost.style.transform = `translate(${x - TD.dx}px, ${y - TD.dy}px)`;
  const under = document.elementFromPoint(x, y);
  if (TD.kind == 'card') {
    // a column of any open project, or the trash can of the card's own project
    const bin = under && under.closest('.pj.holding [data-drop="del"]');
    const col = bin || (under && under.closest('.col'));
    document.querySelectorAll('.col.over, [data-drop].over').forEach(c => { if (c !== col) c.classList.remove('over'); });
    // over + Task (or any other button): nothing happens on a drop, and the card says so
    const deny = !col && under && under.closest('.pj .pact .pbtn:not(.del)');
    document.querySelectorAll('.pbtn.deny').forEach(b => { if (b !== deny) b.classList.remove('deny'); });
    if (deny) deny.classList.add('deny');
    TD.ghost.classList.toggle('nodrop', !!deny);
    if (col) col.classList.add('over');
    TD.target = col;
  } else {
    const zone = under && under.closest('.pzone');
    if (zone) pzMark(zone, y);
    TD.target = zone;
  }
}

// Scroll the page while the finger rests near the top or bottom edge
function touchAutoScroll() {
  if (!TD || !TD.active) return;
  const edge = 90, y = TD.lastY;
  if (y < edge) window.scrollBy(0, -Math.ceil((edge - y) / 4));
  else if (y > innerHeight - edge) window.scrollBy(0, Math.ceil((y - innerHeight + edge) / 4));
  requestAnimationFrame(touchAutoScroll);
}

function touchDrop() {
  const { kind, id, target, ghost } = TD;
  const before = DROP_BEFORE;
  TD_CLICK_BLOCK = Date.now() + 500;
  if (kind == 'card') {
    // the lifted copy glides into the new column (or back home); a real move keeps the columns open for the landing
    const t = T.find(x => x.id == id), s = target && target.dataset.st;
    if (t && target && target.dataset.drop == 'del') {   // dropped on the trash can: back home, then ask
      TD.ghost = null;
      touchCancel();
      flyTo(ghost, id);
      dropDelete(id);
      return;
    }
    const moving = !!(t && s && t.status != s);
    TD.ghost = null;
    TD.keep = moving;
    touchCancel();
    if (moving) moveTask(id, s, ghost);
    else flyTo(ghost, id);
    return;
  }
  touchCancel();
  if (target) moveProj(PJ[id], +target.dataset.pr, before);
}

function touchCancel() {
  if (!TD) return;
  clearTimeout(TD.timer);
  TD.el.draggable = TD.dr;       // project rows: mouse drag still works on touch laptops
  if (TD.ghost) TD.ghost.remove();
  TD.el.classList.remove('moving', 'pressing');
  document.querySelectorAll('.col.over, [data-drop].over, .pbtn.deny').forEach(c => c.classList.remove('over', 'deny'));
  if (TD.kind == 'proj' && TD.active) pdEnd();
  if (TD.kind == 'card' && !TD.keep) holdOff();
  document.body.classList.remove('lifting');
  TD = null;
}

// Home map: tapping anywhere else closes the room tooltip.
// LAST_POINTER: Safari's click events don't say whether a finger or a mouse made them.
let LAST_POINTER = 'mouse';
document.addEventListener('pointerdown', e => {
  LAST_POINTER = e.pointerType || 'mouse';
  if (!e.target.closest('[data-room], #tip')) hideTip();
});
// tapped-open details are fixed on screen: scrolling the page puts them away
window.addEventListener('scroll', () => { if (TAPPED_ROOM) hideTip(); }, { passive: true });

/* ---- click outside: close any dialog (backdrop) and the date picker ---- */
let downTarget = null;
window.addEventListener('pointerdown', e => {
  downTarget = e.target.tagName === 'DIALOG' ? e.target : null;
});
window.addEventListener('click', e => {
  const t = e.target;
  if (t.tagName === 'DIALOG' && t === downTarget && t.open) {
    if (t.id === 'iw') closeIW();                  // the import wizard asks first, so edits aren't lost
    else t.close();
  }
  downTarget = null;

  // composedPath is captured at click time, so it still works after the picker re-renders itself
  const dp = $('dp');
  if (dp && !dp.hidden && !e.composedPath().some(n => n.classList && n.classList.contains('dpw'))) dp.hidden = true;
});

// Esc in the import wizard also asks before throwing away edits
$('iw').addEventListener('cancel', e => { e.preventDefault(); closeIW(); });
// Esc while the calendar is open closes just the calendar, not the whole task form
$('d').addEventListener('cancel', e => {
  if (!$('dp').hidden) { e.preventDefault(); $('dp').hidden = true; $('u').focus(); }
});
$('lb').addEventListener('keydown', lbKey);
// in quick entry, Tab from the title (or project name) goes straight to "Save & add another"
['t', 'pn'].forEach(id => $(id).addEventListener('keydown', e => {
  if (QUICK && e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); $('addmore').focus(); }
}));
$('d').addEventListener('close', () => { QUICK = false; });
$('u').addEventListener('keydown', dueKey);
$('dp').addEventListener('keydown', dpKey);

load();
