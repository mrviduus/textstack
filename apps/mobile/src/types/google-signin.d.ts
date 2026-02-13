declare module '@react-native-google-signin/google-signin' {
  export interface SignInResponse {
    data: {
      idToken: string | null;
      user: {
        id: string;
        email: string;
        name: string | null;
        photo: string | null;
      };
    } | null;
  }

  export const GoogleSignin: {
    configure: (options: { webClientId?: string; offlineAccess?: boolean }) => void;
    hasPlayServices: (options?: { showPlayServicesUpdateDialog?: boolean }) => Promise<boolean>;
    signIn: () => Promise<SignInResponse>;
    signOut: () => Promise<null>;
    isSignedIn: () => Promise<boolean>;
    getCurrentUser: () => Promise<SignInResponse | null>;
  };

  export const GoogleSigninButton: React.ComponentType<{
    testID?: string;
    size?: number;
    color?: number;
    onPress?: () => void;
    disabled?: boolean;
  }> & {
    Size: { Wide: number; Icon: number; Standard: number };
    Color: { Dark: number; Light: number };
  };

  export const statusCodes: {
    SIGN_IN_CANCELLED: string;
    IN_PROGRESS: string;
    PLAY_SERVICES_NOT_AVAILABLE: string;
  };
}
