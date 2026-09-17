import './globals.css';
import Nav from '@/components/Nav';

export const metadata = {
  title: 'Dream Reel',
  description: 'Catch the dream before it fades.',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Dream Reel' },
};

export const viewport = {
  themeColor: '#0a0814',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400&family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap"
        />
        <link rel="apple-touch-icon" href="/icon.png" />
      </head>
      <body>
        {children}
        <Nav />
      </body>
    </html>
  );
}
