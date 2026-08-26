from PIL import Image, ImageDraw, ImageFilter
import os

SRC = "D:/xwechat_files/wxid_98zbakmmidg322_4d6b/temp/RWTemp/2026-08/9e20f478899dc29eb19741386f9343c8/6853bab7d3d3a41ac0537fddb803af0e.jpg"
OUT_DIR = "icons"
SIZES = [512, 192]

def make_icon(src_path, size):
    img = Image.open(src_path).convert("RGB")
    w, h = img.size

    # 以人物为中心裁剪一个正方形（人物在原图中偏右、偏上）
    # 中心点选在画面 55% 宽、42% 高处，裁剪框边长取 62%
    # 继续向右移动，彻底避开左侧文字/卡片，聚焦人物头肩
    center_x, center_y = w * 0.65, h * 0.45
    crop_size = min(w, h) * 0.54
    left = max(0, center_x - crop_size / 2)
    top = max(0, center_y - crop_size / 2)
    right = min(w, left + crop_size)
    bottom = min(h, top + crop_size)
    # 修正为正方形
    if right - left > bottom - top:
        right = left + (bottom - top)
    else:
        bottom = top + (right - left)

    cropped = img.crop((left, top, right, bottom))

    # 采样人物身后的暖橙色背景，让图标底色更协调鲜明
    edge = img.crop((w * 0.72, h * 0.32, w * 0.88, h * 0.48))
    bg_color = tuple(int(c) for c in edge.resize((1, 1)).getpixel((0, 0)))

    # 创建目标画布（圆角方形图标，留出 6% 边距给 iOS/Android 安全区域）
    canvas = Image.new("RGBA", (size, size), (*bg_color, 255))
    padding = int(size * 0.06)
    inner_size = size - padding * 2

    # 把裁剪图缩放并放入内圆
    cropped_resized = cropped.resize((inner_size, inner_size), Image.LANCZOS)

    # 创建圆形遮罩
    mask = Image.new("L", (inner_size, inner_size), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, inner_size, inner_size), fill=255)

    # 轻微羽化边缘，让圆形更自然
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(1, size // 256)))

    # 把人物图贴到画布中央
    icon = canvas.copy()
    icon.paste(cropped_resized, (padding, padding), mask)

    return icon

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in SIZES:
        icon = make_icon(SRC, s)
        out_path = os.path.join(OUT_DIR, f"icon-{s}.png")
        icon.save(out_path, "PNG")
        print(f"saved {out_path} ({s}x{s})")

if __name__ == "__main__":
    main()
