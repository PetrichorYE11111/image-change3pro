import { useCallback, useMemo, useRef, useState } from "react";
import { Button, Checkbox, message, Tooltip } from "antd";
import { CheckCircle2, ClipboardCopy, ImagePlus, Layers, Loader2, Play, PlaySquare, Trash2, X } from "lucide-react";
import { nanoid } from "nanoid";

import type { CanvasNodeContext } from "@/types/canvas-plugin";
import type { LayoutData, LayoutRegion } from "@/types/canvas-layout";
import { EMPTY_LAYOUT_DATA } from "@/types/canvas-layout";
import { CanvasLayoutDrawingCanvas } from "@/components/canvas/canvas-layout-drawing-canvas";
import { CanvasNodeType } from "@/types/canvas";
import { buildRegionPrompt, exportLayoutJson } from "@/services/api/layout-region";

// ---- 颜色调色板（与画布同步） ----
const REGION_COLORS = [
    "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
    "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16",
];
const regionColor = (idx: number) => REGION_COLORS[idx % REGION_COLORS.length];

// ---- 解析/序列化 ----
function parseLayout(raw?: string): LayoutData {
    if (!raw) return { ...EMPTY_LAYOUT_DATA };
    try { return JSON.parse(raw) as LayoutData; }
    catch { return { ...EMPTY_LAYOUT_DATA }; }
}

// ---- 获取上游图片节点（供 @ 参考图选择器使用）----
function getUpstreamImageNodes(ctx: CanvasNodeContext) {
    return ctx.getUpstream().filter(
        (n) => n.type === CanvasNodeType.Image && n.metadata?.content
    );
}

// ============================================================
// Content 组件 — 节点卡片内缩略预览
// ============================================================
export function LayoutEditorContent({ ctx }: { ctx: CanvasNodeContext }) {
    const layout = useMemo(() => parseLayout(ctx.node.metadata?.layoutData), [ctx.node.metadata?.layoutData]);
    const bgImage = ctx.node.metadata?.content;
    const refCount = getUpstreamImageNodes(ctx).length;

    return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-2 overflow-hidden">
            <div className="relative rounded overflow-hidden bg-slate-800 border border-slate-600 flex-1 w-full" style={{ minHeight: 60 }}>
                {bgImage && <img src={bgImage} alt="" className="absolute inset-0 w-full h-full object-cover opacity-50" />}
                <svg viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 w-full h-full">
                    {layout.regions.map((r, idx) => (
                        <g key={r.id}>
                            <rect x={Math.min(r.startX, r.endX)} y={Math.min(r.startY, r.endY)} width={Math.abs(r.endX - r.startX)} height={Math.abs(r.endY - r.startY)} fill={regionColor(idx)} fillOpacity={0.28} stroke={regionColor(idx)} strokeWidth={1.5} />
                            <text x={Math.min(r.startX, r.endX) + 4} y={Math.min(r.startY, r.endY) + 13} fontSize={10} fill="#fff">{r.label || `区域 ${idx + 1}`}</text>
                        </g>
                    ))}
                </svg>
                {!layout.regions.length && <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs">双击编辑布局</div>}
            </div>
            <div className="text-xs text-slate-400 w-full text-left">
                {layout.regions.length} 个区域{refCount > 0 ? ` · ${refCount} 张全局参考图` : ""}
            </div>
        </div>
    );
}

// ============================================================
// Panel 组件 — 完整编辑 + 生成
// ============================================================
type RegionGenStatus = "idle" | "loading" | "done" | "error";

export function LayoutEditorPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const [layout, setLayout] = useState<LayoutData>(() => parseLayout(ctx.node.metadata?.layoutData));
    const [selectedId, setSelectedId] = useState<string | null>(null);       // 当前展开编辑的区域
    const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());    // 多选勾选
    const [genStatus, setGenStatus] = useState<Record<string, RegionGenStatus>>({});
    const [bgPreview, setBgPreview] = useState<string | undefined>(ctx.node.metadata?.content);
    const abortRef = useRef<AbortController | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [msgApi, contextHolder] = message.useMessage();

    const upstreamImageNodes = getUpstreamImageNodes(ctx);
    const selectedRegion = layout.regions.find((r) => r.id === selectedId) ?? null;

    // ---- 持久化 ----
    const saveLayout = useCallback((next: LayoutData) => {
        setLayout(next);
        ctx.updateMetadata({ layoutData: JSON.stringify(next) });
    }, [ctx]);

    const updateRegion = useCallback((id: string, patch: Partial<LayoutRegion>) => {
        saveLayout({ ...layout, regions: layout.regions.map((r) => r.id === id ? { ...r, ...patch } : r) });
    }, [layout, saveLayout]);

    const deleteRegion = useCallback((id: string) => {
        saveLayout({ ...layout, regions: layout.regions.filter((r) => r.id !== id) });
        if (selectedId === id) setSelectedId(null);
        setCheckedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }, [layout, saveLayout, selectedId]);

    // ---- 上传布局背景图 ----
    const handleBgUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result as string;
            setBgPreview(dataUrl);
            ctx.updateMetadata({ content: dataUrl });
        };
        reader.readAsDataURL(file);
        e.target.value = "";
    }, [ctx]);

    // ---- 切换区域 @ 参考图 ----
    const toggleRegionRef = useCallback((regionId: string, nodeId: string) => {
        const region = layout.regions.find((r) => r.id === regionId);
        if (!region) return;
        const prev = region.referenceNodeIds ?? [];
        const next = prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId];
        updateRegion(regionId, { referenceNodeIds: next });
    }, [layout.regions, updateRegion]);

    // ---- 生成单区域 ----
    const generateRegion = useCallback(async (region: LayoutRegion) => {
        if (!region.prompt.trim()) {
            void msgApi.warning(`区域「${region.label}」未填写提示词`);
            return;
        }
        // 解析参考图：优先用该区域独立绑定的节点，回退到全局上游图
        const refNodeIds = region.referenceNodeIds?.length
            ? region.referenceNodeIds
            : upstreamImageNodes.map((n) => n.id);
        const references = refNodeIds
            .map((id) => ctx.getNode(id)?.metadata?.content)
            .filter((url): url is string => Boolean(url));

        const prompt = buildRegionPrompt(region, layout, references.length);
        const abort = new AbortController();
        abortRef.current = abort;
        setGenStatus((prev) => ({ ...prev, [region.id]: "loading" }));
        try {
            const result = await ctx.ai.generateImage(prompt, {
                references,
                signal: abort.signal,
                count: 1,
            });
            const imageUrl = result.images[0];
            if (!imageUrl) throw new Error("No image returned");

            const parentNode = ctx.node;
            const childId = nanoid();
            ctx.applyOps([
                {
                    type: "add_node",
                    id: childId,
                    nodeType: CanvasNodeType.Image,
                    title: region.label || "生成图",
                    position: {
                        x: parentNode.position.x + parentNode.width + 96 + layout.regions.indexOf(region) * 360,
                        y: parentNode.position.y,
                    },
                    width: 340,
                    height: 240,
                    metadata: { content: imageUrl, status: "success", prompt: region.prompt },
                },
                { type: "connect_nodes", fromNodeId: parentNode.id, toNodeId: childId },
            ]);
            setGenStatus((prev) => ({ ...prev, [region.id]: "done" }));
        } catch (err) {
            if ((err as Error)?.name === "AbortError") return;
            void msgApi.error(`区域「${region.label}」生成失败：${(err as Error).message}`);
            setGenStatus((prev) => ({ ...prev, [region.id]: "error" }));
        }
    }, [ctx, layout, upstreamImageNodes, msgApi]);

    // ---- 生成全部 / 选中 ----
    const generateBatch = useCallback(async (ids?: Set<string>) => {
        const targets = ids?.size
            ? layout.regions.filter((r) => ids.has(r.id))
            : layout.regions;
        for (const region of targets) await generateRegion(region);
    }, [layout.regions, generateRegion]);

    const stopAll = useCallback(() => {
        abortRef.current?.abort();
        setGenStatus({});
    }, []);

    // ---- 全选 / 取消 ----
    const toggleAll = () => {
        if (checkedIds.size === layout.regions.length) {
            setCheckedIds(new Set());
        } else {
            setCheckedIds(new Set(layout.regions.map((r) => r.id)));
        }
    };

    // ---- 复制 JSON ----
    const copyJson = useCallback(() => {
        const json = exportLayoutJson(layout, checkedIds.size ? checkedIds : undefined);
        void navigator.clipboard.writeText(json).then(() => void msgApi.success("JSON 已复制到剪贴板"));
    }, [layout, checkedIds, msgApi]);

    const isAnyLoading = Object.values(genStatus).includes("loading");
    const checkedCount = checkedIds.size;

    return (
        <div className="flex flex-col h-full bg-slate-900 text-slate-200 overflow-hidden">
            {contextHolder}
            {/* 顶部工具栏 */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 shrink-0 gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Layers className="size-4 text-amber-400" />
                    布局编辑器
                    {upstreamImageNodes.length > 0 && (
                        <span className="text-xs text-slate-400">· {upstreamImageNodes.length} 张全局参考图</span>
                    )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    <Tooltip title="上传布局参考背景图（对照用，非生图参考）">
                        <Button size="small" icon={<ImagePlus className="size-3.5" />} onClick={() => fileInputRef.current?.click()} />
                    </Tooltip>
                    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleBgUpload} />
                    <Tooltip title={checkedCount ? `复制 ${checkedCount} 个选中区域的 JSON` : "复制所有区域 JSON"}>
                        <Button size="small" icon={<ClipboardCopy className="size-3.5" />} onClick={copyJson}>
                            {checkedCount ? `复制 JSON (${checkedCount})` : "复制 JSON"}
                        </Button>
                    </Tooltip>
                    {isAnyLoading ? (
                        <Button size="small" danger icon={<X className="size-3.5" />} onClick={stopAll}>停止</Button>
                    ) : (
                        <>
                            {checkedCount > 0 && (
                                <Button size="small" icon={<PlaySquare className="size-3.5" />} onClick={() => void generateBatch(checkedIds)} disabled={!checkedCount}>
                                    生成选中 ({checkedCount})
                                </Button>
                            )}
                            <Button size="small" type="primary" icon={<Play className="size-3.5" />} disabled={!layout.regions.length} onClick={() => void generateBatch()}>
                                全部生成
                            </Button>
                        </>
                    )}
                    <Button size="small" icon={<X className="size-3.5" />} onClick={onClose} />
                </div>
            </div>

            <div className="flex flex-1 min-h-0">
                {/* 左侧：绘图画布 */}
                <div className="flex-1 p-3 overflow-auto">
                    <CanvasLayoutDrawingCanvas
                        layout={layout}
                        bgImage={bgPreview}
                        selectedId={selectedId ?? undefined}
                        onChange={saveLayout}
                        onSelect={setSelectedId}
                    />
                    <div className="mt-2 text-xs text-slate-500">
                        {upstreamImageNodes.length > 0
                            ? `${upstreamImageNodes.length} 张全局参考图（连线图片节点）· 每区域可单独覆盖`
                            : "连线图片节点可作为参考图；或在区域里单独指定 @ 参考图"}
                    </div>
                </div>

                {/* 右侧：区域列表 */}
                <div className="w-72 shrink-0 border-l border-slate-700 flex flex-col overflow-hidden">
                    {/* 列表头部：全选 */}
                    {layout.regions.length > 0 && (
                        <div className="px-3 py-2 border-b border-slate-700 flex items-center gap-2">
                            <Checkbox
                                indeterminate={checkedCount > 0 && checkedCount < layout.regions.length}
                                checked={checkedCount === layout.regions.length}
                                onChange={toggleAll}
                            />
                            <span className="text-xs text-slate-400">
                                {checkedCount > 0 ? `已选 ${checkedCount} / ${layout.regions.length}` : `${layout.regions.length} 个区域`}
                            </span>
                        </div>
                    )}

                    <div className="flex-1 overflow-y-auto thin-scrollbar">
                        {layout.regions.length === 0 && (
                            <div className="p-4 text-xs text-slate-500 text-center">Ctrl+拖拽画布添加区域</div>
                        )}
                        {layout.regions.map((region, idx) => {
                            const status = genStatus[region.id] ?? "idle";
                            const isSelected = selectedId === region.id;
                            const isChecked = checkedIds.has(region.id);
                            const regionRefs = (region.referenceNodeIds ?? [])
                                .map((id) => upstreamImageNodes.find((n) => n.id === id))
                                .filter(Boolean);

                            return (
                                <div key={region.id} className={`border-b border-slate-800 ${isSelected ? "bg-slate-800/80" : ""}`}>
                                    {/* 区域行 */}
                                    <div
                                        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-slate-800/60"
                                        onClick={() => setSelectedId(isSelected ? null : region.id)}
                                    >
                                        <Checkbox
                                            checked={isChecked}
                                            onChange={(e) => {
                                                e.stopPropagation();
                                                setCheckedIds((prev) => {
                                                    const next = new Set(prev);
                                                    if (e.target.checked) next.add(region.id);
                                                    else next.delete(region.id);
                                                    return next;
                                                });
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                        />
                                        <div className="size-2.5 rounded-sm shrink-0" style={{ background: regionColor(idx) }} />
                                        <span className="text-xs font-medium truncate flex-1">{region.label || `区域 ${idx + 1}`}</span>
                                        <div className="flex items-center gap-1">
                                            {status === "loading" && <Loader2 className="size-3 animate-spin text-blue-400" />}
                                            {status === "done" && <CheckCircle2 className="size-3 text-emerald-400" />}
                                            {status === "error" && <span className="text-[10px] text-red-400">✕</span>}
                                            {regionRefs.length > 0 && (
                                                <span className="text-[10px] text-amber-400 font-medium">@{regionRefs.length}</span>
                                            )}
                                            <button
                                                className="p-0.5 hover:text-blue-400 text-slate-500"
                                                onClick={(e) => { e.stopPropagation(); void generateRegion(region); }}
                                                disabled={status === "loading"}
                                            >
                                                <Play className="size-3" />
                                            </button>
                                            <button
                                                className="p-0.5 hover:text-red-400 text-slate-500"
                                                onClick={(e) => { e.stopPropagation(); deleteRegion(region.id); }}
                                            >
                                                <Trash2 className="size-3" />
                                            </button>
                                        </div>
                                    </div>

                                    {/* 展开编辑区 */}
                                    {isSelected && (
                                        <div className="px-3 pb-3 flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
                                            {/* 标签 */}
                                            <input
                                                className="w-full bg-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 ring-blue-500"
                                                placeholder="区域标签（如：沙发区）"
                                                value={region.label}
                                                onChange={(e) => updateRegion(region.id, { label: e.target.value })}
                                            />
                                            {/* 提示词 */}
                                            <textarea
                                                rows={4}
                                                className="w-full bg-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 ring-blue-500 resize-none"
                                                placeholder="该区域完整生图提示词…"
                                                value={region.prompt}
                                                onChange={(e) => updateRegion(region.id, { prompt: e.target.value })}
                                            />

                                            {/* @ 参考图选择器 */}
                                            {upstreamImageNodes.length > 0 && (
                                                <div>
                                                    <div className="text-[10px] text-slate-400 mb-1">@ 参考图（仅此区域生效）</div>
                                                    <div className="flex flex-wrap gap-1">
                                                        {upstreamImageNodes.map((node, ni) => {
                                                            const active = (region.referenceNodeIds ?? []).includes(node.id);
                                                            return (
                                                                <button
                                                                    key={node.id}
                                                                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border transition ${active ? "border-blue-500 bg-blue-500/20 text-blue-200" : "border-slate-600 text-slate-400 hover:border-slate-400"}`}
                                                                    onClick={() => toggleRegionRef(region.id, node.id)}
                                                                >
                                                                    {node.metadata?.content && (
                                                                        <img src={node.metadata.content} alt="" className="size-3.5 rounded object-cover" />
                                                                    )}
                                                                    {node.title || `图${ni + 1}`}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                    {(region.referenceNodeIds?.length ?? 0) === 0 && (
                                                        <div className="text-[10px] text-slate-500 mt-1">未选择 → 回退使用全局参考图</div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
