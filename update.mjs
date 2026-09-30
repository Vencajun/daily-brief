// 데일리 브리프 로봇: 주제별 뉴스와 DART 공시를 모아 news.json, disclosures.json 을 갱신합니다.
// 외부 라이브러리 없이 Node.js 20 이상에서 동작합니다.
// 키가 없으면 그 부분만 건너뜁니다: DART_API_KEY(공시), NAVER_CLIENT_ID/SECRET(네이버 뉴스), ANTHROPIC_API_KEY(AI 요약).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const P = f => path.join(ROOT, f);
const env = k => (process.env[k] || "").trim();

/* ---------- 공통 도구 ---------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s = "") {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#"
      ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : (ENT[e.toLowerCase()] ?? m))
    .replace(/\s+/g, " ").trim();
}
export const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3);
export const kstDate = (d = new Date()) => kst(d).toISOString().slice(0, 10);
export const titleKey = t => t.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase().slice(0, 40);
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const readJson = async (f, d) => { try { return JSON.parse(await readFile(P(f), "utf8")); } catch { return d; } };
const writeJson = (f, v) => writeFile(P(f), JSON.stringify(v, null, 2) + "\n");

/* ---------- 뉴스 수집 ---------- */
export function parseGoogleRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const get = t => { const r = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`)); return r ? r[1] : ""; };
    const source = decode(get("source"));
    let title = decode(get("title"));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const pub = new Date(decode(get("pubDate"))), url = decode(get("link"));
    if (title && url && !isNaN(pub)) out.push({ title, url, source: source || hostOf(url), published: pub.toISOString() });
  }
  return out;
}
export function parseNaver(json) {
  return (json.items || []).map(it => {
    const url = it.originallink || it.link, pub = new Date(it.pubDate);
    return { title: decode(it.title), url, source: hostOf(url), published: isNaN(pub) ? null : pub.toISOString(), snippet: decode(it.description) };
  }).filter(i => i.title && i.url && i.published);
}
async function fetchGoogle(q) {
  const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:2d")}&hl=ko&gl=KR&ceid=KR:ko`, { headers: { "User-Agent": "Mozilla/5.0 daily-brief-bot" } });
  if (!res.ok) throw new Error(`Google 뉴스 ${res.status}`);
  return parseGoogleRss(await res.text());
}
async function fetchNaver(q) {
  if (!env("NAVER_CLIENT_ID") || !env("NAVER_CLIENT_SECRET")) return [];
  const res = await fetch(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(q)}&display=100&sort=date`,
    { headers: { "X-Naver-Client-Id": env("NAVER_CLIENT_ID"), "X-Naver-Client-Secret": env("NAVER_CLIENT_SECRET") } });
  if (!res.ok) throw new Error(`네이버 뉴스 ${res.status}`);
  return parseNaver(await res.json());
}

/* 같은 소식 묶기: 제목 단어가 많이 겹치면 한 묶음. 포털 주소는 대표 기사로 쓰지 않는다 */
const PORTALS = ["v.daum.net", "news.daum.net", "n.news.naver.com", "news.naver.com", "m.news.naver.com"];
const isPortal = a => PORTALS.some(p => (a.source || "").includes(p) || hostOf(a.url).endsWith(p));
const words = t => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length >= 2));
const similar = (a, b) => { let n = 0; a.forEach(w => { if (b.has(w)) n++; }); return n / Math.max(1, Math.min(a.size, b.size)); };
export function groupArticles(articles) {
  const groups = [];
  for (const a of articles) {
    const w = words(a.title);
    let g = null, best = 0.6;
    for (const c of groups) { const v = similar(c.w, w); if (c.lead.source !== a.source && v >= best) { best = v; g = c; } }
    if (!g) { groups.push({ lead: a, w, rest: [] }); continue; }
    if (g.rest.some(r => r.source === a.source)) continue;
    if (isPortal(g.lead) && !isPortal(a)) { g.rest.push(g.lead); g.lead = a; } else g.rest.push(a);
  }
  return groups;
}
export function filterNew(all, topic, seen, lookbackHours, now = Date.now()) {
  const since = now - lookbackHours * 3600e3, ex = (topic.exclude || []).map(w => w.toLowerCase());
  const keys = new Set(seen.keys), urls = new Set(seen.urls), out = [];
  for (const a of [...all].sort((x, y) => y.published.localeCompare(x.published))) {
    const t = new Date(a.published).getTime();
    if (t < since || t > now + 3600e3 || ex.some(w => a.title.toLowerCase().includes(w))) continue;
    const k = titleKey(a.title);
    if (keys.has(k) || urls.has(a.url)) continue;
    keys.add(k); urls.add(a.url); out.push(a);
  }
  return out;
}
async function collectTopic(topic, seen, cfg) {
  const all = [];
  for (const q of topic.queries) for (const [name, fn] of [["google", fetchGoogle], ["naver", fetchNaver]]) {
    try { all.push(...(await fn(q)).map(a => ({ ...a, q }))); } catch (e) { console.warn(`[${topic.id}/${name}] "${q}" 실패: ${e.message}`); }
  }
  const fresh = filterNew(all, topic, seen, cfg.lookbackHours || 36);
  // 묶이면서 빠지는 기사도 다음 실행에서 다시 들어오지 않게 모두 본 것으로 기록
  fresh.forEach(a => { seen.keys.push(titleKey(a.title)); seen.urls.push(a.url); });
  return groupArticles(fresh).map(({ lead, rest }) => ({
    topic: topic.id, date: kstDate(new Date(lead.published)), title: lead.title, url: lead.url, source: lead.source,
    published: lead.published, q: lead.q || "", snippet: lead.snippet || "",
    related: rest.slice(0, 4).map(r => ({ title: r.title, url: r.url, source: r.source })),
    weight: 1 + rest.length
  })).sort((a, b) => b.weight - a.weight || b.published.localeCompare(a.published)).slice(0, cfg.maxNewsPerTopic || 40);
}

/* ---------- 선택: AI 한 줄 요약 (ANTHROPIC_API_KEY 가 있을 때만) ---------- */
async function aiSummaries(topic, items, cfg) {
  if (!env("ANTHROPIC_API_KEY") || !items.length) return;
  const list = items.map((a, i) => `[${i}] ${a.title} | ${a.source}${a.snippet ? ` | ${a.snippet.slice(0, 160)}` : ""}`).join("\n");
  const prompt = `너는 "${topic.name}" 분야 뉴스 편집자다. 아래 기사마다 한국어로 무슨 일인지 한 문장(60자 이내)을 새로 쓴다. 제목과 발췌에 없는 사실은 쓰지 않고, 투자 판단이나 주가 전망은 쓰지 않는다. JSON 하나로만 답한다: {"s":{"0":"요약", "1":"요약"}}\n\n${list}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 3000, messages: [{ role: "user", content: prompt }] })
    });
    if (!res.ok) { console.warn(`Claude API ${res.status}: ${await res.text()}`); return; }
    const text = ((await res.json()).content || []).map(c => c.text || "").join("").replace(/```json|```/g, "");
    const r = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    items.forEach((a, i) => { if (r.s?.[i]) a.summary = String(r.s[i]).slice(0, 120); });
  } catch (e) { console.warn(`AI 요약 건너뜀: ${e.message}`); }
}

/* ---------- DART 공시 ---------- */
const ymd = d => kst(d).toISOString().slice(0, 10).replace(/-/g, "");
export function classifyDisclosure(d, dartCfg) {
  const hits = [];
  for (const [topic, kws] of Object.entries(dartCfg.reportKeywords || {})) {
    const k = kws.find(k => d.report_nm.replace(/\s/g, "").includes(k.replace(/\s/g, "")));
    if (k) hits.push({ topic, reason: k });
  }
  for (const [topic, corps] of Object.entries(dartCfg.watch || {})) {
    if (!corps.includes(d.corp_name)) continue;
    const k = (dartCfg.watchReports || []).find(k => d.report_nm.replace(/\s/g, "").includes(k.replace(/\s/g, "")));
    if (k && !hits.some(h => h.topic === topic)) hits.push({ topic, reason: `감시 기업, ${k}` });
  }
  return hits;
}
async function fetchDart(dartCfg) {
  const key = env("DART_API_KEY");
  if (!key) { console.log("DART_API_KEY 없음: 공시 수집 건너뜀"); return []; }
  const now = new Date(), from = new Date(now.getTime() - 2 * 864e5), out = [];
  for (let page = 1, total = 1; page <= total && page <= 60; page++) {
    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${key}&bgn_de=${ymd(from)}&end_de=${ymd(now)}&page_no=${page}&page_count=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`DART ${res.status}`);
    const j = await res.json();
    if (j.status === "013") break; // 조회된 데이터 없음
    if (j.status !== "000") throw new Error(`DART 응답 ${j.status}: ${j.message}`);
    total = j.total_page || 1;
    for (const d of j.list || []) for (const h of classifyDisclosure(d, dartCfg)) out.push({
      topic: h.topic, reason: h.reason, corp: d.corp_name, report: d.report_nm.trim(),
      date: `${d.rcept_dt.slice(0, 4)}-${d.rcept_dt.slice(4, 6)}-${d.rcept_dt.slice(6, 8)}`,
      market: { Y: "코스피", K: "코스닥", N: "코넥스", E: "기타" }[d.corp_cls] || "",
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}`, id: `${d.rcept_no}-${h.topic}`
    });
  }
  return out;
}

/* ---------- 실행 ---------- */
export function keepRecent(items, days, today = kstDate()) {
  const cut = new Date(new Date(today + "T00:00:00Z").getTime() - (days - 1) * 864e5).toISOString().slice(0, 10);
  return items.filter(i => i.date >= cut);
}
async function main() {
  const cfg = await readJson("config.json", null);
  if (!cfg) throw new Error("config.json 을 읽지 못했습니다.");
  const days = cfg.days || 7;

  const news = await readJson("news.json", { updated: null, items: [] });
  const seen = { keys: [], urls: [] };
  news.items.forEach(i => { seen.keys.push(titleKey(i.title)); seen.urls.push(i.url); (i.related || []).forEach(r => { seen.keys.push(titleKey(r.title)); seen.urls.push(r.url); }); });
  let added = 0;
  for (const topic of cfg.topics) {
    const items = await collectTopic(topic, seen, cfg);
    await aiSummaries(topic, items, cfg);
    items.forEach(i => { delete i.snippet; seen.keys.push(titleKey(i.title)); seen.urls.push(i.url); });
    news.items.push(...items); added += items.length;
    console.log(`[${topic.id}] 새 뉴스 ${items.length}건`);
  }
  news.items = keepRecent(news.items, days).sort((a, b) => b.published.localeCompare(a.published));
  news.updated = new Date().toISOString();
  await writeJson("news.json", news);

  const disc = await readJson("disclosures.json", { updated: null, items: [] });
  try {
    const got = await fetchDart(cfg.dart || {});
    const ids = new Set(disc.items.map(i => i.id));
    const fresh = got.filter(i => !ids.has(i.id));
    disc.items = keepRecent(disc.items.concat(fresh), days).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    console.log(`새 공시 ${fresh.length}건`);
  } catch (e) { console.warn(`공시 수집 실패: ${e.message}`); }
  disc.updated = new Date().toISOString();
  await writeJson("disclosures.json", disc);
  console.log(`완료: 뉴스 ${added}건 추가, 보관 뉴스 ${news.items.length}건, 보관 공시 ${disc.items.length}건`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
