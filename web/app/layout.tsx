import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://82.158.91.82:7400'),
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
