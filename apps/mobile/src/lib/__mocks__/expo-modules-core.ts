import { randomUUID } from 'node:crypto'

/** The one export the app's tested code uses: `uuid.v4()`. */
export const uuid = { v4: () => randomUUID() }
