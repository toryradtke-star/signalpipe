#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { main } from '../src/cli.ts';

main(process.argv.slice(2)).catch((err) => {
  console.error(`signalpipe: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
