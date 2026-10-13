// localStorage that never throws: when site storage is blocked (or full, or in some private modes) reads give null and
// writes are dropped, so a remembered preference is simply not remembered instead of stopping the app.
export const store = {
  get(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value) } catch { /* not remembered */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key) } catch { /* not remembered */ }
  },
}
