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
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
