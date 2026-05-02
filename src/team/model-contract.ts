import { spawnSync } from 'child_process';
import { isAbsolute, normalize, win32 as win32Path } from 'path';
import { validateTeamName } from './team-name.js';
import { normalizeToCcAlias } from '../features/delegation-enforcer.js';
import { getDefaultModelHigh, getDefaultModelLow, getDefaultModelMedium, isBedrock, isVertexAI, isProviderSpecificModelId } from '../config/models.js';
import { isExternalLLMDisabled } from '../lib/security-config.js';

export type CliAgentType = 'claude' | 'codex' | 'gemini' | 'cursor';

export interface CliAgentContract {
  agentType: CliAgentType;
  binary: string;
  installInstructions: string;
  buildLaunchArgs(model?: string, extraFlags?: string[]): string[];
  parseOutput(rawOutput: string): string;
  /** Whether this agent supports a prompt/headless mode that bypasses TUI input */
  supportsPromptMode?: boolean;
  /** CLI flag for prompt mode (e.g., '-p' for gemini) */
  promptModeFlag?: string;
}

export type TeamReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ParsedTeamWorkerLaunchArgs {
  passthrough: string[];
  wantsBypass: boolean;
  reasoningOverride: string | null;
  modelProviderOverride: string | null;
  modelOverride: string | null;
}

export interface ResolveTeamWorkerLaunchArgsOptions {
  existingRaw?: string;
  inheritedArgs?: string[];
  fallbackModel?: string;
  preferredReasoning?: TeamReasoningEffort;
}

export interface WorkerLaunchConfig {
  teamName: string;
  workerName: string;
  model?: string;
  cwd: string;
  extraFlags?: string[];
  /**
   * Optional pre-validated absolute CLI binary path.
   * Used by runtime preflight validation to ensure spawns are pinned.
   */
  resolvedBinaryPath?: string;
  /**
   * Optional path the worker writes its structured verdict JSON to
   * (used by the CLI-worker output contract for critic/reviewer stages).
   * Consumed by the worker-completion handler in runtime-v2.
   */
  output_file?: string;
}

/** @deprecated Backward-compat shim for older team API consumers. */
export interface CliBinaryValidation {
  valid: boolean;
  binary: string;
  resolvedPath?: string;
  reason?: string;
}

const resolvedPathCache = new Map<string, string>();

const UNTRUSTED_PATH_PATTERNS: RegExp[] = [
  /^\/tmp(\/|$)/,
  /^\/var\/tmp(\/|$)/,
  /^\/dev\/shm(\/|$)/,
];

function getTrustedPrefixes(): string[] {
  const trusted = [
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/',
  ];

  const home = process.env.HOME;
  if (home) {
    trusted.push(`${home}/.local/bin`);
    trusted.push(`${home}/.nvm/`);
    trusted.push(`${home}/.cargo/bin`);
  }

  const custom = (process.env.OMC_TRUSTED_CLI_DIRS ?? '')
    .split(':')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => isAbsolute(part));

  trusted.push(...custom);
  return trusted;
}

function isTrustedPrefix(resolvedPath: string): boolean {
  const normalized = normalize(resolvedPath);
  return getTrustedPrefixes().some(prefix => normalized.startsWith(normalize(prefix)));
}

function assertBinaryName(binary: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(binary)) {
    throw new Error(`Invalid CLI binary name: ${binary}`);
  }
}

/** @deprecated Backward-compat shim; non-interactive shells should generally skip RC files. */
export function shouldLoadShellRc(): boolean {
  return false;
}

/** @deprecated Backward-compat shim retained for API compatibility. */
export function resolveCliBinaryPath(binary: string): string {
  assertBinaryName(binary);
  const cached = resolvedPathCache.get(binary);
  if (cached) return cached;

  const finder = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(finder, [binary], {
    timeout: 5000,
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`CLI binary '${binary}' not found in PATH`);
  }

  const stdout = result.stdout?.toString().trim() ?? '';
  const firstLine = stdout.split('\n').map(line => line.trim()).find(Boolean) ?? '';
  if (!firstLine) {
    throw new Error(`CLI binary '${binary}' not found in PATH`);
  }

  const resolvedPath = normalize(firstLine);
  if (!isAbsolute(resolvedPath)) {
    throw new Error(`Resolved CLI binary '${binary}' to relative path`);
  }

  if (UNTRUSTED_PATH_PATTERNS.some(pattern => pattern.test(resolvedPath))) {
    throw new Error(`Resolved CLI binary '${binary}' to untrusted location: ${resolvedPath}`);
  }

  if (!isTrustedPrefix(resolvedPath)) {
    console.warn(`[omc:cli-security] CLI binary '${binary}' resolved to non-standard path: ${resolvedPath}`);
  }

  resolvedPathCache.set(binary, resolvedPath);
  return resolvedPath;
}

/** @deprecated Backward-compat shim retained for API compatibility. */
export function clearResolvedPathCache(): void {
  resolvedPathCache.clear();
}

/** @deprecated Backward-compat shim retained for API compatibility. */
export function validateCliBinaryPath(binary: string): CliBinaryValidation {
  try {
    const resolvedPath = resolveCliBinaryPath(binary);
    return { valid: true, binary, resolvedPath };
  } catch (error) {
    return {
      valid: false,
      binary,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export const _testInternals = {
  UNTRUSTED_PATH_PATTERNS,
  getTrustedPrefixes,
};

const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const MADMAX_FLAG = '--madmax';
const MODEL_FLAG = '--model';
const CONFIG_FLAG = '-c';
const REASONING_KEY = 'model_reasoning_effort';
const MODEL_PROVIDER_KEY = 'model_provider';

const LOW_COMPLEXITY_AGENT_TYPES = new Set(['explore', 'style-reviewer']);

const ROLE_REASONING_DEFAULTS: Record<string, TeamReasoningEffort> = {
  explore: 'low',
  writer: 'low',
  executor: 'medium',
  debugger: 'medium',
  'test-engineer': 'medium',
  verifier: 'medium',
  designer: 'medium',
  'security-reviewer': 'medium',
  architect: 'high',
  planner: 'high',
  analyst: 'high',
  critic: 'high',
  'code-reviewer': 'high',
  'code-simplifier': 'high',
};

const ROLE_MODEL_DEFAULTS: Record<string, () => string> = {
  explore: getDefaultModelLow,
  writer: getDefaultModelLow,
  executor: getDefaultModelMedium,
  debugger: getDefaultModelMedium,
  'test-engineer': getDefaultModelMedium,
  verifier: getDefaultModelMedium,
  designer: getDefaultModelMedium,
  'security-reviewer': getDefaultModelMedium,
  'document-specialist': getDefaultModelMedium,
  architect: getDefaultModelHigh,
  planner: getDefaultModelHigh,
  analyst: getDefaultModelHigh,
  critic: getDefaultModelHigh,
  'code-reviewer': getDefaultModelHigh,
  'code-simplifier': getDefaultModelHigh,
  orchestrator: getDefaultModelHigh,
};

function isConfigOverrideForKey(value: string, key: string): boolean {
  return new RegExp(`^${key}\\s*=`).test(value.trim());
}

function isReasoningOverride(value: string): boolean {
  return isConfigOverrideForKey(value, REASONING_KEY);
}

function isModelProviderOverride(value: string): boolean {
  return isConfigOverrideForKey(value, MODEL_PROVIDER_KEY);
}

function isValidModelValue(value: string): boolean {
  return value.trim().length > 0 && !value.startsWith('-');
}

function normalizeOptionalModel(model?: string | null): string | undefined {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalReasoning(reasoning?: TeamReasoningEffort | string | null): TeamReasoningEffort | undefined {
  if (typeof reasoning !== 'string') return undefined;
  const normalized = reasoning.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }
  return undefined;
}

function normalizeRoleName(agentType?: string): string | undefined {
  const normalized = agentType?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

export function splitWorkerLaunchArgs(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];
  return raw.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

export function parseTeamWorkerLaunchArgs(args: string[]): ParsedTeamWorkerLaunchArgs {
  const passthrough: string[] = [];
  let wantsBypass = false;
  let reasoningOverride: string | null = null;
  let modelProviderOverride: string | null = null;
  let modelOverride: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === CODEX_BYPASS_FLAG || arg === MADMAX_FLAG) {
      wantsBypass = true;
      continue;
    }

    if (arg === MODEL_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === 'string' && isValidModelValue(maybeValue)) {
        modelOverride = maybeValue.trim();
        i += 1;
      }
      continue;
    }

    if (arg.startsWith(`${MODEL_FLAG}=`)) {
      const inlineValue = arg.slice(`${MODEL_FLAG}=`.length).trim();
      if (isValidModelValue(inlineValue)) modelOverride = inlineValue;
      continue;
    }

    if (arg === CONFIG_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === 'string' && isReasoningOverride(maybeValue)) {
        reasoningOverride = maybeValue;
        i += 1;
        continue;
      }
      if (typeof maybeValue === 'string' && isModelProviderOverride(maybeValue)) {
        modelProviderOverride = maybeValue;
        i += 1;
        continue;
      }
    }

    passthrough.push(arg);
  }

  return { passthrough, wantsBypass, reasoningOverride, modelProviderOverride, modelOverride };
}

export function collectInheritableTeamWorkerArgs(workerArgs: string[]): string[] {
  const parsed = parseTeamWorkerLaunchArgs(workerArgs);
  const inherited: string[] = [];
  if (parsed.wantsBypass) inherited.push(CODEX_BYPASS_FLAG);
  if (parsed.modelProviderOverride) inherited.push(CONFIG_FLAG, parsed.modelProviderOverride);
  if (parsed.reasoningOverride) inherited.push(CONFIG_FLAG, parsed.reasoningOverride);
  if (parsed.modelOverride) inherited.push(MODEL_FLAG, parsed.modelOverride);
  return inherited;
}

export function normalizeTeamWorkerLaunchArgs(
  args: string[],
  preferredModel?: string,
  preferredReasoning?: TeamReasoningEffort,
  preferredModelProviderOverride?: string,
): string[] {
  const parsed = parseTeamWorkerLaunchArgs(args);
  const normalized = [...parsed.passthrough];
  if (parsed.wantsBypass) normalized.push(CODEX_BYPASS_FLAG);

  const selectedReasoning = parsed.reasoningOverride
    ?? (normalizeOptionalReasoning(preferredReasoning) ? `${REASONING_KEY}="${normalizeOptionalReasoning(preferredReasoning)}"` : null);
  const selectedModelProvider = preferredModelProviderOverride ?? parsed.modelProviderOverride;
  if (selectedModelProvider) normalized.push(CONFIG_FLAG, selectedModelProvider);
  if (selectedReasoning) normalized.push(CONFIG_FLAG, selectedReasoning);

  const selectedModel = normalizeOptionalModel(preferredModel) ?? normalizeOptionalModel(parsed.modelOverride);
  if (selectedModel) normalized.push(MODEL_FLAG, selectedModel);
  return normalized;
}

export function resolveTeamWorkerLaunchArgs(options: ResolveTeamWorkerLaunchArgsOptions): string[] {
  const envArgs = splitWorkerLaunchArgs(options.existingRaw);
  const inheritedArgs = options.inheritedArgs ?? [];
  const allArgs = [...envArgs, ...inheritedArgs];
  const envParsed = parseTeamWorkerLaunchArgs(envArgs);
  const inheritedParsed = parseTeamWorkerLaunchArgs(inheritedArgs);
  const selectedModel = normalizeOptionalModel(envParsed.modelOverride)
    ?? normalizeOptionalModel(inheritedParsed.modelOverride)
    ?? normalizeOptionalModel(options.fallbackModel);
  const selectedModelProvider = envParsed.modelProviderOverride ?? inheritedParsed.modelProviderOverride ?? undefined;
  return normalizeTeamWorkerLaunchArgs(allArgs, selectedModel, options.preferredReasoning, selectedModelProvider);
}

export function isLowComplexityAgentType(agentType?: string): boolean {
  const normalized = normalizeRoleName(agentType);
  if (!normalized) return false;
  if (normalized.endsWith('-low')) return true;
  return LOW_COMPLEXITY_AGENT_TYPES.has(normalized);
}

export function resolveAgentReasoningEffort(agentType?: string): TeamReasoningEffort | undefined {
  const normalized = normalizeRoleName(agentType);
  if (!normalized) return undefined;
  return ROLE_REASONING_DEFAULTS[normalized];
}

export function resolveAgentDefaultModel(agentType?: string): string | undefined {
  const normalized = normalizeRoleName(agentType);
  if (!normalized) return undefined;
  if (normalized.endsWith('-low')) return getDefaultModelLow();
  return ROLE_MODEL_DEFAULTS[normalized]?.();
}

function contractExtraFlags(
  agentType: CliAgentType,
  extraFlags: string[] | undefined,
  model?: string,
): { model?: string; extraFlags: string[] } {
  const parsed = parseTeamWorkerLaunchArgs(extraFlags ?? []);
  const selectedModel = normalizeOptionalModel(parsed.modelOverride) ?? normalizeOptionalModel(model);
  const passthrough = [...parsed.passthrough];
  if (agentType === 'codex' && parsed.modelProviderOverride) passthrough.push(CONFIG_FLAG, parsed.modelProviderOverride);
  if (agentType === 'codex' && parsed.reasoningOverride) passthrough.push(CONFIG_FLAG, parsed.reasoningOverride);
  if (parsed.wantsBypass && agentType !== 'codex') passthrough.push(CODEX_BYPASS_FLAG);
  return { model: selectedModel, extraFlags: passthrough };
}

export function resolveWorkerLaunchExtraFlags(
  env: NodeJS.ProcessEnv = process.env,
  inheritedArgs: string[] = [],
  fallbackModel?: string,
  preferredReasoning?: TeamReasoningEffort,
): string[] {
  return resolveTeamWorkerLaunchArgs({
    existingRaw: env.OMC_TEAM_WORKER_LAUNCH_ARGS,
    inheritedArgs,
    fallbackModel,
    preferredReasoning,
  });
}

/**
 * Detect parent launch env for Claude Code API-key auth.
 *
 * Claude Code's `--dangerously-skip-permissions` only bypasses permission
 * prompts. When an API key is present, `--bare` is needed to avoid the
 * interactive OAuth/session login path for team worker panes.
 */
export function shouldUseClaudeBareMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim().length > 0;
}

const CONTRACTS: Record<CliAgentType, CliAgentContract> = {
  claude: {
    agentType: 'claude',
    binary: 'claude',
    installInstructions: 'Install Claude CLI: https://claude.ai/download',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--dangerously-skip-permissions'];
      if (shouldUseClaudeBareMode() && !extraFlags.includes('--bare')) {
        args.push('--bare');
      }
      if (model) {
        // Provider-specific model IDs (Bedrock, Vertex) must be passed as-is.
        // Normalizing them to aliases like "sonnet" causes Claude Code to expand
        // them to Anthropic API names (claude-sonnet-4-6) which are invalid on
        // these providers. (issue #1695)
        const resolved = isProviderSpecificModelId(model) ? model : normalizeToCcAlias(model);
        args.push('--model', resolved);
      }
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
  codex: {
    agentType: 'codex',
    binary: 'codex',
    installInstructions: 'Install Codex CLI: npm install -g @openai/codex',
    // Team workers must be persistent interactive panes. Do not use `codex exec`
    // or positional prompt mode here; runtime dispatch writes inbox.md and nudges
    // the live Codex TUI with `codex` as the worker process.
    supportsPromptMode: false,
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--dangerously-bypass-approvals-and-sandbox'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      // Codex outputs JSONL — extract the last assistant message
      const lines = rawOutput.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.type === 'message' && parsed.role === 'assistant') {
            return parsed.content ?? rawOutput;
          }
          if (parsed.type === 'result' || parsed.output) {
            return parsed.output ?? parsed.result ?? rawOutput;
          }
        } catch {
          // not JSON, skip
        }
      }
      return rawOutput.trim();
    },
  },
  gemini: {
    agentType: 'gemini',
    binary: 'gemini',
    installInstructions: 'Install Gemini CLI: npm install -g @google/gemini-cli',
    supportsPromptMode: true,
    promptModeFlag: '-p',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--approval-mode', 'yolo'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
  cursor: {
    agentType: 'cursor',
    binary: 'cursor-agent',
    installInstructions: 'Install Cursor Agent CLI: see https://docs.cursor.com/cli',
    // cursor-agent runs as an interactive REPL — no exit-on-complete prompt mode.
    // Keep supportsPromptMode false so the verdict-file contract path
    // (CONTRACT_ROLES + shouldInjectContract) skips this provider; cursor
    // workers participate as executors only.
    supportsPromptMode: false,
    buildLaunchArgs(_model?: string, extraFlags: string[] = []): string[] {
      // Minimal flags — cursor-agent owns its own session/auth state.
      // The model is selected interactively inside cursor-agent itself.
      return [...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
};

export function getContract(agentType: CliAgentType): CliAgentContract {
  const contract = CONTRACTS[agentType];
  if (!contract) {
    throw new Error(`Unknown agent type: ${agentType}. Supported: ${Object.keys(CONTRACTS).join(', ')}`);
  }
  if (agentType !== 'claude' && isExternalLLMDisabled()) {
    throw new Error(
      `External LLM provider "${agentType}" is blocked by security policy (disableExternalLLM). ` +
      `Only Claude workers are allowed in the current security configuration.`
    );
  }
  return contract;
}

function validateBinaryRef(binary: string): void {
  if (isAbsolute(binary)) return;
  if (/^[A-Za-z0-9._-]+$/.test(binary)) return;
  throw new Error(`Unsafe CLI binary reference: ${binary}`);
}

function resolveBinaryPath(binary: string): string {
  validateBinaryRef(binary);
  if (isAbsolute(binary)) return binary;

  try {
    const resolver = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(resolver, [binary], { timeout: 5000, encoding: 'utf8' });
    if (result.status !== 0) return binary;

    const lines = result.stdout
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean) ?? [];

    const firstPath = lines[0];
    const isResolvedAbsolute = !!firstPath && (isAbsolute(firstPath) || win32Path.isAbsolute(firstPath));
    return isResolvedAbsolute ? firstPath : binary;
  } catch {
    return binary;
  }
}

export function isCliAvailable(agentType: CliAgentType): boolean {
  const contract = getContract(agentType);
  try {
    const resolvedBinary = resolveBinaryPath(contract.binary);
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedBinary)) {
      const comspec = process.env.COMSPEC || 'cmd.exe';
      const result = spawnSync(comspec, ['/d', '/s', '/c', `"${resolvedBinary}" --version`], { timeout: 5000 });
      return result.status === 0;
    }

    const result = spawnSync(resolvedBinary, ['--version'], {
      timeout: 5000,
      shell: process.platform === 'win32',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function validateCliAvailable(agentType: CliAgentType): void {
  if (!isCliAvailable(agentType)) {
    const contract = getContract(agentType);
    throw new Error(
      `CLI agent '${agentType}' not found. ${contract.installInstructions}`
    );
  }
}

export function resolveValidatedBinaryPath(agentType: CliAgentType): string {
  const contract = getContract(agentType);
  return resolveCliBinaryPath(contract.binary);
}

export function buildLaunchArgs(agentType: CliAgentType, config: WorkerLaunchConfig): string[] {
  const prepared = contractExtraFlags(agentType, config.extraFlags, config.model);
  return getContract(agentType).buildLaunchArgs(prepared.model, prepared.extraFlags);
}

export function buildWorkerArgv(agentType: CliAgentType, config: WorkerLaunchConfig): string[] {
  validateTeamName(config.teamName);
  const contract = getContract(agentType);
  const binary = config.resolvedBinaryPath
    ? (() => {
        validateBinaryRef(config.resolvedBinaryPath);
        return config.resolvedBinaryPath;
      })()
    : resolveBinaryPath(contract.binary);
  const args = buildLaunchArgs(agentType, config);
  return [binary, ...args];
}

export function buildWorkerCommand(agentType: CliAgentType, config: WorkerLaunchConfig): string {
  return buildWorkerArgv(agentType, config)
    .map((part) => `'${part.replace(/'/g, `'\"'\"'`)}'`)
    .join(' ');
}

const WORKER_MODEL_ENV_ALLOWLIST = [
  'ANTHROPIC_MODEL',
  'CLAUDE_MODEL',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
  'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
  'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'OMC_MODEL_HIGH',
  'OMC_MODEL_MEDIUM',
  'OMC_MODEL_LOW',
  'OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL',
  'OMC_CODEX_DEFAULT_MODEL',
  'OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL',
  'OMC_GEMINI_DEFAULT_MODEL',
] as const;

export function getWorkerEnv(
  teamName: string,
  workerName: string,
  agentType: CliAgentType,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  validateTeamName(teamName);
  const workerEnv: Record<string, string> = {
    OMC_TEAM_WORKER: `${teamName}/${workerName}`,
    OMC_TEAM_NAME: teamName,
    OMC_WORKER_AGENT_TYPE: agentType,
  };

  for (const key of WORKER_MODEL_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      workerEnv[key] = value;
    }
  }

  return workerEnv;
}

export function parseCliOutput(agentType: CliAgentType, rawOutput: string): string {
  return getContract(agentType).parseOutput(rawOutput);
}

/**
 * Check if an agent type supports prompt/headless mode (bypasses TUI).
 */
export function isPromptModeAgent(agentType: CliAgentType): boolean {
  const contract = getContract(agentType);
  return !!contract.supportsPromptMode;
}

/**
 * Resolve the active model for Claude team workers on Bedrock/Vertex.
 *
 * When running on a non-standard provider (Bedrock, Vertex), workers need
 * the provider-specific model ID passed explicitly via --model. Without it,
 * Claude Code falls back to its built-in default (claude-sonnet-4-6) which
 * is invalid on these providers.
 *
 * Resolution order:
 *   1. ANTHROPIC_MODEL / CLAUDE_MODEL env vars (user's explicit setting)
 *   2. Provider tier-specific env vars (CLAUDE_CODE_BEDROCK_SONNET_MODEL, etc.)
 *   3. undefined — let Claude Code handle its own default
 *
 * Returns undefined when not on Bedrock/Vertex (standard Anthropic API
 * handles bare aliases fine).
 */
export function resolveClaudeWorkerModel(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // When force-inherit routing is enabled, do not resolve/override worker model.
  // This preserves parent model inheritance and avoids alias normalization drift.
  if (env.OMC_ROUTING_FORCE_INHERIT === 'true') {
    return undefined;
  }

  // Only needed for non-standard providers
  if (!isBedrock() && !isVertexAI()) {
    return undefined;
  }

  // Direct model env vars — highest priority
  const directModel = env.ANTHROPIC_MODEL || env.CLAUDE_MODEL || '';
  if (directModel) {
    return directModel;
  }

  // Fallback: Bedrock tier-specific env vars (default to sonnet tier)
  const bedrockModel =
    env.CLAUDE_CODE_BEDROCK_SONNET_MODEL ||
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    '';
  if (bedrockModel) {
    return bedrockModel;
  }

  // OMC tier env vars
  const omcModel = env.OMC_MODEL_MEDIUM || '';
  if (omcModel) {
    return omcModel;
  }

  return undefined;
}

/**
 * Get the extra CLI args needed to pass an instruction in prompt mode.
 * Returns empty array if the agent does not support prompt mode.
 */
export function getPromptModeArgs(agentType: CliAgentType, instruction: string): string[] {
  const contract = getContract(agentType);
  if (!contract.supportsPromptMode) {
    return [];
  }
  // If a flag is defined (e.g. gemini's '-p'), prepend it; otherwise the
  // instruction is passed as a positional argument (e.g. codex [PROMPT]).
  if (contract.promptModeFlag) {
    return [contract.promptModeFlag, instruction];
  }
  return [instruction];
}
