/**
 * Generate `test/fixtures/ocr.png`: a PNG containing the text `ARK-7391`.
 *
 *   node scripts/make-ocr-fixture.ts
 *
 * The vision check needs an image whose answer is unambiguous, and a checked-in
 * binary is easier to trust when it is reproducible. Hand-rolled PNG encoder so
 * the script has no dependencies (no canvas, no sharp) and runs on bare Node.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const TEXT = "ARK-7391";
const SCALE = 10;
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const TRACKING = 4;
const MARGIN = 12;

const FONT: Record<string, string[]> = {
	A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
	R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
	K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
	"-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
	"3": ["11111", "00001", "00001", "01110", "00001", "00001", "11111"],
	"7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
	"9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
	"1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
};

const width = MARGIN * 2 + TEXT.length * GLYPH_WIDTH * SCALE + (TEXT.length - 1) * TRACKING;
const height = MARGIN * 2 + GLYPH_HEIGHT * SCALE;

// White page, black glyphs: no antialiasing means the model either reads the
// glyph or does not, which is what makes this a usable assertion.
const pixels: number[][] = Array.from({ length: height }, () => Array<number>(width).fill(255));

for (const [index, character] of [...TEXT].entries()) {
	const glyph = FONT[character];
	if (!glyph) throw new Error(`no glyph for ${JSON.stringify(character)}`);
	const originX = MARGIN + index * (GLYPH_WIDTH * SCALE + TRACKING);
	for (const [row, line] of glyph.entries()) {
		for (const [column, bit] of [...line].entries()) {
			if (bit !== "1") continue;
			for (let dy = 0; dy < SCALE; dy += 1) {
				for (let dx = 0; dx < SCALE; dx += 1) {
					const x = originX + column * SCALE + dx;
					const y = MARGIN + row * SCALE + dy;
					if (x < width && y < height) pixels[y][x] = 0;
				}
			}
		}
	}
}

const raw = Buffer.concat(
	pixels.map(row => Buffer.concat([Buffer.from([0]), Buffer.from(row.flatMap(value => [value, value, value]))])),
);

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(height, 4);
header[8] = 8; // bit depth
header[9] = 2; // truecolour RGB
const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	chunk("IHDR", header),
	chunk("IDAT", deflateSync(raw, { level: 9 })),
	chunk("IEND", Buffer.alloc(0)),
]);

const target = new URL("../test/fixtures/ocr.png", import.meta.url);
writeFileSync(target, png);
console.log(`wrote ${width}x${height} ${TEXT} to ${target.pathname} (${png.length} bytes)`);
