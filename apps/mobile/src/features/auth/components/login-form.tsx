import Env from 'env';
import * as React from 'react';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { Button, Text, View } from '@/components/ui';

let googleSignInModule: typeof import('@react-native-google-signin/google-signin') | null = null;
let configured = false;

async function getGoogleSignIn() {
  if (!googleSignInModule) {
    googleSignInModule = await import('@react-native-google-signin/google-signin');
  }
  if (!configured && Env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID) {
    googleSignInModule.GoogleSignin.configure({
      webClientId: Env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    });
    configured = true;
  }
  return googleSignInModule;
}

export type LoginFormProps = {
  onGoogleSignIn: (idToken: string) => void;
  onSkip?: () => void;
  loading?: boolean;
  error?: string | null;
};

export function LoginForm({
  onGoogleSignIn,
  onSkip,
  loading = false,
  error = null,
}: LoginFormProps) {
  const handleGooglePress = async () => {
    try {
      const { GoogleSignin, statusCodes } = await getGoogleSignIn();
      await GoogleSignin.hasPlayServices();
      const response = await GoogleSignin.signIn();
      const idToken = response.data?.idToken;
      if (idToken) {
        onGoogleSignIn(idToken);
      }
    } catch (err: unknown) {
      const e = err as { code?: string };
      // Lazy import statusCodes for error checking
      const mod = await getGoogleSignIn().catch(() => null);
      if (mod && e.code === mod.statusCodes.SIGN_IN_CANCELLED) {
        // User cancelled
      } else if (mod && e.code === mod.statusCodes.IN_PROGRESS) {
        // Already signing in
      } else {
        console.error('Google Sign-In error:', err);
      }
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
      keyboardVerticalOffset={10}
    >
      <View className="flex-1 justify-center p-4">
        <View className="items-center justify-center">
          <Text
            testID="form-title"
            className="pb-2 text-center text-4xl font-bold"
          >
            TextStack
          </Text>

          <Text className="mb-8 max-w-xs text-center text-gray-500">
            A calm place to read books. Sign in to save your library and reading
            progress.
          </Text>
        </View>

        {error ? (
          <Text className="mb-4 text-center text-red-500">{error}</Text>
        ) : null}

        <Button
          testID="login-button"
          label="Sign in with Google"
          onPress={handleGooglePress}
          loading={loading}
        />

        {onSkip ? (
          <Button
            label="Browse without signing in"
            variant="ghost"
            onPress={onSkip}
            className="mt-2"
          />
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}
