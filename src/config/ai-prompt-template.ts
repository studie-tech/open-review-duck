/** Replaces `{{name}}` tokens. Unknown tokens are left unchanged. */
export function renderAiPromptTemplate(
  template: string,
  values: Record<string, string>,
) {
  return template.replace(/\{\{([a-z0-9_]+)\}\}/g, (match, key: string) => {
    const replacement = Object.hasOwn(values, key) ? values[key] : undefined;
    return replacement ?? match;
  });
}
