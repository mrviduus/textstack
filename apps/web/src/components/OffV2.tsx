import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { v2Offers, type V2Feature } from '@textstack/shared'
import { useV2 } from '../context/AuthContext'

/**
 * M5 (#1031): a page V2 holds no data for (`V2_FEATURES`) redirects to its parent while V2 is on;
 * `to` is relative to the page's path. V2 off: the page as it was.
 */
export function OffV2({ feature, to, children }: { feature: V2Feature; to: string; children: ReactNode }) {
  return v2Offers(useV2(), feature) ? children : <Navigate to={to} relative="path" replace />
}
