import { useRouter } from 'expo-router';
import * as React from 'react';

import { FocusAwareStatusBar } from '@/components/ui';
import { client } from '@/lib/api/client';
import type { AuthResponse } from '@/lib/api/types';
import { LoginForm } from './components/login-form';
import { useAuthStore } from './use-auth-store';

export function LoginScreen() {
  const router = useRouter();
  const signIn = useAuthStore.use.signIn();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onGoogleSignIn = async (idToken: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.post<AuthResponse>('/auth/google', { idToken });
      signIn(res.data.user);
      router.replace('/');
    } catch {
      setError('Sign in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <FocusAwareStatusBar />
      <LoginForm
        onGoogleSignIn={onGoogleSignIn}
        onSkip={() => router.replace('/')}
        loading={loading}
        error={error}
      />
    </>
  );
}
