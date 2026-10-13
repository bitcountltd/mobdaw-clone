/**
 * Cloud features (accounts, cloud projects, server demos, sharing, chat) need the Node server. The static build
 * (daw.bitcount.com) has none, so they are hidden unless the build sets VITE_CLOUD=1 (docs/redesign.md §1).
 */
export const CLOUD = import.meta.env.VITE_CLOUD === '1'
