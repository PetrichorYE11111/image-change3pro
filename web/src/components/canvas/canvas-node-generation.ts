import type { AiTextMessage } from "@/services/api/image";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { getGenerationResourceNodes } from "@/lib/canvas/canvas-resource-references";
import type { Asset, ImageAsset, TextAsset, VideoAsset } from "@/stores/use-asset-store";

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

export type NodeGenerationInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
};

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string, extraInputs?: NodeGenerationInput[]): NodeGenerationContext {
    const canvasInputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    const assetInputs = extraInputs ?? [];
    const sourceNode = nodes.find((node) => node.id === nodeId);
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
        return buildComposerGenerationContext([...canvasInputs, ...assetInputs], prompt);
    }

    // 普通节点：画布连线输入全部保留；资产库输入仅保留提示词中被 @ 引用的，
    // 避免把未提及的资产也发给 API。
    const filteredAssetInputs = filterAssetInputsByMentions(canvasInputs, assetInputs, prompt);
    const inputs = [...canvasInputs, ...filteredAssetInputs];

    const upstreamText = inputs
        .map((input) => input.text)
        .filter(Boolean)
        .join("\n\n");
    const referenceImages = inputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = inputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = inputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    return {
        prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

/**
 * 根据提示词中出现的引用标签（如"图片1"、"视频2"）过滤资产输入。
 * 画布连线输入始终保留；资产库输入仅保留在提示词中被 @ 提及的。
 * 若提示词中不含任何引用标签，回退为保留全部资产（兼容旧行为）。
 */
function filterAssetInputsByMentions(canvasInputs: NodeGenerationInput[], assetInputs: NodeGenerationInput[], prompt: string): NodeGenerationInput[] {
    if (!assetInputs.length) return assetInputs;
    // 按合并顺序（画布输入在前，资产输入在后）为每条输入分配标签，编号与 UI 侧一致
    const counts: Record<NodeGenerationInput["type"], number> = { image: 0, video: 0, audio: 0, text: 0 };
    const labeled = [...canvasInputs, ...assetInputs].map((input) => ({
        input,
        label: generationLabel(input.type, counts[input.type]++),
    }));
    // 取出所有可能的引用标签，检查哪些出现在提示词里
    const mentionedLabels = new Set(labeled.map(({ label }) => label).filter((label) => prompt.includes(label)));
    if (!mentionedLabels.size) return assetInputs; // 无标签时保持原有全量行为
    // 只保留被提及的资产输入（画布连线输入由调用方始终保留，此处不重复过滤）
    const canvasNodeIds = new Set(canvasInputs.map((i) => i.nodeId));
    return labeled
        .filter(({ input, label }) => !canvasNodeIds.has(input.nodeId) && mentionedLabels.has(label))
        .map(({ input }) => input);
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string): NodeGenerationContext {
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const selectedInputs: NodeGenerationInput[] = [];
    const labelByNodeId = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = inputByNodeId.get(match[1]);
        if (input) {
            let label = labelByNodeId.get(input.nodeId);
            if (!label) {
                label = generationLabel(input.type, counts[input.type]++);
                labelByNodeId.set(input.nodeId, label);
                if (input.type === "text") textBlocks.push(`【${label}】\n${input.text || ""}`);
                else selectedInputs.push(input);
            }
            nextPrompt += input.type === "text" ? `【${label}】` : label;
        }
        lastIndex = match.index + match[0].length;
    }

    nextPrompt += prompt.slice(lastIndex);
    if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
    const referenceImages = selectedInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = selectedInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = selectedInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    if (!hasToken) {
        return {
            prompt,
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
    }

    return {
        prompt: nextPrompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: counts.text,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    return getGenerationResourceNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
        const image = readReferenceImage(node);
        if (image) return [{ nodeId: node.id, type: "image" as const, title: node.title, image }];
        const video = readReferenceVideo(node);
        if (video) return [{ nodeId: node.id, type: "video" as const, title: node.title, video }];
        const audio = readReferenceAudio(node);
        if (audio) return [{ nodeId: node.id, type: "audio" as const, title: node.title, audio }];
        const text = readNodeTextInput(node);
        if (text) return [{ nodeId: node.id, type: "text" as const, title: node.title, text }];
        return [];
    });
}

/** 将资产库中的资产转换为生成输入，供 buildNodeGenerationContext 的 extraInputs 使用。 */
export function buildAssetGenerationInputs(assets: Asset[]): NodeGenerationInput[] {
    return assets.flatMap((asset): NodeGenerationInput[] => {
        if (asset.kind === "image") {
            const a = asset as ImageAsset;
            const dataUrl = a.data.dataUrl || a.coverUrl;
            if (!dataUrl) return [];
            const image: ReferenceImage = { id: a.id, name: a.title || a.id, type: a.data.mimeType || "image/png", dataUrl, storageKey: a.data.storageKey };
            return [{ nodeId: a.id, type: "image" as const, title: a.title, image }];
        }
        if (asset.kind === "video") {
            const a = asset as VideoAsset;
            const url = a.data.url;
            if (!url) return [];
            const video: ReferenceVideo = { id: a.id, name: a.title || a.id, type: a.data.mimeType || "video/mp4", url, storageKey: a.data.storageKey };
            return [{ nodeId: a.id, type: "video" as const, title: a.title, video }];
        }
        if (asset.kind === "text") {
            const a = asset as TextAsset;
            if (!a.data.content) return [];
            return [{ nodeId: a.id, type: "text" as const, title: a.title, text: a.data.content }];
        }
        return [];
    });
}

export function buildNodeResponseMessages(context: NodeGenerationContext): AiTextMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))) };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function generationLabel(type: NodeGenerationInput["type"], index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return seedanceReferenceLabel("video", index);
    if (type === "audio") return seedanceReferenceLabel("audio", index);
    return `文本${index + 1}`;
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.png`,
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
    };
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp4`,
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: node.metadata.durationMs,
    };
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp3`,
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        durationMs: node.metadata.durationMs,
    };
}
