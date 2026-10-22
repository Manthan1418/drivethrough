'use client';

// /settings — the standalone Connections page. The OAuth callback lands here after
// Google consent (backend 302s to ?connected=1 / ?connect=error&reason=…), so this
// route must exist even though the everyday home for connections is the sidebar's ⚙
// window (same panel component, one source of truth).

import Link from 'next/link';
import { ConnectionsPanel } from '@/components/settings/connections';
import { RetroWindow } from '@/components/retro/window';
import { IconGear } from '@/components/retro/icons';

export default function SettingsPage() {
  return (
    <main className="flex min-h-dvh items-start justify-center p-4">
      <RetroWindow title="Settings — Connections" icon={<IconGear size={14} />} draggable className="w-auto max-w-full">
        <ConnectionsPanel />
        <div className="flex justify-end px-1 pb-1">
          <Link href="/" className="bevel-raised retro-focus inline-flex h-6 items-center bg-face px-2 text-[12px] text-ink hover:bg-face-hover">
            ← Back to files
          </Link>
        </div>
      </RetroWindow>
    </main>
  );
}
