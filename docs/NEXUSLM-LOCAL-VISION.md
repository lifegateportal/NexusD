# NexusLM Local Vision

NexusLM can inspect image attachments without a vision API or separately hosted service.

## What happens locally

When an image is attached in General context:

1. The browser reads the image locally.
2. Canvas calculates dimensions, orientation, brightness, contrast, edge density, and dominant color.
3. Bundled English Tesseract.js OCR extracts visible printed text locally.
4. The resulting observation is sent to the existing text-only NexusLM chat route as reference context.
5. The original image remains available in the existing attachment preview.

The image is not uploaded to an OCR provider.

## Supported inputs

- PNG
- JPEG/JPG
- WebP
- GIF (the first frame is inspected)
- AVIF when the browser can decode it
- Text-based PDFs through the existing `pdf-parse` route

Scanned or image-only PDFs still need to be attached as page images for local OCR. The current PDF parser does not rasterize PDF pages.

## Installation behavior

`npm install` or `pnpm install` runs `scripts/prepare-tesseract-assets.mjs`. It copies the OCR worker, WebAssembly runtime, and English language data into the ignored `public/vendor/tesseract/` directory. Runtime OCR uses these local assets and does not contact a CDN.

## Limits

This feature is document and screenshot inspection, not general human-like image understanding. It is good for extracting text and reporting basic pixel/layout properties. It does not reliably identify arbitrary objects, infer emotion, or interpret artistic meaning.
