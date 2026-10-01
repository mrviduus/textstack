// Display only. The arithmetic (pace rule, 200 wpm fallback) lives in
// @textstack/shared `bookMinutesLeft` — one formula for web and mobile.

/** Library card: "~35m", "2h 5m", "~58h". */
export function formatTimeLeft(minutes: number): string {
  if (minutes <= 0) return '0m'
  if (minutes >= 50 * 60) return `~${Math.round(minutes / 60)}h`
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  return `~${minutes}m`
}

/** Reader stats widget: "~35m", "~2h 5m". */
export function formatEtf(minutes: number): string {
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `~${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `~${h}h`
  return `~${h}h ${m}m`
}
