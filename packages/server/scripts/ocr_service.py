#!/usr/bin/env python3
"""RapidOCR 本地识别服务（免费开源：PaddleOCR 模型 + ONNX 轻量推理）
用法: python ocr_service.py <图片路径>
输出: JSON {"texts": [...], "elapsed": 秒}
"""
import json
import sys
import time

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "缺少图片路径"}, ensure_ascii=False))
        sys.exit(1)

    img_path = sys.argv[1]
    try:
        from rapidocr_onnxruntime import RapidOCR
        engine = RapidOCR()
        t0 = time.time()
        result, elapse = engine(img_path)
        texts = [item[1] for item in result] if result else []
        # elapse 是分段耗时列表 [det, cls, rec]，取总和
        total = sum(elapse) if isinstance(elapse, (list, tuple)) else float(elapse or 0)
        out = {"texts": texts, "elapsed": round(total, 2)}
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()
