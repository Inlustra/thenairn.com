import {
  parseAsArrayOf,
  parseAsString,
  parseAsStringEnum,
  useQueryStates,
} from "nuqs";

export const useSearchParams = () => {
  const [get, set] = useQueryStates({
    streams: parseAsArrayOf(parseAsString).withDefault([]),
    showControls: parseAsStringEnum(["true", "false", "hide"])
      .withDefault("false")
      .withOptions({ clearOnDefault: true }),
    showLabels: parseAsStringEnum(["true", "false", "hide"])
      .withDefault("true")
      .withOptions({ clearOnDefault: true }),
    forceAudio: parseAsStringEnum(["true", "false"])
      .withDefault("false")
      .withOptions({ clearOnDefault: true }),
  });

  return [get, set] as const;
};
