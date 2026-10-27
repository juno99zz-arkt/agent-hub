// 허브가 보여 줄 Agent들의 GitHub 실행 기록을 모아 status.json 으로 저장한다.
// 대상 목록은 index.html 의 AGENTS (repo / workflow 필드)에서 읽는다. 읽기만 하며 어떤 저장소도 바꾸지 않는다.
import { readFileSync, writeFileSync } from "node:fs";

const OWNER = "juno99zz-arkt";
const token = process.env.GITHUB_TOKEN;
const headers = { Accept: "application/vnd.github+json", ...(token && { Authorization: `Bearer ${token}` }) };

const html = readFileSync(process.argv[2] || "index.html", "utf8");
const targets = new Map();
for (const m of html.matchAll(/repo:\s*"([^"]+)"(?:\s*,\s*workflow:\s*"([^"]+)")?/g)) {
  if (!targets.has(m[1]) || m[2]) targets.set(m[1], m[2] || targets.get(m[1]));
}

async function api(path) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${path}`, { headers });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

const repos = {};
const failed = [];
await Promise.all([...targets].map(async ([repo, workflow]) => {
  try {
    const [runs, wf, yml] = await Promise.all([
      api(`${repo}/actions/runs?per_page=15`),
      workflow ? api(`${repo}/actions/workflows/${workflow}`) : null,
      workflow ? fetch(`https://raw.githubusercontent.com/${OWNER}/${repo}/HEAD/.github/workflows/${workflow}`).then(r => (r.ok ? r.text() : "")) : "",
    ]);
    repos[repo] = {
      runs: runs.workflow_runs.map(r => ({ id: r.workflow_id, name: r.name, event: r.event, status: r.status, conclusion: r.conclusion, at: r.run_started_at || r.created_at, url: r.html_url })),
      wfId: wf?.id, state: wf?.state, wfUrl: wf?.html_url,
      crons: [...yml.matchAll(/cron:\s*["']([^"']+)["']/g)].map(m => m[1]),
    };
  } catch (e) {
    failed.push(`${repo}: ${e.message}`);
  }
}));

// 일부 저장소만 실패한 경우에도 나머지는 저장한다. 전부 실패하면 기존 파일을 덮어쓰지 않도록 비정상 종료한다.
if (!Object.keys(repos).length) { console.error("모든 저장소 조회 실패:\n" + failed.join("\n")); process.exit(1); }
writeFileSync(process.argv[3] || "status.json", JSON.stringify({ generated: new Date().toISOString(), repos }));
console.log(`저장소 ${Object.keys(repos).length}개 저장` + (failed.length ? `, 실패 ${failed.length}개:\n${failed.join("\n")}` : ""));
