// qr-generator.ts — QR code generator returning data URLs
// Uses the `qrcode` npm package for encoding.

import QRCode from "qrcode";

/**
 * Generate a QR code as a PNG data URL (data:image/png;base64,...).
 * @param text - The text to encode in the QR code
 * @param size - Width/height in pixels (default 256)
 * @returns PNG data URL string
 */
export async function generateQR(
  text: string,
  size: number = 256,
): Promise<string> {
  return QRCode.toDataURL(text, {
    width: size,
    margin: 2,
    color: {
      dark: "#ffffff",
      light: "#000000",
    },
  });
}
