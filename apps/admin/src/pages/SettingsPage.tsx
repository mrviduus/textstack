import { useState, useEffect } from 'react'
import { adminApi, SessionSettings } from '../api/client'

export function SettingsPage() {
  const [, setSettings] = useState<SessionSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const [accessMinutes, setAccessMinutes] = useState('')
  const [refreshDays, setRefreshDays] = useState('')

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const data = await adminApi.getSessionSettings()
      setSettings(data)
      setAccessMinutes(String(data.accessTokenExpiryMinutes))
      setRefreshDays(String(data.refreshTokenExpiryDays))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setError(null)
    setSuccess(false)

    const accessVal = parseInt(accessMinutes, 10)
    const refreshVal = parseInt(refreshDays, 10)

    if (isNaN(accessVal) || accessVal < 5 || accessVal > 1440) {
      setError('Access token expiry must be 5-1440 minutes')
      return
    }
    if (isNaN(refreshVal) || refreshVal < 1 || refreshVal > 365) {
      setError('Refresh token expiry must be 1-365 days')
      return
    }

    setSaving(true)
    try {
      const updated = await adminApi.updateSessionSettings({
        accessTokenExpiryMinutes: accessVal,
        refreshTokenExpiryDays: refreshVal,
      })
      setSettings(updated)
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="settings-page"><p>Loading...</p></div>
  }

  return (
    <div className="settings-page">
      <h1>Settings</h1>
      <p className="settings-page__subtitle">Configure admin panel settings</p>

      <div className="settings-section">
        <h2>Session Duration</h2>
        <p className="settings-section__description">
          Configure how long admin sessions last. Changes apply to new logins.
        </p>

        {error && <div className="alert alert--danger">{error}</div>}
        {success && <div className="alert alert--success">Settings saved</div>}

        <div className="form-group">
          <label htmlFor="accessMinutes">Access Token Expiry (minutes)</label>
          <input
            id="accessMinutes"
            type="number"
            value={accessMinutes}
            onChange={(e) => setAccessMinutes(e.target.value)}
            min="5"
            max="1440"
            className="form-control"
          />
          <small>How long until the access token expires (5-1440 min). Default: 60</small>
        </div>

        <div className="form-group">
          <label htmlFor="refreshDays">Refresh Token Expiry (days)</label>
          <input
            id="refreshDays"
            type="number"
            value={refreshDays}
            onChange={(e) => setRefreshDays(e.target.value)}
            min="1"
            max="365"
            className="form-control"
          />
          <small>How long until you need to login again (1-365 days). Default: 30</small>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="btn btn--primary"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
