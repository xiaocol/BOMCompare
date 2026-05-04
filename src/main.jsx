import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import demoBom from "../bom-data.json";
import "./styles.css";

const STORAGE_KEY = "bom-react-flow-demo-v2";
const NODE_SIZE = 86;
const X_GAP = 46;
const Y_GAP = 126;

const deepClone = (value) => structuredClone(value);

function initialState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : { current: demoBom.current, next: demoBom.next };
  } catch {
    return { current: demoBom.current, next: demoBom.next };
  }
}

function flatten(nodes, side, depth = 0, parent = "") {
  return nodes.flatMap((node) => {
    node.parent = parent;
    const row = { ...node, side, depth };
    return [row, ...flatten(node.children || [], side, depth + 1, node.partNo)];
  });
}

function findNode(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children || [], id);
    if (found) return found;
  }
  return null;
}

function findNodeByPartNo(nodes, partNo) {
  for (const node of nodes) {
    if (node.partNo === partNo) return node;
    const found = findNodeByPartNo(node.children || [], partNo);
    if (found) return found;
  }
  return null;
}

function removeNode(nodes, id) {
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].id === id) return nodes.splice(i, 1)[0];
    const found = removeNode(nodes[i].children || [], id);
    if (found) return found;
  }
  return null;
}

function hasDescendant(node, id) {
  return (node.children || []).some((child) => child.id === id || hasDescendant(child, id));
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((item) => item.trim())) rows.push(row);
  return rows;
}

function exportBomCsv(nodes) {
  const rows = [["亲品目", "子品目", "有效开始日", "有效终了日", "版数"]];
  flatten(nodes, "next")
    .filter((item) => item.parent)
    .forEach((item) => {
      rows.push([item.parent, item.partNo, item.start, item.end, item.revision]);
    });
  return rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
}

function csvToTree(text) {
  const rows = parseCsv(text);
  const [header, ...body] = rows;
  if (!header) throw new Error("CSVが空です。");
  const index = Object.fromEntries(header.map((name, i) => [name.trim(), i]));
  for (const name of ["亲品目", "子品目", "有效开始日", "有效终了日", "版数"]) {
    if (!(name in index)) throw new Error(`CSV列 ${name} がありません。`);
  }

  const nodes = new Map();
  const childSet = new Set();
  const getNode = (partNo) => {
    if (!nodes.has(partNo)) {
      nodes.set(partNo, {
        id: `csv-${partNo}`,
        parent: "",
        partNo,
        name: partNo,
        revision: "",
        qty: 1,
        start: "",
        end: "2099-12-31",
        expanded: true,
        children: []
      });
    }
    return nodes.get(partNo);
  };

  body.forEach((row) => {
    const parentNo = row[index["亲品目"]]?.trim();
    const childNo = row[index["子品目"]]?.trim();
    if (!parentNo || !childNo) return;
    const parent = getNode(parentNo);
    const child = getNode(childNo);
    child.parent = parentNo;
    child.start = row[index["有效开始日"]]?.trim() || child.start;
    child.end = row[index["有效终了日"]]?.trim() || child.end;
    child.revision = row[index["版数"]]?.trim() || child.revision;
    parent.children = parent.children.filter((item) => item.partNo !== childNo);
    parent.children.push(child);
    childSet.add(childNo);
  });

  return [...nodes.values()].filter((node) => !childSet.has(node.partNo));
}

function statusText(status) {
  return {
    added: "追加",
    removed: "削除",
    changed: "変更",
    same: "両方"
  }[status] || "両方";
}

function buildDiffMap(data, parentNo) {
  const currentRoot = findNodeByPartNo(data.current, parentNo);
  const nextRoot = findNodeByPartNo(data.next, parentNo);
  const currentRows = currentRoot ? flatten([currentRoot], "current") : [];
  const nextRows = nextRoot ? flatten([nextRoot], "next") : [];
  const current = new Map(currentRows.map((item) => [item.partNo, item]));
  const next = new Map(nextRows.map((item) => [item.partNo, item]));
  const statuses = new Map();

  current.forEach((item, partNo) => {
    const target = next.get(partNo);
    if (!target) {
      statuses.set(partNo, "removed");
      return;
    }
    const changed = ["name", "revision", "qty", "start", "end", "parent"].some(
      (key) => String(item[key] ?? "") !== String(target[key] ?? "")
    );
    statuses.set(partNo, changed ? "changed" : "same");
  });
  next.forEach((_, partNo) => {
    if (!current.has(partNo)) statuses.set(partNo, "added");
  });
  return statuses;
}

function ensureRoot(data, side, parentNo) {
  const existing = findNodeByPartNo(data[side], parentNo);
  if (existing) return existing;
  const root = {
    id: `${side}-root-${Date.now()}`,
    parent: "",
    partNo: parentNo,
    name: "親品目",
    revision: "",
    qty: 1,
    start: "2026-05-01",
    end: "2099-12-31",
    expanded: true,
    children: []
  };
  data[side].push(root);
  return root;
}

function visibleTreeToFlow(root, side, statuses, handlers, readOnly) {
  const nodes = [];
  const edges = [];

  function measure(node) {
    const children = node.expanded === false ? [] : node.children || [];
    return children.length
      ? Math.max(NODE_SIZE, children.reduce((sum, child) => sum + measure(child), 0) + (children.length - 1) * X_GAP)
      : NODE_SIZE;
  }

  function layout(node, depth, left) {
    const children = node.expanded === false ? [] : node.children || [];
    const subtreeWidth = measure(node);
    const x = left + subtreeWidth / 2 - NODE_SIZE / 2;
    const y = depth * Y_GAP;

    nodes.push({
      id: node.id,
      type: "bomNode",
      position: { x, y },
      draggable: !readOnly && depth > 0,
      data: {
        node,
        side,
        depth,
        readOnly,
        status: statuses.get(node.partNo) || "same",
        onAdd: handlers.onAdd,
        onEdit: handlers.onEdit,
        onToggle: handlers.onToggle
      }
    });

    const childrenWidth = children.length
      ? children.reduce((sum, child) => sum + measure(child), 0) + (children.length - 1) * X_GAP
      : 0;
    let childLeft = left + (subtreeWidth - childrenWidth) / 2;

    children.forEach((child) => {
      const childWidth = measure(child);
      layout(child, depth + 1, childLeft);
      edges.push({
        id: `${node.id}-${child.id}`,
        source: node.id,
        target: child.id,
        type: "straight",
        style: { stroke: "#176786", strokeWidth: 2 }
      });
      childLeft += childWidth + X_GAP;
    });
  }

  layout(root, 0, 0);
  return { nodes, edges };
}

function BomNode({ data }) {
  const { node, depth, readOnly, status, side, onAdd, onEdit, onToggle } = data;
  const hasChildren = (node.children || []).length > 0;

  return (
    <div className={`flow-node ${status} ${depth === 0 ? "root-node" : ""}`}>
      <Handle type="target" position={Position.Top} className="flow-handle" />
      {hasChildren && (
        <button className="toggle-node" type="button" onClick={() => onToggle(side, node.id)} title="展開/折りたたみ">
          {node.expanded === false ? "+" : "-"}
        </button>
      )}
      <div className="flow-circle">
        <strong>{node.partNo}</strong>
        <span>{node.name}</span>
        <small>Rev. {node.revision || "-"}</small>
        <i>{statusText(status)}</i>
      </div>
      {!readOnly && (
        <div className="flow-actions">
          <button type="button" onClick={() => onAdd(side, node.id)} title="子品目を追加">+</button>
          <button type="button" onClick={() => onEdit(side, node.id)} title="品目を修正">✎</button>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="flow-handle" />
    </div>
  );
}

const nodeTypes = { bomNode: BomNode };

function BomFlow({ side, title, subtitle, readOnly = false, layoutVersion = 0, canUndoMove = false, data, parentNo, statuses, onAdd, onEdit, onToggle, onMove, onUndoMove, onEnsureRoot }) {
  const flowRef = useRef(null);
  const root = findNodeByPartNo(data[side], parentNo);
  const flow = useMemo(() => {
    if (!root) return { nodes: [], edges: [] };
    return visibleTreeToFlow(root, side, statuses, { onAdd, onEdit, onToggle }, readOnly);
  }, [root, side, statuses, onAdd, onEdit, onToggle, readOnly]);
  const [nodes, setNodes, onNodesChange] = useNodesState(flow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flow.edges);

  useEffect(() => {
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [flow.nodes, flow.edges, setNodes, setEdges]);

  useEffect(() => {
    requestAnimationFrame(() => flowRef.current?.fitView({ padding: 0.18, duration: 180 }));
  }, [layoutVersion, parentNo, setNodes]);

  return (
    <article className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <span>{subtitle}</span>
        </div>
        <div className="panel-actions">
          {readOnly ? (
            <span className="readonly-badge">参照専用</span>
          ) : (
            <>
              <button className="icon-button" type="button" onClick={onUndoMove} disabled={!canUndoMove} title="移動を戻す">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 8H5V4" />
                  <path d="M5.5 8.5A7 7 0 1 1 5 15" />
                </svg>
              </button>
              <button className="ghost-button" type="button" onClick={() => onEnsureRoot(side)}>
                <span className="button-icon">＋</span>
                子品目追加
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flow-wrap">
        {root ? (
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.35}
              maxZoom={1.7}
              panOnDrag={[0, 1, 2]}
              zoomOnDoubleClick={false}
              nodesDraggable={!readOnly}
              nodesConnectable={false}
              edgesFocusable={false}
              elementsSelectable
              onNodesChange={readOnly ? undefined : onNodesChange}
              onEdgesChange={onEdgesChange}
              onInit={(instance) => {
                flowRef.current = instance;
                requestAnimationFrame(() => instance.fitView({ padding: 0.18 }));
              }}
              onNodeDragStop={(_, node) => {
                if (readOnly) return;
                const nodeCenter = {
                  x: node.position.x + NODE_SIZE / 2,
                  y: node.position.y + NODE_SIZE / 2
                };
                const distanceToSegment = (point, start, end) => {
                  const dx = end.x - start.x;
                  const dy = end.y - start.y;
                  const lengthSq = dx * dx + dy * dy || 1;
                  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
                  const px = start.x + t * dx;
                  const py = start.y + t * dy;
                  return Math.hypot(point.x - px, point.y - py);
                };
                const closestEdge = edges
                  .filter((edge) => edge.source !== node.id && edge.target !== node.id)
                  .map((edge) => {
                    const source = nodes.find((item) => item.id === edge.source);
                    const targetNode = nodes.find((item) => item.id === edge.target);
                    if (!source || !targetNode) return null;
                    return {
                      edge,
                      distance: distanceToSegment(
                        nodeCenter,
                        { x: source.position.x + NODE_SIZE / 2, y: source.position.y + NODE_SIZE },
                        { x: targetNode.position.x + NODE_SIZE / 2, y: targetNode.position.y }
                      )
                    };
                  })
                  .filter(Boolean)
                  .sort((a, b) => a.distance - b.distance)[0];
                if (closestEdge && closestEdge.distance < 42) {
                  const moved = onMove(side, node.id, {
                    type: "insert",
                    sourceId: closestEdge.edge.source,
                    targetId: closestEdge.edge.target
                  });
                  if (moved) return;
                }
                const hits = flowRef.current
                  ?.getIntersectingNodes(node)
                  .filter((item) => item.id !== node.id);
                const target = hits?.[0];
                if (target && onMove(side, node.id, { type: "parent", parentId: target.id })) return;
                setNodes(flow.nodes);
              }}
            >
              <Background gap={28} size={1} color="#dfe6ee" />
              <Controls position="bottom-right" showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
        ) : (
          <div className="empty-flow">
            {readOnly ? `${parentNo} の現行BOMがありません。` : `${parentNo} のBOMがありません。子品目追加で作成できます。`}
          </div>
        )}
      </div>
    </article>
  );
}

function BomTable({ data, parentNo, statuses }) {
  const currentRoot = findNodeByPartNo(data.current, parentNo);
  const nextRoot = findNodeByPartNo(data.next, parentNo);
  const currentRows = currentRoot ? flatten([currentRoot], "current") : [];
  const nextRows = nextRoot ? flatten([nextRoot], "next") : [];
  const currentMap = new Map(currentRows.map((item) => [item.partNo, item]));
  const nextMap = new Map(nextRows.map((item) => [item.partNo, item]));
  const keys = [...new Set([...currentRows.map((item) => item.partNo), ...nextRows.map((item) => item.partNo)])];

  const value = (left, right, key) => {
    const currentValue = left?.[key] ?? "";
    const nextValue = right?.[key] ?? "";
    if (left && right && String(currentValue) !== String(nextValue)) {
      return <span className="cell-change">{currentValue || "-"} → {nextValue || "-"}</span>;
    }
    return currentValue || nextValue || "-";
  };

  return (
    <section className="table-panel">
      <div className="table-head">
        <div>
          <h2>BOM構成一覽</h2>
          <span>親子関係、版数、有効期間、差異ステータス</span>
        </div>
        <div className="legend">
          <span><i className="legend-added" />追加</span>
          <span><i className="legend-changed" />変更</span>
          <span><i className="legend-removed" />削除</span>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>区分</th>
              <th>親品目番号</th>
              <th>子品目番号</th>
              <th>品目名称</th>
              <th>版数</th>
              <th>数量</th>
              <th>有効開始日</th>
              <th>有効終了日</th>
              <th>差異</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((partNo) => {
              const currentItem = currentMap.get(partNo);
              const nextItem = nextMap.get(partNo);
              const item = nextItem || currentItem;
              const status = statuses.get(partNo) || "same";
              const depth = Math.min(currentItem?.depth ?? 99, nextItem?.depth ?? 99);
              return (
                <tr key={partNo}>
                  <td><span className={`row-tag ${status === "same" ? "both" : status}`}>{statusText(status)}</span></td>
                  <td>{value(currentItem, nextItem, "parent")}</td>
                  <td style={{ paddingLeft: 12 + depth * 16 }}>{partNo}</td>
                  <td>{value(currentItem, nextItem, "name")}</td>
                  <td>{value(currentItem, nextItem, "revision")}</td>
                  <td>{value(currentItem, nextItem, "qty")}</td>
                  <td>{value(currentItem, nextItem, "start")}</td>
                  <td>{value(currentItem, nextItem, "end")}</td>
                  <td><span className={`diff-badge ${status}`}>{statusText(status)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EditDialog({ target, data, onClose, onSave }) {
  const node = target?.mode === "edit" ? findNode(data[target.side], target.nodeId) : null;
  const [form, setForm] = useState(() => ({
    partNo: node?.partNo || "",
    name: node?.name || "",
    revision: node?.revision || "A",
    qty: node?.qty || 1,
    start: node?.start || "2026-05-01",
    end: node?.end || "2099-12-31"
  }));

  if (!target) return null;

  const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="dialog-backdrop">
      <form
        className="node-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(form);
        }}
      >
        <div>
          <h2>{target.mode === "edit" ? "品目を修正" : "子品目を追加"}</h2>
          <p>{target.side === "current" ? "現行BOM" : "新BOM"} の構成品を編集します。</p>
        </div>
        <label>子品目番号<input value={form.partNo} onChange={(e) => update("partNo", e.target.value)} required /></label>
        <label>品目名称<input value={form.name} onChange={(e) => update("name", e.target.value)} required /></label>
        <div className="form-grid">
          <label>版数<input value={form.revision} onChange={(e) => update("revision", e.target.value)} required /></label>
          <label>数量<input type="number" min="1" value={form.qty} onChange={(e) => update("qty", Number(e.target.value || 1))} /></label>
        </div>
        <div className="form-grid">
          <label>有効開始日<input type="date" value={form.start} onChange={(e) => update("start", e.target.value)} /></label>
          <label>有効終了日<input type="date" value={form.end} onChange={(e) => update("end", e.target.value)} /></label>
        </div>
        <menu>
          <button type="button" onClick={onClose}>キャンセル</button>
          <button className="primary-action" type="submit">保存</button>
        </menu>
      </form>
    </div>
  );
}

function App() {
  const [data, setData] = useState(initialState);
  const [history, setHistory] = useState([]);
  const [moveHistory, setMoveHistory] = useState([]);
  const [parentInput, setParentInput] = useState("PRD-9000");
  const [parentNo, setParentNo] = useState("PRD-9000");
  const [collapsed, setCollapsed] = useState(false);
  const [dialog, setDialog] = useState(null);
  const currentCsvRef = useRef(null);
  const nextCsvRef = useRef(null);
  const [layoutVersion, setLayoutVersion] = useState(0);

  const statuses = useMemo(() => buildDiffMap(data, parentNo), [data, parentNo]);
  const diffCount = [...statuses.values()].filter((item) => item !== "same").length;

  const commit = (updater) => {
    setData((prev) => {
      setHistory((items) => [...items.slice(-19), deepClone(prev)]);
      const next = deepClone(prev);
      updater(next);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next, null, 2));
      return next;
    });
    setLayoutVersion((value) => value + 1);
  };

  const onEnsureRoot = (side) => {
    commit((next) => {
      const root = ensureRoot(next, side, parentNo);
      setDialog({ mode: "add", side, parentId: root.id });
    });
  };

  const onMove = (side, movingId, move) => {
    if (side !== "next") return false;
    const preview = deepClone(data);
    let moved = false;
    const applyMove = (next) => {
      const root = findNodeByPartNo(next[side], parentNo);
      if (!root || root.id === movingId) return;
      const moving = findNode(next[side], movingId);
      if (!moving) return;

      if (move.type === "insert") {
        if (movingId === move.sourceId || movingId === move.targetId) return;
        const source = findNode(next[side], move.sourceId);
        const target = findNode(next[side], move.targetId);
        if (!source || !target || hasDescendant(moving, move.sourceId) || hasDescendant(moving, move.targetId)) return;
        const removed = removeNode(next[side], movingId);
        if (!removed) return;
        source.children = (source.children || []).filter((child) => child.id !== target.id);
        removed.parent = source.partNo;
        removed.expanded = true;
        target.parent = removed.partNo;
        removed.children = removed.children || [];
        removed.children = removed.children.filter((child) => child.id !== target.id);
        removed.children.push(target);
        source.expanded = true;
        source.children.push(removed);
        moved = true;
        return;
      }

      const parent = findNode(next[side], move.parentId);
      if (!parent || movingId === move.parentId || hasDescendant(moving, move.parentId)) return;
      const removed = removeNode(next[side], movingId);
      if (!removed) return;
      removed.parent = parent.partNo;
      parent.expanded = true;
      parent.children = parent.children || [];
      parent.children.push(removed);
      moved = true;
    };
    applyMove(preview);
    if (!moved) return false;
    setMoveHistory((items) => [...items.slice(-9), deepClone(data)]);
    commit(applyMove);
    return true;
  };

  const undoMove = () => {
    const snapshot = moveHistory.at(-1);
    if (!snapshot) return;
    setData(snapshot);
    setMoveHistory((items) => items.slice(0, -1));
    setLayoutVersion((value) => value + 1);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot, null, 2));
  };

  const onToggle = (side, nodeId) => {
    commit((next) => {
      const node = findNode(next[side], nodeId);
      if (node) node.expanded = node.expanded === false;
    });
  };

  const onSaveDialog = (form) => {
    if (!form.partNo.trim() || !form.name.trim()) return;
    commit((next) => {
      if (dialog.mode === "edit") {
        const node = findNode(next[dialog.side], dialog.nodeId);
        if (!node) return;
        const oldPartNo = node.partNo;
        Object.assign(node, {
          partNo: form.partNo.trim(),
          name: form.name.trim(),
          revision: form.revision.trim(),
          qty: Number(form.qty || 1),
          start: form.start,
          end: form.end
        });
        if (oldPartNo !== node.partNo) {
          (node.children || []).forEach((child) => {
            child.parent = node.partNo;
          });
        }
        return;
      }
      const parent = findNode(next[dialog.side], dialog.parentId);
      if (!parent) return;
      parent.expanded = true;
      parent.children = parent.children || [];
      parent.children.push({
        id: `${dialog.side}-${Date.now()}`,
        parent: parent.partNo,
        partNo: form.partNo.trim(),
        name: form.name.trim(),
        revision: form.revision.trim(),
        qty: Number(form.qty || 1),
        start: form.start,
        end: form.end,
        expanded: true,
        children: []
      });
    });
    setDialog(null);
  };

  const exportCsv = async () => {
    const text = exportBomCsv(data.next);
    if ("showSaveFilePicker" in window) {
      const handle = await window.showSaveFilePicker({
        suggestedName: "new-bom.csv",
        types: [{ description: "BOM CSV", accept: { "text/csv": [".csv"] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "new-bom.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const importCsv = async (side, file) => {
    if (!file) return;
    const tree = csvToTree(await file.text());
    setHistory((items) => [...items.slice(-19), deepClone(data)]);
    const nextData = { ...data, [side]: tree };
    setData(nextData);
    setLayoutVersion((value) => value + 1);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextData, null, 2));
  };

  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">B</div>
          <div><strong>BOM Hub</strong><span>部品構成管理</span></div>
        </div>
        <button className="sidebar-toggle" type="button" onClick={() => setCollapsed((v) => !v)} title="メニュー収縮">‹</button>
        <nav className="menu">
          {["BOM比較", "品目マスタ", "版数管理", "差異レポート", "システム設定"].map((item, index) => (
            <button className={`menu-item ${index === 0 ? "active" : ""}`} type="button" key={item}>
              <span className="menu-icon">{["☰", "□", "≡", "↗", "⚙"][index]}</span>{item}
            </button>
          ))}
        </nav>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>BOM構成展開・比較</h1>
            <p>React Flowで現行BOMと新BOMを左右に展開し、構成差異を確認します。</p>
          </div>
          <div className="top-actions">
            <button className="ghost-button" type="button" onClick={exportCsv}>CSV出力</button>
            <button className="ghost-button" type="button" onClick={() => currentCsvRef.current?.click()}>現行BOM CSV読込</button>
            <button className="ghost-button" type="button" onClick={() => nextCsvRef.current?.click()}>新BOM CSV読込</button>
            <input
              ref={currentCsvRef}
              hidden
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                importCsv("current", e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <input
              ref={nextCsvRef}
              hidden
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                importCsv("next", e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <button className="primary-action" type="button">差異を再計算</button>
          </div>
        </header>

        <section className="filter-bar">
          <label>親品目番号<input value={parentInput} onChange={(e) => setParentInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setParentNo(parentInput.trim() || "PRD-9000")} /></label>
          <button className="ghost-button filter-action" type="button" onClick={() => setParentNo(parentInput.trim() || "PRD-9000")}>読込</button>
          <label>版数<select><option>Rev. 03 / Rev. 04</option><option>Rev. 02 / Rev. 03</option></select></label>
          <label>有効基準日<input type="date" defaultValue="2026-05-01" /></label>
          <div className="status-stack"><span className="status-dot" /><span>差異 {diffCount} 件</span></div>
          <button
            className="ghost-button filter-action"
            type="button"
            disabled={!history.length}
            onClick={() => {
              const snapshot = history.at(-1);
              if (!snapshot) return;
              setData(snapshot);
              setHistory((items) => items.slice(0, -1));
              setLayoutVersion((value) => value + 1);
              localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot, null, 2));
            }}
          >
            戻す
          </button>
        </section>

        <section className="tree-grid">
          <BomFlow
            side="current"
            title="現行BOM"
            subtitle="現在の物料ツリー"
            readOnly
            data={data}
            parentNo={parentNo}
            layoutVersion={layoutVersion}
            statuses={statuses}
            onToggle={onToggle}
          />
          <BomFlow
            side="next"
            title="新BOM"
            subtitle="新しい物料ツリー"
            data={data}
            parentNo={parentNo}
            layoutVersion={layoutVersion}
            statuses={statuses}
            canUndoMove={moveHistory.length > 0}
            onAdd={(side, parentId) => setDialog({ mode: "add", side, parentId })}
            onEdit={(side, nodeId) => setDialog({ mode: "edit", side, nodeId })}
            onToggle={onToggle}
            onMove={onMove}
            onUndoMove={undoMove}
            onEnsureRoot={onEnsureRoot}
          />
        </section>

        <BomTable data={data} parentNo={parentNo} statuses={statuses} />
      </main>

      {dialog && <EditDialog key={`${dialog.mode}-${dialog.nodeId || dialog.parentId}`} target={dialog} data={data} onClose={() => setDialog(null)} onSave={onSaveDialog} />}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
