import { supportedExtensions } from "../../types";
import { javascriptAdapter } from "../ecmascript";

export const javascriptLanguageAdapter = javascriptAdapter(
  "javascript",
  supportedExtensions.javascript,
);
