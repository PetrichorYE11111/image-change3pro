"""
Layout Service — Nano Banana Pro (gemini-3-pro-image) per-region image generation.

Accepts a bbox region descriptor + optional reference images (base64),
calls the Google Gen AI SDK, returns the generated image as base64.
"""
from __future__ import annotations

import base64
import os
from io import BytesIO
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
MODEL_ID = os.getenv("LAYOUT_MODEL_ID", "gemini-3-pro-image")

# 支持两种凭据模式：
#   Vertex AI (企业版)：设置 GOOGLE_CLOUD_PROJECT + (可选) GOOGLE_CLOUD_LOCATION
#   标准 Gemini API ：设置 GOOGLE_API_KEY
GOOGLE_CLOUD_PROJECT = os.getenv("GOOGLE_CLOUD_PROJECT", "")
GOOGLE_CLOUD_LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "global")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")

if GOOGLE_CLOUD_PROJECT:
    client = genai.Client(
        enterprise=True,
        project=GOOGLE_CLOUD_PROJECT,
        location=GOOGLE_CLOUD_LOCATION,
    )
elif GOOGLE_API_KEY:
    client = genai.Client(api_key=GOOGLE_API_KEY)
else:
    client = None  # 延迟初始化，启动不崩溃

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class BBox(BaseModel):
    x: float        # 像素坐标（左上角）
    y: float
    w: float        # 宽高
    h: float
    nx: float       # 归一化 0-1
    ny: float
    nw: float
    nh: float

class RegionRequest(BaseModel):
    label: str
    prompt: str
    bbox: BBox
    canvas_width: int
    canvas_height: int
    # 参考图：base64 字符串列表，格式 "data:<mime>;base64,<data>" 或纯 base64
    reference_images: list[str] = []
    # 图像尺寸：1K / 2K / 4K，对应 notebook 里的 image_size 参数
    image_size: str = "1K"
    aspect_ratio: str = "1:1"

class RegionResponse(BaseModel):
    image_base64: str   # 纯 base64，无 data: 前缀
    mime_type: str
    thought: Optional[str] = None   # 模型思考过程（如果有）

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Layout Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_ID}


@app.post("/generate-region", response_model=RegionResponse)
async def generate_region(req: RegionRequest):
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="No Google credentials configured. Set GOOGLE_CLOUD_PROJECT or GOOGLE_API_KEY.",
        )

    # ---- 构建提示词（对小模型优化的指令遵循格式）----
    prompt_text = _build_region_prompt(req)

    # ---- 构建 contents ----
    parts: list = []

    # 1. 先放参考图（与 notebook cell-37 的顺序一致：图 → 文字）
    for ref in req.reference_images:
        raw, mime = _decode_image(ref)
        parts.append(types.Part.from_bytes(data=raw, mime_type=mime))

    # 2. 最后放文字提示词
    parts.append(prompt_text)

    try:
        response = client.models.generate_content(
            model=MODEL_ID,
            contents=parts,
            config=types.GenerateContentConfig(
                response_modalities=["IMAGE", "TEXT"],
                image_config=types.ImageConfig(
                    aspect_ratio=req.aspect_ratio,
                    image_size=req.image_size,
                ),
            ),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    # ---- 检查 finish_reason ----
    candidate = response.candidates[0]
    if candidate.finish_reason not in (
        types.FinishReason.STOP,
        types.FinishReason.MAX_TOKENS,
    ):
        raise HTTPException(
            status_code=422,
            detail=f"Generation blocked: {candidate.finish_reason}",
        )

    # ---- 提取图像 ----
    image_b64 = ""
    mime_type = "image/png"
    thought_text = ""

    for part in candidate.content.parts:
        if getattr(part, "thought", False):
            if getattr(part, "text", None):
                thought_text = part.text
            continue
        if part.inline_data:
            raw_bytes = part.inline_data.data
            mime_type = part.inline_data.mime_type or "image/png"
            image_b64 = base64.b64encode(raw_bytes).decode()
            break

    if not image_b64:
        raise HTTPException(status_code=500, detail="Model returned no image.")

    return RegionResponse(
        image_base64=image_b64,
        mime_type=mime_type,
        thought=thought_text or None,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _build_region_prompt(req: RegionRequest) -> str:
    """
    结构化提示词，对指令遵循性弱的模型（Nano Banana）更友好：
    明确的 JSON 结构 + 简短的任务指令，避免歧义。
    """
    b = req.bbox
    ref_note = (
        f"Use the {len(req.reference_images)} reference image(s) provided as the visual source."
        if req.reference_images
        else "No reference images provided; generate from the text description only."
    )

    return f"""You are a layout-aware image generator.

TASK: Generate the visual content for ONE rectangular region in a larger canvas.

REGION:
{{
  "label": "{req.label}",
  "prompt": "{req.prompt}",
  "bbox_pixels": {{"x": {b.x:.0f}, "y": {b.y:.0f}, "w": {b.w:.0f}, "h": {b.h:.0f}}},
  "bbox_normalized": {{"x": {b.nx:.3f}, "y": {b.ny:.3f}, "w": {b.nw:.3f}, "h": {b.nh:.3f}}},
  "canvas_size": {{"width": {req.canvas_width}, "height": {req.canvas_height}}}
}}

REFERENCE IMAGES: {ref_note}

INSTRUCTIONS:
1. Generate a single image that exactly matches the region label and prompt above.
2. The output image will be placed at the bbox position in the final canvas layout.
3. Match the visual style and perspective implied by the region's position and size.
4. Output ONLY the image. Do not add text overlays unless the prompt requests them.
"""


def _decode_image(ref: str) -> tuple[bytes, str]:
    """支持 data URI 和纯 base64 两种格式。"""
    if ref.startswith("data:"):
        header, data = ref.split(",", 1)
        mime = header.split(":")[1].split(";")[0]
        return base64.b64decode(data), mime
    # 纯 base64，默认 PNG
    return base64.b64decode(ref), "image/png"
