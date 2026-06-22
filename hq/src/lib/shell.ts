import { $ } from "bun";

export async function run(cmd: string): Promise<string> {
  const result = await $`bash -c ${cmd}`.quiet().nothrow();
  return result.stdout.toString().trim();
}

export async function runLines(cmd: string): Promise<string[]> {
  const output = await run(cmd);
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}
