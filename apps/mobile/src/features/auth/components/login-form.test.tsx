import * as React from 'react';

import { cleanup, screen, setup } from '@/lib/test-utils';
import { LoginForm } from './login-form';

afterEach(cleanup);

const onGoogleSignInMock = jest.fn();

describe('LoginForm', () => {
  it('renders correctly', async () => {
    setup(<LoginForm onGoogleSignIn={onGoogleSignInMock} />);
    expect(await screen.findByTestId('form-title')).toBeOnTheScreen();
  });
});
