import { mkdir, readFile, writeFile } from "fs/promises";
import { Composio } from "@composio/core";

const TOOLKITS = ["googlesuper", "github"];
const FORCE = process.argv.includes("--force");

const composio = new Composio();

await mkdir("data", { recursive: true });

for (const toolkit of TOOLKITS) {
  const outPath = `data/${toolkit}_tools.json`;

  if (!FORCE) {
    try {
      const existing = JSON.parse(await readFile(outPath, "utf-8"));
      console.log(`skip ${toolkit}: ${existing.length} tools cached at ${outPath} (use --force to refetch)`);
      continue;
    } catch {
      // no cache yet, fetch below
    }
  }

  console.log(`fetching ${toolkit}...`);
  const tools = await composio.tools.getRawComposioTools({
    toolkits: [toolkit],
    limit: 1000,
  });

  if (!tools || tools.length === 0) {
    throw new Error(`fetched 0 tools for toolkit "${toolkit}" — check toolkit slug/casing`);
  }

  console.log(`fetched ${tools.length} tools for ${toolkit}`);
  await writeFile(outPath, JSON.stringify(tools, null, 2), "utf-8");
  console.log(`wrote ${outPath}`);
}
