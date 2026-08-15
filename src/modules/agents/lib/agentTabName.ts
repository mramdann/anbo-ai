import {
  AGENT_LAUNCHERS,
  type AgentLauncherId,
  type BuiltInAgentLauncherId,
  CUSTOM_CLI_AGENT_ICONS,
  type CustomCliAgentIcon,
  isBuiltInAgentLauncherId,
} from "./launcher";

export type AgentTabIdentity = {
  launcherId: AgentLauncherId;
  icon: CustomCliAgentIcon;
  label: string;
  name: string;
};

export type AgentTabNameRequest = Pick<
  AgentTabIdentity,
  "launcherId" | "icon" | "label"
>;

export const BUILT_IN_AGENT_ALIASES: Record<
  BuiltInAgentLauncherId,
  readonly string[]
> = {
  claude: [
    "Atlas",
    "Aurelia",
    "Caspian",
    "Elio",
    "Felix",
    "Lucian",
    "Marcel",
    "Nilo",
    "Orson",
    "Remy",
    "Silas",
    "Theo",
    "Valen",
    "Cedric",
    "Dorian",
    "Florian",
    "Jasper",
    "Leander",
    "Marlowe",
    "Soren",
  ],
  codex: [
    "Orion",
    "Sirius",
    "Altair",
    "Rigel",
    "Deneb",
    "Capella",
    "Antares",
    "Spica",
    "Regulus",
    "Castor",
    "Pollux",
    "Alnilam",
    "Alnitak",
    "Saiph",
    "Canopus",
    "Procyon",
    "Vega",
    "Mirach",
    "Mizar",
    "Nashira",
  ],
  antigravity: [
    "Aurora",
    "Lyra",
    "Celeste",
    "Selene",
    "Elara",
    "Calypso",
    "Thalia",
    "Maia",
    "Rhea",
    "Dione",
    "Portia",
    "Larissa",
    "Bianca",
    "Despina",
    "Galatea",
    "Sao",
    "Nerissa",
    "Leda",
    "Thebe",
    "Carme",
  ],
  pi: [
    "Euler",
    "Gauss",
    "Fermat",
    "Noether",
    "Hilbert",
    "Cantor",
    "Fourier",
    "Laplace",
    "Galois",
    "Turing",
    "Boole",
    "Kepler",
    "Euclid",
    "Riemann",
    "Erdos",
    "Emmy",
    "Ada",
    "Cauchy",
    "Leibniz",
    "Newton",
  ],
  opencode: [
    "Aspen",
    "Cedar",
    "Rowan",
    "Willow",
    "Maple",
    "Linden",
    "Juniper",
    "Acacia",
    "Cypress",
    "Sequoia",
    "Alder",
    "Birch",
    "Hazel",
    "Laurel",
    "Olive",
    "Sorrel",
    "Briar",
    "Yarrow",
    "Zinnia",
    "Camelia",
  ],
  grok: [
    "Apollo",
    "Hermes",
    "Ares",
    "Helios",
    "Triton",
    "Proteus",
    "Janus",
    "Evander",
    "Nestor",
    "Hector",
    "Priam",
    "Damon",
    "Theseus",
    "Perseus",
    "Adonis",
    "Cadmus",
    "Linus",
    "Theron",
    "Xander",
    "Orpheus",
  ],
};

const GLOBAL_ALIASES = Object.values(BUILT_IN_AGENT_ALIASES).flat();
const CANONICAL_OWNERS = new Map(
  AGENT_LAUNCHERS.map((launcher) => [folded(launcher.label), launcher.id]),
);
const FALLBACK_PREFIXES = [
  "za",
  "ve",
  "lu",
  "mi",
  "no",
  "ra",
  "se",
  "ta",
  "ka",
  "jo",
  "fi",
  "do",
  "be",
  "cy",
  "ha",
  "wo",
] as const;
const FALLBACK_SUFFIXES = [
  "len",
  "ris",
  "via",
  "nor",
  "tis",
  "mar",
  "zen",
  "lio",
  "ren",
  "dor",
  "sai",
  "mon",
  "vek",
  "ral",
  "nis",
  "tor",
] as const;
const CUSTOM_AGENT_ID = /^custom:[a-z0-9][a-z0-9-]{0,63}$/;
const CALLSIGN = /^[A-Za-z][A-Za-z0-9]{0,6}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function folded(value: string): string {
  return value.toLocaleLowerCase();
}

function secureRandomIndex(upperBound: number): number {
  if (!Number.isSafeInteger(upperBound) || upperBound < 1) return 0;
  const range = 0x1_0000_0000;
  const limit = Math.floor(range / upperBound) * upperBound;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % upperBound;
}

function fallbackCallsign(index: number): string {
  const combinations = FALLBACK_PREFIXES.length * FALLBACK_SUFFIXES.length;
  const slot = index % combinations;
  const round = Math.floor(index / combinations);
  const prefix = FALLBACK_PREFIXES[Math.floor(slot / FALLBACK_SUFFIXES.length)];
  const suffix = FALLBACK_SUFFIXES[slot % FALLBACK_SUFFIXES.length];
  const tail = round === 0 ? "" : round.toString(36);
  const raw = `${prefix}${suffix}${tail}`.slice(0, 7);
  return `${raw[0].toUpperCase()}${raw.slice(1)}`;
}

export function allocateAgentTabNames(
  request: AgentTabNameRequest,
  count: number,
  occupiedNames: Iterable<string>,
  randomIndex: (upperBound: number) => number = secureRandomIndex,
): string[] {
  if (!Number.isSafeInteger(count) || count < 1) return [];
  const used = new Set(Array.from(occupiedNames, folded));
  const preferred = isBuiltInAgentLauncherId(request.launcherId)
    ? BUILT_IN_AGENT_ALIASES[request.launcherId]
    : [];
  const names: string[] = [];

  const reserve = (candidate: string): boolean => {
    const key = folded(candidate);
    const canonicalOwner = CANONICAL_OWNERS.get(key);
    if (canonicalOwner && canonicalOwner !== request.launcherId) return false;
    if (used.has(key)) return false;
    used.add(key);
    names.push(candidate);
    return true;
  };

  if (reserve(request.label) && names.length === count) return names;

  const reserveRandom = (candidates: readonly string[]) => {
    const available = candidates.filter(
      (candidate) => !used.has(folded(candidate)),
    );
    while (available.length > 0 && names.length < count) {
      const selected = randomIndex(available.length);
      const index =
        Number.isSafeInteger(selected) && selected >= 0
          ? selected % available.length
          : 0;
      const [candidate] = available.splice(index, 1);
      reserve(candidate);
    }
  };

  reserveRandom(preferred);
  if (names.length < count) {
    reserveRandom(GLOBAL_ALIASES.filter((name) => !preferred.includes(name)));
  }
  const fallbackStart = randomIndex(
    FALLBACK_PREFIXES.length * FALLBACK_SUFFIXES.length,
  );
  for (let offset = 0; names.length < count; offset += 1) {
    reserve(fallbackCallsign(fallbackStart + offset));
  }
  return names;
}

export function normalizeAgentTabIdentity(
  value: unknown,
): AgentTabIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const launcherId =
    candidate.launcherId === "gemini" ? "antigravity" : candidate.launcherId;
  const icon = candidate.icon === "gemini" ? "antigravity" : candidate.icon;
  const label =
    candidate.launcherId === "gemini" && candidate.label === "Gemini"
      ? "Antigravity"
      : candidate.label;
  const name =
    candidate.launcherId === "gemini" && candidate.name === "Gemini"
      ? "Antigravity"
      : candidate.name;
  if (
    typeof launcherId !== "string" ||
    (!isBuiltInAgentLauncherId(launcherId) &&
      !CUSTOM_AGENT_ID.test(launcherId)) ||
    typeof icon !== "string" ||
    !(CUSTOM_CLI_AGENT_ICONS as readonly string[]).includes(icon) ||
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 64 ||
    CONTROL_CHARACTERS.test(label) ||
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 64 ||
    CONTROL_CHARACTERS.test(name)
  ) {
    return undefined;
  }
  const normalizedLabel = label.trim();
  const normalizedName = name.trim();
  if (normalizedName !== normalizedLabel && !CALLSIGN.test(normalizedName)) {
    return undefined;
  }
  const canonicalOwner = CANONICAL_OWNERS.get(folded(normalizedName));
  if (canonicalOwner && canonicalOwner !== launcherId) {
    return undefined;
  }
  return {
    launcherId: launcherId as AgentLauncherId,
    icon: icon as CustomCliAgentIcon,
    label: normalizedLabel,
    name: normalizedName,
  };
}

export function canonicalAgentTabIdentity(
  launcherId: BuiltInAgentLauncherId,
): AgentTabNameRequest {
  const launcher = AGENT_LAUNCHERS.find((agent) => agent.id === launcherId);
  if (!launcher) throw new RangeError(`Unknown built-in agent: ${launcherId}`);
  return {
    launcherId,
    icon: launcher.icon,
    label: launcher.label,
  };
}
