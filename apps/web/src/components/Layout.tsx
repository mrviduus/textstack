import { Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { platform } from '../platform'
import { Footer } from './Footer'
import { Header } from './Header'
import { TabBar } from './TabBar'
import { GlobalDropZone } from './library/GlobalDropZone'

/**
 * The frame of every page except the reader (it has its own bars): header, the page, footer, and the tab bar.
 * The tab bar shows on a phone-width screen (styles/app-shell.css) for a reader with a session, and always in
 * the Android app. The app has no site footer.
 */
export function Layout() {
  const { isAuthenticated } = useAuth()
  return (
    <>
      <Header />
      <GlobalDropZone />
      {/* As tall as the screen, so the footer does not jump up while a page's chunk loads. */}
      <div className="app-main">
        <Outlet />
      </div>
      {!platform.appShell && <Footer />}
      {(platform.appShell || isAuthenticated) && <TabBar />}
    </>
  )
}
