import type { User } from '@/lib/api/types';

import { create } from 'zustand';
import { client } from '@/lib/api/client';
import { getUser, removeUser, setUser } from '@/lib/auth/utils';
import { createSelectors } from '@/lib/utils';

type AuthState = {
  user: User | null;
  status: 'idle' | 'signOut' | 'signIn';
  signIn: (user: User) => void;
  signOut: () => void;
  hydrate: () => void;
};

const _useAuthStore = create<AuthState>((set, get) => ({
  status: 'idle',
  user: null,
  signIn: (user) => {
    setUser(user);
    set({ status: 'signIn', user });
  },
  signOut: () => {
    client.post('/auth/logout').catch(() => {});
    removeUser();
    set({ status: 'signOut', user: null });
  },
  hydrate: () => {
    try {
      const cachedUser = getUser();
      if (cachedUser) {
        // Restore cached user immediately for fast startup
        set({ status: 'signIn', user: cachedUser });
        // Verify session in background
        client
          .get('/auth/me')
          .then((r) => {
            const user = r.data.user as User;
            get().signIn(user);
          })
          .catch(() => {
            // Cookie expired and refresh failed — sign out
            get().signOut();
          });
      } else {
        set({ status: 'signOut', user: null });
      }
    } catch (e) {
      console.error(e);
      get().signOut();
    }
  },
}));

export const useAuthStore = createSelectors(_useAuthStore);

export const signOut = () => _useAuthStore.getState().signOut();
export const signIn = (user: User) => _useAuthStore.getState().signIn(user);
export const hydrateAuth = () => _useAuthStore.getState().hydrate();
