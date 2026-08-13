/**
 * Maps nixpkgs attribute paths to Devbox package names.
 *
 * Faithful port of axiom/devbox-search internal/devpkg/devpkg.go.
 *
 * The {@link canonicalName} function groups attribute paths into a single
 * Devbox package name, also known as a "canonical name". This name is the
 * first component in a Devbox "package@version" string. Most Devbox package
 * names are the same as their corresponding attribute path.
 *
 * Packages in the nixpkgs repository are defined by one or more attribute
 * paths across one or more commits, which leads to name/version ambiguity as
 * attribute paths change over time. For example, for two nixpkgs commits:
 *
 *   - nixpkgs/1111111#go      -> Go 1.19
 *   - nixpkgs/1111111#go_1_19 -> Go 1.19
 *   - nixpkgs/2222222#go      -> Go 1.20
 *   - nixpkgs/2222222#go_1_19 -> Go 1.19.1
 *
 * Grouping all of these attribute paths under the name "go" lets users refer
 * to go@1.19, go@1.19.1, and go@1.20.
 */

/**
 * Regular expressions for each Devbox package name. Attribute paths that
 * match one of the regular expressions are grouped into the corresponding
 * name.
 *
 * Naming conventions and rules:
 *
 *   - Names are separated by dashes (even if attribute paths are not).
 *   - If a name is identical to an existing attribute path, the matcher
 *     _must_ match that attribute path.
 */
const nameRegexp: ReadonlyArray<readonly [string, RegExp]> = [
  ["apache", /^apacheHttpd$/],
  ["apacheKafka", /^apacheKafka[0-9_]*$/],
  ["gcc", /^gcc[0-9]*$/],
  ["go", /^go(_[0-9]_[0-9]{1,2})?$/],
  ["jdk", /^jdk[0-9]*$/],
  ["jdk-headless", /^jdk[0-9]*_headless$/],
  ["jre", /^jre[0-9]*$/],
  ["jre-headless", /^jre[0-9]*_headless$/],
  ["mariadb", /^mariadb(_[0-9]+)?$/],
  ["mono", /^mono[0-9]*$/],
  ["nix", /^nixVersions\..+$/],
  ["nodejs", /^nodejs(-|_)[0-9]*(_x)?$/],
  ["nodejs-slim", /^nodejs-slim(-|_)[0-9]*(_x)?$/],
  ["php", /^php[0-9]*$/],
  ["python", /^python[0-9]*$/],
  ["python-full", /^python[0-9]*Full$/],
  ["python-minimal", /^python[0-9]*Minimal$/],
  ["ruby", /^ruby[0-9_]*$/],
  ["tomcat", /^tomcat[0-9]*$/],
  ["zulu", /^zulu[0-9]*$/],
];

/** Returns the Devbox package name for a nixpkgs attribute path. */
export function canonicalName(attrPath: string): string {
  for (const [name, re] of nameRegexp) {
    if (re.test(attrPath)) {
      return name;
    }
  }
  return attrPath;
}

/** Reports whether two attribute paths map to the same Devbox package name. */
export function canonicalNameEquals(attrPath1: string, attrPath2: string): boolean {
  return canonicalName(attrPath1) === canonicalName(attrPath2);
}
