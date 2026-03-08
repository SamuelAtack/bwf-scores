// BWF Proxy Worker — Cloudflare Worker
// KV binding: BWF_KV
//
// Endpoints:
//   GET /data                                         — All England KV cache
//   GET /refresh                                      — Re-cache All England
//   GET /fetch?tmtId=5227&date=YYYY-MM-DD&drawCode=1  — Proxy any tournament by numeric ID
//   GET /tmtcode?tmtId=5227                           — Look up UUID from numeric ID

const DRAWS = ['1','2','3','4','5'];
const BWF_API  = 'https://extranet-lv.bwfbadminton.com/api/tournaments/day-matches';
const BWF_LIST = 'https://extranet-lv.bwfbadminton.com/api/tournaments';

const ALL_ENGLAND = {
  code:  '1A1AB550-BF1E-4CE9-A774-82414E3D4405',
  dates: ['2026-03-03','2026-03-04','2026-03-05','2026-03-06','2026-03-07','2026-03-08'],
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

const HDRS = {
  'Accept':     'application/json',
  'Referer':    'https://bwfworldtour.bwfbadminton.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Origin':     'https://bwfworldtour.bwfbadminton.com',
};

const ok  = d  => new Response(JSON.stringify(d), { headers: CORS });
const raw = t  => new Response(t, { headers: CORS });
const err = (m, s=500) => new Response(JSON.stringify({ error: m }), { status: s, headers: CORS });

// Fetch one day+draw from BWF by UUID
async function fetchDay(tmtCode, date, drawCode) {
  // drawCode is optional — omitting it returns all draws for the day (more reliable)
  const dcParam = drawCode ? `&drawCode=${drawCode}` : '';
  const url = `${BWF_API}?tournamentCode=${tmtCode}&date=${date}${dcParam}&order=2&court=0`;
  const r = await fetch(url, { headers: HDRS });
  if (!r.ok) return [];
  const data = await r.json();
  const items = data.results || data.matches || data || [];
  return Array.isArray(items) ? items : Object.values(items);
}

// Resolve numeric tmtId → UUID tmtCode, using KV cache
async function resolveCode(tmtId, env) {
  const cacheKey = `tmtcode-${tmtId}`;
  const cached = await env.BWF_KV.get(cacheKey, 'text');
  if (cached) return cached;

  // Try BWF list endpoint
  const r = await fetch(`${BWF_LIST}?season=2026`, { headers: HDRS });
  if (!r.ok) return null;
  const data = await r.json();
  const list = data.results || data || [];
  for (const t of list) {
    // Cache every tournament we find while we're here
    const id   = t.id || t.tournamentId;
    const code = t.code || t.tournamentCode;
    if (id && code) await env.BWF_KV.put(`tmtcode-${id}`, code, { expirationTtl: 86400 * 30 });
    if (String(id) === String(tmtId)) return code;
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });

    if (path === '/')
      return new Response('BWF Proxy', { headers: { 'Content-Type': 'text/plain' } });

    // ── /tmtcode?tmtId=X ────────────────────────────────────────────────────
    // Returns the UUID for a numeric tournament ID (cached in KV)
    if (path === '/tmtcode') {
      const tmtId = url.searchParams.get('tmtId');
      if (!tmtId) return err('Missing tmtId', 400);
      const code = await resolveCode(tmtId, env);
      if (!code) return err(`Could not resolve tmtCode for tmtId=${tmtId}`, 404);
      return ok({ tmtId, tmtCode: code });
    }

    // -- /fetch?tmtCode=X&date=Y&drawCode=Z ---------------------------------
    // CORS proxy -- accepts tmtCode directly, or resolves from tmtId fallback
    if (path === '/fetch') {
      const date     = url.searchParams.get('date');
      const drawCode = url.searchParams.get('drawCode');
      let   tmtCode  = url.searchParams.get('tmtCode');
      const tmtId    = url.searchParams.get('tmtId');

      if (!date) return err('Required: date', 400);
      if (!tmtCode && tmtId) tmtCode = await resolveCode(tmtId, env);
      if (!tmtCode) return err('Could not determine tmtCode', 400);

      try {
        const results = await fetchDay(tmtCode, date, drawCode);
        return ok({ results, drawCode, date });
      } catch (e) {
        return err(e.message);
      }
    }

    // ── /data ────────────────────────────────────────────────────────────────
    if (path === '/data') {
      const single = await env.BWF_KV.get('matches', 'text');
      if (single) return raw(single);

      // Fallback: old per-draw key format
      const allMatches = {};
      for (const d of DRAWS) {
        const r = await env.BWF_KV.get(d, 'text');
        if (r) { try { allMatches[d] = JSON.parse(r); } catch {} }
      }
      if (Object.keys(allMatches).length) return ok({ matches: allMatches });

      return ok({ matches: {} });
    }

    // ── /refresh ─────────────────────────────────────────────────────────────
    if (path === '/refresh') {
      const allMatches = { '1':{}, '2':{}, '3':{}, '4':{}, '5':{} };
      const tasks = [];
      for (const date of ALL_ENGLAND.dates) {
        for (const draw of DRAWS) {
          tasks.push(
            fetchDay(ALL_ENGLAND.code, date, draw).then(items => {
              items.forEach(m => {
                const dc  = String(m.drawCode || draw);
                // Use roundName+code as key to prevent cross-round collisions
                const key = `${m.roundName||'X'}_${m.code||m.id||''}`;
                if (key !== 'X_' && allMatches[dc]) allMatches[dc][key] = m;
              });
            }).catch(() => {})
          );
        }
      }
      await Promise.all(tasks);
      await env.BWF_KV.put('matches', JSON.stringify({ matches: allMatches }));
      return ok({ ok: true, counts: Object.fromEntries(
        Object.entries(allMatches).map(([k,v]) => [k, Object.keys(v).length])
      )});
    }

    // ── /peek — return first 3 matches of one day raw, for debugging draw structure
    if (path === '/peek') {
      const tmtCode = url.searchParams.get('tmtCode');
      const date    = url.searchParams.get('date') || '2026-01-11';
      if (!tmtCode) return err('Required: tmtCode', 400);
      try {
        const items = await fetchDay(tmtCode, date, null);
        const sample = items.slice(0, 5).map(m => ({
          code: m.code, drawCode: m.drawCode, drawName: m.drawName,
          roundName: m.roundName, matchStatus: m.matchStatus, winner: m.winner,
          t1: m.team1?.players?.map(p=>p.nameShort2||p.lastName),
          t2: m.team2?.players?.map(p=>p.nameShort2||p.lastName),
        }));
        // Count by draw+round
        const byDraw = {};
        items.forEach(m => {
          const k = `${m.drawCode}(${m.drawName})`;
          if (!byDraw[k]) byDraw[k] = {};
          byDraw[k][m.roundName] = (byDraw[k][m.roundName]||0)+1;
        });
        return ok({ total: items.length, byDraw, sample });
      } catch(e) { return err(e.message); }
    }

    return err('Not found', 404);
  },
};
