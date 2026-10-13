import type { Me } from '@mobdaw/shared'
import { CLOUD } from '../cloud'
import { h, mount } from '../dom'
import { nav } from '../ui/nav'
import { aboutColumn } from './about'
import { demoSection } from './demos'
import { localSection } from './local'
import { cloudSection } from './projects'
import { startSection } from './start'
import './home.css'

/**
 * Home: the studio launcher. The wordmark, a row of ways to start (templates and the demo song), then the projects on
 * this device. Cloud builds add the account's cloud projects and the server's demos below, and an about column.
 */
export function homePage(me: Me | null) {
  const intro = h('header', { className: 'home-intro' },
    h('h1', { className: 'logo home-mark' }, 'mobdaw'),
    h('p', { className: 'home-lede' },
      h('span', {}, 'A multitrack studio in a browser tab.'),
      h('span', { className: 'dim' }, ' Record, loop, sequence, automate and mix. Nothing to install, and your projects stay on this device.')))
  const main = h('main', { className: 'home-main' }, intro, startSection(), localSection(me))
  if (CLOUD) {
    main.append(me ? cloudSection(me) : cloudPitch(), demoSection(me))
    const top = nav(me)
    const about = aboutColumn()
    // On the home page the wordmark in the bar shows / hides the about column instead of reloading the page.
    top.querySelector('.logo')!.replaceWith(h('a', { className: 'logo', href: '#', title: 'about mobdaw', onclick: (e: Event) => (e.preventDefault(), about.toggle()) }, 'mobdaw'))
    mount(top, h('div', { className: 'home with-about' }, about.el, main))
  } else {
    // static build: no account bar; the wordmark in the intro is the brand
    mount(h('div', { className: 'home' }, main))
  }
}

/** What the cloud section offers, shown in place of it when signed out (cloud builds only). */
function cloudPitch(): HTMLElement {
  return h('section', { className: 'home-sec' },
    h('div', { className: 'sec-head' }, h('h2', {}, 'Cloud')),
    h('p', { className: 'dim' }, 'Cloud storage and real-time editing with others are part of mobdaw pro. ',
      h('a', { href: '#/login' }, 'Sign in'), ' or ', h('a', { href: '#/register' }, 'create a free account'), '.'))
}
