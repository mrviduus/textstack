// Lesson checklists: tick a box, the tick stays in this browser. A lesson with every box ticked
// gets a mark in the side menu, and the Start group shows how many lessons are done.
const KEY = 'textstack-docs-lessons'
const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {} } catch { return {} }
}
const write = (state) => {
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* private window: ticks last for this page only */ }
}
const isLesson = (href) => /\/start\/(run|pr)-\d/.test(href)
const here = location.pathname

const state = read()
const boxes = [...document.querySelectorAll('.sl-markdown-content li input[type="checkbox"]')]
if (isLesson(here) && boxes.length) {
  const saved = state[here] ?? []
  boxes.forEach((box, i) => {
    box.disabled = false
    box.checked = saved[i] === true
    box.addEventListener('change', () => {
      state[here] = boxes.map((b) => b.checked)
      write(state)
      paint()
    })
  })
}

function paint() {
  const links = [...document.querySelectorAll('nav.sidebar a[href]')].filter((a) => isLesson(a.getAttribute('href')))
  let done = 0
  for (const a of links) {
    const ticks = state[new URL(a.href).pathname]
    const complete = Array.isArray(ticks) && ticks.length > 0 && ticks.every(Boolean)
    a.classList.toggle('lesson-done', complete)
    if (complete) done++
  }
  if (!links.length) return
  for (const el of document.querySelectorAll('.lesson-count')) el.remove()
  const count = document.createElement('span')
  count.className = 'lesson-count'
  count.textContent = `${done} of ${links.length} lessons done`
  links[0].closest('details')?.parentElement?.closest('details')?.querySelector('summary')?.after(count)
  const note = document.querySelector('.lesson-complete')
  const allHere = boxes.length > 0 && boxes.every((b) => b.checked)
  if (isLesson(here) && allHere && !note) {
    const p = document.createElement('p')
    p.className = 'lesson-complete'
    p.textContent = 'Lesson complete.'
    boxes.at(-1).closest('ul').after(p)
  } else if (!allHere && note) note.remove()
}
paint()
