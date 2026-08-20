function agentIdPart(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/^custom:/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function agentIdFor(name: string, cli: string, tabId: number): string {
  const cliPart = agentIdPart(cli) || "agent";
  const namePart = agentIdPart(name) || cliPart;
  const identity = namePart === cliPart ? cliPart : `${namePart}-${cliPart}`;
  return `${identity}:${tabId}`;
}
