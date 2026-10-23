// result-*.json 4개를 읽어 README용 타임라인 SVG(라이트/다크)를 만든다.
//   node render-chart.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(here, name), "utf8"));

const themes = {
  light: {
    surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e4e3df",
    lane: "#f0efec", pending: "#fab219", failed: "#d03b3b", completed: "#0ca30c", onFill: "#0b0b0b", onFailed: "#ffffff",
  },
  dark: {
    surface: "#1a1a19", ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781", grid: "#2f2f2c",
    lane: "#242422", pending: "#fab219", failed: "#d03b3b", completed: "#0ca30c", onFill: "#0b0b0b", onFailed: "#ffffff",
  },
};

const panels = [
  {
    title: "① 발행 오류 — worker의 SQS 발행 권한 누락 (실제 장애 #362)",
    marker: { minute: 5, label: "권한 복구 (5분)" },
    rows: [
      { label: "#367 이전", file: "result-before-denied.json" },
      { label: "#367 이후", file: "result-after-denied.json" },
    ],
  },
  {
    title: "② 조용한 유실 — DB 커밋 직후, 발행 전에 worker 종료",
    marker: { minute: 15, label: "복구 기준 15분" },
    rows: [
      { label: "#367 이전", file: "result-before-crash.json" },
      { label: "#367 이후", file: "result-after-crash.json" },
    ],
  },
];

const W = 960;
const PAD_L = 112;
const PAD_R = 280;
const PLOT_W = W - PAD_L - PAD_R;
const MINUTES = 30;
const ROW_H = 30;
const x = (m) => PAD_L + (m / MINUTES) * PLOT_W;

function segments(result) {
  const rows = result.timeline;
  const out = [];
  for (const row of rows) {
    const state = row.followUp;
    const last = out[out.length - 1];
    if (last && last.state === state) last.end = row.minute + 1;
    else out.push({ state, start: row.minute, end: row.minute + 1 });
  }
  return out.filter((s) => s.state);
}

function outcome(result) {
  const { followUp, followUpFailureReason } = result.finalState;
  if (followUp === "COMPLETED") return { text: `${result.followUpCompletedAtMinute}분에 자동 재발행 → 완료`, tone: "completed" };
  if (followUp === "FAILED") return { text: `실패로 기록 (${shortReason(followUpFailureReason)})`, tone: "failed" };
  if (followUp === "PENDING") {
    const source = result.finalState.source === "COMPLETED" ? " · 원본은 '완료'로 표시" : "";
    return { text: `30분 후에도 대기${source}`, tone: "pending" };
  }
  return { text: String(followUp), tone: "pending" };
}

function shortReason(reason) {
  if (!reason) return "사유 없음";
  return reason.includes("sqs:SendMessage") ? "sqs:SendMessage 거부" : reason.slice(0, 24);
}

const STATE_TEXT = { PENDING: "PENDING · 실행 안 됨", FAILED: "FAILED", COMPLETED: "COMPLETED", RUNNING: "RUNNING" };

function render(themeName) {
  const t = themes[themeName];
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const parts = [];
  let y = 0;

  parts.push(`<text x="24" y="34" font-size="18" font-weight="700" fill="${t.ink}">후속 AI 작업(개인화 질문 생성)의 상태 변화 — 같은 장애를 두 버전에 재현</text>`);
  parts.push(`<text x="24" y="56" font-size="12.5" fill="${t.ink2}">worker 코드 그대로 실행, 장애만 주입 · 시간은 1초 = 실제 1분으로 축소 · 결과 파일: docs/evidence/367-orphan-pending-recovery</text>`);
  y = 84;

  // 범례 (색 + 글자)
  const legend = [
    ["pending", "PENDING (실행 대기, 아무도 안 가져감)"],
    ["failed", "FAILED (실패 기록 · 재시도 가능)"],
    ["completed", "COMPLETED"],
  ];
  let lx = 24;
  for (const [tone, text] of legend) {
    parts.push(`<rect x="${lx}" y="${y - 10}" width="12" height="12" rx="3" fill="${t[tone]}"/>`);
    parts.push(`<text x="${lx + 18}" y="${y}" font-size="12" fill="${t.ink2}">${esc(text)}</text>`);
    // 한글은 글자 폭이 넓어 영문보다 넉넉히 잡는다.
    const width = [...text].reduce((sum, ch) => sum + (/[가-힣]/.test(ch) ? 12 : 6.8), 0);
    lx += 18 + width + 20;
  }
  parts.push(`<text x="${lx}" y="${y}" font-size="12" fill="${t.ink2}">✕ 발행 실패  ● 발행 성공</text>`);
  y += 30;

  for (const panel of panels) {
    parts.push(`<text x="24" y="${y + 6}" font-size="13.5" font-weight="700" fill="${t.ink}">${esc(panel.title)}</text>`);
    y += 40;
    const top = y;
    const bottom = y + panel.rows.length * (ROW_H + 10) - 10;

    // 눈금
    for (let m = 0; m <= MINUTES; m += 5) {
      parts.push(`<line x1="${x(m)}" y1="${top - 4}" x2="${x(m)}" y2="${bottom + 4}" stroke="${t.grid}" stroke-width="1"/>`);
      parts.push(`<text x="${x(m)}" y="${bottom + 18}" font-size="11" fill="${t.muted}" text-anchor="middle">${m}분</text>`);
    }
    // 기준선
    const mx = x(panel.marker.minute);
    parts.push(`<line x1="${mx}" y1="${top - 8}" x2="${mx}" y2="${bottom + 6}" stroke="${t.ink2}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
    parts.push(`<text x="${mx + 5}" y="${top - 9}" font-size="11" font-weight="600" fill="${t.ink2}">${esc(panel.marker.label)}</text>`);

    for (const row of panel.rows) {
      const result = load(row.file);
      const cy = y + ROW_H / 2;
      parts.push(`<text x="${PAD_L - 12}" y="${cy + 4}" font-size="12.5" font-weight="600" fill="${t.ink}" text-anchor="end">${esc(row.label)}</text>`);
      parts.push(`<rect x="${PAD_L}" y="${y}" width="${PLOT_W}" height="${ROW_H}" rx="4" fill="${t.lane}"/>`);
      for (const seg of segments(result)) {
        const tone = seg.state.toLowerCase();
        const fill = t[tone] ?? t.muted;
        const sx = x(seg.start) + 1;
        const sw = Math.max(2, x(seg.end) - x(seg.start) - 2);
        parts.push(`<rect x="${sx}" y="${y + 2}" width="${sw}" height="${ROW_H - 4}" rx="4" fill="${fill}"/>`);
        if (sw > 90) {
          const color = tone === "failed" ? t.onFailed : t.onFill;
          // 구간 시작에 발행 표시(✕/●)가 있으면 글자를 그 오른쪽으로 민다.
          const hasMarkerAtStart = result.publishLog.some((p) => p.processLogId === 22 && p.minute === seg.start);
          const tx = sx + (hasMarkerAtStart ? 22 : 8);
          parts.push(`<text x="${tx}" y="${cy + 4}" font-size="11.5" font-weight="600" fill="${color}">${esc(STATE_TEXT[seg.state] ?? seg.state)}</text>`);
        }
      }
      for (const p of result.publishLog.filter((item) => item.processLogId === 22)) {
        const px = x(p.minute) + 10;
        // 표시는 막대 위에 놓이므로 그 구간의 색에 맞춰 대비를 확보한다(빨강 위는 흰색, 나머지는 검정).
        const under = result.timeline.find((row) => row.minute === p.minute)?.followUp;
        const mark = under === "FAILED" ? t.onFailed : t.onFill;
        const ring = under === "FAILED" ? t.failed : "#ffffff";
        if (p.ok) {
          parts.push(`<circle cx="${px}" cy="${cy}" r="6" fill="${mark}" stroke="${ring}" stroke-width="2"/>`);
        } else {
          parts.push(`<g stroke="${mark}" stroke-width="2.5" stroke-linecap="round"><line x1="${px - 5}" y1="${cy - 5}" x2="${px + 5}" y2="${cy + 5}"/><line x1="${px + 5}" y1="${cy - 5}" x2="${px - 5}" y2="${cy + 5}"/></g>`);
        }
      }
      const o = outcome(result);
      parts.push(`<rect x="${W - PAD_R + 16}" y="${cy - 5}" width="10" height="10" rx="2" fill="${t[o.tone]}"/>`);
      parts.push(`<text x="${W - PAD_R + 32}" y="${cy + 4}" font-size="12" fill="${t.ink}">${esc(o.text)}</text>`);
      y += ROW_H + 10;
    }
    y += 34;
  }

  parts.push(`<text x="24" y="${y}" font-size="11.5" fill="${t.muted}">원본 작업(문서 추출)은 ①-이전에서 재전달 후 '완료'로 끝나지만, 후속 작업은 다시 만들어지지 않아 영영 실행되지 않는다.</text>`);
  y += 18;
  const H = y + 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif">
<title>PR #367 전후: 후속 AI 작업 상태 타임라인</title>
<rect width="${W}" height="${H}" fill="${t.surface}"/>
${parts.join("\n")}
</svg>
`;
}

writeFileSync(join(here, "timeline.svg"), render("light"));
writeFileSync(join(here, "timeline-dark.svg"), render("dark"));
console.log("wrote timeline.svg, timeline-dark.svg");
