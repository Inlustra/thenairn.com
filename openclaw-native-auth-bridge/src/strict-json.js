export class DuplicateJsonKeyError extends SyntaxError {}

// Validate JSON grammar while rejecting duplicate object member names. JSON.parse
// alone silently accepts duplicates, which is unsafe for authentication objects.
export function parseJsonRejectDuplicates(source, maxDepth = 64) {
  if (typeof source !== "string") throw new SyntaxError("JSON input must be text");
  let offset = 0;

  function skipWhitespace() {
    while (offset < source.length && /[\t\n\r ]/.test(source[offset])) offset += 1;
  }

  function parseString() {
    const start = offset;
    if (source[offset++] !== '"') throw new SyntaxError("expected string");
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '"') return JSON.parse(source.slice(start, offset));
      if (char === "\\") {
        const escaped = source[offset++];
        if (escaped === "u") {
          const hex = source.slice(offset, offset + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError("invalid unicode escape");
          offset += 4;
        } else if (!'"\\/bfnrt'.includes(escaped ?? "")) {
          throw new SyntaxError("invalid escape");
        }
      } else if (char.charCodeAt(0) <= 0x1f) {
        throw new SyntaxError("unescaped control character");
      }
    }
    throw new SyntaxError("unterminated string");
  }

  function parseValue(depth) {
    if (depth > maxDepth) throw new SyntaxError("JSON nesting limit exceeded");
    skipWhitespace();
    const char = source[offset];
    if (char === "{") return parseObject(depth + 1);
    if (char === "[") return parseArray(depth + 1);
    if (char === '"') return parseString();
    const tail = source.slice(offset);
    const literal = /^(?:true|false|null)/.exec(tail);
    if (literal) {
      offset += literal[0].length;
      return;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(tail);
    if (number) {
      offset += number[0].length;
      return;
    }
    throw new SyntaxError("invalid JSON value");
  }

  function parseObject(depth) {
    offset += 1;
    skipWhitespace();
    const keys = new Set();
    if (source[offset] === "}") {
      offset += 1;
      return;
    }
    for (;;) {
      skipWhitespace();
      if (source[offset] !== '"') throw new SyntaxError("expected object key");
      const key = parseString();
      if (keys.has(key)) throw new DuplicateJsonKeyError("duplicate JSON object key");
      keys.add(key);
      skipWhitespace();
      if (source[offset++] !== ":") throw new SyntaxError("expected colon");
      parseValue(depth);
      skipWhitespace();
      const separator = source[offset++];
      if (separator === "}") return;
      if (separator !== ",") throw new SyntaxError("expected comma or object end");
    }
  }

  function parseArray(depth) {
    offset += 1;
    skipWhitespace();
    if (source[offset] === "]") {
      offset += 1;
      return;
    }
    for (;;) {
      parseValue(depth);
      skipWhitespace();
      const separator = source[offset++];
      if (separator === "]") return;
      if (separator !== ",") throw new SyntaxError("expected comma or array end");
    }
  }

  skipWhitespace();
  parseValue(0);
  skipWhitespace();
  if (offset !== source.length) throw new SyntaxError("trailing JSON data");
  return JSON.parse(source);
}
