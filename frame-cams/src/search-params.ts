import {
  createParser,
  parseAsArrayOf,
  parseAsBoolean,
  parseAsString,
  parseAsStringEnum,
  useQueryStates,
  type ParserBuilder,
} from "nuqs";

export const parseAsPresenceBoolean: ParserBuilder<boolean> = createParser({
  parse: (v) => v !== null && v !== "false",
  serialize: (v) => v ? "" : null as unknown as string,
});

export const useSearchParams = () => {
  const [get, set] = useQueryStates({
    streams: parseAsArrayOf(parseAsString).withDefault([]),
    hideControls: parseAsPresenceBoolean
      .withDefault(false)
      .withOptions({ clearOnDefault: true }),
    showControls: parseAsBoolean
      .withDefault(false)
      .withOptions({ clearOnDefault: true }),
    showLabels: parseAsBoolean
      .withDefault(true)
      .withOptions({ clearOnDefault: true }),
    forceAudio: parseAsBoolean
      .withDefault(true)
      .withOptions({ clearOnDefault: true }),
  });

  return [get, set] as const;
};
