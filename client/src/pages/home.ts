import type { Me } from '@mobdaw/shared'
import { h, mount } from '../dom'
import { nav } from '../ui/nav'
import { aboutColumn } from './about'
import { demoSection } from './demos'
import { localSection } from './local'
import { cloudSection } from './projects'

/** Home: projects on this device, in the cloud (when signed in) and the admin-picked demos, each in its own section. The name in the top bar opens an about column on the left. */
export function homePage(me: Me | null) {
  const about = aboutColumn()
  const top = nav(me)
  // On the home page the name shows / hides the about column instead of reloading the page.
  // (replaced rather than re-wired: the nav's own link already has a handler that goes home)
  top.querySelector('.logo')!.replaceWith(h('a', { className: 'logo', href: '#', title: 'about mobdaw', onclick: (e: Event) => (e.preventDefault(), about.toggle()) }, 'mobdaw'))
  mount(top, h('div', { className: 'home' }, about.el,
    h('main', { className: 'wide' }, localSection(me), me ? cloudSection(me) : cloudPitch(), demoSection(me))))
}

/** What the cloud section offers, shown in place of it when signed out. */
function cloudPitch(): HTMLElement {
  return h('section', { className: 'section' },
    h('h2', {}, 'cloud'),
    h('p', { className: 'dim' }, 'cloud storage and real-time editing with others are part of mobdaw pro.'),
    h('p', { className: 'dim' }, h('a', { href: '#/login' }, 'sign in'), ' or ', h('a', { href: '#/register' }, 'create a free account'), '.'))
}
