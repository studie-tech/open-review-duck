import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

const app = new Hono();

app.get("/health", (context) =>
  context.json({ status: "ok", service: "review-agent" }),
);
app.route("/", flue());

export default app;
