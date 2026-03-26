# Third-Party Notices

SignuDoc includes bundled third-party assets that remain under their own
licenses. The project license applies to SignuDoc's code, but it does not
replace the licenses for redistributed third-party files.

## Bundled third-party assets

### 1. Great Vibes font

- **Bundled path:** `src/assets/fonts/GreatVibes-Regular.ttf`
- **Used by:** `src/lib/services/pdf-finalize.ts`
- **License:** SIL Open Font License 1.1
- **Full license text:** `src/assets/fonts/LICENSE-OFL.txt`

### 2. Mozilla PDF.js legacy worker asset

- **Bundled path:** `public/pdfjs/5.5.207/legacy/build/pdf.worker.min.mjs`
- **Source project:** Mozilla PDF.js
- **License:** Apache License 2.0
- **Full license text:** `LICENSES/Apache-2.0.txt`

### 3. PDF.js standard fonts - PDFium-derived Foxit font files

- **Bundled path:** `public/pdfjs/5.5.207/standard_fonts/Foxit*.pfb`
- **Source project:** Mozilla PDF.js standard font assets
- **License text already bundled at:** `public/pdfjs/5.5.207/standard_fonts/LICENSE_FOXIT`
- **Notes:** The bundled notice identifies these files under the PDFium Authors copyright and license terms distributed with PDF.js.

### 4. PDF.js standard fonts - Liberation Sans

- **Bundled path:** `public/pdfjs/5.5.207/standard_fonts/LiberationSans-*.ttf`
- **Source project:** Mozilla PDF.js standard font assets
- **License:** SIL Open Font License 1.1
- **License text already bundled at:** `public/pdfjs/5.5.207/standard_fonts/LICENSE_LIBERATION`

## Notes

- Include this file and the referenced license texts in release archives and other redistributions of the repository contents.
- If additional third-party assets are vendored into the repository later, add them here alongside their license texts.
