// "Finish book" (#1266): when the hosts show the end-of-book block. Pure, shared by both hosts.

/**
 * The block shows while the end of the book is on screen (`readRelocate(m).atEnd`, the page's own test: hosts
 * never guess it from the fraction) in a book whose format is known. Hidden on CBZ: a CBZ page has no reading
 * state the server takes yet, so its completion could not be written; #1188 turns it on.
 */
export function showsFinishBook({ atEnd, format }) {
  return atEnd === true && typeof format === 'string' && format !== '' && format !== 'cbz'
}
