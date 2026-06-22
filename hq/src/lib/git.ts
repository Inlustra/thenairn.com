import { run } from "./shell.js";

export async function clone(repoUrl: string, targetDir: string): Promise<string> {
  return run(`git clone ${JSON.stringify(repoUrl)} ${JSON.stringify(targetDir)}`);
}

export async function init(dir: string): Promise<string> {
  return run(`cd ${JSON.stringify(dir)} && git init`);
}
