// 條碼解碼器（ADR 0013）：瀏覽器有支援 EAN 的 BarcodeDetector（例如 Android Chrome）就用它；
// 否則（iPhone Safari 沒有 BarcodeDetector）用 zxing-wasm。.wasm 由 Vite 打包到 dist/assets，從同源載入，不用預設的 CDN。
// 這個檔案由 App 以動態 import 載入，WASM 不進主程式。
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

const ZXING_FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE'];
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

// 回傳 decode(canvas) → 條碼文字（沒讀到為 ''）。WASM 在這裡就開始載入，CSP 或網路問題會在開相機時就出現。
export async function createDecoder() {
  try {
    const supported = await globalThis.BarcodeDetector?.getSupportedFormats?.();
    const formats = NATIVE_FORMATS.filter(f => supported?.includes(f));
    if (formats.length) {
      const detector = new globalThis.BarcodeDetector({ formats });
      return async canvas => (await detector.detect(canvas))[0]?.rawValue || '';
    }
  } catch {} // 原生偵測失敗就改用 WASM
  await prepareZXingModule({ overrides: { locateFile: (path, prefix) => path.endsWith('.wasm') ? wasmUrl : prefix + path }, fireImmediately: true });
  return async canvas => {
    const image = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    return (await readBarcodes(image, { formats: ZXING_FORMATS, tryHarder: true, maxNumberOfSymbols: 1 }))[0]?.text || '';
  };
}
