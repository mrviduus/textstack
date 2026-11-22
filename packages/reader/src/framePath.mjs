// Where the web app serves the V2 reader (frame.mjs, #1219, #1225). Its own module, so the web host, the e2e
// spec, the dev server's path check and the build assertion do not load the 3.75 MB page to know it.
/** Everything the reader serves lives under this prefix: the frame shell and its content-hashed page script. */
export const READER_DIR = '/reader/'
export const READER_FRAME_PATH = '/reader/frame.html'
/** The page script's path: `page.<first 16 hex of its SHA-384>.js`, cached as immutable. */
export const READER_SCRIPT_PATH = /^\/reader\/page\.[0-9a-f]{16}\.js$/
