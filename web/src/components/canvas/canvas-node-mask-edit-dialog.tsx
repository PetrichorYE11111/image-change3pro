import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal, Slider, Tooltip } from "antd";
import { Brush, Eraser, ImagePlus, RotateCcw, WandSparkles, X } from "lucide-react";

import { readFileAsDataUrl, readImageMeta } from "@/lib/image-utils";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { ReferenceImage } from "@/types/image";

/** 用户在弹窗内直接上传的参考图 */
type UploadedRef = { id: string; name: string; dataUrl: string };

export type CanvasImageMaskEditPayload = {
    prompt: string;
    maskDataUrl: string;
    /** 用户通过 @ 选取的额外参考图，与涂抹区域一起发给 API */
    extraReferences?: ReferenceImage[];
};

type DrawMode = "paint" | "erase";

const defaultBrushSize = 100;
const maskFillColor = "rgba(37, 99, 235, .38)";
const maskBorderColor = "rgba(255, 255, 255, .72)";

export function CanvasNodeMaskEditDialog({
    dataUrl,
    open,
    availableReferences = [],
    onClose,
    onConfirm,
}: {
    dataUrl: string;
    open: boolean;
    availableReferences?: CanvasResourceReference[];
    onClose: () => void;
    onConfirm: (payload: CanvasImageMaskEditPayload) => void;
}) {
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<{ active: boolean; last: { x: number; y: number } | null }>({ active: false, last: null });
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [prompt, setPrompt] = useState("");
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [mode, setMode] = useState<DrawMode>("paint");
    const [error, setError] = useState("");
    const [selectedRefs, setSelectedRefs] = useState<CanvasResourceReference[]>([]);
    const [uploadedRefs, setUploadedRefs] = useState<UploadedRef[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        setPrompt("");
        setBrushSize(defaultBrushSize);
        setMode("paint");
        setError("");
        setSelectedRefs([]);
        setUploadedRefs([]);
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    useEffect(() => {
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
    }, [image]);

    const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const maskCanvas = maskCanvasRef.current;
        const context = maskCanvas?.getContext("2d");
        if (!maskCanvas || !context) return;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = brushSize;
        context.globalCompositeOperation = mode === "paint" ? "source-over" : "destination-out";
        context.strokeStyle = "#000";
        context.fillStyle = "#000";
        if (!drawingRef.current.last) {
            drawMaskStroke(context, point, point, brushSize);
        } else {
            drawMaskStroke(context, drawingRef.current.last, point, brushSize);
        }
        renderMaskPreview(maskCanvas, previewCanvasRef.current);
        drawingRef.current.last = point;
        if (mode === "paint") {
            setError("");
        }
    };

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = { active: true, last: null };
        if (maskCanvasRef.current) renderMaskPreview(maskCanvasRef.current, previewCanvasRef.current);
        draw(event);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current.active) return;
        event.preventDefault();
        draw(event);
    };

    const stopDraw = () => {
        drawingRef.current = { active: false, last: null };
        const maskCanvas = maskCanvasRef.current;
        if (maskCanvas) renderMaskPreview(maskCanvas, previewCanvasRef.current, canvasHasPaint(maskCanvas));
    };

    const resetMask = () => {
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
        setError("");
    };

    const submit = () => {
        const nextPrompt = prompt.trim();
        const canvas = maskCanvasRef.current;
        if (!nextPrompt) return setError("请输入修改要求");
        if (!canvas) return;
        if (!canvasHasPaint(canvas)) return setError("请先涂抹局部区域");
        // 已选画布/资产引用 + 弹窗内上传的图片，一起作为额外参考图
        const fromSelected: ReferenceImage[] = selectedRefs
            .filter((ref) => ref.previewUrl)
            .map((ref) => ({ id: ref.id, name: ref.title || ref.id, type: "image/png", dataUrl: ref.previewUrl!, storageKey: undefined }));
        const fromUploaded: ReferenceImage[] = uploadedRefs.map((ref) => ({ id: ref.id, name: ref.name, type: ref.dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png", dataUrl: ref.dataUrl, storageKey: undefined }));
        const extraReferences = [...fromSelected, ...fromUploaded];
        onConfirm({ prompt: nextPrompt, maskDataUrl: buildEditMask(canvas), extraReferences: extraReferences.length ? extraReferences : undefined });
    };

    const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith("image/"));
        event.target.value = ""; // 允许重复选同一文件
        if (!files.length) return;
        try {
            const uploaded = await Promise.all(
                files.map(async (file) => ({ id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: file.name, dataUrl: await readFileAsDataUrl(file) })),
            );
            setUploadedRefs((prev) => [...prev, ...uploaded]);
        } catch {
            setError("图片读取失败，请重试");
        }
    };

    const removeUploaded = (id: string) => {
        setUploadedRefs((prev) => prev.filter((ref) => ref.id !== id));
    };

    const toggleRef = (ref: CanvasResourceReference) => {
        setSelectedRefs((prev) => prev.some((r) => r.id === ref.id) ? prev.filter((r) => r.id !== ref.id) : [...prev, ref]);
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={980} centered destroyOnHidden>
            <div className="grid gap-5 lg:grid-cols-[minmax(360px,1fr)_320px]">
                <div className="flex min-h-[360px] items-center justify-center rounded-xl border border-black/10 bg-transparent p-0 dark:border-white/10">
                    <div className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img src={dataUrl} alt="" className="block max-h-[68vh] max-w-full bg-transparent" draggable={false} />
                        {image ? (
                            <>
                                <canvas ref={maskCanvasRef} width={image.width} height={image.height} className="hidden" />
                                <canvas
                                    ref={previewCanvasRef}
                                    width={image.width}
                                    height={image.height}
                                    className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                                    onPointerDown={startDraw}
                                    onPointerMove={moveDraw}
                                    onPointerUp={stopDraw}
                                    onPointerCancel={stopDraw}
                                />
                            </>
                        ) : null}
                    </div>
                </div>

                <div className="flex min-h-[360px] flex-col gap-5">
                    <div>
                        <h2 className="text-xl font-semibold">局部遮罩编辑</h2>
                        <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : "读取中"}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <Button type={mode === "paint" ? "primary" : "default"} icon={<Brush className="size-4" />} onClick={() => setMode("paint")}>
                            画笔
                        </Button>
                        <Button type={mode === "erase" ? "primary" : "default"} icon={<Eraser className="size-4" />} onClick={() => setMode("erase")}>
                            擦除
                        </Button>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">笔刷大小</span>
                            <span className="font-semibold">{brushSize}px</span>
                        </div>
                        <Slider min={8} max={160} step={2} value={brushSize} onChange={setBrushSize} />
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">修改要求</div>
                        <Input.TextArea
                            rows={4}
                            value={prompt}
                            status={error && !prompt.trim() ? "error" : undefined}
                            placeholder="例如：把选中区域改成金属材质，保持原图光影"
                            onChange={(event) => {
                                setPrompt(event.target.value);
                                setError("");
                            }}
                        />
                        {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center gap-1 text-sm font-medium opacity-75">
                            <span>参考图片</span>
                            <span className="ml-auto text-xs opacity-60">上传或选择，随涂抹区域一起发给模型</span>
                        </div>
                        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleUpload} />
                        <div className="flex flex-wrap gap-2">
                            <Tooltip title="上传本地图片作为参考图">
                                <button
                                    type="button"
                                    className="flex h-12 w-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-dashed border-black/20 text-black/50 transition hover:border-blue-400 hover:text-blue-500 dark:border-white/25 dark:text-white/50"
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <ImagePlus className="size-4" />
                                    <span className="text-[9px] leading-none">上传</span>
                                </button>
                            </Tooltip>

                            {uploadedRefs.map((ref) => (
                                <Tooltip key={ref.id} title={ref.name}>
                                    <div className="relative h-12 w-12 overflow-hidden rounded-md border-2 border-blue-500 ring-2 ring-blue-300">
                                        <img src={ref.dataUrl} alt={ref.name} className="h-full w-full object-cover" />
                                        <button
                                            type="button"
                                            className="absolute right-0 top-0 flex size-4 items-center justify-center rounded-bl bg-black/60 text-white"
                                            onClick={() => removeUploaded(ref.id)}
                                        >
                                            <X className="size-2.5" />
                                        </button>
                                    </div>
                                </Tooltip>
                            ))}

                            {availableReferences
                                .filter((r) => r.kind === "image" && r.previewUrl)
                                .map((ref) => {
                                    const isSelected = selectedRefs.some((r) => r.id === ref.id);
                                    return (
                                        <Tooltip key={ref.id} title={ref.title || ref.label}>
                                            <button
                                                type="button"
                                                className={`relative h-12 w-12 overflow-hidden rounded-md border-2 transition ${isSelected ? "border-blue-500 ring-2 ring-blue-300" : "border-transparent opacity-60 hover:opacity-100"}`}
                                                onClick={() => toggleRef(ref)}
                                            >
                                                <img src={ref.previewUrl} alt={ref.title} className="h-full w-full object-cover" />
                                                {isSelected && (
                                                    <div className="absolute inset-0 flex items-center justify-center bg-blue-500/20">
                                                        <div className="size-4 rounded-full bg-blue-500 text-white flex items-center justify-center text-[10px] font-bold">✓</div>
                                                    </div>
                                                )}
                                            </button>
                                        </Tooltip>
                                    );
                                })}
                        </div>
                        {selectedRefs.length + uploadedRefs.length > 0 && (
                            <div className="text-xs opacity-55">已选 {selectedRefs.length + uploadedRefs.length} 张参考图</div>
                        )}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <Button icon={<RotateCcw className="size-4" />} onClick={resetMask}>
                            重置
                        </Button>
                        <div className="flex items-center gap-2">
                            <Button icon={<X className="size-4" />} onClick={onClose}>
                                取消
                            </Button>
                            <Button type="primary" icon={<WandSparkles className="size-4" />} onClick={submit}>
                                AI 修改
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function readCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
        y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawMaskStroke(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, size: number) {
    if (from.x === to.x && from.y === to.y) {
        context.beginPath();
        context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
        context.fill();
        return;
    }
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
}

function canvasHasPaint(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) return true;
    }
    return false;
}

function renderMaskPreview(maskCanvas: HTMLCanvasElement, previewCanvas: HTMLCanvasElement | null, withBorder = false) {
    const context = previewCanvas?.getContext("2d");
    if (!previewCanvas || !context) return;
    context.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.fillStyle = maskFillColor;
    context.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(maskCanvas, 0, 0);
    context.globalCompositeOperation = "source-over";
    if (withBorder) drawDashedMaskBorder(context, maskCanvas);
}

function drawDashedMaskBorder(context: CanvasRenderingContext2D, maskCanvas: HTMLCanvasElement) {
    const maskContext = maskCanvas.getContext("2d");
    if (!maskContext) return;
    const { width, height } = maskCanvas;
    const data = maskContext.getImageData(0, 0, width, height).data;
    const step = Math.max(1, Math.round(Math.max(width, height) / 1200));
    const dash = step * 8;
    const gap = step * 5;
    const period = dash + gap;

    context.save();
    context.fillStyle = maskBorderColor;
    context.shadowColor = "rgba(0, 0, 0, .24)";
    context.shadowBlur = step * 1.5;
    for (let y = step; y < height - step; y += step) {
        for (let x = step; x < width - step; x += step) {
            const offset = (y * width + x) * 4 + 3;
            if (data[offset] === 0 || !isMaskEdge(data, width, x, y, step)) continue;
            if ((x + y) % period > dash) continue;
            context.fillRect(x - step / 2, y - step / 2, Math.max(1.5, step), Math.max(1.5, step));
        }
    }
    context.restore();
}

function isMaskEdge(data: Uint8ClampedArray, width: number, x: number, y: number, step: number) {
    return data[((y - step) * width + x) * 4 + 3] === 0 || data[((y + step) * width + x) * 4 + 3] === 0 || data[(y * width + x - step) * 4 + 3] === 0 || data[(y * width + x + step) * 4 + 3] === 0;
}

function buildEditMask(selectionCanvas: HTMLCanvasElement) {
    const canvas = document.createElement("canvas");
    canvas.width = selectionCanvas.width;
    canvas.height = selectionCanvas.height;
    const context = canvas.getContext("2d");
    if (!context) return selectionCanvas.toDataURL("image/png");
    const selectionContext = selectionCanvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!selectionContext) return canvas.toDataURL("image/png");
    const selection = selectionContext.getImageData(0, 0, canvas.width, canvas.height);
    const mask = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 3; index < mask.data.length; index += 4) {
        if (selection.data[index] > 0) mask.data[index] = 0;
    }
    context.putImageData(mask, 0, 0);
    return canvas.toDataURL("image/png");
}
