export function attemptId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function writeUInt32BE(buffer: Buffer, value: number, offset: number): void {
  buffer.writeUInt32BE(value >>> 0, offset);
}

function writeUInt32LE(buffer: Buffer, value: number, offset: number): void {
  buffer.writeUInt32LE(value >>> 0, offset);
}

export function pngBytes(width = 32, height = 32): Buffer {
  const buffer = Buffer.alloc(8 + 25 + 12);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
    buffer,
    0,
  );
  writeUInt32BE(buffer, 13, 8);
  buffer.write("IHDR", 12, "ascii");
  writeUInt32BE(buffer, width, 16);
  writeUInt32BE(buffer, height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  writeUInt32BE(buffer, 0, 33);
  buffer.write("IEND", 37, "ascii");
  return buffer;
}

export function jpegBytes(width = 32, height = 32): Buffer {
  const payload = Buffer.alloc(15);
  payload[0] = 8;
  payload.writeUInt16BE(height, 1);
  payload.writeUInt16BE(width, 3);
  payload[5] = 3;
  payload.set([0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 6);

  const buffer = Buffer.alloc(2 + 2 + 2 + payload.length + 2);
  let offset = 0;
  buffer.set([0xff, 0xd8, 0xff, 0xc0], offset);
  offset += 4;
  buffer.writeUInt16BE(payload.length + 2, offset);
  offset += 2;
  payload.copy(buffer, offset);
  offset += payload.length;
  buffer.set([0xff, 0xd9], offset);
  return buffer;
}

export function webpVp8lBytes(width = 32, height = 32): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  const bits = ((height - 1) << 14) | (width - 1);
  writeUInt32LE(payload, bits, 1);

  const buffer = Buffer.alloc(20 + payload.length);
  buffer.write("RIFF", 0, "ascii");
  writeUInt32LE(buffer, 4 + 4 + 4 + payload.length, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8L", 12, "ascii");
  writeUInt32LE(buffer, payload.length, 16);
  payload.copy(buffer, 20);
  return buffer;
}

export function webpVp8xBytes(width = 32, height = 32): Buffer {
  const payload = Buffer.alloc(10);
  const widthBits = width - 1;
  const heightBits = height - 1;
  payload[4] = widthBits & 0xff;
  payload[5] = (widthBits >> 8) & 0xff;
  payload[6] = (widthBits >> 16) & 0xff;
  payload[7] = heightBits & 0xff;
  payload[8] = (heightBits >> 8) & 0xff;
  payload[9] = (heightBits >> 16) & 0xff;

  const buffer = Buffer.alloc(20 + payload.length);
  buffer.write("RIFF", 0, "ascii");
  writeUInt32LE(buffer, 4 + 4 + 4 + payload.length, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  writeUInt32LE(buffer, payload.length, 16);
  payload.copy(buffer, 20);
  return buffer;
}

export function webpVp8Bytes(width = 32, height = 32): Buffer {
  const payload = Buffer.alloc(10);
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width & 0x3fff, 6);
  payload.writeUInt16LE(height & 0x3fff, 8);

  const buffer = Buffer.alloc(20 + payload.length);
  buffer.write("RIFF", 0, "ascii");
  writeUInt32LE(buffer, 4 + 4 + 4 + payload.length, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8 ", 12, "ascii");
  writeUInt32LE(buffer, payload.length, 16);
  payload.copy(buffer, 20);
  return buffer;
}

export const svgBytes = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"></svg>',
  "utf8",
);
