// 布局编辑器节点的数据结构，序列化为 JSON 字符串存于 CanvasNodeMetadata.layoutData

export type LayoutRegion = {
    id: string;
    label: string;    // 区域显示标签（如"沙发区"）
    prompt: string;   // 驱动生图的完整提示词
    startX: number;   // 以布局画布像素为单位
    startY: number;
    endX: number;
    endY: number;
    referenceNodeIds?: string[];  // 该区域独立的参考图节点 ID（@ 引用）
};

export type LayoutPoint = {
    id: string;
    label: string;
    x: number;
    y: number;
    polarity: "positive" | "negative";
};

export type LayoutData = {
    width: number;    // 布局画布尺寸（不随节点缩放）
    height: number;
    regions: LayoutRegion[];
    points?: LayoutPoint[];
};

export const EMPTY_LAYOUT_DATA: LayoutData = {
    width: 512,
    height: 384,
    regions: [],
    points: [],
};
