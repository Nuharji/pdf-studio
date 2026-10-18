# Tesseract OCR (bundled, offline)

Text recognition for scanned pages in PDF Studio ("Recognize Text (OCR)").

- `tesseract.min.js`, `worker.min.js` — tesseract.js 7.0.0 (Apache-2.0, see LICENSE-tesseract.js.md)
- `core/` — tesseract.js-core 7.0.0, WebAssembly build of Tesseract (Apache-2.0); SIMD build and a fallback without SIMD (chosen at runtime)
- `lang/` — trained data `deu`, `eng` (tessdata "best_int", from @tesseract.js-data 1.0.0; Apache-2.0 models by Google / the Tesseract project)

Nothing is downloaded at runtime; recognition runs on the computer.
