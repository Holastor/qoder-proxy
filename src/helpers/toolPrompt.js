'use strict';

/**
 * toolPrompt.js
 *
 * Converts OpenAI-style tool/function schemas into prompt instructions,
 * and parses model text output back into OpenAI tool_calls format.
 *
 * This enables "fake" tool calling: qodercli receives a text prompt that
 * instructs the model how to signal a tool call, and we parse its response.
 */

// ── Prompt injection ──────────────────────────────────────────────────────────

/**
 * Build a system instruction block describing available tools.
 * Injected at the top of the prompt when tools are present.
 *
 * @param {Array} tools - OpenAI-format tools array from the client request
 * @returns {string} - Plain text system instruction to prepend to the prompt
 */
const buildToolSystemPrompt = (tools) => {
  if (!tools || tools.length === 0) return '';

  const defs = tools
    .filter((t) => t.type === 'function' && t.function)
    .map((t) => {
      const fn = t.function;
      const params = fn.parameters
        ? JSON.stringify(fn.parameters, null, 2)
        : '{}';
      return `Function: ${fn.name}\nDescription: ${fn.description || 'No description'}\nParameters (JSON Schema): ${params}`;
    })
    .join('\n\n');

  return `You have access to the following functions. When you need to call a function, you MUST respond with ONLY a valid JSON object in this exact format and nothing else:

{"tool_call":{"name":"<function_name>","arguments":<arguments_object>}}

Do NOT include any explanation or text before or after the JSON when calling a tool. Only output the raw JSON object.

If you do not need to call a function, respond normally with plain text.

Available functions:
${defs}`;
};

/**
 * Inject tool instructions into a messages array by prepending/merging
 * a system message, then convert to prompt string.
 *
 * @param {Array}  messages - OpenAI messages array
 * @param {Array}  tools    - OpenAI tools array
 * @param {Function} messagesToPromptFn - The existing messagesToPrompt helper
 * @returns {string} - Final prompt string with tool instructions embedded
 */
const buildPromptWithTools = (messages, tools, messagesToPromptFn) => {
  if (!tools || tools.length === 0) {
    return messagesToPromptFn(messages);
  }

  const toolSystem = buildToolSystemPrompt(tools);

  // Extract system message separately
  const existingSystem = messages.find((m) => m.role === 'system');
  const systemContent = existingSystem
    ? Array.isArray(existingSystem.content)
      ? existingSystem.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
      : existingSystem.content || ''
    : '';

  // Get conversation messages (non-system), keep last 10 turns for context
  const conversation = messages.filter((m) => m.role !== 'system');
  const recent = conversation.slice(-10);

  const extractContent = (msg) => {
    if (Array.isArray(msg.content)) {
      return msg.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
    }
    // Handle tool_result messages from multi-turn tool calling
    if (typeof msg.content === 'string') return msg.content;
    return '';
  };

  // Build the prompt parts
  const parts = [toolSystem];
  if (systemContent.trim()) parts.push(`System context: ${systemContent.trim()}`);

  // Include conversation history with role labels
  for (const msg of recent) {
    const content = extractContent(msg).trim();
    if (!content) continue;
    if (msg.role === 'user') parts.push(`User: ${content}`);
    else if (msg.role === 'assistant') parts.push(`Assistant: ${content}`);
    else if (msg.role === 'tool') parts.push(`Tool result: ${content}`);
  }

  return parts.join('\n\n');
};

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Patterns to detect a tool call JSON in model output.
 * Handles cases where the model wraps JSON in markdown code fences.
 */
const TOOL_CALL_PATTERNS = [
  // Raw JSON object
  /^\s*(\{"tool_call"\s*:[\s\S]*\})\s*$/m,
  // Markdown fenced
  /```(?:json)?\s*(\{"tool_call"\s*:[\s\S]*?\})\s*```/m,
];

/**
 * Try to extract a tool_call JSON object from model text output.
 *
 * @param {string} text - Raw model response text
 * @returns {{ name: string, arguments: object }|null} - Parsed tool call or null
 */
const parseToolCallFromText = (text) => {
  if (!text || !text.includes('"tool_call"')) return null;

  for (const pattern of TOOL_CALL_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;

    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.tool_call && parsed.tool_call.name) {
        return {
          name: parsed.tool_call.name,
          arguments: parsed.tool_call.arguments ?? {},
        };
      }
    } catch {
      // Try next pattern
    }
  }

  // Fallback: scan for any JSON blob containing tool_call
  const start = text.indexOf('{"tool_call"');
  if (start === -1) return null;

  // Walk forward to find the matching closing brace
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }

  if (end === -1) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end));
    if (parsed.tool_call && parsed.tool_call.name) {
      return {
        name: parsed.tool_call.name,
        arguments: parsed.tool_call.arguments ?? {},
      };
    }
  } catch {
    return null;
  }

  return null;
};

/**
 * Convert a parsed tool call into OpenAI-format tool_calls array.
 *
 * @param {{ name: string, arguments: object }} toolCall
 * @param {string} callId - Unique ID for this tool call
 * @returns {Array} - OpenAI tool_calls array
 */
const toOpenAIToolCalls = (toolCall, callId) => [
  {
    id: callId,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments:
        typeof toolCall.arguments === 'string'
          ? toolCall.arguments
          : JSON.stringify(toolCall.arguments),
    },
  },
];

module.exports = {
  buildPromptWithTools,
  parseToolCallFromText,
  toOpenAIToolCalls,
};
