/**
 * What the book screen shows when `getUserBook` failed. A confirmed 404 is `notfound`; otherwise the
 * device's copy when there is one, else offline or failed. (The deleted-on-server marks of #1174 only ever
 * named stored PDF originals and went with that cache, #1527.)
 */
export function failedLoadView(input: {
  notFound: boolean
  hasCopy: boolean
  offline: boolean
}): 'notfound' | 'cached' | 'offline' | 'failed' {
  if (input.notFound) return 'notfound'
  if (input.hasCopy) return 'cached'
  return input.offline ? 'offline' : 'failed'
}
