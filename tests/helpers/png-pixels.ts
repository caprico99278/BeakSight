// PNG（8 bit・RGB か RGBA・interlace なし。Chromium の写し）の画素を読む、テストの補助（依存を足さない。Node の zlib だけ）。
// AUD-3d: 画像の上の矩形が、要素の位置と合うかを確かめるために使う。
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** 読んだ画像（大きさと、画素の色を読む関数）。 */
export interface PngPixels {
  readonly width: number;
  readonly height: number;
  /** (x, y) の画素の色（範囲の外は `null`）。 */
  readonly rgbAt: (x: number, y: number) => readonly [number, number, number] | null;
}

/** PNG のファイルの、指定の色（RGB）の画素の数（通知の枠の色が画像に残っていないことの確かめなどに使う）。 */
export function countRgbPixels(file: string, rgb: readonly [number, number, number]): number {
  const image = readPngPixels(file);
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixel = image.rgbAt(x, y);
      if (pixel !== null && pixel[0] === rgb[0] && pixel[1] === rgb[1] && pixel[2] === rgb[2]) count += 1;
    }
  }
  return count;
}

/** PNG のファイルを読む（対応しない形なら例外）。 */
export function readPngPixels(file: string): PngPixels {
  const png = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('unsupported PNG');
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      if (channels === 0) throw new Error('unsupported PNG color type');
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] ?? 0;
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? pixels[row * stride + index - channels] ?? 0 : 0;
      const up = row > 0 ? pixels[(row - 1) * stride + index] ?? 0 : 0;
      const upLeft = row > 0 && index >= channels ? pixels[(row - 1) * stride + index - channels] ?? 0 : 0;
      const value = line[index] ?? 0;
      let decoded: number;
      switch (filter) {
        case 1: decoded = value + left; break;
        case 2: decoded = value + up; break;
        case 3: decoded = value + Math.floor((left + up) / 2); break;
        case 4: {
          const estimate = left + up - upLeft;
          const toLeft = Math.abs(estimate - left);
          const toUp = Math.abs(estimate - up);
          const toUpLeft = Math.abs(estimate - upLeft);
          decoded = value + (toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft);
          break;
        }
        default: decoded = value;
      }
      pixels[row * stride + index] = decoded & 0xff;
    }
  }
  return {
    width,
    height,
    rgbAt: (x, y) => {
      const column = Math.floor(x);
      const row = Math.floor(y);
      if (column < 0 || row < 0 || column >= width || row >= height) return null;
      const at = row * stride + column * channels;
      return [pixels[at] ?? 0, pixels[at + 1] ?? 0, pixels[at + 2] ?? 0];
    },
  };
}
