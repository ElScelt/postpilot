// Loaded before every test file. The suite checks behaviour against postpilot's
// defaults, so it pins them here; otherwise customising postpilot.config.ts, as the
// README asks, would fail tests that expect UTC or an empty stack. config.test.ts still
// validates the real file.
process.env.POSTPILOT_CONFIG = "defaults";
