import { createInterface } from "node:readline/promises";

/**
 * Interactive prompts for CLI commands. The password prompt reads keystrokes
 * directly with echo off, so the secret never appears on screen, in shell
 * history, in the process list (unlike a --password flag) or in an env var.
 */

function requireTerminal(): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      "This command needs an interactive terminal. Run it with `docker compose exec app ...` " +
        "from a terminal (not piped, and not with -T).",
    );
  }
}

export async function promptLine(question: string): Promise<string> {
  requireTerminal();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function promptHidden(question: string): Promise<string> {
  requireTerminal();
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (settle: () => void) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      settle();
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(() => resolve(value));
        if (char === "\u0003") return finish(() => reject(new Error("Cancelled")));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char; // ignore other control characters
      }
    };
    stdin.on("data", onData);
  });
}
