import { useEffect, useRef, useState } from "react";
import { Button, Modal, Slider, Switch } from "antd";
import { RotateCcw, WandSparkles } from "lucide-react";
import { CameraWidget, type CameraState } from "@/lib/camera-widget";

export type CanvasImageAngleParams = {
    azimuth: number;   // 0–360（0 = 正面）
    elevation: number; // -30 ~ 60（0 = 水平）
    distance: number;  // 0–10
    wideAngle: boolean;
};

const 默认参数: CanvasImageAngleParams = {
    azimuth: 0,
    elevation: 0,
    distance: 5,
    wideAngle: false,
};

const 预设机位 = [
    { 名称: "正面",     azimuth: 0,   elevation: 0   },
    { 名称: "右前方",   azimuth: 45,  elevation: 0   },
    { 名称: "右侧",     azimuth: 90,  elevation: 0   },
    { 名称: "右后方",   azimuth: 135, elevation: 0   },
    { 名称: "背面",     azimuth: 180, elevation: 0   },
    { 名称: "左侧",     azimuth: 270, elevation: 0   },
    { 名称: "四分之三俯视", azimuth: 45,  elevation: 35  },
    { 名称: "俯视",     azimuth: 0,   elevation: 60  },
    { 名称: "仰视",     azimuth: 0,   elevation: -20 },
];

// 角度 → 中文描述（用于提示词预览）
function 水平描述(azimuth: number): string {
    const h = ((azimuth % 360) + 360) % 360;
    if (h < 22.5 || h >= 337.5) return "正面视角";
    if (h < 67.5) return "右前方四分之三视角";
    if (h < 112.5) return "右侧视角";
    if (h < 157.5) return "右后方四分之三视角";
    if (h < 202.5) return "背面视角";
    if (h < 247.5) return "左后方四分之三视角";
    if (h < 292.5) return "左侧视角";
    return "左前方四分之三视角";
}

function 仰俯描述(elevation: number): string {
    if (elevation < -15) return "仰拍";
    if (elevation < 15) return "平视";
    if (elevation < 45) return "高角度";
    return "俯拍";
}

function 距离描述(distance: number): string {
    if (distance < 2) return "远景";
    if (distance < 6) return "中景";
    return "特写";
}

export function buildAnglePromptPreview(params: CanvasImageAngleParams): string {
    const parts = [水平描述(params.azimuth), 仰俯描述(params.elevation), 距离描述(params.distance)];
    if (params.wideAngle) parts.push("广角镜头");
    return parts.join("，");
}

export function CanvasNodeAngleDialog({
    dataUrl,
    open,
    onClose,
    onConfirm,
}: {
    dataUrl: string;
    open: boolean;
    onClose: () => void;
    onConfirm: (params: CanvasImageAngleParams) => void;
}) {
    const [params, setParams] = useState(默认参数);
    const [相机视角模式, 设相机视角] = useState(false);
    const widgetRef = useRef<CameraWidget | null>(null);

    useEffect(() => {
        if (open) {
            setParams(默认参数);
            设相机视角(false);
        }
    }, [dataUrl, open]);

    useEffect(() => {
        widgetRef.current?.setState({
            azimuth: params.azimuth,
            elevation: params.elevation,
            distance: params.distance,
        });
    }, [params.azimuth, params.elevation, params.distance]);

    useEffect(() => {
        widgetRef.current?.setCameraView(相机视角模式);
    }, [相机视角模式]);

    const 更新 = (next: Partial<CanvasImageAngleParams>) =>
        setParams((cur) => ({ ...cur, ...next }));

    const 当前预设 = 预设机位.find(
        (p) => p.azimuth === params.azimuth && p.elevation === params.elevation,
    );

    const 重置 = () => {
        setParams(默认参数);
        widgetRef.current?.resetToDefaults();
        设相机视角(false);
    };

    const 提示词预览 = buildAnglePromptPreview(params);

    return (
        <Modal
            title={null}
            open={open && Boolean(dataUrl)}
            onCancel={onClose}
            footer={null}
            width={1080}
            centered
            destroyOnHidden
        >
            <div className="space-y-4">
                {/* 标题栏 */}
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-semibold">AI 多角度</h2>
                        <p className="mt-0.5 text-sm opacity-50">
                            拖动场景手柄或调节滑块设定镜头位置，基于原图生成新视角
                        </p>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                        <span className="opacity-60">相机视角</span>
                        <Switch size="small" checked={相机视角模式} onChange={设相机视角} />
                    </div>
                </div>

                {/* 主体内容：3D 场景 + 控制面板 */}
                <div className="grid gap-5 md:grid-cols-[1fr_300px]">

                    {/* ── 左：3D 场景 ── */}
                    <div className="flex flex-col gap-2">
                        <div className="relative overflow-hidden rounded-xl border" style={{ height: 420 }}>
                            <ThreeJS场景
                                dataUrl={dataUrl}
                                initialState={{ azimuth: params.azimuth, elevation: params.elevation, distance: params.distance }}
                                onMount={(w) => { widgetRef.current = w; }}
                                onUnmount={() => { widgetRef.current = null; }}
                                onStateChange={(s) => 更新({ azimuth: s.azimuth, elevation: s.elevation, distance: s.distance })}
                            />
                        </div>
                        {/* 提示词预览条 */}
                        <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-sm">
                            <span className="shrink-0 text-xs font-medium opacity-50">机位提示词</span>
                            <span className="text-blue-400">{提示词预览}</span>
                        </div>
                    </div>

                    {/* ── 右：控制面板 ── */}
                    <div className="flex flex-col gap-5 py-1">

                        {/* 快捷机位 */}
                        <div>
                            <p className="mb-2 text-xs font-medium uppercase tracking-wide opacity-50">快捷机位</p>
                            <div className="grid grid-cols-3 gap-1.5">
                                {预设机位.map((p) => (
                                    <button
                                        key={p.名称}
                                        type="button"
                                        onClick={() => 更新({ azimuth: p.azimuth, elevation: p.elevation })}
                                        className={`rounded-md border px-1.5 py-1.5 text-center text-xs transition ${
                                            当前预设?.名称 === p.名称
                                                ? "border-blue-500 bg-blue-500/15 font-semibold text-blue-400"
                                                : "border-black/10 hover:border-blue-400/60 dark:border-white/10"
                                        }`}
                                    >
                                        {p.名称}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* 精确调节 */}
                        <div>
                            <p className="mb-3 text-xs font-medium uppercase tracking-wide opacity-50">精确调节</p>
                            <div className="space-y-4">
                                <精确滑块
                                    标签="水平方位"
                                    值={params.azimuth}
                                    最小={0}
                                    最大={360}
                                    步进={1}
                                    单位="°"
                                    颜色="#E93D82"
                                    onChange={(v) => 更新({ azimuth: v })}
                                />
                                <精确滑块
                                    标签="俯仰角度"
                                    值={params.elevation}
                                    最小={-30}
                                    最大={60}
                                    步进={1}
                                    单位="°"
                                    颜色="#00FFD0"
                                    onChange={(v) => 更新({ elevation: v })}
                                />
                                <精确滑块
                                    标签="镜头距离"
                                    值={params.distance}
                                    最小={0}
                                    最大={10}
                                    步进={0.1}
                                    颜色="#FFB800"
                                    onChange={(v) => 更新({ distance: v })}
                                />
                                <div className="flex items-center justify-between">
                                    <span className="text-sm opacity-70">广角镜头</span>
                                    <Switch
                                        checked={params.wideAngle}
                                        onChange={(v) => 更新({ wideAngle: v })}
                                        checkedChildren="开"
                                        unCheckedChildren="关"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* 操作按钮 */}
                        <div className="mt-auto flex flex-col gap-2 pt-2">
                            <Button
                                type="primary"
                                size="large"
                                icon={<WandSparkles className="size-4" />}
                                block
                                onClick={() => onConfirm(params)}
                            >
                                AI 生成
                            </Button>
                            <Button
                                size="small"
                                icon={<RotateCcw className="size-3.5" />}
                                block
                                onClick={重置}
                            >
                                重置
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

// ── Three.js 容器 ─────────────────────────────────────────────────────────
function ThreeJS场景({
    dataUrl,
    initialState,
    onMount,
    onUnmount,
    onStateChange,
}: {
    dataUrl: string;
    initialState: Partial<CameraState>;
    onMount: (w: CameraWidget) => void;
    onUnmount: () => void;
    onStateChange: (s: CameraState) => void;
}) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const widget = new CameraWidget({
            container: el,
            initialState: { ...initialState, imageUrl: dataUrl },
            onStateChange,
        });
        onMount(widget);
        return () => { widget.dispose(); onUnmount(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return <div ref={containerRef} className="absolute inset-0" />;
}

// ── 精确滑块 ──────────────────────────────────────────────────────────────
function 精确滑块({
    标签,
    值,
    最小,
    最大,
    步进,
    单位 = "",
    颜色,
    onChange,
}: {
    标签: string;
    值: number;
    最小: number;
    最大: number;
    步进: number;
    单位?: string;
    颜色?: string;
    onChange: (v: number) => void;
}) {
    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
                <span className="opacity-60">{标签}</span>
                <span className="font-semibold tabular-nums" style={颜色 ? { color: 颜色 } : undefined}>
                    {Number.isInteger(值) ? 值 : 值.toFixed(1)}{单位}
                </span>
            </div>
            <Slider
                min={最小}
                max={最大}
                step={步进}
                value={值}
                onChange={onChange}
                styles={{ track: 颜色 ? { background: 颜色 } : undefined }}
            />
        </div>
    );
}
