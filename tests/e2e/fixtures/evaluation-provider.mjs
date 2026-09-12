import http from "node:http";

/** Serves deterministic OpenAI-compatible responses solely for browser QA. */
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url.endsWith("/models")) {
    res.end(JSON.stringify({ data: [{ id: "reviewduck-eval-fixture" }] }));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  const messages = input.messages ?? [];
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const prompt = messages.find((m) => m.role === "user")?.content ?? "";
  if (system.includes("QA_FORCE_FAILURE")) {
    res.statusCode = 503;
    res.end(
      JSON.stringify({ error: { message: "Controlled provider outage" } }),
    );
    return;
  }
  if (system.includes("QA_SLOW"))
    await new Promise((resolve) => setTimeout(resolve, 5000));
  const strict = system.includes(
    "check whether a guard already proves it impossible",
  );
  const guarded =
    prompt.includes("if (!user) return") || prompt.includes("Math.max(1,");
  let message;
  if (input.tools?.some((tool) => tool.function.name === "report_finding")) {
    const hasToolReply = messages.some((m) => m.role === "tool");
    message = {
      role: "assistant",
      content: null,
      tool_calls:
        !hasToolReply && !guarded
          ? [
              {
                id: "call_report",
                type: "function",
                function: {
                  name: "report_finding",
                  arguments: JSON.stringify({
                    findings: [
                      {
                        title: "Missing input guard",
                        body: "The input is used without checking it first.",
                        existing_code: prompt.includes("user.name")
                          ? "user.name"
                          : "total / count",
                        severity: "high",
                        category: "bug",
                      },
                    ],
                  }),
                },
              },
            ]
          : [
              {
                id: "call_finish",
                type: "function",
                function: {
                  name: "finish_file",
                  arguments: JSON.stringify({
                    summary: "Frozen file review complete.",
                  }),
                },
              },
            ],
    };
  } else {
    const id = prompt.match(/<finding id="([^"]+)"/)?.[1];
    const path = prompt.match(/<file-under-review path="([^"]+)"/)?.[1];
    const verdict = strict && guarded ? "refuted" : "not_refuted";
    message = {
      role: "assistant",
      content: JSON.stringify({
        votes: [
          {
            id,
            verdict,
            ...(verdict === "refuted"
              ? {
                  refutation:
                    "The guard in the frozen source rules out the reported failure.",
                  evidencePath: path,
                  evidenceLine: 2,
                }
              : {}),
          },
        ],
      }),
    };
  }
  res.end(
    JSON.stringify({
      id: "qa-completion",
      object: "chat.completion",
      created: 1,
      model: input.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: message.tool_calls ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 240, completion_tokens: 65, total_tokens: 305 },
    }),
  );
});
server.listen(4199, "127.0.0.1");
