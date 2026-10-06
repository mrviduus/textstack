/**
 * The section order of the legal pages, shared by web and mobile.
 *
 * Both clients used to hardcode the sequence of `t()` calls, so adding a section
 * meant editing four files and remembering all four. That is how the privacy policy
 * drifted into describing a browser-only app with no third parties, months after the
 * product had server accounts and sent book text to OpenAI.
 *
 * Now the order lives here and the clients map over it: adding a section is one entry
 * plus the strings. Play requires the in-app policy and the policy at the listed URL
 * to say the same thing, and a parity test enforces that the two locale files match.
 */
export interface LegalSection {
  /** i18n key for the section heading. */
  heading: string
  /** i18n keys for the paragraphs beneath it, in order. */
  bodies: string[]
  /** Optional trailing link. `label` is an i18n key. */
  link?: { url: string; label: string }
}

export const DELETE_ACCOUNT_URL = 'https://textstack.app/en/delete-account'

export const PRIVACY_SECTIONS: LegalSection[] = [
  { heading: 'privacy.scopeHeading', bodies: ['privacy.scopeBody1', 'privacy.scopeBody2'] },
  {
    heading: 'privacy.collectHeading',
    bodies: [
      'privacy.collectBody1',
      'privacy.collectBody2',
      'privacy.collectBody3',
      'privacy.collectBody4',
      'privacy.collectBody5',
      'privacy.collectBody6',
      'privacy.collectBody7',
    ],
  },
  { heading: 'privacy.purposeHeading', bodies: ['privacy.purposeBody'] },
  {
    heading: 'privacy.thirdPartiesHeading',
    bodies: [
      'privacy.thirdPartiesIntro',
      'privacy.thirdPartiesOpenai',
      'privacy.thirdPartiesTts',
      'privacy.thirdPartiesOpenLibrary',
      'privacy.thirdPartiesAuth',
      'privacy.thirdPartiesEmail',
      'privacy.thirdPartiesSentry',
      'privacy.thirdPartiesExpo',
      'privacy.thirdPartiesAnalytics',
      'privacy.thirdPartiesCloudflare',
      'privacy.thirdPartiesOllama',
      'privacy.thirdPartiesConnectors',
    ],
  },
  {
    heading: 'privacy.aiHeading',
    bodies: ['privacy.aiBody1', 'privacy.aiBody2', 'privacy.aiBody3', 'privacy.aiBody4'],
  },
  { heading: 'privacy.cookiesHeading', bodies: ['privacy.cookiesBody1', 'privacy.cookiesBody2'] },
  { heading: 'privacy.securityHeading', bodies: ['privacy.securityBody'] },
  {
    heading: 'privacy.retentionHeading',
    bodies: [
      'privacy.retentionBody1',
      'privacy.retentionBody2',
      'privacy.retentionBody3',
      'privacy.retentionBody4',
    ],
  },
  {
    heading: 'privacy.rightsHeading',
    bodies: ['privacy.rightsBody1', 'privacy.rightsBody2'],
    link: { url: DELETE_ACCOUNT_URL, label: 'privacy.rightsLinkLabel' },
  },
  { heading: 'privacy.childrenHeading', bodies: ['privacy.childrenBody'] },
  { heading: 'privacy.transfersHeading', bodies: ['privacy.transfersBody'] },
  { heading: 'privacy.changesHeading', bodies: ['privacy.changesBody'] },
]
