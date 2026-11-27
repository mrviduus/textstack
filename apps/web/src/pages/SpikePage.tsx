// SPIKE #1629 (throwaway): the five checks on one screen inside the Capacitor shell.
import { useEffect, useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { ReaderHost, type HostBook } from '../components/reader/ReaderHost'
import { bookBytes, corsProbe, counts, deviceBooks, googleSignIn, log, type DeviceBook } from '../platform/android'

export default function SpikePage() {
  const [books, setBooks] = useState<DeviceBook[] | null>(null)
  const [stats, setStats] = useState<Record<string, number>>({})
  const [book, setBook] = useState<HostBook | null>(null)
  const [msg, setMsg] = useState('')
  const [, tick] = useState(0)

  useEffect(() => {
    deviceBooks().then(setBooks, (e) => setMsg(`library: ${e}`))
    counts().then(setStats, () => {})
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const open = async (b: DeviceBook) => {
    try {
      const t0 = performance.now()
      const bytes = await bookBytes(b.sha256!)
      setMsg(`read ${bytes.byteLength} bytes in ${Math.round(performance.now() - t0)} ms`)
      setBook({ bytes, name: b.title })
    } catch (e) { setMsg(`open: ${e}`) }
  }
  const run = (f: () => Promise<string>) => () => f().then(setMsg, (e) => setMsg(String(e)))

  if (book) return <BrowserRouter><ReaderHost book={book} dev backUrl="/spike" onReload={() => setBook({ ...book })} /></BrowserRouter>
  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif', fontSize: 14 }}>
      <h2>Spike #1629</h2>
      <p data-testid="counts">{JSON.stringify(stats)}</p>
      {books?.map((b) => (
        <button key={b.id} style={{ display: 'block', margin: '8px 0', padding: 12, width: '100%' }} onClick={() => open(b)}>
          {b.title} · {b.format} · file {b.fileOk ? 'ok' : 'MISSING'}
        </button>
      ))}
      <button style={{ padding: 12, marginRight: 8 }} onClick={run(googleSignIn)}>Google sign-in</button>
      <button style={{ padding: 12, marginRight: 8 }} onClick={run(corsProbe)}>CORS probe</button>
      <a href="/en/library">web app</a>
      <p data-testid="msg">{msg}</p>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{log.join('\n')}</pre>
    </div>
  )
}
