/** Every wait has a deadline: `p`, or a rejection ('deadline') after `ms` — a captive portal must not hold a tap. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms) })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}
