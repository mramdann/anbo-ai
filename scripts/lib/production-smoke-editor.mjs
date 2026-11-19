// The editor part of the production smoke (scripts/production-smoke.mjs): what
// the editor page (src/app/EditorProductionSmoke.tsx) left in the DOM that
// headless Chrome dumped, and when a failed run of it is worth one more.

/** The page's verdict, from the data attributes it wrote on the root element. */
export function readEditorSmoke(stdout) {
  const attribute = (suffix) =>
    stdout.match(new RegExp(`data-anbo-editor-smoke${suffix}="([^"]*)"`))?.[1] ?? null;
  return {
    passed: stdout.includes('data-anbo-editor-smoke="pass"'),
    looks: attribute("-looks"),
    firstLook: attribute("-first-look"),
    detail: attribute("-error"),
  };
}

/**
 * The page looks every 100 ms until its deadline, and both are counted in the
 * headless browser's virtual time, which does not wait for the editor to
 * draw: on a CI runner all 30 looks once went by in 0.6 s before the selection
 * was drawn, and the smoke failed for an editor that was fine. A part that is
 * still missing at the last look, or a page that gave no verdict at all, is
 * therefore worth one more run. A layout that is there and wrong is not.
 */
export function editorDeservesAnotherTry(result) {
  if (result.passed) return false;
  return result.detail === null || result.detail.includes("did not mount");
}

function describeFailure(result) {
  const reason = result.detail ?? "the page gave no verdict";
  return `production editor layout smoke failed: ${reason}${result.looks ? ` (after ${result.looks} looks)` : ""}`;
}

/**
 * Runs the editor page through `runPage(label)`, which resolves with the
 * dumped `stdout` and Chrome's `stderr`, and once more when the first run
 * deserves it. Resolves with the verdict that counted and the run it came
 * from; throws when the editor failed for good.
 */
export async function runEditorSmoke(runPage, log = console) {
  for (let attempt = 1; ; attempt += 1) {
    const { stdout, stderr } = await runPage(attempt === 1 ? "editor" : "editor, second try");
    const result = readEditorSmoke(stdout);
    // What the first look was still waiting for, so a CI log shows how close
    // the page came to its deadline.
    if (result.firstLook) log.log(`editor smoke, first look: ${result.firstLook}`);
    if (result.passed) return { ...result, attempt };
    const failure = describeFailure(result);
    if (attempt > 1 || !editorDeservesAnotherTry(result)) {
      throw new Error(
        `${failure}${attempt > 1 ? ", on the second try too" : ""}\n${stderr.slice(-4000)}`,
      );
    }
    log.warn(`${failure}; trying once more.`);
  }
}
