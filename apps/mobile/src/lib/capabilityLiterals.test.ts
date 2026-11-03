import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guest policy is written once, in `capabilitiesFor` (`packages/shared/src/lib/capabilities.ts`,
 * re-exported by `src/lib/capabilities.ts`), and nowhere else in this app.
 *
 * The failure this prevents is not hypothetical — it shipped. `app/(tabs)/profile.tsx`
 * derived `const isGuest = !!user?.isGuest` and then used it twice: to hide the edit
 * pencil (`{!isGuest && <Ionicons name="pencil" …>}`) and to hide the danger zone.
 * The pencil is decoration; the `TouchableOpacity` wrapping it still called
 * `startEdit`, so a guest tapping their own name entered edit mode and could
 * `PUT /me/profile`. `pickAvatar` on the same screen had no guard at all. One screen,
 * the policy written twice, one copy right — which is what an inline boolean buys you.
 *
 * A capability name says what the caller may DO (`canEditIdentity`), so a reviewer can
 * see it is on the wrong control. `!isGuest` says only what the viewer IS, and reads
 * plausible next to anything. So the boolean is banned at the door.
 *
 * Scope note: this bans DERIVING the policy, not the concept. `capabilitiesFor(user).isGuest`
 * is fine and expected — reading a decided answer is the point. Only the re-derivation
 * from the raw DTO field, and the bare `!isGuest &&` render gate that always follows it,
 * are forbidden.
 *
 * Same shape as `routeLiterals.test.ts`: it greps, it names the file, it fails loudly.
 * Not a type system. It catches the copy-paste, which is the way this one actually spreads.
 */

const ROOTS = ['app', 'src']
const SKIP_DIRS = new Set(['node_modules', '__snapshots__', '__mocks__'])

/**
 * Files allowed to mention the raw field. Every entry is a decision, not a mute:
 * shrinking this list is always an improvement, growing it needs a reason on the line.
 */
const ALLOW: { file: string; why: string }[] = [
  {
    file: 'src/context/AuthContext.tsx',
    why:
      'upstream of the policy, not a consumer of it: it mints and restores the session, ' +
      'and its one use skips the once-per-session profile refetch for a generated ' +
      'guest identity. Asking `capabilitiesFor` there would be the context importing ' +
      'a derivation of its own output.',
  },
  {
    file: 'src/context/NativeLanguageContext.tsx',
    why:
      'dependency arrays only (`}, [user?.id, user?.nativeLanguage, user?.isGuest])`). ' +
      'No branch reads it — it is a re-run trigger for "the identity kind changed", ' +
      'and both effects deliberately run FOR guests. Nothing to move into a capability.',
  },
]

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  {
    pattern: /user\?\.isGuest/,
    why: 'inline guest derivation — use `capabilitiesFor(user)` and name the capability you actually need',
  },
  {
    pattern: /\buser\.isGuest\b/,
    why: 'inline guest derivation — `capabilitiesFor(user)` decides this once, with its reason',
  },
  {
    pattern: /!\s*isGuest\s*&&/,
    why: 'a render gate on identity, not on permission — say `canEditIdentity`/`canDeleteAccount` so the wrong control is visible in review',
  },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    // Test files are excluded, so `capabilities.test.ts` (which builds guest and
    // account fixtures, `isGuest: true`) needs no allow-entry, and neither does this file.
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const allowed = new Set(ALLOW.map(a => a.file))

describe('capability literals', () => {
  const files = ROOTS.flatMap(r => walk(r))

  it('finds source files to scan', () => {
    // Guards against the walk silently returning [] and the suite passing vacuously.
    expect(files.length).toBeGreaterThan(50)
  })

  for (const { pattern, why } of FORBIDDEN) {
    it(`has no ${pattern.source} outside capabilities.ts — ${why}`, () => {
      const offenders = files.filter(f => !allowed.has(f) && pattern.test(readFileSync(f, 'utf8')))
      expect(offenders).toEqual([])
    })
  }

  it('every allowed file still exists and still needs its exception', () => {
    // An exception that no longer matches anything is stale documentation with a
    // veto attached. Fail on it so the list shrinks by itself.
    const stale = ALLOW.filter(a => !FORBIDDEN.some(f => f.pattern.test(readFileSync(a.file, 'utf8'))))
    expect(stale.map(s => s.file)).toEqual([])
  })
})
