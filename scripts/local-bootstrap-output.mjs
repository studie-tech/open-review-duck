/**
 * Formats a local owner URL as an unmistakable terminal action banner.
 *
 * @param {string} url complete one-time owner URL
 * @param {{ color?: boolean }} [options] terminal color preference
 * @returns {string} terminal-formatted banner
 */
export function formatLocalBootstrapLink(url, options = {}) {
  const color =
    options.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  const action = color ? "\u001b[1;30;103m" : "";
  const link = color ? "\u001b[1;4;96m" : "";
  const accent = color ? "\u001b[1;36m" : "";
  const reset = color ? "\u001b[0m" : "";
  return (
    `\n${action} ACTION REQUIRED: AUTHORIZE YOUR BROWSER ${reset}\n\n` +
    `${link}>>> ${url} <<<${reset}\n\n` +
    `${accent}This one-time link expires in 15 minutes.${reset}\n\n`
  );
}

/**
 * Explains a restart without exposing a new owner capability in logs.
 *
 * @param {number} port local application port
 * @returns {string} restart guidance
 */
export function formatLocalSessionReady(port) {
  return (
    `\nReviewDuck already has an active owner session.\n` +
    `Open http://localhost:${port} in the authorized browser.\n` +
    `To authorize another browser, run the bootstrap administration command.\n\n`
  );
}
