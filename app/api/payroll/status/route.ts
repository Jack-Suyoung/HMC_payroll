import { NextRequest, NextResponse } from 'next/server';
import { cleanupOldJobs, getPayrollJob } from '../jobs';

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get('jobId');
  if (!jobId) {
    return NextResponse.json({ ok: false, error: 'jobId가 필요합니다.' }, { status: 400 });
  }

  const job = getPayrollJob(jobId);
  if (!job) {
    cleanupOldJobs();
    return NextResponse.json({ ok: false, error: '작업을 찾을 수 없습니다.' }, { status: 404 });
  }

  cleanupOldJobs();
  return NextResponse.json({ ok: true, job }, { status: 200 });
}
