import { FileText, Group, Image as ImageIcon, LayoutGrid, Music2, Settings2, Video } from "lucide-react";

import i18n from "@/i18n";

import { NODE_SPECS } from "@/constant/canvas";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeDefinition, CanvasNodeResource } from "@/types/canvas-plugin";
import { LayoutEditorContent, LayoutEditorPanel } from "@/components/canvas/canvas-layout-editor-node";
import { EMPTY_LAYOUT_DATA } from "@/types/canvas-layout";

// Extensible metadata for built-in nodes, reusing NODE_SPECS for size and initial metadata.
// Rendering remains in canvas-node's internal renderer, so no Content component is provided.
function builtinResource(node: CanvasNodeData): CanvasNodeResource | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return { kind: "image", url: node.metadata.content };
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return { kind: "video", url: node.metadata.content };
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return { kind: "audio", url: node.metadata.content };
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return { kind: "text", text: node.metadata.content || node.metadata.prompt };
    return null;
}

const iconClass = "size-5";

const BUILTIN_DEFINITIONS: CanvasNodeDefinition[] = [
    { type: CanvasNodeType.Text, title: i18n.t("assets.kinds.text"), icon: <FileText className={iconClass} />, minimapColor: undefined, resource: builtinResource },
    { type: CanvasNodeType.Image, title: i18n.t("assets.kinds.image"), icon: <ImageIcon className={iconClass} />, minimapColor: "#10b981", keepAspectRatio: (node: CanvasNodeData) => !node.metadata?.freeResize, resource: builtinResource },
    { type: CanvasNodeType.Video, title: i18n.t("assets.kinds.video"), icon: <Video className={iconClass} />, minimapColor: "#f97316", keepAspectRatio: () => true, resource: builtinResource },
    { type: CanvasNodeType.Audio, title: i18n.t("assets.kinds.audio"), icon: <Music2 className={iconClass} />, minimapColor: "#a855f7", resource: builtinResource },
    { type: CanvasNodeType.Config, title: i18n.t("canvas.configNode.title"), icon: <Settings2 className={iconClass} />, minimapColor: "#60a5fa", hasSourceHandle: false },
    { type: CanvasNodeType.Group, title: i18n.t("canvas.node.group"), icon: <Group className={iconClass} />, minimapColor: "#94a3b8" },
].map((def) => {
    const spec = NODE_SPECS[def.type];
    return { ...def, title: spec.title, defaultSize: { width: spec.width, height: spec.height }, defaultMetadata: spec.metadata };
});

let registered = false;
export function registerBuiltinNodes() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions(BUILTIN_DEFINITIONS, "builtin");
}

// ---- 布局编辑器节点（独立注册，不走 NODE_SPECS .map()） ----
let layoutRegistered = false;
export function registerLayoutEditorNode() {
    if (layoutRegistered) return;
    layoutRegistered = true;
    const def: CanvasNodeDefinition = {
        type: "layout-editor",
        title: "布局编辑器",
        description: "分区域绘制布局，每区域独立填写提示词驱动生图；可外挂参考图",
        icon: <LayoutGrid className="size-5" />,
        defaultSize: { width: 480, height: 340 },
        defaultMetadata: {
            status: "idle",
            layoutData: JSON.stringify(EMPTY_LAYOUT_DATA),
        },
        minimapColor: "#f59e0b",
        autoOpenPanel: false,
        Content: LayoutEditorContent,
        Panel: LayoutEditorPanel,
        onDoubleClick: (ctx) => { ctx.openPanel(); return true; },
        resource: (node) =>
            node.metadata?.layoutData
                ? { kind: "text", text: node.metadata.layoutData }
                : null,
    };
    registerNodeDefinitions([def], "builtin");
}
