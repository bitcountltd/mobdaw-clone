// Song markers (shared/src/markers.ts): the helpers, section lookup, jumps, tempo changes and undo; the lanes' section bands.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addMarker, beginTempoChange, deleteMarker, getMarkers, markerJump, markersMap, nextMarkerName, samplesPerBar, sectionAt, sectionIndexAt,
  sectionRange, setProjectTempo, undoScope, updateMarker, type Marker,
} from '@mobdaw/shared'
import { laneGridCss } from '../src/studio/arrange/grid'
import { sectionBands } from '../src/studio/arrange/rulerMarkers'
import { buildDemo, DEMO_BPM } from '../src/content/demo'
import { TEMPLATES } from '../src/content/templates'

const rate = 48000
const bar = samplesPerBar({ bpm: 120, beatsPerBar: 4 }, rate) // 96000
const m = (pos: number, name = 'x', id = name): Marker => ({ id, pos, name })

describe('marker helpers', () => {
  it('add, update, delete, read back in song order', () => {
    const doc = new Y.Doc()
    expect(getMarkers(doc)).toEqual([])
    const b = addMarker(doc, { pos: 8 * bar, name: '  Chorus  ' })
    const a = addMarker(doc, { pos: 0, name: 'Intro', color: 2 })
    expect(getMarkers(doc).map((x) => [x.name, x.pos])).toEqual([['Intro', 0], ['Chorus', 8 * bar]])
    expect(getMarkers(doc)[0].color).toBe(2)
    updateMarker(doc, b, { pos: -5, name: 'Hook' })
    expect(getMarkers(doc).find((x) => x.id === b)).toMatchObject({ pos: 0, name: 'Hook' })
    updateMarker(doc, b, { name: '   ' }) // an empty name is ignored
    expect(markersMap(doc).get(b)!.get('name')).toBe('Hook')
    updateMarker(doc, a, { color: null })
    expect(getMarkers(doc).find((x) => x.id === a)!.color).toBeUndefined()
    updateMarker(doc, 'nope', { pos: 1 }) // (no-op)
    deleteMarker(doc, a)
    expect(getMarkers(doc).map((x) => x.name)).toEqual(['Hook'])
  })
  it('positions are whole samples; names are trimmed and capped', () => {
    const doc = new Y.Doc()
    const id = addMarker(doc, { pos: 1000.6, name: 'a'.repeat(80) })
    expect(getMarkers(doc)[0]).toMatchObject({ id, pos: 1001 })
    expect(getMarkers(doc)[0].name.length).toBe(40)
  })
  it('are in the undo scope', () => {
    const doc = new Y.Doc()
    const undo = new Y.UndoManager(undoScope(doc))
    const id = addMarker(doc, { pos: bar, name: 'Verse' })
    undo.stopCapturing()
    updateMarker(doc, id, { pos: 3 * bar })
    undo.undo()
    expect(getMarkers(doc)[0].pos).toBe(bar)
    undo.undo()
    expect(getMarkers(doc)).toEqual([])
    undo.redo()
    expect(getMarkers(doc)[0].name).toBe('Verse')
  })
  it('names new markers Intro, Verse, Chorus, Bridge, Outro, then Section n', () => {
    expect(nextMarkerName([])).toBe('Intro')
    expect(nextMarkerName([m(0, 'Intro')])).toBe('Verse')
    expect(nextMarkerName([m(0, 'verse')])).toBe('Intro')
    const all = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'].map((n, i) => m(i, n))
    expect(nextMarkerName(all)).toBe('Section 6')
    expect(nextMarkerName([...all, m(9, 'Section 6')])).toBe('Section 7')
  })
})

describe('sections', () => {
  const list = [m(0, 'Intro'), m(4 * bar, 'Verse'), m(12 * bar, 'Chorus')]
  it('finds the section at a position', () => {
    expect(sectionAt([], 100)).toBeNull()
    expect(sectionAt([m(bar, 'Late')], 0)).toBeNull() // before the first marker
    expect(sectionAt(list, 0)?.name).toBe('Intro')
    expect(sectionAt(list, 4 * bar - 1)?.name).toBe('Intro')
    expect(sectionAt(list, 4 * bar)?.name).toBe('Verse')
    expect(sectionAt(list, 100 * bar)?.name).toBe('Chorus')
    expect(sectionIndexAt(list, 5 * bar)).toBe(1)
  })
  it('a section runs to the next marker, the last to the song end', () => {
    expect(sectionRange(list, 0, 20 * bar)).toEqual({ start: 0, end: 4 * bar })
    expect(sectionRange(list, 2, 20 * bar)).toEqual({ start: 12 * bar, end: 20 * bar })
    expect(sectionRange(list, 2, 0)).toEqual({ start: 12 * bar, end: 12 * bar + 1 }) // (a marker past the end)
    // with a minimum length (the studio passes 4 bars), a marker at or past the song end still makes a usable section
    expect(sectionRange(list, 2, 12 * bar, 4 * bar)).toEqual({ start: 12 * bar, end: 16 * bar })
    expect(sectionRange(list, 2, 20 * bar, 4 * bar)).toEqual({ start: 12 * bar, end: 20 * bar })
    expect(sectionBands(list, 0, 4 * bar).at(-1)).toMatchObject({ start: 12 * bar, end: 16 * bar })
  })
  it('jumps to the next and previous marker', () => {
    expect(markerJump(list, 0, 1)?.name).toBe('Verse')
    expect(markerJump(list, 4 * bar, 1)?.name).toBe('Chorus')
    expect(markerJump(list, 13 * bar, 1)).toBeNull()
    expect(markerJump(list, 13 * bar, -1)?.name).toBe('Chorus')
    expect(markerJump(list, 12 * bar, -1)?.name).toBe('Verse')
    // just past a marker while playing: the grace skips it
    expect(markerJump(list, 12 * bar + 1000, -1, rate / 2)?.name).toBe('Verse')
    expect(markerJump(list, 0, -1)).toBeNull()
  })
  it('bands alternate and carry colours; the lanes paint them', () => {
    const bands = sectionBands([m(0, 'a'), { ...m(4 * bar, 'b'), color: 1 }], 8 * bar)
    expect(bands.map((b) => [b.start, b.end, b.alt, !!b.color])).toEqual([[0, 4 * bar, false, false], [4 * bar, 8 * bar, true, true]])
    const t = { bpm: 120, beatsPerBar: 4 }
    expect(laneGridCss(t, rate, 50, 0.25, null)).not.toContain('color-mix')
    const css = laneGridCss(t, rate, 50, 0.25, null, bands)
    expect(css).toContain('color-mix(in srgb, #6c9bd6 6%, transparent) 400px 800px') // bar = 2 s = 100 px at 50 px/s
  })
})

describe('tempo changes keep markers on their bar', () => {
  it('setProjectTempo scales the positions', () => {
    const doc = new Y.Doc()
    setProjectTempo(doc, 120)
    addMarker(doc, { pos: 4 * bar, name: 'Verse' })
    addMarker(doc, { pos: 8 * bar + bar / 4, name: 'Off' }) // bar 9, beat 2
    setProjectTempo(doc, 90)
    const bar90 = samplesPerBar({ bpm: 90, beatsPerBar: 4 }, rate)
    expect(getMarkers(doc).map((x) => x.pos)).toEqual([Math.round(4 * bar90), Math.round(8.25 * bar90)])
  })
  it('a stepped change (a drag) never drifts and is one undo step', () => {
    const doc = new Y.Doc()
    setProjectTempo(doc, 120)
    addMarker(doc, { pos: 7 * bar, name: 'B' })
    const undo = new Y.UndoManager(undoScope(doc))
    const ch = beginTempoChange(doc)
    for (const bpm of [97, 133, 61, 150, 120]) ch.set(bpm)
    ch.end()
    expect(getMarkers(doc)[0].pos).toBe(7 * bar)
    ch.set(60) // (ended: ignored)
    expect(getMarkers(doc)[0].pos).toBe(7 * bar)
    setProjectTempo(doc, 60)
    expect(getMarkers(doc)[0].pos).toBe(14 * bar)
    undo.undo()
    expect(getMarkers(doc)[0].pos).toBe(7 * bar)
  })
})

describe('content', () => {
  it('the demo marks its sections at bars 1, 5, 13, 21, 29', () => {
    const doc = new Y.Doc()
    buildDemo(doc)
    const b = samplesPerBar({ bpm: DEMO_BPM, beatsPerBar: 4 }, rate)
    expect(getMarkers(doc).map((x) => [x.name, Math.round(x.pos / b) + 1])).toEqual([['Intro', 1], ['A', 5], ['A′', 13], ['B', 21], ['Outro', 29]])
  })
  it('the Beat template has one Groove marker; old-style projects have none', () => {
    const doc = new Y.Doc()
    TEMPLATES.find((t) => t.id === 'beat')!.build(doc)
    expect(getMarkers(doc).map((x) => [x.name, x.pos])).toEqual([['Groove', 0]])
    const empty = new Y.Doc()
    TEMPLATES.find((t) => t.id === 'empty')!.build(empty)
    expect(getMarkers(empty)).toEqual([])
  })
})
