// Which files the studio takes, and file pickers that work on iPhone and iPad.
//
// iOS and iPadOS turn a file input's `accept` list into system file types and grey out every file that doesn't conform.
// Extensions with no system type (`.mobdaw`), and files whose provider reports a generic type (audio in some cloud
// drives), can't be picked at all. So on those devices the pickers accept anything, and what was picked is checked here
// (the studio names what it skipped).

/** iPhone, iPad, or an iPad asking for the desktop site (it reports itself as a Mac with a touch screen). */
export const isAppleTouch = () =>
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

/** A touch screen without a fine pointer: where pasting needs a target to long-press. */
export const isTouch = () =>
  isAppleTouch() || (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches)

/** Audio the engine can decode, by type or (as iOS often gives no type) by extension. */
export const isAudioFile = (f: Pick<File, 'name' | 'type'>) =>
  (f.type.startsWith('audio/') && !/midi/.test(f.type)) || /\.(wav|wave|mp3|ogg|oga|opus|flac|m4a|aac|aiff?|caf|weba|webm|mp4)$/i.test(f.name)

/** A hidden file input. `accept` filters the picker on desktops; on iPhone and iPad it is left off (see the top). */
export function filePicker(accept: string, multiple = false): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'file'
  input.hidden = true
  input.multiple = multiple
  if (!isAppleTouch()) input.accept = accept
  return input
}
