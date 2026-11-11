// Where the web app serves the V2 reader frame document (frame.mjs, #1219). Its own module, so the web host,
// the e2e spec and the dev server's path check do not load the 3.75 MB page to know it.
export const V2_READER_FRAME_PATH = '/reader-v2/frame.html'
