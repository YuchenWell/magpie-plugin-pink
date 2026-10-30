import { applyEdits, modify, parse, type ParseError, type JSONPath } from 'jsonc-parser';
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject } from './types.js';

export class UserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 解析 JSONC，并拒绝覆盖有语法错误的配置 */
export function parseConfig(text: string, label: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length) throw new UserError(`${label} 存在 JSONC 语法错误，请先在 PinK 中修复`, 409);
  return value;
}

export function editJson(text: string, path: JSONPath, value: unknown): string {
  const prefix = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  text = text.slice(prefix.length);
  const indent = text.match(/\n([\t ]+)\S/)?.[1];
  return prefix + applyEdits(text, modify(text, path, value, {
    formattingOptions: {
      insertSpaces: !indent?.includes('\t'),
      tabSize: indent?.length || 2,
      eol: text.includes('\r\n') ? '\r\n' : '\n',
    },
  }));
}

export const equal = isDeepStrictEqual;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
