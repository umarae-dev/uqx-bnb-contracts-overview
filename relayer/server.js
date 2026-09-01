// Stable production entrypoint. The hardened V4.1 implementation preserves
// the /health and /relay API while extending the selector allowlist for the
// signed delayed-budget lifecycle.
require("./server-v4_1");
