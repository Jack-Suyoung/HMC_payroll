import { NextRequest, NextResponse } from 'next/server';
import { startPayrollJob } from '../jobs';

const DEFAULT_WAIT_SECONDS = 60;
const DEFAULT_POLL_INTERVAL = 2;

const parseRangeInput = (input?: unknown): number[] => {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((num) => Number(num)).filter((num) => Number.isFinite(num));
  const text = String(input);
  return text
    .split(',')
    .flatMap((token) => {
      const part = token.trim();
      if (!part) return [];
      if (part.includes('-')) {
        const [aRaw, bRaw] = part.split('-', 2).map((value) => Number(value));
        if (Number.isFinite(aRaw) && Number.isFinite(bRaw)) {
          const step = aRaw <= bRaw ? 1 : -1;
          const range: number[] = [];
          for (let v = aRaw; step > 0 ? v <= bRaw : v >= bRaw; v += step) {
            range.push(v);
          }
          return range;
        }
        return [];
      }
      const num = Number(part);
      return Number.isFinite(num) ? [num] : [];
    })
    .filter((num) => Number.isFinite(num));
};

export async function POST(request: NextRequest) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload.' }, { status: 400 });
  }

  const { username, password, pernr, years } = payload;
  if (!username || !password) {
    return NextResponse.json({ ok: false, error: 'username과 password가 필요합니다.' }, { status: 400 });
  }

  const pernrValue = String(pernr ?? username);

  const yearList = parseRangeInput(years ?? '2023-2025');
  const monthList = parseRangeInput('1-12');
  if (yearList.length === 0) {
    return NextResponse.json({ ok: false, error: '조회할 연도가 필요합니다.' }, { status: 400 });
  }

  const job = startPayrollJob({
    username: String(username),
    password: String(password),
    pernr: pernrValue,
    years: [...new Set(yearList)].sort((a, b) => a - b),
    months: [...new Set(monthList)].sort((a, b) => a - b),
    waitAuthSeconds: DEFAULT_WAIT_SECONDS,
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL,
  });

  return NextResponse.json(
    {
      ok: true,
      job,
    },
    { status: 200 },
  );
}
