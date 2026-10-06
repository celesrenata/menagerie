import React, { useMemo } from "react"
import type { ObservedTask, ObservedTaskStatus } from "@roo-code/types"

const STATUS_ICON: Record<ObservedTaskStatus, string> = {
	queued: "○",
	working: "◉",
	streaming: "⟳",
	waiting: "⏸",
	completed: "✓",
	failed: "✗",
	cancelled: "⊘",
}

interface TaskTreeProps {
	tasks: readonly ObservedTask[]
	onSelectTask: (id: string, title: string) => void
}

interface TreeNode {
	task: ObservedTask
	children: TreeNode[]
}

/**
 * Renders the parent/worker hierarchy. Each child nests under its parentId;
 * tasks without a parent are roots. Renders per-task state indicators.
 */
export const TaskTree: React.FC<TaskTreeProps> = ({ tasks, onSelectTask }) => {
	const roots = useMemo(() => buildTree(tasks), [tasks])

	return (
		<div className="observatory-task-tree" style={{ padding: "8px" }}>
			<div style={{ fontWeight: "bold", fontSize: "0.85em", marginBottom: "6px", color: "var(--vscode-descriptionForeground)" }}>
				TASKS
			</div>
			{roots.map((node) => (
				<TreeNodeView key={node.task.logicalWorkerId ?? node.task.id} node={node} depth={0} onSelectTask={onSelectTask} />
			))}
		</div>
	)
}

const TreeNodeView: React.FC<{ node: TreeNode; depth: number; onSelectTask: (id: string, title: string) => void }> = ({
	node,
	depth,
	onSelectTask,
}) => {
	const { task } = node
	const key = task.logicalWorkerId ?? task.id
	const title = task.header.workspace ?? task.id

	return (
		<div>
			<div
				role="button"
				tabIndex={0}
				onClick={() => onSelectTask(key, title)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") onSelectTask(key, title)
				}}
				style={{
					paddingLeft: `${depth * 16 + 4}px`,
					cursor: "pointer",
					display: "flex",
					alignItems: "center",
					gap: "6px",
					padding: "3px 4px",
				}}>
				<span aria-hidden="true">{STATUS_ICON[task.status]}</span>
				<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.9em" }}>
					{task.id.slice(0, 8)} · {task.status}
				</span>
			</div>
			{node.children.map((child) => (
				<TreeNodeView key={child.task.logicalWorkerId ?? child.task.id} node={child} depth={depth + 1} onSelectTask={onSelectTask} />
			))}
		</div>
	)
}

function buildTree(tasks: readonly ObservedTask[]): TreeNode[] {
	const byId = new Map<string, TreeNode>()
	for (const task of tasks) {
		byId.set(task.id, { task, children: [] })
	}
	const roots: TreeNode[] = []
	for (const node of byId.values()) {
		const parentId = node.task.parentId
		if (parentId && byId.has(parentId)) {
			byId.get(parentId)!.children.push(node)
		} else {
			roots.push(node)
		}
	}
	return roots
}
