import { Language, Parser } from "web-tree-sitter";

const runtimeGlobal = globalThis as typeof globalThis & {
  __openReviewDuckTreeSitter?: {
    Language: typeof Language;
    Parser: typeof Parser;
  };
  __openReviewDuckTreeSitterAssetRoot?: string;
};

runtimeGlobal.__openReviewDuckTreeSitter = { Language, Parser };
runtimeGlobal.__openReviewDuckTreeSitterAssetRoot = `${process.cwd()}/public/tree-sitter`;
