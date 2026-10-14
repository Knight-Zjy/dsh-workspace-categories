/**
 * Host loader entry for the browser-only workspace-tree plugin.
 *
 * The plugin's entire product is client-side: it shadows the
 * `sidebar.workspaces` slot and renders the category tree there. This host
 * half exists so the Loader has a row to mount and the `dsh.client` scan can
 * discover `./client`; it deliberately provides no host behavior.
 */

export const name = 'dsh-workspace-tree'

/** Provides no host-side behavior. */
export function apply() {}
