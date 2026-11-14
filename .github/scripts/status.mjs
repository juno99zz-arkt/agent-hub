// 허브가 보여 줄 Agent들의 GitHub 실행 기록·오늘 일정 실행 여부·조치 필요 목록을 모아 status.json 으로 저장한다.
// 대상 목록은 registry.json (agents · schedule)에서 읽는다. 읽기만 하며 어떤 저장소도 바꾸지 않는다.
import { readFileSync, writeFileSync } from "node:fs";

const OWNER = "juno99zz-arkt";
const token = process.env.GITHUB_TOKEN;
const headers = { Accept: "application/vnd.github+json", ...(token && { Authorization: `Bearer ${token}` }) };
// 비공개 저장소(obsidian-vault · vault-agent) 읽기 전용 토큰. 없으면 볼트 상태는 건너뛴다.
const readToken = process.env.HUB_READ_TOKEN;
const privHeaders = { Accept: "application/vnd.github+json", Authorization: `Bearer ${readToken}` };

const registry = JSON.parse(readFileSync(process.argv[2] || "registry.json", "utf8"));
const privateRepos = new Set(registry.agents.filter(a => a.private).map(a => a.repo));
const targets = new Map();
for (const a of registry.agents) if (a.repo && (!a.private || readToken)) targets.set(a.repo, { workflow: a.workflow, watch: a.watch || [], name: a.name });

async function api(path) {
  const priv = privateRepos.has(path.split("/")[0]);
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${path}`, { headers: priv ? privHeaders : headers });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

// KST 기준 오늘
const nowMs = Date.now();
const nowKst = new Date(nowMs + 9 * 3600000);
const today = nowKst.toISOString().slice(0, 10);
const dow = nowKst.getUTCDay(), hour = nowKst.getUTCHours();
const kstToMs = hm => Date.parse(`${today}T${hm}:00+09:00`);
const actions = [];   // { level: error|warn, title, detail, url, agent }

const repos = {};
const failed = [];
await Promise.all([...targets].map(async ([repo, { workflow, watch, name }]) => {
  try {
    const [runs, wf, yml] = await Promise.all([
      api(`${repo}/actions/runs?per_page=30`),
      workflow ? api(`${repo}/actions/workflows/${workflow}`) : null,
      workflow ? fetch(`https://raw.githubusercontent.com/${OWNER}/${repo}/HEAD/.github/workflows/${workflow}`).then(r => (r.ok ? r.text() : "")) : "",
    ]);
    const checks = [];
    if (workflow) {
      // 사이트 배포가 업무 실행을 가리지 않도록 워크플로 자체의 최신 기록을 별도 조회한다.
      const own = await api(`${repo}/actions/workflows/${workflow}/runs?per_page=5`);
      const latest = own.workflow_runs[0];
      if (!latest) checks.push({ level: "unknown", message: "업무 실행 기록 없음" });
      if (latest?.status === "completed") {
        const jobs = await api(`${repo}/actions/runs/${latest.id}/jobs?per_page=100`);
        const bad = jobs.jobs.flatMap(j => j.steps || []).filter(s => ["failure", "timed_out", "cancelled"].includes(s.conclusion));
        if (bad.length) checks.push({ level: "error", message: "처리 단계 실패: " + bad.map(s => s.name).join(", "), url: latest.html_url });
      }
      runs.workflow_runs = [...new Map([...own.workflow_runs, ...runs.workflow_runs].map(r => [r.id, r])).values()]
        .sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }
    // 보조 워크플로(시험 운영 등): 최신 실행이 실패면 주의로 올린다.
    for (const w of watch) {
      const r = (await api(`${repo}/actions/workflows/${w}/runs?per_page=1`)).workflow_runs[0];
      if (r && ["failure", "timed_out", "startup_failure"].includes(r.conclusion))
        checks.push({ level: "warn", message: `${r.name} 최근 실행 실패`, url: r.html_url });
    }
    if (repo === "Invest") {
      const readJson = async path => {
        const r = await fetch(`https://raw.githubusercontent.com/${OWNER}/${repo}/main/${path}`);
        if (!r.ok) throw new Error(`결과 조회 HTTP ${r.status}`);
        return r.json();
      };
      const [mail, analysis] = await Promise.all([readJson("data/email_log.json"), readJson("data/aside/result.json")]);
      const lastMail = Object.keys(mail.sent || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().at(-1);
      if ([1,5].includes(dow) && hour >= 8 && !mail.sent?.[today])
        checks.push({ level:"error", message:"오늘 정기 메일 발송 기록 없음 (수신함 도착은 별도 확인)" });
      else if (lastMail && (nowMs - Date.parse(lastMail + "T00:00:00+09:00")) / 864e5 > 8)
        checks.push({ level:"error", message:`정기 메일 ${lastMail} 이후 발송 기록 없음` });
      // Aside 분석은 평일(월~금)에만 기대한다. 주말에 결과가 없는 것은 정상.
      if (dow >= 1 && dow <= 5 && hour >= 8 && analysis.week !== today)
        checks.push({ level:"error", message:"오늘 AI 분석 결과 없음" });
      checks.push({ level:"info", message:"분석 기준 " + (analysis.week || "미확인") + " · 메일 기록 " + (lastMail || "없음") });
    }
    for (const c of checks) if (c.level === "error" || c.level === "warn")
      actions.push({ level: c.level, title: `${name}: ${c.message}`, url: c.url || `https://github.com/${OWNER}/${repo}/actions`, agent: name });
    repos[repo] = {
      checks,
      runs: runs.workflow_runs.map(r => ({ id: r.workflow_id, name: r.name, event: r.event, status: r.status, conclusion: r.conclusion, at: r.run_started_at || r.created_at, url: r.html_url })),
      wfId: wf?.id, state: wf?.state, wfUrl: wf?.html_url,
      crons: [...yml.matchAll(/cron:\s*["']([^"']+)["']/g)].map(m => m[1]),
    };
  } catch (e) {
    failed.push(`${repo}: ${e.message}`);
  }
}));

// ── 오늘 일정: GH 디스패처 작업표(registry.schedule)의 예정 시각과 실제 실행을 맞춰 본다 ──
const MISS_AFTER = 20 * 60000;    // 디스패처는 5분 간격이므로 20분이 지나도 실행이 없으면 누락
const WINDOW = 60 * 60000;        // 디스패처는 예정 시각부터 60분 안에만 실행
const slots = registry.schedule.flatMap(j => j.days.includes(dow) ? j.at.map(at => ({ ...j, at, t: kstToMs(at) })) : [])
  .sort((a, b) => a.t - b.t);
const todayRuns = {};
await Promise.all([...new Set(slots.map(s => `${s.repo}/${s.wf}`))].map(async key => {
  const [repo, wf] = key.split("/");
  try {
    const since = new Date(kstToMs("00:00") - 5 * 60000).toISOString().slice(0, 19) + "Z";
    const r = await api(`${repo}/actions/workflows/${wf}/runs?per_page=30&created=${encodeURIComponent(">=" + since)}`);
    todayRuns[key] = r.workflow_runs.filter(x => x.event !== "push").sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  } catch (e) { todayRuns[key] = null; failed.push(`일정 ${key}: ${e.message}`); }
}));
const used = new Set();
const jobs = slots.map((s, i) => {
  const key = `${s.repo}/${s.wf}`, list = todayRuns[key];
  const nextSame = slots.slice(i + 1).find(x => x.repo === s.repo && x.wf === s.wf);
  const end = Math.min(s.t + WINDOW, nextSame ? nextSame.t - 60000 : Infinity);
  const run = list?.find(r => !used.has(r.id) && Date.parse(r.created_at) >= s.t - 2 * 60000 && Date.parse(r.created_at) < end);
  if (run) used.add(run.id);
  let state;
  if (list === null) state = "unknown";
  else if (run) state = run.status !== "completed" ? "run" : run.conclusion === "success" ? "done" : run.conclusion === "skipped" ? "done" : "fail";
  else state = nowMs < s.t ? "wait" : nowMs - s.t > MISS_AFTER ? "missed" : "due";
  const out = { id: s.id, name: s.name, repo: s.repo, at: s.at, state, ...(run && { runAt: run.run_started_at || run.created_at, url: run.html_url }) };
  if (state === "fail") actions.push({ level: "error", title: `${s.at} ${s.name} 실행 실패`, url: run.html_url, agent: s.name });
  if (state === "missed") actions.push({ level: "error", title: `${s.at} ${s.name} 실행 안 됨`, detail: "GH 디스패처 또는 GitHub 확인", url: `https://github.com/${OWNER}/${s.repo}/actions/workflows/${s.wf}`, agent: s.name });
  return out;
});

// ── 디스패처 심장박동: 허브 상태 갱신이 디스패처 호출(workflow_dispatch)로 마지막에 돈 시각 ──
let heartbeat = null;
try {
  const r = await api(`agent-hub/actions/workflows/status.yml/runs?per_page=10&event=workflow_dispatch`);
  const last = r.workflow_runs[0];
  if (last) heartbeat = { last: last.created_at, ok: nowMs - Date.parse(last.created_at) < 40 * 60000 };
  if (!heartbeat?.ok) actions.push({ level: "error", title: "GH 디스패처 호출 끊김", detail: "Apps Script 트리거·토큰 확인", agent: "GH 디스패처" });
} catch (e) { failed.push(`디스패처 확인: ${e.message}`); }

// ── 볼트(비공개) 상태: 파일 이름·커밋 시각·작업기록 상태만 읽는다. 노트 본문·제목·사람 이름은 내보내지 않는다 ──
const VAULT = "obsidian-vault";
const vault = {};       // 에이전트 이름 → { level: ok|warn|error, message, at }
const stale = [];       // 오래된 '진행 중' AI 작업기록
let readTokenInfo = null;
const vapi = async path => {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${VAULT}/${path}`, { headers: privHeaders });
  if (!readTokenInfo) readTokenInfo = { expires: r.headers.get("github-authentication-token-expiration") };
  if (!r.ok) throw new Error(`볼트 ${path.split("?")[0]} → HTTP ${r.status}`);
  return r.json();
};
const enc = p => p.split("/").map(encodeURIComponent).join("/");
const hoursAgo = iso => (nowMs - Date.parse(iso)) / 3600000;
const fmtAge = h => h < 1 ? "1시간 이내" : h < 48 ? `${Math.round(h)}시간 전` : `${Math.round(h / 24)}일 전`;
const rank = { ok: 0, warn: 1, error: 2 };

async function signal(s) {
  if (s.kind === "file") {
    // 폴더 안 파일 이름의 날짜(YYYY-MM-DD) 중 가장 최근 것. daily: 그 시각이 지나면 오늘 파일을 기대한다.
    const list = await vapi(`contents/${enc(s.path)}`);
    const dates = list.map(f => f.name.match(/(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean).sort();
    const last = dates.at(-1);
    if (!last) return { level: "error", message: `${s.label} 없음` };
    const yesterday = new Date(nowMs + 9 * 3600000 - 864e5).toISOString().slice(0, 10);
    const level = last === today ? "ok" : last === yesterday ? (s.daily && nowMs > kstToMs(s.daily) ? "warn" : "ok") : "error";
    return { level, message: `${s.label} 최근 ${last}` + (level === "ok" ? "" : level === "warn" ? " · 오늘 것 아직 없음" : " · 하루 넘게 없음"), at: `${last}T12:00:00+09:00` };
  }
  // kind commit: 해당 폴더에 마지막으로 커밋된 시각 (msg 가 있으면 그 메시지로 시작하는 커밋만)
  const list = await vapi(`commits?path=${encodeURIComponent(s.path)}&per_page=${s.msg ? 60 : 1}`);
  const c = list.find(x => !s.msg || x.commit.message.startsWith(s.msg));
  if (!c) return { level: "warn", message: `${s.label} 최근 기록 없음` };
  const at = c.commit.author.date, h = hoursAgo(at);
  const level = h > s.warnHours * 3 ? "error" : h > s.warnHours ? "warn" : "ok";
  return { level, message: `${s.label} ${fmtAge(h)}`, at };
}

if (readToken) {
  await Promise.all(registry.agents.filter(a => a.vault).map(async a => {
    try {
      const res = await Promise.all(a.vault.map(signal));
      const worst = res.reduce((w, r) => rank[r.level] > rank[w.level] ? r : w, res[0]);
      vault[a.name] = { level: worst.level, message: res.map(r => r.message).join(" · "), at: res.map(r => r.at).filter(Boolean).sort().at(-1) };
      for (const r of res) if (r.level !== "ok") actions.push({ level: r.level, title: `${a.name}: ${r.message}`, agent: a.name });
    } catch (e) { failed.push(`${a.name}: ${e.message}`); }
  }));
  // AI 작업기록: '진행 중'으로 48시간 넘게 남은 기록 (보안: 공개 인 기록만 작업명 표시)
  try {
    const dir = "3. Area of Responsibility/AI·HR/AI 작업기록";
    const files = (await vapi(`contents/${enc(dir)}`)).filter(f => f.type === "file" && /^\d{8}-\d{6}-/.test(f.name));
    const recent = files.filter(f => nowMs - Date.parse(`${f.name.slice(0,4)}-${f.name.slice(4,6)}-${f.name.slice(6,8)}T00:00:00+09:00`) < 30 * 864e5);
    const q = recent.map((f, i) => `f${i}: object(expression: ${JSON.stringify("HEAD:" + dir + "/" + f.name)}) { ... on Blob { text } }`).join("\n");
    const r = await fetch("https://api.github.com/graphql", { method: "POST", headers: privHeaders,
      body: JSON.stringify({ query: `{ repository(owner: "${OWNER}", name: "${VAULT}") { ${q} } }` }) });
    const j = await r.json();
    if (!r.ok || j.errors) throw new Error("작업기록 조회 " + (j.errors?.[0]?.message || r.status));
    for (const [k, v] of Object.entries(j.data.repository)) {
      const fm = v?.text?.split("\n---")[0] || "";
      const get = key => fm.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m"))?.[1] || "";
      if (get("상태") !== "진행 중") continue;
      const h = hoursAgo(get("갱신") ? get("갱신") + "+09:00" : get("시작") + "+09:00");
      if (h < 48) continue;
      stale.push({ tool: get("도구"), start: get("시작").slice(0, 10), days: Math.round(h / 24), task: get("보안") === "공개" ? get("작업") : "" });
    }
    if (stale.length) actions.push({ level: "warn", title: `AI 작업기록 ${stale.length}건이 2일 넘게 '진행 중'`,
      detail: stale.map(s => `${s.tool} ${s.start.slice(5).replace("-", "/")} (${s.days}일째)${s.task ? " " + s.task : ""}`).join(" · "), agent: "AI 작업기록" });
  } catch (e) { failed.push(`AI 작업기록: ${e.message}`); }
} else {
  actions.push({ level: "warn", title: "볼트 상태 미확인: HUB_READ_TOKEN 시크릿 없음", detail: "agent-hub 저장소 시크릿에 읽기 전용 토큰 등록 필요", agent: "AI 허브" });
}

// ── 토큰 만료: 등록부의 수기 목록 + 읽기 토큰 자체(응답 헤더) ──
const tokens = [...(registry.tokens || [])];
if (readTokenInfo?.expires) tokens.push({ name: "허브 읽기 토큰 (HUB_READ_TOKEN)", expires: readTokenInfo.expires.slice(0, 10) });
for (const t of tokens) {
  const d = (Date.parse(t.expires + "T00:00:00+09:00") - nowMs) / 864e5;
  t.daysLeft = Math.floor(d);
  if (d < 30) actions.push({ level: d < 7 ? "error" : "warn", title: `${t.name} 만료 ${t.expires} (${Math.max(0, t.daysLeft)}일 남음)`, detail: t.note, agent: "토큰" });
}

// 같은 실행을 가리키는 항목은 하나만 남긴다.
const seen = new Set();
const dedup = actions.filter(a => { const k = a.url && a.url.includes("/runs/") ? a.url : a.title; if (seen.has(k)) return false; seen.add(k); return true; });

// 일부 저장소만 실패한 경우에도 나머지는 저장한다. 전부 실패하면 기존 파일을 덮어쓰지 않도록 비정상 종료한다.
if (!Object.keys(repos).length) { console.error("모든 저장소 조회 실패:\n" + failed.join("\n")); process.exit(1); }
writeFileSync(process.argv[3] || "status.json", JSON.stringify({
  generated: new Date().toISOString(), repos, today: { date: today, dow, jobs }, heartbeat, vault, stale, tokens, actions: dedup, errors: failed,
}));
console.log(`저장소 ${Object.keys(repos).length}개 · 오늘 일정 ${jobs.length}건 · 조치 ${dedup.length}건` + (failed.length ? `, 실패 ${failed.length}개:\n${failed.join("\n")}` : ""));
