import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../infra/dotenv.js";
import { isTruthyEnvValue, normalizeEnv } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { installUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { enableConsoleCapture } from "../logging.js";
import { getCommandPath, getPrimaryCommand, hasHelpOrVersion } from "./argv.js";
import { tryRouteCli } from "./route.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

export function shouldRegisterPrimarySubcommand(argv: string[]): boolean {
  return !hasHelpOrVersion(argv);
}

export function shouldSkipPluginCommandRegistration(params: {
  argv: string[];
  primary: string | null;
  hasBuiltinPrimary: boolean;
}): boolean {
  if (params.hasBuiltinPrimary) {
    return true;
  }
  if (!params.primary) {
    return hasHelpOrVersion(params.argv);
  }
  return false;
}

export function shouldEnsureCliPath(argv: string[]): boolean {
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  const [primary, secondary] = getCommandPath(argv, 2);
  if (!primary) {
    return true;
  }
  if (primary === "status" || primary === "health" || primary === "sessions") {
    return false;
  }
  if (primary === "config" && (secondary === "get" || secondary === "unset")) {
    return false;
  }
  if (primary === "models" && (secondary === "list" || secondary === "status")) {
    return false;
  }
  return true;
}

const ROOT_OPTIONS_WITH_VALUE = new Set(["--profile"]);

function parseRootInvocation(argv: string[]): {
  primary: string | null;
  hasInteractiveFlag: boolean;
} {
  const args = argv.slice(2);
  let primary: string | null = null;
  let hasInteractiveFlag = false;
  let expectOptionValue = false;

  for (const arg of args) {
    if (expectOptionValue) {
      expectOptionValue = false;
      continue;
    }
    if (arg === "--") {
      break;
    }
    if (arg === "-i" || arg === "--interactive") {
      hasInteractiveFlag = true;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      continue;
    }
    if (ROOT_OPTIONS_WITH_VALUE.has(arg)) {
      expectOptionValue = true;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    primary = arg;
    break;
  }

  return { primary, hasInteractiveFlag };
}

export function shouldUseInteractiveCommandSelector(params: {
  argv: string[];
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  ciEnv?: string;
  disableSelectorEnv?: string;
}): boolean {
  if (hasHelpOrVersion(params.argv)) {
    return false;
  }
  const root = parseRootInvocation(params.argv);
  if (!root.hasInteractiveFlag) {
    return false;
  }
  // Keep -i as an explicit interactive entrypoint only for root invocations.
  // If a real command is already present, run it normally and ignore -i.
  if (root.primary) {
    return false;
  }
  if (!params.stdinIsTTY || !params.stdoutIsTTY) {
    return false;
  }
  if (isTruthyEnvValue(params.ciEnv) || isTruthyEnvValue(params.disableSelectorEnv)) {
    return false;
  }
  return true;
}

export function stripInteractiveSelectorArgs(argv: string[]): string[] {
  const args = argv.slice(2);
  const next: string[] = [];
  let sawPrimary = false;
  let expectOptionValue = false;

  for (const arg of args) {
    if (!sawPrimary) {
      if (expectOptionValue) {
        expectOptionValue = false;
        next.push(arg);
        continue;
      }
      if (arg === "--") {
        sawPrimary = true;
        next.push(arg);
        continue;
      }
      if (arg === "-i" || arg === "--interactive") {
        continue;
      }
      if (arg.startsWith("--profile=")) {
        next.push(arg);
        continue;
      }
      if (ROOT_OPTIONS_WITH_VALUE.has(arg)) {
        expectOptionValue = true;
        next.push(arg);
        continue;
      }
      if (!arg.startsWith("-")) {
        sawPrimary = true;
      }
    }
    next.push(arg);
  }

  return [...argv.slice(0, 2), ...next];
}

export function isCommanderExitError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("commander.");
}

export async function runCli(argv: string[] = process.argv) {
  const normalizedArgv = normalizeWindowsArgv(argv);
  loadDotEnv({ quiet: true });
  normalizeEnv();
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  if (await tryRouteCli(normalizedArgv)) {
    return;
  }

  // Capture all console output into structured logs while keeping stdout/stderr behavior.
  enableConsoleCapture();

  const { buildProgram } = await import("./program.js");
  const program = buildProgram();

  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
    process.exit(1);
  });

  let parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
  const useInteractiveSelector = shouldUseInteractiveCommandSelector({
    argv: parseArgv,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    ciEnv: process.env.CI,
    disableSelectorEnv: process.env.OPENCLAW_DISABLE_COMMAND_SELECTOR,
  });
  if (useInteractiveSelector) {
    parseArgv = stripInteractiveSelectorArgs(parseArgv);
  }

  // Register the primary command (builtin or subcli) so help and command parsing
  // are correct even with lazy command registration.
  const primary = getPrimaryCommand(parseArgv);
  if (primary) {
    const { getProgramContext } = await import("./program/program-context.js");
    const ctx = getProgramContext(program);
    if (ctx) {
      const { registerCoreCliByName } = await import("./program/command-registry.js");
      await registerCoreCliByName(program, ctx, primary, parseArgv);
    }
    const { registerSubCliByName } = await import("./program/register.subclis.js");
    await registerSubCliByName(program, primary);
  }

  const hasBuiltinPrimary =
    primary !== null && program.commands.some((command) => command.name() === primary);
  const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
    argv: parseArgv,
    primary,
    hasBuiltinPrimary,
  });
  if (!shouldSkipPluginRegistration) {
    // Register plugin CLI commands before parsing
    const { registerPluginCliCommands } = await import("../plugins/cli.js");
    const { loadConfig } = await import("../config/config.js");
    registerPluginCliCommands(program, loadConfig());
  }

  if (useInteractiveSelector) {
    const interactiveBaseArgv = parseArgv;
    const { runInteractiveCommandSelector } = await import("./program/command-selector.js");
    const { runCommandQuestionnaire } = await import("./program/command-questionnaire.js");

    // In interactive mode we keep the process alive and return to the main menu
    // after each command run (or handled command-parse/help exit).
    program.exitOverride();
    while (true) {
      const selectedPath = await runInteractiveCommandSelector(program);
      if (!selectedPath || selectedPath.length === 0) {
        // Exit silently when leaving interactive mode.
        return;
      }

      const promptArgs = await runCommandQuestionnaire({ program, commandPath: selectedPath });
      if (promptArgs === null) {
        // User cancelled parameter entry: return to the main picker.
        continue;
      }

      const commandArgv = [...interactiveBaseArgv, ...selectedPath, ...promptArgs];
      try {
        await program.parseAsync(commandArgv);
      } catch (error) {
        if (!isCommanderExitError(error)) {
          console.error("[openclaw] Command failed:", formatUncaughtError(error));
        }
      }
    }
  }

  await program.parseAsync(parseArgv);
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
