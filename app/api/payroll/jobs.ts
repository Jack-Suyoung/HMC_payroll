import { randomUUID } from 'crypto';
import { CookieJar } from 'tough-cookie';
import got, { Got, Response } from 'got';
import * as cheerio from 'cheerio';

const BASE = 'https://myehr.hmc.co.kr';
const ENDPOINT = `${BASE}/saly/selectPayDetailsH.do`;
const REFERER = `${BASE}/saly/PayslipForYearHInitPage.do`;
const LOGIN_PAGE = `${BASE}/login.do`;
const LOGIN_PROC = `${BASE}/loginProcess.do`;
const PAYS_INIT = `${BASE}/saly/PayslipForYearHInitPage.do`;
const LOGIN_SUCCESS = `${BASE}/loginSuccess.do`;
const NOTICE_POP = `${BASE}/symt/selectSystemNoticePopup.do`;

export type Txn = {
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

type JobStatus = 'pending' | 'auth_wait' | 'fetching' | 'completed' | 'error';

type Summary = {
  gross: number;
  deductions: number;
  net: number;
  count: number;
};

type ScrapeParams = {
  username: string;
  password: string;
  pernr: string;
  years: number[];
  months: number[];
  waitAuthSeconds: number;
  pollIntervalSeconds: number;
};

type JobState = {
  id: string;
  status: JobStatus;
  message: string;
  totalMonths: number;
  processedMonths: number;
  transactions: Txn[];
  summary?: Summary;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type JobSnapshot = {
  id: string;
  status: JobStatus;
  message: string;
  totalMonths: number;
  processedMonths: number;
  summary?: Summary;
  error?: string;
  transactions?: Txn[];
};

type GlobalJobStore = typeof globalThis & {
  __HM_PAYROLL_JOBS__?: Map<string, JobState>;
};

const getJobStore = (): Map<string, JobState> => {
  const globalWithStore = globalThis as GlobalJobStore;
  if (!globalWithStore.__HM_PAYROLL_JOBS__) {
    globalWithStore.__HM_PAYROLL_JOBS__ = new Map<string, JobState>();
  }
  return globalWithStore.__HM_PAYROLL_JOBS__;
};

const z2 = (m: number) => m.toString().padStart(2, '0');

const parseIntMoney = (val: unknown): number => {
  if (val === null || val === undefined) return 0;
  const stripped = String(val).replace(/,/g, '').trim();
  if (stripped === '') return 0;
  const num = Number(stripped);
  return Number.isFinite(num) ? Math.round(num) : 0;
};

const firstPresent = <T>(record: Record<string, T>, keys: string[]): T | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
};

const normalizeDate = (val: unknown): string => {
  if (val === null || val === undefined) return '';
  const raw = String(val).trim();
  if (!raw) return '';
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
  }
  const normalized = raw.replace(/[./]/g, '-');
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(normalized) ? normalized : raw;
};

const extractMetaCsrf = (html: string): string | undefined => {
  const $ = cheerio.load(html);
  const meta = $('meta[name="_csrf"]').attr('content');
  return meta?.trim();
};

const extractMetaCsrfAndHeader = (html: string): { token?: string; headerName?: string } => {
  const $ = cheerio.load(html);
  const token = $('meta[name="_csrf"]').attr('content')?.trim();
  const headerName = $('meta[name="_csrf_header"]').attr('content')?.trim();
  return { token, headerName };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const createClient = (): GotWithJar => {
  const jar = new CookieJar();
  const instance = got.extend({
    cookieJar: jar,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    https: {
      rejectUnauthorized: true,
    },
    timeout: {
      request: 30000,
    },
    followRedirect: true,
  }) as GotWithJar;
  instance.__jar = jar;
  return instance;
};

const buildHeaders = (csrf: string, headerName: string) => ({
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Origin: BASE,
  Referer: REFERER,
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  [headerName]: csrf,
});

const buildBody = (pernr: string, year: number, month: number, csrf: string) => ({
  coScnCd: 'H',
  yearPay: 'N',
  pernr,
  loginPernr: pernr,
  year: String(year),
  month: z2(month),
  _csrf: csrf,
});

const isHtml = (text: string): boolean => {
  const trimmed = text.trim().slice(0, 50).toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.includes('<html');
};

const normalizeRows = (year: number, month: number, rows: Record<string, unknown>[] = []): Txn[] =>
  rows
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
    .map((row) => {
      const date =
        normalizeDate(
          firstPresent(row, [
            'rqdatTxt',
            'rqdat',
            'rqDt',
            'payDate',
            'paydate',
            'payDt',
            'paydt',
            'payday',
            'payDay',
            'pdate',
            'payYmd',
          ]) as unknown,
        ) ||
        normalizeDate(firstPresent(row, ['fpend', 'fpEnd', 'fpendTxt']) as unknown) ||
        `${year}-${z2(month)}-01`;

      const category =
        String(
          firstPresent(row, [
            'paytyTxt',
            'paytyNm',
            'payTypeNm',
            'payType',
            'payName',
            'payNm',
            'category',
          ]) ?? 'UNKNOWN',
        ).trim() || 'UNKNOWN';

      const group = String(
        firstPresent(row, ['paygubun', 'payGubun', 'paygubunCd', 'payGroup', 'group']) ?? '',
      ).trim();

      return {
        year,
        month,
        date,
        category,
        group,
        gross: parseIntMoney(
          firstPresent(row, ['bet01Txt', 'bet01', 'gross', 'grossAmt', 'totGross']),
        ),
        deductions: parseIntMoney(
          firstPresent(row, ['bet07Txt', 'bet07', 'deductions', 'deduction', 'totDeduction']),
        ),
        net: parseIntMoney(firstPresent(row, ['bet08Txt', 'bet08', 'net', 'netAmt', 'totNet', 'payAmt'])),
        currency:
          String(firstPresent(row, ['waers', 'currency', 'curr', 'currCd']) ?? 'KRW').trim() || 'KRW',
        seqnr: String(firstPresent(row, ['seqnr', 'seqNo', 'seq', 'seqnrTxt', 'seqno']) ?? '').trim(),
        fpbeg: normalizeDate(firstPresent(row, ['fpbeg', 'fpBeg', 'fromDate', 'begda', 'fpbegTxt']) as unknown),
        fpend: normalizeDate(firstPresent(row, ['fpend', 'fpEnd', 'toDate', 'endda', 'fpendTxt']) as unknown),
      };
    });

const computeSummary = (transactions: Txn[]): Summary => {
  return transactions.reduce<Summary>(
    (acc, txn) => ({
      gross: acc.gross + txn.gross,
      deductions: acc.deductions + txn.deductions,
      net: acc.net + txn.net,
      count: acc.count + 1,
    }),
    { gross: 0, deductions: 0, net: 0, count: 0 },
  );
};

const updateJob = (jobId: string, patch: Partial<JobState>) => {
  const store = getJobStore();
  const job = store.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
  job.updatedAt = Date.now();
};

interface GotWithJar extends Got {
  __jar?: CookieJar;
}

const looksLikeLoginFailure = (html: string): boolean => {
  const normalized = html.replace(/\s+/g, ' ');
  const patterns = [
    /로그인[^<]{0,40}실패/i,
    /아이디[^<]{0,40}확인/i,
    /비밀번호[^<]{0,40}(다시|확인|일치하지)/i,
    /입력하신 정보가 올바르지/i,
  ];
  return patterns.some((regex) => regex.test(normalized));
};

const waitForFido = async (
  client: GotWithJar,
  params: ScrapeParams,
  jobId: string,
): Promise<{ token: string; headerName: string }> => {
  const deadline = Date.now() + params.waitAuthSeconds * 1000;
  let lastError = 'no poll yet';
  while (Date.now() < deadline) {
    try {
      const initResp = await client.get(PAYS_INIT, {
        headers: { Referer: LOGIN_PAGE },
      });
      const initToken = extractMetaCsrf(initResp.body);
      if (initToken) {
        updateJob(jobId, {
          status: 'fetching',
          message: '모바일 인증이 확인되었습니다. 급여 데이터를 수집합니다.',
        });
        const { headerName } = extractMetaCsrfAndHeader(initResp.body);
        return { token: initToken, headerName: headerName ?? 'X-CSRF-TOKEN' };
      }

      const noticeResp = await client.post(NOTICE_POP, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          Origin: BASE,
          Referer: LOGIN_PAGE,
        },
        form: {
          typeCd: '00',
        },
      });
      const noticeToken = extractMetaCsrf(noticeResp.body);
      if (noticeToken) {
        updateJob(jobId, {
          status: 'fetching',
          message: '모바일 인증이 확인되었습니다. 급여 데이터를 수집합니다.',
        });
        const { headerName } = extractMetaCsrfAndHeader(noticeResp.body);
        return { token: noticeToken, headerName: headerName ?? 'X-CSRF-TOKEN' };
      }

      const successResp = await client.get(LOGIN_SUCCESS);
      const successToken = extractMetaCsrf(successResp.body);
      if (successToken) {
        updateJob(jobId, {
          status: 'fetching',
          message: '모바일 인증이 확인되었습니다. 급여 데이터를 수집합니다.',
        });
        const { headerName } = extractMetaCsrfAndHeader(successResp.body);
        return { token: successToken, headerName: headerName ?? 'X-CSRF-TOKEN' };
      }

      lastError = `poll: init=${initResp.statusCode} notice=${noticeResp.statusCode} success=${successResp.statusCode}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(Math.max(500, params.pollIntervalSeconds * 1000));
  }
  throw new Error(`Mobile approval timed out. Last status: ${lastError}`);
};

const postLoginProcess = async (client: GotWithJar, csrf: string, params: ScrapeParams) => {
  const response = (await client.post(LOGIN_PROC, {
    form: {
      user: Buffer.from(params.username, 'utf8').toString('base64'),
      pw: Buffer.from(params.password, 'utf8').toString('base64'),
      otpType: 'FIDO',
      otpFlag: 'P',
      otpPasscode: '',
      ABLE_LANGUAGE_SELECTION_PARAM: 'ko_KR',
      accessType: 'login',
      osType: 'P',
      _csrf: csrf,
    },
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: BASE,
      Referer: LOGIN_PAGE,
    },
    followRedirect: true,
  })) as Response<string>;

  const body = response.body ?? '';
  if (looksLikeLoginFailure(body)) {
    throw new Error('로그인에 실패했습니다. 아이디 또는 비밀번호를 다시 확인해 주세요.');
  }
};

const fetchLatestCsrf = async (client: GotWithJar, jobId: string): Promise<{ token: string; headerName: string }> => {
  const resp = await client.get(PAYS_INIT, {
    headers: { Referer: LOGIN_PAGE },
  });
  const { token, headerName } = extractMetaCsrfAndHeader(resp.body);
  if (!token) {
    throw new Error('Unable to extract _csrf token after approval.');
  }
  updateJob(jobId, {
    message: '최신 인증 토큰을 갱신했습니다. 데이터를 계속 수집합니다.',
  });
  return { token, headerName: headerName ?? 'X-CSRF-TOKEN' };
};

const parseJson = <T>(text: string): T => {
  return JSON.parse(text) as T;
};

const processJob = async (jobId: string, params: ScrapeParams) => {
  const totalMonths = params.years.length * params.months.length;
  try {
    updateJob(jobId, {
      status: 'pending',
      message: '로그인 페이지에 접속합니다...',
    });
    const client = createClient();

    const loginResp = await client.get(LOGIN_PAGE);
    const initialCsrf = extractMetaCsrf(loginResp.body);
    if (!initialCsrf) {
      throw new Error('로그인 페이지에서 _csrf 토큰을 찾을 수 없습니다.');
    }

    updateJob(jobId, {
      status: 'auth_wait',
      message: '로그인 정보를 제출했습니다. 휴대폰에서 승인을 진행해 주세요.',
    });
    await postLoginProcess(client, initialCsrf, params);

    const { token: csrfToken, headerName } = await waitForFido(client, params, jobId);

    const all: Txn[] = [];
    let processed = 0;
    for (const year of params.years) {
      for (const month of params.months) {
        processed += 1;
        updateJob(jobId, {
          processedMonths: processed,
          totalMonths,
          message: `데이터 처리중... (${processed}/${totalMonths}) → ${year}-${z2(month)}`,
        });
        try {
          const resp = await client.post(ENDPOINT, {
            headers: buildHeaders(csrfToken, headerName),
            form: buildBody(params.pernr, year, month, csrfToken),
          });

          let payloadText = resp.body;
          if (isHtml(payloadText)) {
            const refreshed = await fetchLatestCsrf(client, jobId);
            const retryResp = await client.post(ENDPOINT, {
              headers: buildHeaders(refreshed.token, refreshed.headerName),
              form: buildBody(params.pernr, year, month, refreshed.token),
            });
            if (isHtml(retryResp.body)) {
              throw new Error('JSON 응답을 기대했지만 HTML이 반환되었습니다.');
            }
            payloadText = retryResp.body;
          }

          const payload = parseJson<{ result?: { payDetails?: { payDetails?: Record<string, unknown>[] } } }>(
            payloadText,
          );
          all.push(...normalizeRows(year, month, payload.result?.payDetails?.payDetails ?? []));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          updateJob(jobId, {
            message: `오류 발생 (${processed}/${totalMonths}) → ${year}-${z2(month)}: ${message}`,
          });
        }
        await sleep(200);
      }
    }

    const summary = computeSummary(all);
    updateJob(jobId, {
      status: 'completed',
      message: `데이터 처리 완료! 총 ${summary.count}건을 가져왔습니다.`,
      transactions: all,
      summary,
      processedMonths: totalMonths,
      totalMonths,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateJob(jobId, {
      status: 'error',
      message: `작업이 실패했습니다: ${message}`,
      error: message,
    });
  }
};

const toSnapshot = (job: JobState | undefined): JobSnapshot | undefined => {
  if (!job) return undefined;
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    totalMonths: job.totalMonths,
    processedMonths: job.processedMonths,
    summary: job.summary,
    error: job.error,
    transactions: job.status === 'completed' ? job.transactions : undefined,
  };
};

export const startPayrollJob = (params: ScrapeParams): JobSnapshot => {
  const jobId = randomUUID();
  const totalMonths = params.years.length * params.months.length;
  const state: JobState = {
    id: jobId,
    status: 'pending',
    message: '작업을 준비 중입니다...',
    totalMonths,
    processedMonths: 0,
    transactions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const store = getJobStore();
  store.set(jobId, state);

  processJob(jobId, params).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    updateJob(jobId, {
      status: 'error',
      message: `작업이 실패했습니다: ${message}`,
      error: message,
    });
  });

  return toSnapshot(state)!;
};

export const getPayrollJob = (jobId: string): JobSnapshot | undefined => {
  return toSnapshot(getJobStore().get(jobId));
};

export const cleanupOldJobs = (maxAgeMs = 1000 * 60 * 30) => {
  const now = Date.now();
  const store = getJobStore();
  for (const [jobId, job] of store.entries()) {
    if (now - job.updatedAt > maxAgeMs) {
      store.delete(jobId);
    }
  }
};
