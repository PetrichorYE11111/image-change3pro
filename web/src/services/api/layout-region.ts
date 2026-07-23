/**
 * Layout Region 工具函数
 * 生成调用走 ctx.ai.generateImage（复用现有 CORS proxy + API key 配置），不另起服务。
 */
import type { LayoutData, LayoutRegion } from "@/types/canvas-layout";

/** LayoutRegion 坐标转 xywh + 归一化 */
export function regionToBbox(region: LayoutRegion, canvasW: number, canvasH: number) {
    const x = Math.min(region.startX, region.endX);
    const y = Math.min(region.startY, region.endY);
    const w = Math.abs(region.endX - region.startX);
    const h = Math.abs(region.endY - region.startY);
    return {
        x, y, w, h,
        nx: +(x / canvasW).toFixed(3),
        ny: +(y / canvasH).toFixed(3),
        nw: +(w / canvasW).toFixed(3),
        nh: +(h / canvasH).toFixed(3),
    };
}

/**
 * 为 Nano Banana Pro / gemini-3-pro-image 构建结构化提示词。
 * 明确的 JSON 区域描述 → 提升小模型指令遵循性。
 */
export function buildRegionPrompt(region: LayoutRegion, layout: LayoutData, referenceCount: number): string {
    const b = regionToBbox(region, layout.width, layout.height);
    const refNote = referenceCount > 0
        ? `Reference images provided: ${referenceCount}. Use them as the visual source for style/content.`
        : "No reference images. Generate from text description only.";

    return `You are a layout-aware image generator. Generate the visual content for ONE rectangular region.

REGION:
{
  "label": "${region.label}",
  "prompt": "${region.prompt.replace(/"/g, '\\"')}",
  "bbox_pixels": {"x": ${Math.round(b.x)}, "y": ${Math.round(b.y)}, "w": ${Math.round(b.w)}, "h": ${Math.round(b.h)}},
  "bbox_normalized": {"x": ${b.nx}, "y": ${b.ny}, "w": ${b.nw}, "h": ${b.nh}},
  "canvas_size": {"width": ${layout.width}, "height": ${layout.height}}
}

${refNote}

RULES:
1. Generate exactly one image matching the label and prompt.
2. The image will be placed at the bbox position in the final layout.
3. Match perspective and scale implied by the region size.
4. Output ONLY the image.`;
}

/**
 * 导出选中区域的标准 JSON（小模型友好格式，可直接发给第三方 API）。
 */
export function exportLayoutJson(layout: LayoutData, selectedIds?: Set<string>): string {
    const regions = selectedIds?.size
        ? layout.regions.filter((r) => selectedIds.has(r.id))
        : layout.regions;

    return JSON.stringify({
        canvas_size: { width: layout.width, height: layout.height },
        regions: regions.map((r, idx) => {
            const b = regionToBbox(r, layout.width, layout.height);
            return {
                index: idx,
                label: r.label || `region_${idx}`,
                prompt: r.prompt,
                bbox_pixels: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) },
                bbox_normalized: { x: b.nx, y: b.ny, w: b.nw, h: b.nh },
                reference_node_ids: r.referenceNodeIds ?? [],
            };
        }),
    }, null, 2);
}
