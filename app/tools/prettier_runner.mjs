#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const prettierPackagePath = require.resolve("prettier/package.json");
const prettierDir = path.dirname(prettierPackagePath);
const prettierCli = path.join(prettierDir, "bin", "prettier.cjs");

require(prettierCli);
