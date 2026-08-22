import { useEffect, useState } from "react"
import { useI18n, useStore } from "../app"
import type { FileNode } from "@shared/api-types"

export function FilePanel() {
  const store = useStore()
  const { t } = useI18n()
  const project = store.currentProject

  if (!project) {
    return (
      <aside className="file-panel">
        <div className="sidebar-empty">{t.noProject}</div>
      </aside>
    )
  }

  const rootNodes = store.fileTreeNodes.get(".") ?? []
  const hasLoaded = store.fileTreeNodes.has(".")

  useEffect(() => {
    if (!hasLoaded) void store.loadFileNodes(".")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLoaded, project.id, store.currentWorkspace?.directory])

  return (
    <aside className="file-panel">
      <div className="sidebar-heading">
        <span>{t.filesTitle}</span>
        <span className="tree-meta" title={project.worktree}>
          {project.name || project.worktree.split("/").pop()}
        </span>
      </div>
      <div className="tree scroll">
        {!hasLoaded && <div className="tree-empty">{t.loading}</div>}
        <NodeList nodes={rootNodes} depth={0} />
      </div>
    </aside>
  )
}

function NodeList({ nodes, depth }: { nodes: FileNode[]; depth: number }) {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return (
    <>
      {sorted
        .filter((n) => !n.name.startsWith(".") && !n.ignored)
        .map((n) => (
          <FileRow key={n.path} node={n} depth={depth} />
        ))}
    </>
  )
}

function FileRow({ node, depth }: { node: FileNode; depth: number }) {
  const store = useStore()
  const expanded = store.fileTreeExpanded.get(node.path) ?? false
  const children = store.fileTreeNodes.get(node.path) ?? []
  const isActive = store.activeTab?.key === `file:${node.absolute}`

  if (node.type === "directory") {
    return (
      <>
        <div
          className="tree-row file-row"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => store.toggleFileNode(node.path)}
        >
          <span className="chevron">{expanded ? "▾" : "▸"}</span>
          <span className="tree-label">{node.name}</span>
        </div>
        {expanded && children.length > 0 && <NodeList nodes={children} depth={depth + 1} />}
        {expanded && children.length === 0 && (
          <div className="tree-row file-row disabled" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
            <span className="tree-label">…</span>
          </div>
        )}
      </>
    )
  }

  return (
    <div
      className={"tree-row file-row" + (isActive ? " active" : "")}
      style={{ paddingLeft: 8 + depth * 14 + 16 }}
      onClick={() => store.openFileTab(node.absolute)}
    >
      <span className="tree-label">{node.name}</span>
    </div>
  )
}
