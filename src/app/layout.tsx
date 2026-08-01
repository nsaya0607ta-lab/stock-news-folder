import type { Metadata, Viewport } from 'next';
import './globals.css';

const SPLASH = [
  { w: 640, h: 1136, ratio: 2, dw: 320, dh: 568 },
  { w: 750, h: 1334, ratio: 2, dw: 375, dh: 667 },
  { w: 828, h: 1792, ratio: 2, dw: 414, dh: 896 },
  { w: 1125, h: 2436, ratio: 3, dw: 375, dh: 812 },
  { w: 1170, h: 2532, ratio: 3, dw: 390, dh: 844 },
  { w: 1179, h: 2556, ratio: 3, dw: 393, dh: 852 },
  { w: 1206, h: 2622, ratio: 3, dw: 402, dh: 874 },
  { w: 1242, h: 2688, ratio: 3, dw: 414, dh: 896 },
  { w: 1284, h: 2778, ratio: 3, dw: 428, dh: 926 },
  { w: 1290, h: 2796, ratio: 3, dw: 430, dh: 932 },
  { w: 1320, h: 2868, ratio: 3, dw: 440, dh: 956 },
  { w: 1536, h: 2048, ratio: 2, dw: 768, dh: 1024 },
  { w: 1668, h: 2388, ratio: 2, dw: 834, dh: 1194 },
  { w: 2048, h: 2732, ratio: 2, dw: 1024, dh: 1366 },
];

export const metadata: Metadata = {
  title: '株式ニュースフォルダー',
  description:
    '追跡したい株式銘柄を登録すると、毎日その銘柄のニュースを整理した日次レポートが自動で作成され、銘柄ごとのフォルダーに保存されるアプリ。',
  applicationName: '株式ニュースフォルダー',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: '株式ニュースフォルダー',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#f4f6f8',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        {SPLASH.map((entry) => (
          <link
            key={`${entry.w}x${entry.h}`}
            rel="apple-touch-startup-image"
            href={`/splash/splash-${entry.w}x${entry.h}.png`}
            media={`(device-width: ${entry.dw}px) and (device-height: ${entry.dh}px) and (-webkit-device-pixel-ratio: ${entry.ratio}) and (orientation: portrait)`}
          />
        ))}
        {/* テーマのちらつきを防ぐため、描画前にダークモードを適用する */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('pdf-folder-theme')||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(s==='dark'||(s==='system'&&m)){document.documentElement.classList.add('dark');}}catch(e){}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
