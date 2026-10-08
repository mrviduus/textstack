import NetInfo from '@react-native-community/netinfo'
import { libraryApi } from '@textstack/shared'
import { createLibraryAutoAdd } from './libraryAutoAdd'
import { wasLibraryRemoved } from './libraryRemovals'

// The app's one instance (session state lives in it). Apart from libraryAutoAdd.ts so the rule can
// be tested without NetInfo, which vitest cannot load.
const autoAdd = createLibraryAutoAdd({
  wasRemoved: wasLibraryRemoved,
  isOnline: async () => (await NetInfo.fetch()).isConnected !== false,
  add: id => libraryApi.addToLibrary(id),
})
export const autoAddToLibrary = autoAdd.maybeAdd
export const autoAddSettled = autoAdd.settled
