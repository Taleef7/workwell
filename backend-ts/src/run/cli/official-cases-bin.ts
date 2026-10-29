#!/usr/bin/env -S node --import tsx
import "../../engine/utc.ts"; // first: pins the process to UTC before anything reads a date (#845)
import { main } from "./official-cases.ts";

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
