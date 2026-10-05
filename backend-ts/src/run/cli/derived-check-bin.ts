#!/usr/bin/env -S node --import tsx
import { main } from "./derived-check.ts";

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
