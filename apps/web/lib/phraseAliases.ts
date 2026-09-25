/**
 * Common words for a package that nixpkgs spells differently.
 *
 * Phrase search matches names and attribute paths, so a word nixpkgs never
 * uses ranks the package it means below whatever happens to start with it:
 * "node" found node-gyp and node-red ahead of nodejs, and "golang" did not
 * find go at all. A phrase listed here ranks its packages first.
 *
 * Keys are lowercase phrases, values the package names or attribute paths
 * they mean (matched case-insensitively). A word that is itself a package
 * name ("aws", "tf", "ag") is left out: searching for it should find it.
 * Every key must contain a letter or digit, or searchByPhrase ignores it.
 */
const PHRASE_ALIASES: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
    node: ["nodejs"],
    npm: ["nodejs"],
    golang: ["go"],
    rust: ["rustc"],
    py3: ["python3"],
    java: ["jdk"],
    haskell: ["ghc"],
    dotnet: ["dotnet-sdk"],
    csharp: ["dotnet-sdk"],
    postgres: ["postgresql"],
    psql: ["postgresql"],
    pg: ["postgresql"],
    mongo: ["mongodb"],
    sqlite3: ["sqlite"],
    k8s: ["kubectl"],
    kube: ["kubectl"],
    gcloud: ["google-cloud-sdk"],
    az: ["azure-cli"],
    tofu: ["opentofu"],
    nvim: ["neovim"],
    rg: ["ripgrep"],
    make: ["gnumake"],
    ssh: ["openssh"],
    gpg: ["gnupg"],
    magick: ["imagemagick"],
    mvn: ["maven"],
    protoc: ["protobuf"],
    pwsh: ["powershell"],
    chrome: ["google-chrome"],
  }),
);

/** The packages a phrase is a common word for, or none. */
export function phraseAliases(phrase: string): readonly string[] {
  return PHRASE_ALIASES.get(phrase.toLowerCase()) ?? [];
}
