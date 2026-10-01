# Mobile App TODO

> Last edited 2026-03-20 (Expo SDK 55 era). Reviewed 2026-10-01 against SDK 57 / RN 0.86.3: struck items carry evidence; the unstruck ones were not re-verified and need a device pass before anyone acts on them.

## Pending
- [x] ~~Infinite scroll in home screen (load more books on scroll — currently works but needs visual polish)~~ — obsolete 2026-10-01: Home tab deleted, `app/(tabs)/index.tsx` is now a `<Redirect>` (Library is the front door).
- [ ] Login flow — investigate why auth isn't working on simulator
- [ ] Reader menu icons — verify tappable after 44x44 touch target fix
- [ ] Dark mode — test on all screens
- [x] ~~Skeleton loaders — add to remaining screens (stats, vocabulary)~~ — done, verified 2026-10-01: `SkeletonLoader` used in `app/stats/index.tsx` and `app/(tabs)/vocabulary.tsx`.
- [ ] Empty states — improve with illustrations
