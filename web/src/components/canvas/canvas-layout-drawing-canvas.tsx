import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "antd";
import { nanoid } from "nanoid";

import type { LayoutData, LayoutRegion } from "@/types/canvas-layout";

// 区域颜色调色板（循环复用）
const REGION_COLORS = [
    "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
    "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16",
];
const regionColor = (idx: number) => REGION_COLORS[idx % REGION_COLORS.length];

type DrawState =
    | { phase: "idle" }
    | { phase: "drawing"; startX: number; startY: number; curX: number; curY: number }
    | { phase: "labeling"; region: LayoutRegion };

type Props = {
    layout: LayoutData;
    bgImage?: string;        // 可选背景图 dataUrl / URL
    selectedId?: string;
    onChange: (layout: LayoutData) => void;
    onSelect: (id: string | null) => void;
};

/** 把 clientX/Y 转换成画布坐标 */
function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: Math.round((clientX - rect.left) * scaleX),
        y: Math.round((clientY - rect.top) * scaleY),
    };
}

/** 判断点是否在矩形内（含 5px 边距容忍） */
function hitRegion(region: LayoutRegion, x: number, y: number): boolean {
    const x0 = Math.min(region.startX, region.endX) - 5;
    const y0 = Math.min(region.startY, region.endY) - 5;
    const x1 = Math.max(region.startX, region.endX) + 5;
    const y1 = Math.max(region.startY, region.endY) + 5;
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

export function CanvasLayoutDrawingCanvas({ layout, bgImage, selectedId, onChange, onSelect }: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [drawState, setDrawState] = useState<DrawState>({ phase: "idle" });
    const [labelInput, setLabelInput] = useState("");
    const [promptInput, setPromptInput] = useState("");
    const bgRef = useRef<HTMLImageElement | null>(null);

    // 加载背景图
    useEffect(() => {
        if (!bgImage) { bgRef.current = null; return; }
        const img = new Image();
        img.src = bgImage;
        img.onload = () => { bgRef.current = img; render(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bgImage]);

    const render = useCallback(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 背景
        if (bgRef.current) {
            ctx.drawImage(bgRef.current, 0, 0, canvas.width, canvas.height);
        } else {
            ctx.fillStyle = "#1e293b";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            // 网格
            ctx.strokeStyle = "#334155";
            ctx.lineWidth = 1;
            for (let x = 0; x < canvas.width; x += 32) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
            }
            for (let y = 0; y < canvas.height; y += 32) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
            }
        }

        // 已有区域
        layout.regions.forEach((region, idx) => {
            const color = regionColor(idx);
            const x0 = Math.min(region.startX, region.endX);
            const y0 = Math.min(region.startY, region.endY);
            const w = Math.abs(region.endX - region.startX);
            const h = Math.abs(region.endY - region.startY);
            const isSelected = region.id === selectedId;

            ctx.globalAlpha = 0.25;
            ctx.fillStyle = color;
            ctx.fillRect(x0, y0, w, h);
            ctx.globalAlpha = 1;

            ctx.strokeStyle = isSelected ? "#fff" : color;
            ctx.lineWidth = isSelected ? 2.5 : 1.5;
            ctx.setLineDash(isSelected ? [] : [4, 3]);
            ctx.strokeRect(x0, y0, w, h);
            ctx.setLineDash([]);

            // 标签背景
            const label = region.label || `区域 ${idx + 1}`;
            ctx.font = "bold 12px system-ui, sans-serif";
            const textW = ctx.measureText(label).width;
            ctx.fillStyle = color;
            ctx.fillRect(x0, y0, textW + 10, 20);
            ctx.fillStyle = "#fff";
            ctx.fillText(label, x0 + 5, y0 + 14);
        });

        // 正在绘制的临时框
        if (drawState.phase === "drawing") {
            const { startX, startY, curX, curY } = drawState;
            const x0 = Math.min(startX, curX);
            const y0 = Math.min(startY, curY);
            const w = Math.abs(curX - startX);
            const h = Math.abs(curY - startY);
            ctx.globalAlpha = 0.18;
            ctx.fillStyle = "#60a5fa";
            ctx.fillRect(x0, y0, w, h);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = "#60a5fa";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(x0, y0, w, h);
            ctx.setLineDash([]);
        }
    }, [layout, drawState, selectedId]);

    useEffect(() => { render(); }, [render]);

    // --- 指针事件 ---
    const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (drawState.phase === "labeling") return;

        // Ctrl + 左键拖拽 → 画框
        if (e.ctrlKey && e.button === 0) {
            e.preventDefault();
            canvas.setPointerCapture(e.pointerId);
            const { x, y } = canvasPoint(canvas, e.clientX, e.clientY);
            setDrawState({ phase: "drawing", startX: x, startY: y, curX: x, curY: y });
            return;
        }

        // 普通左键 → 选择区域
        if (e.button === 0) {
            const { x, y } = canvasPoint(canvas, e.clientX, e.clientY);
            const hit = [...layout.regions].reverse().find((r) => hitRegion(r, x, y));
            onSelect(hit?.id ?? null);
        }
    }, [drawState.phase, layout.regions, onSelect]);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas || drawState.phase !== "drawing") return;
        e.preventDefault();
        const { x, y } = canvasPoint(canvas, e.clientX, e.clientY);
        setDrawState((prev) => prev.phase === "drawing" ? { ...prev, curX: x, curY: y } : prev);
    }, [drawState.phase]);

    const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas || drawState.phase !== "drawing") return;
        canvas.releasePointerCapture(e.pointerId);
        const { startX, startY, curX, curY } = drawState;
        const w = Math.abs(curX - startX);
        const h = Math.abs(curY - startY);
        if (w < 10 || h < 10) { setDrawState({ phase: "idle" }); return; }
        // 转入标签输入阶段
        const newRegion: LayoutRegion = { id: nanoid(), label: "", prompt: "", startX, startY, endX: curX, endY: curY };
        setLabelInput("");
        setPromptInput("");
        setDrawState({ phase: "labeling", region: newRegion });
    }, [drawState]);

    const onContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        e.preventDefault();
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { x, y } = canvasPoint(canvas, e.clientX, e.clientY);
        const hit = [...layout.regions].reverse().find((r) => hitRegion(r, x, y));
        if (hit) {
            onChange({ ...layout, regions: layout.regions.filter((r) => r.id !== hit.id) });
            if (selectedId === hit.id) onSelect(null);
        }
    }, [layout, onChange, onSelect, selectedId]);

    const confirmLabel = useCallback(() => {
        if (drawState.phase !== "labeling") return;
        const region: LayoutRegion = { ...drawState.region, label: labelInput.trim() || `区域 ${layout.regions.length + 1}`, prompt: promptInput };
        onChange({ ...layout, regions: [...layout.regions, region] });
        onSelect(region.id);
        setDrawState({ phase: "idle" });
    }, [drawState, labelInput, promptInput, layout, onChange, onSelect]);

    const cancelLabel = useCallback(() => {
        setDrawState({ phase: "idle" });
    }, []);

    return (
        <div className="relative select-none" style={{ width: "100%", aspectRatio: `${layout.width} / ${layout.height}` }}>
            <canvas
                ref={canvasRef}
                width={layout.width}
                height={layout.height}
                className="w-full h-full rounded cursor-crosshair"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onContextMenu={onContextMenu}
            />
            {/* 标签输入浮层 */}
            {drawState.phase === "labeling" && (() => {
                const { region } = drawState;
                const canvas = canvasRef.current;
                const rect = canvas?.getBoundingClientRect();
                const scaleX = rect ? rect.width / layout.width : 1;
                const scaleY = rect ? rect.height / layout.height : 1;
                const x = Math.min(region.startX, region.endX) * scaleX;
                const y = (Math.max(region.startY, region.endY)) * scaleY + 8;
                return (
                    <div
                        className="absolute z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-xl p-3 flex flex-col gap-2 min-w-[240px]"
                        style={{ left: x, top: y }}
                        onMouseDown={(e) => e.stopPropagation()}
                    >
                        <Input
                            autoFocus
                            size="small"
                            placeholder="区域标签（如：沙发区）"
                            value={labelInput}
                            onChange={(e) => setLabelInput(e.target.value)}
                        />
                        <Input.TextArea
                            rows={3}
                            size="small"
                            placeholder="该区域的完整生图提示词…"
                            value={promptInput}
                            onChange={(e) => setPromptInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) confirmLabel(); }}
                        />
                        <div className="flex gap-2 justify-end">
                            <button className="px-3 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 text-slate-200" onClick={cancelLabel}>取消</button>
                            <button className="px-3 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white" onClick={confirmLabel}>确认（Ctrl+Enter）</button>
                        </div>
                    </div>
                );
            })()}
            {/* 操作提示 */}
            <div className="absolute bottom-2 right-2 text-xs text-slate-400 bg-slate-900/70 rounded px-2 py-1 pointer-events-none select-none">
                Ctrl+拖拽 画区域 · 左键 选区域 · 右键 删区域
            </div>
        </div>
    );
}
