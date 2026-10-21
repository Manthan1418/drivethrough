// client/system.ts — deployment-level config (9Drive parity: Google OAuth credentials are
// entered in Settings, stored encrypted server-side; the secret is write-only — the GET
// only ever reports hasSecret). Uses api.ts (single choke-point).

import { api } from './api';
import type { GoogleConfigStatus, SaveGoogleConfigRequest, SaveGoogleConfigResponse } from '@drivethrough/contracts';

export async function getGoogleConfigStatus(): Promise<GoogleConfigStatus> {
  return api<GoogleConfigStatus>('/api/system/google-config', { method: 'GET' });
}

export async function saveGoogleConfig(input: SaveGoogleConfigRequest): Promise<SaveGoogleConfigResponse> {
  return api<SaveGoogleConfigResponse>('/api/system/google-config', { method: 'POST', json: input });
}
