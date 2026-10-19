import type { Me } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'
import { describeError } from '../errors'
import { projectTile } from '../ui/tile'

/**
 * Demo projects: public projects an admin picked. Anyone can open one read-only, signed in or not. The section stays
 * hidden until there is at least one (and if the list can't be loaded: it is a showcase, not something to fix).
 */
export function demoSection(me: Me | null): HTMLElement {
  const list = h('ul', { className: 'tiles' })
  const count = h('span', { className: 'sec-count num' })
  const section = h('section', { className: 'home-sec', 'aria-labelledby': 'demo-h', hidden: true },
    h('div', { className: 'sec-head' }, h('h2', { id: 'demo-h' }, 'From the community'), count),
    h('p', { className: 'dim sec-lede' }, me
      ? 'Projects shared to listen to and learn from. They open read-only; save a copy (in its ⋯ menu) to make one your own.'
      : 'Projects shared to listen to and learn from. They open read-only, no account needed.'),
    list)
  api.demos().then((projects) => {
    section.hidden = !projects.length
    count.textContent = projects.length ? String(projects.length) : ''
    list.replaceChildren(...projects.map((p) => projectTile({
      href: `#/project/${p.id}`, name: p.name,
      details: [p.ownerUsername === me?.username ? 'yours' : `by ${p.ownerUsername}`],
      preview: () => api.projectPreview(p.id),
      // (signed in: start from it, as a project of your own)
      actions: me && me.planStatus === 'active' ? [{ label: 'save a copy', icon: 'duplicate', title: 'a new cloud project of your own, with the same tracks and audio',
        onclick: () => void api.copyProject(p.id).then((c) => (location.hash = `#/project/${c.id}`), (e) => alert(describeError(e))) }] : [],
    })))
  }, () => {})
  return section
}
