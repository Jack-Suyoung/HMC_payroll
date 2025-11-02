import './globals.css';
import type { Metadata, Viewport } from 'next';
import ServiceWorkerRegister from '../components/ServiceWorkerRegister';

export const metadata: Metadata = {
  title: 'HM Payroll Dashboard',
  description: '모바일에서도 사용 가능한 급여 명세 대시보드 PWA',
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0c3c78',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#0c3c78" />
      </head>
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
