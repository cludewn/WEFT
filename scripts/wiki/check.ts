import { resolve } from "node:path";

import { readWikiSources, registeredCommands, validateGuide } from "./content.js";

const sources = readWikiSources(resolve("docs/wiki"));
validateGuide(sources);
console.log(
  `Wiki validation passed: ${(sources.size - 1) / 2} page pairs, ${registeredCommands().length} commands per language.`,
);
