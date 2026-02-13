const React = require('react');
const { TouchableOpacity, Text } = require('react-native');

exports.GoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn().mockResolvedValue(true),
  signIn: jest.fn().mockResolvedValue({ data: { idToken: 'mock-id-token' } }),
  signOut: jest.fn().mockResolvedValue(null),
  isSignedIn: jest.fn().mockResolvedValue(false),
  getCurrentUser: jest.fn().mockResolvedValue(null),
};

const GoogleSigninButton = React.forwardRef(
  (props: Record<string, unknown>, ref: unknown) =>
    React.createElement(
      TouchableOpacity,
      { ...props, ref, testID: props.testID || 'google-signin-button' },
      React.createElement(Text, null, 'Sign in with Google'),
    ),
);
GoogleSigninButton.Size = { Wide: 0, Icon: 1, Standard: 2 };
GoogleSigninButton.Color = { Dark: 0, Light: 1 };
exports.GoogleSigninButton = GoogleSigninButton;

exports.statusCodes = {
  SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
  IN_PROGRESS: 'IN_PROGRESS',
  PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
};
