import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * RGBA バッファ (Uint8ClampedArray) を PNG (8bit RGBA) にエンコードする。
 */
export function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 単純なソフトウェアラスタライザ (スーパーサンプリングで輪郭を滑らかにする)。 */
export class Raster {
  constructor(width, height, scale = 4) {
    this.w = width;
    this.h = height;
    this.s = scale;
    this.buf = new Uint8ClampedArray(width * scale * height * scale * 4);
  }

  fillAll(color) {
    const [r, g, b, a = 255] = color;
    for (let i = 0; i < this.buf.length; i += 4) {
      this.buf[i] = r;
      this.buf[i + 1] = g;
      this.buf[i + 2] = b;
      this.buf[i + 3] = a;
    }
  }

  /** 多角形 (頂点配列 [[x,y], ...]、論理座標) を塗る。 */
  fillPolygon(points, color) {
    const s = this.s;
    const W = this.w * s;
    const H = this.h * s;
    const pts = points.map(([x, y]) => [x * s, y * s]);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of pts) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(H - 1, Math.ceil(maxY));
    const [r, g, b, a = 255] = color;
    const alpha = a / 255;
    for (let y = y0; y <= y1; y += 1) {
      const cy = y + 0.5;
      const xs = [];
      for (let i = 0; i < pts.length; i += 1) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        if (ay === by) continue;
        if (cy >= Math.min(ay, by) && cy < Math.max(ay, by)) {
          xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const sx = Math.max(0, Math.round(xs[i]));
        const ex = Math.min(W - 1, Math.round(xs[i + 1]) - 1);
        for (let x = sx; x <= ex; x += 1) {
          const o = (y * W + x) * 4;
          this.buf[o] = this.buf[o] * (1 - alpha) + r * alpha;
          this.buf[o + 1] = this.buf[o + 1] * (1 - alpha) + g * alpha;
          this.buf[o + 2] = this.buf[o + 2] * (1 - alpha) + b * alpha;
          this.buf[o + 3] = Math.max(this.buf[o + 3], a);
        }
      }
    }
  }

  fillRoundRect(x, y, w, h, radius, color) {
    const pts = [];
    const seg = 10;
    const corners = [
      [x + w - radius, y + radius, -Math.PI / 2, 0],
      [x + w - radius, y + h - radius, 0, Math.PI / 2],
      [x + radius, y + h - radius, Math.PI / 2, Math.PI],
      [x + radius, y + radius, Math.PI, (Math.PI * 3) / 2],
    ];
    for (const [cx, cy, a0, a1] of corners) {
      for (let i = 0; i <= seg; i += 1) {
        const t = a0 + ((a1 - a0) * i) / seg;
        pts.push([cx + Math.cos(t) * radius, cy + Math.sin(t) * radius]);
      }
    }
    this.fillPolygon(pts, color);
  }

  fillRect(x, y, w, h, color) {
    this.fillPolygon(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      color,
    );
  }

  /** スーパーサンプリングを解除して RGBA バッファを取り出す。 */
  resolve() {
    const s = this.s;
    const out = new Uint8ClampedArray(this.w * this.h * 4);
    const W = this.w * s;
    const n = s * s;
    for (let y = 0; y < this.h; y += 1) {
      for (let x = 0; x < this.w; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let dy = 0; dy < s; dy += 1) {
          for (let dx = 0; dx < s; dx += 1) {
            const o = ((y * s + dy) * W + x * s + dx) * 4;
            r += this.buf[o];
            g += this.buf[o + 1];
            b += this.buf[o + 2];
            a += this.buf[o + 3];
          }
        }
        const o = (y * this.w + x) * 4;
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
        out[o + 3] = a / n;
      }
    }
    return out;
  }
}

/** RGBA バッファをバイリニア補間で拡大縮小する。 */
export function resample(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, (y * sh) / dh);
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, (x * sw) / dw);
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const p00 = src[(y0 * sw + x0) * 4 + c];
        const p10 = src[(y0 * sw + x1) * 4 + c];
        const p01 = src[(y1 * sw + x0) * 4 + c];
        const p11 = src[(y1 * sw + x1) * 4 + c];
        out[o + c] =
          p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
      }
    }
  }
  return out;
}
