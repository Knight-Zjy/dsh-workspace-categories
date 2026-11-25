/**
 * dsh-workspace-categories — client half.
 *
 * Renders a VS Code style category tree (分类 > 工作区 > 会话) into the
 * sidebar's `sidebar.workspaces` slot. That slot is `kind: "single"`, and a
 * single slot renders its lowest-priority entry, so registering at
 * `priority: -100` shadows ui-workspace's default browser (`priority: 0`)
 * without disabling it — disposing our entry brings the native browser back.
 *
 * Data comes from the client Cordis services, no RPC:
 *   ctx.get("workspaces").list  -> { items, archivedSessionIds, pinnedSessionIds, phase }
 *   ctx.get("sessions").list    -> { ids, byId, phase }   (byId rows carry displayTitle/running/retainedBy)
 * Opening a session is delegated to ctx.get("uiWorkspace") (retain mainView +
 * reveal the main panel), with a hand-rolled fallback.
 *
 * Session archiving reuses the workspaces controller
 * (`archiveSession` / `unarchiveSession`), because that is what installs the
 * returned archive set into the snapshot store; a `workspace/session-active`
 * refusal is answered with the same "stop and archive?" second step the
 * built-in browser takes. A tri-state filter (隐藏归档 / 含归档 / 仅归档) decides
 * whether archived rows show up in the tree at all.
 *
 * Categories live in localStorage: they are pure UI metadata, so the plugin
 * needs no host half and no profile storage wiring.
 */

window.__ModuleLoader__.load({
	id: 'dsh-workspace-categories',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const h = react.createElement

		/**
		 * The shell seeds a fixed set of UI packages into every client bundle, and
		 * `@deepseek-ai/dsh-client-ui-primitives` is the one the built-in browser
		 * uses for its own hover tooltips (`ArchiveSessionRowButton` wraps its
		 * button in `Tooltip` with `side: "bottom"`, `align: "end"`,
		 * `delayMs: 500`). Reusing it keeps our hints identical to the rest of the
		 * app. The seed list is not part of this plugin's contract though, so a
		 * missing package must not break the tree: we degrade to the native
		 * `title` tooltip instead of throwing.
		 */
		let Tooltip = null
		try {
			const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
			if (primitives !== null && primitives !== undefined && typeof primitives.Tooltip === 'function') {
				Tooltip = primitives.Tooltip
			}
		} catch (reason) {
			Tooltip = null
		}

		/* ------------------------------------------------------------------ *
		 * Persisted view state
		 * ------------------------------------------------------------------ */

		const STORAGE_KEY = 'dsh.workspace-tree.state.v1'
		const STYLE_ID = 'dsh-workspace-categories/styles'

		const DEFAULTS = {
			version: 2,
			/** "tree" shows this plugin; "native" restores ui-workspace's browser. */
			mode: 'tree',
			/** [{ id, name, collapsed, parentId }] — array order is the sibling order. */
			categories: [],
			/** workspaceId -> categoryId */
			assign: {},
			/** workspaceId -> [{ id, name, collapsed, parentId }]; sibling order follows the array. */
			sessionCategories: {},
			/** sessionId -> session category id */
			sessionAssign: {},
			/** sessionId -> true; favorites are local to this tree. */
			favoriteSessions: {},
			/** sessionId -> true; pins reorder sessions only inside this tree. */
			pinnedSessions: {},
			/** workspaceId -> true when its session list is expanded */
			expanded: {},
			/** workspaceId -> how many session rows are shown while expanded */
			visible: {},
			/** Archived sessions: "default" hides them, "show" includes them, "only" isolates them. */
			archivedFilter: 'default',
			/** Whether the unclassified group is collapsed. */
			unassignedCollapsed: false
		}
		const SESSION_STEP = 10
		const SESSION_DEFAULT = 5
		/** Mirrors the built-in browser's tri-state archived-row filter. */
		const ARCHIVED_FILTERS = ['default', 'show', 'only']

		/** Drop category entries that cannot be rendered, then reparent the rest onto existing, acyclic parents. */
		function sanitizeCategories(raw) {
			const categories = []
			const known = new Set()
			for (const entry of Array.isArray(raw) ? raw : []) {
				if (entry === null || typeof entry !== 'object') continue
				if (typeof entry.id !== 'string' || known.has(entry.id)) continue
				known.add(entry.id)
				categories.push({
					id: entry.id,
					name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : '未命名分类',
					collapsed: entry.collapsed === true,
					parentId: typeof entry.parentId === 'string' ? entry.parentId : null
				})
			}
			const byId = new Map(categories.map((category) => [category.id, category]))
			for (const category of categories) {
				let current = category
				const seen = new Set()
				while (current.parentId !== null) {
					if (!byId.has(current.parentId) || seen.has(current.id)) {
						category.parentId = null
						break
					}
					seen.add(current.id)
					current = byId.get(current.parentId)
				}
			}
			return categories
		}

		/** Session categories are independent per workspace, so each map value is a category list of the same shape. */
		function sanitizeSessionCategories(raw) {
			const byWorkspace = {}
			if (raw === null || typeof raw !== 'object') return byWorkspace
			for (const [workspaceId, list] of Object.entries(raw)) {
				if (workspaceId === '') continue
				const categories = sanitizeCategories(list)
				if (categories.length > 0) byWorkspace[workspaceId] = categories
			}
			return byWorkspace
		}

		/** Keep only explicit true flags so removed entries cannot linger in storage. */
		function sanitizeFlags(raw) {
			const flags = {}
			if (raw === null || typeof raw !== 'object') return flags
			for (const [id, value] of Object.entries(raw)) {
				if (id !== '' && value === true) flags[id] = true
			}
			return flags
		}

		/** V1 stored one flat category level; move it to V2 root categories. */
		function migrateV1(raw) {
			if (raw === null || typeof raw !== 'object' || raw.version !== 1) return raw
			return Object.assign({}, raw, {
				version: 2,
				categories: Array.isArray(raw.categories)
					? raw.categories
							.filter((entry) => entry !== null && typeof entry === 'object')
							.map((entry) => ({
								id: entry.id,
								name: entry.name,
								collapsed: entry.collapsed === true,
								parentId: null
							}))
					: [],
				sessionCategories: {},
				sessionAssign: {}
			})
		}

		function sanitize(raw) {
			const merged = Object.assign({}, DEFAULTS, migrateV1(raw) || {})
			const categories = sanitizeCategories(merged.categories)
			const known = new Set(categories.map((category) => category.id))
			const assign = {}
			if (merged.assign !== null && typeof merged.assign === 'object') {
				for (const [workspaceId, categoryId] of Object.entries(merged.assign)) {
					if (known.has(categoryId)) assign[workspaceId] = categoryId
				}
			}
			const sessionCategories = sanitizeSessionCategories(merged.sessionCategories)
			const knownSessionCategories = new Set()
			for (const list of Object.values(sessionCategories)) {
				for (const category of list) knownSessionCategories.add(category.id)
			}
			const sessionAssign = {}
			if (merged.sessionAssign !== null && typeof merged.sessionAssign === 'object') {
				for (const [sessionId, categoryId] of Object.entries(merged.sessionAssign)) {
					if (knownSessionCategories.has(categoryId)) sessionAssign[sessionId] = categoryId
				}
			}
			return {
				version: 2,
				mode: merged.mode === 'native' ? 'native' : 'tree',
				categories,
				assign,
				sessionCategories,
				sessionAssign,
				favoriteSessions: sanitizeFlags(merged.favoriteSessions),
				pinnedSessions: sanitizeFlags(merged.pinnedSessions),
				expanded: merged.expanded && typeof merged.expanded === 'object' ? Object.assign({}, merged.expanded) : {},
				visible: merged.visible && typeof merged.visible === 'object' ? Object.assign({}, merged.visible) : {},
				archivedFilter: ARCHIVED_FILTERS.indexOf(merged.archivedFilter) === -1 ? 'default' : merged.archivedFilter,
				unassignedCollapsed: merged.unassignedCollapsed === true
			}
		}

		function readState() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY)
				if (raw === null) return sanitize(null)
				const parsed = JSON.parse(raw)
				const state = sanitize(parsed)
				if (parsed !== null && typeof parsed === 'object' && parsed.version === 1) {
					try {
						window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
					} catch (error) {
						console.warn('[workspace-tree] could not persist migrated state', error)
					}
				}
				return state
			} catch (error) {
				console.warn('[workspace-tree] could not read saved state', error)
				return sanitize(null)
			}
		}

		let viewState = readState()
		const stateListeners = new Set()

		function getViewState() {
			return viewState
		}

		function updateViewState(patch) {
			const next = typeof patch === 'function' ? patch(viewState) : patch
			viewState = Object.assign({}, viewState, next)
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(viewState))
			} catch (error) {
				console.warn('[workspace-tree] could not persist state', error)
			}
			for (const listener of Array.from(stateListeners)) {
				try {
					listener()
				} catch (error) {
					console.error('[workspace-tree] state listener failed', error)
				}
			}
		}

		function subscribeViewState(listener) {
			stateListeners.add(listener)
			return () => {
				stateListeners.delete(listener)
			}
		}

		function useViewState() {
			return react.useSyncExternalStore(subscribeViewState, getViewState, getViewState)
		}

		/** Subscribe to one of the Cordis snapshot stores delivered as a prop. */
		function useStoreSnapshot(store) {
			const subscribe = react.useCallback((listener) => store.subscribe(listener), [store])
			const getSnapshot = react.useCallback(() => store.getSnapshot(), [store])
			return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
		}

		let idSeq = 0
		function newCategoryId() {
			idSeq += 1
			return 'cat_' + Date.now().toString(36) + '_' + idSeq.toString(36)
		}

		/* ------------------------------------------------------------------ *
		 * Derivations
		 * ------------------------------------------------------------------ */

		const UNASSIGNED_ID = '__unassigned__'

		function timeOf(value) {
			if (typeof value === 'number' && Number.isFinite(value)) return value
			const parsed = Date.parse(typeof value === 'string' ? value : '')
			return Number.isNaN(parsed) ? 0 : parsed
		}

		/** Message for a thrown value, whatever it happens to be. */
		function describe(reason) {
			return reason instanceof Error ? reason.message : String(reason)
		}

		/**
		 * Sessions belonging to one workspace, in the browser's own order.
		 *
		 * Rows carry an `archived` flag so the tree can offer archive on a live
		 * row and unarchive on a restored one. The filter is tri-state and
		 * mirrors the built-in browser exactly: "default" drops archived rows,
		 * "show" keeps everything, "only" keeps archived rows exclusively.
		 *
		 * @param workspace - workspace item from the workspaces snapshot.
		 * @param workspaceSnapshot - `workspaces.list` snapshot (archive/pin sets).
		 * @param sessionSnapshot - `sessions.list` snapshot (row metadata).
		 * @param categoryFilter - lowercased search needle; '' means no filter.
		 * @param archivedFilter - "default" | "show" | "only".
		 * @returns session rows, pinned first then most recently updated.
		 */
		function sessionsOf(workspace, workspaceSnapshot, sessionSnapshot, categoryFilter, archivedFilter) {
			const archived = new Set(workspaceSnapshot.archivedSessionIds || [])
			const pinned = new Set(workspaceSnapshot.pinnedSessionIds || [])
			const rows = []
			for (const id of workspace.sessionIds || []) {
				const summary = (sessionSnapshot.byId || {})[id]
				if (summary === undefined) continue
				const isArchived = archived.has(id)
				if (archivedFilter === 'default' && isArchived) continue
				if (archivedFilter === 'only' && !isArchived) continue
				// Subagent source sessions stay out of the tree, like the built-in browser.
				if (summary.parentId !== undefined || summary.origin === 'subagent') continue
				if (categoryFilter !== '' && !matches(summary, categoryFilter)) continue
				rows.push(Object.assign({}, summary, { archived: isArchived }))
			}
			rows.sort((left, right) => {
				const pl = pinned.has(left.id) ? 0 : 1
				const pr = pinned.has(right.id) ? 0 : 1
				if (pl !== pr) return pl - pr
				return timeOf(right.updatedAt) - timeOf(left.updatedAt)
			})
			return rows
		}

		function matches(summary, needle) {
			if (needle === '') return true
			const haystack = [summary.displayTitle, summary.title, summary.cwd, summary.id]
				.filter((value) => typeof value === 'string')
				.join('\u0000')
				.toLowerCase()
			return haystack.includes(needle)
		}

		function matchesWorkspace(workspace, needle) {
			if (needle === '') return true
			const haystack = [workspace.title, workspace.path, workspace.workspaceId]
				.filter((value) => typeof value === 'string')
				.join('\u0000')
				.toLowerCase()
			return haystack.includes(needle)
		}

		/** Group workspace items under the declared categories. */
		function groupWorkspaces(workspaces, state) {
			const known = new Set(state.categories.map((category) => category.id))
			const buckets = new Map(state.categories.map((category) => [category.id, []]))
			const unassigned = []
			for (const workspace of workspaces) {
				const target = state.assign[workspace.workspaceId]
				if (target !== undefined && known.has(target)) buckets.get(target).push(workspace)
				else unassigned.push(workspace)
			}
			return { buckets, unassigned }
		}

		/** Map parentId -> children, keeping the stored array order as sibling order. */
		function categoryTree(categories) {
			const known = new Set(categories.map((category) => category.id))
			const children = new Map()
			for (const category of categories) {
				const parentId = category.parentId === null || !known.has(category.parentId) ? null : category.parentId
				const list = children.get(parentId)
				if (list === undefined) children.set(parentId, [category])
				else list.push(category)
			}
			return children
		}

		/** One category plus every category nested anywhere below it. */
		function categorySubtree(categories, id) {
			const subtree = new Set([id])
			let changed = true
			while (changed) {
				changed = false
				for (const category of categories) {
					if (!subtree.has(category.id) && subtree.has(category.parentId)) {
						subtree.add(category.id)
						changed = true
					}
				}
			}
			return subtree
		}

		/** Category ids from the given category up to its root, for revealing it. */
		function categoryLineage(categories, id) {
			const byId = new Map(categories.map((category) => [category.id, category]))
			const lineage = new Set()
			let current = byId.get(id)
			while (current !== undefined && !lineage.has(current.id)) {
				lineage.add(current.id)
				current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined
			}
			return lineage
		}

		/** Depth-first category list with nesting depth, for indented labels. */
		function flattenCategories(categories) {
			const children = categoryTree(categories)
			const seen = new Set()
			const rows = []
			const visit = (parentId, depth) => {
				for (const category of children.get(parentId) || []) {
					if (seen.has(category.id)) continue
					seen.add(category.id)
					rows.push({ category, depth })
					visit(category.id, depth + 1)
				}
			}
			visit(null, 0)
			return rows
		}

		/**
		 * Move one category next to or inside another.
		 *
		 * Edge "before" / "after" makes it the target's sibling, "inside" makes
		 * it the target's last child. Moves onto itself or into its own subtree
		 * return null so the caller can leave the state untouched.
		 */
		function moveCategory(categories, categoryId, targetId, edge) {
			if (categoryId === targetId) return null
			const dragged = categories.find((category) => category.id === categoryId)
			const target = categories.find((category) => category.id === targetId)
			if (dragged === undefined || target === undefined) return null
			if (categorySubtree(categories, categoryId).has(targetId)) return null
			const rest = categories.filter((category) => category.id !== categoryId)
			if (edge === 'inside') {
				const expanded = rest.map((category) =>
					category.id === targetId ? Object.assign({}, category, { collapsed: false }) : category
				)
				return expanded.concat([Object.assign({}, dragged, { parentId: targetId })])
			}
			const parentId = target.parentId === undefined ? null : target.parentId
			const expanded = rest.map((category) =>
				category.id === parentId ? Object.assign({}, category, { collapsed: false }) : category
			)
			const index = expanded.findIndex((category) => category.id === targetId)
			expanded.splice(edge === 'before' ? index : index + 1, 0, Object.assign({}, dragged, { parentId }))
			return expanded
		}

		/** Detach one category to the end of the root list. */
		function moveCategoryToRoot(categories, categoryId) {
			const dragged = categories.find((category) => category.id === categoryId)
			if (dragged === undefined) return null
			return categories
				.filter((category) => category.id !== categoryId)
				.concat([Object.assign({}, dragged, { parentId: null })])
		}

		/** Which third of a row a drag pointer is over: reorder above, nest, or reorder below. */
		function dropEdgeOf(event) {
			const rect = event.currentTarget.getBoundingClientRect()
			if (rect.height === 0) return 'inside'
			const ratio = (event.clientY - rect.top) / rect.height
			if (ratio < 0.3) return 'before'
			if (ratio > 0.7) return 'after'
			return 'inside'
		}

		function currentMainSession(sessionSnapshot) {
			for (const id of sessionSnapshot.ids || []) {
				const summary = (sessionSnapshot.byId || {})[id]
				if (summary !== undefined && (summary.retainedBy || {}).mainView > 0) return id
			}
			return undefined
		}

		function workspaceOf(sessionId, workspaces) {
			for (const workspace of workspaces) {
				if ((workspace.sessionIds || []).includes(sessionId)) return workspace.workspaceId
			}
			return undefined
		}

		/* ------------------------------------------------------------------ *
		 * Icons
		 * ------------------------------------------------------------------ */

		const PATHS = {
			chevron: 'M6 3.5 10.5 8 6 12.5',
			plus: 'M8 3.2v9.6M3.2 8h9.6',
			pencil: 'M11.6 2.4l2 2-7.4 7.4-2.8.8.8-2.8z',
			close: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6',
			search: 'M7 2.6a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8zM10.3 10.3 13.6 13.6',
			layers: 'M8 2.2 14 5.5 8 8.8 2 5.5zM2 9l6 3.3L14 9M2 12.2 8 15.5l6-3.3',
			list: 'M3 4.2h10M3 8h10M3 11.8h10',
			folder: 'M2.2 4.6A1.6 1.6 0 0 1 3.8 3h2.1l1.3 1.7h5A1.6 1.6 0 0 1 13.8 6.3v5.1A1.6 1.6 0 0 1 12.2 13H3.8A1.6 1.6 0 0 1 2.2 11.4z',
			chat: 'M13.6 8.1c0 2.6-2.5 4.7-5.6 4.7-.7 0-1.4-.1-2-.3L2.9 14l1-2.5C3.2 10.7 2.9 9.5 2.9 8.1 2.9 5.5 5.4 3.4 8 3.4s5.6 2.1 5.6 4.7z',
			archive: 'M2.4 2.9h11.2v2.9H2.4zM3.4 5.8h9.2v6.6a1.2 1.2 0 0 1-1.2 1.2H4.6a1.2 1.2 0 0 1-1.2-1.2zM6.3 8.3h3.4',
			unarchive: 'M2.4 2.9h11.2v2.9H2.4zM3.4 5.8h9.2v6.6a1.2 1.2 0 0 1-1.2 1.2H4.6a1.2 1.2 0 0 1-1.2-1.2zM8 12.9V8.1M6.1 10l1.9-1.9L9.9 10',
			filter: 'M2.6 4h10.8L9.2 8.6v4.1l-2.4 1.2V8.6z',
			subfolder: [
				'M2.2 4.6A1.6 1.6 0 0 1 3.8 3h2.1l1.3 1.7h5A1.6 1.6 0 0 1 13.8 6.3v5.1A1.6 1.6 0 0 1 12.2 13H3.8A1.6 1.6 0 0 1 2.2 11.4z',
				'M8 7.5v3.6M6.2 9.3h3.6'
			],
			more: 'M3 8h.01M8 8h.01M13 8h.01',
			spinner: 'M8 2.2a5.8 5.8 0 1 1-5.8 5.8',
			locate: 'M8 2.5v2.1M8 11.4v2.1M2.5 8h2.1M11.4 8h2.1M8 5.3a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4z',
			star: 'M8 2.4l1.7 3.5 3.9.6-2.8 2.7.7 3.9L8 11.3l-3.5 1.8.7-3.9L2.4 6.5l3.9-.6z',
			pin: 'M9.5 2.2l4.3 4.3-2 .4-2.6 2.6.4 1.8-1.3 1.3-4.9-4.9 1.3-1.3 1.8.4L9.1 4.2zM6.5 9.5 3.2 12.8'
		}

		function Icon(props) {
			const size = props.size === undefined ? 13 : props.size
			const paths = Array.isArray(PATHS[props.name]) ? PATHS[props.name] : [PATHS[props.name]]
			return h(
				'svg',
				{
					className: 'twt-svg',
					viewBox: '0 0 16 16',
					width: size,
					height: size,
					'aria-hidden': 'true',
					focusable: 'false'
				},
				paths.map((d, index) =>
					h('path', {
						key: index,
						d,
						fill: 'none',
						stroke: 'currentColor',
						strokeWidth:
							props.name === 'chevron' ? 1.7 : props.name === 'more' ? 2.4 : props.name === 'spinner' ? 1.6 : 1.35,
						strokeLinecap: 'round',
						strokeLinejoin: 'round'
					})
				)
			)
		}

		function cls() {
			let out = ''
			for (const value of arguments) {
				if (typeof value === 'string' && value !== '') out = out === '' ? value : out + ' ' + value
			}
			return out
		}

		/**
		 * A hover-revealed icon button that never steals the row's own click.
		 *
		 * The hint is the app's own `Tooltip` primitive when it is seeded (same
		 * side/align/delay as the built-in browser's archive button, so the pill
		 * lands below the icon, right-aligned, after 500 ms). Without the
		 * primitive the button falls back to a native `title` — and only then,
		 * because two tooltips for one hover would be worse than none.
		 */
		function RowButton(props) {
			const button = h(
				'button',
				{
					type: 'button',
					className: cls('twt-icon', props.className),
					title: Tooltip === null ? props.label : undefined,
					'aria-label': props.label,
					disabled: props.disabled === true,
					onClick: (event) => {
						event.preventDefault()
						event.stopPropagation()
						if (props.disabled === true) return
						props.onClick(event)
					},
					onMouseDown: (event) => event.stopPropagation()
				},
				props.children
			)
			if (Tooltip === null) return button
			return h(
				Tooltip,
				{ label: props.label, side: 'bottom', align: 'end', delayMs: 500 },
				button
			)
		}

		/* ------------------------------------------------------------------ *
		 * Tree rows
		 * ------------------------------------------------------------------ */

		/** Open a row's shared context menu at the pointer target (a button or the row itself). */
		function menuAt(event, openMenu, target) {
			event.preventDefault()
			event.stopPropagation()
			if (typeof openMenu !== 'function' || target === undefined) return
			const rect = event.currentTarget.getBoundingClientRect()
			openMenu(target, { x: rect.left, y: rect.bottom })
		}

		function SessionRow(props) {
			const { summary, active, dragging, favorite, pinned, onOpen, onFavorite, onPin, onDragStart, onDragEnd, openMenu, target } = props
			const archived = summary.archived === true
			return h(
				'div',
				{
					className: cls('twt-row', 'twt-session', active && 'twt-active', archived && 'twt-archived', dragging && 'twt-dragging'),
					role: 'button',
					tabIndex: 0,
					title: summary.displayTitle,
					draggable: typeof onDragStart === 'function',
					onDragStart,
					onDragEnd,
					onContextMenu: (event) => menuAt(event, openMenu, target),
					onClick: () => onOpen(summary.id),
					onKeyDown: (event) => {
						if (event.target !== event.currentTarget) return
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault()
							onOpen(summary.id)
						}
					}
				},
				h('span', { className: 'twt-glyph' }, h(Icon, { name: archived ? 'archive' : 'chat', size: 12 })),
				h('span', { className: cls('twt-label', summary.blank && 'twt-muted') }, summary.displayTitle),
				summary.running ? h('span', { className: 'twt-pulse', title: '运行中' }) : null,
				favorite || pinned
					? h(
							'span',
							{ className: 'twt-marks' },
							favorite ? h('span', { className: 'twt-mark', title: '已收藏' }, h(Icon, { name: 'star', size: 11 })) : null,
							pinned ? h('span', { className: 'twt-mark', title: '已置顶' }, h(Icon, { name: 'pin', size: 11 })) : null
						)
					: null,
				h(
					'div',
					{ className: 'twt-actions' },
					h(RowButton, { label: favorite ? '取消收藏' : '收藏会话', onClick: onFavorite }, h(Icon, { name: 'star' })),
					h(RowButton, { label: pinned ? '取消置顶' : '置顶会话', onClick: onPin }, h(Icon, { name: 'pin' })),
					h(
						RowButton,
						{ label: '更多操作', onClick: (event) => menuAt(event, openMenu, target) },
						h(Icon, { name: 'more' })
					)
				)
			)
		}

		function WorkspaceRow(props) {
			const {
				workspace,
				sessions,
				expanded,
				renaming,
				onToggle,
				onNewSession,
				onRenameCommit,
				onRenameCancel,
				onDragStart,
				onDragEnd,
				openMenu,
				target
			} = props
			const title = workspace.title || workspace.path
			const inputRef = react.useRef(null)
			const settled = react.useRef(false)
			react.useEffect(() => {
				if (!renaming) return
				settled.current = false
				if (inputRef.current !== null) {
					inputRef.current.focus()
					inputRef.current.select()
				}
			}, [renaming])
			const commitRename = (value) => {
				if (settled.current) return
				settled.current = true
				onRenameCommit(value)
			}
			const cancelRename = () => {
				if (settled.current) return
				settled.current = true
				onRenameCancel()
			}

			return h(
				'div',
				{ className: 'twt-workspace', 'data-workspace-id': workspace.workspaceId },
				h(
					'div',
					{
						className: 'twt-row twt-ws-head',
						role: 'button',
						tabIndex: 0,
						title: workspace.path,
						draggable: renaming !== true,
						onDragStart,
						onDragEnd,
						onContextMenu: (event) => menuAt(event, openMenu, target),
						onClick: onToggle,
						onKeyDown: (event) => {
							if (event.target !== event.currentTarget) return
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault()
								onToggle()
							}
						}
					},
					h(
						'button',
						{
							type: 'button',
							className: cls('twt-chevron', expanded && 'twt-chevron-open'),
							'aria-label': expanded ? '折叠' : '展开',
							'aria-expanded': expanded,
							onClick: (event) => {
								event.stopPropagation()
								onToggle()
							}
						},
						h(Icon, { name: 'chevron', size: 11 })
					),
					renaming
						? h('input', {
								ref: inputRef,
								className: 'twt-input twt-input-inline',
								defaultValue: title,
								onClick: (event) => event.stopPropagation(),
								onBlur: (event) => commitRename(event.target.value),
								onKeyDown: (event) => {
									event.stopPropagation()
									if (event.key === 'Enter') commitRename(event.currentTarget.value)
									else if (event.key === 'Escape') cancelRename()
								}
							})
						: h('span', { className: 'twt-label twt-ws-label' }, title),
					h('span', { className: 'twt-count' }, String(sessions.length)),
					h(
						'div',
						{ className: 'twt-actions' },
						h(RowButton, { label: '在此工作区新建会话', onClick: onNewSession }, h(Icon, { name: 'plus' })),
						h(
							RowButton,
							{ label: '更多操作', onClick: (event) => menuAt(event, openMenu, target) },
							h(Icon, { name: 'more' })
						)
					)
				),
				expanded ? h('div', { className: 'twt-sessions' }, props.body) : null
			)
		}

		/**
		 * Inline name field for a new category: full width in the header, or a
		 * compact row that lands inside its future parent.
		 */
		function CategoryCreator(props) {
			const finished = react.useRef(false)
			const finish = (value) => {
				if (finished.current) return
				finished.current = true
				props.onCommit(value)
			}
			return h('input', {
				className: props.inline ? 'twt-input twt-input-create' : 'twt-input',
				autoFocus: true,
				placeholder: props.placeholder !== undefined ? props.placeholder : props.inline ? '子分类名称，回车确认' : '分类名称，回车确认',
				onClick: (event) => event.stopPropagation(),
				onKeyDown: (event) => {
					event.stopPropagation()
					if (event.key === 'Enter') finish(event.currentTarget.value)
					else if (event.key === 'Escape') {
						finished.current = true
						props.onCancel()
					}
				},
				onBlur: (event) => finish(event.target.value)
			})
		}

		function CategoryRow(props) {
			const {
				category,
				count,
				kind,
				dropEdge,
				dragging,
				renaming,
				busy,
				onToggle,
				onRenameCommit,
				onRenameCancel,
				onNewWorkspace,
				onNewCategory,
				onDragStart,
				onDragEnd,
				onDragOver,
				onDragLeave,
				onDrop,
				openMenu,
				target
			} = props
			const sessionCategory = kind === 'session'

			const inputRef = react.useRef(null)
			const settled = react.useRef(false)
			react.useEffect(() => {
				if (!renaming) return
				settled.current = false
				if (inputRef.current !== null) {
					inputRef.current.focus()
					inputRef.current.select()
				}
			}, [renaming])
			const commitRename = (value) => {
				if (settled.current) return
				settled.current = true
				onRenameCommit(value)
			}
			const cancelRename = () => {
				if (settled.current) return
				settled.current = true
				onRenameCancel()
			}

			return h(
				'div',
				{
					className: cls(
						'twt-row',
						'twt-cat',
						sessionCategory && 'twt-scat',
						dropEdge === 'inside' && 'twt-drop',
						dropEdge === 'before' && 'twt-drop-before',
						dropEdge === 'after' && 'twt-drop-after',
						dragging && 'twt-dragging'
					),
					role: 'button',
					tabIndex: 0,
					title: '拖动可排序；拖到行中间成为子分类，拖到行边缘调整同级顺序',
					draggable: renaming !== true,
					onDragStart,
					onDragEnd,
					onDragOver,
					onDragLeave,
					onDrop,
					onContextMenu: (event) => menuAt(event, openMenu, target),
					onClick: onToggle,
					onKeyDown: (event) => {
						if (event.target !== event.currentTarget) return
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault()
							onToggle()
						}
					}
				},
				h(
					'button',
					{
						type: 'button',
						className: cls('twt-chevron', !category.collapsed && 'twt-chevron-open'),
						'aria-label': category.collapsed ? '展开' : '折叠',
						onMouseDown: (event) => event.stopPropagation(),
						onClick: (event) => {
							event.stopPropagation()
							onToggle()
						}
					},
					h(Icon, { name: 'chevron', size: 11 })
				),
				renaming
					? h('input', {
							ref: inputRef,
							className: 'twt-input twt-input-inline',
							defaultValue: category.name,
							onClick: (event) => event.stopPropagation(),
							onBlur: (event) => commitRename(event.target.value),
							onKeyDown: (event) => {
								event.stopPropagation()
								if (event.key === 'Enter') commitRename(event.currentTarget.value)
								else if (event.key === 'Escape') cancelRename()
							}
						})
					: h('span', { className: 'twt-label twt-cat-label' }, category.name),
				h('span', { className: 'twt-count' }, String(count)),
				h(
					'div',
					{ className: 'twt-actions' },
					sessionCategory
						? null
						: h(
								'button',
								{
									type: 'button',
									className: cls('twt-icon', busy && 'twt-busy'),
									title: busy ? '正在选择文件夹…' : '在此分类新建工作区',
									'aria-label': '在此分类新建工作区',
									disabled: busy,
									onMouseDown: (event) => event.stopPropagation(),
									onClick: (event) => {
										event.stopPropagation()
										onNewWorkspace()
									}
								},
								h(Icon, { name: busy ? 'spinner' : 'plus' })
							),
					h(RowButton, { label: '新建子分类', onClick: onNewCategory }, h(Icon, { name: 'subfolder' })),
					h(
						RowButton,
						{ label: '更多操作', onClick: (event) => menuAt(event, openMenu, target) },
						h(Icon, { name: 'more' })
					)
				)
			)
		}

		/* ------------------------------------------------------------------ *
		 * The tree
		 * ------------------------------------------------------------------ */

		function WorkspaceTree(props) {
			const state = useViewState()
			const workspaceSnapshot = useStoreSnapshot(props.workspacesStore)
			const sessionSnapshot = useStoreSnapshot(props.sessionsStore)

			const [query, setQuery] = react.useState('')
			const [renamingId, setRenamingId] = react.useState(null)
			const [renamingWorkspaceId, setRenamingWorkspaceId] = react.useState(null)
			const [renamingSessionCategoryId, setRenamingSessionCategoryId] = react.useState(null)
			const [creatingIn, setCreatingIn] = react.useState(null)
			const [creatingSessionCategory, setCreatingSessionCategory] = react.useState(null)
			const [dragState, setDragState] = react.useState(null)
			const [dropHint, setDropHint] = react.useState(null)
			const [adding, setAdding] = react.useState(false)
			const [error, setError] = react.useState(null)
			const scrollRef = react.useRef(null)

			const narrow = props.wide === false
			const needle = query.trim().toLowerCase()

			const workspaceItems = react.useMemo(
				() => (workspaceSnapshot.items || []).filter((workspace) => matchesWorkspace(workspace, needle)),
				[workspaceSnapshot, needle]
			)
			const grouped = react.useMemo(() => groupWorkspaces(workspaceItems, state), [workspaceItems, state])
			const tree = react.useMemo(() => categoryTree(state.categories), [state.categories])
			const categoryOptions = react.useMemo(() => flattenCategories(state.categories), [state.categories])
			const activeSessionId = currentMainSession(sessionSnapshot)
			const activeWorkspaceId = activeSessionId === undefined ? undefined : workspaceOf(activeSessionId, workspaceSnapshot.items || [])

			// ---- mutations ----

			const assign = react.useCallback((workspaceId, categoryId) => {
				updateViewState((current) => {
					const next = Object.assign({}, current.assign)
					if (categoryId === UNASSIGNED_ID || categoryId === undefined) delete next[workspaceId]
					else next[workspaceId] = categoryId
					return { assign: next }
				})
			}, [])

			const createCategory = react.useCallback(
				(name, parentId) => {
					const trimmed = name.trim()
					if (trimmed === '') return
					const parent = parentId === undefined ? null : parentId
					const category = { id: newCategoryId(), name: trimmed, collapsed: false, parentId: parent }
					updateViewState((current) => ({
						categories: current.categories
							.map((entry) =>
								entry.id === parent ? Object.assign({}, entry, { collapsed: false }) : entry
							)
							.concat([category])
					}))
					return category.id
				},
				[]
			)

			const renameCategory = react.useCallback((categoryId, name) => {
				const trimmed = name.trim()
				setRenamingId(null)
				if (trimmed === '') return
				updateViewState((current) => ({
					categories: current.categories.map((category) =>
						category.id === categoryId ? Object.assign({}, category, { name: trimmed }) : category
					)
				}))
			}, [])

			const deleteCategory = react.useCallback((categoryId) => {
				const categories = getViewState().categories
				const category = categories.find((entry) => entry.id === categoryId)
				const subtree = categorySubtree(categories, categoryId)
				const nested = subtree.size - 1
				const label = category === undefined ? '这个分类' : '“' + category.name + '”'
				const suffix = nested === 0 ? '' : '及其 ' + nested + ' 个子分类'
				if (!window.confirm('删除 ' + label + suffix + '？这些分类下的工作区会回到「未分类」。')) return
				updateViewState((current) => {
					const nextAssign = Object.assign({}, current.assign)
					for (const [workspaceId, target] of Object.entries(nextAssign)) {
						if (subtree.has(target)) delete nextAssign[workspaceId]
					}
					return {
						categories: current.categories.filter((entry) => !subtree.has(entry.id)),
						assign: nextAssign
					}
				})
			}, [])

			const toggleCategory = react.useCallback((categoryId) => {
				updateViewState((current) => ({
					categories: current.categories.map((category) =>
						category.id === categoryId ? Object.assign({}, category, { collapsed: !category.collapsed }) : category
					)
				}))
			}, [])

			const toggleUnassigned = react.useCallback(() => {
				updateViewState((current) => ({ unassignedCollapsed: current.unassignedCollapsed !== true }))
			}, [])

			const locateActiveWorkspace = react.useCallback((workspaceId) => {
				updateViewState((current) => {
					const assigned = current.assign[workspaceId]
					const known = assigned !== undefined && current.categories.some((category) => category.id === assigned)
					const lineage = known ? categoryLineage(current.categories, assigned) : null
					const categories =
						lineage === null
							? current.categories
							: current.categories.map((category) =>
								lineage.has(category.id) && category.collapsed === true
									? Object.assign({}, category, { collapsed: false })
									: category
							)
					const expanded = Object.assign({}, current.expanded)
					expanded[workspaceId] = true
					return {
						categories,
						expanded,
						unassignedCollapsed: known ? current.unassignedCollapsed : false
					}
				})
				const reveal = (attempt) => {
					const root = scrollRef.current
					if (root === null) return
					const rows = root.querySelectorAll('[data-workspace-id]')
					for (const row of rows) {
						if (row.getAttribute('data-workspace-id') !== workspaceId) continue
						/* Scroll only this tree, never the page or the sidebar around it:
						 * scrollIntoView() would also move ancestors and make the active
						 * row jump under the pointer. */
						const head = row.querySelector('.twt-ws-head')
						const anchor = head === null ? row : head
						const viewRect = root.getBoundingClientRect()
						const rowRect = anchor.getBoundingClientRect()
						const margin = 4
						if (rowRect.top < viewRect.top + margin) {
							root.scrollTop = Math.max(0, root.scrollTop + rowRect.top - viewRect.top - margin)
						} else if (rowRect.bottom > viewRect.bottom - margin) {
							root.scrollTop = Math.min(root.scrollHeight, root.scrollTop + rowRect.bottom - viewRect.bottom + margin)
						}
						return
					}
					if (attempt === 0 && query !== '') {
						setQuery('')
						setTimeout(() => reveal(1), 0)
					}
				}
				if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => reveal(0))
				else setTimeout(() => reveal(0), 0)
			}, [query])

			const openCategory = react.useCallback((categoryId) => {
				const current = getViewState()
				const category = current.categories.find((entry) => entry.id === categoryId)
				if (category === undefined || category.collapsed !== true) return
				updateViewState((stateAtOpen) => ({
					categories: stateAtOpen.categories.map((entry) =>
						entry.id === categoryId ? Object.assign({}, entry, { collapsed: false }) : entry
					)
				}))
			}, [])

			const toggleFavorite = react.useCallback((sessionId) => {
				updateViewState((current) => {
					const next = Object.assign({}, current.favoriteSessions)
					if (next[sessionId] === true) delete next[sessionId]
					else next[sessionId] = true
					return { favoriteSessions: next }
				})
			}, [])

			const togglePin = react.useCallback((sessionId) => {
				updateViewState((current) => {
					const next = Object.assign({}, current.pinnedSessions)
					if (next[sessionId] === true) delete next[sessionId]
					else next[sessionId] = true
					return { pinnedSessions: next }
				})
			}, [])

			const createSessionCategory = react.useCallback((workspaceId, name, parentId) => {
				const trimmed = name.trim()
				if (trimmed === '') return
				const parent = parentId === undefined ? null : parentId
				const category = { id: newCategoryId(), name: trimmed, collapsed: false, parentId: parent }
				updateViewState((current) => {
					const list = current.sessionCategories[workspaceId] || []
					const next = list
						.map((entry) => (entry.id === parent ? Object.assign({}, entry, { collapsed: false }) : entry))
						.concat([category])
					const sessionCategories = Object.assign({}, current.sessionCategories)
					sessionCategories[workspaceId] = next
					return { sessionCategories }
				})
				return category.id
			}, [])

			const openSessionCategory = react.useCallback((workspaceId, categoryId) => {
				const list = getViewState().sessionCategories[workspaceId] || []
				if (!list.some((entry) => entry.id === categoryId && entry.collapsed === true)) return
				updateViewState((current) => {
					const currentList = current.sessionCategories[workspaceId] || []
					const nextList = currentList.map((entry) =>
						entry.id === categoryId ? Object.assign({}, entry, { collapsed: false }) : entry
					)
					const sessionCategories = Object.assign({}, current.sessionCategories)
					sessionCategories[workspaceId] = nextList
					return { sessionCategories }
				})
			}, [])

			const renameSessionCategory = react.useCallback((workspaceId, categoryId, name) => {
				const trimmed = name.trim()
				setRenamingSessionCategoryId(null)
				if (trimmed === '') return
				updateViewState((current) => {
					const list = current.sessionCategories[workspaceId] || []
					const sessionCategories = Object.assign({}, current.sessionCategories)
					sessionCategories[workspaceId] = list.map((category) =>
						category.id === categoryId ? Object.assign({}, category, { name: trimmed }) : category
					)
					return { sessionCategories }
				})
			}, [])

			const deleteSessionCategory = react.useCallback((workspaceId, categoryId) => {
				const list = getViewState().sessionCategories[workspaceId] || []
				const category = list.find((entry) => entry.id === categoryId)
				const subtree = categorySubtree(list, categoryId)
				const nested = subtree.size - 1
				const label = category === undefined ? '这个会话分类' : '“' + category.name + '”'
				const suffix = nested === 0 ? '' : '及其 ' + nested + ' 个子分类'
				if (!window.confirm('删除 ' + label + suffix + '？这些分类下的会话会回到工作区下。')) return
				updateViewState((current) => {
					const currentList = current.sessionCategories[workspaceId] || []
					const nextList = currentList.filter((entry) => !subtree.has(entry.id))
					const sessionCategories = Object.assign({}, current.sessionCategories)
					if (nextList.length === 0) delete sessionCategories[workspaceId]
					else sessionCategories[workspaceId] = nextList
					const nextAssign = Object.assign({}, current.sessionAssign)
					for (const [sessionId, target] of Object.entries(nextAssign)) {
						if (subtree.has(target)) delete nextAssign[sessionId]
					}
					return { sessionCategories, sessionAssign: nextAssign }
				})
			}, [])

			const toggleSessionCategory = react.useCallback((workspaceId, categoryId) => {
				updateViewState((current) => {
					const list = current.sessionCategories[workspaceId] || []
					const sessionCategories = Object.assign({}, current.sessionCategories)
					sessionCategories[workspaceId] = list.map((category) =>
						category.id === categoryId ? Object.assign({}, category, { collapsed: !category.collapsed }) : category
					)
					return { sessionCategories }
				})
			}, [])

			const assignSession = react.useCallback((workspaceId, sessionId, categoryId) => {
				const list = getViewState().sessionCategories[workspaceId] || []
				if (categoryId !== null && categoryId !== undefined && !list.some((entry) => entry.id === categoryId)) return
				updateViewState((current) => {
					const sessionAssign = Object.assign({}, current.sessionAssign)
					if (categoryId === null || categoryId === undefined) delete sessionAssign[sessionId]
					else sessionAssign[sessionId] = categoryId
					let sessionCategories = current.sessionCategories
					if (categoryId !== null && categoryId !== undefined) {
						const currentList = current.sessionCategories[workspaceId] || []
						const byId = new Map(currentList.map((entry) => [entry.id, entry]))
						const open = new Set()
						let cursor = byId.get(categoryId)
						while (cursor !== undefined && !open.has(cursor.id)) {
							open.add(cursor.id)
							cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
						}
						const nextList = currentList.map((entry) =>
							entry.collapsed === true && open.has(entry.id) ? Object.assign({}, entry, { collapsed: false }) : entry
						)
						if (nextList.some((entry, index) => entry !== currentList[index])) {
							sessionCategories = Object.assign({}, current.sessionCategories)
							sessionCategories[workspaceId] = nextList
						}
					}
					return { sessionAssign, sessionCategories }
				})
			}, [])

			const toggleWorkspace = react.useCallback((workspaceId) => {
				updateViewState((current) => {
					const next = Object.assign({}, current.expanded)
					if (next[workspaceId] === true) delete next[workspaceId]
					else next[workspaceId] = true
					return { expanded: next }
				})
			}, [])

			const expandWorkspace = react.useCallback((workspaceId) => {
				updateViewState((current) => {
					if (current.expanded[workspaceId] === true) return {}
					const next = Object.assign({}, current.expanded)
					next[workspaceId] = true
					return { expanded: next }
				})
			}, [])

			const showMore = react.useCallback((workspaceId) => {
				updateViewState((current) => {
					const next = Object.assign({}, current.visible)
					next[workspaceId] = (next[workspaceId] === undefined ? SESSION_DEFAULT : next[workspaceId]) + SESSION_STEP
					return { visible: next }
				})
			}, [])

			const openSession = react.useCallback(
				(sessionId) => {
					try {
						props.openSession(sessionId)
					} catch (error) {
						console.error('[workspace-tree] open session failed', error)
					}
				},
				[props.openSession]
			)

			const newSession = react.useCallback(
				(workspaceId) => {
					try {
						props.startSession(workspaceId)
					} catch (error) {
						console.error('[workspace-tree] new session failed', error)
					}
				},
				[props.startSession]
			)

			const newSessionInCategory = react.useCallback(
				(workspaceId, categoryId) => {
					Promise.resolve(props.connectSession(workspaceId))
						.then((sessionId) => {
							assignSession(workspaceId, sessionId, categoryId)
							openSession(sessionId)
						})
						.catch((reason) => {
							setError('新建会话失败：' + describe(reason))
							console.error('[workspace-tree] new session failed', reason)
						})
				},
				[assignSession, openSession, props.connectSession]
			)

			/**
			 * Add a workspace through the same desktop directory chooser the
			 * native browser uses, then file it under the category whose `＋` was
			 * clicked (`UNASSIGNED_ID` / undefined leaves it uncategorised).
			 *
			 * Re-entrancy is guarded on `adding`, not on a ref, because the button
			 * is disabled while the chooser is up — and the chooser can stay up
			 * for as long as the user browses.
			 */
			const addWorkspace = react.useCallback(
				(categoryId) => {
					if (adding) return
					setError(null)
					setAdding(true)
					Promise.resolve(props.createWorkspace())
						.then((workspace) => {
							if (workspace === null || workspace === undefined) return
							if (categoryId === undefined || categoryId === UNASSIGNED_ID) return
							assign(workspace.workspaceId, categoryId)
						})
						.catch((reason) => {
							setError('新建工作区失败：' + describe(reason))
							console.error('[workspace-tree] add workspace failed', reason)
						})
						.finally(() => setAdding(false))
				},
				[adding, assign, props.createWorkspace]
			)

			// ---- workspace rename / delete ----

			const renameWorkspace = react.useCallback(
				(workspaceId, name) => {
					const trimmed = name.trim()
					setRenamingWorkspaceId(null)
					if (trimmed === '') return
					Promise.resolve(props.renameWorkspace(workspaceId, trimmed)).catch((reason) => {
						setError('重命名工作区失败：' + describe(reason))
						console.error('[workspace-tree] rename workspace failed', reason)
					})
				},
				[props.renameWorkspace]
			)

			const deleteWorkspace = react.useCallback(
				(workspaceId) => {
					const workspace = workspaceItems.find((entry) => entry.workspaceId === workspaceId)
					const title = workspace === undefined ? workspaceId : workspace.title || workspace.path
					const sessionIds = new Set(workspace === undefined ? [] : workspace.sessionIds || [])
					if (!window.confirm('删除工作区 “' + title + '”？工作区内的会话会一并删除。')) return
					setError(null)
					Promise.resolve(props.deleteWorkspace(workspaceId))
						.then(() => {
							updateViewState((current) => {
								const assign = Object.assign({}, current.assign)
								delete assign[workspaceId]
								const sessionCategories = Object.assign({}, current.sessionCategories)
								delete sessionCategories[workspaceId]
								const expanded = Object.assign({}, current.expanded)
								delete expanded[workspaceId]
								const visible = Object.assign({}, current.visible)
								delete visible[workspaceId]
								const sessionAssign = Object.assign({}, current.sessionAssign)
								for (const sessionId of sessionIds) delete sessionAssign[sessionId]
								return { assign, sessionCategories, sessionAssign, expanded, visible }
							})
						})
						.catch((reason) => {
							setError('删除工作区失败：' + describe(reason))
							console.error('[workspace-tree] delete workspace failed', reason)
						})
				},
				[workspaceItems, props.deleteWorkspace]
			)

			// ---- drag & drop: workspaces into categories, categories into categories ----

			const beginDrag = react.useCallback(
				(kind, id, workspaceId) => (event) => {
					event.stopPropagation()
					setDragState({ kind, id, workspaceId })
					setDropHint(null)
					try {
						event.dataTransfer.setData('text/plain', kind + ':' + id)
						event.dataTransfer.setData('application/x-dsh-' + kind + '-id', id)
						event.dataTransfer.effectAllowed = 'move'
					} catch (error) {
						/* React state carries the payload; dataTransfer is only for other drop handlers */
					}
				},
				[]
			)

			const endDrag = react.useCallback(() => {
				setDragState(null)
				setDropHint(null)
			}, [])

			const moveCategoryTo = react.useCallback((categoryId, targetId, edge) => {
				const next = moveCategory(getViewState().categories, categoryId, targetId, edge)
				if (next !== null) updateViewState({ categories: next })
			}, [])

			const moveCategoryToRootEnd = react.useCallback((categoryId) => {
				const next = moveCategoryToRoot(getViewState().categories, categoryId)
				if (next !== null) updateViewState({ categories: next })
			}, [])

			const moveSessionCategoryTo = react.useCallback((workspaceId, categoryId, targetId, edge) => {
				const current = getViewState()
				const list = current.sessionCategories[workspaceId] || []
				const next = moveCategory(list, categoryId, targetId, edge)
				if (next === null) return
				const sessionCategories = Object.assign({}, current.sessionCategories)
				sessionCategories[workspaceId] = next
				updateViewState({ sessionCategories })
			}, [])

			const moveSessionCategoryToRootEnd = react.useCallback((workspaceId, categoryId) => {
				const current = getViewState()
				const list = current.sessionCategories[workspaceId] || []
				const next = moveCategoryToRoot(list, categoryId)
				if (next === null) return
				const sessionCategories = Object.assign({}, current.sessionCategories)
				sessionCategories[workspaceId] = next
				updateViewState({ sessionCategories })
			}, [])

			const hoverCategory = react.useCallback(
				(categoryId) => (event) => {
					if (dragState === null) return
					if (dragState.kind !== 'workspace' && dragState.kind !== 'category') return
					const edge = dragState.kind === 'category' ? dropEdgeOf(event) : 'inside'
					if (dragState.kind === 'category' && categorySubtree(getViewState().categories, dragState.id).has(categoryId)) return
					event.preventDefault()
					event.stopPropagation()
					event.dataTransfer.dropEffect = 'move'
					setDropHint((current) =>
						current !== null && current.type === 'category' && current.categoryId === categoryId && current.edge === edge
							? current
							: { type: 'category', categoryId, edge }
					)
				},
				[dragState]
			)

			const leaveCategory = react.useCallback(
				(categoryId) => (event) => {
					if (event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget)) return
					setDropHint((current) =>
						current !== null && current.type === 'category' && current.categoryId === categoryId ? null : current
					)
				},
				[]
			)

			const dropOnCategory = react.useCallback(
				(categoryId) => (event) => {
					if (dragState === null) return
					if (dragState.kind !== 'workspace' && dragState.kind !== 'category') return
					event.preventDefault()
					event.stopPropagation()
					const dragged = dragState
					const edge = dragged.kind === 'category' ? dropEdgeOf(event) : 'inside'
					setDragState(null)
					setDropHint(null)
					if (dragged.kind === 'workspace') {
						assign(dragged.id, categoryId)
						return
					}
					moveCategoryTo(dragged.id, categoryId, edge)
				},
				[assign, dragState, moveCategoryTo]
			)

			const hoverUnassigned = react.useCallback(
				(event) => {
					if (dragState === null) return
					if (dragState.kind !== 'workspace' && dragState.kind !== 'category') return
					event.preventDefault()
					event.stopPropagation()
					event.dataTransfer.dropEffect = 'move'
					setDropHint((current) => (current !== null && current.type === 'unassigned' ? current : { type: 'unassigned' }))
				},
				[dragState]
			)

			const leaveUnassigned = react.useCallback((event) => {
				if (event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget)) return
				setDropHint((current) => (current !== null && current.type === 'unassigned' ? null : current))
			}, [])

			const dropOnUnassigned = react.useCallback(
				(event) => {
					if (dragState === null) return
					if (dragState.kind !== 'workspace' && dragState.kind !== 'category') return
					event.preventDefault()
					event.stopPropagation()
					const dragged = dragState
					setDragState(null)
					setDropHint(null)
					if (dragged.kind === 'workspace') assign(dragged.id, UNASSIGNED_ID)
					else moveCategoryToRootEnd(dragged.id)
				},
				[assign, dragState, moveCategoryToRootEnd]
			)

			const hoverRoot = react.useCallback(
				(event) => {
					if (dragState === null || dragState.kind !== 'category') return
					event.preventDefault()
					event.stopPropagation()
					event.dataTransfer.dropEffect = 'move'
					setDropHint((current) => (current !== null && current.type === 'root' ? current : { type: 'root' }))
				},
				[dragState]
			)

			const leaveRoot = react.useCallback((event) => {
				if (event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget)) return
				setDropHint((current) => (current !== null && current.type === 'root' ? null : current))
			}, [])

			const dropOnRoot = react.useCallback(
				(event) => {
					if (dragState === null || dragState.kind !== 'category') return
					event.preventDefault()
					event.stopPropagation()
					const categoryId = dragState.id
					setDragState(null)
					setDropHint(null)
					moveCategoryToRootEnd(categoryId)
				},
				[dragState, moveCategoryToRootEnd]
			)

			// ---- drag & drop: sessions into session categories, session categories into each other ----

			const hoverSessionCategory = react.useCallback(
				(workspaceId, categoryId) => (event) => {
					if (dragState === null || dragState.workspaceId !== workspaceId) return
					if (dragState.kind === 'session') {
						event.preventDefault()
						event.stopPropagation()
						event.dataTransfer.dropEffect = 'move'
						setDropHint((current) =>
							current !== null &&
							current.type === 'sessionCategory' &&
							current.workspaceId === workspaceId &&
							current.categoryId === categoryId &&
							current.edge === 'inside'
								? current
								: { type: 'sessionCategory', workspaceId, categoryId, edge: 'inside' }
						)
						return
					}
					if (dragState.kind !== 'sessionCategory') return
					const list = getViewState().sessionCategories[workspaceId] || []
					if (categorySubtree(list, dragState.id).has(categoryId)) return
					const edge = dropEdgeOf(event)
					event.preventDefault()
					event.stopPropagation()
					event.dataTransfer.dropEffect = 'move'
					setDropHint((current) =>
						current !== null &&
						current.type === 'sessionCategory' &&
						current.workspaceId === workspaceId &&
						current.categoryId === categoryId &&
						current.edge === edge
							? current
							: { type: 'sessionCategory', workspaceId, categoryId, edge }
					)
				},
				[dragState]
			)

			const leaveSessionCategory = react.useCallback(
				(workspaceId, categoryId) => (event) => {
					if (event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget)) return
					setDropHint((current) =>
						current !== null &&
						current.type === 'sessionCategory' &&
						current.workspaceId === workspaceId &&
						current.categoryId === categoryId
							? null
							: current
					)
				},
				[]
			)

			const dropOnSessionCategory = react.useCallback(
				(workspaceId, categoryId) => (event) => {
					if (dragState === null || dragState.workspaceId !== workspaceId) return
					const kind = dragState.kind
					if (kind !== 'session' && kind !== 'sessionCategory') return
					event.preventDefault()
					event.stopPropagation()
					const dragged = dragState
					const edge = kind === 'sessionCategory' ? dropEdgeOf(event) : 'inside'
					setDragState(null)
					setDropHint(null)
					if (kind === 'session') assignSession(workspaceId, dragged.id, categoryId)
					else moveSessionCategoryTo(workspaceId, dragged.id, categoryId, edge)
				},
				[assignSession, dragState, moveSessionCategoryTo]
			)

			const hoverSessionRoot = react.useCallback(
				(workspaceId) => (event) => {
					if (dragState === null || dragState.workspaceId !== workspaceId) return
					if (dragState.kind !== 'session' && dragState.kind !== 'sessionCategory') return
					event.preventDefault()
					event.stopPropagation()
					event.dataTransfer.dropEffect = 'move'
					setDropHint((current) =>
						current !== null && current.type === 'sessionRoot' && current.workspaceId === workspaceId
							? current
							: { type: 'sessionRoot', workspaceId }
					)
				},
				[dragState]
			)

			const leaveSessionRoot = react.useCallback(
				(workspaceId) => (event) => {
					if (event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget)) return
					setDropHint((current) =>
						current !== null && current.type === 'sessionRoot' && current.workspaceId === workspaceId ? null : current
					)
				},
				[]
			)

			const dropOnSessionRoot = react.useCallback(
				(workspaceId) => (event) => {
					if (dragState === null || dragState.workspaceId !== workspaceId) return
					if (dragState.kind !== 'session' && dragState.kind !== 'sessionCategory') return
					event.preventDefault()
					event.stopPropagation()
					const dragged = dragState
					setDragState(null)
					setDropHint(null)
					if (dragged.kind === 'session') assignSession(workspaceId, dragged.id, null)
					else moveSessionCategoryToRootEnd(workspaceId, dragged.id)
				},
				[assignSession, dragState, moveSessionCategoryToRootEnd]
			)

			// ---- shared context menus ----

			const workspaceMoveChildren = (workspaceId) => {
				const children = [
					{ id: 'move-unassigned', label: '未分类', run: () => assign(workspaceId, UNASSIGNED_ID) }
				]
				for (const entry of categoryOptions) {
					children.push({
						id: 'move-' + entry.category.id,
						label: '\u3000'.repeat(entry.depth) + entry.category.name,
						run: () => assign(workspaceId, entry.category.id)
					})
				}
				return children
			}

			const categoryMoveChildren = (categoryId) => {
				const subtree = categorySubtree(state.categories, categoryId)
				const children = [{ id: 'move-root', label: '顶层', run: () => moveCategoryToRootEnd(categoryId) }]
				for (const entry of categoryOptions) {
					if (subtree.has(entry.category.id)) continue
					children.push({
						id: 'move-' + entry.category.id,
						label: '\u3000'.repeat(entry.depth) + entry.category.name,
						run: () => moveCategoryTo(categoryId, entry.category.id, 'inside')
					})
				}
				return children
			}

			const sessionMoveChildren = (sessionId, workspaceId) => {
				const list = state.sessionCategories[workspaceId] || []
				const children = [
					{ id: 'move-direct', label: '工作区下（未分类）', run: () => assignSession(workspaceId, sessionId, null) }
				]
				for (const entry of flattenCategories(list)) {
					children.push({
						id: 'move-' + entry.category.id,
						label: '\u3000'.repeat(entry.depth) + entry.category.name,
						run: () => assignSession(workspaceId, sessionId, entry.category.id)
					})
				}
				return children
			}

			const sessionCategoryMoveChildren = (workspaceId, categoryId) => {
				const list = state.sessionCategories[workspaceId] || []
				const subtree = categorySubtree(list, categoryId)
				const children = [
					{ id: 'move-root', label: '顶层', run: () => moveSessionCategoryToRootEnd(workspaceId, categoryId) }
				]
				for (const entry of flattenCategories(list)) {
					if (subtree.has(entry.category.id)) continue
					children.push({
						id: 'move-' + entry.category.id,
						label: '\u3000'.repeat(entry.depth) + entry.category.name,
						run: () => moveSessionCategoryTo(workspaceId, categoryId, entry.category.id, 'inside')
					})
				}
				return children
			}

			const workspaceCategoryActions = (workspaceId) => [
				{
					id: 'new-session-category',
					label: '新建会话分类',
					separatorBefore: true,
					run: () => {
						expandWorkspace(workspaceId)
						setCreatingSessionCategory({ workspaceId, parentId: null })
					}
				},
				{ id: 'move-workspace', label: '移动到工作区分类', children: workspaceMoveChildren(workspaceId) }
			]

			const mapNativeView = (view, resolution) => {
				const mapped = { id: view.id, label: view.label }
				if (view.commandId !== undefined) mapped.commandId = view.commandId
				if (view.disabled !== undefined) mapped.disabled = view.disabled
				if (view.danger !== undefined) mapped.danger = view.danger
				if (view.separatorBefore !== undefined) mapped.separatorBefore = view.separatorBefore
				if (view.afterContent !== undefined) mapped.afterContent = view.afterContent
				if (view.children !== undefined) mapped.children = view.children.map((child) => mapNativeView(child, resolution))
				else mapped.run = () => resolution.select(view.id)
				return mapped
			}

			const openNativeMenu = async (target, signal) => {
				if (typeof props.resolveNative !== 'function') return null
				try {
					const resolution = props.resolveNative(target)
					if (resolution === undefined || resolution === null) return null
					await resolution.ready
					if (signal !== undefined && signal.aborted) {
						resolution.dispose()
						return null
					}
					if (signal !== undefined) {
						signal.addEventListener(
							'abort',
							() => {
								Promise.resolve().then(() => resolution.dispose())
							},
							{ once: true }
						)
					}
					return resolution
				} catch (error) {
					console.error('[workspace-tree] native menu failed', error)
					return null
				}
			}

			const menuActions = {
				async workspace(target, signal) {
					const workspaceId = target.workspaceId
					const resolution = await openNativeMenu(
						{ kind: 'workspace', value: { workspaceId, path: target.path, displayTitle: target.displayTitle } },
						signal
					)
					const native = resolution === null ? [] : resolution.source.getSnapshot()
					const actions = []
					let renamed = false
					let deleted = false
					let moved = false
					const insertCategoryActions = () => {
						if (moved) return
						moved = true
						for (const action of workspaceCategoryActions(workspaceId)) actions.push(action)
					}
					for (const view of native) {
						if (view.id === 'workspace.rename/rename') {
							renamed = true
							actions.push({ id: 'tree-rename', label: '重命名', run: () => setRenamingWorkspaceId(workspaceId) })
							continue
						}
						if (view.id === 'workspace.delete/delete') {
							insertCategoryActions()
							deleted = true
							actions.push({
								id: 'tree-delete',
								label: '删除工作区',
								separatorBefore: true,
								danger: true,
								run: () => deleteWorkspace(workspaceId)
							})
							continue
						}
						actions.push(mapNativeView(view, resolution))
					}
					if (!renamed) actions.unshift({ id: 'tree-rename', label: '重命名', run: () => setRenamingWorkspaceId(workspaceId) })
					if (!deleted) {
						insertCategoryActions()
						actions.push({
							id: 'tree-delete',
							label: '删除工作区',
							separatorBefore: true,
							danger: true,
							run: () => deleteWorkspace(workspaceId)
						})
					}
					return actions
				},
				async session(target, signal) {
					const sessionId = target.sessionId
					const resolution = await openNativeMenu(
						{ kind: 'session', value: { sessionId, displayTitle: target.displayTitle } },
						signal
					)
					const native = resolution === null ? [] : resolution.source.getSnapshot()
					const actions = []
					let moved = false
					for (const view of native) {
						if (view.id === 'session.archive/archive') {
							if (!moved) {
								moved = true
								actions.push({
									id: 'move-session',
									label: '移动到会话分类',
									children: sessionMoveChildren(sessionId, target.workspaceId)
								})
							}
							actions.push(mapNativeView(view, resolution))
							continue
						}
						actions.push(mapNativeView(view, resolution))
					}
					if (!moved) {
						actions.push({
							id: 'move-session',
							label: '移动到会话分类',
							children: sessionMoveChildren(sessionId, target.workspaceId)
						})
					}
					return actions
				},
				category(target) {
					const category = state.categories.find((entry) => entry.id === target.categoryId)
					if (category === undefined) return []
					return [
						{ id: 'rename', label: '重命名', run: () => setRenamingId(category.id) },
						{
							id: 'new-child',
							label: '新建子分类',
							run: () => {
								openCategory(category.id)
								setCreatingIn({ parentId: category.id })
							}
						},
						{ id: 'new-workspace', label: '在该分类新建工作区', run: () => addWorkspace(category.id) },
						{ id: 'move', label: '移动到其他分类', children: categoryMoveChildren(category.id) },
						{
							id: 'delete',
							label: '删除分类',
							separatorBefore: true,
							danger: true,
							run: () => deleteCategory(category.id)
						}
					]
				},
				sessionCategory(target) {
					const list = state.sessionCategories[target.workspaceId] || []
					const category = list.find((entry) => entry.id === target.categoryId)
					if (category === undefined) return []
					return [
						{ id: 'rename', label: '重命名', run: () => setRenamingSessionCategoryId(category.id) },
						{
							id: 'new-child',
							label: '新建子分类',
							run: () => {
								expandWorkspace(target.workspaceId)
								openSessionCategory(target.workspaceId, category.id)
								setCreatingSessionCategory({ workspaceId: target.workspaceId, parentId: category.id })
							}
						},
						{
							id: 'new-session',
							label: '在该分类新建会话',
							run: () => newSessionInCategory(target.workspaceId, category.id)
						},
						{
							id: 'move',
							label: '移动到其他会话分类',
							children: sessionCategoryMoveChildren(target.workspaceId, category.id)
						},
						{
							id: 'delete',
							label: '删除分类',
							separatorBefore: true,
							danger: true,
							run: () => deleteSessionCategory(target.workspaceId, category.id)
						}
					]
				}
			}
			react.useEffect(() => {
				const actions = menuActions
				if (props.treeActions !== undefined && props.treeActions !== null) props.treeActions.current = actions
				return () => {
					if (props.treeActions !== undefined && props.treeActions !== null && props.treeActions.current === actions) {
						props.treeActions.current = null
					}
				}
			})

			// ---- narrow rail (collapsed sidebar) ----

			if (narrow) {
				const railCategories = categoryOptions.map((entry) => entry.category)
				return h(
					'div',
					{ className: 'twt-root twt-narrow' },
					railCategories.length > 0
						? railCategories.map((category) =>
								h(
									'button',
									{
										key: category.id,
										type: 'button',
										className: 'twt-rail',
										title: category.name,
										onClick: () => props.expandSidebar()
									},
									h(Icon, { name: 'folder', size: 16 })
								)
							)
						: null,
					(workspaceSnapshot.items || []).map((workspace) =>
						h(
							'button',
							{
								key: workspace.workspaceId,
								type: 'button',
								className: 'twt-rail',
								title: workspace.title || workspace.path,
								onClick: () => props.expandSidebar()
							},
							h(Icon, { name: 'layers', size: 16 })
						)
					)
				)
			}

			// ---- full tree ----

			const renderWorkspaceBody = (workspace, sessions) => {
				const workspaceId = workspace.workspaceId
				const categories = state.sessionCategories[workspaceId] || []
				const sessionTree = categoryTree(categories)
				const knownCategoryIds = new Set(categories.map((entry) => entry.id))
				const buckets = new Map()
				const direct = []
				for (const summary of sessions) {
					const target = state.sessionAssign[summary.id]
					if (target !== undefined && knownCategoryIds.has(target)) {
						const list = buckets.get(target)
						if (list === undefined) buckets.set(target, [summary])
						else list.push(summary)
					} else direct.push(summary)
				}
				const visibleCount = state.visible[workspaceId] === undefined ? SESSION_DEFAULT : state.visible[workspaceId]
				const shown = direct.slice(0, visibleCount)
				const hidden = direct.length - shown.length
				const creatingHere =
					creatingSessionCategory !== null &&
					creatingSessionCategory.workspaceId === workspaceId &&
					(creatingSessionCategory.parentId === null ||
						categories.some((entry) => entry.id === creatingSessionCategory.parentId))

				const renderSession = (summary) => {
					return h(SessionRow, {
						key: summary.id,
						summary,
						active: summary.id === activeSessionId,
						dragging: dragState !== null && dragState.kind === 'session' && dragState.id === summary.id,
						onOpen: openSession,
						favorite: state.favoriteSessions[summary.id] === true,
						pinned: state.pinnedSessions[summary.id] === true,
						onFavorite: () => toggleFavorite(summary.id),
						onPin: () => togglePin(summary.id),
						onDragStart: beginDrag('session', summary.id, workspaceId),
						onDragEnd: endDrag,
						openMenu: props.openMenu,
						target: {
							kind: 'workspaceTreeSession',
							value: {
								sessionId: summary.id,
								workspaceId,
								displayTitle: summary.displayTitle
							}
						}
					})
				}

				const renderSessionCategory = (category) => {
					const children = sessionTree.get(category.id) || []
					const assigned = buckets.get(category.id) || []
					const open = category.collapsed !== true
					const creatingChild = creatingHere && creatingSessionCategory.parentId === category.id
					let count = 0
					for (const id of categorySubtree(categories, category.id)) count += (buckets.get(id) || []).length
					const hint =
						dropHint !== null &&
						dropHint.type === 'sessionCategory' &&
						dropHint.workspaceId === workspaceId &&
						dropHint.categoryId === category.id
							? dropHint.edge
							: undefined
					return h(
						'div',
						{ key: category.id, className: 'twt-scat-block' },
						h(CategoryRow, {
							category,
							count,
							kind: 'session',
							dropEdge: hint,
							dragging: dragState !== null && dragState.kind === 'sessionCategory' && dragState.id === category.id,
							renaming: renamingSessionCategoryId === category.id,
							onToggle: () => toggleSessionCategory(workspaceId, category.id),
							onRenameCommit: (name) => renameSessionCategory(workspaceId, category.id, name),
							onRenameCancel: () => setRenamingSessionCategoryId(null),
							onNewCategory: () => {
								openSessionCategory(workspaceId, category.id)
								setCreatingSessionCategory({ workspaceId, parentId: category.id })
							},
							onDragStart: beginDrag('sessionCategory', category.id, workspaceId),
							onDragEnd: endDrag,
							onDragOver: hoverSessionCategory(workspaceId, category.id),
							onDragLeave: leaveSessionCategory(workspaceId, category.id),
							onDrop: dropOnSessionCategory(workspaceId, category.id),
							openMenu: props.openMenu,
							target: {
								kind: 'workspaceTreeSessionCategory',
								value: { workspaceId, categoryId: category.id, displayTitle: category.name }
							}
						}),
						open
							? h(
									'div',
									{ className: 'twt-cat-body twt-scat-body' },
									creatingChild
										? h(CategoryCreator, {
												key: 'creator-' + category.id,
												inline: true,
												onCommit: (name) => {
													createSessionCategory(workspaceId, name, category.id)
													setCreatingSessionCategory(null)
												},
												onCancel: () => setCreatingSessionCategory(null)
											})
										: null,
									children.map(renderSessionCategory),
									assigned.map(renderSession),
									assigned.length === 0 && children.length === 0 && !creatingChild
										? h(
											'div',
											{
												className: 'twt-empty twt-empty-indent',
												onDragOver: hoverSessionCategory(workspaceId, category.id),
												onDragLeave: leaveSessionCategory(workspaceId, category.id),
												onDrop: dropOnSessionCategory(workspaceId, category.id)
											},
											'把会话拖到这里'
										)
										: null
								)
							: null
					)
				}

				const rootCategories = sessionTree.get(null) || []
				const body = []
				const draggingSession = dragState !== null && dragState.workspaceId === workspaceId && dragState.kind === 'session'
				const draggingSessionCategory =
					dragState !== null && dragState.workspaceId === workspaceId && dragState.kind === 'sessionCategory'
				if (draggingSession) {
					body.push(
						h(
							'div',
							{
								key: 'session-root-drop',
								className: cls(
									'twt-root-drop',
									dropHint !== null &&
										dropHint.type === 'sessionRoot' &&
										dropHint.workspaceId === workspaceId &&
										'twt-root-drop-active'
								),
								onDragOver: hoverSessionRoot(workspaceId),
								onDragLeave: leaveSessionRoot(workspaceId),
								onDrop: dropOnSessionRoot(workspaceId)
							},
							'拖到这里移出会话分类'
						)
					)
				}
				for (const summary of shown) body.push(renderSession(summary))
				if (hidden > 0) {
					body.push(
						h(
							'button',
							{
								key: 'more-' + workspaceId,
								type: 'button',
								className: 'twt-more',
								onClick: (event) => {
									event.stopPropagation()
									showMore(workspaceId)
								}
							},
							'显示更多 (' + hidden + ')'
						)
					)
				}
				if (direct.length === 0 && rootCategories.length === 0 && !creatingHere) {
					body.push(h('div', { key: 'empty-' + workspaceId, className: 'twt-empty' }, '暂无会话'))
				}
				for (const category of rootCategories) body.push(renderSessionCategory(category))
				if (creatingHere && creatingSessionCategory.parentId === null) {
					body.push(
						h(CategoryCreator, {
							key: 'creator-root-' + workspaceId,
							inline: false,
							placeholder: '会话分类名称，回车确认',
							onCommit: (name) => {
								createSessionCategory(workspaceId, name, null)
								setCreatingSessionCategory(null)
							},
							onCancel: () => setCreatingSessionCategory(null)
						})
					)
				}
				if (draggingSessionCategory) {
					body.push(
						h(
							'div',
							{
								key: 'session-category-root-drop',
								className: cls(
									'twt-root-drop',
									dropHint !== null &&
										dropHint.type === 'sessionRoot' &&
										dropHint.workspaceId === workspaceId &&
										'twt-root-drop-active'
								),
								onDragOver: hoverSessionRoot(workspaceId),
								onDragLeave: leaveSessionRoot(workspaceId),
								onDrop: dropOnSessionRoot(workspaceId)
							},
							'拖到这里移到顶层'
						)
					)
				}
				return body
			}

			const renderWorkspace = (workspace) => {
				const expanded = state.expanded[workspace.workspaceId] === true
				const sessions = sessionsOf(workspace, workspaceSnapshot, sessionSnapshot, needle, state.archivedFilter).sort(
					(left, right) =>
						(state.pinnedSessions[left.id] === true ? 0 : 1) - (state.pinnedSessions[right.id] === true ? 0 : 1)
				)
				return h(WorkspaceRow, {
					key: workspace.workspaceId,
					workspace,
					sessions,
					expanded,
					renaming: renamingWorkspaceId === workspace.workspaceId,
					body: renderWorkspaceBody(workspace, sessions),
					onToggle: () => toggleWorkspace(workspace.workspaceId),
					onNewSession: () => newSession(workspace.workspaceId),
					onRenameCommit: (name) => renameWorkspace(workspace.workspaceId, name),
					onRenameCancel: () => setRenamingWorkspaceId(null),
					onDragStart: beginDrag('workspace', workspace.workspaceId),
					onDragEnd: endDrag,
					openMenu: props.openMenu,
					target: {
						kind: 'workspaceTreeWorkspace',
						value: {
							workspaceId: workspace.workspaceId,
							path: workspace.path,
							displayTitle: workspace.title || workspace.path
						}
					}
				})
			}

			const roots = tree.get(null) || []
			const unassignedOpen = state.unassignedCollapsed !== true

			const renderCategory = (category) => {
				const workspaces = grouped.buckets.get(category.id) || []
				const children = tree.get(category.id) || []
				let count = 0
				for (const id of categorySubtree(state.categories, category.id)) count += (grouped.buckets.get(id) || []).length
				const hint =
					dropHint !== null && dropHint.type === 'category' && dropHint.categoryId === category.id ? dropHint.edge : undefined
				const open = category.collapsed !== true
				return h(
					'div',
					{ key: category.id, className: 'twt-cat-block' },
					h(CategoryRow, {
						category,
						count,
						dropEdge: hint,
						dragging: dragState !== null && dragState.kind === 'category' && dragState.id === category.id,
						renaming: renamingId === category.id,
						busy: adding,
						onToggle: () => toggleCategory(category.id),
						onRenameCommit: (name) => renameCategory(category.id, name),
						onRenameCancel: () => setRenamingId(null),
						onNewWorkspace: () => addWorkspace(category.id),
						onNewCategory: () => {
							openCategory(category.id)
							setCreatingIn({ parentId: category.id })
						},
						onDragStart: beginDrag('category', category.id),
						onDragEnd: endDrag,
						onDragOver: hoverCategory(category.id),
						onDragLeave: leaveCategory(category.id),
						onDrop: dropOnCategory(category.id),
						openMenu: props.openMenu,
						target: {
							kind: 'workspaceTreeCategory',
							value: { categoryId: category.id, displayTitle: category.name }
						}
					}),
					open
						? h(
							'div',
							{ className: 'twt-cat-body' },
							creatingIn !== null && creatingIn.parentId === category.id
								? h(CategoryCreator, {
									key: 'creator-' + category.id,
									inline: true,
									onCommit: (name) => {
										createCategory(name, category.id)
										setCreatingIn(null)
									},
									onCancel: () => setCreatingIn(null)
								})
								: null,
							children.map(renderCategory),
							workspaces.length === 0 &&
							children.length === 0 &&
							!(creatingIn !== null && creatingIn.parentId === category.id)
								? h(
									'div',
									{
										className: 'twt-empty twt-empty-indent',
										onDragOver: hoverCategory(category.id),
										onDragLeave: leaveCategory(category.id),
										onDrop: dropOnCategory(category.id)
									},
									'把工作区拖到这里'
								)
								: workspaces.map(renderWorkspace)
						)
						: null
				)
			}

			const renderRootDrop = () =>
				dragState !== null && dragState.kind === 'category'
					? h(
						'div',
						{
							key: 'root-drop',
							className: cls('twt-root-drop', dropHint !== null && dropHint.type === 'root' && 'twt-root-drop-active'),
							onDragOver: hoverRoot,
							onDragLeave: leaveRoot,
							onDrop: dropOnRoot
						},
						'拖到这里移到顶层'
					)
					: null

			const body = roots.map(renderCategory)

			if (grouped.unassigned.length > 0) {
				const active = dropHint !== null && dropHint.type === 'unassigned'
				body.push(
					h(
						'div',
						{ key: UNASSIGNED_ID, className: 'twt-cat-block' },
						h(
							'div',
							{
								className: cls('twt-row', 'twt-cat', active && 'twt-drop'),
								role: 'button',
								tabIndex: 0,
								onDragOver: hoverUnassigned,
								onDragLeave: leaveUnassigned,
								onDrop: dropOnUnassigned,
								onClick: toggleUnassigned,
								onKeyDown: (event) => {
									if (event.target !== event.currentTarget) return
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault()
										toggleUnassigned()
									}
								}
							},
							h(
								'button',
								{
									type: 'button',
									className: cls('twt-chevron', unassignedOpen && 'twt-chevron-open'),
									'aria-label': unassignedOpen ? '折叠' : '展开',
									'aria-expanded': unassignedOpen,
									onClick: (event) => {
										event.stopPropagation()
										toggleUnassigned()
									}
								},
								h(Icon, { name: 'chevron', size: 11 })
							),
							h('span', { className: 'twt-label twt-cat-label' }, '未分类'),
							h('span', { className: 'twt-count' }, String(grouped.unassigned.length)),
							h(
								'div',
								{ className: 'twt-actions' },
								h(
									'button',
									{
										type: 'button',
										className: cls('twt-icon', adding && 'twt-busy'),
										title: adding ? '正在选择文件夹…' : '新建工作区',
										'aria-label': '新建工作区',
										disabled: adding,
										onClick: (event) => {
											event.stopPropagation()
											addWorkspace(UNASSIGNED_ID)
										}
									},
									h(Icon, { name: adding ? 'spinner' : 'plus' })
								)
							)
						),
						unassignedOpen
							? h('div', { className: 'twt-cat-body' }, grouped.unassigned.map(renderWorkspace))
							: null
					)
				)
			}

			body.push(renderRootDrop())

			if (roots.length === 0 && grouped.unassigned.length === 0) {
				body.push(
					h(
						'div',
						{ key: 'empty', className: 'twt-empty-block' },
						h('div', { className: 'twt-empty' }, needle === '' ? '还没有工作区' : '没有匹配的工作区或会话'),
						needle === ''
							? h(
								'button',
								{
									type: 'button',
									className: 'twt-add-btn',
									disabled: adding,
									onClick: () => addWorkspace()
								},
								h(Icon, { name: adding ? 'spinner' : 'plus', size: 12 }),
								adding ? '正在选择文件夹…' : '新建工作区'
							)
							: null
					)
				)
			}

			return h(
				'div',
				{ className: 'twt-root' },
				h(
					'div',
					{ className: 'twt-header' },
					h('span', { className: 'twt-title' }, '工作区分类'),
					h(
						RowButton,
						{
							label: adding ? '正在选择文件夹…' : '新建工作区',
							disabled: adding,
							className: adding ? 'twt-icon twt-busy' : undefined,
							onClick: () => addWorkspace()
						},
						h(Icon, { name: adding ? 'spinner' : 'folder', size: 13 })
					),
					h(RowButton, { label: '新建分类', onClick: () => setCreatingIn({ parentId: null }) }, h(Icon, { name: 'plus' })),
					h(
						RowButton,
						{
							label: '切换到原生工作区列表',
							onClick: () => updateViewState({ mode: 'native' })
						},
						h(Icon, { name: 'list' })
					)
				),
			creatingIn !== null && creatingIn.parentId === null
				? h(CategoryCreator, {
					key: 'creator-root',
					inline: false,
					onCommit: (name) => {
						createCategory(name, null)
						setCreatingIn(null)
					},
					onCancel: () => setCreatingIn(null)
				})
				: null,
				workspaceSnapshot.phase !== 'ready' || sessionSnapshot.phase !== 'ready'
					? h('div', { className: 'twt-empty' }, '正在载入…')
					: null,
				h(
					'div',
					{ className: 'twt-search' },
					h(Icon, { name: 'search', size: 12 }),
					h('input', {
						className: 'twt-search-input',
						value: query,
						placeholder: '筛选…',
						onChange: (event) => setQuery(event.target.value)
					}),
					query === ''
						? null
						: h(
								'button',
								{ type: 'button', className: 'twt-icon', 'aria-label': '清除筛选', onClick: () => setQuery('') },
								h(Icon, { name: 'close', size: 11 })
							),
					/* A native <select> keeps its own white chrome unless the
					 * appearance is reset, which reads as a bright patch inside the
					 * sidebar. So: reset it, let the chip borrow the row's own
					 * colour, and draw the caret ourselves. */
					h(
						'span',
						{ className: cls('twt-filter', state.archivedFilter !== 'default' && 'twt-filter-on') },
						h(
							'select',
							{
								className: 'twt-filter-select',
								title: '已归档会话的显示方式',
								'aria-label': '已归档会话的显示方式',
								value: state.archivedFilter,
								onClick: (event) => event.stopPropagation(),
								onChange: (event) => updateViewState({ archivedFilter: event.target.value })
							},
							[
								h('option', { key: 'default', value: 'default' }, '隐藏归档'),
								h('option', { key: 'show', value: 'show' }, '含归档'),
								h('option', { key: 'only', value: 'only' }, '仅归档')
							]
						),
						h('span', { className: 'twt-filter-caret' }, h(Icon, { name: 'chevron', size: 9 }))
					)
				),
				error === null
					? null
					: h(
							'div',
							{ className: 'twt-error', title: error },
							h('span', { className: 'twt-error-text' }, error),
							h(
								'button',
								{
									type: 'button',
									className: 'twt-icon twt-error-close',
									'aria-label': '关闭提示',
									onClick: () => setError(null)
								},
								h(Icon, { name: 'close', size: 11 })
							)
						),
				h('div', { className: 'twt-scroll', ref: scrollRef }, body),
				activeWorkspaceId === undefined
					? null
					: h(
							'div',
							{ className: 'twt-hint' },
							h('span', { className: 'twt-hint-text' }, '当前工作区：' + activeWorkspaceId.slice(0, 8)),
							h(
								'a',
								{
									className: 'twt-hint-link',
									href: '#',
									title: '定位到当前工作区',
									'aria-label': '定位到当前工作区',
									onClick: (event) => {
										event.preventDefault()
										event.stopPropagation()
										locateActiveWorkspace(activeWorkspaceId)
									}
								},
								'定位'
							)
						)
			)
		}

		/**
		 * The always-present plugin switch, so the native browser is never a dead
		 * end. The sidebar footer is easy to miss, so the wide form is a full
		 * labelled row — "工作区分类插件 · 已开启/已关闭" — and states outright that
		 * this row is the plugin's view switch, instead of leaving a bare icon
		 * whose meaning has to be guessed. In the collapsed rail only the icon
		 * fits, and the tooltip carries the rest.
		 */
		function ModeToggle(props) {
			const state = useViewState()
			const tree = state.mode === 'tree'
			const hint = tree
				? 'dsh-workspace-categories 插件：当前显示「工作区分类树」，点击切回原生工作区列表'
				: 'dsh-workspace-categories 插件：当前显示原生工作区列表，点击切到「工作区分类树」'

			if (props.wide === false) {
				return h(
					'button',
					{
						type: 'button',
						className: cls('twt-foot', 'twt-foot-rail', tree && 'twt-foot-on'),
						title: hint,
						'aria-label': hint,
						'aria-pressed': tree,
						onClick: () => updateViewState({ mode: tree ? 'native' : 'tree' })
					},
					h(Icon, { name: 'folder', size: 16 })
				)
			}

			return h(
				'button',
				{
					type: 'button',
					className: cls('twt-foot', tree && 'twt-foot-on'),
					title: hint,
					'aria-label': hint,
					'aria-pressed': tree,
					onClick: () => updateViewState({ mode: tree ? 'native' : 'tree' })
				},
				h(Icon, { name: 'folder', size: 15 }),
				h('span', { className: 'twt-foot-label' }, '工作区分类'),
				/* The state reads as a switch pinned to the right edge rather than a
				 * wordy chip: label left, adaptive gap, knob right. */
				h('span', { className: 'twt-switch', 'aria-hidden': 'true' }, h('span', { className: 'twt-switch-knob' }))
			)
		}

		/* ------------------------------------------------------------------ *
		 * Styles
		 * ------------------------------------------------------------------ */

		const CSS = `
.twt-root{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;font-size:12.5px;color:inherit;line-height:1.45}
.twt-header{display:flex;align-items:center;gap:1px;padding:4px 6px 2px}
.twt-title{flex:1 1 auto;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;opacity:.5;overflow:hidden;white-space:nowrap}
.twt-search{display:flex;align-items:center;gap:5px;margin:2px 6px 4px;padding:3px 6px;border-radius:6px;background:color-mix(in srgb,currentColor 7%,transparent);opacity:.9}
.twt-search-input{flex:1 1 auto;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:12px}
.twt-search-input::placeholder{color:inherit;opacity:.45}
.twt-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 4px 8px}
.twt-row{display:flex;align-items:center;gap:4px;min-height:26px;padding:2px 6px;border-radius:6px;cursor:pointer;user-select:none;position:relative;flex-wrap:nowrap;white-space:nowrap;transition:padding-right .12s ease}
.twt-row:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.twt-row:hover,.twt-row:focus-within{padding-right:64px}
.twt-row.twt-active{background:color-mix(in srgb,currentColor 15%,transparent);font-weight:500}
.twt-row.twt-drop{background:color-mix(in srgb,currentColor 18%,transparent);outline:1px dashed color-mix(in srgb,currentColor 45%,transparent)}
.twt-drop-before{box-shadow:inset 0 2px 0 0 color-mix(in srgb,currentColor 55%,transparent)}
.twt-drop-after{box-shadow:inset 0 -2px 0 0 color-mix(in srgb,currentColor 55%,transparent)}
.twt-dragging{opacity:.42}
.twt-cat{font-weight:600;min-height:28px}
.twt-cat-block{margin-bottom:7px}
.twt-cat-block:last-child{margin-bottom:2px}
.twt-cat-body{margin-left:9px;padding-left:8px;border-left:1px solid color-mix(in srgb,currentColor 12%,transparent)}
.twt-scat{font-weight:500;min-height:25px}
.twt-scat-block{margin:0 0 3px}
.twt-scat-block:last-child{margin-bottom:0}
.twt-scat-body{margin-left:7px;padding-left:7px}
.twt-sessions>.twt-root-drop{margin:2px 0 3px}
.twt-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.twt-cat-label{letter-spacing:.01em}
.twt-ws-label{opacity:.92}
.twt-muted{opacity:.55;font-style:italic}
.twt-count{order:1;margin-left:auto;font-size:10.5px;opacity:.4;padding:0 2px;font-variant-numeric:tabular-nums}
.twt-marks{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;order:1;opacity:.55}
.twt-mark{display:inline-flex;align-items:center}
.twt-glyph{display:inline-flex;width:13px;justify-content:center;opacity:.55;flex:0 0 auto}
.twt-workspace{margin-left:6px;padding:1px 0 1px 10px;border-left:1px solid color-mix(in srgb,currentColor 10%,transparent)}
.twt-ws-head{min-height:25px}
.twt-sessions{display:flex;flex-direction:column;gap:2px;margin:1px 0 2px 10px;padding:1px 0 2px 9px;border-left:1px solid color-mix(in srgb,currentColor 16%,transparent)}
.twt-sessions>.twt-empty{padding-left:20px}
.twt-session{min-height:24px;line-height:18px}
.twt-pulse{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.75;flex:0 0 auto;animation:twt-pulse 1.1s ease-in-out infinite}
@keyframes twt-pulse{0%,100%{opacity:.25}50%{opacity:.85}}
.twt-chevron{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:0 0 auto;border:0;background:transparent;color:inherit;padding:0;opacity:.5;cursor:pointer;transition:transform .12s ease}
.twt-chevron-open{transform:rotate(90deg)}
.twt-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:0 0 auto;border:0;border-radius:4px;background:transparent;color:inherit;padding:0;opacity:0;cursor:pointer}
.twt-row:hover .twt-icon,.twt-header .twt-icon{opacity:.6}
.twt-icon:hover{opacity:1;background:color-mix(in srgb,currentColor 14%,transparent)}
.twt-actions{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:1px;height:18px;max-width:0;opacity:0;overflow:hidden;pointer-events:none;z-index:1;transition:max-width .12s ease,opacity .12s ease}
.twt-row:hover .twt-actions,.twt-row:focus-within .twt-actions{max-width:220px;opacity:1;pointer-events:auto}
.twt-actions .twt-icon{opacity:.62}
.twt-filter{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;max-width:46%;min-width:0;border-radius:5px;background:transparent;transition:background .12s ease}
.twt-filter:hover,.twt-filter:focus-within{background:color-mix(in srgb,currentColor 9%,transparent)}
.twt-filter-select{max-width:100%;min-width:0;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:10.5px;padding:1px 11px 1px 4px;outline:0;opacity:.6;cursor:pointer;appearance:none;-webkit-appearance:none;text-overflow:ellipsis}
.twt-filter:hover .twt-filter-select,.twt-filter-select:focus{opacity:.95}
.twt-filter-on .twt-filter-select{opacity:.95;font-weight:600}
.twt-filter-caret{position:absolute;right:3px;top:50%;display:inline-flex;transform:translateY(-50%) rotate(90deg);opacity:.4;pointer-events:none}
.twt-filter-select option{color:CanvasText;background:Canvas}
.twt-archived{opacity:.62}
.twt-archived .twt-label{font-style:italic}
.twt-more{align-self:flex-start;text-align:left;margin:2px 0 1px 18px;border:0;background:transparent;color:inherit;opacity:.55;font:inherit;font-size:11.5px;padding:1px 4px;border-radius:4px;cursor:pointer}
.twt-more:hover{opacity:.9;background:color-mix(in srgb,currentColor 8%,transparent)}
.twt-empty{padding:6px 10px;font-size:11.5px;opacity:.45}
.twt-empty-block{display:flex;flex-direction:column;align-items:flex-start;gap:2px}
.twt-add-btn{display:inline-flex;align-items:center;gap:5px;margin:0 8px 4px;padding:3px 8px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:11.5px;cursor:pointer;opacity:.75}
.twt-add-btn:hover:not(:disabled){opacity:1;background:color-mix(in srgb,currentColor 8%,transparent)}
.twt-add-btn:disabled{cursor:default;opacity:.45}
.twt-error{display:flex;align-items:flex-start;gap:4px;margin:2px 6px 4px;padding:4px 6px;border-radius:6px;background:color-mix(in srgb,#e5484d 16%,transparent);color:inherit;font-size:11px}
.twt-error-text{flex:1 1 auto;min-width:0;word-break:break-word;line-height:1.35}
.twt-error-close{opacity:.6;width:16px;height:16px}
.twt-error-close:hover{opacity:1}
.twt-busy{opacity:.55!important}
.twt-busy .twt-svg{animation:twt-spin 1s linear infinite}
@keyframes twt-spin{to{transform:rotate(360deg)}}
.twt-empty-indent{padding-left:2px}
.twt-root-drop{margin:4px 6px 2px;padding:5px 8px;border:1px dashed color-mix(in srgb,currentColor 28%,transparent);border-radius:6px;font-size:11px;text-align:center;opacity:.5}
.twt-root-drop-active{opacity:1;border-style:solid;background:color-mix(in srgb,currentColor 10%,transparent)}
.twt-input-create{margin:2px 0 4px;font-weight:500}
.twt-input{margin:2px 6px 4px;padding:3px 7px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;outline:0}
.twt-input-inline{flex:1 1 auto;min-width:0;margin:0;padding:0 3px;border-radius:4px;font-weight:600}
.twt-hint{display:flex;align-items:center;gap:5px;padding:2px 8px 4px;font-size:10.5px;white-space:nowrap;overflow:hidden}
.twt-hint-text{flex:1 1 auto;min-width:0;opacity:.5;overflow:hidden;text-overflow:ellipsis}
.twt-hint-link{display:inline;flex:0 0 auto;width:auto;height:auto;min-width:0;min-height:0;padding:0;border:0;outline:0;background:none;box-shadow:none;appearance:none;-webkit-appearance:none;color:var(--dsw-alias-link,var(--dsw-alias-brand-primary,currentColor));font:inherit;font-size:10.5px;line-height:inherit;text-decoration:underline;text-underline-offset:2px;white-space:nowrap;cursor:pointer}
.twt-hint-link:hover{text-decoration-thickness:2px}
.twt-hint-link:focus-visible{outline:2px solid var(--dsw-alias-link,currentColor);outline-offset:2px;border-radius:2px}
.twt-narrow{align-items:center;gap:2px;padding:4px 0}
.twt-rail{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:7px;background:transparent;color:inherit;opacity:.65;cursor:pointer}
.twt-rail:hover{opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}
.twt-foot{display:flex;align-items:center;gap:7px;width:100%;min-width:0;box-sizing:border-box;height:30px;margin:2px 0;padding:0 8px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;opacity:.7}
.twt-foot:hover{background:color-mix(in srgb,currentColor 8%,transparent);opacity:1}
.twt-foot-on{opacity:1}
.twt-foot-rail{width:30px;height:30px;padding:0;gap:0;justify-content:center;border-radius:7px}
.twt-foot-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.twt-switch{position:relative;flex:0 0 auto;width:28px;height:16px;border-radius:8px;background:color-mix(in srgb,currentColor 18%,transparent);transition:background .15s ease}
.twt-switch-knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:currentColor;opacity:.55;transition:transform .15s ease,opacity .15s ease}
.twt-foot-on .twt-switch{background:color-mix(in srgb,currentColor 40%,transparent)}
.twt-foot-on .twt-switch-knob{transform:translateX(12px);opacity:.95}
.twt-svg{display:block}
`

		function ensureStyles() {
			const existing = document.getElementById(STYLE_ID)
			if (existing !== null) {
				if (existing.textContent !== CSS) existing.textContent = CSS
				return
			}
			const element = document.createElement('style')
			element.id = STYLE_ID
			element.textContent = CSS
			document.head.appendChild(element)
		}

		/* ------------------------------------------------------------------ *
		 * Opening sessions
		 * ------------------------------------------------------------------ */

		/**
		 * Ask the desktop for a directory to adopt.
		 *
		 * Two sources exist, and we keep the exact preference order the official
		 * `dsh-client-ui-directory-picker-native` plugin uses: the Electron shell's
		 * injected chooser wins when present, otherwise the `uiWorkspace` service
		 * fronts `remote.directoryPicker`. Both resolve to an absolute path, or
		 * `null` when the user cancels.
		 *
		 * @param ctx - client root context.
		 * @returns Promise<string | null> absolute path, or null on cancel.
		 */
		function pickDirectory(ctx) {
			const desktop = globalThis.__DSH_DIRECTORY_PICKER__
			if (desktop !== undefined && desktop !== null && typeof desktop.pick === 'function') {
				return Promise.resolve(desktop.pick())
			}
			const uiWorkspace = ctx.get('uiWorkspace')
			if (uiWorkspace !== undefined && typeof uiWorkspace.pickDirectory === 'function') {
				return Promise.resolve(uiWorkspace.pickDirectory())
			}
			return Promise.reject(new Error('没有可用的目录选择器（uiWorkspace 未就绪）'))
		}

		/**
		 * The workspaces controller, or a clear error when the core UI is absent.
		 * Renaming and deleting are controller commands, not plain snapshot reads.
		 *
		 * @param ctx - client root context.
		 * @returns the workspaces controller.
		 */
		function requireWorkspaces(ctx) {
			const workspaces = ctx.get('workspaces')
			if (workspaces === undefined || workspaces === null || typeof workspaces.rename !== 'function') {
				throw new Error('workspaces 服务不可用')
			}
			return workspaces
		}

		/**
		 * `uiWorkspace` owns the main-view swap. When it is unavailable we
		 * reproduce its essential effect: retain the target under `mainView`
		 * (which is what the layout renders) and reveal the main panel.
		 */
		function createNavigator(ctx) {
			let mainReference

			const fallbackOpen = (sessionId) => {
				const sessions = ctx.get('sessions')
				const reference = sessions.retain(sessionId, { source: 'mainView' })
				const previous = mainReference
				mainReference = reference
				if (previous !== undefined) previous.release()
				const layout = ctx.get('layout')
				if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null)
			}

			return {
				openSession(sessionId) {
					const uiWorkspace = ctx.get('uiWorkspace')
					if (uiWorkspace !== undefined && typeof uiWorkspace.openSession === 'function') {
						uiWorkspace.openSession(sessionId)
						return
					}
					fallbackOpen(sessionId)
				},
				startSession(workspaceId) {
					const uiWorkspace = ctx.get('uiWorkspace')
					if (uiWorkspace !== undefined && typeof uiWorkspace.startSession === 'function') {
						uiWorkspace.startSession(workspaceId)
						return
					}
					const sessions = ctx.get('sessions')
					Promise.resolve(sessions.create({ workspaceId }))
						.then((sessionId) => fallbackOpen(sessionId))
						.catch((error) => console.error('[workspace-tree] new session failed', error))
				},
				/**
				 * The official "add workspace" flow, start to finish: pick a
				 * directory, then adopt it. `workspaces.create({ path })` resolves
				 * an existing absolute path into a Workspace row, and the client
				 * model merges that row into the snapshot immediately, so our tree
				 * re-renders without a reload.
				 *
				 * @returns Promise<Workspace | null> null when the user cancels.
				 */
				createWorkspace() {
					return pickDirectory(ctx).then((path) => {
						if (path === null || path === undefined || path === '') return null
						const workspaces = ctx.get('workspaces')
						if (workspaces === undefined || typeof workspaces.create !== 'function') {
							throw new Error('workspaces 服务不可用')
						}
						return workspaces.create({ path })
					})
				},
				renameWorkspace(workspaceId, title) {
					return requireWorkspaces(ctx).rename(workspaceId, title)
				},
				deleteWorkspace(workspaceId) {
					return requireWorkspaces(ctx).delete(workspaceId)
				},
				connectSession(workspaceId) {
					const uiWorkspace = ctx.get('uiWorkspace')
					if (uiWorkspace !== undefined && typeof uiWorkspace.connectWorkspace === 'function') {
						return Promise.resolve(uiWorkspace.connectWorkspace(workspaceId))
					}
					const sessions = ctx.get('sessions')
					return Promise.resolve(sessions.create({ workspaceId }))
				}
			}
		}

		/* ------------------------------------------------------------------ *
		 * Plugin
		 * ------------------------------------------------------------------ */

		/** Menus are declared up front; every other service is resolved lazily. */
		const inject = ['slots', 'contextMenus']

		function apply(ctx) {
			ensureStyles()

			const navigator = createNavigator(ctx)
			const treeActions = { current: null }

			const menu = (id, target, resolve) =>
				ctx.effect(() => ctx.contextMenus.register({ id, target, order: 100, resolve }), 'workspace-tree: ' + id)
			const fromTree = (method) => (target, signal) => {
				const actions = treeActions.current
				return actions === null || actions === undefined ? [] : actions[method](target, signal)
			}
			menu('workspace-tree.workspace', 'workspaceTreeWorkspace', fromTree('workspace'))
			menu('workspace-tree.category', 'workspaceTreeCategory', fromTree('category'))
			menu('workspace-tree.session-category', 'workspaceTreeSessionCategory', fromTree('sessionCategory'))
			menu('workspace-tree.session', 'workspaceTreeSession', fromTree('session'))

			const injectedProps = () => ({
				workspacesStore: ctx.get('workspaces').list,
				sessionsStore: ctx.get('sessions').list,
				openSession: navigator.openSession,
				startSession: navigator.startSession,
				createWorkspace: navigator.createWorkspace,
				renameWorkspace: navigator.renameWorkspace,
				deleteWorkspace: navigator.deleteWorkspace,
				connectSession: navigator.connectSession,
				openMenu: (target, position) => ctx.contextMenus.open(target, position),
				resolveNative: (target) => ctx.contextMenus.resolve(target),
				treeActions
			})

			// `sidebar.workspaces` is a single slot: our -100 entry shadows
			// ui-workspace's default 0 entry, and disposing it restores it.
			ctx.slots.inject('sidebar.workspaces', () => {
				let disposeRegistration

				const sync = () => {
					const wanted = getViewState().mode === 'tree'
					if (wanted && disposeRegistration === undefined) {
						disposeRegistration = ctx.slots.register(
							{
								name: 'sidebar.workspaces',
								priority: -100,
								registrant: 'dsh-workspace-categories',
								inject: injectedProps
							},
							WorkspaceTree
						)
					} else if (!wanted && disposeRegistration !== undefined) {
						disposeRegistration()
						disposeRegistration = undefined
					}
				}

				const unsubscribe = subscribeViewState(sync)
				sync()

				return () => {
					unsubscribe()
					if (disposeRegistration !== undefined) {
						disposeRegistration()
						disposeRegistration = undefined
					}
				}
			})

			// A permanent toggle in the sidebar foot, so switching to the native
			// browser is always reversible.
			ctx.slots.inject('sidebar.footer.action', () =>
				ctx.slots.register(
					{
						name: 'sidebar.footer.action',
						id: 'workspace-tree',
						order: 40,
						label: '工作区分类树',
						registrant: 'dsh-workspace-categories'
					},
					ModeToggle
				)
			)
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	}
})
