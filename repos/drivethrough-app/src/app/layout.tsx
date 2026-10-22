import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/client/auth-context';

export const metadata: Metadata = {
  title: 'DriveThrough',
  description: 'One drive across every cloud account you own',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d7b76',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* body background/typography come from globals.css — the retro world is one world */}
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
