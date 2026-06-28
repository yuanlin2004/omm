// Render the mindmap SVG to PNG or PDF bytes. Builds a standalone, content-sized SVG
// (independent of the on-screen pan/zoom) and rasterizes it via a canvas. Returns an
// ArrayBuffer so the caller can save it into the vault, which works on desktop and mobile.

import { jsPDF } from "jspdf";

const MARGIN = 20;
const PNG_SCALE = 2; // render at 2x for crisp output

interface ExportImage {
  dataUrl: string;
  width: number;
  height: number;
}

/** Clone the live SVG into a standalone, content-sized SVG string. */
function buildStandaloneSVG(live: SVGSVGElement): { svg: string; width: number; height: number } {
  const viewport = live.querySelector<SVGGElement>(".omm-viewport");
  if (!viewport) throw new Error("nothing to export");
  const bbox = viewport.getBBox();
  const width = Math.ceil(bbox.width + MARGIN * 2);
  const height = Math.ceil(bbox.height + MARGIN * 2);

  const clone = live.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `${bbox.x - MARGIN} ${bbox.y - MARGIN} ${width} ${height}`);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  // Reset the pan/zoom transform so the full tree is captured.
  const clonedViewport = clone.querySelector<SVGGElement>(".omm-viewport");
  clonedViewport?.removeAttribute("transform");

  // Size the background rect to cover the exported area.
  const bg = clone.querySelector<SVGRectElement>(".omm-bg");
  if (bg) {
    bg.setAttribute("x", String(bbox.x - MARGIN));
    bg.setAttribute("y", String(bbox.y - MARGIN));
    bg.setAttribute("width", String(width));
    bg.setAttribute("height", String(height));
  }

  return { svg: new XMLSerializer().serializeToString(clone), width, height };
}

function rasterize(live: SVGSVGElement): Promise<ExportImage> {
  const { svg, width, height } = buildStandaloneSVG(live);
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = activeDocument.createElement("canvas");
      canvas.width = width * PNG_SCALE;
      canvas.height = height * PNG_SCALE;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("canvas unavailable"));
        return;
      }
      ctx.scale(PNG_SCALE, PNG_SCALE);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve({ dataUrl: canvas.toDataURL("image/png"), width, height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("failed to rasterize SVG"));
    };
    img.src = url;
  });
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function mindmapToPNG(live: SVGSVGElement): Promise<ArrayBuffer> {
  const { dataUrl } = await rasterize(live);
  return dataUrlToArrayBuffer(dataUrl);
}

export async function mindmapToPDF(live: SVGSVGElement): Promise<ArrayBuffer> {
  const { dataUrl, width, height } = await rasterize(live);
  const orientation = width >= height ? "landscape" : "portrait";
  const pdf = new jsPDF({ orientation, unit: "pt", format: [width, height] });
  pdf.addImage(dataUrl, "PNG", 0, 0, width, height);
  return pdf.output("arraybuffer");
}
