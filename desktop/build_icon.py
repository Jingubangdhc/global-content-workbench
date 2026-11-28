# -*- coding: utf-8 -*-
"""
使用 Python 标准库（零第三方依赖）生成 Global Content Workbench 独立多尺寸 Windows .ico 图标。
包含 256x256, 64x64, 32x32, 16x16 四档 PNG-in-ICO，支持 Windows 桌面快捷方式与任务栏高分屏清晰渲染。
"""
import math
import os
import struct
import zlib


def _make_png(width: int, height: int, rgba_bytes: bytes) -> bytes:
    """将 RGBA 原始像素编码为标准 PNG 字节流。"""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # Filter type 0 (None)
        raw.extend(rgba_bytes[y * stride:(y + 1) * stride])

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def _render_icon(size: int) -> bytes:
    """绘制深海青背景 + 麦田金极简地球与雷达焦点图标。"""
    buf = bytearray(size * size * 4)
    cx = (size - 1) / 2.0
    cy = (size - 1) / 2.0
    radius_card = size * 0.46
    corner_r = size * 0.16
    half_box = size * 0.44

    # 主题配色：深海青卡片底色 + 麦田金主环 + 暖白高光
    bg_top = (15, 31, 46)       # #0F1F2E
    bg_bot = (24, 52, 74)       # #18344A
    gold = (212, 162, 76)       # #D4A24C
    gold_hi = (246, 213, 134)   # #F6D586
    cyan = (62, 184, 178)       # #3EB8B2

    for y in range(size):
        for x in range(size):
            dx = abs(x - cx)
            dy = abs(y - cy)

            # 圆角矩形 SDF（抗锯齿）
            qx = max(dx - (half_box - corner_r), 0.0)
            qy = max(dy - (half_box - corner_r), 0.0)
            sdf_card = math.hypot(qx, qy) - corner_r
            alpha_card = max(0.0, min(1.0, 0.5 - sdf_card))

            idx = (y * size + x) * 4
            if alpha_card <= 0.001:
                buf[idx:idx + 4] = b"\x00\x00\x00\x00"
                continue

            t = y / max(1, size - 1)
            r = bg_top[0] * (1 - t) + bg_bot[0] * t
            g = bg_top[1] * (1 - t) + bg_bot[1] * t
            b = bg_top[2] * (1 - t) + bg_bot[2] * t

            # 细金色内描边
            border_dist = abs(sdf_card + size * 0.032)
            if border_dist < size * 0.018:
                w = max(0.0, 1.0 - border_dist / (size * 0.018)) * 0.55
                r = r * (1 - w) + gold[0] * w
                g = g * (1 - w) + gold[1] * w
                b = b * (1 - w) + gold[2] * w

            # 中心地球主环 + 经纬弧线 + 右下搜索放大镜手柄
            nx = (x - cx) / (size * 0.5)
            ny = (y - cy) / (size * 0.5)
            dist_c = math.hypot(nx + 0.05, ny + 0.05)

            # 主圆环 (半径 0.44)
            ring_w = 0.075
            d_ring = abs(dist_c - 0.44)
            if d_ring < ring_w:
                w = max(0.0, 1.0 - d_ring / ring_w)
                c = gold_hi if (nx + ny) < 0 else gold
                r = r * (1 - w) + c[0] * w
                g = g * (1 - w) + c[1] * w
                b = b * (1 - w) + c[2] * w

            # 内部纬线与经线（仅在主圆内）
            if dist_c < 0.41:
                d_lat = abs(ny + 0.05)
                d_mer = abs((nx + 0.05) / 0.48)
                d_ell = abs(math.hypot((nx + 0.05) / 0.48, (ny + 0.05)) - 0.42)
                line_w = 0.045
                w_line = 0.0
                if d_lat < line_w:
                    w_line = max(w_line, (1.0 - d_lat / line_w) * 0.72)
                if d_ell < line_w:
                    w_line = max(w_line, (1.0 - d_ell / line_w) * 0.72)
                if w_line > 0:
                    r = r * (1 - w_line) + cyan[0] * w_line
                    g = g * (1 - w_line) + cyan[1] * w_line
                    b = b * (1 - w_line) + cyan[2] * w_line

            # 中心聚焦亮点
            if dist_c < 0.13:
                w = max(0.0, 1.0 - dist_c / 0.13)
                r = r * (1 - w) + gold_hi[0] * w
                g = g * (1 - w) + gold_hi[1] * w
                b = b * (1 - w) + gold_hi[2] * w

            # 右下放大镜手柄 (45度线段)
            hx1, hy1 = 0.27, 0.27
            hx2, hy2 = 0.57, 0.57
            vx, vy = hx2 - hx1, hy2 - hy1
            seg_len2 = vx * vx + vy * vy
            proj = max(0.0, min(1.0, ((nx - hx1) * vx + (ny - hy1) * vy) / seg_len2))
            px, py = hx1 + proj * vx, hy1 + proj * vy
            d_handle = math.hypot(nx - px, ny - py)
            if d_handle < 0.075:
                w = max(0.0, 1.0 - d_handle / 0.075)
                r = r * (1 - w) + gold_hi[0] * w
                g = g * (1 - w) + gold_hi[1] * w
                b = b * (1 - w) + gold_hi[2] * w

            buf[idx] = int(max(0, min(255, round(r))))
            buf[idx + 1] = int(max(0, min(255, round(g))))
            buf[idx + 2] = int(max(0, min(255, round(b))))
            buf[idx + 3] = int(max(0, min(255, round(alpha_card * 255))))

    return _make_png(size, size, bytes(buf))


def build_ico(out_path: str) -> None:
    sizes = [256, 64, 32, 16]
    images = [(s, _render_icon(s)) for s in sizes]

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    header = struct.pack("<HHH", 0, 1, len(images))  # ICONDIR: reserved=0, type=1(ICO), count
    entries = bytearray()
    offset = 6 + 16 * len(images)

    for s, data in images:
        dim = 0 if s >= 256 else s
        entries.extend(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset))
        offset += len(data)

    with open(out_path, "wb") as f:
        f.write(header)
        f.write(entries)
        for _, data in images:
            f.write(data)
    print(f"ICO generated: {out_path} ({os.path.getsize(out_path)} bytes)")


if __name__ == "__main__":
    target = os.path.join(os.path.dirname(__file__), "assets", "gcw-icon.ico")
    build_ico(target)
