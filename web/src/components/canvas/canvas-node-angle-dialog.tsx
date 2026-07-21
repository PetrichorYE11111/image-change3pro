import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Modal, Segmented, Slider } from "antd";
import { RotateCcw, WandSparkles } from "lucide-react";

export type CanvasImageAngleParams = {
    horizontalAngle: number;
    pitchAngle: number;
    cameraDistance: number;
    wideAngle: boolean;
};

const defaultParams: CanvasImageAngleParams = {
    horizontalAngle: 0,
    pitchAngle: 9,
    cameraDistance: 4.8,
    wideAngle: false,
};

// 常用机位预设：水平 360°、俯仰全角度
const presets: Array<{ label: string; horizontalAngle: number; pitchAngle: number }> = [
    { label: "正面", horizontalAngle: 0, pitchAngle: 0 },
    { label: "左侧", horizontalAngle: -90, pitchAngle: 0 },
    { label: "右侧", horizontalAngle: 90, pitchAngle: 0 },
    { label: "背面", horizontalAngle: 180, pitchAngle: 0 },
    { label: "3/4 俯视", horizontalAngle: 35, pitchAngle: 35 },
    { label: "正俯视", horizontalAngle: 0, pitchAngle: 90 },
    { label: "正仰视", horizontalAngle: 0, pitchAngle: -90 },
];

export function CanvasNodeAngleDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (params: CanvasImageAngleParams) => void }) {
    const [params, setParams] = useState(defaultParams);

    useEffect(() => {
        if (open) setParams(defaultParams);
    }, [dataUrl, open]);

    const update = <Key extends keyof CanvasImageAngleParams>(key: Key, value: CanvasImageAngleParams[Key]) => setParams((current) => ({ ...current, [key]: value }));
    const patch = (next: Partial<CanvasImageAngleParams>) => setParams((current) => ({ ...current, ...next }));

    const activePreset = presets.find((preset) => preset.horizontalAngle === params.horizontalAngle && preset.pitchAngle === params.pitchAngle);

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={880} centered destroyOnHidden>
            <div className="space-y-5">
                <div>
                    <h2 className="text-xl font-semibold">AI 多角度</h2>
                    <p className="mt-1 text-sm opacity-60">拖动导轨上的相机或调节滑块设定机位，结果会基于原图重新生成</p>
                </div>
                <div className="grid gap-6 md:grid-cols-[minmax(300px,1fr)_360px]">
                    <div className="flex min-h-[340px] flex-col justify-between rounded-xl border p-4">
                        <CameraRig dataUrl={dataUrl} params={params} onChange={patch} />
                        <div className="mt-3 flex items-center justify-between gap-2">
                            <span className="text-xs opacity-55">拖动相机环绕主体 · 上下拖动改变俯仰</span>
                            <Button size="small" icon={<RotateCcw className="size-4" />} onClick={() => setParams(defaultParams)}>
                                重置
                            </Button>
                        </div>
                    </div>
                    <div className="space-y-5 py-1">
                        <div className="space-y-2">
                            <span className="text-sm font-medium opacity-75">快捷机位</span>
                            <div className="flex flex-wrap gap-1.5">
                                {presets.map((preset) => (
                                    <button
                                        key={preset.label}
                                        type="button"
                                        className={`rounded-md border px-2.5 py-1 text-xs transition ${activePreset?.label === preset.label ? "border-blue-500 bg-blue-500/12 font-medium text-blue-500" : "border-black/12 hover:border-blue-400 dark:border-white/15"}`}
                                        onClick={() => patch({ horizontalAngle: preset.horizontalAngle, pitchAngle: preset.pitchAngle })}
                                    >
                                        {preset.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <AngleSlider label="水平旋转" value={params.horizontalAngle} min={-180} max={180} step={1} suffix="°" onChange={(value) => update("horizontalAngle", value)} />
                        <AngleSlider label="俯仰角度" value={params.pitchAngle} min={-90} max={90} step={1} suffix="°" onChange={(value) => update("pitchAngle", value)} />
                        <AngleSlider label="镜头距离" value={params.cameraDistance} min={1} max={10} step={0.1} onChange={(value) => update("cameraDistance", value)} />
                        <div className="grid grid-cols-[88px_1fr_72px] items-center gap-4">
                            <span className="font-medium opacity-75">广角镜头</span>
                            <Segmented
                                className="w-fit"
                                value={params.wideAngle ? "wide" : "standard"}
                                options={[
                                    { label: "标准", value: "standard" },
                                    { label: "广角", value: "wide" },
                                ]}
                                onChange={(value) => update("wideAngle", value === "wide")}
                            />
                        </div>
                    </div>
                </div>
                <div className="flex justify-end">
                    <Button type="primary" size="large" icon={<WandSparkles className="size-4" />} onClick={() => onConfirm(params)}>
                        AI 生成
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

// 摄像头导轨：主体固定在中心，相机沿球面轨道运行；可拖拽调整水平/俯仰角。
function CameraRig({ dataUrl, params, onChange }: { dataUrl: string; params: CanvasImageAngleParams; onChange: (patch: Partial<CanvasImageAngleParams>) => void }) {
    const dragRef = useRef<{ startX: number; startY: number; yaw: number; pitch: number } | null>(null);
    const W = 340;
    const H = 260;
    const cx = W / 2;
    const cy = H / 2 + 6;
    const depthFlatten = 0.4; // 前后方向在屏幕上的压扁比例（透视俯视效果）
    const heightScale = 0.82; // 俯仰在屏幕上的纵向比例
    // 镜头距离影响轨道半径：越远轨道越大
    const radius = 44 + params.cameraDistance * 5.4;

    const project = (yaw: number, pitch: number, r = radius) => {
        const y = (yaw * Math.PI) / 180;
        const p = (pitch * Math.PI) / 180;
        const px = Math.sin(y) * Math.cos(p);
        const py = Math.sin(p);
        const pz = Math.cos(y) * Math.cos(p); // >0 朝向观察者（前方）
        return { x: cx + r * px, y: cy - r * py * heightScale + r * pz * depthFlatten, pz };
    };

    const cam = project(params.horizontalAngle, params.pitchAngle);
    const camBehind = cam.pz < 0;
    const camScale = 1 + cam.pz * 0.16;

    // 当前水平角下的俯仰子午线弧
    const meridian: string[] = [];
    for (let pp = -90; pp <= 90; pp += 6) {
        const pt = project(params.horizontalAngle, pp);
        meridian.push(`${pt.x.toFixed(1)},${pt.y.toFixed(1)}`);
    }

    // 方向标记锚点
    const front = project(0, 0);
    const back = project(180, 0);
    const left = project(-90, 0);
    const right = project(90, 0);

    const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { startX: event.clientX, startY: event.clientY, yaw: params.horizontalAngle, pitch: params.pitchAngle };
    };
    const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
        if (!dragRef.current) return;
        const dx = event.clientX - dragRef.current.startX;
        const dy = event.clientY - dragRef.current.startY;
        const yaw = clamp(Math.round(dragRef.current.yaw + dx * 0.7), -180, 180);
        const pitch = clamp(Math.round(dragRef.current.pitch - dy * 0.7), -90, 90);
        onChange({ horizontalAngle: yaw, pitchAngle: pitch });
    };
    const onPointerUp = () => {
        dragRef.current = null;
    };

    const subjectR = 26;
    const clipId = "camera-rig-subject-clip";
    const cameraGlyph = (
        <g transform={`translate(${cam.x} ${cam.y}) scale(${camScale.toFixed(3)})`} opacity={camBehind ? 0.45 : 1}>
            <circle r={11} fill="#2f80ff" stroke="#fff" strokeWidth={2} />
            <rect x={-4.5} y={-3.5} width={9} height={7} rx={1.5} fill="#fff" />
            <circle r={2.2} fill="#2f80ff" />
        </g>
    );

    return (
        <svg
            viewBox={`0 0 ${W} ${H}`}
            className="mx-auto h-auto w-full max-w-[360px] cursor-grab touch-none select-none active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
        >
            <defs>
                <clipPath id={clipId}>
                    <circle cx={cx} cy={cy} r={subjectR} />
                </clipPath>
            </defs>

            {/* 水平轨道（赤道环） */}
            <ellipse cx={cx} cy={cy} rx={radius} ry={radius * depthFlatten} fill="none" stroke="currentColor" strokeOpacity={0.22} strokeWidth={1.4} strokeDasharray="4 4" />
            {/* 当前俯仰子午线 */}
            <polyline points={meridian.join(" ")} fill="none" stroke="currentColor" strokeOpacity={0.16} strokeWidth={1.2} strokeDasharray="3 4" />

            {/* 方向标记 */}
            <text x={front.x} y={front.y + 14} textAnchor="middle" fontSize={11} fill="currentColor" opacity={0.5}>前</text>
            <text x={back.x} y={back.y - 7} textAnchor="middle" fontSize={11} fill="currentColor" opacity={0.5}>后</text>
            <text x={left.x - 12} y={left.y + 4} textAnchor="middle" fontSize={11} fill="currentColor" opacity={0.5}>左</text>
            <text x={right.x + 12} y={right.y + 4} textAnchor="middle" fontSize={11} fill="currentColor" opacity={0.5}>右</text>

            {/* 相机在主体后方时先画相机再画主体，让主体遮挡相机 */}
            {camBehind ? cameraGlyph : null}

            {/* 视线：主体 → 相机 */}
            <line x1={cx} y1={cy} x2={cam.x} y2={cam.y} stroke="#2f80ff" strokeOpacity={camBehind ? 0.3 : 0.6} strokeWidth={1.4} strokeDasharray="4 3" />

            {/* 主体（原图缩略） */}
            <circle cx={cx} cy={cy} r={subjectR + 2} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.5} />
            <image href={dataUrl} x={cx - subjectR} y={cy - subjectR} width={subjectR * 2} height={subjectR * 2} clipPath={`url(#${clipId})`} preserveAspectRatio="xMidYMid slice" />

            {camBehind ? null : cameraGlyph}
        </svg>
    );
}

function AngleSlider({ label, value, min, max, step, suffix = "", onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
    return (
        <div className="grid grid-cols-[88px_1fr_72px] items-center gap-4">
            <span className="font-medium opacity-75">{label}</span>
            <Slider min={min} max={max} step={step} value={value} onChange={onChange} />
            <span className="whitespace-nowrap text-right font-semibold">
                {Number.isInteger(value) ? value : value.toFixed(1)}
                {suffix}
            </span>
        </div>
    );
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}
