import type { ReactNode } from 'react'
import { Redirect, type Href } from 'expo-router'
import { v2Offers, type V2Feature } from '@textstack/shared'
import { useV2 } from '../context/AuthContext'

/**
 * M5 (#1031): a screen V2 holds no data for (`V2_FEATURES`) redirects to `href`, its parent, while
 * V2 is on. V2 off: the screen as it was.
 */
export function OffV2({ feature, href, children }: { feature: V2Feature; href: Href; children: ReactNode }) {
  return v2Offers(useV2(), feature) ? children : <Redirect href={href} />
}
