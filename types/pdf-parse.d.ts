declare module "pdf-parse" {
  type PdfParseResult = {
    text: string;
    numpages?: number;
    numrender?: number;
    info?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
    version?: string;
  };

  function pdfParse(buffer: Buffer): Promise<PdfParseResult>;

  export default pdfParse;
}
