import { postReceipts } from "./mocha.ts";

postReceipts()
  .then((notes) => {
    for (const note of notes) console.log(note);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
