import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, message, Tooltip } from "antd";
import { CheckCircle2, ImagePlus, Layers, Loader2, Play, Trash2, X } from "lucide-react";
import { nanoid } from "nanoid";

import type { CanvasNodeContext } from "@/types/canvas-plugin";
import type { LayoutData, LayoutRegion } from "@/types/canvas-layout";
import { EMPTY_LAYOUT_DATA } from "@/types/canvas-layout";
import { CanvasLayoutDrawingCanvas } from "@/components/canvas/canvas-layout-drawing-canvas";
import { CanvasNodeType } from "@/types/canvas";

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

// ---- 获取上游参考图 ----
function getUpstreamReferenceUrls(ctx: CanvasNodeContext): string[] {
    return ctx
        .getUpstream()
        .filter((n) => n.type === CanvasNodeType.Image && n.metadata?.content)
        .map((n) => n.metadata!.content!);
}

// ============================================================
// Content 组件 — 节点卡片内显示（缩略预览）
// ============================================================
export function LayoutEditorContent({ ctx }: { ctx: CanvasNodeContext }) {
    const layout = useMemo(() => parseLayout(ctx.node.metadata?.layoutData), [ctx.node.metadata?.layoutData]);
    const bgImage = ctx.node.metadata?.content;

    return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-2 overflow-hidden">
            {/* 缩略布局预览 */}
            <div
                className="relative rounded overflow-hidden bg-slate-800 border border-slate-600 flex-1 w-full"
                style={{ minHeight: 60 }}
            >
                {bgImage && (
                    <img src={bgImage} alt="" className="absolute inset-0 w-full h-full object-cover opacity-50" />
                )}
                {/* 区域框缩略 */}
                <svg
                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                    preserveAspectRatio="xMidYMid meet"
                    className="absolute inset-0 w-full h-full"
                >
                    {layout.regions.map((r, idx) => (
                        <g key={r.id}>
                            <rect
                                x={Math.min(r.startX, r.endX)}
                                y={Math.min(r.startY, r.endY)}
                                width={Math.abs(r.endX - r.startX)}
                                height={Math.abs(r.endY - r.startY)}
                                fill={regionColor(idx)}
                                fillOpacity={0.28}
                                stroke={regionColor(idx)}
                                strokeWidth={1.5}
                            />
                            <text
                                x={Math.min(r.startX, r.endX) + 4}
                                y={Math.min(r.startY, r.endY) + 13}
                                fontSize={10}
                                fill="#fff"
                            >
                                {r.label || `区域 ${idx + 1}`}
                            </text>
                        </g>
                    ))}
                </svg>
                {!layout.regions.length && (
                    <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs">
                        双击编辑布局
                    </div>
                )}
            </div>
            <div className="text-xs text-slate-400 w-full text-left">
                {layout.regions.length} 个区域{getUpstreamReferenceUrls(ctx).length > 0 ? " · 有参考图" : ""}
            </div>
        </div>
    );
}

// ============================================================
// Panel 组件 — 底部展开面板（完整编辑 + 生成）
// ============================================================
type RegionGenStatus = "idle" | "loading" | "done" | "error";

export function LayoutEditorPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const [layout, setLayout] = useState<LayoutData>(() => parseLayout(ctx.node.metadata?.layoutData));
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [globalPrompt, setGlobalPrompt] = useState(ctx.node.metadata?.prompt ?? "");
    const [genStatus, setGenStatus] = useState<Record<string, RegionGenStatus>>({});
    const [bgPreview, setBgPreview] = useState<string | undefined>(ctx.node.metadata?.content);
    const abortRef = useRef<AbortController | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [msgApi, contextHolder] = message.useMessage();

    const selectedRegion = layout.regions.find((r) => r.id === selectedId) ?? null;

    // 保存 layout 到 metadata
    const saveLayout = useCallback((next: LayoutData) => {
        setLayout(next);
        ctx.updateMetadata({ layoutData: JSON.stringify(next) });
    }, [ctx]);

    // 更新选中区域的字段
    const updateRegion = useCallback((id: string, patch: Partial<LayoutRegion>) => {
        saveLayout({
            ...layout,
            regions: layout.regions.map((r) => r.id === id ? { ...r, ...patch } : r),
        });
    }, [layout, saveLayout]);

    // 删除选中区域
    const deleteRegion = useCallback((id: string) => {
        saveLayout({ ...layout, regions: layout.regions.filter((r) => r.id !== id) });
        if (selectedId === id) setSelectedId(null);
    }, [layout, saveLayout, selectedId]);

    // 上传/替换背景图（布局参考图，存 metadata.content）
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

    // 生成单个区域
    const generateRegion = useCallback(async (region: LayoutRegion) => {
        const prompt = region.prompt.trim() || globalPrompt.trim();
        if (!prompt) { void msgApi.warning(`区域「${region.label}」未填写提示词`); return; }
        const references = getUpstreamReferenceUrls(ctx);
        const abort = new AbortController();
        abortRef.current = abort;
        setGenStatus((prev) => ({ ...prev, [region.id]: "loading" }));
        try {
            const result = await ctx.ai.generateImage(prompt, { references, signal: abort.signal, count: 1 });
            const imageUrl = result.images[0];
            if (!imageUrl) throw new Error("No image returned");

            // 在布局节点右侧创建子图片节点
            const childId = nanoid();
            const parentNode = ctx.node;
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
                    metadata: { content: imageUrl, status: "success", prompt },
                },
                { type: "connect_nodes", fromNodeId: parentNode.id, toNodeId: childId },
            ]);
            setGenStatus((prev) => ({ ...prev, [region.id]: "done" }));
        } catch (err) {
            if ((err as Error)?.name === "AbortError") return;
            void msgApi.error(`区域「${region.label}」生成失败`);
            setGenStatus((prev) => ({ ...prev, [region.id]: "error" }));
        }
    }, [ctx, globalPrompt, layout.regions, msgApi]);

    // 全部生成
    const generateAll = useCallback(async () => {
        for (const region of layout.regions) {
            await generateRegion(region);
        }
    }, [layout.regions, generateRegion]);

    // 停止
    const stopAll = useCallback(() => {
        abortRef.current?.abort();
        setGenStatus({});
    }, []);

    const isAnyLoading = Object.values(genStatus).includes("loading");
    const upstreamCount = getUpstreamReferenceUrls(ctx).length;

    return (
        <div className="flex flex-col h-full bg-slate-900 text-slate-200 overflow-hidden">
            {contextHolder}
            {/* 顶部工具栏 */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 shrink-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Layers className="size-4 text-amber-400" />
                    布局编辑器
                    {upstreamCount > 0 && (
                        <span className="text-xs text-slate-400">· {upstreamCount} 张参考图</span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {/* 上传布局参考图 */}
                    <Tooltip title="上传布局参考图（非生图参考，仅用于对照）">
                        <Button size="small" icon={<ImagePlus className="size-3.5" />} onClick={() => fileInputRef.current?.click()} />
                    </Tooltip>
                    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleBgUpload} />
                    {/* 生成全部 / 停止 */}
                    {isAnyLoading ? (
                        <Button size="small" danger icon={<X className="size-3.5" />} onClick={stopAll}>停止</Button>
                    ) : (
                        <Button
                            size="small"
                            type="primary"
                            icon={<Play className="size-3.5" />}
                            disabled={!layout.regions.length}
                            onClick={() => void generateAll()}
                        >
                            全部生成
                        </Button>
                    )}
                    <Button size="small" icon={<X className="size-3.5" />} onClick={onClose} />
                </div>
            </div>

            <div className="flex flex-1 min-h-0">
                {/* 左侧：绘图画布 */}
                <div className="flex-1 p-3 overflow-auto">
                    {/* 全局提示词（可选，用于无独立提示词的区域的 fallback） */}
                    <div className="mb-3">
                        <div className="text-xs text-slate-400 mb-1">全局提示词（作为未填区域的 fallback）</div>
                        <Input.TextArea
                            rows={2}
                            placeholder="可为空 — 每个区域有独立提示词时无需填写"
                            value={globalPrompt}
                            onChange={(e) => {
                                setGlobalPrompt(e.target.value);
                                ctx.updateMetadata({ prompt: e.target.value });
                            }}
                            className="text-xs"
                        />
                    </div>
                    <CanvasLayoutDrawingCanvas
                        layout={layout}
                        bgImage={bgPreview}
                        selectedId={selectedId ?? undefined}
                        onChange={saveLayout}
                        onSelect={setSelectedId}
                    />
                    <div className="mt-2 text-xs text-slate-500">
                        {upstreamCount > 0
                            ? `已连接 ${upstreamCount} 张参考图，将作为所有区域的生图参考`
                            : "如需参考图，请将图片节点连线到本节点"}
                    </div>
                </div>

                {/* 右侧：区域列表 + 选中区域编辑 */}
                <div className="w-64 shrink-0 border-l border-slate-700 flex flex-col overflow-hidden">
                    <div className="px-3 py-2 text-xs font-medium text-slate-400 border-b border-slate-700">
                        区域列表 ({layout.regions.length})
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {layout.regions.length === 0 && (
                            <div className="p-4 text-xs text-slate-500 text-center">
                                Ctrl+拖拽画布添加区域
                            </div>
                        )}
                        {layout.regions.map((region, idx) => {
                            const status = genStatus[region.id] ?? "idle";
                            const isSelected = selectedId === region.id;
                            return (
                                <div
                                    key={region.id}
                                    className={`px-3 py-2 cursor-pointer border-b border-slate-800 hover:bg-slate-800 ${isSelected ? "bg-slate-800" : ""}`}
                                    onClick={() => setSelectedId(region.id)}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                            <div className="size-2.5 rounded-sm shrink-0" style={{ background: regionColor(idx) }} />
                                            <span className="text-xs font-medium truncate">{region.label || `区域 ${idx + 1}`}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            {status === "loading" && <Loader2 className="size-3 animate-spin text-blue-400" />}
                                            {status === "done" && <CheckCircle2 className="size-3 text-emerald-400" />}
                                            {status === "error" && <X className="size-3 text-red-400" />}
                                            <button
                                                className="p-0.5 hover:text-red-400 text-slate-500"
                                                onClick={(e) => { e.stopPropagation(); deleteRegion(region.id); }}
                                            >
                                                <Trash2 className="size-3" />
                                            </button>
                                            <button
                                                className="p-0.5 hover:text-blue-400 text-slate-500"
                                                onClick={(e) => { e.stopPropagation(); void generateRegion(region); }}
                                                disabled={status === "loading"}
                                            >
                                                <Play className="size-3" />
                                            </button>
                                        </div>
                                    </div>
                                    {isSelected && (
                                        <div className="mt-2 flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
                                            <Input
                                                size="small"
                                                placeholder="区域标签"
                                                value={region.label}
                                                onChange={(e) => updateRegion(region.id, { label: e.target.value })}
                                            />
                                            <Input.TextArea
                                                rows={4}
                                                size="small"
                                                placeholder="该区域完整生图提示词…"
                                                value={region.prompt}
                                                onChange={(e) => updateRegion(region.id, { prompt: e.target.value })}
                                            />
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
