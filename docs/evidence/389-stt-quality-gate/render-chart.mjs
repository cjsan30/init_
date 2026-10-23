// result-before.json, result-after.json을 읽어 README용 비교표 SVG(라이트/다크)를 만든다.
//   node render-chart.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const before = JSON.parse(readFileSync(join(here, "result-before.json"), "utf8"));
const after = JSON.parse(readFileSync(join(here, "result-after.json"), "utf8"));

const themes = {
  light: {
    surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", rule: "#e4e3df", band: "#f3f2ef",
    good: "#0ca30c", bad: "#d03b3b", onGood: "#0b0b0b", onBad: "#ffffff",
  },
  dark: {
    surface: "#1a1a19", ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781", rule: "#2f2f2c", band: "#222220",
    good: "#0ca30c", bad: "#d03b3b", onGood: "#0b0b0b", onBad: "#ffffff",
  },
};

const OUTCOME_TEXT = {
  FOLLOW_UP_CREATED: "꼬리질문 생성",
  REANSWER_REQUIRED: "재답변 요청",
  NO_FOLLOW_UP: "꼬리질문 없음",
};

// 정상 답변만 꼬리질문으로 이어지는 것이 올바른 처리다.
const isCorrect = (row) =>
  row.assumedUsability === "USABLE" ? row.outcome === "FOLLOW_UP_CREATED" : row.outcome !== "FOLLOW_UP_CREATED";
const calls = (row) => row.aiCalls.factCheck + row.aiCalls.followUp;

const W = 960;
const COL_SAMPLE = 24;
const COL_BEFORE = 430;
const COL_AFTER = 690;
const CHIP_W = 236;
const ROW_H = 58;

function render(name) {
  const t = themes[name];
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const clip = (s, n) => ([...s].length > n ? `${[...s].slice(0, n).join("")}…` : s);
  const parts = [];

  parts.push(`<text x="24" y="34" font-size="18" font-weight="700" fill="${t.ink}">음성 인식이 망가진 답변을 꼬리질문으로 이어 가는가 — 같은 답변 5개를 두 버전에 입력</text>`);
  parts.push(`<text x="24" y="56" font-size="12.5" fill="${t.ink2}">worker의 꼬리질문 처리 코드를 그대로 실행 · AI 모델 호출은 횟수를 세는 대역으로 대체 · 결과 파일: docs/evidence/389-stt-quality-gate</text>`);

  // 범례
  let y = 84;
  parts.push(`<rect x="24" y="${y - 10}" width="12" height="12" rx="3" fill="${t.good}"/>`);
  parts.push(`<text x="42" y="${y}" font-size="12" fill="${t.ink2}">올바른 처리</text>`);
  parts.push(`<rect x="130" y="${y - 10}" width="12" height="12" rx="3" fill="${t.bad}"/>`);
  parts.push(`<text x="148" y="${y}" font-size="12" fill="${t.ink2}">잘못된 처리 (망가진 답변으로 꼬리질문을 만듦)</text>`);

  // 열 제목
  y = 120;
  parts.push(`<text x="${COL_SAMPLE}" y="${y}" font-size="12.5" font-weight="700" fill="${t.ink2}">답변 (음성 인식 결과)</text>`);
  parts.push(`<text x="${COL_BEFORE}" y="${y}" font-size="12.5" font-weight="700" fill="${t.ink2}">#389 이전 (${esc(before.label.match(/\(([^)]+)\)/)?.[1] ?? "")})</text>`);
  parts.push(`<text x="${COL_AFTER}" y="${y}" font-size="12.5" font-weight="700" fill="${t.ink2}">#389 이후</text>`);
  y += 12;
  parts.push(`<line x1="24" y1="${y}" x2="${W - 24}" y2="${y}" stroke="${t.rule}" stroke-width="1"/>`);

  const chip = (x0, top, row, withReason) => {
    const ok = isCorrect(row);
    const fill = ok ? t.good : t.bad;
    const fg = ok ? t.onGood : t.onBad;
    const out = [];
    out.push(`<rect x="${x0}" y="${top + 10}" width="${CHIP_W}" height="26" rx="5" fill="${fill}"/>`);
    out.push(`<text x="${x0 + 10}" y="${top + 27}" font-size="12.5" font-weight="700" fill="${fg}">${esc(OUTCOME_TEXT[row.outcome] ?? row.outcome)}</text>`);
    out.push(`<text x="${x0 + CHIP_W - 10}" y="${top + 27}" font-size="11.5" fill="${fg}" text-anchor="end">AI 호출 ${calls(row)}회</text>`);
    if (withReason && row.outcome === "REANSWER_REQUIRED") {
      out.push(`<text x="${x0}" y="${top + 50}" font-size="10.5" fill="${t.muted}">${esc(clip(row.detail, 22))}</text>`);
    }
    return out.join("\n");
  };

  before.rows.forEach((b, i) => {
    const a = after.rows[i];
    const top = y + i * ROW_H;
    if (i % 2 === 1) parts.push(`<rect x="16" y="${top + 2}" width="${W - 32}" height="${ROW_H - 2}" rx="4" fill="${t.band}"/>`);
    parts.push(`<text x="${COL_SAMPLE + 4}" y="${top + 24}" font-size="13" font-weight="700" fill="${t.ink}">${esc(b.title)}</text>`);
    parts.push(`<text x="${COL_SAMPLE + 4}" y="${top + 43}" font-size="11.5" fill="${t.ink2}">"${esc(clip(b.transcript, 30))}"</text>`);
    parts.push(chip(COL_BEFORE, top, b, false));
    parts.push(chip(COL_AFTER, top, a, true));
  });
  y += before.rows.length * ROW_H + 8;
  parts.push(`<line x1="24" y1="${y}" x2="${W - 24}" y2="${y}" stroke="${t.rule}" stroke-width="1"/>`);

  // 합계: 저품질 답변만
  const bad = (rows) => rows.filter((row) => row.assumedUsability === "UNUSABLE");
  const sum = (rows) => ({
    followUps: rows.filter((row) => row.outcome === "FOLLOW_UP_CREATED").length,
    calls: rows.reduce((total, row) => total + calls(row), 0),
  });
  const sb = sum(bad(before.rows));
  const sa = sum(bad(after.rows));
  y += 30;
  parts.push(`<text x="${COL_SAMPLE + 4}" y="${y}" font-size="13" font-weight="700" fill="${t.ink}">저품질 답변 ${bad(before.rows).length}건 합계</text>`);
  parts.push(`<text x="${COL_BEFORE}" y="${y}" font-size="13" font-weight="700" fill="${t.ink}">꼬리질문 ${sb.followUps}개 · AI 호출 ${sb.calls}회</text>`);
  parts.push(`<text x="${COL_AFTER}" y="${y}" font-size="13" font-weight="700" fill="${t.ink}">꼬리질문 ${sa.followUps}개 · AI 호출 ${sa.calls}회</text>`);
  y += 30;
  parts.push(`<text x="24" y="${y}" font-size="11.5" fill="${t.muted}">무응답·짧은 인식은 AI 호출 전에 걸러지고, 환각·끊긴 문장은 원래 하던 팩트체크 호출 1회 안에서 함께 판정한다(추가 호출 없음). 정상 답변 처리는 그대로다.</text>`);
  const H = y + 22;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif">
<title>PR #389 전후: 저품질 음성 인식 답변 처리 비교</title>
<rect width="${W}" height="${H}" fill="${t.surface}"/>
${parts.join("\n")}
</svg>
`;
}

writeFileSync(join(here, "comparison.svg"), render("light"));
writeFileSync(join(here, "comparison-dark.svg"), render("dark"));
console.log("wrote comparison.svg, comparison-dark.svg");
