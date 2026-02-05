#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const eslintPackagePath = require.resolve("eslint/package.json");
const eslintDir = path.dirname(eslintPackagePath);
const eslintCli = path.join(eslintDir, "bin", "eslint.js");

// Defer to ESLint's official CLI implementation so CLI args and exit codes match
// the standard `eslint` binary.
require(eslintCli);
