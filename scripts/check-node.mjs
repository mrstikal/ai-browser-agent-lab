import { reportNodeVersion } from "./node-version.mjs";

if (!reportNodeVersion()) process.exit(1);
