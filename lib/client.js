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

		/* ------------------------------------------------------------------ *
		 * Persisted view state
		 * ------------------------------------------------------------------ */

		const STORAGE_KEY = 'dsh.workspace-tree.state.v1'
		const STYLE_ID = 'dsh-workspace-categories/styles'

		const DEFAULTS = {
			version: 1,
			/** "tree" shows this plugin; "native" restores ui-workspace's browser. */
			mode: 'tree',
			/** [{ id, name, collapsed }] — array order is display order. */
			categories: [],
			/** workspaceId -> categoryId */
			assign: {},
			/** workspaceId -> true when its session list is expanded */
			expanded: {},
			/** workspaceId -> how many session rows are shown while expanded */
			visible: {},
			/** Archived sessions: "default" hides them, "show" includes them, "only" isolates them. */
			archivedFilter: 'default'
		}
		const SESSION_STEP = 10
		const SESSION_DEFAULT = 5
		/** Mirrors the built-in browser's tri-state archived-row filter. */
		const ARCHIVED_FILTERS = ['default', 'show', 'only']

		function sanitize(raw) {
			const merged = Object.assign({}, DEFAULTS, raw || {})
			return {
				version: 1,
				mode: merged.mode === 'native' ? 'native' : 'tree',
				categories: Array.isArray(merged.categories)
					? merged.categories
							.filter((entry) => entry && typeof entry.id === 'string')
							.map((entry) => ({
								id: entry.id,
								name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : '未命名分类',
								collapsed: entry.collapsed === true
							}))
					: [],
				assign: merged.assign && typeof merged.assign === 'object' ? Object.assign({}, merged.assign) : {},
				expanded: merged.expanded && typeof merged.expanded === 'object' ? Object.assign({}, merged.expanded) : {},
				visible: merged.visible && typeof merged.visible === 'object' ? Object.assign({}, merged.visible) : {},
				archivedFilter: ARCHIVED_FILTERS.indexOf(merged.archivedFilter) === -1 ? 'default' : merged.archivedFilter
			}
		}

		function readState() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY)
				return sanitize(raw === null ? null : JSON.parse(raw))
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
		 * True when the Host refused an archive because the Session still has
		 * work in progress. `workspaces.archiveSession` rethrows the refusal as
		 * a `WorkspaceArchiveError` carrying the offending RPC error, so the
		 * code below is the same one the built-in browser tests.
		 */
		function isActiveRefusal(reason) {
			if (!(reason instanceof Error) || reason.name !== 'WorkspaceArchiveError') return false
			const rpcError = reason.rpcError
			return rpcError !== undefined && rpcError !== null && rpcError.code === 'workspace/session-active'
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
			filter: 'M2.6 4h10.8L9.2 8.6v4.1l-2.4 1.2V8.6z'
		}

		function Icon(props) {
			const size = props.size === undefined ? 13 : props.size
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
				h('path', {
					d: PATHS[props.name],
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: props.name === 'chevron' ? 1.7 : 1.35,
					strokeLinecap: 'round',
					strokeLinejoin: 'round'
				})
			)
		}

		function cls() {
			let out = ''
			for (const value of arguments) {
				if (typeof value === 'string' && value !== '') out = out === '' ? value : out + ' ' + value
			}
			return out
		}

		/** A hover-revealed icon button that never steals the row's own click. */
		function RowButton(props) {
			return h(
				'button',
				{
					type: 'button',
					className: cls('twt-icon', props.className),
					title: props.label,
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
		}

		/* ------------------------------------------------------------------ *
		 * Tree rows
		 * ------------------------------------------------------------------ */

		function SessionRow(props) {
			const { summary, active, busy, onOpen, onArchive, onUnarchive } = props
			const archived = summary.archived === true
			return h(
				'div',
				{
					className: cls('twt-row', 'twt-session', active && 'twt-active', archived && 'twt-archived', busy && 'twt-busy'),
					role: 'button',
					tabIndex: 0,
					title: summary.displayTitle,
					onClick: () => onOpen(summary.id),
					onKeyDown: (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault()
							onOpen(summary.id)
						}
					}
				},
				h('span', { className: 'twt-glyph' }, h(Icon, { name: archived ? 'archive' : 'chat', size: 12 })),
				h('span', { className: cls('twt-label', summary.blank && 'twt-muted') }, summary.displayTitle),
				summary.running ? h('span', { className: 'twt-pulse', title: '运行中' }) : null,
				h(
					RowButton,
					{
						label: archived ? '取消归档' : '归档会话',
						disabled: busy === true,
						onClick: () => (archived ? onUnarchive(summary.id) : onArchive(summary.id))
					},
					h(Icon, { name: archived ? 'unarchive' : 'archive', size: 13 })
				)
			)
		}

		function WorkspaceRow(props) {
			const {
				workspace,
				sessions,
				expanded,
				visibleCount,
				activeSessionId,
				onToggle,
				onOpenSession,
				onNewSession,
				onArchiveSession,
				onUnarchiveSession,
				busySessionId,
				onAssign,
				categories,
				workspaceCategoryId,
				onDragStart,
				onDragEnd
			} = props

			const shown = sessions.slice(0, visibleCount)
			const hidden = sessions.length - shown.length

			return h(
				'div',
				{ className: 'twt-workspace' },
				h(
					'div',
					{
						className: 'twt-row twt-ws-head',
						role: 'button',
						tabIndex: 0,
						title: workspace.path,
						draggable: true,
						onDragStart,
						onDragEnd,
						onClick: onToggle,
						onKeyDown: (event) => {
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
							'onaria-expanded': expanded,
							onClick: (event) => {
								event.stopPropagation()
								onToggle()
							}
						},
						h(Icon, { name: 'chevron', size: 11 })
					),
					h('span', { className: 'twt-label twt-ws-label' }, workspace.title || workspace.path),
					h('span', { className: 'twt-count' }, String(sessions.length)),
					h(RowButton, { label: '在此工作区新建会话', onClick: onNewSession }, h(Icon, { name: 'plus' })),
					h(
						'select',
						{
							className: 'twt-select',
							title: '归入分类',
							value: workspaceCategoryId === undefined ? UNASSIGNED_ID : workspaceCategoryId,
							onClick: (event) => event.stopPropagation(),
							onMouseDown: (event) => event.stopPropagation(),
							onChange: (event) => onAssign(event.target.value)
						},
						[
							h('option', { key: UNASSIGNED_ID, value: UNASSIGNED_ID }, '未分类'),
							...categories.map((category) => h('option', { key: category.id, value: category.id }, category.name))
						]
					)
				),
				expanded
					? h(
							'div',
							{ className: 'twt-sessions' },
							shown.map((summary) =>
								h(SessionRow, {
									key: summary.id,
									summary,
									active: summary.id === activeSessionId,
									busy: summary.id === busySessionId,
									onOpen: onOpenSession,
									onArchive: onArchiveSession,
									onUnarchive: onUnarchiveSession
								})
							),
							hidden > 0
								? h(
										'button',
										{
											type: 'button',
											className: 'twt-more',
											onClick: (event) => {
												event.stopPropagation()
												props.onShowMore()
											}
										},
										'显示更多 (' + hidden + ')'
									)
								: null,
							sessions.length === 0 ? h('div', { className: 'twt-empty' }, '暂无会话') : null
						)
					: null
			)
		}

		function CategoryRow(props) {
			const {
				category,
				workspaces,
				dropActive,
				renaming,
				busy,
				onToggle,
				onRenameStart,
				onRenameCommit,
				onRenameCancel,
				onDelete,
				onNewWorkspace,
				onDrop,
				onDragOver,
				onDragLeave,
				children
			} = props

			const inputRef = react.useRef(null)
			react.useEffect(() => {
				if (renaming && inputRef.current !== null) {
					inputRef.current.focus()
					inputRef.current.select()
				}
			}, [renaming])

			const row = h(
				'div',
				{
					className: cls('twt-row', 'twt-cat', dropActive && 'twt-drop'),
					role: 'button',
					tabIndex: 0,
					onClick: onToggle,
					onDragOver,
					onDragLeave,
					onDrop,
					onKeyDown: (event) => {
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
							onBlur: (event) => onRenameCommit(event.target.value),
							onKeyDown: (event) => {
								event.stopPropagation()
								if (event.key === 'Enter') onRenameCommit(event.currentTarget.value)
								else if (event.key === 'Escape') onRenameCancel()
							}
						})
					: h('span', { className: 'twt-label twt-cat-label' }, category.name),
				h('span', { className: 'twt-count' }, String(workspaces)),
				h(
					'button',
					{
						type: 'button',
						className: cls('twt-icon', busy && 'twt-busy'),
						title: busy ? '正在选择文件夹…' : '在此分类新建工作区',
						'aria-label': '在此分类新建工作区',
						disabled: busy,
						onClick: (event) => {
							event.stopPropagation()
							onNewWorkspace()
						}
					},
					h(Icon, { name: 'plus' })
				),
				h(RowButton, { label: '重命名分类', onClick: onRenameStart }, h(Icon, { name: 'pencil' })),
				h(RowButton, { label: '删除分类', onClick: onDelete }, h(Icon, { name: 'close' }))
			)

			return h('div', { className: 'twt-cat-block' }, row, category.collapsed ? null : children)
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
			const [creating, setCreating] = react.useState(false)
			const [dragCategory, setDragCategory] = react.useState(null)
			const [adding, setAdding] = react.useState(false)
			const [error, setError] = react.useState(null)
			const [busySessionId, setBusySessionId] = react.useState(null)
			const [undo, setUndo] = react.useState(null)
			const undoTimer = react.useRef(undefined)
			react.useEffect(
				() => () => {
					if (undoTimer.current !== undefined) clearTimeout(undoTimer.current)
				},
				[]
			)

			const narrow = props.wide === false
			const needle = query.trim().toLowerCase()

			const workspaceItems = react.useMemo(
				() => (workspaceSnapshot.items || []).filter((workspace) => matchesWorkspace(workspace, needle)),
				[workspaceSnapshot, needle]
			)
			const grouped = react.useMemo(() => groupWorkspaces(workspaceItems, state), [workspaceItems, state])
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
				(name) => {
					const trimmed = name.trim()
					if (trimmed === '') return
					const category = { id: newCategoryId(), name: trimmed, collapsed: false }
					updateViewState((current) => ({ categories: current.categories.concat([category]) }))
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
				const category = getViewState().categories.find((entry) => entry.id === categoryId)
				const label = category === undefined ? '这个分类' : '“' + category.name + '”'
				if (!window.confirm('删除 ' + label + '？分类下的工作区会回到「未分类」。')) return
				updateViewState((current) => {
					const nextAssign = Object.assign({}, current.assign)
					for (const [workspaceId, target] of Object.entries(nextAssign)) {
						if (target === categoryId) delete nextAssign[workspaceId]
					}
					return {
						categories: current.categories.filter((entry) => entry.id !== categoryId),
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

			const toggleWorkspace = react.useCallback((workspaceId) => {
				updateViewState((current) => {
					const next = Object.assign({}, current.expanded)
					if (next[workspaceId] === true) delete next[workspaceId]
					else next[workspaceId] = true
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

			// ---- archive / unarchive sessions ----

			/** Arm the "undo" strip; a later archive replaces the pending one. */
			const showUndo = react.useCallback((sessionId, title) => {
				if (undoTimer.current !== undefined) clearTimeout(undoTimer.current)
				setUndo({ sessionId, title })
				undoTimer.current = setTimeout(() => {
					undoTimer.current = undefined
					setUndo(null)
				}, 10000)
			}, [])

			/**
			 * Archive one session, mirroring the built-in browser's flow.
			 *
			 * The Host refuses to archive a session that still has work in
			 * progress (`workspace/session-active`); the built-in browser reacts
			 * by asking "stop and archive?". We keep that two-step shape, with a
			 * plain `confirm()` because this plugin injects no UI primitives.
			 * The refusal is detected on the error, not on `summary.running`, so
			 * a session that merely looks idle still gets the real answer.
			 */
			const archiveSession = react.useCallback(
				(sessionId) => {
					const summary = (sessionSnapshot.byId || {})[sessionId]
					const title = summary !== undefined ? summary.displayTitle || sessionId : sessionId
					setBusySessionId(sessionId)
					setError(null)
					const run = async () => {
						try {
							await props.archiveSession(sessionId)
						} catch (reason) {
							if (!isActiveRefusal(reason)) throw reason
							const question =
								'“' +
								title +
								'”仍有正在进行的工作。\n\n归档会先停止这些工作；之后可在侧栏筛选「仅归档」中恢复会话，被停止的工作不会自动继续。\n\n确定停止并归档吗？'
							if (!window.confirm(question)) return false
							await props.archiveSession(sessionId, { stopActivity: true })
						}
						return true
					}
					run()
						.then((archived) => {
							if (archived) showUndo(sessionId, title)
						})
						.catch((reason) => {
							setError('归档失败：' + describe(reason))
							console.error('[workspace-tree] archive failed', reason)
						})
						.finally(() => setBusySessionId(null))
				},
				[sessionSnapshot, props.archiveSession, showUndo]
			)

			const unarchiveSession = react.useCallback(
				(sessionId) => {
					setBusySessionId(sessionId)
					setError(null)
					setUndo(null)
					Promise.resolve(props.unarchiveSession(sessionId))
						.catch((reason) => {
							setError('取消归档失败：' + describe(reason))
							console.error('[workspace-tree] unarchive failed', reason)
						})
						.finally(() => setBusySessionId(null))
				},
				[props.unarchiveSession]
			)

			const undoArchive = react.useCallback(() => {
				if (undo === null) return
				unarchiveSession(undo.sessionId)
			}, [undo, unarchiveSession])

			// ---- drag & drop: workspace -> category ----

			const makeDragStart = react.useCallback(
				(workspaceId) => (event) => {
					event.stopPropagation()
					try {
						event.dataTransfer.setData('text/plain', workspaceId)
						event.dataTransfer.effectAllowed = 'move'
					} catch (error) {
						/* drag payload is best-effort */
					}
				},
				[]
			)

			const dropHandlers = react.useCallback(
				(categoryId) => ({
					onDragOver: (event) => {
						event.preventDefault()
						event.stopPropagation()
						setDragCategory(categoryId)
					},
					onDragLeave: () => setDragCategory((current) => (current === categoryId ? null : current)),
					onDrop: (event) => {
						event.preventDefault()
						event.stopPropagation()
						setDragCategory(null)
						const workspaceId = event.dataTransfer.getData('text/plain')
						if (workspaceId !== '') assign(workspaceId, categoryId)
					}
				}),
				[assign]
			)

			// ---- narrow rail (collapsed sidebar) ----

			if (narrow) {
				const railCategories = state.categories
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

			const renderWorkspace = (workspace) => {
				const expanded = state.expanded[workspace.workspaceId] === true
				const sessions = sessionsOf(workspace, workspaceSnapshot, sessionSnapshot, needle, state.archivedFilter)
				return h(WorkspaceRow, {
					key: workspace.workspaceId,
					workspace,
					sessions,
					expanded,
					visibleCount: state.visible[workspace.workspaceId] === undefined ? SESSION_DEFAULT : state.visible[workspace.workspaceId],
					activeSessionId,
					busySessionId,
					workspaceCategoryId: state.assign[workspace.workspaceId],
					categories: state.categories,
					onToggle: () => toggleWorkspace(workspace.workspaceId),
					onShowMore: () => showMore(workspace.workspaceId),
					onOpenSession: openSession,
					onNewSession: () => newSession(workspace.workspaceId),
					onArchiveSession: archiveSession,
					onUnarchiveSession: unarchiveSession,
					onAssign: (categoryId) => assign(workspace.workspaceId, categoryId),
					onDragStart: makeDragStart(workspace.workspaceId),
					onDragEnd: () => setDragCategory(null)
				})
			}

			const body = []

			for (const category of state.categories) {
				const workspaces = grouped.buckets.get(category.id) || []
				body.push(
					h(
						CategoryRow,
						Object.assign(
							{
								key: category.id,
								category,
								workspaces: workspaces.length,
								dropActive: dragCategory === category.id,
								renaming: renamingId === category.id,
								busy: adding,
								onToggle: () => toggleCategory(category.id),
								onRenameStart: () => setRenamingId(category.id),
								onRenameCommit: (name) => renameCategory(category.id, name),
								onRenameCancel: () => setRenamingId(null),
								onDelete: () => deleteCategory(category.id),
								onNewWorkspace: () => addWorkspace(category.id)
							},
							dropHandlers(category.id)
						),
						workspaces.length === 0
							? h('div', { className: 'twt-empty twt-empty-indent' }, '把工作区拖到这里')
							: workspaces.map(renderWorkspace)
					)
				)
			}

			if (grouped.unassigned.length > 0) {
				body.push(
					h(
						'div',
						{ key: UNASSIGNED_ID, className: cls('twt-cat-block', dragCategory === UNASSIGNED_ID && 'twt-dropping') },
						h(
							'div',
							Object.assign(
								{
									className: cls('twt-row', 'twt-cat', 'twt-cat-muted', dragCategory === UNASSIGNED_ID && 'twt-drop')
								},
								dropHandlers(UNASSIGNED_ID)
							),
							h('span', { className: 'twt-chevron' }),
							h('span', { className: 'twt-label twt-cat-label' }, '未分类'),
							h('span', { className: 'twt-count' }, String(grouped.unassigned.length)),
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
								h(Icon, { name: 'plus' })
							)
						),
						grouped.unassigned.map(renderWorkspace)
					)
				)
			}

			if (body.length === 0) {
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
									h(Icon, { name: 'plus', size: 12 }),
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
						h(Icon, { name: 'folder', size: 13 })
					),
					h(RowButton, { label: '新建分类', onClick: () => setCreating(true) }, h(Icon, { name: 'plus' })),
					h(
						RowButton,
						{
							label: '切换到原生工作区列表',
							onClick: () => updateViewState({ mode: 'native' })
						},
						h(Icon, { name: 'list' })
					)
				),
				creating
					? h('input', {
							className: 'twt-input',
							autoFocus: true,
							placeholder: '分类名称，回车确认',
							onKeyDown: (event) => {
								if (event.key === 'Enter') {
									createCategory(event.currentTarget.value)
									setCreating(false)
								} else if (event.key === 'Escape') setCreating(false)
							},
							onBlur: (event) => {
								createCategory(event.target.value)
								setCreating(false)
							}
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
				undo === null
					? null
					: h(
							'div',
							{ className: 'twt-undo' },
							h('span', { className: 'twt-undo-text', title: undo.title }, '已归档「' + undo.title + '」'),
							h(
								'button',
								{
									type: 'button',
									className: 'twt-undo-btn',
									disabled: busySessionId !== null,
									onClick: undoArchive
								},
								'撤销'
							)
						),
				h('div', { className: 'twt-scroll' }, body),
				activeWorkspaceId === undefined
					? null
					: h('div', { className: 'twt-hint' }, '当前工作区：' + activeWorkspaceId.slice(0, 8))
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
.twt-row{display:flex;align-items:center;gap:4px;min-height:26px;padding:2px 6px;border-radius:6px;cursor:pointer;user-select:none}
.twt-row:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.twt-row.twt-active{background:color-mix(in srgb,currentColor 15%,transparent);font-weight:500}
.twt-row.twt-drop{background:color-mix(in srgb,currentColor 18%,transparent);outline:1px dashed color-mix(in srgb,currentColor 45%,transparent)}
.twt-cat{font-weight:600;min-height:28px}
.twt-cat-muted{font-weight:500;opacity:.75}
.twt-cat-block{margin-bottom:7px}
.twt-cat-block:last-child{margin-bottom:2px}
.twt-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.twt-cat-label{letter-spacing:.01em}
.twt-ws-label{opacity:.92}
.twt-muted{opacity:.55;font-style:italic}
.twt-count{order:1;margin-left:auto;font-size:10.5px;opacity:.4;padding:0 2px;font-variant-numeric:tabular-nums}
.twt-glyph{display:inline-flex;width:13px;justify-content:center;opacity:.55;flex:0 0 auto}
.twt-workspace{margin-left:6px;padding:1px 0 1px 10px;border-left:1px solid color-mix(in srgb,currentColor 10%,transparent)}
.twt-ws-head{min-height:25px}
.twt-sessions{display:flex;flex-direction:column;gap:2px;margin:1px 0 2px 10px;padding:1px 0 2px 9px;border-left:1px solid color-mix(in srgb,currentColor 16%,transparent)}
.twt-sessions>.twt-empty{padding-left:20px}
.twt-session{min-height:24px}
.twt-pulse{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.75;flex:0 0 auto;animation:twt-pulse 1.1s ease-in-out infinite}
@keyframes twt-pulse{0%,100%{opacity:.25}50%{opacity:.85}}
.twt-chevron{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:0 0 auto;border:0;background:transparent;color:inherit;padding:0;opacity:.5;cursor:pointer;transition:transform .12s ease}
.twt-chevron-open{transform:rotate(90deg)}
.twt-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:0 0 auto;border:0;border-radius:4px;background:transparent;color:inherit;padding:0;opacity:0;cursor:pointer}
.twt-row:hover .twt-icon,.twt-header .twt-icon{opacity:.6}
.twt-icon:hover{opacity:1;background:color-mix(in srgb,currentColor 14%,transparent)}
.twt-select{max-width:74px;flex:0 0 auto;border:0;border-radius:4px;background-color:color-mix(in srgb,currentColor 8%,transparent);color:inherit;font:inherit;font-size:10.5px;padding:1px 12px 1px 3px;opacity:0;cursor:pointer;appearance:none;-webkit-appearance:none;text-overflow:ellipsis;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 8px) 50%,calc(100% - 5px) 50%;background-size:3px 3px,3px 3px;background-repeat:no-repeat}
.twt-ws-head:hover .twt-select,.twt-select:focus{opacity:.85}
.twt-select option{color:CanvasText;background:Canvas}
.twt-filter{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;max-width:46%;min-width:0;border-radius:5px;background:transparent;transition:background .12s ease}
.twt-filter:hover,.twt-filter:focus-within{background:color-mix(in srgb,currentColor 9%,transparent)}
.twt-filter-select{max-width:100%;min-width:0;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:10.5px;padding:1px 11px 1px 4px;outline:0;opacity:.6;cursor:pointer;appearance:none;-webkit-appearance:none;text-overflow:ellipsis}
.twt-filter:hover .twt-filter-select,.twt-filter-select:focus{opacity:.95}
.twt-filter-on .twt-filter-select{opacity:.95;font-weight:600}
.twt-filter-caret{position:absolute;right:3px;top:50%;display:inline-flex;transform:translateY(-50%) rotate(90deg);opacity:.4;pointer-events:none}
.twt-filter-select option{color:CanvasText;background:Canvas}
.twt-archived{opacity:.62}
.twt-archived .twt-label{font-style:italic}
.twt-undo{display:flex;align-items:center;gap:6px;margin:2px 6px 4px;padding:4px 6px;border-radius:6px;background:color-mix(in srgb,currentColor 10%,transparent);font-size:11px}
.twt-undo-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}
.twt-undo-btn{flex:0 0 auto;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:11px;font-weight:600;padding:1px 6px;cursor:pointer;opacity:.85}
.twt-undo-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 16%,transparent);opacity:1}
.twt-undo-btn:disabled{opacity:.4;cursor:default}
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
.twt-busy{opacity:.55!important;animation:twt-spin 1s linear infinite}
@keyframes twt-spin{to{transform:rotate(360deg)}}
.twt-empty-indent{padding-left:22px}
.twt-input{margin:2px 6px 4px;padding:3px 7px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;outline:0}
.twt-input-inline{flex:1 1 auto;min-width:0;margin:0;padding:0 3px;border-radius:4px;font-weight:600}
.twt-hint{padding:2px 8px 4px;font-size:10.5px;opacity:.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
			if (document.getElementById(STYLE_ID) !== null) return
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
		 * Archiving is a controller command (it installs the returned archive set
		 * into the snapshot store), not a plain snapshot read.
		 *
		 * @param ctx - client root context.
		 * @returns the workspaces controller.
		 */
		function requireWorkspaces(ctx) {
			const workspaces = ctx.get('workspaces')
			if (workspaces === undefined || workspaces === null || typeof workspaces.archiveSession !== 'function') {
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
				 * Archive one session. `options.stopActivity` is the "stop and
				 * archive" answer to a `workspace/session-active` refusal; without
				 * it the Host refuses rather than killing live work.
				 */
				archiveSession(sessionId, options) {
					return requireWorkspaces(ctx).archiveSession(sessionId, options)
				},
				unarchiveSession(sessionId) {
					return requireWorkspaces(ctx).unarchiveSession(sessionId)
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
				}
			}
		}

		/* ------------------------------------------------------------------ *
		 * Plugin
		 * ------------------------------------------------------------------ */

		/** Only `slots` is required: everything else is resolved lazily. */
		const inject = ['slots']

		function apply(ctx) {
			ensureStyles()

			const navigator = createNavigator(ctx)

			const injectedProps = () => ({
				workspacesStore: ctx.get('workspaces').list,
				sessionsStore: ctx.get('sessions').list,
				openSession: navigator.openSession,
				startSession: navigator.startSession,
				createWorkspace: navigator.createWorkspace,
				archiveSession: navigator.archiveSession,
				unarchiveSession: navigator.unarchiveSession
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
