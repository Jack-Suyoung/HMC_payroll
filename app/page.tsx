'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  BarElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, BarElement, LineElement, Title, Tooltip, Legend);

type Txn = {
  year: number;
  month: number;
  date: string;
  category: string;
  group: string;
  gross: number;
  deductions: number;
  net: number;
  currency: string;
  seqnr: string;
  fpbeg: string;
  fpend: string;
};

type SummaryPayload = {
  gross: number;
  deductions: number;
  net: number;
  count: number;
};

type JobPayload = {
  id: string;
  status: 'pending' | 'auth_wait' | 'fetching' | 'completed' | 'error';
  message: string;
  totalMonths: number;
  processedMonths: number;
  summary?: SummaryPayload;
  error?: string;
  transactions?: Txn[];
};

type StartResponse = {
  ok: boolean;
  job?: JobPayload;
  error?: string;
};

type StatusResponse = {
  ok: boolean;
  job?: JobPayload;
  error?: string;
};

const apiBase = (process.env.NEXT_PUBLIC_API_BASE ?? '').replace(/\/$/, '');
const startEndpoint = `${apiBase}/api/payroll/start`;
const statusEndpoint = `${apiBase}/api/payroll/status`;
const currencyFmt = new Intl.NumberFormat('ko-KR');

type YearlyRow = {
  year: number;
  months: number;
  gross: number;
  deductions: number;
  net: number;
  grossCum: number;
  netCum: number;
};

type GroupRow = {
  year: number;
  group: string;
  gross: number;
  deductions: number;
  net: number;
};

type DebugEntry = {
  timestamp: string;
  fetchMs: number;
  intervalMs: number | null;
  status: JobPayload['status'] | 'network_error';
  processed?: number;
  total?: number;
  note?: string;
};

function computeYearly(transactions: Txn[]): YearlyRow[] {
  const map = new Map<number, { gross: number; deductions: number; net: number; months: Set<number> }>();
  for (const txn of transactions) {
    if (!map.has(txn.year)) {
      map.set(txn.year, { gross: 0, deductions: 0, net: 0, months: new Set() });
    }
    const entry = map.get(txn.year)!;
    entry.gross += txn.gross;
    entry.deductions += txn.deductions;
    entry.net += txn.net;
    entry.months.add(txn.month);
  }
  const rows = Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([year, data]) => ({
      year,
      months: data.months.size,
      gross: data.gross,
      deductions: data.deductions,
      net: data.net,
    }));
  let grossCum = 0;
  let netCum = 0;
  return rows.map((row) => {
    grossCum += row.gross;
    netCum += row.net;
    return { ...row, grossCum, netCum };
  });
}

function computeGroupBreakdown(transactions: Txn[]): GroupRow[] {
  const map = new Map<string, { gross: number; deductions: number; net: number }>();
  for (const txn of transactions) {
    const key = `${txn.year}:${txn.group || '-'}`;
    if (!map.has(key)) {
      map.set(key, { gross: 0, deductions: 0, net: 0 });
    }
    const entry = map.get(key)!;
    entry.gross += txn.gross;
    entry.deductions += txn.deductions;
    entry.net += txn.net;
  }
  return Array.from(map.entries())
    .map(([key, sums]) => {
      const [yearStr, group] = key.split(':');
      return {
        year: Number(yearStr),
        group: group === '-' ? '' : group,
        ...sums,
      };
    })
    .sort((a, b) => (a.year === b.year ? a.group.localeCompare(b.group) : a.year - b.year));
}

function HomePage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [years, setYears] = useState('2023-2025');

  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('대기 중');
  const [progress, setProgress] = useState<{ processed: number; total: number }>({ processed: 0, total: 0 });
  const [transactions, setTransactions] = useState<Txn[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPollTimeRef = useRef<number | null>(null);
  const [debugSignals, setDebugSignals] = useState<DebugEntry[]>([]);

  const yearlyRows = useMemo(() => computeYearly(transactions), [transactions]);
  const groupRows = useMemo(() => computeGroupBreakdown(transactions), [transactions]);
  const totalSummary = useMemo(() => {
    if (transactions.length === 0) {
      return null;
    }
    return transactions.reduce(
      (acc, txn) => ({
        gross: acc.gross + txn.gross,
        deductions: acc.deductions + txn.deductions,
        net: acc.net + txn.net,
      }),
      { gross: 0, deductions: 0, net: 0 },
    );
  }, [transactions]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username || !password) {
      alert('아이디와 비밀번호를 모두 입력하세요.');
      return;
    }
    setLoading(true);
    setStatusMessage('요청을 시작합니다...');
    setProgress({ processed: 0, total: 0 });
    setTransactions([]);
    setJobId(null);
    setDebugSignals([]);
    lastPollTimeRef.current = null;

    try {
      const response = await fetch(startEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username,
          password,
          years,
        }),
      });
      const data = (await response.json()) as StartResponse;
      if (!response.ok || !data.ok || !data.job) {
        throw new Error(data.error || '작업을 시작하지 못했습니다.');
      }
      setJobId(data.job.id);
      setStatusMessage(data.job.message);
      setProgress({
        processed: data.job.processedMonths ?? 0,
        total: data.job.totalMonths ?? 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`오류: ${message}`);
      alert(message);
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!jobId) {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
      lastPollTimeRef.current = null;
      return;
    }

    let cancelled = false;

    const poll = async () => {
      const startedAt = performance.now();
      const intervalMs = lastPollTimeRef.current === null ? null : startedAt - lastPollTimeRef.current;
      lastPollTimeRef.current = startedAt;

      try {
        const fetchStartedAt = performance.now();
        const response = await fetch(`${statusEndpoint}?jobId=${jobId}`);
        const fetchCompletedAt = performance.now();
        const data = (await response.json()) as StatusResponse;
        if (!response.ok || !data.ok || !data.job) {
          throw new Error(data.error || '상태를 조회하지 못했습니다.');
        }
        if (cancelled) return;

        const job = data.job;
        setStatusMessage(job.message);
        setProgress({
          processed: job.processedMonths ?? 0,
          total: job.totalMonths ?? 0,
        });

        const debugEntry: DebugEntry = {
          timestamp: new Date().toLocaleTimeString(),
          fetchMs: Math.round(fetchCompletedAt - fetchStartedAt),
          intervalMs: intervalMs !== null ? Math.round(intervalMs) : null,
          status: job.status,
          processed: job.processedMonths,
          total: job.totalMonths,
          note: job.message,
        };
        setDebugSignals((prev) => {
          const next = [debugEntry, ...prev];
          return next.slice(0, 10);
        });

        if (job.status === 'completed') {
          setTransactions(job.transactions ?? []);
          setLoading(false);
          setJobId(null);
          return;
        }

        if (job.status === 'error') {
          setLoading(false);
          setJobId(null);
          alert(job.error || '작업이 실패했습니다.');
          return;
        }

        pollTimeoutRef.current = setTimeout(poll, 1000);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setStatusMessage(`오류: ${message}`);
        setLoading(false);
        setJobId(null);
        const errorEntry: DebugEntry = {
          timestamp: new Date().toLocaleTimeString(),
          fetchMs: 0,
          intervalMs: intervalMs !== null ? Math.round(intervalMs) : null,
          status: 'network_error',
          note: message,
        };
        setDebugSignals((prev) => {
          const next = [errorEntry, ...prev];
          return next.slice(0, 10);
        });
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [jobId, statusEndpoint]);

  const chartYearlyData = useMemo(() => {
    const labels = yearlyRows.map((row) => String(row.year));
    return {
      labels,
      datasets: [
        {
          label: '총 지급 (Gross)',
          data: yearlyRows.map((row) => row.gross),
          backgroundColor: 'rgba(14, 116, 144, 0.7)',
        },
        {
          label: '총 공제 (Deductions)',
          data: yearlyRows.map((row) => row.deductions),
          backgroundColor: 'rgba(203, 213, 225, 0.9)',
        },
        {
          label: '총 실수령 (Net)',
          data: yearlyRows.map((row) => row.net),
          backgroundColor: 'rgba(56, 189, 248, 0.8)',
        },
      ],
    };
  }, [yearlyRows]);

  const chartCumulativeData = useMemo(() => {
    const labels = yearlyRows.map((row) => String(row.year));
    return {
      labels,
      datasets: [
        {
          label: '누적 지급 (Gross)',
          data: yearlyRows.map((row) => row.grossCum),
          borderColor: '#0ea5e9',
          backgroundColor: 'rgba(14,165,233,0.1)',
          tension: 0.25,
          fill: true,
        },
        {
          label: '누적 실수령 (Net)',
          data: yearlyRows.map((row) => row.netCum),
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.1)',
          tension: 0.25,
          fill: true,
        },
      ],
    };
  }, [yearlyRows]);

  const chartGroupData = useMemo(() => {
    const years = Array.from(new Set(groupRows.map((row) => row.year))).sort((a, b) => a - b);
    const groups = Array.from(new Set(groupRows.map((row) => row.group || '미지정'))).sort();
    const colors = ['#0ea5e9', '#8b5cf6', '#f97316', '#22c55e', '#ec4899'];

    const datasets = groups.map((group, index) => {
      const points = years.map((year) => {
        const match = groupRows.find((row) => row.year === year && (row.group || '미지정') === group);
        return match?.net ?? 0;
      });
      return {
        label: `Group ${group}`,
        data: points,
        backgroundColor: colors[index % colors.length],
      };
    });

    return {
      labels: years.map(String),
      datasets,
    };
  }, [groupRows]);

  return (
    <main className="page">
      <header className="hero">
        <h1>HMC 급여 명세 대시보드</h1>
      </header>

      <section className="card">
        <h2>로그인 및 기간 선택</h2>
        <form className="form" onSubmit={handleSubmit}>
          <div className="form-row">
            <div className="field">
              <label htmlFor="username">아이디</label>
              <input
                id="username"
                placeholder="사번"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                inputMode="numeric"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">비밀번호</label>
              <input
                id="password"
                type="password"
                placeholder="비밀번호"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="years">연도</label>
              <input
                id="years"
                placeholder="예: 2023-2025 또는 2023,2024"
                value={years}
                onChange={(event) => setYears(event.target.value)}
              />
            </div>
            <div className="button-status">
              <button type="submit" disabled={loading}>
                {loading ? '승인 대기 중…' : '데이터 가져오기'}
              </button>
              <div className="status-box inline">
                <span className="status-dot" aria-hidden="true" />
                <div>
                  <p>{statusMessage}</p>
                  {progress.total > 0 && (
                    <p className="status-progress">
                      {progress.processed}/{progress.total}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </form>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>급여 명세 히스토리</h2>
          <div className="actions">
            <span className="badge">{transactions.length} 건</span>
          </div>
        </div>

        {totalSummary ? (
          <div className="summary-grid">
            <article className="summary-card">
              <p className="summary-label">총 지급액</p>
              <p className="summary-value">{currencyFmt.format(totalSummary.gross)} 원</p>
            </article>
            <article className="summary-card">
              <p className="summary-label">총 공제액</p>
              <p className="summary-value">{currencyFmt.format(totalSummary.deductions)} 원</p>
            </article>
            <article className="summary-card">
              <p className="summary-label">총 실수령</p>
              <p className="summary-value">{currencyFmt.format(totalSummary.net)} 원</p>
            </article>
          </div>
        ) : (
          <p className="muted">데이터를 조회하면 히스토리가 표시됩니다.</p>
        )}

        {yearlyRows.length > 0 && (
          <>
            <h3>연도별 요약</h3>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>연도</th>
                    <th>월수</th>
                    <th>총 지급</th>
                    <th>총 공제</th>
                    <th>총 실수령</th>
                    <th>누적 지급</th>
                    <th>누적 실수령</th>
                  </tr>
                </thead>
                <tbody>
                  {yearlyRows.map((row) => (
                    <tr key={row.year}>
                      <td>{row.year}</td>
                      <td>{row.months}</td>
                      <td>{currencyFmt.format(row.gross)}</td>
                      <td>{currencyFmt.format(row.deductions)}</td>
                      <td>{currencyFmt.format(row.net)}</td>
                      <td>{currencyFmt.format(row.grossCum)}</td>
                      <td>{currencyFmt.format(row.netCum)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {groupRows.length > 0 && (
          <>
            <h3>그룹별 요약 (1=급여, 2=상여, 3=소급)</h3>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>연도</th>
                    <th>그룹</th>
                    <th>총 지급</th>
                    <th>총 공제</th>
                    <th>총 실수령</th>
                  </tr>
                </thead>
                <tbody>
                  {groupRows.map((row) => (
                    <tr key={`${row.year}-${row.group}`}>
                      <td>{row.year}</td>
                      <td>{row.group || '미지정'}</td>
                      <td>{currencyFmt.format(row.gross)}</td>
                      <td>{currencyFmt.format(row.deductions)}</td>
                      <td>{currencyFmt.format(row.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {yearlyRows.length > 0 && (
        <section className="card">
          <h2>그래프</h2>
          <div className="chart">
            <Bar
              data={chartYearlyData}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  tooltip: {
                    callbacks: {
                      label: (context) =>
                        `${context.dataset.label}: ${currencyFmt.format(Number(context.raw ?? 0))} 원`,
                    },
                  },
                  legend: { position: 'bottom' },
                },
                scales: {
                  y: {
                    ticks: {
                      callback: (value) => currencyFmt.format(Number(value ?? 0)),
                    },
                  },
                },
              }}
            />
          </div>
          <div className="chart">
            <Line
              data={chartCumulativeData}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  tooltip: {
                    callbacks: {
                      label: (context) =>
                        `${context.dataset.label ?? ''}: ${currencyFmt.format(Number(context.raw ?? 0))} 원`,
                    },
                  },
                  legend: { position: 'bottom' },
                },
                scales: {
                  y: {
                    ticks: {
                      callback: (value) => currencyFmt.format(Number(value ?? 0)),
                    },
                  },
                },
              }}
            />
          </div>
          {groupRows.length > 0 && (
            <div className="chart">
              <Bar
                data={chartGroupData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    tooltip: {
                      callbacks: {
                        label: (context) =>
                          `${context.dataset.label ?? ''}: ${currencyFmt.format(Number(context.raw ?? 0))} 원`,
                      },
                    },
                    legend: { position: 'bottom' },
                  },
                  scales: {
                    y: {
                      ticks: {
                        callback: (value) => currencyFmt.format(Number(value ?? 0)),
                      },
                    },
                  },
                }}
              />
            </div>
          )}
        </section>
      )}

      {debugSignals.length > 0 && (
        <section className="card">
          <h2>디버그 신호</h2>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>시각</th>
                  <th>Fetch(ms)</th>
                  <th>Interval(ms)</th>
                  <th>상태</th>
                  <th>진행도</th>
                  <th>메시지</th>
                </tr>
              </thead>
              <tbody>
                {debugSignals.map((entry, index) => (
                  <tr key={`${entry.timestamp}-${index}`}>
                    <td>{entry.timestamp}</td>
                    <td>{entry.fetchMs}</td>
                    <td>{entry.intervalMs ?? '—'}</td>
                    <td>{entry.status}</td>
                    <td>
                      {entry.processed !== undefined && entry.total !== undefined
                        ? `${entry.processed ?? 0}/${entry.total ?? 0}`
                        : '—'}
                    </td>
                    <td className="muted">{entry.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="footer">
        <p>ⓒ 2025 HMC Payroll Dashboard</p>
      </footer>
    </main>
  );
}

export default HomePage;
