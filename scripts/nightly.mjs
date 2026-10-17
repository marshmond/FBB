// Nightly job: pull game logs for every rostered player (MLB + minors) from the free MLB Stats API,
// score them per league, write recaps (Claude if ANTHROPIC_API_KEY is set, otherwise templates).
// Usage: node scripts/nightly.mjs [YYYY-MM-DD]   (default: yesterday, US Eastern)
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const API = 'https://statsapi.mlb.com/api/v1';
const SPORTS = '1,11,12,13,14,16'; // MLB, AAA, AA, High-A, A, Rookie
const MODEL = process.env.RECAP_MODEL || 'claude-sonnet-5-5';
const DAYS = 'docs/data/days';

const easternDate = (offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(Date.now() + offsetDays * 864e5));
const date = process.argv[2] || easternDate(-1);
const season = date.slice(0, 4);

const getJson = async (url) => {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    await new Promise((s) => setTimeout(s, 1000 * (i + 1)));
  }
  throw new Error(`Failed: ${url}`);
};

// ---------- ids ----------
const idCachePath = 'config/id-cache.json';
const idCache = existsSync(idCachePath) ? JSON.parse(await readFile(idCachePath, 'utf8')) : {};
async function resolveId(p) {
  if (p.mlbId) return p.mlbId;
  if (idCache[p.name]) return idCache[p.name];
  const j = await getJson(`${API}/people/search?names=${encodeURIComponent(p.name)}&sportIds=${SPORTS}`);
  const hits = (j.people || []).sort((a, b) => Number(b.active) - Number(a.active));
  if (!hits.length) { console.warn(`! no match for "${p.name}" - add mlbId`); return null; }
  if (hits.length > 1) console.warn(`! "${p.name}" matched ${hits.length} people, using ${hits[0].id}; add mlbId to be sure`);
  return (idCache[p.name] = hits[0].id);
}

// ---------- stats ----------
const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));
const outsOf = (ip) => { const [w, f = '0'] = String(ip ?? 0).split('.'); return num(w) * 3 + num(f); };
const ipOf = (outs) => `${Math.floor(outs / 3)}.${outs % 3}`;

const blankBat = () => ({ g: 0, pa: 0, ab: 0, h: 0, doubles: 0, triples: 0, homeRuns: 0, runs: 0, rbi: 0, baseOnBalls: 0, strikeOuts: 0, stolenBases: 0, caughtStealing: 0, hitByPitch: 0 });
const blankPit = () => ({ g: 0, gs: 0, outs: 0, h: 0, runs: 0, earnedRuns: 0, homeRuns: 0, baseOnBalls: 0, strikeOuts: 0, hitBatsmen: 0, wins: 0, losses: 0, saves: 0, holds: 0, qs: 0, qa7: 0 });
const blankField = () => ({ assists: 0, errors: 0, passedBalls: 0, csa: 0, sba: 0 });

function addBat(t, s) {
  t.g++; t.pa += num(s.plateAppearances); t.ab += num(s.atBats); t.h += num(s.hits);
  for (const k of ['doubles', 'triples', 'homeRuns', 'runs', 'rbi', 'baseOnBalls', 'strikeOuts', 'stolenBases', 'caughtStealing', 'hitByPitch']) t[k] += num(s[k]);
}
function addPit(t, s) {
  t.g++; t.gs += num(s.gamesStarted); t.outs += outsOf(s.inningsPitched);
  t.h += num(s.hits); t.runs += num(s.runs); t.earnedRuns += num(s.earnedRuns); t.homeRuns += num(s.homeRuns);
  t.baseOnBalls += num(s.baseOnBalls); t.strikeOuts += num(s.strikeOuts); t.hitBatsmen += num(s.hitBatsmen);
  for (const k of ['wins', 'losses', 'saves', 'holds']) t[k] += num(s[k]);
  { // Fantrax QA7: 4.0-4.2 IP <=1 ER, 5.0-6.2 IP <=2 ER, 7+ IP <=3 ER
    const o = outsOf(s.inningsPitched), er = num(s.earnedRuns);
    if ((o >= 12 && o <= 14 && er <= 1) || (o >= 15 && o <= 20 && er <= 2) || (o >= 21 && er <= 3)) t.qa7++;
  }
  if (num(s.gamesStarted) && outsOf(s.inningsPitched) >= 18 && num(s.earnedRuns) <= 3) t.qs++;
}
// Fantrax fielding scoring: errors for any non-pitcher, assists for C/OF, PB/CSA/SBA for catchers.
function addField(t, s) {
  const pos = s.position?.abbreviation;
  if (pos === 'P') return;
  t.errors += num(s.errors);
  if (pos === 'C' || ['LF', 'CF', 'RF', 'OF'].includes(pos)) t.assists += num(s.assists);
  if (pos === 'C') { t.passedBalls += num(s.passedBall); t.csa += num(s.caughtStealing); t.sba += num(s.stolenBases); }
}
const finishBat = (t) => ({ ...t, singles: t.h - t.doubles - t.triples - t.homeRuns,
  avg: t.ab ? (t.h / t.ab).toFixed(3).replace(/^0/, '') : '---' });
const finishPit = (t) => ({ ...t, inningsPitched: ipOf(t.outs),
  era: t.outs ? ((t.earnedRuns * 27) / t.outs).toFixed(2) : '-.--',
  whip: t.outs ? (((t.h + t.baseOnBalls) * 3) / t.outs).toFixed(2) : '-.--' });

async function playerStats(id) {
  const mk = () => ({ bat: blankBat(), pit: blankPit(), field: blankField() });
  const out = { info: null, day: mk(), season: mk(), mlbDay: mk(), mlbSeason: mk(), games: [] };
  const person = (await getJson(`${API}/people/${id}?hydrate=currentTeam`)).people?.[0];
  out.info = { id, name: person?.fullName, age: person?.currentAge, pos: person?.primaryPosition?.abbreviation, team: person?.currentTeam?.name };
  const adders = { hitting: ['bat', addBat], pitching: ['pit', addPit], fielding: ['field', addField] };
  for (const group of Object.keys(adders)) {
    const [kind, add] = adders[group];
    const j = await getJson(`${API}/people/${id}/stats?stats=gameLog&group=${group}&season=${season}&sportIds=${SPORTS}`);
    for (const split of j.stats?.[0]?.splits || []) {
      if (split.date > date) continue;
      const mlb = split.sport?.abbreviation === 'MLB';
      const touch = (t) => (kind === 'field' ? addField(t, split.stat) : add(t, split.stat));
      touch(out.season[kind]); if (mlb) touch(out.mlbSeason[kind]);
      if (split.date === date) {
        touch(out.day[kind]); if (mlb) touch(out.mlbDay[kind]);
        if (kind !== 'field') out.games.push({ kind, level: split.sport?.abbreviation, team: split.team?.name, opp: split.opponent?.name,
          home: split.isHome, win: split.isWin, line: split.stat.summary, ip: split.stat.inningsPitched, stat: split.stat });
      }
    }
  }
  for (const w of ['day', 'season', 'mlbDay', 'mlbSeason']) { out[w].bat = finishBat(out[w].bat); out[w].pit = finishPit(out[w].pit); }
  out.played = out.games.length > 0;
  return out;
}

function points(scoring, s) {
  if (!scoring) return null;
  let p = 0;
  for (const [key, w] of Object.entries(scoring)) {
    const [kind, stat] = key.split('.');
    const src = { bat: s.bat, pit: s.pit, field: s.field }[kind];
    const v = stat === 'inningsPitched' ? src.outs / 3 : src[stat];
    p += (v || 0) * w;
  }
  return Math.round(p * 100) / 100;
}

// ---------- recaps ----------
function lineText(p) {
  const bits = p.games.map((g) => g.kind === 'pit'
    ? `${g.level} ${g.ip} IP, ${g.stat.earnedRuns} ER, ${g.stat.strikeOuts} K${g.stat.wins ? ' (W)' : g.stat.losses ? ' (L)' : g.stat.saves ? ' (SV)' : ''}`
    : `${g.level} ${g.line}`);
  return `${p.info.name}: ${bits.join('; ')}`;
}
const templateRecap = (players) => {
  const played = players.filter((p) => p.played);
  return played.length ? played.map(lineText).join('. ') + '.' : 'No one on this roster played last night.';
};
async function claudeRecap(team, players) {
  const played = players.filter((p) => p.played);
  if (!played.length) return 'No one on this roster played last night.';
  const facts = played.map((p) => `${lineText(p)} | fantasy pts: ${p.pts ?? 'n/a'}`).join('\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: 'user', content:
      `Write a punchy 3-5 sentence nightly fantasy baseball recap for my team "${team}" for ${date}. ` +
      `Lead with the biggest performances, flag minor leaguers (levels like AAA/AA) as prospects, mention notable duds briefly. ` +
      `Use only these facts, do not invent anything:\n${facts}` }] }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${await r.text()}`);
  return (await r.json()).content.map((c) => c.text || '').join('').trim();
}

// ---------- main ----------
const files = (await readdir('config/leagues')).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
const cfg = { leagues: await Promise.all(files.map(async (f) => JSON.parse(await readFile(`config/leagues/${f}`, 'utf8')))) };
const cache = new Map();
const result = { date, generatedAt: new Date().toISOString(), leagues: [] };

for (const lg of cfg.leagues) {
  const players = [];
  for (const p of lg.players) {
    const id = await resolveId(p);
    if (!id) continue;
    if (!cache.has(id)) cache.set(id, await playerStats(id));
    const st = cache.get(id);
    players.push({ ...st, slot: p.slot || 'active', bench: (p.slot || 'active') !== 'active', pts: points(lg.scoring, st.mlbDay), seasonPts: points(lg.scoring, st.mlbSeason) });
  }
  const total = lg.scoring ? Math.round(players.filter((p) => !p.bench).reduce((a, p) => a + (p.pts || 0), 0) * 100) / 100 : null;
  let recap;
  try { recap = process.env.ANTHROPIC_API_KEY ? await claudeRecap(lg.name, players) : templateRecap(players); }
  catch (e) { console.warn('Recap fallback:', e.message); recap = templateRecap(players); }
  result.leagues.push({ id: lg.id, name: lg.name, platform: lg.platform, scored: !!lg.scoring, totalPts: total, recap, players });
}

await mkdir(DAYS, { recursive: true });
await writeFile(`${DAYS}/${date}.json`, JSON.stringify(result));
await writeFile(idCachePath, JSON.stringify(idCache, null, 2));
const dates = (await readdir(DAYS)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort().reverse();
await writeFile('docs/data/index.json', JSON.stringify({ dates }));
console.log(`Wrote ${date}: ${result.leagues.map((l) => `${l.name} (${l.players.length} players)`).join(', ')}`);
