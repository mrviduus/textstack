import { useState, useEffect, useRef } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView } from 'react-native'
import { useRouter, Stack } from 'expo-router'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { colors } from '../../src/theme/colors'
import { useAuth } from '../../src/context/AuthContext'
import { useDownload } from '../../src/context/DownloadContext'
import { capabilitiesFor } from '../../src/lib/capabilities'
import { SessionGate } from '../../src/components/SessionGate'
import { startV2Probe, uploadV2Book, deviceUploadIo } from '../../src/lib/v2'


export default function UploadRoute() {
  // Settles the session before the screen mounts, exactly as the reader routes
  // do. Choosing to upload a book is a commitment signal, and a guest is
  // allowed to upload — the screen below used to offer an account instead,
  // purely because nothing on this path had ever minted one.
  return (
    <SessionGate>
      <UploadScreen />
    </SessionGate>
  )
}

function UploadScreen() {
  const router = useRouter()
  const { user } = useAuth()
  const { syncOfflineLibrary } = useDownload()
  const { canUpload } = capabilitiesFor(user)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [ownsRights, setOwnsRights] = useState(false)
  // The upload this screen is running, one token per pick (#1143): Cancel, unmount and the next pick
  // mark it, and a marked upload never navigates, moves the bar or resets the screen. V2 parts go
  // one by one through fetch: Cancel stops before the next part or hash chunk (no XHR to abort).
  // ponytail: a part already in flight finishes (one part's network time); abort it via a fetch
  // signal if that window matters.
  const uploadRef = useRef<{ cancelled: boolean } | null>(null)

  // Abort any in-flight upload on unmount so the user doesn't silently
  // consume bandwidth after navigating away, and so a subsequent retry
  // doesn't race the abandoned request (P1-3).
  useEffect(() => {
    return () => {
      if (uploadRef.current) uploadRef.current.cancelled = true
    }
  }, [])

  const handleCancel = () => {
    if (uploadRef.current) uploadRef.current.cancelled = true
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
    if (uploadRef.current) uploadRef.current.cancelled = true
    const upload = { cancelled: false }
    uploadRef.current = upload
    /** Nobody cancelled, left or superseded this upload. */
    const live = () => !upload.cancelled
    // The picker's copy in cache/DocumentPicker/ (#1143): deleted once this upload ends, however it ends.
    let pickedUri: string | null = null
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
      pickedUri = file.uri
      // Left (or cancelled) while the picker was open: no state, no probe, no hash.
      if (!live()) return
      setFileName(file.name)
      setUploading(true)

      // V2 (#1025): sha256 → by-sha256 → import → parts → complete. The same bytes already in the
      // library open that book instead. The part size is the status probe's answer: none, no upload.
      const v2 = await startV2Probe()
      if (!v2.enabled) throw new Error('Network error — check your connection.')
      const { bookId, existing } = await uploadV2Book(
        file, v2.maxPartBytes, deviceUploadIo(() => upload.cancelled),
        // A superseded upload's last part never moves the newer upload's bar.
        p => { if (live()) setUploadProgress(p) })
      if (!live()) return
      if (existing) {
        router.replace(`/my-books/${bookId}`)
        return
      }

      // The book the reader just added is the one they are most likely to open
      // next, so fetch it now rather than waiting for the next reconnect. Not
      // awaited: the screen closes immediately, the sweep runs behind it, and
      // it is Wi-Fi-gated and budget-gated like every other automatic fetch.
      // Not awaited — the screen closes immediately — but not unguarded either:
      // `runAutoDownload` has no catch of its own, so a list request failing as
      // the connection drops mid-upload would surface as an unhandled rejection
      // exactly when the screen pops.
      void syncOfflineLibrary().catch(err => console.warn('[auto-download] post-upload sweep failed:', err))
      router.back()
    } catch (e: any) {
      if (!live()) return
      // Cancellation is an intentional user action — don't show an error
      // banner, just reset state.
      if (e?.aborted) return
      setError(e?.message || 'Upload failed')
    } finally {
      // A cancelled one was reset by Cancel; a left one has no screen; a superseded one is not its own.
      if (live()) setUploading(false)
      // Best-effort: a cleanup failure never fails the upload (the OS clears the cache eventually).
      if (pickedUri) try { new File(pickedUri).delete() } catch {}
    }
  }

  // This screen had no auth check of its own — it relied entirely on the tab
  // being hidden, which stopped being enough once `FirstBookState` on an empty
  // Library started routing straight here. It keeps its own guard.
  //
  // What the guard catches changed twice. On 2026-09-06 (ADR-014 §3) a guest
  // began passing it and uploading on the `Guest` tier. On 2026-09-28 the route
  // gained a `SessionGate`, so a reader arriving without a session now gets one
  // minted before this runs — the previous note said the honest next step was an
  // account, but that was circular: there was no row to attach a file to only
  // because nothing here had asked for one.
  //
  // What is left below is the case where minting genuinely failed — offline,
  // rate limited, or a wedged bootstrap. Then an account IS the only actionable
  // step, and saying so is honest rather than a default.
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
