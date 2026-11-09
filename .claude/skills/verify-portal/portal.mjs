// Portal Sol verification helper. Usage: node portal.mjs reset | log [accId] | state <accId> <from> <to>
const BASE = process.env.PORTAL_BASE_URL ?? 'http://localhost:4000';
const KEY = process.env.PORTAL_API_KEY ?? 'sol-demo-key';
const [cmd, ...args] = process.argv.slice(2);

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

if (cmd === 'reset') {
  console.log(res(await fetch(`${BASE}/__admin/reset`, { method: 'POST' })));
} else if (cmd === 'log') {
  const { requests } = await json(await fetch(`${BASE}/__admin/requests`));
  const acc = args[0];
  const rows = acc ? requests.filter((r) => r.path.includes(`/${acc}`)) : requests;
  const byStatus = {};
  // The admin log does not record the Retry-After header we received, so we can only show the
  // time elapsed since the previous 429 (the exact check lives in the AC6 integration test).
  let last429 = null;
  for (const r of rows) {
    const key = r.status ?? 'disconnected';
    byStatus[key] = (byStatus[key] ?? 0) + 1;
    const t = Date.parse(r.timestamp);
    const since429 = last429 === null ? '' : `\t+${((t - last429) / 1000).toFixed(1)}s since last 429`;
    const b = r.body ? `${r.body.from}..${r.body.to} avail=${r.body.available} price=${r.body.pricePerNight}` : '';
    console.log(`${r.id}\t${r.timestamp}\t${r.method} ${r.path}\t${b}\t${r.status ?? 'disconnected'}\t${r.durationMs}ms${since429}`);
    if (r.status === 429) last429 = t;
  }
  console.log('\nby status:', byStatus, `total: ${rows.length}`);
} else if (cmd === 'state') {
  const [acc, from, to] = args;
  if (!acc) throw new Error('usage: state <accId> [from] [to]');
  const qs = from ? `?from=${from}&to=${to ?? from}` : '';
  const res = await fetch(`${BASE}/api/v1/accommodations/${acc}${qs}`, { headers: { 'X-Api-Key': KEY } });
  const body = await json(res);
  if (res.status !== 200) { console.log(res.status, body); process.exit(1); }
  for (const d of body.days) console.log(`${d.date}\tavailable=${d.available}\tprice=${d.pricePerNight}`);
} else {
  console.log('usage: node portal.mjs reset | log [accId] | state <accId> [from] [to]');
  process.exit(1);
}

function res(r) { return `${r.status} ${r.statusText}`; }
