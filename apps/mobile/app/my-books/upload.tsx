import { useState, useEffect, useRef } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView } from 'react-native'
import { useRouter, Stack } from 'expo-router'
import * as DocumentPicker from 'expo-document-picker'
import { userBooksApi, getApiConfig } from '@textstack/shared'
import { colors } from '../../src/theme/colors'
import { trackBookUploaded } from '../../src/lib/analytics'
import { useAuth } from '../../src/context/AuthContext'
import { capabilitiesFor } from '../../src/lib/capabilities'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export default function UploadScreen() {
  const router = useRouter()
  const { user } = useAuth()
  const { canUpload } = capabilitiesFor(user)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [quota, setQuota] = useState<{ usedBytes: number; limitBytes: number } | null>(null)
  const [ownsRights, setOwnsRights] = useState(false)
  const xhrRef = useRef<XMLHttpRequest | null>(null)
  const unmountedRef = useRef(false)

  useEffect(() => {
    // A guest now gets this figure, and it is the truth: their `Guest` tier
    // answer is 50 MB and they may spend it (ADR-014 §3, reversed 2026-09-06).
    // The guard stays for the sessionless case, where `/me/books/quota` has no
    // bearer token and would only 401 into the console.
    if (!canUpload) return
    userBooksApi.getStorageQuota()
      .then(setQuota)
      .catch(err => console.warn('getStorageQuota failed:', err))
  }, [canUpload])

  // Abort any in-flight upload on unmount so the user doesn't silently
  // consume bandwidth after navigating away, and so a subsequent retry
  // doesn't race the abandoned request (P1-3).
  useEffect(() => {
    return () => {
      unmountedRef.current = true
      if (xhrRef.current) {
        try { xhrRef.current.abort() } catch {}
        xhrRef.current = null
      }
    }
  }, [])

  /**
   * The server's own message for a 400, when it sent one.
   *
   * Every refusal from `UserBookService` comes back as `400 { error: "…" }`, and
   * until upload opened to guests they all meant the same thing in practice — a
   * file the extractor would not take — because every non-guest tier has
   * `MaxBooks: null`. The tier refusals are reachable now (ADR-014 §3a), and the
   * one a guest actually hits reads *"Guest accounts can upload 1 book. Sign up
   * for more."*: the correct copy AND the conversion prompt, thrown away by a
   * status-only mapping that answered it with "This file looks invalid".
   */
  const serverErrorMessage = (body: string | undefined): string | null => {
    if (!body) return null
    try {
      const parsed = JSON.parse(body)
      const message = parsed?.error
      // Length-bounded: a stack trace or an HTML error page is not copy.
      return typeof message === 'string' && message.length > 0 && message.length <= 200
        ? message
        : null
    } catch {
      return null
    }
  }

  /** Map HTTP status to user-visible copy so errors are actionable (P3-3). */
  const uploadErrorMessage = (status: number, body?: string): string => {
    if (status === 413) return 'File is too large. Try a smaller book.'
    if (status === 415) return 'Unsupported file format. Use EPUB or PDF.'
    if (status === 400) return serverErrorMessage(body) ?? 'This file looks invalid. Try another one.'
    if (status === 401 || status === 403) return 'Sign in to upload books.'
    if (status === 429) return 'Too many uploads. Take a breather and retry.'
    if (status >= 500) return 'Server error. Try again in a bit.'
    return `Upload failed (${status}).`
  }

  const handleCancel = () => {
    if (xhrRef.current) {
      try { xhrRef.current.abort() } catch {}
      xhrRef.current = null
    }
    setUploading(false)
    setUploadProgress(0)
    setFileName(null)
  }

  const pickAndUpload = async () => {
    if (!ownsRights) {
      setError('Please confirm you own the rights or the book is in the public domain.')
      return
    }
    setError(null)
    setUploadProgress(0)
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'application/epub+zip',
          'application/pdf',
          'application/octet-stream',
        ],
        copyToCacheDirectory: true,
      })

      if (result.canceled) return

      const file = result.assets[0]
      setFileName(file.name)
      setUploading(true)

      const { baseUrl, getAccessToken } = getApiConfig()
      const token = await getAccessToken()

      const formData = new FormData()
      formData.append('file', {
        uri: file.uri,
        name: file.name,
        type: file.mimeType || 'application/octet-stream',
      } as any)

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhrRef.current = xhr
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress((e.loaded / e.total) * 100)
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve()
          else {
            const err = new Error(uploadErrorMessage(xhr.status, xhr.responseText)) as Error & { status?: number }
            err.status = xhr.status
            reject(err)
          }
        }
        xhr.onerror = () => reject(new Error('Network error — check your connection.'))
        // `onabort` fires when we call xhr.abort() (unmount / Cancel button).
        // We surface a distinct error type so the finally-block and the UI
        // can tell "user cancelled" apart from a real failure.
        xhr.onabort = () => {
          const err = new Error('Upload cancelled') as Error & { aborted?: boolean }
          err.aborted = true
          reject(err)
        }
        xhr.open('POST', `${baseUrl}/me/books/upload`)
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        xhr.send(formData)
      })

      if (unmountedRef.current) return
      const format = file.name.split('.').pop()?.toLowerCase() || 'unknown'
      trackBookUploaded({ format, sizeBytes: file.size ?? 0 })
      router.back()
    } catch (e: any) {
      if (unmountedRef.current) return
      // Cancellation is an intentional user action — don't show an error
      // banner, just reset state.
      if (e?.aborted) return
      setError(e?.message || 'Upload failed')
    } finally {
      if (!unmountedRef.current) setUploading(false)
      xhrRef.current = null
    }
  }

  const usedPercent = quota && quota.limitBytes > 0
    ? Math.min((quota.usedBytes / quota.limitBytes) * 100, 100)
    : 0

  // This screen had no auth check of its own — it relied entirely on the tab
  // being hidden, which stopped being enough once `FirstBookState` on an empty
  // Library started routing straight here. It keeps its own guard.
  //
  // What the guard catches changed on 2026-09-06 (ADR-014 §3): a guest passes it
  // now and uploads on the `Guest` tier. What is left below is the reader with no
  // session at all — mobile mints a guest only when a book is opened — for whom
  // there is genuinely no row to attach a file to, and for whom the honest and
  // only actionable next step is an account.
  if (!canUpload) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: 'Upload Book' }} />
        <SafeAreaView style={styles.container}>
          <View style={styles.content}>
            <Text style={styles.title}>Upload a Book</Text>
            <Text style={styles.subtitle}>
              Your books need somewhere to live. Create a free account — it also carries them to your next phone.
            </Text>
            <TouchableOpacity
              style={styles.pickBtn}
              onPress={() => router.replace('/(auth)/login')}
              accessibilityRole="button"
            >
              <Text style={styles.pickBtnText}>Create free account</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </>
    )
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Upload Book' }} />
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.title}>Upload a Book</Text>
          <Text style={styles.subtitle}>Supported formats: EPUB, PDF</Text>

          {quota && (
            <View style={styles.quotaBox}>
              <View style={styles.quotaBar}>
                <View style={[styles.quotaFill, { width: `${usedPercent}%` as any }]} />
              </View>
              <Text style={styles.quotaText}>
                {formatBytes(quota.usedBytes)} / {formatBytes(quota.limitBytes)} used
              </Text>
            </View>
          )}

          {!uploading && (
            <TouchableOpacity
              style={styles.rightsRow}
              onPress={() => setOwnsRights(v => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: ownsRights }}
              accessibilityLabel="I own the rights to this book or it is in the public domain"
            >
              <View style={[styles.checkbox, ownsRights && styles.checkboxChecked]}>
                {ownsRights && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={styles.rightsText}>
                I own the rights to this book or it is in the public domain.
              </Text>
            </TouchableOpacity>
          )}

          {uploading ? (
            <View style={styles.uploadingBox}>
              <View style={styles.uploadProgressBar}>
                <View style={[styles.uploadProgressFill, { width: `${Math.round(uploadProgress)}%` as any }]} />
              </View>
              <Text style={styles.uploadingText}>{Math.round(uploadProgress)}% uploading {fileName}...</Text>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={handleCancel}
                accessibilityLabel="Cancel upload"
                accessibilityRole="button"
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.pickBtn, !ownsRights && styles.pickBtnDisabled]}
              onPress={pickAndUpload}
              disabled={!ownsRights}
              accessibilityLabel="Choose file to upload"
              accessibilityRole="button"
              accessibilityState={{ disabled: !ownsRights }}
            >
              <Text style={styles.pickBtnText}>Choose File</Text>
            </TouchableOpacity>
          )}

          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      </SafeAreaView>
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: 8 },
  subtitle: { fontSize: 14, color: colors.textSecondary, marginBottom: 32 },
  quotaBox: { alignItems: 'center', marginBottom: 24, width: '100%', maxWidth: 240 },
  quotaBar: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textSecondary + '33',
    overflow: 'hidden',
    marginBottom: 6,
  },
  quotaFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 2 },
  quotaText: { fontSize: 12, color: colors.textSecondary },
  pickBtn: {
    backgroundColor: colors.primary,
    paddingVertical: 16,
    paddingHorizontal: 48,
    borderRadius: 12,
  },
  pickBtnDisabled: { opacity: 0.4 },
  pickBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  rightsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 24,
    paddingHorizontal: 8,
    maxWidth: 320,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.textSecondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkmark: { color: '#fff', fontSize: 14, fontWeight: '700', lineHeight: 16 },
  rightsText: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 },
  uploadingBox: { alignItems: 'center', gap: 12, width: '100%', maxWidth: 280 },
  uploadProgressBar: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.textSecondary + '33',
    overflow: 'hidden',
  },
  uploadProgressFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 3 },
  uploadingText: { fontSize: 14, color: colors.textSecondary },
  cancelBtn: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.textSecondary + '66',
  },
  cancelBtnText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  error: { color: colors.error, fontSize: 14, marginTop: 16, textAlign: 'center' },
})
