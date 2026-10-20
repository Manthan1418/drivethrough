// AuthProvider — bridges Firebase client auth ↔ api.ts (the single choke-point).
// Owns: current user, sign-in/out actions, and handing the ID token to api.ts via setTokenGetter.
// This is the ONLY place that calls setTokenGetter (flow: firebase.ts auth → here → api.ts).

'use client';

import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import {
  onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  updateProfile, type User,
} from 'firebase/auth';
import { getFirebaseAuth, googleProvider } from './firebase';
import { setTokenGetter } from './api';

interface AuthContextValue {
  user: User | null;
  loading: boolean;           // true until first onAuthStateChanged fires
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string, displayName?: string) => Promise<void>;
  signOutUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const auth = getFirebaseAuth();

    // hand api.ts a live token getter: fresh ID token (auto-refreshed) on every call
    setTokenGetter(() => auth.currentUser?.getIdToken() ?? null);

    // complete any in-flight redirect sign-in (mobile fallback)
    void getRedirectResult(auth).catch(() => { /* user closed / denied — state comes via onAuthStateChanged */ });

    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
      // keep token getter pointed at current user (matters right after sign-in/out)
      setTokenGetter(() => auth.currentUser?.getIdToken() ?? null);
    });
    return unsub;
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    async signInWithGoogle() {
      const auth = getFirebaseAuth();
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (err) {
        // popup blocked / third-party cookies restricted (common on mobile & Safari) → redirect flow
        const code = (err as { code?: string }).code;
        if (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request' || code === 'auth/popup-closed-by-user') {
          await signInWithRedirect(auth, googleProvider);
          return;
        }
        throw err;
      }
    },
    async signInWithEmail(email: string, password: string) {
      await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
    },
    async signUpWithEmail(email: string, password: string, displayName?: string) {
      const cred = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
      if (displayName) await updateProfile(cred.user, { displayName });
    },
    async signOutUser() {
      await signOut(getFirebaseAuth());
      setTokenGetter(() => null); // immediately drop the token — don't leak it across sign-out
    },
  }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
