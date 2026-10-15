// Google tag Consent Mode v2 — analytics denied until the user consents (CookieBanner flips it).
// A file, not an inline <script>, so the nginx CSP needs no 'unsafe-inline' or hash for it.
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  functionality_storage: 'granted',
  security_storage: 'granted',
  wait_for_update: 500
});
gtag('js', new Date());
gtag('config', 'G-3ZNR40KDFP');
