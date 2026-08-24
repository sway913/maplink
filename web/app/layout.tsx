import type { Metadata } from 'next';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

export const metadata: Metadata = {
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  title: '映链 MapLink',
  description: 'MapLink 多设备端口映射服务端控制台',
  icons: { icon: '/maplink-icon.png', apple: '/maplink-icon.png' },
  openGraph: {
    title: '映链 MapLink',
    description: 'MapLink 多设备端口映射服务端控制台',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: '映链 MapLink',
    description: 'MapLink 多设备端口映射服务端控制台',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
