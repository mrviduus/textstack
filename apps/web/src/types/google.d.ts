declare namespace google.accounts.id {
  interface CredentialResponse {
    credential: string
    select_by: string
  }

  interface PromptNotification {
    isNotDisplayed(): boolean
    isSkippedMoment(): boolean
    isDismissedMoment(): boolean
  }

  interface ButtonConfig {
    type?: 'standard' | 'icon'
    theme?: 'outline' | 'filled_blue' | 'filled_black'
    size?: 'large' | 'medium' | 'small'
    text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin'
    shape?: 'rectangular' | 'pill' | 'circle' | 'square'
    logo_alignment?: 'left' | 'center'
    width?: number
    locale?: string
  }

  interface InitializeConfig {
    client_id: string
    callback: (response: CredentialResponse) => void
    auto_select?: boolean
    cancel_on_tap_outside?: boolean
    context?: 'signin' | 'signup' | 'use'
    ux_mode?: 'popup' | 'redirect'
    login_uri?: string
    native_callback?: (response: CredentialResponse) => void
    itp_support?: boolean
  }

  function initialize(config: InitializeConfig): void
  function prompt(callback?: (notification: PromptNotification) => void): void
  function renderButton(parent: HTMLElement, config: ButtonConfig): void
  function disableAutoSelect(): void
  function storeCredential(credential: { id: string; password: string }, callback?: () => void): void
  function cancel(): void
  function revoke(hint: string, callback?: (response: { successful: boolean; error?: string }) => void): void
}
