import { writeFile } from "node:fs/promises";

import { PDFDocument, StandardFonts } from "pdf-lib";

/** Writes a small two-page PDF and returns its path. */
export async function writeSamplePdf(filePath: string): Promise<string> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);

  for (const pageNumber of [1, 2]) {
    const page = document.addPage([612, 792]);

    page.drawText(`Sample agreement, page ${String(pageNumber)}`, {
      font,
      size: 18,
      x: 72,
      y: 700,
    });
    page.drawText("Signature: ______________________", {
      font,
      size: 12,
      x: 72,
      y: 200,
    });
  }

  await writeFile(filePath, await document.save());

  return filePath;
}
