import { supportedExtensions } from "../../types";
import { javascriptAdapter } from "../ecmascript";

export const typescriptAdapter = javascriptAdapter(
  "typescript",
  supportedExtensions.typescript,
);
