declare module "html-to-docx" {
  export type HtmlToDocxMargins = {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
    header?: number;
    footer?: number;
    gutter?: number;
  };

  export type HtmlToDocxOptions = {
    title?: string;
    creator?: string;
    description?: string;
    pageSize?: {
      width: number;
      height: number;
    };
    margins?: HtmlToDocxMargins;
    table?: {
      row?: {
        cantSplit?: boolean;
      };
    };
  };

  const htmlToDocx: (
    html: string,
    headerHtml?: string | null,
    options?: HtmlToDocxOptions,
    footerHtml?: string | null,
  ) => Promise<Buffer>;

  export default htmlToDocx;
}
