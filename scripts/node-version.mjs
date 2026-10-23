const MINIMUM = [22, 19, 0];

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return undefined;
  return match.slice(1, 4).map(Number);
}

function atLeast(current, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    const left = current[index];
    const right = minimum[index];
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

export function nodeVersionProblem(version = process.versions.node) {
  const parsed = parse(version);
  if (parsed && atLeast(parsed, MINIMUM)) return undefined;
  return [
    `AI Browser Agent Lab requires Node.js ${MINIMUM.join(".")} or newer; found ${version}.`,
    "Browser Use Pi needs Node.js 22.19+ for its JavaScript worker.",
    "",
    "With nvm installed, run:",
    "  nvm install    # reads .nvmrc",
    "  nvm use",
    "Then retry the command.",
  ].join("\n");
}

export function reportNodeVersion() {
  const problem = nodeVersionProblem();
  if (problem) {
    console.error(problem);
    return false;
  }
  console.log(
    `Node.js ${process.versions.node} satisfies the >=${MINIMUM.join(".")} requirement.`,
  );
  return true;
}
