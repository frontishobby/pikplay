// Hash routes carry ids only, so nothing readable ends up in browser history:
//   #/                      drive root
//   #/f/<folderId>          a folder
//   #/w/<folderId|->/<id>   a video, with the folder its playlist comes from

export type Route =
  | { view: 'folder'; folderId: string }
  | { view: 'watch'; folderId: string; fileId: string }

const ROOT_MARK = '-'

function parse(hash: string): Route {
  const [kind, first, second] = hash.replace(/^#\/?/, '').split('/')
  if (kind === 'f' && first) return { view: 'folder', folderId: first }
  if (kind === 'w' && first && second) {
    return { view: 'watch', folderId: first === ROOT_MARK ? '' : first, fileId: second }
  }
  return { view: 'folder', folderId: '' }
}

export const router = $state({ route: parse(location.hash) })

window.addEventListener('hashchange', () => {
  router.route = parse(location.hash)
})

export function folderHref(folderId: string): string {
  return folderId ? `#/f/${folderId}` : '#/'
}

export function watchHref(folderId: string, fileId: string): string {
  return `#/w/${folderId || ROOT_MARK}/${fileId}`
}

/** `replace` swaps the current history entry, e.g. when stepping through a playlist. */
export function navigate(href: string, replace = false): void {
  if (replace) {
    history.replaceState(null, '', href)
    router.route = parse(href)
  } else {
    location.hash = href
  }
}
